import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { SongResult } from '../../../src/types';
import {
    buildAppleMusicSongUrl,
    getAppleMusicPlaylists,
    getAppleMusicStatus,
    isAppleMusicLibraryAvailable,
    openAppleMusicTrack,
    readAppleMusicSongPayload,
    resolveAppleMusicCatalogFields,
    toAppleMusicSongResult,
} from '../../../src/services/appleMusicService';

// test/unit/services/appleMusicService.test.ts
//
// Covers the renderer boundary that adapts Apple Music data into Folia shapes.
//
// The behaviours worth locking are the ones that decide whether a track can actually play:
// `toAppleMusicSongResult` must produce a `sourceRef.kind` the player routes on, and the payload must
// carry the **catalog id** — the only id `playById` can address, and therefore the thing that decides
// whether a track is playable at all. Both must degrade honestly when the bridge is absent (a browser
// build) or the lookup fails.
//
// This replaced a preview-resolution suite. The ~90 second preview path is gone: Folia no longer
// plays Apple Music bytes itself, so a `previewUrl` is no longer part of the contract. What the
// catalog batch is still needed for is the id and the metadata merge.
//
// `isAppleMusicLibraryAvailable` reads `window.electron` on every call rather than caching, so a
// test can install or remove the bridge between assertions.

/** Installs a fake `window.electron` bridge, recording every operation it is asked for. */
const installBridge = (handlers: Record<string, (args: any[]) => unknown> = {}) => {
    const calls: Array<{ operation: string; args: unknown[] }> = [];
    (globalThis as any).window = {
        electron: {
            appleMusicLibraryStatus: async () => ({ signedIn: true, storefront: 'cn' }),
            appleMusicLibraryRequest: async (operation: string, ...args: unknown[]) => {
                calls.push({ operation, args });
                const handler = handlers[operation];
                return handler ? handler(args) : { ok: true, page: { items: [], hasMore: false, nextOffset: 0 } };
            },
            appleMusicLibrarySignIn: async () => ({ ok: true }),
            appleMusicLibrarySignOut: async () => ({ ok: true }),
            onAppleMusicLibraryStatusChanged: () => () => {},
            openExternalUrl: async () => true,
        },
    };
    return calls;
};

const makeSong = (overrides: Record<string, unknown> = {}) => ({
    id: 'a.1538098094',
    type: 'library-song' as const,
    title: 'unravel',
    artist: 'TK from Ling tosite sigure',
    album: 'Fantastic Magic',
    albumId: '1538098090',
    durationMs: 238360,
    trackNumber: 2,
    discNumber: 1,
    isrc: null,
    coverUrl: 'https://x/600x600bb.jpg',
    hasLyrics: true,
    contentRating: null,
    catalogId: '1538098094' as string | null,
    isLibrary: true,
    url: 'https://music.apple.com/cn/song/unravel/1538098094',
    ...overrides,
});

