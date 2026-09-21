// test/manual/phase3a-effective-playback-check.ts
//
// Phase 3A 纯逻辑的运行时自检（SMTC 判据 / PlayerState 映射 / effective model 的三条硬约束 /
// 共享发布模型的零回归等价）。与 test/unit/effectivePlayback.test.ts 覆盖同一批规则，区别只在
// 运行方式：
//
//   vitest 需要 vite 加载 vitest.config.ts，而 vite 在 Windows 上的 real-path 解析会 spawn 子进程，
//   在 agent 沙箱里被拒绝（spawn EPERM）。这个文件用仓库自带的 rolldown 打包后直接跑 node，
//   因此可以在没有 GUI 的环境里复核规则。`npm test` 仍是正式门禁，本文件是补充而非替代。
//
// 运行：
//   node node_modules/rolldown/bin/cli.mjs test/manual/phase3a-effective-playback-check.ts \
//     --format esm --platform node --file "$env:TEMP/phase3a-check.mjs"
//   node "$env:TEMP/phase3a-check.mjs"
import { PlayerState } from '../../src/types';
import {
    buildAppleMusicEffectiveModel,
    buildAppleMusicPseudoSong,
    mapAppleMusicPlayerState,
    type AppleMusicEffectiveInput,
} from '../../src/utils/effectivePlayback';
import { hasAppleMusicMedia, resolveAppleMusicAvailability } from '../../src/utils/appleMusicSmtcStatus';
import { buildPlaybackSyncBridgeModel } from '../../src/utils/playbackSyncBridge';

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

const input = (over: Partial<AppleMusicEffectiveInput> = {}): AppleMusicEffectiveInput => ({
    bridgeAvailable: true,
    connected: true,
    hasMedia: true,
    title: 'Track',
    artist: 'Artist',
    album: 'Album',
    playbackStatus: 'Playing',
    positionMs: 61_000,
    durationMs: 240_000,
    ...over,
});

const status = (over: Partial<ElectronAppleMusicSmtcStatus> = {}): ElectronAppleMusicSmtcStatus => ({
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
    ...over,
});

console.log('SMTC 判据');
eq('Playing 有媒体', hasAppleMusicMedia(status()), true);
eq('Paused 有媒体', hasAppleMusicMedia(status({ playbackStatus: 'Paused' })), true);
eq('Stopped 仍有媒体（曲目要留在界面上）', hasAppleMusicMedia(status({ playbackStatus: 'Stopped' })), true);
eq('Opened 仍有媒体', hasAppleMusicMedia(status({ playbackStatus: 'Opened' })), true);
eq('Changing 仍有媒体', hasAppleMusicMedia(status({ playbackStatus: 'Changing' })), true);
eq('无标题则无媒体', hasAppleMusicMedia(status({ title: null })), false);
eq('空白标题则无媒体', hasAppleMusicMedia(status({ title: '   ' })), false);
eq('无 session 则无媒体', hasAppleMusicMedia(status({ connected: false })), false);
eq('null 无媒体', hasAppleMusicMedia(null), false);
eq('三态 unavailable', resolveAppleMusicAvailability(status({ bridgeAvailable: false })), 'unavailable');
eq('三态 not-running', resolveAppleMusicAvailability(status({ connected: false })), 'not-running');
eq('三态 connected', resolveAppleMusicAvailability(status()), 'connected');

console.log('\nPlayerState 映射');
eq('Playing', mapAppleMusicPlayerState('Playing'), PlayerState.PLAYING);
eq('Paused', mapAppleMusicPlayerState('Paused'), PlayerState.PAUSED);
for (const value of ['Closed', 'Stopped', 'Opened', 'Changing', 'Unknown(99)', null]) {
    eq(`${String(value)} → IDLE`, mapAppleMusicPlayerState(value), PlayerState.IDLE);
}

console.log('\n硬约束 4：无有效媒体时不得暴露伪 Song');
{
    const model = buildAppleMusicEffectiveModel(
        input({ hasMedia: false, playbackStatus: 'Closed', title: null }),
        'connected',
        'aumid',
    );
    eq('song 为 null', model.song, null);
    eq('hasTrack=false', model.hasTrack, false);
    eq('playerState=IDLE', model.playerState, PlayerState.IDLE);
    eq('controlsDisabled=true', model.controlsDisabled, true);
    eq('canGoPrevious=false', model.canGoPrevious, false);
    eq('canGoNext=false', model.canGoNext, false);
    eq('position 归零', model.positionSec, 0);
}

