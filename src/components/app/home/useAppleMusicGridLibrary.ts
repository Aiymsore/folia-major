import { useCallback, useEffect, useState } from 'react';
import {
    getAppleMusicAlbums,
    getAppleMusicPlaylists,
    getAppleMusicSongs,
    getAppleMusicStatus,
    isAppleMusicLibraryAvailable,
    signInToAppleMusic,
    signOutOfAppleMusic,
    type AppleMusicCollection,
    type AppleMusicErrorKind,
    type AppleMusicStatus,
} from '../../../services/appleMusicService';

// src/components/app/home/useAppleMusicGridLibrary.ts
// Owns Apple Music overview requests so AppleMusicGrid3DView stays a presentation-focused entry,
// mirroring useNavidromeGridLibrary.

const LIBRARY_PAGE_SIZE = 100;
const MAX_LIBRARY_PAGES = 10;

export interface AppleMusicGridLibrary {
    albums: AppleMusicCollection[];
    playlists: AppleMusicCollection[];
    songCount: number;
    status: AppleMusicStatus;
    isLoading: boolean;
    /** Set when a request failed, so the view can explain *why* rather than showing "empty". */
    errorKind: AppleMusicErrorKind | null;
    errorMessage: string | null;
    isSigningIn: boolean;
    available: boolean;
    refresh: () => Promise<void>;
    signIn: () => Promise<void>;
    signOut: () => Promise<void>;
}

/**
 * Walks every page of a library listing.
 *
 * Apple pages these endpoints, and a user with 300 playlists would otherwise see only the first
 * hundred with no indication the rest exist.
 */
const readAllPages = async <T>(
    read: (options: { limit: number; offset: number }) => Promise<
        { ok: true; page: { items: T[]; hasMore: boolean; nextOffset: number } }
        | { ok: false; errorKind: AppleMusicErrorKind; message: string }
    >,
): Promise<{ items: T[]; error: { errorKind: AppleMusicErrorKind; message: string } | null }> => {
    const items: T[] = [];
    let offset = 0;

    for (let page = 0; page < MAX_LIBRARY_PAGES; page += 1) {
        const result = await read({ limit: LIBRARY_PAGE_SIZE, offset });
        if (!result.ok) {
            // Keep whatever was already collected: a failure on page 3 should not blank pages 1-2.
            return { items, error: { errorKind: result.errorKind, message: result.message } };
        }
        items.push(...result.page.items);
        if (!result.page.hasMore) break;
        offset = result.page.nextOffset;
    }

    return { items, error: null };
};

export const useAppleMusicGridLibrary = (): AppleMusicGridLibrary => {
    const available = isAppleMusicLibraryAvailable();

    const [status, setStatus] = useState<AppleMusicStatus>({ signedIn: false, storefront: null });
    const [playlists, setPlaylists] = useState<AppleMusicCollection[]>([]);
    const [albums, setAlbums] = useState<AppleMusicCollection[]>([]);
    const [songCount, setSongCount] = useState(0);
    const [isLoading, setIsLoading] = useState(false);
    const [isSigningIn, setIsSigningIn] = useState(false);
    const [errorKind, setErrorKind] = useState<AppleMusicErrorKind | null>(null);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        if (!available) return;

        setIsLoading(true);
        setErrorKind(null);
        setErrorMessage(null);

        try {
            const nextStatus = await getAppleMusicStatus();
            setStatus(nextStatus);
            if (!nextStatus.signedIn) {
                setPlaylists([]);
                setAlbums([]);
                setSongCount(0);
                return;
            }

            const [playlistResult, albumResult, songResult] = await Promise.all([
                readAllPages(getAppleMusicPlaylists),
                readAllPages(getAppleMusicAlbums),
                getAppleMusicSongs({ limit: 1 }),
            ]);

            setPlaylists(playlistResult.items);
            setAlbums(albumResult.items);
            setSongCount(songResult.ok ? (songResult.page.total ?? songResult.page.items.length) : 0);

            // Report the first failure only; it is almost always the same cause for all three.
            const firstError = playlistResult.error || albumResult.error
                || (songResult.ok ? null : { errorKind: songResult.errorKind, message: songResult.message });
            if (firstError) {
                setErrorKind(firstError.errorKind);
                setErrorMessage(firstError.message);
            }
        } finally {
            setIsLoading(false);
        }
    }, [available]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    // Sign-in happens in a Folia-owned window; the main process tells us when Apple has actually
    // handed over a usable token, so the list appears without the user having to refresh by hand.
    useEffect(() => {
        const bridge = typeof window === 'undefined' ? undefined : window.electron;
        if (!bridge?.onAppleMusicLibraryStatusChanged) return;

        return bridge.onAppleMusicLibraryStatusChanged(() => {
            setIsSigningIn(false);
            void refresh();
        });
    }, [refresh]);

    const signIn = useCallback(async () => {
        setIsSigningIn(true);
        const result = await signInToAppleMusic();
        if (!result.ok) {
            setIsSigningIn(false);
            setErrorKind(result.errorKind);
            setErrorMessage(result.message);
        }
        // On success the status-change event above clears the flag.
    }, []);

    const signOut = useCallback(async () => {
        await signOutOfAppleMusic();
        setStatus({ signedIn: false, storefront: null });
        setPlaylists([]);
        setAlbums([]);
        setSongCount(0);
    }, []);

    return {
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
    };
};
