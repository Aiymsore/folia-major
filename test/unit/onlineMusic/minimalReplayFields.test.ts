import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SongResult } from '../../../src/types';

// test/unit/onlineMusic/minimalReplayFields.test.ts
// 跨来源歌单条目的「最小可回放字段」契约：netease / kugou / qq 的回放与歌词请求，
// 在只喂 entry 重建出的歌曲时仍然只引用持久化过的身份字段（id、sourceRef.mediaId、
// providerData 子集），且 entry 与重建件都不携带临时音频 URL 或 provider 原始对象。
//
// 三家的真实服务需要 .env.local 与 test-results/.dev-credentials，本测试在传输层
// （neteaseApi / kugouTransport / qqTransport）打桩：桩捕获请求参数，断言参数只含
// 持久化字段。真实服务的端到端冒烟见 test/manual/minimal-replay-smoke.ts。

const mocks = vi.hoisted(() => ({
    netease: {
        getSongUrl: vi.fn(),
        getLyric: vi.fn(),
        getCloudLyric: vi.fn(),
    },
    kugou: {
        requestKugou: vi.fn(),
        requestKugouLegacyPlayInfo: vi.fn(),
        requestKugouAnonymousSearch: vi.fn(),
        getKugouTransportAvailability: vi.fn(),
        hasKugouAuthenticatedSearchSession: vi.fn(),
    },
    qq: {
        requestQq: vi.fn(),
        clearQqSession: vi.fn(),
        hasQqSession: vi.fn(),
        getQqTransportAvailability: vi.fn(),
    },
    qqLyrics: {
        fetchQQLyrics: vi.fn(),
        searchQQLyrics: vi.fn(),
    },
}));

vi.mock('../../../src/services/netease', () => ({
    neteaseApi: mocks.netease,
    isSongMarkedUnavailable: () => false,
}));
vi.mock('../../../src/services/onlineMusic/kugouTransport', () => mocks.kugou);
vi.mock('../../../src/services/onlineMusic/qqTransport', () => mocks.qq);
vi.mock('../../../src/utils/lyrics/providers/qqLyricProvider', () => mocks.qqLyrics);

import { neteaseProvider } from '../../../src/services/onlineMusic/neteaseProvider';
import { kugouProvider } from '../../../src/services/onlineMusic/kugouProvider';
import { qqProvider } from '../../../src/services/onlineMusic/qqProvider';
import { buildPlaylistEntry, playlistEntryToSong } from '../../../src/utils/playlistEntry';
import { parsePortablePlaylist, serializePortablePlaylist } from '../../../src/utils/portablePlaylistFormat';

const roundTrip = (song: SongResult): { entryJson: string; rebuilt: SongResult | null } => {
    const entry = buildPlaylistEntry(song);
    expect(entry).not.toBeNull();
    const entryJson = JSON.stringify(entry);
    // 契约 1：条目里不允许出现任何 URL（临时音频 URL 或 provider 响应体里的链接）。
    expect(entryJson).not.toContain('http');

    const parsed = parsePortablePlaylist(serializePortablePlaylist('contract', [entry!]));
    expect(parsed.skippedCount).toBe(0);
    const rebuilt = playlistEntryToSong(parsed.entries[0]);
    expect(rebuilt).not.toBeNull();
    // 契约 2：重建件同样不携带 URL。
    expect(JSON.stringify(rebuilt)).not.toContain('http');
    return { entryJson, rebuilt: rebuilt! };
};

describe('netease minimal replay fields', () => {
    const song: SongResult = {
        id: 3000078,
        name: '测试曲目',
        artists: [{ id: 1, name: '测试歌手' }],
        album: { id: 2, name: '测试专辑' },
        durationMs: 200000,
        sourceRef: { kind: 'online', providerId: 'netease', mediaId: '3000078' },
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.netease.getSongUrl.mockResolvedValue({ data: [{ url: 'https://audio.example/ncm.mp3' }] });
        mocks.netease.getLyric.mockResolvedValue({});
    });

    it('requests audio and lyrics from the persisted id alone', async () => {
        const { entryJson, rebuilt } = roundTrip(song);

        // 只持久化身份 + 展示元数据，没有 providerData 也能回放（网易云只认 id）。
        expect(JSON.parse(entryJson)).toMatchObject({
            sourceRef: { kind: 'online', providerId: 'netease', mediaId: '3000078' },
            id: 3000078,
        });

        await neteaseProvider.playback!.getAudioSource!(rebuilt!, 'standard');
        expect(mocks.netease.getSongUrl).toHaveBeenCalledWith(3000078, expect.any(String));

        await neteaseProvider.lyrics!.getLyrics(rebuilt!);
        expect(mocks.netease.getLyric).toHaveBeenCalledWith(3000078);
    });
});

