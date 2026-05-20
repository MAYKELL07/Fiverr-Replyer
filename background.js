const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MEM0_HOST = 'https://api.mem0.ai';
const MAX_LINKS_TO_PROCESS = 5;
const MAX_EXTRACTED_CHARS_PER_LINK = 5000;
const DEFAULT_MODEL_CANDIDATES = [
  'google/gemini-2.5-flash',
  'google/gemini-2.0-flash-001',
  'google/gemini-flash-1.5',
  'openai/gpt-4o-mini',
  'openrouter/auto'
];

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'draftReply') {
    handleDraftReply(request.chatContext, request.username || null)
      .then(response => sendResponse({ success: true, ...response }))
      .catch(error => sendResponse({ success: false, error: error.message }));

    return true;
  }

  if (request.action === 'getOpenRouterModels') {
    getOpenRouterModels({ forceRefresh: request.forceRefresh })
      .then(models => sendResponse({ success: true, models }))
      .catch(error => sendResponse({ success: false, error: error.message }));

    return true;
  }
});

// ─────────────────────────────────────────────
//  AUTO-RETRY HELPER
// ─────────────────────────────────────────────

/**
 * Retry an async fn up to maxAttempts times.
 * Retries on network errors and HTTP 429 / 5xx.
 * Backoff: 1 s, 2 s, 4 s …
 */
async function withRetry(fn, maxAttempts) {
  if (!maxAttempts) maxAttempts = 3;
  var lastError;
  for (var attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (!err.retryable || attempt === maxAttempts) throw err;
      var delay = Math.pow(2, attempt - 1) * 1000;
      console.warn('[Fiverr AI] Attempt ' + attempt + ' failed (' + err.message + '), retrying in ' + delay + 'ms...');
      await new Promise(function(r) { setTimeout(r, delay); });
    }
  }
  throw lastError;
}

/** Wrap an HTTP error so withRetry can identify it as retryable */
function httpError(status, message) {
  var err = new Error(message);
  err.status = status;
  err.retryable = status === 429 || status >= 500;
  return err;
}

// ─────────────────────────────────────────────
//  MAIN DRAFT HANDLER
// ─────────────────────────────────────────────