describe('appleMusicService', () => {
    beforeEach(() => {
        delete (globalThis as any).window;
    });

    afterEach(() => {
        delete (globalThis as any).window;
    });

    it('reports unavailable when there is no Electron bridge', async () => {
        (globalThis as any).window = {};

        expect(isAppleMusicLibraryAvailable()).toBe(false);
        await expect(getAppleMusicStatus()).resolves.toEqual({ signedIn: false, storefront: null });
    });

    it('reports available when the bridge exposes both entry points', () => {
        installBridge();
        expect(isAppleMusicLibraryAvailable()).toBe(true);
    });

    it('converts a song into a SongResult the player routes on its own source kind', () => {
        installBridge();

        const result = toAppleMusicSongResult(makeSong() as any) as SongResult & Record<string, unknown>;

        // A distinct kind, not 'online': there is no Omni provider to fetch audio from, and not
        // 'local': the bytes come from Apple's CDN and are decoded in the browser.
        expect(result.sourceRef).toEqual({ kind: 'external-media', mediaId: 'a.1538098094' });
        // Namespaced so it can never collide with a Netease/KuGou numeric id or a local UUID.
        expect(result.id).toBe('apple-music:a.1538098094');
        expect(result.name).toBe('unravel');
        expect(result.artists).toEqual([{ id: 0, name: 'TK from Ling tosite sigure' }]);
        expect(result.album).toMatchObject({ name: 'Fantastic Magic', coverUrl: 'https://x/600x600bb.jpg' });
        expect(result.durationMs).toBe(238360);
        expect(result.externalMediaCatalogId).toBe('1538098094');
    });

    it('carries no audio url, because Folia does not decode these bytes', () => {
        installBridge();

        const result = toAppleMusicSongResult(makeSong() as any) as unknown as Record<string, unknown>;

        // The queue entry is Folia's record of *what it asked the external player for*, not a source
        // Folia can load. A leftover url field is how a stale queued song would fall back into a
        // playback mode nothing else supports.
        expect(result).not.toHaveProperty('externalMediaPreviewUrl');
        expect(result).not.toHaveProperty('audioSrc');
    });

    it('reads the external media payload back off a queued song', () => {
        installBridge();

        const result = toAppleMusicSongResult(makeSong() as any);

        expect(readAppleMusicSongPayload(result)).toMatchObject({
            catalogId: '1538098094',
            externalMediaId: 'a.1538098094',
            hasLyrics: true,
        });
        // A song that is not an Apple Music one reads back as null rather than a half-filled object.
        expect(readAppleMusicSongPayload({ id: '1', name: 'x' } as SongResult)).toBeNull();
        expect(readAppleMusicSongPayload(null)).toBeNull();
    });

    it('fills in catalog fields on library rows via a catalog batch', async () => {
        // Library rows carry no catalog-level metadata at all, so this exchange is what gives the
        // playback path an id it can address. Verified against a signed-in account.
        const calls = installBridge({
            getCatalogSongsByIds: () => ({
                ok: true,
                songs: [{ id: '1538098094', catalogId: '1538098094', coverUrl: 'https://x/catalog.jpg' }],
            }),
        });

        const resolved = await resolveAppleMusicCatalogFields([makeSong() as any], 'cn');

        expect(resolved[0].catalogId).toBe('1538098094');
        expect(calls[0].operation).toBe('getCatalogSongsByIds');
        expect(calls[0].args[0]).toEqual(['1538098094']);
    });

    it('takes the catalog row as authoritative for the catalog id', async () => {
        // The library row's own id is `a.<n>`, which 404s against the catalog endpoint. Whatever the
        // catalog response says the id is, that is what playback will be addressed with.
        installBridge({
            getCatalogSongsByIds: () => ({
                ok: true,
                songs: [{ id: '1538098094', catalogId: '1538098094', coverUrl: 'https://x/catalog.jpg' }],
            }),
        });

        const resolved = await resolveAppleMusicCatalogFields(
            [makeSong({ catalogId: '1538098094', coverUrl: undefined }) as any],
            'cn',
        );

        expect(resolved[0].catalogId).toBe('1538098094');
        expect(resolved[0].coverUrl).toBe('https://x/catalog.jpg');
    });

    it('leaves rows without a catalog id alone', async () => {
        // A library upload has no catalog entry, so there is no id to find and no request worth
        // making. It stays unplayable, permanently and correctly.
        const calls = installBridge();

        const input = [makeSong({ catalogId: null }) as any];
        const resolved = await resolveAppleMusicCatalogFields(input, 'cn');

        expect(calls).toHaveLength(0);
        expect(resolved).toBe(input);
    });

    it('keeps the playlist intact when the catalog lookup fails', async () => {
        installBridge({ getCatalogSongsByIds: () => ({ ok: false, errorKind: 'throttled', message: 'slow down' }) });

        const input = [makeSong() as any];
        const resolved = await resolveAppleMusicCatalogFields(input, 'cn');

        // Rows still render; they just cannot be played. A failed lookup must not present as an
        // empty playlist.
        expect(resolved).toHaveLength(1);
        expect(resolved[0].catalogId).toBe('1538098094');
    });

    it('unwraps a structured failure instead of throwing', async () => {
        installBridge({ getLibraryPlaylists: () => ({ ok: false, errorKind: 'not-signed-in', message: 'nope' }) });

        await expect(getAppleMusicPlaylists()).resolves.toMatchObject({ ok: false, errorKind: 'not-signed-in' });
    });

    it('turns a rejected bridge call into a structured failure', async () => {
        (globalThis as any).window = {
            electron: {
                appleMusicLibraryRequest: async () => { throw new Error('ipc exploded'); },
                appleMusicLibraryStatus: async () => ({ signedIn: true, storefront: null }),
            },
        };

        await expect(getAppleMusicPlaylists()).resolves.toMatchObject({ ok: false, errorKind: 'network' });
    });

    it('builds a deep link for the track, preferring Apple\'s own url', () => {
        installBridge();

        expect(buildAppleMusicSongUrl({ url: 'https://music.apple.com/x', catalogId: '1', id: 'a.1' }))
            .toBe('https://music.apple.com/x');
        expect(buildAppleMusicSongUrl({ url: null, catalogId: '1538098094', id: 'a.1538098094' }))
            .toContain('1538098094');
        // A library-only id cannot form a catalog link.
        expect(buildAppleMusicSongUrl({ url: null, catalogId: null, id: 'a.999' })).toBeNull();
    });

    it('opens the track through the external-url bridge', async () => {
        const openExternalUrl = vi.fn(async () => true);
        (globalThis as any).window = {
            electron: {
                appleMusicLibraryRequest: async () => ({ ok: true }),
                appleMusicLibraryStatus: async () => ({ signedIn: true, storefront: null }),
                openExternalUrl,
            },
        };

        const opened = await openAppleMusicTrack(toAppleMusicSongResult(makeSong() as any));

        expect(opened).toBe(true);
        expect(openExternalUrl).toHaveBeenCalledWith('https://music.apple.com/cn/song/unravel/1538098094');
    });

    it('refuses to open a track with no link', async () => {
        installBridge();
        await expect(openAppleMusicTrack(null)).resolves.toBe(false);
    });
});
