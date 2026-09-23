import { useMemo } from 'react';
import { currentTime, lyricCurrentTime } from '../../../stores/motionSignals';
import { useAppViewStore } from '../../../stores/useAppViewStore';
import { useAppChromeStore } from '../../../stores/useAppChromeStore';
import { useSearchNavigationStore } from '../../../stores/useSearchNavigationStore';
import { useThemeSettingsStore } from '../../../stores/useThemeSettingsStore';
import { useStageSettingsStore } from '../../../stores/useStageSettingsStore';
import { usePlayerChromeSettingsStore } from '../../../stores/usePlayerChromeSettingsStore';
import { useTranslation } from 'react-i18next';
import {
    usePlaybackStore,
} from '../../../stores/usePlaybackStore';
import { useDisplayLyrics } from '../../../hooks/useDisplayLyrics';
import { useEffectivePlaybackModel } from '../../../hooks/useEffectivePlayback';
import { resolveLikeAvailability } from '../../../utils/playerLikeAvailability';
import { buildAppOverlaysModel, type AppOverlaysDeps, type AppOverlaysModel } from './buildAppOverlaysModel';

// src/components/app/overlays/useAppOverlaysModel.ts

const MEMORY_MONITOR_SHORTCUT_LABEL = 'Alt+Shift+M';

/**
 * 生效时长交给 overlay 模型时**不做任何换算**，两个后端共用同一条秒契约：
 *   * `effective.durationSec` 永远是秒 —— Folia 的 `selectDisplayDuration` 本身就是秒
 *     （`store.duration` 来自 `HTMLAudioElement.duration`）；Apple Music 的 SMTC `durationMs`
 *     已在 `buildExternalMediaEffectiveModel` 里 `/ 1000`；
 *   * 下游 `FloatingPlayerControls` → `ProgressBar` → `formatTime` 也全部按秒，与 motion signal
 *     `currentTime`（秒）同标尺。
 *
 * 这里曾经写成 `* 1000`（并声称模型层要毫秒）：对 Apple Music 把 164s 变成 164000 并显示成
 * `2733:20`；对 Folia 则只是与 `useEffectivePlayback` 里那处多余的 `/ 1000` 互相抵消，表面看不出
 * 来 —— 实际是 164s 被当成 164000 秒格式化，进度条分母同时错 1000 倍。
 */
export const resolveOverlayDurationSec = (effective: { durationSec: number }): number => effective.durationSec;

/**
 * The overlay model with everything this file can reach on its own already filled in.
 *
 * Store reads, the two motion signals and the five translated labels used to be 25 entries in
 * App.tsx's argument list plus 25 more in its dependency array - and adding one overlay field meant
 * editing App.tsx, the params type and the mapping below. Now a store-backed field is this file
 * alone.
 */
