import { createRequire } from 'node:module';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const sidecar = require('../../../electron/analysis/sidecar.cjs') as {
    separate: (options: {
        pythonExe: string;
        script: string;
        modelPath: string;
        left: Float32Array;
        right: Float32Array;
        timeoutMs?: number;
    }) => Promise<Record<string, { left: Float32Array; right: Float32Array }>>;
    RETURNED: string[];
    RUNNER_SCRIPT: string;
    TIMEOUT_MS: number;
};

// test/unit/electron/sidecar.test.ts
// automix Phase 2② 的健壮性契约：runner 崩溃 / 超时被杀 / 输出契约不符 / 崩溃或成功都释放临时目录。
// 真解释器换不掉，但 sidecar 只按 argv 契约调用它 —— 用 node 脚本当假 runner，即可把
// 「另一个 OS 进程会怎样死」的每种方式都演一遍。

const TOTAL = 8;

/** 写一个假 runner（node 脚本，argv 契约与 htdemucs_runner.py 相同）并返回其路径。 */
const writeRunner = async (dir: string, name: string, body: string): Promise<string> => {
    const file = path.join(dir, name);
    await fsp.writeFile(file, body, 'utf8');
    return file;
};

const makeHarness = async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'folia-sidecar-test-'));
    const capturePath = path.join(dir, 'capture.txt');
    // 假 runner 的公共头：把 in 文件所在目录（= sidecar 的临时目录）与 pid 记进 capture，
    // 供「用完释放」「超时确实杀掉了子进程」断言用。
    const captureHeader = `
        const fs = require('fs');
        const inDir = require('path').dirname(process.argv[2]);
        fs.writeFileSync(${JSON.stringify(capturePath)}, inDir + '\\n' + process.pid);
    `;
    return { dir, capturePath, captureHeader };
};

const readCapture = async (capturePath: string): Promise<{ dir: string; pid: number }> => {
    const [dirLine, pidLine] = (await fsp.readFile(capturePath, 'utf8')).split('\n');
    return { dir: dirLine, pid: Number(pidLine) };
};

const input = () => {
    // 故意用带偏移的子视图：separate 必须尊重 byteOffset，否则切出的左右声道是错的。
    const backing = new Float32Array(TOTAL + 4);
    const left = backing.subarray(1, 1 + TOTAL);
    const right = new Float32Array(TOTAL);
    for (let index = 0; index < TOTAL; index += 1) {
        left[index] = 100 + index;
        right[index] = 200 + index;
    }
    return { left, right };
};

const harnesses: string[] = [];

const makeSeparate = async (runnerBody: string) => {
    const { dir, capturePath, captureHeader } = await makeHarness();
    harnesses.push(dir);
    const script = await writeRunner(dir, 'fake-runner.js', captureHeader + runnerBody);
    const { left, right } = input();
    return {
        capturePath,
        call: (timeoutMs?: number) => sidecar.separate({
            pythonExe: process.execPath,
            script,
            modelPath: path.join(dir, 'model.onnx'),
            left,
            right,
            timeoutMs,
        }),
    };
};

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(dir => fsp.rm(dir, { recursive: true, force: true })));
});

describe('sidecar.separate', () => {
    it('splits the runner output into three ordered stems and cleans up', async () => {
        // 假 runner 按契约写回 3 轨 × 2 声道 × total 个 float32，值 = 全局序号。
        // （captureHeader 已声明 fs，这里直接用）
        const { call, capturePath } = await makeSeparate(`
            const total = Number(process.argv[4]);
            const count = 3 * 2 * total;
            const out = Buffer.alloc(count * 4);
            for (let i = 0; i < count; i += 1) out.writeFloatLE(i, i * 4);
            fs.writeFileSync(process.argv[3], out);
        `);

        const stems = await call();

        expect(sidecar.RETURNED).toEqual(['drums', 'bass', 'vocals']);
        expect(stems.drums.left).toHaveLength(TOTAL);
        expect(stems.drums.left[0]).toBe(0);
        expect(stems.drums.left[TOTAL - 1]).toBe(TOTAL - 1);
        expect(stems.drums.right[0]).toBe(TOTAL);
        expect(stems.bass.left[0]).toBe(2 * TOTAL);
        expect(stems.vocals.right[TOTAL - 1]).toBe(6 * TOTAL - 1);

        // 成功用完就把临时目录还回去
        const { dir: usedDir } = await readCapture(capturePath);
        await expect(fsp.stat(usedDir)).rejects.toThrow();
    });

    it('rejects when the runner crashes, and still cleans up', async () => {
        const { call, capturePath } = await makeSeparate(`
            console.error('boom-detail');
            process.exit(3);
        `);

        await expect(call()).rejects.toThrow(/exited 3/);
        await expect(call()).rejects.toThrow(/boom-detail/);

        const { dir: usedDir } = await readCapture(capturePath);
        await expect(fsp.stat(usedDir)).rejects.toThrow();
    });

    it('rejects when the interpreter cannot be spawned at all', async () => {
        const { dir } = await makeHarness();
        const { left, right } = input();
        await expect(sidecar.separate({
            pythonExe: path.join(dir, 'no-such-python'),
            script: path.join(dir, 'no-such-script.py'),
            modelPath: path.join(dir, 'model.onnx'),
            left,
            right,
        })).rejects.toThrow();
    });

    it('kills a hung runner at the deadline and rejects', async () => {
        const { call, capturePath } = await makeSeparate('setInterval(() => {}, 1000);');

        await expect(call(300)).rejects.toThrow(/timed out/);

        // 超时确实把子进程杀掉了，不留孤儿
        const { pid } = await readCapture(capturePath);
        expect(() => process.kill(pid, 0)).toThrow();
    });

    it('rejects a truncated stem file instead of trusting it', async () => {
        const { call } = await makeSeparate(`
            fs.writeFileSync(process.argv[3], Buffer.alloc(4));
        `);

        await expect(call()).rejects.toThrow(/wrote 1 floats, expected/);
    });
});
