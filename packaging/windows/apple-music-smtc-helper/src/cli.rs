// packaging/windows/apple-music-smtc-helper/src/cli.rs
// Pure command-line parsing for the external-media SMTC reader (the media session matched by
// `--match`, by default the Chrome tab playing music.apple.com). No WinRT imports, so the unit tests
// at the bottom of this file run on any host OS (see `cargo test`) — the Windows-only code path
// lives in session.rs and main.rs and is cfg-gated to Windows.
//
// Two subcommands since Phase 2:
//   * `watch`   — the long-lived JSONL event stream (Phase 1, read-only).
//   * `command` — one transport command, one `response` event, exit. It runs as its own process
//                 rather than as a second mode of the watch loop so the verified read path is
//                 untouched: `session::read` re-requests the manager on every poll precisely
//                 because a session object kept across calls answers with stale values, and the
//                 same reasoning applies to a command that must act on the live timeline.

/// Default poll interval. Apple Music republishes its timeline roughly every 280 ms but quantizes
/// the position to whole seconds, so 250 ms samples every republish while leaving the process idle
/// most of the time.
///
/// Why not the previous 500 ms: at 500 ms the helper skipped about half of the OS's republishes, so
/// the `lastUpdatedMs` stamp it forwards was up to ~750 ms old instead of ~250 ms. The position
/// value itself cannot get finer than whole seconds regardless (that is Apple Music's quantization,
/// not our polling rate), but a fresher stamp is what lets the renderer measure — rather than
/// estimate — how stale a position is.
pub const DEFAULT_INTERVAL_MS: u64 = 250;

/// Default heartbeat. Must stay comfortably above the interval so a healthy stream is mostly
/// change-driven; its only job is to prove the loop is still running when nothing changes.
pub const DEFAULT_HEARTBEAT_MS: u64 = 3000;

/// Substring matched against each session's AUMID to decide which session is the target media
/// source.
///
/// Since the external-media backend targets music.apple.com **in Chrome** (the web player is the
/// only place full tracks can play), the default is `Chrome`. Matching is case-insensitive
/// substring, so this covers `Chrome`, `Chrome Beta`, `Chrome_<hash>`-style AUMIDs and even a bare
/// `chrome.exe` — while excluding Edge (`MSEdge`) and every other player. `--match` (and Folia's
/// `FOLIA_EXTERNAL_MEDIA_SMTC_MATCH` override) exists so another channel or browser can be targeted
/// without a rebuild.
///
/// The desktop Apple Music app (`AppleInc.AppleMusicWin_nzyj5cx40ttqa!App`) is deliberately NOT a
/// default or a fallback: its SMTC session cannot play a track by id, so nothing in Folia addresses
/// it any more.
pub const DEFAULT_MATCH: &str = "Chrome";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchOptions {
    pub interval_ms: u64,
    pub heartbeat_ms: u64,
    pub match_substring: String,
    /// One read, one event, exit. Used by tests and by anything that wants a single sample.
    pub once: bool,
    /// Stop after this many poll cycles instead of running until stdin `stop`/EOF. Zero means
    /// unbounded. Exists so the watch loop can be exercised end to end without a held-open stdin
    /// pipe — a redirected stdin reaches EOF immediately and would end the run after one cycle.
    pub iterations: u64,
}

/// A one-shot transport command: `<name> [--position-ms <n>] [--match <aumid>]`, or
/// `--command-sequence` to run the scripted self-test instead of naming one command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandOptions {
    /// Protocol command name, normalized to exactly one spelling per action by
    /// `commands::Command::from_name`. Parsing here only decides that a name is present. Empty when
    /// `command_sequence` is set.
    pub command: String,
    /// Seek target in milliseconds. Required by `seek`, rejected for every other command so a
    /// mistyped flag cannot be silently ignored.
    pub position_ms: Option<u64>,
    pub match_substring: String,
    /// Run the fixed diagnostic sequence (pause → play → seek → next → previous → toggle) instead of
    /// a single command. Exists because the real-Electron acceptance run has to prove every Try* call
    /// reaches Apple Music, and sending that sequence from JavaScript would move the verification
    /// logic into the script that is supposed to be verifying it.
    pub command_sequence: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Invocation {
    Watch(WatchOptions),
    Command(CommandOptions),
}

