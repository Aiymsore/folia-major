// packaging/windows/apple-music-smtc-helper/src/events.rs
// JSONL event protocol spoken on stdout between this helper and the Electron main process
// (parsed by electron/externalMediaSmtcBridge.cjs). Pure string building — no WinRT — so the
// snapshot-style unit tests below run on any host OS, matching the wallpaper helper's events.rs.
//
// Two properties are load-bearing for the consumer:
//   * Every snapshot carries the SAME key set, with absent values as JSON null rather than an
//     omitted key. The renderer/diagnostic surface can read a field without probing for it.
//   * `positionMs`/`durationMs` are integers. Apple Music reports both quantized to whole
//     seconds, but other SMTC sources report sub-millisecond values, so the protocol keeps
//     milliseconds as the unit and lets the consumer decide how much precision to trust.

use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionSnapshot {
    /// AUMID of the session this snapshot describes; the literal identity the OS uses.
    pub source_app_user_model_id: String,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    /// Raw `GlobalSystemMediaTransportControlsSessionPlaybackStatus` name, so the consumer never
    /// has to guess how a new Windows value maps onto a smaller local enum.
    pub playback_status: String,
    pub position_ms: Option<u64>,
    pub duration_ms: Option<u64>,
    pub has_thumbnail: bool,
    /// When this snapshot was captured, as Unix epoch milliseconds (the same unit the Folia
    /// renderer uses for timestamps). Not the track's progress - see position_ms.
    pub updated_at_ms: u64,
    /// When the *reported position* was established, as Unix epoch milliseconds.
    ///
    /// This is the OS's own `TimelineProperties.LastUpdatedTime`, which is the timestamp of the
    /// timeline sample `position_ms` was read from — not when we happened to poll. It is the one
    /// field that lets a consumer know how stale the position is without guessing: Apple Music
    /// quantizes the position to whole seconds and only republishes the timeline about every
    /// 250 ms, so the value read at any instant may be up to one republish period old.
    ///
    /// `None` when the timeline could not be read, which degrades this one field rather than the
    /// whole snapshot (same rule as position/duration).
    pub last_updated_ms: Option<u64>,
}

/// Structured result of one transport command, emitted as `{"event":"response",…}`.
///
/// Phase 2: `id` echoes the caller's request id so the Electron bridge can resolve the exact
/// promise that asked for it — the response stream is asynchronous and a later command may finish
/// before an earlier one, so position in the stream is not an identity.
///
/// The five fields below are the whole contract. `ok` is the only thing a consumer must branch on;
/// `error_kind` exists so it can react differently to "Apple Music is not running"
/// (`session-not-found`) and "the OS refused the call" (`transport-error`) without parsing
/// `error`, which is human text — exactly like `Event::Error`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandReply {
    pub id: String,
    pub command: String,
    pub ok: bool,
    /// AUMID of the session the command was addressed to, or None when it never got that far.
    /// Present so the consumer can prove the command did NOT land on another player.
    pub target_app_user_model_id: Option<String>,
    pub error: Option<String>,
    pub error_kind: Option<&'static str>,
    pub completed_at_ms: u64,
}

impl CommandReply {
    /// The command was handed to the WinRT call and the OS reported that it was accepted.
    pub fn delivered(
        id: &str,
        command: &str,
        target_app_user_model_id: &str,
        completed_at_ms: u64,
    ) -> Self {
        Self {
            id: id.to_string(),
            command: command.to_string(),
            ok: true,
            target_app_user_model_id: Some(target_app_user_model_id.to_string()),
            error: None,
            error_kind: None,
            completed_at_ms,
        }
    }

    /// The command was well formed but not carried out. `target_app_user_model_id` is None when
    /// no Apple Music session was found, which is the case that must never fall through to
    /// controlling whatever player happens to be current.
    pub fn failed(
        id: &str,
        command: &str,
        error_kind: &'static str,
        error: &str,
        target_app_user_model_id: Option<&str>,
        completed_at_ms: u64,
    ) -> Self {
        Self {
            id: id.to_string(),
            command: command.to_string(),
            ok: false,
            target_app_user_model_id: target_app_user_model_id.map(str::to_string),
            error: Some(error.to_string()),
            error_kind: Some(error_kind),
            completed_at_ms,
        }
    }

