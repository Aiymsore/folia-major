// packaging/windows/apple-music-smtc-helper/src/watcher.rs
// The watch loop's decision logic, with the WinRT read injected. Keeping this free of WinRT is
// what makes the change-gating and heartbeat rules testable on any host OS, in the same spirit as
// cli.rs and events.rs. main.rs hands it a closure that performs the real SMTC read.
//
// Why the loop is not "emit every poll": the consumer needs to tell three states apart —
// a change it should react to, no change, and a helper that is alive but silent. Emitting the raw
// poll stream answers none of them, and emitting on every poll would also flood the IPC boundary
// with identical snapshots several times a second.

use crate::events::{Event, SessionSnapshot};

/// What one poll of the platform returned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PollOutcome {
    /// An Apple Music session exists and was read.
    Snapshot(SessionSnapshot),
    /// No Apple Music session is currently visible.
    NoSession,
}

pub struct WatchState {
    heartbeat_ms: u64,
    last_snapshot: Option<SessionSnapshot>,
    /// Whether the previous poll saw a session, so leaving that state emits exactly one NoSession.
    saw_session: bool,
    last_emitted_at_ms: u64,
}

impl WatchState {
    pub fn new(heartbeat_ms: u64) -> Self {
        Self {
            heartbeat_ms,
            last_snapshot: None,
            saw_session: false,
            last_emitted_at_ms: 0,
        }
    }

    /// Decides what (if anything) to emit for one poll taken at `now_ms`.
    ///
    /// Emits a snapshot when the session content changed, a single `NoSession` when the session
    /// disappeared, and a `Heartbeat` once per heartbeat window if nothing else has been emitted.
    pub fn on_poll(&mut self, outcome: PollOutcome, now_ms: u64) -> Option<Event> {
        let event = match outcome {
            PollOutcome::Snapshot(snapshot) => {
                let unchanged = self
                    .last_snapshot
                    .as_ref()
                    .is_some_and(|previous| snapshot.same_content_as(previous));
                // `saw_session` is checked as well: the first snapshot after a NoSession must be
                // emitted even if it happens to equal the last one seen before the gap.
                if unchanged && self.saw_session {
                    None
                } else {
                    self.last_snapshot = Some(snapshot.clone());
                    Some(Event::Snapshot { snapshot })
                }
            }
            PollOutcome::NoSession => {
                // Drop the cached snapshot: it describes a track that is no longer loaded, and
                // keeping it would suppress the first snapshot after the session returns.
                self.last_snapshot = None;
                if self.saw_session {
                    self.saw_session = false;
                    Some(Event::NoSession)
                } else {
                    None
                }
            }
        };

        if let Some(event) = event {
            self.saw_session = matches!(event, Event::Snapshot { .. });
            self.last_emitted_at_ms = now_ms;
            return Some(event);
        }

        // Nothing changed. A NoSession is only ever emitted once per disappearance, so the
        // heartbeat is also what keeps the consumer's "connected but idle" view fresh while Apple
        // Music stays closed.
        if now_ms.saturating_sub(self.last_emitted_at_ms) >= self.heartbeat_ms {
            self.last_emitted_at_ms = now_ms;
            return Some(Event::Heartbeat);
        }

        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(title: &str, position_ms: u64) -> SessionSnapshot {
        SessionSnapshot {
            source_app_user_model_id: "AppleInc.AppleMusicWin_nzyj5cx40ttqa!App".to_string(),
            title: Some(title.to_string()),
            artist: Some("artist".to_string()),
            album: None,
            playback_status: "Playing".to_string(),
            position_ms: Some(position_ms),
            duration_ms: Some(218000),
            has_thumbnail: true,
            updated_at_ms: 0,
        }
    }

    const HEARTBEAT: u64 = 3000;

    #[test]
    fn first_snapshot_is_emitted() {
        let mut state = WatchState::new(HEARTBEAT);
        let event = state.on_poll(PollOutcome::Snapshot(snapshot("a", 1000)), 100);
        assert!(matches!(event, Some(Event::Snapshot { .. })));
    }

    #[test]
    fn identical_polls_are_suppressed_until_the_heartbeat() {
        let mut state = WatchState::new(HEARTBEAT);
        let first = PollOutcome::Snapshot(snapshot("a", 1000));
        assert!(state.on_poll(first.clone(), 0).is_some());
        assert!(state.on_poll(first.clone(), 500).is_none());
        assert!(state.on_poll(first.clone(), 1000).is_none());
        // At the heartbeat boundary the silence is broken by exactly one heartbeat...
        assert_eq!(state.on_poll(first.clone(), HEARTBEAT), Some(Event::Heartbeat));
        // ...and then the stream goes quiet again.
        assert!(state.on_poll(first, HEARTBEAT + 100).is_none());
    }

    #[test]
    fn content_change_is_emitted_immediately() {
        let mut state = WatchState::new(HEARTBEAT);
        assert!(state.on_poll(PollOutcome::Snapshot(snapshot("a", 1000)), 0).is_some());
        let grew = state.on_poll(PollOutcome::Snapshot(snapshot("a", 2000)), 500);
        assert!(matches!(grew, Some(Event::Snapshot { .. })));
    }

    #[test]
    fn a_later_capture_timestamp_is_not_a_content_change() {
        let mut state = WatchState::new(HEARTBEAT);
        let mut first = snapshot("a", 1000);
        first.updated_at_ms = 111;
        assert!(state.on_poll(PollOutcome::Snapshot(first), 0).is_some());

        let mut later = snapshot("a", 1000);
        later.updated_at_ms = 222;
        assert!(state.on_poll(PollOutcome::Snapshot(later), 400).is_none());
    }

    #[test]
    fn losing_the_session_emits_no_session_exactly_once() {
        let mut state = WatchState::new(HEARTBEAT);
        assert!(state.on_poll(PollOutcome::Snapshot(snapshot("a", 1000)), 0).is_some());
        assert_eq!(state.on_poll(PollOutcome::NoSession, 500), Some(Event::NoSession));
        // Still gone: silence until the heartbeat, not a second no-session.
        assert!(state.on_poll(PollOutcome::NoSession, 800).is_none());
        assert_eq!(state.on_poll(PollOutcome::NoSession, 3500), Some(Event::Heartbeat));
    }

    #[test]
    fn no_session_before_any_session_is_silent() {
        // Apple Music not running at startup is the common case; it must not emit a no-session
        // the consumer never asked about, and no snapshot is synthesised for it either.
        let mut state = WatchState::new(HEARTBEAT);
        assert!(state.on_poll(PollOutcome::NoSession, 0).is_none());
        assert!(state.on_poll(PollOutcome::NoSession, 100).is_none());
        assert_eq!(state.on_poll(PollOutcome::NoSession, HEARTBEAT), Some(Event::Heartbeat));
    }

    #[test]
    fn session_returning_after_a_gap_is_re_emitted_even_if_unchanged() {
        // The track can be the same one as before the gap (paused, app closed, reopened). The
        // consumer cleared its state on NoSession, so it must be told again.
        let mut state = WatchState::new(HEARTBEAT);
        assert!(state.on_poll(PollOutcome::Snapshot(snapshot("a", 1000)), 0).is_some());
        assert_eq!(state.on_poll(PollOutcome::NoSession, 500), Some(Event::NoSession));
        let returned = state.on_poll(PollOutcome::Snapshot(snapshot("a", 1000)), 1000);
        assert!(matches!(returned, Some(Event::Snapshot { .. })));
    }
}
