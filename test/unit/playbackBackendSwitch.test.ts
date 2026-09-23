import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useActivePlaybackBackendStore } from '../../src/stores/useActivePlaybackBackendStore';
import { useExternalMediaStore } from '../../src/stores/useExternalMediaStore';
import {
    isExternalMediaSelectable,
    leaveExternalMediaForStage,
    selectExternalMediaBackend,
    selectFoliaBackend,
} from '../../src/hooks/usePlaybackBackendSwitch';
import { resolveExternalMediaAvailability } from '../../src/utils/externalMediaStatus';

// test/unit/playbackBackendSwitch.test.ts
// 显式 backend 切换契约（全部由**用户操作**触发，没有任何自动抢占）：
//
//   选中外部媒体后端          → best-effort 暂停 Folia（仅在真的在播时），backend = external-media，
//                               **绝不自动 play 外部播放器**
//   选中 Folia 原生平台        → best-effort pause 外部播放器，backend = folia，**绝不自动 resume Folia**
//   进入 Stage                → 与上一条同一套动作，保证
//                               `activePlaybackContext === 'stage' && backend === 'external-media'` 不成立
//
// best-effort 的含义也在断言里：暂停失败、bridge 缺失、session 缺失都不阻塞 backend 切换。

const status = (over: Partial<ElectronExternalMediaStatus> = {}): ElectronExternalMediaStatus => ({
    bridgeAvailable: true,
    helperState: 'running',
    connected: true,
    sourceAppUserModelId: 'Chrome',
    title: 'Track',
    artist: 'Artist',
    album: null,
    playbackStatus: 'Playing',
    positionMs: 1_000,
    durationMs: 200_000,
    hasThumbnail: false,
    updatedAt: 1,
    lastUpdatedAt: 1,
    lastEventAt: 1,
    sessionCount: 1,
    extensionConnected: true,
    extensionVersion: '1.0.0',
    extensionCapabilities: ['observe', 'transport', 'seek', 'playById'],
    // `null` = 扩展还没报告过这一页可不可驱动。夹具沿用这个缺省值，好让"扩展没报告"这条路径
    // 在既有断言里保持原样（它们断言的是 SMTC 那一半）。
    pageReady: null,
    signedIn: true,
    storefrontMatches: true,
    lastCommand: null,
    lastError: null,
    ...over,
});

type SentCommand = { command: string; positionMs?: number };
let sent: SentCommand[] = [];

