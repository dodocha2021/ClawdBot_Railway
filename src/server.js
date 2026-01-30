import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import express from "express";
import httpProxy from "http-proxy";
import * as tar from "tar";

// Railway commonly sets PORT=8080 for HTTP services.
const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const STATE_DIR = process.env.CLAWDBOT_STATE_DIR?.trim() || path.join(os.homedir(), ".clawdbot");
const WORKSPACE_DIR = process.env.CLAWDBOT_WORKSPACE_DIR?.trim() || path.join(STATE_DIR, "workspace");

// Protect /setup with a user-provided password.
const SETUP_PASSWORD = process.env.SETUP_PASSWORD?.trim();

// Gateway admin token (protects Clawdbot gateway + Control UI).
// Must be stable across restarts. If not provided via env, persist it in the state dir.
function resolveGatewayToken() {
  const envTok = process.env.CLAWDBOT_GATEWAY_TOKEN?.trim();
  if (envTok) return envTok;

  const tokenPath = path.join(STATE_DIR, "gateway.token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch {
    // ignore
  }

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(tokenPath, generated, { encoding: "utf8", mode: 0o600 });
  } catch {
    // best-effort
  }
  return generated;
}

const CLAWDBOT_GATEWAY_TOKEN = resolveGatewayToken();
process.env.CLAWDBOT_GATEWAY_TOKEN = CLAWDBOT_GATEWAY_TOKEN;

// Where the gateway will listen internally (we proxy to it).
const INTERNAL_GATEWAY_PORT = Number.parseInt(process.env.INTERNAL_GATEWAY_PORT ?? "18789", 10);
const INTERNAL_GATEWAY_HOST = process.env.INTERNAL_GATEWAY_HOST ?? "127.0.0.1";
const GATEWAY_TARGET = `http://${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`;

// Always run the built-from-source CLI entry directly to avoid PATH/global-install mismatches.
const CLAWDBOT_ENTRY = process.env.CLAWDBOT_ENTRY?.trim() || "/clawdbot/dist/entry.js";
const CLAWDBOT_NODE = process.env.CLAWDBOT_NODE?.trim() || "node";

function clawArgs(args) {
  return [CLAWDBOT_ENTRY, ...args];
}

function configPath() {
  return process.env.CLAWDBOT_CONFIG_PATH?.trim() || path.join(STATE_DIR, "clawdbot.json");
}

function isConfigured() {
  try {
    return fs.existsSync(configPath());
  } catch {
    return false;
  }
}

