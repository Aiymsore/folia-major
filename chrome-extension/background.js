// chrome-extension/background.js
// Folia companion — MV3 service worker.
//
// Owns the single WebSocket to the Folia desktop bridge, relays commands down to the content script
// on music.apple.com, and relays observations back up. It holds no playback logic of its own: the
// page automation lives in content.js, next to the MusicKit instance it drives.
//
// MV3 REALITY: this worker is killed whenever Chrome decides it is idle, which closes the socket.
// Disconnection is therefore NORMAL, not an error, and the answer is always to reconnect with
// backoff. Folia's `ping` frames double as the keepalive — WebSocket activity extends a service
// worker's lifetime — but a worker that sleeps while Folia is closed is harmless and must not
// produce error spam.
//
// SECURITY NOTE: the token travels in the WebSocket URL query string (`?token=`) because a browser
// cannot set custom headers on `new WebSocket()`. That is the one place the token can reach a log.
// The connection is loopback-only and Folia can regenerate the token at any time.

'use strict';

const SOURCE_ID = 'apple-music-web';
const WS_PATH = '/external-media/ws';
const APPLE_MUSIC_MATCH = 'https://music.apple.com/*';
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
// A local ceiling under Folia's own command timeout, so this worker always answers even if the
// content script never does (a page that was reloaded mid-command, for instance).
const CONTENT_COMMAND_TIMEOUT_MS = 8_000;

const EXTENSION_VERSION = chrome.runtime.getManifest().version;
// Advertised to Folia so it can refuse to send a verb this build cannot carry out.
const CAPABILITIES = ['observe', 'play', 'pause', 'toggle', 'seek', 'playById'];

/** @type {WebSocket|null} */
let socket = null;
let reconnectTimer = null;
let backoffMs = MIN_BACKOFF_MS;
let reconnectAttempts = 0;
let config = { port: null, token: null };
let heartbeatIntervalMs = 15_000;
let lastObservationFrame = null;
let lastError = null;

// 'unconfigured' | 'connecting' | 'connected' | 'disconnected' | 'error'
let connectionState = 'unconfigured';

function getPublicStatus() {
  return {
    state: connectionState,
    port: config.port,
    hasToken: Boolean(config.token),
    extensionVersion: EXTENSION_VERSION,
    capabilities: CAPABILITIES.slice(),
    heartbeatIntervalMs,
    reconnectAttempts,
    lastError,
  };
}

// The options page is the only consumer, and it is usually closed, so a missing receiver is expected.
function broadcastStatus() {
  try {
    chrome.runtime.sendMessage({ type: 'status', status: getPublicStatus() }, () => {
      // Reading lastError is what marks the "no receiver" rejection as handled.
      void chrome.runtime.lastError;
    });
  } catch {
    // No receiver at all.
  }
}

function setConnectionState(state, error) {
  connectionState = state;
  lastError = error ? String(error) : null;
  broadcastStatus();
}

function clearReconnectTimer() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

// Exponential backoff with jitter: a fixed retry interval would have every Folia install hammering
// the loopback port in lockstep after a restart.
function scheduleReconnect() {
  if (reconnectTimer !== null) {
    return;
  }
  const jitter = Math.floor(Math.random() * 250);
  const delay = Math.min(backoffMs, MAX_BACKOFF_MS) + jitter;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
}

function sendFrame(frame) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  try {
    socket.send(JSON.stringify(frame));
    return true;
  } catch (error) {
    lastError = String((error && error.message) || error);
    return false;
  }
}

function sendHello() {
  sendFrame({
    type: 'hello',
    extensionVersion: EXTENSION_VERSION,
    sourceId: SOURCE_ID,
    capabilities: CAPABILITIES,
  });
}

// The latest observation is replayed right after `hello` so Folia does not sit on a stale reading
// until the page next changes.
function sendState(observation, errorKind) {
  const frame = {
    type: 'state',
    observation,
    errorKind: errorKind ?? null,
  };
  lastObservationFrame = frame;
  sendFrame(frame);
}

function sendResponse(id, ok, errorKind, error, targetSourceId) {
  sendFrame({
    type: 'response',
    id,
    ok: ok === true,
    errorKind: errorKind ?? null,
    error: error ?? null,
    targetSourceId: targetSourceId ?? null,
  });
}

// --- content-script relay -----------------------------------------------------------------------

async function findAppleMusicTab() {
  // `tabs` + the music.apple.com host permission make the url pattern queryable.
  const tabs = await chrome.tabs.query({ url: APPLE_MUSIC_MATCH });
  if (!tabs || tabs.length === 0) {
    return null;
  }
  // Prefer the tab the user is actually looking at; otherwise the first one.
  const active = tabs.find((tab) => tab.active);
  return active || tabs[0];
}

