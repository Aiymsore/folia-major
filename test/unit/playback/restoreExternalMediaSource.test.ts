import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/playback/restoreExternalMediaSource.test.ts
// 修复 2/3 的会话恢复半边：把上一会话的 Apple Music 曲目恢复成"屏幕上的一首曲目"，
// 而**绝不**把它送进 omni 的在线取流路径。
//
// 旧行为：`restorePlaybackSourceForSong` 只挡了 local / Navidrome，于是外部媒体曲目落到
// `omni.canPlaySong(song)` —— 对一首没有 provider 拥有的曲目，那一步是 `unsupported` 抛出，
// 恢复因此以 `status.playbackFailed` 结束。

type AudioSourceResult = { kind: 'ok'; audioSrc: string } | { kind: 'unavailable' };

const loadAudioSourceMock = vi.hoisted(() => vi.fn(async (): Promise<AudioSourceResult> => ({ kind: 'unavailable' })));
const canPlaySongMock = vi.hoisted(() => vi.fn(() => true));
const getLyricsMock = vi.hoisted(() => vi.fn(async () => ({ lyrics: null })));
const setCurrentSongMock = vi.hoisted(() => vi.fn());
const setAudioSrcMock = vi.hoisted(() => vi.fn());
const setStatusMsgMock = vi.hoisted(() => vi.fn());
const fetchAmllDbLyricsMock = vi.hoisted(() => vi.fn(async () => ({
    lines: [{ fullText: 'am lyric', startTime: 0, endTime: 1 }],
})));

vi.mock('@/services/onlinePlayback', () => ({
    loadOnlineSongAudioSource: loadAudioSourceMock,
    applyOnlineAudioSourceMetadata: (song: unknown) => song,
}));
vi.mock('@/services/onlineMusic/omni', () => ({
    omni: { canPlaySong: canPlaySongMock, getLyrics: getLyricsMock },
}));
// The network leaf only: `appleMusicService`'s own exports (payload reader included) stay real, so
// the catalog-id resolution under test is the production one.
vi.mock('@/utils/lyrics/providers/amllDbProvider', () => ({
    fetchAmllDbLyrics: fetchAmllDbLyricsMock,
}));
vi.mock('@/stores/usePlaybackStore', () => ({
    setAudioSrc: setAudioSrcMock,
    setCachedCoverUrl: vi.fn(),
    setCurrentSong: setCurrentSongMock,
}));
vi.mock('@/stores/useStatusMessageStore', () => ({ setStatusMessage: setStatusMsgMock }));
vi.mock('@/services/coverCache', () => ({
    getCachedCoverUrl: vi.fn(async () => null),
    loadCachedOrFetchCover: vi.fn(async () => null),
}));
vi.mock('@/services/db', () => ({ getLocalSongs: vi.fn(async () => []) }));
vi.mock('@/services/localMusicService', () => ({
    ensureLocalSongCoverAsset: vi.fn(),
    getAudioFromLocalSong: vi.fn(async () => null),
}));
vi.mock('@/services/playbackAdapters', () => ({
    applyLocalLibraryEntityDisplay: (song: unknown) => song,
    buildUnifiedLocalSong: vi.fn(),
}));
vi.mock('@/services/playbackRecovery/sourceRevision', () => ({ buildNavidromeSourceRevision: vi.fn() }));
vi.mock('@/services/localLibraryEntityRepository', () => ({
    getLocalLibraryCatalogSnapshot: vi.fn(async () => null),
}));
vi.mock('@/services/navidromeService', () => ({ getNavidromeConfig: vi.fn(() => null), navidromeApi: {} }));
vi.mock('@/services/onlineMusic/resourceCache', () => ({
    getCachedSongCoverUrl: vi.fn(async () => null),
    getSongCacheWithLegacyMigration: vi.fn(async () => null),
}));
vi.mock('@/services/onlineMusic/songMetadata', () => ({ getSongCoverUrl: vi.fn(() => null) }));
vi.mock('@/stores/useOnlineProviderAccountStore', () => ({
    useOnlineProviderAccountStore: { getState: () => ({ accounts: {} }) },
}));
vi.mock('@/utils/onlineLyricsState', () => ({
    loadOnlineLyricsState: vi.fn(async () => null),
    resolveOnlineLyrics: vi.fn(() => null),
}));
vi.mock('@/utils/appNavidromeLyrics', () => ({
    hydrateNavidromeLyricPayload: vi.fn(),
    resolvePreferredNavidromeLyrics: vi.fn(async () => null),
}));
vi.mock('@/utils/appPlaybackHelpers', () => ({ hasRenderableLyrics: () => true }));
vi.mock('@/i18n/config', () => ({ default: { t: (key: string) => key } }));

