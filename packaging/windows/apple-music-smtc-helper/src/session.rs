// packaging/windows/apple-music-smtc-helper/src/session.rs
// Windows-only: reads the Apple Music session out of the System Media Transport Controls (SMTC)
// surface and converts it into the platform-independent SessionSnapshot from events.rs. Phase 2
// adds the reverse direction: `SessionTransport` addresses the same session and drives it with the
// Try* API.
//
// API notes that are load-bearing and were verified against Apple Music on Windows 11 26200:
//   * `GlobalSystemMediaTransportControlsSessionManager::RequestAsync` is the entry point; the
//     manager must be obtained on a thread that has initialized the Windows Runtime.
//   * A session's own AUMID (`SourceAppUserModelId`) is the only stable identity. The Microsoft
//     Store Apple Music package reports `AppleInc.AppleMusicWin_nzyj5cx40ttqa!App`.
//   * Apple Music quantizes `Position` to whole seconds and reports an empty `AlbumTitle`, so both
//     are treated as possibly-absent rather than as fixed-width fields.
//   * `TryGetMediaPropertiesAsync` is the only source of title/artist/album; the synchronous
//     `GetPlaybackInfo` / `GetTimelineProperties` cover status and time. Each is read
//     independently so one failing property cannot blank the whole snapshot.
//   * Apple Music answers Try* commands while it is NOT the current media session
//     (`TryTogglePlayPauseAsync` and `TrySkipNextAsync` both returned true and were observed to take
//     effect). Command targeting therefore matches on AUMID and never consults `GetCurrentSession`.

use crate::commands::{ms_to_ticks, Command, CommandOutcome, Transport};
use crate::events::SessionSnapshot;
use crate::watcher::PollOutcome;
use windows::Foundation::TimeSpan;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession,
    GlobalSystemMediaTransportControlsSessionManager as SessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
};

/// Keeps the process in the multi-threaded apartment for its whole lifetime. WinRT requires an
/// initialized apartment; the MTA is the right one for a background polling thread with no UI.
pub fn init_apartment() -> Result<(), String> {
    // The returned cookie is intentionally leaked: the MTA stays alive until process exit, and
    // dropping the guard early would tear the apartment down while the watch loop still runs.
    let _cookie = unsafe {
        windows::Win32::System::Com::CoIncrementMTAUsage()
            .map_err(|error| format!("CoIncrementMTAUsage failed: {error}"))?
    };
    Ok(())
}

/// Unix epoch milliseconds, which is the unit the Folia renderer already uses for timestamps.
pub fn now_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

fn time_span_to_ms(value: TimeSpan) -> i64 {
    value.Duration / 10_000
}

// WinRT property getters are fallible: every accessor in this file returns
// Result<T, windows_core::Error> rather than a bare value. These two adapters collapse that into
// the Option the snapshot wants, so a single unreadable property degrades one field instead of
// failing the whole read.
fn time_span_ms(value: Result<TimeSpan, windows::core::Error>) -> Option<i64> {
    value.ok().map(time_span_to_ms)
}

fn non_negative_u64(value: Option<i64>) -> Option<u64> {
    value.and_then(|ms| if ms > 0 { Some(ms as u64) } else { None })
}

/// `GlobalSystemMediaTransportControlsSessionPlaybackStatus` is a Windows Runtime enum, so it can
/// legally gain members. Matching explicitly and reporting the numeric value for anything unknown
/// keeps the protocol honest instead of silently reporting a wrong state name.
fn playback_status_name(status: PlaybackStatus) -> String {
    match status {
        PlaybackStatus::Closed => "Closed",
        PlaybackStatus::Opened => "Opened",
        PlaybackStatus::Changing => "Changing",
        PlaybackStatus::Stopped => "Stopped",
        PlaybackStatus::Playing => "Playing",
        PlaybackStatus::Paused => "Paused",
        other => return format!("Unknown({})", other.0),
    }
    .to_string()
}

/// An unreadable playback status is reported as Unknown rather than guessed at.
fn playback_status_label(status: Result<PlaybackStatus, windows::core::Error>) -> String {
    match status {
        Ok(status) => playback_status_name(status),
        Err(_) => "Unknown".to_string(),
    }
}

