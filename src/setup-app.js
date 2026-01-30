// Served at /setup/app.js
// No fancy syntax: keep it maximally compatible.

(function () {
  var statusEl = document.getElementById('status');
  var authGroupEl = document.getElementById('authGroup');
  var authChoiceEl = document.getElementById('authChoice');
  var logEl = document.getElementById('log');
  var providersContainer = document.getElementById('providersContainer');
  var addProviderBtn = document.getElementById('addProviderBtn');

  // Provider default URLs
  var providerUrls = {
    'anthropic': 'https://api.anthropic.com',
    'openai': 'https://api.openai.com/v1',
    'openrouter': 'https://openrouter.ai/api/v1',
    'google': 'https://generativelanguage.googleapis.com'
  };

  // Provider API types
  var providerApiTypes = {
    'anthropic': 'anthropic-messages',
    'openai': 'openai-completions',
    'openrouter': 'openai-completions',
    'google': 'google-generative-ai'
  };

  // Static model lists for common providers (with provider labels)
  var staticModels = {
    'anthropic': [
      { id: 'anthropic/claude-sonnet-4-20250514', name: '[Anthropic] Claude Sonnet 4 (Latest)', provider: 'anthropic' },
      { id: 'anthropic/claude-opus-4-20250514', name: '[Anthropic] Claude Opus 4', provider: 'anthropic' },
      { id: 'anthropic/claude-3-5-sonnet-20241022', name: '[Anthropic] Claude 3.5 Sonnet', provider: 'anthropic' },
      { id: 'anthropic/claude-3-5-haiku-20241022', name: '[Anthropic] Claude 3.5 Haiku', provider: 'anthropic' },
      { id: 'anthropic/claude-3-opus-20240229', name: '[Anthropic] Claude 3 Opus', provider: 'anthropic' }
    ],
    'openai': [
      { id: 'openai/gpt-4o', name: '[OpenAI] GPT-4o', provider: 'openai' },
      { id: 'openai/gpt-4o-mini', name: '[OpenAI] GPT-4o Mini', provider: 'openai' },
      { id: 'openai/gpt-4-turbo', name: '[OpenAI] GPT-4 Turbo', provider: 'openai' },
      { id: 'openai/o1', name: '[OpenAI] o1', provider: 'openai' },
      { id: 'openai/o1-mini', name: '[OpenAI] o1 Mini', provider: 'openai' },
      { id: 'openai/o3-mini', name: '[OpenAI] o3 Mini', provider: 'openai' }
    ],
    'google': [
      { id: 'google/gemini-2.0-flash', name: '[Google] Gemini 2.0 Flash', provider: 'google' },
      { id: 'google/gemini-2.0-flash-thinking', name: '[Google] Gemini 2.0 Flash Thinking', provider: 'google' },
      { id: 'google/gemini-1.5-pro', name: '[Google] Gemini 1.5 Pro', provider: 'google' },
      { id: 'google/gemini-1.5-flash', name: '[Google] Gemini 1.5 Flash', provider: 'google' }
    ],
    'moonshot': [
      { id: 'moonshotai/kimi-k2', name: '[Moonshot] Kimi K2', provider: 'moonshot' },
      { id: 'moonshotai/kimi-k2.5', name: '[Moonshot] Kimi K2.5', provider: 'moonshot' },
      { id: 'moonshot-v1-8k', name: '[Moonshot] Moonshot v1 8K', provider: 'moonshot' },
      { id: 'moonshot-v1-32k', name: '[Moonshot] Moonshot v1 32K', provider: 'moonshot' },
      { id: 'moonshot-v1-128k', name: '[Moonshot] Moonshot v1 128K', provider: 'moonshot' }
    ]
  };

  // Map auth choices to provider names
  var authChoiceToProvider = {
    'openrouter-api-key': 'openrouter',
    'openai-api-key': 'openai',
    'apiKey': 'anthropic',
    'gemini-api-key': 'google',
    'moonshot-api-key': 'moonshot',
    'kimi-code-api-key': 'moonshot'
  };

  // Cached models list
  var loadedModels = [];
  var currentProvider = null;

  function setStatus(s) {
    statusEl.textContent = s;
  }

  function renderAuth(groups) {
    authGroupEl.innerHTML = '';
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      var opt = document.createElement('option');
      opt.value = g.value;
      opt.textContent = g.label + (g.hint ? ' - ' + g.hint : '');
      authGroupEl.appendChild(opt);
    }

    authGroupEl.onchange = function () {
      var sel = null;
      for (var j = 0; j < groups.length; j++) {
        if (groups[j].value === authGroupEl.value) sel = groups[j];
      }
      authChoiceEl.innerHTML = '';
      var opts = (sel && sel.options) ? sel.options : [];
      for (var k = 0; k < opts.length; k++) {
        var o = opts[k];
        var opt2 = document.createElement('option');
        opt2.value = o.value;
        opt2.textContent = o.label + (o.hint ? ' - ' + o.hint : '');
        authChoiceEl.appendChild(opt2);
      }
      // Clear models when auth changes
      loadedModels = [];
      currentProvider = null;
      populateModelDropdowns([]);
    };

    authGroupEl.onchange();
  }

  // Populate all model dropdowns with the given models
  function populateModelDropdowns(models) {
    var primaryEl = document.getElementById('primaryModel');
    var imageEl = document.getElementById('imageModel');

    // Update primary model dropdown
    if (primaryEl) {
      var currentVal = primaryEl.value;
      primaryEl.innerHTML = '<option value="">-- Select a model --</option>';
      for (var i = 0; i < models.length; i++) {
        var opt = document.createElement('option');
        opt.value = models[i].id;
        opt.textContent = models[i].name || models[i].id;
        primaryEl.appendChild(opt);
      }
      if (currentVal) primaryEl.value = currentVal;
    }

    // Update image model dropdown
    if (imageEl) {
      var currentImgVal = imageEl.value;
      imageEl.innerHTML = '<option value="">-- Select image model (optional) --</option>';
      for (var j = 0; j < models.length; j++) {
        var opt2 = document.createElement('option');
        opt2.value = models[j].id;
        opt2.textContent = models[j].name || models[j].id;
        imageEl.appendChild(opt2);
      }
      if (currentImgVal) imageEl.value = currentImgVal;
    }

    // Update all fallback dropdowns
    updateFallbackDropdowns('fallbackModelsContainer', 'fallback-model-select', models);
    updateFallbackDropdowns('imageFallbackModelsContainer', 'image-fallback-model-select', models);
  }

  // Update fallback model dropdowns in a container
  function updateFallbackDropdowns(containerId, selectClass, models) {
    var container = document.getElementById(containerId);
    if (!container) return;

    var selects = container.querySelectorAll('.' + selectClass);
    for (var i = 0; i < selects.length; i++) {
      var sel = selects[i];
      var currentVal = sel.value;
      var placeholder = sel.querySelector('option[value=""]');
      var placeholderText = placeholder ? placeholder.textContent : '-- Select fallback --';

      sel.innerHTML = '<option value="">' + placeholderText + '</option>';
      for (var j = 0; j < models.length; j++) {
        var opt = document.createElement('option');
        opt.value = models[j].id;
        opt.textContent = models[j].name || models[j].id;
        sel.appendChild(opt);
      }
      if (currentVal) sel.value = currentVal;
    }
  }

  // Create a new fallback model row
  function createFallbackRow(selectClass, placeholder) {
    var wrapper = document.createElement('div');
    wrapper.style.cssText = 'display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.25rem;';

    var sel = document.createElement('select');
    sel.className = selectClass;
    sel.style.cssText = 'flex: 1;';
    sel.innerHTML = '<option value="">' + placeholder + '</option>';

    // Populate with loaded models
    for (var i = 0; i < loadedModels.length; i++) {
      var opt = document.createElement('option');
      opt.value = loadedModels[i].id;
      opt.textContent = loadedModels[i].name || loadedModels[i].id;
      sel.appendChild(opt);
    }

    var removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = 'Remove';
    removeBtn.style.cssText = 'background: #dc2626; padding: 0.3rem 0.6rem; font-size: 0.85em;';
    removeBtn.onclick = function() {
      wrapper.remove();
    };

    wrapper.appendChild(sel);
    wrapper.appendChild(removeBtn);
    return wrapper;
  }

  // Setup fallback add buttons
  var addFallbackBtn = document.getElementById('addFallbackBtn');
  if (addFallbackBtn) {
    addFallbackBtn.onclick = function() {
      var container = document.getElementById('fallbackModelsContainer');
      if (container) {
        container.appendChild(createFallbackRow('fallback-model-select', '-- Select fallback model --'));
      }
    };
  }

  var addImageFallbackBtn = document.getElementById('addImageFallbackBtn');
  if (addImageFallbackBtn) {
    addImageFallbackBtn.onclick = function() {
      var container = document.getElementById('imageFallbackModelsContainer');
      if (container) {
        container.appendChild(createFallbackRow('image-fallback-model-select', '-- Select fallback (optional) --'));
      }
    };
  }

  // Load models button handler
  var loadModelsBtn = document.getElementById('loadModelsBtn');
  var modelsLoadStatus = document.getElementById('modelsLoadStatus');

  if (loadModelsBtn) {
    loadModelsBtn.onclick = function() {
      var authChoice = authChoiceEl.value;
      var apiKey = document.getElementById('authSecret').value.trim();
      var provider = authChoiceToProvider[authChoice];

      if (!provider) {
        if (modelsLoadStatus) modelsLoadStatus.textContent = 'Select an auth provider first';
        return;
      }

      if (modelsLoadStatus) modelsLoadStatus.textContent = 'Loading models...';

      if (provider === 'openrouter') {
        // Fetch from OpenRouter API
        if (!apiKey) {
          if (modelsLoadStatus) modelsLoadStatus.textContent = 'Enter OpenRouter API key first';
          return;
        }

        fetch('/setup/api/openrouter/models', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ apiKey: apiKey })
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.ok && data.models) {
            // Add [OpenRouter] prefix to model names for clarity
            loadedModels = data.models.map(function(m) {
              return {
                id: m.id,
                name: '[OpenRouter] ' + (m.name || m.id),
                provider: 'openrouter'
              };
            });
            currentProvider = provider;
            populateModelDropdowns(loadedModels);
            if (modelsLoadStatus) modelsLoadStatus.textContent = 'Loaded ' + loadedModels.length + ' models from OpenRouter';
          } else {
            if (modelsLoadStatus) modelsLoadStatus.textContent = 'Error: ' + (data.error || 'Failed to load models');
          }
        })
        .catch(function(e) {
          if (modelsLoadStatus) modelsLoadStatus.textContent = 'Error: ' + String(e);
        });
      } else {
        // Use static model list
        var models = staticModels[provider] || [];
        if (models.length === 0) {
          if (modelsLoadStatus) modelsLoadStatus.textContent = 'No preset models for ' + provider + '. You may need to enter model ID manually.';
          return;
        }
        loadedModels = models;
        currentProvider = provider;
        populateModelDropdowns(loadedModels);
        if (modelsLoadStatus) modelsLoadStatus.textContent = 'Loaded ' + models.length + ' models for ' + provider;
      }
    };
  }

  // Create a new provider item HTML
  function createProviderItem() {
    var div = document.createElement('div');
    div.className = 'provider-item';
    div.style.cssText = 'padding: 1rem; background: #f9f9f9; border-radius: 8px; margin-bottom: 1rem;';
    div.innerHTML = [
      '<div style="display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.5rem;">',
      '  <select class="provider-type" style="width: 150px;">',
      '    <option value="">-- Select --</option>',
      '    <option value="anthropic">Anthropic</option>',
      '    <option value="openai">OpenAI</option>',
      '    <option value="openrouter">OpenRouter</option>',
      '    <option value="google">Google</option>',
      '    <option value="custom">Custom</option>',
      '  </select>',
      '  <input class="provider-apikey" type="password" placeholder="API Key" style="flex: 1;" />',
      '  <button type="button" class="remove-provider-btn" style="background: #dc2626; padding: 0.5rem;">Remove</button>',
      '</div>',
      '<div class="provider-custom-url" style="display: none; margin-top: 0.5rem;">',
      '  <input class="provider-baseurl" type="text" placeholder="Base URL (e.g., https://api.example.com/v1)" style="width: 100%;" />',
      '</div>'
    ].join('\n');
    return div;
  }

  // Setup provider item event handlers
  function setupProviderItem(item) {
    var typeSelect = item.querySelector('.provider-type');
    var customUrlDiv = item.querySelector('.provider-custom-url');
    var removeBtn = item.querySelector('.remove-provider-btn');

    typeSelect.onchange = function () {
      if (typeSelect.value === 'custom') {
        customUrlDiv.style.display = 'block';
      } else {
        customUrlDiv.style.display = 'none';
      }
    };

    removeBtn.onclick = function () {
      item.remove();
    };
  }

  // Setup all existing provider items
  function setupAllProviderItems() {
    var items = providersContainer.querySelectorAll('.provider-item');
    for (var i = 0; i < items.length; i++) {
      setupProviderItem(items[i]);
    }
  }

  // Add provider button handler
  if (addProviderBtn) {
    addProviderBtn.onclick = function () {
      var newItem = createProviderItem();
      providersContainer.appendChild(newItem);
      setupProviderItem(newItem);
    };
  }

  // Initialize existing provider items
  setupAllProviderItems();

  // Collect all provider configurations
  function collectProviders() {
    var providers = {};
    var items = providersContainer.querySelectorAll('.provider-item');

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var type = item.querySelector('.provider-type').value;
      var apiKey = item.querySelector('.provider-apikey').value.trim();
      var baseUrl = item.querySelector('.provider-baseurl').value.trim();

      if (!type || !apiKey) continue;

      var providerName = type;
      if (type === 'custom' && baseUrl) {
        // Generate a unique name for custom providers
        providerName = 'custom_' + i;
      }

      var config = {
        apiKey: apiKey
      };

      // Set baseUrl
      if (type === 'custom') {
        if (baseUrl) config.baseUrl = baseUrl;
      } else {
        config.baseUrl = providerUrls[type];
      }

      // Set API type
      if (providerApiTypes[type]) {
        config.api = providerApiTypes[type];
      }

      providers[providerName] = config;
    }

    return providers;
  }

  // Parse comma-separated model list (kept for backwards compatibility)
  function parseModelList(str) {
    if (!str) return [];
    return str.split(',')
      .map(function(s) { return s.trim(); })
      .filter(function(s) { return s.length > 0; });
  }

  // Collect selected values from fallback model dropdowns
  function collectFallbackModels(containerId, selectClass) {
    var container = document.getElementById(containerId);
    if (!container) return [];
    var selects = container.querySelectorAll('.' + selectClass);
    var models = [];
    for (var i = 0; i < selects.length; i++) {
      var val = selects[i].value.trim();
      if (val) models.push(val);
    }
    return models;
  }

  function httpJson(url, opts) {
    opts = opts || {};
    opts.credentials = 'same-origin';
    return fetch(url, opts).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          throw new Error('HTTP ' + res.status + ': ' + (t || res.statusText));
        });
      }
      return res.json();
    });
  }

  function refreshStatus() {
    setStatus('Loading...');
    return httpJson('/setup/api/status').then(function (j) {
      var ver = j.clawdbotVersion ? (' | ' + j.clawdbotVersion) : '';
      setStatus((j.configured ? 'Configured - open /clawdbot' : 'Not configured - run setup below') + ver);
      renderAuth(j.authGroups || []);
      if (j.channelsAddHelp && j.channelsAddHelp.indexOf('telegram') === -1) {
        logEl.textContent += '\nNote: this clawdbot build does not list telegram in `channels add --help`. Telegram auto-add will be skipped.\n';
      }
    }).catch(function (e) {
      setStatus('Error: ' + String(e));
    });
  }

  document.getElementById('run').onclick = function () {
    // Collect providers
    var providers = collectProviders();

    // Collect model configuration
    var primaryModelEl = document.getElementById('primaryModel');
    var imageModelEl = document.getElementById('imageModel');
    var thinkingDefaultEl = document.getElementById('thinkingDefault');
    var userTimezoneEl = document.getElementById('userTimezone');
    var workspacePathEl = document.getElementById('workspacePath');

    // Collect fallback models from dropdowns
    var fallbackModels = collectFallbackModels('fallbackModelsContainer', 'fallback-model-select');
    var imageFallbackModels = collectFallbackModels('imageFallbackModelsContainer', 'image-fallback-model-select');

    var payload = {
      flow: document.getElementById('flow').value,
      authChoice: authChoiceEl.value,
      authSecret: document.getElementById('authSecret').value,
      // Provider configurations
      providers: providers,
      // Model configuration
      primaryModel: primaryModelEl ? primaryModelEl.value.trim() : '',
      fallbackModels: fallbackModels,
      imageModel: imageModelEl ? imageModelEl.value.trim() : '',
      imageFallbackModels: imageFallbackModels,
      // Agent defaults
      thinkingDefault: thinkingDefaultEl ? thinkingDefaultEl.value : '',
      userTimezone: userTimezoneEl ? userTimezoneEl.value : '',
      workspacePath: workspacePathEl ? workspacePathEl.value : '',
      // Channel tokens
      telegramToken: document.getElementById('telegramToken').value,
      discordToken: document.getElementById('discordToken').value,
      slackBotToken: document.getElementById('slackBotToken').value,
      slackAppToken: document.getElementById('slackAppToken').value
    };

    logEl.textContent = 'Running...\n';

    fetch('/setup/api/run', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.text();
    }).then(function (text) {
      var j;
      try { j = JSON.parse(text); } catch (_e) { j = { ok: false, output: text }; }
      logEl.textContent += (j.output || JSON.stringify(j, null, 2));
      return refreshStatus();
    }).catch(function (e) {
      logEl.textContent += '\nError: ' + String(e) + '\n';
    });
  };

  // Pairing approve helper
  var pairingBtn = document.getElementById('pairingApprove');
  if (pairingBtn) {
    pairingBtn.onclick = function () {
      var channel = prompt('Enter channel (telegram or discord):');
      if (!channel) return;
      channel = channel.trim().toLowerCase();
      if (channel !== 'telegram' && channel !== 'discord') {
        alert('Channel must be "telegram" or "discord"');
        return;
      }
      var code = prompt('Enter pairing code (e.g. 3EY4PUYS):');
      if (!code) return;
      logEl.textContent += '\nApproving pairing for ' + channel + '...\n';
      fetch('/setup/api/pairing/approve', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: channel, code: code.trim() })
      }).then(function (r) { return r.text(); })
        .then(function (t) { logEl.textContent += t + '\n'; })
        .catch(function (e) { logEl.textContent += 'Error: ' + String(e) + '\n'; });
    };
  }

  document.getElementById('reset').onclick = function () {
    if (!confirm('Reset setup? This deletes the config file so onboarding can run again.')) return;
    logEl.textContent = 'Resetting...\n';
    fetch('/setup/api/reset', { method: 'POST', credentials: 'same-origin' })
      .then(function (res) { return res.text(); })
      .then(function (t) { logEl.textContent += t + '\n'; return refreshStatus(); })
      .catch(function (e) { logEl.textContent += 'Error: ' + String(e) + '\n'; });
  };

  refreshStatus();
})();