let gatewayProc = null;
let gatewayStarting = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForGatewayReady(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${GATEWAY_TARGET}/clawdbot`, { method: "GET" });
      // Any HTTP response means the port is open.
      if (res) return true;
    } catch {
      // not ready
    }
    await sleep(250);
  }
  return false;
}

async function startGateway() {
  if (gatewayProc) return;
  if (!isConfigured()) throw new Error("Gateway cannot start: not configured");

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  const args = [
    "gateway",
    "run",
    "--bind",
    "loopback",
    "--port",
    String(INTERNAL_GATEWAY_PORT),
    "--auth",
    "token",
    "--token",
    CLAWDBOT_GATEWAY_TOKEN,
  ];

  gatewayProc = childProcess.spawn(CLAWDBOT_NODE, clawArgs(args), {
    stdio: "inherit",
    env: {
      ...process.env,
      CLAWDBOT_STATE_DIR: STATE_DIR,
      CLAWDBOT_WORKSPACE_DIR: WORKSPACE_DIR,
    },
  });

  gatewayProc.on("error", (err) => {
    console.error(`[gateway] spawn error: ${String(err)}`);
    gatewayProc = null;
  });

  gatewayProc.on("exit", (code, signal) => {
    console.error(`[gateway] exited code=${code} signal=${signal}`);
    gatewayProc = null;
  });
}

async function ensureGatewayRunning() {
  if (!isConfigured()) return { ok: false, reason: "not configured" };
  if (gatewayProc) return { ok: true };
  if (!gatewayStarting) {
    gatewayStarting = (async () => {
      await startGateway();
      const ready = await waitForGatewayReady({ timeoutMs: 20_000 });
      if (!ready) {
        throw new Error("Gateway did not become ready in time");
      }
    })().finally(() => {
      gatewayStarting = null;
    });
  }
  await gatewayStarting;
  return { ok: true };
}

async function restartGateway() {
  if (gatewayProc) {
    try {
      gatewayProc.kill("SIGTERM");
    } catch {
      // ignore
    }
    // Give it a moment to exit and release the port.
    await sleep(750);
    gatewayProc = null;
  }
  return ensureGatewayRunning();
}

function requireSetupAuth(req, res, next) {
  if (!SETUP_PASSWORD) {
    return res
      .status(500)
      .type("text/plain")
      .send("SETUP_PASSWORD is not set. Set it in Railway Variables before using /setup.");
  }

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    res.set("WWW-Authenticate", 'Basic realm="Clawdbot Setup"');
    return res.status(401).send("Auth required");
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  if (password !== SETUP_PASSWORD) {
    res.set("WWW-Authenticate", 'Basic realm="Clawdbot Setup"');
    return res.status(401).send("Invalid password");
  }
  return next();
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

// Minimal health endpoint for Railway.
app.get("/setup/healthz", (_req, res) => res.json({ ok: true }));

app.get("/setup/app.js", requireSetupAuth, (_req, res) => {
  // Serve JS for /setup (kept external to avoid inline encoding/template issues)
  res.type("application/javascript");
  res.send(fs.readFileSync(path.join(process.cwd(), "src", "setup-app.js"), "utf8"));
});

app.get("/setup", requireSetupAuth, (_req, res) => {
  // No inline <script>: serve JS from /setup/app.js to avoid any encoding/template-literal issues.
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Clawdbot Setup</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; margin: 2rem; max-width: 900px; }
    .card { border: 1px solid #ddd; border-radius: 12px; padding: 1.25rem; margin: 1rem 0; }
    label { display:block; margin-top: 0.75rem; font-weight: 600; }
    input, select { width: 100%; padding: 0.6rem; margin-top: 0.25rem; }
    button { padding: 0.8rem 1.2rem; border-radius: 10px; border: 0; background: #111; color: #fff; font-weight: 700; cursor: pointer; }
    code { background: #f6f6f6; padding: 0.1rem 0.3rem; border-radius: 6px; }
    .muted { color: #555; }
  </style>
</head>
<body>
  <h1>Clawdbot Setup</h1>
  <p class="muted">This wizard configures Clawdbot by running the same onboarding command it uses in the terminal, but from the browser.</p>

  <div class="card">
    <h2>Status</h2>
    <div id="status">Loading...</div>
    <div style="margin-top: 0.75rem">
      <a href="/clawdbot" target="_blank">Open Clawdbot UI</a>
      &nbsp;|&nbsp;
      <a href="/setup/export" target="_blank">Download backup (.tar.gz)</a>
    </div>
  </div>

  <div class="card">
    <h2>1) Primary Auth Provider</h2>
    <p class="muted">Select your primary authentication method for the initial setup.</p>
    <label>Provider group</label>
    <select id="authGroup"></select>

    <label>Auth method</label>
    <select id="authChoice"></select>

    <label>Key / Token (if required)</label>
    <input id="authSecret" type="password" placeholder="Paste API key / token if applicable" />

    <label>Wizard flow</label>
    <select id="flow">
      <option value="quickstart">quickstart</option>
      <option value="advanced">advanced</option>
      <option value="manual">manual</option>
    </select>
  </div>

  <div class="card">
    <h2>2) API Providers</h2>
    <p class="muted">Configure API keys for different model providers. You can use models from any configured provider.</p>

    <div id="providersContainer">
      <div class="provider-item" style="padding: 1rem; background: #f9f9f9; border-radius: 8px; margin-bottom: 1rem;">
        <div style="display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.5rem;">
          <select class="provider-type" style="width: 150px;">
            <option value="">-- Select --</option>
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
            <option value="openrouter">OpenRouter</option>
            <option value="google">Google</option>
            <option value="custom">Custom</option>
          </select>
          <input class="provider-apikey" type="password" placeholder="API Key" style="flex: 1;" />
          <button type="button" class="remove-provider-btn" style="background: #dc2626; padding: 0.5rem;">Remove</button>
        </div>
        <div class="provider-custom-url" style="display: none; margin-top: 0.5rem;">
          <input class="provider-baseurl" type="text" placeholder="Base URL (e.g., https://api.example.com/v1)" style="width: 100%;" />
        </div>
      </div>
    </div>
    <button type="button" id="addProviderBtn" style="background: #16a34a; margin-top: 0.5rem;">+ Add Provider</button>

    <div class="muted" style="margin-top: 1rem; font-size: 0.85em;">
      <strong>Provider URLs:</strong><br/>
      • Anthropic: https://api.anthropic.com<br/>
      • OpenAI: https://api.openai.com/v1<br/>
      • OpenRouter: https://openrouter.ai/api/v1<br/>
      • Google: https://generativelanguage.googleapis.com
    </div>
  </div>

  <div class="card">
    <h2>3) Agent Defaults</h2>
    <p class="muted">Configure default model and behavior settings for the agent.</p>

    <div style="padding: 1rem; background: #f0f9ff; border-radius: 8px; margin-bottom: 1rem;">
      <strong>Model Configuration</strong>
      <p class="muted" style="margin: 0.25rem 0; font-size: 0.85em;">
        Use format: provider/model-name (e.g., anthropic/claude-sonnet-4, openai/gpt-4o, openrouter/meta-llama/llama-3.3-70b-instruct)
      </p>

      <label>Primary Model</label>
      <input id="primaryModel" type="text" placeholder="e.g., anthropic/claude-sonnet-4" />

      <label>Fallback Models (comma-separated)</label>
      <input id="fallbackModels" type="text" placeholder="e.g., openai/gpt-4o, openrouter/deepseek/deepseek-chat" />
      <div class="muted" style="margin-top: 0.25rem; font-size: 0.85em;">Backup models if primary is unavailable</div>
    </div>

    <div style="padding: 1rem; background: #fef3c7; border-radius: 8px; margin-bottom: 1rem;">
      <strong>Image/Vision Model (optional)</strong>

      <label>Image Model</label>
      <input id="imageModel" type="text" placeholder="e.g., openai/gpt-4o, anthropic/claude-sonnet-4" />

      <label>Image Model Fallbacks (comma-separated)</label>
      <input id="imageFallbackModels" type="text" placeholder="e.g., google/gemini-pro-vision" />
      <div class="muted" style="margin-top: 0.25rem; font-size: 0.85em;">Leave empty to use primary model for vision tasks</div>
    </div>

    <label>Thinking Level</label>
    <select id="thinkingDefault">
      <option value="">-- Default --</option>
      <option value="off">Off - No reasoning</option>
      <option value="minimal">Minimal</option>
      <option value="low">Low</option>
      <option value="medium">Medium</option>
      <option value="high">High</option>
      <option value="xhigh">Extra High - Maximum reasoning</option>
    </select>
    <div class="muted" style="margin-top: 0.25rem; font-size: 0.85em;">Controls AI reasoning depth (higher = more thorough but slower)</div>

    <label>User Timezone (optional)</label>
    <select id="userTimezone">
      <option value="">-- Auto-detect --</option>
      <option value="UTC">UTC</option>
      <option value="America/New_York">America/New_York (EST/EDT)</option>
      <option value="America/Los_Angeles">America/Los_Angeles (PST/PDT)</option>
      <option value="America/Chicago">America/Chicago (CST/CDT)</option>
      <option value="Europe/London">Europe/London (GMT/BST)</option>
      <option value="Europe/Paris">Europe/Paris (CET/CEST)</option>
      <option value="Europe/Berlin">Europe/Berlin (CET/CEST)</option>
      <option value="Asia/Tokyo">Asia/Tokyo (JST)</option>
      <option value="Asia/Shanghai">Asia/Shanghai (CST)</option>
      <option value="Asia/Hong_Kong">Asia/Hong_Kong (HKT)</option>
      <option value="Asia/Singapore">Asia/Singapore (SGT)</option>
      <option value="Asia/Seoul">Asia/Seoul (KST)</option>
      <option value="Australia/Sydney">Australia/Sydney (AEST/AEDT)</option>
    </select>
    <div class="muted" style="margin-top: 0.25rem; font-size: 0.85em;">IANA timezone for timestamps</div>

    <label>Workspace Path (optional)</label>
    <input id="workspacePath" type="text" placeholder="/data/workspace" />
    <div class="muted" style="margin-top: 0.25rem; font-size: 0.85em;">Default working directory for the agent</div>
  </div>

  <div class="card">
    <h2>4) Optional: Channels</h2>
    <p class="muted">You can also add channels later inside Clawdbot, but this helps you get messaging working immediately.</p>

    <label>Telegram bot token (optional)</label>
    <input id="telegramToken" type="password" placeholder="123456:ABC..." />
    <div class="muted" style="margin-top: 0.25rem">
      Get it from BotFather: open Telegram, message <code>@BotFather</code>, run <code>/newbot</code>, then copy the token.
    </div>

    <label>Discord bot token (optional)</label>
    <input id="discordToken" type="password" placeholder="Bot token" />
    <div class="muted" style="margin-top: 0.25rem">
      Get it from the Discord Developer Portal: create an application, add a Bot, then copy the Bot Token.<br/>
      <strong>Important:</strong> Enable <strong>MESSAGE CONTENT INTENT</strong> in Bot → Privileged Gateway Intents, or the bot will crash on startup.
    </div>

    <label>Slack bot token (optional)</label>
    <input id="slackBotToken" type="password" placeholder="xoxb-..." />

    <label>Slack app token (optional)</label>
    <input id="slackAppToken" type="password" placeholder="xapp-..." />
  </div>

  <div class="card">
    <h2>5) Run onboarding</h2>
    <button id="run">Run setup</button>
    <button id="pairingApprove" style="background:#1f2937; margin-left:0.5rem">Approve pairing</button>
    <button id="reset" style="background:#444; margin-left:0.5rem">Reset setup</button>
    <pre id="log" style="white-space:pre-wrap"></pre>
    <p class="muted">Reset deletes the Clawdbot config file so you can rerun onboarding. Pairing approval lets you grant DM access when dmPolicy=pairing.</p>
  </div>

  <script src="/setup/app.js"></script>
</body>
</html>`);
});

