import { useCallback, useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import type { MotionValue } from 'framer-motion';
import { findLatestActiveLineIndex } from '../utils/appPlaybackHelpers';
import { PlayerState } from '../types';
import type { AudioBands, LyricData } from '../types';
import { setCurrentLineIndex, setPlayerState } from '../stores/usePlaybackStore';
import { selectDisplayLyrics, usePlaybackStore } from '../stores/usePlaybackStore';
import { useActivePlaybackBackendStore } from '../stores/useActivePlaybackBackendStore';
import { useAppleMusicSmtcStore } from '../stores/useAppleMusicSmtcStore';
import { resolveAppleMusicClockSec } from '../utils/appleMusicSmtcStatus';
import type { PlaybackBackend } from '../types/playbackBackend';
import { audioBands, audioPower, currentTime, lyricCurrentTime } from '../stores/motionSignals';

// src/hooks/usePlaybackVisualizerBridge.ts

type UsePlaybackVisualizerBridgeParams = {

    audioRef: MutableRefObject<HTMLAudioElement | null>;
    analyserRef: MutableRefObject<AnalyserNode | null>;
    animationFrameRef: MutableRefObject<number>;
    effectiveLoopMode: 'off' | 'all' | 'one';
    isNowPlayingStageActive: boolean;
    isPlayerCapStageActive: boolean;
    stageActiveEntryKind: string | null;
    stageLyricsSession: unknown;
    stageLyricsClockRef: MutableRefObject<{
        startTimeSec: number;
        endTimeSec: number;
        baseTimeSec: number;
        startedAtMs: number | null;
    }>;
    getSyntheticStageLyricsTime: () => number;
    syncStageLyricsClock: (timeSec: number, endTimeSec: number, nextPlayerState: PlayerState, startTimeSec?: number) => void;
    getNowPlayingDisplayTime: () => number;
    getPlayerCapDisplayTime: () => number;
    syncNowPlayingClock: (progressSec: number, durationSec: number, paused: boolean) => void;
    lyricTimelineOffsetMs: number;
    /** True while an automix handover is in progress and a deck other than the active one sounds. */
    isTransitionAudible: () => boolean;
    /**
     * The deck the on-screen track is playing on while a transition holds the picture, else null.
     *
     * The clock below has to follow whatever is on screen. From the moment a blend arms, the
     * active deck is seconds into the NEXT track while the title, cover and lyrics still belong to
     * the one finishing - so reading the active deck here puts the progress bar and the lyric
     * read-head near zero under a song that is three minutes in.
     */
    getDisplayElement?: () => HTMLAudioElement | null;
};

/**
 * 「Apple Music 拥有传输权时,把 SMTC 位置写进全局播放时钟」。返回本帧是否写了。
 *
 * 从 RAF 循环里提出来,是为了让这条支路能被真正执行地断言(而不是只读源码):
 * motion signal 是模块级的,所以调用它就能观察 `currentTime` / `lyricCurrentTime` 的值。
 *
 * 三条语义,与 `resolveAppleMusicClockSec` 的判据一一对应:
 *   * `null`(后端不是 apple-music,或快照没有位置)→ 一个字节都不写,时钟仍由原有四分支持有。
 *     这条正是"迟到的 SMTC 快照不会覆盖正在播放的 Folia deck 位置"的保证。
 *   * 已知位置 → 写 `currentTime`(秒),并按同一 offset 规则写歌词时钟。
 *   * 只读镜像:不写 playback store、不碰 audio 元素、不改 backend。
 */
export const applyAppleMusicClockTick = (
    backend: PlaybackBackend,
    positionMs: number | null | undefined,
    lyricTimelineOffsetMs: number,
): boolean => {
    const positionSec = resolveAppleMusicClockSec(backend, positionMs);
    if (positionSec === null) {
        return false;
    }

    currentTime.set(positionSec);
    lyricCurrentTime.set(positionSec - lyricTimelineOffsetMs / 1000);
    return true;
};

// Runs the requestAnimationFrame loop for audio-reactive visuals and lyric timing.
export function usePlaybackVisualizerBridge({
    audioRef,
    analyserRef,
    animationFrameRef,
    effectiveLoopMode,
    isNowPlayingStageActive,
    isPlayerCapStageActive,
    stageActiveEntryKind,
    stageLyricsSession,
    stageLyricsClockRef,
    getSyntheticStageLyricsTime,
    syncStageLyricsClock,
    getNowPlayingDisplayTime,
    getPlayerCapDisplayTime,
    syncNowPlayingClock,
    lyricTimelineOffsetMs,
    isTransitionAudible,
    getDisplayElement,
}: UsePlaybackVisualizerBridgeParams) {
    // Read here rather than passed in: store fields and the module-level motion signals.
    const activePlaybackContext = usePlaybackStore(state => state.activePlaybackContext);
    const playerState = usePlaybackStore(state => state.playerState);
    const duration = usePlaybackStore(state => state.duration);
    // The lyrics on screen, matching the deck getDisplayElement points at.
    const lyrics = usePlaybackStore(selectDisplayLyrics);
    // Phase 3A: the four clock sources below all describe a Folia deck or a Stage session, so in the
    // Apple Music backend not one of them fires - which is why the progress bar sat at 00:00 and a
    // completed drag never became visible anywhere. The SMTC snapshot is the fifth source, and this
    // is the one place the global playback clock is written, so it belongs here rather than in a
    // second clock owner. Read-only mirror: no store write, no audio element, no backend change.
    //
    // Read through refs rather than as loop dependencies. The snapshot changes about once a second,
    // and a dependency would tear down and re-schedule the whole animation loop at that rate - the
    // exact restart-per-tick pattern frontend-runtime-guardrails forbids. Refs keep one continuous
    // loop that always sees the newest values.
    const backend = useActivePlaybackBackendStore(state => state.activeBackend);
    const appleMusicStatus = useAppleMusicSmtcStore(state => state.status);
    const backendRef = useRef(backend);
    const appleMusicStatusRef = useRef(appleMusicStatus);
    backendRef.current = backend;
    appleMusicStatusRef.current = appleMusicStatus;

    const currentLineIndexRef = useRef(-1);

    const updateLoop = useCallback(() => {
        // Normally the active deck; the outgoing one for as long as a blend holds the picture on
        // the track it is finishing, so that clock and picture never describe different songs.
        const audioElement = getDisplayElement?.() ?? audioRef.current;
        const isActuallyPlaying = Boolean(audioElement && !audioElement.paused && !audioElement.ended);
        // Mid-handover a deck can be loading while the other one is still sounding. The analyser
        // is downstream of both, so it has real signal: dropping to the idle breath here would put
        // a visible stutter at exactly the moment meant to be seamless.
        const hasAudibleSignal = isActuallyPlaying || isTransitionAudible();

        if (hasAudibleSignal && analyserRef.current) {
            const bufferLength = analyserRef.current.frequencyBinCount;
            const dataArray = new Uint8Array(bufferLength);
            analyserRef.current.getByteFrequencyData(dataArray);
            audioBands.spectrum?.set(dataArray);

            const getEnergy = (minHz: number, maxHz: number): number => {
                const start = Math.floor(minHz / 21.5);
                const end = Math.floor(maxHz / 21.5);
                let sum = 0;
                for (let index = start; index <= end; index += 1) {
                    sum += dataArray[index];
                }
                const count = end - start + 1;
                return count > 0 ? sum / count : 0;
            };

            const bass = getEnergy(20, 150);
            const lowMid = getEnergy(150, 400);
            const mid = getEnergy(400, 1200);
            const vocal = getEnergy(1000, 3500);
            const treble = getEnergy(3500, 12000);

            const process = (value: number, boost = 2) => {
                const normalized = value / 255;
                return Math.pow(normalized, boost) * 255;
            };

            audioPower.set(process((bass + lowMid) / 2, 3));
            audioBands.bass.set(process(bass, 1.8));
            audioBands.lowMid.set(process(lowMid, 2));
            audioBands.mid.set(process(mid, 2));
            audioBands.vocal.set(process(vocal, 1.5));
            audioBands.treble.set(process(treble, 2));
        } else {
            const time = Date.now() / 2000;
            const breath = (Math.sin(time) + 1) * 20;
            audioPower.set(breath);
            audioBands.bass.set(breath);
            audioBands.lowMid.set(breath);
            audioBands.mid.set(breath);
            audioBands.vocal.set(breath);
            audioBands.treble.set(breath);
            audioBands.spectrum?.set(new Uint8Array(0));
        }

        // Phase 3A: the Apple Music backend owns the transport, so the SMTC snapshot is the clock.
        // Deliberately the FIRST arm of this chain: it is mutually exclusive with the four Folia /
        // Stage sources by construction (an external player cannot also be a Folia deck), and putting
        // it first means the priority is readable instead of depending on the order of the others.
        //
        // The snapshot arrives on the store at roughly 1Hz (the helper polls every 500ms and gates on
        // content, and Apple Music quantizes its position to whole seconds), so the bar steps about
        // once a second. That is the data source's own resolution, not a smoothing choice:
        // interpolating between coarse anchors is the lyric-clock task, and faking it here would
        // publish a position the OS never reported.
        if (backendRef.current === 'apple-music') {
            // 本帧时钟归 SMTC：下面四个 Folia / Stage 来源必须让位。
            applyAppleMusicClockTick(
                backendRef.current,
                appleMusicStatusRef.current?.positionMs,
                lyricTimelineOffsetMs,
            );
        } else if (isActuallyPlaying && audioElement) {
            const time = audioElement.currentTime;
            currentTime.set(time);

            const effectiveLyricTime = time - lyricTimelineOffsetMs / 1000;
            lyricCurrentTime.set(effectiveLyricTime);

            if (lyrics) {
                const foundIndex = findLatestActiveLineIndex(lyrics.lines, effectiveLyricTime);
                if (foundIndex !== currentLineIndexRef.current) {
                    currentLineIndexRef.current = foundIndex;
                    setCurrentLineIndex(foundIndex);
                }
            }
        } else if (isNowPlayingStageActive) {
            const nextTime = getNowPlayingDisplayTime();
            const hasReachedEnd = playerState === PlayerState.PLAYING && duration > 0 && nextTime >= duration;

            currentTime.set(nextTime);

            const effectiveLyricTime = nextTime - lyricTimelineOffsetMs / 1000;
            lyricCurrentTime.set(effectiveLyricTime);

            if (lyrics) {
                const foundIndex = findLatestActiveLineIndex(lyrics.lines, effectiveLyricTime);
                if (foundIndex !== currentLineIndexRef.current) {
                    currentLineIndexRef.current = foundIndex;
                    setCurrentLineIndex(foundIndex);
                }
            } else if (currentLineIndexRef.current !== -1) {
                currentLineIndexRef.current = -1;
                setCurrentLineIndex(-1);
            }

            if (hasReachedEnd) {
                if (effectiveLoopMode === 'one' || effectiveLoopMode === 'all') {
                    syncNowPlayingClock(0, duration, false);
                    currentTime.set(0);
                    if (lyrics) {
                        const restartedLineIndex = findLatestActiveLineIndex(lyrics.lines, 0);
                        if (restartedLineIndex !== currentLineIndexRef.current) {
                            currentLineIndexRef.current = restartedLineIndex;
                            setCurrentLineIndex(restartedLineIndex);
                        }
                    }
                } else {
                    syncNowPlayingClock(duration, duration, true);
                    setPlayerState(PlayerState.PAUSED);
                }
            }
        } else if (isPlayerCapStageActive) {
            // PlayerCap: clock extrapolated from progress×duration; a passive source, looping/ending is driven by the external player, so no end/loop handling here.
            const nextTime = getPlayerCapDisplayTime();
            currentTime.set(nextTime);

            const effectiveLyricTime = nextTime - lyricTimelineOffsetMs / 1000;
            lyricCurrentTime.set(effectiveLyricTime);

            if (lyrics) {
                const foundIndex = findLatestActiveLineIndex(lyrics.lines, effectiveLyricTime);
                if (foundIndex !== currentLineIndexRef.current) {
                    currentLineIndexRef.current = foundIndex;
                    setCurrentLineIndex(foundIndex);
                }
            } else if (currentLineIndexRef.current !== -1) {
                currentLineIndexRef.current = -1;
                setCurrentLineIndex(-1);
            }
        } else if (activePlaybackContext === 'stage' && stageActiveEntryKind === 'lyrics' && stageLyricsSession && lyrics) {
            const nextTime = getSyntheticStageLyricsTime();
            const clock = stageLyricsClockRef.current;
            const hasReachedEnd = playerState === PlayerState.PLAYING && nextTime >= clock.endTimeSec;

            currentTime.set(nextTime);

            const foundIndex = findLatestActiveLineIndex(lyrics.lines, nextTime);
            if (foundIndex !== currentLineIndexRef.current) {
                currentLineIndexRef.current = foundIndex;
                setCurrentLineIndex(foundIndex);
            }

            if (hasReachedEnd) {
                if (effectiveLoopMode === 'one' || effectiveLoopMode === 'all') {
                    syncStageLyricsClock(clock.startTimeSec, clock.endTimeSec, PlayerState.PLAYING, clock.startTimeSec);
                    currentTime.set(clock.startTimeSec);
                    const restartedLineIndex = findLatestActiveLineIndex(lyrics.lines, clock.startTimeSec);
                    if (restartedLineIndex !== currentLineIndexRef.current) {
                        currentLineIndexRef.current = restartedLineIndex;
                        setCurrentLineIndex(restartedLineIndex);
                    }
                } else {
                    syncStageLyricsClock(clock.endTimeSec, clock.endTimeSec, PlayerState.PAUSED, clock.startTimeSec);
                    setPlayerState(PlayerState.PAUSED);
                }
            }
        }

        animationFrameRef.current = requestAnimationFrame(updateLoop);
    }, [
        activePlaybackContext,
        analyserRef,
        animationFrameRef,
        audioBands,
        audioPower,
        audioRef,
        currentTime,
        duration,
        effectiveLoopMode,
        getNowPlayingDisplayTime,
        getPlayerCapDisplayTime,
        getSyntheticStageLyricsTime,
        isNowPlayingStageActive,
        isPlayerCapStageActive,
        lyrics,
        playerState,
        setCurrentLineIndex,
        setPlayerState,
        stageActiveEntryKind,
        stageLyricsClockRef,
        stageLyricsSession,
        syncNowPlayingClock,
        syncStageLyricsClock,
        lyricTimelineOffsetMs,
        lyricCurrentTime,
        isTransitionAudible,
        getDisplayElement,
    ]);

    useEffect(() => {
        animationFrameRef.current = requestAnimationFrame(updateLoop);
        return () => {
            if (animationFrameRef.current) {
                cancelAnimationFrame(animationFrameRef.current);
            }
        };
    }, [animationFrameRef, updateLoop]);
}
