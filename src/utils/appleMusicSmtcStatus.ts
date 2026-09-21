import type { AppleMusicAvailability, PlaybackBackend } from '../types/playbackBackend';

// src/utils/appleMusicSmtcStatus.ts
// SMTC 快照的纯判据层：不依赖 React、不依赖 store，因此可以被 effective model、UI 与单测直接使用，
// 而不会把 zustand 拖进纯逻辑的依赖图。
//
// 这里最重要的区分是「有没有媒体」和「媒体现在是什么状态」：
//
//   session   有 Apple Music 的 SMTC session 可见              → connected
//   media     该 session 报告了有效的 media properties（title）→ hasAppleMusicMedia
//   state     Playing / Paused / Stopped / Closed / ...        → playbackStatus
//
// 之前把 media 与 state 混在一起（要求 status ∈ {Playing, Paused}）会在 Stopped / Opened 这类
// 仍然有完整曲目信息的状态下丢掉歌曲、禁用 Play —— 而"按播放"恰恰是用户从这些状态恢复播放的方式。
// 现在只有**真的没有曲目信息**才判为无内容。

/** SMTC 里明确表示"没有装载媒体"的状态。语义只影响 state，不影响是否算有曲目。 */
const NO_MEDIA_STATUSES = new Set(['Closed']);

/**
 * 有效媒体判据：有 session，且报告了非空的 title。
 *
 * title 是 SMTC 唯一能证明"装载了某首曲目"的字段（`TryGetMediaPropertiesAsync` 的来源）。播放状态
 * 刻意不参与判断：`Stopped` 的曲目依然可以被播放，把它当成"无内容"会直接砍掉恢复播放的入口。
 */
export const hasAppleMusicMedia = (status: ElectronAppleMusicSmtcStatus | null): boolean => (
    Boolean(status?.connected) && Boolean((status?.title ?? '').trim())
);

/**
 * 媒体是否处于"已装载但未播放"的静止状态。仅用于把 state 映射为 IDLE 时的辅助判断，
 * 不参与 hasMedia。
 */
export const isAppleMusicMediaStopped = (status: ElectronAppleMusicSmtcStatus | null): boolean => (
    NO_MEDIA_STATUSES.has(status?.playbackStatus ?? '')
);

/**
 * 三态显示值。`unavailable` 与 `not-running` 是两件不同的事：前者是本机没有可用的 helper/bridge，
 * 后者是 bridge 健康但 Apple Music 当前没有可见 session。
 */
export const resolveAppleMusicAvailability = (
    status: ElectronAppleMusicSmtcStatus | null,
): AppleMusicAvailability => {
    if (!status?.bridgeAvailable) return 'unavailable';
    return status.connected ? 'connected' : 'not-running';
};

/**
 * Apple Music 后端下全局播放时钟应当采用的秒值,`null` 表示"这一帧没有 SMTC 位置可写"。
 *
 * 为什么需要这个判据:四个 Folia / Stage 时钟来源在 apple-music 后端下**一个都不命中**,所以这条
 * 支路必须自己决定"能不能写"。三条规则:
 *
 *   1. 只有 `backend === 'apple-music'` 才给出值 —— 其余后端必须继续由原有分支写时钟,
 *      否则一个迟到的 SMTC 快照会把 Folia 的位置覆盖掉。
 *   2. `positionMs` 缺失或非有限值(`null`、`NaN`、`Infinity`)返回 null —— 写 0 会把进度条按回
 *      开头,而"未知"和"零点"是不同的事实。
 *   3. 负值钳到 0,其余按 `/1000` 转秒,与 motion signal `currentTime` 及 `ProgressBar` 的秒契约一致。
 *
 * 纯函数、无 store / 无 React,因此这条支路的行为可以被单测逐条锁定。
 */
export const resolveAppleMusicClockSec = (
    backend: PlaybackBackend,
    positionMs: number | null | undefined,
): number | null => {
    if (backend !== 'apple-music') return null;
    if (typeof positionMs !== 'number' || !Number.isFinite(positionMs)) return null;
    return Math.max(0, positionMs / 1000);
};
