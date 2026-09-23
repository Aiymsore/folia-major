import { useCallback, useMemo } from 'react';
import type { OnlineProviderId, ProviderAccountSummary } from '../types/onlineMusic';
import type { PlaybackSwitcherEntry } from '../types/playbackBackend';
import { useActivePlaybackBackendStore } from '../stores/useActivePlaybackBackendStore';
import { useExternalMediaStore } from '../stores/useExternalMediaStore';
import { usePlaybackStore } from '../stores/usePlaybackStore';
import { resolveExternalMediaAvailability } from '../utils/externalMediaStatus';
import {
    isExternalMediaSelectable,
    selectExternalMediaBackend,
    selectFoliaBackend,
} from './usePlaybackBackendSwitch';

// src/hooks/usePlaybackSwitcherEntries.ts
// 把「普通在线平台」与「Apple Music」组装成**同一份**选择器条目列表，并把点击分流回各自的体系。
//
// 概念隔离（这是本文件存在的全部理由）：
//   普通 provider → switchProvider(providerId)，即 activeProviderId / omni / 账号生命周期
//   Apple Music   → activePlaybackBackend，**不写 activeProviderId、不进 omni、不注册 provider**
//
// 因此 Apple Music 这一支在类型上就没有 providerId（见 PlaybackSwitcherEntry 的判别联合），
// 想污染 provider 状态必须改类型，而不是漏写一个判断。

export type PlaybackSwitcherEntries = {
    entries: PlaybackSwitcherEntry[];
    /** 当前被选中的条目 id；Apple Music 被选中时 `activeProviderId` 保持用户上次的原生平台不动。 */
    activeEntryId: OnlineProviderId | 'external-media';
    onSelectEntry: (entry: PlaybackSwitcherEntry) => void;
};

export type UsePlaybackSwitcherEntriesInput = {
    /** 原生 provider 列表，直接来自 omni。 */
    providers: ProviderAccountSummary[];
    activeProviderId: OnlineProviderId;
    /** 原有平台切换流程（含确认弹窗与账号刷新）。Apple Music 不走它。 */
    switchProvider: (providerId: OnlineProviderId) => unknown;
    /** 真正能停声的 Folia 暂停回调，由 App 从 transport controller 注入。 */
    pauseFolia: () => void;
    /** Stage 活跃时 Apple Music 不可选：两者是互斥的两个「当前播放源」模型。 */
    isStageActive: boolean;
};

export const usePlaybackSwitcherEntries = ({
    providers,
    activeProviderId,
    switchProvider,
    pauseFolia,
    isStageActive,
}: UsePlaybackSwitcherEntriesInput): PlaybackSwitcherEntries => {
    const backend = useActivePlaybackBackendStore(state => state.activeBackend);
    const appleMusicStatus = useExternalMediaStore(state => state.status);

    const availability = resolveExternalMediaAvailability(appleMusicStatus ?? null);

    const appleMusicEntry = useMemo<PlaybackSwitcherEntry>(() => ({
        kind: 'external-media',
        status: availability,
        isActive: backend === 'external-media',
        // Stage 活跃时不可选。其余情况即使 Apple Music 没在运行也可选：选中后 UI 显示
        // not running 并禁用 transport，这正是用户被告知"去把 Apple Music 打开"的方式。
        disabledReason: isExternalMediaSelectable(isStageActive) ? null : 'stage',
    }), [availability, backend, isStageActive]);

    const entries = useMemo<PlaybackSwitcherEntry[]>(() => [
        ...providers.map(provider => ({
            kind: 'provider' as const,
            providerId: provider.providerId,
            summary: provider,
            // 原生平台只在 folia 后端下才显示为选中 —— 切到 Apple Music 时不该有两个高亮项。
            isActive: backend === 'folia' && provider.providerId === activeProviderId,
        })),
        appleMusicEntry,
    ], [activeProviderId, appleMusicEntry, backend, providers]);

    const onSelectEntry = useCallback((entry: PlaybackSwitcherEntry) => {
        if (entry.kind === 'external-media') {
            if (entry.disabledReason) return;
            // Read the raw transport at click time instead of subscribing to it: this hook lives in
            // Grid3D's tree, and `playerState` changes on every play/pause of every track — a
            // subscription here would re-render the grid surface for a value only a click needs.
            const foliaPlayerState = usePlaybackStore.getState().playerState;
            // Apple Music 只写 backend：activeProviderId 保持不变，用户切回来时无需恢复。
            selectExternalMediaBackend(pauseFolia, foliaPlayerState);
            return;
        }

        // 任何原生平台都把 backend 归位，然后继续原有流程（**不自动 resume Folia**）。
        selectFoliaBackend();
        void switchProvider(entry.providerId);
    }, [pauseFolia, switchProvider]);

    return {
        entries,
        activeEntryId: backend === 'external-media' ? 'external-media' : activeProviderId,
        onSelectEntry,
    };
};
