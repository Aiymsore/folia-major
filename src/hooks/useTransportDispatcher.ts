import type { PlaybackBackend } from '../types/playbackBackend';
import { getActivePlaybackBackend, setActivePlaybackBackend } from '../stores/useActivePlaybackBackendStore';
import { getAppleMusicStatus, hasAppleMusicMedia } from '../stores/useAppleMusicSmtcStore';

// src/hooks/useTransportDispatcher.ts
// 唯一的 transport 命令分发点：backend 决定命令发给谁。
//
// 为什么是 `handleAppleMusicAction() -> boolean` 而不是一个 dispatch(action) 中枢：
// 四个原始 handler（resumePlayback / pausePlayback / togglePlay / seekMainAudio）各自持有大量
// 上下文（混音交接、stage 分支、恢复源、音频上下文），把它们抽进 dispatcher 等于重写它们。
// 反过来让 dispatcher **在 handler 内部先试一次**，就不会出现递归，也不会丢失上下文：
//
//     const pausePlayback = useCallback(() => {
//         if (handleAppleMusicAction('pause')) return;   // apple-music 已处理（成功或已拒绝）
//         ...原函数体，逐字节不变...
//     })
//
// 返回值语义是「本次调用是否已由 Apple Music 后端承接」：
//   * backend 不是 apple-music            → false，调用方继续跑原函数体
//   * backend 是 apple-music 且 session 有效 → true，命令已下发（无 await，副作用在后台）
//   * backend 是 apple-music 但 session 无效 → true，命令**有意不下发**，同时原函数体也不执行。
//     这是硬约束 4 的延伸：backend=apple-music 时 Folia 的 deck 绝不能被一个"看起来没反应"的
//     按钮顺手启动。UI 此时是 disabled 的，走到这里说明是竞态，静默吞掉比误控更安全。

/** 一动作对应一个 Phase 2 命令名。`toggle` 走 SMTC 自己的 toggle，不靠本地状态猜。 */
export type TransportAction = 'play' | 'pause' | 'toggle' | 'previous' | 'next';

const COMMAND_BY_ACTION: Record<TransportAction, 'play' | 'pause' | 'toggle-play-pause' | 'previous' | 'next'> = {
    play: 'play',
    pause: 'pause',
    toggle: 'toggle-play-pause',
    previous: 'previous',
    next: 'next',
};

export const getTransportBackend = (): PlaybackBackend => getActivePlaybackBackend();

/** Apple Music 后端是否已经承接本次调用（见文件头部的返回值语义）。 */
export const handleAppleMusicAction = (action: TransportAction): boolean => {
    if (getActivePlaybackBackend() !== 'apple-music') return false;

    // Gate on media existing, not on the playback state: `Stopped`/`Opened` still has a track, and
    // 'play' is precisely how the user resumes from there. With no track at all there is nothing to
    // address, so the call is taken and dropped rather than sent into a guaranteed decline.
    if (!hasAppleMusicMedia(getAppleMusicStatus())) return true;

    const bridge = typeof window !== 'undefined' ? window.electron : undefined;
    if (typeof bridge?.appleMusicSendCommand !== 'function') return true;

    // 不 await：命令结果由 useAppleMusicSmtcStore 的后续推送体现，UI 不应等待一次 IPC 往返。
    // sendCommand 保证永不 reject（Phase 2），失败也以结构化结果返回。
    void bridge
        .appleMusicSendCommand({ command: COMMAND_BY_ACTION[action] })
        .catch(() => { /* 结构化失败已在 bridge 内成型；此处不再打扰 UI */ });

    return true;
};

/**
 * Hands the transport back to Folia, best-effort silencing Apple Music first.
 *
 * Called when the user starts Folia playback from the formal source UI, and when the user is about to
 * enter Stage (Stage and the Apple Music backend are mutually exclusive). The order is load-bearing:
 * the pause command must be read and sent while `apple-music` is STILL the active backend, because
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

    const status = getAppleMusicStatus();
    if (status?.playbackStatus === 'Playing') {
        const bridge = typeof window !== 'undefined' ? window.electron : undefined;
        if (typeof bridge?.appleMusicSendCommand === 'function') {
            void bridge
                .appleMusicSendCommand({ command: 'pause' })
                .catch(() => { /* best-effort: a failed pause must not block the backend switch */ });
        }
    }

    setActivePlaybackBackend('folia');
    return true;
};

