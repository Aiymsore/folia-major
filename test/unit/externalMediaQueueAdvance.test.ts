import { describe, expect, it } from 'vitest';
import type { SongResult } from '../../src/types';
import {
    decideExternalMediaAdvance,
    EXTERNAL_MEDIA_END_PROXIMITY_MS,
    hasQueuedSuccessor,
    isNaturalTrackEnd,
    isNearTrackEnd,
    toObservedPlaybackSnapshot,
    type ObservedPlaybackSnapshot,
} from '../../src/utils/externalMediaQueueAdvance';

// test/unit/externalMediaQueueAdvance.test.ts
// 分段权威决策的穷举锁定。六类场景（自然结束 / 曲末抢占 / 手动跳队列内 / 手动跳队列外 /
// 派发窗口 / loop 与队列耗尽）都在这里，因为这层的每一条边界都会变成用户可见的行为：
// 推进错 = 切歌错，误判接管 = queue 停摆。

const song = (name: string, artist = 'Artist'): SongResult => ({
    id: name,
    name,
    artists: [{ id: 0, name: artist }],
} as unknown as SongResult);

const queue = [song('A'), song('B'), song('C')];

const observed = (over: Partial<ObservedPlaybackSnapshot> = {}): ObservedPlaybackSnapshot => ({
    title: 'A',
    artist: 'Artist',
    positionMs: 30_000,
    durationMs: 240_000,
    playbackStatus: 'Playing',
    ...over,
});

const decide = (over: Partial<Parameters<typeof decideExternalMediaAdvance>[0]> = {}) => (
    decideExternalMediaAdvance({
        queue,
        currentSong: queue[0],
        observed: observed(),
        previousObserved: observed({ positionMs: 10_000 }),
        loopMode: 'off',
        inDispatchWindow: false,
        ...over,
    })
);

describe('isNearTrackEnd', () => {
    it('is true only inside the end proximity window with a known duration', () => {
        expect(isNearTrackEnd(observed({ positionMs: 239_000, durationMs: 240_000 }))).toBe(true);
        expect(isNearTrackEnd(observed({
            positionMs: 240_000 - EXTERNAL_MEDIA_END_PROXIMITY_MS,
            durationMs: 240_000,
        }))).toBe(true);
        expect(isNearTrackEnd(observed({ positionMs: 200_000, durationMs: 240_000 }))).toBe(false);
        // Unknown duration or position: "we cannot tell" is not "near the end".
        expect(isNearTrackEnd(observed({ positionMs: 239_000, durationMs: null }))).toBe(false);
        expect(isNearTrackEnd(observed({ positionMs: null, durationMs: 240_000 }))).toBe(false);
    });
});

describe('isNaturalTrackEnd', () => {
    // 回归的现场：只收 Playing 让**每一首正常放完的歌都不推进 queue**。
    // 网页播放器的队列只有一首（playById 用 setQueue({song})），放完就停在末尾报 Stopped，
    // 于是观察层看到的最后一帧是 Stopped —— 判据不成立 → in-sync → 队列停摆。
    it('accepts Stopped inside the end window, because that is what a finished track looks like', () => {
        expect(isNaturalTrackEnd(observed({ positionMs: 240_000, playbackStatus: 'Stopped' }))).toBe(true);
        expect(isNaturalTrackEnd(observed({ positionMs: 239_000, playbackStatus: 'Playing' }))).toBe(true);
    });

    it('never treats a pause as the end of the track', () => {
        // 用户按了暂停却被自动切歌，比漏掉一次推进更糟。
        expect(isNaturalTrackEnd(observed({ positionMs: 239_900, playbackStatus: 'Paused' }))).toBe(false);
    });

    it('still requires the end window', () => {
        expect(isNaturalTrackEnd(observed({ positionMs: 200_000, playbackStatus: 'Stopped' }))).toBe(false);
        expect(isNaturalTrackEnd(observed({ positionMs: 239_000, durationMs: null, playbackStatus: 'Stopped' }))).toBe(false);
    });
});

