import type React from 'react';
import { LocalLibraryGroup, LocalSong, SongResult } from '../../../types';
import { navidromeApi, getNavidromeConfig } from '../../../services/navidromeService';
import { LIST_ROW_COVER_SIZE, buildLocalQueue, buildNavidromeQueue } from '../../../services/playbackAdapters';
import { SubsonicSong } from '../../../types/navidrome';
import { sortLocalFolderSongs } from '../../../utils/localSongSorting';
import type { LocalLibraryAssignment, LocalLibraryEntity } from '../../../types/localLibrary';
import type {
    OnlineProviderId,
    ProviderArtistSummary,
    ProviderCollection,
    ProviderUser,
} from '../../../types/onlineMusic';
import { buildLocalLibraryIndex, followEntityRedirect } from '../../../utils/localLibraryIndex';
import { getLocalCoverAssetUrl } from '../../../services/localCoverAssetUrl';
import type { PlaylistEntry } from '../../../types/playlist';
import { resolvePlaylistEntrySongs } from '../../../utils/playlistEntry';
import {
    getAppleMusicAlbumTracks,
    getAppleMusicPlaylistTracks,
    resolveAppleMusicCatalogFields,
    toAppleMusicSongResult,
} from '../../../services/appleMusicService';

// src/components/app/home/gridViewCollectionAdapters.ts
// Converts home-surface collections into small GridView descriptors and resolves non-Netease tracks outside GridView.

// `source` names the CONTENT source (where a collection was read from), which is a different axis
// from the playback backend (`src/types/playbackBackend.ts`). Apple Music stays `'apple-music'`
// here even though the backend that plays its tracks is now `'external-media'`: browsing the user's
// Apple Music library is still an Apple Music concern, and the two names must not be conflated.
export type GridViewCollectionSource = 'online' | 'local' | 'navidrome' | 'apple-music';
export type NavidromeGridViewCollectionType = 'album' | 'playlist' | 'artist' | 'random' | 'favorites';
export type AppleMusicGridViewCollectionType = 'album' | 'playlist';

/**
 * 一个集合的稳定身份：来源 + 类型 + id。
 *
 * 两个用途共用它：作 GridView / ArtistGridView 的 React key，以及判断「这次 push 的目标
 * 是不是已经在看的那一层」。后者是必须的 —— 专辑详情里的曲目卡片带着自己的专辑入口，
 * 点它等于再压一层同一张专辑，返回要按很多次才能退出去；歌手页的曲目卡片带着同一张歌手
 * 的入口，同理。两处各写一份 key 迟早会分叉，所以放在这里。
 */
export const collectionKey = (
    collection: Pick<BaseGridViewCollectionDescriptor, 'source' | 'type' | 'id'> | null | undefined,
): string => (
    collection ? `${collection.source}:${collection.type}:${String(collection.id)}` : ''
);

export interface BaseGridViewCollectionDescriptor {
    source: GridViewCollectionSource;
    id: string | number;
    name: string;
    type: string;
    coverUrl?: string;
    description?: string;
    trackCount?: number;
    albumCount?: number;
    isOwned?: boolean;
    artists?: ProviderArtistSummary[];
    aliases?: string[];
    publishedAt?: number;
    publisher?: string;
    playCount?: number;
    updatedAt?: number;
    tracksUpdatedAt?: number;
    isLiked?: boolean;
    providerData?: ProviderCollection['providerData'];
    creator?: ProviderUser;
    albumArtist?: string;
    albumYear?: number;
    albumGenre?: string;
    albumDuration?: number;
    albumCompany?: string;
    albumPublishTime?: number;
}

export interface LocalGridViewCollectionDescriptor extends BaseGridViewCollectionDescriptor {
    source: 'local';
    type: LocalLibraryGroup['type'];
    id: string;
    songIds: string[];
    /** 跨来源歌单（LocalPlaylist.entries）的条目；有值时曲目以它为准，songIds 仅是本地子集。 */
    entries?: PlaylistEntry[];
    entityId?: string;
    playlistId?: string;
    isVirtual?: boolean;
}

export interface NavidromeGridViewCollectionDescriptor extends BaseGridViewCollectionDescriptor {
    source: 'navidrome';
    type: NavidromeGridViewCollectionType;
    id: string;
    editable?: boolean;
}

export interface OnlineGridViewCollectionDescriptor extends BaseGridViewCollectionDescriptor {
    source: 'online';
    providerId: OnlineProviderId;
    raw?: any;
}

/**
 * Apple Music collection descriptor.
 *
 * Apple Music is deliberately a fourth *collection source* rather than an Omni provider: it has no
 * `providerId`, so it can never be passed to `switchProvider` or routed through `omni`. That
 * mirrors the rule recorded in `src/types/playbackBackend.ts` and the `navidromeService` precedent.
 */
