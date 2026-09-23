import { useMemo, useState } from 'react';
import { useMotionValueEvent } from 'framer-motion';
import { PlayerState, type SongResult } from '../types';
import type { ExternalMediaAvailability, PlaybackBackend } from '../types/playbackBackend';
import {
    selectDisplayCoverUrl,
    selectDisplayDuration,
    selectDisplayPlayerState,
    selectDisplaySong,
    usePlaybackStore,
} from '../stores/usePlaybackStore';
import { currentTime } from '../stores/motionSignals';
import { useActivePlaybackBackendStore } from '../stores/useActivePlaybackBackendStore';
import { hasExternalMedia, useExternalMediaStore } from '../stores/useExternalMediaStore';
import { resolveExternalMediaAvailability } from '../utils/externalMediaStatus';
import {
    buildExternalMediaEffectiveModel,
    type EffectivePlaybackModel,
} from '../utils/effectivePlayback';

// src/hooks/useEffectivePlayback.ts
// effective playback model 的 React 读取层：按 activeBackend 选择数据来源，其余一切交给
// utils/effectivePlayback.ts 的纯函数。UI 组件与 bridge 只读这里，不关心 backend。
//
// 三条边界：
//   * 只读。不写 usePlaybackStore、不写 queue、不碰 audioRef。
//   * folia 分支只是把现有 display selector 的值**原样装进同一个结构**，不做任何合成或重算。
//     `canGoPrevious` / `canGoNext` / `controlsDisabled` 在 folia 下不在这里重算 —— 它们依赖
//     队列邻居与 Stage gate，重算就会产生第二套规则。调用方按需通过 `folia` 参数传入，
//     不传则保持 `null`（"未提供"），由消费者沿用**现有**逻辑（这正是零回归的来源）。
//   * apple-music 分支不读 audio 元素，也不给 `hasTrack` 抄近路成 `connected`。

/** folia 后端下由调用方提供（或由既有逻辑决定）的三个派生值。null 表示"未提供，沿用现状"。 */
export type EffectiveFoliaOverrides = {
    canGoPrevious: boolean | null;
    canGoNext: boolean | null;
    controlsDisabled: boolean | null;
};

const NO_FOLIA_OVERRIDES: EffectiveFoliaOverrides = {
    canGoPrevious: null,
    canGoNext: null,
    controlsDisabled: null,
};

export const useEffectiveBackend = (): PlaybackBackend => (
    useActivePlaybackBackendStore(state => state.activeBackend)
);

/**
 * 外部媒体后端当前的可显示状态。
 *
 * 判据完全交给 `resolveExternalMediaAvailability`（纯函数、可单测）—— 六态阶梯的**顺序**是承重的
 * （桥可达 → 扩展已连接 → 有 tab → 已登录 → storefront 匹配），在这里重写一遍就是第二套规则。
 */
export const useExternalMediaAvailability = (): ExternalMediaAvailability => (
    resolveExternalMediaAvailability(useExternalMediaStore(state => state.status))
);

/**
 * 播放位置（秒）。
 *
 * folia 位置是 motion signal（每帧变化，刻意不是 store state），所以这里用
 * `useMotionValueEvent` 订阅后落到本地 state。订阅只在 backend === 'folia' 时写 state，
 * external-media 模式下位置来自外部观察（经校正层），不会因为 Folia 的位置变化触发额外渲染。
 */
const useEffectivePositionSec = (backend: PlaybackBackend, externalMediaPositionSec: number): number => {
    const [foliaPositionSec, setFoliaPositionSec] = useState(() => currentTime.get());

    useMotionValueEvent(currentTime, 'change', (value: number) => {
        if (backend !== 'folia') return;
        setFoliaPositionSec(value);
    });

    return backend === 'folia' ? foliaPositionSec : externalMediaPositionSec;
};

