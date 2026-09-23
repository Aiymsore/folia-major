import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/playback/backendAwarePlaybackClaim.test.ts
// 修复 1 的锁定：点歌时认领的后端由**曲目本身**决定。
//
// 旧行为是无条件 `claimFoliaBackend()`，于是点一首 Apple Music 曲目会先把后端抢回 folia，
// 紧接着 `playExternalMediaTrack` 因为"后端不是 external-media"返回 false —— 用户看到
// "无法在 Chrome 中开始播放"，真正的原因却是 Folia 自己刚放弃了那个后端。
//
// 仓库的 vitest 跑在 node 环境、没有 React，也没有 testing-library：这里按
// `playbackBackendSwitch.test.ts` 的做法 mock 掉三个 store 与 react 的四个 hook，
// 直接驱动真实的包装器实现。

const state = vi.hoisted(() => ({
    backend: 'folia' as 'folia' | 'external-media',
    playerState: 'PAUSED' as string,
    externalStatus: null as unknown,
}));

vi.mock('react', () => ({
    useMemo: (factory: () => unknown) => factory(),
    useCallback: (callback: unknown) => callback,
}));

vi.mock('@/stores/useActivePlaybackBackendStore', () => ({
    useActivePlaybackBackendStore: Object.assign(
        (selector: (s: { activeBackend: string }) => unknown) => selector({ activeBackend: state.backend }),
        {
            getState: () => ({
                activeBackend: state.backend,
                setActiveBackend: (next: string) => { state.backend = next as typeof state.backend; },
            }),
        },
    ),
    getActivePlaybackBackend: () => state.backend,
    setActivePlaybackBackend: (next: string) => { state.backend = next as typeof state.backend; },
}));

vi.mock('@/stores/usePlaybackStore', () => ({
    usePlaybackStore: Object.assign(
        (selector: (s: { playerState: string }) => unknown) => selector({ playerState: state.playerState }),
        { getState: () => ({ playerState: state.playerState }) },
    ),
}));

vi.mock('@/stores/useExternalMediaStore', () => ({
    useExternalMediaStore: (selector: (s: { status: unknown }) => unknown) => selector({ status: state.externalStatus }),
    getExternalMediaStatus: () => state.externalStatus,
    hasExternalMedia: () => false,
    isExternalMediaTransportReady: () => false,
}));

import { resolvePlaybackBackendClaim } from '@/utils/playbackBackendClaim';
import { useBackendAwarePlaybackActions } from '@/hooks/useBackendAwarePlaybackActions';
import type { SongResult } from '@/types';

const appleMusicSong: SongResult = {
    id: 'apple-music:a.1538098094',
    name: '你',
    artists: [{ id: 0, name: 'Artist' }],
    album: { id: 0, name: 'Album' },
    durationMs: 1000,
    sourceRef: { kind: 'external-media', mediaId: 'a.1538098094' },
    externalMediaId: 'a.1538098094',
    externalMediaCatalogId: '1538098094',
} as SongResult;

const onlineSong: SongResult = {
    id: 'qq-song',
    name: 'Song',
    artists: [],
    album: { id: 'album', name: 'Album' },
    durationMs: 1000,
    sourceRef: { kind: 'online', providerId: 'qq', mediaId: '004Th6td4LaoZs' },
};

const buildActions = (pauseFolia = vi.fn()) => {
    const playSong = vi.fn();
    const actions = useBackendAwarePlaybackActions({
        playSong,
        onPlayLocalSong: vi.fn(),
        onPlayNavidromeSong: vi.fn(),
        handleSearchResultPlay: vi.fn(),
        pauseFolia,
    });
    return { actions, playSong, pauseFolia };
};

describe('playback backend claim', () => {
    beforeEach(() => {
        state.backend = 'folia';
        state.playerState = 'PAUSED';
        state.externalStatus = null;
    });

    it('answers from the track itself, not from the surface it was clicked on', () => {
        expect(resolvePlaybackBackendClaim(appleMusicSong)).toBe('external-media');
        expect(resolvePlaybackBackendClaim(onlineSong)).toBe('folia');
        expect(resolvePlaybackBackendClaim(null)).toBe('folia');
        expect(resolvePlaybackBackendClaim(undefined)).toBe('folia');
    });

    it('claims the external media backend for an Apple Music track instead of pulling it back to Folia', () => {
        state.playerState = 'PLAYING';
        const { actions, playSong, pauseFolia } = buildActions();

        actions.playSong(appleMusicSong, [appleMusicSong]);

        // The whole fix: the claim must NOT be 'folia', or playExternalMediaTrack declines.
        expect(state.backend).toBe('external-media');
        // Folia was sounding, so it had to give way - two players must not sound at once.
        expect(pauseFolia).toHaveBeenCalledTimes(1);
        expect(playSong).toHaveBeenCalledWith(appleMusicSong, [appleMusicSong]);
    });

    it('pauses Folia only when it is actually playing', () => {
        for (const playerState of ['IDLE', 'PAUSED']) {
            state.backend = 'folia';
            state.playerState = playerState;
            const { actions, pauseFolia } = buildActions();

            actions.playSong(appleMusicSong, [appleMusicSong]);

            expect(pauseFolia).not.toHaveBeenCalled();
            expect(state.backend).toBe('external-media');
        }
    });

    it('does not touch the transport when the external media backend already owns it', () => {
        state.backend = 'external-media';
        state.playerState = 'PLAYING';
        const { actions, pauseFolia } = buildActions();

        actions.playSong(appleMusicSong, [appleMusicSong]);

        expect(pauseFolia).not.toHaveBeenCalled();
        expect(state.backend).toBe('external-media');
    });

    it('still claims Folia back for every non-external track', () => {
        state.backend = 'external-media';
        const { actions, pauseFolia } = buildActions();

        actions.playSong(onlineSong, [onlineSong]);

        expect(state.backend).toBe('folia');
        expect(pauseFolia).not.toHaveBeenCalled();
    });

    it('applies the same rule to every wrapped entry point', () => {
        const actions = useBackendAwarePlaybackActions({
            playSong: vi.fn(),
            onPlayLocalSong: vi.fn(),
            onPlayNavidromeSong: vi.fn(),
            handleSearchResultPlay: vi.fn(),
            pauseFolia: vi.fn(),
        });

        actions.handleSearchResultPlay(appleMusicSong);
        expect(state.backend).toBe('external-media');

        state.backend = 'folia';
        actions.onPlayLocalSong({ ...onlineSong, isLocal: true, localRef: { songId: 'l1' } } as SongResult);
        expect(state.backend).toBe('folia');
    });
});
