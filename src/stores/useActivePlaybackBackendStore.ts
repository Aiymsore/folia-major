import { create } from 'zustand';
import type { PlaybackBackend } from '../types/playbackBackend';

// src/stores/useActivePlaybackBackendStore.ts
// 当前播放后端的唯一状态源。
//
// 为什么是一个独立 store，而不是塞进 usePlaybackStore：
//   * usePlaybackStore 的每个字段都描述 Folia 自己的播放事实（currentSong / audioSrc / queue）。
//     backend 为 apple-music 时这些字段仍然持有 Folia 的陈旧值，混在一起会被下游误读。
//   * 本 store 会被非渲染路径读取（taskbar / remote / Stage 的 IPC 回调），必须能用
//     `useActivePlaybackBackendStore.getState()` 直读，而不是从 React context 里取。
//
// 唯一写入入口是 setActiveBackend，且**只有用户的显式选择**能调用它：
// 任何 SMTC 状态变化（Playing/Paused/切歌/位置）都不得修改它 —— 这是产品决策，不是实现细节。

type ActivePlaybackBackendStore = {
    activeBackend: PlaybackBackend;
    setActiveBackend: (next: PlaybackBackend) => void;
};

export const useActivePlaybackBackendStore = create<ActivePlaybackBackendStore>(set => ({
    activeBackend: 'folia',
    setActiveBackend: next => set(state => (state.activeBackend === next ? state : { activeBackend: next })),
}));

/** 非渲染路径的直读入口（IPC 回调、命令派发）。 */
export const getActivePlaybackBackend = (): PlaybackBackend => (
    useActivePlaybackBackendStore.getState().activeBackend
);

/** 模块级写入入口，与 usePlaybackStore 的 setter 同一范式。 */
export const setActivePlaybackBackend = (next: PlaybackBackend): void => {
    useActivePlaybackBackendStore.getState().setActiveBackend(next);
};
