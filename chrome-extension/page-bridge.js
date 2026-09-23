// chrome-extension/page-bridge.js
// Folia companion — MAIN-world half. Reaches into the page's own MusicKit instance.
//
// WHY THIS FILE EXISTS: a normal content script runs in an ISOLATED WORLD. It shares the DOM with the
// page but NOT the page's JavaScript globals, so `window.MusicKit` — set by Apple's bundle in the
// page's own world — is `undefined` there. Reading it from content.js reported `player-declined` for
// a page whose player was working perfectly: `typeof window.MusicKit.getInstance` is 'function' in
// the page console (DevTools evaluates in the main world) while the content script saw nothing.
//
// So the MusicKit access lives here, declared with `"world": "MAIN"` in the manifest, and the two
// worlds talk over `window.postMessage`. The split is by capability, not by taste:
//   * this file  — runs in the page's world: may touch `window.MusicKit`, may NOT use `chrome.*`
//   * content.js — runs in the extension's world: uses `chrome.*`, may NOT see `window.MusicKit`
//
// WHAT THIS IS NOT: it never touches DRM. No key-system access, no license request or response, no
// stream interception, no decryption, no capture or recording of media, no proxying of Apple's
// traffic. It only calls the page's own playback methods and reads the page's own player state. If a
// future feature seems to need more than that, it does not belong in this file.
//
// BEST-EFFORT, NOT AN API: MusicKit is Apple's runtime, not a contract for third parties. Field
// names, event names and the global's existence can change with any deploy of music.apple.com. Every
// access below is defensive — a missing field degrades to `null`, a missing instance reports
// `player-declined`, and nothing here throws.

