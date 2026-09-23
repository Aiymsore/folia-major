import { describe, expect, it } from 'vitest';
import type { LocalSong, SongResult } from '../../../src/types';
import type { PlaylistEntry } from '../../../src/types/playlist';
import {
    buildPlaylistEntry,
    canPersistPlaylistEntry,
    getPlaylistEntryKey,
    localSongToPlaylistEntry,
    parsePlaylistEntry,
    playlistEntryToSong,
    resolvePlaylistEntrySongs,
} from '../../../src/utils/playlistEntry';

// test/unit/utils/playlistEntry.test.ts
// 队列曲目 ⇄ 歌单条目的编解码契约：五个来源各存什么、什么必须剔除、重建件要能播。

const display = {
    name: '曲目',
    artists: [{ id: 1, name: '歌手' }],
    album: { id: 1, name: '专辑', coverUrl: 'https://img.example/cover.jpg' },
    durationMs: 123456,
};

const localSongStub = (id: string, filePath: string) => ({
    id,
    filePath,
    title: '曲目',
    fileName: 'q.mp3',
    duration: 123456,
    titleOrigin: 'import',
    importedMetadata: { artistNames: ['歌手'], albumName: '专辑' },
} as unknown as LocalSong);

describe('buildPlaylistEntry', () => {
    it('keeps identity + display metadata for online songs', () => {
        const song = {
            ...display,
            id: 42,
            sourceRef: { kind: 'online', providerId: 'netease', mediaId: '42' },
        } as SongResult;

        expect(buildPlaylistEntry(song)).toEqual({
            sourceRef: { kind: 'online', providerId: 'netease', mediaId: '42' },
            name: '曲目',
            artistNames: ['歌手'],
            albumName: '专辑',
            durationMs: 123456,
            coverUrl: 'https://img.example/cover.jpg',
            id: 42,
        });
    });

    it('stores local entries with songId and a portable path from the library', () => {
        const song = {
            ...display,
            id: -123,
            isLocal: true,
            localRef: { songId: 'ls-1' },
            sourceRef: { kind: 'local', mediaId: 'ls-1' },
        } as SongResult;

        const entry = buildPlaylistEntry(song, { localSongs: [localSongStub('ls-1', 'Root/a.mp3')] });
        expect(entry).toMatchObject({
            sourceRef: { kind: 'local', mediaId: 'ls-1' },
            localSongId: 'ls-1',
            localPath: 'Root/a.mp3',
        });
    });

    it('keeps navidrome identity without the transient streamUrl', () => {
        const song = {
            ...display,
            id: 7,
            isNavidrome: true,
            navidromeData: {
                id: 'nd-7',
                streamUrl: 'https://stream.example/expire.mp3',
                suffix: 'mp3',
                albumId: 'al-7',
                artistId: 'ar-7',
                path: '/music/q.mp3',
            },
            sourceRef: { kind: 'navidrome', mediaId: 'nd-7' },
        } as SongResult;

        const entry = buildPlaylistEntry(song)!;
        expect(entry.navidrome).toEqual({ id: 'nd-7', suffix: 'mp3', albumId: 'al-7', artistId: 'ar-7' });
        expect(JSON.stringify(entry)).not.toContain('stream.example');
    });

    it('keeps external-media tracks only when a catalog id resolves playback', () => {
        const base = {
            ...display,
            sourceRef: { kind: 'external-media', mediaId: 'am-1' },
            externalMediaId: 'am-1',
        } as SongResult;

        const playable = {
            ...base,
            id: 9,
            externalMediaCatalogId: 'cat-9',
            externalMediaUrl: 'https://music.apple.com/song/9',
        } as SongResult;
        expect(buildPlaylistEntry(playable)).toMatchObject({
            externalMedia: { externalMediaId: 'am-1', catalogId: 'cat-9' },
        });

        const libraryUpload = { ...base, id: 10, externalMediaCatalogId: null } as SongResult;
        // 资料库上传曲目没有 catalogId，`playById` 无从寻址 → 不可回放，保存时剔除。
        expect(buildPlaylistEntry(libraryUpload)).toBeNull();
        expect(canPersistPlaylistEntry(libraryUpload)).toBe(false);
    });

    it('drops stage sessions and nameless songs (decision: unplayable entries never persist)', () => {
        const stage = {
            ...display,
            id: 1,
            sourceRef: { kind: 'stage', mediaId: 'stage-1' },
        } as SongResult;
        expect(buildPlaylistEntry(stage)).toBeNull();
        expect(canPersistPlaylistEntry(stage)).toBe(false);

        const nameless = { ...display, name: '  ', id: 1, sourceRef: { kind: 'online', providerId: 'netease', mediaId: '1' } } as SongResult;
        expect(buildPlaylistEntry(nameless)).toBeNull();
    });

    it('backfills kgHash/qqMid named fallbacks into providerData', () => {
        const legacy: SongResult = {
            ...display,
            id: 'HASH1',
            kgHash: 'HASH1',
            sourceRef: { kind: 'online', providerId: 'kugou', mediaId: 'HASH1' },
        } as SongResult;
        expect(buildPlaylistEntry(legacy)!.sourceRef).toMatchObject({
            providerData: { hash: 'HASH1' },
        });

        const qqLegacy: SongResult = {
            ...display,
            id: 11,
            qqMid: 'mid-11',
            sourceRef: { kind: 'online', providerId: 'qq', mediaId: 'mid-11' },
        } as SongResult;
        expect(buildPlaylistEntry(qqLegacy)!.sourceRef).toMatchObject({
            providerData: { songMid: 'mid-11' },
        });
    });
});

