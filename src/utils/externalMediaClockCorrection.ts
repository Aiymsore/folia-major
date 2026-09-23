import type { PlaybackBackend } from '../types/playbackBackend';

// src/utils/externalMediaClockCorrection.ts
// 「SMTC 粗锚点 + 单调时钟 + 低增益校正」的**纯状态机**：不依赖 React、不读时钟、不写 store。
//
// 为什么需要它（数字来自 2026-09-15 的真实采样，见 docs/apple-music-lyric-clock.md）：
//
//   * Apple Music 把位置量化到整秒，并且只在操作系统重新发布 timeline 时才更新，发布周期
//     实测 ~250ms。于是相邻两次位置变化之间的墙钟间隔落在两个峰上：~850ms 与 ~1100ms。
//   * 结果是：**读到新位置的那一刻，真实播放时间已经比它多出 0~150ms（中位数 ~99ms）**。
//     也就是说「拿到多少就显示多少」这件事本身就带来约 0.1s 的系统性滞后。
//   * 但整段的平均速率是对的：120s 的位置跨度对应 119.82s 墙钟（1.0015x），残差在 120 秒里
//     只漂移了 179ms。所以**不需要速率校正去救比例误差**，只需要把量化带来的台阶抹平。
//
// 三条规则，都不做猜测：
//   1. 两帧之间按本地单调时钟推进（斜率锁在 1.0），所以进度条与歌词是连续移动的，
//      而不是每约 1 秒硬跳一格。
//   2. 收到新锚点时，误差作为**位置修正量**被分批吃掉。两个边界一起决定它有多"软"：
//      `gain`（每步吃掉多少比例）与 `MAX_CORRECTION_FACTOR`（本帧最多按真实经过时间的几倍推进）。
//   3. 大到正常播放解释不了的差值（>`APPLE_MUSIC_CLOCK_JUMP_MS`）不是台阶而是切歌，直接采纳。
//
// 速率刻意恒为 1：位置被量化成整秒，用 `Δposition` 推斜率会得到 1.125 这种荒谬值；
// 而整段实测就是 1.0015x。收敛交给第 2 条，不交给斜率。

/** 相邻锚点间隔超过这个值就判定为停滞（暂停/缓冲/桥接断开），不推进外推。 */
export const APPLE_MUSIC_CLOCK_STALL_MS = 2500;

/**
 * 「一跳就是这么远」的判定阈值（毫秒）。
 *
 * 位置是整秒量化的，因此正常情况下一帧的观测最多比外推值超前约一个量化步（1000ms）。
 * 超过这个值就只能是换了一首歌，或者暂停恢复时用户在别处拖了进度 —— 两种情况都应当**直接采纳**，
 * 而不是用有上限的修正慢慢拖过去（那会表现为「切歌后进度条爬十几秒才到位」）。
 */
export const APPLE_MUSIC_CLOCK_JUMP_MS = 1500;

/**
 * 单帧位置修正上限，表达为「本帧真实经过时间的倍数」。
 *
 * 为什么是倍数而不是固定毫秒数：量化台阶是整整 1000ms，而锚点每约 1 秒才到一次。
 * 固定 120ms 的上限意味着一个台阶要爬约 8 个锚点周期 —— 实测那会让估计值长期落后报告值
 * 数百毫秒，读头系统性偏早。允许「本帧最多按真实经过时间的两倍推进」，就把台阶摊在它所属的
 * 那一秒区间里消化掉：视觉上是一段轻微加速，而不是一次跳跃。
 */
export const APPLE_MUSIC_CLOCK_MAX_CORRECTION_FACTOR = 2;

/** 斜率允许区间。位置来自整秒量化，长时间尺度上实测就是 1.0，因此这里只留很小的修正余地。 */
export const APPLE_MUSIC_CLOCK_RATE_MIN = 0.98;
export const APPLE_MUSIC_CLOCK_RATE_MAX = 1.02;