app.get("/setup/api/status", requireSetupAuth, async (_req, res) => {
  const version = await runCmd(CLAWDBOT_NODE, clawArgs(["--version"]));
  const channelsHelp = await runCmd(CLAWDBOT_NODE, clawArgs(["channels", "add", "--help"]));

  // We reuse Clawdbot's own auth-choice grouping logic indirectly by hardcoding the same group defs.
  // This is intentionally minimal; later we can parse the CLI help output to stay perfectly in sync.
  const authGroups = [
    {
      value: "openai", label: "OpenAI", hint: "Codex OAuth + API key", options: [
        { value: "codex-cli", label: "OpenAI Codex OAuth (Codex CLI)" },
        { value: "openai-codex", label: "OpenAI Codex (ChatGPT OAuth)" },
        { value: "openai-api-key", label: "OpenAI API key" }
      ]
    },
    {
      value: "anthropic", label: "Anthropic", hint: "Claude Code CLI + API key", options: [
        { value: "claude-cli", label: "Anthropic token (Claude Code CLI)" },
        { value: "token", label: "Anthropic token (paste setup-token)" },
        { value: "apiKey", label: "Anthropic API key" }
      ]
    },
    {
      value: "google", label: "Google", hint: "Gemini API key + OAuth", options: [
        { value: "gemini-api-key", label: "Google Gemini API key" },
        { value: "google-antigravity", label: "Google Antigravity OAuth" },
        { value: "google-gemini-cli", label: "Google Gemini CLI OAuth" }
      ]
    },
    {
      value: "openrouter", label: "OpenRouter", hint: "API key", options: [
        { value: "openrouter-api-key", label: "OpenRouter API key" }
      ]
    },
    {
      value: "ai-gateway", label: "Vercel AI Gateway", hint: "API key", options: [
        { value: "ai-gateway-api-key", label: "Vercel AI Gateway API key" }
      ]
    },
    {
      value: "moonshot", label: "Moonshot AI", hint: "Kimi K2 + Kimi Code", options: [
        { value: "moonshot-api-key", label: "Moonshot AI API key" },
        { value: "kimi-code-api-key", label: "Kimi Code API key" }
      ]
    },
    {
      value: "zai", label: "Z.AI (GLM 4.7)", hint: "API key", options: [
        { value: "zai-api-key", label: "Z.AI (GLM 4.7) API key" }
      ]
    },
    {
      value: "minimax", label: "MiniMax", hint: "M2.1 (recommended)", options: [
        { value: "minimax-api", label: "MiniMax M2.1" },
        { value: "minimax-api-lightning", label: "MiniMax M2.1 Lightning" }
      ]
    },
    {
      value: "qwen", label: "Qwen", hint: "OAuth", options: [
        { value: "qwen-portal", label: "Qwen OAuth" }
      ]
    },
    {
      value: "copilot", label: "Copilot", hint: "GitHub + local proxy", options: [
        { value: "github-copilot", label: "GitHub Copilot (GitHub device login)" },
        { value: "copilot-proxy", label: "Copilot Proxy (local)" }
      ]
    },
    {
      value: "synthetic", label: "Synthetic", hint: "Anthropic-compatible (multi-model)", options: [
        { value: "synthetic-api-key", label: "Synthetic API key" }
      ]
    },
    {
      value: "opencode-zen", label: "OpenCode Zen", hint: "API key", options: [
        { value: "opencode-zen", label: "OpenCode Zen (multi-model proxy)" }
      ]
    }
  ];

  res.json({
    configured: isConfigured(),
    gatewayTarget: GATEWAY_TARGET,
    clawdbotVersion: version.output.trim(),
    channelsAddHelp: channelsHelp.output,
    authGroups,
  });
});