fn parse_u64(name: &str, value: &str) -> Result<u64, String> {
    value
        .parse::<u64>()
        .map_err(|_| format!("invalid value for {name} (expected a positive integer): {value}"))
}

/// Collects `--name value` / `--name=value` pairs. Value-taking options must be listed by the
/// caller, so a boolean flag can never swallow the argument that follows it.
fn collect_options<'a>(
    args: impl Iterator<Item = &'a String>,
    value_options: &[&str],
) -> Result<Vec<(String, Option<String>)>, String> {
    let mut options: Vec<(String, Option<String>)> = Vec::new();
    let mut iter = args.peekable();
    while let Some(arg) = iter.next() {
        let (name, inline_value) = match arg.split_once('=') {
            Some((name, value)) => (name.to_string(), Some(value.to_string())),
            None => (arg.clone(), None),
        };
        if !name.starts_with("--") {
            return Err(format!("unexpected argument: {arg}"));
        }
        if inline_value.is_none() && value_options.contains(&name.as_str()) {
            match iter.next() {
                Some(value) => options.push((name, Some(value.clone()))),
                None => return Err(format!("missing value for {name}")),
            }
        } else {
            options.push((name, inline_value));
        }
    }
    Ok(options)
}

fn take_value(options: &[(String, Option<String>)], name: &str) -> Option<String> {
    options
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.clone().unwrap_or_default())
}

/// Parses `args` (already stripped of argv[0]).
pub fn parse(args: &[String]) -> Result<Invocation, String> {
    let Some(command) = args.first() else {
        return Err("missing command (watch | command)".to_string());
    };
    match command.as_str() {
        "watch" => parse_watch(args).map(Invocation::Watch),
        "command" => parse_command(args).map(Invocation::Command),
        other => Err(format!("unknown command: {other}")),
    }
}

fn parse_watch(args: &[String]) -> Result<WatchOptions, String> {
    let options = collect_options(
        args[1..].iter(),
        &["--interval", "--heartbeat", "--match", "--iterations"],
    )?;

    // Reject unknown flags instead of ignoring them: a typo in `--interval` would otherwise
    // silently leave the default in place and look like the option did nothing.
    for (name, _) in &options {
        match name.as_str() {
            "--interval" | "--heartbeat" | "--match" | "--iterations" | "--once" => {}
            other => return Err(format!("unknown option: {other}")),
        }
    }

    let interval_ms = match take_value(&options, "--interval") {
        Some(value) => parse_u64("--interval", &value)?,
        None => DEFAULT_INTERVAL_MS,
    };
    if interval_ms == 0 {
        return Err("--interval must be greater than zero".to_string());
    }

    let heartbeat_ms = match take_value(&options, "--heartbeat") {
        Some(value) => parse_u64("--heartbeat", &value)?,
        None => DEFAULT_HEARTBEAT_MS,
    };
    if heartbeat_ms == 0 {
        return Err("--heartbeat must be greater than zero".to_string());
    }

    let match_substring = take_value(&options, "--match").unwrap_or_else(|| DEFAULT_MATCH.to_string());
    if match_substring.trim().is_empty() {
        return Err("--match must not be empty".to_string());
    }

    let once = options.iter().any(|(name, _)| name == "--once");
    let iterations = match take_value(&options, "--iterations") {
        Some(value) => parse_u64("--iterations", &value)?,
        None => 0,
    };

    Ok(WatchOptions {
        interval_ms,
        heartbeat_ms,
        match_substring,
        once,
        iterations,
    })
}

