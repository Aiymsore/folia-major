import type { LocalSong, SongResult } from '../types';
import type { JsonValue, MediaId, PlaybackSourceRef } from '../types/onlineMusic';
import type { PlaylistEntry, PlaylistExternalMediaRef, PlaylistNavidromeRef } from '../types/playlist';
import { readAppleMusicSongPayload } from '../services/appleMusicService';
import {
    getPlaybackSourceRef,
    getPlaybackSourceRefKey,
    isExternalMediaPlaybackSong,
    isLocalPlaybackSong,
    isNavidromePlaybackSong,
    isStagePlaybackSong,
    resolveNavidromePlaybackCarrier,
} from './appPlaybackGuards';

// src/utils/playlistEntry.ts
// 队列曲目 ⇄ 跨来源歌单条目的纯函数编解码：判「能不能存」、存什么、怎么重建。
//
// 保存方向（buildPlaylistEntry）是**有损**的：只留身份 + 最小可回放字段 + 展示元数据，
// 不可回放的曲目（stage、无 catalogId 的资料库上传曲目）返回 null，由调用方剔除并计数。
// 重建方向（playlistEntryToSong）产出的是「够播、够显示」的 SongResult：播放路径会按
// sourceRef 再解析真实音频（omni.getAudioSource / navidromeApi.getStreamUrl / playById），
// 所以这里绝不生成音频 URL。

type BuildOptions = { localSongs?: LocalSong[] };

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/** KuGou/QQ 的具名回退字段（kgHash/qqMid）回填进 providerData，保证重建后旧路径也能解析。 */
const backfillOnlineProviderData = (
    song: SongResult,
    sourceRef: Extract<PlaybackSourceRef, { kind: 'online' }>,
): Extract<PlaybackSourceRef, { kind: 'online' }> => {
    const providerData: Record<string, JsonValue> = { ...(sourceRef.providerData ?? {}) };
    let changed = false;
    if (!providerData.hash && isNonEmptyString(song.kgHash)) {
        providerData.hash = song.kgHash;
        changed = true;
    }
    if (!providerData.songMid && isNonEmptyString(song.qqMid)) {
        providerData.songMid = song.qqMid;
        changed = true;
    }
    return changed ? { ...sourceRef, providerData } : sourceRef;
};

/**
 * 能否把这首曲目写进歌单（结构上存在回放路径）。
 * 与 `buildPlaylistEntry` 同源，UI 的可用性判据与保存行为必须一致。
 */
export const canPersistPlaylistEntry = (song: SongResult | null | undefined): boolean => (
    buildPlaylistEntry(song) !== null
);

