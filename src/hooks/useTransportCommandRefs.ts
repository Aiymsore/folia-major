import { useEffect, useMemo, useRef } from 'react';
import { selectDisplayPlayerState, usePlaybackStore } from '../stores/usePlaybackStore';
import { handleExternalMediaAction } from './useTransportDispatcher';

// src/hooks/useTransportCommandRefs.ts
//
// Latest-value handles for the surfaces that live outside React: the OS media session, the Windows
// taskbar thumbbar, the remote control and Discord presence. They are registered once with the main
// process and then fire whenever the user presses something there, so they cannot close over a
// render's values - they read through these.
//
// Phase 3A: this hook is also the single place where the **external** drivers' transport commands
// become backend-aware. Every ref below is wrapped so an Apple Music backend takes the command
// before the Folia handler runs; the four drivers (media session action handlers, the taskbar
// thumbbar, the remote control window, the Stage external controller) therefore need no Apple Music
// branch of their own.
//
// The wrap lives inside the hook rather than at its call site on purpose: assigning it here keeps
// `resumePlayback` / `pausePlayback` / `handlePrevTrack` / `handleNextTrack` as the effect
// dependencies, so an unstable caller cannot leave a stale closure in a ref the main process owns.

// Kept as the consumers' exact signatures rather than a widened union: the bridges' ref types are
// what they are, and widening here would only move the mismatch to their call sites.
type TransportCommandRefsParams = {
    resumePlayback: () => Promise<void>;
    pausePlayback: () => void;
    handlePrevTrack: () => void;
    handleNextTrack: (options?: never) => Promise<void>;
};

export const useTransportCommandRefs = ({
    resumePlayback,
    pausePlayback,
    handlePrevTrack,
    handleNextTrack,
}: TransportCommandRefsParams) => {
    const currentSong = usePlaybackStore(state => state.currentSong);
    // The transport the picture belongs to, not the raw one: every consumer of this ref asks "is
    // the listener hearing music right now" - the taskbar buttons, the remote's play/pause toggle,
    // the voice-input auto-pause. During a blend's lead the raw state is IDLE while the outgoing
    // deck plays on, and all three then offered play on a track that was already playing: pressing
    // it started the arriving deck early and took the blend with it.
    const displayPlayerState = usePlaybackStore(selectDisplayPlayerState);

    const mediaSessionPlayRef = useRef(resumePlayback);
    const mediaSessionPauseRef = useRef(pausePlayback);
    const mediaSessionPrevRef = useRef(handlePrevTrack);
    const mediaSessionNextRef = useRef(handleNextTrack);
    const taskbarHasTrackRef = useRef(Boolean(currentSong));
    const taskbarPlayerStateRef = useRef(displayPlayerState);

    useEffect(() => {
        mediaSessionPlayRef.current = () => {
            // Taken by Apple Music (sent, or deliberately dropped): the Folia handler must not run.
            if (handleExternalMediaAction('play')) return Promise.resolve();
            return resumePlayback();
        };
    }, [resumePlayback]);

    useEffect(() => {
        mediaSessionPauseRef.current = () => {
            if (handleExternalMediaAction('pause')) return;
            pausePlayback();
        };
    }, [pausePlayback]);

    useEffect(() => {
        mediaSessionPrevRef.current = () => {
            // Deliberately NOT forwarded to the external player: "previous" means Folia's queue
            // steps back, and the queue layer turns that into a playById of the previous track.
            // Forwarding it would make Apple Music play its own internal queue instead.
            handlePrevTrack();
        };
    }, [handlePrevTrack]);

    useEffect(() => {
        mediaSessionNextRef.current = (options?: never) => (
            // Same as prev: Folia owns the queue, so "next" is resolved here rather than handed to
            // the external player. See docs/external-media-backend.md, "命令面：绝不透传 next / previous".
            handleNextTrack(options)
        );
    }, [handleNextTrack]);

    useEffect(() => {
        taskbarHasTrackRef.current = Boolean(currentSong);
    }, [currentSong]);

    useEffect(() => {
        taskbarPlayerStateRef.current = displayPlayerState;
    }, [displayPlayerState]);

    // Refs are stable, so the container is built once.
    return useMemo(() => ({
        mediaSessionPlayRef,
        mediaSessionPauseRef,
        mediaSessionPrevRef,
        mediaSessionNextRef,
        taskbarHasTrackRef,
        taskbarPlayerStateRef,
    }), []);
};