export interface AppleMusicGridViewCollectionDescriptor extends BaseGridViewCollectionDescriptor {
    source: 'apple-music';
    type: AppleMusicGridViewCollectionType;
    id: string;
    /** True when the collection comes from the user's library rather than the public catalog. */
    isLibrary: boolean;
}

export type GridViewCollectionDescriptor =
    | OnlineGridViewCollectionDescriptor
    | LocalGridViewCollectionDescriptor
    | NavidromeGridViewCollectionDescriptor
    | AppleMusicGridViewCollectionDescriptor;

const getDisplayName = (name: React.ReactNode) => (
    typeof name === 'string' || typeof name === 'number'
        ? String(name)
        : ''
);

// Returns the provider-normalized artist label used by collection overview cards.
export const getProviderCollectionArtistLabel = (
    collection: Pick<ProviderCollection, 'artists' | 'creator'> | null | undefined,
): string => {
    const artists = collection?.artists
        ?.map(artist => artist.name.trim())
        .filter(Boolean)
        .join(', ');
    return artists || collection?.creator?.nickname || '';
};

export const createNeteaseProviderUser = (user: ProviderUser | null | undefined): ProviderUser | null => user || null;

export const createNeteaseGridViewCollection = (collection: ProviderCollection): GridViewCollectionDescriptor => (
    createOnlineGridViewCollection(collection, 'netease')
);

export const createOnlineGridViewCollection = (
    collection: any,
    providerId: OnlineProviderId,
): OnlineGridViewCollectionDescriptor => {
    const creator = collection.creator;
    return {
        ...collection,
        source: 'online',
        providerId,
        coverUrl: collection.coverUrl,
        trackCount: collection.trackCount,
        albumCount: collection.albumCount,
        isOwned: collection.isOwned,
        artists: collection.artists,
        aliases: collection.aliases,
        publishedAt: collection.publishedAt,
        publisher: collection.publisher,
        playCount: collection.playCount,
        updatedAt: collection.updatedAt,
        tracksUpdatedAt: collection.tracksUpdatedAt,
        isLiked: collection.isLiked,
        creator: creator ? { ...creator } : undefined,
        raw: collection.raw || collection,
    };
};

export const createLocalGridViewCollection = (group: LocalLibraryGroup): LocalGridViewCollectionDescriptor => ({
    source: 'local',
    id: group.id,
    name: group.name,
    type: group.type,
    coverUrl: typeof group.coverUrl === 'string' ? group.coverUrl : undefined,
    description: group.description,
    trackCount: group.trackCount ?? group.songs.length,
    songIds: group.songs.map(song => song.id),
    ...(group.entries?.length ? { entries: group.entries } : {}),
    ...(group.entityId ? { entityId: group.entityId } : {}),
    playlistId: group.playlistId,
    isVirtual: group.isVirtual,
});

export const createNavidromeGridViewCollection = (
    item: {
        id: string | number;
        name: React.ReactNode;
        coverUrl?: string;
        description?: string;
        trackCount?: number;
        albumArtist?: string;
        albumYear?: number;
        albumGenre?: string;
        albumDuration?: number;
    },
    type: NavidromeGridViewCollectionType
): NavidromeGridViewCollectionDescriptor => ({
    source: 'navidrome',
    id: String(item.id),
    name: getDisplayName(item.name),
    type,
    coverUrl: item.coverUrl,
    description: item.description,
    trackCount: item.trackCount,
    albumArtist: item.albumArtist,
    albumYear: item.albumYear,
    albumGenre: item.albumGenre,
    albumDuration: item.albumDuration,
    publishedAt: item.albumYear ? new Date(item.albumYear, 0, 1).getTime() : undefined,
    editable: Boolean((item as { editable?: boolean }).editable),
});

// Resolves the ordered, deduplicated artist entity names represented by a local album's songs.
export const resolveLocalAlbumArtistDisplay = (
    songIds: string[],
    catalog: { entities: LocalLibraryEntity[]; assignments: LocalLibraryAssignment[]; },
): string => {
    const index = buildLocalLibraryIndex(catalog.entities, catalog.assignments);
    const songIdSet = new Set(songIds);
    const seenArtistIds = new Set<string>();
    const names: string[] = [];

    catalog.assignments.forEach(assignment => {
        if (!songIdSet.has(assignment.songId)) return;
        assignment.artistEntityIds.forEach(artistEntityId => {
            const activeArtistId = followEntityRedirect(artistEntityId, index.entitiesById);
            const artistEntity = activeArtistId ? index.entitiesById.get(activeArtistId) : undefined;
            if (!artistEntity || artistEntity.kind !== 'artist' || seenArtistIds.has(artistEntity.id)) return;
            seenArtistIds.add(artistEntity.id);
            names.push(artistEntity.displayName);
        });
    });

    return names.join(', ');
};

