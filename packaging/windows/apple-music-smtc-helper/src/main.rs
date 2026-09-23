// packaging/windows/apple-music-smtc-helper/src/main.rs
// Folia Windows external-media SMTC helper.
//
//   watch        — reads the matched media session (by default the Chrome tab playing
//                  music.apple.com) out of the System Media Transport Controls surface
//                  and reports it as JSONL events on stdout (Phase 1, read-only).
//   command <n>  — one transport command (play/pause/toggle/previous/next/seek) against the same
//                  session, one `response` event on stdout, exit (Phase 2).
//
// Both talk to electron/externalMediaSmtcBridge.cjs over the same one-way-per-direction protocol:
// JSONL commands on stdin, JSONL events on stdout, and every human-readable line on stderr. Nothing
// in this crate may print to stdout outside events.rs — the consumer parses that stream.
//
// Windows Runtime calls live in session.rs behind `#[cfg(windows)]`; cli.rs, commands.rs, events.rs
// and watcher.rs stay platform-free so `cargo test` runs on any host. Licensing is AGPL-3.0, same
// as Folia.

mod cli;
mod commands;
mod events;
mod watcher;

#[cfg(windows)]
mod session;

use cli::{CommandOptions, Invocation, WatchOptions};
use events::Event;
use watcher::{PollOutcome, WatchState};

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Exit codes. `command` mirrors its own reply: 0 means the response carried `ok: true`, so a
/// script can branch on the exit status without parsing stdout — and can never read a failure as a
/// success. 2 is reserved for usage/usage-level errors, matching the `std::process::exit(2)` below.
const EXIT_OK: i32 = 0;
const EXIT_COMMAND_FAILED: i32 = 3;
const EXIT_USAGE: i32 = 2;

/// How long the command thread waits for a stdin line before re-checking the stop flag. Short enough
/// that shutdown is not delayed, long enough that an idle helper stays asleep between requests.
#[cfg(windows)]
const COMMAND_WAIT_SLICE: Duration = Duration::from_millis(250);

const USAGE: &str = concat!(
    "usage: folia-apple-music-smtc-helper watch [--interval <ms>] [--heartbeat <ms>] [--match <aumid-substring>] [--iterations <n>] [--once]\n",
    "       folia-apple-music-smtc-helper command <play|pause|toggle-play-pause|previous|next|seek> [--position-ms <ms>] [--match <aumid-substring>]\n",
    "       folia-apple-music-smtc-helper command --command-sequence [--match <aumid-substring>]"
);

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match cli::parse(&args) {
        Ok(Invocation::Watch(options)) => run(options),
        Ok(Invocation::Command(options)) => run_command_once(options),
        Err(message) => {
            eprintln!("{USAGE}");
            eprintln!("error: {message}");
            std::process::exit(EXIT_USAGE);
        }
    }
}

fn run(options: WatchOptions) {
    // Built only on/for Windows; the guard keeps `cargo test` and `cargo build` working on other
    // hosts, matching the wallpaper helper. `--once` is still honoured so a non-Windows host can
    // exercise the protocol shape without the platform read.
    #[cfg(not(windows))]
    {
        let _ = &options;
        events::emit(&Event::Error {
            message: "this helper only runs on Windows".to_string(),
            kind: None,
        });
        std::process::exit(EXIT_USAGE);
    }

    #[cfg(windows)]
    run_windows(options);
}

/// One command, one response, exit. Deliberately a separate process from the watch loop: the
/// verified read path re-requests the SMTC manager on every poll because a session object kept
/// across calls answers with stale values, and a short-lived process gets the same freshness for
/// free while leaving `run_windows` untouched.
fn run_command_once(options: CommandOptions) {
    #[cfg(not(windows))]
    {
        let _ = &options;
        eprintln!("error: transport commands are only available on Windows");
        std::process::exit(EXIT_USAGE);
    }

    #[cfg(windows)]
    {
        // The Windows Runtime apartment must be initialized before the manager is requested.
        if let Err(message) = session::init_apartment() {
            eprintln!("error: {message}");
            std::process::exit(EXIT_USAGE);
        }

        if options.command_sequence {
            let all_ok = run_command_sequence(&options.match_substring);
            std::process::exit(if all_ok { EXIT_OK } else { EXIT_COMMAND_FAILED });
        }

        let reply = commands::execute_argv(
            &options,
            || {
                session::SessionTransport::open(&options.match_substring)
                    .map(|transport| Box::new(transport) as Box<dyn commands::Transport>)
            },
            session::now_epoch_ms(),
        );
        events::emit(&Event::Response { reply: reply.clone() });
        // Non-zero on failure so a caller that only checks the exit status cannot mistake a
        // rejected command for a delivered one. The response has already been flushed.
        std::process::exit(if reply.ok { EXIT_OK } else { EXIT_COMMAND_FAILED });
    }
}

