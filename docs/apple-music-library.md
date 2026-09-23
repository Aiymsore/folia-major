# Apple Music 内容源

本文说明 Folia 如何读取用户的 Apple Music 资料库，以及为什么这样分层。

**结论先行**：能读歌单、能显示封面、能进 Folia 的 GridView 特色界面；
**API 拿不到全曲音频**（只有 90 秒试听流），这是 DRM 的硬边界，不是实现缺陷。
**播放因此不走 API**：外部媒体后端让 Chrome 里的 `music.apple.com` 网页播放器放全曲
（见 `docs/external-media-backend.md`）；90 秒试听路径已随之整体删除（`previewUrl` 不复存在）。

---

## 一、能力边界（先读这一节，它决定其它一切）

| 能力 | 状态 |
| --- | --- |
| 读取用户资料库歌单 / 专辑 / 歌曲 | ✅ 桌面版 |
| 读取公开目录歌单 / 搜索 | ✅ 全平台（无需账号） |
| 封面、GridView、3D 网格、歌词板、visualizer | ✅ 全部照常 |
| 播放（全曲） | ✅ 经**外部媒体后端**（Chrome 网页播放器，需四个前置条件，默认关闭） |
| API 音频流 | ⚠️ **仅 90 秒试听**（AAC，实测 ~90.02s / 265kbps）——Folia 已不使用 |
| 完整歌曲（API 内） | ❌ FairPlay/PlayReady DRM，只能在 Apple 自己的播放路径里解 |
| 逐字歌词 | ⚠️ 走 AMLL TTML DB 的 `am` 平台，按**目录 id** 索引 |

**全曲的两条合法出口**：外部媒体后端（首选，Folia 继续持有 queue 与 UI），以及唤起
Apple Music 应用/网页的深链兜底（`music://` / `itms://` / `music.apple.com` 的 AppUriHandler，
`openExternalUrl()` 一跳就过去）。

注意：**付费的 MusicKit developer token 同样拿不到完整音频**，所以「正规化」只解决合规，
不解决能力。这条结论来自 Apple 自己的文档与开发者论坛，不是我们的取舍。

---

## 二、凭据模型

### 为什么不用 DPAPI 逆向

最初的方案是解密 Windows 版 Apple Music 的 WebView2 cookie 库
（`%LOCALAPPDATA%\Packages\AppleInc.AppleMusicWin_*\LocalState\EBWebView\Default\Network\Cookies`）。

**实测结论：这条路已经死了。** 该 cookie 库最后写入是 2026-05-21，而应用此后一直在正常使用
（封面缓存更新到 9 月）——说明新版 Apple Music **不再用这个 profile 认证**。解出来的
`mt-tkn-*` token 打 `/v1/me/library/playlists` 返回 `403 Invalid authentication`，因为
配套的 `amp` cookie 早在 2026-06-20 就过期了。DPAPI 本身能解（`Local State` 的
`os_crypt.encrypted_key` → AES-GCM），但解出来的是**死凭据**。

### 现在的方案：Electron 自己的 session

不用逆向任何东西。`session.fromPartition('persist:folia-apple-music')` 开一个 Folia 拥有的
窗口指向 `music.apple.com`，用户登录一次，然后 `ses.cookies.get()` **直接返回明文 cookie**。

- 用户密码从不经过 Folia，也没有任何密码表单
- `persist:` 前缀是**承重**的：Electron 里裸分区名是内存态，不加就会每次重启丢失登录，
  把用户永远送回登录页
- 登录完成后窗口自动关闭，并通过 `apple-music-library-status-changed` 通知渲染层刷新

### developer token

公开目录与资料库请求都需要一个 developer token。它内嵌在 `music.apple.com` 的
web player bundle（`/assets/index~*.js`）里，实测抓到的签发方是 `AMPWebPlay`，有效期约 70 天。

按 `exp` 缓存到过期前一小时，401 时强制重抓一次。这是 Apple 的**共享**配额，批量操作会 429，
因此 `throttled` 是一个显式错误种类而不是空结果。

---

## 三、分层（关键，别破坏）

Apple Music **不是第四个 Omni provider**。`src/types/playbackBackend.ts` 已经把这条规则写进类型：
它是 playback backend，没有 `providerId`、不产生 `UnifiedSong`、不消费 `activeProviderId`。

读资料库是**内容源**问题，所以照 `navidromeService` 的先例做：

```text
UI (AppleMusicGrid3DView / GridView)
  -> src/services/appleMusicService.ts        renderer 边界，归一化成 Folia 形状
       -> window.electron.appleMusicLibrary*  IPC
            -> electron/appleMusicLibraryBridge.cjs   传输 + 归一化（可单测）
                 -> Electron session partition（凭据）
                 -> amp-api.music.apple.com（数据）
```

