import type { SongResult } from '../types';
import { readAppleMusicSongPayload } from '../services/appleMusicService';
import { getPlaybackSongKey } from './appPlaybackGuards';

// src/utils/externalMediaQueueReconcile.ts
// 「Folia 的 queue」与「外部播放器实际在放什么」之间的**对账**：纯函数层，不依赖 React、不依赖
// store、不读时钟，因此分段权威策略的每一条都能被穷举断言。
//
// ── 为什么需要这一层（本次重构最硬的约束）──────────────────────────────────────
//
// Folia 原生的自动切歌信号是 `<audio>` 元素的 `onEnded`。外部播放器**没有 Folia 的音频元素**，
// 所以那个事件永远不会触发 —— queue 推进会彻底停摆。这是"Folia 自己维护 queue"这句话在工程上
// 真正的难点：不是 queue 数据结构，而是**切歌信号的来源**。
//
// 替代信号只能来自观察：位置到达时长、或观察到的曲目身份变了。两者都比一个精确事件粗糙，
// 因此必须把"这次变化意味着什么"显式建模，而不是在 effect 里堆 if。
//
// ── 分段权威（segmented authority，已确认采用）────────────────────────────────
//
// 只有 Folia 自己下发的播放才认为 queue 有效；此外的一切外部操作都视为"用户接管了播放器"，
// Folia 退出 queue 推进。三种判定结果：
//
//   in-sync        观察到的曲目 == Folia queue 的当前项 → 正常，queue 权威仍在 Folia
//   drifted        身份变了，且变到了 queue 里的**另一项** → 用户手动切到了队列内的歌
//   taken-over     身份变了，且**不在 queue 里** → 用户接管（点了别的歌、或播放器自己跳了）
//
// 刻意不做的判定：把"位置回绕到 0"当成切歌。暂停后拖动进度条也会回绕，那不是切歌。

/** 观察到的曲目身份，归一化成对账需要的形状。 */
export type ObservedTrackIdentity = {
    title: string;
    artist: string | null;
};

export type QueueReconcileVerdict =
    /** 观察到的曲目就是 queue 的当前项：Folia 仍然拥有权威，正常推进。 */
    | { kind: 'in-sync'; queueIndex: number }
    /**
     * 观察到的曲目在 queue 里，但不是当前项 —— 用户在网页里手动跳到了队列内的另一首。
     * 采用分段权威后这**不**被"纠正"回去，而是把 queue 索引同步到事实。
     */
    | { kind: 'drifted'; queueIndex: number }
    /** 观察到的曲目不在 queue 里（或没有观察结果）：用户接管了播放器，Folia 停止推进 queue。 */
    | { kind: 'taken-over'; reason: 'not-in-queue' | 'no-observation' };

/**
 * 归一化用于比较的字符串。
 *
 * 大小写、首尾空白、以及成串空白都要抹平：SMTC 与扩展上报的元数据来自不同层（OS 会话元数据 vs
 * 页面 MusicKit 对象），实测同一首歌在两处的空白与大小写并不总是一致。不归一化会产生
 * "看起来是同一首歌但对账失败"的假性接管。
 *
 * 刻意**不**做 Unicode 规范化与标点折叠：那会让"Live 版"与"录音室版"这类真实不同的曲目
 * 互相匹配，把假性接管换成了更糟的假性同步。
 */
