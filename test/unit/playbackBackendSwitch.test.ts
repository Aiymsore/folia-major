import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useActivePlaybackBackendStore } from '../../src/stores/useActivePlaybackBackendStore';
import { useAppleMusicSmtcStore } from '../../src/stores/useAppleMusicSmtcStore';
import {
    isAppleMusicSelectable,
    leaveAppleMusicForStage,
    selectAppleMusicBackend,
    selectFoliaBackend,
} from '../../src/hooks/usePlaybackBackendSwitch';
import { resolveAppleMusicAvailability } from '../../src/utils/appleMusicSmtcStatus';

// test/unit/playbackBackendSwitch.test.ts
// Phase 3A 的显式 backend 切换契约（全部由**用户操作**触发，没有任何自动抢占）：
//
//   选中 Apple Music          → best-effort 暂停 Folia（仅在真的在播时），backend = apple-music，
//                               **绝不自动 play Apple Music**
//   选中 Folia 原生平台        → best-effort pause Apple Music，backend = folia，**绝不自动 resume Folia**
//   进入 Stage                → 与上一条同一套动作，保证
//                               `activePlaybackContext === 'stage' && backend === 'apple-music'` 不成立
//
// best-effort 的含义也在断言里：暂停失败、bridge 缺失、session 缺失都不阻塞 backend 切换。

const status = (over: Partial<ElectronAppleMusicSmtcStatus> = {}): ElectronAppleMusicSmtcStatus => ({
    bridgeAvailable: true,
    helperState: 'running',
    connected: true,
    sourceAppUserModelId: 'AppleInc.AppleMusicWin_nzyj5cx40ttqa!App',
    title: 'Track',
    artist: 'Artist',
    album: null,
    playbackStatus: 'Playing',
    positionMs: 1_000,
    durationMs: 200_000,
    hasThumbnail: false,
    updatedAt: 1,
    lastEventAt: 1,
    sessionCount: 1,
    lastCommand: null,
    lastError: null,
    ...over,
});

type SentCommand = { command: string; positionMs?: number };
let sent: SentCommand[] = [];

const installBridge = (options: { reject?: boolean } = {}) => {
    (globalThis as unknown as { window: unknown }).window = {
        electron: {
            appleMusicSendCommand: (request: SentCommand) => {
                sent.push(request);
                return options.reject ? Promise.reject(new Error('boom')) : Promise.resolve({ ok: true });
            },
        },
    };
};

const backend = () => useActivePlaybackBackendStore.getState().activeBackend;

describe('playback backend switch', () => {
    beforeEach(() => {
        sent = [];
        installBridge();
        useActivePlaybackBackendStore.getState().setActiveBackend('folia');
        useAppleMusicSmtcStore.getState().setStatus(status());
    });

    afterEach(() => {
        delete (globalThis as { window?: unknown }).window;
    });

    it('pauses Folia when it is playing, then takes the Apple Music backend', () => {
        const pauses: string[] = [];
        selectAppleMusicBackend(() => pauses.push('folia'), 'PLAYING');

        expect(pauses).toEqual(['folia']);
        expect(backend()).toBe('apple-music');
        // Switching backends changes the control target only — it never starts the new backend.
        expect(sent).toEqual([]);
    });

    it('does not touch Folia when it is not playing', () => {
        const pauses: string[] = [];
        selectAppleMusicBackend(() => pauses.push('folia'), 'PAUSED');
        expect(pauses).toEqual([]);
        expect(backend()).toBe('apple-music');

        useActivePlaybackBackendStore.getState().setActiveBackend('folia');
        selectAppleMusicBackend(() => pauses.push('folia'), 'IDLE');
        expect(pauses).toEqual([]);
        expect(backend()).toBe('apple-music');
    });

    it('still switches when the Folia pause throws', () => {
        selectAppleMusicBackend(() => {
            throw new Error('deck already gone');
        }, 'PLAYING');
        expect(backend()).toBe('apple-music');
    });

    it('pauses Apple Music when handing back to Folia, and never resumes Folia', () => {
        useActivePlaybackBackendStore.getState().setActiveBackend('apple-music');

        selectFoliaBackend();

        expect(sent.map(entry => entry.command)).toEqual(['pause']);
        expect(backend()).toBe('folia');
    });

    it('sends no pause when Apple Music is not playing', () => {
        useActivePlaybackBackendStore.getState().setActiveBackend('apple-music');
        useAppleMusicSmtcStore.getState().setStatus(status({ playbackStatus: 'Paused' }));

        selectFoliaBackend();

        expect(sent).toEqual([]);
        expect(backend()).toBe('folia');
    });

    it('releases the Apple Music backend before Stage can claim it', () => {
        // The invariant this exists for: entering Stage while Apple Music owned the transport is
        // exactly the state that must never hold, because Stage has its own source selection.
        useActivePlaybackBackendStore.getState().setActiveBackend('apple-music');

        expect(leaveAppleMusicForStage()).toBe(true);
        expect(sent.map(entry => entry.command)).toEqual(['pause']);
        expect(backend()).toBe('folia');
    });

    it('is a no-op when entering Stage from the Folia backend', () => {
        expect(leaveAppleMusicForStage()).toBe(false);
        expect(sent).toEqual([]);
        expect(backend()).toBe('folia');
    });

    it('switches back even when the pause command is rejected', () => {
        installBridge({ reject: true });
        useActivePlaybackBackendStore.getState().setActiveBackend('apple-music');

        expect(leaveAppleMusicForStage()).toBe(true);
        expect(backend()).toBe('folia');
    });

    it('disables the Apple Music entry while Stage is active, and only then', () => {
        expect(isAppleMusicSelectable(false)).toBe(true);
        expect(isAppleMusicSelectable(true)).toBe(false);
    });

    it('maps the SMTC bridge state onto the three entry labels', () => {
        expect(resolveAppleMusicAvailability(status())).toBe('connected');
        expect(resolveAppleMusicAvailability(status({ connected: false }))).toBe('not-running');
        expect(resolveAppleMusicAvailability(status({ bridgeAvailable: false }))).toBe('unavailable');
        // No snapshot yet (bridge not started, or non-Electron window) reads as unavailable rather
        // than as "connected".
        expect(resolveAppleMusicAvailability(null)).toBe('unavailable');
    });
});
