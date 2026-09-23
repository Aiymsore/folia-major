import type { LyricData } from '../types';
import type { PlaybackBackend } from '../types/playbackBackend';
import { currentTime, lyricCurrentTime } from '../stores/motionSignals';
import { resolveExternalMediaLineIndex } from './externalMediaLyricClock';
import { sampleExternalMediaClockProbe } from './externalMediaClockProbe';
import {
    EXTERNAL_MEDIA_CLOCK_DEFAULT_LEAD_MS,
    externalMediaClockPositionSec,
    createExternalMediaClockState,
    tickExternalMediaClock,
    type ExternalMediaClockState,
} from './externalMediaClockCorrection';

// src/utils/externalMediaClockRuntime.ts
// Apple Music 的**全局播放时钟写入者**：把「SMTC 粗锚点 + 单调时钟 + 低增益校正」接到 motion signal 上。
//
// 三条边界（与 frontend-runtime-guardrails 一致）：
//   * 连续时间只写 MotionValue（`currentTime` / `lyricCurrentTime`），**绝不进 React state 或 store**。
//     校正状态是模块级单例，不是 hook state —— 它每帧都会被改，放进 React 只会带来每帧重渲染。
//   * 唯一的 React state 写入是歌词读头（离散整数），且只在真的换行时写。
//   * 非 apple-music 后端时状态被复位，时钟完全交还给 Folia 的四个来源。

let clockState: ExternalMediaClockState = createExternalMediaClockState();

/** 单调时钟读数（毫秒）。抽成函数是为了让测试注入确定性的时间轴。 */
export const externalMediaClockNow = (): number => performance.now();

/**
 * 运行时覆盖 lead 的 localStorage 键。
 *
 * 为什么需要它：`EXTERNAL_MEDIA_CLOCK_DEFAULT_LEAD_MS` 里的「听感那一段」只能靠耳朵定位（见该常数
 * 的注释）。如果每次试值都要改源码 + 重启 dev server，调参会慢到没法做。这个键让「改一个数、
 * 刷新页面、再听一遍」成立，且不需要任何构建。
 *
 * 值是毫秒整数；非法或缺失时回落到默认值。
 */
export const EXTERNAL_MEDIA_CLOCK_LEAD_OVERRIDE_KEY = 'folia_apple_music_clock_lead_ms';

/** 读取运行时 lead：localStorage 覆盖优先，否则用默认值。 */
export const readRuntimeLeadMs = (): number => {
    if (typeof window === 'undefined') return EXTERNAL_MEDIA_CLOCK_DEFAULT_LEAD_MS;
    try {
        const raw = window.localStorage.getItem(EXTERNAL_MEDIA_CLOCK_LEAD_OVERRIDE_KEY);
        if (raw === null) return EXTERNAL_MEDIA_CLOCK_DEFAULT_LEAD_MS;
        const parsed = Number(raw);
        // 允许 0（关掉补偿）但拒绝负数与荒谬值：负 lead 会把时钟推向报告值之前。
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 10_000) {
            return EXTERNAL_MEDIA_CLOCK_DEFAULT_LEAD_MS;
        }
        return parsed;
    } catch {
        // localStorage 可能被禁用（隐私模式、极端沙箱）：回到默认值，而不是让时钟挂掉。
        return EXTERNAL_MEDIA_CLOCK_DEFAULT_LEAD_MS;
    }
};

/** 复位校正状态。后端切换、测试与诊断重置都走这里。 */
export const resetExternalMediaClock = (): void => {
    clockState = createExternalMediaClockState();
};

/** 只读当前估计值（秒），供诊断与测试断言。 */
export const getExternalMediaClockSec = (): number => externalMediaClockPositionSec(clockState);

/** 只读当前估计值（毫秒），供诊断与测试断言。 */
export const getExternalMediaClockState = (): ExternalMediaClockState => clockState;

/**
 * 位置上限（24 小时）。只用来给荒谬输入兜底，不表达任何产品约束。
 *
 * 为什么需要它：校正层把「大幅前向差」当作切歌直接采纳，而 `Infinity - position` 是 `Infinity`，
 * 于是一条坏输入会把位置永久打成 `Infinity`。这里先把观测值收成有限值，让校正常规地判断。
 */
const EXTERNAL_MEDIA_CLOCK_MAX_POSITION_MS = 24 * 60 * 60 * 1000;

/** 把 SMTC 位置收成「有限、非负、有上界」的值；不可解析时返回 null（未知，不是零点）。 */
const normalizeObservedPositionMs = (positionMs: number | null | undefined): number | null => {
    if (typeof positionMs !== 'number' || !Number.isFinite(positionMs)) return null;
    return Math.min(EXTERNAL_MEDIA_CLOCK_MAX_POSITION_MS, Math.max(0, positionMs));
};

export type ExternalMediaClockTickInput = {
    backend: PlaybackBackend;
    positionMs: number | null | undefined;
    playbackStatus: string | null;
    lyricTimelineOffsetMs: number;
    nowMs: number;
    /**
     * 该位置被操作系统确立的时刻，Unix 墙钟毫秒（快照的 `lastUpdatedAt`）。
     *
     * 由 `runExternalMediaClockTick` 折算成本地单调刻度后交给校正层 —— 校正层刻意不读时钟，
     * 而墙钟与单调钟之间需要一个基准点才能换算。
     */
    lastUpdatedAtMs?: number | null;
};