fn parse_command(args: &[String]) -> Result<CommandOptions, String> {
    // `args` has already been stripped of argv[0] by the caller, so args[0] is the `command`
    // subcommand itself. Everything after it is the optional positional command name, the boolean
    // `--command-sequence`, or a value option.
    let rest = &args[1..];
    let value_options = ["--position-ms", "--match"];

    // One pass, because which arguments are positional depends on which options take a value:
    // `command --match X play` has `X` as the option's value, not a second command name. A boolean
    // flag is never allowed to consume the next argument, so `--command-sequence` cannot swallow the
    // command name that follows it.
    let mut options: Vec<(String, Option<String>)> = Vec::new();
    let mut names: Vec<String> = Vec::new();
    let mut index = 0usize;
    while index < rest.len() {
        let arg = &rest[index];
        index += 1;

        let (name, inline_value) = match arg.split_once('=') {
            Some((name, value)) => (name.to_string(), Some(value.to_string())),
            None => (arg.clone(), None),
        };
        if !name.starts_with("--") {
            names.push(arg.clone());
            continue;
        }
        if inline_value.is_none() && value_options.contains(&name.as_str()) {
            match rest.get(index) {
                Some(value) => {
                    options.push((name, Some(value.clone())));
                    index += 1;
                }
                None => return Err(format!("missing value for {name}")),
            }
            continue;
        }
        options.push((name, inline_value));
    }

    for (option, _) in &options {
        match option.as_str() {
            "--position-ms" | "--match" | "--command-sequence" => {}
            other => return Err(format!("unknown option: {other}")),
        }
    }
    let sequence = options.iter().any(|(name, _)| name == "--command-sequence");
    if options.iter().any(|(name, value)| name == "--command-sequence" && value.is_some()) {
        return Err("--command-sequence is a boolean flag and takes no value".to_string());
    }

    if names.len() > 1 {
        return Err("command accepts at most one command name".to_string());
    }
    let name = names.into_iter().next().unwrap_or_default();
    // With --command-sequence the name is optional: the sequence is the scripted self-test the
    // real-Electron acceptance run drives, and naming one command there would be meaningless.
    if name.is_empty() && !sequence {
        return Err("missing command name (play | pause | toggle-play-pause | previous | next | seek)".to_string());
    }

    let match_substring = take_value(&options, "--match").unwrap_or_else(|| DEFAULT_MATCH.to_string());
    if match_substring.trim().is_empty() {
        return Err("--match must not be empty".to_string());
    }

    let position_ms = match take_value(&options, "--position-ms") {
        Some(value) => Some(parse_u64("--position-ms", &value)?),
        None => None,
    };

    // Only `seek` takes a position. Rejecting the others makes a copy-pasted flag loud instead of
    // ignored, which is the same reason unknown options are rejected above.
    if position_ms.is_some() && name != "seek" {
        return Err(format!("--position-ms only applies to seek, not to {name}"));
    }
    if name == "seek" && position_ms.is_none() {
        return Err("seek requires --position-ms <ms>".to_string());
    }
    if sequence && position_ms.is_some() {
        return Err("--command-sequence and --position-ms are mutually exclusive".to_string());
    }

    Ok(CommandOptions {
        command: name,
        position_ms,
        match_substring,
        command_sequence: sequence,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn watch(list: &[&str]) -> WatchOptions {
        match parse(&args(list)).unwrap() {
            Invocation::Watch(options) => options,
            other => panic!("expected watch, got {other:?}"),
        }
    }

    fn command(list: &[&str]) -> CommandOptions {
        match parse(&args(list)).unwrap() {
            Invocation::Command(options) => options,
            other => panic!("expected command, got {other:?}"),
        }
    }

    #[test]
    fn watch_defaults() {
        assert_eq!(
            watch(&["watch"]),
            WatchOptions {
                interval_ms: DEFAULT_INTERVAL_MS,
                heartbeat_ms: DEFAULT_HEARTBEAT_MS,
                match_substring: DEFAULT_MATCH.to_string(),
                once: false,
                iterations: 0,
            }
        );
    }

    #[test]
    fn parses_iterations() {
        assert_eq!(watch(&["watch", "--iterations", "5"]).iterations, 5);
        assert_eq!(watch(&["watch", "--iterations=0"]).iterations, 0);
        assert!(parse(&args(&["watch", "--iterations", "x"])).is_err());
    }

    #[test]
    fn accepts_both_flag_forms() {
        let spaced = watch(&["watch", "--interval", "250"]);
        let inline = watch(&["watch", "--interval=250"]);
        assert_eq!(spaced, inline);
        assert_eq!(spaced.interval_ms, 250);
    }

    #[test]
    fn parses_match_and_heartbeat_and_once() {
        let options = watch(&[
            "watch",
            "--match=Chrome",
            "--heartbeat",
            "1000",
            "--once",
        ]);
        assert_eq!(options.match_substring, "Chrome");
        assert_eq!(options.heartbeat_ms, 1000);
        assert!(options.once);
    }

    #[test]
    fn boolean_flag_does_not_swallow_the_next_argument() {
        // Regression: when only --hwnd-style options consumed values, --once ate the following
        // argument and the flag after it silently disappeared.
        let options = watch(&["watch", "--once", "--interval", "250"]);
        assert!(options.once);
        assert_eq!(options.interval_ms, 250);
    }

    #[test]
    fn rejects_unknown_option() {
        // A typo must fail loudly rather than silently keeping the default.
        assert!(parse(&args(&["watch", "--intervall", "250"])).is_err());
        assert!(parse(&args(&["watch", "--verbose"])).is_err());
    }

    #[test]
    fn rejects_bad_input() {
        assert!(parse(&args(&[])).is_err());
        assert!(parse(&args(&["frobnicate"])).is_err());
        assert!(parse(&args(&["watch", "--interval", "abc"])).is_err());
        assert!(parse(&args(&["watch", "--interval"])).is_err());
        assert!(parse(&args(&["watch", "--interval", "0"])).is_err());
        assert!(parse(&args(&["watch", "--heartbeat", "0"])).is_err());
        assert!(parse(&args(&["watch", "--match", "   "])).is_err());
        assert!(parse(&args(&["watch", "stray"])).is_err());
    }

    #[test]
    fn parses_a_command_with_defaults() {
        assert_eq!(
            command(&["command", "play"]),
            CommandOptions {
                command: "play".to_string(),
                position_ms: None,
                match_substring: DEFAULT_MATCH.to_string(),
                command_sequence: false,
            }
        );
    }

    #[test]
    fn parses_the_scripted_sequence_without_a_command_name() {
        let options = command(&["command", "--command-sequence"]);
        assert!(options.command_sequence);
        assert!(options.command.is_empty());

        // A sequence plus an explicit command name is accepted and the name is simply unused, so a
        // stale copy-paste does not become a usage error.
        let with_name = command(&["command", "play", "--command-sequence"]);
        assert!(with_name.command_sequence);
        assert_eq!(with_name.command, "play");

        assert!(parse(&args(&["command"])).is_err());
        assert!(parse(&args(&["command", "--command-sequence", "--position-ms", "1000"])).is_err());
        // The =value form is not accepted for a boolean flag.
        assert!(parse(&args(&["command", "--command-sequence=1"])).is_err());
    }

    #[test]
    fn rejects_more_than_one_command_name() {
        assert!(parse(&args(&["command", "play", "pause"])).is_err());
    }

    #[test]
    fn parses_a_seek_with_a_position() {
        let options = command(&["command", "seek", "--position-ms", "42000"]);
        assert_eq!(options.command, "seek");
        assert_eq!(options.position_ms, Some(42000));
        // The = form is accepted here too, like watch's flags.
        assert_eq!(
            command(&["command", "seek", "--position-ms=42000"]).position_ms,
            Some(42000)
        );
        assert_eq!(
            command(&["command", "next", "--match=CustomMusic"]).match_substring,
            "CustomMusic"
        );
    }

    #[test]
    fn command_names_are_passed_through_for_commands_rs_to_validate() {
        // cli.rs only checks that a name is present; the single source of truth for which names are
        // real is commands::Command::from_name, so an unknown name must survive parsing and be
        // rejected later with a structured reason.
        assert_eq!(command(&["command", "frobnicate"]).command, "frobnicate");
        assert_eq!(command(&["command", "toggle"]).command, "toggle");
    }

    #[test]
    fn rejects_bad_command_arguments() {
        assert!(parse(&args(&["command"])).is_err());
        assert!(parse(&args(&["command", "--match=x"])).is_err());
        assert!(parse(&args(&["command", "seek"])).is_err());
        assert!(parse(&args(&["command", "play", "--position-ms", "1000"])).is_err());
        assert!(parse(&args(&["command", "seek", "--position-ms", "-1"])).is_err());
        assert!(parse(&args(&["command", "play", "--verbose"])).is_err());
        assert!(parse(&args(&["command", "play", "--match", " "])).is_err());
    }
}
