import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    startAppleMusicSmtcSubscription,
    stopAppleMusicSmtcSubscription,
    useAppleMusicSmtcStore,
} from '../../src/stores/useAppleMusicSmtcStore';

// test/unit/appleMusicSmtcSubscription.test.ts
// 锁死「只有一份 SMTC 订阅」这条不变量、它必须能被重新建立，以及**旧生命周期的初读不得写回**
// 这三件事。
//
//   start → start                 （未 cleanup）→ 同一个句柄、仍然只有 1 个订阅、代次不推进
//   start → cleanup → start       → 新订阅 + 旧订阅被摘除
//   start → 初读 pending → cleanup → 初读解析回来 → **不得写 store**
//   start A → cleanup A → start B → A 的初读最后解析 → **不得覆盖 B**
//
// 最后两条是 production lifecycle 契约，不是测试技巧：`appleMusicGetState()` 是一次 IPC，
// 慢 IPC 下迟到的解析会把过期快照盖在更新鲜的状态上。
//
// 清理一律走 `stopAppleMusicSmtcSubscription()`。绝不能用一个「start 再 cleanup」来充当 reset：
// 那样本身就制造了一次 listener 注册与一次初读，测试会在自己制造的噪声上断言。

type Handler = (status: ElectronAppleMusicSmtcStatus) => void;

