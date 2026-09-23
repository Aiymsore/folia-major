import type { SongResult } from '../types';
import { getPlaybackSongKey } from './appPlaybackGuards';
import {
    getQueueSongIdentity,
    isSameObservedTrack,
    reconcileExternalMediaQueue,
    type ObservedTrackIdentity,
} from './externalMediaQueueReconcile';

// src/utils/externalMediaQueueAdvance.ts
// 「对账结论」到「下一步动作」的**纯决策层**：外部播放器报回的每一帧观察，
// 在这里被翻译成推进 / 同步索引 / 放弃权威 / 什么都不做。不依赖 React、不依赖 store、
// 不读时钟 —— 因此分段权威的每一条边界都能被穷举单测。
//
// ── 为什么"曲目结束"需要两个判据 ────────────────────────────────────────────────
//
// Folia 原生的切歌信号是 `<audio>` 的 `onEnded`（精确事件）。外部播放器没有 Folia 的音频
// 元素，替代信号只有两个，都比它粗糙：
//
//   1. **结尾邻域**：观察到 `durationMs - positionMs <= END_PROXIMITY_MS` 且仍在 Playing。
//      SMTC 的位置是整秒量化 + 约 1Hz 发布，最后一帧很可能停在 duration 前不到一秒处，
//      所以判据是"邻域"而不是"到达时长"。
//   2. **曲末抢占（E5-A，已确认接受）**：网页播放器会在曲末自动播它**自己**的下一首。
//      若身份变化前的最后一帧停在结尾邻域，就把这次身份变化判为"自然结束、播放器自己走了"，
//      由 Folia 下发 `playById` 抢回控制权 —— 而不是误判成用户接管。
//      代价是"用户恰好在最后 1.5 秒里手动跳过"会被当成自然结束，E5-A 已接受这个抢占。
//
// ── 派发时间窗（分段权威的"分段"边界）─────────────────────────────────────────
//
// Folia 每下发一首（用户点歌、自动推进、循环重播），观察层要过一会儿才反映新曲目：
// SMTC 的发布是约 1Hz 的，页面切换也需要时间。这段时间里的观察还停在**旧**曲目上 ——
// 它在 queue 里，于是对账会得出 `drifted`（把索引同步回旧曲目）或 `taken-over`，
// 两种都会撤销 Folia 刚刚做出的推进。因此下发之后的 DISPATCH_WINDOW_MS 内，
// 非 `in-sync` 的对账结论一律降级为 `hold`：**只有 Folia 自己下发的播放在窗口内算数**。
// 窗口外的手动操作才是"用户接管"（分段权威）。

/**
 * 结尾邻域的宽度（毫秒）。
 *
 * 1500ms 是对观察粒度的估计而非测量保证：SMTC 整秒量化意味着最后一帧位置最多落后真实位置
 * 约 2 秒。取窄了会漏掉自然结束（queue 停摆），取宽了会把"跳到歌曲最后两秒再手动切歌"
 * 误判成自然结束 —— 两者都错，但前者是功能中断，后者只是一次多余的推进，所以偏宽。
 */
export const EXTERNAL_MEDIA_END_PROXIMITY_MS = 1500;

/**
 * 派发时间窗（毫秒）：Folia 下发 `playById` 之后，多长时间内不接受"外部权威"的对账结论。
 *
 * 覆盖页面切换 + SMTC 发布延迟（约 1–2 秒）加一倍余量。窗口太短会在慢机上重新出现
 * "推进被撤销"，太长会让真正的用户接管晚几秒被发现 —— 后者只是提示迟到，前者是功能错误。
 */
export const EXTERNAL_MEDIA_DISPATCH_WINDOW_MS = 5000;

/** 一次观察的完整快照：身份 + 决策需要的三个播放事实。 */
export type ObservedPlaybackSnapshot = ObservedTrackIdentity & {
    positionMs: number | null;
    durationMs: number | null;
    playbackStatus: string | null;
};

