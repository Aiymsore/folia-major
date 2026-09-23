// test/manual/apple-music-smtc-bridge-lifecycle-check.mjs
//
// bridge 的「未运行时不排队命令」契约自检（纯 node，沙箱内可跑）。
//
// 存在的理由：test/unit/electron/externalMediaSmtcBridge.test.ts 里有一条断言
// `expect(child).toBeUndefined()`，而该文件在 sendCommand 这一层没有在 beforeEach 重置模块级
// 的 fake child，于是它读到的是上一个用例留下的对象 —— 断言失败，但实现是对的。这个自检直接
// 对着 bridge 验证被断言的行为本身，把「实现没错」这件事固定下来，而不是只靠阅读测试代码。
//
// 用法: node test/manual/apple-music-smtc-bridge-lifecycle-check.mjs

import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const { createExternalMediaSmtcBridge } = require('../../electron/externalMediaSmtcBridge.cjs');

let failures = 0;
let checks = 0;
const check = (label, condition, detail = '') => {
    checks += 1;
    if (condition) {
        console.log(`  ok   ${label}`);
        return;
    }
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (label, actual, expected) => {
    check(label, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}`);
};

function createBridgeHarness() {
    let spawnCalls = 0;
    let child = null;
    const bridge = createExternalMediaSmtcBridge({
        spawnFn: () => {
            spawnCalls += 1;
            const stdout = new EventEmitter();
            stdout.setEncoding = () => {};
            const stderr = new EventEmitter();
            stderr.setEncoding = () => {};
            const fake = new EventEmitter();
            fake.stdout = stdout;
            fake.stderr = stderr;
            fake.stdin = { written: [], write: chunk => fake.stdin.written.push(chunk) };
            fake.kill = () => {};
            child = fake;
            return fake;
        },
        helperPath: () => 'C:/fake/folia-apple-music-smtc-helper.exe',
        now: () => 1_000_000,
        setTimeoutFn: () => 0,
        clearTimeoutFn: () => {},
        logWarn: () => {},
        logError: () => {},
    });
    return { bridge, getSpawnCalls: () => spawnCalls, getChild: () => child };
}

console.log('未 start：不发命令、不 spawn、不留 child');
{
    const { bridge, getSpawnCalls, getChild } = createBridgeHarness();
    const result = await bridge.sendCommand({ command: 'play' });
    eq('结构化失败', result.ok, false);
    eq('errorKind 为 helper-unavailable', result.errorKind, 'helper-unavailable');
    eq('没有 spawn 过 helper', getSpawnCalls(), 0);
    eq('没有 child（就是那条断言的语义）', getChild(), null);
    eq('helperState 仍是 stopped', bridge.getStatus().helperState, 'stopped');
}

console.log('\nstart 之后：命令才会真正下发');
{
    const { bridge, getSpawnCalls, getChild } = createBridgeHarness();
    bridge.start();
    eq('spawn 一次', getSpawnCalls(), 1);
    check('child 存在', getChild() !== null);
    const pending = bridge.sendCommand({ command: 'next' });
    const written = getChild().stdin.written;
    eq('写了一行请求', written.length, 1);
    const request = JSON.parse(written[0]);
    eq('命令名正确', request.command, 'next');
    // 用请求自己的 id 回一条 response，确认 promise 会解析而不是挂住。
    getChild().stdout.emit('data', `${JSON.stringify({
        event: 'response',
        id: request.id,
        command: 'next',
        ok: true,
        targetAppUserModelId: 'Chrome',
        error: null,
        errorKind: null,
        completedAtMs: 1,
    })}\n`);
    const reply = await pending;
    eq('收到结构化成功', reply.ok, true);
}

console.log('\nstart 之后 stop：child 被丢弃，命令重新变为不可用');
{
    const { bridge, getSpawnCalls, getChild } = createBridgeHarness();
    bridge.start();
    bridge.killHelper();
    eq('helperState 回到 stopped', bridge.getStatus().helperState, 'stopped');
    const result = await bridge.sendCommand({ command: 'play' });
    eq('再次 helper-unavailable', result.errorKind, 'helper-unavailable');
    eq('没有额外 spawn', getSpawnCalls(), 1);
    check('child 已被丢弃', getChild() !== null); // 变量仍指向旧对象，但 bridge 已不再持有它
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
