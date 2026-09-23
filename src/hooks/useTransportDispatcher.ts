import type { PlaybackBackend } from '../types/playbackBackend';
import type { SongResult } from '../types';
import { getActivePlaybackBackend, setActivePlaybackBackend } from '../stores/useActivePlaybackBackendStore';
import { getExternalMediaStatus, hasExternalMedia, isExternalMediaTransportReady } from '../stores/useExternalMediaStore';
import { getQueueSongIdentity, isSameObservedTrack, resolveExternalMediaPlayableId } from '../utils/externalMediaQueueReconcile';
import { toObservedPlaybackSnapshot } from '../utils/externalMediaQueueAdvance';

// src/hooks/useTransportDispatcher.ts
// 唯一的 transport 命令分发点：backend 决定命令发给谁。
//
// 为什么是 `handleExternalMediaAction() -> boolean` 而不是一个 dispatch(action) 中枢：
// 原始 handler（resumePlayback / pausePlayback / togglePlay / seekMainAudio）各自持有大量
// 上下文（混音交接、stage 分支、恢复源、音频上下文），把它们抽进 dispatcher 等于重写它们。
// 反过来让 dispatcher **在 handler 内部先试一次**，就不会出现递归，也不会丢失上下文：
//
//     const pausePlayback = useCallback(() => {
//         if (handleExternalMediaAction('pause')) return;   // 外部媒体已处理（成功或已拒绝）
//         ...原函数体，逐字节不变...
//     })
//
// 返回值语义是「本次调用是否已由外部媒体后端承接」：
//   * backend 不是 external-media          → false，调用方继续跑原函数体
//   * backend 是 external-media 且通道就绪  → true，命令已下发（无 await，副作用在后台）
//   * backend 是 external-media 但通道没就绪 → true，命令**有意不下发**，同时原函数体也不执行。
//     这是硬约束的延伸：backend=external-media 时 Folia 的 deck 绝不能被一个"看起来没反应"的
//     按钮顺手启动。UI 此时是 disabled 的，走到这里说明是竞态，静默吞掉比误控更安全。
//
// ── 本次重构最重要的一条规则：next / previous 不在这里 ──────────────────────────────
//
// `TransportAction` 只保留 play / pause / toggle。**next 与 previous 被刻意移出本 dispatcher。**
//
// 理由：Folia 自己拥有 queue。如果把它们透传给网页播放器，Apple Music 会播它**自己**的内部
// 队列，于是两个 queue 争夺控制权，表现是"按下一首跳到了我没选的歌"。正确做法是 Folia 把
// "下一首"解析成 `playById(<queue 里的下一首>)`，这发生在 queue 层
// （`useBackendAwareTrackNavigation` / `usePlaybackQueueController`），而不是命令转发层。
//
// 因此这里没有 'next' / 'previous' 的映射，调用点也不再需要 `handleExternalMediaAction('next')`：
// 它们直接走 Folia 的 `handleNextTrack`，由后者在装载曲目时分派到 playById。

/** 可以由外部媒体后端**直接**承接的动作。next/previous 刻意不在其中（见文件头）。 */
export type TransportAction = 'play' | 'pause' | 'toggle';

const COMMAND_BY_ACTION: Record<TransportAction, 'play' | 'pause' | 'toggle'> = {
    play: 'play',
    pause: 'pause',
    // `toggle` 走外部播放器自己的 toggle，不靠本地状态猜 —— 本地状态可能落后一个推送周期。
    toggle: 'toggle',
};

export const getTransportBackend = (): PlaybackBackend => getActivePlaybackBackend();

/** 外部媒体后端是否已经承接本次调用（见文件头部的返回值语义）。 */
export const handleExternalMediaAction = (action: TransportAction): boolean => {
    if (getActivePlaybackBackend() !== 'external-media') return false;

    // Gate on media existing, not on the playback state: `Stopped`/`Opened` still has a track, and
    // 'play' is precisely how the user resumes from there. With no track at all there is nothing to
    // address, so the call is taken and dropped rather than sent into a guaranteed decline.
    if (!hasExternalMedia(getExternalMediaStatus())) return true;

    const bridge = typeof window !== 'undefined' ? window.electron : undefined;
    if (typeof bridge?.externalMediaSendCommand !== 'function') return true;

    // 不 await：命令结果由 useExternalMediaStore 的后续推送体现，UI 不应等待一次 IPC 往返。
    // sendCommand 保证永不 reject，失败也以结构化结果返回。
    void bridge
        .externalMediaSendCommand({ command: COMMAND_BY_ACTION[action] })
        .catch(() => { /* 结构化失败已在 bridge 内成型；此处不再打扰 UI */ });

    return true;
};

