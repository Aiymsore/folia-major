import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { getActivePlaybackBackend } from '../stores/useActivePlaybackBackendStore';
import { useAudioSettingsStore } from '../stores/useAudioSettingsStore';
import { useExternalMediaStore } from '../stores/useExternalMediaStore';
import { usePlaybackStore } from '../stores/usePlaybackStore';
import { setStatusMessage } from '../stores/useStatusMessageStore';
import { getPlaybackSongKey } from '../utils/appPlaybackGuards';
import {
    decideExternalMediaAdvance,
    EXTERNAL_MEDIA_DISPATCH_WINDOW_MS,
    hasQueuedSuccessor,
    isNearTrackEnd,
    toObservedPlaybackSnapshot,
    type ObservedPlaybackSnapshot,
} from '../utils/externalMediaQueueAdvance';
import { resolveExternalMediaPlayableId } from '../utils/externalMediaQueueReconcile';
import { handleExternalMediaAction, playExternalMediaTrack } from './useTransportDispatcher';

// src/hooks/useExternalMediaQueueAdvance.ts
// 外部媒体后端的**切歌信号来源**：把观察层的每一帧快照接进分段权威决策，再落到三个动作上
// （queue 推进 / 同步索引 / 放弃权威）。
//
// 为什么必须有它：Folia 的自动切歌信号是 `<audio>` 的 `onEnded`，外部播放器没有 Folia 的
// 音频元素，那个事件永远不会触发 —— 没有这一层，外部媒体后端下的 queue 会永远停在第一首。
// 决策规则在 `utils/externalMediaQueueAdvance.ts`（纯函数、可穷举单测），这里只负责接线：
// 读快照、维护四个 ref、执行动作。
//
// 与 Folia 原生 onEnded 路径的一条对齐：`loopMode === 'one'` 时**重新下发当前曲目**，
// 而不是把循环语义透传给网页播放器（它会按它自己的循环规则走）。

export type ExternalMediaQueueAdvanceOptions = {
    /**
     * queue 推进的唯一入口（Folia 的 `handleNextTrack`）。
     *
     * "下一首"由它解析成 `playById(下一首)`，绝不以 next/previous 的形式透传给网页播放器 ——
     * 那会让 Apple Music 播它自己的内部队列（见 docs/external-media-backend.md「命令面」）。
     */
    advanceToNextTrack: (options?: { allowStopOnMissing?: boolean; shouldNavigateToPlayer?: boolean }) => unknown;
};

export const useExternalMediaQueueAdvance = ({ advanceToNextTrack }: ExternalMediaQueueAdvanceOptions): void => {
    const { t } = useTranslation();
    const status = useExternalMediaStore(state => state.status);

    /** 上一帧观察。曲末抢占判据要比较"两次观察"，而不是观察与 currentSong。 */
    const previousObservedRef = useRef<ObservedPlaybackSnapshot | null>(null);
    /** 防重入：同一首曲目只推进一次（结尾邻域会连续出现好几帧）。 */
    const advancedForKeyRef = useRef<string | null>(null);
    /** 接管提示只报一次，回到 in-sync / sync-index 后才允许再报。 */
    const takenOverNotifiedRef = useRef(false);
    /** 上一次见到的 currentSong 身份键，用来发现"Folia 刚下发过播放"。 */
    const lastCurrentSongKeyRef = useRef<string | null>(null);
    /** 派发时间窗的截止时刻（墙钟 ms）。 */
    const dispatchWindowUntilRef = useRef(0);

    useEffect(() => {
        if (getActivePlaybackBackend() !== 'external-media') {
            // 交还权威：状态整体复位，下一次进入 external-media 从新锚点开始，
            // 而不是接上一次的旧观察（与外部时钟复位同一条规则）。
            previousObservedRef.current = null;
            advancedForKeyRef.current = null;
            takenOverNotifiedRef.current = false;
            lastCurrentSongKeyRef.current = null;
            dispatchWindowUntilRef.current = 0;
            return;
        }

        const { playQueue, currentSong } = usePlaybackStore.getState();
        const loopMode = useAudioSettingsStore.getState().loopMode;
        const observed = toObservedPlaybackSnapshot(status);

        // Folia 刚下发过一首（当前曲目变了）→ 开派发时间窗。必须发生在**决策之前**：
        // 否则同一帧里还停在旧曲目的观察会得出 drifted，把索引同步回去 —— 撤销这次推进。
        const currentSongKey = currentSong ? getPlaybackSongKey(currentSong) : null;
        if (currentSongKey !== lastCurrentSongKeyRef.current) {
            lastCurrentSongKeyRef.current = currentSongKey;
            if (currentSongKey) {
                dispatchWindowUntilRef.current = Date.now() + EXTERNAL_MEDIA_DISPATCH_WINDOW_MS;
            }
        }

        const decision = decideExternalMediaAdvance({
            queue: playQueue,
            currentSong,
            observed,
            previousObserved: previousObservedRef.current,
            loopMode,
            inDispatchWindow: Date.now() < dispatchWindowUntilRef.current,
        });
        previousObservedRef.current = observed;

        // 任何一帧"远离结尾"的观察都解除防重入：新曲目（或循环重播）从此可以再次触发推进。
        if (observed && !isNearTrackEnd(observed)) {
            advancedForKeyRef.current = null;
        }

        if (decision.kind === 'advance') {
            if (currentSongKey && advancedForKeyRef.current === currentSongKey) return;
            if (currentSongKey) advancedForKeyRef.current = currentSongKey;

            if (decision.mode === 'repeat') {
                // loop 'one'：重新下发**当前**曲目。循环语义留在 Folia，网页播放器只收到一次
                // "播这首"，因此它自己的循环/队列规则没有机会参与。
                const mediaId = resolveExternalMediaPlayableId(currentSong);
                if (mediaId) {
                    dispatchWindowUntilRef.current = Date.now() + EXTERNAL_MEDIA_DISPATCH_WINDOW_MS;
                    void playExternalMediaTrack(mediaId);
                }
                return;
            }

            // queue 到头（且不循环）时，Folia 的播放到此为止：把外部播放器也停下来，
            // 否则 Folia 显示已停止、网页却在播它自己的下一首（E5-A 只接受曲末抢占，不接受失控续播）。
            if (!hasQueuedSuccessor(playQueue, currentSong, loopMode)) {
                handleExternalMediaAction('pause');
            }
            void advanceToNextTrack({ allowStopOnMissing: true, shouldNavigateToPlayer: false });
            return;
        }

        if (decision.kind === 'sync-index') {
            // 用户在网页里跳到了队列内的另一首：把 queue 索引同步到事实，不"纠正"回去。
            takenOverNotifiedRef.current = false;
            const target = playQueue[decision.queueIndex] ?? null;
            if (target && getPlaybackSongKey(target) !== currentSongKey) {
                usePlaybackStore.getState().setCurrentSong(target);
                // 不开派发窗口：没有下发发生，外部播放器已经在放这一首了。
                lastCurrentSongKeyRef.current = getPlaybackSongKey(target);
            }
            return;
        }

        if (decision.kind === 'take-over') {
            // 分段权威的边界：窗口外的手动操作 = 用户接管，Folia 退出 queue 推进。
            if (takenOverNotifiedRef.current) return;
            takenOverNotifiedRef.current = true;
            setStatusMessage({
                type: 'info',
                text: t('appleMusic.queueTakenOver', 'Playback is now controlled by the Apple Music web player'),
            });
            return;
        }

        if (decision.kind === 'in-sync') {
            takenOverNotifiedRef.current = false;
        }
    }, [advanceToNextTrack, status, t]);
};
