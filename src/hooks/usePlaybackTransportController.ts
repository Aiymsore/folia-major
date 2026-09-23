import { useCallback } from 'react';
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';
import { PlayerState } from '../types';
import { setStatusMessage as setStatusMsg } from '../stores/useStatusMessageStore';
import { setPlayerState } from '../stores/usePlaybackStore';
import { useTranslation } from 'react-i18next';
import { usePlaybackStore } from '../stores/usePlaybackStore';
import { currentTime } from '../stores/motionSignals';
import { isExternalMediaPlaybackSong } from '../utils/appPlaybackGuards';
import { claimExternalMediaBackend, handleExternalMediaAction, resumeExternalMediaSong } from './useTransportDispatcher';

// src/hooks/usePlaybackTransportController.ts

type UsePlaybackTransportControllerParams = {
    stageActiveEntryKind: string | null;
    isNowPlayingStageActive: boolean;
    audioRef: RefObject<HTMLAudioElement | null>;
    audioContextRef: MutableRefObject<AudioContext | null>;
    stageLyricsClockRef: MutableRefObject<{
        startTimeSec: number;
        endTimeSec: number;
        baseTimeSec: number;
        startedAtMs: number | null;
    }>;
    setupAudioAnalyzer: () => void;
    syncOutputGain: (targetVolume: number, smoothing?: number) => void;
    getTargetPlaybackVolume: () => number;
    shouldRefreshCurrentOnlineAudioSource: () => boolean;
    recoverOnlinePlaybackSource: (options: {
        failedSrc?: string | null;
        resumeAt?: number;
        autoplay: boolean;
    }) => Promise<boolean>;
    getSyntheticStageLyricsTime: () => number;
    syncStageLyricsClock: (timeSec: number, endTimeSec: number, nextPlayerState: PlayerState, startTimeSec?: number) => void;
    /**
     * Handles a pause that lands during an automix blend, returning true when it did.
     *
     * Mid-blend `audioRef` names the deck the next track is ARRIVING on, so the pause below would
     * stop a deck the listener cannot hear and leave the one they can hear playing on into the
     * next song - "I pressed pause and it jumped to the next track". This cancels the blend back
     * onto the deck still sounding the displayed track and pauses that, the same cancel a mid-blend
     * seek uses. Returns false (and the ordinary pause runs) when no blend is in flight.
     */
    pauseDuringTransition?: () => boolean;
};

