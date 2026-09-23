import type { PlaylistEntry, PortablePlaylistFile } from '../types/playlist';
import { PORTABLE_PLAYLIST_FORMAT, PORTABLE_PLAYLIST_FORMAT_VERSION } from '../types/playlist';
import { parsePlaylistEntry } from './playlistEntry';

// src/utils/portablePlaylistFormat.ts
// 便携歌单文件（`.json`）的序列化与解析。
//
// 信封坏了整体拒绝（不是 Folia 歌单文件就没必要猜）；条目坏了逐条跳过并计数，
// 与 M3U 导入的「matched/unmatched」报告语义一致。混合歌单只走这条 JSON 通道，
// 不做 M3U8 `#EXTINF` + 深链降级（那会把「能不能播」问题藏进文本格式里）。

export interface PortablePlaylistParseResult {
    name: string;
    entries: PlaylistEntry[];
    skippedCount: number;
}

export const serializePortablePlaylist = (name: string, entries: PlaylistEntry[]): string => {
    const file: PortablePlaylistFile = {
        format: PORTABLE_PLAYLIST_FORMAT,
        formatVersion: PORTABLE_PLAYLIST_FORMAT_VERSION,
        name: name || 'Playlist',
        exportedAt: Date.now(),
        entries,
    };
    return `${JSON.stringify(file, null, 2)}\n`;
};

export const parsePortablePlaylist = (text: string): PortablePlaylistParseResult => {
    let raw: unknown;
    try {
        raw = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch {
        throw new Error('INVALID_PLAYLIST_FILE');
    }
    if (typeof raw !== 'object' || raw === null) {
        throw new Error('INVALID_PLAYLIST_FILE');
    }

    const envelope = raw as Record<string, unknown>;
    if (envelope.format !== PORTABLE_PLAYLIST_FORMAT) {
        throw new Error('INVALID_PLAYLIST_FILE');
    }
    const formatVersion = Number(envelope.formatVersion);
    if (!Number.isInteger(formatVersion) || formatVersion < 1 || formatVersion > PORTABLE_PLAYLIST_FORMAT_VERSION) {
        throw new Error('UNSUPPORTED_PLAYLIST_VERSION');
    }
    if (!Array.isArray(envelope.entries)) {
        throw new Error('INVALID_PLAYLIST_FILE');
    }

    const entries: PlaylistEntry[] = [];
    let skippedCount = 0;
    envelope.entries.forEach(item => {
        const entry = parsePlaylistEntry(item);
        if (entry) {
            entries.push(entry);
        } else {
            skippedCount += 1;
        }
    });

    const name = typeof envelope.name === 'string' && envelope.name.trim() !== ''
        ? envelope.name.trim()
        : 'Playlist';

    return { name, entries, skippedCount };
};
