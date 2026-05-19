chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'draftReply') {
    handleDraftReply(request.chatContext)
      .then(response => sendResponse({ success: true, ...response }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    
    return true; // Keep the message channel open for async response
  }
});

async function handleDraftReply(chatContext) {
  const data = await chrome.storage.local.get(['openRouterApiKey', 'aiModel', 'aiPersona', 'aiMemory']);
  
  if (!data.openRouterApiKey) {
    throw new Error('Please set your OpenRouter API Key in the extension popup.');
  }

  const model = data.aiModel || 'google/gemini-1.5-flash';
  const persona = data.aiPersona || 'You are a professional freelancer on Fiverr.';
  const memory = data.aiMemory || [];

  const systemPrompt = `
You are an AI assistant helping a Fiverr freelancer draft a reply to a client.
Persona/Rules: ${persona}

Memory (Stored facts about clients or projects):
${memory.length > 0 ? memory.map(m => '- ' + m).join('\n') : 'No memory yet.'}

Instructions:
1. Read the provided chat context.
2. Draft a polite, professional, and helpful reply.
3. Extract any NEW important facts from the conversation (e.g., buyer's name, project requirements, budget, deadlines) that should be saved to memory. DO NOT extract temporary greetings.
4. Output your response STRICTLY as a JSON object with the following schema:
{
  "reply": "The drafted reply text here",
  "new_facts_to_save": ["fact 1", "fact 2"]
}
Only output valid JSON. Do not include markdown code blocks around the JSON.
`;

  const userPrompt = `Chat Context:\n\n${chatContext}`;

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${data.openRouterApiKey}`,
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
      response_format: { type: "json_object" }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenRouter API Error: ${response.status} ${errText}`);
  }

  const jsonResponse = await response.json();
  const rawContent = jsonResponse.choices[0].message.content;
  
  let parsedContent;
  try {
    // Attempt to parse JSON. Sometimes LLMs include markdown ```json ... ```
    let cleanContent = rawContent.trim();
    if (cleanContent.startsWith('```json')) {
      cleanContent = cleanContent.replace(/^```json\n/, '').replace(/\n```$/, '');
    }
    parsedContent = JSON.parse(cleanContent);
  } catch (e) {
    console.error("Failed to parse JSON from AI response:", rawContent);
    // Fallback: assume the whole response is the reply
    parsedContent = { reply: rawContent, new_facts_to_save: [] };
  }

  // Update Memory
  if (parsedContent.new_facts_to_save && parsedContent.new_facts_to_save.length > 0) {
    const updatedMemory = [...memory, ...parsedContent.new_facts_to_save];
    // Keep memory to last 50 items to prevent bloat
    if (updatedMemory.length > 50) {
      updatedMemory.splice(0, updatedMemory.length - 50);
    }
    await chrome.storage.local.set({ aiMemory: updatedMemory });
  }

  return {
    reply: parsedContent.reply,
    factsAdded: parsedContent.new_facts_to_save ? parsedContent.new_facts_to_save.length : 0
  };
}