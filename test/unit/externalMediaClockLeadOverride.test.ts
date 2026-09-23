import { afterEach, describe, expect, it } from 'vitest';
import {
    EXTERNAL_MEDIA_CLOCK_LEAD_OVERRIDE_KEY,
    readRuntimeLeadMs,
    resetExternalMediaClock,
} from '../../src/utils/externalMediaClockRuntime';
import { EXTERNAL_MEDIA_CLOCK_DEFAULT_LEAD_MS } from '../../src/utils/externalMediaClockCorrection';

// test/unit/externalMediaClockLeadOverride.test.ts
// 运行时 lead 覆盖。
//
// 为什么这条要单独锁：默认 lead 里包含一段**只能实机听感定位**的常数相位（见
// EXTERNAL_MEDIA_CLOCK_DEFAULT_LEAD_MS 的注释），所以「改一个数、刷新页面、再听一遍」必须是可靠的。
// 如果覆盖逻辑在非法输入或 localStorage 不可用时抛错，调参就会变成「歌词时钟整体失灵」，
// 而那是最难归因的一类故障。
//
// 这个套件不依赖 jsdom：`window` 不存在时函数必须回落到默认值，这本身就是一条要守的性质。

const setOverride = (value: string) => {
    (globalThis as unknown as { window: unknown }).window = {
        localStorage: {
            getItem: (key: string) => (key === EXTERNAL_MEDIA_CLOCK_LEAD_OVERRIDE_KEY ? value : null),
        },
    };
};

const setThrowingStorage = () => {
    (globalThis as unknown as { window: unknown }).window = {
        localStorage: {
            getItem: () => { throw new Error('storage disabled'); },
        },
    };
};

const clearWindow = () => {
    delete (globalThis as unknown as { window?: unknown }).window;
};

afterEach(() => {
    clearWindow();
    resetExternalMediaClock();
});

describe('readRuntimeLeadMs', () => {
    it('falls back to the default when there is no window at all', () => {
        // 非 Electron 窗口（网页构建、单测）没有 localStorage：时钟必须照常工作。
        clearWindow();
        expect(readRuntimeLeadMs()).toBe(EXTERNAL_MEDIA_CLOCK_DEFAULT_LEAD_MS);
    });

    it('falls back to the default when no override is stored', () => {
        setOverride('');
        (globalThis as unknown as { window: { localStorage: { getItem: () => null } } }).window.localStorage.getItem = () => null;
        expect(readRuntimeLeadMs()).toBe(EXTERNAL_MEDIA_CLOCK_DEFAULT_LEAD_MS);
    });

    it('accepts a valid millisecond override', () => {
        setOverride('900');
        expect(readRuntimeLeadMs()).toBe(900);
    });

    it('accepts zero, so the compensation can be switched off while tuning', () => {
        setOverride('0');
        expect(readRuntimeLeadMs()).toBe(0);
    });

    it('rejects a negative override instead of pushing the clock ahead of the report', () => {
        setOverride('-500');
        expect(readRuntimeLeadMs()).toBe(EXTERNAL_MEDIA_CLOCK_DEFAULT_LEAD_MS);
    });

    it('rejects a non-numeric override', () => {
        setOverride('abc');
        expect(readRuntimeLeadMs()).toBe(EXTERNAL_MEDIA_CLOCK_DEFAULT_LEAD_MS);
    });

    it('rejects an absurd override rather than trusting it', () => {
        setOverride('999999');
        expect(readRuntimeLeadMs()).toBe(EXTERNAL_MEDIA_CLOCK_DEFAULT_LEAD_MS);
    });

    it('survives a localStorage that throws', () => {
        // 隐私模式与极端沙箱会直接抛。诊断开关绝不能把播放时钟拖下水。
        setThrowingStorage();
        expect(readRuntimeLeadMs()).toBe(EXTERNAL_MEDIA_CLOCK_DEFAULT_LEAD_MS);
    });
});