export const refreshLocalGridViewCollection = (
    descriptor: LocalGridViewCollectionDescriptor,
    localSongs: LocalSong[],
    catalog?: { entities: LocalLibraryEntity[]; assignments: LocalLibraryAssignment[]; },
): LocalGridViewCollectionDescriptor => {
    if (descriptor.entityId && catalog) {
        const index = buildLocalLibraryIndex(catalog.entities, catalog.assignments);
        const entityId = followEntityRedirect(descriptor.entityId, index.entitiesById);
        const entity = entityId ? index.entitiesById.get(entityId) : undefined;
        if (!entity || entity.mergedInto) {
            return { ...descriptor, songIds: [], trackCount: 0 };
        }
        const songIds = catalog.assignments
            .filter(assignment => entity.kind === 'artist'
                ? assignment.artistEntityIds.some(artistEntityId => (
                    followEntityRedirect(artistEntityId, index.entitiesById) === entity.id
                ))
                : Boolean(assignment.albumEntityId && (
                    followEntityRedirect(assignment.albumEntityId, index.entitiesById) === entity.id
                )))
            .map(assignment => assignment.songId);
        const songIdSet = new Set(songIds);
        const currentSongs = localSongs.filter(song => songIdSet.has(song.id));
        const refreshedSongs = entity.kind === 'album' ? sortLocalFolderSongs(currentSongs) : currentSongs;
        const albumArtist = entity.kind === 'album'
            ? resolveLocalAlbumArtistDisplay(songIds, catalog)
            : undefined;
        return {
            ...descriptor,
            id: entity.id,
            entityId: entity.id,
            name: entity.displayName,
            songIds: refreshedSongs.map(song => song.id),
            trackCount: refreshedSongs.length,
            ...(albumArtist ? { albumArtist, description: albumArtist } : {}),
        };
    }

    if (descriptor.playlistId || descriptor.type !== 'folder') {
        return descriptor;
    }

    const currentSongs = descriptor.isVirtual
        ? localSongs
        : localSongs.filter(song => song.folderName === descriptor.name);
    const refreshedSongs = sortLocalFolderSongs(currentSongs);

    return {
        ...descriptor,
        songIds: refreshedSongs.map(song => song.id),
        trackCount: refreshedSongs.length,
    };
};

// Rebuilds a local GridView queue from descriptor ids while preserving descriptor order.
export const resolveLocalGridViewTracks = (
    descriptor: LocalGridViewCollectionDescriptor,
    localSongs: LocalSong[],
    catalog?: { entities: LocalLibraryEntity[]; assignments: LocalLibraryAssignment[]; },
): SongResult[] => {
    // 跨来源歌单：条目即顺序，直接解析成歌曲（含 online/navidrome/external-media）。
    if (descriptor.entries?.length) {
        return resolvePlaylistEntrySongs(descriptor.entries, localSongs).songs;
    }

    const songsById = new Map(localSongs.map(song => [song.id, song]));
    const orderedSongs = descriptor.songIds
        .map(songId => songsById.get(songId))
        .filter((song): song is LocalSong => Boolean(song));

    // Row-sized covers: GridView renders these as list thumbnails, never full-bleed.
    return buildLocalQueue(orderedSongs, undefined, catalog, LIST_ROW_COVER_SIZE) as SongResult[];
};

const getLocalGridViewCoverSource = (songs: LocalSong[]): string | undefined => {
    const sortedSongs = [...songs].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    const preferredSong = sortedSongs.find(song => {
        const hasEmbeddedCover = Boolean(getLocalCoverAssetUrl(song.localCoverAssetId));
        if (song.useOnlineCover) {
            return song.onlineMetadata?.coverUrl || hasEmbeddedCover;
        }
        return hasEmbeddedCover || song.onlineMetadata?.coverUrl;
    });

    if (!preferredSong) {
        return undefined;
    }

    const localCoverUrl = getLocalCoverAssetUrl(preferredSong.localCoverAssetId, 512) || undefined;
    if (preferredSong.useOnlineCover) {
        return preferredSong.onlineMetadata?.coverUrl || localCoverUrl;
    }

    return localCoverUrl || preferredSong.onlineMetadata?.coverUrl;
};

