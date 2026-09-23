import type { TFunction } from 'i18next';
import type { LocalPlaylist, LocalSong, StatusMessage } from '../types';
import type { PlaylistEntry } from '../types/playlist';
import { createSafeObjectUrl } from '../utils/blobGuards';
import { sanitizeDownloadFileName } from '../utils/downloadFileName';
import { parsePlaylistEntry } from '../utils/playlistEntry';
import { parsePortablePlaylist, serializePortablePlaylist } from '../utils/portablePlaylistFormat';
import { importLocalPlaylistFile, normalizeM3uPath } from './localPlaylistFileService';
import { createLocalPlaylistFromEntries } from './localPlaylistService';

// src/services/portablePlaylistFileService.ts
// 便携歌单（JSON）的下载/导入，以及「一份歌单文件」的统一导入入口（m3u/m3u8/json）。
// 混合歌单只有 JSON 通道；纯本地歌单导出仍走 M3U8（localPlaylistFileService）。

export interface PlaylistFileImportResult {
    playlist: LocalPlaylist | null;
    format: 'json' | 'm3u8';
    name: string;
    matchedCount: number;
    skippedCount: number;
}

/** 便携歌单下载（混合歌单唯一的导出通道）。 */
export const downloadPortablePlaylist = (name: string, entries: PlaylistEntry[]): void => {
    const content = serializePortablePlaylist(name, entries);
    const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
    const url = createSafeObjectUrl(blob);
    if (!url) throw new Error('Failed to create playlist download');

    const link = document.createElement('a');
    link.href = url;
    link.download = `${sanitizeDownloadFileName(name, 'playlist')}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
};

// 本地条目对齐本机曲库：先按 songId，其次按可移植路径（换机导入场景）。
const resolveLocalEntry = (entry: PlaylistEntry, songById: Map<string, LocalSong>, pathIndex: Map<string, LocalSong>): PlaylistEntry | null => {
    const songId = entry.localSongId ?? entry.sourceRef.mediaId;
    const direct = songById.get(songId);
    if (direct) {
        return { ...entry, id: entry.id ?? direct.id, localSongId: direct.id, localPath: direct.filePath || entry.localPath, sourceRef: { kind: 'local', mediaId: direct.id } };
    }

    const targetPath = normalizeM3uPath(entry.localPath ?? '');
    const pathMatched = targetPath ? pathIndex.get(targetPath) : undefined;
    if (pathMatched) {
        return {
            ...entry,
            id: entry.id ?? pathMatched.id,
            localSongId: pathMatched.id,
            localPath: pathMatched.filePath || entry.localPath,
            sourceRef: { kind: 'local', mediaId: pathMatched.id },
        };
    }

    return null;
};

export const importPortablePlaylistFile = async (
    file: File,
    localSongs: LocalSong[],
): Promise<PlaylistFileImportResult> => {
    const text = await file.text();
    const parsed = parsePortablePlaylist(text);

    const songById = new Map(localSongs.map(song => [song.id, song]));
    const pathIndex = new Map<string, LocalSong>();
    localSongs.forEach(song => {
        const normalized = normalizeM3uPath(song.filePath ?? '');
        if (normalized && !pathIndex.has(normalized)) {
            pathIndex.set(normalized, song);
        }
    });

    let skippedCount = parsed.skippedCount;
    const entries: PlaylistEntry[] = [];
    parsed.entries.forEach(entry => {
        if (entry.sourceRef.kind === 'local') {
            const resolved = resolveLocalEntry(entry, songById, pathIndex);
            if (resolved) {
                entries.push(resolved);
            } else {
                skippedCount += 1;
            }
            return;
        }
        entries.push(entry);
    });

    if (entries.length === 0) {
        return { playlist: null, format: 'json', name: parsed.name, matchedCount: 0, skippedCount };
    }

    const playlist = await createLocalPlaylistFromEntries(parsed.name, entries.map(entry => parsePlaylistEntry(entry)).filter((entry): entry is PlaylistEntry => Boolean(entry)));
    return { playlist, format: 'json', name: parsed.name, matchedCount: entries.length, skippedCount };
};

/** 统一导入入口：`.json` 走便携歌单，其余按 M3U 解析。 */
export const importPlaylistFile = async (
    file: File,
    localSongs: LocalSong[],
): Promise<PlaylistFileImportResult> => {
    if (/\.json$/i.test(file.name) || file.type === 'application/json') {
        return importPortablePlaylistFile(file, localSongs);
    }

    const result = await importLocalPlaylistFile(file, localSongs);
    return {
        playlist: result.playlist,
        format: 'm3u8',
        name: result.playlist?.name || file.name.replace(/\.m3u8?$/i, '').trim() || 'Playlist',
        matchedCount: result.matchedSongIds.length,
        skippedCount: result.unmatchedPaths.length + result.ambiguousPaths.length,
    };
};

/** 导入结果 → 状态条消息（Grid3D 与 GridView 共用一份文案逻辑）。 */
export const buildPlaylistImportStatusMessage = (result: PlaylistFileImportResult, t: TFunction): StatusMessage => {
    if (!result.playlist) {
        return { type: 'error', text: t('localMusic.playlistImportNoMatches') };
    }

    return {
        type: result.skippedCount > 0 ? 'info' : 'success',
        text: result.skippedCount > 0
            ? t('localMusic.playlistImportPartial', {
                name: result.name,
                count: result.matchedCount,
                skipped: result.skippedCount,
            })
            : t('localMusic.playlistImportSuccess', {
                name: result.name,
                count: result.matchedCount,
            }),
    };
};
