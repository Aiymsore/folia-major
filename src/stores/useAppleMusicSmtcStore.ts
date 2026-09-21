import { create } from 'zustand';
import type { AppleMusicAvailability } from '../types/playbackBackend';
import { hasAppleMusicMedia, resolveAppleMusicAvailability } from '../utils/appleMusicSmtcStatus';

// src/stores/useAppleMusicSmtcStore.ts
// Apple Music SMTC 快照的唯一状态源（只读）。
//
// 为什么统一成 store，而不是「一个 hook + 一个 .getState()」：
//   * 订阅 main 进程广播的动作只能发生一次。做成 hook 的话，每个调用点都会各自
//     `onAppleMusicStateChanged` 一次，得到彼此独立的 snapshot，并且谁都可能落后一帧。
//   * 非渲染路径（命令派发、能力判断）必须能同步直读，所以需要 `getAppleMusicStatus()`。
//   两者读的是同一份对象，因此不存在「hook 版」和「store 版」两个真相。
//
// 本 store 是纯只读的投影：它不写 currentSong / audioSrc / queue / audioRef，
// 也不修改 activePlaybackBackend（SMTC 状态变化绝不切换后端）。
//
// 判据本身（是否算「有内容」、三态如何映射）在 utils/appleMusicSmtcStatus.ts，依赖无关、可单测。

export { hasAppleMusicMedia };

type AppleMusicSmtcStore = {
    status: ElectronAppleMusicSmtcStatus | null;
    setStatus: (next: ElectronAppleMusicSmtcStatus) => void;
};

export const useAppleMusicSmtcStore = create<AppleMusicSmtcStore>(set => ({
    status: null,
    setStatus: next => set({ status: next }),
}));

/** 非渲染路径的直读入口。 */
export const getAppleMusicStatus = (): ElectronAppleMusicSmtcStatus | null => (
    useAppleMusicSmtcStore.getState().status
);

export const getAppleMusicAvailability = (): AppleMusicAvailability => (
    resolveAppleMusicAvailability(getAppleMusicStatus())
);

/** 是否有可播放的曲目（session + 曲目信息），与播放状态无关。 */
export const hasAppleMusicSession = (): boolean => hasAppleMusicMedia(getAppleMusicStatus());

/** 当前活跃订阅的清理句柄。null 表示没有订阅。 */
let subscriptionCleanup: (() => void) | null = null;

/**
 * 订阅代次。每**真正建立**一次订阅才递增，用于让旧生命周期的异步结果失效。
 *
 * 为什么需要它：`appleMusicGetState()` 是一次 IPC，返回时可能这一代订阅早就被 cleanup 掉了。
 * 没有代次校验的话，那次迟到的解析会把一份已经过期的快照写进 store ——
 * 症状是「切换/重建之后状态被几秒前的值盖回去」，而且只在慢 IPC 下偶发。
 */
let subscriptionGeneration = 0;

/**
 * 停止当前订阅。只负责订阅生命周期，**不做别的**。
 *
 * 三条刻意的性质：
 *   * 没有订阅时是 no-op（句柄为 null 直接返回）。
 *   * **绝不为了 stop 新建订阅** —— 它不调用 start。
 *   * **不清空 store.status**。订阅生命周期与播放快照生命周期是两件事：停止监听不代表
 *     「远端没有在播放」。需要干净状态的调用方（测试、诊断重置）自己 reset store。
 */
export const stopAppleMusicSmtcSubscription = (): void => {
    subscriptionCleanup?.();
};

/**
 * 建立**唯一**一份 SMTC 订阅并把快照写进 store。重复调用是 no-op，返回同一个清理句柄。
 *
 * 幂等是这里的关键：它会被 App 调用一次，也可能被提前调用（诊断面板、命令派发），
 * 而任何一次重复订阅都会让 store 被两条广播流交替覆盖。因此**只有真正创建订阅的分支**
 * 才递增代次：重复的 start 既不注册 listener，也不推进代次。
 */
export const startAppleMusicSmtcSubscription = (): (() => void) => {
    if (subscriptionCleanup) return subscriptionCleanup;

    const generation = ++subscriptionGeneration;
    // 这一代的失效标记。除了比较代次数字，还用一个闭包内的布尔显式记录「我被清理过」：
    // 清理后重新 start 会产生新代次，老代次迟到的 promise 必须失效，而显式标记让这件事在代码里
    // 直接可读，而不是靠数字推断。
    let cancelled = false;

    const bridge = typeof window !== 'undefined' ? window.electron : undefined;
    if (typeof bridge?.onAppleMusicStateChanged !== 'function') {
        // 非 Electron 窗口（网页构建、单测）没有这条通道：保持 status = null，
        // availability 自然是 'unavailable'，不需要额外的降级分支。
        subscriptionCleanup = () => {
            if (cancelled) return;
            cancelled = true;
            subscriptionCleanup = null;
        };
        return subscriptionCleanup;
    }

    const unsubscribe = bridge.onAppleMusicStateChanged(status => {
        // 推送属于**当前**这一代才写。unsubscribe 之后理论上不会再回调，把守卫放在这里是为了让
        // 「旧订阅写 store」在结构上不可能，而不是依赖 removeListener 的实现细节。
        if (cancelled || subscriptionGeneration !== generation) return;
        useAppleMusicSmtcStore.getState().setStatus(status);
    });

    const cleanup = () => {
        // 幂等：重复 cleanup 不重复摘除，也不推进任何状态。
        if (cancelled) return;
        cancelled = true;
        unsubscribe?.();
        if (subscriptionGeneration === generation) {
            subscriptionCleanup = null;
        }
    };
    subscriptionCleanup = cleanup;

    // 一次初读，避免等到第一次变化才有值。读失败就保持 null，由 availability 表达不可用。
    if (typeof bridge.appleMusicGetState === 'function') {
        void bridge.appleMusicGetState()
            .then(status => {
                // 两层保护，缺一不可：
                //   1. 失效标记 / 代次 —— cleanup 之后这次解析属于一个已不存在的生命周期，直接丢弃。
                //      这就是「start → initial read pending → cleanup → 解析回来」那个真实竞态的修复。
                //   2. store 已有快照 —— 即使这一代仍然有效，推送先到时初读也不能把它盖回去。
                if (cancelled || subscriptionGeneration !== generation) return;
                if (!useAppleMusicSmtcStore.getState().status && status) {
                    useAppleMusicSmtcStore.getState().setStatus(status);
                }
            })
            .catch(() => {
                /* 不可用由 availability 表达，不在此处打扰用户 */
            });
    }

    return subscriptionCleanup;
};

export const selectAppleMusicAvailability = resolveAppleMusicAvailability;
