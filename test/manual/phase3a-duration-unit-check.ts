// test/manual/phase3a-duration-unit-check.ts
//
// Phase 3A duration 秒契约的运行时自检。与 test/unit/overlays/overlayDurationUnit.test.ts 覆盖
// 同一批断言，区别只在运行方式：vitest 在 Windows 上要 spawn 子进程加载 vite 配置，agent 沙箱里
// 会被拒绝（spawn EPERM）；这里用仓库自带的 rolldown 打包后直接跑 node。
//
// 修复前的两处错误换算（互为抵消）：
//   * `useEffectivePlayback` 把 Folia 的秒值 `/ 1000` → 164 变 0.164
//   * `useAppOverlaysModel` 把 effective 的秒值 `* 1000` 当毫秒 → 164 变 164000
// Apple Music 显示 `2733:20` 就是后半段造成的：164s 被 `formatTime` 当成 164000 秒。
//
// 运行：
//   node node_modules/rolldown/bin/cli.mjs test/manual/phase3a-duration-unit-check.ts \
//     --format esm --platform node --file "$env:TEMP/phase3a-duration-unit-check.mjs"
//   node "$env:TEMP/phase3a-duration-unit-check.mjs"
import { motionValue } from 'framer-motion';
import { PlayerState, type SongResult } from '../../src/types';
import {
    buildExternalMediaEffectiveModel,
    buildFoliaEffectiveModel,
    type ExternalMediaEffectiveInput,
} from '../../src/utils/effectivePlayback';
import { buildAppOverlaysModel } from '../../src/components/app/overlays/buildAppOverlaysModel';
import { resolveOverlayDurationSec } from '../../src/components/app/overlays/useAppOverlaysModel';

let failures = 0;
let checks = 0;
const check = (label: string, condition: boolean, detail = '') => {
    checks += 1;
    if (condition) {
        console.log(`  ok   ${label}`);
        return;
    }
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (label: string, actual: unknown, expected: unknown) => {
    check(label, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}`);
};

const DURATION_SEC = 164;
const DURATION_MS = DURATION_SEC * 1000;

const foliaSong: SongResult = {
    id: 'folia-1',
    name: 'Folia Track',
    artists: [{ id: 1, name: 'Artist' }],
    album: { id: 1, name: 'Album' },
    durationMs: DURATION_MS,
};

const foliaModel = () => buildFoliaEffectiveModel({
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

const appleMusicInput = (over: Partial<ExternalMediaEffectiveInput> = {}): ExternalMediaEffectiveInput => ({
    bridgeAvailable: true,
    connected: true,
    hasMedia: true,
    title: 'Apple Music Track',
    artist: 'Artist',
    album: 'Album',
    playbackStatus: 'Playing',
    positionMs: 61_000,
    durationMs: DURATION_MS,
    ...over,
});

const appleMusicModel = () => buildExternalMediaEffectiveModel(appleMusicInput(), 'ready', 'Chrome');

const buildOverlays = (duration: number) => buildAppOverlaysModel({
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
    stageTrackPillOnScreen: false,
    stageTrackPillMode: 'auto',
    stageTrackPillTimeoutSec: 10,
    stageNextUp: null,
    stageIsNextUp: false,
} as unknown as Parameters<typeof buildAppOverlaysModel>[0]);

console.log('effective 模型：两个后端都是秒');
eq('Folia durationSec', foliaModel().durationSec, DURATION_SEC);
eq('Apple Music durationSec', appleMusicModel().durationSec, DURATION_SEC);
eq('两后端相等', foliaModel().durationSec, appleMusicModel().durationSec);
check('Folia 不再是 0.164', foliaModel().durationSec !== DURATION_SEC / 1000, 'still /1000');
check('Apple Music 不再是 164000', appleMusicModel().durationSec !== DURATION_MS, 'still ms');

console.log('\noverlay 出口：不做换算');
eq('overlay(Folia)', resolveOverlayDurationSec(foliaModel()), DURATION_SEC);
eq('overlay(Apple Music)', resolveOverlayDurationSec(appleMusicModel()), DURATION_SEC);
check('overlay 未变毫秒', resolveOverlayDurationSec(appleMusicModel()) < DURATION_MS, 'multiplied by 1000');

console.log('\n浮层模型：秒值原样到达 floatingControls');
eq('floatingControls.duration', buildOverlays(DURATION_SEC).floatingControls?.duration, DURATION_SEC);
check(
    'floatingControls.duration 未变毫秒',
    buildOverlays(DURATION_SEC).floatingControls?.duration !== DURATION_MS,
    'multiplied by 1000',
);

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
