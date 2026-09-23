import { describe, expect, it } from 'vitest';
import type { PlaylistEntry } from '../../../src/types/playlist';
import { PORTABLE_PLAYLIST_FORMAT, PORTABLE_PLAYLIST_FORMAT_VERSION } from '../../../src/types/playlist';
import { parsePortablePlaylist, serializePortablePlaylist } from '../../../src/utils/portablePlaylistFormat';

// test/unit/utils/portablePlaylistFormat.test.ts
// 便携歌单文件的信封契约：坏了整体拒绝，条目坏了逐条跳过并计数，formatVersion 必须存在。

const entry = (overrides: Partial<PlaylistEntry> = {}): PlaylistEntry => ({
    sourceRef: { kind: 'online', providerId: 'netease', mediaId: '1' },
    name: '曲目',
    artistNames: ['歌手'],
    durationMs: 1000,
    ...overrides,
});

describe('serializePortablePlaylist', () => {
    it('writes a versioned envelope with name and entries', () => {
        const parsed = JSON.parse(serializePortablePlaylist('我的歌单', [entry()]));
        expect(parsed.format).toBe(PORTABLE_PLAYLIST_FORMAT);
        expect(parsed.formatVersion).toBe(PORTABLE_PLAYLIST_FORMAT_VERSION);
        expect(parsed.name).toBe('我的歌单');
        expect(parsed.entries).toHaveLength(1);
    });
});

describe('parsePortablePlaylist', () => {
    it('round-trips entries across the five replayable sources', () => {
        const entries: PlaylistEntry[] = [
            entry(),
            entry({ sourceRef: { kind: 'local', mediaId: 'ls-1' }, name: 'l', localSongId: 'ls-1', localPath: 'Root/a.mp3' }),
            entry({ sourceRef: { kind: 'navidrome', mediaId: 'nd-1' }, name: 'n', navidrome: { id: 'nd-1', suffix: 'mp3' } }),
            entry({
                sourceRef: { kind: 'external-media', mediaId: 'am-1' },
                name: 'e',
                externalMedia: { externalMediaId: 'am-1', catalogId: 'cat-1', url: null, hasLyrics: false },
            }),
            entry({
                sourceRef: { kind: 'online', providerId: 'kugou', mediaId: 'HASH', providerData: { hash: 'HASH', albumId: 'al' } },
                name: 'k',
            }),
        ];

        const result = parsePortablePlaylist(serializePortablePlaylist('混音', entries));
        expect(result.skippedCount).toBe(0);
        expect(result.name).toBe('混音');
        expect(result.entries).toEqual(entries);
    });

    it('rejects a broken envelope instead of guessing', () => {
        expect(() => parsePortablePlaylist('not json')).toThrow('INVALID_PLAYLIST_FILE');
        expect(() => parsePortablePlaylist('{"format":"other","entries":[]}')).toThrow('INVALID_PLAYLIST_FILE');
        expect(() => parsePortablePlaylist(`{"format":"${PORTABLE_PLAYLIST_FORMAT}","formatVersion":${PORTABLE_PLAYLIST_FORMAT_VERSION},"entries":{}}`)).toThrow('INVALID_PLAYLIST_FILE');
        expect(() => parsePortablePlaylist(`{"format":"${PORTABLE_PLAYLIST_FORMAT}","formatVersion":99,"entries":[]}`)).toThrow('UNSUPPORTED_PLAYLIST_VERSION');
    });

    it('skips broken entries and counts them, tolerating a BOM', () => {
        const text = serializePortablePlaylist('p', [
            entry(),
            entry({ sourceRef: { kind: 'stage', mediaId: 'x' } as never }),
            { nope: true } as never,
        ]);
        const result = parsePortablePlaylist(`\uFEFF${text}`);
        expect(result.entries).toHaveLength(1);
        expect(result.skippedCount).toBe(2);
    });
});
