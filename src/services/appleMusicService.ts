import type { LyricData, SongResult } from '../types';
import { fetchAmllDbLyrics } from '../utils/lyrics/providers/amllDbProvider';

// src/services/appleMusicService.ts
// Apple Music content source for the renderer.
//
// This is deliberately NOT an Omni provider. `src/types/playbackBackend.ts` records the rule:
// Apple Music is an external playback backend, not a fourth online provider — it has no
// `providerId`, produces no `UnifiedSong`, and does not consume `activeProviderId`. Reading the
// user's library is a *content source* concern, so it follows the `navidromeService` precedent:
// a standalone service with its own transport, adapted into Folia shapes at this boundary.
//
// Everything here is Electron-only. In a browser build `window.electron` is absent, and the
// library half (which needs the user's session cookie) is unavailable by construction; only the
// public catalog half can work, and it needs a server-side proxy that this build does not have.
// `isAppleMusicLibraryAvailable()` is the single check callers use to decide.

/** The result envelope every bridge call returns. Mirrors `ElectronAppleMusicResult`. */
export type AppleMusicErrorKind =
    | 'not-signed-in'
    | 'throttled'
    | 'dev-token-unavailable'
    | 'network'
    | 'upstream'
    | 'invalid-request'
    | 'unavailable';

export type AppleMusicResult<T> =
    | ({ ok: true } & T)
    | { ok: false; errorKind: AppleMusicErrorKind; message: string };

export interface AppleMusicSong {
    id: string;
    type: 'song' | 'library-song';
    title: string;
    artist: string;
    album: string;
    albumId: string | null;
    durationMs: number | null;
    trackNumber: number | null;
    discNumber: number | null;
    isrc: string | null;
    coverUrl?: string;
    hasLyrics: boolean;
    contentRating: string | null;
    /**
     * The Apple Music **catalog** id — the only id that can address this track for playback.
     *
     * There is deliberately no `previewUrl` any more. Folia used to play Apple's ~90 second AAC
     * preview in its own `<audio>` deck; that path is removed, and full tracks are now played by
     * music.apple.com in Chrome through the extension (`playById`). Keeping a preview URL on this
     * shape would let a stale queued song fall back into a playback mode nothing else supports.
     *
     * `catalogId` is also the id the lyrics database is keyed by. Library rows carry `a.<n>` as
     * their `id` and reach the catalog id only through `attributes.playParams.catalogId` — and that
     * lookup is what makes a library row playable at all. Rows without one (library uploads with no
     * catalog entry) are simply not playable and not matchable.
     */
    catalogId: string | null;
    isLibrary: boolean;
    url: string | null;
}

export interface AppleMusicCollection {
    id: string;
    type: 'playlist' | 'album';
    name: string;
    description: string;
    curator: string;
    trackCount: number | null;
    coverUrl?: string;
    canEdit?: boolean;
    releaseDate?: string | null;
    isLibrary: boolean;
    url: string | null;
}

export interface AppleMusicPage<T> {
    items: T[];
    hasMore: boolean;
    nextOffset: number;
    total?: number;
}

export interface AppleMusicStatus {
    signedIn: boolean;
    storefront: string | null;
}

const getBridge = () => {
    if (typeof window === 'undefined') return undefined;
    return window.electron;
};

/**
 * True when this build can read the user's Apple Music library at all.
 *
 * The library half needs the Electron main process (it owns the session cookie jar), so a
 * browser/Docker build is honestly unavailable rather than silently empty.
 */
export const isAppleMusicLibraryAvailable = (): boolean => {
    const bridge = getBridge();
    return Boolean(bridge?.appleMusicLibraryStatus && bridge?.appleMusicLibraryRequest);
};