/** 队列曲目 → 歌单条目。不可回放返回 null（stage、无 catalogId 的 external-media 等）。 */
export const buildPlaylistEntry = (
    song: SongResult | null | undefined,
    options: BuildOptions = {},
): PlaylistEntry | null => {
    if (!song) return null;
    const name = (song.name ?? '').trim();
    if (!name) return null;

    const artistNames = (song.artists ?? [])
        .map(artist => (artist?.name ?? '').trim())
        .filter(Boolean);
    const albumName = (song.album?.name ?? '').trim();
    const coverUrl = song.album?.coverUrl ?? null;
    const durationMs = Number.isFinite(song.durationMs) ? Math.max(0, Math.round(song.durationMs)) : 0;
    const display = {
        name,
        artistNames,
        ...(albumName ? { albumName } : {}),
        durationMs,
        ...(coverUrl ? { coverUrl } : {}),
    };

    // Stage 会话是瞬态的，没有任何回放路径能重建它。
    if (isStagePlaybackSong(song)) return null;

    if (isExternalMediaPlaybackSong(song)) {
        const payload = readAppleMusicSongPayload(song);
        // 刻意比 resolveExternalMediaPlayableId 严格：那里 `catalogId || externalMediaId` 的兜底
        // 会把资料库上传曲目的 `a.<n>` 行 id 当可播 id，但 playById 打目录 404（docs/
        // apple-music-library.md 实测）。持久化只认 catalogId —— 没有它就没有任何回放路径。
        const catalogId = payload?.catalogId ?? null;
        if (!payload?.externalMediaId || !catalogId) return null;
        const externalMedia: PlaylistExternalMediaRef = {
            externalMediaId: payload.externalMediaId,
            catalogId,
            url: payload.url,
            hasLyrics: payload.hasLyrics,
        };
        return {
            ...display,
            sourceRef: { kind: 'external-media', mediaId: payload.externalMediaId },
            id: song.id,
            externalMedia,
        };
    }

    if (isLocalPlaybackSong(song)) {
        const songId = song.localRef?.songId;
        if (!isNonEmptyString(songId)) return null;
        const localSong = options.localSongs?.find(candidate => candidate.id === songId);
        return {
            ...display,
            sourceRef: { kind: 'local', mediaId: songId },
            id: song.id,
            localSongId: songId,
            ...(localSong?.filePath ? { localPath: localSong.filePath } : {}),
        };
    }

    const navidromeCarrier = isNavidromePlaybackSong(song) ? resolveNavidromePlaybackCarrier(song) : null;
    if (navidromeCarrier) {
        const data = navidromeCarrier.navidromeData;
        const navidromeId = isNonEmptyString(data?.id) ? data.id : String(data?.id ?? '');
        if (!navidromeId) return null;
        const navidrome: PlaylistNavidromeRef = {
            id: navidromeId,
            ...(data.suffix ? { suffix: data.suffix } : {}),
            ...(data.coverArtUrl ? { coverArtUrl: data.coverArtUrl } : {}),
            ...(data.albumId ? { albumId: data.albumId } : {}),
            ...(data.artistId ? { artistId: data.artistId } : {}),
        };
        return {
            ...display,
            sourceRef: { kind: 'navidrome', mediaId: navidromeId },
            id: song.id,
            navidrome,
        };
    }

    const sourceRef = getPlaybackSourceRef(song);
    if (sourceRef.kind !== 'online') return null;
    const mediaId = sourceRef.mediaId || String(song.id ?? '');
    if (!mediaId) return null;
    return {
        ...display,
        sourceRef: backfillOnlineProviderData(song, { ...sourceRef, mediaId }),
        id: song.id,
    };
};