/// Normalizes an optional WinRT string. Empty and whitespace-only collapse to None, because Apple
/// Music reports an empty AlbumTitle and a consumer cannot act on the difference.
fn optional_text(value: windows::core::HSTRING) -> Option<String> {
    let text = value.to_string_lossy();
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Case-insensitive substring match against the AUMID.
fn matches_session(source_app_user_model_id: &str, needle: &str) -> bool {
    source_app_user_model_id
        .to_ascii_lowercase()
        .contains(&needle.to_ascii_lowercase())
}

/// Reads every visible session's AUMID. Kept separate from `read` so the diagnostic path can list
/// what the OS is actually offering when the configured match finds nothing.
pub fn session_ids(manager: &SessionManager) -> Result<Vec<String>, String> {
    let sessions = manager
        .GetSessions()
        .map_err(|error| format!("GetSessions failed: {error}"))?;

    let mut ids = Vec::with_capacity(sessions.Size().unwrap_or(0) as usize);
    for session in &sessions {
        if let Ok(id) = session.SourceAppUserModelId() {
            ids.push(id.to_string_lossy());
        }
    }
    Ok(ids)
}

/// Obtains the session manager. Held for the whole watch loop rather than re-requested per poll:
/// the request is the expensive part, and a transient failure between polls would otherwise be
/// indistinguishable from Apple Music having gone away.
pub fn open_manager() -> Result<SessionManager, String> {
    SessionManager::RequestAsync()
        .and_then(|operation| operation.join())
        .map_err(|error| format!("session manager request failed: {error}"))
}

/// One poll: the matching session's snapshot, or NoSession when Apple Music is not visible.
///
/// The manager is re-requested on every poll rather than held for the process lifetime. Holding it
/// looked cheaper, but a session object obtained once keeps answering with the values it had when
/// it was first read: the timeline froze at whatever position was current on the first poll, so the
/// change-gate suppressed every later snapshot while playback advanced. Re-requesting the manager is
/// what the verified PowerShell probe did, and it is the only form observed to return live values.
pub fn read(match_substring: &str) -> Result<PollOutcome, String> {
    let manager = open_manager()?;
    Ok(match find_session(&manager, match_substring)? {
        Some((session, source_id)) => PollOutcome::Snapshot(snapshot_for(&session, &source_id)),
        None => PollOutcome::NoSession,
    })
}

/// Finds the Apple Music session among the manager's visible sessions.
///
/// This is the only targeting rule in the crate, shared by reads and commands, so the two can never
/// disagree about which session is Apple Music. `GetCurrentSession` is deliberately never consulted:
/// Apple Music answers Try* calls while other players hold the current-session slot, and using the
/// current session would silently redirect a command to whatever the user last touched.
pub fn find_session(
    manager: &SessionManager,
    match_substring: &str,
) -> Result<Option<(GlobalSystemMediaTransportControlsSession, String)>, String> {
    let sessions = manager
        .GetSessions()
        .map_err(|error| format!("GetSessions failed: {error}"))?;

    for session in &sessions {
        let Ok(source_id) = session.SourceAppUserModelId() else {
            continue;
        };
        let source_id = source_id.to_string_lossy();
        if matches_session(&source_id, match_substring) {
            return Ok(Some((session, source_id)));
        }
    }

    Ok(None)
}

fn snapshot_for(
    session: &GlobalSystemMediaTransportControlsSession,
    source_app_user_model_id: &str,
) -> SessionSnapshot {
    let playback_status = session
        .GetPlaybackInfo()
        .map(|info| playback_status_label(info.PlaybackStatus()))
        .unwrap_or_else(|_| "Unknown".to_string());

    let (position_ms, duration_ms) = match session.GetTimelineProperties() {
        Ok(timeline) => {
            let end = time_span_ms(timeline.EndTime());
            let start = time_span_ms(timeline.StartTime()).unwrap_or(0);
            (
                non_negative_u64(time_span_ms(timeline.Position())),
                // EndTime is the track length in practice, but subtract StartTime so a player that
                // reports a non-zero origin cannot produce a duration shorter than the position.
                non_negative_u64(end.map(|end| end - start)),
            )
        }
        Err(_) => (None, None),
    };

    let (title, artist, album, has_thumbnail) = match session
        .TryGetMediaPropertiesAsync()
        .and_then(|operation| operation.join())
    {
        Ok(properties) => (
            optional_text(properties.Title().unwrap_or_default()),
            optional_text(properties.Artist().unwrap_or_default()),
            optional_text(properties.AlbumTitle().unwrap_or_default()),
            properties.Thumbnail().is_ok(),
        ),
        // Metadata is a separate call from status/timeline, so losing it degrades the snapshot
        // rather than discarding the transport state that was read successfully.
        Err(_) => (None, None, None, false),
    };

    SessionSnapshot {
        source_app_user_model_id: source_app_user_model_id.to_string(),
        title,
        artist,
        album,
        playback_status,
        position_ms,
        duration_ms,
        has_thumbnail,
        updated_at_ms: now_epoch_ms(),
    }
}

/// Resolves the Apple Music session once and drives it with the Try* API.
///
/// Resolution happens in `open`, not per command: a transport that silently re-resolved on every
/// dispatch could answer a later command against a different session than the one the caller was
/// told about. The session object is kept in the MTAs initialized by main, so it stays usable for
/// the whole (short) command process.
pub struct SessionTransport {
    session: GlobalSystemMediaTransportControlsSession,
    source_app_user_model_id: String,
}

impl SessionTransport {
    /// Binds to the Apple Music session, or explains that there is none. A missing Apple Music
    /// session is an error, never a fallback: the caller must be able to prove that a command did
    /// not land on another player.
    pub fn open(match_substring: &str) -> Result<Self, String> {
        let manager = open_manager()?;
        match find_session(&manager, match_substring)? {
            Some((session, source_app_user_model_id)) => Ok(Self {
                session,
                source_app_user_model_id,
            }),
            None => Err(format!(
                "no session matching '{match_substring}' is visible in SMTC (is Apple Music running?)"
            )),
        }
    }

    /// Calls one Try* method and maps its three possible shapes onto `CommandOutcome`:
    /// an error from the call itself, a resolved `false` (the session declined), or a resolved
    /// `true` (delivered).
    ///
    /// The WinRT call and its `.join()` both happen inside `invoke`, which is why this does not name
    /// the `IAsyncOperation` type: that type lives in the `windows-future` crate, and reaching into
    /// a transitive dependency to spell it out would be a build break waiting for a version bump.
    /// Both closures therefore return a plain `Result<bool>`.
    ///
    /// `TryChangePlaybackPositionAsync` resolves to a plain bool rather than an error code, so a
    /// seek past the end of a track comes back as `false` — reported as declined, not as a crash.
    fn call(
        &self,
        label: &str,
        invoke: impl FnOnce(&GlobalSystemMediaTransportControlsSession) -> windows::core::Result<bool>,
    ) -> CommandOutcome {
        match invoke(&self.session) {
            Ok(true) => CommandOutcome::Delivered,
            Ok(false) => CommandOutcome::Declined,
            Err(error) => CommandOutcome::Failed(format!("{label} failed: {error}")),
        }
    }
}

impl Transport for SessionTransport {
    fn dispatch(&self, command: Command) -> Result<CommandOutcome, String> {
        // Every arm states the exact WinRT call it makes so the mapping is auditable at a glance.
        // `Try*` is used throughout: the non-Try variants throw, and a helper that crashes on a
        // declined command would take the whole bridge down with it.
        let outcome = match command {
            Command::Play => self.call("TryPlayAsync", |session| session.TryPlayAsync()?.join()),
            Command::Pause => self.call("TryPauseAsync", |session| session.TryPauseAsync()?.join()),
            Command::TogglePlayPause => {
                self.call("TryTogglePlayPauseAsync", |session| session.TryTogglePlayPauseAsync()?.join())
            }
            Command::Previous => {
                self.call("TrySkipPreviousAsync", |session| session.TrySkipPreviousAsync()?.join())
            }
            Command::Next => self.call("TrySkipNextAsync", |session| session.TrySkipNextAsync()?.join()),
            Command::Seek { position_ms } => self.call("TryChangePlaybackPositionAsync", |session| {
                session.TryChangePlaybackPositionAsync(ms_to_ticks(position_ms))?.join()
            }),
        };
        Ok(outcome)
    }

    fn target_app_user_model_id(&self) -> &str {
        &self.source_app_user_model_id
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matching_is_case_insensitive_and_substring_based() {
        let aumid = "AppleInc.AppleMusicWin_nzyj5cx40ttqa!App";
        assert!(matches_session(aumid, "AppleMusicWin"));
        assert!(matches_session(aumid, "applemusicwin"));
        assert!(matches_session(aumid, "AppleInc.AppleMusicWin"));
        assert!(!matches_session(aumid, "Microsoft.ZuneMusic"));
    }

    #[test]
    fn unknown_playback_status_reports_its_numeric_value() {
        // A value Microsoft adds later must not be reported under an existing name.
        let unknown = playback_status_name(PlaybackStatus(99));
        assert_eq!(unknown, "Unknown(99)");
    }

    #[test]
    fn time_span_converts_ticks_to_milliseconds() {
        // 100-nanosecond ticks: one second is 10_000_000.
        assert_eq!(time_span_to_ms(TimeSpan { Duration: 10_000_000 }), 1000);
        assert_eq!(time_span_to_ms(TimeSpan { Duration: 2_180_000_000 }), 218_000);
        assert_eq!(time_span_to_ms(TimeSpan { Duration: 0 }), 0);
    }
}