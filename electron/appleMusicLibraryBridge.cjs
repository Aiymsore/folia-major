// electron/appleMusicLibraryBridge.cjs
// Apple Music library bridge: reads the user's Apple Music library (playlists, songs,
// albums) and catalog resources through Apple's private web API, so Folia can render an
// Apple Music home surface without registering a fourth Omni provider.
//
// Why the web API and not MusicKit: a developer token needs a paid Apple Developer
// membership, and even then it cannot play full tracks (FairPlay/DRM). The web player's
// own backend is the same path Cider and Music Assistant use, and it is the only one that
// works with a plain consumer account.
//
// Credential model, in priority order:
//   1. `media-user-token` from a Folia-owned Electron session partition, populated by the
//      user signing in to music.apple.com once in a window we open. Cookies come back in
//      plaintext through `ses.cookies.get()`, so there is no DPAPI/keychain reverse
//      engineering and no password ever reaches this process.
//   2. Nothing. The bridge then reports `signed-out` and the renderer falls back to public
//      catalog browsing, which needs no account at all.
//
// The developer token is scraped from the public web player bundle and cached until shortly
// before it expires. It is a shared, rate-limited token: catalog browsing is fine, but bulk
// work can be throttled, which surfaces as `throttled` rather than an empty result.
//
// Every side effect is injected (`fetchImpl`, `session`, `now`) so the request building,
// response normalization, and token lifecycle are unit-testable without Electron or network.

'use strict';

const AMP_API_BASE = 'https://amp-api.music.apple.com';
const WEB_PLAYER_ORIGIN = 'https://music.apple.com';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Session partition holding the Apple Music sign-in. Kept out of the default session so
 *  Folia's own cookies and proxy state can never be confused with Apple's.
 *
 *  The `persist:` prefix is load-bearing: Electron treats a bare partition name as in-memory
 *  only, which would silently discard the sign-in on every restart and send the user back to
 *  the login page forever. */
const APPLE_MUSIC_PARTITION = 'persist:folia-apple-music';

/** The media-user-token cookie Apple's web player stores after sign-in.
 *
 *  Two names exist in the wild and both must be accepted: the current web player sets a
 *  cookie literally named `media-user-token`, while older profiles carry `mt-tkn-<dsid>`.
 *  Verified against a signed-in Windows profile on 2026-09-22: the live cookie is
 *  `media-user-token`, and a bridge that only looked for `mt-tkn-` reported "signed out"
 *  for an account that was in fact signed in. */
const MEDIA_USER_TOKEN_NAMES = ['media-user-token'];
const MEDIA_USER_TOKEN_PREFIX = 'mt-tkn-';

/** True when a cookie name carries the Apple Music user token, under either naming scheme. */
const isMediaUserTokenCookieName = (name) => (
  typeof name === 'string'
  && (MEDIA_USER_TOKEN_NAMES.includes(name) || name.startsWith(MEDIA_USER_TOKEN_PREFIX))
);

/** Refresh the developer token this long before it actually expires. */
const DEV_TOKEN_REFRESH_MARGIN_MS = 60 * 60 * 1000;

/** Catalog pages are capped by Apple; keep requests inside the documented window. */
const MAX_PAGE_LIMIT = 100;

/** How many catalog ids one `?ids=` batch may carry. Apple accepts more, but chunking keeps
 *  a single failure from discarding a whole playlist's worth of resolution. */
const CATALOG_ID_BATCH_SIZE = 100;

const ERR_KIND_NOT_SIGNED_IN = 'not-signed-in';
const ERR_KIND_THROTTLED = 'throttled';
const ERR_KIND_DEV_TOKEN = 'dev-token-unavailable';
const ERR_KIND_NETWORK = 'network';
const ERR_KIND_UPSTREAM = 'upstream';
const ERR_KIND_INVALID_REQUEST = 'invalid-request';

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Clamps a caller-supplied page size into Apple's accepted range. */
const clampLimit = (limit, fallback = 25) => {
  const numeric = Number(limit);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(Math.floor(numeric), MAX_PAGE_LIMIT);
};