export const useAppOverlaysModel = (deps: AppOverlaysDeps): AppOverlaysModel => {
    const { t } = useTranslation();
    const currentView = useAppViewStore(state => state.view);
    const isPlayerChromeHidden = useAppChromeStore(state => state.isPlayerChromeHidden);
    const isDevDebugOverlayVisible = useAppChromeStore(state => state.isDevDebugOverlayVisible);
    const isMemoryMonitorVisible = useAppChromeStore(state => state.isMemoryMonitorVisible);
    const isSearchOpen = useSearchNavigationStore(state => state.isSearchOpen);
    const isDaylight = useThemeSettingsStore(state => state.isDaylight);
    const stageTrackPillMode = useStageSettingsStore(state => state.stageTrackPillMode);
    const stageTrackPillTimeoutSec = useStageSettingsStore(state => state.stageTrackPillTimeoutSec);
    const playerControlSlotPrimary = usePlayerChromeSettingsStore(state => state.playerControlSlotPrimary);
    const playerControlSlotSecondary = usePlayerChromeSettingsStore(state => state.playerControlSlotSecondary);
    const handleSetPlayerBottomBarOffset = usePlayerChromeSettingsStore(state => state.handleSetPlayerBottomBarOffset);
    // Phase 3A: the displayed track, its length, its cover and its transport state now come from the
    // effective model, so this one seam switches the whole player surface between Folia and Apple
    // Music. Everything else here (queue, FM mode, stage context, like state) stays Folia's: Apple
    // Music has no Folia queue, and inventing one would make the panel offer actions that cannot
    // apply to it.
    //
    // `audioSrc` is deliberately still Folia's raw value: it gates the Folia audio path, and in
    // Apple Music mode nothing drives that element. The per-song UI gates read the effective fields.
    const audioSrc = usePlaybackStore(state => state.audioSrc);
    const playQueue = usePlaybackStore(state => state.playQueue);
    const isFmMode = usePlaybackStore(state => state.isFmMode);
    const activePlaybackContext = usePlaybackStore(state => state.activePlaybackContext);
    // The held picture, not the live one: a blend keeps song, lyrics, duration and cover describing
    // the same track for its whole length. See the note on `coverUrl` above.
    //
    // Phase 3A/Phase 4: song / cover / duration / playerState come from the effective model, and
    // lyrics come from the unified `useDisplayLyrics()` entry, so this single seam switches the whole
    // player surface between the two backends. `useDisplayLyrics` returns Folia's display selector in
    // the folia backend and the Apple Music store in the apple-music backend — never the other one.
    const displayLyrics = useDisplayLyrics();
    const effective = useEffectivePlaybackModel();
    const displaySong = effective.song;
    const displayCoverUrl = effective.coverUrl;
    // 秒进秒出，见 `resolveOverlayDurationSec` 上的单位契约。曾经在这里乘 1000 当成毫秒，
    // 但 `buildAppOverlaysModel` 的 `duration`、`ProgressBar` 与 `formatTime` 全都按秒使用。
    const displayDuration = resolveOverlayDurationSec(effective);
    const displayPlayerState = effective.playerState;
    const playerControlSlotContext = useMemo(() => ({
        onShuffle: deps.shuffleQueue,
        canShuffle: !isFmMode && playQueue.length > 1,
        onLike: deps.handleLike,
        isLiked: deps.isDisplaySongLiked,
        likeDisabled: resolveLikeAvailability(
            displaySong,
            deps.isNowPlayingControlDisabled,
            activePlaybackContext === 'stage',
        ).disabled,
        invokeCommandById: deps.invokeCommandById,
        canInvokeCommandById: deps.canInvokeCommandById,
    }), [
        activePlaybackContext,
        deps.canInvokeCommandById,
        deps.handleLike,
        deps.invokeCommandById,
        deps.isDisplaySongLiked,
        deps.isNowPlayingControlDisabled,
        deps.shuffleQueue,
        displaySong,
        isFmMode,
        playQueue.length,
    ]);

    return useMemo(() => buildAppOverlaysModel({
        ...deps,
        currentView,
        isSearchOpen,
        isDaylight,
        isDevDebugOverlayVisible,
        isMemoryMonitorVisible,
        memoryMonitorShortcutLabel: MEMORY_MONITOR_SHORTCUT_LABEL,
        currentTime,
        lyricCurrentTime,
        currentSong: displaySong,
        playerState: displayPlayerState,
        duration: displayDuration,
        audioSrc,
        lyrics: displayLyrics,
        activePlaybackContext,
        isPlayerChromeHidden,
        playQueue,
        isFmMode,
        coverUrl: displayCoverUrl,
        stageTrackPillMode,
        stageTrackPillTimeoutSec,
        noTrackText: t('ui.noTrack'),
        prevTrackLabel: t('ui.previousTrack'),
        nextTrackLabel: t('ui.nextTrack'),
        stageTrackPillOpenPlayerLabel: t('ui.stageTrackPillOpenPlayer'),
        stageTrackPillOpenSongCardLabel: t('ui.stageTrackPillOpenSongCard'),
        stageTrackPillFocusLatticeLabel: t('home.latticeFocusCurrent'),
        playerControlSlotPrimary,
        playerControlSlotSecondary,
        playerControlSlotContext,
        onCommitPlayerBottomBarOffset: handleSetPlayerBottomBarOffset,
        // Spread rather than `deps`: the caller passes an object literal, so depending on the object
        // itself would rebuild this on every render and defeat the memo entirely. The key set is
        // fixed by the call site, so the array keeps a constant length.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [
        ...Object.values(deps),
        currentView,
        isSearchOpen,
        isDaylight,
        isDevDebugOverlayVisible,
        isMemoryMonitorVisible,
        displaySong,
        displayPlayerState,
        displayDuration,
        audioSrc,
        displayLyrics,
        activePlaybackContext,
        isPlayerChromeHidden,
        playQueue,
        isFmMode,
        displayCoverUrl,
        stageTrackPillMode,
        stageTrackPillTimeoutSec,
        playerControlSlotPrimary,
        playerControlSlotSecondary,
        playerControlSlotContext,
        handleSetPlayerBottomBarOffset,
        t,
    ]);
};
