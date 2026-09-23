import type { LyricData } from '../types';
import type { PlaybackBackend } from '../types/playbackBackend';

// src/utils/externalMediaLyricTrackKey.ts
// Apple Music 歌词的身份与派发判据：纯函数层，不依赖 React、不依赖 store、不 import 网络。
//
// 为什么单独一层：身份（哪首歌的歌词）与派发（此刻该显示谁的歌词）是两条最容易被写歪的规则，
// 而它们都能被穷举断言。把它们留在纯函数里，控制器与 selector 就只剩接线。

/**
 * Apple Music 曲目身份。
 *
 * 与 `buildExternalMediaPseudoSong` 的 id 哈希同源（AUMID + title + artist），但这里不做哈希 ——
 * 歌词 store 只需要一个可比较的键，可读的字符串比 53 位负数更适合出现在日志与断言里。
 * artist 为空时退化成空串，不影响身份（同一首歌缺 artist 元数据时仍应命中同一份歌词）。
 */
export const getExternalMediaTrackKey = (
    sourceAppUserModelId: string | null,
    title: string | null,
    artist: string | null,
): string | null => {
    const trimmedTitle = (title ?? '').trim();
    if (!trimmedTitle) return null;
    return `${sourceAppUserModelId ?? 'external-media'}|${trimmedTitle}|${(artist ?? '').trim()}`;
};

/**
 * 歌词的派发判据：此刻应当显示哪一份歌词。
 *
 * `backend === 'folia'` 时原样返回 Folia 的 display 歌词（含混音交接期取 outgoing deck 的语义，
 * 由 `selectDisplayLyrics` 负责）；`apple-music` 时只返回 Apple Music 的歌词，没有就是 null。
 *
 * 关键的一条：apple-music 分支**绝不回落到 Folia 的歌词**。回落会显示上一首 Folia 曲目的行，
 * 与 effectivePlayback.ts 里「coverUrl 必须为空、不得回落」是同一条理由。
 */
export const resolveDisplayLyrics = (
    backend: PlaybackBackend,
    foliaLyrics: LyricData | null,
    externalMediaLyrics: LyricData | null,
): LyricData | null => (
    backend === 'external-media' ? externalMediaLyrics : foliaLyrics
);

/**
 * folia 那一侧的歌词，**带 backend 判据一起取**。
 *
 * 为什么不是直接把 `selectDisplayLyrics(state)` 交出去：那个 selector 会在混音交接期返回
 * outgoing deck 的歌词（这是 folia 后端下正确的语义）。若读取层在 apple-music 后端下仍然调用它，
 * 就出现一个真实但窗口很窄的错配：交接窗口内 A 曲的歌词会被当成当前歌词，而此时的播放时钟已经
 * 由 SMTC 驱动 —— 于是「A 曲的行 + B 曲（外部应用）的时间」会一起进到歌词读头里。
 *
 * 判据放在这里而不是读取层里，是为了让「在 apple-music 后端下，folia 的歌词取值恒为 null」
 * 成为一条可单测的纯函数规则；读取层因此只有一个入口、一条规则。
 */
export const selectDisplayLyricsForBackend = (
    backend: PlaybackBackend,
    state: { transitionDisplay: { lyrics: LyricData | null } | null; lyrics: LyricData | null },
): LyricData | null => (
    backend === 'external-media' ? null : (state.transitionDisplay ? state.transitionDisplay.lyrics : state.lyrics)
);
