// packaging/windows/apple-music-smtc-helper/src/commands.rs
// Phase 2 reverse channel: parses one-line transport commands off stdin and turns them into
// structured results. No WinRT imports here — the actual Try* call arrives through the `Transport`
// trait, so every branch below (unknown command, bad argument, missing session, declined call,
// failing call) is covered by `cargo test` on any host OS, exactly like cli.rs/events.rs/watcher.rs.
//
// Two rules are load-bearing and must not be relaxed:
//   * A command is addressed to the Apple Music session by its AUMID, on demand. There is no
//     fallback to the OS "current session" and no fallback to any other player: if Apple Music is
//     not on the SMTC surface the command fails with `session-not-found` and nothing is touched.
//     Verified behaviour on Windows 11 26200 is that Apple Music answers Try* calls even while it
//     is not the current session, so "not current" must never be treated as "not targetable".
//   * stdout stays machine-readable JSONL. Nothing in this module prints; human-readable text goes
//     to stderr in main.rs only.

use crate::events::{
    CommandReply, ERR_KIND_CONTROLLER_DECLINED, ERR_KIND_INVALID_ARGUMENT,
    ERR_KIND_MALFORMED_REQUEST, ERR_KIND_SESSION_NOT_FOUND, ERR_KIND_TRANSPORT_ERROR,
    ERR_KIND_UNSUPPORTED_COMMAND,
};

/// Upper bound for a seek target: one hour. Apple Music's own tracks are far shorter, and the
/// bound keeps a malformed or hostile request from being turned into an absurd tick count.
pub const MAX_SEEK_MS: u64 = 3_600_000;

/// One parsed transport command. `as_str` is the protocol name — the same spelling that appears on
/// stdin and in the response's `command` field, so the two can never drift apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    Play,
    Pause,
    TogglePlayPause,
    Previous,
    Next,
    Seek { position_ms: u64 },
}

impl Command {
    pub fn as_str(&self) -> &'static str {
        match self {
            Command::Play => "play",
            Command::Pause => "pause",
            Command::TogglePlayPause => "toggle-play-pause",
            Command::Previous => "previous",
            Command::Next => "next",
            Command::Seek { .. } => "seek",
        }
    }

    /// Protocol names accepted on stdin. Longer than `as_str` on purpose: a caller may spell the
    /// toggle as `toggle` or `play-pause`, and normalizing here is cheaper than making the
    /// Electron side remember one exact spelling.
    fn from_name(name: &str) -> Option<Command> {
        match name {
            "play" => Some(Command::Play),
            "pause" => Some(Command::Pause),
            "toggle" | "toggle-play-pause" | "toggle-playpause" | "play-pause" => {
                Some(Command::TogglePlayPause)
            }
            "previous" | "prev" => Some(Command::Previous),
            "next" | "skip-next" => Some(Command::Next),
            "seek" => Some(Command::Seek { position_ms: 0 }),
            _ => None,
        }
    }
}

/// A request line, already validated. `id` is echoed verbatim so the consumer can match the
/// response to the promise that asked for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandRequest {
    pub id: String,
    pub command: Command,
}

