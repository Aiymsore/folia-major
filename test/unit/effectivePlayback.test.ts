import { describe, expect, it } from 'vitest';
import { PlayerState } from '../../src/types';
import {
    buildExternalMediaEffectiveModel,
    buildExternalMediaPseudoSong,
    mapExternalMediaPlayerState,
    type ExternalMediaEffectiveInput,
} from '../../src/utils/effectivePlayback';
import { hasExternalMedia, resolveExternalMediaClockSec } from '../../src/utils/externalMediaStatus';

// test/unit/effectivePlayback.test.ts
// 外部媒体后端的核心规则锁定：什么算「有曲目」、什么时候必须暴露 null、什么时候禁用 transport。
//
// 最关键的一条是 session / media / state 三者分离：有 session 且报告了曲目信息就算 hasMedia，
// **播放状态不参与这个判断**。所以 `Stopped` 的曲目仍然要显示出来、Play 仍然可用 —— 按播放正是
// 用户从该状态恢复的方式。把这些规则逐条断言，而不是整体快照。
//
// 另一条本次重构引入的规则：`canGoPrevious` / `canGoNext` 描述的是 **Folia 队列里有没有邻居**，
// 而不是外部播放器能不能切歌。next/previous 不透传给网页播放器（那会让它播自己的内部队列），
// 所以这两个值不再与 `canControl` 绑定。

const baseInput = (overrides: Partial<ExternalMediaEffectiveInput> = {}): ExternalMediaEffectiveInput => ({
    bridgeAvailable: true,
    connected: true,
    hasMedia: true,
    title: 'Track',
    artist: 'Artist',
    album: 'Album',
    playbackStatus: 'Playing',
    positionMs: 61_000,
    durationMs: 240_000,
    ...overrides,
});

const status = (overrides: Partial<ElectronExternalMediaStatus> = {}): ElectronExternalMediaStatus => ({
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
    hasThumbnail: true,
    updatedAt: 1,
    lastUpdatedAt: 1,
    lastEventAt: 1,
    sessionCount: 2,
    extensionConnected: true,
    extensionVersion: '1.0.0',
    extensionCapabilities: ['observe', 'transport', 'seek', 'playById'],
    pageReady: null,
    signedIn: true,
    storefrontMatches: true,
    lastCommand: null,
    lastError: null,
    ...overrides,
});
describe('mapExternalMediaPlayerState', () => {
    it('maps only the two states that describe loaded media', () => {
        expect(mapExternalMediaPlayerState('Playing')).toBe(PlayerState.PLAYING);
        expect(mapExternalMediaPlayerState('Paused')).toBe(PlayerState.PAUSED);
    });

    it('maps everything else to IDLE rather than guessing', () => {
        // Changing included on purpose: SMTC's Changing does not guarantee the next state is Playing,
        // and reporting PLAYING during a track switch is what makes the UI flash "now playing".
        for (const value of ['Closed', 'Stopped', 'Opened', 'Changing', 'Unknown(99)', null, '']) {
            expect(mapExternalMediaPlayerState(value)).toBe(PlayerState.IDLE);
        }
    });
});

describe('hasExternalMedia', () => {
    it('requires a visible session and reported track information', () => {
        expect(hasExternalMedia(status())).toBe(true);
        expect(hasExternalMedia(status({ connected: false }))).toBe(false);
        expect(hasExternalMedia(status({ title: null }))).toBe(false);
        expect(hasExternalMedia(status({ title: '   ' }))).toBe(false);
        expect(hasExternalMedia(null)).toBe(false);
    });

    it('ignores the playback state entirely', () => {
        // The rule this locks: a Stopped/Opened/Changing track is still a track. Gating on
        // `Playing|Paused` used to hide the song and disable Play exactly when the user wanted to
        // resume it.
        for (const playbackStatus of ['Playing', 'Paused', 'Stopped', 'Opened', 'Changing', 'Unknown(9)']) {
            expect(hasExternalMedia(status({ playbackStatus }))).toBe(true);
        }
        // Only the session/track information decides.
        expect(hasExternalMedia(status({ playbackStatus: 'Stopped', title: null }))).toBe(false);
    });
});

