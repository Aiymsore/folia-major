# 外部媒体后端（external-media backend）

Folia 的第二个播放后端：**曲目由 Folia 选择和排队，声音由 Chrome 里的 music.apple.com 网页播放器
放出**。这是 2026-09 重构的架构记录：为什么长这样、边界在哪、什么被刻意不做。

> 命名：后端叫 `external-media` 而不是 `apple-music`——名字描述**角色**（Folia 之外的一个受控媒体
> 源），不描述当前唯一的一个实现。Apple Music 目录浏览（`appleMusicService.ts`、
> `HomeViewTab='appleMusic'`、i18n `appleMusic.*`）是**内容源**命名，与此正交，保留原名。
> `folia-apple-music-smtc-helper.exe` 的二进制名是历史遗留（它原本读桌面版 Apple Music），保留。

## 为什么是网页端，为什么必须配扩展

桌面版 Apple Music 的 SMTC 会话**无法按 id 播放曲目**（无 PlayById 语义），而 Folia 的 queue 需要
"播第 N 首"。网页播放器能（MusicKit `setQueue`/`play`），但网页自身受 DRM 与登录限制，因此把
"在页面里按按钮"这件事交给一个 Chrome 扩展。四个前置条件（已确认接受，缺一不可）：

1. Chrome 在运行
2. Folia Chrome 扩展已安装并连上 Folia 的 loopback 桥
3. `music.apple.com` 标签页已登录 Apple Music
4. 该账号有有效订阅

90 秒试听（`previews[].url` / `previewUrl`）已整体删除：这条路径被网页全曲取代，`previewUrl`
字段及其提取、判据全部不存在了（不可播的唯一情形是没有目录条目的资料库上传曲目）。

## 拓扑：一个观察者 + 一个控制器，同一个媒体源

```
Folia queue（唯一权威）
   │  playById(catalogId)          play / pause / toggle / seek
   ▼                                        ▼
electron/externalMediaBridge.cjs ──WS──▶ Folia Chrome 扩展 ──▶ music.apple.com（出声）
   ▲ 127.0.0.1:32110（HTTP+WS，token 鉴权）
   │
electron/externalMediaSmtcBridge.cjs ◀──JSONL── folia-apple-music-smtc-helper.exe ◀──SMTC── Chrome 会话
   （观察者：正在放什么、位置在哪）                        （AUMID 子串匹配，FOLIA_EXTERNAL_MEDIA_SMTC_MATCH）
```

- **观察者**（SMTC helper，`--match Chrome`）回答"现在在放什么、到哪了"。
- **控制器**（扩展桥）回答"让页面播这首/停/走/跳"。
- 两者必须指向**同一个**媒体源：观察者看着一个播放器、控制器驱动另一个，就会报告一首没人听见
  的曲子。这是整个架构唯一的承重不变量（不变量本身见 `electron/main.cjs` 里两个桥的注册处：
  两侧都以 `'apple-music-web'` 命名同一个源）。

## 后端认领：点歌即认领，判据在曲目本身

`activeBackend` 的写入者是**用户的显式操作**，共两个：

1. 平台选择器里选 Apple Music / 任意原生平台（`usePlaybackSwitcherEntries`）；
2. **点击一首外部媒体曲目**（`useBackendAwarePlaybackActions`）。

第 2 条是 2026-09-23 修的（判据 `utils/playbackBackendClaim.ts`）。此前那个包装器无条件
`claimFoliaBackend()`，于是点一首 Apple Music 曲目会先把后端抢回 `folia`，紧接着
`playExternalMediaTrack` 因为「后端不是 external-media」返回 false —— 用户看到「无法在 Chrome 中
开始播放」，真正的原因却是 Folia 自己刚放弃了那个后端。现在按 `sourceRef.kind` 分流：外部媒体
曲目认领 `external-media`（必要时先暂停正在出声的 Folia，复用 `selectExternalMediaBackend`），
其余一律认领 `folia`。两个分支都幂等。