export const resolveLocalGridViewCoverSource = (
    descriptor: LocalGridViewCollectionDescriptor,
    localSongs: LocalSong[]
): string | undefined => {
    const songsById = new Map(localSongs.map(song => [song.id, song]));
    const orderedSongs = descriptor.songIds
        .map(songId => songsById.get(songId))
        .filter((song): song is LocalSong => Boolean(song));

    return getLocalGridViewCoverSource(orderedSongs);
};

// Loads Navidrome tracks for GridView without moving Navidrome service logic into GridView itself.
export const resolveNavidromeGridViewTracks = async (
    descriptor: NavidromeGridViewCollectionDescriptor
): Promise<SongResult[]> => {    const config = getNavidromeConfig();
    if (!config) {
        return [];
    }

    let subsonicSongs: SubsonicSong[] = [];

    if (descriptor.type === 'album') {
        const albumDetail = await navidromeApi.getAlbum(config, descriptor.id);
        subsonicSongs = albumDetail?.song || [];
    } else if (descriptor.type === 'playlist') {
        const playlistDetail = await navidromeApi.getPlaylist(config, descriptor.id);
        subsonicSongs = playlistDetail?.entry || [];
    } else if (descriptor.type === 'artist') {
        const artistDetail = await navidromeApi.getArtist(config, descriptor.id);
        const albums = artistDetail?.album || [];
        const albumResults = await Promise.all(albums.map(album => navidromeApi.getAlbum(config, album.id)));
        subsonicSongs = albumResults.flatMap(album => album?.song || []);
    } else if (descriptor.type === 'random') {
        subsonicSongs = await navidromeApi.getRandomSongs(config, 100);
    } else if (descriptor.type === 'favorites') {
        subsonicSongs = await navidromeApi.getStarred2(config);
    }

    const navidromeSongs = subsonicSongs.map(song => navidromeApi.toNavidromeSong(config, song));
    return buildNavidromeQueue(navidromeSongs);
};

/**
 * Loads an Apple Music collection's tracks for GridView.
 *
 * The second step is not optional, but its purpose changed with this refactor. Library rows come
 * back with `a.<n>` as their id and **no `previews` array**, so their `attributes.playParams.catalogId`
 * has to be exchanged for the catalog resource before anything downstream has an id it can address.
 * That exchange used to be about finding a preview URL; it is now about finding the **catalog id**,
 * because `playById` (the extension path that plays full tracks in Chrome) can only address a
 * catalog id — an `a.<n>` id 404s against the catalog endpoint.
 *
 * The rows are still merged with the catalog resource for the fields the library row lacks
 * (artwork aspect ratio, track number, isrc), so the resolution is not purely an id lookup.
 *
 * A failed catalog lookup still returns the rows — they are real, they just have no addressable id
 * and therefore cannot be played — so a partial Apple outage degrades to "unplayable rows" rather
 * than an empty page. `isExternalMediaQueueSongPlayable` is what surfaces that per row.
 */
export const resolveAppleMusicGridViewTracks = async (
    descriptor: AppleMusicGridViewCollectionDescriptor,
    storefront?: string,
): Promise<SongResult[]> => {
    const page = descriptor.type === 'album'
        ? await getAppleMusicAlbumTracks(descriptor.id, { limit: 100 })
        : await getAppleMusicPlaylistTracks(descriptor.id, { limit: 100 });

    if (!page.ok) {
        throw new Error(page.message || `Apple Music request failed: ${page.errorKind}`);
    }

    const resolved = await resolveAppleMusicCatalogFields(page.page.items, storefront);
    return resolved.map(toAppleMusicSongResult);
};

export const isLocalGridViewCollection = (
    collection: GridViewCollectionDescriptor
): collection is LocalGridViewCollectionDescriptor => collection.source === 'local';

export const isNavidromeGridViewCollection = (
    collection: GridViewCollectionDescriptor
): collection is NavidromeGridViewCollectionDescriptor => collection.source === 'navidrome';

export const isAppleMusicGridViewCollection = (
    collection: GridViewCollectionDescriptor
): collection is AppleMusicGridViewCollectionDescriptor => collection.source === 'apple-music';

export const createAppleMusicGridViewCollection = (
    item: {
        id: string | number;
        name: string;
        coverUrl?: string;
        description?: string;
        trackCount?: number;
        isLibrary?: boolean;
    },
    type: AppleMusicGridViewCollectionType,
): AppleMusicGridViewCollectionDescriptor => ({
    source: 'apple-music',
    id: String(item.id),
    name: item.name,
    type,
    coverUrl: item.coverUrl,
    description: item.description,
    trackCount: item.trackCount,
    isLibrary: item.isLibrary !== false,
});

export const isNeteaseGridViewCollection = (
    collection: GridViewCollectionDescriptor
) => collection.source === 'online' && collection.providerId === 'netease';
