import { createRequire } from 'module';
import path from 'path';
import { describe, expect, it } from 'vitest';
import packageJson from '../../../package.json';

// test/unit/electron/externalMediaSmtcHelperPath.test.ts
//
// Locks the helper resolution priority: FOLIA_APPLE_MUSIC_SMTC_HELPER_PATH → <resources>/…exe →
// <repo>/build/…exe (dev only) → null.
//
// The dev slot is the regression this file exists for. Under `electron .` the app is unpackaged and
// `process.resourcesPath` names Electron's own resources directory, so before the fallback the exe
// that `npm run build:apple-music-smtc-helper` writes to <repo>/build/ was never looked at: the
// bridge reported helper-missing and the UI said "Apple Music unavailable" for a complete install,
// and the only way to use it was to export the override by hand for every launch style.
//
// The packaged test is the other half: a release must never pick up a stray dev artifact, so the
// fallback is deliberately gated on `isPackaged`.

const require = createRequire(import.meta.url);
const {
    resolveExternalMediaSmtcHelperPath,
    HELPER_BINARY_NAME,
    DEV_BUILD_DIR,
} = require('../../../electron/externalMediaSmtcHelperPath.cjs') as {
    resolveExternalMediaSmtcHelperPath: (options: {
        platform?: string;
        env?: Record<string, string | undefined>;
        resourcesPath?: string;
        isPackaged?: boolean;
        appPath?: string;
        fileExists: (candidate: string) => boolean;
    }) => string | null;
    HELPER_BINARY_NAME: string;
    DEV_BUILD_DIR: string;
};

const RESOURCES = path.join('/tmp', 'folia-resources-fixture');
const APP_PATH = path.join('/tmp', 'folia-app-fixture');
const PACKAGED = path.join(RESOURCES, HELPER_BINARY_NAME);
const DEV_BUILD = path.join(APP_PATH, DEV_BUILD_DIR, HELPER_BINARY_NAME);

/** Resolves against a virtual filesystem: only the listed paths exist. */
const resolveWith = ({
    platform = 'win32',
    env = {},
    resourcesPath = RESOURCES,
    isPackaged = false,
    appPath = APP_PATH,
    existing = [],
}: {
    platform?: string;
    env?: Record<string, string | undefined>;
    resourcesPath?: string | undefined;
    isPackaged?: boolean;
    appPath?: string;
    existing?: string[];
} = {}) => resolveExternalMediaSmtcHelperPath({
    platform,
    env,
    resourcesPath,
    isPackaged,
    appPath,
    fileExists: candidate => existing.includes(candidate),
});

describe('resolveExternalMediaSmtcHelperPath', () => {
    it('is Windows-only', () => {
        expect(resolveWith({ platform: 'linux', existing: [PACKAGED, DEV_BUILD] })).toBeNull();
        expect(resolveWith({ platform: 'darwin', existing: [PACKAGED, DEV_BUILD] })).toBeNull();
    });

    it('prefers the environment override over both directories', () => {
        const override = path.join('/tmp', 'explicit-helper.exe');

        expect(resolveWith({
            env: { FOLIA_APPLE_MUSIC_SMTC_HELPER_PATH: override },
            existing: [override, PACKAGED, DEV_BUILD],
        })).toBe(override);
    });

    it('does not fall through when the override is set but missing', () => {
        // A typo in the override must be visible instead of silently resolving to another binary.
        expect(resolveWith({
            env: { FOLIA_APPLE_MUSIC_SMTC_HELPER_PATH: path.join('/tmp', 'typo.exe') },
            existing: [PACKAGED, DEV_BUILD],
        })).toBeNull();
    });

    it('ignores a blank override', () => {
        expect(resolveWith({
            env: { FOLIA_APPLE_MUSIC_SMTC_HELPER_PATH: '   ' },
            existing: [PACKAGED],
        })).toBe(PACKAGED);
    });

    it('resolves the packaged resources layout', () => {
        expect(resolveWith({ isPackaged: true, existing: [PACKAGED] })).toBe(PACKAGED);
    });

    it('resolves <repo>/build/… for an unpackaged run', () => {
        // The regression: this returned null before the fallback existed.
        expect(resolveWith({ isPackaged: false, existing: [DEV_BUILD] })).toBe(DEV_BUILD);
    });

    it('prefers the packaged copy over the dev copy when both exist', () => {
        expect(resolveWith({ isPackaged: false, existing: [PACKAGED, DEV_BUILD] })).toBe(PACKAGED);
    });

    it('never uses a dev artifact in a packaged app', () => {
        // A release install that somehow has <repo>/build around must still report unavailable.
        let probedDevPath = false;
        const resolved = resolveExternalMediaSmtcHelperPath({
            platform: 'win32',
            env: {},
            resourcesPath: RESOURCES,
            isPackaged: true,
            appPath: APP_PATH,
            fileExists: candidate => {
                if (candidate === DEV_BUILD) probedDevPath = true;
                return false;
            },
        });

        expect(resolved).toBeNull();
        expect(probedDevPath).toBe(false);
    });

    it('returns null when nothing is installed, which is a supported outcome', () => {
        expect(resolveWith({ isPackaged: false, existing: [] })).toBeNull();
        expect(resolveWith({ isPackaged: true, existing: [] })).toBeNull();
    });

    it('tolerates a missing resourcesPath', () => {
        expect(resolveWith({ resourcesPath: undefined, existing: [DEV_BUILD] })).toBe(DEV_BUILD);
    });

    it('packages the binary into the resources root the resolver reads', () => {
        // package.json win.extraResources copies build/ -> . ; a nested destination would make every
        // packaged install report helper-missing while dev kept working.
        const extraResources = packageJson.build.win.extraResources as Array<{
            from: string;
            to: string;
            filter?: string[];
        }>;
        const winEntry = extraResources.find(entry => entry.to === '.');
        expect(winEntry).toBeDefined();
        expect(winEntry?.filter).toContain(HELPER_BINARY_NAME);
        expect(DEV_BUILD_DIR).toBe('build');
        expect(path.basename(winEntry?.from ?? '')).toBe(DEV_BUILD_DIR);
    });
});
