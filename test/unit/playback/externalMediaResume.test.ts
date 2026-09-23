import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useActivePlaybackBackendStore } from '@/stores/useActivePlaybackBackendStore';
import { useExternalMediaStore } from '@/stores/useExternalMediaStore';
import { resumeExternalMediaSong } from '@/hooks/useTransportDispatcher';
import type { SongResult } from '@/types';

// test/unit/playback/externalMediaResume.test.ts
// 修复 3 的锁定：按播放键面对一首**外部媒体曲目**时，命令发给外部播放器而不是 Folia 的 deck。
//
// 背景（截图里那两条错误）：后端还是 folia 时，一首 Apple Music 曲目在 Folia 里没有任何音频源
// （`onPlayExternalMediaSong` 刻意让 deck 保持静默），于是 `resumePlayback` 走到 `deck.play()`
// 得到一个 AbortError，随后 recovery 又去问 Omni 要音频源 —— 而 Omni 里没有拥有它的 provider。

type SentCommand = { command: string; mediaId?: string };

let sent: SentCommand[] = [];

const installBridge = () => {
    (globalThis as unknown as { window: unknown }).window = {
        electron: {
            externalMediaSendCommand: (request: SentCommand) => {
                sent.push(request);
                return Promise.resolve({ ok: true });
            },
        },
    };
};

const setStatus = (over: Partial<ElectronExternalMediaStatus> = {}) => {
    useExternalMediaStore.getState().setStatus({
        bridgeAvailable: true,
        helperState: 'running',
        connected: true,
        sourceAppUserModelId: 'Chrome',
        title: null,
        artist: null,
        album: null,
        playbackStatus: null,
        positionMs: null,
        durationMs: null,
        hasThumbnail: false,
        updatedAt: 1,
        lastEventAt: 1,
        sessionCount: 1,
        extensionConnected: true,
        extensionVersion: '1.0.0',
        extensionCapabilities: ['playById'],
        signedIn: true,
        storefrontMatches: true,
        lastCommand: null,
        lastError: null,
        ...over,
    } as ElectronExternalMediaStatus);
};

const appleMusicSong = (over: Partial<SongResult> = {}): SongResult => ({
    id: 'apple-music:a.1538098094',
    name: '你',
    artists: [{ id: 0, name: 'Artist' }],
    album: { id: 0, name: 'Album' },
    durationMs: 1000,
    sourceRef: { kind: 'external-media', mediaId: 'a.1538098094' },
    externalMediaId: 'a.1538098094',
    externalMediaCatalogId: '1538098094',
    ...over,
} as SongResult);

describe('resuming an external media track from the play button', () => {
    beforeEach(() => {
        sent = [];
        installBridge();
        useActivePlaybackBackendStore.getState().setActiveBackend('folia');
        setStatus();
    });

    it('claims the backend and addresses the catalog id when the web player is elsewhere', async () => {
        const dispatched = await resumeExternalMediaSong(appleMusicSong());

        expect(dispatched).toBe(true);
        expect(useActivePlaybackBackendStore.getState().activeBackend).toBe('external-media');
        // The claim has to happen first: playExternalMediaTrack's own gate is the backend.
        expect(sent).toEqual([{ command: 'playById', mediaId: '1538098094' }]);
    });

    it('sends plain play when the web player already holds this exact track', async () => {
        setStatus({ title: '你', artist: 'Artist', playbackStatus: 'Paused' });

        const dispatched = await resumeExternalMediaSong(appleMusicSong());

        expect(dispatched).toBe(true);
        // Not playById: pressing play on a paused track means continue, not restart.
        expect(sent).toEqual([{ command: 'play' }]);
    });

    it('falls back to playById when the observed track is a different one', async () => {
        setStatus({ title: 'Other', artist: 'Artist', playbackStatus: 'Playing' });

        await resumeExternalMediaSong(appleMusicSong());

        expect(sent).toEqual([{ command: 'playById', mediaId: '1538098094' }]);
    });

    it('refuses honestly for a library upload with no catalog entry', async () => {
        const dispatched = await resumeExternalMediaSong(appleMusicSong({
            externalMediaCatalogId: null,
            externalMediaId: null,
            sourceRef: { kind: 'external-media', mediaId: 'a.9' },
        } as unknown as Partial<SongResult>));

        expect(dispatched).toBe(false);
        expect(sent).toEqual([]);
    });

    it('claims the backend but sends nothing while the extension channel is not ready', async () => {
        setStatus({ extensionConnected: false });

        const dispatched = await resumeExternalMediaSong(appleMusicSong());

        expect(dispatched).toBe(false);
        expect(sent).toEqual([]);
        // Claimed anyway: the track belongs to this backend whether or not it can be driven right now.
        expect(useActivePlaybackBackendStore.getState().activeBackend).toBe('external-media');
    });
});
