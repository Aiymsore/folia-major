# folia-apple-music-smtc-helper

Windows SMTC helper for Apple Music. Reads the Apple Music session out of the System Media Transport
Controls (SMTC) surface and reports it to the Electron main process as JSONL events; since Phase 2 it
also drives that session on request (`play`/`pause`/`toggle-play-pause`/`previous`/`next`/`seek`).
Spawned and supervised by `electron/appleMusicSmtcBridge.cjs`.

Two properties of the command path are load-bearing:

- Commands are addressed to the Apple Music session by AUMID, resolved on demand. There is no fallback
  to the OS "current session" and no fallback to any other player: with no Apple Music session the
  command fails with `session-not-found` and reports **no target**. Verified behaviour on Windows 11
  26200 is that Apple Music answers `Try*` calls even while it is not the current media session, so
  "not current" must never be read as "not targetable".
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
| `no-session` | no Apple Music session is currently visible                                          |
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
{"event":"snapshot","sourceAppUserModelId":"AppleInc.AppleMusicWin_nzyj5cx40ttqa!App",
 "title":"MaringCode","artist":"…","album":null,"playbackStatus":"Playing",
 "positionMs":13000,"durationMs":218000,"hasThumbnail":true,"updatedAtMs":1789471213330}
```

A response carries the same fixed-key rule:

```json
{"event":"response","id":"c1","command":"play","ok":true,
 "targetAppUserModelId":"AppleInc.AppleMusicWin_nzyj5cx40ttqa!App",
 "error":null,"errorKind":null,"completedAtMs":1789564593832}
```

`errorKind` values (the only thing a consumer should branch on; `error` is human text):

| kind                   | meaning                                                                       |
| ---------------------- | ----------------------------------------------------------------------------- |
| `session-not-found`    | no Apple Music session is visible; **nothing was controlled**                  |
| `controller-declined`  | the `Try*` call resolved `false` — the session would not do it right now        |
| `transport-error`      | the `Try*` call itself failed                                                  |
| `unsupported-command`  | the command name is not one of the six                                         |
| `invalid-argument`     | e.g. `seek` without a usable `positionMs`                                      |
| `malformed-request`    | the line was not a well-formed request object                                  |

Field notes that come from measured Windows behaviour rather than preference:

- `title`/`artist`/`album` collapse empty and whitespace-only to `null`. Apple Music reports an
  **empty `AlbumTitle`**, and a consumer cannot act on the difference between `""` and absent.
- `positionMs`/`durationMs` are integers in milliseconds. Apple Music **quantizes the position to
  whole seconds** and republishes its timeline roughly every 280 ms, so the value moves in 1000 ms
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

- `--interval` (default 500) — poll period. Apple Music moves its position about once a second, so
  500 ms catches every change while leaving the process idle most of the time.
- `--heartbeat` (default 3000) — liveness period. A healthy stream is mostly change-driven; the
  heartbeat only proves the loop is running when nothing changes.
- `--match` (default `AppleMusicWin`) — case-insensitive substring matched against each session's
  AUMID, shared by reads and commands. The Store package reports
  `AppleInc.AppleMusicWin_nzyj5cx40ttqa!App`; matching a substring rather than the full AUMID survives
  a package-family hash change while excluding other Apple publishers. Override it to target a renamed
  package or an iTunes build.
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