    pub fn to_json(&self) -> String {
        format!(
            concat!(
                "{{\"event\":\"response\",",
                "\"id\":\"{}\",",
                "\"command\":\"{}\",",
                "\"ok\":{},",
                "\"targetAppUserModelId\":{},",
                "\"error\":{},",
                "\"errorKind\":{},",
                "\"completedAtMs\":{}}}"
            ),
            escape_json(&self.id),
            escape_json(&self.command),
            self.ok,
            json_optional_string(&self.target_app_user_model_id),
            json_optional_string(&self.error),
            json_optional_string(&self.error_kind.map(str::to_string)),
            self.completed_at_ms,
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// The SMTC session manager was obtained. Emitted once per process; `session_count` is the
    /// number of sessions visible at that moment, so the consumer can tell "manager up, Apple
    /// Music not running" from "manager never came up" without waiting for a snapshot.
    Ready { session_count: usize },
    /// The matched media session is present and was read successfully.
    Snapshot { snapshot: SessionSnapshot },
    /// No matching media session is currently visible. This is the normal state when the app is
    /// closed or has nothing loaded; it is NOT an error, and the consumer is expected to clear
    /// its state on receiving it.
    NoSession,
    /// Liveness marker so the consumer can distinguish "nothing changing" from "helper hung".
    Heartbeat,
    /// Clean shutdown in response to a `stop` line on stdin (or stdin EOF, which means the main
    /// process went away). Lets the consumer tell an intentional stop from a crash.
    Stopped,
    /// Anything fatal or noteworthy. `kind` is an optional structured class the consumer may
    /// branch on; the message text is for humans and must never be parsed.
    Error { message: String, kind: Option<&'static str> },
    /// Result of one stdin transport command (Phase 2). Emitted at most once per request id.
    Response { reply: CommandReply },
}

// Error kind: the Windows Runtime refused to hand over the session manager. Retrying may help
// (the media control service can be briefly unavailable), so the consumer may restart the helper
// instead of degrading permanently.
pub const ERR_KIND_MANAGER_UNAVAILABLE: &str = "manager-unavailable";

// Response kinds, in the order a command can fail:
// * unsupported-command / invalid-argument / malformed-request: the request never reached WinRT.
// * session-not-found: the request was fine but Apple Music is not on the SMTC surface. This is
//   the kind that guarantees nothing else was controlled.
// * transport-error: the Try* call itself failed (the OS refused, or the call panicked out).
// * controller-declined: the Try* call returned FALSE, which SMTC defines as "the session does not
//   support this action right now" rather than as an error. Kept separate from transport-error
//   because the two mean different things to a consumer deciding whether to retry.
pub const ERR_KIND_UNSUPPORTED_COMMAND: &str = "unsupported-command";
pub const ERR_KIND_INVALID_ARGUMENT: &str = "invalid-argument";
pub const ERR_KIND_MALFORMED_REQUEST: &str = "malformed-request";
pub const ERR_KIND_SESSION_NOT_FOUND: &str = "session-not-found";
pub const ERR_KIND_TRANSPORT_ERROR: &str = "transport-error";
pub const ERR_KIND_CONTROLLER_DECLINED: &str = "controller-declined";

// Minimal JSON string escaping (subset of chars that can appear in our messages). Duplicated
// deliberately from the wallpaper helper: the two crates are built and versioned independently,
// and a shared crate for ~15 lines would couple their release cycles.
fn escape_json(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            control if (control as u32) < 0x20 => {
                escaped.push_str(&format!("\\u{:04x}", control as u32));
            }
            other => escaped.push(other),
        }
    }
    escaped
}

/// JSON string for an optional text field: `null` when absent or empty after trimming.
///
/// Empty and absent collapse into the same value on purpose. SMTC reports an empty
/// `AlbumTitle` for Apple Music (verified on Windows 11 26200), and a consumer that had to
/// distinguish "" from null would gain nothing it can act on.
fn json_optional_string(value: &Option<String>) -> String {
    match value.as_deref().map(str::trim) {
        Some(text) if !text.is_empty() => format!("\"{}\"", escape_json(text)),
        _ => "null".to_string(),
    }
}

fn json_optional_u64(value: Option<u64>) -> String {
    match value {
        Some(number) => number.to_string(),
        None => "null".to_string(),
    }
}

impl SessionSnapshot {
    /// True when nothing a consumer would act on has changed since `previous`.
    ///
    /// `updated_at_ms` is excluded on purpose: it changes on every read, so including it would
    /// make every poll look like a change and turn the change-gated stream back into a stream of
    /// identical snapshots. `position_ms` IS included - it is the one field that legitimately
    /// moves during playback, and Apple Music moves it about once a second.
    ///
    /// `last_updated_ms` is excluded for the same reason as `updated_at_ms`: the OS re-stamps it
    /// several times per position step (measured ~3.6 republishes per second of position), so
    /// including it would emit a snapshot for every republish and defeat the change gate. A
    /// consumer that needs the freshest stamp reads it off whichever snapshot it already has —
    /// the value only ever moves forward, and `position_ms` (which IS gated) is what changes when
    /// it matters.
    pub fn same_content_as(&self, previous: &SessionSnapshot) -> bool {
        self.source_app_user_model_id == previous.source_app_user_model_id
            && self.title == previous.title
            && self.artist == previous.artist
            && self.album == previous.album
            && self.playback_status == previous.playback_status
            && self.position_ms == previous.position_ms
            && self.duration_ms == previous.duration_ms
            && self.has_thumbnail == previous.has_thumbnail
    }

