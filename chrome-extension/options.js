// chrome-extension/options.js
// Folia companion — options page logic. Plain DOM, no framework, no build step.
//
// Two jobs: persist `{port, token}` into chrome.storage.local (the service worker watches that key
// and reconnects on change), and show whether the bridge is actually reachable so the user is not
// left guessing whether they pasted the right token.

'use strict';

const DEFAULT_PORT = 32110;
const HEALTH_PATH = '/external-media/health';

const portInput = document.getElementById('port');
const tokenInput = document.getElementById('token');
const statusEl = document.getElementById('status');
const saveButton = document.getElementById('save');
const testButton = document.getElementById('test');

function setStatus(text, tone) {
  statusEl.textContent = text;
  statusEl.className = tone || '';
}

// Parsing lives in bridge-input.js: it accepts a whole `ws://127.0.0.1:32110` as well as the bare
// number, which is what the port field used to silently mangle (see that file's header).
function readForm() {
  const parsed = window.FoliaBridgeInput.parseBridgeInput(portInput.value, tokenInput.value);
  if (parsed.error) {
    return parsed;
  }
  // Normalize what is on screen so the user can see the value that will actually be saved.
  portInput.value = String(parsed.config.port);
  return parsed;
}

async function load() {
  const stored = await chrome.storage.local.get(['port', 'token']);
  const port = Number.parseInt(stored.port, 10);
  portInput.value = Number.isInteger(port) && port > 0 ? String(port) : String(DEFAULT_PORT);
  tokenInput.value = typeof stored.token === 'string' ? stored.token : '';
  if (!tokenInput.value) {
    setStatus('Not configured.', 'warn');
  }
  await refreshStatus();
}

async function save() {
  const parsed = readForm();
  if (parsed.error) {
    // A recoverable token still goes in the field: one paste of the full address should leave the
    // user with only the port left to fix, not both.
    if (parsed.token) {
      tokenInput.value = parsed.token;
    }
    setStatus(parsed.error, 'err');
    return false;
  }
  // The service worker's chrome.storage.onChanged listener reconnects with the new values.
  await chrome.storage.local.set(parsed.config);
  setStatus('Saved. Connecting…', 'ok');
  return true;
}

// Asks the service worker for its view of the socket. The worker is the only thing that knows
// whether the WebSocket is actually up, and it may be asleep — in which case this message wakes it.
function askServiceWorker() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'getStatus' }, (reply) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(reply && reply.status ? reply.status : null);
      });
    } catch {
      resolve(null);
    }
  });
}

// The definitive check: an HTTP probe of the bridge itself, with the token the user typed. This is
// the same call the extension makes, so a green result means the port AND the token are right.
async function probeBridge(port, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${HEALTH_PATH}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
      cache: 'no-store',
    });
    if (response.status === 401) {
      return { ok: false, message: 'The bridge rejected the token (401). Copy it again from Folia.' };
    }
    if (!response.ok) {
      return { ok: false, message: `The bridge answered HTTP ${response.status}.` };
    }
    const body = await response.json();
    if (body && body.ok === true) {
      return {
        ok: true,
        message: `Bridge reachable (protocol v${body.version}). Extension socket: ${
          body.extensionConnected ? 'connected' : 'connecting…'
        }`,
      };
    }
    return { ok: false, message: 'The bridge answered with an unexpected body.' };
  } catch (error) {
    const reason = error && error.name === 'AbortError' ? 'the probe timed out' : String(error && error.message);
    return {
      ok: false,
      message: `Could not reach Folia on 127.0.0.1:${port} — ${reason}. Is Folia running with external media control enabled?`,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function refreshStatus() {
  const status = await askServiceWorker();
  if (!status) {
    setStatus('The extension service worker is not answering. Reload the extension.', 'err');
    return;
  }

  const labels = {
    unconfigured: ['Not configured.', 'warn'],
    connecting: ['Connecting to Folia…', 'warn'],
    connected: ['Connected to Folia.', 'ok'],
    disconnected: ['Disconnected — retrying in the background.', 'warn'],
    error: [`Connection error: ${status.lastError || 'unknown'}`, 'err'],
  };
  const [text, tone] = labels[status.state] || ['Unknown state.', 'warn'];
  setStatus(text, tone);
}

saveButton.addEventListener('click', () => {
  save().then((saved) => {
    if (saved) {
      refreshStatus();
    }
  });
});

testButton.addEventListener('click', async () => {
  const parsed = readForm();
  if (parsed.error) {
    if (parsed.token) {
      tokenInput.value = parsed.token;
    }
    setStatus(parsed.error, 'err');
    return;
  }
  setStatus('Probing the bridge…', 'warn');
  const result = await probeBridge(parsed.config.port, parsed.config.token);
  setStatus(result.message, result.ok ? 'ok' : 'err');
  if (result.ok) {
    // Nudge the worker to drop any backoff and reconnect now.
    try {
      chrome.runtime.sendMessage({ type: 'reconnect' }, () => {
        void chrome.runtime.lastError;
      });
    } catch {
      // Worker asleep; it will connect on its own schedule.
    }
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === 'status') {
    refreshStatus();
  }
  return false;
});

load().catch(() => {
  setStatus('Could not read the saved settings.', 'err');
});
