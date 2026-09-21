import { PlayerState, type LyricData, type SongResult } from '../types';
import type { PlaybackBackend } from '../types/playbackBackend';
import { getPlaybackSongKey } from './appPlaybackGuards';

// src/utils/effectivePlayback.ts
// 「有效播放状态」的**纯函数**推导层：把「当前 backend 的原始事实」映射成播放器 UI / 发布面
// 需要的那一组字段。这里不 import 任何 store、不读 React、不碰 audio 元素 —— 因此规则的每一条
// 都能在单测里逐项锁定。
//
// 存在意义：正式播放器（悬浮控件、主面板、taskbar、remote、mediaSession）都只认一组字段
// （song / playerState / position / duration / hasTrack / canPrev / canNext / controlsDisabled）。
// backend = folia 时这组字段就是 Folia 的 display selector 输出；backend = apple-music 时它们
// 来自 SMTC 快照。把分支集中在这一层，UI 组件与 driver 都不需要知道自己面对的是谁。

/** Apple Music 模式下「有可播放内容」的最小输入。字段名与 SMTC 快照保持一致，便于直接透传。 */
export type AppleMusicEffectiveInput = {
    /** bridge 健康（helper 二进制存在且已启动）。 */
    bridgeAvailable: boolean;
    /** SMTC 中 Apple Music session 可见。 */
    connected: boolean;
    /**
     * 有效媒体判据已通过：session 可见**且**报告了曲目信息。
     *
     * 刻意与 playbackStatus 解耦。过去要求 status ∈ {Playing, Paused}，于是 `Stopped` 下隐藏曲目并
     * 禁用 Play —— 而按播放正是用户从该状态恢复的方式。现在状态只影响 playerState。
     */
    hasMedia: boolean;
    title: string | null;
    artist: string | null;
    album: string | null;
    /** 原始 Windows 枚举名：Playing / Paused / Closed / Stopped / ... 或 Unknown(n)。 */
    playbackStatus: string | null;
    positionMs: number | null;
    durationMs: number | null;
};

export type EffectivePlaybackModel = {
    backend: PlaybackBackend;
    /**
     * 有可播放内容。apple-music 分支**不等于** connected：session 存在但媒体已 Closed/Stopped
     * 时这里为 false，于是 transport 一起禁用，而不是对着一个空 session 发命令。
     */
    hasTrack: boolean;
    /** 无内容时必须是 null —— 不允许继续暴露上一首的 title/artist。 */
    song: SongResult | null;
    /** 本轮 apple-music 分支不提供歌词（不进入歌词阶段），因此这里只会是 null。 */
    lyrics: LyricData | null;
    playerState: PlayerState;
    positionSec: number;
    durationSec: number;
    coverUrl: string | null;
    /**
     * folia 后端下由调用方提供（见 `buildFoliaEffectiveModel`）。effective 层刻意**不重算**这三个值：
     * 它们依赖队列邻居与 Stage gate，重算就是第二套规则。`null` 表示"未提供，沿用现有逻辑" ——
     * 这正是零回归的来源。apple-music 分支总是给出确定的布尔值。
     */
    canGoPrevious: boolean | null;
    canGoNext: boolean | null;
    controlsDisabled: boolean | null;
    /** 让 UI 能说明「当前控制的是谁」，也为将来切换文案留出单一来源。 */
    availability: 'connected' | 'not-running' | 'unavailable';
};

/**
 * Windows 播放状态名 → Folia 的 PlayerState。
 *
 * `Closed` / `Stopped` / `Opened` / `Changing` / `Unknown(n)` 全部映射到 IDLE：它们表示媒体**当前**
 * 不在播放也不在暂停。这里只决定 state，不决定"有没有曲目" —— `Stopped` 的曲目依然是有效曲目，
 * 用户按播放就能恢复，因此 hasMedia 不受此函数影响。
 *
 * 刻意不把 `Changing` 当成 PLAYING —— 切歌瞬间报 PLAYING 会让 UI 提前显示"正在播放"，而 SMTC 的
 * Changing 并不保证下一秒会进入 Playing。
 */
export const mapAppleMusicPlayerState = (playbackStatus: string | null): PlayerState => {
    if (playbackStatus === 'Playing') return PlayerState.PLAYING;
    if (playbackStatus === 'Paused') return PlayerState.PAUSED;
    return PlayerState.IDLE;
};