`GridViewOverlayHost` 用**已有的** `externalTracks` 通道接入，`GridView` 一行没改 —— 这正是
local / navidrome 当初的接法。

`PlaybackSourceRef` 新增了 `{ kind: 'apple-music' }`。刻意不是 `online`（没有 provider 可路由，
给了会让 `omni` 声称拥有一首它取不到的歌），也不是 `local`（字节来自 Apple CDN，而 `local`
在别处一律指「本机文件」）。

---

## 四、实测出来的四个坑（都有回归测试）

这四个都是跑真实账号才暴露的，写错任何一个功能都会静默失效：

1. **cookie 名是 `media-user-token`，不是 `mt-tkn-` 前缀。**
   只看旧前缀会把已登录的账号判成「未登录」。现在两种都接受。

2. **资料库行没有 `previews` 数组。**
   资料库曲目 id 形如 `a.1538098094`，且**完全没有 `previews` 字段**，所以资料库歌单单靠
   资料库响应是无法播放的。唯一出路是拿 `attributes.playParams.catalogId` 去目录端点换。
   **不能用 `resource.id` 兜底**：`a.1538098094` 打目录会 404，会把每一首都变成不可播。

3. **`itspod` cookie 是数字 storefront id（中国区是 `43`），不是 ISO 码。**
   直接透传得到 `400 Unknown storefront '43'`，而这一步正是让资料库曲目变得可播的请求 ——
   会静默废掉整个资料库的播放。桥接层负责映射成 `cn`。

4. **`?ids=` 批量查询不能带 `limit`。**
   带上就是 400，一个都解析不出来。单曲查询不受影响，所以很容易漏掉。
   实测 25/25 全部解析出试听。

另外两条实测数据：
- 试听实测 **90.02 秒**、AAC 265kbps，`?extend=30s` **无效**
- Apple 自己的歌词接口对第三方关闭（`?include=lyrics` 返回的 relationships 只有 `albums/artists`），
  所以逐字歌词只能走 AMLL TTML DB 的 `am` 平台，且必须用**目录 id**（`/am/1468058171` 有数据，
  资料库 id 没有）

---

## 五、平台差异

| 平台 | 行为 |
| --- | --- |
| 桌面版 | 完整功能（登录 + 资料库 + 目录 + 试听） |
| Web / Docker | `isAppleMusicLibraryAvailable()` 返回 false，入口不出现；渲染「仅桌面版可用」 |

浏览器的构建里没有 `window.electron`，也就没有 cookie jar，资料库在构造上不可能实现。
所以这里选择**明确不可用**，而不是显示一个空资料库让用户以为音乐丢了。

---

## 六、代码地图

| 文件 | 职责 |
| --- | --- |
| `electron/appleMusicLibraryBridge.cjs` | 传输、凭据、归一化；副作用全部注入，可直接单测 |
| `electron/main.cjs` | 登录窗口、IPC handler（含 operation 白名单） |
| `electron/preload.cjs` | `appleMusicLibrary*` 桥面 |
| `src/services/appleMusicService.ts` | renderer 边界：类型、深链、`SongResult` 转换（试听解析已删） |
| `src/components/app/home/AppleMusicGrid3DView.tsx` | 首页面（仿 `NavidromeGrid3DView`） |
| `src/components/app/home/useAppleMusicGridLibrary.ts` | 该页面的请求与登录状态 |
| `src/components/app/home/gridViewCollectionAdapters.ts` | `apple-music` collection descriptor + 曲目解析 |
| `src/hooks/usePlaybackQueueController.ts` | `playSong` 的 Apple Music 分支、队列可播判定 |
| `src/hooks/useLibraryPlaybackController.ts` | `onPlayExternalMediaSong`：外部媒体后端播放 + 歌词 |

测试：`test/unit/electron/appleMusicLibraryBridge.test.ts`（28）、
`test/unit/services/appleMusicService.test.ts`（13）。

---

## 七、验证方式

桥接层可以用真实账号端到端验证，且**不碰用户自己的 Folia profile**：把已登录的 partition 连同
`Local State`（cookie 加密密钥在里面，单独拷 partition 不够）复制到一个隔离的 `userData`，
用 `app.setPath('userData', ...)` 指过去，再驱动**生产模块**跑一遍全部操作。

实测输出：

```text
[1] getStatus -> { signedIn: true, storefront: "cn" }
[2] getLibraryPlaylists -> ok items=5
[3] getLibraryAlbums -> ok items=10 hasMore=true total=230
[4] getLibrarySongs -> ok items=5 hasMore=true total=268
[5] getLibraryPlaylistTracks -> ok items=25
[6] getCatalogSongsByIds -> ok songs=25 ; 25/25 have previews
[7] preview stream -> HTTP 200, 977255 bytes, audio/x-m4p
[8] getCatalogPlaylist (public) -> ok tracks=50
```