/// Parses one stdin line into a request, or explains why it cannot be one.
///
/// Every rejection carries a static kind so the response is structured even for garbage input;
/// the reason string is for humans and is never parsed by the consumer.
pub fn parse_command_line(line: &str) -> Result<CommandRequest, (&'static str, String)> {
    let text = line.trim();
    if text.is_empty() {
        return Err((ERR_KIND_MALFORMED_REQUEST, "empty request".to_string()));
    }

    let object = JsonObject::parse(text)
        .map_err(|reason| (ERR_KIND_MALFORMED_REQUEST, format!("malformed request: {reason}")))?;

    let id = match object.string("id") {
        Some(id) if !id.trim().is_empty() => id,
        _ => {
            return Err((
                ERR_KIND_MALFORMED_REQUEST,
                "request is missing a non-empty string \"id\"".to_string(),
            ))
        }
    };

    let name = match object.string("command") {
        Some(name) => name,
        None => {
            return Err((
                ERR_KIND_MALFORMED_REQUEST,
                "request is missing a string \"command\"".to_string(),
            ))
        }
    };

    let Some(mut command) = Command::from_name(&name) else {
        return Err((
            ERR_KIND_UNSUPPORTED_COMMAND,
            format!("unsupported command: {name}"),
        ));
    };

    if let Command::Seek { position_ms: _ } = command {
        let raw = object.integer("positionMs").ok_or_else(|| {
            (
                ERR_KIND_INVALID_ARGUMENT,
                "seek requires an integer \"positionMs\"".to_string(),
            )
        })?;
        let parsed = raw.parse::<i64>().map_err(|_| {
            (
                ERR_KIND_INVALID_ARGUMENT,
                format!("seek requires an integer \"positionMs\", got: {raw}"),
            )
        })?;
        command = Command::Seek {
            position_ms: validate_seek_ms(parsed)
                .map_err(|reason| (ERR_KIND_INVALID_ARGUMENT, reason))?,
        };
    }

    Ok(CommandRequest { id, command })
}

/// Resolves a protocol name (plus an optional position) into a validated `Command`, or None when the
/// name is not one this helper supports. The single resolution point for argv, the scripted sequence
/// and — through `parse_command_line` — stdin, so all three accept exactly the same vocabulary.
pub fn command_named(name: &str, position_ms: Option<u64>) -> Option<Command> {
    match Command::from_name(name)? {
        Command::Seek { .. } => {
            let requested = position_ms?;
            validate_seek_ms(requested as i64).ok().map(|position_ms| Command::Seek { position_ms })
        }
        other => Some(other),
    }
}

/// A seek target must be a non-negative integer within `MAX_SEEK_MS`. Negative is rejected rather
/// than clamped: `TryChangePlaybackPositionAsync` takes an unsigned tick count, so a negative value
/// silently became a huge one before this check existed.
pub fn validate_seek_ms(position_ms: i64) -> Result<u64, String> {
    if position_ms < 0 {
        return Err(format!("positionMs must not be negative: {position_ms}"));
    }
    let value = position_ms as u64;
    if value > MAX_SEEK_MS {
        return Err(format!(
            "positionMs must not exceed {MAX_SEEK_MS} (one hour), got: {value}"
        ));
    }
    Ok(value)
}

/// Milliseconds to the 100-nanosecond ticks `TryChangePlaybackPositionAsync` expects. The unit is
/// the only thing standing between a correct seek and one that lands 10 000x off, so it has its own
/// function and its own test.
pub fn ms_to_ticks(position_ms: u64) -> i64 {
    (position_ms as i64).saturating_mul(10_000)
}

/// What the platform did with a command. The split between `Declined` and `Failed` mirrors WinRT:
/// `Try*` resolves to FALSE when the session does not support the action right now, and returns an
/// error only when the call itself could not be made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandOutcome {
    Delivered,
    Declined,
    Failed(String),
}

/// The platform half of a command, injected so the decision logic is testable without Windows.
/// Implemented by `session::SessionTransport` (which targets the Apple Music session found by
/// AUMID) and by fakes in the tests below.
pub trait Transport {
    /// Sends the command to the Apple Music session. `Err(reason)` means no Apple Music session
    /// could be addressed — never that another player was used instead.
    fn dispatch(&self, command: Command) -> Result<CommandOutcome, String>;

    /// AUMID the transport is bound to, for the reply. Empty when nothing was resolved.
    fn target_app_user_model_id(&self) -> &str;
}

