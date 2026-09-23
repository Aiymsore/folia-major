// src/components/app/presentation/buildPlayerViewFlags.ts

// Builds top-level player-view booleans used by the shell, overlays, and floating controls.
export const buildPlayerViewFlags = ({
    currentView,
    disableHomeDynamicBackground,
    hidePlayerProgressBar,
    hidePlayerTranslationSubtitle,
    hidePlayerRightPanelButton,
    isNowPlayingControlDisabled,
    activePlaybackContext,
    stageActiveEntryKind,
    audioSrc,
    duration,
    effectiveHasTrack,
}: {
    currentView: string;
    disableHomeDynamicBackground: boolean;
    hidePlayerProgressBar: boolean;
    hidePlayerTranslationSubtitle: boolean;
    hidePlayerRightPanelButton: boolean;
    isNowPlayingControlDisabled: boolean;
    activePlaybackContext: 'main' | 'stage';
    stageActiveEntryKind: string | null;
    audioSrc: string | null;
    duration: number;
    /**
     * 当前播放后端有没有一首可控制的曲目（`effective.hasTrack`）。
     *
     * `audioSrc` 只描述 Folia 自己的音源，因此它对 Apple Music 这类外部播放后端恒为 null ——
     * 只判 `audioSrc` 会把暂停按钮在 Apple Music 模式下永久置灰，点击根本到不了
     * `handleExternalMediaAction('toggle')`（usePlaybackInteractionBridge）。两个条件是"或"关系：
     * Folia 有音源就有歌（等价于原来的写法），Apple Music 有曲目就能控制。
     */
    effectiveHasTrack: boolean;
}) => {
    const isPlayerView = currentView === 'player';
    return {
        isPlayerView,
        shouldPauseVisualizerBackground: currentView !== 'player' && disableHomeDynamicBackground,
        shouldHidePlayerProgressBar: isPlayerView && hidePlayerProgressBar,
        shouldHidePlayerTranslationSubtitle: isPlayerView && hidePlayerTranslationSubtitle,
        shouldHidePlayerRightPanelButton: isPlayerView && hidePlayerRightPanelButton,
        canToggleCurrentPlayback: !isNowPlayingControlDisabled && Boolean(
            audioSrc
            || effectiveHasTrack
            || (activePlaybackContext === 'stage' && stageActiveEntryKind === 'lyrics' && duration > 0),
        ),
    };
};
