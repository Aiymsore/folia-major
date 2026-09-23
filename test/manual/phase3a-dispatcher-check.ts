// test/manual/phase3a-dispatcher-check.ts
//
// transport dispatcher 的运行时自检：不递归、用 `handled: boolean` 表达"我接了"、
// seek 只认观察到的时长、**next / previous 绝不透传**（由 queue 层解析成 playById）。
// 与 test/unit/transportDispatcher.test.ts 是同一批断言，
// 区别只在运行方式——vitest 在 agent 沙箱里加载不了 vite 配置（spawn EPERM），这里用仓库自带的
// rolldown 打包后直接跑 node。`npm test` 仍是正式门禁，本文件是沙箱内的补充。
//
// 运行：
//   node node_modules/rolldown/bin/cli.mjs test/manual/phase3a-dispatcher-check.ts \
//     --format esm --platform node --file "$env:TEMP/phase3a-dispatcher-check.mjs"
//   node "$env:TEMP/phase3a-dispatcher-check.mjs"
import { useActivePlaybackBackendStore } from '../../src/stores/useActivePlaybackBackendStore';
import { useExternalMediaStore } from '../../src/stores/useExternalMediaStore';
import {
    handleExternalMediaAction,
    handleExternalMediaSeek,
    playExternalMediaTrack,
} from '../../src/hooks/useTransportDispatcher';

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

type SentCommand = { command: string; positionMs?: number };
let sent: SentCommand[] = [];

const installBridge = (reject = false) => {
    (globalThis as unknown as { window: unknown }).window = {
        electron: {
            externalMediaSendCommand: (request: SentCommand) => {
                sent.push(request);
                return reject ? Promise.reject(new Error('boom')) : Promise.resolve({ ok: true });
            },
        },
    };
};

const connectedPlaying = (over: Partial<ElectronExternalMediaStatus> = {}) => ({
    bridgeAvailable: true,
    helperState: 'running' as const,
    connected: true,
    sourceAppUserModelId: 'Chrome',
    title: 'Track',
    artist: 'Artist',
    album: null,
    playbackStatus: 'Playing',
    positionMs: 61_000,
    durationMs: 240_000,
    hasThumbnail: false,
    updatedAt: 1,
    lastUpdatedAt: 1,
    lastEventAt: 1,
    sessionCount: 2,
    extensionConnected: true,
    extensionVersion: '1.0.0',
    extensionCapabilities: ['observe', 'transport', 'seek', 'playById'],
    signedIn: true,
    storefrontMatches: true,
    lastCommand: null,
    lastError: null,
    ...over,
});

const setBackend = (next: 'folia' | 'external-media') => {
    useActivePlaybackBackendStore.getState().setActiveBackend(next);
};
const setStatus = (status: Partial<ElectronExternalMediaStatus>) => {
    useExternalMediaStore.getState().setStatus(status as ElectronExternalMediaStatus);
};

console.log('folia 后端：全部拒绝，且一条命令都不发');
installBridge();
sent = [];
setBackend('folia');
setStatus(connectedPlaying());
for (const action of ['play', 'pause', 'toggle'] as const) {
    eq(`handleExternalMediaAction(${action}) = false`, handleExternalMediaAction(action), false);
}
eq('handleExternalMediaSeek = false', handleExternalMediaSeek(30), false);
eq('未发送任何命令', sent, []);

console.log('\nexternal-media 后端：全部接管，命令名映射正确');
sent = [];
setBackend('external-media');
eq('toggle 被接管', handleExternalMediaAction('toggle'), true);
eq('play 被接管', handleExternalMediaAction('play'), true);
eq('pause 被接管', handleExternalMediaAction('pause'), true);
// 只有三个动词。next / previous 不在词表里（类型层面就不存在）："下一首"由 queue 层
// 解析成 playById，见下面的断言。
eq('命令名映射', sent.map(entry => entry.command), [
    'toggle',
    'play',
    'pause',
]);

console.log('\n"下一首"由 Folia 的 queue 解析成 playById，绝不透传');
sent = [];
await playExternalMediaTrack('1440833098');
eq('下发的是 playById', sent, [{ command: 'playById', mediaId: '1440833098' }]);

console.log('\n硬约束 4 延伸：无曲目信息时接管但不下发');
sent = [];
// No media *information* (no title), not merely a non-playing state: `Stopped` keeps its track and
// must still accept a play command, which is the distinction this whole split exists for.
setStatus(connectedPlaying({ playbackStatus: 'Closed', title: null }));
eq('接管（返回 true，Folia 体不执行）', handleExternalMediaAction('play'), true);
eq('不下发命令', sent, []);
sent = [];
setStatus(connectedPlaying({ bridgeAvailable: false, connected: false, playbackStatus: null, title: null }));
eq('bridge 不可用仍接管', handleExternalMediaAction('toggle'), true);
eq('bridge 不可用不下发', sent, []);

console.log('\nStopped 仍然能收到 play（恢复播放的入口不能被砍掉）');
sent = [];
setStatus(connectedPlaying({ playbackStatus: 'Stopped', positionMs: 0 }));
eq('Stopped 下 play 被接管', handleExternalMediaAction('play'), true);
eq('Stopped 下命令确实下发', sent, [{ command: 'play' }]);

console.log('\nseek：按 SMTC duration 夹紧 + 整秒量化 + 负数归零');
sent = [];
setStatus(connectedPlaying());
eq('越界 seek 接管', handleExternalMediaSeek(9_999), true);
eq('亚秒 seek 接管', handleExternalMediaSeek(41.7), true);
eq('负数 seek 接管', handleExternalMediaSeek(-5), true);
eq('夹紧与量化结果', sent, [
    { command: 'seek', positionMs: 240_000 },
    { command: 'seek', positionMs: 42_000 },
    { command: 'seek', positionMs: 0 },
]);

console.log('\nseek：duration 未知时不设上限');
sent = [];
setStatus(connectedPlaying({ durationMs: null }));
eq('未知时长接管', handleExternalMediaSeek(600), true);
eq('未夹紧', sent, [{ command: 'seek', positionMs: 600_000 }]);

console.log('\nbridge reject 时不向调用方抛错');
installBridge(true);
setStatus(connectedPlaying());
let threw = false;
try {
    handleExternalMediaAction('pause');
    handleExternalMediaSeek(10);
} catch {
    threw = true;
}
eq('不抛错', threw, false);

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