/// The scripted self-test sequence: every Try* call the helper can make, once each, in an order whose
/// effects are observable and self-cancelling — pause then play restores playback, the seek lands near
/// the start, skip-next then skip-previous returns to the same track, and the toggle is applied last
/// so it is the one visible leftover. Each step emits its own `response` event, so a consumer sees
/// per-command results rather than a single verdict.
///
/// Returns true only when every step was delivered. A step that is refused stops the sequence: the
/// remaining steps would be reported against a session state the refusal has already changed.
#[cfg(windows)]
fn run_command_sequence(match_substring: &str) -> bool {
    let steps: [(&str, Option<u64>); 6] = [
        ("pause", None),
        ("play", None),
        ("seek", Some(5_000)),
        ("next", None),
        ("previous", None),
        ("toggle-play-pause", None),
    ];

    // The transport is resolved once for the whole sequence: re-resolving per step could answer a
    // later step against a different session than the caller was told about.
    let transport = match session::SessionTransport::open(match_substring) {
        Ok(transport) => transport,
        Err(reason) => {
            for (name, _) in steps {
                events::emit(&Event::Response {
                    reply: commands::rejection_reply(
                        "",
                        name,
                        events::ERR_KIND_SESSION_NOT_FOUND,
                        &reason,
                        session::now_epoch_ms(),
                    ),
                });
            }
            return false;
        }
    };

    let mut all_ok = true;
    for (name, position_ms) in steps {
        let reply = sequence_step(name, position_ms, &transport);
        let ok = reply.ok;
        events::emit(&Event::Response { reply });
        if !ok {
            all_ok = false;
            break;
        }
        // A short gap between steps: SMTC republishes playback state asynchronously, so firing the
        // next call in the same millisecond would let a stale state be read back as the next step's
        // starting condition.
        std::thread::sleep(Duration::from_millis(400));
    }
    all_ok
}

/// Runs one step of the sequence. The name is resolved through the same table stdin and argv use, so
/// the sequence cannot exercise a command those paths do not support.
#[cfg(windows)]
fn sequence_step(
    name: &str,
    position_ms: Option<u64>,
    transport: &session::SessionTransport,
) -> events::CommandReply {
    let Some(command) = commands::command_named(name, position_ms) else {
        return commands::rejection_reply(
            "",
            name,
            events::ERR_KIND_UNSUPPORTED_COMMAND,
            &format!("unsupported command: {name}"),
            session::now_epoch_ms(),
        );
    };
    let request = commands::CommandRequest {
        id: String::new(),
        command,
    };
    commands::execute(&request, transport, session::now_epoch_ms())
}

#[cfg(windows)]
fn run_windows(options: WatchOptions) {
    if let Err(message) = session::init_apartment() {
        events::emit(&Event::Error { message, kind: None });
        std::process::exit(1);
    }

    // The manager is the one thing that can fail hard at startup: without it there is no SMTC at
    // all, and that is worth a structured kind so the consumer can decide to restart the helper.
    let manager = match session::open_manager() {
        Ok(manager) => manager,
        Err(message) => {
            events::emit(&Event::Error {
                message,
                kind: Some(events::ERR_KIND_MANAGER_UNAVAILABLE),
            });
            std::process::exit(1);
        }
    };

    match session::session_ids(&manager) {
        Ok(ids) => events::emit(&Event::Ready { session_count: ids.len() }),
        Err(message) => {
            events::emit(&Event::Error { message, kind: None });
            std::process::exit(1);
        }
    }
    // The startup manager is dropped here: every later read requests its own (see session::read).
    drop(manager);

    if options.once {
        match session::read(&options.match_substring) {
            Ok(outcome) => {
                events::emit(&match outcome {
                    PollOutcome::Snapshot(snapshot) => Event::Snapshot { snapshot },
                    PollOutcome::NoSession => Event::NoSession,
                });
            }
            Err(message) => {
                events::emit(&Event::Error { message, kind: None });
                std::process::exit(1);
            }
        }
        return;
    }

    let stop = Arc::new(AtomicBool::new(false));
    // Commands arrive on their own thread so a `play` issued while the poll loop sleeps is answered
    // immediately rather than after the current interval. The thread ends with the loop: main sends
    // `stop` on this channel, which releases the blocking stdin read.
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    spawn_command_reader(Arc::clone(&stop), stop_rx, options.match_substring.clone());

    let mut state = WatchState::new(options.heartbeat_ms);
    let started = Instant::now();
    let interval = Duration::from_millis(options.interval_ms);
    let mut cycle = 0u64;

    loop {
        // An explicit iteration bound is authoritative, so it is checked first. A redirected stdin
        // delivers EOF immediately and would otherwise end the run on cycle 1, before the bound
        // could be observed at all.
        if options.iterations > 0 {
            if cycle >= options.iterations {
                events::emit(&Event::Stopped);
                break;
            }
        } else if stop.load(Ordering::Relaxed) {
            events::emit(&Event::Stopped);
            break;
        }
        cycle += 1;

        let now_ms = started.elapsed().as_millis() as u64;
        let outcome = session::read(&options.match_substring);
        // A failed read is reported but does not end the loop: the media control service can be
        // briefly unavailable, and exiting would force the consumer to respawn for a transient.
        let outcome = match outcome {
            Ok(outcome) => outcome,
            Err(message) => {
                events::emit(&Event::Error { message, kind: None });
                std::thread::sleep(interval);
                continue;
            }
        };

        if let Some(event) = state.on_poll(outcome, now_ms) {
            events::emit(&event);
        }

        std::thread::sleep(interval);
    }

    // Release the command thread's blocking stdin read so the process can exit instead of leaving a
    // detached thread holding the pipe. It is detached either way; this only ends it promptly.
    let _ = stop_tx.send(());
}