async function sendToContentScript(message, timeoutMs) {
  const tab = await findAppleMusicTab();
  if (!tab || typeof tab.id !== 'number') {
    return { ok: false, errorKind: 'tab-not-found', error: 'no music.apple.com tab is open' };
  }

  let timer = null;
  try {
    const replyPromise = chrome.tabs.sendMessage(tab.id, message);
    const reply = await Promise.race([
      replyPromise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    if (reply === null || reply === undefined) {
      // The losing branch of the race may still reject later (a tab closed mid-command); swallowing
      // it here keeps that from surfacing as an unhandled rejection in the service worker.
      if (replyPromise && typeof replyPromise.catch === 'function') {
        replyPromise.catch(() => {});
      }
      return {
        ok: false,
        errorKind: 'timeout',
        error: `the music.apple.com tab did not answer within ${timeoutMs}ms`,
      };
    }
    return { ok: true, reply };
  } catch (error) {
    // The tab exists but the content script did not answer: it was injected before the extension was
    // installed or reloaded, and only a page reload will fix that. Reported as a transport failure
    // rather than "no tab", because the tab is right there.
    return {
      ok: false,
      errorKind: 'transport-error',
      error: `the content script on the music.apple.com tab could not be reached: ${String(
        (error && error.message) || error,
      )}`,
    };
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

async function handleCommandFrame(id, command) {
  const outcome = await sendToContentScript(
    { type: 'command', id, command },
    CONTENT_COMMAND_TIMEOUT_MS,
  );
  if (!outcome.ok) {
    sendResponse(id, false, outcome.errorKind, outcome.error, null);
    return;
  }
  const reply = outcome.reply || {};
  sendResponse(id, reply.ok === true, reply.errorKind, reply.error, reply.targetSourceId ?? SOURCE_ID);
}

// A fresh read, forced past the content script's change dedupe. Used to answer Folia's ping with
// proof of life that also carries current state.
async function requestFreshObservation() {
  const outcome = await sendToContentScript({ type: 'readObservation' }, CONTENT_COMMAND_TIMEOUT_MS);
  if (outcome.ok && outcome.reply && outcome.reply.observation) {
    sendState(outcome.reply.observation, outcome.reply.errorKind);
  }
}

// --- connection ---------------------------------------------------------------------------------

function connect() {
  if (!config.port || !config.token) {
    // Not configured yet: do nothing and stay quiet. The options page is where the user fixes this,
    // and spamming the console before then helps nobody.
    setConnectionState('unconfigured');
    return;
  }
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
    return;
  }

  clearReconnectTimer();
  setConnectionState('connecting');

  // See the SECURITY NOTE at the top of this file: the token is in the query string because a
  // browser cannot put it in a header on a WebSocket handshake.
  const url = `ws://127.0.0.1:${config.port}${WS_PATH}?token=${encodeURIComponent(config.token)}`;

  let next;
  try {
    next = new WebSocket(url);
  } catch (error) {
    setConnectionState('error', (error && error.message) || error);
    scheduleReconnect();
    return;
  }
  socket = next;

  next.addEventListener('open', () => {
    backoffMs = MIN_BACKOFF_MS;
    reconnectAttempts = 0;
    setConnectionState('connected');
    sendHello();
    if (lastObservationFrame) {
      sendFrame(lastObservationFrame);
    }
  });

  next.addEventListener('message', (event) => {
    let frame = null;
    try {
      frame = JSON.parse(event.data);
    } catch {
      // Folia only ever writes JSON; anything else is dropped rather than guessed at.
      return;
    }
    if (!frame || typeof frame !== 'object') {
      return;
    }

    switch (frame.type) {
      case 'welcome':
        heartbeatIntervalMs = Number.isFinite(frame.heartbeatIntervalMs)
          ? frame.heartbeatIntervalMs
          : heartbeatIntervalMs;
        broadcastStatus();
        return;
      case 'ping':
        sendFrame({ type: 'pong', at: Date.now() });
        // Answered with a live observation too: the ping is Folia asking "are you still there", and
        // the most useful answer includes what the player is doing right now.
        requestFreshObservation().catch(() => {});
        return;
      case 'command':
        if (typeof frame.id === 'string') {
          handleCommandFrame(frame.id, frame.command).catch((error) => {
            sendResponse(frame.id, false, 'transport-error', String((error && error.message) || error), null);
          });
        }
        return;
      default:
        // Forward compatibility with a newer Folia: unknown frames are ignored.
        return;
    }
  });

  next.addEventListener('close', () => {
    if (socket === next) {
      socket = null;
      reconnectAttempts += 1;
      setConnectionState('disconnected');
      scheduleReconnect();
    }
  });

  next.addEventListener('error', () => {
    // The close event always follows, and that is where reconnection is scheduled. Recording the
    // state here keeps the options page honest while the socket is failing.
    if (socket === next) {
      setConnectionState('error', `could not reach ws://127.0.0.1:${config.port}`);
    }
  });
}

function disconnect() {
  clearReconnectTimer();
  const current = socket;
  socket = null;
  if (current) {
    try {
      current.close(1000, 'configuration changed');
    } catch {
      // Already closed.
    }
  }
}

async function loadConfig() {
  const stored = await chrome.storage.local.get(['port', 'token']);
  const port = Number(stored.port);
  config = {
    port: Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null,
    token: typeof stored.token === 'string' && stored.token ? stored.token : null,
  };
  return config;
}

// --- messages from the content script and the options page --------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') {
    return false;
  }

  if (message.type === 'observation') {
    sendState(message.observation, message.errorKind);
    return false;
  }

  if (message.type === 'getStatus') {
    sendResponse({ type: 'status', status: getPublicStatus() });
    return false;
  }

  if (message.type === 'reconnect') {
    // The options page's "Test connection" button: forget the backoff and try right now.
    backoffMs = MIN_BACKOFF_MS;
    disconnect();
    connect();
    sendResponse({ type: 'status', status: getPublicStatus() });
    return false;
  }

  return false;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || (!changes.port && !changes.token)) {
    return;
  }
  loadConfig()
    .then(() => {
      disconnect();
      connect();
    })
    .catch(() => {});
});

// Startup: load whatever the user saved and connect if it is complete.
loadConfig()
  .then(() => {
    connect();
  })
  .catch(() => {
    setConnectionState('unconfigured');
  });
