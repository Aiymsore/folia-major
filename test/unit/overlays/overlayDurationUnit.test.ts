import { describe, expect, it } from 'vitest';
import { motionValue } from 'framer-motion';
import { PlayerState, type SongResult } from '../../../src/types';
import {
    buildAppleMusicEffectiveModel,
    buildFoliaEffectiveModel,
    type AppleMusicEffectiveInput,
} from '../../../src/utils/effectivePlayback';
import { buildAppOverlaysModel } from '../../../src/components/app/overlays/buildAppOverlaysModel';
import { resolveOverlayDurationSec } from '../../../src/components/app/overlays/useAppOverlaysModel';

// test/unit/overlays/overlayDurationUnit.test.ts
//
// 锁死 Phase 3A 的 duration 秒契约。这条链上曾经同时存在两处多余换算：
//   * `useEffectivePlayback` 把 Folia 的秒值 `/ 1000`（164 → 0.164）；
//   * `useAppOverlaysModel` 把 effective 的秒值 `* 1000` 当毫秒（164 → 164000）。
// 两者对 Folia 恰好互相抵消，所以表面看不出问题；Apple Music 的输入本来就是毫秒，`/ 1000`
// 先把它变成正确的秒，再被 `* 1000` 推回 164000，于是 164 秒的曲目在 `ProgressBar` 里
// 被 `formatTime` 当成 164000 秒，显示成 `2733:20`。
//
// 这里不测 hook 本身（仓库是 node 测试环境，没有 renderHook / testing-library），而是把契约
// 钉在它两侧的纯边界上：effective 模型必须给出秒，overlay 出口必须把秒原样交出。
// `resolveOverlayDurationSec` 是唯一的 overlay 出口换算点，因此第 3 条断言会直接抓住
// 「又乘回毫秒」这类回归。

const DURATION_SEC = 164;
const DURATION_MS = DURATION_SEC * 1000;

const foliaSong: SongResult = {
    id: 'folia-1',
    name: 'Folia Track',
    artists: [{ id: 1, name: 'Artist' }],
    album: { id: 1, name: 'Album' },
    durationMs: DURATION_MS,
};

const appleMusicInput = (overrides: Partial<AppleMusicEffectiveInput> = {}): AppleMusicEffectiveInput => ({
    bridgeAvailable: true,
    connected: true,
    hasMedia: true,
    title: 'Apple Music Track',
    artist: 'Artist',
    album: 'Album',
    playbackStatus: 'Playing',
    positionMs: 61_000,
    durationMs: DURATION_MS,
    ...overrides,
});

/** 覆盖 `buildAppOverlaysModel` 实际读到的字段；`duration` 是本文件唯一关心的一项。 */
const buildOverlaysWithDuration = (duration: number) => buildAppOverlaysModel({
    currentView: 'player',
    currentSong: foliaSong,
    playerState: PlayerState.PLAYING,
    currentTime: motionValue(0),
    lyricCurrentTime: motionValue(0),
    duration,
    lyrics: null,
    audioSrc: 'blob:folia-track',
    activePlaybackContext: 'main',
    playQueue: [foliaSong],
    effectiveLoopMode: 'off',
    isFmMode: false,
    isNowPlayingStageActive: false,
    isNowPlayingControlDisabled: false,
    isPlayerChromeHidden: false,
    shouldHidePlayerProgressBar: false,
    coverUrl: null,
    // 只要 currentSong 非空,浮层模型就会走进 floatingControls 分支,这里必须给全该分支读到的值。
    stageTrackPillOnScreen: false,
    stageTrackPillMode: 'auto',
    stageTrackPillTimeoutSec: 10,
    stageNextUp: null,
    stageIsNextUp: false,
} as unknown as Parameters<typeof buildAppOverlaysModel>[0]);

describe('duration 单位契约：effective 模型是秒', () => {
    it('Folia：把 display selector 的秒值原样交给 effective 模型', () => {
        // 回归保护点：`useEffectivePlayback` 曾经在这里 `/ 1000`,得到 0.164。
        const model = buildFoliaEffectiveModel({
            hasTrack: true,
            song: foliaSong,
            playerState: PlayerState.PLAYING,
            positionSec: 61,
            durationSec: DURATION_SEC,
            coverUrl: null,
            canGoPrevious: true,
            canGoNext: true,
            controlsDisabled: false,
        });

        expect(model.durationSec).toBe(DURATION_SEC);
        expect(model.durationSec).not.toBe(DURATION_SEC / 1000);
    });

    it('Apple Music：把 SMTC 的 durationMs 换算成秒', () => {
        const model = buildAppleMusicEffectiveModel(appleMusicInput(), 'connected', 'AppleInc.AppleMusicWin');

        expect(model.durationSec).toBe(DURATION_SEC);
        expect(model.durationSec).not.toBe(DURATION_MS);
    });

    it('两个后端在 effective 出口处得到完全相同的秒值', () => {
        const folia = buildFoliaEffectiveModel({
            hasTrack: true,
            song: foliaSong,
            playerState: PlayerState.PLAYING,
            positionSec: 61,
            durationSec: DURATION_SEC,
            coverUrl: null,
            canGoPrevious: true,
            canGoNext: true,
            controlsDisabled: false,
        });
        const appleMusic = buildAppleMusicEffectiveModel(appleMusicInput(), 'connected', 'AppleInc.AppleMusicWin');

        expect(folia.durationSec).toBe(appleMusic.durationSec);
    });
});

describe('duration 单位契约：overlay 出口不再换算', () => {
    it('overlay 时长与 effective.durationSec 完全相同', () => {
        // 回归保护点：`useAppOverlaysModel` 曾经在这里 `* 1000`,得到 164000。
        const model = buildAppleMusicEffectiveModel(appleMusicInput(), 'connected', 'AppleInc.AppleMusicWin');

        expect(resolveOverlayDurationSec(model)).toBe(DURATION_SEC);
    });

    it('164 秒不会被折算成毫秒的数', () => {
        const model = buildAppleMusicEffectiveModel(appleMusicInput(), 'connected', 'AppleInc.AppleMusicWin');

        // 不写成 `expect(overlayDuration).not.toBe(...)` 的具体值:这里要钉的是量级。
        expect(resolveOverlayDurationSec(model)).toBeLessThan(DURATION_MS);
    });

    it('Folia 与 Apple Music 交出的 overlay 时长一致', () => {
        const folia = buildFoliaEffectiveModel({
            hasTrack: true,
            song: foliaSong,
            playerState: PlayerState.PLAYING,
            positionSec: 61,
            durationSec: DURATION_SEC,
            coverUrl: null,
            canGoPrevious: true,
            canGoNext: true,
            controlsDisabled: false,
        });
        const appleMusic = buildAppleMusicEffectiveModel(appleMusicInput(), 'connected', 'AppleInc.AppleMusicWin');

        expect(resolveOverlayDurationSec(folia)).toBe(resolveOverlayDurationSec(appleMusic));
        expect(resolveOverlayDurationSec(folia)).toBe(DURATION_SEC);
    });
});

describe('duration 单位契约：浮层模型原样透传到 ProgressBar', () => {
    it('传进浮层模型的秒值不会被放大', () => {
        const overlays = buildOverlaysWithDuration(DURATION_SEC);

        expect(overlays.floatingControls?.duration).toBe(DURATION_SEC);
    });

    it('浮层模型不会把秒值换算成毫秒', () => {
        const overlays = buildOverlaysWithDuration(DURATION_SEC);

        expect(overlays.floatingControls?.duration).not.toBe(DURATION_MS);
    });
});