describe('buildExternalMediaPseudoSong', () => {
    it('produces a minimal SongResult with no provider identity', () => {
        const song = buildExternalMediaPseudoSong(baseInput(), 'Chrome');
        expect(song).toMatchObject({
            name: 'Track',
            artists: [{ id: 0, name: 'Artist' }],
            album: { id: 0, name: 'Album' },
            durationMs: 240_000,
        });
        // Nothing owns it: no sourceRef, no playbackSourceRevision, so it cannot be liked,
        // queued or reported as a provider playback.
        expect(song?.sourceRef).toBeUndefined();
        expect(song?.playbackSourceRevision).toBeUndefined();
        // A stable negative id keeps it out of the positive online-id space.
        expect(song?.id).toBeLessThan(0);
    });

    it('returns null without media information, so no stale title can survive', () => {
        expect(buildExternalMediaPseudoSong(baseInput({ hasMedia: false }), 'aumid')).toBeNull();
        expect(buildExternalMediaPseudoSong(baseInput({ title: null }), 'aumid')).toBeNull();
        expect(buildExternalMediaPseudoSong(baseInput({ title: '   ' }), 'aumid')).toBeNull();
    });

    it('keeps the track for a Stopped session, because resuming from there is the point', () => {
        const song = buildExternalMediaPseudoSong(
            baseInput({ playbackStatus: 'Stopped' }),
            'aumid',
        );
        expect(song).not.toBeNull();
        expect(song?.name).toBe('Track');
    });

    it('keeps identity stable for the same track and distinct across tracks', () => {
        const first = buildExternalMediaPseudoSong(baseInput(), 'aumid');
        const again = buildExternalMediaPseudoSong(baseInput(), 'aumid');
        const other = buildExternalMediaPseudoSong(baseInput({ title: 'Other' }), 'aumid');
        expect(again?.id).toBe(first?.id);
        expect(other?.id).not.toBe(first?.id);
    });

    it('tolerates a missing artist and album', () => {
        const song = buildExternalMediaPseudoSong(baseInput({ artist: null, album: null }), 'aumid');
        expect(song?.artists).toEqual([]);
        expect(song?.album).toEqual({ id: 0, name: '' });
    });
});

