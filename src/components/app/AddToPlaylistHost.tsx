import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import type { LocalPlaylist } from '../../types';
import type { ProviderCollection } from '../../types/onlineMusic';
import PlaylistSelectionDialog from '../shared/PlaylistSelectionDialog';
import TextInputDialog from '../shared/TextInputDialog';
import { getPlaybackSourceRef } from '../../utils/appPlaybackGuards';
import { canPersistPlaylistEntry } from '../../utils/playlistEntry';
import { omni } from '../../services/onlineMusic/omni';
import { selectDisplaySong, usePlaybackStore } from '../../stores/usePlaybackStore';
import { useAddToPlaylistStore } from '../../stores/useAddToPlaylistStore';

// src/components/app/AddToPlaylistHost.tsx
// The playlist picker for the current song, and the "new playlist" prompt behind it.
//
// Lifted out of UnifiedPanel so it is not tied to the player panel being on screen: it answers a
// question about the song, not about the panel, and a command bound to a global shortcut has to be
// able to ask it from anywhere. The star button in the panel now only requests it.
//
// Everything the three sources need to be told apart stays here, in one place, because the answer
// depends on a Navidrome fetch — see the note in useAddToPlaylistStore.

type AddToPlaylistHostProps = {
    isDaylight: boolean;
    localPlaylists: LocalPlaylist[];
    onlinePlaylists: ProviderCollection[];
    onAddCurrentSongToLocalPlaylist: (playlistId: string) => Promise<void>;
    onCreateCurrentLocalPlaylist: (name: string) => Promise<void>;
    onAddCurrentSongToOnlinePlaylist: (playlist: ProviderCollection) => Promise<void>;
    onAddCurrentSongToNavidromePlaylist: (playlistId: string) => Promise<void>;
    onCreateCurrentNavidromePlaylist: (name: string) => Promise<void>;
};

type PlaylistEntry = { id: string; name: string; description?: string };

