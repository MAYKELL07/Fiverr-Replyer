// Content script injected into Fiverr. It deliberately uses broad selectors and
// a floating fallback because Fiverr's React DOM changes often.

const AI_BUTTON_ID = 'fiverr-ai-reply-button';
const AI_FLOATING_WRAP_ID = 'fiverr-ai-floating-wrap';
const INJECT_THROTTLE_MS = 400;
let injectTimer = null;

function createAIButton(mode = 'inline') {
  const btn = document.createElement('button');
  btn.id = AI_BUTTON_ID;
  btn.className = `fiverr-ai-reply-btn fiverr-ai-reply-btn--${mode}`;
  btn.innerHTML = `
    <span class="btn-icon">AI</span>
    <div class="fiverr-ai-spinner"></div>
    <span>AI Reply</span>
  `;
  btn.type = 'button';
  btn.title = 'Draft a reply using the visible Fiverr conversation';

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (btn.classList.contains('loading')) return;

    setButtonLoading(btn, true);

    try {
      const chatContext = extractChatContext();
      if (!chatContext || chatContext.length < 20) {
        alert("Couldn't find enough Fiverr conversation text. Open a buyer chat/order conversation and try again.");
        setButtonLoading(btn, false);
        return;
      }

      chrome.runtime.sendMessage({ action: 'draftReply', chatContext }, (response) => {
        setButtonLoading(btn, false);

        if (chrome.runtime.lastError) {
          alert('Extension error: ' + chrome.runtime.lastError.message);
          return;
        }

        if (response && response.success) {
          insertReply(response.reply);
          if (response.factsAdded > 0) {
            console.log(`[Fiverr AI] Saved ${response.factsAdded} new facts to memory.`);
          }
        } else {
          alert('Error drafting reply: ' + ((response && response.error) || 'Unknown error'));
        }
      });
    } catch (err) {
      setButtonLoading(btn, false);
      console.error('[Fiverr AI] Unexpected error', err);
      alert('Unexpected Fiverr AI error. Check the console for details.');
    }
  });

  return btn;
}

function setButtonLoading(btn, loading) {
  btn.classList.toggle('loading', loading);
  btn.disabled = loading;
}

function extractChatContext() {
  var pageHints = getPageHints();
  var messages = extractStructuredMessages();
  var links = extractVisibleLinks();
  var linkText = links.length > 0 ? "Visible client links:\n" + links.map(function(u){ return "- " + u; }).join("\n") : "";

  if (messages.length > 0) {
    return [pageHints, messages.slice(-40).join("\n\n"), linkText].filter(Boolean).join("\n\n");
  }

  var fallbackText = extractVisibleConversationText();
  return [pageHints, fallbackText, linkText].filter(Boolean).join("\n\n").slice(-12000);
}


function extractVisibleLinks() {
  const containers = [
    ...document.querySelectorAll('main, [role="main"], [class*="inbox" i], [class*="conversation" i], [class*="message" i], [class*="chat" i]')
  ].filter(isVisible);
  const scope = containers[0] || document.body;
  const urls = [...scope.querySelectorAll('a[href]')]
    .filter(isVisible)
    .map((anchor) => anchor.href)
    .filter((href) => /^https?:\/\//i.test(href));
  return [...new Set(urls)].slice(0, 20);
}

function getPageHints() {
  const title = document.title ? `Page title: ${document.title}` : '';
  const url = `URL: ${location.href}`;
  const buyerName = findBuyerName();
  return [title, url, buyerName ? `Possible buyer/contact: ${buyerName}` : ''].filter(Boolean).join('\n');
}

function findBuyerName() {
  const selectors = [
    '[data-testid*="username" i]',
    '[class*="username" i]',
    '[class*="buyer" i] [class*="name" i]',
    'aside h1',
    'aside h2',
    'header h1',
    'header h2'
  ];

  for (const selector of selectors) {
    const el = document.querySelector(selector);
    const text = cleanText(el && el.innerText);
    if (text && text.length < 80) return text;
  }

  return '';
}

function extractStructuredMessages() {
  const selectors = [
    '[data-testid*="message" i]',
    '[data-qa*="message" i]',
    '[class*="message-wrapper" i]',
    '[class*="message-item" i]',
    '[class*="message-row" i]',
    '[class*="chat-message" i]',
    '[class*="conversation-message" i]',
    'article'
  ];

  const seen = new Set();
  const messages = [];

  document.querySelectorAll(selectors.join(',')).forEach((el) => {
    if (!isVisible(el)) return;

    const text = cleanText(el.innerText);
    if (!text || text.length < 2 || text.length > 3000) return;
    if (looksLikeNavigation(text)) return;

    const key = text.slice(0, 300);
    if (seen.has(key)) return;
    seen.add(key);

    messages.push(labelMessage(el, text));
  });

  return dedupeNearby(messages);
}

function labelMessage(el, text) {
  const senderSelectors = [
    '[class*="sender" i]',
    '[class*="username" i]',
    '[class*="name" i]',
    'h4',
    'h5'
  ];

  let sender = '';
  for (const selector of senderSelectors) {
    const senderEl = el.querySelector(selector);
    const possible = cleanText(senderEl && senderEl.innerText);
    if (possible && possible.length < 80 && !text.startsWith(possible + possible)) {
      sender = possible;
      break;
    }
  }

  if (!sender) {
    const className = String(el.className || '').toLowerCase();
    sender = className.includes('sent') || className.includes('seller') || className.includes('outgoing') ? 'Me' : 'Buyer';
  }

  return `${sender}: ${text}`;
}

function extractVisibleConversationText() {
  const containers = [
    ...document.querySelectorAll('main, [role="main"], [class*="inbox" i], [class*="conversation" i], [class*="message" i], [class*="chat" i]')
  ].filter(isVisible);

  const best = containers
    .map((el) => cleanText(el.innerText))
    .filter((text) => text.length > 50)
    .sort((a, b) => scoreConversationText(b) - scoreConversationText(a))[0];

  const source = best || cleanText(document.body.innerText);
  return source.slice(-12000);
}

function scoreConversationText(text) {
  const keywords = ['message', 'offer', 'order', 'buyer', 'seller', 'delivery', 'budget', 'requirements', 'reply'];
  return keywords.reduce((score, word) => score + (text.toLowerCase().includes(word) ? 100 : 0), 0) + Math.min(text.length, 5000);
}

function insertReply(replyText) {
  const input = findReplyInput();
  if (!input) {
    navigator.clipboard.writeText(replyText).catch(() => {});
    alert("Couldn't find the message input box, so I copied the draft to your clipboard.");
    return;
  }

  input.focus();

  if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
    setNativeValue(input, replyText);
  } else {
    input.innerHTML = '';
    input.textContent = replyText;
  }

  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: replyText }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function findReplyInput() {
  const selectors = [
    'textarea[placeholder*="message" i]',
    'textarea[placeholder*="reply" i]',
    'textarea',
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"]',
    '[data-testid*="textbox" i]'
  ];

  return selectors
    .flatMap((selector) => [...document.querySelectorAll(selector)])
    .filter(isVisible)
    .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0] || null;
}

