import type { LyricData } from '../types';
import { useActivePlaybackBackendStore } from '../stores/useActivePlaybackBackendStore';
import { useExternalMediaLyricsStore } from '../stores/useExternalMediaLyricsStore';
import { selectDisplayLyrics, usePlaybackStore } from '../stores/usePlaybackStore';
import { resolveDisplayLyrics, selectDisplayLyricsForBackend } from '../utils/externalMediaLyricTrackKey';

// src/hooks/useDisplayLyrics.ts
// 歌词的**唯一读取入口**：按 activePlaybackBackend 决定读谁。
//
// 为什么需要这一层：歌词有两份状态源（Folia 的 usePlaybackStore、Apple Music 的
// useExternalMediaLyricsStore），但消费者不该知道这件事。放在这里而不是放进 effective playback
// model，是因为那个 model 是「每次调用构造」的只读视图，而发布面（handoff / OBS / playerCap）
// 需要的是可同步直读的快照 —— 那是 store 的能力，不是 hook 的能力。
//
// 判据本身（派发规则）在 utils/externalMediaLyricTrackKey.ts，纯函数、可单测。

/** React 读取入口。消费者只调这一个，不关心后端。 */
export const useDisplayLyrics = (): LyricData | null => {
    const backend = useActivePlaybackBackendStore(state => state.activeBackend);
    // folia 歌词带 backend 判据一起取：apple-music 后端下它必须是 null，不能把
    // `selectDisplayLyrics`（可能停在混音交接期的 outgoing deck 上）直接交出去。
    const foliaLyrics = usePlaybackStore(state => selectDisplayLyricsForBackend(backend, state));
    const externalMediaLyrics = useExternalMediaLyricsStore(state => state.lyrics);
    return resolveDisplayLyrics(backend, foliaLyrics, externalMediaLyrics);
};

/**
 * 非渲染路径的同步快照读取（发布面、命令派发）。
 *
 * 与 `useDisplayLyrics` 读同一份状态：两者都不缓存、不复制，所以不存在「hook 版」和
 * 「getState 版」两个真相。
 */
export const getDisplayLyrics = (): LyricData | null => {
    const backend = useActivePlaybackBackendStore.getState().activeBackend;
    return resolveDisplayLyrics(
        backend,
        selectDisplayLyricsForBackend(backend, usePlaybackStore.getState()),
        useExternalMediaLyricsStore.getState().lyrics,
    );
};

// 这里刻意**没有**「后端感知的歌词写入器」。两个写入方向不是对称的：
//
//   * Folia 的歌词只能写进 usePlaybackStore。它的写入者是 Folia 自己的播放管线（歌曲装载、
//     手动匹配弹窗、逐词切分、混音冻结快照），这些管线描述的就是 Folia 那一台机器；
//     让它们按 backend 分派，反而会在「Folia 曲目还在装载、backend 刚被切到 apple-music」
//     这种瞬时状态下把 Folia 的歌词写进 Apple Music 的槽位。
//   * Apple Music 的歌词只能写进 useExternalMediaLyricsStore。它的写入者是
//     useExternalMediaLyricsController，那里直接 commit（并带 trackKey 守卫）。
//
// 也就是说：**读**统一（本文件），**写**各自归位。两份真相之所以不可能出现，不是因为写入被
// 中心化，而是因为两个 store 的读取者被 resolveDisplayLyrics 排他地二选一。