/// Runs one request and always produces a structured reply. `completed_at_ms` is supplied by the
/// caller so this function stays free of clocks and is deterministic under test.
pub fn execute(request: &CommandRequest, transport: &dyn Transport, completed_at_ms: u64) -> CommandReply {
    let name = request.command.as_str();
    match transport.dispatch(request.command) {
        Ok(CommandOutcome::Delivered) => {
            CommandReply::delivered(&request.id, name, transport.target_app_user_model_id(), completed_at_ms)
        }
        Ok(CommandOutcome::Declined) => CommandReply::failed(
            &request.id,
            name,
            ERR_KIND_CONTROLLER_DECLINED,
            "the session refused the command (the Try* call returned false)",
            Some(transport.target_app_user_model_id()),
            completed_at_ms,
        ),
        Ok(CommandOutcome::Failed(reason)) => CommandReply::failed(
            &request.id,
            name,
            ERR_KIND_TRANSPORT_ERROR,
            &reason,
            Some(transport.target_app_user_model_id()),
            completed_at_ms,
        ),
        Err(reason) => CommandReply::failed(
            &request.id,
            name,
            ERR_KIND_SESSION_NOT_FOUND,
            &reason,
            None,
            completed_at_ms,
        ),
    }
}

/// Turns a rejected request line into a reply, so a malformed line is answered on stdout rather
/// than only logged. The id is empty when the line was too broken to carry one.
pub fn rejection_reply(id: &str, command: &str, kind: &'static str, reason: &str, completed_at_ms: u64) -> CommandReply {
    CommandReply::failed(id, command, kind, reason, None, completed_at_ms)
}

/// Runs the `command` subcommand's argv form through the same validation the stdin path uses, so the
/// one-shot and the watch-loop channel cannot drift apart.
///
/// `resolve` supplies the transport, which is how the Windows-only `SessionTransport` stays out of
/// this platform-free module. The reply's id is empty: nothing is correlating a headless run.
pub fn execute_argv<'a>(
    options: &crate::cli::CommandOptions,
    resolve: impl FnOnce() -> Result<Box<dyn Transport + 'a>, String>,
    completed_at_ms: u64,
) -> CommandReply {
    let Some(command) = command_named(&options.command, options.position_ms) else {
        // The two ways this can fail are told apart so the reply says which one it was: an unknown
        // name, or a seek whose position is missing or out of range.
        let seek = matches!(Command::from_name(&options.command), Some(Command::Seek { .. }));
        if seek && options.position_ms.is_none() {
            return rejection_reply(
                "",
                &options.command,
                ERR_KIND_INVALID_ARGUMENT,
                "seek requires --position-ms <ms>",
                completed_at_ms,
            );
        }
        if seek {
            let reason = validate_seek_ms(options.position_ms.unwrap_or(0) as i64).unwrap_err();
            return rejection_reply("", &options.command, ERR_KIND_INVALID_ARGUMENT, &reason, completed_at_ms);
        }
        return rejection_reply(
            "",
            &options.command,
            ERR_KIND_UNSUPPORTED_COMMAND,
            &format!("unsupported command: {}", options.command),
            completed_at_ms,
        );
    };
    let request = CommandRequest {
        id: String::new(),
        command,
    };

    match resolve() {
        Ok(transport) => execute(&request, transport.as_ref(), completed_at_ms),
        Err(reason) => rejection_reply(
            "",
            request.command.as_str(),
            ERR_KIND_SESSION_NOT_FOUND,
            &reason,
            completed_at_ms,
        ),
    }
}

impl Transport for () {
    fn dispatch(&self, _command: Command) -> Result<CommandOutcome, String> {
        Err("no transport".to_string())
    }

    fn target_app_user_model_id(&self) -> &str {
        ""
    }
}

// -- Minimal JSON object reader ------------------------------------------------------------------
//
// The request grammar is a flat object of scalars, so a full JSON parser would be a dependency and a
// support surface for four fields. This reader handles exactly one flat object: string and integer
// values, quoted strings with escapes, and whitespace. Anything else is a `malformed-request`, and
// the emitted protocol never nests.

struct JsonObject {
    fields: Vec<(String, JsonValue)>,
}

enum JsonValue {
    Text(String),
    Number(String),
}

