import { beforeEach, describe, expect, it } from 'vitest';
import { applyExternalMediaClockTick } from '../../../src/hooks/usePlaybackVisualizerBridge';
import { currentTime, lyricCurrentTime } from '../../../src/stores/motionSignals';
import { resetExternalMediaClock, runExternalMediaClockTick } from '../../../src/utils/externalMediaClockRuntime';
import { EXTERNAL_MEDIA_CLOCK_DEFAULT_LEAD_MS } from '../../../src/utils/externalMediaClockCorrection';

// test/unit/playback/externalMediaClockTick.test.ts
//
// The Apple Music backend had no writer for the global playback clock: all four existing sources
// (Folia's audio element, now-playing Stage, PlayerCap, synthetic Stage lyrics) describe a Folia
// deck or a Stage session, so in apple-music mode the chain matched nothing and `currentTime` stayed
// at 0 - which is why the progress bar sat at 00:00 and a completed drag never became visible.
//
// 这个套件现在锁的是**接线之后**的契约：写进时钟的不是原始 `positionMs`，而是校正状态机的输出。
// 因此断言里出现 `LEAD`（发布滞后补偿）—— 这不是误差，是刻意的：SMTC 报的位置是「最后一个走完的
// 整秒」，读到它时真实播放时间已经多出 0~150ms（中位数 ~99ms，实测见
// docs/apple-music-lyric-clock.md）。状态机本身的规则在 externalMediaClockCorrection.test.ts 里逐条锁定。
//
// A seek hold ("keep the target until the backend catches up") was tried and REVERTED: measured on
// the real machine it only postponed the snap-back instead of making Apple Music move, so it was
// masking the symptom. The seek behaviour is being diagnosed separately; nothing here fakes a
// position the OS did not report. 最后一条「mirrors the snapshot」的断言就是这条决定的守卫。

const OFFSET_MS = 0;
const LEAD_SEC = EXTERNAL_MEDIA_CLOCK_DEFAULT_LEAD_MS / 1000;

/**
 * 一次循环迭代。
 *
 * 时间由注入的 `now` 提供：真实场景里两个锚点相隔约 1 秒，而**同一帧内连续调用两次**是现实中
 * 不存在的输入（观测值一步跳 1000ms 而墙钟没走）。校正上限以「本帧真实经过时间」为界，
 * 所以要用可控的时间轴来测「锚点按实测节律到达」的行为。
 *
 * 逻辑本身仍然走真实的 `runExternalMediaClockTick`（默认参数），测试只替换时钟。
 */
let fakeNowMs = 0;

const tick = (
    backend: 'folia' | 'external-media',
    positionMs: number | null | undefined,
    offsetMs = OFFSET_MS,
    elapsedMs = 0,
) => {
    fakeNowMs += elapsedMs;
    const now = () => fakeNowMs;
    return applyExternalMediaClockTick(backend, positionMs, offsetMs, 'Playing', runExternalMediaClockTick, now);
};

beforeEach(() => {
    currentTime.set(0);
    lyricCurrentTime.set(0);
    fakeNowMs = 0;
    // 校正状态是模块级单例：不重置的话，上一个用例的锚点会带进下一个用例。
    resetExternalMediaClock();
});

describe('applyExternalMediaClockTick', () => {
    it('writes the lag-compensated SMTC position into the shared playback clock, in seconds', () => {
        const wrote = tick('external-media', 164_000);

        expect(wrote).toBe(true);
        expect(currentTime.get()).toBeCloseTo(164 + LEAD_SEC, 5);
        expect(lyricCurrentTime.get()).toBeCloseTo(164 + LEAD_SEC, 5);
    });

    it('keeps the lyric clock on the same offset rule as the other sources', () => {
        tick('external-media', 30_000, 250);

        expect(currentTime.get()).toBeCloseTo(30 + LEAD_SEC, 5);
        expect(lyricCurrentTime.get()).toBeCloseTo(30 + LEAD_SEC - 0.25, 5);
    });

    it('writes nothing while another backend owns the transport', () => {
        // The regression this guards: a late SMTC snapshot overwriting the position of a Folia deck
        // that is actually playing.
        currentTime.set(12.5);
        lyricCurrentTime.set(12.5);

        const wrote = tick('folia', 164_000);

        expect(wrote).toBe(false);
        expect(currentTime.get()).toBe(12.5);
        expect(lyricCurrentTime.get()).toBe(12.5);
    });

    it('writes nothing when the snapshot carries no position', () => {
        // "Unknown" must not become "the very beginning": writing 0 would snap the bar back.
        currentTime.set(12.5);
        resetExternalMediaClock();

        for (const positionMs of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(applyExternalMediaClockTick('external-media', positionMs, OFFSET_MS, 'Playing')).toBe(false);
        }

        expect(currentTime.get()).toBe(12.5);
    });

    it('clamps a negative position to zero instead of refusing it', () => {
        expect(tick('external-media', -1000)).toBe(true);
        expect(currentTime.get()).toBeCloseTo(LEAD_SEC, 5);
    });

    it('adopts an advancing snapshot instead of dragging it out', () => {
        // 实测节律：锚点每约 1 秒到一次。一步 1000ms 的观测在这条支路里应当被采纳，
        // 而不是靠有上限的修正慢慢爬。
        tick('external-media', 60_000);
        expect(currentTime.get()).toBeCloseTo(60 + LEAD_SEC, 5);

        tick('external-media', 61_000, OFFSET_MS, 1100);
        // 估计值应当落在「上一锚点」与「新锚点 + 滞后补偿」之间，并明显靠后：
        // 既不能停在 60.x 慢慢爬，也不该跳到新锚点之后。
        expect(currentTime.get()).toBeGreaterThan(61);
        expect(currentTime.get()).toBeLessThan(61 + LEAD_SEC + 0.1);
    });

    it('always mirrors the snapshot, so a seek that did not take effect stays visible', () => {
        // This is the property the reverted hold broke: if the backend keeps reporting 80s after a
        // seek to 84s, the clock must say 80s - a bar that keeps claiming 84s is how a failed seek
        // stayed hidden.
        //
        // 断言写成相对于 LEAD 的形式：延迟补偿是刻意加上去的常数相位（现在是秒级，见该常数的
        // 注释），而这条测试守的是「不把报告值甩在后面」—— 两件不同的事，不该被同一个数字绑死。
        tick('external-media', 80_000);
        expect(currentTime.get()).toBeGreaterThan(80 + LEAD_SEC - 0.1);
        expect(currentTime.get()).toBeLessThan(80 + LEAD_SEC + 0.3);
    });
});