const clampOffset = (offset) => {
  const numeric = Number(offset);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.floor(numeric);
};

/**
 * Apple's artwork URLs are templates: `.../{w}x{h}bb.jpg` (catalog) or `.../{w}x{h}cc.jpg`
 * (library). Folia always wants a square cover at a known size, so substitute the dimensions
 * while PRESERVING the template's own crop code — `cc` and `bb` crop differently, and
 * overwriting one with the other changes how the cover is framed.
 *
 * Some library playlists instead return an already-signed blobstore URL with no placeholders;
 * those are returned untouched, because rewriting them would invalidate the signature.
 */
const buildArtworkUrl = (artwork, size = 600) => {
  const template = isRecord(artwork) ? artwork.url : null;
  if (typeof template !== 'string' || template.length === 0) return undefined;
  if (!template.includes('{w}') && !template.includes('{h}')) return template;
  return template
    .replace('{w}', String(size))
    .replace('{h}', String(size))
    .replace('{f}', 'jpg');
};

/** Extracts the JWT the public web player ships inside its own JS bundle. */
const extractDevTokenFromBundle = (source) => {
  if (typeof source !== 'string') return null;
  const match = source.match(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/);
  return match ? match[0] : null;
};

/** Reads `exp` out of a JWT without verifying it — we only need the refresh deadline. */
const readJwtExpiryMs = (token) => {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
};

/**
 * Numeric storefront ids Apple's own `itspod` cookie uses, mapped to the ISO codes every catalog
 * endpoint requires.
 *
 * The cookie carries the NUMBER (`43` for mainland China), and passing it straight through yields
 * `400 Unknown storefront '43'` — which silently breaks preview resolution for every library
 * track, because that is the request that turns a library row into something playable. Found by
 * running the real bridge against a real signed-in account.
 *
 * Unmapped ids fall back to `us` (Apple's default, which always resolves) rather than failing.
 */
const STOREFRONT_IDS = {
  '43': 'cn',
  '143441': 'us',
  '143442': 'fr',
  '143443': 'de',
  '143444': 'gb',
  '143445': 'at',
  '143446': 'it',
  '143447': 'nl',
  '143448': 'be',
  '143449': 'es',
  '143450': 'dk',
  '143451': 'fi',
  '143452': 'no',
  '143453': 'se',
  '143454': 'ch',
  '143455': 'ie',
  '143456': 'lu',
  '143457': 'pt',
  '143458': 'au',
  '143459': 'nz',
  '143460': 'jp',
  '143461': 'ca',
  '143462': 'mx',
  '143463': 'br',
  '143464': 'ar',
  '143465': 'cl',
  '143466': 'co',
  '143467': 'ru',
  '143468': 'in',
  '143469': 'id',
  '143470': 'th',
  '143471': 'my',
  '143472': 'sg',
  '143473': 'ph',
  '143474': 'vn',
  '143475': 'hk',
  '143476': 'tw',
  '143477': 'kr',
  '143478': 'za',
  '143479': 'eg',
  '143480': 'tr',
  '143481': 'sa',
  '143482': 'ae',
};

/** The two-letter code for a storefront value, whether it arrived as an id or already a code. */
const normalizeStorefront = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  // Already an ISO code.
  if (/^[a-z]{2}$/i.test(trimmed)) return trimmed.toLowerCase();
  return STOREFRONT_IDS[trimmed] || null;
};

/** Reads the account's storefront out of the `itspod` cookie, normalized to an ISO code. */
const resolveStorefrontFromCookie = (cookies) => {
  if (!Array.isArray(cookies)) return null;
  const match = cookies.find((cookie) => cookie && cookie.name === 'itspod');
  return match ? normalizeStorefront(match.value) : null;
};

