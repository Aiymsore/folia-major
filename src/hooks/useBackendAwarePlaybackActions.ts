import { useMemo } from 'react';
import { useActivePlaybackBackendStore } from '../stores/useActivePlaybackBackendStore';
import { claimFoliaBackend, handleAppleMusicAction } from './useTransportDispatcher';

// src/hooks/useBackendAwarePlaybackActions.ts
// 把「用户从正式 source UI 开始播放 Folia 歌曲」这条路径变成 backend-aware 的，并把正式播放器 UI 的
// 上一首/下一首也接到同一个 dispatcher 上。
//
// 为什么不复用 useTransportCommandRefs：那条路只服务 mediaSession / Windows taskbar / 遥控窗口 /
// Stage 四个外部 driver，正式播放器 UI 的按钮根本不经过它。所以这两个入口需要各自包一层 —— 但两者
// 内部都只调用 useTransportDispatcher 的同一个函数，判断逻辑仍然只有一份。
//
// 所有被包装的函数都由既有 controller 提供，本文件**不修改任何 controller 内部语义**。
//
// 实现上是「同一个运行时包装 + 每个调用点显式收窄类型，再用显式类型标注的函数产出」。用类型参数而不是
// `any` 是刻意的：`any` 会把这个文件的类型漏洞扩散到 App.tsx 每个接收这些 handler 的 prop 上。

export type BackendAwarePlaybackActionsInput = {
    /** 在线播放（Grid / 播放队列的最终入口）。 */
    playSong: (...args: any[]) => any;
    /** 本地文件播放。 */
    onPlayLocalSong: (...args: any[]) => any;
    /** Navidrome 播放。 */
    onPlayNavidromeSong: (...args: any[]) => any;
    /** 搜索结果播放入口，自己也是一条独立路径。 */
    handleSearchResultPlay: (...args: any[]) => any;
};

type Wrapped<F> = F extends (...args: infer A) => infer R ? (...args: A) => R : never;

export type BackendAwarePlaybackActions = {
    playSong: Wrapped<BackendAwarePlaybackActionsInput['playSong']>;
    onPlayLocalSong: Wrapped<BackendAwarePlaybackActionsInput['onPlayLocalSong']>;
    onPlayNavidromeSong: Wrapped<BackendAwarePlaybackActionsInput['onPlayNavidromeSong']>;
    handleSearchResultPlay: Wrapped<BackendAwarePlaybackActionsInput['handleSearchResultPlay']>;
};

/**
 * 包装后的 play actions。
 *
 * 语义（对应产品决策 3 的例外条款）：用户在 apple-music 后端下从正式 source UI 开始播放 Folia 歌曲
 * = 显式选择了 Folia 后端，因此先 best-effort 暂停 Apple Music、把 backend 切回 'folia'，再执行原
 * action。这是由用户操作自然发生的切换，不是任何自动抢占。
 *
 * 包装函数只在 backend 变化时重建身份；调用点都是事件处理器或已 memo 的 model，因此不会引起额外渲染。
 */
export const useBackendAwarePlaybackActions = ({
    playSong,
    onPlayLocalSong,
    onPlayNavidromeSong,
    handleSearchResultPlay,
}: BackendAwarePlaybackActionsInput): BackendAwarePlaybackActions => {
    const backend = useActivePlaybackBackendStore(state => state.activeBackend);

    return useMemo(() => {
        // Claiming before forwarding, and only when something else currently owns the transport: in
        // the Folia backend this costs one store read and sends nothing.
        const wrap = <F extends (...args: any[]) => any>(action: F): F => (
            ((...args: Parameters<F>) => {
                claimFoliaBackend();
                return action(...args);
            }) as F
        );

        return {
            playSong: wrap(playSong),
            onPlayLocalSong: wrap(onPlayLocalSong),
            onPlayNavidromeSong: wrap(onPlayNavidromeSong),
            handleSearchResultPlay: wrap(handleSearchResultPlay),
        };
        // `backend` participates so the wrappers are rebuilt when it changes; claimFoliaBackend reads
        // the live value itself, so this is about keeping the closure honest rather than caching it.
    }, [backend, handleSearchResultPlay, onPlayLocalSong, onPlayNavidromeSong, playSong]);
};

export type BackendAwareTrackNavigationInput = {
    handlePrevTrack: () => void;
    handleNextTrack: (options?: any) => Promise<void>;
};

export type BackendAwareTrackNavigation = {
    handlePrevTrack: () => void;
    handleNextTrack: (options?: any) => Promise<void>;
};

/**
 * backend-aware 的上一首 / 下一首，供**正式播放器 UI** 使用。
 *
 * 签名与返回类型与原来的 handler 一致（`handleNextTrack` 仍然返回 Promise），因此悬浮控件、播放器
 * 面板、键盘快捷键的调用点一行都不用改。返回值语义见 useTransportDispatcher：被 Apple Music 接管时
 * 直接返回，Folia 体不执行。
 */
export const useBackendAwareTrackNavigation = ({
    handlePrevTrack,
    handleNextTrack,
}: BackendAwareTrackNavigationInput): BackendAwareTrackNavigation => {
    const backend = useActivePlaybackBackendStore(state => state.activeBackend);

    return useMemo(() => ({
        handlePrevTrack: () => {
            if (handleAppleMusicAction('previous')) return;
            handlePrevTrack();
        },
        handleNextTrack: (options?: any) => {
            if (handleAppleMusicAction('next')) return Promise.resolve();
            return Promise.resolve(handleNextTrack(options));
        },
    }), [backend, handleNextTrack, handlePrevTrack]);
};