function buildOnboardArgs(payload) {
  const args = [
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--json",
    "--no-install-daemon",
    "--skip-health",
    "--workspace",
    WORKSPACE_DIR,
    // The wrapper owns public networking; keep the gateway internal.
    "--gateway-bind",
    "loopback",
    "--gateway-port",
    String(INTERNAL_GATEWAY_PORT),
    "--gateway-auth",
    "token",
    "--gateway-token",
    CLAWDBOT_GATEWAY_TOKEN,
    "--flow",
    payload.flow || "quickstart"
  ];

  if (payload.authChoice) {
    args.push("--auth-choice", payload.authChoice);

    // Map secret to correct flag for common choices.
    const secret = (payload.authSecret || "").trim();
    const map = {
      "openai-api-key": "--openai-api-key",
      "apiKey": "--anthropic-api-key",
      "openrouter-api-key": "--openrouter-api-key",
      "ai-gateway-api-key": "--ai-gateway-api-key",
      "moonshot-api-key": "--moonshot-api-key",
      "kimi-code-api-key": "--kimi-code-api-key",
      "gemini-api-key": "--gemini-api-key",
      "zai-api-key": "--zai-api-key",
      "minimax-api": "--minimax-api-key",
      "minimax-api-lightning": "--minimax-api-key",
      "synthetic-api-key": "--synthetic-api-key",
      "opencode-zen": "--opencode-zen-api-key"
    };
    const flag = map[payload.authChoice];
    if (flag && secret) {
      args.push(flag, secret);
    }

    if (payload.authChoice === "token" && secret) {
      // This is the Anthropics setup-token flow.
      args.push("--token-provider", "anthropic", "--token", secret);
    }
  }

  return args;
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const proc = childProcess.spawn(cmd, args, {
      ...opts,
      env: {
        ...process.env,
        CLAWDBOT_STATE_DIR: STATE_DIR,
        CLAWDBOT_WORKSPACE_DIR: WORKSPACE_DIR,
      },
    });

    let out = "";
    proc.stdout?.on("data", (d) => (out += d.toString("utf8")));
    proc.stderr?.on("data", (d) => (out += d.toString("utf8")));

    proc.on("error", (err) => {
      out += `\n[spawn error] ${String(err)}\n`;
      resolve({ code: 127, output: out });
    });

    proc.on("close", (code) => resolve({ code: code ?? 0, output: out }));
  });
}

