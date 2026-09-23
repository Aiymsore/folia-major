import type { Line, LyricData } from '../types';
import { findLatestActiveLineIndex } from './appPlaybackHelpers';

// src/utils/externalMediaLyricClock.ts
// Apple Music 的歌词读头与歌词时间窗：纯函数层，不依赖 React、不依赖 store。
//
// 为什么单独一层：Apple Music 的位置来自外部应用的 SMTC 快照（整秒量化、约 1Hz 发布），
// 而 Folia 的读头公式假设位置是连续的。两者之间的差不是「精度差一点」，而是两类具体缺陷：
//
//   1. **读头缺失**：时钟被写对了但没有任何地方更新 `currentLineIndex`，歌词高亮会整首停在
//      当前行不再前进。四个 Folia 分支都更新它，Apple Music 分支曾经没有。
//   2. **读头越窗**：粗位置 + 逐词歌词时，若拿整份歌词去找活动行，边界附近的行会被过早或过晚点亮。
//      先按时间窗把候选行裁出来，读头只在窗内选，误差被限制在一两个行宽内。
//
// 两条规则都能穷举断言，因此留在纯函数里。

/**
 * 读头应当落在哪一行。与四个 Folia 分支**同一条公式**：用已经扣掉 offset 的 `lyricCurrentTime`
 * 去找最后一个 startTime ≤ t 的行，找不到就是 -1。
 *
 * 不在这里做「位置不连续就冻结读头」之类的猜测：读头必须如实反映时钟。位置是粗的这件事应当
 * 由时间窗与（将来的）外推来吸收，而不是让读头说谎。
 */
export const resolveExternalMediaLineIndex = (lines: Line[], lyricTimeSec: number): number => (
    findLatestActiveLineIndex(lines, lyricTimeSec)
);

/** 一行歌词在时间轴上的区间，供读头与后续的外推层共用。 */
export type AppleMusicLyricWindow = {
    /** 裁出的行（原顺序、原对象）。 */
    lines: Line[];
    /** 窗口起点（秒）。 */
    startSec: number;
    /** 窗口终点（秒）。等于末行的 endTime。 */
    endSec: number;
};

/**
 * 按当前歌词时间裁出**候选行窗口**。
 *
 * 规则：
 *   * 窗口从当前行**前一行的 startTime** 开始。回看一行是刻意的：SMTC 位置整秒量化，而快照可能
 *     比真实播放时刻晚到几百毫秒，读头本来就可能在边界处落在上一行；把上一行排除在窗口外会让
 *     边界抖动变成「行消失」。
 *   * 窗口到窗口内**最后一个连续行的 endTime** 为止，且至少包含当前行。之后的行属于后续时间轴，
 *     没有理由提前进入候选。
 *   * `timeSec` 早于第一行时窗口就是开头若干行，而非空。
 *
 * `lookaheadLines` 控制窗口向后多带几行（默认 0）：逐字歌词需要下一行提前进入布局，
 * 而按需渲染的调用方不需要。
 */
export const buildExternalMediaLyricWindow = (
    lines: Line[],
    timeSec: number,
    lookaheadLines = 0,
): AppleMusicLyricWindow | null => {
    if (lines.length === 0) return null;

    const boundedTime = Number.isFinite(timeSec) ? Math.max(0, timeSec) : 0;
    const activeIndex = findLatestActiveLineIndex(lines, boundedTime);
    const anchorIndex = activeIndex < 0 ? 0 : activeIndex;
    const startIndex = Math.max(0, anchorIndex - 1);
    const endIndex = Math.min(lines.length - 1, anchorIndex + Math.max(0, lookaheadLines));

    const windowLines = lines.slice(startIndex, endIndex + 1);
    if (windowLines.length === 0) return null;

    const startSec = Math.min(boundedTime, windowLines[0].startTime);
    const endSec = windowLines[windowLines.length - 1].endTime;

    return { lines: windowLines, startSec, endSec };
};

/** 判断一份歌词在给定时间点上是否存在活动行。供 UI 区分「还没唱到」与「已经唱完」。 */
export const hasActiveExternalMediaLine = (lyrics: LyricData | null, timeSec: number): boolean => (
    Boolean(lyrics) && resolveExternalMediaLineIndex(lyrics!.lines, timeSec) >= 0
);