/**
 * 把 SMTC 快照造成一个只读的伪 SongResult，供现有 UI helper（艺术家/专辑标签、封面解析、
 * 队列邻居计算）复用。
 *
 * 四条硬规则：
 *   1. **没有有效媒体时才返回 null**。判据是 `hasMedia`（session + 非空 title），与 playbackStatus
 *      无关：`Stopped` 的曲目仍然是有效曲目，播放按钮要能把它恢复起来。
 *   2. title 为空/纯空白时返回 null —— 那不是"某首歌"，是"没有曲目信息"。
 *   3. 不生成 `sourceRef` 与 `playbackSourceRevision`：它不是 Folia 的在线歌曲，没有任何
 *      provider 拥有它，也就不能被喜欢/加队列/上报播放。
 *   4. id 用稳定的负数区间，与 `getLocalSongId` 的负值域相邻但不冲突（Apple Music 是本地进程
 *      播放，语义上同样"不属于任何在线库"）；身份由 AUMID + title/artist 派生，使切歌时
 *      `getPlaybackSongKey` 能正确判定身份变化。
 */
export const buildAppleMusicPseudoSong = (
    input: AppleMusicEffectiveInput,
    sourceAppUserModelId: string | null,
): SongResult | null => {
    const title = (input.title ?? '').trim();
    if (!input.hasMedia || !title) return null;

    const identity = `${sourceAppUserModelId ?? 'apple-music'}|${title}|${input.artist ?? ''}`;
    // DJB2 变体，与 playbackAdapters.getLocalSongId 同族的 53 位安全整数，取负值。
    let hash = 0x811c9dc5;
    for (let index = 0; index < identity.length; index += 1) {
        hash ^= identity.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    const id = -((hash >>> 0) % 0x1fffffffffffff) - 1;

    return {
        id,
        name: title,
        artists: input.artist ? [{ id: 0, name: input.artist }] : [],
        album: { id: 0, name: input.album ?? '' },
        durationMs: input.durationMs ?? 0,
    };
};

/** Apple Music 的有效状态。`playerStatePositionSec` 由调用方读位置来源（motion signal 或 SMTC）。 */
export const buildAppleMusicEffectiveModel = (
    input: AppleMusicEffectiveInput,
    availability: EffectivePlaybackModel['availability'],
    sourceAppUserModelId: string | null,
): EffectivePlaybackModel => {
    const song = buildAppleMusicPseudoSong(input, sourceAppUserModelId);
    const hasTrack = song !== null;
    const canControl = availability === 'connected' && hasTrack;

    return {
        backend: 'apple-music',
        hasTrack,
        song,
        lyrics: null,
        // 没有有效曲目时强制 IDLE；有曲目但状态是 Stopped/Closed 时同样映射 IDLE —— 但曲目本身
        // 保留，于是 Play 仍然可用，用户能把它恢复起来。
        playerState: hasTrack ? mapAppleMusicPlayerState(input.playbackStatus) : PlayerState.IDLE,
        positionSec: hasTrack && Number.isFinite(input.positionMs) ? Math.max(0, (input.positionMs ?? 0) / 1000) : 0,
        durationSec: hasTrack && Number.isFinite(input.durationMs) ? Math.max(0, (input.durationMs ?? 0) / 1000) : 0,
        // 本轮不取 SMTC thumbnail bytes（只有 hasThumbnail 布尔），因此封面必须为空；
        // 绝不能回落到 Folia 的 cachedCoverUrl，否则会显示上一首 Folia 曲目的封面。
        coverUrl: null,
        canGoPrevious: canControl,
        canGoNext: canControl,
        controlsDisabled: !canControl,
        availability,
    };
};

/**
 * Folia 的 display selector 输出原样透传。这个函数存在的唯一目的是让「folia 分支不做任何合成」
 * 成为可断言的事实，而不是散落在各处的三元表达式。
 */
export const buildFoliaEffectiveModel = (folia: {
    hasTrack: boolean;
    song: SongResult | null;
    playerState: PlayerState;
    positionSec: number;
    durationSec: number;
    coverUrl: string | null;
    canGoPrevious: boolean;
    canGoNext: boolean;
    controlsDisabled: boolean;
}): EffectivePlaybackModel => ({
    backend: 'folia',
    hasTrack: folia.hasTrack,
    song: folia.song,
    lyrics: null,
    playerState: folia.playerState,
    positionSec: folia.positionSec,
    durationSec: folia.durationSec,
    coverUrl: folia.coverUrl,
    canGoPrevious: folia.canGoPrevious,
    canGoNext: folia.canGoNext,
    controlsDisabled: folia.controlsDisabled,
    availability: 'connected',
});

/** 供 taskbar / remote 使用的稳定身份键；无曲目时为 null。 */
export const resolveEffectiveTrackKey = (model: EffectivePlaybackModel): string | null => (
    model.song ? getPlaybackSongKey(model.song) : null
);
