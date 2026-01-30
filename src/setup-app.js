// Served at /setup/app.js
// No fancy syntax: keep it maximally compatible.

(function () {
  var statusEl = document.getElementById('status');
  var authGroupEl = document.getElementById('authGroup');
  var authChoiceEl = document.getElementById('authChoice');
  var logEl = document.getElementById('log');
  var openrouterModelSection = document.getElementById('openrouterModelSection');
  var openrouterModelEl = document.getElementById('openrouterModel');
  var openrouterFallbacksEl = document.getElementById('openrouterFallbacks');
  var openrouterImageModelEl = document.getElementById('openrouterImageModel');
  var openrouterImageFallbacksEl = document.getElementById('openrouterImageFallbacks');
  var openrouterModelStatusEl = document.getElementById('openrouterModelStatus');
  var fetchModelsBtn = document.getElementById('fetchModelsBtn');
  var authSecretEl = document.getElementById('authSecret');
  var thinkingDefaultEl = document.getElementById('thinkingDefault');
  var userTimezoneEl = document.getElementById('userTimezone');
  var workspacePathEl = document.getElementById('workspacePath');

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
      // Show/hide OpenRouter model selection
      if (authGroupEl.value === 'openrouter') {
        openrouterModelSection.style.display = 'block';
      } else {
        openrouterModelSection.style.display = 'none';
      }
    };

    authGroupEl.onchange();
  }

  // Populate a select element with model options
  function populateModelSelect(selectEl, models, popularIds, includeEmpty, emptyLabel) {
    selectEl.innerHTML = '';

    if (includeEmpty) {
      var emptyOpt = document.createElement('option');
      emptyOpt.value = '';
      emptyOpt.textContent = emptyLabel || '-- None --';
      selectEl.appendChild(emptyOpt);
    }

    var popularModels = [];
    var otherModels = [];
    for (var i = 0; i < models.length; i++) {
      var m = models[i];
      if (popularIds.indexOf(m.id) !== -1) {
        popularModels.push(m);
      } else {
        otherModels.push(m);
      }
    }

    // Sort popular models by the order in popularIds
    popularModels.sort(function (a, b) {
      return popularIds.indexOf(a.id) - popularIds.indexOf(b.id);
    });

    // Add optgroup for popular models
    if (popularModels.length > 0) {
      var popularGroup = document.createElement('optgroup');
      popularGroup.label = '⭐ Popular Models';
      for (var j = 0; j < popularModels.length; j++) {
        var pm = popularModels[j];
        var opt = document.createElement('option');
        opt.value = pm.id;
        opt.textContent = pm.name + ' (' + pm.id + ')';
        popularGroup.appendChild(opt);
      }
      selectEl.appendChild(popularGroup);
    }

    // Add optgroup for all other models
    if (otherModels.length > 0) {
      var otherGroup = document.createElement('optgroup');
      otherGroup.label = 'All Models';
      for (var k = 0; k < otherModels.length; k++) {
        var om = otherModels[k];
        var opt2 = document.createElement('option');
        opt2.value = om.id;
        opt2.textContent = om.name + ' (' + om.id + ')';
        otherGroup.appendChild(opt2);
      }
      selectEl.appendChild(otherGroup);
    }
  }

  // Fetch OpenRouter models
  function fetchOpenRouterModels() {
    var apiKey = authSecretEl.value.trim();
    if (!apiKey) {
      openrouterModelStatusEl.textContent = 'Please enter your OpenRouter API key first.';
      openrouterModelStatusEl.style.color = '#dc2626';
      return;
    }

    openrouterModelStatusEl.textContent = 'Fetching models...';
    openrouterModelStatusEl.style.color = '#555';
    fetchModelsBtn.disabled = true;

    fetch('/setup/api/openrouter/models', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: apiKey })
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        fetchModelsBtn.disabled = false;
        if (!data.ok) {
          openrouterModelStatusEl.textContent = 'Error: ' + (data.error || 'Failed to fetch models');
          openrouterModelStatusEl.style.color = '#dc2626';
          return;
        }

        var models = data.models || [];

        // Popular model IDs for prioritization
        var popularIds = [
          'anthropic/claude-sonnet-4',
          'anthropic/claude-3.5-sonnet',
          'anthropic/claude-3-opus',
          'openai/gpt-4o',
          'openai/o1',
          'google/gemini-2.0-flash-exp',
          'google/gemini-pro-1.5',
          'meta-llama/llama-3.3-70b-instruct',
          'deepseek/deepseek-chat'
        ];

        // Vision-capable models for image model selection
        var visionModels = models.filter(function(m) {
          return m.id.indexOf('vision') !== -1 ||
                 m.id.indexOf('gpt-4o') !== -1 ||
                 m.id.indexOf('claude-3') !== -1 ||
                 m.id.indexOf('claude-sonnet-4') !== -1 ||
                 m.id.indexOf('gemini') !== -1;
        });

        // Populate primary model select
        populateModelSelect(openrouterModelEl, models, popularIds, true, '-- Select primary model --');

        // Populate fallbacks multi-select
        populateModelSelect(openrouterFallbacksEl, models, popularIds, false);

        // Populate image model select (prefer vision-capable models)
        populateModelSelect(openrouterImageModelEl, visionModels.length > 0 ? visionModels : models, popularIds, true, '-- None (use primary) --');

        // Populate image fallbacks multi-select
        populateModelSelect(openrouterImageFallbacksEl, visionModels.length > 0 ? visionModels : models, popularIds, false);

        openrouterModelStatusEl.textContent = 'Loaded ' + models.length + ' models.';
        openrouterModelStatusEl.style.color = '#16a34a';
      })
      .catch(function (err) {
        fetchModelsBtn.disabled = false;
        openrouterModelStatusEl.textContent = 'Error: ' + String(err);
        openrouterModelStatusEl.style.color = '#dc2626';
      });
  }

  // Bind fetch models button
  if (fetchModelsBtn) {
    fetchModelsBtn.onclick = fetchOpenRouterModels;
  }

  // Get selected values from a multi-select element
  function getMultiSelectValues(selectEl) {
    var values = [];
    if (!selectEl) return values;
    for (var i = 0; i < selectEl.options.length; i++) {
      if (selectEl.options[i].selected && selectEl.options[i].value) {
        values.push(selectEl.options[i].value);
      }
    }
    return values;
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
      // If channels are unsupported, surface it for debugging.
      if (j.channelsAddHelp && j.channelsAddHelp.indexOf('telegram') === -1) {
        logEl.textContent += '\nNote: this clawdbot build does not list telegram in `channels add --help`. Telegram auto-add will be skipped.\n';
      }

    }).catch(function (e) {
      setStatus('Error: ' + String(e));
    });
  }

  document.getElementById('run').onclick = function () {
    var payload = {
      flow: document.getElementById('flow').value,
      authChoice: authChoiceEl.value,
      authSecret: document.getElementById('authSecret').value,
      // Model configuration
      openrouterModel: openrouterModelEl ? openrouterModelEl.value : '',
      openrouterFallbacks: getMultiSelectValues(openrouterFallbacksEl),
      openrouterImageModel: openrouterImageModelEl ? openrouterImageModelEl.value : '',
      openrouterImageFallbacks: getMultiSelectValues(openrouterImageFallbacksEl),
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
