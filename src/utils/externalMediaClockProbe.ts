// src/utils/externalMediaClockProbe.ts
// Apple Music 歌词时钟的**诊断采样**：回答「我们的时钟与 SMTC 报告值相差多少、以及这个差怎么变」。
//
// 为什么需要它：`EXTERNAL_MEDIA_CLOCK_DEFAULT_LEAD_MS` 里的常数相位（听感那一段）只能实机定位，
// 而听感本身分不清「固定提前量」与「周期内斜坡」。探针把两者分开记录：
//
//   phaseMs       估计值 - 报告值。**固定相位**表现为这个数的均值；斜坡表现为它在 1 秒周期内摆动。
//   anchorAgeMs   距上一个锚点确立过了多久。用来确认摆动周期是否等于实测的发布节律。
//
// 三条纪律：
//   * 默认关闭。探针会写 localStorage 与 console，不能常开。
//   * 采样只在**报告值变化时**发生（约 1Hz），不是每帧 —— 每帧记录会把缓冲区冲掉且毫无信息量。
//   * 不读 store、不写 store、不 import React。它只是往数组里塞数字。

/** 是否开启：`localStorage['folia_apple_music_clock_probe'] = '1'` */
export const APPLE_MUSIC_CLOCK_PROBE_KEY = 'folia_apple_music_clock_probe';

/** 落盘位置：`localStorage['folia_apple_music_clock_probe_log']`，JSON 数组。 */
export const APPLE_MUSIC_CLOCK_PROBE_LOG_KEY = 'folia_apple_music_clock_probe_log';

/** 缓冲区上限。约 1Hz 采样 ⇒ 600 条约十分钟，足够覆盖一首长曲。 */
const PROBE_BUFFER_LIMIT = 600;

export type ExternalMediaClockProbeSample = {
    /** 采样时的本地单调时钟（毫秒）。 */
    atMs: number;
    /** SMTC 报告的位置（毫秒）。 */
    observedMs: number;
    /** 校正层的估计值（毫秒，已含 lead）。 */
    estimatedMs: number;
    /** 估计值 - 报告值。固定相位 + 斜坡都体现在这里。 */
    phaseMs: number;
    /** 距上一个锚点的真实经过时间（毫秒）。 */
    anchorAgeMs: number;
    /**
     * 锚点年龄是**测出来的**还是估出来的。
     *
     * `measured` = 快照带了 `lastUpdatedAt`，年龄来自操作系统的时间戳；
     * `assumed` = 没有那个戳，年龄退化成「刚收到」，此时相位里必然含一段未补偿的滞后。
     * 这条区分很关键：判读相位均值时必须知道它是在哪种模式下测的。
     */
    stampSource: 'measured' | 'assumed';
    playbackStatus: string | null;
};

let enabled: boolean | null = null;
let buffer: ExternalMediaClockProbeSample[] = [];
let lastObservedMs: number | null = null;
let lastAnchorAtMs: number | null = null;

const readEnabled = (): boolean => {
    if (enabled !== null) return enabled;
    if (typeof window === 'undefined') {
        enabled = false;
        return enabled;
    }
    try {
        enabled = window.localStorage.getItem(APPLE_MUSIC_CLOCK_PROBE_KEY) === '1';
    } catch {
        enabled = false;
    }
    return enabled;
};

/** 重新读取开关。改了 localStorage 后调用（或刷新页面）。 */
export const refreshExternalMediaClockProbeEnabled = (): boolean => {
    enabled = null;
    return readEnabled();
};

export const isExternalMediaClockProbeEnabled = (): boolean => readEnabled();

/** 清空缓冲与锚点状态。 */
export const resetExternalMediaClockProbe = (): void => {
    buffer = [];
    lastObservedMs = null;
    lastAnchorAtMs = null;
};

const persist = (): void => {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(APPLE_MUSIC_CLOCK_PROBE_LOG_KEY, JSON.stringify(buffer));
    } catch {
        // 配额或隐私模式：诊断数据丢了可以接受，绝不能让时钟因此出错。
    }
};

/**
 * 记录一次采样。由 `runExternalMediaClockTick` 在有可用位置时调用。
 *
 * **只在报告值变化时记录**：位置整秒量化，每帧都记只会塞满同样的数字。
 */
export const sampleExternalMediaClockProbe = (input: {
    nowMs: number;
    observedPositionMs: number;
    playbackStatus: string | null;
    estimatedPositionMs: number;
    /** 锚点年龄是否来自操作系统的 `LastUpdatedTime`（true）还是「刚收到」的假设（false）。 */
    stampMeasured?: boolean;
}): void => {
    if (!readEnabled()) return;
    if (input.observedPositionMs === lastObservedMs) return;

    const anchorAgeMs = lastAnchorAtMs === null ? 0 : input.nowMs - lastAnchorAtMs;
    lastObservedMs = input.observedPositionMs;
    lastAnchorAtMs = input.nowMs;

    const stampSource = input.stampMeasured === true ? 'measured' : 'assumed';

    buffer.push({
        atMs: Math.round(input.nowMs),
        observedMs: input.observedPositionMs,
        estimatedMs: Math.round(input.estimatedPositionMs),
        phaseMs: Math.round(input.estimatedPositionMs - input.observedPositionMs),
        anchorAgeMs: Math.round(anchorAgeMs),
        stampSource,
        playbackStatus: input.playbackStatus,
    });

    if (buffer.length > PROBE_BUFFER_LIMIT) {
        buffer = buffer.slice(buffer.length - PROBE_BUFFER_LIMIT);
    }
    persist();

    // 控制台也留一份，方便边听边看最新一条。
    console.log(
        `[AM clock] pos=${(input.observedPositionMs / 1000).toFixed(3)}s ` +
        `est=${(input.estimatedPositionMs / 1000).toFixed(3)}s ` +
        `phase=${(input.estimatedPositionMs - input.observedPositionMs).toFixed(0)}ms ` +
        `anchorAge=${anchorAgeMs.toFixed(0)}ms stamp=${stampSource}`,
    );
};

/** 供诊断 UI 或控制台读取当前缓冲。 */
export const getExternalMediaClockProbeSamples = (): readonly ExternalMediaClockProbeSample[] => buffer;