console.log('\nsession / media / state 三者分离：Stopped / Opened 仍有曲目且 Play 可用');
{
    const stopped = buildAppleMusicEffectiveModel(
        input({ playbackStatus: 'Stopped', positionMs: 0 }),
        'connected',
        'aumid',
    );
    eq('Stopped 保留曲目', stopped.song?.name, 'Track');
    eq('Stopped hasTrack=true', stopped.hasTrack, true);
    eq('Stopped 状态映射 IDLE', stopped.playerState, PlayerState.IDLE);
    eq('Stopped 不禁用 transport', stopped.controlsDisabled, false);
    eq('Stopped 仍可 next', stopped.canGoNext, true);

    const opened = buildAppleMusicEffectiveModel(input({ playbackStatus: 'Opened' }), 'connected', 'aumid');
    eq('Opened 保留曲目', opened.hasTrack, true);
    eq('Opened 不禁用 transport', opened.controlsDisabled, false);

    const changing = buildAppleMusicEffectiveModel(input({ playbackStatus: 'Changing' }), 'connected', 'aumid');
    eq('Changing 保留曲目', changing.hasTrack, true);
    eq('Changing 不谎报 PLAYING', changing.playerState, PlayerState.IDLE);
}
{
    const disconnected = buildAppleMusicEffectiveModel(
        input({ bridgeAvailable: false, connected: false, hasMedia: false, title: null }),
        'unavailable',
        null,
    );
    eq('bridge 不可用时 song 为 null', disconnected.song, null);
    eq('bridge 不可用 controlsDisabled', disconnected.controlsDisabled, true);
}
{
    const paused = buildAppleMusicEffectiveModel(input({ playbackStatus: 'Paused' }), 'connected', 'aumid');
    eq('暂停仍可控', paused.controlsDisabled, false);
    eq('暂停状态正确', paused.playerState, PlayerState.PAUSED);
    eq('封面为空而非回落', paused.coverUrl, null);
    eq('位置 61s', paused.positionSec, 61);
}

console.log('\n伪 Song 形状');
{
    const song = buildAppleMusicPseudoSong(input(), 'AppleInc.AppleMusicWin_nzyj5cx40ttqa!App');
    eq('无 sourceRef', song?.sourceRef, undefined);
    eq('无 provider 归属', song?.playbackSourceRevision, undefined);
    check('id 为负', Number(song?.id ?? 0) < 0, String(song?.id));
    const aumid = 'AppleInc.AppleMusicWin_nzyj5cx40ttqa!App';
    eq('同上曲目 id 稳定', buildAppleMusicPseudoSong(input(), aumid)?.id === song?.id, true);
    eq('换曲目 id 变化', buildAppleMusicPseudoSong(input({ title: 'Other' }), aumid)?.id !== song?.id, true);
    eq('换 session 来源 id 变化', buildAppleMusicPseudoSong(input(), 'other-aumid')?.id !== song?.id, true);
    eq('无媒体信息返回 null', buildAppleMusicPseudoSong(input({ hasMedia: false, title: null }), 'aumid'), null);
    eq('空标题返回 null', buildAppleMusicPseudoSong(input({ title: null }), 'aumid'), null);
}

