# folia-apple-music-smtc-helper

Windows SMTC helper for the external-media backend. Reads the **matched media session** — by default
the Chrome tab playing music.apple.com, because that is the only place full tracks can play — out of
the System Media Transport Controls (SMTC) surface and reports it to the Electron main process as
JSONL events; since Phase 2 it also drives that session on request (`play`/`pause`/`toggle-play-pause`/
`previous`/`next`/`seek`).
Spawned and supervised by `electron/externalMediaSmtcBridge.cjs`.

The binary name is historical (this crate was written when the target was the Windows Apple Music
desktop app). Nothing addresses that app any more: it cannot play a track by id, which is what the
external-media backend needs. Folia's own `MediaCommand` surface is narrower than this helper's —
Folia never sends `previous`/`next`/queue verbs (Folia's queue resolves "next" into
`playById(下一首)`); those verbs remain here only for manual SMTC probing.

Two properties of the command path are load-bearing:

- Commands are addressed to the matched session by AUMID, resolved on demand. There is no fallback
  to the OS "current session" and no fallback to any other player: with no matching session the
  command fails with `session-not-found` and reports **no target**. Verified behaviour on Windows 11
  26200 is that a media session answers `Try*` calls even while it is not the current media session,
  so "not current" must never be read as "not targetable".
- Every failure is a structured value, never an exception: `ok`, `errorKind` and the target AUMID are
  always present, and the process exit code mirrors `ok` (0 / 3).

## Protocol

stdin accepts one JSON object per line, or the bare word `stop`:

| input                                              | meaning                                                       |
| -------------------------------------------------- | ------------------------------------------------------------- |
| `stop`                                             | shut down cleanly and emit `stopped`                          |
| `{"id":"c1","command":"play"}`                     | one transport command; the reply echoes `id`                  |
| `{"id":"c2","command":"seek","positionMs":42000}`  | seek to 42 s (`positionMs` is required by `seek` only)         |

Stdin EOF means the main process went away and is treated the same as `stop`, so an orphaned helper
cannot hold the media session with nobody listening.

stdout is JSONL, one event per line, flushed immediately:

| event        | payload                                                                             |
| ------------ | ----------------------------------------------------------------------------------- |
| `ready`      | `{"sessionCount":n}` — emitted once, after the session manager is obtained           |
| `snapshot`   | the session fields below                                                             |
| `no-session` | no matching media session is currently visible                                       |
| `heartbeat`  | liveness marker, emitted on the heartbeat interval when nothing else changes          |
| `response`   | the result of one stdin command, keyed by the request's `id`                          |
| `stopped`    | clean shutdown                                                                       |
| `error`      | `{"message":"…","kind":"…"}` — `kind` is a structured class, `message` is for humans  |

stdout carries events only. Every human-readable line (usage, startup failures) goes to stderr, and a
process-wide lock serializes the two threads that write events so a snapshot and a response can never
interleave mid-line.

A snapshot carries a fixed key set; absent values are `null` rather than an omitted key, so the
consumer never has to probe for a field:

```json
{"event":"snapshot","sourceAppUserModelId":"Chrome",
 "title":"MaringCode","artist":"…","album":null,"playbackStatus":"Playing",
 "positionMs":13000,"durationMs":218000,"hasThumbnail":true,"updatedAtMs":1789471213330,
 "lastUpdatedMs":1789471213000}
```

Two timestamps, and the difference is load-bearing:

- `updatedAtMs` — when the helper captured this snapshot.
- `lastUpdatedMs` — when the **reported position** was established, straight from the OS's
  `TimelineProperties.LastUpdatedTime`. This is what lets a consumer measure how stale
  `lastUpdatedMs` is instead of guessing: the source player quantizes the position to whole seconds and
  republishes the timeline about every 250 ms, so the value read at any instant may be up to one
  republish period old. `null` when the timeline could not be read.

`lastUpdatedMs` is deliberately **excluded from the content-equality gate** (same rule as
`updatedAtMs`): the OS re-stamps it ~3.6 times per second of position, so including it would emit a
snapshot for every republish and turn the change-gated stream into a much faster one.