async function handleDraftReply(chatContext, username) {
  // username may also be embedded in the context header as fallback
  if (!username) {
    var m = String(chatContext).match(/^Buyer username:\s*(\S+)/m);
    username = m ? m[1] : null;
  }

  const data = await chrome.storage.local.get([
    'openRouterApiKey',
    'aiModel',
    'aiPersona',
    'linkProcessingEnabled',
    'debugMode',
    'mem0ApiKey',
    'mem0UserId',
    'mem0Enabled'
  ]);

  // Load per-client local memory (keyed by username) with global fallback
  const clientMemoryKey = username ? 'aiMemory_' + username : 'aiMemory';
  const memoryData = await chrome.storage.local.get(['aiMemory', clientMemoryKey]);
  data.aiMemory = memoryData[clientMemoryKey] || memoryData.aiMemory || [];
  data._clientMemoryKey = clientMemoryKey;
  data._username = username;

  if (!data.openRouterApiKey) {
    throw new Error('Please set your OpenRouter API Key in the extension popup.');
  }

  await debugLog(data, 'Draft requested', {
    username: username || '(unknown)',
    memoryKey: clientMemoryKey,
    originalContextLength: chatContext.length
  });

  const enrichedChatContext = data.linkProcessingEnabled === false
    ? chatContext
    : await enrichChatContextWithLinks(chatContext, data);

  // Debug: record the full message text the AI will read
  await debugLog(data, 'Message text sent to AI', { text: enrichedChatContext });

  const model = await resolveOpenRouterModel(data.aiModel);
  const persona = data.aiPersona || 'You are a professional freelancer on Fiverr.';
  const memory = await getRelevantMemory(enrichedChatContext, data);

  const clientLabel = username ? ' - ' + username : '';
  const memoryLines = memory.length > 0
    ? memory.map(function(m) { return '- ' + m; }).join('\n')
    : 'No memory yet.';

  const systemPrompt = [
    'You are an AI assistant helping a Fiverr freelancer draft a reply to a client.',
    'Persona/Rules: ' + persona,
    '',
    'Relevant long-term memory (specific to this client' + clientLabel + '):',
    memoryLines,
    '',
    'Instructions:',
    '1. Read the provided chat context.',
    '2. Draft a polite, professional, and helpful reply.',
    '3. If the context includes extracted document/link content, use it when drafting. If a client link is private, blocked, unsupported, or only a PDF without extractable text, do not pretend you read it; politely ask the buyer to grant access, paste the requirements, or upload a text-readable file.',
    "4. Extract any NEW important facts from the conversation (e.g., buyer's name, project requirements, budget, deadlines) that should be saved to memory. DO NOT extract temporary greetings.",
    '5. Output your response STRICTLY as a JSON object with the following schema:',
    '{"reply": "The drafted reply text here", "new_facts_to_save": ["fact 1", "fact 2"]}',
    'Only output valid JSON. Do not include markdown code blocks around the JSON.'
  ].join('\n');

  const userPrompt = 'Chat Context:\n\n' + enrichedChatContext;

  const jsonResponse = await withRetry(async function(attempt) {
    if (attempt > 1) await debugLog(data, 'OpenRouter retry attempt ' + attempt, {});

    const response = await fetch(OPENROUTER_CHAT_URL, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + data.openRouterApiKey,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/FiverrReplyer',
        'X-Title': 'Fiverr AI Reply Drafter'
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        response_format: { type: 'json_object' }
      })
    }).catch(function(netErr) { netErr.retryable = true; throw netErr; });

    if (!response.ok) {
      const errText = await response.text();
      throw httpError(response.status, 'OpenRouter API Error: ' + response.status + ' ' + errText);
    }

    return response.json();
  }, 3);

  const rawContent = jsonResponse.choices && jsonResponse.choices[0]
    ? (jsonResponse.choices[0].message && jsonResponse.choices[0].message.content) || ''
    : '';

  let parsedContent;
  try {
    parsedContent = JSON.parse(stripJsonMarkdown(rawContent));
  } catch (e) {
    console.error('Failed to parse JSON from AI response:', rawContent);
    parsedContent = { reply: rawContent, new_facts_to_save: [] };
  }

  const newFacts = Array.isArray(parsedContent.new_facts_to_save)
    ? parsedContent.new_facts_to_save.map(fact => String(fact).trim()).filter(Boolean)
    : [];

  const factsAdded = await saveMemory(newFacts, enrichedChatContext, data);
  await debugLog(data, 'Draft completed', { modelUsed: model, factsAdded, enrichedContextLength: enrichedChatContext.length });

  return {
    reply: parsedContent.reply,
    factsAdded,
    modelUsed: model
  };
}

async function enrichChatContextWithLinks(chatContext, data) {
  const urls = extractUrls(chatContext).slice(0, MAX_LINKS_TO_PROCESS);
  if (urls.length === 0) return chatContext;

  await debugLog(data, 'Links detected', { urls });

  const summaries = [];
  for (const url of urls) {
    const result = await extractLinkedResource(url, data);
    summaries.push(formatLinkedResourceResult(result));
  }

  const linkContext = summaries.filter(Boolean).join('\n\n');
  if (!linkContext) return chatContext;

  return (chatContext + '\n\n--- Extracted Client Links / Attachments ---\n' + linkContext).slice(-18000);
}