const { restorePlaybackSourceForSong } = await import('@/components/app/playback/restorePlaybackSource');
import type { SongResult } from '@/types';

const appleMusicSong = (over: Partial<SongResult> = {}): SongResult => ({
    id: 'apple-music:a.1538098094',
    name: '你',
    artists: [{ id: 0, name: 'Artist' }],
    album: { id: 0, name: 'Album' },
    durationMs: 1000,
    sourceRef: { kind: 'external-media', mediaId: 'a.1538098094' },
    externalMediaId: 'a.1538098094',
    externalMediaCatalogId: '1538098094',
    externalMediaHasLyrics: true,
    ...over,
} as SongResult);

const restore = async (song: SongResult, queue?: SongResult[]) => restorePlaybackSourceForSong(song, {
    audioQuality: 'high',
    blobUrlRef: { current: null },
    currentOnlineAudioUrlFetchedAtRef: { current: 1 },
    setLyrics: vi.fn(),
    queue,
});

describe('restoring an Apple Music track from the last session', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('never asks a provider for a stream no provider owns', async () => {
        const restored = await restore(appleMusicSong());

        expect(restored).toBe(true);
        // The two calls that used to run and throw `Song is not owned by an online provider`.
        expect(canPlaySongMock).not.toHaveBeenCalled();
        expect(loadAudioSourceMock).not.toHaveBeenCalled();
        // Nothing to load: the external player owns the bytes, so Folia's deck stays empty.
        expect(setAudioSrcMock).not.toHaveBeenCalled();
    });

    it('puts the track back on screen and keeps its lyrics lookup on the catalog id', async () => {
        const setLyrics = vi.fn();
        await restorePlaybackSourceForSong(appleMusicSong(), {
            audioQuality: 'high',
            blobUrlRef: { current: null },
            currentOnlineAudioUrlFetchedAtRef: { current: 1 },
            setLyrics,
            queue: [appleMusicSong()],
        });

        expect(setCurrentSongMock).toHaveBeenCalled();
        // Lyrics still come from AMLL's TTML database, keyed by the catalog id.
        expect(fetchAmllDbLyricsMock).toHaveBeenCalledWith('am', '1538098094');
        expect(setLyrics).toHaveBeenCalledWith(expect.objectContaining({ lines: expect.any(Array) }));
    });

    it('says so when the remembered track has no catalog entry to address', async () => {
        await restore(appleMusicSong({
            externalMediaCatalogId: null,
            externalMediaId: null,
            externalMediaHasLyrics: false,
        } as unknown as Partial<SongResult>));

        expect(setStatusMsgMock).toHaveBeenCalledWith(expect.objectContaining({
            text: 'appleMusic.noCatalogEntry',
        }));
    });

    it('leaves the online path untouched for a normal provider song', async () => {
        canPlaySongMock.mockReturnValue(true);
        loadAudioSourceMock.mockResolvedValue({ kind: 'ok', audioSrc: 'https://example.test/a.mp3' });

        const restored = await restore({
            id: 'qq-song',
            name: 'Song',
            artists: [],
            album: { id: 'album', name: 'Album' },
            durationMs: 1000,
            sourceRef: { kind: 'online', providerId: 'qq', mediaId: '004Th6td4LaoZs' },
        } as SongResult);

        expect(restored).toBe(true);
        expect(canPlaySongMock).toHaveBeenCalled();
        expect(setAudioSrcMock).toHaveBeenCalledWith('https://example.test/a.mp3');
    });
});