function setNativeValue(element, value) {
  const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  descriptor.set.call(element, value);
}

function injectUI() {
  if (!document.body || document.getElementById(AI_BUTTON_ID)) return;

  const anchor = findInlineAnchor();
  if (anchor && anchor.parentElement) {
    const aiBtn = createAIButton('inline');
    anchor.parentElement.insertBefore(aiBtn, anchor);
    console.log('[Fiverr AI] Injected inline AI Reply button.');
    return;
  }

  injectFloatingButton();
}

function findInlineAnchor() {
  const selectors = [
    'button[type="submit"]',
    'button[aria-label*="send" i]',
    'button[aria-label*="reply" i]',
    '[data-testid*="send" i]',
    '[data-qa*="send" i]',
    '[class*="send" i] button',
    '[class*="message-actions" i] button',
    '[class*="composer" i] button',
    '[class*="reply" i] button'
  ];

  const candidates = selectors.flatMap((selector) => [...document.querySelectorAll(selector)]).filter(isVisible);
  return candidates.find((el) => isNearReplyInput(el)) || candidates[candidates.length - 1] || null;
}

function isNearReplyInput(el) {
  const input = findReplyInput();
  if (!input) return true;
  const a = el.getBoundingClientRect();
  const b = input.getBoundingClientRect();
  return Math.abs(a.top - b.top) < 250 || Math.abs(a.bottom - b.bottom) < 250;
}

function injectFloatingButton() {
  if (document.getElementById(AI_FLOATING_WRAP_ID)) return;

  const wrap = document.createElement('div');
  wrap.id = AI_FLOATING_WRAP_ID;
  wrap.innerHTML = '<div class="fiverr-ai-floating-label">Fiverr AI</div>';
  wrap.appendChild(createAIButton('floating'));
  document.body.appendChild(wrap);
  console.log('[Fiverr AI] Injected floating AI Reply button fallback.');
}

function scheduleInject() {
  clearTimeout(injectTimer);
  injectTimer = setTimeout(injectUI, INJECT_THROTTLE_MS);
}

function cleanText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function isVisible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
}

function looksLikeNavigation(text) {
  const lower = text.toLowerCase();
  if (text.length < 120 && ['dashboard', 'analytics', 'earnings', 'notifications', 'settings'].some((word) => lower.includes(word))) {
    return true;
  }
  return false;
}

function dedupeNearby(items) {
  const result = [];
  for (const item of items) {
    if (!result.some((existing) => existing.includes(item) || item.includes(existing))) {
      result.push(item);
    }
  }
  return result;
}

console.log('[Fiverr AI] Content script loaded on', location.href);

const observer = new MutationObserver(scheduleInject);
observer.observe(document.documentElement, { childList: true, subtree: true });

scheduleInject();
setInterval(injectUI, 3000);
