import type { OnlineProviderId } from '../types/onlineMusic';
import { claimExternalMediaBackend, claimFoliaBackend } from './useTransportDispatcher';

// src/hooks/usePlaybackBackendSwitch.ts
// 显式 backend 切换的两个**用户操作**入口。
//
// 本轮的硬性产品规则（不是自动抢占，全部由用户操作触发）：
//   * 选择 Apple Music：若 Folia 正在播，best-effort 暂停 Folia → backend = 'external-media'。
//     **不自动 play Apple Music**，它保持自己原来的 Playing/Paused。
//   * 选择任意 Folia 原生平台：若 Apple Music 正在播，best-effort SMTC pause → backend = 'folia'
//     → 然后继续原有 provider 选择流程。**不自动 resume Folia**。
//   * 进入 Stage：与「切回 folia」同一套动作，保证
//     `activePlaybackContext === 'stage' && activeBackend === 'external-media'` 永不稳定成立。
//
// best-effort 的含义：任何一步失败都不阻塞切换，最终 backend 始终由用户操作决定。

/**
 * 选中 Apple Music 后端。
 *
 * Folia 侧的暂停用 raw `playerState` 判断（不是 display 层）：混音交接期 display 是 PLAYING，
 * 但 raw 才是"这台机器上的 deck 现在有没有在出声"的判据，而这里要的就是别让两个播放器同时出声。
 */
export const selectExternalMediaBackend = (pauseFolia: () => void, foliaPlayerState: string): void => {
    if (foliaPlayerState === 'PLAYING') {
        try {
            pauseFolia();
        } catch {
            // best-effort：暂停失败也必须完成 backend 切换。
        }
    }
    // 刻意不发送 Apple Music 的 play：切换只改控制目标，不启动新后端。
    claimExternalMediaBackend();
};

/** 选中 Folia 后端（随后由调用方继续原有的 provider 选择流程）。 */
export const selectFoliaBackend = (): void => {
    claimFoliaBackend();
};

/**
 * 进入 Stage 前的让位。
 *
 * Stage 与 Apple Music 后端是互斥的两个"当前播放源"模型：Stage 有自己的 source 选择
 * （stage-api / now-playing / playercap），Apple Music 是一个外部 backend，两者同时成立会让
 * 遥控窗口、taskbar 和播放器面板同时收到两套事实。所以在进入 Stage 之前先让出 backend。
 *
 * 顺序与切回 folia 一致，且必须在 `setActiveBackend` **之前**发 pause —— 此刻 session 仍然有效。
 * 返回是否真的发生了让位，便于调用方记录/测试。
 */
export const leaveExternalMediaForStage = (): boolean => {
    const switched = claimFoliaBackend();
    return switched;
};

/**
 * 供入口 UI 判断 Apple Music 是否可选。
 *
 * 参数就是 `isStageActive` 本身，不取反：这个函数曾经写成 `!isStageActive` 却收 `!isStageActive`，
 * 结果 Stage 不活跃时反而禁用 —— 语义反了的布尔参数正是最容易写错的地方，所以参数名与调用点保持同名。
 */
export const isExternalMediaSelectable = (isStageActive: boolean): boolean => !isStageActive;

/** 供 provider 列表的 `onSelect` 分流使用。 */
export const isExternalMediaEntryId = (id: OnlineProviderId | 'external-media'): boolean => id === 'external-media';