export const useEffectivePlaybackModel = (
    foliaOverrides: EffectiveFoliaOverrides = NO_FOLIA_OVERRIDES,
): EffectivePlaybackModel => {
    const backend = useActivePlaybackBackendStore(state => state.activeBackend);
    const appleMusicStatus = useExternalMediaStore(state => state.status);

    // ---- folia：display 层，不是 raw 层。混音交接期 picture 属于 outgoing deck ----
    const foliaSong = usePlaybackStore(selectDisplaySong);
    const foliaPlayerState = usePlaybackStore(selectDisplayPlayerState);
    // 秒进秒出：`selectDisplayDuration` 本身就是秒（`store.duration` 来自
    // `HTMLAudioElement.duration`，与 motion signal `currentTime` 同标尺），而 `durationSec`
    // 契约要求秒。这里**不做任何换算** —— 曾经写成 `/ 1000`，把 164s 变成 0.164，
    // 于是 effective 模型对 Folia 恒错 1000 倍（remote/taskbar/MediaSession 全部跟着错）。
    const foliaDurationSec = usePlaybackStore(selectDisplayDuration);
    const foliaCoverUrl = usePlaybackStore(selectDisplayCoverUrl);

    const availability = resolveExternalMediaAvailability(appleMusicStatus);

    const externalMediaModel = useMemo(() => buildExternalMediaEffectiveModel(
        {
            bridgeAvailable: appleMusicStatus?.bridgeAvailable === true,
            connected: appleMusicStatus?.connected === true,
            hasMedia: hasExternalMedia(appleMusicStatus),
            title: appleMusicStatus?.title ?? null,
            artist: appleMusicStatus?.artist ?? null,
            album: appleMusicStatus?.album ?? null,
            playbackStatus: appleMusicStatus?.playbackStatus ?? null,
            positionMs: appleMusicStatus?.positionMs ?? null,
            durationMs: appleMusicStatus?.durationMs ?? null,
        },
        availability,
        appleMusicStatus?.sourceAppUserModelId ?? null,
        // next/previous 由 Folia 的 queue 决定，而不是由外部播放器决定，因此这三个值必须与
        // folia 分支同源、由调用方传入（见 utils/effectivePlayback.ts 的说明）。
        foliaOverrides,
    ), [appleMusicStatus, availability, foliaOverrides]);

    const positionSec = useEffectivePositionSec(backend, externalMediaModel.positionSec);

    if (backend !== 'folia') return externalMediaModel;

    return {
        backend: 'folia',
        // folia 的"有曲目"就是 display selector 有值 —— 与 buildPlaybackSyncBridgeModel 的
        // hasTrack 同源（那个还额外排除 stage，属于发布面的事，这里不重复）。
        hasTrack: foliaSong !== null,
        song: foliaSong,
        lyrics: null,
        playerState: foliaPlayerState,
        positionSec,
        durationSec: foliaDurationSec,
        coverUrl: foliaCoverUrl,
        canGoPrevious: foliaOverrides.canGoPrevious,
        canGoNext: foliaOverrides.canGoNext,
        controlsDisabled: foliaOverrides.controlsDisabled,
        // Folia 后端没有任何外部前置条件，因此恒为 `ready` —— 它不是"外部媒体已就绪"的断言，
        // 而是"这个后端此刻没有未满足的前置条件"。UI 只对 external-media 分支渲染前置条件提示。
        availability: 'ready',
    };
};

// ---- 单字段读取器 ----
// 供只关心一个值的消费者使用（mediaSession 的 playbackState、封面等）。
// 每个都是对同一个 model 的一次派生，因此不存在第二个真相。

export const useEffectiveSong = (): SongResult | null => useEffectivePlaybackModel().song;
export const useEffectivePlayerState = (): PlayerState => useEffectivePlaybackModel().playerState;
export const useEffectiveDurationSec = (): number => useEffectivePlaybackModel().durationSec;
export const useEffectiveCoverUrl = (): string | null => useEffectivePlaybackModel().coverUrl;
export const useEffectiveHasTrack = (): boolean => useEffectivePlaybackModel().hasTrack;
export const useEffectiveControlsDisabled = (): boolean | null => (
    useEffectivePlaybackModel().controlsDisabled
);