describe('hasQueuedSuccessor', () => {
    it('mirrors handleNextTrack nextIndex rules', () => {
        expect(hasQueuedSuccessor(queue, queue[0], 'off')).toBe(true);
        expect(hasQueuedSuccessor(queue, queue[2], 'off')).toBe(false);
        // loop 'all' wraps to the head.
        expect(hasQueuedSuccessor(queue, queue[2], 'all')).toBe(true);
        // Unknown current → index 0 is reachable.
        expect(hasQueuedSuccessor(queue, song('Z'), 'off')).toBe(true);
        expect(hasQueuedSuccessor([], queue[0], 'all')).toBe(false);
    });
});

describe('decideExternalMediaAdvance', () => {
    it('holds without an observation or a current track', () => {
        // 不知道不等于同步：盲推 queue 会在坏掉的观察通道上把整队放完。
        expect(decide({ observed: null })).toEqual({ kind: 'hold', reason: 'no-observation' });
        expect(decide({ currentSong: null })).toEqual({ kind: 'hold', reason: 'no-current-track' });
    });

    it('reports in-sync while the observed track is the queue current', () => {
        expect(decide()).toEqual({ kind: 'in-sync' });
    });

    it('advances when the track is Playing inside the end proximity window', () => {
        // 自然结束的判据 1：位置进入结尾邻域且仍在 Playing。
        // 暂停在结尾邻域不算：那是"用户暂停了"，不是"这首结束了"。
        expect(decide({ observed: observed({ positionMs: 239_500 }) })).toEqual({ kind: 'advance', mode: 'next' });
        expect(decide({
            observed: observed({ positionMs: 239_500, playbackStatus: 'Paused' }),
        })).toEqual({ kind: 'in-sync' });
    });

    it('advances when the web player stopped at the end, which is how a track actually finishes', () => {
        // 这一条是"不按歌单自动播放下一首"的回归锁。网页播放器的队列只有一首，放完就停在
        // 末尾报 Stopped；只收 Playing 会让每一首正常放完的歌都停在 in-sync。
        expect(decide({
            observed: observed({ positionMs: 240_000, playbackStatus: 'Stopped' }),
            previousObserved: observed({ positionMs: 239_000, playbackStatus: 'Playing' }),
        })).toEqual({ kind: 'advance', mode: 'next' });

        // 连续多帧 Stopped 也只推进一次 —— 由 hook 层的 advancedForKeyRef 保证，
        // 这里锁的是决策层对每一帧都给出 advance（而不是第二帧变 in-sync）。
        expect(decide({
            observed: observed({ positionMs: 240_000, playbackStatus: 'Stopped' }),
            previousObserved: observed({ positionMs: 240_000, playbackStatus: 'Stopped' }),
        })).toEqual({ kind: 'advance', mode: 'next' });
    });

    it('does not advance on a pause at the very end', () => {
        expect(decide({
            observed: observed({ positionMs: 239_900, playbackStatus: 'Paused' }),
            previousObserved: observed({ positionMs: 239_000, playbackStatus: 'Playing' }),
        })).toEqual({ kind: 'in-sync' });
    });

    it('repeats instead of advancing under loop one', () => {
        // loop 'one' 的语义留在 Folia：重新下发同一首，绝不把 next/loop 透传给网页播放器。
        expect(decide({ observed: observed({ positionMs: 239_500 }), loopMode: 'one' })).toEqual({
            kind: 'advance',
            mode: 'repeat',
        });
        // 曲末抢占同样按 loop 语义分派。
        expect(decide({
            currentSong: queue[1],
            observed: observed({ title: 'Q' }),
            previousObserved: observed({ title: 'B', positionMs: 239_500 }),
            loopMode: 'one',
        })).toEqual({ kind: 'advance', mode: 'repeat' });
    });

    it('reclaims control when the web player moved on by itself at the track end', () => {
        // 判据 2（E5-A 曲末抢占）：身份真的变了（比较两次观察），且上一帧停在结尾邻域。
        // 网页播放器此时已经跳到了它自己的下一首（不在 Folia 的 queue 里），
        // 但这次变化是"自然结束"，不是"用户接管" —— Folia 要下发 playById 抢回控制权。
        expect(decide({
            currentSong: queue[1],
            observed: observed({ title: 'Some Web Queue Track', artist: 'Other' }),
            previousObserved: observed({ title: 'B', positionMs: 239_400 }),
        })).toEqual({ kind: 'advance', mode: 'next' });
    });

    it('reclaims only when the identity really changed between observations', () => {
        // 曲末抢占的门槛是"两次观察之间身份真的变了"：同一首还停在结尾邻域不构成
        // "播放器自己走了"，那只是这一首快要结束 —— 对账仍按它本来的归属走。
        expect(decide({
            currentSong: queue[1],
            observed: observed({ title: 'Q', positionMs: 239_500 }),
            previousObserved: observed({ title: 'Q', positionMs: 239_400 }),
        })).toEqual({ kind: 'take-over', reason: 'not-in-queue' });

        // 且上一帧不在结尾邻域时不抢占：那是手动切歌，不是自然结束。
        expect(decide({
            currentSong: queue[1],
            observed: observed({ title: 'Some Web Queue Track' }),
            previousObserved: observed({ title: 'B', positionMs: 100_000 }),
        })).toEqual({ kind: 'take-over', reason: 'not-in-queue' });
    });

    it('syncs the queue index when the user jumps to another queued track', () => {
        // 分段权威：queue 内的手动跳转不被"纠正"回去，索引同步到事实。
        expect(decide({ currentSong: queue[0], observed: observed({ title: 'C' }) })).toEqual({
            kind: 'sync-index',
            queueIndex: 2,
        });
    });

    it('yields the queue when the player reports something outside it', () => {
        // 分段权威：queue 外 = 用户接管，Folia 退出 queue 推进。
        expect(decide({ observed: observed({ title: 'Not In Queue' }) })).toEqual({
            kind: 'take-over',
            reason: 'not-in-queue',
        });
    });

    it('holds every non-in-sync verdict inside the dispatch window', () => {
        // 派发时间窗：Folia 刚下发过播放，观察层还停在旧曲目上。
        // 此时 drifted 会把索引同步回旧曲目、take-over 会放弃权威 —— 两者都撤销推进，
        // 所以窗口内非 in-sync 的结论一律 hold。
        expect(decide({
            currentSong: queue[1],
            observed: observed({ title: 'A', positionMs: 10_000 }),
            previousObserved: observed({ title: 'A', positionMs: 5_000 }),
            inDispatchWindow: true,
        })).toEqual({ kind: 'hold', reason: 'dispatch-pending' });

        expect(decide({
            observed: observed({ title: 'Not In Queue' }),
            inDispatchWindow: true,
        })).toEqual({ kind: 'hold', reason: 'dispatch-pending' });

        // in-sync 在窗口内照常工作：观察层已经追上了新曲目。
        expect(decide({ inDispatchWindow: true })).toEqual({ kind: 'in-sync' });
    });
});