/**
 * 按曲目 id 让外部播放器播放指定曲目。
 *
 * 这是网页版相对桌面版的**唯一能力增量**，也是整个重构存在的理由：SMTC 无法按 id 指定曲目，
 * 而网页版可以（页面内的 MusicKit `setQueue({song})`）。
 *
 * 与 `handleExternalMediaAction` 的两点不同：
 *   1. 它**需要扩展通道**，不只是 SMTC 观察 —— 因此 gate 在 `isExternalMediaTransportReady()`
 *      而不是 `hasExternalMedia()`。观察层健康不代表能下发命令。
 *   2. 它返回 `Promise<boolean>` 而不是同步布尔：调用方（queue 层）需要知道这一首**是否真的
 *      被下发了**，才能决定要不要把 Folia 的 queue 索引推进到它。同步返回会让"下发失败但索引
 *      已推进"变成必然发生的错位。
 *
 * 返回 false 的语义是「本次调用不由外部媒体承接」或「承接了但下发失败」；调用方据此决定
 * 回退策略（提示用户、或按分段权威策略放弃接管）。
 */
export const playExternalMediaTrack = async (mediaId: string): Promise<boolean> => {
    if (getActivePlaybackBackend() !== 'external-media') return false;
    if (!mediaId) return false;
    if (!isExternalMediaTransportReady()) return false;

    const bridge = typeof window !== 'undefined' ? window.electron : undefined;
    if (typeof bridge?.externalMediaSendCommand !== 'function') return false;

    try {
        const result = await bridge.externalMediaSendCommand({ command: 'playById', mediaId });
        return result?.ok === true;
    } catch {
        // sendCommand 契约上永不 reject；这里兜住 IPC 层本身的异常（preload 缺失、通道被拆）。
        return false;
    }
};

/**
 * 「按播放」时把一首**外部媒体曲目**交回外部播放器，并顺带认领后端。
 *
 * 存在的理由：这类曲目在 Folia 里没有音频源（`audioSrc` 恒为 null，见 `onPlayExternalMediaSong`），
 * 所以 deck 那条路对它必然是 AbortError。而它又可能在后端是 `folia` 的时候成为当前曲目 —— 会话恢复
 * 起来就是（后端 store 每次启动都从 'folia' 开始），用户切到原生平台后再按播放也是。这两种情况下
 * 按播放的诚实含义是"接着放这一首"，而这一首只有外部播放器放得出来。
 *
 * 认领是必须的且是幂等的：`playExternalMediaTrack` 的第一道闸就是后端必须是 external-media。
 *
 * 命令的选择复用观察层判据：网页播放器**已经**载着这一首时发 `play`（从当前位置/暂停处继续），
 * 否则发 `playById(catalogId)`。不这样区分的话，每次按播放都会把当前曲目从头重放 —— 而按播放
 * 的语义恰恰是"继续"。
 *
 * 返回 false 表示这一首没有目录条目（无法寻址），调用方据此给出诚实的失败提示。
 */
export const resumeExternalMediaSong = async (song: SongResult): Promise<boolean> => {
    const mediaId = resolveExternalMediaPlayableId(song);
    if (!mediaId) return false;

    claimExternalMediaBackend();
    if (!isExternalMediaTransportReady()) return false;

    const observed = toObservedPlaybackSnapshot(getExternalMediaStatus());
    const identity = getQueueSongIdentity(song);
    if (observed && identity && isSameObservedTrack(observed, identity)) {
        handleExternalMediaAction('play');
        return true;
    }

    return playExternalMediaTrack(mediaId);
};

