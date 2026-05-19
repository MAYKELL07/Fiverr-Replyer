const DEFAULT_MODEL_CANDIDATES = [
  'google/gemini-2.5-flash',
  'google/gemini-2.0-flash-001',
  'google/gemini-flash-1.5',
  'openai/gpt-4o-mini',
  'openrouter/auto'
];

let loadedModels = [];
let savedSettings = {};

document.addEventListener('DOMContentLoaded', async () => {
  const apiKeyInput = document.getElementById('apiKey');
  const modelSelect = document.getElementById('model');
  const personaInput = document.getElementById('persona');
  const memoryInput = document.getElementById('memory');
  const mem0EnabledInput = document.getElementById('mem0Enabled');
  const mem0ApiKeyInput = document.getElementById('mem0ApiKey');
  const mem0UserIdInput = document.getElementById('mem0UserId');
  const saveBtn = document.getElementById('saveBtn');
  const refreshModelsBtn = document.getElementById('refreshModelsBtn');
  const statusSpan = document.getElementById('status');
  const modelStatus = document.getElementById('modelStatus');

  savedSettings = await chrome.storage.local.get([
    'openRouterApiKey',
    'aiModel',
    'aiPersona',
    'aiMemory',
    'mem0Enabled',
    'mem0ApiKey',
    'mem0UserId'
  ]);

  if (savedSettings.openRouterApiKey) apiKeyInput.value = savedSettings.openRouterApiKey;
  if (savedSettings.aiPersona) personaInput.value = savedSettings.aiPersona;
  if (savedSettings.mem0ApiKey) mem0ApiKeyInput.value = savedSettings.mem0ApiKey;
  mem0EnabledInput.checked = Boolean(savedSettings.mem0Enabled);
  mem0UserIdInput.value = savedSettings.mem0UserId || 'fiverr-freelancer';

  if (Array.isArray(savedSettings.aiMemory)) {
    memoryInput.value = savedSettings.aiMemory.join('\n');
  }

  refreshModelsBtn.addEventListener('click', () => loadModels(true));

  saveBtn.addEventListener('click', () => {
    const memoryLines = memoryInput.value.split('\n').map(l => l.trim()).filter(Boolean);

    chrome.storage.local.set({
      openRouterApiKey: apiKeyInput.value.trim(),
      aiModel: modelSelect.value,
      aiPersona: personaInput.value.trim(),
      aiMemory: memoryLines,
      mem0Enabled: mem0EnabledInput.checked,
      mem0ApiKey: mem0ApiKeyInput.value.trim(),
      mem0UserId: mem0UserIdInput.value.trim() || 'fiverr-freelancer'
    }, () => {
      statusSpan.textContent = 'Saved!';
      setTimeout(() => {
        statusSpan.textContent = '';
      }, 2000);
    });
  });

  await loadModels(false);

  async function loadModels(forceRefresh) {
    modelStatus.textContent = forceRefresh ? 'Refreshing live OpenRouter models...' : 'Loading live OpenRouter models...';
    refreshModelsBtn.disabled = true;

    chrome.runtime.sendMessage({ action: 'getOpenRouterModels', forceRefresh }, (response) => {
      refreshModelsBtn.disabled = false;

      if (chrome.runtime.lastError || !response?.success) {
        const error = chrome.runtime.lastError?.message || response?.error || 'Unknown error';
        modelStatus.textContent = `Could not load live models: ${error}`;
        renderModelOptions([], savedSettings.aiModel);
        return;
      }

      loadedModels = response.models || [];
      const selectedModel = chooseSelectedModel(savedSettings.aiModel, loadedModels);
      renderModelOptions(loadedModels, selectedModel);
      modelStatus.textContent = `${loadedModels.length} live OpenRouter models loaded. Free models are listed first.`;

      if (selectedModel && selectedModel !== savedSettings.aiModel) {
        chrome.storage.local.set({ aiModel: selectedModel });
        savedSettings.aiModel = selectedModel;
      }
    });
  }

  function renderModelOptions(models, selectedModel) {
    modelSelect.innerHTML = '';

    if (models.length === 0) {
      appendOption(selectedModel || 'openrouter/auto', selectedModel || 'OpenRouter Auto', 'Fallback');
      modelSelect.value = selectedModel || 'openrouter/auto';
      return;
    }

    models.forEach((model) => {
      const isFree = model.promptPrice === 0 && model.completionPrice === 0;
      const label = `${model.name} (${model.id})${isFree ? ' - free' : ''}`;
      appendOption(model.id, label, isFree ? 'Free' : 'Paid');
    });

    modelSelect.value = selectedModel;
  }

  function appendOption(value, label, groupLabel) {
    let group = [...modelSelect.children].find(child => child.label === groupLabel);
    if (!group) {
      group = document.createElement('optgroup');
      group.label = groupLabel;
      modelSelect.appendChild(group);
    }

    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    group.appendChild(option);
  }

  function chooseSelectedModel(savedModel, models) {
    const ids = new Set(models.map(model => model.id));
    if (savedModel && ids.has(savedModel)) return savedModel;
    return DEFAULT_MODEL_CANDIDATES.find(id => ids.has(id)) || models[0]?.id || savedModel || 'openrouter/auto';
  }
});