/// Reads stdin on a separate thread so `stop` is honoured while the poll loop sleeps. EOF also
/// stops the loop: it means the Electron main process died, and an orphaned helper would keep a
/// handle on the media session with nobody listening.
///
/// Phase 2: any other non-empty line is parsed as a command request and answered with exactly one
/// `response` event. Parsing and dispatch happen on this thread; the reply's `id` is what lets the
/// consumer match it, so command order on stdout never has to be assumed.
#[cfg(windows)]
fn spawn_command_reader(stop: Arc<AtomicBool>, stop_rx: mpsc::Receiver<()>, match_substring: String) {
    // The blocking stdin read runs on its own thread and hands lines over a channel, so the command
    // thread below waits with a timeout. Reading stdin directly there would park it in a call the
    // poll loop has no way to interrupt, and the process would linger after `stop`.
    let (line_tx, line_rx) = mpsc::channel::<Option<String>>();
    std::thread::spawn(move || {
        use std::io::BufRead;
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            match line {
                Ok(line) => {
                    if line_tx.send(Some(line)).is_err() {
                        return;
                    }
                }
                // EOF: the main process is gone. Signalled as `None` so it can be told apart from a
                // request, and so an orphaned helper cannot keep the media session open.
                Err(_) => {
                    let _ = line_tx.send(None);
                    return;
                }
            }
        }
        let _ = line_tx.send(None);
    });

    std::thread::spawn(move || loop {
        // Both a request and the loop's exit arrive on a channel, so neither can be missed while the
        // other is being handled. `recv` on stdin would not be interruptible.
        let line = match stop_rx.try_recv() {
            Ok(()) => return,
            Err(mpsc::TryRecvError::Disconnected) => return,
            Err(mpsc::TryRecvError::Empty) => match line_rx.recv_timeout(COMMAND_WAIT_SLICE) {
                Ok(Some(line)) => line,
                Ok(None) => {
                    stop.store(true, Ordering::Relaxed);
                    return;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
            },
        };

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.eq_ignore_ascii_case("stop") {
            stop.store(true, Ordering::Relaxed);
            return;
        }

        let now_ms = session::now_epoch_ms();
        // Phase 2: any other non-empty line is a command request, answered with exactly one
        // `response` event. The reply's `id` is what lets the consumer match it, so command order on
        // stdout never has to be assumed.
        let reply = match commands::parse_command_line(trimmed) {
            Ok(request) => match session::SessionTransport::open(&match_substring) {
                Ok(transport) => commands::execute(&request, &transport, session::now_epoch_ms()),
                // No Apple Music session: reported with no target, and nothing else is touched.
                // This is the branch that keeps a command from reaching another player when Apple
                // Music is not running.
                Err(reason) => commands::rejection_reply(
                    &request.id,
                    request.command.as_str(),
                    events::ERR_KIND_SESSION_NOT_FOUND,
                    &reason,
                    now_ms,
                ),
            },
            // A malformed line is answered rather than only logged: the caller is waiting for a
            // response, and silence would look like a hung helper.
            Err((kind, reason)) => commands::rejection_reply("", "", kind, &reason, now_ms),
        };
        events::emit(&Event::Response { reply });
    });
}
