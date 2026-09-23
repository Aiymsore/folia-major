import { useEffect } from 'react';
import type { LyricData } from '../types';
import { useActivePlaybackBackendStore } from '../stores/useActivePlaybackBackendStore';
import { useExternalMediaLyricsStore } from '../stores/useExternalMediaLyricsStore';
import { useExternalMediaStore } from '../stores/useExternalMediaStore';
import { autoMatchBestLyric } from '../utils/lyrics/autoMatchBestLyric';
import { hasExternalMedia } from '../utils/externalMediaStatus';
import { getExternalMediaTrackKey } from '../utils/externalMediaLyricTrackKey';
import { createLyricsSetter } from '../components/app/playback/createLyricsSetter';

// src/hooks/useExternalMediaLyricsController.ts
// Apple Music 后端的歌词装载控制器：曲目变化 → 跨 provider 匹配 → 走 Folia 同一条显示管线 → 入账。
//
// 三段职责，刻意分开：
//   1. 身份（utils/externalMediaLyricTrackKey.ts）：由 SMTC 元数据派生稳定键，纯函数、可单测。
//   2. 匹配（utils/lyrics/autoMatchBestLyric.ts）：Folia 手动歌词匹配用的就是这套跨 provider 编排，
//      Apple Music 只是把「元数据」换成 SMTC 的 title/artist/album/durationMs。不新增第二套匹配规则。
//   3. 显示处理（components/app/playback/createLyricsSetter.ts）：过滤 → staff 策略 → chorus →
//      逐词切分 → render hints。通过注入 setter 复用同一条管线，**不复制**。
//
// 竞态防护与 SMTC 订阅同源：迟到的匹配结果由 store 的 key 守卫（commitLyrics）丢弃。

/**
 * 一次匹配的结果，收窄成控制器需要知道的形状。
 *
 * 刻意不直接依赖 `AutoMatchBestLyricResult`：控制器只关心「有歌词 / 纯音乐 / 没匹配到」三态，
 * 而这三态是最容易被写歪的地方（把纯音乐当成匹配成功就会显示一份不存在的歌词）。
 */
export type ExternalMediaLyricMatchResult =
    | { kind: 'matched'; lyrics: LyricData }
    | { kind: 'pure-music' }
    | { kind: 'none' };

/**
 * 匹配实现。默认是 Folia 手动歌词匹配用的那套跨 provider 编排（`autoMatchBestLyric`），
 * 可注入以便在不联网的环境里锁定控制器行为。
 */
export type ExternalMediaLyricMatcher = (input: {
    title: string;
    artist: string;
    album: string | null;
    durationMs: number | null;
}) => Promise<ExternalMediaLyricMatchResult>;

/**
 * 匹配输入：SMTC 元数据 → 编排需要的形状。纯函数，因此「空 album 与缺失 duration 怎么处理」
 * 可以被直接断言，而不必让测试去碰网络。
 *
 * 两条归一化规则都是实测驱动的：
 *   * `AlbumTitle` 常为空（helper README 记录了这一点）。空串要变成 `null`，再在调用编排时整个
 *     丢掉 —— 否则会拿一张"叫空字符串的专辑"去打分。
 *   * `durationMs` 缺失时给 0，让编排的时长归一化自己决定「无时长可比」（它内部会把 0 视为不可用）。
 */
export const buildExternalMediaMatchInput = (metadata: {
    title: string;
    artist: string;
    album: string | null;
    durationMs: number | null;
}): { title: string; artist: string; album: string | null; durationMs: number | null } => ({
    title: metadata.title.trim(),
    artist: metadata.artist.trim(),
    album: (metadata.album ?? '').trim() || null,
    durationMs: metadata.durationMs,
});

/**
 * 交给跨 provider 编排的选项。纯函数，因此「Apple Music 这条路要求行级兜底」可以被直接断言。
 *
 * `acceptLineLevelLyrics` 是 Apple Music **必需**的一项，而不是可选优化：Folia 自己的播放路径在
 * 自动匹配之后还有 `omni.getLyrics(song)` 兜底，所以只有普通 LRC 的歌照样能显示；Apple Music 的
 * 曲目不在任何 provider 目录里，没有那条兜底。不开这个开关时，那些歌会被逐个来源跳过、
 * 最终返回 null —— 表现就是「有些歌完全没有歌词」。
 *
 * 注意它放宽的是**时间粒度**（逐字 → 行级），不是**曲目身份**：候选仍然要过同一套标题/艺术家/
 * 时长打分与 `AUTO_MATCH_MIN_SCORE`。
 */
export const buildExternalMediaMatchOptions = (album: string | null) => ({
    ...(album ? { album } : {}),
    acceptLineLevelLyrics: true,
});

