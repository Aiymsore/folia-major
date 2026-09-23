import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActivePlaybackBackendStore } from '../../src/stores/useActivePlaybackBackendStore';
import { useExternalMediaStore } from '../../src/stores/useExternalMediaStore';
import {
    handleExternalMediaAction,
    handleExternalMediaSeek,
    playExternalMediaTrack,
} from '../../src/hooks/useTransportDispatcher';

// test/unit/transportDispatcher.test.ts
// dispatcher 契约的锁定：不得递归、必须用 `handled: boolean` 表达"我接了"，
// seek 只认观察到的时长，以及**最重要的一条** —— next / previous 绝不透传给外部播放器。
//
// "下一首"由 Folia 的 queue 解析成 `playById(<下一首>)`（走 `playExternalMediaTrack`），
// 否则 Apple Music 网页版会播它自己的内部队列，与 Folia 的 queue 争夺控制权。
// 因此 `TransportAction` 只有 play / pause / toggle，本文件的断言把这个缺失钉死。

type SentCommand = { command: string; positionMs?: number };

let sent: SentCommand[] = [];

const installBridge = (options: { reject?: boolean } = {}) => {
    (globalThis as unknown as { window: unknown }).window = {
        electron: {
            externalMediaSendCommand: (request: SentCommand) => {
                sent.push(request);
                return options.reject ? Promise.reject(new Error('boom')) : Promise.resolve({ ok: true });
            },
        },
    };
};

const setStatus = (status: Partial<ElectronExternalMediaStatus> | null) => {
    useExternalMediaStore.getState().setStatus(status as ElectronExternalMediaStatus);
};

const connectedPlaying = (over: Partial<ElectronExternalMediaStatus> = {}) => ({
    bridgeAvailable: true,
    helperState: 'running' as const,
    connected: true,
    sourceAppUserModelId: 'Chrome',
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
    extensionConnected: true,
    extensionVersion: '1.0.0',
    extensionCapabilities: ['observe', 'transport', 'seek', 'playById'],
    signedIn: true,
    storefrontMatches: true,
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
        for (const action of ['play', 'pause', 'toggle'] as const) {
            expect(handleExternalMediaAction(action)).toBe(false);
        }
        expect(handleExternalMediaSeek(30)).toBe(false);
        expect(sent).toEqual([]);
    });

    it('takes every transport action for the external media backend and never touches Folia', () => {
        useActivePlaybackBackendStore.getState().setActiveBackend('external-media');

        expect(handleExternalMediaAction('toggle')).toBe(true);
        expect(handleExternalMediaAction('play')).toBe(true);
        expect(handleExternalMediaAction('pause')).toBe(true);

        // Exactly three verbs. `next` / `previous` are not in the vocabulary at all (the type does
        // not allow them): the queue layer resolves "next" itself, see the test below.
        expect(sent.map(entry => entry.command)).toEqual([
            'toggle',
            'play',
            'pause',
        ]);
    });

    it('resolves "next" as playById from the Folia queue instead of forwarding it', () => {
        // This is the whole point of removing next/previous from the command set: the web player
        // must be asked for ONE track by id, never "advance your own queue".
        useActivePlaybackBackendStore.getState().setActiveBackend('external-media');

        return playExternalMediaTrack('1234567890').then(dispatched => {
            expect(dispatched).toBe(true);
            expect(sent).toEqual([{ command: 'playById', mediaId: '1234567890' }]);
        });
    });

    it('takes the call but sends nothing when there is no track information at all', () => {
        // Returning true while sending nothing is deliberate: the Folia body must not run either.
        // backend=apple-music means the Folia deck is not the user's target, so a "no reaction"
        // button must not start this element instead.
        //
        // Note the predicate is "no media information", NOT "not Playing/Paused": a Stopped track is
        // still a track and must accept a play command (see the next test).
        useActivePlaybackBackendStore.getState().setActiveBackend('external-media');
        setStatus(connectedPlaying({ playbackStatus: 'Closed', title: null }));

        expect(handleExternalMediaAction('play')).toBe(true);
        expect(sent).toEqual([]);
    });

    it('still sends play for a Stopped track, because resuming is the whole point', () => {
        useActivePlaybackBackendStore.getState().setActiveBackend('external-media');
        setStatus(connectedPlaying({ playbackStatus: 'Stopped', positionMs: 0 }));

        expect(handleExternalMediaAction('play')).toBe(true);
        expect(sent).toEqual([{ command: 'play' }]);
    });

    it('takes the call but sends nothing when the bridge is unavailable', () => {
        useActivePlaybackBackendStore.getState().setActiveBackend('external-media');
        setStatus(connectedPlaying({ bridgeAvailable: false, connected: false, playbackStatus: null, title: null }));

        expect(handleExternalMediaAction('toggle')).toBe(true);
        expect(sent).toEqual([]);
    });

    it('clamps a seek against the Apple Music duration and quantizes to whole seconds', () => {
        useActivePlaybackBackendStore.getState().setActiveBackend('external-media');

        // Beyond the end: clamped to the SMTC duration (240 s), not to any Folia value.
        expect(handleExternalMediaSeek(9_999)).toBe(true);
        // Sub-second: quantized, so the bar cannot report 41.7 s while playback sits at 42 s.
        expect(handleExternalMediaSeek(41.7)).toBe(true);
        // Negative positions are floored at zero rather than becoming a huge unsigned tick count.
        expect(handleExternalMediaSeek(-5)).toBe(true);

        expect(sent).toEqual([
            { command: 'seek', positionMs: 240_000 },
            { command: 'seek', positionMs: 42_000 },
            { command: 'seek', positionMs: 0 },
        ]);
    });

    it('does not clamp when the duration is unknown', () => {
        useActivePlaybackBackendStore.getState().setActiveBackend('external-media');
        setStatus(connectedPlaying({ durationMs: null }));

        expect(handleExternalMediaSeek(600)).toBe(true);
        expect(sent).toEqual([{ command: 'seek', positionMs: 600_000 }]);
    });

    it('survives a rejecting bridge without throwing into the caller', () => {
        installBridge({ reject: true });
        useActivePlaybackBackendStore.getState().setActiveBackend('external-media');

        expect(() => handleExternalMediaAction('pause')).not.toThrow();
        expect(() => handleExternalMediaSeek(10)).not.toThrow();
    });
});
