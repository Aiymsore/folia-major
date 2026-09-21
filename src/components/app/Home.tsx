import React from 'react';
import Grid3D from '../Grid3D';
import GridViewOverlayHost from './home/GridViewOverlayHost';
import type { HomeViewModel } from './home/buildHomeModel';
import type { PlaybackSwitcherEntries } from '../../hooks/usePlaybackSwitcherEntries';
import { countRender } from '../../dev/renderCount';

// App-level entry for the home surface backed by a view model.
type AppHomeProps = {
    model: HomeViewModel;
    /**
     * Phase 3A: the platform menu's entries with the Apple Music backend entry. Passed beside the
     * memoised `model` rather than inside it — the entries change whenever the SMTC snapshot does,
     * and folding them into the view model would invalidate it (re-rendering Home) on every Apple
     * Music playback tick.
     */
    playbackSwitcherEntries?: PlaybackSwitcherEntries;
    isHomeFullyHidden?: boolean;
    isInteractive?: boolean;
};

const Home: React.FC<AppHomeProps> = ({ model, playbackSwitcherEntries, isHomeFullyHidden, isInteractive = true }) => {
    countRender('Home');
    if (isHomeFullyHidden) {
        return null;
    }

    return (
        <GridViewOverlayHost
            surfaceProps={model.surfaceProps}
            onOpenCollection={model.onOpenCollection}
            onPushCollection={model.onPushCollection}
            onBackCollection={model.onBackCollection}
            isInteractive={isInteractive}
        >
            {(openGridView, isHomeGridInteractive) => (
                <Grid3D
                    {...model.surfaceProps}
                    onlineProviderPlatform={model.onlineProviderPlatform}
                    playbackSwitcherEntries={playbackSwitcherEntries}
                    onOpenGridView={openGridView}
                    isInteractive={isHomeGridInteractive}
                />
            )}
        </GridViewOverlayHost>
    );
};

// Memoised because App re-renders on every store write anywhere in the app, while `homeModel`
// only changes for the 35 values it is actually built from. Without this the whole home tree
// re-runs for a volume drag.
export default React.memo(Home);