A response carries the same fixed-key rule:

```json
{"event":"response","id":"c1","command":"play","ok":true,
 "targetAppUserModelId":"Chrome",
 "error":null,"errorKind":null,"completedAtMs":1789564593832}
```

`errorKind` values (the only thing a consumer should branch on; `error` is human text):

| kind                   | meaning                                                                       |
| ---------------------- | ----------------------------------------------------------------------------- |
| `session-not-found`    | no matching session is visible; **nothing was controlled**                        |
| `controller-declined`  | the `Try*` call resolved `false` — the session would not do it right now        |
| `transport-error`      | the `Try*` call itself failed                                                  |
| `unsupported-command`  | the command name is not one of the six                                         |
| `invalid-argument`     | e.g. `seek` without a usable `positionMs`                                      |
| `malformed-request`    | the line was not a well-formed request object                                  |

Field notes that come from measured Windows behaviour rather than preference:

- `title`/`artist`/`album` collapse empty and whitespace-only to `null`. Measured behaviour on the
  Windows SMTC surface (originally with the Apple Music app) is an **empty `AlbumTitle`**, and a
  consumer cannot act on the difference between `""` and absent.
- `positionMs`/`durationMs` are integers in milliseconds. The position as reported is **quantized to
  whole seconds** (measured with the Windows Apple Music app; Chromium's SMTC session is treated as
  potentially similar until measured otherwise — which is why Folia keeps its clock-correction layer)
  and the timeline republishes roughly every 280 ms, so the value moves in 1000 ms
  steps; a `seek` therefore lands on a second boundary. Other SMTC sources report sub-millisecond
  values. The protocol keeps milliseconds as the unit and leaves it to the consumer to decide how much
  precision to trust — do not assume the position can anchor word-by-word lyric sync.
- `playbackStatus` is the raw Windows enum name (`Closed`/`Opened`/`Changing`/`Stopped`/`Playing`/
  `Paused`), or `Unknown(n)` for a value Microsoft adds later, so a new enum member is reported
  honestly instead of being mapped onto a wrong existing name.
- `updatedAtMs` is when the helper captured the snapshot, not the track's progress.
- `ok` is the only field a consumer must branch on, and it is not a claim that the user heard
  anything: it is the OS accepting the call. A command can be delivered and have no audible effect
  (seeking to the position already playing, `next` on a one-track queue).

The helper does **not** extract thumbnail bytes; it only reports `hasThumbnail` so a consumer can tell
artwork exists without paying for the stream.

## CLI

```
folia-apple-music-smtc-helper watch [--interval <ms>] [--heartbeat <ms>] [--match <aumid>] [--iterations <n>] [--once]
folia-apple-music-smtc-helper command <play|pause|toggle-play-pause|previous|next|seek> [--position-ms <ms>] [--match <aumid>]
folia-apple-music-smtc-helper command --command-sequence [--match <aumid>]
```

`watch` is the long-lived event stream the bridge supervises:

