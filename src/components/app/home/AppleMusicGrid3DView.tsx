import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Disc3, ListMusic, Loader2, LogIn, LogOut, Music, RefreshCw } from 'lucide-react';
import DesktopGrid3DSurface, { DesktopGrid3DAction } from '../../folia-grid/DesktopGrid3DSurface';
import { Theme } from '../../../types';
import { createCoverPlaceholder } from '../../../utils/coverPlaceholders';
import {
    createAppleMusicGridViewCollection,
    GridViewCollectionDescriptor,
} from './gridViewCollectionAdapters';
import { useAppleMusicGridLibrary } from './useAppleMusicGridLibrary';

// src/components/app/home/AppleMusicGrid3DView.tsx
// Desktop-only Apple Music Grid3D overview.
//
// Structurally the sibling of NavidromeGrid3DView: a home surface that opens GridView rather than a
// legacy collection view, over a service that is not an Omni provider. The one thing it has that
// Navidrome does not is an account, so it also owns the signed-out state.

type AppleMusicSection = 'playlists' | 'albums' | 'songs';

interface AppleMusicGrid3DViewProps {
    focusedAlbumIndex: number;
    setFocusedAlbumIndex: (index: number) => void;
    onOpenGridView?: (collection: GridViewCollectionDescriptor) => void;
    theme: Theme;
    isDaylight: boolean;
    hasFloatingPlayer?: boolean;
    isInteractive?: boolean;
}

export const AppleMusicGrid3DView: React.FC<AppleMusicGrid3DViewProps> = ({
    focusedAlbumIndex,
    setFocusedAlbumIndex,
    onOpenGridView,
    theme,
    isDaylight,
    hasFloatingPlayer = false,
    isInteractive = true,
}) => {
    const { t } = useTranslation();
    const [section, setSection] = useState<AppleMusicSection>('playlists');
    const [focusedPlaylistIndex, setFocusedPlaylistIndex] = useState(0);
    const [focusedAlbumIndexLocal, setFocusedAlbumIndexLocal] = useState(0);
    const {
        albums,
        playlists,
        songCount,
        status,
        isLoading,
        errorKind,
        errorMessage,
        isSigningIn,
        available,
        refresh,
        signIn,
        signOut,
    } = useAppleMusicGridLibrary();

    const playlistItems = useMemo(() => playlists.map(playlist => ({
        id: playlist.id,
        name: playlist.name,
        coverUrl: playlist.coverUrl || createCoverPlaceholder(playlist.name, 'playlist'),
        description: playlist.curator || playlist.description || t('home.playlists'),
        trackCount: playlist.trackCount ?? undefined,
        isLibrary: true,
    })), [playlists, t]);

    const albumItems = useMemo(() => albums.map(album => ({
        id: album.id,
        name: album.name,
        coverUrl: album.coverUrl || createCoverPlaceholder(album.name, 'playlist'),
        description: album.curator || album.description,
        trackCount: album.trackCount ?? undefined,
        isLibrary: true,
    })), [albums]);

    const currentItems = section === 'playlists' ? playlistItems : section === 'albums' ? albumItems : [];
    const focusedIndex = section === 'albums' ? focusedAlbumIndexLocal : focusedPlaylistIndex;
    const setFocusedIndex = section === 'albums' ? setFocusedAlbumIndexLocal : setFocusedPlaylistIndex;

    // Keep the shared 3D index in step so switching sections does not jump the camera.
    useEffect(() => {
        setFocusedAlbumIndex(focusedIndex);
    }, [focusedIndex, setFocusedAlbumIndex]);

    const tabs: DesktopGrid3DAction[] = [
        {
            id: 'playlists',
            label: t('home.playlists'),
            icon: <ListMusic size={13} />,
            active: section === 'playlists',
            onClick: () => setSection('playlists'),
        },
        {
            id: 'albums',
            label: t('home.albums'),
            icon: <Disc3 size={13} />,
            active: section === 'albums',
            onClick: () => setSection('albums'),
        },
    ];

    const actions: DesktopGrid3DAction[] = [
        {
            id: 'refresh',
            label: t('options.audioOutputRefresh') || 'Refresh',
            icon: isLoading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />,
            disabled: isLoading || !status.signedIn,
            onClick: () => void refresh(),
            title: t('options.audioOutputRefresh') || 'Refresh',
        },
        ...(status.signedIn ? [{
            id: 'sign-out',
            label: t('account.logout'),
            icon: <LogOut size={13} />,
            onClick: () => void signOut(),
            title: t('account.logout'),
        }] : []),
    ];

    // The browser build cannot own a session cookie jar, so say so plainly instead of showing an
    // empty library the user would read as "my music is gone".
    if (!available) {
        return (
            <div className="w-full h-full flex flex-col items-center justify-center gap-5 opacity-70">
                <Music size={56} />
                <p className="text-sm">{t('appleMusic.desktopOnly')}</p>
            </div>
        );
    }

    if (!status.signedIn) {
        return (
            <div className="w-full h-full flex flex-col items-center justify-center gap-5 opacity-80">
                <Music size={56} />
                <p className="text-sm">{t('appleMusic.signInPrompt')}</p>
                {errorKind && errorMessage && (
                    <p className="text-xs opacity-60 max-w-md text-center">{errorMessage}</p>
                )}
                <button
                    onClick={() => void signIn()}
                    disabled={isSigningIn}
                    className="px-6 py-3 rounded-full bg-white/10 hover:bg-white/20 transition-colors text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-50"
                >
                    {isSigningIn
                        ? <Loader2 size={16} className="animate-spin" />
                        : <LogIn size={16} />}
                    {t('appleMusic.signIn')}
                </button>
            </div>
        );
    }

    const emptyMessage = errorKind && errorMessage
        ? errorMessage
        : section === 'playlists'
            ? t('appleMusic.noPlaylists')
            : t('appleMusic.noAlbums');

    return (
        <DesktopGrid3DSurface
            title={section === 'playlists'
                ? t('appleMusic.playlistsTitle', { count: songCount })
                : t('home.albums')}
            mapButtonLabel={t('home.allAlbums')}
            items={currentItems}
            focusedIndex={focusedIndex}
            onFocusedIndexChange={setFocusedIndex}
            onSelect={(item) => {
                // `Grid3DSliderItem` is structurally wider than the descriptor input (its `name` is
                // a ReactNode), so read the fields explicitly rather than passing the item through.
                onOpenGridView?.(createAppleMusicGridViewCollection(
                    {
                        id: item.id,
                        name: String(item.name ?? ''),
                        coverUrl: item.coverUrl,
                        description: typeof item.description === 'string' ? item.description : undefined,
                        trackCount: typeof item.trackCount === 'number' ? item.trackCount : undefined,
                        isLibrary: true,
                    },
                    section === 'albums' ? 'album' : 'playlist',
                ));
            }}
            tabs={tabs}
            actions={actions}
            isLoading={isLoading}
            emptyMessage={emptyMessage}
            theme={theme}
            isDaylight={isDaylight}
            isInteractive={isInteractive}
            hasFloatingPlayer={hasFloatingPlayer}
            playlistVisibilityScope="external-media"
        />
    );
};

export default AppleMusicGrid3DView;