// Owns play and pause transport behavior across main playback and Stage lyric-only playback.
export function usePlaybackTransportController({
    stageActiveEntryKind,
    isNowPlayingStageActive,
    audioRef,
    audioContextRef,
    stageLyricsClockRef,
    setupAudioAnalyzer,
    syncOutputGain,
    getTargetPlaybackVolume,
    shouldRefreshCurrentOnlineAudioSource,
    recoverOnlinePlaybackSource,
    getSyntheticStageLyricsTime,
    syncStageLyricsClock,
    pauseDuringTransition,
}: UsePlaybackTransportControllerParams) {
    // Read here rather than passed in: store fields, a module-level motion signal, or i18n.
    const { t } = useTranslation();
    const activePlaybackContext = usePlaybackStore(state => state.activePlaybackContext);
    const audioSrc = usePlaybackStore(state => state.audioSrc);
    const duration = usePlaybackStore(state => state.duration);
    // Read for the external-media branch below: pressing play on one of those tracks must not reach
    // the Folia deck, which has no source for it at all.
    const currentSong = usePlaybackStore(state => state.currentSong);

    const resumePlayback = useCallback(async () => {
        // Phase 3A: an Apple Music backend owns the transport. `handleExternalMediaAction` returns true
        // when it has taken the call — either the command was sent, or this backend is active and
        // the command was deliberately dropped. Either way the Folia body below must not run: it
        // would start this element for a button the user aimed at Apple Music.
        if (handleExternalMediaAction('play')) return;

        // The track ON SCREEN is an Apple Music one while the Folia backend still owns the transport:
        // a restored session, or a provider switch after one was loaded. There is no source for it in
        // this app, so the deck path below can only fail with an AbortError on an empty element. Hand
        // it back to the external player instead, which is what "play" means for that track.
        if (isExternalMediaPlaybackSong(currentSong)) {
            const resumed = await resumeExternalMediaSong(currentSong);
            if (!resumed) {
                // Nothing is shown on success: the external player's own state push is what updates
                // the transport, and a toast would be a second, later claim about the same fact.
                setStatusMsg({ type: 'error', text: t('appleMusic.playRequestFailed') });
            }
            return;
        }

        if (isNowPlayingStageActive) {
            return;
        }

        if (activePlaybackContext === 'stage' && stageActiveEntryKind === 'lyrics' && !audioSrc) {
            const currentSyntheticTime = getSyntheticStageLyricsTime();
            syncStageLyricsClock(currentSyntheticTime, duration, PlayerState.PLAYING, stageLyricsClockRef.current.startTimeSec);
            currentTime.set(currentSyntheticTime);
            setPlayerState(PlayerState.PLAYING);
            return;
        }

        if (!audioRef.current) {
            return;
        }

        setupAudioAnalyzer();
        if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
            await audioContextRef.current.resume();
        }

        syncOutputGain(getTargetPlaybackVolume(), 0);
        if (shouldRefreshCurrentOnlineAudioSource()) {
            const refreshed = await recoverOnlinePlaybackSource({
                failedSrc: audioRef.current.currentSrc || audioSrc,
                resumeAt: audioRef.current.currentTime,
                autoplay: true,
            });

            if (refreshed) {
                return;
            }
        }

        try {
            await audioRef.current.play();
            setPlayerState(PlayerState.PLAYING);
        } catch (error) {
            const recovered = await recoverOnlinePlaybackSource({
                failedSrc: audioRef.current.currentSrc || audioSrc,
                resumeAt: audioRef.current.currentTime,
                autoplay: true,
            });

            if (recovered) {
                return;
            }

            if (!audioRef.current.paused && !audioRef.current.ended) {
                setPlayerState(PlayerState.PLAYING);
                return;
            }

            if (error instanceof DOMException && error.name === 'NotAllowedError') {
                setStatusMsg({ type: 'info', text: t('status.clickToPlay') });
                setPlayerState(PlayerState.PAUSED);
                return;
            }

            setStatusMsg({ type: 'error', text: t('status.playbackError') });
            setPlayerState(PlayerState.PAUSED);
            throw error;
        }
    }, [activePlaybackContext, audioContextRef, audioRef, audioSrc, currentSong, currentTime, duration, getSyntheticStageLyricsTime, getTargetPlaybackVolume, isNowPlayingStageActive, recoverOnlinePlaybackSource, setPlayerState, setStatusMsg, setupAudioAnalyzer, shouldRefreshCurrentOnlineAudioSource, stageActiveEntryKind, stageLyricsClockRef, syncOutputGain, syncStageLyricsClock, t]);

    const pausePlayback = useCallback(() => {
        // Same contract as resumePlayback above: an Apple Music backend takes the pause, and the
        // Folia deck is left untouched.
        if (handleExternalMediaAction('pause')) return;

        // An Apple Music track with the Folia backend active (see resumePlayback): the deck is not
        // what is sounding, so pausing it would be a no-op that leaves the web player playing.
        if (isExternalMediaPlaybackSong(currentSong)) {
            claimExternalMediaBackend();
            handleExternalMediaAction('pause');
            return;
        }

        if (isNowPlayingStageActive) {
            return;
        }

        if (activePlaybackContext === 'stage' && stageActiveEntryKind === 'lyrics' && !audioSrc) {
            const currentSyntheticTime = getSyntheticStageLyricsTime();
            syncStageLyricsClock(currentSyntheticTime, duration, PlayerState.PAUSED, stageLyricsClockRef.current.startTimeSec);
            currentTime.set(currentSyntheticTime);
            setPlayerState(PlayerState.PAUSED);
            return;
        }

        // Before the element is touched, because mid-blend `audioRef` is the wrong element to touch:
        // it names the deck the next track is arriving on. The cancel pauses the deck that is
        // actually sounding, so there is nothing left here but to settle the transport.
        if (pauseDuringTransition?.()) {
            syncOutputGain(getTargetPlaybackVolume(), 0);
            setPlayerState(PlayerState.PAUSED);
            return;
        }

        if (!audioRef.current) {
            return;
        }

        audioRef.current.pause();
        syncOutputGain(getTargetPlaybackVolume(), 0);
        setPlayerState(PlayerState.PAUSED);
    }, [activePlaybackContext, audioRef, audioSrc, currentSong, currentTime, duration, getSyntheticStageLyricsTime, getTargetPlaybackVolume, isNowPlayingStageActive, pauseDuringTransition, setPlayerState, stageActiveEntryKind, stageLyricsClockRef, syncOutputGain, syncStageLyricsClock]);

    return {
        resumePlayback,
        pausePlayback,
    };
}
