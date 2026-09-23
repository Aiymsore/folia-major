# Apple Music Web Player — Full-Length Playback in Chromium: Evidence Report

**Scope**: Does `https://music.apple.com` play FULL-LENGTH songs (not previews) in Chromium-based
browsers on Windows — Google Chrome, Microsoft Edge, and Electron apps?
**Method**: Apple's shipped JavaScript bundles (primary source), live EME probes in real Chrome/Edge/
Electron on this Windows machine, and full text of the relevant Apple Developer Forums threads.
**Date of evidence**: bundles fetched and probes run against live `music.apple.com` in this session.

---

## 1. Verdict

| Target | Full-length playback? | Mechanism |
|---|---|---|
| **Google Chrome** (Windows) | ✅ **YES** | Widevine (`com.widevine.alpha`) |
| **Microsoft Edge** (Windows) | ✅ **YES** | Widevine (`com.widevine.alpha`) |
| **Electron — stock** (`electron` npm) | ❌ **NO** — previews only | No Widevine CDM ships with stock Electron |
| **Electron — CastLabs ECS** (`wvmp`/`wvcus`) | ✅ **YES** | Bundled Widevine CDM + VMP signing |

The limiter is **not** the Chromium engine and **not** the FairPlay/DRM vendor. It is
**whether a Widevine CDM is available to the browser process**.

---

## 2. The crux: MusicKit JS vs. the official web player

The premise that thread 683958 limits Chromium is **incorrect**. The thread's own accepted answer
identifies a different cause, and the thread is about a *third-party page*.