(() => {
  'use strict';

  const MARKER = '__foliaCompanionPageBridge';
  const POLL_INTERVAL_MS = 250;

  // MusicKit.PlaybackStates, mapped onto the vocabulary Folia already uses on its SMTC path so
  // downstream code has one set of strings to switch on. Values: 0 none, 1 loading, 2 playing,
  // 3 paused, 4 stopped, 5 ended, 6 seeking, 7 waiting, 8 stalled, 9 completed.
  const PLAYBACK_STATE_NAMES = {
    0: 'Stopped',
    1: 'Playing',
    2: 'Playing',
    3: 'Paused',
    4: 'Stopped',
    5: 'Stopped',
    6: 'Playing',
    7: 'Playing',
    8: 'Playing',
    9: 'Stopped',
  };

  // MusicKit's own change events. Subscribing is preferred over polling because it reports a change
  // at the moment it happens instead of up to one poll interval later; the content script's poll
  // stays as a backstop for the events that never fire (or that a future MusicKit renames).
  const MUSICKIT_EVENTS = [
    'playbackStateDidChange',
    'nowPlayingItemDidChange',
    'playbackTimeDidChange',
    'queueItemsDidChange',
    'authorizationStatusDidChange',
  ];

  // Re-injection guard. The page global is the right place for it: it survives a second injection
  // into the same document, which is exactly the case it exists for.
  if (window[MARKER]) {
    return;
  }
  window[MARKER] = true;

  const logWarn = (...args) => console.warn('[Folia companion:page]', ...args);

  // The page's MusicKit instance, or null. `window.MusicKit` only exists after Apple's bundle has
  // booted, so null is a normal state during page load — not an error.
  function getMusicKit() {
    try {
      const MusicKit = window.MusicKit;
      if (!MusicKit || typeof MusicKit.getInstance !== 'function') {
        return null;
      }
      const instance = MusicKit.getInstance();
      return instance && typeof instance === 'object' ? instance : null;
    } catch (error) {
      // getInstance() throws before the instance is configured. Treated as "not ready yet".
      return null;
    }
  }

  // The storefront the page itself was loaded under, e.g. `us` for /us/browse.
  function getPageStorefront() {
    try {
      const segment = (window.location.pathname.split('/')[1] || '').toLowerCase();
      // Only a two-letter country code counts; `/browse` and `/` must not be read as a storefront.
      return /^[a-z]{2}$/.test(segment) ? segment : '';
    } catch {
      return '';
    }
  }

  function toFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  function readIdentity(mk) {
    try {
      const item = mk.nowPlayingItem;
      if (!item || typeof item !== 'object') {
        return null;
      }
      const attributes = item.attributes && typeof item.attributes === 'object' ? item.attributes : {};
      const title = typeof attributes.name === 'string' ? attributes.name : '';
      const artist = typeof attributes.artistName === 'string' ? attributes.artistName : '';
      const album = typeof attributes.albumName === 'string' ? attributes.albumName : null;
      // `durationInMillis` is what MusicKit exposes on the item; the instance's
      // `currentPlaybackDuration` is the fallback and is read by the caller.
      const durationMs = toFiniteNumber(attributes.durationInMillis);
      if (!title && !artist && durationMs === null) {
        return null;
      }
      return { title, artist, album, durationMs };
    } catch (error) {
      logWarn('could not read nowPlayingItem', error);
      return null;
    }
  }

  // The storefront mismatch check, and why it matters: the web player itself forces
  // `previewOnly = true` whenever the page storefront differs from the account storefront
  // (`setPreviewOnlyBasedOnSF()`), regardless of whether the browser can actually play DRM audio.
  // The user then sees "cannot play" with no visible reason. Reporting it as a distinct error kind is
  // the difference between a diagnosable state and a mystery.
  function detectStorefrontMismatch(mk) {
    try {
      const pageStorefront = getPageStorefront();
      const accountStorefront =
        typeof mk.storefrontCountryCode === 'string' ? mk.storefrontCountryCode.toLowerCase() : '';
      if (!pageStorefront || !accountStorefront) {
        return false;
      }
      return pageStorefront !== accountStorefront;
    } catch {
      return false;
    }
  }

  // Builds one observation from a live read. `positionEstablishedAtMs` is `Date.now()` at read time
  // on purpose: unlike the SMTC path, which republishes a value Windows quantized some time ago, this
  // is a live read of a running player, so the position is established exactly now.
  function readObservation() {
    const observedAtMs = Date.now();
    const mk = getMusicKit();

    if (!mk) {
      // Not an exception: the page may still be booting, or this is a page under music.apple.com that
      // never mounts a player. Reported, never thrown.
      return {
        observation: {
          connected: false,
          identity: null,
          playbackStatus: null,
          positionMs: null,
          positionEstablishedAtMs: null,
          observedAtMs,
        },
        errorKind: 'player-declined',
      };
    }

    const identity = readIdentity(mk);
    // SECONDS -> milliseconds. `currentPlaybackTime` is second-valued while `durationInMillis` is
    // millisecond-valued; see musickit-time.js for the measurement that settled it. Reading it raw
    // put a 2:40 track's position at "160" against a duration of "160520", so the end-of-track test
    // (duration - position <= 1500) could never fire and the queue never advanced.
    const positionMs = globalThis.FoliaMusicKitTime.musicKitSecondsToMs(mk.currentPlaybackTime);
    const playbackState = toFiniteNumber(mk.playbackState);
    const playbackStatus =
      playbackState === null ? null : PLAYBACK_STATE_NAMES[playbackState] || null;

    let errorKind = null;
    if (detectStorefrontMismatch(mk)) {
      errorKind = 'storefront-mismatch';
    } else if (mk.isAuthorized === false) {
      // Only an explicit `false` counts: an older MusicKit that does not expose the flag at all must
      // not be reported as signed out.
      errorKind = 'not-signed-in';
    }

    // The instance's own duration is the fallback for an item that did not carry one. Also
    // second-valued (see musickit-time.js), so it goes through the same conversion.
    if (identity && identity.durationMs === null) {
      identity.durationMs = globalThis.FoliaMusicKitTime.musicKitSecondsToMs(mk.currentPlaybackDuration);
    }

    return {
      observation: {
        // `connected` means "this page can be controlled", so an unusable player is disconnected
        // even though the page is obviously reachable.
        connected: errorKind === null,
        identity,
        playbackStatus,
        positionMs,
        positionEstablishedAtMs: positionMs === null ? null : observedAtMs,
        observedAtMs,
      },
      errorKind,
    };
  }

  // --- commands ---------------------------------------------------------------------------------

  function commandError(errorKind, error) {
    return { ok: false, errorKind, error };
  }

  async function applyCommand(command) {
    const mk = getMusicKit();
    if (!mk) {
      return commandError('player-declined', 'the Apple Music web player is not available on this page');
    }
    if (detectStorefrontMismatch(mk)) {
      return commandError(
        'storefront-mismatch',
        'the page storefront does not match the Apple Music account storefront; the web player forces preview-only mode',
      );
    }
    if (mk.isAuthorized === false) {
      return commandError('not-signed-in', 'the Apple Music web player is not signed in');
    }

    const kind = command && command.kind;
    try {
      switch (kind) {
        case 'play':
          await mk.play();
          return { ok: true, errorKind: null, error: null };
        case 'pause':
          await mk.pause();
          return { ok: true, errorKind: null, error: null };
        case 'toggle': {
          const state = toFiniteNumber(mk.playbackState);
          const isPlaying = state !== null && PLAYBACK_STATE_NAMES[state] === 'Playing';
          await (isPlaying ? mk.pause() : mk.play());
          return { ok: true, errorKind: null, error: null };
        }
        case 'seek':
          // MusicKit takes seconds; the protocol carries milliseconds.
          await mk.seekToTime(command.positionMs / 1000);
          return { ok: true, errorKind: null, error: null };
        case 'playById':
          // HONEST NOTE: setting a single-item queue is the only mechanism MusicKit exposes to
          // address one song by id, and it does technically replace Apple Music's own queue. Folia
          // never writes its multi-track queue here — it sends one song, one at a time, and reclaims
          // control at track end. This is why the protocol has no `next`/`previous`: Folia resolves
          // those itself and calls `playById` with the id it wants.
          await mk.setQueue({ song: command.mediaId });
          await mk.play();
          return { ok: true, errorKind: null, error: null };
        default:
          // The bridge refuses unknown kinds before they reach here; this is the second line of the
          // same allow-list.
          return commandError('invalid-argument', `unsupported command kind: ${String(kind)}`);
      }
    } catch (error) {
      return commandError('player-declined', String((error && error.message) || error));
    }
  }

  // --- the two-world protocol --------------------------------------------------------------------

  // The page is the same window, so it can read these messages and could forge replies. That grants
  // it nothing it did not already have: it owns the MusicKit instance being driven. The token, the
  // socket and the queue all stay on the extension/Folia side (see the README's security note).
  function post(frame) {
    try {
      window.postMessage({ marker: MARKER, ...frame }, window.location.origin);
    } catch (error) {
      logWarn('could not post to the content script', error);
    }
  }

  function reply(id, payload) {
    post({ type: 'reply', id, ...payload });
  }

  function publishObservation() {
    const { observation, errorKind } = readObservation();
    post({ type: 'push', observation, errorKind: errorKind ?? null });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) {
      return;
    }
    const data = event.data;
    if (!data || typeof data !== 'object' || data.marker !== MARKER || data.type !== 'request') {
      return;
    }

    if (data.kind === 'readObservation') {
      const { observation, errorKind } = readObservation();
      reply(data.id, { ok: true, observation, errorKind: errorKind ?? null });
      return;
    }

    if (data.kind === 'command') {
      applyCommand(data.command).then(
        (result) => reply(data.id, {
          ok: result.ok === true,
          errorKind: result.errorKind ?? null,
          error: result.error ?? null,
        }),
        (error) => reply(data.id, {
          ok: false,
          errorKind: 'player-declined',
          error: String((error && error.message) || error),
        }),
      );
    }
  });

  // --- observation loop -------------------------------------------------------------------------

  function subscribeToMusicKitEvents() {
    const mk = getMusicKit();
    if (!mk || typeof mk.addEventListener !== 'function') {
      return;
    }
    for (const eventName of MUSICKIT_EVENTS) {
      try {
        mk.addEventListener(eventName, () => {
          publishObservation();
        });
      } catch {
        // An unknown event name throws on some MusicKit builds. Skipped: the poll still covers it.
      }
    }
  }

  subscribeToMusicKitEvents();
  // The instance usually does not exist yet when this runs (document_start), so retry the
  // subscription until it does. Cheap: one property read per tick.
  const subscribeRetry = setInterval(() => {
    if (getMusicKit()) {
      clearInterval(subscribeRetry);
      subscribeToMusicKitEvents();
      publishObservation();
    }
  }, POLL_INTERVAL_MS);

  // One immediate read so Folia does not wait for the first poll. The content script polls on its own
  // schedule too; both paths go through the same dedupe there.
  publishObservation();
})();