describe('buildExternalMediaEffectiveModel', () => {
    it('reports a ready playing session with queue-provided neighbors', () => {
        // canGoPrevious / canGoNext 由**调用方**按 Folia 的 queue 传入：next/previous 不透传给
        // 网页播放器（见 docs/external-media-backend.md「命令面」），所以"能不能切歌"只能由队列邻居决定。
        const model = buildExternalMediaEffectiveModel(baseInput(), 'ready', 'Chrome', {
            canGoPrevious: true,
            canGoNext: true,
            controlsDisabled: false,
        });
        expect(model).toMatchObject({
            backend: 'external-media',
            hasTrack: true,
            playerState: PlayerState.PLAYING,
            positionSec: 61,
            durationSec: 240,
            canGoPrevious: true,
            canGoNext: true,
            controlsDisabled: false,
            availability: 'ready',
        });
        // No thumbnail bytes this round, so the cover must stay empty instead of falling back
        // to whatever Folia last showed.
        expect(model.coverUrl).toBeNull();
    });

    it('defaults the neighbor flags to null so the caller keeps its own queue logic', () => {
        // null 的语义是"未提供，沿用现有逻辑" —— effective 层刻意不重算队列邻居，
        // 否则就是第二套规则（旧实现把它们绑在 canControl 上，"队列只剩一首"仍显示可切歌）。
        const model = buildExternalMediaEffectiveModel(baseInput(), 'ready', 'Chrome');
        expect(model.canGoPrevious).toBeNull();
        expect(model.canGoNext).toBeNull();
        // controlsDisabled 是唯一会自己推导的：ready + 有曲目 → 可控。
        expect(model.controlsDisabled).toBe(false);
    });

    it('keeps a paused session controllable', () => {
        const model = buildExternalMediaEffectiveModel(
            baseInput({ playbackStatus: 'Paused' }),
            'ready',
            'Chrome',
        );
        expect(model.playerState).toBe(PlayerState.PAUSED);
        expect(model.hasTrack).toBe(true);
        expect(model.controlsDisabled).toBe(false);
    });

    it('exposes no track when the session reports no media information', () => {
        const model = buildExternalMediaEffectiveModel(
            baseInput({ hasMedia: false, playbackStatus: 'Closed', title: null }),
            'ready',
            'Chrome',
        );
        expect(model.hasTrack).toBe(false);
        expect(model.song).toBeNull();
        expect(model.playerState).toBe(PlayerState.IDLE);
        expect(model.positionSec).toBe(0);
        expect(model.durationSec).toBe(0);
        // 没有曲目就没有任何东西可寻址 —— transport 自己禁用；邻居标志仍然留给调用方。
        expect(model.controlsDisabled).toBe(true);
        expect(model.canGoPrevious).toBeNull();
        expect(model.canGoNext).toBeNull();
    });

    it('keeps a Stopped track visible, mapped to IDLE, with transport still enabled', () => {
        // The regression this locks: treating Stopped as "no media" hid the song and disabled Play,
        // which is the exact control the user needs to resume it.
        const model = buildExternalMediaEffectiveModel(
            baseInput({ playbackStatus: 'Stopped', positionMs: 0 }),
            'ready',
            'Chrome',
        );
        expect(model.hasTrack).toBe(true);
        expect(model.song?.name).toBe('Track');
        expect(model.playerState).toBe(PlayerState.IDLE);
        expect(model.controlsDisabled).toBe(false);
    });

    it('disables transport when the bridge itself is unavailable', () => {
        const model = buildExternalMediaEffectiveModel(
            baseInput({ bridgeAvailable: false, connected: false, hasMedia: false, title: null }),
            'unavailable',
            null,
        );
        expect(model.availability).toBe('unavailable');
        expect(model.hasTrack).toBe(false);
        expect(model.controlsDisabled).toBe(true);
    });

    it('treats a null duration as unknown rather than as zero-length', () => {
        const model = buildExternalMediaEffectiveModel(
            baseInput({ durationMs: null, positionMs: null }),
            'ready',
            'Chrome',
        );
        expect(model.durationSec).toBe(0);
        expect(model.positionSec).toBe(0);
        // Still controllable: an unknown length must not disable the transport buttons.
        expect(model.controlsDisabled).toBe(false);
    });
});

describe('resolveExternalMediaClockSec', () => {
    it('converts the SMTC position to the seconds the playback clock uses', () => {
        expect(resolveExternalMediaClockSec('external-media', 164_000)).toBe(164);
        expect(resolveExternalMediaClockSec('external-media', 61_500)).toBe(61.5);
    });

    it('refuses to answer for any other backend', () => {
        // The four Folia / Stage clock sources own the clock there; a late SMTC snapshot must not
        // overwrite the position of a Folia deck that is actually playing.
        expect(resolveExternalMediaClockSec('folia', 164_000)).toBeNull();
    });

    it('reports "no position" rather than zero when the snapshot has none', () => {
        // Writing 0 here would snap the progress bar back to the start; "unknown" and "the very
        // beginning" are different facts.
        expect(resolveExternalMediaClockSec('external-media', null)).toBeNull();
        expect(resolveExternalMediaClockSec('external-media', undefined)).toBeNull();
        expect(resolveExternalMediaClockSec('external-media', Number.NaN)).toBeNull();
        expect(resolveExternalMediaClockSec('external-media', Number.POSITIVE_INFINITY)).toBeNull();
    });

    it('clamps a negative position to zero', () => {
        expect(resolveExternalMediaClockSec('external-media', -1000)).toBe(0);
    });
});
