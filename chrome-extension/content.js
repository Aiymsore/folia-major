// chrome-extension/content.js
// Folia companion — content script for https://music.apple.com/*.
//
// WHAT THIS IS: the extension's half of the two-world split, and nothing else. It runs in the
// ISOLATED world, which is the only place `chrome.*` exists — and the one place `window.MusicKit`
// does NOT (page globals are not shared across worlds). The MusicKit work therefore lives in
// `page-bridge.js` (manifest `"world": "MAIN"`), and this file is the relay between it and the
// service worker:
//
//     background.js  ──chrome.tabs.sendMessage──▶  content.js  ──window.postMessage──▶  page-bridge.js
//
// Reading MusicKit from here is what made every observation report `player-declined` on a page whose
// player was working: see the header of page-bridge.js for the evidence.
//
// WHAT THIS IS NOT: it never touches DRM, never reads media, and never proxies Apple's traffic. It
// moves JSON between two contexts.

(() => {
  'use strict';

  const PAGE_MARKER = '__foliaCompanionPageBridge';
  const POLL_INTERVAL_MS = 250;
  // Under the service worker's own 8s content-command timeout, so a page bridge that never answers
  // still produces a reply the worker can act on instead of a timeout it can only report.
  const REQUEST_TIMEOUT_MS = 4_000;
  const SOURCE_ID = 'apple-music-web';

  // Re-injection guard: a content script can be injected more than once into the same document (an
  // extension reload, a manual re-inject during development). The page global keeps a second copy
  // from installing a second message listener, which would double every observation.
  if (window.__foliaCompanionInstalled) {
    return;
  }
  window.__foliaCompanionInstalled = true;

  const logWarn = (...args) => console.warn('[Folia companion]', ...args);

  /** id -> { resolve, timer } for requests waiting on the page bridge. */
  const pending = new Map();
  let requestCounter = 0;

  function requestPage(kind, payload, timeoutMs = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve) => {
      const id = `${Date.now().toString(36)}-${requestCounter++}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(null);
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      try {
        window.postMessage({ marker: PAGE_MARKER, type: 'request', id, kind, ...payload }, window.location.origin);
      } catch (error) {
        // The window is going away; answer the caller rather than leaving the promise pending.
        clearTimeout(timer);
        pending.delete(id);
        logWarn('could not post to the page bridge', error);
        resolve(null);
      }
    });
  }

  /**
   * A read from the page bridge, or the honest "it is not there" observation.
   *
   * A missing bridge is not hypothetical: it is what a tab loaded BEFORE the extension was installed
   * or reloaded looks like (the manifest injects content scripts at page load), and it is also what a
   * page mid-teardown looks like. Both are answered with `player-declined`, whose user action is
   * "reload the music.apple.com tab" — the same action, and a real one.
   */
  async function readObservationFromPage() {
    const reply = await requestPage('readObservation');
    if (!reply || !reply.observation) {
      return {
        observation: {
          connected: false,
          identity: null,
          playbackStatus: null,
          positionMs: null,
          positionEstablishedAtMs: null,
          observedAtMs: Date.now(),
        },
        errorKind: 'player-declined',
      };
    }
    return { observation: reply.observation, errorKind: reply.errorKind ?? null };
  }

  function replyToBackground(message) {
    try {
      // No receiver (service worker asleep) is normal and must not surface as an unhandled rejection.
      const pendingSend = chrome.runtime.sendMessage(message);
      if (pendingSend && typeof pendingSend.catch === 'function') {
        pendingSend.catch(() => {});
      }
    } catch {
      // The extension context was invalidated (reload/update). Nothing useful to do from here.
    }
  }

  // --- observation forwarding --------------------------------------------------------------------

  let lastSerialized = '';

  function publish(observation, errorKind, force = false) {
    // Deduplicate unless forced: the poll runs four times a second and the renderer only cares about
    // changes. The heartbeat is what proves liveness, so a suppressed duplicate is not a missed
    // signal — and a forced read is how a heartbeat gets current state anyway.
    const serialized = `${JSON.stringify(observation)}|${errorKind ?? ''}`;
    if (!force && serialized === lastSerialized) {
      return;
    }
    lastSerialized = serialized;
    replyToBackground({ type: 'observation', observation, errorKind: errorKind ?? null });
  }

  // Pushes from the page bridge: MusicKit events (immediate) and its first read.
  window.addEventListener('message', (event) => {
    if (event.source !== window) {
      return;
    }
    const data = event.data;
    if (!data || typeof data !== 'object' || data.marker !== PAGE_MARKER) {
      return;
    }

    if (data.type === 'push' && data.observation) {
      publish(data.observation, data.errorKind ?? null);
      return;
    }

    if (data.type === 'reply') {
      const entry = pending.get(data.id);
      if (!entry) {
        // Late (already timed out) or unknown id. Nothing left to hand it to.
        return;
      }
      pending.delete(data.id);
      clearTimeout(entry.timer);
      entry.resolve(data);
    }
  });

  // The poll deliberately keeps running while the tab is hidden: Folia is usually the focused window
  // and music.apple.com is the background tab, which is exactly when the observation still has to
  // flow. It also covers the events a future MusicKit renames.
  setInterval(() => {
    void readObservationFromPage().then(({ observation, errorKind }) => {
      publish(observation, errorKind);
    });
  }, POLL_INTERVAL_MS);

  // A tab that is closing or navigating away is no longer controllable, and the last observation
  // would otherwise keep saying it is. Best-effort by nature: the service worker may be asleep.
  window.addEventListener('pagehide', () => {
    publish({
      connected: false,
      identity: null,
      playbackStatus: null,
      positionMs: null,
      positionEstablishedAtMs: null,
      observedAtMs: Date.now(),
    }, 'player-declined', true);
  });

  // --- messages from the service worker ----------------------------------------------------------

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    // The background worker's keepalive path: answer a `ping` with a live read even when nothing has
    // changed, so Folia gets proof of life rather than a deduplicated silence.
    if (message && message.type === 'readObservation') {
      readObservationFromPage().then(({ observation, errorKind }) => {
        // Recorded as the last published state so the next poll does not immediately re-send it.
        lastSerialized = `${JSON.stringify(observation)}|${errorKind ?? ''}`;
        sendResponse({ observation, errorKind: errorKind ?? null });
      });
      // Keeps the message channel open for the async reply above.
      return true;
    }

    if (!message || message.type !== 'command') {
      return false;
    }

    const commandId = message.id;
    requestPage('command', { command: message.command })
      .then((reply) => {
        // A null reply means the page bridge never answered: report it as the page refusing rather
        // than as a timeout the worker cannot tell apart from a dead tab.
        sendResponse({
          type: 'commandResult',
          id: commandId,
          ok: Boolean(reply && reply.ok === true),
          errorKind: reply ? (reply.errorKind ?? null) : 'player-declined',
          error: reply ? (reply.error ?? null) : 'the page bridge on the music.apple.com tab did not answer',
          targetSourceId: SOURCE_ID,
        });
      })
      .catch((error) => {
        sendResponse({
          type: 'commandResult',
          id: commandId,
          ok: false,
          errorKind: 'player-declined',
          error: String((error && error.message) || error),
          targetSourceId: SOURCE_ID,
        });
      });

    // Keeps the message channel open for the async reply above.
    return true;
  });

  // One immediate read so Folia does not wait a full interval for the first state. `force` because
  // this is also how a page that has been sitting idle announces itself after a service-worker wake.
  void readObservationFromPage().then(({ observation, errorKind }) => {
    publish(observation, errorKind, true);
  });
})();