export const AddToPlaylistHost: React.FC<AddToPlaylistHostProps> = ({
    isDaylight,
    localPlaylists,
    onlinePlaylists,
    onAddCurrentSongToLocalPlaylist,
    onCreateCurrentLocalPlaylist,
    onAddCurrentSongToOnlinePlaylist,
    onAddCurrentSongToNavidromePlaylist,
    onCreateCurrentNavidromePlaylist,
}) => {
    const { t } = useTranslation();
    // The song as the listener sees it, so a blend shows the track that is on screen.
    const currentSong = usePlaybackStore(selectDisplaySong);
    const { isOpen, close, setAvailability } = useAddToPlaylistStore(useShallow(state => ({
        isOpen: state.isOpen,
        close: state.close,
        setAvailability: state.setAvailability,
    })));
    const [isCreateOpen, setIsCreateOpen] = useState(false);
    const [navidromePlaylists, setNavidromePlaylists] = useState<PlaylistEntry[]>([]);

    const isNavidrome = Boolean(currentSong && (currentSong as any).isNavidrome === true);
    const playbackSourceRef = currentSong ? getPlaybackSourceRef(currentSong) : null;
    const isOnline = playbackSourceRef?.kind === 'online';
    const onlineProviderLabel = playbackSourceRef?.kind === 'online'
        ? omni.getProviderLabel(playbackSourceRef.providerId)
        : '';
    const canAddOnlineSong = Boolean(currentSong && isOnline && omni.canAddSongToPlaylist(currentSong));
    // 跨来源歌单（LocalPlaylist.entries）对所有可回放来源开放：local/online/navidrome/
    // external-media 都能进「本地歌单」；provider 歌单仍是同 provider 专属。
    const canPersist = Boolean(currentSong && canPersistPlaylistEntry(currentSong));

    const refreshNavidromePlaylists = useCallback(async () => {
        const { getNavidromeConfig, navidromeApi } = await import('../../services/navidromeService');
        const config = getNavidromeConfig();
        if (!config) {
            setNavidromePlaylists([]);
            return;
        }

        const playlists = await navidromeApi.getPlaylists(config);
        setNavidromePlaylists(playlists.map((playlist) => ({
            id: playlist.id,
            name: playlist.name,
            description: `${playlist.songCount} ${t('playlist.tracks')}`,
        })));
    }, [t]);

    useEffect(() => {
        if (!isNavidrome) {
            setNavidromePlaylists([]);
            return;
        }

        void refreshNavidromePlaylists();
    }, [currentSong?.id, isNavidrome, refreshNavidromePlaylists]);

    const availablePlaylists = useMemo<PlaylistEntry[]>(() => {
        // 「本地歌单」对所有来源开放，id 前缀 `local:` 与服务端歌单（`navi:`/`online:`）区分路由。
        // 「Liked Songs」保持本地专属，非本地曲目不出现在它的目标列表里。
        const isLocalSong = playbackSourceRef?.kind === 'local';
        const localPlaylistEntries = localPlaylists
            .filter((playlist) => isLocalSong || !playlist.isFavorite)
            .map((playlist) => ({
                id: `local:${playlist.id}`,
                name: playlist.name,
                description: `${playlist.entries?.length ?? playlist.songIds.length} ${t('playlist.tracks')}`,
            }));

        if (isOnline) {
            return [
                ...localPlaylistEntries,
                ...onlinePlaylists.map((playlist) => ({
                    id: `online:${String(playlist.id)}`,
                    name: playlist.name,
                    description: `${playlist.trackCount || 0} ${t('playlist.tracks')}`,
                })),
            ];
        }

        if (isNavidrome) {
            return [
                ...localPlaylistEntries,
                ...navidromePlaylists.map((playlist) => ({ ...playlist, id: `navi:${playlist.id}` })),
            ];
        }

        return localPlaylistEntries;
    }, [isOnline, isNavidrome, localPlaylists, navidromePlaylists, onlinePlaylists, playbackSourceRef?.kind, t]);

    const isApplicable = canPersist;
    // 任何可入歌单的曲目都有「本地歌单」可去（可新建），所以不存在「无处可放」。
    const canAdd = canPersist;
    const disabledReason = isOnline && !canAddOnlineSong && onlinePlaylists.length > 0 && localPlaylists.length === 0
        ? t('status.providerPlaylistMutationUnavailable', { provider: onlineProviderLabel })
        : (!canAdd ? t('localMusic.noPlaylistsFound') : undefined);

    // The track can change under an open dialog — a blend lands, the queue advances — and the new
    // one may have nowhere to go. Closing beats leaving a picker up that cannot pick.
    useEffect(() => {
        if (isOpen && !(isApplicable && canAdd)) {
            close();
        }
    }, [canAdd, close, isApplicable, isOpen]);

    // Published rather than recomputed by each consumer: the star button and the command both need
    // this answer, and only one of them can afford to be the thing that fetches it.
    useEffect(() => {
        setAvailability({ isApplicable, canAdd: isApplicable && canAdd, disabledReason });
    }, [canAdd, disabledReason, isApplicable, setAvailability]);

    return (
        <div className="pointer-events-auto">
            <PlaylistSelectionDialog
                isOpen={isOpen}
                onClose={close}
                isDaylight={isDaylight}
                title={t('localMusic.addToPlaylist')}
                description={t('home.playlists') || 'Playlists'}
                playlists={availablePlaylists}
                onSelect={async (playlistId) => {
                    const rawId = String(playlistId);
                    if (rawId.startsWith('navi:')) {
                        await onAddCurrentSongToNavidromePlaylist(rawId.slice('navi:'.length));
                        await refreshNavidromePlaylists();
                        return;
                    }

                    if (rawId.startsWith('online:')) {
                        const playlist = onlinePlaylists.find(item => String(item.id) === rawId.slice('online:'.length));
                        if (!playlist) throw new Error('Selected playlist is unavailable');
                        await onAddCurrentSongToOnlinePlaylist(playlist);
                        return;
                    }

                    await onAddCurrentSongToLocalPlaylist(rawId.startsWith('local:') ? rawId.slice('local:'.length) : rawId);
                }}
                // Navidrome 歌曲仍建服务端歌单（它的家在服务器）；其余来源建「本地歌单」（entries）。
                onCreate={(canPersist || isNavidrome) ? () => {
                    close();
                    setIsCreateOpen(true);
                } : undefined}
                createLabel={t(isNavidrome ? 'navidrome.createPlaylist' : 'localMusic.createPlaylist')}
            />

            <TextInputDialog
                isOpen={isCreateOpen}
                onClose={() => setIsCreateOpen(false)}
                isDaylight={isDaylight}
                title={t(isNavidrome ? 'navidrome.createPlaylist' : 'localMusic.createPlaylist')}
                description={t('localMusic.enterPlaylistName')}
                placeholder={t('localMusic.enterPlaylistName')}
                confirmLabel={t('options.save')}
                onConfirm={async (name) => {
                    if (isNavidrome) {
                        await onCreateCurrentNavidromePlaylist(name);
                        await refreshNavidromePlaylists();
                        return;
                    }

                    await onCreateCurrentLocalPlaylist(name);
                }}
            />
        </div>
    );
};

export default AddToPlaylistHost;
