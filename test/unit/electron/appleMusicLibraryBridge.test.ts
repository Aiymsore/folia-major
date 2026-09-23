import { createRequire } from 'module';
import { describe, expect, it, vi } from 'vitest';

// test/unit/electron/appleMusicLibraryBridge.test.ts
//
// Covers electron/appleMusicLibraryBridge.cjs: the pure normalizers, the credential lookup, and
// the request/response contract the renderer branches on.
//
// Three behaviours here are regressions found by probing a real signed-in account, and each one
// silently broke the feature when it was wrong:
//
//   1. The media-user-token cookie is named `media-user-token` on the current web player. An
//      earlier version only looked for the legacy `mt-tkn-<dsid>` prefix and therefore reported
//      "signed out" for an account that was signed in.
//   2. Library rows carry no `previews` array, so a playable track can only be reached through
//      `playParams.catalogId`. Reading `resource.id` instead 404s against the catalog, turning
//      every library track into an unplayable row.
//   3. The `?ids=` catalog batch rejects `limit` with a 400, so a batch that sends one resolves
//      nothing at all.

const require = createRequire(import.meta.url);
const bridgeModule = require('../../../electron/appleMusicLibraryBridge.cjs') as {
    createAppleMusicLibraryBridge: (options?: Record<string, unknown>) => any;
    buildArtworkUrl: (artwork: unknown, size?: number) => string | undefined;
    clampLimit: (limit: unknown, fallback?: number) => number;
    clampOffset: (offset: unknown) => number;
    extractDevTokenFromBundle: (source: unknown) => string | null;
    readJwtExpiryMs: (token: unknown) => number | null;
    resolveStorefrontFromCookie: (cookies: unknown) => string | null;
    isMediaUserTokenCookieName: (name: unknown) => boolean;
    normalizeSong: (resource: unknown) => any;
    normalizePlaylist: (resource: unknown) => any;
    normalizeAlbum: (resource: unknown) => any;
    APPLE_MUSIC_PARTITION: string;
    MEDIA_USER_TOKEN_PREFIX: string;
};

const {
    createAppleMusicLibraryBridge,
    buildArtworkUrl,
    clampLimit,
    clampOffset,
    extractDevTokenFromBundle,
    readJwtExpiryMs,
    resolveStorefrontFromCookie,
    isMediaUserTokenCookieName,
    normalizeSong,
    normalizePlaylist,
    normalizeAlbum,
    APPLE_MUSIC_PARTITION,
} = bridgeModule;

/**
 * A JWT-shaped string with a chosen `exp`, mirroring the real web-player token's shape
 * (header carries `kid`, payload carries `iss`) so it satisfies the same regex the scraper uses.
 * A short placeholder would silently produce "no token found" and make every downstream
 * assertion fail for the wrong reason.
 */
const makeJwt = (expSeconds: number): string => {
    const header = Buffer.from(JSON.stringify({
        typ: 'JWT',
        alg: 'ES256',
        kid: 'WebPlayKidPlaceholder',
    })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
        iss: 'AMPWebPlay',
        iat: expSeconds - 3600,
        exp: expSeconds,
    })).toString('base64url');
    const signature = Buffer.from('a'.repeat(64)).toString('base64url');
    return `${header}.${payload}.${signature}`;
};

/** Builds a bridge over a scripted fetch, recording every URL it was asked for. */
const createTestBridge = ({
    responses = [] as Array<{ status?: number; body?: unknown; text?: string }>,
    cookies = [] as Array<{ name: string; value: string }>,
    now = () => 1_700_000_000_000,
} = {}) => {
    const calls: string[] = [];
    const queue = [...responses];
    const fetchImpl = vi.fn(async (url: string) => {
        calls.push(String(url));
        const next = queue.shift() ?? { status: 200, body: {} };
        const status = next.status ?? 200;
        const text = next.text ?? JSON.stringify(next.body ?? {});
        return {
            ok: status >= 200 && status < 300,
            status,
            text: async () => text,
        };
    });

    const session = {
        cookies: {
            get: vi.fn(async () => cookies),
        },
    };

    const bridge = createAppleMusicLibraryBridge({
        fetchImpl,
        getSession: () => session,
        now,
        warn: () => {},
    });

    return { bridge, calls, fetchImpl, session };
};

