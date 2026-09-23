# Folia Companion (Chrome extension)

Folia's transport into the Apple Music **web** player. The extension opens a WebSocket to the Folia
desktop app on loopback, relays transport commands into the `music.apple.com` page, and streams the
page's player state back to Folia.

Folia keeps its own queue. This extension never receives or writes a multi-track queue — Folia
resolves "next" itself and asks for one song by id.

## What it does

- Connects to `ws://127.0.0.1:<port>/external-media/ws?token=<token>` and stays connected
  (reconnecting with backoff whenever the MV3 service worker is recycled).
- Forwards five transport commands to the page: `play`, `pause`, `toggle`, `seek`, `playById`.
- Reads `nowPlayingItem`, `playbackState`, `currentPlaybackTime`, `isAuthorized` and
  `storefrontCountryCode` from the page's own MusicKit instance and reports them about every 250 ms,
  plus immediately on MusicKit's own change events.
- Reports honest failure kinds (`tab-not-found`, `not-signed-in`, `storefront-mismatch`,
  `player-declined`, `timeout`, `transport-error`) instead of failing silently.

## Two worlds, and why (the MusicKit trap)

The MusicKit access lives in `page-bridge.js`, not in the content script, and that split is
load-bearing:

| File | World | Can use | Cannot use |
| --- | --- | --- | --- |
| `page-bridge.js` | `MAIN` (the page's own) | `window.MusicKit` | `chrome.*` |
| `content.js` | isolated (the extension's) | `chrome.*` | `window.MusicKit` |

A content script shares the DOM with the page but **not its JavaScript globals**, so
`window.MusicKit` — set by Apple's bundle in the page's world — is `undefined` inside a content
script. Reading it there reported `player-declined` for pages whose player was working perfectly,
because `typeof window.MusicKit.getInstance` is `'function'` when typed into the page console
(DevTools evaluates in the main world) and `'undefined'` from the extension's world. The two halves
now talk over `window.postMessage`.

Consequence for anyone extending this: a new MusicKit field or method goes in `page-bridge.js`; a new
`chrome.*` call goes in `content.js`.

## What it does NOT do

**It never touches DRM.** There is no key-system access, no license request or response handling, no
decryption, no media-stream capture, recording, proxying or remuxing anywhere in this extension. It
does not read or transmit license data. It only calls the page's own playback methods
(`mk.play()`, `mk.pause()`, `mk.seekToTime()`, `mk.setQueue()`) and reads the page's own player
state. If the page cannot play a track, neither can the extension.

It is also **best-effort page automation, not a stable API**. `window.MusicKit.getInstance()` is
Apple's runtime, not a contract for third parties, and music.apple.com can change it without notice.
The code degrades to a reported error kind rather than throwing, but a future site change can still
break it until it is updated.

## Install (unpacked, Chrome only)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `chrome-extension` directory.
4. Pin the extension if you want to see its toolbar entry.
5. **Reload any `music.apple.com` tab that was already open** (see the prerequisite below).

There is no build step and no store package. Chrome only — the API surface used here
(`chrome.storage`, `chrome.tabs.sendMessage`, MV3 service worker WebSockets, `"world": "MAIN"`)
is not implemented by Firefox or Safari.

Requires **Chrome 116+** (the `"world": "MAIN"` content-script key).

## Get the port and token from Folia

1. In Folia, open **Settings → External media** (Apple Music web control) and enable it. Enabling it
   is what starts the loopback bridge; while it is off, nothing is listening.
2. The panel shows the **address** (default `ws://127.0.0.1:32110`) and a **token**.
3. Open the extension's **Options** page (right-click the toolbar icon → Options, or the
   *Details → Extension options* button on `chrome://extensions`) and paste both values.
4. Click **Save**, then **Test connection**. A green result means the port and the token are both
   correct.

The port field accepts either the bare number (`32110`) or the whole address
(`ws://127.0.0.1:32110`); pasting the address with a token in it fills both fields. A wrong value is
rejected with an explanation — it is never silently rewritten.

The token can be regenerated from Folia at any time; regenerating it disconnects the extension until
you paste the new value.

### A note on the token in the URL

Browsers cannot set custom headers on `new WebSocket()`, so the token travels in the query string
(`?token=…`) on the handshake. That is the one place the token can end up in a log. The connection is
loopback-only, the bridge is bound to `127.0.0.1`, and it does not send
`Access-Control-Allow-Origin: *`, so a web page in any browser cannot talk to it.

## Prerequisites (the honest list)

All of these must hold, or control will not work:

1. **Folia is running** with external media control enabled — that is what opens the port.
2. **Chrome is running** with this extension loaded, in the same profile you configured.
3. **A `music.apple.com` tab is open.** Commands are sent to that tab; with no such tab the extension
   reports `tab-not-found`. (A background tab is fine — the poll keeps running in hidden tabs.)
4. **You are signed in** to Apple Music on that page. Signed out, every command is refused with
   `not-signed-in`.
5. **An active Apple Music subscription.** The web player refuses to play full tracks without one.
6. **The storefront must match.** If the page is `music.apple.com/cn/…` but the account storefront is
   `us`, the web player forces `previewOnly = true` regardless of DRM support, and everything looks
   like "cannot play" for no visible reason. The extension reports this as `storefront-mismatch`
   instead of letting it look like a mystery. Open the page in your account's storefront to fix it.
7. **The page's MusicKit must have booted.** For the first second or two after a reload the player
   does not exist yet and the extension reports `player-declined`; it recovers on its own.
8. If you reload the extension itself, **reload the music.apple.com tab too** — the content scripts
   are injected at page load, and the old copy is orphaned by an extension reload. Folia reports this
   state as "reload the music.apple.com tab" rather than "open music.apple.com", which is a different
   problem with a different fix.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest: `storage` + `tabs`, `http://127.0.0.1/*` host permission, two content scripts on `music.apple.com` (one `MAIN`, one isolated), options page. |
| `background.js` | Service worker. Owns the WebSocket, reconnects with backoff, relays both directions. |
| `musickit-time.js` | MusicKit's time units in one place. `currentPlaybackTime` is **seconds**, `durationInMillis` is **milliseconds** — see the trap below. |
| `page-bridge.js` | Runs in the page's own world. Drives the page's MusicKit instance and reads observations. |
| `content.js` | Runs in the isolated world. Relays between `background.js` (`chrome.*`) and `page-bridge.js` (`postMessage`). |
| `bridge-input.js` | Parses the port/address and token the options page asks for. |
| `options.html` / `options.js` | Port + token entry and connection status. |

## The time-unit trap

MusicKit JS is inconsistent with itself, and the two fields sit three lines apart in `page-bridge.js`:

| Field | Unit |
| --- | --- |
| `mk.currentPlaybackTime` | **seconds** |
| `mk.currentPlaybackDuration` | **seconds** |
| `item.attributes.durationInMillis` | **milliseconds** |

Read as milliseconds, a 2:40 track's position reads `160` against a duration of `160520` — so it looks
like the track sits at 0.16 s and can never reach its end. Folia's end-of-track test
(`durationMs - positionMs <= 1500`) then never fires and the queue stops advancing. Measured, not
assumed: the position went `2 -> 159 -> 160` and the track ended.

The extension↔Folia protocol is milliseconds everywhere, so the conversion happens once, in
`musickit-time.js`, at the point the MusicKit value is read.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Options page: "Could not reach Folia" | Folia is not running, or external media control is off, or the port is wrong. |
| Options page: "rejected the token (401)" | The token was regenerated in Folia. Copy the current one. |
| Options page: "That is an address, not a port" | The whole `ws://…` string went into the port field. Use the number, e.g. `32110`. |
| Status stays "Connecting…" | The bridge is up but the token does not match, or Folia's port changed. |
| Commands do nothing | No `music.apple.com` tab, not signed in, no subscription, or a storefront mismatch. |
| Folia says "reload the music.apple.com tab" | The page's player could not be read: the tab was open before the extension was loaded/reloaded, or MusicKit has not booted. Reload the tab. |
| Works, then stops after a while | Chrome recycled the service worker. It reconnects on its own within ~30s. |
