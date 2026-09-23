import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/automix/beatThisCpuSetting.test.ts
// 挂账 8a 开关的渲染器半边：持久化 + 模块加载/切换时把值单向推给主进程（fork 时刻要用）。

const storage = () => {
    const map = new Map<string, string>();
    return {
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => { map.set(key, String(value)); },
        removeItem: (key: string) => { map.delete(key); },
    };
};

let pushBeatThisCpuOnly: ReturnType<typeof vi.fn>;
let storageStub: ReturnType<typeof storage>;

describe('beat_this CPU setting', () => {
    beforeEach(() => {
        vi.resetModules();
        storageStub = storage();
        pushBeatThisCpuOnly = vi.fn();
        vi.stubGlobal('localStorage', storageStub);
        vi.stubGlobal('window', {
            localStorage: storageStub,
            electron: { setAutomixBeatThisCpuOnly: pushBeatThisCpuOnly },
        });
    });

    it('persists the switch and pushes it to the main process on toggle', async () => {
        const { useAutomixSettingsStore } = await import('@/stores/useAutomixSettingsStore');

        expect(useAutomixSettingsStore.getState().beatThisCpuOnly).toBe(false);
        // 模块加载即推送初始值，保证第一次 fork 就看到开关
        expect(pushBeatThisCpuOnly).toHaveBeenCalledWith(false);

        useAutomixSettingsStore.getState().handleToggleBeatThisCpu(true);

        expect(useAutomixSettingsStore.getState().beatThisCpuOnly).toBe(true);
        expect(storageStub.getItem('folia_beat_this_cpu_only')).toBe('true');
        expect(pushBeatThisCpuOnly).toHaveBeenLastCalledWith(true);
    });

    it('replays the persisted value to main at module load', async () => {
        storageStub.setItem('folia_beat_this_cpu_only', 'true');
        const { useAutomixSettingsStore } = await import('@/stores/useAutomixSettingsStore');

        expect(useAutomixSettingsStore.getState().beatThisCpuOnly).toBe(true);
        expect(pushBeatThisCpuOnly).toHaveBeenCalledWith(true);
    });
});
