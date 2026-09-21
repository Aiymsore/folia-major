import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActivePlaybackBackendStore } from '../../src/stores/useActivePlaybackBackendStore';
import { useAppleMusicSmtcStore } from '../../src/stores/useAppleMusicSmtcStore';
import {
    handleAppleMusicAction,
    handleAppleMusicSeek,
} from '../../src/hooks/useTransportDispatcher';

// test/unit/transportDispatcher.test.ts
// 硬约束 3 的锁定：dispatcher 不得递归、必须用 `handled: boolean` 表达"我接了"，
// 且 Apple Music 的 seek 只认 SMTC 自己的时长。

type SentCommand = { command: string; positionMs?: number };

let sent: SentCommand[] = [];

const installBridge = (options: { reject?: boolean } = {}) => {
    (globalThis as unknown as { window: unknown }).window = {
        electron: {
            appleMusicSendCommand: (request: SentCommand) => {
                sent.push(request);
                return options.reject ? Promise.reject(new Error('boom')) : Promise.resolve({ ok: true });
            },
        },
    };
};

const setStatus = (status: Partial<ElectronAppleMusicSmtcStatus> | null) => {
    useAppleMusicSmtcStore.getState().setStatus(status as ElectronAppleMusicSmtcStatus);
};

const connectedPlaying = (over: Partial<ElectronAppleMusicSmtcStatus> = {}) => ({
    bridgeAvailable: true,
    helperState: 'running' as const,
    connected: true,
    sourceAppUserModelId: 'AppleInc.AppleMusicWin_nzyj5cx40ttqa!App',
    title: 'Track',
    artist: 'Artist',
    album: null,
    playbackStatus: 'Playing',
    positionMs: 61_000,
    durationMs: 240_000,
    hasThumbnail: false,
    updatedAt: 1,
    lastEventAt: 1,
    sessionCount: 2,
    lastCommand: null,
    lastError: null,
    ...over,
});

describe('transport dispatcher', () => {
    beforeEach(() => {
        sent = [];
        installBridge();
        useActivePlaybackBackendStore.getState().setActiveBackend('folia');
        setStatus(connectedPlaying());
    });

    afterEach(() => {
        vi.restoreAllMocks();
        delete (globalThis as { window?: unknown }).window;
    });

    it('declines every action while the Folia backend owns the transport', () => {
        // false is the whole contract for the Folia path: the caller then runs its original body,
        // which is what keeps resumePlayback/pausePlayback/togglePlay byte-for-byte unchanged.
        for (const action of ['play', 'pause', 'toggle', 'previous', 'next'] as const) {
            expect(handleAppleMusicAction(action)).toBe(false);
        }
        expect(handleAppleMusicSeek(30)).toBe(false);
        expect(sent).toEqual([]);
    });

    it('takes every action for the Apple Music backend and never touches Folia', () => {
        useActivePlaybackBackendStore.getState().setActiveBackend('apple-music');

        expect(handleAppleMusicAction('toggle')).toBe(true);
        expect(handleAppleMusicAction('next')).toBe(true);
        expect(handleAppleMusicAction('previous')).toBe(true);
        expect(handleAppleMusicAction('play')).toBe(true);
        expect(handleAppleMusicAction('pause')).toBe(true);

        expect(sent.map(entry => entry.command)).toEqual([
            'toggle-play-pause',
            'next',
            'previous',
            'play',
            'pause',
        ]);
    });

    it('takes the call but sends nothing when there is no track information at all', () => {
        // Returning true while sending nothing is deliberate: the Folia body must not run either.
        // backend=apple-music means the Folia deck is not the user's target, so a "no reaction"
        // button must not start this element instead.
        //
        // Note the predicate is "no media information", NOT "not Playing/Paused": a Stopped track is
        // still a track and must accept a play command (see the next test).
        useActivePlaybackBackendStore.getState().setActiveBackend('apple-music');
        setStatus(connectedPlaying({ playbackStatus: 'Closed', title: null }));

        expect(handleAppleMusicAction('play')).toBe(true);
        expect(sent).toEqual([]);
    });

    it('still sends play for a Stopped track, because resuming is the whole point', () => {
        useActivePlaybackBackendStore.getState().setActiveBackend('apple-music');
        setStatus(connectedPlaying({ playbackStatus: 'Stopped', positionMs: 0 }));

        expect(handleAppleMusicAction('play')).toBe(true);
        expect(sent).toEqual([{ command: 'play' }]);
    });

    it('takes the call but sends nothing when the bridge is unavailable', () => {
        useActivePlaybackBackendStore.getState().setActiveBackend('apple-music');
        setStatus(connectedPlaying({ bridgeAvailable: false, connected: false, playbackStatus: null, title: null }));

        expect(handleAppleMusicAction('toggle')).toBe(true);
        expect(sent).toEqual([]);
    });

    it('clamps a seek against the Apple Music duration and quantizes to whole seconds', () => {
        useActivePlaybackBackendStore.getState().setActiveBackend('apple-music');

        // Beyond the end: clamped to the SMTC duration (240 s), not to any Folia value.
        expect(handleAppleMusicSeek(9_999)).toBe(true);
        // Sub-second: quantized, so the bar cannot report 41.7 s while playback sits at 42 s.
        expect(handleAppleMusicSeek(41.7)).toBe(true);
        // Negative positions are floored at zero rather than becoming a huge unsigned tick count.
        expect(handleAppleMusicSeek(-5)).toBe(true);

        expect(sent).toEqual([
            { command: 'seek', positionMs: 240_000 },
            { command: 'seek', positionMs: 42_000 },
            { command: 'seek', positionMs: 0 },
        ]);
    });

    it('does not clamp when the duration is unknown', () => {
        useActivePlaybackBackendStore.getState().setActiveBackend('apple-music');
        setStatus(connectedPlaying({ durationMs: null }));

        expect(handleAppleMusicSeek(600)).toBe(true);
        expect(sent).toEqual([{ command: 'seek', positionMs: 600_000 }]);
    });

    it('survives a rejecting bridge without throwing into the caller', () => {
        installBridge({ reject: true });
        useActivePlaybackBackendStore.getState().setActiveBackend('apple-music');

        expect(() => handleAppleMusicAction('pause')).not.toThrow();
        expect(() => handleAppleMusicSeek(10)).not.toThrow();
    });
});