/**
 * Hands the transport to the Apple Music backend.
 *
 * Deliberately does NOT start playback: switching backends changes the control target only, so Apple
 * Music keeps whatever Playing/Paused state it already had. The Folia pause is the caller's job
 * because only the caller knows whether Folia is audible (see usePlaybackBackendSwitch).
 */
export const claimAppleMusicBackend = (): boolean => {
    if (getActivePlaybackBackend() === 'apple-music') return false;
    setActivePlaybackBackend('apple-music');
    return true;
};

/**
 * Apple Music 的 seek。
 *
 * 三条与 Folia 路径刻意不同的规则：
 *   1. duration 用 **SMTC 自己的** durationMs 夹紧，绝不读 `audioRef.current.duration`
 *      （那是 Folia 的元素，Apple Music 模式下毫无意义，且上一位听众的时长会截断本次 seek）。
 *   2. 量化到整秒：Apple Music 的 timeline 只按整秒生效，不做量化会让进度条显示 41.7s
 *      而实际落在 42s，产生持续的回跳。
 *   3. 不触发 Folia 的 play()：`seekMainAudio` 在 folia 分支里会顺带 resume，Apple Music 的
 *      TryChangePlaybackPositionAsync 在暂停态只改位置、不恢复播放，两边语义不同。
 *
 * ⚠️ 已知限制（实测于 Windows 11 26200 + Apple Music，2026-09）：**Apple Music 不接受 SMTC 的
 *     位置变更，本函数发出的 seek 不会让 Apple Music 跳到目标位置。**
 *
 *     证据（同一台机器上逐项排除了其它解释）：
 *       * 能力位：`GetPlaybackInfo().Controls.IsPlaybackPositionEnabled === False`
 *         —— Apple Music 自己声明不支持位置控制；而同一时刻 play/pause/next/previous 位都是 true，
 *         这也解释了为什么只有 seek 无效、其余 transport 全部正常。
 *       * timeline 本身完好（`MinSeekTime 0 / MaxSeekTime 266`），不是可 seek 区间畸形。
 *       * 四次不同调用（3s、107s 播放中、20s 暂停态，renderer 与 DevTools 两条发起路径）
 *         返回的都是 `{ ok: true, errorKind: null }`，而位置序列只有自然播放推进
 *         （例如 seek 5000 之后：107s → 108s），Apple Music 自己的进度条也不动。
 *       * 因此 `ok: true` 在这里**不能**当作"位置已改变"：WinRT 收了调用并回 true，应用层不执行。
 *         helper（packaging/windows/apple-music-smtc-helper）只是忠实转述该返回值，不是它误报。
 *
 *     刻意没有做的两件事：
 *       * 不做「读回位置、没到目标就重发」的重试 —— 应用层是明确拒绝，重发只是把一个必然无效的
 *         调用重复两次，会把"没生效"这件事掩盖得更久。
 *       * 不因为这条限制就把进度条改成只读 —— 产品上保留可拖动（拖动后位置会在下一次 SMTC 推送
 *         时回到真实值），不做功能层的假承诺，也不隐藏这条限制。
 *     如果将来 Apple Music（或其它 SMTC 源）把 `IsPlaybackPositionEnabled` 打开，这里无需改动即可
 *     自动生效；若要按能力位精细控制，需要把该位一路带到 renderer（helper → bridge → preload →
 *     store → effective 模型），那是届时再做的升级。
 */
export const handleAppleMusicSeek = (positionSec: number): boolean => {
    if (getActivePlaybackBackend() !== 'apple-music') return false;

    if (!hasAppleMusicMedia(getAppleMusicStatus())) return true;

    const bridge = typeof window !== 'undefined' ? window.electron : undefined;
    if (typeof bridge?.appleMusicSendCommand !== 'function') return true;

    const durationMs = getAppleMusicStatus()?.durationMs ?? null;
    const requestedMs = Number.isFinite(positionSec) ? Math.max(0, positionSec * 1000) : 0;
    const clampedMs = typeof durationMs === 'number' && durationMs > 0
        ? Math.min(requestedMs, durationMs)
        : requestedMs;
    const quantizedMs = Math.round(clampedMs / 1000) * 1000;

    void bridge
        .appleMusicSendCommand({ command: 'seek', positionMs: quantizedMs })
        .catch(() => { /* 同上 */ });

    return true;
};