/**
 * 默认匹配器：把 SMTC 元数据交给 `autoMatchBestLyric`。
 *
 * Apple Music 没有 provider id，因此这里只给它元数据 —— 这正是那条编排本来就接受的输入
 * （Netease → AMLL → QQ → Kugou，word-by-word 优先，时长/标题/艺术家打分）。
 */
export const matchExternalMediaLyrics: ExternalMediaLyricMatcher = async (input) => {
    const result = await autoMatchBestLyric(
        input.title,
        input.artist,
        input.durationMs ?? 0,
        buildExternalMediaMatchOptions(input.album),
    );

    if (!result) return { kind: 'none' };
    if ('isPureMusic' in result && result.isPureMusic) return { kind: 'pure-music' };
    return { kind: 'matched', lyrics: result.lyrics };
};

export type ExternalMediaLyricsControllerOptions = {
    /** 匹配实现。默认走跨 provider 自动匹配；单测里替换成固定结果。 */
    match?: ExternalMediaLyricMatcher;
};

/**
 * 把 Apple Music 歌词装进 useExternalMediaLyricsStore。
 *
 * 生命周期三条：
 *   * backend 离开 apple-music → `reset()`，store 回到 idle，`useDisplayLyrics` 随之回落到 Folia。
 *   * 曲目变化（或 backend 进入 apple-music）→ `beginTrack()` 原子清空并进入 loading。
 *   * 匹配返回 → 跑显示管线 → `commitLyrics()`；key 不匹配即丢弃，迟到的结果绝不覆盖新曲目。
 *
 * 刻意不做的事：不写 usePlaybackStore、不碰 queue/audio/currentSong、不改 activeBackend。
 */
export const useExternalMediaLyricsController = (options: ExternalMediaLyricsControllerOptions = {}): void => {
    const match = options.match ?? matchExternalMediaLyrics;
    const backend = useActivePlaybackBackendStore(state => state.activeBackend);
    const status = useExternalMediaStore(state => state.status);

    const hasMedia = hasExternalMedia(status);
    const trackKey = hasMedia
        ? getExternalMediaTrackKey(status?.sourceAppUserModelId ?? null, status?.title ?? null, status?.artist ?? null)
        : null;
    // 归一化只做一次，并把**标量**放进 effect 依赖：SMTC 快照每轮轮询都会换对象引用，
    // 若依赖里放对象，位置每跳一秒就会重跑一次匹配。归一化后的三个字符串是稳定的。
    const {
        title: matchTitle,
        artist: matchArtist,
        album: matchAlbum,
        durationMs: matchDurationMs,
    } = buildExternalMediaMatchInput({
        title: status?.title ?? '',
        artist: status?.artist ?? '',
        album: status?.album ?? null,
        durationMs: status?.durationMs ?? null,
    });

    useEffect(() => {
        const store = useExternalMediaLyricsStore.getState();

        if (backend !== 'external-media') {
            store.reset();
            return;
        }

        if (!trackKey) {
            // 是 Apple Music，但没有可匹配的曲目：清掉上一首的歌词并进入 no-media，
            // 绝不让旧歌词挂在新身份上。
            store.beginTrack(null, 'no-media');
            return;
        }

        let cancelled = false;
        store.beginTrack(trackKey, 'loading');

        const commit = (lyrics: LyricData | null) => {
            useExternalMediaLyricsStore.getState().commitLyrics(trackKey, lyrics ? 'ready' : 'empty', lyrics);
        };

        void match({ title: matchTitle, artist: matchArtist, album: matchAlbum, durationMs: matchDurationMs })
            .then(result => {
                if (cancelled) return;
                if (result.kind !== 'matched') {
                    commit(null);
                    return;
                }
                // 显示管线在这里跑：与 Folia 完全相同的一条（过滤 → staff → chorus → 逐词切分 →
                // render hints），只是终点换成本 store。两个注入点的取值即「这条管线不认识 Folia」：
                //   * resolveSong 返回 null —— Apple Music 伪曲目不在 usePlaybackStore 里；
                //   * resolveStoredLyrics 返回 null —— 没有 provider 侧原文歌词，于是 chorus 走
                //     **文本频率检测**那条分支（分支被真实走到，而不是被跳过）。
                const apply = createLyricsSetter(
                    (next) => {
                        const resolved = typeof next === 'function' ? next(null) : next;
                        commit(resolved);
                    },
                    '',
                    undefined,
                    undefined,
                    {
                        resolveSong: () => null,
                        resolveStoredLyrics: () => null,
                    },
                );
                apply(result.lyrics);
            })
            .catch(() => {
                if (cancelled) return;
                commit(null);
            });

        return () => {
            cancelled = true;
        };
    }, [backend, trackKey, matchTitle, matchArtist, matchAlbum, matchDurationMs, match]);
};
