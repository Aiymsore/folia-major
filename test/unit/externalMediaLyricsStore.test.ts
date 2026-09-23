import { afterEach, describe, expect, it } from 'vitest';
import type { LyricData } from '../../src/types';
import {
    getExternalMediaLyrics,
    getExternalMediaLyricsPhase,
    getExternalMediaLyricsTrackKey,
    resetExternalMediaLyricsForTests,
    useExternalMediaLyricsStore,
} from '../../src/stores/useExternalMediaLyricsStore';

// test/unit/externalMediaLyricsStore.test.ts
// Apple Music 歌词状态源的生命周期契约。锁定的是三条最容易写歪的性质：
//
//   * 切歌**原子清空**：先看到新曲目的身份、后拿到新曲目的行。中间不存在
//     「新身份 + 上一首的行」那一帧 —— 否则视觉化器会用错误的歌词渲染一帧。
//   * 迟到的匹配结果**不能**覆盖新曲目：commitLyrics 带 trackKey 守卫，key 不符即丢弃。
//   * reset 回到 idle：离开 apple-music 后端后 store 不参与，读取层随之回落到 Folia。

const lyrics = (text: string): LyricData => ({
    lines: [{ words: [], startTime: 0, endTime: 1, fullText: text }],
});

afterEach(() => {
    resetExternalMediaLyricsForTests();
});

describe('useExternalMediaLyricsStore', () => {
    it('starts idle with nothing committed', () => {
        expect(getExternalMediaLyricsTrackKey()).toBeNull();
        expect(getExternalMediaLyrics()).toBeNull();
        expect(getExternalMediaLyricsPhase()).toBe('idle');
    });

    it('runs the loading → ready cycle for one track', () => {
        const store = useExternalMediaLyricsStore.getState();
        store.beginTrack('key-a', 'loading');
        expect(getExternalMediaLyricsPhase()).toBe('loading');
        expect(getExternalMediaLyricsTrackKey()).toBe('key-a');
        expect(getExternalMediaLyrics()).toBeNull();

        store.commitLyrics('key-a', 'ready', lyrics('a'));
        expect(getExternalMediaLyricsPhase()).toBe('ready');
        expect(getExternalMediaLyrics()?.lines[0].fullText).toBe('a');
    });

    it('clears the lyrics atomically when the track changes', () => {
        const store = useExternalMediaLyricsStore.getState();
        store.beginTrack('key-a', 'loading');
        store.commitLyrics('key-a', 'ready', lyrics('a'));

        store.beginTrack('key-b', 'loading');
        // 身份已经前进，行必须同时消失 —— 这一对断言就是「不存在错配帧」的机器可读形式。
        expect(getExternalMediaLyricsTrackKey()).toBe('key-b');
        expect(getExternalMediaLyrics()).toBeNull();
    });

    it('drops a late commit for a track that is no longer current', () => {
        const store = useExternalMediaLyricsStore.getState();
        store.beginTrack('key-a', 'loading');
        store.beginTrack('key-b', 'loading');

        // key-a 的匹配结果迟到：既不能写进歌词，也不能把阶段改成 ready。
        store.commitLyrics('key-a', 'ready', lyrics('a'));
        expect(getExternalMediaLyrics()).toBeNull();
        expect(getExternalMediaLyricsPhase()).toBe('loading');
    });

    it('records "no lyrics" as an empty phase rather than leaving it loading', () => {
        const store = useExternalMediaLyricsStore.getState();
        store.beginTrack('key-a', 'loading');
        store.commitLyrics('key-a', 'empty', null);
        expect(getExternalMediaLyricsPhase()).toBe('empty');
        expect(getExternalMediaLyrics()).toBeNull();
    });

    it('distinguishes "no media" from "not Apple Music"', () => {
        const store = useExternalMediaLyricsStore.getState();
        store.beginTrack(null, 'no-media');
        expect(getExternalMediaLyricsTrackKey()).toBeNull();
        expect(getExternalMediaLyricsPhase()).toBe('no-media');
    });

    it('resets everything when the backend leaves Apple Music', () => {
        const store = useExternalMediaLyricsStore.getState();
        store.beginTrack('key-a', 'loading');
        store.commitLyrics('key-a', 'ready', lyrics('a'));

        store.reset();
        expect(getExternalMediaLyricsTrackKey()).toBeNull();
        expect(getExternalMediaLyrics()).toBeNull();
        expect(getExternalMediaLyricsPhase()).toBe('idle');
    });
});
