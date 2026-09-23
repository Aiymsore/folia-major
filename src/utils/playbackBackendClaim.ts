import type { SongResult } from '../types';
import { isExternalMediaPlaybackSong } from './appPlaybackGuards';

// src/utils/playbackBackendClaim.ts
//
// 「播放这一首应当由哪个后端承接」的**纯判据**。放在这里而不是散在调用点，是因为它同时被三条
// 路径需要，而它们此前各自答错了同一个问题：
//
//   * 播放动作包装器（useBackendAwarePlaybackActions）—— 曾经无条件 claimFoliaBackend()，
//     于是点一首 Apple Music 曲目会先把后端抢回 folia，紧接着 playExternalMediaTrack 因为
//     「后端不是 external-media」直接返回 false，用户看到的是"无法在 Chrome 中开始播放"，
//     而真正的原因是 Folia 自己刚刚放弃了那个后端。
//   * 播放键（usePlaybackTransportController）—— 曾经对一首没有 audioSrc 的曲目调用
//     deck.play()，得到一个 AbortError。
//   * 会话恢复（restorePlaybackSource）—— 曾经把外部媒体曲目送进 omni 的在线取流路径。
//
// 判据本身只有一条：`sourceRef.kind === 'external-media'`（含持久化前的 `externalMediaId`
// 标记，见 isExternalMediaPlaybackSong）。本地 / Navidrome / 在线曲目一律由 folia 承接。
//
// **它只回答"谁承接"，不负责切换。** 真正的切换仍由 usePlaybackBackendSwitch 的两个用户操作
// 入口执行（见 types/playbackBackend.ts 的产品规则：只有显式选择才写 activeBackend）。

export type PlaybackBackendClaim = 'folia' | 'external-media';

/** 这一首应当由哪个后端承接。null / 非曲目输入按 folia 处理（旧行为）。 */
export const resolvePlaybackBackendClaim = (song: unknown): PlaybackBackendClaim => (
    isExternalMediaPlaybackSong(song as SongResult | null | undefined) ? 'external-media' : 'folia'
);
