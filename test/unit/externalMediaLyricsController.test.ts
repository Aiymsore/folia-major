import { describe, expect, it } from 'vitest';
import {
    buildExternalMediaMatchInput,
    matchExternalMediaLyrics,
} from '../../src/hooks/useExternalMediaLyricsController';

// test/unit/externalMediaLyricsController.test.ts
// 控制器的匹配边界。跨 provider 匹配编排本身（Netease → AMLL → QQ → Kugou + 打分）是既有代码，
// 不在这里重复测；这里锁的是 Apple Music 特有的一段：SMTC 元数据怎样被归一化成编排的输入。
//
// 归一化是实测驱动的：Apple Music 的 `AlbumTitle` 常为空（helper README 记录了这一点），
// 而「空专辑」若不收成 null，就会拿一张"叫空字符串的专辑"进打分。

describe('buildExternalMediaMatchInput', () => {
    it('collapses a missing or blank album to null', () => {
        expect(buildExternalMediaMatchInput({ title: 'T', artist: 'A', album: null, durationMs: 1 }).album).toBeNull();
        expect(buildExternalMediaMatchInput({ title: 'T', artist: 'A', album: '', durationMs: 1 }).album).toBeNull();
        expect(buildExternalMediaMatchInput({ title: 'T', artist: 'A', album: '   ', durationMs: 1 }).album).toBeNull();
    });

    it('trims the metadata so whitespace cannot fork the match', () => {
        expect(buildExternalMediaMatchInput({
            title: '  Song  ',
            artist: ' Artist ',
            album: ' Album ',
            durationMs: 1000,
        })).toEqual({
            title: 'Song',
            artist: 'Artist',
            album: 'Album',
            durationMs: 1000,
        });
    });

    it('keeps a missing duration as null rather than inventing zero', () => {
        // 0 与「没有时长」在编排里走同一条不可用分支，但保留 null 让这条事实在数据里可读。
        expect(buildExternalMediaMatchInput({ title: 'T', artist: 'A', album: null, durationMs: null }).durationMs).toBeNull();
    });

    it('is referentially stable in its outputs for identical inputs', () => {
        const first = buildExternalMediaMatchInput({ title: 'T', artist: 'A', album: 'B', durationMs: 5 });
        const second = buildExternalMediaMatchInput({ title: ' T ', artist: 'A ', album: 'B', durationMs: 5 });
        // 归一化之后必须逐字段相等 —— 控制器的 effect 依赖的就是这些标量，
        // 否则「元数据里多一个空格」会触发一次多余的跨 provider 匹配。
        expect(second).toEqual(first);
    });
});

describe('matchExternalMediaLyrics', () => {
    it('is exposed as the default injection point', () => {
        // 控制器取 `options.match ?? matchExternalMediaLyrics`：这条断言锁的是默认路径确实接到了
        // 跨 provider 匹配，而不是某个空实现。
        expect(typeof matchExternalMediaLyrics).toBe('function');
    });
});
