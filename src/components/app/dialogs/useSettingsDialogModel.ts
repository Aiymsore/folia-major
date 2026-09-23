import { useMemo } from 'react';
import { lyricCurrentTime } from '../../../stores/motionSignals';
import { usePlaybackStore } from '../../../stores/usePlaybackStore';
import { useSettingsModalStore } from '../../../stores/useSettingsModalStore';
import { buildSettingsDialogModel, type SettingsDialogDeps } from './buildSettingsDialogModel';

// src/components/app/dialogs/useSettingsDialogModel.ts

/**
 * The settings dialog props with the six ambient values already filled in. `state`, the current
 * song's title, its lyrics, the playback context and the replay-gain mode all live in stores, and
 * `lyricCurrentTime` is a module-level motion signal - none of them needed App.tsx as a courier.
 */
export const useSettingsDialogModel = (deps: SettingsDialogDeps) => {
    const state = useSettingsModalStore(modal => modal.settingsModalState);
    const currentSongTitle = usePlaybackStore(playback => playback.currentSong?.name ?? null);
    // 刻意直读 raw：设置面板的「当前歌词」档位以 Folia 的 currentSong 为身份，两者必须同源。
    const currentLyrics = usePlaybackStore(playback => playback.lyrics);
    const activePlaybackContext = usePlaybackStore(playback => playback.activePlaybackContext);
    const replayGainMode = usePlaybackStore(playback => playback.replayGainMode);

    return useMemo(() => buildSettingsDialogModel({
        ...deps,
        state,
        currentSongTitle,
        currentLyrics,
        lyricCurrentTime,
        activePlaybackContext,
        replayGainMode,
        // Spread rather than `deps`: the caller passes an object literal, so depending on the object
        // would rebuild this every render. The key set is fixed by the call site.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [...Object.values(deps), state, currentSongTitle, currentLyrics, activePlaybackContext, replayGainMode]);
};