console.log('\n零回归：不传 effective 时模型逐字段等价');
{
  const base = (over: Record<string, unknown> = {}) => {
      const currentSong = {
          id: 2,
          name: 'Current Song',
          artists: [{ id: 2, name: 'Artist 2' }],
          album: { id: 2, name: 'Album 2', coverUrl: 'https://example.com/2.jpg' },
          durationMs: 180_000,
      };
      return {
          activePlaybackContext: 'main' as const,
          currentSong,
          playQueue: [
              { ...currentSong, id: 1, name: 'Prev' },
              currentSong,
              { ...currentSong, id: 3, name: 'Next' },
          ],
          currentTimeSec: 42,
          durationSec: 180,
          playerState: PlayerState.PLAYING,
          coverUrl: null,
          cachedCoverUrl: null,
          effectiveLoopMode: 'off' as const,
          isFmMode: false,
          isStageActive: false,
          controlsDisabled: false,
          transparentModeEnabled: false,
          mainWindowClickThroughEnabled: false,
          mainWindowBorderVisible: false,
          playerChromeHidden: false,
          exportState: { status: 'idle', presetId: null, progress: 0, elapsed: 0, duration: 0, countdown: null, filePath: null, error: null },
          isDaylight: false,
          isLiked: false,
          mainWindowWidth: 800,
          mainWindowHeight: 600,
          sampledAt: 999,
          ...over,
      } as Parameters<typeof buildPlaybackSyncBridgeModel>[0];
  };

  const plain = buildPlaybackSyncBridgeModel(base());
  const withEmptyOverride = buildPlaybackSyncBridgeModel(base({ effective: {} }));
  eq('省略与空覆盖完全一致', plain, withEmptyOverride);
  eq('hasTrack 未变', plain.hasTrack, true);
  eq('canGoPrevious 未变', plain.canGoPrevious, true);
  eq('canGoNext 未变', plain.canGoNext, true);
  eq('controlsDisabled 未变', plain.controlsDisabled, false);
}
{
    const appleSong = {
        id: -7,
        name: 'Apple Track',
        artists: [{ id: 0, name: 'Apple Artist' }],
        album: { id: 0, name: '' },
        durationMs: 240_000,
    };
    const model = buildPlaybackSyncBridgeModel({
        activePlaybackContext: 'main',
        currentSong: null,
        playQueue: [],
        currentTimeSec: 0,
        durationSec: 0,
        playerState: PlayerState.IDLE,
        coverUrl: null,
        cachedCoverUrl: null,
        effectiveLoopMode: 'off',
        isFmMode: false,
        isStageActive: false,
        controlsDisabled: false,
        transparentModeEnabled: false,
        mainWindowClickThroughEnabled: false,
        mainWindowBorderVisible: false,
        playerChromeHidden: false,
        exportState: { status: 'idle', presetId: null, progress: 0, elapsed: 0, duration: 0, countdown: null, filePath: null, error: null },
        isDaylight: false,
        isLiked: false,
        mainWindowWidth: 800,
        mainWindowHeight: 600,
        sampledAt: 1,
        effective: {
            currentSong: appleSong,
            playerState: PlayerState.PAUSED,
            hasTrack: true,
            title: 'Apple Track',
            artist: 'Apple Artist',
            coverUrl: null,
            currentTimeSec: 61,
            durationSec: 240,
            canGoPrevious: true,
            canGoNext: true,
            controlsDisabled: false,
        },
    } as Parameters<typeof buildPlaybackSyncBridgeModel>[0]);
    eq('覆盖后 hasTrack', model.hasTrack, true);
    eq('覆盖后 playerState', model.playerState, PlayerState.PAUSED);
    eq('覆盖后标题', model.title, 'Apple Track');
    eq('覆盖后位置', model.currentTimeSec, 61);
    eq('覆盖后时长', model.durationSec, 240);
    eq('覆盖后 canGoPrevious', model.canGoPrevious, true);
    eq('覆盖后 canGoNext', model.canGoNext, true);
    eq('覆盖后 controlsDisabled', model.controlsDisabled, false);
}
{
    const model = buildPlaybackSyncBridgeModel({
        activePlaybackContext: 'main',
        currentSong: null,
        playQueue: [],
        currentTimeSec: 0,
        durationSec: 0,
        playerState: PlayerState.IDLE,
        coverUrl: null,
        cachedCoverUrl: null,
        effectiveLoopMode: 'off',
        isFmMode: false,
        isStageActive: false,
        controlsDisabled: false,
        transparentModeEnabled: false,
        mainWindowClickThroughEnabled: false,
        mainWindowBorderVisible: false,
        playerChromeHidden: false,
        exportState: { status: 'idle', presetId: null, progress: 0, elapsed: 0, duration: 0, countdown: null, filePath: null, error: null },
        isDaylight: false,
        isLiked: false,
        mainWindowWidth: 800,
        mainWindowHeight: 600,
        sampledAt: 1,
        effective: { currentSong: null, hasTrack: false, title: null, artist: null, controlsDisabled: true },
    } as Parameters<typeof buildPlaybackSyncBridgeModel>[0]);
    eq('断开时无残留标题', model.title, null);
    eq('断开时无残留艺术家', model.artist, null);
    eq('断开时 hasTrack=false', model.hasTrack, false);
    eq('断开时 controlsDisabled=true', model.controlsDisabled, true);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
