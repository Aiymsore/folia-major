import { create } from 'zustand';
import type { LyricData } from '../types';

// src/stores/useExternalMediaLyricsStore.ts
// Apple Music 后端的歌词状态源。与 useExternalMediaStore 同构：单一状态源 + getState 直读入口。
//
// 为什么不写进 usePlaybackStore.lyrics：
//   * usePlaybackStore 的语义是「Folia 这台机器在做什么」（见该文件 16-31 行的 raw/display 契约），
//     Apple Music 的歌词不属于 Folia 的任何一条播放路径；写进去等于放宽它已经成立的主键假设。
//   * Apple Music 的伪曲目**不进 store**（不进 queue、不进 currentSong），因此它的歌词也没有
//     「跟着 currentSong 一起被写」的时机 —— 只能由自己的控制器入账。
//   * 发布面（handoff / OBS / playerCap）需要同步快照直读，store 天然有 getState()。
//
// 一条硬规则：本 store 只在 backend === 'external-media' 时被读取。
// apple-music 后端下 Folia 的 lyrics **不被读取**（统一 selector 负责这件事），
// 因此不存在「两边都读、谁后写谁赢」的两份真相。
//
// 一条不变量：`lyrics` 只在 `trackKey` 与当前曲目一致时才可被展示。切歌时 `beginTrack`
// 先把 key 推到新曲目并把歌词清空，因此「新曲目的身份 + 上一首的行」这一帧在结构上不存在。

/**
 * 歌词的装载阶段。
 *
 * `idle` 与 `no-media` 是两件事：前者表示「当前后端不是 Apple Music，这个 store 不参与」，
 * 后者表示「是 Apple Music，但没有可匹配的曲目」。UI 对它们的处理不同（一个沿用 Folia 分支，
 * 一个应当显示「无歌词」而不是继续显示上一首）。
 */
export type ExternalMediaLyricsPhase = 'idle' | 'loading' | 'ready' | 'empty' | 'no-media';

type ExternalMediaLyricsStore = {
    /** 当前曲目身份（由伪曲目派生的播放键）。null 表示没有曲目。 */
    trackKey: string | null;
    /** 已入账的歌词。只在它与 trackKey 属于同一曲目时有效。 */
    lyrics: LyricData | null;
    phase: ExternalMediaLyricsPhase;
    /**
     * 切到一首新曲目：立即把身份推到新的 key **并清空歌词**。
     *
     * 原子性是这里的全部要点：`buildExternalMediaPseudoSong` 的 id 由 AUMID + title + artist
     * 哈希而来，切歌时消费者会先看到新 key。若歌词还挂着上一首，视觉化器就有机会用
     * 「新曲目的身份 + 旧曲目的行」渲染一帧。一次 set 让这一帧在结构上不存在。
     */
    beginTrack: (trackKey: string | null, phase: ExternalMediaLyricsPhase) => void;
    /** 为一首已开始的曲目入账歌词。key 不匹配时丢弃 —— 那是迟到的匹配结果。 */
    commitLyrics: (trackKey: string, phase: ExternalMediaLyricsPhase, lyrics: LyricData | null) => void;
    /** 只推进阶段，不动曲目与歌词。用于同曲目内的 loading / empty 迁移。 */
    setPhase: (phase: ExternalMediaLyricsPhase) => void;
    /** 离开 Apple Music 后端时整体复位。 */
    reset: () => void;
};

export const useExternalMediaLyricsStore = create<ExternalMediaLyricsStore>(set => ({
    trackKey: null,
    lyrics: null,
    phase: 'idle',
    beginTrack: (trackKey, phase) => set({ trackKey, phase, lyrics: null }),
    commitLyrics: (trackKey, phase, lyrics) => set(state => (
        state.trackKey === trackKey ? { phase, lyrics } : state
    )),
    setPhase: phase => set({ phase }),
    reset: () => set({ trackKey: null, lyrics: null, phase: 'idle' }),
}));

/** 非渲染路径的直读入口（发布面、命令派发）。 */
export const getExternalMediaLyrics = (): LyricData | null => (
    useExternalMediaLyricsStore.getState().lyrics
);

export const getExternalMediaLyricsTrackKey = (): string | null => (
    useExternalMediaLyricsStore.getState().trackKey
);

export const getExternalMediaLyricsPhase = (): ExternalMediaLyricsPhase => (
    useExternalMediaLyricsStore.getState().phase
);

/**
 * 测试与诊断用的复位入口。生产代码请用 `reset()`（离开后端时调用），不要用这个。
 * 单独导出是为了让 store 的生命周期断言不必去戳 `setState` 的原始形状。
 */
export const resetExternalMediaLyricsForTests = (): void => {
    useExternalMediaLyricsStore.getState().reset();
};
