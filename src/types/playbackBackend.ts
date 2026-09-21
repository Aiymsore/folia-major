import type { OnlineProviderId, ProviderAccountSummary } from './onlineMusic';

// src/types/playbackBackend.ts
// 播放后端（playback backend）选择，与「内容源」「在线平台账号」是三个不同的概念：
//
//   content source        homeViewTab（歌单/电台/专辑/本地/Navidrome）—— 只决定首页显示什么
//   platform account      activeProviderId —— 只决定在线搜索/歌单请求打到哪家
//   playback backend      本文件 —— 决定播放器读谁的状态、transport 命令发给谁
//
// 三者互不推导：「当前浏览网易云」不代表「播放器正在播放网易云」，一首歌的取流归属由它自己的
// song.sourceRef.providerId 决定（services/onlineMusic/omni.ts 的 providerForSong）。
//
// Apple Music 是 Folia 之外的一个后端，不是第四个 provider：它不产生 SongResult、不进 queue、
// 不进 omni 的 provider registry，也不消费 activeProviderId。

export type PlaybackBackend = 'folia' | 'apple-music';

/**
 * Apple Music 入口在平台选择器里的三种可显示状态。
 *
 * `unavailable` 与 `not-running` 是两件不同的事：前者表示本机根本没有可用的 helper/bridge
 * （非 Windows、二进制缺失），后者表示 bridge 健康但 Apple Music 当前没有可见的 SMTC session。
 * 两者都禁用 transport，但文案不同，用户能据此判断该去启动什么。
 */
export type AppleMusicAvailability = 'connected' | 'not-running' | 'unavailable';

/**
 * 平台选择器的一行。判别联合而不是给 `ProviderAccountSummary` 加可选字段：
 * 「是否需要登录/登出」在类型层面就不成立，而不是靠运行时 if 防错。
 *
 * `apple-music` 这一支刻意**没有** `providerId`，因此它无法被传给 switchProvider /
 * logoutProvider / omni —— 想污染 provider 状态必须改类型，而不是漏写一个判断。
 */
export type PlaybackSwitcherEntry =
    | { kind: 'provider'; providerId: OnlineProviderId; summary: ProviderAccountSummary; isActive: boolean }
    | { kind: 'apple-music'; status: AppleMusicAvailability; isActive: boolean; disabledReason: string | null };