/** Unwraps a bridge envelope, converting a transport-level throw into a structured failure. */
const call = async <T>(
    operation: Parameters<NonNullable<ReturnType<typeof getBridge>>['appleMusicLibraryRequest']>[0],
    ...args: unknown[]
): Promise<AppleMusicResult<T>> => {
    const bridge = getBridge();
    if (!bridge?.appleMusicLibraryRequest) {
        return { ok: false, errorKind: 'unavailable', message: 'Apple Music is only available in the desktop app.' };
    }

    try {
        const result = await bridge.appleMusicLibraryRequest(operation, ...args);
        if (result && typeof result === 'object' && 'ok' in result) {
            return result as AppleMusicResult<T>;
        }
        return { ok: false, errorKind: 'upstream', message: 'Apple Music bridge returned an unexpected shape.' };
    } catch (error) {
        return {
            ok: false,
            errorKind: 'network',
            message: error instanceof Error ? error.message : String(error),
        };
    }
};

/** Reads sign-in state. Never throws; an absent bridge reads as signed out. */
export const getAppleMusicStatus = async (): Promise<AppleMusicStatus> => {
    const bridge = getBridge();
    if (!bridge?.appleMusicLibraryStatus) {
        return { signedIn: false, storefront: null };
    }
    try {
        return await bridge.appleMusicLibraryStatus();
    } catch {
        return { signedIn: false, storefront: null };
    }
};

/** Opens Apple's own login page in a Folia-owned window. The password never reaches Folia. */
export const signInToAppleMusic = async (): Promise<AppleMusicResult<{ alreadyOpen?: boolean }>> => {
    const bridge = getBridge();
    if (!bridge?.appleMusicLibrarySignIn) {
        return { ok: false, errorKind: 'unavailable', message: 'Apple Music is only available in the desktop app.' };
    }
    try {
        const result = await bridge.appleMusicLibrarySignIn();
        return { ok: true, alreadyOpen: result?.alreadyOpen };
    } catch (error) {
        return {
            ok: false,
            errorKind: 'network',
            message: error instanceof Error ? error.message : String(error),
        };
    }
};

/** Clears the stored Apple Music session. */
export const signOutOfAppleMusic = async (): Promise<AppleMusicResult<{ signedOut: true }>> => {
    const bridge = getBridge();
    if (!bridge?.appleMusicLibrarySignOut) {
        return { ok: false, errorKind: 'unavailable', message: 'Apple Music is only available in the desktop app.' };
    }
    try {
        await bridge.appleMusicLibrarySignOut();
        return { ok: true, signedOut: true };
    } catch (error) {
        return {
            ok: false,
            errorKind: 'network',
            message: error instanceof Error ? error.message : String(error),
        };
    }
};

export const getAppleMusicPlaylists = (options: { limit?: number; offset?: number } = {}) =>
    call<{ page: AppleMusicPage<AppleMusicCollection> }>('getLibraryPlaylists', options);

export const getAppleMusicAlbums = (options: { limit?: number; offset?: number } = {}) =>
    call<{ page: AppleMusicPage<AppleMusicCollection> }>('getLibraryAlbums', options);

export const getAppleMusicSongs = (options: { limit?: number; offset?: number } = {}) =>
    call<{ page: AppleMusicPage<AppleMusicSong> }>('getLibrarySongs', options);

export const getAppleMusicPlaylistTracks = (playlistId: string, options: { limit?: number; offset?: number } = {}) =>
    call<{ page: AppleMusicPage<AppleMusicSong> }>('getLibraryPlaylistTracks', playlistId, options);

export const getAppleMusicAlbumTracks = (albumId: string, options: { limit?: number; offset?: number } = {}) =>
    call<{ page: AppleMusicPage<AppleMusicSong> }>('getLibraryAlbumTracks', albumId, options);

export const getAppleMusicCatalogSongs = (ids: string[], options: { storefront?: string } = {}) =>
    call<{ songs: AppleMusicSong[] }>('getCatalogSongsByIds', ids, options);

export const getAppleMusicCatalogPlaylist = (playlistId: string, storefront?: string) =>
    call<{ playlist: AppleMusicCollection; tracks: AppleMusicSong[]; hasMoreTracks: boolean }>(
        'getCatalogPlaylist',
        playlistId,
        storefront,
    );

export const searchAppleMusicCatalog = (
    term: string,
    options: { storefront?: string; limit?: number; offset?: number } = {},
) => call<{ page: AppleMusicPage<AppleMusicSong> }>('searchCatalog', term, options);

