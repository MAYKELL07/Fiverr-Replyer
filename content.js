// Content script injected into Fiverr

function createAIButton() {
  const btn = document.createElement('button');
  btn.className = 'fiverr-ai-reply-btn';
  btn.innerHTML = `
    <span class="btn-icon">✨</span>
    <div class="fiverr-ai-spinner"></div>
    AI Reply
  `;
  btn.type = 'button'; // Prevent form submission
  
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (btn.classList.contains('loading')) return;
    
    btn.classList.add('loading');
    
    try {
      const chatContext = extractChatContext();
      if (!chatContext) {
        alert("Couldn't find any chat context. Please ensure you are in a conversation.");
        return;
      }

      chrome.runtime.sendMessage({ action: 'draftReply', chatContext }, (response) => {
        btn.classList.remove('loading');
        
        if (response.success) {
          insertReply(response.reply);
          if (response.factsAdded > 0) {
            console.log(`[Fiverr AI] Saved ${response.factsAdded} new facts to memory.`);
          }
        } else {
          alert("Error drafting reply: " + response.error);
        }
      });
    } catch (err) {
      btn.classList.remove('loading');
      console.error(err);
      alert("Unexpected error.");
    }
  });

  return btn;
}

function extractChatContext() {
  // Fiverr UI changes, so we use a broad strategy.
  // Strategy 1: Look for specific message list containers
  let messageElements = document.querySelectorAll('article.message-item, .message-list-item, [data-message]');
  
  if (messageElements.length === 0) {
    // Strategy 2: Fallback to reading all text in the main messaging area
    const mainArea = document.querySelector('.inbox-main, .message-list-container, main');
    if (mainArea) {
      // Get raw text, limit to last few thousand characters
      const text = mainArea.innerText;
      return text.substring(Math.max(0, text.length - 8000));
    }
    return "";
  }

  let chatHistory = [];
  messageElements.forEach(el => {
    // Try to get sender name and text
    const senderEl = el.querySelector('.sender-name, h4, .name');
    const textEl = el.querySelector('.message-body, .message-text, p');
    
    let sender = senderEl ? senderEl.innerText.trim() : 'Unknown';
    let text = textEl ? textEl.innerText.trim() : el.innerText.trim();
    
    if (text) {
      chatHistory.push(`${sender}: ${text}`);
    }
  });

  // Limit context to last 20 messages to avoid token bloat
  return chatHistory.slice(-20).join('\n\n');
}

function insertReply(replyText) {
  // Find the text input area
  const textarea = document.querySelector('textarea, [contenteditable="true"]');
  if (!textarea) {
    alert("Couldn't find the message input box to insert the reply. Copied to clipboard instead.");
    navigator.clipboard.writeText(replyText);
    return;
  }

  if (textarea.tagName === 'TEXTAREA') {
    textarea.value = replyText;
  } else {
    textarea.innerText = replyText;
  }
  
  // Trigger events so React/Fiverr knows the value changed
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.dispatchEvent(new Event('change', { bubbles: true }));
}

// Function to inject button into the DOM
function injectUI() {
  // If button already exists, do nothing
  if (document.querySelector('.fiverr-ai-reply-btn')) return;

  // Find the send button or actions wrapper
  const sendButton = document.querySelector('button[type="submit"], .send-button, .message-actions');
  
  if (sendButton && sendButton.parentElement) {
    const aiBtn = createAIButton();
    // Insert before the send button
    sendButton.parentElement.insertBefore(aiBtn, sendButton);
  }
}

// Observer to handle SPA navigation and dynamic loading
const observer = new MutationObserver((mutations) => {
  // Throttle injection attempts
  if (window.injectTimeout) clearTimeout(window.injectTimeout);
  window.injectTimeout = setTimeout(() => {
    injectUI();
  }, 500);
});

observer.observe(document.body, { childList: true, subtree: true });

// Initial run
setTimeout(injectUI, 1000);