/** The web player page plus its bundle, which is how the developer token is obtained. */
const devTokenResponses = (token: string) => ([
    { status: 200, text: '<script src="/assets/index~abc.js"></script>' },
    { status: 200, text: `var t="${token}";` },
]);

describe('appleMusicLibraryBridge / pure helpers', () => {
    it('substitutes artwork template dimensions without changing the crop code', () => {
        // `bb` (catalog) and `cc` (library) crop differently; rewriting one into the other
        // changes how the cover is framed.
        expect(buildArtworkUrl({ url: 'https://x/y/{w}x{h}bb.jpg' }, 600))
            .toBe('https://x/y/600x600bb.jpg');
        expect(buildArtworkUrl({ url: 'https://x/y/{w}x{h}cc.jpg' }, 300))
            .toBe('https://x/y/300x300cc.jpg');
    });

    it('leaves already-signed artwork urls untouched', () => {
        // Library playlists return blobstore URLs with a signature; rewriting them would
        // invalidate it.
        const signed = 'https://store-033.blobstore.apple.com/image?X-Amz-Signature=abc';
        expect(buildArtworkUrl({ url: signed })).toBe(signed);
    });

    it('returns undefined for missing artwork', () => {
        expect(buildArtworkUrl(null)).toBeUndefined();
        expect(buildArtworkUrl({})).toBeUndefined();
        expect(buildArtworkUrl({ url: '' })).toBeUndefined();
    });

    it('clamps paging into Apple-accepted ranges', () => {
        expect(clampLimit(25)).toBe(25);
        expect(clampLimit(5000)).toBe(100);
        expect(clampLimit(0)).toBe(25);
        expect(clampLimit(-3)).toBe(25);
        expect(clampLimit('12')).toBe(12);
        expect(clampLimit(undefined)).toBe(25);

        expect(clampOffset(10)).toBe(10);
        expect(clampOffset(-1)).toBe(0);
        expect(clampOffset('7')).toBe(7);
        expect(clampOffset(null)).toBe(0);
    });

    it('extracts the developer token out of the web player bundle', () => {
        const token = makeJwt(1_800_000_000);
        expect(extractDevTokenFromBundle(`x="${token}"`)).toBe(token);
        expect(extractDevTokenFromBundle('no token here')).toBeNull();
        expect(extractDevTokenFromBundle(null)).toBeNull();
    });

    it('reads the jwt expiry, and rejects anything malformed', () => {
        expect(readJwtExpiryMs(makeJwt(1_800_000_000))).toBe(1_800_000_000_000);
        expect(readJwtExpiryMs('not-a-jwt')).toBeNull();
        expect(readJwtExpiryMs('a.!!!.c')).toBeNull();
        expect(readJwtExpiryMs(null)).toBeNull();
    });

    it('reads the storefront out of the itspod cookie', () => {
        // The cookie carries a NUMERIC id; every catalog endpoint wants the ISO code. Passing the
        // number through yields `400 Unknown storefront '43'`, which silently breaks preview
        // resolution for every library track. Found against a real signed-in account.
        expect(resolveStorefrontFromCookie([{ name: 'itspod', value: '43' }])).toBe('cn');
        expect(resolveStorefrontFromCookie([{ name: 'itspod', value: '143441' }])).toBe('us');
        // An already-ISO value is passed through, lowercased.
        expect(resolveStorefrontFromCookie([{ name: 'itspod', value: 'CN' }])).toBe('cn');
        // An unmapped numeric id resolves to null rather than a bogus code.
        expect(resolveStorefrontFromCookie([{ name: 'itspod', value: '999999' }])).toBeNull();
        expect(resolveStorefrontFromCookie([{ name: 'other', value: 'x' }])).toBeNull();
        expect(resolveStorefrontFromCookie(null)).toBeNull();
    });

    it('accepts both media-user-token cookie namings', () => {
        // Regression: only matching the legacy prefix reported a signed-in account as signed out.
        expect(isMediaUserTokenCookieName('media-user-token')).toBe(true);
        expect(isMediaUserTokenCookieName('mt-tkn-19119615753')).toBe(true);
        expect(isMediaUserTokenCookieName('media-user-token-extra')).toBe(false);
        expect(isMediaUserTokenCookieName('itspod')).toBe(false);
        expect(isMediaUserTokenCookieName(null)).toBe(false);
    });

    it('uses a persistent session partition', () => {
        // A bare partition name is in-memory in Electron, which would discard the sign-in on
        // every restart and send the user back to the login page forever.
        expect(APPLE_MUSIC_PARTITION.startsWith('persist:')).toBe(true);
    });
});