describe('playlistEntryToSong', () => {
    it('rebuilds a playable local song carrying localRef', () => {
        const entry: PlaylistEntry = {
            sourceRef: { kind: 'local', mediaId: 'ls-1' },
            name: '曲目',
            artistNames: ['歌手'],
            durationMs: 1,
            localSongId: 'ls-1',
        };
        const song = playlistEntryToSong(entry)!;
        expect((song as any).isLocal).toBe(true);
        expect((song as any).localRef).toEqual({ songId: 'ls-1' });
        expect(song.sourceRef).toEqual({ kind: 'local', mediaId: 'ls-1' });
    });

    it('rebuilds navidrome songs without a streamUrl (playback re-resolves it)', () => {
        const entry: PlaylistEntry = {
            sourceRef: { kind: 'navidrome', mediaId: 'nd-7' },
            name: '曲目',
            artistNames: [],
            durationMs: 1,
            navidrome: { id: 'nd-7' },
        };
        const song = playlistEntryToSong(entry) as any;
        expect(song.isNavidrome).toBe(true);
        expect(song.navidromeData.id).toBe('nd-7');
        expect(song.navidromeData.streamUrl).toBe('');
    });

    it('rebuilds external-media songs with the catalog id playById needs', () => {
        const entry: PlaylistEntry = {
            sourceRef: { kind: 'external-media', mediaId: 'am-1' },
            name: '曲目',
            artistNames: [],
            durationMs: 1,
            externalMedia: { externalMediaId: 'am-1', catalogId: 'cat-9', url: 'https://music.apple.com/song/9' },
        };
        const song = playlistEntryToSong(entry) as any;
        expect(song.externalMediaCatalogId).toBe('cat-9');
        expect(song.externalMediaId).toBe('am-1');
    });

    it('mirrors kugou hash and qq songMid back onto the rebuilt song', () => {
        const kugou: PlaylistEntry = {
            sourceRef: { kind: 'online', providerId: 'kugou', mediaId: 'HASH1', providerData: { hash: 'HASH1' } },
            name: '曲目',
            artistNames: [],
            durationMs: 1,
        };
        expect((playlistEntryToSong(kugou) as any).kgHash).toBe('HASH1');

        const qq: PlaylistEntry = {
            sourceRef: { kind: 'online', providerId: 'qq', mediaId: 'mid-11', providerData: { songMid: 'mid-11' } },
            name: '曲目',
            artistNames: [],
            durationMs: 1,
        };
        expect((playlistEntryToSong(qq) as any).qqMid).toBe('mid-11');
    });
});

describe('parsePlaylistEntry', () => {
    it('rejects garbage instead of letting it reach the playback path', () => {
        expect(parsePlaylistEntry(null)).toBeNull();
        expect(parsePlaylistEntry({})).toBeNull();
        expect(parsePlaylistEntry({ sourceRef: { kind: 'stage', mediaId: 'x' }, name: 'a' })).toBeNull();
        expect(parsePlaylistEntry({ sourceRef: { kind: 'online', providerId: '', mediaId: '' }, name: 'a' })).toBeNull();
        expect(parsePlaylistEntry({ sourceRef: { kind: 'local', mediaId: 'x' } })).toBeNull();
        // external-media 没有 catalogId 就不可回放，拒绝入库。
        expect(parsePlaylistEntry({
            sourceRef: { kind: 'external-media', mediaId: 'am-1' },
            name: 'a',
            externalMedia: { externalMediaId: 'am-1' },
        })).toBeNull();
    });

    it('derives local/navidrome identity from sourceRef when the sidecar is missing', () => {
        const local = parsePlaylistEntry({
            sourceRef: { kind: 'local', mediaId: 'ls-9' },
            name: 'a',
            durationMs: '500',
        })!;
        expect(local.localSongId).toBe('ls-9');
        expect(local.durationMs).toBe(500);

        const navidrome = parsePlaylistEntry({
            sourceRef: { kind: 'navidrome', mediaId: 'nd-9' },
            name: 'a',
        })!;
        expect(navidrome.navidrome).toEqual({ id: 'nd-9' });
    });
});

describe('helpers', () => {
    it('keys entries in the same namespace as queue songs', () => {
        expect(getPlaylistEntryKey({
            sourceRef: { kind: 'online', providerId: 'qq', mediaId: 'mid' },
            name: 'a',
            artistNames: [],
            durationMs: 0,
        })).toBe('online:qq:mid');
    });

    it('converts local library records for legacy-playlist materialization', () => {
        expect(localSongToPlaylistEntry(localSongStub('ls-2', 'Root/b.mp3'))).toMatchObject({
            sourceRef: { kind: 'local', mediaId: 'ls-2' },
            localSongId: 'ls-2',
            localPath: 'Root/b.mp3',
        });
    });

    it('resolves entries in playlist order and counts what cannot resolve', () => {
        const entries: PlaylistEntry[] = [
            { sourceRef: { kind: 'online', providerId: 'netease', mediaId: '1' }, name: 'n1', artistNames: [], durationMs: 0 },
            { sourceRef: { kind: 'external-media', mediaId: 'am-x' }, name: 'gone', artistNames: [], durationMs: 0, externalMedia: undefined as never },
            { sourceRef: { kind: 'local', mediaId: 'ls-1' }, name: 'l1', artistNames: [], durationMs: 0, localSongId: 'ls-1' },
        ];
        const { songs, unresolvedCount } = resolvePlaylistEntrySongs(entries);
        expect(songs.map(song => song.name)).toEqual(['n1', 'l1']);
        expect(unresolvedCount).toBe(1);
    });
});
