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
// `external-media` 是 Folia 之外的一个后端，不是第四个 provider：它不产生 provider 归属、
// 不进 omni 的 provider registry，也不消费 activeProviderId。
//
// 这次重构把旧的 `apple-music` 改名为 `external-media`：旧名字把"谁在播"和"播的是什么"绑死在了
// Apple Music 上，而现在的架构是「Folia 作为统一媒体控制层，外部播放器只是它的一个受控目标」。
// 名字必须描述角色，不描述当前唯一的一个实现 —— 否则第二个外部播放器出现时又要改名一次。

export type PlaybackBackend = 'folia' | 'external-media';

/**
 * 外部媒体后端在平台选择器里的可显示状态。
 *
 * 这些状态是**依次递进的前置条件**，缺任何一个功能就不可用（已确认接受这一组前置条件）：
 *
 *   1. 扩展已安装并连上 Folia 的 loopback 桥        → 否则 `extension-missing`
 *   2. Chrome 里存在 music.apple.com 的 tab         → 否则 `tab-not-found`
 *   3. 那个 tab 的播放器真的可被驱动                 → 否则 `player-not-ready`
 *   4. 该 tab 已登录 Apple Music 且有订阅            → 否则 `not-signed-in`
 *   5. 页面 storefront 与 MusicKit storefront 一致   → 否则 `storefront-mismatch`
 *
 * 分开表达而不是合成一个布尔，是因为每一态的**用户动作完全不同**（装扩展 / 开网页 / 刷新页面 /
 * 登录 / 换区），而旧的三态 `connected | not-running | unavailable` 只能告诉用户"不可用"。
 *
 * `player-not-ready` 是 2026-09-23 补的，代价是一次真实的误诊：content script 跑在隔离世界、
 * 读不到页面主世界的 `window.MusicKit`，于是每一帧观察都是 `player-declined`；而当时的阶梯把
 * "有 tab 但播放器读不到"与"没有 tab"合并成 `tab-not-found`，UI 让用户去打开一个**已经开着的**
 * 标签页。两件事的用户动作不同：一个是"去开页面"，一个是"刷新那个页面"。
 *
 * `ready` 之后才有 transport；其余各态都禁用 transport，但文案各不相同。
 */
export type ExternalMediaAvailability =
    | 'ready'
    | 'extension-missing'
    | 'tab-not-found'
    /** tab 在，但页面里的播放器读不到（页面未 boot 完 / 扩展重载后页面未刷新）。 */
    | 'player-not-ready'
    | 'not-signed-in'
    | 'storefront-mismatch'
    /** loopback 桥本身起不来（端口被占、Electron 主进程异常）。 */
    | 'unavailable';

/**
 * 平台选择器的一行。判别联合而不是给 `ProviderAccountSummary` 加可选字段：
 * 「是否需要登录/登出」在类型层面就不成立，而不是靠运行时 if 防错。
 *
 * `external-media` 这一支刻意**没有** `providerId`，因此它无法被传给 switchProvider /
 * logoutProvider / omni —— 想污染 provider 状态必须改类型，而不是漏写一个判断。
 */
export type PlaybackSwitcherEntry =
    | { kind: 'provider'; providerId: OnlineProviderId; summary: ProviderAccountSummary; isActive: boolean }
    | { kind: 'external-media'; status: ExternalMediaAvailability; isActive: boolean; disabledReason: string | null };
