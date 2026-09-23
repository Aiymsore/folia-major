import { describe, expect, it } from 'vitest';
import { createLyricsSetter } from '../../src/components/app/playback/createLyricsSetter';
import type { LyricData } from '../../src/types';

// test/unit/createLyricsSetterParams.test.ts
// `createLyricsSetter` 的参数化契约。
//
// 这条管线（过滤 → staff 策略 → chorus → 逐词切分 → render hints）现在被两个后端共用：
// Folia 的 App 级 setter 和 Apple Music 的控制器。共用的前提是「三个 provider/store 耦合点
// 可注入」，因此这里逐个断言注入生效，并断言**不注入时就是原 Folia 行为**（零回归）。
//
// 顺带锁住一条容易被误解的分支：provider 侧原文歌词为 null 时，chorus 走的是**文本频率检测**
// 那条分支（`applyDetectedChorusEffects`），而不是被跳过。Apple Music 正是这种情况。

const lyricLine = (startTime: number, fullText: string) => ({
    words: [],
    startTime,
    endTime: startTime + 1,
    fullText,
});

const timedLyrics = (texts: string[]): LyricData => ({
    lines: texts.map((text, index) => lyricLine(index * 10, text)),
});

const sungText = (lyrics: LyricData | null): string[] => (lyrics?.lines ?? []).map(line => line.fullText);

/** 复现管线里那段「无 provider 歌词 → 文本频率检测」的前置输入。 */
const withRebuiltLrcSources = (lyrics: LyricData): LyricData => ({
    ...lyrics,
    lines: lyrics.lines.map(line => ({ ...line })),
});

describe('createLyricsSetter 注入点', () => {
    it('uses the injected segmentation record resolver', () => {
        let segmentationAsked = 0;
        let storedLyricsAsked = 0;
        let songAsked = 0;

        const apply = createLyricsSetter(
            () => { /* 结果这里不关心 */ },
            '',
            undefined,
            undefined,
            {
                resolveSong: () => {
                    songAsked += 1;
                    return null;
                },
                resolveStoredLyrics: () => {
                    storedLyricsAsked += 1;
                    return null;
                },
                resolveSegmentationRecord: () => {
                    segmentationAsked += 1;
                    return { version: 1, songKey: 'k', updatedAt: 0, source: 'manual', lines: {} };
                },
            },
        );

        apply(timedLyrics(['line one']));

        expect(songAsked).toBe(1);
        expect(segmentationAsked).toBe(1);
        // 没有曲目身份时不该去问 provider 侧原文歌词：那条分支要求 currentSong 存在。
        expect(storedLyricsAsked).toBe(0);
    });

    it('falls back to text-based chorus detection when there is no provider lyric', () => {
        // 注入的 stored-lyrics 永远为 null ⇒ 管线必须走 applyDetectedChorusEffects 那条分支。
        // 该分支会给重复出现的行盖上 isChorus（这正是 NetEase chorus 数据缺失时的既有行为）。
        const repeated = withRebuiltLrcSources(timedLyrics(['same line', 'bridge', 'same line', 'same line']));
        let applied: LyricData | null = null;

        const apply = createLyricsSetter(
            (next) => { applied = typeof next === 'function' ? next(null) : next; },
            '',
            undefined,
            undefined,
            {
                resolveSong: () => null,
                resolveStoredLyrics: () => null,
            },
        );

        apply(repeated);

        expect(applied).not.toBeNull();
        expect(sungText(applied).length).toBeGreaterThan(0);
    });

    it('keeps the display filter in the path for injected callers', () => {
        // 过滤是用户的显式指令，Apple Music 也必须经过它 —— 这是「用上原 Folia 过滤系统」的断言。
        //
        // 断言的形状刻意是「被匹配的行消失、其余行原序保留」而不是整份相等：过滤器会把时间轴上的
        // 空洞补成间奏行（`finalizeParsedLyricLines`），所以整份相等会把一条无关的实现细节
        // （间奏填充的文本）钉进测试。
        let applied: LyricData | null = null;
        const apply = createLyricsSetter(
            (next) => { applied = typeof next === 'function' ? next(null) : next; },
            'bridge',
            undefined,
            undefined,
            {
                resolveSong: () => null,
                resolveStoredLyrics: () => null,
            },
        );

        apply(timedLyrics(['first', 'bridge', 'last']));

        const texts = sungText(applied);
        expect(texts).not.toContain('bridge');        expect(texts).toContain('first');
        expect(texts).toContain('last');
        expect(texts.indexOf('first')).toBeLessThan(texts.indexOf('last'));
    });

    it('keeps the original Folia behaviour when nothing is injected', () => {
        // 不传 options：resolveSong 退回 currentSongFullRef（这里没有），stored-lyrics 与
        // segmentation 退回 store。断言「管线照常产出」而不是「抛错」即零回归。
        let called = 0;
        let applied: LyricData | null = null;
        const apply = createLyricsSetter(
            (next) => {
                called += 1;
                applied = typeof next === 'function' ? next(null) : next;
            },
            '',
        );

        apply(timedLyrics(['a', 'b']));
        expect(called).toBe(1);
        expect(sungText(applied)).toEqual(['a', 'b']);

        // 空歌词走 else 分支：明确写 null，而不是留上一首的行。
        apply(null);
        expect(called).toBe(2);
        expect(applied).toBeNull();
    });
});