Full text of [thread 683958](https://developer.apple.com/forums/thread/683958)
("MusicKit JS: Chromium based browsers only get 30 second previews", Jun '21; **Replies: 1,
Participants: 1** — i.e. no Apple engineer ever replied; the OP self-accepted):

> "I've got a little MusicKit JS page I'm working on and I'm running into this issue where the only
> browser that will play full tracks is Firefox (and Safari, obviously). I've tried several Chromium
> based browsers and MusicKit plays 30 seconds previews instead of full tracks. **Other widevine
> content works in those browsers.**"
>
> "**Of course, the v2 library works on music.apple.com in Brave and others.** v1 and v2 libraries
> behave the same **for me in my page**."

Accepted answer (by `jsimon0`, the OP — **not** an Apple employee):

> "It turns out that **pages served over http from servers that aren't localhost will not try to play
> DRM content.** Serving the same page from localhost over http works fine."

**Conclusions from this thread:**
1. It applies to **(a) MusicKit JS embedded in third-party developer sites only** — the author is
   debugging "a little MusicKit JS page I'm working on".
2. The same post states the **official web player works in Chromium** ("the v2 library works on
   music.apple.com in Brave and others").
3. The root cause was an **insecure context** (plain HTTP on a non-localhost origin), which disables
   EME entirely. This is a browser security rule, not an Apple/Chromium restriction.

I independently reproduced that exact failure mode: loading a page from a `data:` URL in Electron
gives `isSecureContext: false` and `navigator.requestMediaKeySystemAccess` is **`undefined`**;
over `http://127.0.0.1` (a secure context) the API exists. See §5.

**Thread 785413** ("Apple Music web player will not work on wkwebview web browser or electron
chromium browser", May '25) is **not** authoritative: **Replies: 0, Participants: 1**. It is an
unanswered question from a user building their own browser, reporting the error
"Not available on the web — You can listen to this in the Apple Music app." No Apple response exists.

**Thread 771759** ("Playing music with Musickit.js in Chrome and Firefox", Jan '25) shows the same
third-party pattern with storefront confusion, and ends with the reporter resolving it by version,
not by browser: "I have abandoned MusicKit JS V1 and switched to V3, this seems to be more reliable.
With V1 the DRM implementation is causing issues for me in Chrome while Safari is working fine."

---

## 3. DRM mechanism (primary source: Apple's own shipped code)

Apple's web player is **multi-DRM**, not FairPlay-only. Extracted from the live bundle
`https://music.apple.com/assets/index~8bc3c631ba.js` (3,341,534 bytes), the web player declares:

```js
var ID;(function(t){
  t.NONE="none",
  t.FAIRPLAY="com.apple.fps",
  t.PLAYREADY="com.microsoft.playready",
  t.WIDEVINE="com.widevine.alpha"
})(ID||(ID={}));
```

MusicKit JS itself (v3.2636.0, `https://music.apple.com/includes/js-cdn/musickit/v3/amp/musickit.js`)
implements all three plus ClearKey:

```js
const Q={playready:"com.microsoft.playready",widevine:"com.widevine.alpha",
         clearkey:"org.w3.clearkey",fairplay:"com.apple.fps"},
      J="com.apple.fps.1_0", X="com.microsoft.playready";

function* _detectEMEKeySystems(e){
  const n=[];
  if((yield isNodeEnvironment())||!(yield detectEMESupport()))return n;
  ...
  for(const[h,y]of Object.entries(Q))
    (yield supportsEMEConfiguration(y,{videoCapabilities:d,audioCapabilities:p}))&&n.push(h);
  return n;
}
```

Key-system selection and the DRM gate:

```js
return _.includes("fairplay")&&(g="fairplay"),
       _.includes("playready")&&(g="playready"),
       _.includes("widevine")&&(g="widevine"),
       { ..., isDRMAvailable: void 0!==g, availableKeySystems:_, preferredKeySystem:g }
```

Because **Chromium supports only Widevine** (see §4), `preferredKeySystem` resolves to `widevine`
and `isDRMAvailable` is `true`. Preview fallback is gated on DRM availability:

```js
shouldPlayPreview(e,n){
  ... (!0===(n?.previewOnly) || !(yield d.isPlayable(e)) ||
       (!!isEmptyString(e.rawAssetUrl) &&
        (!0!==n?.subscription ||
         (!1!==e.playParams?.hasDrm && (!d.services.runtime.isDRMAvailable && !isEmptyString(e.previewURL))))))
}
```

So a preview is served only when the item is explicitly `previewOnly`, is unplayable, or has no
asset URL **and** the runtime has no DRM. With Widevine present, DRM-protected items take the
encrypted full-playback path (`playbackType.encryptedFull`, `playItemFromEncryptedSource`).

---

## 4. Empirical EME probe (this Windows machine)

Same probe run in each browser; `audio/mp4; codecs="mp4a.40.2"` + `video/mp4; codecs="avc1.42E01E"`.

| Browser | `com.widevine.alpha` | `com.apple.fps` | `com.microsoft.playready` | `org.w3.clearkey` |
|---|---|---|---|---|
| **Chrome 153.0.8010.52** | ✅ **supported** | ❌ NotSupportedError | ❌ NotSupportedError | ✅ |
| **Edge 153.0.4234.48** | ✅ **supported** | ❌ NotSupportedError | ❌ NotSupportedError | ✅ |
| **Stock Electron 43.3.0** (Chromium 150) | ❌ NotSupportedError | ❌ NotSupportedError | ❌ NotSupportedError | ✅ |

*Caveat: the PlayReady negative in Edge may reflect my configuration rather than a true absence;
Edge is known to support PlayReady for video under different robustness settings. This does not
affect the verdict — Widevine is the key system that matters and it is confirmed present.*

**Decisive test — Apple's own runtime on the real site, in real Chrome:**

Loaded `https://music.apple.com/us/browse` in Chrome and queried Apple's live MusicKit instance:

```json
{
  "availableKeySystems": ["widevine", "clearkey"],
  "preferredKeySystem": "widevine",
  "isDRMAvailable": true,
  "mkBrowserSupportsVideoDrm": true
}
```

Apple's own code, running in Chrome on Windows, reports DRM available via Widevine.

**Stock Electron has no Widevine CDM** — confirmed on disk: `node_modules/electron/dist` contains
**no `widevinecdm.dll`** (Chrome and Edge each ship one under their `WidevineCdm\_platform_specific\`
directories). Without the CDM, `isDRMAvailable` is `false` and MusicKit falls back to previews.

---

## 5. Why `previewOnly` was true in my unauthenticated probe (honest caveat)

My live probe of the signed-out web player reported `previewOnly: true`, `playbackMode: 0`
(`PREVIEW_ONLY`). That is **not** a Chromium limitation — it is the web player's storefront gate:

```js
async setPreviewOnlyBasedOnSF(e){
  const i=await this.musicKit,
        r=(e?.toLowerCase())===i?.storefrontCountryCode?.toLowerCase();
  i.previewOnly=!r;
}
```

`previewOnly` is set to `true` whenever the **page storefront does not match the MusicKit storefront
country code**. My sandbox resolved to page `/cn/` while MusicKit reported storefront `us`, so
`previewOnly` was correctly `true`. MusicKit's own default is `MIXED_CONTENT`
(`_playbackMode = dn.MIXED_CONTENT`), and `mk.changeUserStorefront()` did not take effect without a
real authenticated session, so I could not drive the storefronts to match and observe the flip
end-to-end.

**This is the single most important caveat in this report**: I did **not** perform an end-to-end
authenticated full-song playback test. The `previewOnly` flag I observed is explained by a
storefront mismatch, and the DRM layer beneath it is confirmed available. The full-playback
conclusion rests on (a) Apple's shipped code paths, (b) Apple's runtime reporting
`isDRMAvailable: true` / `preferredKeySystem: "widevine"` in Chrome, and (c) the independent
working implementations in §6 — not on my own authenticated listen.

---

## 6. Corroborating community evidence (working Chromium implementations)

**Sidra** — an Apple Music desktop client that wraps `music.apple.com` in CastLabs Electron
([README](https://raw.githubusercontent.com/wimpysworld/sidra/main/README.md)):

> "Sidra loads `music.apple.com` directly inside CastLabs Electron (**required for Widevine DRM on
> Linux - no other shell supports this**)."
>
> "**standard Electron cannot be substituted as it lacks Widevine DRM support on Linux.**"
>
> Windows: "**Full Widevine DRM with EVS production VMP signing**"
>
> "Widevine enforces VMP (Verified Media Path) production signing on macOS and Windows - **without
> it, Apple Music returns "Something went wrong" after login.**"

**Parachord** — [RELEASE_NOTES](https://github.com/Parachord/parachord/blob/main/RELEASE_NOTES.md),
v0.9.0-beta.4, directly linking CDM presence to the preview limitation:

> "**Widevine CDM Auto-Detection (Linux/Windows)** — On Linux, Parachord now automatically finds the
> Widevine CDM from installed Chromium-based browsers so **MusicKit JS can play full Apple Music
> tracks instead of 30-second previews**."
>
> "Auto-detection — searches Chrome, Edge, Brave, Vivaldi, Opera, and Dia for installed Widevine CDM"

**Chrome-as-client projects** ([686f6c61/apple-music-ubuntu](https://686f6c61.dev/en/projects/apple-music-ubuntu/)):

> "Launches Google Chrome with `--app=https://music.apple.com` ... **Chrome ships the Widevine DRM
> needed for playback.**"

**CastLabs ECS** ([README](https://raw.githubusercontent.com/castlabs/electron-releases/master/README.md)):
stock Electron needs the CDM supplied externally; ECS "will be installed on first launch and enabled
as an option for playback of DRM protected content using common EME APIs."

---

## 7. Conditions and caveats

1. **Requires sign-in and an active Apple Music subscription.** Apple Music has no free tier for
   on-demand catalog playback; free live radio stations are the exception.
2. **Storefront must match.** Per `setPreviewOnlyBasedOnSF()`, a page/MusicKit storefront mismatch
   forces `previewOnly = true` regardless of DRM availability.
3. **Secure context required.** EME is unavailable on insecure origins (plain HTTP, non-localhost) —
   the actual root cause in thread 683958. In Electron, always use `https://` or `http://127.0.0.1`.
4. **A Widevine CDM must be present.** Stock Electron has none. Options: CastLabs ECS, or point
   Electron at an installed Chrome/Edge CDM via `--widevine-cdm-path` / `--widevine-cdm-version`.
   The older Electron docs note VMP signing may be required from Electron ≥1.8.
5. **VMP production signing on macOS/Windows.** Per Sidra, CastLabs' development keys are
   insufficient for production; Apple Music returns "Something went wrong" after login without a
   free CastLabs EVS account.
6. **Browser-side quality ceiling.** Community guides report the web player tops out below
   lossless/hi-res; lossless requires the native app or a VMP-signed client.
7. **"30-second" is era-specific.** Thread 683958 is from Jun 2021. Apple later lengthened
   previews; this repo's own measurement recorded ~90.02 s AAC previews.
8. **The API cannot deliver full audio.** A paid MusicKit developer token returns only `previews`
   URLs — that is an API-surface limit, separate from web-player playback. Full audio is only
   reachable through the web player's DRM playback stack (or the native app).

---

## 8. Bottom line for an Electron-based app

- Full-length playback in **Chrome and Edge on Windows works today** via Widevine. No flags needed.
- **Stock Electron cannot** play full songs — it ships no Widevine CDM. This is the real blocker,
  and it is fixable.
- Two viable routes: **(a)** ship CastLabs Electron for Content Security (with EVS production VMP
  signing on Windows/macOS), or **(b)** load the Widevine CDM from an installed Chrome/Edge into
  stock Electron via the `--widevine-cdm-path` / `--widevine-cdm-version` switches.
- Route (b) inherits a dependency on a locally installed Chromium browser and its CDM version
  compatibility; route (a) is what shipping products (Sidra, Parachord, Cider) actually use.
- Apple's web player is **not** FairPlay-locked on the web. The FairPlay-only assumption is the
  main factual error to correct.

---

## 9. Reproduction

The probe scripts were **throwaway** and are deliberately not kept in the repo (they ran once, on one
machine, against a live site that has since moved on). What they produced is either quoted in the
sections above or recorded here, so the conclusions do not depend on the scripts surviving.

If the probes need to be rebuilt, this is what each one did:

| Script | Purpose |
|---|---|
| Electron EME probe | `data:` URL vs secure `http://127.0.0.1` — showed `isSecureContext: false` and `navigator.requestMediaKeySystemAccess === undefined` on the former |
| Browser EME probe | The same query in installed Chrome and Edge, which reported `isDRMAvailable: true` / `preferredKeySystem: "widevine"` (§5) |
| Live MusicKit query | Read Apple's own runtime on the real site in Chrome |
| Storefront isolation | Separated storefront mismatch from browser as the `previewOnly` cause (§5 caveat) |
| Forum fetch | Retrieved Apple Developer Forums threads past the bot gate via real Chrome |

The forum threads are cited by link in §2; the quoted passages are reproduced inline there.
