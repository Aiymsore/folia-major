import { beforeAll, describe, expect, it } from 'vitest';

// test/unit/chrome-extension/musicKitTime.test.ts
// MusicKit 的时间单位换算。
//
// 起因是一次静默错误：`mk.currentPlaybackTime` 是**秒**，而 `attributes.durationInMillis` 是**毫秒**，
// 两者在 page-bridge.js 里相隔三行、都叫 `durationMs`/`positionMs`。实测一首 160.5s 的曲子报
// `currentPlaybackTime` 为 2 → 159 → 160 然后结束；当成毫秒读的话那是"第 0.16 秒"，永远到不了结尾，
// 于是 `duration - position <= 1500` 永不成立、队列永不推进。
//
// 这个 bug 在扩展观察被消费之前是无害的，一旦位置改走扩展优先就变成致命的 —— 所以先锁住换算。

type MusicKitTime = { musicKitSecondsToMs: (value: unknown) => number | null };

let musicKitTime: MusicKitTime;

beforeAll(async () => {
    await import('../../../chrome-extension/musickit-time.js');
    musicKitTime = (globalThis as unknown as { FoliaMusicKitTime: MusicKitTime }).FoliaMusicKitTime;
});

describe('MusicKit seconds -> protocol milliseconds', () => {
    it('converts a live position the way the measurement showed', () => {
        // 实测序列：2 -> 159 -> 160，然后曲目结束（时长 160.5s）。
        expect(musicKitTime.musicKitSecondsToMs(2)).toBe(2000);
        expect(musicKitTime.musicKitSecondsToMs(159)).toBe(159_000);
        expect(musicKitTime.musicKitSecondsToMs(160)).toBe(160_000);
    });

    it('keeps a sub-second position instead of rounding it away', () => {
        // 秒值是浮点：0.25s 必须变成 250ms，而不是 0。
        expect(musicKitTime.musicKitSecondsToMs(0.25)).toBe(250);
        expect(musicKitTime.musicKitSecondsToMs(160.52)).toBe(160_520);
    });

    it('reports "unknown" as null rather than as the start of the track', () => {
        // null 与 0 是不同的事实：决策层拒绝在位置未知时判定曲目结束。
        expect(musicKitTime.musicKitSecondsToMs(null)).toBeNull();
        expect(musicKitTime.musicKitSecondsToMs(undefined)).toBeNull();
        expect(musicKitTime.musicKitSecondsToMs(Number.NaN)).toBeNull();
        expect(musicKitTime.musicKitSecondsToMs(Number.POSITIVE_INFINITY)).toBeNull();
        expect(musicKitTime.musicKitSecondsToMs('160')).toBeNull();
        // 真正的 0 是"在开头"，必须保留。
        expect(musicKitTime.musicKitSecondsToMs(0)).toBe(0);
    });

    it('clamps a negative position to zero', () => {
        // MusicKit 在切歌瞬间会短暂报负值；负位置会让"剩余时长"算出大于整首的值。
        expect(musicKitTime.musicKitSecondsToMs(-1.5)).toBe(0);
    });

    it('produces a duration and position on the same scale', () => {
        // 这条是回归锁本身：同一首曲子的两个值必须可以直接相减。
        const duration = musicKitTime.musicKitSecondsToMs(160.5);
        const position = musicKitTime.musicKitSecondsToMs(159);
        expect(duration! - position!).toBeLessThanOrEqual(1500);
    });
});
