<p align="center">
  <img src="https://github.com/user-attachments/assets/b5d0e863-48be-497b-b0e9-4bd8d8ce9bf0" alt="Folia" width="100%" />
</p>

<div align="center">
<a href="https://trendshift.io/repositories/71740?utm_source=repository-badge&amp;utm_medium=badge&amp;utm_campaign=badge-repository-71740" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/repositories/71740" alt="chthollyphile%2Ffolia-major | Trendshift" width="250" height="55"/></a>

# Folia

Lyrics Reimagined // 辞曲新境

> [!IMPORTANT]
> **这是 [chthollyphile/folia-major](https://github.com/chthollyphile/folia-major) 的 fork。**
>
> 本仓库在上游基础上增加了 **Apple Music 播放后端**：把 Apple Music 当作一个显式选择的播放后端，
> Folia 仍然拥有队列和 UI，实际出声的是 Chrome 里的 music.apple.com 网页版播放器。
>
> - **下载请用本仓库的 [Releases](https://github.com/Aiymsore/folia-major/releases)**，
>   不要用上游的下载链接 —— 那是没有 Apple Music 功能的版本。
> - 上游文档站（folia-site.cielaniska.top）讲的是上游版本，对本构建不一定适用；
>   本仓库的 `docs/` 是随代码走的。
> - 原项目版权归上游作者及全体贡献者所有（AGPL-3.0），署名见 [CONTRIBUTORS.md](CONTRIBUTORS.md)。

[![License](https://img.shields.io/github/license/Aiymsore/folia-major)](https://github.com/Aiymsore/folia-major/blob/main/LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
<!-- ALL-CONTRIBUTORS-BADGE:START - Do not remove or modify this section -->
[![All Contributors](https://img.shields.io/badge/all_contributors-35-orange.svg?style=flat-square)](CONTRIBUTORS.md)
<!-- ALL-CONTRIBUTORS-BADGE:END -->

[获取方式](#获取方式)
·
[技术说明](docs/technical.md)
·
[外部媒体后端](docs/external-media-backend.md)

</div>

## 项目简介

Folia是一个以全屏沉浸式歌词播放为核心的在线音乐播放器，支持网易云、酷狗、Navidrome 和本地音乐库，通过智能歌词匹配，AI生成配色主题，以及多种全屏歌词动画为用户提供独特的听歌体验。

提供基于Electron的 windows/ macOS/ Linux 桌面端版本与基于 Node.js 的 Web 版本，支持多平台部署。

如果希望能够在移动设备上使用，或在浏览器上体验，可以选择一键部署到 Vercel 的 Web 版本（见下方「获取方式」），或自行部署到其他支持 Node.js 的平台。

## 展示

![visualizer](./img/visualizer.png)

### 演示视频

https://github.com/user-attachments/assets/af806cf1-f67f-4b88-b2e7-57db507e9e81

https://github.com/user-attachments/assets/fd27f4f0-64b9-4c57-8c3b-10df767f934b

https://github.com/user-attachments/assets/704f195a-2194-434b-86e8-8f36290e5cc4

### 部分主题预览

<table>
  <tr>
    <td width="50%">
      <img src="./img/preview-fume.png" alt="Fume 主题预览" />
    </td>
    <td width="50%">
      <img src="./img/preview-lumi.png" alt="Lumi 主题预览" />
    </td>
  </tr>
  <tr>
    <td align="center"><strong>浮名</strong></td>
    <td align="center"><strong>流光</strong></td>
  </tr>
  <tr>
    <td width="50%">
      <img src="./img/preview-cad.png" alt="Cad 主题预览" />
    </td>
    <td width="50%">
      <img src="./img/preview-pat.png" alt="Pat 主题预览" />
    </td>
  </tr>
  <tr>
    <td align="center"><strong>心象</strong></td>
    <td align="center"><strong>云阶</strong></td>
  </tr>
  <tr>
    <td width="50%">
      <img src="./img/preview-cappella.jpg" alt="群唱 主题预览" />
    </td>
    <td width="50%">
      <img src="./img/preview-tilt.png" alt="Tilt 主题预览" />
    </td>
  </tr>
  <tr>
    <td align="center"><strong>群唱</strong></td>
    <td align="center"><strong>倾诉</strong></td>
  </tr>
    <tr>
    <td width="50%">
      <img src="./img/preview-diorama.png" alt="镜台 主题预览" />
    </td>
    <td width="50%">
      <img src="./img/preview-pendolo.png" alt="时计 主题预览" />
    </td>
  </tr>
  <tr>
    <td align="center"><strong>镜台</strong></td>
    <td align="center"><strong>时计</strong></td>
  </tr>
</table>

不同的歌词动画具有不同的排版氛围和可调参数，让全屏歌词拥有如同文字PV般的丰富视觉效果，同时又能兼顾响应式布局，自动适配不同窗口尺寸。

## 核心能力

| 模块 | 说明 |
| --- | --- |
| 在线搜索与播放 | 搜索歌曲、歌手或专辑后即可播放，并自动加载相关封面与歌词。 |
| 本地音乐支持 | 可导入本地音频文件，在本地安全保存索引信息，不上传文件内容。详细用法见 [本地音乐库管理](docs/local-library-management.md)。 |
| 智能歌词匹配 | 本地歌曲可自动匹配在线歌词与封面，也支持手动修正匹配结果。 |
| 本地歌词文件识别 | 自动加载同目录同名 `.lrc`、`.vtt`、`.ttml`、`.qrc`、`.yrc`、`.krc` 歌词文件，或歌词文件内嵌 LRC 歌词。适配 LDDC 生成的增强型逐字歌词格式。 |
| Now Playing 接入 | 支持通过本机 [Now Playing](https://github.com/Widdit/now-playing-service/) 服务接入外部播放器的歌曲、时间轴与歌词信息，并驱动 Folia 的舞台视图与全屏歌词渲染。 |
| AI 主题生成 | 基于歌曲情绪与歌词内容生成沉浸式背景与视觉参数。 |
| 多端体验 | 提供 Web 部署方式，同时支持桌面端打包分发。 |

## 获取方式

桌面版内置前后端运行环境，适合希望即装即用的用户。

### 一键部署

Web 版本可以自行部署到 Vercel / Cloudflare，部署入口请用本仓库（下面的按钮已经指向本 fork）：

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/Aiymsore/folia-major)

项目也支持一键部署到 Cloudflare，配置方式与 Vercel 一致：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Aiymsore/folia-major)

Vercel 与 Cloudflare 上的 QQ 音乐不再需要额外部署一个常驻 API 实例：把 `VITE_QQ_API_BASE` 填成 `/api/qq`，再配一个 `QQ_SESSION_SECRET`（服务端密钥，**不加 `VITE_` 前缀**）即可。这种形态默认只支持微信扫码登录，且播放前必须先登录；Cloudflare 上可以再绑定一个 Durable Object，增加 QQ 扫码登录方式。完整步骤、平台差异和排错方法见 [QQ 音乐部署指南](docs/qq-music-deployment.md)。

自托管用户可以使用 [Docker Compose 全栈部署](deploy/docker/README.md)。本地音乐目录访问依赖可信 HTTPS 安全上下文，部署文档包含 NAS 反向代理和证书要求。

关于移动端：

目前推荐移动端用户部署 Web 版本/自托管版本之后，通过chrome for android / iOS Safari 创建 PWA应用（也就是将网页应用添加到桌面，Folia web版本支持安装为PWA应用）来使用。

有一定技术的用户可以使用 capacitor 将本项目的web版本打包成为可安装的安卓apk，具体方法可参考示范仓库：[chthollyphile/folia-sonnet](https://github.com/chthollyphile/folia-sonnet)

### 直接下载

- **Windows**: 最新版本的安装包请前往 [本仓库 Releases 页面](https://github.com/Aiymsore/folia-major/releases/latest) 下载。
- **macOS / Linux**: 本 fork 目前只提供 Windows 安装包（Apple Music 后端依赖 Windows SMTC）。
  需要 macOS / Linux 版本请从 [上游仓库](https://github.com/chthollyphile/folia-major/releases/latest)
  获取，但注意上游版本不含 Apple Music 功能。

Linux 包、Wayland / Hyprland 遥控窗和桌面端细节见 [技术与开发说明](docs/technical.md)。

## 文档与开发

本仓库的文档在 `docs/` 下，随代码走：

- [外部媒体后端](docs/external-media-backend.md) —— 本 fork 新增的 Apple Music 后端：拓扑、命令面、保守契约
- [Apple Music 歌词时钟](docs/apple-music-lyric-clock.md) —— 位置量化与校正层的实测依据
- [网页播放器 DRM 调研](docs/apple-music-webplayer-drm-research.md) —— 为什么必须走 Chrome 扩展而不是内嵌播放器
- [Chrome 扩展说明](chrome-extension/README.md) —— 安装与两世界拆分的原因

上游的文档站（folia-site.cielaniska.top）讲的是上游版本，对本构建不一定适用。

部署、环境变量、本地开发、Stage API、常用脚本和技术栈见 [技术与开发说明](docs/technical.md)。

## Sync Server

Folia 提供了可选的官方同步服务端 `sync-server`，用于在多个设备之间同步外观设置与 AI 主题库。服务端由用户自行托管，适合希望跨设备同步配色主题的用户。

支持以下部署方式：

- **Cloudflare Workers / D1**：免服务器运维的 Serverless 部署，推荐使用。
  [![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Aiymsore/folia-major/tree/main/sync-server)
- **Docker**：镜像与 Compose 入口见 [Docker 部署目录](deploy/docker/README.md)。
- **Node.js 自托管**：使用 SQLite，适合本地或不方便使用 Docker 的环境。

环境变量、Token 配置与部署步骤见 [sync-server/README.md](sync-server/README.md)。部署完成后，在 Folia 的“存储设置”中填写服务端地址和 `SYNC_TOKEN` 即可启用同步。

## 本地音乐与匹配说明

Folia 会读取音频文件元数据、同目录歌词和封面，并可通过网易云、QQ 音乐或酷狗音乐补全歌曲信息。自动匹配按网易云、QQ、酷狗依次回退；匹配不准确时，可以手动选择候选、恢复首次导入的本地信息，或进一步合并、拆分艺术家与专辑实体。

完整的导入、重扫、匹配、实体编辑、歌单、缓存和故障排查说明见 [本地音乐库管理](docs/local-library-management.md)。

## Community

加入discord社群，共同交流，获得帮助

[![Discord](https://img.shields.io/discord/1541051241822687232?logo=discord&logoColor=white&label=Join%20our%20Discord)](https://discord.gg/dMDBTHxeKd)

## 贡献者

感谢所有为本项目进行 Issue 提交、Bug 报告、想法建议、测试与代码编写的贡献者，均依据 all-contributors 规范进行统计

由于列表过长，贡献记录请见 [贡献者名单](CONTRIBUTORS.md)。

## 法律与免责声明

本项目在 AI 的广泛协助下开发，因此仍可能存在细微或不易察觉的问题。若给你带来不便，敬请理解。

本项目主要用于展示播放动效、界面设计与相关工程实现。应用中涉及的在线音乐流媒体、歌词、专辑封面及其他内容，其版权均归对应权利人所有。

本仓库及其源代码仅供个人学习、技术交流与非营利测试使用。请勿将其用于商业盈利用途。若因对在线资源的传播、加工或再分发而引发版权纠纷或其他责任，均由使用者自行承担，项目开发者不承担相关责任。

请始终尊重数字版权，并在条件允许时通过官方平台支持正版音乐。

## 致谢

特别感谢以下项目和资源：

- [chenmozhijin/LDDC](https://github.com/chenmozhijin/LDDC)
- [NeteaseCloudMusicApiEnhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)
- [chenglou/pretext](https://github.com/chenglou/pretext)
- [MakcRe/KuGouMusicApi](https://github.com/MakcRe/KuGouMusicApi)
- [paper-design/shaders](https://github.com/paper-design/shaders)
- [yakult-green-tea/qq-music-api](https://github.com/yakult-green-tea/qq-music-api)

本项目接入了 [Apple Music-like Lyrics TTML 逐词歌词库](https://github.com/amll-dev/amll-ttml-db) 以提供高质量的歌词文件，感谢此歌词库的作者和贡献者们。

## 许可证

本项目基于 `AGPL-3.0` 许可证开源。