function extractUrls(text) {
  const matches = String(text || '').match(/https?:\/\/[^\s<>()"']+/gi) || [];
  const cleaned = matches
    .map(url => url.replace(/[\].,;:!?]+$/, ''))
    .map(expandKnownRedirectUrl)
    .filter(shouldProcessUrl);
  return [...new Set(cleaned)];
}

async function extractLinkedResource(url, data) {
  try {
    const normalized = normalizeGoogleUrl(url);
    const response = await fetchWithTimeout(normalized.fetchUrl, { method: 'GET' }, 12000);
    const contentType = response.headers.get('content-type') || '';

    if (!response.ok) {
      return { url, status: 'inaccessible', reason: 'HTTP ' + response.status, kind: normalized.kind };
    }

    if (contentType.includes('application/pdf') || /\.pdf([?#].*)?$/i.test(url)) {
      const bytes = await response.arrayBuffer();
      const pdfText = extractTextFromPdfBytes(bytes);
      if (pdfText.length > 100) {
        return {
          url,
          status: 'read',
          kind: 'pdf',
          title: filenameFromUrl(url),
          text: pdfText.slice(0, MAX_EXTRACTED_CHARS_PER_LINK)
        };
      }

      return {
        url,
        status: 'limited',
        kind: 'pdf',
        title: filenameFromUrl(url),
        text: 'PDF detected (' + Math.round(bytes.byteLength / 1024) + ' KB), but text could not be extracted reliably. Ask the client to paste the key requirements or upload a text-readable brief if the conversation does not already explain the task.'
      };
    }

    const rawText = await response.text();
    const extractedText = contentType.includes('text/html')
      ? extractTextFromHtml(rawText)
      : cleanText(rawText);

    if (looksBlockedOrPrivate(extractedText)) {
      return { url, status: 'inaccessible', reason: 'The link appears private, blocked, or requires sign-in/access.', kind: normalized.kind };
    }

    if (!extractedText || extractedText.length < 40) {
      return { url, status: 'limited', reason: 'No useful text could be extracted.', kind: normalized.kind };
    }

    return {
      url,
      status: 'read',
      kind: normalized.kind,
      title: extractTitle(rawText) || filenameFromUrl(url),
      text: extractedText.slice(0, MAX_EXTRACTED_CHARS_PER_LINK)
    };
  } catch (error) {
    await debugLog(data, 'Link extraction failed', { url, error: error.message });
    return { url, status: 'inaccessible', reason: error.message, kind: 'link' };
  }
}

function shouldProcessUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return !host.endsWith('fiverr.com');
  } catch (error) {
    return false;
  }
}

function expandKnownRedirectUrl(url) {
  try {
    const parsed = new URL(url);
    const candidate = parsed.searchParams.get('url') || parsed.searchParams.get('u') || parsed.searchParams.get('target');
    if (candidate && /^https?:\/\//i.test(candidate)) return decodeURIComponent(candidate);
  } catch (error) {
    return url;
  }
  return url;
}

function normalizeGoogleUrl(url) {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();

  if (host === 'drive.google.com') {
    const fileMatch = parsed.pathname.match(/\/file\/d\/([^/]+)/);
    const id = fileMatch ? fileMatch[1] : parsed.searchParams.get('id');
    if (id) return { kind: 'google-drive-file', fetchUrl: 'https://drive.google.com/uc?export=download&id=' + id };
  }

  if (host === 'docs.google.com') {
    const docMatch = parsed.pathname.match(/\/document\/d\/([^/]+)/);
    if (docMatch) return { kind: 'google-doc', fetchUrl: 'https://docs.google.com/document/d/' + docMatch[1] + '/export?format=txt' };

    const sheetMatch = parsed.pathname.match(/\/spreadsheets\/d\/([^/]+)/);
    if (sheetMatch) return { kind: 'google-sheet', fetchUrl: 'https://docs.google.com/spreadsheets/d/' + sheetMatch[1] + '/export?format=csv' };

    const slidesMatch = parsed.pathname.match(/\/presentation\/d\/([^/]+)/);
    if (slidesMatch) return { kind: 'google-slides', fetchUrl: 'https://docs.google.com/presentation/d/' + slidesMatch[1] + '/export/txt' };
  }

  return { kind: /\.pdf([?#].*)?$/i.test(url) ? 'pdf' : 'web-link', fetchUrl: url };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, Object.assign({}, options, { signal: controller.signal, credentials: 'omit' }));
  } finally {
    clearTimeout(timer);
  }
}

function formatLinkedResourceResult(result) {
  if (result.status === 'read') {
    return 'Link: ' + result.url + '\nType: ' + result.kind + '\nStatus: readable\nTitle: ' + (result.title || 'Untitled') + '\nExtracted text:\n' + result.text;
  }

  if (result.status === 'limited') {
    return 'Link: ' + result.url + '\nType: ' + result.kind + '\nStatus: limited\nNote: ' + (result.text || result.reason);
  }

  return 'Link: ' + result.url + '\nType: ' + result.kind + '\nStatus: inaccessible\nReason: ' + result.reason + '\nInstruction: Ask the buyer to grant public/view access, paste the key requirements, or upload a readable brief if this link is needed.';
}

function extractTextFromPdfBytes(bytes) {
  try {
    const raw = new TextDecoder('latin1').decode(bytes);
    const chunks = [];
    const literalMatches = raw.matchAll(/\(([^()]{2,500})\)\s*T[jJ]/g);
    for (const match of literalMatches) chunks.push(unescapePdfString(match[1]));

    const arrayMatches = raw.matchAll(/\[((?:\s*\([^()]{1,500}\)\s*)+)\]\s*TJ/g);
    for (const match of arrayMatches) {
      const inner = [...match[1].matchAll(/\(([^()]{1,500})\)/g)].map(part => unescapePdfString(part[1])).join('');
      if (inner) chunks.push(inner);
    }

    return cleanText(chunks.join(' '));
  } catch (error) {
    return '';
  }
}

function unescapePdfString(text) {
  return String(text || '')
    .replace(/\n/g, ' ')
    .replace(/\r/g, ' ')
    .replace(/\t/g, ' ')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\');
}

function extractTextFromHtml(html) {
  return cleanText(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'"));
}

function extractTitle(html) {
  const match = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? cleanText(match[1]) : '';
}

function filenameFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const last = pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(last) || 'Linked file';
  } catch (error) {
    return 'Linked file';
  }
}

function looksBlockedOrPrivate(text) {
  const lower = String(text || '').toLowerCase();
  const privateMarkers = [
    'request access',
    'you need access',
    'sign in',
    'access denied',
    'permission denied',
    '403 forbidden',
    'enable javascript',
    'sorry, unable to open the file'
  ];
  return privateMarkers.some(marker => lower.includes(marker));
}

function cleanText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

async function debugLog(data, message, details) {
  if (!details) details = {};
  if (!data.debugMode) return;

  const time = new Date().toISOString();
  const line = '[Fiverr AI Debug] ' + time + ' ' + message + ' ' + JSON.stringify(details);
  console.log(line);

  try {
    const previous = await chrome.storage.local.get(['fiverrAiLastDebug']);
    const next = ((previous.fiverrAiLastDebug || '') + '\n' + line).trim().split('\n').slice(-60).join('\n');
    await chrome.storage.local.set({ fiverrAiLastDebug: next });
  } catch (error) {
    console.warn('[Fiverr AI Debug] Could not store debug log', error);
  }
}

async function getOpenRouterModels(opts) {
  const forceRefresh = opts && opts.forceRefresh;
  const cached = await chrome.storage.local.get(['openRouterModels', 'openRouterModelsFetchedAt']);
  const maxAgeMs = 1000 * 60 * 60 * 6;

  if (!forceRefresh && Array.isArray(cached.openRouterModels) && cached.openRouterModels.length > 0) {
    const age = Date.now() - Number(cached.openRouterModelsFetchedAt || 0);
    if (age < maxAgeMs) return cached.openRouterModels;
  }

  const response = await fetch(OPENROUTER_MODELS_URL, { method: 'GET' });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error('Could not load OpenRouter models: ' + response.status + ' ' + errText);
  }

  const payload = await response.json();
  const models = (payload.data || [])
    .filter(model => model && model.id)
    .map(model => ({
      id: model.id,
      name: model.name || model.id,
      contextLength: model.context_length || model.contextLength || 0,
      promptPrice: Number((model.pricing && model.pricing.prompt) || 0),
      completionPrice: Number((model.pricing && model.pricing.completion) || 0)
    }))
    .sort(sortModelsForUi);

  await chrome.storage.local.set({
    openRouterModels: models,
    openRouterModelsFetchedAt: Date.now()
  });

  return models;
}

async function resolveOpenRouterModel(savedModel) {
  let models = [];
  try {
    models = await getOpenRouterModels();
  } catch (error) {
    console.warn('[Fiverr AI] Could not refresh OpenRouter models, using cached/default model if possible.', error);
    const cached = await chrome.storage.local.get(['openRouterModels']);
    models = cached.openRouterModels || [];
  }

  const ids = new Set(models.map(model => model.id));
  if (savedModel && ids.has(savedModel)) return savedModel;

  const fallback = DEFAULT_MODEL_CANDIDATES.find(id => ids.has(id)) || (models[0] && models[0].id) || savedModel || 'openrouter/auto';
  if (fallback !== savedModel) {
    await chrome.storage.local.set({ aiModel: fallback });
  }
  return fallback;
}

function sortModelsForUi(a, b) {
  const aFree = a.promptPrice === 0 && a.completionPrice === 0;
  const bFree = b.promptPrice === 0 && b.completionPrice === 0;
  if (aFree !== bFree) return aFree ? -1 : 1;
  return a.name.localeCompare(b.name);
}

async function getRelevantMemory(chatContext, data) {
  if (data.mem0Enabled && data.mem0ApiKey) {
    try {
      const memories = await mem0Search(chatContext, data);
      if (memories.length > 0) return memories;
    } catch (error) {
      console.warn('[Fiverr AI] Mem0 search failed; falling back to local memory.', error);
    }
  }

  // Return per-client local memory (already loaded into data.aiMemory by handleDraftReply)
  return Array.isArray(data.aiMemory) ? data.aiMemory.slice(-20) : [];
}

async function saveMemory(newFacts, chatContext, data) {
  if (newFacts.length === 0) return 0;

  if (data.mem0Enabled && data.mem0ApiKey) {
    try {
      await mem0Add(newFacts, chatContext, data);
      return newFacts.length;
    } catch (error) {
      console.warn('[Fiverr AI] Mem0 save failed; saving facts locally instead.', error);
    }
  }

  // Save under the per-client key (e.g. aiMemory_somebuyer) so each client has their own memory
  const key = data._clientMemoryKey || 'aiMemory';
  const existing = Array.isArray(data.aiMemory) ? data.aiMemory : [];
  const updatedMemory = existing.concat(newFacts).slice(-50);
  const toSet = {};
  toSet[key] = updatedMemory;
  await chrome.storage.local.set(toSet);
  return newFacts.length;
}

async function mem0Search(chatContext, data) {
  const response = await fetch(MEM0_HOST + '/v3/memories/search/', {
    method: 'POST',
    headers: mem0Headers(data.mem0ApiKey),
    body: JSON.stringify({
      query: chatContext.slice(-4000),
      output_format: 'v1.1',
      top_k: 10,
      filters: mem0Filters(data)
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error('Mem0 search error: ' + response.status + ' ' + errText);
  }

  const payload = await response.json();
  const results = Array.isArray(payload.results) ? payload.results : [];
  return results
    .map(item => item.memory || (item.data && item.data.memory) || item.text || '')
    .map(text => String(text).trim())
    .filter(Boolean)
    .slice(0, 10);
}

async function mem0Add(newFacts, chatContext, data) {
  const messages = [
    {
      role: 'user',
      content: 'Fiverr conversation context:\n' + chatContext.slice(-3000) + '\n\nImportant facts to remember:\n' + newFacts.map(fact => '- ' + fact).join('\n')
    }
  ];

  const response = await fetch(MEM0_HOST + '/v3/memories/add/', {
    method: 'POST',
    headers: mem0Headers(data.mem0ApiKey),
    body: JSON.stringify({
      messages,
      user_id: getMem0UserId(data),
      app_id: 'fiverr-reply-drafter',
      infer: true,
      metadata: {
        source: 'fiverr-reply-drafter',
        url: extractUrlFromContext(chatContext),
        saved_at: new Date().toISOString()
      }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error('Mem0 add error: ' + response.status + ' ' + errText);
  }
  return response.json().catch(() => null);
}

function mem0Headers(apiKey) {
  return {
    'Authorization': 'Token ' + apiKey,
    'Content-Type': 'application/json'
  };
}

function mem0Filters(data) {
  return {
    user_id: getMem0UserId(data),
    app_id: 'fiverr-reply-drafter'
  };
}

function getMem0UserId(data) {
  // Scope Mem0 memories per client by appending the buyer username to the base user ID
  const base = data.mem0UserId || 'fiverr-freelancer';
  return data._username ? base + '::' + data._username : base;
}

function extractUrlFromContext(chatContext) {
  const match = String(chatContext).match(/URL:\s*(\S+)/);
  return match ? match[1] : '';
}

function stripJsonMarkdown(content) {
  let cleanContent = String(content || '').trim();
  if (cleanContent.startsWith('```json')) {
    cleanContent = cleanContent.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  } else if (cleanContent.startsWith('```')) {
    cleanContent = cleanContent.replace(/^```\s*/, '').replace(/\s*```$/, '');
  }
  return cleanContent;
}