/**
 * 观察快照（外部媒体 store 的 `ElectronExternalMediaStatus`）→ 决策输入。
 *
 * 没有有效媒体（无 session / 无标题）时返回 null —— 决策层的"不知道不等于同步"规则由此开始。
 * 非有限的 position/duration 归一成 null：`NaN` / `Infinity` 与"未知"是同一件事，
 * 而"未知"与"0"是不同的事实（与 `resolveExternalMediaClockSec` 同一条规则）。
 */
export const toObservedPlaybackSnapshot = (
    status: ElectronExternalMediaStatus | null | undefined,
): ObservedPlaybackSnapshot | null => {
    if (!status?.connected) return null;
    const title = (status.title ?? '').trim();
    if (!title) return null;
    const artist = (status.artist ?? '').trim();
    const finiteOrNull = (value: number | null | undefined): number | null => (
        typeof value === 'number' && Number.isFinite(value) ? value : null
    );
    return {
        title,
        artist: artist || null,
        positionMs: finiteOrNull(status.positionMs),
        durationMs: finiteOrNull(status.durationMs),
        playbackStatus: status.playbackStatus ?? null,
    };
};

/**
 * 一次决策的结果。
 *
 * * `hold`       —— 什么都不做（没有观察 / 没有当前曲目 / 派发窗口内等待切换）。
 * * `in-sync`   —— 正常播放中，权威在 Folia。
 * * `advance`   —— 曲目自然结束：`next` 交给 Folia 的 queue 推进（内部解析成 playById），
 *                  `repeat` 由本层重新下发当前曲目（loop 'one'，绝不透传给网页播放器）。
 * * `sync-index` —— 用户在网页里跳到了 queue 内的另一首：把 queue 索引同步到事实（不抢回）。
 * * `take-over` —— 播放器放了 queue 之外的东西：Folia 退出 queue 推进（分段权威）。
 */
export type ExternalMediaAdvanceDecision =
    | { kind: 'hold'; reason: 'no-observation' | 'no-current-track' | 'dispatch-pending' }
    | { kind: 'in-sync' }
    | { kind: 'advance'; mode: 'next' | 'repeat' }
    | { kind: 'sync-index'; queueIndex: number }
    | { kind: 'take-over'; reason: 'not-in-queue' };

/** 该快照是否停在曲目结尾邻域（见 `EXTERNAL_MEDIA_END_PROXIMITY_MS`）。 */
export const isNearTrackEnd = (snapshot: ObservedPlaybackSnapshot): boolean => {
    if (typeof snapshot.durationMs !== 'number' || snapshot.durationMs <= 0) return false;
    if (typeof snapshot.positionMs !== 'number' || !Number.isFinite(snapshot.positionMs)) return false;
    return snapshot.durationMs - snapshot.positionMs <= EXTERNAL_MEDIA_END_PROXIMITY_MS;
};

/**
 * 这一帧是否表示"这首自然放完了"。
 *
 * 两个状态都算，因为播放器在结束时落点不同：
 *
 *   * `Playing` —— 在结尾邻域内被观察到（还没走到最后一步，或位置发布落后于真实播放）。
 *   * `Stopped` —— 已经走到末尾并停在那里。**这是最常见的形态，而不是边角情况**：MusicKit 把
 *     `ended`(5) 与 `completed`(9) 都归一成 `Stopped`（见 content.js 的 PLAYBACK_STATE_NAMES），
 *     而 `playById` 用 `setQueue({ song })` 只给网页播放器设了**一首**的队列 —— 放完就没有下一首，
 *     于是它就停在末尾报 `Stopped`。
 *
 * 只要求 `Playing` 曾让**每一首正常放完的歌都不推进 queue**：观察层看到的最后一帧是 `Stopped`，
 * 判据不成立 → `in-sync` → 队列停摆。这是"不按歌单自动播放下一首"的直接原因。
 *
 * `Paused` 刻意不算：在结尾邻域暂停是**用户动作**，不是结束。用户按了暂停却被自动切歌，
 * 比漏掉一次推进更糟。
 */
export const isNaturalTrackEnd = (snapshot: ObservedPlaybackSnapshot): boolean => {
    if (!isNearTrackEnd(snapshot)) return false;
    return snapshot.playbackStatus === 'Playing' || snapshot.playbackStatus === 'Stopped';
};