/**
 * Hands the transport back to Folia, best-effort silencing the external player first.
 *
 * Called when the user starts Folia playback from the formal source UI, and when the user is about to
 * enter Stage (Stage and the external media backend are mutually exclusive). The order is load-bearing:
 * the pause command must be read and sent while `external-media` is STILL the active backend, because
 * that is what makes the session valid to address. Only then does the backend change.
 *
 * Failure is never fatal and never blocks the switch: a rejected command, an unavailable bridge or a
 * missing session all leave the user's selection standing. `setActiveBackend` runs unconditionally.
 *
 * Returns whether a switch actually happened, so callers (and the Stage-entry path) can tell a real
 * hand-over from a no-op.
 */
export const claimFoliaBackend = (): boolean => {
    const backend = getActivePlaybackBackend();
    if (backend === 'folia') return false;

    const status = getExternalMediaStatus();
    if (status?.playbackStatus === 'Playing') {
        const bridge = typeof window !== 'undefined' ? window.electron : undefined;
        if (typeof bridge?.externalMediaSendCommand === 'function') {
            void bridge
                .externalMediaSendCommand({ command: 'pause' })
                .catch(() => { /* best-effort: a failed pause must not block the backend switch */ });
        }
    }

    setActivePlaybackBackend('folia');
    return true;
};

/**
 * Hands the transport to the external media backend.
 *
 * Deliberately does NOT start playback: switching backends changes the control target only, so the
 * external player keeps whatever Playing/Paused state it already had. The Folia pause is the caller's
 * job because only the caller knows whether Folia is audible (see usePlaybackBackendSwitch).
 */
export const claimExternalMediaBackend = (): boolean => {
    if (getActivePlaybackBackend() === 'external-media') return false;
    setActivePlaybackBackend('external-media');
    return true;
};

/**
 * 外部播放器的 seek。
 *
 * 三条与 Folia 路径刻意不同的规则：
 *   1. duration 用**观察到的** durationMs 夹紧，绝不读 `audioRef.current.duration`
 *      （那是 Folia 的元素，外部媒体模式下毫无意义，且上一位听众的时长会截断本次 seek）。
 *   2. 量化到整秒：这是 SMTC 观察层的粒度。**注意**：扩展通道本身支持亚秒级 seek，量化在这里
 *      是为了让"拖到哪"与"下一次观察报回哪"不会持续互相打架 —— 观察值按整秒回，若本地不量化
 *      就会出现 41.7s → 42s 的持续回跳。若将来观察层粒度提升，这个量化应当随之放宽。
 *   3. 不触发 Folia 的 play()：`seekMainAudio` 在 folia 分支里会顺带 resume，而外部播放器在暂停态
 *      只改位置、不恢复播放，两边语义不同。
 *
 * ⚠️ 历史限制（实测于 Windows 11 26200 + Apple Music **桌面版**，2026-09）：桌面版通过 SMTC 拒绝
 *     位置变更（`IsPlaybackPositionEnabled === False`），那个 seek 不会生效。
 *
 *     **网页版不受这条限制**：扩展走的是页面内 MusicKit 的 `seekToTime()`，不是 WinRT 的
 *     `TryChangePlaybackPositionAsync`。因此本函数在网页版下是真正生效的 —— 这是配对从桌面版
 *     切到网页版带来的第二个实际增益（第一个是 playById）。
 *     旧的实测记录保留在此，是因为它解释了为什么"桌面版后端"不能靠能力位探测来提供 seek。
 */
export const handleExternalMediaSeek = (positionSec: number): boolean => {
    if (getActivePlaybackBackend() !== 'external-media') return false;

    if (!hasExternalMedia(getExternalMediaStatus())) return true;

    const bridge = typeof window !== 'undefined' ? window.electron : undefined;
    if (typeof bridge?.externalMediaSendCommand !== 'function') return true;

    const durationMs = getExternalMediaStatus()?.durationMs ?? null;
    const requestedMs = Number.isFinite(positionSec) ? Math.max(0, positionSec * 1000) : 0;
    const clampedMs = typeof durationMs === 'number' && durationMs > 0
        ? Math.min(requestedMs, durationMs)
        : requestedMs;
    const quantizedMs = Math.round(clampedMs / 1000) * 1000;

    void bridge
        .externalMediaSendCommand({ command: 'seek', positionMs: quantizedMs })
        .catch(() => { /* 同上 */ });

    return true;
};
