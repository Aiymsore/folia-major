import type { Dispatch, SetStateAction, MutableRefObject } from 'react';
import type { LyricData, SongResult } from '../../../types';
import { applyLyricDisplayFilter } from '../../../utils/lyrics/filtering';
import { applyLyricStaffPolicy } from '../../../utils/lyrics/staffCreditsPolicy';
import type { LyricStaffPolicyOptions } from '../../../utils/lyrics/staffCreditsPolicy';
import { ensureLyricDataRenderHints } from '../../../utils/lyrics/renderHints';
import { applyLyricWordSegmentation } from '../../../utils/lyrics/lyricSegmentationRecord';
import type { LyricSegmentationRecord } from '../../../types/lyricSegmentation';
import { getLyricSegmentationRecord } from '../../../stores/useLyricSegmentationStore';
import { applyDetectedChorusEffects, applyNeteaseChorusByTime } from '../../../utils/lyrics/chorusEffects';
import type { NeteaseChorusRange } from '../../../utils/lyrics/chorusEffects';
import { getPlaybackSongKey } from '../../../utils/appPlaybackGuards';

// src/components/app/playback/createLyricsSetter.ts

const getStoredNeteaseLyrics = (song: SongResult | null): LyricData | null => {
    if (!song) return null;
    
    // Navidrome song
    if ((song as any).isNavidrome) {
        if ((song as any).matchedLyricsSource === 'netease' && (song as any).matchedLyrics) {
            return (song as any).matchedLyrics;
        }
        return null;
    }

    // Online song
    if (song.onlineLyricsState) {
        if (song.onlineLyricsState.matchedLyricsSource === 'netease' && song.onlineLyricsState.onlineOverrideLyrics) {
            return song.onlineLyricsState.onlineOverrideLyrics;
        }
    }

    return null;
};

/**
 * `createLyricsSetter` 的可注入项。
 *
 * 存在的理由：这条管线是**显示决策**（过滤 → staff 策略 → chorus → 逐词切分 → render hints），
 * 与「歌词来自哪个 provider」「歌词进哪个 store」无关。Apple Music 后端需要的是同一条管线，
 * 只是终点换成 useExternalMediaLyricsStore、曲目来源换成 SMTC 伪曲目。因此这里把三处
 * provider/store 耦合点做成参数，而不是复制一份管线 —— 复制会产生第二套歌词处理规则。
 *
 * 三个默认值合起来就是原 Folia 行为，逐字节不变。
 */
export type LyricSetterOptions = {
    /**
     * 取当前曲目的方式。Folia 走 `currentSongFullRef`（hydrate 会替换对象，不能闭包捕获）；
     * Apple Music 走它自己的伪曲目 getter。
     */
    resolveSong?: () => SongResult | null;
    /**
     * provider 侧的「原文歌词」兜底（Folia 用它补 NetEase chorus 标记）。
     * 返回 null 时管线照常走文本频率检测那条分支 —— 这是一条真实存在的分支，不是被跳过。
     */
    resolveStoredLyrics?: (song: SongResult | null) => LyricData | null;
    /**
     * 逐词切分记录。Folia 从 useLyricSegmentationStore 现取（歌词到达顺序与记录加载顺序会竞态）；
     * Apple Music 同样现取，因此默认值即正确行为。
     */
    resolveSegmentationRecord?: () => LyricSegmentationRecord | null;
};

// Creates the App-level lyric setter that applies filtering and render-hint normalization.
// The staff-credit policy stays here rather than in the parser: it is a display decision that
// depends on the finished timeline, and the parse/cache layer must not bake it in.
export const createLyricsSetter = (
    setLyricsState: Dispatch<SetStateAction<LyricData | null>>,
    lyricFilterPattern: string,
    currentSongFullRef?: MutableRefObject<SongResult | null>,
    staffOptions?: LyricStaffPolicyOptions,
    options?: LyricSetterOptions,
) => {
    let lastSongId: number | string | null = null;
    let cachedNeteaseChorusRanges: NeteaseChorusRange[] | null = null;
    const resolveSong = options?.resolveSong ?? (() => currentSongFullRef?.current ?? null);
    const resolveStoredLyrics = options?.resolveStoredLyrics ?? getStoredNeteaseLyrics;
    const resolveSegmentationRecord = options?.resolveSegmentationRecord ?? getLyricSegmentationRecord;

    return (nextLyrics: LyricData | null) => {
        const currentSong = resolveSong();
        const currentSongId = currentSong ? getPlaybackSongKey(currentSong) : null;

        if (currentSongId !== lastSongId) {
            lastSongId = currentSongId;
            cachedNeteaseChorusRanges = null;
        }

        // 通用过滤是用户的显式指令，先跑；staff 策略只处理它没删掉的开头块。
        let processed = applyLyricStaffPolicy(applyLyricDisplayFilter(nextLyrics, lyricFilterPattern), staffOptions);
        if (processed) {
            const hasChorus = processed.lines.some(line => line.isChorus);
            if (hasChorus) {
                // Cache the chorus ranges from the incoming lyrics (e.g. NetEase lyrics)
                cachedNeteaseChorusRanges = processed.lines
                    .filter(line => line.isChorus)
                    .map(line => ({
                        startTime: line.startTime,
                        endTime: line.endTime
                    }));
            } else {
                // Try to load NetEase chorus ranges if they are not already cached
                if (!cachedNeteaseChorusRanges && currentSong) {
                    const storedLyrics = resolveStoredLyrics(currentSong);
                    if (storedLyrics) {
                        cachedNeteaseChorusRanges = storedLyrics.lines
                            .filter(line => line.isChorus)
                            .map(line => ({
                                startTime: line.startTime,
                                endTime: line.endTime
                            }));
                    }
                }

                if (cachedNeteaseChorusRanges && cachedNeteaseChorusRanges.length > 0) {
                    processed = applyNeteaseChorusByTime(processed, cachedNeteaseChorusRanges);
                } else {
                    // Fall back to text-based frequency detection
                    const rebuildLrcText = processed.lines.map(line => `[00:00.00]${line.fullText}`).join('\n');
                    processed = applyDetectedChorusEffects(processed, rebuildLrcText);
                }
            }
            // Word segmentation is baked onto the lines here because visualizers receive lines
            // with no song identity and so cannot look up a per-song override themselves. Last in
            // the chain, so it sees the lines that actually survived filtering.
            processed = applyLyricWordSegmentation(processed, resolveSegmentationRecord());
            setLyricsState(ensureLyricDataRenderHints(processed));
        } else {
            setLyricsState(null);
        }
    };
};