describe('appleMusicLibraryBridge / normalization', () => {
    it('normalizes a catalog song and ignores the 90-second previews array', () => {
        // 试听路径已删除（网页全曲时代 previewUrl 无消费者）：即使资源带 previews 也不再提取。
        const song = normalizeSong({
            id: '1538098094',
            type: 'songs',
            attributes: {
                name: 'unravel',
                artistName: 'TK from Ling tosite sigure',
                albumName: 'Fantastic Magic',
                durationInMillis: 238360,
                trackNumber: 2,
                isrc: 'JPV001400123',
                hasLyrics: true,
                artwork: { url: 'https://x/{w}x{h}bb.jpg' },
                previews: [{ url: 'https://audio.example/preview.m4a' }],
                playParams: { id: '1538098094', kind: 'song' },
            },
        });

        expect(song).toMatchObject({
            id: '1538098094',
            type: 'song',
            title: 'unravel',
            artist: 'TK from Ling tosite sigure',
            durationMs: 238360,
            coverUrl: 'https://x/600x600bb.jpg',
            isLibrary: false,
        });
        expect(song.previewUrl).toBeUndefined();
    });

    it('reads the catalog id from playParams, never from the library resource id', () => {
        // Regression: library rows are `a.<n>`, which 404s against the catalog. Only
        // `playParams.catalogId` resolves, so it is the only accepted source.
        const song = normalizeSong({
            id: 'a.1538098094',
            type: 'library-songs',
            attributes: {
                name: 'unravel',
                artistName: 'TK',
                albumName: 'Fantastic Magic',
                durationInMillis: 238360,
                // Library rows genuinely have no previews array.
                playParams: { catalogId: '1538098094', id: 'a.1538098094', isLibrary: true, kind: 'song' },
            },
        });

        expect(song.id).toBe('a.1538098094');
        expect(song.catalogId).toBe('1538098094');
        expect(song.isLibrary).toBe(true);
    });

    it('leaves catalogId null for a library upload with no catalog entry', () => {
        const song = normalizeSong({
            id: 'a.999',
            type: 'library-songs',
            attributes: { name: 'My Upload', playParams: { isLibrary: true, kind: 'song' } },
        });
        expect(song.catalogId).toBeNull();
    });

    it('drops resources with no id and tolerates missing attributes', () => {
        expect(normalizeSong(null)).toBeNull();
        expect(normalizeSong({})).toBeNull();
        expect(normalizeSong({ id: '1' })).toMatchObject({ id: '1', title: '', artist: '' });
    });

    it('normalizes a library playlist and flattens its description', () => {
        const playlist = normalizePlaylist({
            id: 'p.5PG5godsb7kdNW4',
            type: 'library-playlists',
            attributes: {
                name: '能量充电',
                description: { standard: '工作时听' },
                canEdit: false,
                artwork: { url: 'https://x/{w}x{h}cc.jpg' },
            },
        });

        expect(playlist).toMatchObject({
            id: 'p.5PG5godsb7kdNW4',
            type: 'playlist',
            name: '能量充电',
            description: '工作时听',
            canEdit: false,
            isLibrary: true,
        });
    });

    it('normalizes an album', () => {
        const album = normalizeAlbum({
            id: '123',
            type: 'library-albums',
            attributes: { name: 'Fantastic Magic', artistName: 'TK', trackCount: 12, releaseDate: '2014-07-23' },
        });
        expect(album).toMatchObject({ id: '123', type: 'album', curator: 'TK', trackCount: 12, isLibrary: true });
    });
});