const normalizeForCompare = (value: string | null | undefined): string => (
    (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
);

/** 从 Folia 的 SongResult 里取用于对账的身份。 */
export const getQueueSongIdentity = (song: SongResult | null | undefined): ObservedTrackIdentity | null => {
    if (!song) return null;
    const title = (song.name ?? '').trim();
    if (!title) return null;
    const artist = song.artists?.map(entry => entry.name).filter(Boolean).join(', ') ?? '';
    return { title, artist: artist.trim() || null };
};

/**
 * 两首歌是否**可能是同一首**。
 *
 * 判据刻意宽松到"title 相同 + artist 有一方缺失或包含关系"：这是对账，不是去重。
 * 对账的代价是不对称的 —— 误判成"同一首"只是让 queue 索引停在原地（下一次观察会再判一次），
 * 而误判成"不同首"会让 Folia 误以为用户接管了播放器并停止推进 queue，那是用户可见的功能中断。
 *
 * 因此宁可宽松：`getPlaybackSongKey` 那套精确身份用于**去重与队列编辑**，那里误判的代价相反。
 */
export const isSameObservedTrack = (
    left: ObservedTrackIdentity | null,
    right: ObservedTrackIdentity | null,
): boolean => {
    if (!left || !right) return false;
    if (normalizeForCompare(left.title) !== normalizeForCompare(right.title)) return false;

    const leftArtist = normalizeForCompare(left.artist);
    const rightArtist = normalizeForCompare(right.artist);
    // artist 缺失时只按 title 判：SMTC 的 artist 常为空，而扩展上报的通常有值 ——
    // 要求两者都有值才能匹配会让"恰好缺 artist"的观察全部对不上。
    if (!leftArtist || !rightArtist) return true;
    return leftArtist === rightArtist || leftArtist.includes(rightArtist) || rightArtist.includes(leftArtist);
};

/**
 * 对账：把「观察到的曲目」与「Folia 的 queue + 当前项」比对，得出权威归属。
 *
 * 参数刻意都是纯值（queue 数组 + 观察身份），不含 store 引用，因此可以被穷举单测。
 *
 * `observed === null`（没有观察结果、或观察层还没就绪）返回 `taken-over / no-observation`：
 * **不知道不等于同步**。把它当成 in-sync 会让 queue 在一个坏掉的观察通道上继续盲推。
 */
export const reconcileExternalMediaQueue = (input: {
    queue: SongResult[];
    currentSong: SongResult | null;
    observed: ObservedTrackIdentity | null;
}): QueueReconcileVerdict => {
    const { queue, currentSong, observed } = input;

    if (!observed) {
        return { kind: 'taken-over', reason: 'no-observation' };
    }

    const currentIndex = currentSong
        ? queue.findIndex(song => getPlaybackSongKey(song) === getPlaybackSongKey(currentSong))
        : -1;

    // 先看当前项 —— 这是绝大多数观察的归属，先判它可以让常见路径只做一次比较。
    const currentIdentity = getQueueSongIdentity(currentSong);
    if (isSameObservedTrack(currentIdentity, observed)) {
        return { kind: 'in-sync', queueIndex: currentIndex };
    }

    // 再在整个 queue 里找。找到说明用户手动跳到了队列内的另一首。
    for (let index = 0; index < queue.length; index += 1) {
        if (isSameObservedTrack(getQueueSongIdentity(queue[index]), observed)) {
            return { kind: 'drifted', queueIndex: index };
        }
    }

    return { kind: 'taken-over', reason: 'not-in-queue' };
};

/**
 * 该曲目能否被外部媒体后端播放（即能否解析出 `playById` 需要的 catalogId）。
 *
 * 这是 queue 可播判定的外部媒体分支：旧实现要求 `previewUrl` 存在（90 秒试听路径），
 * 那条路已删除。现在要求 catalogId —— 资料库上传曲目没有目录条目，因此**不可播**，
 * 这与试听时代的行为一致（那时它也没有 previewUrl），但原因不同且更本质：
 * 没有 catalogId 就没有任何方式让网页播放器定位到它。
 */
export const resolveExternalMediaPlayableId = (song: SongResult | null | undefined): string | null => {
    const payload = readAppleMusicSongPayload(song);
    if (!payload) return null;
    // 目录 id 优先：`playById` 要求的是 Apple Music 目录 id，而资料库行给的是 `a.<n>`，
    // 后者打目录会 404（见 docs/apple-music-library.md 的实测记录）。
    return payload.catalogId || payload.externalMediaId || null;
};

/** 该曲目是否可播。与 `resolveExternalMediaPlayableId` 同源，避免两处判据漂移。 */
export const isExternalMediaQueueSongPlayable = (song: SongResult | null | undefined): boolean => (
    resolveExternalMediaPlayableId(song) !== null
);
