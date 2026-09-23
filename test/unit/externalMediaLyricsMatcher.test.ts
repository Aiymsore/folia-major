import { describe, expect, it } from 'vitest';
import {
    buildExternalMediaMatchOptions,
    matchExternalMediaLyrics,
} from '../../src/hooks/useExternalMediaLyricsController';

// test/unit/externalMediaLyricsMatcher.test.ts
// Apple Music 歌词匹配器的选项契约。
//
// 这里锁的是本轮修掉的一个真实缺陷：`autoMatchBestLyric` 只接受逐字（word-by-word）歌词，
// 而 Apple Music 的曲目不在任何 provider 目录里、没有 Folia 那条 `omni.getLyrics` 兜底，
// 于是「只有普通 LRC」的歌会逐个来源被跳过、最终返回 null —— 表现就是「有些歌完全没有歌词」。
//
// 断言的是选项构造函数（纯函数），不是匹配器本身：后者要跑三家 provider 的网络。
// 而选项里那一项正是这条缺陷的开关，所以它值得被单独钉住。

describe('buildExternalMediaMatchOptions', () => {
    it('always requests the line-level fallback', () => {
        // 这是「有些歌没歌词」的修复点。去掉它，只有 LRC 的歌会重新变成空白。
        expect(buildExternalMediaMatchOptions('Album').acceptLineLevelLyrics).toBe(true);
        expect(buildExternalMediaMatchOptions(null).acceptLineLevelLyrics).toBe(true);
    });

    it('omits the album key entirely when there is no album', () => {
        // 不能传 `album: null`：那会被编排当成「有一张叫 null 的专辑」参与打分。
        expect('album' in buildExternalMediaMatchOptions(null)).toBe(false);
        expect(buildExternalMediaMatchOptions('Album').album).toBe('Album');
    });

    it('is a plain data object the orchestrator can consume', () => {
        // 防回归：选项必须是可序列化的字面量，不能夹带函数（编排会把它当纯配置读）。
        const options = buildExternalMediaMatchOptions('Album');
        expect(Object.values(options).every(v => typeof v !== 'function')).toBe(true);
    });
});

describe('matchExternalMediaLyrics', () => {
    it('is exported as the default injection point', () => {
        expect(typeof matchExternalMediaLyrics).toBe('function');
    });
});
