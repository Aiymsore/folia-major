import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// test/unit/automix/analysisHostForceCpu.test.ts
// 挂账 8a「beat_this 切 CPU 开关」的主进程半边：开关值经 IPC 到 host，host 在 fork 时带上
// FOLIA_ANALYSIS_FORCE_CPU，切换时重启 worker 让 env 生效；与「GPU 卡死后降级」共用同一开关。

class FakeWorker extends EventEmitter {
    stdout = null;
    stderr = null;
    killed = false;
    postMessage(msg: { id: number }) {
        queueMicrotask(() => this.emit('message', { id: msg.id, result: 'ok' }));
    }
    kill() { this.killed = true; }
}

const forks: { options: { env: Record<string, string> }; worker: FakeWorker }[] = [];
const handlers = new Map<string, (...args: unknown[]) => unknown>();
const listeners = new Map<string, (...args: unknown[]) => unknown>();

beforeAll(() => {
    const electronPath = require.resolve('electron');
    require.cache[electronPath] = {
        id: electronPath, filename: electronPath, loaded: true,
        exports: {
            utilityProcess: {
                fork: (_module: string, _args: string[], options: { env: Record<string, string> }) => {
                    const worker = new FakeWorker();
                    forks.push({ options, worker });
                    return worker;
                },
            },
        },
    } as unknown as NodeModule;

    const { createAnalysisHost } = require(path.join(REPO, 'electron/analysis/host.cjs'));
    createAnalysisHost({
        app: null,
        ipcMain: {
            handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn),
            on: (ch: string, fn: (...a: unknown[]) => unknown) => listeners.set(ch, fn),
        },
        getModelsDirs: () => [path.join(REPO, 'models')],
    });
});

const beatThis = () => handlers.get('automix-beat-this')!({}, []);
const setBeatThisCpuOnly = (value: boolean) => listeners.get('automix-beat-this-cpu-only')!({}, value);

describe('beat_this CPU switch (analysis host)', () => {
    it('starts without the flag, forks with it after the switch, and restarts the worker', async () => {
        expect(forks).toHaveLength(0);
        await beatThis();
        expect(forks).toHaveLength(1);
        expect(forks[0].options.env.FOLIA_ANALYSIS_FORCE_CPU).toBeUndefined();

        setBeatThisCpuOnly(true);
        // 切换即重启：旧 worker 被杀，env 只能靠重新 fork 生效
        expect(forks[0].worker.killed).toBe(true);

        await beatThis();
        expect(forks).toHaveLength(2);
        expect(forks[1].options.env.FOLIA_ANALYSIS_FORCE_CPU).toBe('1');

        setBeatThisCpuOnly(false);
        await beatThis();
        expect(forks).toHaveLength(3);
        expect(forks[2].options.env.FOLIA_ANALYSIS_FORCE_CPU).toBeUndefined();
    });

    it('ignores a no-op push and does not kill a worker for it', async () => {
        const before = forks.length;
        setBeatThisCpuOnly(false); // 与当前值相同
        expect(forks).toHaveLength(before);
    });
});