/**
 * Fills in the fields a library row is missing, by exchanging its `playParams.catalogId` for the
 * catalog resource.
 *
 * Library rows carry no `previews` array and no catalog-level metadata — verified against a signed-in
 * account — so this lookup is what makes a library playlist usable at all. Two things come back that
 * matter downstream:
 *
 *   1. **The catalog resource itself**, which is the only id `playById` can address. A library row's
 *      own id is `a.<n>` and 404s against the catalog endpoint.
 *   2. Artwork at a better aspect ratio, the real track number, and the isrc — the library row's
 *      identity is kept, only the fields it was missing are taken from the catalog row.
 *
 * Rows that already have a `catalogId` still get the metadata merge; rows without one (library
 * uploads with no catalog entry) are passed through unchanged and stay unplayable, which is correct
 * and permanent — there is no catalog resource to address.
 *
 * Returns a new array; the input is not mutated, so a React state update always sees a new identity.
 */
export const resolveAppleMusicCatalogFields = async (
    songs: AppleMusicSong[],
    storefront?: string,
): Promise<AppleMusicSong[]> => {
    const ids = songs.map(song => song.catalogId).filter((id): id is string => Boolean(id));
    if (ids.length === 0) {
        return songs;
    }

    const result = await getAppleMusicCatalogSongs(ids, storefront ? { storefront } : {});
    if (!result.ok) {
        // A failed lookup must not fail the page load: the rows still render, they just have nothing
        // to play. Callers surface that per-row (`isExternalMediaQueueSongPlayable`) rather than as a
        // page-level error, so a partial Apple outage degrades instead of blanking the view.
        return songs;
    }

    const byCatalogId = new Map<string, AppleMusicSong>();
    for (const song of result.songs) {
        if (song.id) byCatalogId.set(song.id, song);
    }

    return songs.map((song) => {
        if (!song.catalogId) return song;
        const resolved = byCatalogId.get(song.catalogId);
        if (!resolved) return song;
        return {
            ...song,
            // The catalog row is authoritative for the catalog id itself: a library row's
            // `playParams.catalogId` is normally right, but the catalog response is what the
            // playback path will actually be addressed with, so take it from there.
            catalogId: resolved.catalogId ?? song.catalogId,
            coverUrl: song.coverUrl || resolved.coverUrl,
            isrc: song.isrc || resolved.isrc,
        };
    });
};

/** Apple Music's deep link for a song, used for "play the full track in Apple Music". */
export const buildAppleMusicSongUrl = (song: Pick<AppleMusicSong, 'url' | 'catalogId' | 'id'>): string | null => {
    if (song.url) return song.url;
    const id = song.catalogId || (song.id.startsWith('a.') ? null : song.id);
    return id ? `https://music.apple.com/song/${encodeURIComponent(id)}` : null;
};

/**
 * Converts an Apple Music song into the `SongResult` Folia's grid and queue already understand.
 *
 * Three deliberate choices:
 *   - The id is namespaced (`apple-music:<id>`) so it can never collide with a Netease/KuGou/QQ
 *     numeric id or a local UUID. Apple Music ids are opaque strings (`a.1538098094` for a
 *     library row, a bare number for a catalog row), and Folia compares ids in several places.
 *   - `sourceRef.kind` is `'external-media'`, its own kind. Not `online` (there is no Omni provider
 *     to route to, and claiming one would make `omni` own a song it cannot resolve) and not
 *     `local` (the bytes come from Apple's CDN and are decoded inside the browser, and `local`
 *     means a file on this machine).
 *   - There is no audio URL on the result. Folia does not play this track: it hands the catalog id
 *     to the external backend, which tells music.apple.com in Chrome to play it. The queue entry
 *     is Folia's bookkeeping of *what it asked for*, not a source Folia can decode.
 */
