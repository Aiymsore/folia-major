import { describe, expect, it } from 'vitest';
import {
    calculateMatchScore,
    calculateMatchScoreDetails,
    isCrossScriptArtistPair,
    normalizeLyricMatchText,
} from '@/utils/lyrics/matchScore';

// test/unit/lyrics/matchScore.test.ts

describe('calculateMatchScore', () => {
    it('keeps non-Chinese international letters while removing punctuation', () => {
        expect(normalizeLyricMatchText('さよならの夏 - Café!')).toBe('sayonarano夏 café');
        expect(normalizeLyricMatchText('안녕, мир?')).toBe('안녕 мир');
    });

    it('normalizes accidental ms * 1000 durations before scoring', () => {
        const score = calculateMatchScore(
            {
                title: 'Night of Bloom (feat. nayuta)',
                artist: 'Kirara Magic/Xomu/nayuta',
                durationMs: 286000000
            },
            {
                id: 201,
                name: 'Night of Bloom',
                artists: [
                    { id: 1, name: 'Kirara Magic' },
                    { id: 2, name: 'Xomu' },
                    { id: 3, name: 'nayuta' }
                ],
                album: { id: 1, name: 'Night of Bloom' },
                durationMs: 286000
            }
        );

        expect(score).toBeGreaterThanOrEqual(85);
    });

    it('keeps same-title same-duration candidates below the threshold when both artist and album miss', () => {
        const score = calculateMatchScore(
            {
                title: 'Night of Bloom (feat. nayuta)',
                artist: 'Kirara Magic/Xomu/nayuta',
                album: 'Night of Bloom',
                durationMs: 286000
            },
            {
                id: 202,
                name: 'Night of Bloom',
                artists: [{ id: 1, name: 'Ayrex' }],
                album: { id: 1, name: 'First Love' },
                durationMs: 286000
            }
        );

        expect(score).toBeLessThan(75);
    });

    it('allows a strong album hit to identify providers with unreliable artist fields', () => {
        const details = calculateMatchScoreDetails(
            {
                title: 'SAKURAスキップ',
                artist: '高田憂希/山口愛/戸田めぐみ/竹尾歩美',
                album: 'TVアニメ「NEW GAME!」オープニングテーマ「SAKURAステップ」',
                durationMs: 249000
            },
            {
                id: 401,
                name: 'SAKURAスキップ',
                artists: [{ id: 1, name: 'fourfolium' }],
                album: { id: 1, name: 'TVアニメ「NEW GAME!」オープニングテーマ「SAKURAステップ」' },
                durationMs: 249000
            }
        );

        expect(details.titleMatched).toBe(true);
        expect(details.albumMatched).toBe(true);
        expect(details.durationMatched).toBe(true);
        expect(details.score).toBeGreaterThanOrEqual(75);
        // The artist field here is a seiyuu list against the unit name — Han-vs-Latin, so it cannot be
        // compared and is now neutral rather than a contradiction (see isCrossScriptArtistPair).
        // That a *judgeable* artist mismatch still sinks a candidate is locked by the
        // "same-title same-duration candidates below the threshold" case above.
        expect(details.artistMatched).toBe(true);
    });

    it('treats parenthesized title translations as aliases but keeps version markers significant', () => {
        const aliasDetails = calculateMatchScoreDetails(
            {
                title: 'SAKURAスキップ',
                artist: '高田憂希/山口愛/戸田めぐみ/竹尾歩美',
                album: 'TVアニメ「NEW GAME!」オープニングテーマ「SAKURAステップ」',
                durationMs: 249000
            },
            {
                id: 402,
                name: 'SAKURAスキップ (樱花跳)',
                artists: [{ id: 1, name: 'fourfolium' }],
                album: { id: 1, name: 'TVアニメ「NEW GAME!」オープニングテーマ「SAKURAステップ」' },
                durationMs: 249000
            }
        );
        const instrumentalDetails = calculateMatchScoreDetails(
            {
                title: 'SAKURAスキップ',
                artist: '高田憂希/山口愛/戸田めぐみ/竹尾歩美',
                album: 'TVアニメ「NEW GAME!」オープニングテーマ「SAKURAステップ」',
                durationMs: 249000
            },
            {
                id: 403,
                name: 'SAKURAスキップ (instrumental)',
                artists: [{ id: 1, name: 'fourfolium' }],
                album: { id: 1, name: 'TVアニメ「NEW GAME!」オープニングテーマ「SAKURAステップ」' },
                durationMs: 249000
            }
        );

        expect(aliasDetails.titleMatched).toBe(true);
        expect(aliasDetails.score).toBeGreaterThanOrEqual(75);
        expect(instrumentalDetails.score).toBeLessThan(aliasDetails.score);
    });

    it('gives duration enough weight to penalize otherwise similar wrong-length results', () => {
        const exactDurationScore = calculateMatchScore(
            {
                title: 'Song Title',
                artist: 'Artist Name',
                album: 'Album Name',
                durationMs: 200000
            },
            {
                id: 301,
                name: 'Song Title',
                artists: [{ id: 1, name: 'Artist Name' }],
                album: { id: 1, name: 'Album Name' },
                durationMs: 200000
            }
        );
        const wrongDurationScore = calculateMatchScore(
            {
                title: 'Song Title',
                artist: 'Artist Name',
                album: 'Album Name',
                durationMs: 200000
            },
            {
                id: 302,
                name: 'Song Title',
                artists: [{ id: 1, name: 'Artist Name' }],
                album: { id: 1, name: 'Album Name' },
                durationMs: 245000
            }
        );

        expect(exactDurationScore).toBe(100);
        expect(wrongDurationScore).toBeLessThan(75);
    });

    it('marks duration as matched only when the difference is at most three seconds', () => {
        const target = {
            title: 'Song Title',
            artist: 'Artist Name',
            durationMs: 200000
        };
        const result = {
            id: 303,
            name: 'Song Title',
            artists: [{ id: 1, name: 'Artist Name' }],
            album: { id: 1, name: 'Album Name' }
        };

        expect(calculateMatchScoreDetails(target, { ...result, durationMs: 203000 }).durationMatched).toBe(true);
        expect(calculateMatchScoreDetails(target, { ...result, durationMs: 203001 }).durationMatched).toBe(false);
    });

    it('strips feat. tags from album and handles partial artist arrays safely', () => {
        const details = calculateMatchScoreDetails(
            {
                title: 'イグニッション',
                artist: '*Luna, ゆある, ねんね',
                album: 'イグニッション',
                durationMs: 200000
            },
            {
                id: 501,
                name: 'イグニッション (feat. Yuaru、Nenne)',
                artists: [{ id: 1, name: '*Luna' }],
                album: { id: 1, name: 'イグニッション (feat. Yuaru、Nenne)' },
                durationMs: 200000
            }
        );

        expect(details.titleMatched).toBe(true);
        expect(details.artistMatched).toBe(true);
        expect(details.albumMatched).toBe(true);
        expect(details.score).toBeGreaterThanOrEqual(90);
    });

    it('normalizes traditional chinese to simplified and katakana to romaji', () => {
        const details = calculateMatchScoreDetails(
            {
                title: '深藍',
                artist: 'ルルティア',
                album: 'NODE from R',
                durationMs: 200000
            },
            {
                id: 601,
                name: '深蓝',
                artists: [{ id: 1, name: 'RURUTIA' }],
                album: { id: 1, name: 'NODE from R' },
                durationMs: 200000
            }
        );

        expect(details.titleMatched).toBe(true);
        expect(details.artistMatched).toBe(true);
        expect(details.score).toBeGreaterThanOrEqual(95);
    });

    // ── 缺失时长不再扣分 ──────────────────────────────────────────────────────────
    //
    // 回归的现场：`calculateDurationScore` 在任一侧没有时长时返回 0.9，于是一次完美的
    // title+artist 命中只拿 90 分。对 provider 不报时长的曲目，这 10 分是白扣的 ——
    // 它是"无法比较"，不是"不匹配"。
    describe('a duration neither side could report', () => {
        const perfectMatch = (durationMs: number, searchDurationMs: number) => calculateMatchScoreDetails(
            { title: 'Aimer Song', artist: 'Aimer', durationMs },
            {
                id: 701,
                name: 'Aimer Song',
                artists: [{ id: 1, name: 'Aimer' }],
                album: { id: 1, name: 'Album' },
                durationMs: searchDurationMs,
            },
        );

        it('costs nothing when both sides are missing it', () => {
            const details = perfectMatch(0, 0);
            expect(details.durationMultiplier).toBe(1);
            // Still reported as "not compared" rather than as a verified match.
            expect(details.durationMatched).toBeNull();
            expect(details.score).toBe(100);
        });

        it('costs nothing when only the target is missing it', () => {
            // SMTC 常常报不出时长，而 provider 报了 —— 同样无法比较。
            expect(perfectMatch(0, 200_000).durationMultiplier).toBe(1);
            expect(perfectMatch(0, 200_000).durationMatched).toBeNull();
        });

        it('costs nothing when only the candidate is missing it', () => {
            expect(perfectMatch(200_000, 0).durationMultiplier).toBe(1);
            expect(perfectMatch(200_000, 0).durationMatched).toBeNull();
        });

        it('still penalizes a length that was reported and disagrees', () => {
            // 真正的"不匹配"必须继续扣分：这是时长唯一的用处。
            expect(perfectMatch(200_000, 245_000).score).toBeLessThan(75);
        });
    });

    // ── 跨文字系统的艺人名 ────────────────────────────────────────────────────────
    //
    // 实测：Apple Music 报罗马字、中文库存汉字名时，同一个艺人对不上。
    //   target "林ゆうき" vs search "Yuki Hayashi" -> 67 分，artistMatched false
    // 假名一侧本来就通（wanakana 把两边都归一到罗马字，88 分），缺的是汉字 —— 汉字没有读音
    // 信息，转写解决不了。这类比较做不了，就不该被当成"不匹配"。
    describe('a CJK-only artist against a Latin-only one', () => {
        const details = (targetArtist: string, searchArtist: string, targetTitle = 'Song Title', searchTitle = 'Song Title') => (
            calculateMatchScoreDetails(
                { title: targetTitle, artist: targetArtist, durationMs: 200_000 },
                {
                    id: 801,
                    name: searchTitle,
                    artists: [{ id: 1, name: searchArtist }],
                    album: { id: 1, name: 'Album' },
                    durationMs: 200_000,
                },
            )
        );

        it('identifies the pair as unjudgeable', () => {
            expect(isCrossScriptArtistPair('林ゆうき', 'Yuki Hayashi')).toBe(true);
            expect(isCrossScriptArtistPair('Yuki Hayashi', '林ゆうき')).toBe(true);
            // Mixed strings share characters with both worlds, so they are compared normally.
            expect(isCrossScriptArtistPair('Mili (ミリー)', 'Mili')).toBe(false);
            expect(isCrossScriptArtistPair('Aimer', 'Aimer')).toBe(false);
            // Kana is phonetic: wanakana romanizes it, so a kana-vs-romaji pair IS comparable and must
            // not be handed the neutral artist point. Treating kana as "CJK" here was a real bug.
            expect(isCrossScriptArtistPair('トゲナシトゲアリ', 'TOGENASHI TOGEARI')).toBe(false);
            expect(isCrossScriptArtistPair('ルルティア', 'RURUTIA')).toBe(false);
        });

        it('clears the threshold instead of failing on a comparison it cannot make', () => {
            const result = details('林ゆうき', 'Yuki Hayashi');
            expect(result.artistMatched).toBe(true);
            expect(result.score).toBeGreaterThanOrEqual(75);
        });

        it('only relaxes under a near-exact title', () => {
            // 这是不让"跨文字即放行"变成白名单的关键：标题不像就不放宽。
            const result = details('林ゆうき', 'Yuki Hayashi', 'Completely Different Song', 'Another Song Entirely');
            expect(result.artistMatched).toBe(false);
            expect(result.score).toBeLessThan(75);
        });
    });
});