describe('kugou minimal replay fields', () => {
    const HASH = 'ABCDEF0123456789ABCDEF0123456789';
    const song: SongResult = {
        id: HASH,
        name: '测试曲目',
        artists: [{ id: 1, name: '测试歌手' }],
        album: { id: 2, name: '测试专辑' },
        durationMs: 200000,
        kgHash: HASH,
        sourceRef: {
            kind: 'online',
            providerId: 'kugou',
            mediaId: HASH,
            providerData: { hash: HASH, albumId: 'al-1', albumAudioId: 'aa-1' },
        },
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.kugou.requestKugou.mockResolvedValue({ data: [{ play_url: 'https://audio.example/kg.mp3' }] });
        mocks.kugou.requestKugouLegacyPlayInfo.mockResolvedValue({});
    });

    it('requests audio from hash + album ids kept in providerData, nothing else', async () => {
        const { entryJson, rebuilt } = roundTrip(song);

        const entry = JSON.parse(entryJson);
        expect(entry.sourceRef.providerData).toEqual({ hash: HASH, albumId: 'al-1', albumAudioId: 'aa-1' });
        // providerData 是契约字段，不是原始响应：只允许这三家声明过的键。
        expect(Object.keys(entry).sort()).toEqual(['albumName', 'artistNames', 'durationMs', 'id', 'name', 'sourceRef']);

        await kugouProvider.playback!.getAudioSource!(rebuilt!, 'standard');
        expect(mocks.kugou.requestKugou).toHaveBeenCalledTimes(1);
        const [operation, params] = mocks.kugou.requestKugou.mock.calls[0];
        expect(operation).toBe('song_url');
        expect(params).toMatchObject({ hash: HASH, album_id: 'al-1', album_audio_id: 'aa-1' });
    });

    it('rebuilds kgHash so the lyric lookup keeps its hash fallback', async () => {
        const { rebuilt } = roundTrip(song);
        expect(rebuilt!.kgHash).toBe(HASH);

        mocks.kugou.requestKugou.mockResolvedValue({ candidates: [] });
        await kugouProvider.lyrics!.getLyrics(rebuilt!);
        const [operation, params] = mocks.kugou.requestKugou.mock.calls[0];
        expect(operation).toBe('search_lyric');
        expect(params).toMatchObject({ hash: HASH, album_audio_id: 'aa-1', duration: 200000 });
    });
});

describe('qq minimal replay fields', () => {
    const song: SongResult = {
        id: 10086,
        name: '测试曲目',
        artists: [{ id: 1, name: '测试歌手' }],
        album: { id: 2, name: '测试专辑' },
        durationMs: 200000,
        qqMid: 'qqmid-1',
        sourceRef: {
            kind: 'online',
            providerId: 'qq',
            mediaId: 'qqmid-1',
            providerData: { songMid: 'qqmid-1', mediaMid: 'media-1', songId: 10086 },
        },
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.qq.requestQq.mockResolvedValue({
            data: { playUrl: { 'qqmid-1': { url: 'https://audio.example/qq.mp3' } } },
        });
        mocks.qqLyrics.fetchQQLyrics.mockResolvedValue(null);
    });

    it('requests audio from songMid/mediaMid and lyrics from songMid/songId', async () => {
        const { entryJson, rebuilt } = roundTrip(song);

        const entry = JSON.parse(entryJson);
        expect(entry.sourceRef.providerData).toEqual({ songMid: 'qqmid-1', mediaMid: 'media-1', songId: 10086 });

        await qqProvider.playback!.getAudioSource!(rebuilt!, 'standard');
        const [operation, params] = mocks.qq.requestQq.mock.calls[0];
        expect(operation).toBe('music_play');
        expect(params).toMatchObject({ songmid: 'qqmid-1', mediaId: 'media-1' });

        await qqProvider.lyrics!.getLyrics(rebuilt!);
        expect(mocks.qqLyrics.fetchQQLyrics).toHaveBeenCalledWith(expect.objectContaining({
            id: 10086,
            qqMid: 'qqmid-1',
        }));
    });
});

describe('entry persistence never stores provider payloads', () => {
    it('drops raw provider fields even when the queue song carries them', () => {
        const fat: SongResult = {
            id: 1,
            name: 'fat',
            artists: [{ id: 1, name: 'a' }],
            album: { id: 1, name: 'b', coverUrl: 'https://img.example/cover.jpg' },
            durationMs: 1000,
            sourceRef: { kind: 'online', providerId: 'netease', mediaId: '1' },
            privilege: { pl: 1, dl: 1 },
            noCopyrightRcmd: { typeDesc: 'x' },
            replayGain: { trackGain: -3 },
        } as SongResult;
        (fat as any).raw = { huge: 'provider response' };

        const entry = buildPlaylistEntry(fat)!;
        expect(Object.keys(entry).sort()).toEqual(['albumName', 'artistNames', 'coverUrl', 'durationMs', 'id', 'name', 'sourceRef']);
        expect((entry as any).privilege).toBeUndefined();
        expect((entry as any).raw).toBeUndefined();
        expect((entry as any).replayGain).toBeUndefined();
    });
});
