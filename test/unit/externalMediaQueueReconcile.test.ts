import { describe, expect, it } from 'vitest';
import type { SongResult } from '../../src/types';
import {
    getQueueSongIdentity,
    isExternalMediaQueueSongPlayable,
    isSameObservedTrack,
    reconcileExternalMediaQueue,
    resolveExternalMediaPlayableId,
} from '../../src/utils/externalMediaQueueReconcile';

// test/unit/externalMediaQueueReconcile.test.ts
// 对账层本身的规则：身份归一化、宽松匹配的代价不对称性、以及"没有 catalogId 就不可播"。
//
// 匹配刻意宽松（title 相同 + artist 一方缺失或互相包含）：对账误判"同一首"只是让索引停在
// 原地（下一帧还会再判），误判"不同首"会让 Folia 误以为用户接管并停摆 queue —— 后者是
// 用户可见的功能中断。`getPlaybackSongKey` 的精确身份用于去重，两者误判的代价相反。

const song = (name: string, artist = 'Artist', extra: Record<string, unknown> = {}): SongResult => ({
    id: name,
    name,
    artists: artist ? [{ id: 0, name: artist }] : [],
    ...extra,
} as unknown as SongResult);

const observed = (title: string, artist: string | null) => ({ title, artist });

describe('isSameObservedTrack', () => {
    it('normalizes case, surrounding and repeated whitespace', () => {
        expect(isSameObservedTrack(observed('  Song   Name ', 'Artist'), observed('song name', 'artist'))).toBe(true);
    });

    it('matches on title alone when either artist is missing', () => {
        // SMTC 的 artist 常为空、扩展上报的通常有值：要求双方都有值会让"恰好缺 artist"全部对不上。
        expect(isSameObservedTrack(observed('Song', null), observed('Song', 'Artist'))).toBe(true);
        expect(isSameObservedTrack(observed('Song', 'Artist'), observed('Song', ''))).toBe(true);
    });

    it('accepts an artist containment match but rejects different artists', () => {
        expect(isSameObservedTrack(observed('Song', 'TK from Ling tosite sigure'), observed('Song', 'TK'))).toBe(true);
        expect(isSameObservedTrack(observed('Song', 'Artist A'), observed('Song', 'Artist B'))).toBe(false);
    });

    it('never matches different titles or missing sides', () => {
        expect(isSameObservedTrack(observed('Song A', null), observed('Song B', null))).toBe(false);
        expect(isSameObservedTrack(null, observed('Song', null))).toBe(false);
    });
});

describe('reconcileExternalMediaQueue', () => {
    const queue = [song('A'), song('B'), song('C')];

    it('reports in-sync when the observation is the queue current', () => {
        expect(reconcileExternalMediaQueue({ queue, currentSong: queue[0], observed: observed('A', 'Artist') }))
            .toEqual({ kind: 'in-sync', queueIndex: 0 });
    });

    it('reports drifted when the observation is another queue member', () => {
        expect(reconcileExternalMediaQueue({ queue, currentSong: queue[0], observed: observed('C', 'Artist') }))
            .toEqual({ kind: 'drifted', queueIndex: 2 });
    });

    it('reports taken-over for anything outside the queue, and for no observation at all', () => {
        expect(reconcileExternalMediaQueue({ queue, currentSong: queue[0], observed: observed('Q', null) }))
            .toEqual({ kind: 'taken-over', reason: 'not-in-queue' });
        // 不知道不等于同步。
        expect(reconcileExternalMediaQueue({ queue, currentSong: queue[0], observed: null }))
            .toEqual({ kind: 'taken-over', reason: 'no-observation' });
    });
});

describe('resolveExternalMediaPlayableId', () => {
    it('prefers the catalog id, because library ids 404 against the catalog', () => {
        // 资料库上传曲目没有目录条目，`playById` 对它无从寻址 —— 这是网页全曲时代
        // 唯一的不可播情形（试听时代的 previewUrl 判据已随试听路径一起删除）。
        expect(resolveExternalMediaPlayableId(song('A', 'Artist', {
            externalMediaId: 'a.1538098094',
            externalMediaCatalogId: '1538098094',
        }))).toBe('1538098094');
        expect(resolveExternalMediaPlayableId(song('A', 'Artist', {
            externalMediaId: 'a.1538098094',
            externalMediaCatalogId: null,
        }))).toBe('a.1538098094');
    });

    it('is null — and therefore unplayable — without any external media id', () => {
        expect(resolveExternalMediaPlayableId(song('A'))).toBeNull();
        expect(resolveExternalMediaPlayableId(null)).toBeNull();
        expect(isExternalMediaQueueSongPlayable(song('A'))).toBe(false);
        expect(isExternalMediaQueueSongPlayable(song('A', 'Artist', { externalMediaId: 'a.1' }))).toBe(true);
    });
});

describe('getQueueSongIdentity', () => {
    it('joins multiple artists and tolerates missing parts', () => {
        expect(getQueueSongIdentity(song('A', ''))).toEqual({ title: 'A', artist: null });
        expect(getQueueSongIdentity({
            id: 'x',
            name: '  Duo  ',
            artists: [{ id: 0, name: 'One' }, { id: 1, name: 'Two' }],
        } as unknown as SongResult)).toEqual({ title: 'Duo', artist: 'One, Two' });
        expect(getQueueSongIdentity(null)).toBeNull();
    });
});