/**
 * 发布滞后补偿的**默认值**（毫秒）。
 *
 * 这个数字的来源分两段，必须区分清楚，否则会以为它是测出来的：
 *
 *   1. **可离线测得的部分 ≈ 100ms**：位置被量化到「最后一个已经走完的整秒」，并且只在操作系统
 *      重新发布 timeline 时才更新（发布周期 ~250ms 的量子，实测相邻变化间隔落在 ~850ms 与 ~1100ms
 *      两个峰）。读到新位置时真实播放时间已经多出 0~150ms，中位数 ~99ms（见
 *      docs/apple-music-lyric-clock.md）。
 *   2. **只能实测的部分 ≈ 1.15s**：实机听感报告「比原曲慢 1~1.5s，取 1.25s」。这一段包含 SMTC
 *      报告链路之外的音频输出/解码延迟与其它固定相位，**离线采样看不到它**，所以我把它作为
 *      实测估计并入默认值，而不是当作已知量硬编码。
 *
 * 因此默认值 = 1250ms，它**是一个待确认的估计**：`docs/apple-music-lyric-clock.md` 的诊断探针
 * 负责把它拆成「常数相位」与「周期内斜坡」两部分。拆开之后，常数部分应当交给用户可调的歌词偏移
 * （`useLyricSettingsStore.globalLyricTimelineOffsetMs`，已经存在且已持久化），本常数只保留第 1 段。
 *
 * 运行时可以用 `localStorage['folia_apple_music_clock_lead_ms']` 覆盖，方便边听边调而不必重新构建
 * （见 externalMediaClockRuntime.ts 的 readRuntimeLeadMs）。
 *
 * 为什么加在**观测值**上而不是加在“锚点+外推”的结果上：前者让外推的起点就是听感时间的无偏估计，
 * 后者会变成“读数 + 固定提前量”，暂停时会把进度条顶到前面去。
 */
export const EXTERNAL_MEDIA_CLOCK_DEFAULT_LEAD_MS = 1250;

export type ExternalMediaClockState = {
    /** 当前估计的真实播放位置（毫秒）。播放中单调不减，除非走了跳变分支。 */
    positionMs: number;
    /** 上一次锚点对应的估计位置（已含滞后补偿）。`null` 表示还没有锚点。 */
    anchorPositionMs: number | null;
    /**
     * 锚点位置**被确立**的本地单调时刻（毫秒）。
     *
     * 有 `LastUpdatedTime` 时这是真的确立时刻；没有时退化成「收到它的时刻」，
     * 那时才需要 `leadMs` 去补偿未知的年龄。
     */
    anchorAtMs: number | null;
    /**
     * 上一次 tick 的本地单调时刻（毫秒）。用于算「本帧推进了多少」。
     *
     * 与 `lastNewObservationAtMs` 刻意分开：两者回答不同的问题。
     * 用同一个数会让「位置没变」被误当成「桥接卡住」。
     */
    lastTickAtMs: number | null;
    /** 上一次收到**新**观测值的本地单调时刻（毫秒）。只用于停滞判定。 */
    lastNewObservationAtMs: number | null;
    /** 到上次锚点为止估计出的斜率，首帧为 1。 */
    rate: number;
    /** 最近一次 tick 之后仍待被吃掉的相位误差（毫秒）。必须有界，用于诊断与断言。 */
    pendingCorrectionMs: number;
    /** 最近一次 tick 时播放器是否在被观察为「正在播放」。 */
    playing: boolean;
    /**
     * 上一次观测值的身份：位置与确立时刻的组合。
     *
     * 用来识别「这一帧没有新信息」：helper 每 250ms 轮询，而位置每秒才变一次，所以绝大多数
     * tick 拿到的是**同一个采样**。把它当成新锚点去校正，等于让外推和自己的前馈打架 ——
     * 表现为位置被反复往回拽。同一个观测值只应当推进，不应当重新锚定。
     */
    lastObservedKey: string | null;
};

export const createExternalMediaClockState = (): ExternalMediaClockState => ({
    positionMs: 0,
    anchorPositionMs: null,
    anchorAtMs: null,
    lastTickAtMs: null,
    lastNewObservationAtMs: null,
    rate: 1,
    pendingCorrectionMs: 0,
    playing: false,
    lastObservedKey: null,
});

export type ExternalMediaClockTickInput = {
    /** 本次 tick 的本地单调时钟读数（毫秒）。由调用方提供，使本模块自身不读时钟。 */
    nowMs: number;
    /** SMTC 报出的位置（毫秒）。null 表示这一帧没有位置可用。 */
    observedPositionMs: number | null;
    /** 观察到的播放状态。只有 'Playing' 才推进外推。 */
    playbackStatus: string | null;
    /** 播放后端。非 apple-music 时状态被复位，时钟交还给 Folia 分支。 */
    backend: PlaybackBackend;
    /**
     * 该位置**被操作系统确立**的时刻，换算成本地单调时钟刻度（毫秒）；未知时为 null。
     *
     * 由调用方把 SMTC 的 `LastUpdatedTime`（Unix 墙钟）折算过来，因为本模块不读时钟。
     * 给了它，锚点年龄就是**测出来的**；没给，就只能假设「刚读到」，那正是周期内斜坡的来源。
     */
    observedAtMs?: number | null;
};