describe('appleMusicLibraryBridge / credentials and requests', () => {
    it('reports signed out when the token cookie is absent', async () => {
        const { bridge } = createTestBridge({ cookies: [{ name: 'itspod', value: 'cn' }] });
        await expect(bridge.getStatus()).resolves.toEqual({ signedIn: false, storefront: null });
    });

    it('reports signed in with the storefront from the itspod cookie', async () => {
        const { bridge } = createTestBridge({
            cookies: [
                { name: 'media-user-token', value: 'token-value' },
                { name: 'itspod', value: '43' },
            ],
        });
        await expect(bridge.getStatus()).resolves.toEqual({ signedIn: true, storefront: 'cn' });
    });

    it('refuses a library call when not signed in, without spending a request', async () => {
        const { bridge, calls } = createTestBridge({ cookies: [] });
        const result = await bridge.getLibraryPlaylists({ limit: 10 });

        expect(result).toMatchObject({ ok: false, errorKind: 'not-signed-in' });
        expect(calls).toHaveLength(0);
    });

    it('sends both tokens on a library request and pages the result', async () => {
        const token = makeJwt(1_800_000_000);
        const { bridge, calls } = createTestBridge({
            responses: [
                ...devTokenResponses(token),
                {
                    status: 200,
                    body: {
                        data: [{ id: 'p.1', type: 'library-playlists', attributes: { name: 'A' } }],
                        next: '/v1/me/library/playlists?offset=1',
                        meta: { total: 5 },
                    },
                },
            ],
            cookies: [{ name: 'media-user-token', value: 'mut' }],
        });

        const result = await bridge.getLibraryPlaylists({ limit: 25, offset: 0 });

        expect(result.ok).toBe(true);
        expect(result.page.items).toHaveLength(1);
        expect(result.page.hasMore).toBe(true);
        expect(result.page.total).toBe(5);
        expect(calls[2]).toContain('/v1/me/library/playlists');
        expect(calls[2]).toContain('limit=25');
    });

    it('maps 403 to not-signed-in and 429 to throttled', async () => {
        const token = makeJwt(1_800_000_000);

        const forbidden = createTestBridge({
            responses: [...devTokenResponses(token), { status: 403, text: '{"errors":[]}' }],
            cookies: [{ name: 'media-user-token', value: 'mut' }],
        });
        await expect(forbidden.bridge.getLibraryPlaylists({}))
            .resolves.toMatchObject({ ok: false, errorKind: 'not-signed-in' });

        const throttled = createTestBridge({
            responses: [...devTokenResponses(token), { status: 429, text: 'slow down' }],
            cookies: [{ name: 'media-user-token', value: 'mut' }],
        });
        await expect(throttled.bridge.getLibraryPlaylists({}))
            .resolves.toMatchObject({ ok: false, errorKind: 'throttled' });
    });

    it('reports a failed developer-token scrape instead of throwing', async () => {
        const { bridge } = createTestBridge({
            responses: [{ status: 503, text: 'down' }],
            cookies: [{ name: 'media-user-token', value: 'mut' }],
        });
        await expect(bridge.getLibraryPlaylists({}))
            .resolves.toMatchObject({ ok: false, errorKind: 'dev-token-unavailable' });
    });

    it('retries once with a fresh developer token after a 401', async () => {
        const stale = makeJwt(1_800_000_000);
        const fresh = makeJwt(1_900_000_000);
        const { bridge, calls } = createTestBridge({
            responses: [
                ...devTokenResponses(stale),
                { status: 401, text: '{"errors":[]}' },
                // The forced refresh re-scrapes page + bundle.
                ...devTokenResponses(fresh),
                { status: 200, body: { data: [] } },
            ],
            cookies: [{ name: 'media-user-token', value: 'mut' }],
        });

        const result = await bridge.getLibraryPlaylists({});

        expect(result.ok).toBe(true);
        expect(calls.filter(url => url.includes('/v1/me/library/playlists'))).toHaveLength(2);
    });

    it('resolves catalog ids in one batch request without a limit parameter', async () => {
        // Regression: sending `limit` alongside `ids` is a 400, which resolved nothing at all.
        const token = makeJwt(1_800_000_000);
        const { bridge, calls } = createTestBridge({
            responses: [
                ...devTokenResponses(token),
                {
                    status: 200,
                    body: {
                        data: [
                            { id: '1', type: 'songs', attributes: { name: 'A', previews: [{ url: 'https://p/1.m4a' }] } },
                            { id: '2', type: 'songs', attributes: { name: 'B' } },
                        ],
                    },
                },
            ],
        });

        const result = await bridge.getCatalogSongsByIds(['1', '2', '1'], { storefront: 'cn' });

        expect(result.ok).toBe(true);
        expect(result.songs).toHaveLength(2);
        const catalogCall = calls.find(url => url.includes('/v1/catalog/cn/songs'));
        expect(catalogCall).toContain('ids=1%2C2');
        expect(catalogCall).not.toContain('limit=');
    });

    it('returns an empty success for an empty id list without calling out', async () => {
        const { bridge, calls } = createTestBridge({});
        await expect(bridge.getCatalogSongsByIds([])).resolves.toEqual({ ok: true, songs: [] });
        expect(calls).toHaveLength(0);
    });

    it('rejects a catalog playlist request with no id', async () => {
        const { bridge } = createTestBridge({});
        await expect(bridge.getCatalogPlaylist(''))
            .resolves.toMatchObject({ ok: false, errorKind: 'invalid-request' });
    });

    it('caches the developer token across requests', async () => {
        const token = makeJwt(Math.floor(1_700_000_000_000 / 1000) + 7200);
        const { bridge, calls } = createTestBridge({
            responses: [
                ...devTokenResponses(token),
                { status: 200, body: { data: [] } },
                { status: 200, body: { data: [] } },
            ],
        });

        await bridge.getCatalogPlaylist('pl.1', 'us');
        const afterFirst = calls.length;
        await bridge.getCatalogPlaylist('pl.2', 'us');

        // The second call adds exactly one request: the playlist itself.
        expect(calls.length).toBe(afterFirst + 1);
    });

    it('drops cached credentials on reset', async () => {
        const token = makeJwt(Math.floor(1_700_000_000_000 / 1000) + 7200);
        const { bridge, calls } = createTestBridge({
            responses: [
                ...devTokenResponses(token),
                { status: 200, body: { data: [] } },
                ...devTokenResponses(token),
                { status: 200, body: { data: [] } },
            ],
        });

        await bridge.getCatalogPlaylist('pl.1', 'us');
        const afterFirst = calls.length;
        bridge.resetCaches();
        await bridge.getCatalogPlaylist('pl.2', 'us');

        // Reset forces a re-scrape, so more than one extra request.
        expect(calls.length).toBeGreaterThan(afterFirst + 1);
    });

    it('surfaces a network failure as a structured result', async () => {
        const bridge = createAppleMusicLibraryBridge({
            fetchImpl: async () => { throw new Error('offline'); },
            getSession: () => ({ cookies: { get: async () => [] } }),
            now: () => 1_700_000_000_000,
            warn: () => {},
        });

        await expect(bridge.getCatalogPlaylist('pl.1', 'us'))
            .resolves.toMatchObject({ ok: false, errorKind: 'network' });
    });
});
