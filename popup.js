document.addEventListener('DOMContentLoaded', () => {
  const apiKeyInput = document.getElementById('apiKey');
  const modelSelect = document.getElementById('model');
  const personaInput = document.getElementById('persona');
  const memoryInput = document.getElementById('memory');
  const saveBtn = document.getElementById('saveBtn');
  const statusSpan = document.getElementById('status');

  // Load existing settings
  chrome.storage.local.get(['openRouterApiKey', 'aiModel', 'aiPersona', 'aiMemory'], (result) => {
    if (result.openRouterApiKey) apiKeyInput.value = result.openRouterApiKey;
    if (result.aiModel) modelSelect.value = result.aiModel;
    if (result.aiPersona) personaInput.value = result.aiPersona;
    
    // Memory is stored as an array of strings
    if (result.aiMemory && Array.isArray(result.aiMemory)) {
      memoryInput.value = result.aiMemory.join('\n');
    }
  });

  saveBtn.addEventListener('click', () => {
    const memoryLines = memoryInput.value.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    
    chrome.storage.local.set({
      openRouterApiKey: apiKeyInput.value.trim(),
      aiModel: modelSelect.value,
      aiPersona: personaInput.value.trim(),
      aiMemory: memoryLines
    }, () => {
      statusSpan.textContent = 'Saved!';
      setTimeout(() => {
        statusSpan.textContent = '';
      }, 2000);
    });
  });
});