const installBridge = (options: { reject?: boolean } = {}) => {
    (globalThis as unknown as { window: unknown }).window = {
        electron: {
            externalMediaSendCommand: (request: SentCommand) => {
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
        useExternalMediaStore.getState().setStatus(status());
    });

    afterEach(() => {
        delete (globalThis as { window?: unknown }).window;
    });

    it('pauses Folia when it is playing, then takes the Apple Music backend', () => {
        const pauses: string[] = [];
        selectExternalMediaBackend(() => pauses.push('folia'), 'PLAYING');

        expect(pauses).toEqual(['folia']);
        expect(backend()).toBe('external-media');
        // Switching backends changes the control target only — it never starts the new backend.
        expect(sent).toEqual([]);
    });

    it('does not touch Folia when it is not playing', () => {
        const pauses: string[] = [];
        selectExternalMediaBackend(() => pauses.push('folia'), 'PAUSED');
        expect(pauses).toEqual([]);
        expect(backend()).toBe('external-media');

        useActivePlaybackBackendStore.getState().setActiveBackend('folia');
        selectExternalMediaBackend(() => pauses.push('folia'), 'IDLE');
        expect(pauses).toEqual([]);
        expect(backend()).toBe('external-media');
    });

    it('still switches when the Folia pause throws', () => {
        selectExternalMediaBackend(() => {
            throw new Error('deck already gone');
        }, 'PLAYING');
        expect(backend()).toBe('external-media');
    });

    it('pauses Apple Music when handing back to Folia, and never resumes Folia', () => {
        useActivePlaybackBackendStore.getState().setActiveBackend('external-media');

        selectFoliaBackend();

        expect(sent.map(entry => entry.command)).toEqual(['pause']);
        expect(backend()).toBe('folia');
    });

    it('sends no pause when Apple Music is not playing', () => {
        useActivePlaybackBackendStore.getState().setActiveBackend('external-media');
        useExternalMediaStore.getState().setStatus(status({ playbackStatus: 'Paused' }));

        selectFoliaBackend();

        expect(sent).toEqual([]);
        expect(backend()).toBe('folia');
    });

    it('releases the Apple Music backend before Stage can claim it', () => {
        // The invariant this exists for: entering Stage while Apple Music owned the transport is
        // exactly the state that must never hold, because Stage has its own source selection.
        useActivePlaybackBackendStore.getState().setActiveBackend('external-media');

        expect(leaveExternalMediaForStage()).toBe(true);
        expect(sent.map(entry => entry.command)).toEqual(['pause']);
        expect(backend()).toBe('folia');
    });

    it('is a no-op when entering Stage from the Folia backend', () => {
        expect(leaveExternalMediaForStage()).toBe(false);
        expect(sent).toEqual([]);
        expect(backend()).toBe('folia');
    });

    it('switches back even when the pause command is rejected', () => {
        installBridge({ reject: true });
        useActivePlaybackBackendStore.getState().setActiveBackend('external-media');

        expect(leaveExternalMediaForStage()).toBe(true);
        expect(backend()).toBe('folia');
    });

    it('disables the Apple Music entry while Stage is active, and only then', () => {
        expect(isExternalMediaSelectable(false)).toBe(true);
        expect(isExternalMediaSelectable(true)).toBe(false);
    });

    it('maps the merged bridge state onto the availability ladder', () => {
        // 每一态对应一个**不同的用户动作**（装扩展 / 开网页 / 刷新页面 / 登录 / 换区），所以必须
        // 逐态分开：合成一个"不可用"只会让用户不知道该做什么。
        expect(resolveExternalMediaAvailability(status())).toBe('ready');
        expect(resolveExternalMediaAvailability(status({ storefrontMatches: false }))).toBe('storefront-mismatch');
        expect(resolveExternalMediaAvailability(status({ signedIn: false }))).toBe('not-signed-in');
        expect(resolveExternalMediaAvailability(status({ connected: false }))).toBe('tab-not-found');
        expect(resolveExternalMediaAvailability(status({ connected: false, extensionConnected: false }))).toBe('extension-missing');
        expect(resolveExternalMediaAvailability(status({ bridgeAvailable: false }))).toBe('unavailable');
        // No snapshot yet (bridge not started, or non-Electron window) reads as unavailable rather
        // than as "ready".
        expect(resolveExternalMediaAvailability(null)).toBe('unavailable');
    });

    it('separates "no tab" from "the tab is there but its player cannot be read"', () => {
        // 2026-09-23 的误诊：content script 跑在隔离世界读不到页面主世界的 MusicKit，每帧观察都是
        // player-declined，而阶梯把它报成 tab-not-found —— 用户被指去打开一个已经开着的标签页。
        // 两者的动作不同：一个是"去开页面"，一个是"刷新那个页面"。
        expect(resolveExternalMediaAvailability(status({ pageReady: false }))).toBe('player-not-ready');
        expect(resolveExternalMediaAvailability(status({ pageReady: false, connected: true }))).toBe('player-not-ready');
        // 扩展报告"这一页可驱动"就相信它：此时 SMTC 看不到会话是正常的（暂停中、刚加载完还没播），
        // 不该反过来否定扩展。
        expect(resolveExternalMediaAvailability(status({ pageReady: true, connected: false }))).toBe('ready');
        // 没报告过 = 不知道，退回 SMTC 判据。
        expect(resolveExternalMediaAvailability(status({ pageReady: null, connected: false }))).toBe('tab-not-found');
        expect(resolveExternalMediaAvailability(status({ pageReady: null, connected: true }))).toBe('ready');
    });

    it('reports unavailable while the feature switch is off, and treats its absence as on', () => {
        // "设置 → 外部媒体"的开关默认关，主进程关着时根本不拉起两个桥 —— 它排在六态阶梯
        // 一切之前。缺省（旧形状、既有夹具）视为开启，历史断言不必跟着开关走。
        expect(resolveExternalMediaAvailability(status({ enabled: false }))).toBe('unavailable');
        expect(resolveExternalMediaAvailability(status({ enabled: true }))).toBe('ready');
    });

    it('treats unknown page facts as unknown, not as unmet', () => {
        // `signedIn` / `storefrontMatches` 的 null 是"扩展还没报告过"，不是"没登录" ——
        // 把不知道当没满足，会把用户赶去一个他们可能已经登录着的登录页。
        expect(resolveExternalMediaAvailability(status({ signedIn: null, storefrontMatches: null }))).toBe('ready');
    });

    it('reports the earlier precondition first when several are unmet', () => {
        // 判定顺序是承重的：扩展没连上时 tab / 登录 / storefront 都无从得知，
        // 不能越过它去报一个猜测出来的 storefront-mismatch。
        expect(resolveExternalMediaAvailability(status({
            connected: false,
            signedIn: false,
            storefrontMatches: false,
        }))).toBe('tab-not-found');
    });
});
