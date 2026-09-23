import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';
import { applyOnlineAudioSourceMetadata, loadOnlineSongAudioSource } from '../../../services/onlinePlayback';
import type { SongResult } from '../../../types';
import type { AudioQualityPreference } from '../../../types/onlineMusic';
import {
    getPlaybackSongKey,
    isExternalMediaPlaybackSong,
    isLocalPlaybackSong,
    isNavidromePlaybackSong,
    isSamePlaybackSong,
    isStagePlaybackSong,
    replacePlaybackSongInQueue,
} from '../../../utils/appPlaybackGuards';
import { setAudioSrc, setCurrentSong, setPlayQueue } from '../../../stores/usePlaybackStore';

// src/components/app/playback/createOnlineRecoveryController.ts

type RecoveryControllerParams = {
    audioQuality: AudioQualityPreference;
    currentSong: SongResult | null;
    audioSrc: string | null;
    audioRef: RefObject<HTMLAudioElement | null>;
    currentSongRef: MutableRefObject<string | number | null>;
    blobUrlRef: MutableRefObject<string | null>;
    shouldAutoPlayRef: MutableRefObject<boolean>;
    pendingResumeTimeRef: MutableRefObject<number | null>;
    onlinePlaybackRecoveryRef: MutableRefObject<Promise<boolean> | null>;
    lastAudioRecoverySourceRef: MutableRefObject<string | null>;
    currentOnlineAudioUrlFetchedAtRef: MutableRefObject<number | null>;
    persistLastPlaybackCache: (song: SongResult | null, queue: SongResult[]) => Promise<void>;
    playQueue: SongResult[];
    onlineAudioUrlTtlMs: number;
    onlineAudioUrlRefreshBufferMs: number;
};

// Provider stream URLs carry a per-request token in the query (QQ mints a fresh `vkey`/`guid`
// every call), so comparing whole URLs never matches and the error -> refresh -> error cycle
// runs unbounded. The origin+path identifies the media file itself, which is what "we already
// refreshed this and it still failed" actually means. Cleared again once playback succeeds.
export const getOnlineRecoveryKey = (src: string | null | undefined): string | null => {
    if (!src) {
        return null;
    }

    try {
        const parsedUrl = new URL(src);
        // Only remote streams carry a token in the query; blob: and friends have no meaningful origin.
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
            return src;
        }
        return `${parsedUrl.origin}${parsedUrl.pathname}`;
    } catch {
        return src;
    }
};

// Creates online-stream refresh and recovery helpers without tying them to a React hook.
export const createOnlineRecoveryController = ({
    audioQuality,
    currentSong,
    audioSrc,
    audioRef,
    currentSongRef,
    blobUrlRef,
    shouldAutoPlayRef,
    pendingResumeTimeRef,
    onlinePlaybackRecoveryRef,
    lastAudioRecoverySourceRef,
    currentOnlineAudioUrlFetchedAtRef,
    persistLastPlaybackCache,
    playQueue,
    onlineAudioUrlTtlMs,
    onlineAudioUrlRefreshBufferMs,
}: RecoveryControllerParams) => {
    const shouldRefreshCurrentOnlineAudioSource = () => {
        // External media is excluded for the same reason local, Navidrome and Stage are: there is no
        // Omni provider behind these tracks, so every "refresh" would ask a provider that does not
        // own the song and raise `Song is not owned by an online provider`. The failure is not a
        // stale URL - there is no URL at all; the external player owns the bytes.
        if (!currentSong || isLocalPlaybackSong(currentSong) || isNavidromePlaybackSong(currentSong) || isStagePlaybackSong(currentSong) || isExternalMediaPlaybackSong(currentSong)) {
            return false;
        }

        if (!audioSrc || audioSrc.startsWith('blob:')) {
            return false;
        }

        const fetchedAt = currentOnlineAudioUrlFetchedAtRef.current;
        if (!fetchedAt) {
            return false;
        }

        return Date.now() - fetchedAt >= onlineAudioUrlTtlMs - onlineAudioUrlRefreshBufferMs;
    };

    const recoverOnlinePlaybackSource = async ({
        failedSrc,
        resumeAt,
        autoplay,
    }: {
        failedSrc?: string | null;
        resumeAt?: number;
        autoplay: boolean;
    }): Promise<boolean> => {
        const song = currentSong;
        const audioElement = audioRef.current;

        // The external-media guard here is load-bearing, not symmetry: this runs from the deck's own
        // error path, and for an Apple Music track the deck has no source to load. Without it the
        // recovery would fetch a stream for a song no provider owns (the `unsupported` throw) and
        // then report a playback error over a track the web player may be playing perfectly well.
        if (!song || !audioElement || isLocalPlaybackSong(song) || isNavidromePlaybackSong(song) || isStagePlaybackSong(song) || isExternalMediaPlaybackSong(song)) {
            return false;
        }

        const normalizedFailedSrc = getOnlineRecoveryKey(failedSrc || audioElement.currentSrc || audioSrc || null);
        if (normalizedFailedSrc && lastAudioRecoverySourceRef.current === normalizedFailedSrc) {
            return false;
        }

        if (onlinePlaybackRecoveryRef.current) {
            return onlinePlaybackRecoveryRef.current;
        }

        const recoveryTask = (async () => {
            if (normalizedFailedSrc) {
                lastAudioRecoverySourceRef.current = normalizedFailedSrc;
            }

            try {
                const audioResult = await loadOnlineSongAudioSource(song, audioQuality, null);
                if (currentSongRef.current !== getPlaybackSongKey(song) || !audioRef.current) {
                    return false;
                }

                if (audioResult.kind === 'unavailable') {
                    return false;
                }

                if (blobUrlRef.current && blobUrlRef.current !== audioResult.blobUrl) {
                    URL.revokeObjectURL(blobUrlRef.current);
                    blobUrlRef.current = null;
                }

                if (audioResult.blobUrl) {
                    blobUrlRef.current = audioResult.blobUrl;
                }

                const resolvedSong = applyOnlineAudioSourceMetadata(song, audioResult.replayGain);
                const replayGain = resolvedSong.replayGain;
                if (replayGain) {
                    setCurrentSong(prev => {
                        if (!prev || !isSamePlaybackSong(prev, song)) return prev;
                        return { ...prev, replayGain };
                    });
                    const resolvedQueue = replacePlaybackSongInQueue(playQueue, resolvedSong);
                    setPlayQueue(resolvedQueue);
                    void persistLastPlaybackCache(
                        resolvedSong,
                        resolvedQueue,
                    );
                }

                pendingResumeTimeRef.current = Math.max(0, resumeAt ?? audioRef.current.currentTime ?? 0);
                shouldAutoPlayRef.current = autoplay;
                currentOnlineAudioUrlFetchedAtRef.current = audioResult.audioSrc.startsWith('blob:')
                    ? null
                    : Date.now();
                setAudioSrc(audioResult.audioSrc);
                return true;
            } catch (error) {
                console.error('[App] Failed to recover online playback source', error);
                return false;
            } finally {
                onlinePlaybackRecoveryRef.current = null;
            }
        })();

        onlinePlaybackRecoveryRef.current = recoveryTask;
        return recoveryTask;
    };

    return {
        shouldRefreshCurrentOnlineAudioSource,
        recoverOnlinePlaybackSource,
    };
};