同一次修复还堵住两条同源路径：

- **按播放键**（`usePlaybackTransportController`）：外部媒体曲目在 Folia 里 `audioSrc` 恒为 null，
  走 deck 只会得到 AbortError，且会触发 recovery 去问 Omni 要音频源（必然 `unsupported` 抛出）。
  现在这一类曲目交给 `resumeExternalMediaSong()`：已载着这一首发 `play`（继续），否则发
  `playById(catalogId)`。
- **会话恢复**（`restorePlaybackSource`）：恢复时把曲目放回屏幕（封面 + AMLL 歌词），
  **不**进在线取流路径，也**不**自动 `playById`（恢复不等于开始播放）。

## 命令面：绝不透传 next / previous

`MediaCommand = play | pause | toggle | seek | playById`（实际形状是
`ElectronExternalMediaCommandName`，见 `src/vite-env.d.ts`）。
**没有 `next` / `previous`，没有任何 queue 动词**，且这条规则有单测锁死：

- "下一首"由 Folia 解析成 `playById(下一首)` 再下发（`usePlaybackQueueController.handleNextTrack`）；
- `loopMode === 'one'` 重新下发**当前**曲目；
- 若把 next 透传给网页播放器，它会按**它自己**的内部队列续播，与 Folia 的 queue 争夺控制权。

失败永远是**值**（`{ok, errorKind}`），不是 reject；`handleExternalMediaAction` 在通道未就绪时返回
`true`（take-and-drop），Folia 自己的 `<audio>` 不会因此自动开播。

## 分段权威：queue 对账推进

外部播放器没有 Folia 的音频元素，`onEnded` 永不触发——切歌信号只能来自观察层对账。
实现分两层（`src/utils/externalMediaQueueAdvance.ts` 纯决策 + `src/hooks/useExternalMediaQueueAdvance.ts`
接线），判定链：

1. **自然结束**：观察进结尾邻域（`durationMs - positionMs ≤ 1500ms`）且仍 Playing → 推进
   （loop 'one' 为 `repeat`，其余交给 `handleNextTrack`）。
2. **曲末抢占（E5-A，已接受）**：网页播放器在曲末会自动播它自己的下一首。若**两次观察之间身份
   真的变了**（`isSameObservedTrack(prev, now) === false`）且上一帧停在结尾邻域 → 这次变化是
   "播放器自己走了"，Folia 下发 `playById` 抢回。代价：最后 1.5 秒里的手动跳过会被当成自然结束。
3. **派发时间窗**（`EXTERNAL_MEDIA_DISPATCH_WINDOW_MS = 5000`）：Folia 刚下发过播放的 5 秒内，
   非 `in-sync` 的对账结论一律 `hold`——观察层还停在旧曲目上，此时 `drifted` 会把索引同步回旧
   曲目、`take-over` 会放弃权威，两者都撤销 Folia 刚做出的推进。
4. **窗口外的手动操作 = 用户接管**（分段权威的"分段"边界）：目标在 queue 内 → `sync-index`
   （索引跟随事实，不"纠正"回去）；在 queue 外 → `take-over`，Folia 退出 queue 推进并提示
   （"已由 Apple Music 网页版接管播放"）。回到 `in-sync` / `sync-index` 后才允许再提示。

身份匹配是宽松的（title 归一 + artist 缺失或互相包含，`isSameObservedTrack`）：误判"同一首"只是
索引停在原地（下一帧再判），误判"不同首"会让 Folia 误弃权威——代价不对称。

## 功能开关（默认关）与设置面板

**设置 → 外部媒体**（`ExternalMediaSettingsSubview.tsx`，桌面限定）：

- 启用开关（默认关）：主进程在关着时**根本不创建**两个桥（无 helper 进程、无 32110 端口），
  状态闸在 `buildExternalMediaStatus()` 单一入口。
