// electron/appleMusicSmtcHelperPath.cjs
// Locates folia-apple-music-smtc-helper.exe with a deterministic priority order.
//
// Split out of main.cjs for the same reason electron/modSystem/ffmpeg.cjs is its own module: the
// order is the whole behaviour, and it can only be asserted when every input is injectable (the
// resolver reads no globals and touches no filesystem itself — `fileExists` is passed in).
//
// Why a dev fallback exists at all: under `electron .` (unpackaged) `resourcesPath` names Electron's
// OWN resources directory, not the checkout, so the exe that `npm run build:apple-music-smtc-helper`
// writes to <repo>/build/ was never looked at. The renderer then reported "Apple Music unavailable"
// for an install that was in fact complete, and the only way out was for the developer to export
// FOLIA_APPLE_MUSIC_SMTC_HELPER_PATH by hand for every launch style.
//
// The wallpaper helper does not need this because the dev:electron* scripts inject
// FOLIA_WALLPAPER_HELPER_PATH. This resolver is reached from launches the scripts do not wrap
// (a bare `electron .`, `dev:electron:dist`, the packaged app), so it carries the fallback itself —
// the same shape as getBundledModelsDirectory() in main.cjs.

'use strict';

const path = require('path');

const HELPER_BINARY_NAME = 'folia-apple-music-smtc-helper.exe';

/** The packaged location: `<resources>/folia-apple-music-smtc-helper.exe` (win extraResources). */
const RESOURCES_SLOT = '';

/** The in-repo location the build script writes to, used by dev runs. */
const DEV_BUILD_DIR = 'build';

/**
 * Resolves the helper path, or null when this machine cannot run it.
 *
 * Priority:
 *   1. `FOLIA_APPLE_MUSIC_SMTC_HELPER_PATH` — explicit override, wins over everything. A set but
 *      missing path resolves to null rather than silently falling through: a typo in the override is
 *      a mistake to surface, not a reason to quietly use another binary.
 *   2. `<resourcesPath>/folia-apple-music-smtc-helper.exe` — the packaged release layout.
 *   3. `<appPath>/build/folia-apple-music-smtc-helper.exe` — dev only (unpackaged). The in-repo slot
 *      sits last, exactly like the ffmpeg resolver's localDirName candidate.
 *
 * Returning null is a supported outcome: the bridge reports `helper-missing` and the UI shows
 * "unavailable". Apple Music support is additive and must never block app startup.
 */
const resolveAppleMusicSmtcHelperPath = ({
    platform = process.platform,
    env = process.env,
    resourcesPath = process.resourcesPath,
    isPackaged = true,
    appPath,
    fileExists,
} = {}) => {
    // Windows-only: the helper speaks the WinRT GSMTC API and nothing else.
    if (platform !== 'win32') {
        return null;
    }

    const override = env && env.FOLIA_APPLE_MUSIC_SMTC_HELPER_PATH;
    if (typeof override === 'string' && override.trim().length > 0) {
        const trimmed = override.trim();
        return fileExists(trimmed) ? trimmed : null;
    }

    const packaged = resourcesPath ? path.join(resourcesPath, HELPER_BINARY_NAME) : null;
    if (packaged && fileExists(packaged)) {
        return packaged;
    }

    if (!isPackaged && appPath) {
        const devCandidate = path.join(appPath, DEV_BUILD_DIR, HELPER_BINARY_NAME);
        if (fileExists(devCandidate)) {
            return devCandidate;
        }
    }

    return null;
};

module.exports = {
    resolveAppleMusicSmtcHelperPath,
    HELPER_BINARY_NAME,
    DEV_BUILD_DIR,
};