// Provider default URLs and API types for models.providers configuration
const providerDefaults = {
  'anthropic': {
    baseUrl: 'https://api.anthropic.com',
    api: 'anthropic-messages'
  },
  'openai': {
    baseUrl: 'https://api.openai.com/v1',
    api: 'openai-completions'
  },
  'openrouter': {
    baseUrl: 'https://openrouter.ai/api/v1',
    api: 'openai-completions'
  },
  'google': {
    baseUrl: 'https://generativelanguage.googleapis.com',
    api: 'google-generative-ai'
  },
  'moonshot': {
    baseUrl: 'https://api.moonshot.ai/v1',
    api: 'openai-completions'
  }
};

// Map auth choices to provider names for models.providers
const authChoiceToProvider = {
  'openrouter-api-key': 'openrouter',
  'openai-api-key': 'openai',
  'apiKey': 'anthropic',
  'gemini-api-key': 'google',
  'moonshot-api-key': 'moonshot',
  'kimi-code-api-key': 'moonshot'
};

// Helper function to set providers configuration
// Based on openclaw schema: models.providers
async function setProvidersConfig(payload) {
  let extra = "";

  // Build models.providers config object
  // Schema: Record<string, { baseUrl: string, apiKey?: string, api?: string, models: [] }>
  const providersConfig = {};

  // First, add the primary auth provider if it's API-based
  const authChoice = payload.authChoice;
  const authSecret = (payload.authSecret || "").trim();
  if (authChoice && authSecret && authChoiceToProvider[authChoice]) {
    const providerName = authChoiceToProvider[authChoice];
    const defaults = providerDefaults[providerName];
    if (defaults) {
      providersConfig[providerName] = {
        baseUrl: defaults.baseUrl,
        apiKey: authSecret,
        api: defaults.api,
        models: []
      };
      extra += `[auth-provider] auto-added ${providerName} from primary auth\n`;
    }
  }

  // Then add any additional providers from the providers section
  const providers = payload.providers;
  if (providers && typeof providers === 'object') {
    for (const [name, config] of Object.entries(providers)) {
      if (!config.apiKey) continue;

      // Don't overwrite if already set from auth
      if (providersConfig[name]) {
        extra += `[providers] ${name} already configured from auth, skipping duplicate\n`;
        continue;
      }

      providersConfig[name] = {
        baseUrl: config.baseUrl || '',
        apiKey: config.apiKey,
        models: []
      };

      if (config.api) {
        providersConfig[name].api = config.api;
      }
    }
  }

  if (Object.keys(providersConfig).length > 0) {
    const provSet = await runCmd(
      CLAWDBOT_NODE,
      clawArgs(["config", "set", "--json", "models.providers", JSON.stringify(providersConfig)]),
    );
    extra += `[providers] configured: ${Object.keys(providersConfig).join(', ')} (exit=${provSet.code})\n${provSet.output || "(no output)"}\n`;
  }

  return extra;
}