/**
 * Normalizes one Apple Music catalog/library song resource into the shape Folia's
 * Apple Music surface consumes. Deliberately NOT `UnifiedSong`: Apple Music is a content
 * source here, not an Omni provider, so it must not be forced into the online identity
 * contract (`sourceRef.providerId`) that Omni owns.
 *
 * `catalogId` is the field that matters most downstream. Library rows are identified as
 * `a.<n>` and carry NO `previews` array at all — verified against a signed-in account on
 * 2026-09-22 — so a library playlist cannot be played from the library response alone. The
 * only way to reach a playable track is `attributes.playParams.catalogId`, looked up
 * against the catalog endpoint. `resource.id` is deliberately NOT used as a fallback:
 * `a.1538098094` 404s against the catalog, so falling back to it would silently turn every
 * library track into an unplayable row.
 *
 * The 90-second preview (`attributes.previews[].url` → `previewUrl`) is deliberately NOT
 * extracted any more: the external-media backend only plays web full tracks, and the preview
 * field had no consumer left.
 */
const normalizeSong = (resource) => {
  if (!isRecord(resource)) return null;
  const attributes = isRecord(resource.attributes) ? resource.attributes : {};
  const id = resource.id != null ? String(resource.id) : null;
  if (!id) return null;

  const playParams = isRecord(attributes.playParams) ? attributes.playParams : {};

  return {
    id,
    type: resource.type === 'library-songs' ? 'library-song' : 'song',
    title: typeof attributes.name === 'string' ? attributes.name : '',
    artist: typeof attributes.artistName === 'string' ? attributes.artistName : '',
    album: typeof attributes.albumName === 'string' ? attributes.albumName : '',
    albumId: attributes.albumId != null ? String(attributes.albumId) : null,
    durationMs: Number.isFinite(attributes.durationInMillis) ? attributes.durationInMillis : null,
    trackNumber: Number.isFinite(attributes.trackNumber) ? attributes.trackNumber : null,
    discNumber: Number.isFinite(attributes.discNumber) ? attributes.discNumber : null,
    isrc: typeof attributes.isrc === 'string' ? attributes.isrc : null,
    coverUrl: buildArtworkUrl(attributes.artwork),
    hasLyrics: Boolean(attributes.hasLyrics),
    contentRating: typeof attributes.contentRating === 'string' ? attributes.contentRating : null,
    /** The catalog song id this row refers to. Absent for library-only uploads, which have
     *  no catalog entry and therefore nothing to playById — those stay visible but unplayable. */
    catalogId: playParams.catalogId != null ? String(playParams.catalogId) : null,
    isLibrary: Boolean(playParams.isLibrary) || resource.type === 'library-songs',
    /** Apple Music's own deep link, used for "play the full track in Apple Music". */
    url: typeof attributes.url === 'string' ? attributes.url : null,
  };
};

/** Normalizes a playlist (library or catalog) into Folia's Apple Music collection shape. */
const normalizePlaylist = (resource) => {
  if (!isRecord(resource)) return null;
  const attributes = isRecord(resource.attributes) ? resource.attributes : {};
  const id = resource.id != null ? String(resource.id) : null;
  if (!id) return null;

  return {
    id,
    type: 'playlist',
    name: typeof attributes.name === 'string' ? attributes.name : '',
    description: isRecord(attributes.description)
      ? (typeof attributes.description.standard === 'string' ? attributes.description.standard : '')
      : (typeof attributes.description === 'string' ? attributes.description : ''),
    curator: typeof attributes.curatorName === 'string' ? attributes.curatorName : '',
    trackCount: Number.isFinite(attributes.trackCount) ? attributes.trackCount : null,
    coverUrl: buildArtworkUrl(attributes.artwork),
    canEdit: Boolean(attributes.canEdit),
    isLibrary: resource.type === 'library-playlists',
    url: typeof attributes.url === 'string' ? attributes.url : null,
  };
};

