// Content script for Fiverr AI Reply Drafter
// Uses Fiverr's internal JSON API (same endpoints as fiverr-conversation-extractor)
// to get real structured message data instead of fragile DOM scraping.

const AI_BUTTON_ID = 'fiverr-ai-reply-button';
const AI_FLOATING_WRAP_ID = 'fiverr-ai-floating-wrap';
const INJECT_THROTTLE_MS = 600;
let injectTimer = null;

// ─────────────────────────────────────────────
//  URL / USERNAME HELPERS
// ─────────────────────────────────────────────

/**
 * Extract the other person's username from the current inbox URL.
 * Works for:
 *   https://www.fiverr.com/inbox/somebuyer
 *   https://www.fiverr.com/inbox/somebuyer?...
 */
function extractUsernameFromUrl(url) {
  const m = url.match(/fiverr\.com\/inbox\/([^/?#]+)/i);
  return m ? m[1] : null;
}

// ─────────────────────────────────────────────
//  FIVERR JSON API — FETCH CONVERSATION
// ─────────────────────────────────────────────

/**
 * Call the same internal API used by Fiverr's own inbox page.
 * Returns an array of message objects (newest-first per batch; we reverse at the end).
 * Works because we're running as a content script so cookies are sent automatically.
 */
async function fetchConversationFromApi(username) {
  const allMessages = [];
  let timestamp = null;
  let lastPage = false;
  let batch = 0;
  const MAX_BATCHES = 3; // Limit to avoid slow loads; ~30-50 msgs per batch

  while (!lastPage && batch < MAX_BATCHES) {
    batch++;
    const url = timestamp
      ? `https://www.fiverr.com/inbox/contacts/${encodeURIComponent(username)}/conversation?timestamp=${timestamp}`
      : `https://www.fiverr.com/inbox/contacts/${encodeURIComponent(username)}/conversation`;

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error(`Fiverr API error ${response.status} for ${url}`);
    }

    const data = await response.json();
    const msgs = data.messages || [];
    allMessages.push(...msgs);

    // If Fiverr does not return the field, treat the first batch as the last (safe default)
    lastPage = data.hasOwnProperty('lastPage') ? Boolean(data.lastPage) : true;

    if (!lastPage && msgs.length > 0) {
      timestamp = Math.min(...msgs.map(m => m.createdAt));
    }

    // Small pause to avoid rate-limit
    if (!lastPage && batch < MAX_BATCHES) {
      await new Promise(r => setTimeout(r, 400));
    }
  }

  // Sort oldest → newest
  return allMessages.sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Turn the API message array into a clean plain-text context string for the AI.
 */
function formatMessagesAsContext(messages, username) {
  const lines = [];
  for (const msg of messages) {
    const sender = msg.sender || 'Unknown';
    const label = sender === username ? 'Buyer' : 'Me';
    const text = (msg.body || '').trim();
    if (!text) continue;

    const ts = msg.createdAt
      ? new Date(parseInt(msg.createdAt)).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })
      : '';

    lines.push(`[${label} – ${ts}]: ${text}`);

    // Note any attachments
    if (msg.attachments && msg.attachments.length > 0) {
      for (const att of msg.attachments) {
        const name = att.file_name || att.filename || 'attachment';
        lines.push(`  [Attachment: ${name}]`);
      }
    }
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────
//  DOM FALLBACK — used when URL has no username
// ─────────────────────────────────────────────

function extractContextFromDom() {
  // Collect text from all visible message-like elements
  const selectors = [
    '[class*="message-body" i]',
    '[class*="message-text" i]',
    '[class*="message-content" i]',
    '[class*="chat-message" i]',
    '[class*="message-item" i]',
    '[class*="message-row" i]',
    '[class*="message-wrapper" i]',
    '[data-testid*="message" i]',
    '[data-qa*="message" i]',
    'article'
  ];

  const seen = new Set();
  const lines = [];

  document.querySelectorAll(selectors.join(',')).forEach(el => {
    if (!isElVisible(el)) return;
    const text = collapseWhitespace(el.innerText);
    if (!text || text.length < 3 || text.length > 2000) return;
    if (isNavText(text)) return;
    const key = text.slice(0, 200);
    if (seen.has(key)) return;
    seen.add(key);
    lines.push(text);
  });

  if (lines.length > 0) return lines.slice(-60).join('\n\n');

  // Last resort: grab main text area
  const main = document.querySelector('main, [role="main"]');
  const raw = collapseWhitespace((main || document.body).innerText);
  return raw.slice(-10000);
}

// ─────────────────────────────────────────────
//  VISIBLE LINKS
// ─────────────────────────────────────────────

function extractVisibleLinks() {
  const scopes = [
    ...document.querySelectorAll('main, [role="main"], [class*="inbox" i], [class*="conversation" i], [class*="message" i]')
  ].filter(isElVisible);
  const scope = scopes[0] || document.body;
  const hrefs = [...scope.querySelectorAll('a[href]')]
    .filter(isElVisible)
    .map(a => a.href)
    .filter(h => /^https?:\/\//i.test(h) && !h.includes('fiverr.com'));
  return [...new Set(hrefs)].slice(0, 20);
}

// ─────────────────────────────────────────────
//  MAIN EXTRACTION ENTRY POINT
// ─────────────────────────────────────────────

async function extractChatContext() {
  const pageUrl = location.href;
  const pageTitle = document.title || '';
  const username = extractUsernameFromUrl(pageUrl);

  let conversationText = '';
  let method = 'dom-fallback';

  if (username) {
    try {
      const messages = await fetchConversationFromApi(username);
      if (messages.length > 0) {
        conversationText = formatMessagesAsContext(messages, username);
        method = 'fiverr-api';
      }
    } catch (err) {
      console.warn('[Fiverr AI] API fetch failed, falling back to DOM:', err.message);
    }
  }

  if (!conversationText) {
    conversationText = extractContextFromDom();
    method = 'dom-fallback';
  }

  const links = extractVisibleLinks();
  const linkSection = links.length > 0
    ? 'Visible links in conversation:\n' + links.map(u => '- ' + u).join('\n')
    : '';

  const header = [
    `Page: ${pageTitle}`,
    `URL: ${pageUrl}`,
    username ? `Buyer username: ${username}` : '',
    `Extraction method: ${method}`
  ].filter(Boolean).join('\n');

  return [header, conversationText, linkSection].filter(Boolean).join('\n\n').slice(-18000);
}

// ─────────────────────────────────────────────
//  REPLY INSERTION
// ─────────────────────────────────────────────

function insertReply(replyText) {
  const input = findReplyInput();
  if (!input) {
    navigator.clipboard.writeText(replyText).catch(() => {});
    alert("Couldn't find the message input box — reply copied to clipboard instead.");
    return;
  }

  input.focus();

  if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
    // React-compatible value setter
    const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    desc.set.call(input, replyText);
  } else {
    // contenteditable
    input.innerHTML = '';
    input.textContent = replyText;
  }

  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: replyText }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.focus();
}

function findReplyInput() {
  const selectors = [
    'textarea[placeholder*="message" i]',
    'textarea[placeholder*="reply" i]',
    'textarea[placeholder*="write" i]',
    'textarea',
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"]',
    '[data-testid*="textbox" i]'
  ];

  return selectors
    .flatMap(sel => [...document.querySelectorAll(sel)])
    .filter(isElVisible)
    // Pick the one closest to the bottom of the viewport (near the send area)
    .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0] || null;
}

// ─────────────────────────────────────────────
//  BUTTON CREATION & INJECTION
// ─────────────────────────────────────────────

function createAIButton(mode) {
  const btn = document.createElement('button');
  btn.id = AI_BUTTON_ID;
  btn.className = 'fiverr-ai-reply-btn fiverr-ai-reply-btn--' + (mode || 'inline');
  btn.innerHTML = '<span class="btn-icon">AI</span><div class="fiverr-ai-spinner"></div><span>AI Reply</span>';
  btn.type = 'button';
  btn.title = 'Draft a reply using the Fiverr conversation (reads real messages via Fiverr API)';

  btn.addEventListener('click', async function(e) {
    e.preventDefault();
    e.stopPropagation();
    if (btn.classList.contains('loading')) return;

    setButtonLoading(btn, true);

    try {
      const chatContext = await extractChatContext();

      if (!chatContext || chatContext.length < 30) {
        alert("No conversation text found. Make sure you're on a Fiverr inbox or order page.");
        setButtonLoading(btn, false);
        return;
      }

      chrome.runtime.sendMessage({ action: 'draftReply', chatContext }, function(response) {
        setButtonLoading(btn, false);

        if (chrome.runtime.lastError) {
          alert('Extension error: ' + chrome.runtime.lastError.message);
          return;
        }

        if (response && response.success) {
          insertReply(response.reply);
          if (response.factsAdded > 0) {
            console.log('[Fiverr AI] Saved ' + response.factsAdded + ' new facts to memory.');
          }
        } else {
          alert('Error drafting reply: ' + ((response && response.error) || 'Unknown error'));
        }
      });
    } catch (err) {
      setButtonLoading(btn, false);
      console.error('[Fiverr AI] Unexpected error', err);
      alert('Fiverr AI unexpected error: ' + err.message);
    }
  });

  return btn;
}

function setButtonLoading(btn, loading) {
  btn.classList.toggle('loading', loading);
  btn.disabled = loading;
}

function injectUI() {
  if (!document.body) return;
  if (document.getElementById(AI_BUTTON_ID)) return;

  const anchor = findInlineAnchor();
  if (anchor && anchor.parentElement) {
    const btn = createAIButton('inline');
    anchor.parentElement.insertBefore(btn, anchor);
    console.log('[Fiverr AI] Injected inline AI Reply button next to:', anchor);
    return;
  }

  injectFloatingButton();
}

function findInlineAnchor() {
  const selectors = [
    // Fiverr's send button — various class patterns observed
    '[class*="send-button" i]',
    '[class*="sendButton" i]',
    '[aria-label*="Send message" i]',
    'button[aria-label*="send" i]',
    '[data-testid*="send" i]',
    '[data-qa*="send" i]',
    // Generic submit inside a composer/reply area
    '[class*="composer" i] button[type="submit"]',
    '[class*="message-input" i] button',
    '[class*="reply-input" i] button',
    '[class*="message-actions" i] button',
    // Last resort: any visible submit button
    'button[type="submit"]'
  ];

  const replyInput = findReplyInput();
  const candidates = selectors
    .flatMap(sel => [...document.querySelectorAll(sel)])
    .filter(isElVisible);

  // Prefer a button that is close to the reply input
  if (replyInput) {
    const inputRect = replyInput.getBoundingClientRect();
    const nearby = candidates.filter(btn => {
      const r = btn.getBoundingClientRect();
      return Math.abs(r.top - inputRect.top) < 300 || Math.abs(r.bottom - inputRect.bottom) < 300;
    });
    if (nearby.length > 0) return nearby[nearby.length - 1];
  }

  return candidates[candidates.length - 1] || null;
}

function injectFloatingButton() {
  if (document.getElementById(AI_FLOATING_WRAP_ID)) return;
  const wrap = document.createElement('div');
  wrap.id = AI_FLOATING_WRAP_ID;
  wrap.innerHTML = '<div class="fiverr-ai-floating-label">Fiverr AI</div>';
  wrap.appendChild(createAIButton('floating'));
  document.body.appendChild(wrap);
  console.log('[Fiverr AI] Injected floating AI Reply button (no send button found in DOM).');
}

function scheduleInject() {
  clearTimeout(injectTimer);
  injectTimer = setTimeout(injectUI, INJECT_THROTTLE_MS);
}

// ─────────────────────────────────────────────
//  UTILITY HELPERS
// ─────────────────────────────────────────────

function isElVisible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const s = window.getComputedStyle(el);
  return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
}

function collapseWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function isNavText(text) {
  const lower = text.toLowerCase();
  if (text.length > 140) return false;
  return ['dashboard', 'analytics', 'notifications', 'my gigs', 'orders', 'logout', 'sign in', 'sign up'].some(w => lower.includes(w));
}

// ─────────────────────────────────────────────
//  STARTUP
// ─────────────────────────────────────────────

console.log('[Fiverr AI] Content script loaded on', location.href);

// Observe DOM mutations for SPA navigation (Fiverr is a React SPA)
const _observer = new MutationObserver(scheduleInject);
_observer.observe(document.documentElement, { childList: true, subtree: true });

// Also poll every 3 s as a safety net
setInterval(injectUI, 3000);

// Initial injection attempt
scheduleInject();