export type AppleMusicClockTickOptions = {
    /** 每帧吃掉相位误差的比例。越大越快收敛、越容易被量化噪声带偏。 */
    gain?: number;
    /**
     * 单帧位置修正上限，单位是「本帧真实经过时间的倍数」。
     * 见 `APPLE_MUSIC_CLOCK_MAX_CORRECTION_FACTOR`。
     */
    maxCorrectionFactor?: number;
    /** 超过这个间隔视为停滞，不推进。 */
    stallMs?: number;
    /** 发布滞后补偿，见 `EXTERNAL_MEDIA_CLOCK_DEFAULT_LEAD_MS`。 */
    leadMs?: number;
};

const DEFAULT_GAIN = 0.25;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/**
 * 推进一帧。返回**新的**状态（纯函数，便于逐条断言）；调用方把返回值的 `positionMs` 写进时钟。
 *
 * 分支语义：
 *   * backend 不是 apple-music → 复位。时钟交还给 Folia 的四个来源，本层不再有话语权。
 *   * `observedPositionMs` 为 null（快照没有位置）→ 保持现状推进，**不写 0**：
 *     「未知」与「零点」是不同的事实，按回开头比停住更糟。
 *   * 播放器不在 Playing → 冻结在当前位置（暂停期间位置本来就不该动），但仍收下锚点，
 *     这样恢复播放时不会有旧锚点引起的跳变。
 *   * 与当前估计相差超过 `APPLE_MUSIC_CLOCK_JUMP_MS` → 视为切歌（Apple Music 的 seek 不生效，
 *     见 `useTransportDispatcher.handleExternalMediaSeek`），直接采纳并重置斜率，不做平滑。
 *   * 与上一锚点间隔超过停滞阈值 → 桥接停了或播放器卡住，不推进。宁可停住也不要按未知速率跑。
 */