    /// Field order is stable and matches the documented schema in the README.
    pub fn to_json(&self) -> String {
        format!(
            concat!(
                "{{\"event\":\"snapshot\",",
                "\"sourceAppUserModelId\":\"{}\",",
                "\"title\":{},",
                "\"artist\":{},",
                "\"album\":{},",
                "\"playbackStatus\":\"{}\",",
                "\"positionMs\":{},",
                "\"durationMs\":{},",
                "\"hasThumbnail\":{},",
                "\"updatedAtMs\":{},",
                "\"lastUpdatedMs\":{}}}"
            ),
            escape_json(&self.source_app_user_model_id),
            json_optional_string(&self.title),
            json_optional_string(&self.artist),
            json_optional_string(&self.album),
            escape_json(&self.playback_status),
            json_optional_u64(self.position_ms),
            json_optional_u64(self.duration_ms),
            self.has_thumbnail,
            self.updated_at_ms,
            json_optional_u64(self.last_updated_ms),
        )
    }
}

impl Event {
    #[allow(dead_code)] // protocol self-description; consumed by tests and future callers
    pub fn kind(&self) -> &'static str {
        match self {
            Event::Ready { .. } => "ready",
            Event::Snapshot { .. } => "snapshot",
            Event::NoSession => "no-session",
            Event::Heartbeat => "heartbeat",
            Event::Stopped => "stopped",
            Event::Error { .. } => "error",
            Event::Response { .. } => "response",
        }
    }

    /// Single-line JSON object (no trailing newline).
    pub fn to_json(&self) -> String {
        match self {
            Event::Ready { session_count } => {
                format!("{{\"event\":\"ready\",\"sessionCount\":{session_count}}}")
            }
            Event::Snapshot { snapshot } => snapshot.to_json(),
            Event::NoSession => "{\"event\":\"no-session\"}".to_string(),
            Event::Heartbeat => "{\"event\":\"heartbeat\"}".to_string(),
            Event::Stopped => "{\"event\":\"stopped\"}".to_string(),
            Event::Error { message, kind } => match kind {
                Some(kind) => format!(
                    "{{\"event\":\"error\",\"message\":\"{}\",\"kind\":\"{}\"}}",
                    escape_json(message),
                    kind
                ),
                None => format!(
                    "{{\"event\":\"error\",\"message\":\"{}\"}}",
                    escape_json(message)
                ),
            },
            Event::Response { reply } => reply.to_json(),
        }
    }
}

/// Writes one event line to stdout (JSONL protocol) and flushes immediately — the main process
/// parses these incrementally, so buffering would stall its staleness check.
///
/// Phase 2 makes this callable from two threads at once (the poll loop and the stdin command
/// thread), so the write is serialized behind a process-wide lock. Without it a snapshot and a
/// command response could interleave mid-line and produce a line the consumer cannot parse —
/// which would look like a hung helper rather than a lost byte. The lock is also why the message
/// text of an error must never contain a raw newline: it is escaped by `escape_json`.
pub fn emit(event: &Event) {
    use std::io::Write;
    let mutex = stdout_mutex();
    // A panic in either thread must not poison the stream for the other one: the protocol only
    // needs mutual exclusion, not recovery, so a poisoned lock is still a usable lock.
    let _guard = match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let stdout = std::io::stdout();
    let mut handle = stdout.lock();
    let _ = writeln!(handle, "{}", event.to_json());
    let _ = handle.flush();
}