describe('toObservedPlaybackSnapshot', () => {
    const status = (over: Partial<ElectronExternalMediaStatus> = {}): ElectronExternalMediaStatus => ({
        bridgeAvailable: true,
        helperState: 'running',
        connected: true,
        sourceAppUserModelId: 'Chrome',
        title: 'Track',
        artist: 'Artist',
        album: null,
        playbackStatus: 'Playing',
        positionMs: 61_000,
        durationMs: 240_000,
        hasThumbnail: false,
        updatedAt: 1,
        lastUpdatedAt: 1,
        lastEventAt: 1,
        sessionCount: 1,
        extensionConnected: true,
        extensionVersion: '1.0.0',
        extensionCapabilities: [],
        pageReady: null,
        signedIn: true,
        storefrontMatches: true,
        lastCommand: null,
        lastError: null,
        ...over,
    });

    it('returns null without a session or without track information', () => {
        expect(toObservedPlaybackSnapshot(null)).toBeNull();
        expect(toObservedPlaybackSnapshot(status({ connected: false }))).toBeNull();
        expect(toObservedPlaybackSnapshot(status({ title: '   ' }))).toBeNull();
    });

    it('normalizes blank artists and non-finite numbers to null', () => {
        const snapshot = toObservedPlaybackSnapshot(status({
            artist: '   ',
            positionMs: Number.NaN,
            durationMs: null,
        }));
        expect(snapshot).toEqual({
            title: 'Track',
            artist: null,
            positionMs: null,
            durationMs: null,
            playbackStatus: 'Playing',
        });
    });
});