// Helper function to set agent defaults configuration
// Based on openclaw schema: agents.defaults.model, imageModel, thinkingDefault, userTimezone, workspace
async function setAgentDefaults(payload) {
  let extra = "";

  // Set model configuration (AgentModelListConfig: { primary?: string, fallbacks?: string[] })
  const primaryModel = payload.primaryModel?.trim();
  const fallbacks = Array.isArray(payload.fallbackModels)
    ? payload.fallbackModels.filter(f => f && f.trim())
    : [];

  if (primaryModel) {
    const modelConfig = { primary: primaryModel };
    if (fallbacks.length > 0) {
      modelConfig.fallbacks = fallbacks;
    }

    const modelSet = await runCmd(
      CLAWDBOT_NODE,
      clawArgs(["config", "set", "--json", "agents.defaults.model", JSON.stringify(modelConfig)]),
    );
    extra += `[model] primary: ${primaryModel}${fallbacks.length > 0 ? `, fallbacks: ${fallbacks.join(', ')}` : ''} (exit=${modelSet.code})\n${modelSet.output || "(no output)"}\n`;
  }

  // Set imageModel configuration if specified
  const imageModel = payload.imageModel?.trim();
  const imageFallbacks = Array.isArray(payload.imageFallbackModels)
    ? payload.imageFallbackModels.filter(f => f && f.trim())
    : [];

  if (imageModel || imageFallbacks.length > 0) {
    const imageModelConfig = {};
    if (imageModel) imageModelConfig.primary = imageModel;
    if (imageFallbacks.length > 0) imageModelConfig.fallbacks = imageFallbacks;

    const imageSet = await runCmd(
      CLAWDBOT_NODE,
      clawArgs(["config", "set", "--json", "agents.defaults.imageModel", JSON.stringify(imageModelConfig)]),
    );
    extra += `[imageModel] ${imageModel ? `primary: ${imageModel}` : ''}${imageFallbacks.length > 0 ? ` fallbacks: ${imageFallbacks.join(', ')}` : ''} (exit=${imageSet.code})\n${imageSet.output || "(no output)"}\n`;
  }

  // Set thinkingDefault (valid values: "off", "minimal", "low", "medium", "high", "xhigh")
  const thinkingDefault = payload.thinkingDefault?.trim();
  if (thinkingDefault && ["off", "minimal", "low", "medium", "high", "xhigh"].includes(thinkingDefault)) {
    const thinkingSet = await runCmd(
      CLAWDBOT_NODE,
      clawArgs(["config", "set", "agents.defaults.thinkingDefault", thinkingDefault]),
    );
    extra += `[thinkingDefault] ${thinkingDefault} (exit=${thinkingSet.code})\n${thinkingSet.output || "(no output)"}\n`;
  }

  // Set userTimezone (IANA timezone string)
  const userTimezone = payload.userTimezone?.trim();
  if (userTimezone) {
    const tzSet = await runCmd(
      CLAWDBOT_NODE,
      clawArgs(["config", "set", "agents.defaults.userTimezone", userTimezone]),
    );
    extra += `[userTimezone] ${userTimezone} (exit=${tzSet.code})\n${tzSet.output || "(no output)"}\n`;
  }

  // Set workspace path
  const workspacePath = payload.workspacePath?.trim();
  if (workspacePath) {
    const wsSet = await runCmd(
      CLAWDBOT_NODE,
      clawArgs(["config", "set", "agents.defaults.workspace", workspacePath]),
    );
    extra += `[workspace] ${workspacePath} (exit=${wsSet.code})\n${wsSet.output || "(no output)"}\n`;
  }

  return extra;
}