export const toAppleMusicSongResult = (song: AppleMusicSong): SongResult => ({
    id: `apple-music:${song.id}`,
    name: song.title,
    artists: [{ id: 0, name: song.artist }],
    album: {
        id: song.albumId || 0,
        name: song.album,
        coverUrl: song.coverUrl,
    },
    durationMs: song.durationMs ?? 0,
    // `mediaId` is the bare Apple Music id, not the namespaced one: `getPlaybackSongKey` already
    // prefixes it with the source kind, and `apple-music:apple-music:a.123` is noise in every log.
    sourceRef: { kind: 'external-media', mediaId: song.id },
    // External media payload, read back by the queue (for `playById`) and the lyrics resolver.
    externalMediaCatalogId: song.catalogId,
    externalMediaId: song.id,
    externalMediaUrl: buildAppleMusicSongUrl(song),
    externalMediaHasLyrics: song.hasLyrics,
} as SongResult);

/**
 * Reads the external media payload back off a queued song, or null when it is not one.
 *
 * `catalogId` is what playback needs; `externalMediaId` is the row's own id, which for a library
 * row is `a.<n>` and **cannot** address the catalog. Callers that need to play must use
 * `catalogId` (see `resolveExternalMediaPlayableId` in `utils/externalMediaQueueReconcile.ts`).
 */
export const readAppleMusicSongPayload = (song: SongResult | null | undefined): {
    catalogId: string | null;
    externalMediaId: string | null;
    url: string | null;
    hasLyrics: boolean;
} | null => {
    if (!song || typeof song !== 'object') return null;
    const candidate = song as SongResult & {
        externalMediaCatalogId?: string | null;
        externalMediaId?: string | null;
        externalMediaUrl?: string | null;
        externalMediaHasLyrics?: boolean;
    };
    if (!candidate.externalMediaId) return null;
    return {
        catalogId: candidate.externalMediaCatalogId ?? null,
        externalMediaId: candidate.externalMediaId,
        url: candidate.externalMediaUrl ?? null,
        hasLyrics: Boolean(candidate.externalMediaHasLyrics),
    };
};

/**
 * Opens the track on music.apple.com in the user's browser.
 *
 * This is the **fallback**, not the primary path: normally Folia asks the extension to play the
 * track in an existing tab. Opening a URL is what remains available when the extension is not
 * connected — and it is also the honest action when the user wants the Apple Music app instead,
 * since `music.apple.com` links are handled by the OS and may land in either.
 *
 * Note the previous version of this function was the *only* way to hear a full track (the app
 * could stream just a 90 second preview). That framing is gone: full playback is the normal case
 * now, and this is a degraded path.
 */
export const openAppleMusicTrack = async (song: SongResult | null | undefined): Promise<boolean> => {
    const payload = readAppleMusicSongPayload(song);
    const url = payload?.url;
    if (!url) return false;

    const bridge = getBridge();
    try {
        if (bridge?.openExternalUrl) {
            return await bridge.openExternalUrl(url);
        }
        return Boolean(window.open(url, '_blank', 'noopener,noreferrer'));
    } catch (error) {
        console.error('[AppleMusic] Failed to open the track:', error);
        return false;
    }
};

/**
 * Resolves lyrics for an Apple Music track from AMLL's TTML database.
 *
 * The database is keyed by the *catalog* song id under the `am` platform — verified against the
 * live service, where `/am/1468058171` returns TTML. A library row's `a.<n>` id has no entry, so
 * `catalogId` is required; rows without one simply have no lyrics to find.
 *
 * Apple's own lyrics endpoint is closed to third parties (the `?include=lyrics` relationship comes
 * back empty even for songs that visibly have lyrics), so this database is the only word-by-word
 * source available.
 */
export const resolveAppleMusicLyrics = async (song: SongResult | null | undefined): Promise<LyricData | null> => {
    const payload = readAppleMusicSongPayload(song);
    if (!payload?.hasLyrics) return null;
    const id = payload.catalogId || payload.externalMediaId;
    if (!id) return null;

    try {
        return await fetchAmllDbLyrics('am', id);
    } catch (error) {
        console.warn('[AppleMusic] Lyrics lookup failed:', error);
        return null;
    }
};