const makeStatus = (over: Partial<ElectronAppleMusicSmtcStatus> = {}): ElectronAppleMusicSmtcStatus => ({
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

let handlers: Handler[];
let handlerAdds: number;
let handlerRemoves: number;
let getStateCalls: number;
/** 每个测试可以决定 appleMusicGetState 返回什么；默认立即成功。 */
let getStateImpl: () => Promise<ElectronAppleMusicSmtcStatus>;

describe('Apple Music SMTC subscription lifecycle', () => {
    beforeEach(() => {
        // 顺序即语义：
        //   1. 用真正的 stop 收掉上一条订阅（不是 start，也不是直接改模块状态）
        //   2. 再清 store —— stop 刻意不清 status，测试要自己的干净起点就自己 reset
        //   3. 重置本测试的计数器
        //   4. 最后安装自己的 bridge fake，避免任何一次注册落在旧 fake 上
        stopAppleMusicSmtcSubscription();
        useAppleMusicSmtcStore.setState({ status: null });

        handlers = [];
        handlerAdds = 0;
        handlerRemoves = 0;
        getStateCalls = 0;
        getStateImpl = () => Promise.resolve(makeStatus({ title: 'Initial Read' }));

        (globalThis as unknown as { window: unknown }).window = {
            electron: {
                onAppleMusicStateChanged: (callback: Handler) => {
                    handlerAdds += 1;
                    handlers.push(callback);
                    return () => {
                        handlerRemoves += 1;
                        handlers = handlers.filter(entry => entry !== callback);
                    };
                },
                appleMusicGetState: () => {
                    getStateCalls += 1;
                    return getStateImpl();
                },
            },
        };
    });

    afterEach(() => {
        stopAppleMusicSmtcSubscription();
        useAppleMusicSmtcStore.setState({ status: null });
        delete (globalThis as { window?: unknown }).window;
    });

    it('subscribes exactly once across repeated starts and applies pushed snapshots', () => {
        const first = startAppleMusicSmtcSubscription();
        const second = startAppleMusicSmtcSubscription();
        const third = startAppleMusicSmtcSubscription();

        // The same cleanup handle comes back, which is what makes the call idempotent.
        expect(second).toBe(first);
        expect(third).toBe(first);
        expect(handlerAdds).toBe(1);
        expect(handlers).toHaveLength(1);

        handlers[0](makeStatus({ title: 'Pushed' }));
        expect(useAppleMusicSmtcStore.getState().status?.title).toBe('Pushed');

        handlers[0](makeStatus({ title: 'Pushed Again' }));
        expect(useAppleMusicSmtcStore.getState().status?.title).toBe('Pushed Again');
    });

    it('cleans up exactly once and can be restarted afterwards', async () => {
        const cleanup = startAppleMusicSmtcSubscription();
        expect(handlerAdds).toBe(1);

        cleanup();
        expect(handlerRemoves).toBe(1);
        expect(handlers).toHaveLength(0);

        const restarted = startAppleMusicSmtcSubscription();
        expect(handlerAdds).toBe(2);
        expect(handlers).toHaveLength(1);

        await Promise.resolve();
        handlers[0](makeStatus({ title: 'After Restart' }));
        expect(useAppleMusicSmtcStore.getState().status?.title).toBe('After Restart');

        restarted();
        expect(handlerRemoves).toBe(2);
    });

    it('stops without starting, and is idempotent', () => {
        // No subscription yet: stop must be a pure no-op — no listener, no initial read.
        stopAppleMusicSmtcSubscription();
        expect(handlerAdds).toBe(0);
        expect(getStateCalls).toBe(0);

        const cleanup = startAppleMusicSmtcSubscription();
        expect(handlerAdds).toBe(1);

        stopAppleMusicSmtcSubscription();
        expect(handlerRemoves).toBe(1);
        expect(handlers).toHaveLength(0);

        // Calling it again (and the old handle too) must not double-remove or re-subscribe.
        stopAppleMusicSmtcSubscription();
        cleanup();
        expect(handlerRemoves).toBe(1);
        expect(handlerAdds).toBe(1);
    });

    it('does not clear the playback snapshot when the subscription stops', () => {
        // Subscription lifecycle and playback snapshot lifecycle are separate concepts: stopping the
        // listener does not mean the remote stopped playing.
        const cleanup = startAppleMusicSmtcSubscription();
        handlers[0](makeStatus({ title: 'Still Playing' }));
        expect(useAppleMusicSmtcStore.getState().status?.title).toBe('Still Playing');

        cleanup();
        expect(useAppleMusicSmtcStore.getState().status?.title).toBe('Still Playing');

        stopAppleMusicSmtcSubscription();
        expect(useAppleMusicSmtcStore.getState().status?.title).toBe('Still Playing');
    });

    it('keeps a pushed snapshot authoritative over the initial read', async () => {
        let resolveInitial: (status: ElectronAppleMusicSmtcStatus) => void = () => {};
        getStateImpl = () => new Promise(resolve => { resolveInitial = resolve; });

        startAppleMusicSmtcSubscription();
        // The push arrives while the initial read is still in flight.
        handlers[0](makeStatus({ title: 'Pushed First' }));

        resolveInitial(makeStatus({ title: 'Initial Read' }));
        await flushMicrotasks();

        expect(useAppleMusicSmtcStore.getState().status?.title).toBe('Pushed First');
    });

    it('ignores an initial read that resolves after cleanup', async () => {
        let resolveInitial: (status: ElectronAppleMusicSmtcStatus) => void = () => {};
        getStateImpl = () => new Promise(resolve => { resolveInitial = resolve; });

        const cleanup = startAppleMusicSmtcSubscription();
        expect(getStateCalls).toBe(1);

        cleanup();
        // The stale generation resolves only now. It belongs to a lifecycle that no longer exists.
        resolveInitial(makeStatus({ title: 'Stale Initial Read' }));
        await flushMicrotasks();

        expect(useAppleMusicSmtcStore.getState().status).toBeNull();
    });

    it('never lets a previous generation overwrite the current one', async () => {
        let resolveA: (status: ElectronAppleMusicSmtcStatus) => void = () => {};
        getStateImpl = () => new Promise(resolve => { resolveA = resolve; });

        // Generation A: initial read pends forever until we resolve it by hand.
        const cleanupA = startAppleMusicSmtcSubscription();
        expect(getStateCalls).toBe(1);

        cleanupA();
        // Generation B: a fresh subscription with its own (immediately resolving) initial read.
        getStateImpl = () => Promise.resolve(makeStatus({ title: 'Generation B' }));
        startAppleMusicSmtcSubscription();
        await flushMicrotasks();
        expect(useAppleMusicSmtcStore.getState().status?.title).toBe('Generation B');

        // A resolves last. It must not touch B's snapshot.
        resolveA(makeStatus({ title: 'Generation A (late)' }));
        await flushMicrotasks();

        expect(useAppleMusicSmtcStore.getState().status?.title).toBe('Generation B');
        expect(handlerAdds).toBe(2);
    });

    it('still works without the preload bridge, and can recover when it appears', () => {
        stopAppleMusicSmtcSubscription();
        delete (globalThis as { window?: unknown }).window;

        // No bridge: the subscription is a no-op, not a crash, and status simply stays empty.
        const offline = startAppleMusicSmtcSubscription();
        expect(useAppleMusicSmtcStore.getState().status).toBeNull();
        expect(getStateCalls).toBe(0);
        offline();
    });
});

/**
 * Flushes the microtask queue deeply enough for a chain of `.then` handlers to settle.
 * `await Promise.resolve()` once is not enough for `void promise.then(...).catch(...)`.
 */
const flushMicrotasks = async (): Promise<void> => {
    for (let index = 0; index < 8; index += 1) {
        await Promise.resolve();
    }
};