/**
 * Folia 的 queue 里还有没有"下一首可播"。判据逐条镜像 `handleNextTrack` 的 nextIndex 规则
 * （含 `currentIndex < 0 → 0` 与 loop 'all' 回绕），**必须**与它保持一致 —— 这个函数只用来决定
 * "queue 到头时要不要把外部播放器也停下来"，判错就会出现"该停没停"或"没到头就停"。
 */
export const hasQueuedSuccessor = (
    queue: SongResult[],
    currentSong: SongResult | null,
    loopMode: 'off' | 'all' | 'one',
): boolean => {
    if (queue.length === 0) return false;
    const currentIndex = currentSong
        ? queue.findIndex(song => getPlaybackSongKey(song) === getPlaybackSongKey(currentSong))
        : -1;
    if (currentIndex >= 0 && currentIndex < queue.length - 1) return true;
    if (currentIndex < 0) return true;
    return loopMode === 'all';
};

/**
 * 纯决策：一帧观察 → 一个动作。
 *
 * 参数刻意都是纯值（queue 数组 + 两次观察快照），不含 store 引用与时间读数 ——
 * 时间只以 `inDispatchWindow` 布尔进来，因此竞态窗口可以被确定性地断言。
 */
export const decideExternalMediaAdvance = (input: {
    queue: SongResult[];
    currentSong: SongResult | null;
    observed: ObservedPlaybackSnapshot | null;
    previousObserved: ObservedPlaybackSnapshot | null;
    loopMode: 'off' | 'all' | 'one';
    /** Folia 刚下发过播放（用户点歌 / 自动推进 / 循环重播），切换尚未反映到观察层。 */
    inDispatchWindow: boolean;
}): ExternalMediaAdvanceDecision => {
    const { queue, currentSong, observed, previousObserved, loopMode, inDispatchWindow } = input;
    if (!currentSong) return { kind: 'hold', reason: 'no-current-track' };
    // 不知道不等于同步：没有观察就没有切歌信号，推进只能靠猜 —— 一律 hold（对账层同一条规则）。
    if (!observed) return { kind: 'hold', reason: 'no-observation' };

    const mode: 'next' | 'repeat' = loopMode === 'one' ? 'repeat' : 'next';

    const verdict = reconcileExternalMediaQueue({ queue, currentSong, observed });

    if (verdict.kind === 'in-sync') {
        // 判据 1：结尾邻域 + 仍在 Playing 或已 Stopped → 自然结束（见 isNaturalTrackEnd）。
        // Playing 与 Stopped 都要收：网页播放器的队列只有一首，放完就停在末尾报 Stopped。
        // Paused 不收 —— 那是用户暂停。
        if (isNaturalTrackEnd(observed)) {
            return { kind: 'advance', mode };
        }
        return { kind: 'in-sync' };
    }

    // 观察到的曲目与当前项不一致。派发窗口内这通常只是"页面还没切过去"：
    // 非 in-sync 的结论（drifted 会把索引同步回旧曲目、take-over 会放弃权威）都会撤销
    // Folia 刚做出的推进，所以窗口内一律 hold。
    if (inDispatchWindow) {
        return { kind: 'hold', reason: 'dispatch-pending' };
    }

    // 判据 2：曲末抢占。身份真的变了（对比上一帧，而不是对比 currentSong —— 元数据噪声
    // 造成的假差异不算），且上一帧停在结尾邻域并仍在播 → 这次变化是"播放器自己走了"。
    const identityChanged = previousObserved !== null && !isSameObservedTrack(previousObserved, observed);
    if (
        identityChanged &&
        isNaturalTrackEnd(previousObserved)
    ) {
        return { kind: 'advance', mode };
    }

    // 分段权威：窗口外的手动操作不被"纠正"回去。
    //   queue 内 → 同步索引到事实（用户挑了队列里的另一首，Folia 跟随）；
    //   queue 外 → 用户接管，Folia 退出 queue 推进。
    if (verdict.kind === 'drifted') {
        return { kind: 'sync-index', queueIndex: verdict.queueIndex };
    }
    return { kind: 'take-over', reason: 'not-in-queue' };
};