app.post("/setup/api/run", requireSetupAuth, async (req, res) => {
  try {
    const payload = req.body || {};

    if (isConfigured()) {
      // Already configured - but still allow updating providers and agent defaults
      let extra = "";

      // Check if any configuration was provided
      const hasProviders = payload.providers && Object.keys(payload.providers).length > 0;
      const hasAuthProvider = payload.authChoice && payload.authSecret && authChoiceToProvider[payload.authChoice];
      const hasModel = payload.primaryModel || payload.imageModel;
      const hasDefaults = payload.thinkingDefault || payload.userTimezone || payload.workspacePath;

      if (hasProviders || hasAuthProvider || hasModel || hasDefaults) {
        // Set providers config (includes auto-adding auth provider)
        extra += await setProvidersConfig(payload);

        // Set agent defaults
        extra += await setAgentDefaults(payload);

        extra += "\nRestarting gateway to apply changes...\n";

        // Kill existing gateway so it restarts with new settings
        try {
          await runCmd("pkill", ["-f", "clawdbot.*gateway"]);
        } catch (e) { /* ignore */ }
      }

      await ensureGatewayRunning();
      return res.json({ ok: true, output: "Already configured.\n" + extra + "Use Reset setup if you want to rerun full onboarding.\n" });
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

    const onboardArgs = buildOnboardArgs(payload);
    const onboard = await runCmd(CLAWDBOT_NODE, clawArgs(onboardArgs));

    let extra = "";

    const ok = onboard.code === 0 && isConfigured();

    // Optional channel setup (only after successful onboarding, and only if the installed CLI supports it).
    if (ok) {
      // Ensure gateway token is written into config so the browser UI can authenticate reliably.
      // (We also enforce loopback bind since the wrapper proxies externally.)
      await runCmd(CLAWDBOT_NODE, clawArgs(["config", "set", "gateway.auth.mode", "token"]));
      await runCmd(CLAWDBOT_NODE, clawArgs(["config", "set", "gateway.auth.token", CLAWDBOT_GATEWAY_TOKEN]));
      await runCmd(CLAWDBOT_NODE, clawArgs(["config", "set", "gateway.bind", "loopback"]));
      await runCmd(CLAWDBOT_NODE, clawArgs(["config", "set", "gateway.port", String(INTERNAL_GATEWAY_PORT)]));

      // Set providers config (models.providers)
      const providersExtra = await setProvidersConfig(payload);
      if (providersExtra) {
        extra += "\n" + providersExtra;
      }

      // Set agent defaults (model, imageModel, thinkingDefault, userTimezone, workspace)
      const agentDefaultsExtra = await setAgentDefaults(payload);
      if (agentDefaultsExtra) {
        extra += "\n" + agentDefaultsExtra;
      }

      const channelsHelp = await runCmd(CLAWDBOT_NODE, clawArgs(["channels", "add", "--help"]));
      const helpText = channelsHelp.output || "";

      const supports = (name) => helpText.includes(name);

      if (payload.telegramToken?.trim()) {
        if (!supports("telegram")) {
          extra += "\n[telegram] skipped (this clawdbot build does not list telegram in `channels add --help`)\n";
        } else {
          // Avoid `channels add` here (it has proven flaky across builds); write config directly.
          const token = payload.telegramToken.trim();
          const cfgObj = {
            enabled: true,
            dmPolicy: "pairing",
            botToken: token,
            groupPolicy: "allowlist",
            streamMode: "partial",
          };
          const set = await runCmd(
            CLAWDBOT_NODE,
            clawArgs(["config", "set", "--json", "channels.telegram", JSON.stringify(cfgObj)]),
          );
          const get = await runCmd(CLAWDBOT_NODE, clawArgs(["config", "get", "channels.telegram"]));
          extra += `\n[telegram config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
          extra += `\n[telegram verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
        }
      }

      if (payload.discordToken?.trim()) {
        if (!supports("discord")) {
          extra += "\n[discord] skipped (this clawdbot build does not list discord in `channels add --help`)\n";
        } else {
          const token = payload.discordToken.trim();
          const cfgObj = {
            enabled: true,
            token,
            groupPolicy: "allowlist",
            dm: {
              policy: "open",
              allowFrom: ["*"],
            },
          };
          const set = await runCmd(
            CLAWDBOT_NODE,
            clawArgs(["config", "set", "--json", "channels.discord", JSON.stringify(cfgObj)]),
          );
          const get = await runCmd(CLAWDBOT_NODE, clawArgs(["config", "get", "channels.discord"]));
          extra += `\n[discord config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
          extra += `\n[discord verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
        }
      }

      if (payload.slackBotToken?.trim() || payload.slackAppToken?.trim()) {
        if (!supports("slack")) {
          extra += "\n[slack] skipped (this clawdbot build does not list slack in `channels add --help`)\n";
        } else {
          const cfgObj = {
            enabled: true,
            botToken: payload.slackBotToken?.trim() || undefined,
            appToken: payload.slackAppToken?.trim() || undefined,
          };
          const set = await runCmd(
            CLAWDBOT_NODE,
            clawArgs(["config", "set", "--json", "channels.slack", JSON.stringify(cfgObj)]),
          );
          const get = await runCmd(CLAWDBOT_NODE, clawArgs(["config", "get", "channels.slack"]));
          extra += `\n[slack config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
          extra += `\n[slack verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
        }
      }

      // Apply changes immediately.
      await restartGateway();
    }

    return res.status(ok ? 200 : 500).json({
      ok,
      output: `${onboard.output}${extra}`,
    });
  } catch (err) {
    console.error("[/setup/api/run] error:", err);
    return res.status(500).json({ ok: false, output: `Internal error: ${String(err)}` });
  }
});

app.get("/setup/api/debug", requireSetupAuth, async (_req, res) => {
  const v = await runCmd(CLAWDBOT_NODE, clawArgs(["--version"]));
  const help = await runCmd(CLAWDBOT_NODE, clawArgs(["channels", "add", "--help"]));
  res.json({
    wrapper: {
      node: process.version,
      port: PORT,
      stateDir: STATE_DIR,
      workspaceDir: WORKSPACE_DIR,
      configPath: configPath(),
      gatewayTokenFromEnv: Boolean(process.env.CLAWDBOT_GATEWAY_TOKEN?.trim()),
      gatewayTokenPersisted: fs.existsSync(path.join(STATE_DIR, "gateway.token")),
      railwayCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    },
    clawdbot: {
      entry: CLAWDBOT_ENTRY,
      node: CLAWDBOT_NODE,
      version: v.output.trim(),
      channelsAddHelpIncludesTelegram: help.output.includes("telegram"),
    },
  });
});

app.post("/setup/api/pairing/approve", requireSetupAuth, async (req, res) => {
  const { channel, code } = req.body || {};
  if (!channel || !code) {
    return res.status(400).json({ ok: false, error: "Missing channel or code" });
  }
  const r = await runCmd(CLAWDBOT_NODE, clawArgs(["pairing", "approve", String(channel), String(code)]));
  return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: r.output });
});

// Fetch OpenRouter models list using the provided API key
app.post("/setup/api/openrouter/models", requireSetupAuth, async (req, res) => {
  const apiKey = (req.body?.apiKey || "").trim();
  if (!apiKey) {
    return res.status(400).json({ ok: false, error: "API key is required" });
  }

  try {
    const response = await fetch("https://openrouter.ai/api/v1/models", {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ ok: false, error: `OpenRouter API error: ${text}` });
    }

    const data = await response.json();
    // Filter and sort models - return id and name
    const models = (data.data || [])
      .filter((m) => m.id)
      .map((m) => ({
        id: m.id,
        name: m.name || m.id,
        context_length: m.context_length,
        pricing: m.pricing,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return res.json({ ok: true, models });
  } catch (err) {
    console.error("[openrouter/models] error:", err);
    return res.status(500).json({ ok: false, error: `Failed to fetch models: ${String(err)}` });
  }
});

app.post("/setup/api/reset", requireSetupAuth, async (_req, res) => {
  // Minimal reset: delete the config file so /setup can rerun.
  // Keep credentials/sessions/workspace by default.
  try {
    fs.rmSync(configPath(), { force: true });
    res.type("text/plain").send("OK - deleted config file. You can rerun setup now.");
  } catch (err) {
    res.status(500).type("text/plain").send(String(err));
  }
});

app.get("/setup/export", requireSetupAuth, async (_req, res) => {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  res.setHeader("content-type", "application/gzip");
  res.setHeader(
    "content-disposition",
    `attachment; filename="clawdbot-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz"`,
  );

  // Prefer exporting from a common /data root so archives are easy to inspect and restore.
  // This preserves dotfiles like /data/.clawdbot/clawdbot.json.
  const stateAbs = path.resolve(STATE_DIR);
  const workspaceAbs = path.resolve(WORKSPACE_DIR);

  const dataRoot = "/data";
  const underData = (p) => p === dataRoot || p.startsWith(dataRoot + path.sep);

  let cwd = "/";
  let paths = [stateAbs, workspaceAbs].map((p) => p.replace(/^\//, ""));

  if (underData(stateAbs) && underData(workspaceAbs)) {
    cwd = dataRoot;
    // We export relative to /data so the archive contains: .clawdbot/... and workspace/...
    paths = [
      path.relative(dataRoot, stateAbs) || ".",
      path.relative(dataRoot, workspaceAbs) || ".",
    ];
  }

  const stream = tar.c(
    {
      gzip: true,
      portable: true,
      noMtime: true,
      cwd,
      onwarn: () => { },
    },
    paths,
  );

  stream.on("error", (err) => {
    console.error("[export]", err);
    if (!res.headersSent) res.status(500);
    res.end(String(err));
  });

  stream.pipe(res);
});

// Proxy everything else to the gateway.
const proxy = httpProxy.createProxyServer({
  target: GATEWAY_TARGET,
  ws: true,
  xfwd: true,
});

proxy.on("error", (err, _req, _res) => {
  console.error("[proxy]", err);
});

app.use(async (req, res) => {
  // If not configured, force users to /setup for any non-setup routes.
  if (!isConfigured() && !req.path.startsWith("/setup")) {
    return res.redirect("/setup");
  }

  if (isConfigured()) {
    try {
      await ensureGatewayRunning();
    } catch (err) {
      return res.status(503).type("text/plain").send(`Gateway not ready: ${String(err)}`);
    }
  }

  return proxy.web(req, res, { target: GATEWAY_TARGET });
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`[wrapper] listening on :${PORT}`);
  console.log(`[wrapper] state dir: ${STATE_DIR}`);
  console.log(`[wrapper] workspace dir: ${WORKSPACE_DIR}`);
  console.log(`[wrapper] gateway token: ${CLAWDBOT_GATEWAY_TOKEN ? "(set)" : "(missing)"}`);
  console.log(`[wrapper] gateway target: ${GATEWAY_TARGET}`);
  if (!SETUP_PASSWORD) {
    console.warn("[wrapper] WARNING: SETUP_PASSWORD is not set; /setup will error.");
  }
  // Don't start gateway unless configured; proxy will ensure it starts.
});

server.on("upgrade", async (req, socket, head) => {
  if (!isConfigured()) {
    socket.destroy();
    return;
  }
  try {
    await ensureGatewayRunning();
  } catch {
    socket.destroy();
    return;
  }
  proxy.ws(req, socket, head, { target: GATEWAY_TARGET });
});

process.on("SIGTERM", () => {
  // Best-effort shutdown
  try {
    if (gatewayProc) gatewayProc.kill("SIGTERM");
  } catch {
    // ignore
  }
  process.exit(0);
});
