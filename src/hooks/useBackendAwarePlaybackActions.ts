import { useMemo } from 'react';
import { getActivePlaybackBackend, useActivePlaybackBackendStore } from '../stores/useActivePlaybackBackendStore';
import { usePlaybackStore } from '../stores/usePlaybackStore';
import { resolvePlaybackBackendClaim } from '../utils/playbackBackendClaim';
import { selectExternalMediaBackend } from './usePlaybackBackendSwitch';
import { claimFoliaBackend, handleExternalMediaAction } from './useTransportDispatcher';

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
    /**
     * 真正能停声的 Folia 暂停回调。
     *
     * 只在「点的是外部媒体曲目、而 Folia 正在出声」时用到：那一刻必须让位，否则两个播放器同时
     * 出声。与平台选择器里的 Apple Music 条目走同一个 `selectExternalMediaBackend`，因此
     * "要不要暂停"这条判断只有一份。
     */
    pauseFolia: () => void;
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
 * ── 唯一的例外：曲目本身就是外部媒体曲目 ──────────────────────────────────────────
 *
 * 点一首 Apple Music 曲目**不是**"选择 Folia 后端"——那一首在 Folia 里根本没有音频源（见
 * `onPlayExternalMediaSong`：deck 刻意保持静默，声音由 Chrome 里的网页播放器发出）。所以这时
 * 认领的是 external-media 后端，且必须**先认领再执行**：`playExternalMediaTrack` 的第一道闸就是
 * `getActivePlaybackBackend() !== 'external-media' → false`，抢回 folia 会让每一次点歌都以
 * "无法在 Chrome 中开始播放"告终。判据在 `utils/playbackBackendClaim.ts`。
 *
 * 包装函数只在 backend 变化时重建身份；调用点都是事件处理器或已 memo 的 model，因此不会引起额外渲染。
 */
export const useBackendAwarePlaybackActions = ({
    playSong,
    onPlayLocalSong,
    onPlayNavidromeSong,
    handleSearchResultPlay,
    pauseFolia,
}: BackendAwarePlaybackActionsInput): BackendAwarePlaybackActions => {
    const backend = useActivePlaybackBackendStore(state => state.activeBackend);

    return useMemo(() => {
        /**
         * 认领这一次播放该由谁承接。
         *
         * 两个分支都幂等（与 `claimFoliaBackend` 同一条规则）：已经是目标后端时不发命令、不写状态。
         * Folia 正在出声而用户点了外部媒体曲目时才暂停 Folia——两个播放器同时出声是这里唯一要
         * 防的事，而"要不要暂停"的判断复用 `selectExternalMediaBackend`。
         */
        const claimBackendFor = (song: unknown): void => {
            if (resolvePlaybackBackendClaim(song) !== 'external-media') {
                claimFoliaBackend();
                return;
            }
            if (getActivePlaybackBackend() === 'external-media') return;
            // 读 raw playerState：混音交接期 display 是 PLAYING，但这里要的是"这台机器上的 deck
            // 现在有没有在出声"。
            selectExternalMediaBackend(pauseFolia, usePlaybackStore.getState().playerState);
        };

        // Claiming before forwarding, and only when something else currently owns the transport: in
        // the matching backend this costs one store read and sends nothing.
        const wrap = <F extends (...args: any[]) => any>(action: F): F => (
            ((...args: Parameters<F>) => {
                claimBackendFor(args[0]);
                return action(...args);
            }) as F
        );

        return {
            playSong: wrap(playSong),
            onPlayLocalSong: wrap(onPlayLocalSong),
            onPlayNavidromeSong: wrap(onPlayNavidromeSong),
            handleSearchResultPlay: wrap(handleSearchResultPlay),
        };
        // `backend` participates so the wrappers are rebuilt when it changes; the claim functions read
        // the live value themselves, so this is about keeping the closure honest rather than caching it.
    }, [backend, handleSearchResultPlay, onPlayLocalSong, onPlayNavidromeSong, pauseFolia, playSong]);
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
 * ── 本次重构后这里不再转发给外部播放器 ──────────────────────────────────────────
 *
 * 旧实现在 backend = apple-music 时直接 `handleExternalMediaAction('next')`，把"下一首"透传给
 * 桌面版 Apple Music。新架构下这是错的：Folia 自己拥有 queue，透传会让 Apple Music 播它**自己**
 * 的内部队列，两个 queue 争夺控制权。
 *
 * 现在的语义：**两个 backend 下都走 Folia 的 `handleNextTrack` / `handlePrevTrack`。**
 * 由 queue 层算出目标曲目，再按当前 backend 分派 —— 外部媒体后端下分派成
 * `playById(目标曲目的 catalogId)`（见 `usePlaybackQueueController`）。
 *
 * 因此这个包装层在 next/previous 上不再需要 backend 分支：它保留的原因只剩签名稳定
 * （调用点包括悬浮控件、播放器面板、键盘快捷键，都不该因为这次重构而改动），以及
 * "用户在外部媒体后端下按播放器 UI 的下一首 = 明确选择 Folia 的 queue"这条语义的落点。
 *
 * 注意它**不**调用 `claimFoliaBackend()`：切歌不等于换后端。用户在外部媒体后端下按下一首，
 * 仍然是"让外部播放器放 queue 里的下一首"，而不是"切回 Folia 播放"。
 */
export const useBackendAwareTrackNavigation = ({
    handlePrevTrack,
    handleNextTrack,
}: BackendAwareTrackNavigationInput): BackendAwareTrackNavigation => {
    const backend = useActivePlaybackBackendStore(state => state.activeBackend);

    return useMemo(() => ({
        handlePrevTrack: () => {
            handlePrevTrack();
        },
        handleNextTrack: (options?: any) => Promise.resolve(handleNextTrack(options)),
        // `backend` 参与依赖，使包装函数在切换后端时重建 —— 目前两条分支体相同，但保留这个依赖
        // 是为了让将来"按 backend 分派"的改动有一个显然的落点，而不是让 memo 悄悄缓存住旧闭包。
    }), [backend, handleNextTrack, handlePrevTrack]);
};