export const tickExternalMediaClock = (
    state: ExternalMediaClockState,
    input: ExternalMediaClockTickInput,
    options: AppleMusicClockTickOptions = {},
): ExternalMediaClockState => {
    const gain = clamp(options.gain ?? DEFAULT_GAIN, 0, 1);
    const maxCorrectionFactor = Math.max(0, options.maxCorrectionFactor ?? APPLE_MUSIC_CLOCK_MAX_CORRECTION_FACTOR);
    const stallMs = options.stallMs ?? APPLE_MUSIC_CLOCK_STALL_MS;
    const leadMs = Math.max(0, options.leadMs ?? EXTERNAL_MEDIA_CLOCK_DEFAULT_LEAD_MS);

    if (input.backend !== 'external-media') {
        return createExternalMediaClockState();
    }

    const playing = input.playbackStatus === 'Playing';
    const rawObserved = (typeof input.observedPositionMs === 'number' && Number.isFinite(input.observedPositionMs))
        ? Math.max(0, input.observedPositionMs)
        : null;

    // 锚点时刻：优先用**测出来的**确立时刻（`LastUpdatedTime` 折算），退化成「收到它的时刻」。
    //
    // 这两者的区别就是本轮修的东西：
    //   * 有确立时刻 ⇒ 我们知道这个位置在墙钟的哪一刻成立，于是年龄是算出来的。
    //     **此时绝不能再加 `leadMs`** —— 那会把同一段滞后补偿两次，表现为歌词整体提前。
    //   * 没有确立时刻 ⇒ 只能假设「刚读到」，用 `leadMs` 去估那个未知的年龄。
    const hasMeasuredStamp = typeof input.observedAtMs === 'number' && Number.isFinite(input.observedAtMs);
    const observedAtMs = hasMeasuredStamp
        // 明显超前于「现在」的戳不可信（时钟跳变、换算错误）：钳到 now，退化成「刚读到」。
        ? Math.min(input.observedAtMs as number, input.nowMs)
        : input.nowMs;
    const observed = rawObserved === null ? null : rawObserved + (hasMeasuredStamp ? 0 : leadMs);

    // 观测值身份：位置 + 确立时刻。用来识别「这一帧没有新信息」。
    //
    // 这是必须的：helper 每 250ms 轮询，而位置每秒才变一次，所以绝大多数 tick 拿到的是同一个
    // 采样。若把重复采样当成新锚点重新校正，外推就会被自己的前馈反复往回拽 —— 表现为位置抖动。
    const observedKey = observed === null ? null : `${rawObserved}|${hasMeasuredStamp ? observedAtMs : 'x'}`;
    const isNewObservation = observedKey !== null && observedKey !== state.lastObservedKey;

    // 首个锚点：直接采纳，不做任何平滑（没有可比的过去）。
    if (state.anchorAtMs === null || state.anchorPositionMs === null) {
        if (observed === null) {
            return { ...state, playing, lastTickAtMs: input.nowMs };
        }
        return {
            // 用锚点的真实时刻回推这一帧：确立到现在之间真实播放已经走过的时间要算进去。
            positionMs: observed + Math.max(0, input.nowMs - observedAtMs),
            anchorPositionMs: observed,
            anchorAtMs: observedAtMs,
            lastTickAtMs: input.nowMs,
            lastNewObservationAtMs: input.nowMs,
            rate: 1,
            pendingCorrectionMs: 0,
            playing,
            lastObservedKey: observedKey,
        };
    }

    // 本帧推进量：距上一次 tick 的真实经过时间。用它而不是「距锚点的时间」，
    // 是为了让连续两帧之间只加一次增量，锚点变化时不会把同一段时间重复计入。
    const tickDeltaMs = Math.max(0, input.nowMs - (state.lastTickAtMs ?? input.nowMs));

    // 停滞判定：**没有新观测值**且已经持续太久（桥接停了、播放器卡住、窗口被挂起）。
    // 关键在「没有新观测值」这个前提 —— helper 两次轮询之间位置不变是正常的，不是停滞。
    const sinceNewObservationMs = state.lastNewObservationAtMs === null
        ? 0
        : Math.max(0, input.nowMs - state.lastNewObservationAtMs);
    const stalled = !isNewObservation && sinceNewObservationMs > stallMs;

    // 暂停或停滞：冻结位置，但收下新锚点，使恢复时从当前位置继续。
    if (!playing || stalled) {
        if (!isNewObservation || observed === null) {
            return { ...state, playing, lastTickAtMs: input.nowMs };
        }
        return {
            ...state,
            anchorPositionMs: observed,
            anchorAtMs: observedAtMs,
            lastTickAtMs: input.nowMs,
            lastNewObservationAtMs: input.nowMs,
            pendingCorrectionMs: 0,
            playing,
            lastObservedKey: observedKey,
        };
    }

    // 前馈：按本帧真实经过的时间推进。这是「进度条连续移动」的来源。
    let positionMs = state.positionMs + tickDeltaMs;

    if (isNewObservation && observed !== null) {
        // 观测值换算到「此刻」的真实播放时间：确立时刻到现在的这段时间要补上。
        const observedNowMs = observed + Math.max(0, input.nowMs - observedAtMs);

        if (Math.abs(observedNowMs - positionMs) > APPLE_MUSIC_CLOCK_JUMP_MS) {
            // 跳变：正常播放解释不了这么大的差。Apple Music 的 seek 不生效，所以这只能是切歌
            // （或暂停恢复时用户在别处拖了进度），直接采纳。
            //
            // 阈值刻意**不**复用 stallMs：曾经两者都用 2500ms，结果一次恰好 2000ms 的切歌跳变
            // 被当成普通锚点、被有上限的修正慢慢拖过去 —— 表现是「切歌后进度条爬十几秒才到位」。
            return {
                positionMs: observedNowMs,
                anchorPositionMs: observed,
                anchorAtMs: observedAtMs,
                lastTickAtMs: input.nowMs,
                lastNewObservationAtMs: input.nowMs,
                rate: 1,
                pendingCorrectionMs: 0,
                playing,
                lastObservedKey: observedKey,
            };
        }

        // 相位误差按增益分批吃掉。上限是「本帧真实经过时间的 maxCorrectionFactor 倍」，
        // 因此一个整秒台阶会在它所属的那一秒区间里被消化，而不是跨好几个锚点周期慢慢追。
        const errorMs = observedNowMs - positionMs;
        const maxCorrectionMs = tickDeltaMs * maxCorrectionFactor;
        const correctionMs = clamp(errorMs * gain, -maxCorrectionMs, maxCorrectionMs);
        positionMs += correctionMs;

        // 位置不允许倒退：倒退会让歌词读头来回跳。
        if (positionMs < state.positionMs) {
            positionMs = state.positionMs;
        }

        return {
            positionMs,
            anchorPositionMs: observed,
            anchorAtMs: observedAtMs,
            lastTickAtMs: input.nowMs,
            lastNewObservationAtMs: input.nowMs,
            rate: 1,
            pendingCorrectionMs: errorMs - correctionMs,
            playing,
            lastObservedKey: observedKey,
        };
    }

    // 没有新观测值（helper 两次轮询之间位置没变）：只推进，不校正。
    // 这正是周期内斜坡消失的地方 —— 位置随墙钟连续前进，而不是停在锚点上等下一次刷新。
    //
    // 斜率恒为 1 是实测结论：整段平均速率就是 1.0015x（120s 位置 / 119.82s 墙钟，残差在 120 秒里
    // 只漂移 179ms）。用单次相位误差反推速率会 windup —— 误差主要来自整秒量化而非速率差。
    return { ...state, positionMs, lastTickAtMs: input.nowMs, playing };
};

/**
 * 估计值换算成秒，供全局时钟使用。与 `resolveExternalMediaClockSec` 的秒契约一致。
 */
export const externalMediaClockPositionSec = (state: ExternalMediaClockState): number => (
    Math.max(0, state.positionMs) / 1000
);