- `--interval` (default 250) — poll period. The position cannot get finer than whole seconds
  (that is the source player's quantization, not our sampling rate), but the OS republishes the timeline
  roughly every 280 ms, so 250 ms samples every republish. At the previous 500 ms default the helper
  skipped about half of them, which made the forwarded `lastUpdatedMs` up to ~750 ms old instead of
  ~250 ms — and a stale stamp is exactly what a consumer uses to decide how much to trust the
  position. The process is still idle most of the time.
- `--heartbeat` (default 3000) — liveness period. A healthy stream is mostly change-driven; the
  heartbeat only proves the loop is running when nothing changes.
- `--match` (default `Chrome`) — case-insensitive substring matched against each session's
  AUMID, shared by reads and commands. The default targets the Chrome tab playing music.apple.com;
  matching a substring rather than the full AUMID survives channel and profile suffixes (`Chrome`,
  `Chrome Beta`, `chrome.exe`, package-identity AUMIDs) while excluding other browsers and players.
  Folia overrides the default through `FOLIA_EXTERNAL_MEDIA_SMTC_MATCH` (see
  `electron/externalMediaSmtcBridge.cjs`), so another browser channel is a setting, not a rebuild.
- `--once` — one read, one event, exit.
- `--iterations <n>` — stop after `n` poll cycles (0 = unbounded). An explicit bound is authoritative
  and is checked before the stdin stop flag, because a redirected stdin reaches EOF immediately and
  would otherwise end the run on the first cycle. This is what makes the loop verifiable from a script
  without a held-open pipe.

`command` runs one command as its own short-lived process: one `response` event, exit 0 when `ok` and
exit 3 otherwise. It is a separate process rather than a mode of the watch loop because the read path
must re-request the SMTC manager to see live values, and a fresh process gets the same freshness for
free while leaving the verified loop untouched.

- `--position-ms <ms>` — required by `seek`, rejected for every other command so a copy-pasted flag is
  loud instead of ignored. Rejected outside `0 … 3600000`; the value is converted to the 100 ns ticks
  `TryChangePlaybackPositionAsync` expects.
- `--command-sequence` — run the fixed self-test sequence instead of one named command:
  `pause → play → seek 5 s → next → previous → toggle-play-pause`, each step emitting its own
  `response`, stopping at the first refusal. This is what the real-Electron acceptance run drives; it
  is not a general-purpose batch mode.

## Reading live values

The control manager is re-requested on every poll. Holding one manager for the process lifetime
looked cheaper, but a session object obtained once keeps answering with the values it had when first
read: the timeline stayed frozen at the position of the first poll, so the change-gate then
suppressed every later snapshot while playback advanced. Re-requesting per poll is what the verified
PowerShell probe did and the only form observed to return live values — a bounded run now yields one
snapshot per second of playback and nothing in between.

## Commanding the session

Commands use the `Try*` family exclusively (`TryPlayAsync`, `TryPauseAsync`,
`TryTogglePlayPauseAsync`, `TrySkipPreviousAsync`, `TrySkipNextAsync`,
`TryChangePlaybackPositionAsync`). The non-`Try` variants throw instead of returning a status, and a
helper that dies on a refused command would take the bridge down with it.

Two mapping rules, both covered by unit tests on any host:

- A resolved `false` is `controller-declined`, not an error. That is SMTC's "the session does not
  support this right now", which is retryable and must not be reported as a crash.
- A session that cannot be found is an error from the transport (`Err`), which becomes
  `session-not-found` with no target. The command is still attempted against the resolver, so the
  reply proves the resolver ran and found nothing rather than proving nothing happened.

## Layout

| file          | contents                                                                      |
| ------------- | ----------------------------------------------------------------------------- |
| `cli.rs`      | argument parsing (no WinRT)                                                    |
| `events.rs`   | event/response JSON schema and the content-equality rule (no WinRT)            |
| `watcher.rs`  | change-gating and heartbeat decision logic (no WinRT)                          |
| `commands.rs` | command parsing/validation, the `Transport` trait, reply mapping (no WinRT)    |
| `session.rs`  | the only WinRT: session manager, matching, field extraction, `Try*` dispatch   |
| `main.rs`     | wiring, command threads, poll loop                                             |

`cli.rs`, `events.rs`, `watcher.rs` and `commands.rs` are deliberately free of WinRT so `cargo test`
runs on any host and the protocol/state-machine rules are covered without a Windows machine. Only
`session.rs` and the Windows half of `main.rs` are `#[cfg(windows)]`.

WinRT calls run on a thread parked in the multi-threaded apartment (`CoIncrementMTAUsage`), which is
the right apartment for a background poller with no UI.

## Build

```
cargo build --release                                   # from this directory
node packaging/windows/build-apple-music-smtc-helper.mjs # from the repo root; copies into build/
```

Requires the Rust MSVC toolchain (rustup default host `x86_64-pc-windows-msvc`) plus the MSVC
linker and Windows SDK that the `windows` crate links against. The output is packaged as
`resources/folia-apple-music-smtc-helper.exe`; `FOLIA_APPLE_MUSIC_SMTC_HELPER_PATH` overrides the
path for non-packaged runs.

## License

AGPL-3.0, same as Folia. No third-party implementation was copied into this crate.
