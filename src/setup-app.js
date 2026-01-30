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
    };

    authGroupEl.onchange();
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

  // Parse comma-separated model list
  function parseModelList(str) {
    if (!str) return [];
    return str.split(',')
      .map(function(s) { return s.trim(); })
      .filter(function(s) { return s.length > 0; });
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
    var fallbackModelsEl = document.getElementById('fallbackModels');
    var imageModelEl = document.getElementById('imageModel');
    var imageFallbackModelsEl = document.getElementById('imageFallbackModels');
    var thinkingDefaultEl = document.getElementById('thinkingDefault');
    var userTimezoneEl = document.getElementById('userTimezone');
    var workspacePathEl = document.getElementById('workspacePath');

    var payload = {
      flow: document.getElementById('flow').value,
      authChoice: authChoiceEl.value,
      authSecret: document.getElementById('authSecret').value,
      // Provider configurations
      providers: providers,
      // Model configuration
      primaryModel: primaryModelEl ? primaryModelEl.value.trim() : '',
      fallbackModels: parseModelList(fallbackModelsEl ? fallbackModelsEl.value : ''),
      imageModel: imageModelEl ? imageModelEl.value.trim() : '',
      imageFallbackModels: parseModelList(imageFallbackModelsEl ? imageFallbackModelsEl.value : ''),
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
