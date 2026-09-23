import { describe, expect, it } from 'vitest';
import type { Line } from '../../src/types';
import {
    buildExternalMediaLyricWindow,
    hasActiveExternalMediaLine,
    resolveExternalMediaLineIndex,
} from '../../src/utils/externalMediaLyricClock';

// test/unit/externalMediaLyricClock.test.ts
// Apple Music 歌词读头与时间窗。
//
// 读头缺失是一个真实缺陷（不是设计取舍）：`lyricCurrentTime` 一直被正确写入，但 Apple Music
// 分支从未更新 `currentLineIndex`，于是歌词高亮整首停在当前行不再前进 —— 时钟对、读头死。
// 这里锁定的是补齐后的规则，以及为后续外推准备的窗口规则。

const line = (startTime: number, endTime: number, fullText = `line@${startTime}`): Line => ({
    words: [],
    startTime,
    endTime,
    fullText,
});

// 0-2 / 2-4 / 4-6 / 6-8：简单、连续、便于断言边界。
const LINES: Line[] = [
    line(0, 2, 'one'),
    line(2, 4, 'two'),
    line(4, 6, 'three'),
    line(6, 8, 'four'),
];

describe('resolveExternalMediaLineIndex', () => {
    it('finds the line whose interval contains the time', () => {
        expect(resolveExternalMediaLineIndex(LINES, 0)).toBe(0);
        expect(resolveExternalMediaLineIndex(LINES, 1.9)).toBe(0);
        expect(resolveExternalMediaLineIndex(LINES, 2)).toBe(1);
        expect(resolveExternalMediaLineIndex(LINES, 7.5)).toBe(3);
    });

    it('reports -1 before the first line starts', () => {
        // 前奏：还没有任何一行该被点亮。返回 0 会让第一行提前高亮。
        expect(resolveExternalMediaLineIndex([line(5, 7), line(7, 9)], 1)).toBe(-1);
    });

    it('reports -1 after the last line ends', () => {
        // 与四个 Folia 分支同一条公式（findLatestActiveLineIndex）：行区间之外一律 -1。
        // 于是读头在「还没开始唱」和「已经唱完」两种情况下都是空的，而不是停在末行假装还在唱。
        // 末行保留：SMTC 的整秒位置可能落在 endTime 之后一点点，此时显示末行比清空更接近事实，
        // 但读头本身按区间判定，不做例外。
        expect(resolveExternalMediaLineIndex(LINES, 99)).toBe(-1);
    });

    it('reads the line boundary inclusively from the left', () => {
        // 整秒量化的位置会精确落在边界上（SMTC 的 position 是整秒），所以左闭是必须的：
        // 2.000 必须已经是第二行，否则每次跳变都会晚整整一秒。
        expect(resolveExternalMediaLineIndex(LINES, 2.0)).toBe(1);
        expect(resolveExternalMediaLineIndex(LINES, 4.0)).toBe(2);
        expect(resolveExternalMediaLineIndex(LINES, 6.0)).toBe(3);
    });
});

describe('buildExternalMediaLyricWindow', () => {
    it('returns null only when there are no lines at all', () => {
        expect(buildExternalMediaLyricWindow([], 1)).toBeNull();
    });

    it('keeps one line of lookback so a boundary jitter cannot hide a line', () => {
        const window = buildExternalMediaLyricWindow(LINES, 4.2);
        expect(window).not.toBeNull();
        // 当前行是 index 2（three），起点回看一行到 index 1（two）。
        expect(window!.lines.map(l => l.fullText)).toEqual(['two', 'three']);
        expect(window!.startSec).toBe(2);
        expect(window!.endSec).toBe(6);
    });

    it('does not walk past the start of the song', () => {
        const window = buildExternalMediaLyricWindow(LINES, 0.5);
        expect(window!.lines[0].fullText).toBe('one');
        expect(window!.startSec).toBe(0);
    });

    it('treats a time before the first line as the beginning of the song', () => {
        const window = buildExternalMediaLyricWindow([line(5, 7, 'intro')], 1);
        expect(window!.lines.map(l => l.fullText)).toEqual(['intro']);
        // 起点取「当前时间」与「首行起点」里更早的那个，因此窗口覆盖前奏区间。
        expect(window!.startSec).toBe(1);
        expect(window!.endSec).toBe(7);
    });

    it('extends forward only when asked, for word-by-word layout', () => {
        const tight = buildExternalMediaLyricWindow(LINES, 4.2);
        const withLookahead = buildExternalMediaLyricWindow(LINES, 4.2, 1);

        expect(tight!.lines.map(l => l.fullText)).toEqual(['two', 'three']);
        expect(withLookahead!.lines.map(l => l.fullText)).toEqual(['two', 'three', 'four']);
        expect(withLookahead!.endSec).toBe(8);
    });

    it('clamps the lookahead at the end of the song', () => {
        const window = buildExternalMediaLyricWindow(LINES, 7.5, 5);
        expect(window!.lines.map(l => l.fullText)).toEqual(['three', 'four']);
        expect(window!.endSec).toBe(8);
    });

    it('tolerates a non-finite time instead of producing a broken window', () => {
        for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
            const window = buildExternalMediaLyricWindow(LINES, value);
            expect(window).not.toBeNull();
            expect(window!.lines.length).toBeGreaterThan(0);
        }
    });
});

describe('hasActiveExternalMediaLine', () => {
    it('is false with no lyrics, even late in the track', () => {
        expect(hasActiveExternalMediaLine(null, 100)).toBe(false);
    });

    it('is false during an intro and true once a line is active', () => {
        const lyrics = { lines: [line(5, 7, 'intro')] };
        expect(hasActiveExternalMediaLine(lyrics, 1)).toBe(false);
        expect(hasActiveExternalMediaLine(lyrics, 5)).toBe(true);
    });
});
