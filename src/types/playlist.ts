import type { MediaId, PlaybackSourceRef } from './onlineMusic';

// src/types/playlist.ts
// 跨来源歌单条目（`LocalPlaylist.entries`）与便携歌单文件的持久化形状。
//
// 只存三样东西：身份（`sourceRef`）、最小可回放字段、展示元数据。刻意不存的：
//   * 临时音频 URL（Navidrome `streamUrl`、provider 预签名 URL）——会过期，回放时由
//     `navidromeApi.getStreamUrl` / `omni.getAudioSource` 现取；
//   * provider 原始响应对象——各 adapter 的回退参数收在 `sourceRef.providerData`
//     （KuGou 的 hash/albumId/albumAudioId/fileId、QQ 的 songMid/mediaMid/songId），
//     它是 `PlaybackSourceRef` 契约的一部分，不是原始载荷。
// 最小可回放字段契约由 `test/unit/onlineMusic/minimalReplayFields.test.ts` 锁定。

/** Navidrome 侧只留回放与展示需要的子集；`streamUrl` 回放时现算。 */
export interface PlaylistNavidromeRef {
    id: string;
    suffix?: string;
    coverArtUrl?: string | null;
    albumId?: string | number;
    artistId?: string | number;
}

/**
 * external-media（Apple Music 网页播放器）条目：`playById` 需要 catalogId。
 * 没有 catalogId 的资料库上传曲目不可回放，按「不可回放条目不入歌单」在保存时剔除。
 */
export interface PlaylistExternalMediaRef {
    externalMediaId: string;
    catalogId: string;
    /** music.apple.com 的稳定歌曲页链接（扩展断开时的深链兜底），不是流地址。 */
    url?: string | null;
    hasLyrics?: boolean;
}

export interface PlaylistEntry {
    /** 身份与 provider 路由；online 分支携带 providerData（回放所需的 provider 侧参数子集）。 */
    sourceRef: PlaybackSourceRef;
    name: string;
    artistNames: string[];
    albumName?: string;
    durationMs: number;
    coverUrl?: string | null;
    /** 重建 `SongResult.id` 用（local 为曲库数值 id，online 为 provider id 的原始形态）。 */
    id?: MediaId;
    /** local：曲库内 UUID，回放按它取 LocalSong。 */
    localSongId?: string;
    /** local：可移植路径提示（换机导入时按路径/标题匹配）。 */
    localPath?: string;
    externalMedia?: PlaylistExternalMediaRef;
    navidrome?: PlaylistNavidromeRef;
}

export const PORTABLE_PLAYLIST_FORMAT = 'folia-playlist' as const;
export const PORTABLE_PLAYLIST_FORMAT_VERSION = 1;

/** 便携歌单文件（`.json`）的信封。条目损坏时整体拒绝，逐条坏数据由解析层跳过并计数。 */
export interface PortablePlaylistFile {
    format: typeof PORTABLE_PLAYLIST_FORMAT;
    formatVersion: number;
    name: string;
    exportedAt: number;
    entries: PlaylistEntry[];
}
