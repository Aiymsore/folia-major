import { describe, expect, it } from 'vitest';
import { buildPlayerViewFlags } from '../../../src/components/app/presentation/buildPlayerViewFlags';

// test/unit/app/buildPlayerViewFlags.test.ts
//
// 锁死「播放控制是否可用」这条判据。它曾经的实现只看 Folia 自己的 `audioSrc`：
//
//     canToggleCurrentPlayback: !disabled && Boolean(audioSrc || (stage 歌词分支))
//
// 而 `audioSrc` 是 Folia 的音源字段，Apple Music 是外部进程播放，它在那里恒为 null —— 于是即使
// backend 已经切到 apple-music（`data-apple-music-active="true"`、行高亮、胶囊变 AM），暂停键依然是
// 灰的：`FloatingPlayerControls` 的 `disabled={!canTogglePlay}` 把点击挡住，永远到不了已经写好的
// `handleExternalMediaAction('toggle')`。这里把两个后端的判据分开断言，防止再退回单一 audioSrc。

const baseInput = (overrides: Partial<Parameters<typeof buildPlayerViewFlags>[0]> = {}) => ({
    currentView: 'player',
    disableHomeDynamicBackground: false,
    hidePlayerProgressBar: false,
    hidePlayerTranslationSubtitle: false,
    hidePlayerRightPanelButton: false,
    isNowPlayingControlDisabled: false,
    activePlaybackContext: 'main' as const,
    stageActiveEntryKind: null,
    audioSrc: null,
    duration: 0,
    effectiveHasTrack: false,
    ...overrides,
});

describe('buildPlayerViewFlags.canToggleCurrentPlayback', () => {
    it('Folia 有音源时可控制', () => {
        expect(buildPlayerViewFlags(baseInput({ audioSrc: 'blob:folia' })).canToggleCurrentPlayback).toBe(true);
    });

    it('外部后端（Apple Music）没有 audioSrc 但有效模型有曲目时可控制', () => {
        // 回归保护点：这一条在只看 audioSrc 的实现下是 false，正是暂停键变灰的原因。
        const flags = buildPlayerViewFlags(baseInput({ audioSrc: null, effectiveHasTrack: true }));

        expect(flags.canToggleCurrentPlayback).toBe(true);
    });

    it('两个后端都没有可控制内容时不可用', () => {
        expect(buildPlayerViewFlags(baseInput({ audioSrc: null, effectiveHasTrack: false })).canToggleCurrentPlayback)
            .toBe(false);
    });

    it('Stage 占用控制权时两个后端都不可用', () => {
        expect(buildPlayerViewFlags(baseInput({
            audioSrc: 'blob:folia',
            effectiveHasTrack: true,
            isNowPlayingControlDisabled: true,
        })).canToggleCurrentPlayback).toBe(false);
    });

    it('保留 stage 歌词分支：无音源、无曲目但时长有效时仍可控制', () => {
        const flags = buildPlayerViewFlags(baseInput({
            activePlaybackContext: 'stage',
            stageActiveEntryKind: 'lyrics',
            duration: 120,
        }));

        expect(flags.canToggleCurrentPlayback).toBe(true);
    });

    it('stage 歌词分支仍然要求时长大于 0', () => {
        const flags = buildPlayerViewFlags(baseInput({
            activePlaybackContext: 'stage',
            stageActiveEntryKind: 'lyrics',
            duration: 0,
        }));

        expect(flags.canToggleCurrentPlayback).toBe(false);
    });
});

describe('buildPlayerViewFlags 其余输出不受影响', () => {
    it('播放页的三个隐藏开关仍然按 view 门控', () => {
        const flags = buildPlayerViewFlags(baseInput({
            currentView: 'player',
            hidePlayerProgressBar: true,
            hidePlayerTranslationSubtitle: true,
            hidePlayerRightPanelButton: true,
        }));

        expect(flags).toMatchObject({
            isPlayerView: true,
            shouldHidePlayerProgressBar: true,
            shouldHidePlayerTranslationSubtitle: true,
            shouldHidePlayerRightPanelButton: true,
        });
    });

    it('离开播放页时三个隐藏开关失效', () => {
        const flags = buildPlayerViewFlags(baseInput({
            currentView: 'home',
            hidePlayerProgressBar: true,
            hidePlayerTranslationSubtitle: true,
            hidePlayerRightPanelButton: true,
        }));

        expect(flags).toMatchObject({
            isPlayerView: false,
            shouldHidePlayerProgressBar: false,
            shouldHidePlayerTranslationSubtitle: false,
            shouldHidePlayerRightPanelButton: false,
        });
    });
});