impl JsonObject {
    fn parse(input: &str) -> Result<JsonObject, String> {
        let bytes = input.as_bytes();
        let mut cursor = 0usize;
        skip_whitespace(bytes, &mut cursor);
        expect(bytes, &mut cursor, b'{')?;

        let mut fields = Vec::new();
        loop {
            skip_whitespace(bytes, &mut cursor);
            if peek(bytes, cursor) == Some(b'}') {
                cursor += 1;
                break;
            }
            let key = parse_string(bytes, &mut cursor)?;
            skip_whitespace(bytes, &mut cursor);
            expect(bytes, &mut cursor, b':')?;
            skip_whitespace(bytes, &mut cursor);
            let value = match peek(bytes, cursor) {
                Some(b'"') => JsonValue::Text(parse_string(bytes, &mut cursor)?),
                Some(b'-') | Some(b'0'..=b'9') => JsonValue::Number(parse_number(bytes, &mut cursor)?),
                _ => return Err("only string and integer values are supported".to_string()),
            };
            fields.push((key, value));
            skip_whitespace(bytes, &mut cursor);
            match peek(bytes, cursor) {
                Some(b',') => cursor += 1,
                Some(b'}') => {
                    cursor += 1;
                    break;
                }
                _ => return Err("expected ',' or '}'".to_string()),
            }
        }

        skip_whitespace(bytes, &mut cursor);
        if cursor != bytes.len() {
            return Err("trailing content after the object".to_string());
        }
        Ok(JsonObject { fields })
    }

    fn string(&self, name: &str) -> Option<String> {
        self.fields.iter().find_map(|(key, value)| match value {
            JsonValue::Text(text) if key == name => Some(text.clone()),
            _ => None,
        })
    }

    /// Raw scalar text for an integer field, so the caller can report the exact value it rejected.
    /// Returns None for a quoted value: `"1000"` is present and readable but the wrong type, which
    /// is an invalid argument rather than malformed JSON, and reporting the value is what makes that
    /// distinguishable in a log.
    fn integer(&self, name: &str) -> Option<String> {
        self.fields.iter().find_map(|(key, value)| match value {
            JsonValue::Number(text) if key == name => Some(text.clone()),
            _ => None,
        })
    }
}

fn peek(bytes: &[u8], cursor: usize) -> Option<u8> {
    bytes.get(cursor).copied()
}

fn skip_whitespace(bytes: &[u8], cursor: &mut usize) {
    while let Some(byte) = peek(bytes, *cursor) {
        if byte == b' ' || byte == b'\t' || byte == b'\r' || byte == b'\n' {
            *cursor += 1;
        } else {
            break;
        }
    }
}

fn expect(bytes: &[u8], cursor: &mut usize, expected: u8) -> Result<(), String> {
    if peek(bytes, *cursor) == Some(expected) {
        *cursor += 1;
        Ok(())
    } else {
        Err(format!("expected '{}'", expected as char))
    }
}

fn parse_string(bytes: &[u8], cursor: &mut usize) -> Result<String, String> {
    expect(bytes, cursor, b'"')?;
    let mut out = String::new();
    while let Some(byte) = peek(bytes, *cursor) {
        *cursor += 1;
        match byte {
            b'"' => return Ok(out),
            b'\\' => {
                let escape = peek(bytes, *cursor).ok_or("unterminated escape")?;
                *cursor += 1;
                match escape {
                    b'"' => out.push('"'),
                    b'\\' => out.push('\\'),
                    b'/' => out.push('/'),
                    b'b' => out.push('\u{0008}'),
                    b'f' => out.push('\u{000c}'),
                    b'n' => out.push('\n'),
                    b'r' => out.push('\r'),
                    b't' => out.push('\t'),
                    b'u' => {
                        let hex = bytes
                            .get(*cursor..*cursor + 4)
                            .ok_or("truncated \\u escape")?;
                        let text = std::str::from_utf8(hex).map_err(|_| "invalid \\u escape")?;
                        let code = u32::from_str_radix(text, 16).map_err(|_| "invalid \\u escape")?;
                        // Surrogate halves are not reassembled: an id or command name never needs
                        // one, and a wrong join would be worse than a replacement character.
                        out.push(char::from_u32(code).unwrap_or('\u{fffd}'));
                        *cursor += 4;
                    }
                    _ => return Err("unknown escape sequence".to_string()),
                }
            }
            _ => {
                // Re-decode the byte through the original string slice so multi-byte UTF-8 in a
                // command name survives; a byte-at-a-time push would corrupt it.
                let start = *cursor - 1;
                let rest = std::str::from_utf8(&bytes[start..]).map_err(|_| "invalid utf-8")?;
                let ch = rest.chars().next().ok_or("invalid utf-8")?;
                out.push(ch);
                *cursor = start + ch.len_utf8();
            }
        }
    }
    Err("unterminated string".to_string())
}

