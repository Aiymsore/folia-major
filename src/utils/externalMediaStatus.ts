import type { ExternalMediaAvailability, PlaybackBackend } from '../types/playbackBackend';

// src/utils/externalMediaStatus.ts
// 外部媒体快照的纯判据层：不依赖 React、不依赖 store，因此可以被 effective model、UI 与单测直接使用，
// 而不会把 zustand 拖进纯逻辑的依赖图。
//
// 这里最重要的区分是「有没有媒体」和「媒体现在是什么状态」：
//
//   session   目标媒体源可见（Chrome 里有 music.apple.com 的 tab）  → connected
//   media     该 session 报告了有效的 media properties（title）     → hasExternalMedia
//   state     Playing / Paused / Stopped / Closed / ...             → playbackStatus
//
// 把 media 与 state 混在一起（要求 status ∈ {Playing, Paused}）会在 Stopped / Opened 这类
// 仍然有完整曲目信息的状态下丢掉歌曲、禁用 Play —— 而"按播放"恰恰是用户从这些状态恢复播放的方式。
// 只有**真的没有曲目信息**才判为无内容。

/** 明确表示"没有装载媒体"的状态。语义只影响 state，不影响是否算有曲目。 */
const NO_MEDIA_STATUSES = new Set(['Closed']);

/**
 * 有效媒体判据：有 session，且报告了非空的 title。
 *
 * title 是唯一能证明"装载了某首曲目"的字段（SMTC 的 `TryGetMediaPropertiesAsync`，扩展上报的
 * `nowPlayingItem.name`）。播放状态刻意不参与判断：`Stopped` 的曲目依然可以被播放，把它当成
 * "无内容"会直接砍掉恢复播放的入口。
 */
export const hasExternalMedia = (status: ElectronExternalMediaStatus | null): boolean => (
    Boolean(status?.connected) && Boolean((status?.title ?? '').trim())
);

/**
 * 媒体是否处于"已装载但未播放"的静止状态。仅用于把 state 映射为 IDLE 时的辅助判断，
 * 不参与 hasMedia。
 */
export const isExternalMediaStopped = (status: ElectronExternalMediaStatus | null): boolean => (
    NO_MEDIA_STATUSES.has(status?.playbackStatus ?? '')
);

/**
 * 六态显示值。
 *
 * 这些状态是**依次递进的前置条件**，每一态对应一个不同的用户动作，所以必须分开表达 ——
 * 合成一个布尔只能告诉用户"不可用"，而用户需要知道的是"该去装扩展 / 开网页 / 刷新页面 /
 * 登录 / 换区"。
 *
 * 判定顺序是承重的：`unavailable`（桥本身起不来）优先于一切，因为后面各态都以桥可达为前提；
 * 扩展未连接时也无法得知 tab 与登录状态，所以 `extension-missing` 必须排在它们之前。
 *
 * `pageReady` 是**扩展侧的判据**（观察帧里的 `connected`：那一页的播放器能不能被驱动），
 * 与 SMTC 的 `connected`（Windows 有没有看到 Chrome 的媒体会话）是两件事：
 *
 *   * `pageReady === false` → 有 tab，但播放器读不到 → `player-not-ready`（动作：刷新那个页面）
 *   * `pageReady == null`   → 扩展还没报告过，退回 SMTC 的判据 → 没有会话即 `tab-not-found`
 *
 * 旧实现把两者合并成 `tab-not-found`，于是"有 tab 但读不到播放器"会让用户去打开一个已经开着的
 * 标签页 —— 这正是 2026-09-23 那次误诊的形态。`null` 与 `false` 必须分开：前者是"不知道"，
 * 不能当成"没满足"。
 */
export const resolveExternalMediaAvailability = (
    status: ElectronExternalMediaStatus | null,
): ExternalMediaAvailability => {
    // 功能开关（"设置 → 外部媒体"）默认关闭：两个桥根本不运行，这是比 bridge 不可达更根本的
    // 前置条件，必须排在一切之前。缺省（旧形状、测试夹具）视为开启。
    if (status?.enabled === false) return 'unavailable';
    if (!status?.bridgeAvailable) return 'unavailable';
    // 扩展没连上时，下面几个字段都无从得知 —— 不能把"不知道"当成"没满足"来报错。
    if (!status.extensionConnected) return 'extension-missing';
    if (status.pageReady === false) return 'player-not-ready';
    // 扩展报告过"这一页可驱动"就直接相信它：SMTC 看不到会话在那种情况下是**正常**的
    // （页面暂停、刚加载完还没播、或者 Chrome 没把会话注册到 SMTC），不该反过来否定扩展。
    if (status.pageReady !== true && !status.connected) return 'tab-not-found';
    if (status.signedIn === false) return 'not-signed-in';
    if (status.storefrontMatches === false) return 'storefront-mismatch';
    return 'ready';
};

/**
 * 外部媒体后端下全局播放时钟应当采用的秒值，`null` 表示"这一帧没有位置可写"。
 *
 * 为什么需要这个判据：四个 Folia / Stage 时钟来源在 external-media 后端下**一个都不命中**，所以这条
 * 支路必须自己决定"能不能写"。三条规则：
 *
 *   1. 只有 `backend === 'external-media'` 才给出值 —— 其余后端必须继续由原有分支写时钟，
 *      否则一个迟到的外部快照会把 Folia 的位置覆盖掉。
 *   2. `positionMs` 缺失或非有限值（`null`、`NaN`、`Infinity`）返回 null —— 写 0 会把进度条按回
 *      开头，而"未知"和"零点"是不同的事实。
 *   3. 负值钳到 0，其余按 `/1000` 转秒，与 motion signal `currentTime` 及 `ProgressBar` 的秒契约一致。
 *
 * 纯函数、无 store / 无 React，因此这条支路的行为可以被单测逐条锁定。
 */
export const resolveExternalMediaClockSec = (
    backend: PlaybackBackend,
    positionMs: number | null | undefined,
): number | null => {
    if (backend !== 'external-media') return null;
    if (typeof positionMs !== 'number' || !Number.isFinite(positionMs)) return null;
    return Math.max(0, positionMs / 1000);
};