/** Normalizes an album into the collection shape used by the grid. */
const normalizeAlbum = (resource) => {
  if (!isRecord(resource)) return null;
  const attributes = isRecord(resource.attributes) ? resource.attributes : {};
  const id = resource.id != null ? String(resource.id) : null;
  if (!id) return null;

  return {
    id,
    type: 'album',
    name: typeof attributes.name === 'string' ? attributes.name : '',
    description: typeof attributes.artistName === 'string' ? attributes.artistName : '',
    curator: typeof attributes.artistName === 'string' ? attributes.artistName : '',
    trackCount: Number.isFinite(attributes.trackCount) ? attributes.trackCount : null,
    coverUrl: buildArtworkUrl(attributes.artwork),
    releaseDate: typeof attributes.releaseDate === 'string' ? attributes.releaseDate : null,
    isLibrary: resource.type === 'library-albums',
    url: typeof attributes.url === 'string' ? attributes.url : null,
  };
};

/**
 * Builds the bridge. All I/O is injected so the module can be unit-tested directly and so
 * main.cjs stays the only place that knows about Electron.
 */
function createAppleMusicLibraryBridge(options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    getSession = () => null,
    now = () => Date.now(),
    warn = () => {},
  } = options;

  /** Cached developer token plus the moment it stops being usable. */
  let devTokenCache = null;

  /** The storefront is account-specific, so it is resolved per signed-in user. */
  let storefrontCache = null;

  const readMediaUserToken = async () => {
    const session = getSession();
    if (!session || typeof session.cookies?.get !== 'function') return null;
    try {
      const cookies = await session.cookies.get({ domain: '.itunes.apple.com' });
      const match = cookies.find((cookie) => cookie && isMediaUserTokenCookieName(cookie.name)
        && typeof cookie.value === 'string' && cookie.value.length > 0);
      return match ? match.value : null;
    } catch (error) {
      warn('[AppleMusicLibrary] failed to read session cookies', error);
      return null;
    }
  };

  const readStorefront = async () => {
    if (storefrontCache) return storefrontCache;
    const session = getSession();
    if (!session || typeof session.cookies?.get !== 'function') return null;
    try {
      const cookies = await session.cookies.get({ domain: '.apple.com' });
      storefrontCache = resolveStorefrontFromCookie(cookies);
      return storefrontCache;
    } catch {
      return null;
    }
  };

  /**
   * Fetches the public web player bundle and pulls its embedded developer token out.
   * Cached until shortly before expiry; a failure here is reported as
   * `dev-token-unavailable` rather than thrown, because it is the one dependency that can
   * break without the user doing anything wrong (Apple rotates the bundle).
   */
  const getDevToken = async (forceRefresh = false) => {
    const current = now();
    if (!forceRefresh && devTokenCache && devTokenCache.expiresAt - DEV_TOKEN_REFRESH_MARGIN_MS > current) {
      return { ok: true, token: devTokenCache.token };
    }

    try {
      const pageResponse = await fetchImpl(`${WEB_PLAYER_ORIGIN}/us/browse`, {
        headers: { 'user-agent': BROWSER_UA },
      });
      if (!pageResponse.ok) {
        return { ok: false, errorKind: ERR_KIND_DEV_TOKEN, message: `web player page returned ${pageResponse.status}` };
      }
      const html = await pageResponse.text();
      const bundleMatch = html.match(/<script[^>]+src="(\/assets\/index[^"]+\.js)"/);
      if (!bundleMatch) {
        return { ok: false, errorKind: ERR_KIND_DEV_TOKEN, message: 'web player bundle not found in page' };
      }

      const bundleResponse = await fetchImpl(`${WEB_PLAYER_ORIGIN}${bundleMatch[1]}`, {
        headers: { 'user-agent': BROWSER_UA },
      });
      if (!bundleResponse.ok) {
        return { ok: false, errorKind: ERR_KIND_DEV_TOKEN, message: `web player bundle returned ${bundleResponse.status}` };
      }

      const token = extractDevTokenFromBundle(await bundleResponse.text());
      if (!token) {
        return { ok: false, errorKind: ERR_KIND_DEV_TOKEN, message: 'no developer token in web player bundle' };
      }

      const expiresAt = readJwtExpiryMs(token) ?? (current + 60 * 60 * 1000);
      devTokenCache = { token, expiresAt };
      return { ok: true, token };
    } catch (error) {
      return {
        ok: false,
        errorKind: ERR_KIND_NETWORK,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };

  /** Maps an HTTP status onto the structured error kinds callers branch on. */
  const classifyResponse = (status, body) => {
    if (status === 401 || status === 403) {
      return { errorKind: ERR_KIND_NOT_SIGNED_IN, message: 'Apple Music rejected the credentials' };
    }
    if (status === 429) {
      return { errorKind: ERR_KIND_THROTTLED, message: 'Apple Music rate limit reached' };
    }
    return { errorKind: ERR_KIND_UPSTREAM, message: `Apple Music returned ${status}: ${body.slice(0, 200)}` };
  };

  /**
   * One authenticated request against the private web API. `requiresAuth` decides whether a
   * missing media-user-token is fatal (library calls) or merely means an anonymous request
   * (catalog calls, which work without any account).
   */
  const request = async (path, { requiresAuth = false, query } = {}) => {
    // Sign-in is checked BEFORE the developer token is fetched. Two reasons: a signed-out user
    // must get `not-signed-in` rather than whatever the token scrape happens to fail with, and a
    // call that cannot succeed must not spend a request (the web-player token is rate limited).
    let mediaUserToken = null;
    if (requiresAuth) {
      mediaUserToken = await readMediaUserToken();
      if (!mediaUserToken) {
        return { ok: false, errorKind: ERR_KIND_NOT_SIGNED_IN, message: 'not signed in to Apple Music' };
      }
    }

    const dev = await getDevToken();
    if (!dev.ok) return dev;

    const headers = {
      'user-agent': BROWSER_UA,
      authorization: `Bearer ${dev.token}`,
      origin: WEB_PLAYER_ORIGIN,
      referer: `${WEB_PLAYER_ORIGIN}/`,
      accept: 'application/json',
    };

    if (mediaUserToken) {
      headers['media-user-token'] = mediaUserToken;
    }

    const url = new URL(`${AMP_API_BASE}${path}`);
    for (const [key, value] of Object.entries(query || {})) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }

    let response;
    try {
      response = await fetchImpl(url.toString(), { headers });
    } catch (error) {
      return {
        ok: false,
        errorKind: ERR_KIND_NETWORK,
        message: error instanceof Error ? error.message : String(error),
      };
    }

    const body = await response.text();
    if (!response.ok) {
      // A rejected developer token is worth exactly one retry with a freshly scraped one;
      // the bundle rotates on Apple's schedule, not ours.
      if (response.status === 401) {
        const refreshed = await getDevToken(true);
        if (refreshed.ok) {
          headers.authorization = `Bearer ${refreshed.token}`;
          try {
            const retry = await fetchImpl(url.toString(), { headers });
            const retryBody = await retry.text();
            if (retry.ok) {
              return { ok: true, data: JSON.parse(retryBody) };
            }
            return { ok: false, ...classifyResponse(retry.status, retryBody) };
          } catch (error) {
            return {
              ok: false,
              errorKind: ERR_KIND_NETWORK,
              message: error instanceof Error ? error.message : String(error),
            };
          }
        }
      }
      return { ok: false, ...classifyResponse(response.status, body) };
    }

    try {
      return { ok: true, data: JSON.parse(body) };
    } catch (error) {
      return {
        ok: false,
        errorKind: ERR_KIND_UPSTREAM,
        message: `Apple Music returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };

  /** Reads a paginated collection and normalizes every row through `normalize`. */
  const readCollection = async (path, normalize, { limit, offset, requiresAuth = false, query } = {}) => {
    const result = await request(path, {
      requiresAuth,
      query: { ...query, limit: clampLimit(limit), offset: clampOffset(offset) },
    });
    if (!result.ok) return result;

    const rows = Array.isArray(result.data?.data) ? result.data.data : [];
    const items = rows.map(normalize).filter(Boolean);
    const hasMore = Boolean(result.data?.next);
    const nextOffset = hasMore ? clampOffset(offset) + items.length : clampOffset(offset) + items.length;

    return {
      ok: true,
      page: {
        items,
        hasMore,
        nextOffset,
        total: Number.isFinite(result.data?.meta?.total) ? result.data.meta.total : undefined,
      },
    };
  };

  return {
    /**
     * Whether the user has signed in, plus what we know about the account. The renderer
     * uses this to decide between the library surface and the public-catalog fallback.
     */
    async getStatus() {
      const mediaUserToken = await readMediaUserToken();
      if (!mediaUserToken) {
        return { signedIn: false, storefront: null };
      }
      const storefront = await readStorefront();
      return { signedIn: true, storefront };
    },

    /** The user's own playlists. Requires sign-in. */
    async getLibraryPlaylists({ limit, offset } = {}) {
      return readCollection('/v1/me/library/playlists', normalizePlaylist, {
        limit,
        offset,
        requiresAuth: true,
      });
    },

    /** The user's own albums. Requires sign-in. */
    async getLibraryAlbums({ limit, offset } = {}) {
      return readCollection('/v1/me/library/albums', normalizeAlbum, {
        limit,
        offset,
        requiresAuth: true,
      });
    },

    /** The user's library songs, i.e. everything added to the library. Requires sign-in. */
    async getLibrarySongs({ limit, offset } = {}) {
      return readCollection('/v1/me/library/songs', normalizeSong, {
        limit,
        offset,
        requiresAuth: true,
      });
    },

    /**
     * The tracks of one library playlist. Apple returns the tracks relationship on the
     * playlist itself; this walks it with paging so a 500-track playlist is not truncated.
     */
    async getLibraryPlaylistTracks(playlistId, { limit, offset } = {}) {
      if (!playlistId) {
        return { ok: false, errorKind: ERR_KIND_INVALID_REQUEST, message: 'playlistId is required' };
      }
      return readCollection(
        `/v1/me/library/playlists/${encodeURIComponent(String(playlistId))}/tracks`,
        normalizeSong,
        { limit, offset, requiresAuth: true },
      );
    },

    /** The tracks of one library album. Requires sign-in. */
    async getLibraryAlbumTracks(albumId, { limit, offset } = {}) {
      if (!albumId) {
        return { ok: false, errorKind: ERR_KIND_INVALID_REQUEST, message: 'albumId is required' };
      }
      return readCollection(
        `/v1/me/library/albums/${encodeURIComponent(String(albumId))}/tracks`,
        normalizeSong,
        { limit, offset, requiresAuth: true },
      );
    },

    /**
     * Resolves catalog ids into playable catalog songs, in batches.
     *
     * This exists because library rows and catalog rows are not interchangeable: a library
     * track carries `a.<n>` as its id and no `previews`, so its `playParams.catalogId` has to
     * be exchanged for the catalog resource before there is anything to stream. Batched with
     * `?ids=` (verified 25/25 resolved) because one request per track would be unusable on a
     * 500-track playlist.
     *
     * `limit` must NOT be sent alongside `ids` — Apple rejects that combination with a 400
     * "Limit may not be supplied on this request".
     */
    async getCatalogSongsByIds(ids, { storefront = 'us' } = {}) {
      const unique = Array.from(new Set(
        (Array.isArray(ids) ? ids : [])
          .map((id) => (id == null ? null : String(id).trim()))
          .filter((id) => Boolean(id)),
      ));
      if (unique.length === 0) {
        return { ok: true, songs: [] };
      }

      const songs = [];
      const failedChunks = [];
      for (let index = 0; index < unique.length; index += CATALOG_ID_BATCH_SIZE) {
        const chunk = unique.slice(index, index + CATALOG_ID_BATCH_SIZE);
        const result = await request(`/v1/catalog/${encodeURIComponent(String(storefront))}/songs`, {
          query: { ids: chunk.join(',') },
        });
        if (!result.ok) {
          failedChunks.push(result);
          continue;
        }
        const rows = Array.isArray(result.data?.data) ? result.data.data : [];
        for (const row of rows) {
          const song = normalizeSong(row);
          if (song) songs.push(song);
        }
      }

      // Partial success is the normal case (a few uploads have no catalog entry), so only
      // report failure when nothing at all could be resolved.
      if (songs.length === 0 && failedChunks.length > 0) {
        return failedChunks[0];
      }
      return { ok: true, songs, partialFailures: failedChunks.length };
    },

    /** Catalog browsing works with no account at all, which is what makes the Web/Docker
     *  build able to show Apple Music without any credential handling. */
    async getCatalogPlaylist(playlistId, storefront = 'us') {
      if (!playlistId) {
        return { ok: false, errorKind: ERR_KIND_INVALID_REQUEST, message: 'playlistId is required' };
      }
      const result = await request(
        `/v1/catalog/${encodeURIComponent(String(storefront))}/playlists/${encodeURIComponent(String(playlistId))}`,
        { query: { include: 'tracks' } },
      );
      if (!result.ok) return result;

      const resource = Array.isArray(result.data?.data) ? result.data.data[0] : null;
      const playlist = normalizePlaylist(resource);
      if (!playlist) {
        return { ok: false, errorKind: ERR_KIND_UPSTREAM, message: 'catalog playlist was empty' };
      }

      const tracks = isRecord(resource?.relationships?.tracks) && Array.isArray(resource.relationships.tracks.data)
        ? resource.relationships.tracks.data.map(normalizeSong).filter(Boolean)
        : [];

      return {
        ok: true,
        playlist,
        tracks,
        hasMoreTracks: Boolean(resource?.relationships?.tracks?.next),
      };
    },

    /** Catalog search. Also account-free. */
    async searchCatalog(term, { storefront = 'us', limit, offset, types = 'songs' } = {}) {
      if (!term || String(term).trim().length === 0) {
        return { ok: false, errorKind: ERR_KIND_INVALID_REQUEST, message: 'term is required' };
      }
      const result = await request(`/v1/catalog/${encodeURIComponent(String(storefront))}/search`, {
        query: { term: String(term), types, limit: clampLimit(limit, 25), offset: clampOffset(offset) },
      });
      if (!result.ok) return result;

      const songs = result.data?.results?.songs?.data;
      return {
        ok: true,
        page: {
          items: Array.isArray(songs) ? songs.map(normalizeSong).filter(Boolean) : [],
          hasMore: Boolean(result.data?.results?.songs?.next),
          nextOffset: clampOffset(offset),
        },
      };
    },

    /** Exposed for tests and for the settings surface's "connection" readout. */
    async getDevTokenStatus() {
      const result = await getDevToken();
      if (!result.ok) return result;
      return {
        ok: true,
        expiresAt: devTokenCache ? devTokenCache.expiresAt : null,
      };
    },

    /** Drops cached credentials so a sign-out is visible immediately. */
    resetCaches() {
      devTokenCache = null;
      storefrontCache = null;
    },
  };
}

module.exports = {
  createAppleMusicLibraryBridge,
  // Exported for direct unit tests of the pure pieces.
  buildArtworkUrl,
  clampLimit,
  clampOffset,
  extractDevTokenFromBundle,
  readJwtExpiryMs,
  resolveStorefrontFromCookie,
  normalizeStorefront,
  isMediaUserTokenCookieName,
  normalizeSong,
  normalizePlaylist,
  normalizeAlbum,
  AMP_API_BASE,
  APPLE_MUSIC_PARTITION,
  MEDIA_USER_TOKEN_PREFIX,
  ERR_KIND_NOT_SIGNED_IN,
  ERR_KIND_THROTTLED,
  ERR_KIND_DEV_TOKEN,
  ERR_KIND_NETWORK,
  ERR_KIND_UPSTREAM,
  ERR_KIND_INVALID_REQUEST,
};