/**
 * 墙钟 → 本地单调钟的基准点。
 *
 * `performance.now()` 与 `Date.now()` 是两个不同的时基（前者从进程启动算起、不受系统时间调整
 * 影响），换算需要一对同时刻的读数。每次 tick 都更新它，于是换算始终用最新的一对，
 * 系统时钟被 NTP 调整时也能跟上。
 */
let wallClockOffsetMs: number | null = null;

/** 把 Unix 墙钟毫秒折算成本地单调刻度。返回 null 表示这次换算不可信（调用方退化成「刚读到」）。 */
const wallClockToMonotonicMs = (wallClockMs: number, nowMs: number): number | null => {
    if (typeof Date !== 'function') return null;
    const wallNowMs = Date.now();
    if (!Number.isFinite(wallNowMs) || !Number.isFinite(wallClockMs)) return null;
    wallClockOffsetMs = wallNowMs - nowMs;
    const mapped = wallClockMs - wallClockOffsetMs;
    // 允许一点点未来（快照可能在两次读数之间到达），但明显超出「现在」的戳不可信：
    // 用它当锚点会让外推从未来起跑，位置直接跳到前面去。
    if (mapped > nowMs + 1000) return null;
    return mapped;
};

/**
 * 「Apple Music 拥有传输权时，把校正后的位置写进全局播放时钟」。返回本帧是否写了。
 *
 * 从 RAF 循环里提出来是为了让这条支路能被真正执行地断言（motion signal 是模块级的，
 * 调用它就能观察 `currentTime` / `lyricCurrentTime` 的值）。
 *
 * 语义：
 *   * 后端不是 apple-music（或快照没有可用位置）→ 一个字节都不写，时钟仍由原有四分支持有。
 *     这条正是「迟到的 SMTC 快照不会覆盖正在播放的 Folia deck 位置」的保证。
 *   * 否则写 `currentTime`（秒），并按同一 offset 规则写歌词时钟。
 *   * 只读镜像：不写 playback store、不碰 audio 元素、不改 backend。
 */
export const runExternalMediaClockTick = (input: ExternalMediaClockTickInput): boolean => {
    const { backend, positionMs, playbackStatus, lyricTimelineOffsetMs, nowMs, lastUpdatedAtMs } = input;

    if (backend !== 'external-media') {
        // 交还时钟：状态复位，让下一次进入 apple-music 时从新锚点开始，而不是接上一次的旧斜率。
        resetExternalMediaClock();
        return false;
    }

    // 先归一化：`null` 表示「这一帧没有位置」（与「零点」不同），非有限值同样按未知处理。
    const observedPositionMs = normalizeObservedPositionMs(positionMs);

    // 有确立时刻就用它 —— 年龄变成算出来的，`leadMs` 随之不再叠加（见校正层注释）。
    const observedAtMs = (typeof lastUpdatedAtMs === 'number' && Number.isFinite(lastUpdatedAtMs))
        ? wallClockToMonotonicMs(lastUpdatedAtMs, nowMs)
        : null;

    if (observedPositionMs === null) {
        // 有后端但没有可用位置：保持状态推进（位置未知不等于零点），但本帧不写时钟。
        // 首帧无锚点时 `tickExternalMediaClock` 自己会保持 0，不需要额外分支。
        clockState = tickExternalMediaClock(clockState, {
            nowMs,
            observedPositionMs: null,
            playbackStatus,
            backend,
        });
        return false;
    }

    clockState = tickExternalMediaClock(clockState, {
        nowMs,
        observedPositionMs,
        playbackStatus,
        backend,
        observedAtMs,
    }, { leadMs: readRuntimeLeadMs() });

    // 诊断采样：探针未开启时是一次纯比较，无副作用。
    sampleExternalMediaClockProbe({
        nowMs,
        observedPositionMs,
        playbackStatus,
        estimatedPositionMs: clockState.positionMs,
        stampMeasured: observedAtMs !== null,
    });

    const positionSec = externalMediaClockPositionSec(clockState);
    currentTime.set(positionSec);
    lyricCurrentTime.set(positionSec - lyricTimelineOffsetMs / 1000);
    return true;
};

/**
 * 歌词读头：把校正后的位置换算成行索引。
 *
 * 返回值**不是** React state，而是「应当写入的离散值」；调用方与上一帧比较后再决定是否写 state ——
 * 每帧无条件 setState 是 guardrails 明确禁止的。
 *
 * `lyricTimeSec` 可注入，使这条读头路径也能用固定时间轴断言，而不必依赖 motion signal 的当前值。
 */
export const resolveCurrentExternalMediaLineIndex = (
    lyrics: LyricData | null,
    lyricTimeSec: number = lyricCurrentTime.get(),
): number => (
    lyrics ? resolveExternalMediaLineIndex(lyrics.lines, lyricTimeSec) : -1
);