fn stdout_mutex() -> &'static Mutex<()> {
    static STDOUT_MUTEX: OnceLock<Mutex<()>> = OnceLock::new();
    STDOUT_MUTEX.get_or_init(|| Mutex::new(()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> SessionSnapshot {
        SessionSnapshot {
            source_app_user_model_id: "Chrome".to_string(),
            title: Some("MaringCode".to_string()),
            artist: Some("神楽 めあ — I'm Turning Into a Demon!".to_string()),
            album: None,
            playback_status: "Playing".to_string(),
            position_ms: Some(13000),
            duration_ms: Some(218000),
            has_thumbnail: true,
            updated_at_ms: 1789471213330,
            last_updated_ms: Some(1789471213000),
        }
    }

    #[test]
    fn snapshot_has_a_stable_key_set() {
        let json = snapshot().to_json();
        assert_eq!(
            json,
            concat!(
                "{\"event\":\"snapshot\",",
                "\"sourceAppUserModelId\":\"Chrome\",",
                "\"title\":\"MaringCode\",",
                "\"artist\":\"神楽 めあ — I'm Turning Into a Demon!\",",
                "\"album\":null,",
                "\"playbackStatus\":\"Playing\",",
                "\"positionMs\":13000,",
                "\"durationMs\":218000,",
                "\"hasThumbnail\":true,",
                "\"updatedAtMs\":1789471213330,",
                "\"lastUpdatedMs\":1789471213000}"
            )
        );
    }

    #[test]
    fn a_republished_stamp_alone_is_not_a_content_change() {
        // The OS re-stamps LastUpdatedTime several times per position step (~3.6 republishes per
        // second of position, measured). If it counted as content, the change gate would emit a
        // snapshot for every republish and the ~1 Hz stream would become a ~4 Hz one.
        let first = snapshot();
        let mut later = snapshot();
        later.last_updated_ms = Some(1789471213250);
        assert!(first.same_content_as(&later));

        // position_ms, by contrast, is exactly what the gate exists to catch.
        let mut moved = snapshot();
        moved.position_ms = Some(14000);
        assert!(!first.same_content_as(&moved));
    }

    #[test]
    fn an_unreadable_timeline_reports_an_absent_stamp() {
        let mut snapshot = snapshot();
        snapshot.last_updated_ms = None;
        assert!(snapshot.to_json().contains("\"lastUpdatedMs\":null"));
    }

    #[test]
    fn absent_and_empty_strings_both_serialize_as_null() {
        // Apple Music reports an empty AlbumTitle; "" and absent must not produce different keys.
        let mut absent = snapshot();
        absent.album = None;
        let mut empty = snapshot();
        empty.album = Some(String::new());
        let mut blank = snapshot();
        blank.album = Some("   ".to_string());
        assert_eq!(absent.to_json(), empty.to_json());
        assert_eq!(absent.to_json(), blank.to_json());
        assert!(absent.to_json().contains("\"album\":null"));
    }

    #[test]
    fn unknown_position_serializes_as_null_not_zero() {
        // A player that has loaded nothing reports no position; 0 would claim a real playback
        // position at the start of the track, which is a different statement.
        let mut snapshot = snapshot();
        snapshot.position_ms = None;
        snapshot.duration_ms = None;
        let json = snapshot.to_json();
        assert!(json.contains("\"positionMs\":null"));
        assert!(json.contains("\"durationMs\":null"));
    }

    #[test]
    fn scalar_events_snapshot() {
        assert_eq!(
            Event::Ready { session_count: 2 }.to_json(),
            "{\"event\":\"ready\",\"sessionCount\":2}"
        );
        assert_eq!(Event::NoSession.to_json(), "{\"event\":\"no-session\"}");
        assert_eq!(Event::Heartbeat.to_json(), "{\"event\":\"heartbeat\"}");
    }

    #[test]
    fn kinds_are_stable_protocol_names() {
        assert_eq!(Event::Ready { session_count: 0 }.kind(), "ready");
        assert_eq!(Event::Snapshot { snapshot: snapshot() }.kind(), "snapshot");
        assert_eq!(Event::NoSession.kind(), "no-session");
        assert_eq!(Event::Heartbeat.kind(), "heartbeat");
        assert_eq!(Event::Stopped.kind(), "stopped");
        assert_eq!(Event::Error { message: String::new(), kind: None }.kind(), "error");
        assert_eq!(Event::Stopped.to_json(), "{\"event\":\"stopped\"}");
    }

    #[test]
    fn updated_at_alone_is_not_a_content_change() {
        // The regression this guards: treating the capture timestamp as content makes every poll
        // emit a snapshot, so the consumer can never tell a real change from a liveness tick.
        let first = snapshot();
        let mut later = snapshot();
        later.updated_at_ms = first.updated_at_ms + 500;
        assert!(later.same_content_as(&first));
    }

    #[test]
    fn playback_position_and_status_are_content_changes() {
        let first = snapshot();

        let mut next_second = snapshot();
        next_second.position_ms = Some(14000);
        assert!(!next_second.same_content_as(&first));

        let mut paused = snapshot();
        paused.playback_status = "Paused".to_string();
        assert!(!paused.same_content_as(&first));

        let mut new_track = snapshot();
        new_track.title = Some("another song".to_string());
        assert!(!new_track.same_content_as(&first));

        let mut position_lost = snapshot();
        position_lost.position_ms = None;
        assert!(!position_lost.same_content_as(&first));
    }

    #[test]
    fn text_is_escaped() {
        let mut snapshot = snapshot();
        snapshot.title = Some("bad \"thing\"\nnext".to_string());
        snapshot.source_app_user_model_id = "quote\"and\\slash".to_string();
        let json = snapshot.to_json();
        assert!(json.contains("\"title\":\"bad \\\"thing\\\"\\nnext\""));
        assert!(json.contains("\"sourceAppUserModelId\":\"quote\\\"and\\\\slash\""));
    }

    #[test]
    fn error_kind_is_serialized_when_present() {
        let event = Event::Error {
            message: "session manager unavailable".to_string(),
            kind: Some(ERR_KIND_MANAGER_UNAVAILABLE),
        };
        assert_eq!(
            event.to_json(),
            "{\"event\":\"error\",\"message\":\"session manager unavailable\",\"kind\":\"manager-unavailable\"}"
        );
    }

    #[test]
    fn a_delivered_command_reports_its_target_and_no_error() {
        let reply = CommandReply::delivered("c1", "play", "Chrome", 123);
        assert_eq!(
            reply.to_json(),
            concat!(
                "{\"event\":\"response\",",
                "\"id\":\"c1\",",
                "\"command\":\"play\",",
                "\"ok\":true,",
                "\"targetAppUserModelId\":\"Chrome\",",
                "\"error\":null,",
                "\"errorKind\":null,",
                "\"completedAtMs\":123}"
            )
        );
    }

    #[test]
    fn a_missing_session_never_names_a_target() {
        // The safety-critical case: no matching session must report no target at all, so a
        // consumer can tell "nothing was controlled" from "something else was controlled".
        let reply = CommandReply::failed(
            "c2",
            "next",
            ERR_KIND_SESSION_NOT_FOUND,
            "no matching media session is visible",
            None,
            456,
        );
        assert!(!reply.ok);
        assert!(reply.target_app_user_model_id.is_none());
        let json = reply.to_json();
        assert!(json.contains("\"targetAppUserModelId\":null"));
        assert!(json.contains("\"errorKind\":\"session-not-found\""));
    }

    #[test]
    fn response_ids_are_escaped_like_every_other_string() {
        let reply = CommandReply::delivered("id\"with\\quote", "play", "aumid", 1);
        assert!(reply.to_json().contains("\"id\":\"id\\\"with\\\\quote\""));
    }

    #[test]
    fn response_kinds_are_stable_protocol_names() {
        assert_eq!(
            Event::Response { reply: CommandReply::delivered("c", "play", "a", 0) }.kind(),
            "response"
        );
    }
}
