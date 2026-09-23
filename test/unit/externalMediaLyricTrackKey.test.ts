import { describe, expect, it } from 'vitest';
import type { LyricData } from '../../src/types';
import {
    getExternalMediaTrackKey,
    resolveDisplayLyrics,
    selectDisplayLyricsForBackend,
} from '../../src/utils/externalMediaLyricTrackKey';

// test/unit/externalMediaLyricTrackKey.test.ts
// 歌词身份与派发判据。这两条规则是本轮最容易写歪的地方，而它们都能被穷举断言：
//
//   * 身份：缺 title 就不是一首歌（返回 null），不能让空标题的 session 占用一个键，
//     否则「没有曲目」与「有一首标题为空的曲目」在 store 里无法区分。
//   * 派发：apple-music 分支**绝不回落**到 Folia 的歌词。回落会显示上一首 Folia 曲目的行，
//     与 effectivePlayback.ts 里「coverUrl 必须为空、不得回落」是同一条理由。

const lyrics = (text: string): LyricData => ({
    lines: [{ words: [], startTime: 0, endTime: 1, fullText: text }],
});

// 观察目标现在是 Chrome 里的 music.apple.com（网页版），不是 Apple Music 桌面版 —— 桌面版
// 的 AUMID（`AppleInc.AppleMusicWin_…!App`）不再是任何代码路径的目标。
const AUMID = 'Chrome';

describe('getExternalMediaTrackKey', () => {
    it('composes the key from AUMID + title + artist', () => {
        expect(getExternalMediaTrackKey(AUMID, 'Song', 'Artist')).toBe(`${AUMID}|Song|Artist`);
    });

    it('treats a missing or blank title as "no track"', () => {
        expect(getExternalMediaTrackKey(AUMID, null, 'Artist')).toBeNull();
        expect(getExternalMediaTrackKey(AUMID, '   ', 'Artist')).toBeNull();
        expect(getExternalMediaTrackKey(AUMID, '', '')).toBeNull();
    });

    it('trims the parts so metadata whitespace cannot fork the identity', () => {
        expect(getExternalMediaTrackKey(AUMID, '  Song  ', ' Artist ')).toBe(`${AUMID}|Song|Artist`);
    });

    it('falls back to a stable AUMID placeholder and tolerates a missing artist', () => {
        expect(getExternalMediaTrackKey(null, 'Song', null)).toBe('external-media|Song|');
        expect(getExternalMediaTrackKey(AUMID, 'Song', null)).toBe(`${AUMID}|Song|`);
    });

    it('separates two tracks that differ only by artist', () => {
        const a = getExternalMediaTrackKey(AUMID, 'Song', 'A');
        const b = getExternalMediaTrackKey(AUMID, 'Song', 'B');
        expect(a).not.toBe(b);
    });
});

describe('resolveDisplayLyrics', () => {
    const folia = lyrics('folia');
    const appleMusic = lyrics('external-media');

    it('reads Folia lyrics in the folia backend', () => {
        expect(resolveDisplayLyrics('folia', folia, appleMusic)).toBe(folia);
    });

    it('reads Apple Music lyrics in the apple-music backend', () => {
        expect(resolveDisplayLyrics('external-media', folia, appleMusic)).toBe(appleMusic);
    });

    it('never falls back to the other backend when one side is empty', () => {
        expect(resolveDisplayLyrics('external-media', folia, null)).toBeNull();
        expect(resolveDisplayLyrics('folia', null, appleMusic)).toBeNull();
    });
});

describe('selectDisplayLyricsForBackend', () => {
    const held = lyrics('held');
    const raw = lyrics('raw');

    it('uses the transition-held lyrics in the folia backend', () => {
        // 混音交接期画面属于 outgoing deck，这是 folia 后端下正确的语义。
        expect(selectDisplayLyricsForBackend('folia', { transitionDisplay: { lyrics: held }, lyrics: raw })).toBe(held);
    });

    it('falls back to the raw lyrics outside a transition', () => {
        expect(selectDisplayLyricsForBackend('folia', { transitionDisplay: null, lyrics: raw })).toBe(raw);
    });

    it('returns null in the apple-music backend regardless of what Folia holds', () => {
        // 这条是「apple-music 后端下不会有 Folia 歌词漏进来」的机器可读形式：
        // 交接期残留的 outgoing-deck 歌词在这里被强制丢掉，因此歌词读头不会拿 A 曲的行
        // 去配 B 曲（外部应用）的时间。
        expect(selectDisplayLyricsForBackend('external-media', { transitionDisplay: { lyrics: held }, lyrics: raw })).toBeNull();
        expect(selectDisplayLyricsForBackend('external-media', { transitionDisplay: null, lyrics: raw })).toBeNull();
    });
});