/** 歌单条目 → 够播、够显示的 `SongResult`。音频 URL 由播放路径按 sourceRef 现取。 */
export const playlistEntryToSong = (
    entry: PlaylistEntry | null | undefined,
    options: BuildOptions = {},
): SongResult | null => {
    const valid = parsePlaylistEntry(entry);
    if (!valid) return null;

    const artists = valid.artistNames.map((name, index) => ({ id: index, name }));
    const album = {
        id: 0,
        name: valid.albumName ?? '',
        ...(valid.coverUrl ? { coverUrl: valid.coverUrl } : {}),
    };
    const base: SongResult = {
        id: valid.id ?? valid.sourceRef.mediaId,
        name: valid.name,
        artists,
        album,
        durationMs: valid.durationMs,
        sourceRef: valid.sourceRef,
    };

    switch (valid.sourceRef.kind) {
        case 'local': {
            const songId = valid.localSongId ?? valid.sourceRef.mediaId;
            const localSong = options.localSongs?.find(candidate => candidate.id === songId);
            return {
                ...base,
                id: valid.id ?? (localSong ? String(localSong.id) : songId),
                sourceRef: { kind: 'local', mediaId: songId },
                isLocal: true,
                localRef: { songId },
            } as SongResult;
        }
        case 'navidrome': {
            const navidrome = valid.navidrome ?? { id: valid.sourceRef.mediaId };
            return {
                ...base,
                id: valid.id ?? navidrome.id,
                sourceRef: { kind: 'navidrome', mediaId: navidrome.id },
                isNavidrome: true,
                // 故意不带 streamUrl：它会过期，onPlayNavidromeSong 按 navidromeData.id 现算。
                navidromeData: {
                    id: navidrome.id,
                    streamUrl: '',
                    coverArtUrl: navidrome.coverArtUrl ?? undefined,
                    albumId: navidrome.albumId != null ? String(navidrome.albumId) : '',
                    artistId: navidrome.artistId != null ? String(navidrome.artistId) : '',
                    path: '',
                    suffix: navidrome.suffix ?? '',
                },
            } as SongResult;
        }
        case 'external-media': {
            const externalMedia = valid.externalMedia;
            if (!externalMedia) return null;
            return {
                ...base,
                id: valid.id ?? externalMedia.externalMediaId,
                sourceRef: { kind: 'external-media', mediaId: externalMedia.externalMediaId },
                externalMediaId: externalMedia.externalMediaId,
                externalMediaCatalogId: externalMedia.catalogId,
                externalMediaUrl: externalMedia.url ?? null,
                externalMediaHasLyrics: Boolean(externalMedia.hasLyrics),
            } as SongResult;
        }
        case 'online': {
            // KuGou 歌词/副歌回退读 `song.kgHash ?? song.id`、QQ 歌词读 `song.qqMid || sourceRef.mediaId`：
            // 把 providerData 里的具名回退字段镜像回歌曲对象，重建件与原队列件的解析行为一致。
            const providerData = valid.sourceRef.kind === 'online' ? valid.sourceRef.providerData ?? {} : {};
            const providerId = valid.sourceRef.kind === 'online' ? valid.sourceRef.providerId : '';
            const extras: Partial<SongResult> = {};
            if (providerId === 'kugou' && typeof providerData.hash === 'string' && providerData.hash) {
                extras.kgHash = providerData.hash;
            }
            if (providerId === 'qq') {
                const songMid = typeof providerData.songMid === 'string' && providerData.songMid
                    ? providerData.songMid
                    : valid.sourceRef.mediaId;
                extras.qqMid = songMid;
            }
            return { ...base, ...extras };
        }
        default:
            return null;
    }
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => (
    Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const optionalString = (value: unknown): string | undefined => (
    typeof value === 'string' && value.trim() !== '' ? value : undefined
);

const optionalMediaId = (value: unknown): MediaId | undefined => (
    (typeof value === 'string' && value !== '') || (typeof value === 'number' && Number.isFinite(value))
        ? value
        : undefined
);

const parseSourceRef = (value: unknown): PlaybackSourceRef | null => {
    if (!isPlainObject(value)) return null;
    const kind = value.kind;
    if (kind === 'online') {
        const providerId = optionalString(value.providerId);
        const mediaId = optionalString(value.mediaId);
        if (!providerId || !mediaId) return null;
        const providerData = isPlainObject(value.providerData) ? value.providerData as Record<string, JsonValue> : undefined;
        const variant = optionalString(value.variant);
        return {
            kind: 'online',
            providerId,
            mediaId,
            ...(variant ? { variant } : {}),
            ...(providerData ? { providerData } : {}),
        };
    }
    if (kind === 'local' || kind === 'navidrome' || kind === 'external-media') {
        const mediaId = optionalString(value.mediaId);
        return mediaId ? { kind, mediaId } : null;
    }
    // stage 及未知来源一律拒绝：它们没有回放路径。
    return null;
};

/**
 * 便携文件 / 持久化数据 → 条目。形状不合法返回 null（调用方计数跳过），不抛错。
 * 逐字段校验：宁可少一首，不给歌单放进一条会炸播放路径的记录。
 */
export const parsePlaylistEntry = (value: unknown): PlaylistEntry | null => {
    if (!isPlainObject(value)) return null;
    const sourceRef = parseSourceRef(value.sourceRef);
    if (!sourceRef) return null;

    const name = optionalString(value.name);
    if (!name) return null;

    const artistNames = Array.isArray(value.artistNames)
        ? value.artistNames.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
        : [];
    const durationMsRaw = Number(value.durationMs);
    const durationMs = Number.isFinite(durationMsRaw) ? Math.max(0, Math.round(durationMsRaw)) : 0;

    const entry: PlaylistEntry = {
        sourceRef,
        name: name.trim(),
        artistNames,
        durationMs,
        ...(optionalString(value.albumName) ? { albumName: optionalString(value.albumName) } : {}),
        ...(optionalString(value.coverUrl) ? { coverUrl: value.coverUrl as string } : {}),
        ...(optionalMediaId(value.id) !== undefined ? { id: optionalMediaId(value.id) } : {}),
        ...(optionalString(value.localPath) ? { localPath: value.localPath as string } : {}),
    };

    if (sourceRef.kind === 'local') {
        const localSongId = optionalString(value.localSongId) ?? sourceRef.mediaId;
        entry.localSongId = localSongId;
        entry.sourceRef = { kind: 'local', mediaId: localSongId };
    }

    if (sourceRef.kind === 'navidrome') {
        const navidrome = isPlainObject(value.navidrome) ? value.navidrome : {};
        const navidromeId = optionalString(navidrome.id) ?? sourceRef.mediaId;
        const parsed: PlaylistNavidromeRef = {
            id: navidromeId,
            ...(optionalString(navidrome.suffix) ? { suffix: navidrome.suffix as string } : {}),
            ...(optionalString(navidrome.coverArtUrl) ? { coverArtUrl: navidrome.coverArtUrl as string } : {}),
            ...(navidrome.albumId !== undefined && navidrome.albumId !== null ? { albumId: navidrome.albumId as string | number } : {}),
            ...(navidrome.artistId !== undefined && navidrome.artistId !== null ? { artistId: navidrome.artistId as string | number } : {}),
        };
        entry.navidrome = parsed;
        entry.sourceRef = { kind: 'navidrome', mediaId: navidromeId };
    }

    if (sourceRef.kind === 'external-media') {
        const externalMedia = isPlainObject(value.externalMedia) ? value.externalMedia : {};
        const externalMediaId = optionalString(externalMedia.externalMediaId) ?? sourceRef.mediaId;
        const catalogId = optionalString(externalMedia.catalogId);
        if (!catalogId) return null;
        const parsed: PlaylistExternalMediaRef = {
            externalMediaId,
            catalogId,
            url: typeof externalMedia.url === 'string' ? externalMedia.url : null,
            hasLyrics: Boolean(externalMedia.hasLyrics),
        };
        entry.externalMedia = parsed;
        entry.sourceRef = { kind: 'external-media', mediaId: externalMediaId };
    }

    return entry;
};

/** 条目身份键，与 `getPlaybackSongKey` 同一命名空间（复用 `getPlaybackSourceRefKey`）。 */
export const getPlaylistEntryKey = (entry: PlaylistEntry): string => (
    getPlaybackSourceRefKey(entry.sourceRef)
);

/** LocalSong 记录 → 本地条目（旧 songIds 歌单在首次引入跨来源条目时用它具象化）。 */
export const localSongToPlaylistEntry = (localSong: LocalSong): PlaylistEntry => ({
    sourceRef: { kind: 'local', mediaId: localSong.id },
    name: localSong.title || localSong.fileName,
    artistNames: (localSong.titleOrigin === 'import'
        ? localSong.importedMetadata.artistNames
        : localSong.onlineMetadata?.artists.map(artist => artist.name) || localSong.importedMetadata.artistNames) || [],
    ...(localSong.importedMetadata.albumName ? { albumName: localSong.importedMetadata.albumName } : {}),
    durationMs: localSong.duration,
    id: localSong.id,
    localSongId: localSong.id,
    ...(localSong.filePath ? { localPath: localSong.filePath } : {}),
});

/**
 * entries 歌单 → 播放/显示用歌曲列表（保持歌单顺序）。
 * 解析不出回放路径的条目跳过并计数（本地文件不在曲库等），条目本身仍留在歌单里。
 */
export const resolvePlaylistEntrySongs = (
    entries: PlaylistEntry[] | null | undefined,
    localSongs: LocalSong[] = [],
): { songs: SongResult[]; unresolvedCount: number } => {
    const songs: SongResult[] = [];
    let unresolvedCount = 0;

    (entries ?? []).forEach(entry => {
        const song = playlistEntryToSong(entry, { localSongs });
        if (song) {
            songs.push(song);
        } else {
            unresolvedCount += 1;
        }
    });

    return { songs, unresolvedCount };
};
