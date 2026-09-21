// test/manual/phase3a-subscription-check.ts
//
// SMTC 订阅生命周期的运行时自检：只有一份订阅、stop 是纯 no-op、cleanup 后可重建，以及
// **旧生命周期的初读不得写回 store**。与 test/unit/appleMusicSmtcSubscription.test.ts 是同一批断言，
// 区别只在运行方式（沙箱内 vitest 无法加载 vite 配置，spawn EPERM）。`npm test` 仍是正式门禁。
//
// 清理一律用 stopAppleMusicSmtcSubscription()。用「start 再 cleanup」充当 reset 会在测试开始前
// 就制造一次 listener 注册与一次初读 —— 那正是这些断言要盯住的东西。
//
// 运行：
//   node node_modules/rolldown/bin/cli.mjs test/manual/phase3a-subscription-check.ts \
//     --format esm --platform node --file "$env:TEMP/phase3a-subscription-check.mjs"
//   node "$env:TEMP/phase3a-subscription-check.mjs"
import {
    startAppleMusicSmtcSubscription,
    stopAppleMusicSmtcSubscription,
    useAppleMusicSmtcStore,
} from '../../src/stores/useAppleMusicSmtcStore';

let failures = 0;
let checks = 0;
const check = (label: string, condition: boolean, detail = '') => {
    checks += 1;
    if (condition) {
        console.log(`  ok   ${label}`);
        return;
    }
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (label: string, actual: unknown, expected: unknown) => {
    check(label, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}`);
};

const flushMicrotasks = async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

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

let handlers: Handler[] = [];
let handlerAdds = 0;
let handlerRemoves = 0;
let getStateCalls = 0;
let getStateImpl: () => Promise<ElectronAppleMusicSmtcStatus> = () => Promise.resolve(makeStatus({ title: 'Initial Read' }));

/** 与单测的 beforeEach 同序：先 stop、再清 store、再重置计数器、最后装 fake。 */
const reset = () => {
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
};

const status = () => useAppleMusicSmtcStore.getState().status?.title ?? null;

console.log('重复 start 不产生第二份订阅');
reset();
{
    const first = startAppleMusicSmtcSubscription();
    const second = startAppleMusicSmtcSubscription();
    const third = startAppleMusicSmtcSubscription();
    check('返回同一个 cleanup 句柄', first === second && second === third);
    eq('只订阅一次', handlerAdds, 1);
    eq('只有一个活跃 handler', handlers.length, 1);
    handlers[0](makeStatus({ title: 'Pushed' }));
    eq('推送写入 store', status(), 'Pushed');
    handlers[0](makeStatus({ title: 'Pushed Again' }));
    eq('推送保持权威', status(), 'Pushed Again');
    first();
    eq('cleanup 摘除 handler', handlerRemoves, 1);
    eq('cleanup 后无活跃 handler', handlers.length, 0);
}

console.log('\nstop 是纯 no-op，且幂等');
reset();
{
    stopAppleMusicSmtcSubscription();
    eq('无订阅时 stop 不注册 listener', handlerAdds, 0);
    eq('无订阅时 stop 不发起初读', getStateCalls, 0);
    const cleanup = startAppleMusicSmtcSubscription();
    eq('start 后有一个 handler', handlerAdds, 1);
    stopAppleMusicSmtcSubscription();
    eq('stop 摘除 handler', handlerRemoves, 1);
    stopAppleMusicSmtcSubscription();
    cleanup();
    eq('重复 stop / 旧句柄不重复摘除', handlerRemoves, 1);
    eq('重复 stop 不重新订阅', handlerAdds, 1);
}

console.log('\nstop 不清空播放快照');
reset();
{
    const cleanup = startAppleMusicSmtcSubscription();
    handlers[0](makeStatus({ title: 'Still Playing' }));
    eq('推送写入', status(), 'Still Playing');
    cleanup();
    eq('cleanup 后快照保留', status(), 'Still Playing');
    stopAppleMusicSmtcSubscription();
    eq('stop 后快照仍保留', status(), 'Still Playing');
}

console.log('\n推送比初读权威');
reset();
{
    let resolveInitial: (s: ElectronAppleMusicSmtcStatus) => void = () => {};
    getStateImpl = () => new Promise(resolve => { resolveInitial = resolve; });
    startAppleMusicSmtcSubscription();
    handlers[0](makeStatus({ title: 'Pushed First' }));
    resolveInitial(makeStatus({ title: 'Initial Read' }));
    await flushMicrotasks();
    eq('初读未覆盖推送', status(), 'Pushed First');
}

console.log('\ncleanup 之后迟到的初读必须失效');
reset();
{
    let resolveInitial: (s: ElectronAppleMusicSmtcStatus) => void = () => {};
    getStateImpl = () => new Promise(resolve => { resolveInitial = resolve; });
    const cleanup = startAppleMusicSmtcSubscription();
    eq('发起了初读', getStateCalls, 1);
    cleanup();
    resolveInitial(makeStatus({ title: 'Stale Initial Read' }));
    await flushMicrotasks();
    eq('store 仍为 null', useAppleMusicSmtcStore.getState().status, null);
}

console.log('\n旧代次不得覆盖新代次');
reset();
{
    let resolveA: (s: ElectronAppleMusicSmtcStatus) => void = () => {};
    getStateImpl = () => new Promise(resolve => { resolveA = resolve; });
    const cleanupA = startAppleMusicSmtcSubscription();
    cleanupA();
    getStateImpl = () => Promise.resolve(makeStatus({ title: 'Generation B' }));
    startAppleMusicSmtcSubscription();
    await flushMicrotasks();
    eq('B 的初读生效', status(), 'Generation B');
    resolveA(makeStatus({ title: 'Generation A (late)' }));
    await flushMicrotasks();
    eq('A 未覆盖 B', status(), 'Generation B');
    eq('两代共注册两次', handlerAdds, 2);
}

console.log('\n没有 preload bridge 时不崩溃');
reset();
{
    stopAppleMusicSmtcSubscription();
    delete (globalThis as { window?: unknown }).window;
    useAppleMusicSmtcStore.setState({ status: null });
    getStateCalls = 0;
    const offline = startAppleMusicSmtcSubscription();
    eq('无 bridge 时 status 保持 null', useAppleMusicSmtcStore.getState().status, null);
    eq('无 bridge 时不读状态', getStateCalls, 0);
    offline();
    stopAppleMusicSmtcSubscription();
    check('cleanup 与 stop 都可安全调用', true);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
