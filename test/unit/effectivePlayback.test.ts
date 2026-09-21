import { describe, expect, it } from 'vitest';
import { PlayerState } from '../../src/types';
import {
    buildAppleMusicEffectiveModel,
    buildAppleMusicPseudoSong,
    mapAppleMusicPlayerState,
    type AppleMusicEffectiveInput,
} from '../../src/utils/effectivePlayback';
import { hasAppleMusicMedia, resolveAppleMusicClockSec } from '../../src/utils/appleMusicSmtcStatus';

// test/unit/effectivePlayback.test.ts
// Phase 3A 的核心规则锁定：Apple Music 后端下什么算「有曲目」、什么时候必须暴露 null、
// 什么时候禁用 transport。
//
// 最关键的一条是 session / media / state 三者分离：有 session 且报告了曲目信息就算 hasMedia，
// **播放状态不参与这个判断**。所以 `Stopped` 的曲目仍然要显示出来、Play 仍然可用 —— 按播放正是
// 用户从该状态恢复的方式。把这些规则逐条断言，而不是整体快照。

const baseInput = (overrides: Partial<AppleMusicEffectiveInput> = {}): AppleMusicEffectiveInput => ({
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

const status = (overrides: Partial<ElectronAppleMusicSmtcStatus> = {}): ElectronAppleMusicSmtcStatus => ({
    bridgeAvailable: true,
    helperState: 'running',
    connected: true,
    sourceAppUserModelId: 'AppleInc.AppleMusicWin_nzyj5cx40ttqa!App',
    title: 'Track',
    artist: 'Artist',
    album: null,
    playbackStatus: 'Playing',
    positionMs: 61_000,
    durationMs: 240_000,
    hasThumbnail: true,
    updatedAt: 1,
    lastEventAt: 1,
    sessionCount: 2,
    lastCommand: null,
    lastError: null,
    ...overrides,
});
describe('mapAppleMusicPlayerState', () => {
    it('maps only the two states that describe loaded media', () => {
        expect(mapAppleMusicPlayerState('Playing')).toBe(PlayerState.PLAYING);
        expect(mapAppleMusicPlayerState('Paused')).toBe(PlayerState.PAUSED);
    });

    it('maps everything else to IDLE rather than guessing', () => {
        // Changing included on purpose: SMTC's Changing does not guarantee the next state is Playing,
        // and reporting PLAYING during a track switch is what makes the UI flash "now playing".
        for (const value of ['Closed', 'Stopped', 'Opened', 'Changing', 'Unknown(99)', null, '']) {
            expect(mapAppleMusicPlayerState(value)).toBe(PlayerState.IDLE);
        }
    });
});

describe('hasAppleMusicMedia', () => {
    it('requires a visible session and reported track information', () => {
        expect(hasAppleMusicMedia(status())).toBe(true);
        expect(hasAppleMusicMedia(status({ connected: false }))).toBe(false);
        expect(hasAppleMusicMedia(status({ title: null }))).toBe(false);
        expect(hasAppleMusicMedia(status({ title: '   ' }))).toBe(false);
        expect(hasAppleMusicMedia(null)).toBe(false);
    });

    it('ignores the playback state entirely', () => {
        // The rule this locks: a Stopped/Opened/Changing track is still a track. Gating on
        // `Playing|Paused` used to hide the song and disable Play exactly when the user wanted to
        // resume it.
        for (const playbackStatus of ['Playing', 'Paused', 'Stopped', 'Opened', 'Changing', 'Unknown(9)']) {
            expect(hasAppleMusicMedia(status({ playbackStatus }))).toBe(true);
        }
        // Only the session/track information decides.
        expect(hasAppleMusicMedia(status({ playbackStatus: 'Stopped', title: null }))).toBe(false);
    });
});

describe('buildAppleMusicPseudoSong', () => {
    it('produces a minimal SongResult with no provider identity', () => {
        const song = buildAppleMusicPseudoSong(baseInput(), 'AppleInc.AppleMusicWin_nzyj5cx40ttqa!App');
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
        expect(buildAppleMusicPseudoSong(baseInput({ hasMedia: false }), 'aumid')).toBeNull();
        expect(buildAppleMusicPseudoSong(baseInput({ title: null }), 'aumid')).toBeNull();
        expect(buildAppleMusicPseudoSong(baseInput({ title: '   ' }), 'aumid')).toBeNull();
    });

    it('keeps the track for a Stopped session, because resuming from there is the point', () => {
        const song = buildAppleMusicPseudoSong(
            baseInput({ playbackStatus: 'Stopped' }),
            'aumid',
        );
        expect(song).not.toBeNull();
        expect(song?.name).toBe('Track');
    });

    it('keeps identity stable for the same track and distinct across tracks', () => {
        const first = buildAppleMusicPseudoSong(baseInput(), 'aumid');
        const again = buildAppleMusicPseudoSong(baseInput(), 'aumid');
        const other = buildAppleMusicPseudoSong(baseInput({ title: 'Other' }), 'aumid');
        expect(again?.id).toBe(first?.id);
        expect(other?.id).not.toBe(first?.id);
    });

    it('tolerates a missing artist and album', () => {
        const song = buildAppleMusicPseudoSong(baseInput({ artist: null, album: null }), 'aumid');
        expect(song?.artists).toEqual([]);
        expect(song?.album).toEqual({ id: 0, name: '' });
    });
});

describe('buildAppleMusicEffectiveModel', () => {
    it('reports a connected playing session', () => {
        const model = buildAppleMusicEffectiveModel(baseInput(), 'connected', 'aumid');
        expect(model).toMatchObject({
            backend: 'apple-music',
            hasTrack: true,
            playerState: PlayerState.PLAYING,
            positionSec: 61,
            durationSec: 240,
            canGoPrevious: true,
            canGoNext: true,
            controlsDisabled: false,
            availability: 'connected',
        });
        // No thumbnail bytes this round, so the cover must stay empty instead of falling back
        // to whatever Folia last showed.
        expect(model.coverUrl).toBeNull();
    });

    it('keeps a paused session controllable', () => {
        const model = buildAppleMusicEffectiveModel(
            baseInput({ playbackStatus: 'Paused' }),
            'connected',
            'aumid',
        );
        expect(model.playerState).toBe(PlayerState.PAUSED);
        expect(model.hasTrack).toBe(true);
        expect(model.controlsDisabled).toBe(false);
    });

    it('exposes no track when the session reports no media information', () => {
        const model = buildAppleMusicEffectiveModel(
            baseInput({ hasMedia: false, playbackStatus: 'Closed', title: null }),
            'connected',
            'aumid',
        );
        expect(model.hasTrack).toBe(false);
        expect(model.song).toBeNull();
        expect(model.playerState).toBe(PlayerState.IDLE);
        expect(model.positionSec).toBe(0);
        expect(model.durationSec).toBe(0);
        expect(model.canGoPrevious).toBe(false);
        expect(model.canGoNext).toBe(false);
        expect(model.controlsDisabled).toBe(true);
    });

    it('keeps a Stopped track visible, mapped to IDLE, with transport still enabled', () => {
        // The regression this locks: treating Stopped as "no media" hid the song and disabled Play,
        // which is the exact control the user needs to resume it.
        const model = buildAppleMusicEffectiveModel(
            baseInput({ playbackStatus: 'Stopped', positionMs: 0 }),
            'connected',
            'aumid',
        );
        expect(model.hasTrack).toBe(true);
        expect(model.song?.name).toBe('Track');
        expect(model.playerState).toBe(PlayerState.IDLE);
        expect(model.controlsDisabled).toBe(false);
        expect(model.canGoNext).toBe(true);
    });

    it('disables transport when the bridge itself is unavailable', () => {
        const model = buildAppleMusicEffectiveModel(
            baseInput({ bridgeAvailable: false, connected: false, hasMedia: false, title: null }),
            'unavailable',
            null,
        );
        expect(model.availability).toBe('unavailable');
        expect(model.hasTrack).toBe(false);
        expect(model.controlsDisabled).toBe(true);
    });

    it('treats a null duration as unknown rather than as zero-length', () => {
        const model = buildAppleMusicEffectiveModel(
            baseInput({ durationMs: null, positionMs: null }),
            'connected',
            'aumid',
        );
        expect(model.durationSec).toBe(0);
        expect(model.positionSec).toBe(0);
        // Still controllable: an unknown length must not disable the transport buttons.
        expect(model.controlsDisabled).toBe(false);
    });
});

describe('resolveAppleMusicClockSec', () => {
    it('converts the SMTC position to the seconds the playback clock uses', () => {
        expect(resolveAppleMusicClockSec('apple-music', 164_000)).toBe(164);
        expect(resolveAppleMusicClockSec('apple-music', 61_500)).toBe(61.5);
    });

    it('refuses to answer for any other backend', () => {
        // The four Folia / Stage clock sources own the clock there; a late SMTC snapshot must not
        // overwrite the position of a Folia deck that is actually playing.
        expect(resolveAppleMusicClockSec('folia', 164_000)).toBeNull();
    });

    it('reports "no position" rather than zero when the snapshot has none', () => {
        // Writing 0 here would snap the progress bar back to the start; "unknown" and "the very
        // beginning" are different facts.
        expect(resolveAppleMusicClockSec('apple-music', null)).toBeNull();
        expect(resolveAppleMusicClockSec('apple-music', undefined)).toBeNull();
        expect(resolveAppleMusicClockSec('apple-music', Number.NaN)).toBeNull();
        expect(resolveAppleMusicClockSec('apple-music', Number.POSITIVE_INFINITY)).toBeNull();
    });

    it('clamps a negative position to zero', () => {
        expect(resolveAppleMusicClockSec('apple-music', -1000)).toBe(0);
    });
});