- loopback 地址（`ws://127.0.0.1:32110`）+ 扩展令牌展示/复制/轮换。轮换立即生效：旧令牌作废、
  扩展断连，需把新令牌填回扩展（动作经确认弹窗，且刻意不给 `executeShortcut`）。
- 连接状态：复用六态阶梯的同一组判据与文案。

命令面板三条（`settings` 组，en/zh-CN/in 三语齐全）：`settings-external-media`（打开面板）、
`external-media-toggle`（开关）、`external-media-regenerate-token`（轮换令牌）。

## 可用性六态（E2）

`ExternalMediaAvailability = ready | extension-missing | tab-not-found | player-not-ready |
not-signed-in | storefront-mismatch | unavailable`（`src/utils/externalMediaStatus.ts`）。每一态对应
**不同的用户动作**（装扩展 / 开网页 / **刷新页面** / 登录 / 换区），所以必须分开表达。判定顺序承重：
桥不可达优先于一切；扩展没连上时 tab/登录/storefront **不可知**而不是"没满足"（`null` ≠ `false`）。
功能开关关闭时直接 `unavailable`，排在阶梯之前。

`player-not-ready` 是 2026-09-23 补的第六态，代价是一次真实的误诊：扩展的 content script 跑在
Chrome 的**隔离世界**，读不到页面主世界的 `window.MusicKit`，于是每一帧观察都是 `player-declined`；
而当时的阶梯把"有 tab 但播放器读不到"与"没有 tab"合并成 `tab-not-found`，UI 让用户去打开一个
**已经开着的**标签页。两者的动作不同：一个是"去开页面"，一个是"刷新那个页面"。

判据来自扩展观察帧自己的 `connected`（经主进程摊平成 `pageReady`），与 SMTC 的 `connected`
（Windows 是否看得到 Chrome 的媒体会话）是两件事，`null`（扩展还没报告）不等于 `false`。

## 观察通道与保守契约

helper 以 JSONL 事件流（`watch`）+ 单发命令（`command`）的形态被 `externalMediaSmtcBridge.cjs`
监督；位置是**整秒量化**的（测量自 Windows SMTC 面），歌词时钟因此保留校正层
（`utils/externalMediaClock*.ts`，E6 决定先保留）。观察里**不携带 sourceRef**；观察是否属于
Folia 的 queue 由对账层判定，判定之前观察不被信任。

已测量的保守事实（详见 `apple-music-lyric-clock.md`）：helper 的 `seek` 在目标应用不支持
`IsPlaybackPositionEnabled` 时会被拒绝——时钟同步为此有"主动对齐失败回退被动跟随"的降级。

## 配置与故障排查

| 项 | 位置 |
| --- | --- |
| 功能开关 / 令牌持久化 | 主进程 settings store（`EXTERNAL_MEDIA_ENABLED` / `EXTERNAL_MEDIA_TOKEN`） |
| AUMID 匹配 | `FOLIA_EXTERNAL_MEDIA_SMTC_MATCH`（默认 `Chrome`，大小写不敏感子串） |
| helper 路径 | `FOLIA_APPLE_MUSIC_SMTC_HELPER_PATH`（默认 `resources/folia-apple-music-smtc-helper.exe`） |
| loopback 端口 | 32110（`DEFAULT_EXTERNAL_MEDIA_PORT`） |

扩展的装载与配对见 `chrome-extension/README.md`。诊断面板：开发者设置里的 SMTC 面板
（`ExternalMediaSmtcPanel.tsx`）直接显示观察状态与命令往返结果。

已知边界（刻意不做的）：

- 不支持多外部播放器实例并存的 UI（架构上第二个播放器只需换 `--match` 与扩展目标，但无设置项）。
- queue 外接管时只有 toast 提示，无常驻"当前由网页版控制"标记（follow-up）。
- SMTC 子串匹配也会看见 Chrome 里的非 Apple 媒体（SMTC 不暴露 URL），由对账层过滤。