fn parse_number(bytes: &[u8], cursor: &mut usize) -> Result<String, String> {
    let start = *cursor;
    if peek(bytes, *cursor) == Some(b'-') {
        *cursor += 1;
    }
    let digits_start = *cursor;
    while matches!(peek(bytes, *cursor), Some(b'0'..=b'9')) {
        *cursor += 1;
    }
    if *cursor == digits_start {
        return Err("expected a number".to_string());
    }
    // A fractional or exponent form is rejected rather than truncated: `positionMs` is defined as an
    // integer, and silently rounding 1000.7 would be a lie about what was requested. The digits are
    // consumed before refusing so the error is about the value's type, not about trailing input.
    let mut fractional = false;
    if peek(bytes, *cursor) == Some(b'.') {
        fractional = true;
        *cursor += 1;
        while matches!(peek(bytes, *cursor), Some(b'0'..=b'9')) {
            *cursor += 1;
        }
    }
    if matches!(peek(bytes, *cursor), Some(b'e') | Some(b'E')) {
        fractional = true;
        *cursor += 1;
        if peek(bytes, *cursor) == Some(b'+') {
            *cursor += 1;
        }
        while matches!(peek(bytes, *cursor), Some(b'0'..=b'9')) {
            *cursor += 1;
        }
    }
    if fractional {
        return Err("only integer numbers are supported".to_string());
    }
    Ok(std::str::from_utf8(&bytes[start..*cursor])
        .map_err(|_| "invalid number")?
        .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    const AUMID: &str = "AppleInc.AppleMusicWin_nzyj5cx40ttqa!App";

    /// Records what it was asked to do and replays a canned outcome, so the reply mapping is tested
    /// without WinRT.
    struct FakeTransport {
        outcome: Result<CommandOutcome, String>,
        target: Option<&'static str>,
        seen: RefCell<Vec<Command>>,
    }

    impl FakeTransport {
        fn new(outcome: Result<CommandOutcome, String>) -> Self {
            Self {
                outcome,
                target: Some(AUMID),
                seen: RefCell::new(Vec::new()),
            }
        }

        fn with_target(outcome: Result<CommandOutcome, String>, target: Option<&'static str>) -> Self {
            Self {
                outcome,
                target,
                seen: RefCell::new(Vec::new()),
            }
        }
    }

    impl Transport for FakeTransport {
        fn dispatch(&self, command: Command) -> Result<CommandOutcome, String> {
            self.seen.borrow_mut().push(command);
            self.outcome.clone()
        }

        fn target_app_user_model_id(&self) -> &str {
            self.target.unwrap_or("")
        }
    }

    fn request(line: &str) -> CommandRequest {
        parse_command_line(line).expect("expected a valid request")
    }

    /// A transport that always answers the same way, for the argv path where nothing is recorded.
    struct StubTransport {
        outcome: Result<CommandOutcome, String>,
        target: &'static str,
    }

    impl Transport for StubTransport {
        fn dispatch(&self, _command: Command) -> Result<CommandOutcome, String> {
            self.outcome.clone()
        }

        fn target_app_user_model_id(&self) -> &str {
            self.target
        }
    }

    fn options(command: &str, position_ms: Option<u64>) -> crate::cli::CommandOptions {
        crate::cli::CommandOptions {
            command: command.to_string(),
            position_ms,
            match_substring: crate::cli::DEFAULT_MATCH.to_string(),
            command_sequence: false,
        }
    }

    #[test]
    fn parses_every_supported_command() {
        assert_eq!(request(r#"{"id":"1","command":"play"}"#).command, Command::Play);
        assert_eq!(request(r#"{"id":"1","command":"pause"}"#).command, Command::Pause);
        assert_eq!(
            request(r#"{"id":"1","command":"toggle-play-pause"}"#).command,
            Command::TogglePlayPause
        );
        // Accepted spellings of the toggle, so the consumer is not forced to remember one.
        assert_eq!(request(r#"{"id":"1","command":"toggle"}"#).command, Command::TogglePlayPause);
        assert_eq!(request(r#"{"id":"1","command":"play-pause"}"#).command, Command::TogglePlayPause);
        assert_eq!(request(r#"{"id":"1","command":"previous"}"#).command, Command::Previous);
        assert_eq!(request(r#"{"id":"1","command":"next"}"#).command, Command::Next);
        assert_eq!(
            request(r#"{"id":"1","command":"seek","positionMs":42000}"#).command,
            Command::Seek { position_ms: 42000 }
        );
    }

    #[test]
    fn accepts_whitespace_and_reordered_fields() {
        let parsed = request("  {\n \"command\" : \"next\" ,\n \"id\" : \"abc\" }  ");
        assert_eq!(parsed.id, "abc");
        assert_eq!(parsed.command, Command::Next);
    }

    #[test]
    fn normalizes_the_toggle_to_one_protocol_name() {
        // The response must name the command the same way every time, whatever spelling arrived.
        let parsed = request(r#"{"id":"1","command":"toggle"}"#);
        assert_eq!(parsed.command.as_str(), "toggle-play-pause");
    }

    #[test]
    fn rejects_unknown_commands_with_a_structured_kind() {
        let (kind, reason) = parse_command_line(r#"{"id":"1","command":"frobnicate"}"#).unwrap_err();
        assert_eq!(kind, ERR_KIND_UNSUPPORTED_COMMAND);
        assert!(reason.contains("frobnicate"));
    }

    #[test]
    fn rejects_malformed_lines_without_panicking() {
        for line in [
            "",
            "   ",
            "not json",
            "{",
            r#"{"id":"1""#,
            r#"{"id":"1","command":"play""#,
            r#"{"command":"play"}"#,
            r#"{"id":"","command":"play"}"#,
            r#"{"id":"1"}"#,
            r#"{"id":"1","command":5}"#,
            r#"{"id":"1","command":"play"} trailing"#,
            r#"{"id":"1","command":"play","extra":{"nested":1}}"#,
        ] {
            let error = parse_command_line(line).unwrap_err();
            assert_eq!(error.0, ERR_KIND_MALFORMED_REQUEST, "line: {line}");
        }
    }

    #[test]
    fn seek_requires_a_valid_position() {
        let missing = parse_command_line(r#"{"id":"1","command":"seek"}"#).unwrap_err();
        assert_eq!(missing.0, ERR_KIND_INVALID_ARGUMENT);

        let negative = parse_command_line(r#"{"id":"1","command":"seek","positionMs":-1}"#).unwrap_err();
        assert_eq!(negative.0, ERR_KIND_INVALID_ARGUMENT);

        // Zero is a real seek to the start of the track, not a missing value.
        assert_eq!(
            request(r#"{"id":"1","command":"seek","positionMs":0}"#).command,
            Command::Seek { position_ms: 0 }
        );

        let too_big = parse_command_line(
            r#"{"id":"1","command":"seek","positionMs":3600001}"#,
        )
        .unwrap_err();
        assert_eq!(too_big.0, ERR_KIND_INVALID_ARGUMENT);

        let fractional =
            parse_command_line(r#"{"id":"1","command":"seek","positionMs":1000.5}"#).unwrap_err();
        assert_eq!(fractional.0, ERR_KIND_MALFORMED_REQUEST);

        let quoted =
            parse_command_line(r#"{"id":"1","command":"seek","positionMs":"1000"}"#).unwrap_err();
        assert_eq!(quoted.0, ERR_KIND_INVALID_ARGUMENT);
    }

    #[test]
    fn seek_validation_round_trips_through_ticks() {
        assert_eq!(validate_seek_ms(1000), Ok(1000));
        assert_eq!(ms_to_ticks(1000), 10_000_000);
        assert_eq!(ms_to_ticks(0), 0);
        assert_eq!(ms_to_ticks(MAX_SEEK_MS), 36_000_000_000);
    }

    #[test]
    fn dispatch_reaches_the_transport_exactly_once() {
        let transport = FakeTransport::new(Ok(CommandOutcome::Delivered));
        let reply = execute(&request(r#"{"id":"c9","command":"next"}"#), &transport, 777);
        assert_eq!(transport.seen.borrow().as_slice(), &[Command::Next]);
        assert!(reply.ok);
        assert_eq!(reply.id, "c9");
        assert_eq!(reply.command, "next");
        assert_eq!(reply.target_app_user_model_id.as_deref(), Some(AUMID));
        assert_eq!(reply.completed_at_ms, 777);
    }

    #[test]
    fn a_seek_is_forwarded_with_its_position() {
        let transport = FakeTransport::new(Ok(CommandOutcome::Delivered));
        execute(&request(r#"{"id":"c","command":"seek","positionMs":42000}"#), &transport, 0);
        assert_eq!(
            transport.seen.borrow().as_slice(),
            &[Command::Seek { position_ms: 42000 }]
        );
    }

    #[test]
    fn a_declined_call_is_not_reported_as_delivered() {
        // WinRT's Try* returning FALSE means "not now", which a consumer must be able to retry.
        let transport = FakeTransport::new(Ok(CommandOutcome::Declined));
        let reply = execute(&request(r#"{"id":"c","command":"pause"}"#), &transport, 5);
        assert!(!reply.ok);
        assert_eq!(reply.error_kind, Some(ERR_KIND_CONTROLLER_DECLINED));
        assert_eq!(reply.target_app_user_model_id.as_deref(), Some(AUMID));
    }

    #[test]
    fn a_failing_call_carries_its_reason() {
        let transport = FakeTransport::new(Ok(CommandOutcome::Failed("the RPC server is unavailable".to_string())));
        let reply = execute(&request(r#"{"id":"c","command":"play"}"#), &transport, 5);
        assert!(!reply.ok);
        assert_eq!(reply.error_kind, Some(ERR_KIND_TRANSPORT_ERROR));
        assert_eq!(reply.error.as_deref(), Some("the RPC server is unavailable"));
    }

    #[test]
    fn a_missing_session_names_no_target_and_never_falls_back() {
        // The safety rule: when Apple Music is not on the SMTC surface the command reports
        // session-not-found with no target, so a consumer can prove nothing else was controlled.
        let transport = FakeTransport::with_target(
            Err("no Apple Music session is visible".to_string()),
            None,
        );
        let reply = execute(&request(r#"{"id":"c","command":"toggle"}"#), &transport, 5);
        assert!(!reply.ok);
        assert_eq!(reply.error_kind, Some(ERR_KIND_SESSION_NOT_FOUND));
        assert!(reply.target_app_user_model_id.is_none());
        // The command was still attempted against the resolver — it just resolved to nothing.
        assert_eq!(transport.seen.borrow().len(), 1);
    }

    #[test]
    fn a_unicode_id_survives_the_round_trip() {
        // Multi-byte UTF-8 in a string field must not be decoded byte-by-byte.
        let parsed = request("{\"id\":\"会话-1\",\"command\":\"play\"}");
        assert_eq!(parsed.id, "会话-1");
    }

    #[test]
    fn escaped_characters_in_an_id_are_decoded() {
        let parsed = request(r#"{"id":"a\"b\\c","command":"play"}"#);
        assert_eq!(parsed.id, "a\"b\\c");
    }

    #[test]
    fn rejection_replies_are_structured() {
        let reply = rejection_reply("c1", "frobnicate", ERR_KIND_UNSUPPORTED_COMMAND, "nope", 42);
        assert!(!reply.ok);
        assert_eq!(reply.error_kind, Some(ERR_KIND_UNSUPPORTED_COMMAND));
        assert!(reply.to_json().contains("\"event\":\"response\""));
    }

    #[test]
    fn command_named_resolves_the_same_vocabulary_as_stdin() {
        assert_eq!(command_named("play", None), Some(Command::Play));
        assert_eq!(command_named("toggle", None), Some(Command::TogglePlayPause));
        assert_eq!(command_named("prev", None), Some(Command::Previous));
        assert_eq!(command_named("seek", Some(1000)), Some(Command::Seek { position_ms: 1000 }));
        assert_eq!(command_named("seek", Some(0)), Some(Command::Seek { position_ms: 0 }));
        // A seek with no position, an out-of-range position, and an unknown name all resolve to None.
        assert_eq!(command_named("seek", None), None);
        assert_eq!(command_named("seek", Some(MAX_SEEK_MS + 1)), None);
        assert_eq!(command_named("frobnicate", None), None);
    }

    #[test]
    fn argv_replies_mirror_the_one_shot_exit_contract() {
        // The claim the process exit code rests on: `ok` is true exactly when the transport delivered.
        let delivered = execute_argv(
            &options("next", None),
            || Ok(Box::new(StubTransport { outcome: Ok(CommandOutcome::Delivered), target: AUMID })),
            11,
        );
        assert!(delivered.ok);
        assert_eq!(delivered.target_app_user_model_id.as_deref(), Some(AUMID));
        assert!(delivered.id.is_empty()); // a headless run has nothing to correlate

        let declined = execute_argv(
            &options("next", None),
            || Ok(Box::new(StubTransport { outcome: Ok(CommandOutcome::Declined), target: AUMID })),
            11,
        );
        assert!(!declined.ok);
        assert_eq!(declined.error_kind, Some(ERR_KIND_CONTROLLER_DECLINED));

        let no_session = execute_argv(
            &options("next", None),
            || Err("no session matching 'AppleMusicWin' is visible".to_string()),
            11,
        );
        assert!(!no_session.ok);
        assert_eq!(no_session.error_kind, Some(ERR_KIND_SESSION_NOT_FOUND));
        assert!(no_session.target_app_user_model_id.is_none());
    }

    #[test]
    fn argv_rejects_bad_arguments_before_resolving_a_transport() {
        let mut resolved = false;
        let unsupported = execute_argv(
            &options("frobnicate", None),
            || {
                resolved = true;
                Ok(Box::new(StubTransport { outcome: Ok(CommandOutcome::Delivered), target: AUMID }))
            },
            7,
        );
        assert_eq!(unsupported.error_kind, Some(ERR_KIND_UNSUPPORTED_COMMAND));
        assert!(!resolved, "an unsupported command must not touch the platform");

        let seek_without_position = execute_argv(
            &options("seek", None),
            || panic!("a rejected seek must not resolve a transport"),
            7,
        );
        assert_eq!(seek_without_position.error_kind, Some(ERR_KIND_INVALID_ARGUMENT));

        let seek_out_of_range = execute_argv(
            &options("seek", Some(MAX_SEEK_MS + 1)),
            || panic!("a rejected seek must not resolve a transport"),
            7,
        );
        assert_eq!(seek_out_of_range.error_kind, Some(ERR_KIND_INVALID_ARGUMENT));
    }
}
