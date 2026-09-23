import React, { useEffect, useState } from 'react';
import ExternalMediaSmtcControls from './ExternalMediaSmtcControls';
import { DASH, Field, formatMs, formatTimestamp, text } from './externalMediaSmtcFormat';

// src/components/debug/ExternalMediaSmtcPanel.tsx
// External media acceptance surface: shows what the bridge currently reports, and offers the
// transport commands through the same preload method the real player uses.
//
// Presentation and orchestration only. It owns no IPC channel and no state beyond the last status
// object: it reads through the preload bridge (`externalMediaGetState`) and follows pushes
// (`onExternalMediaStateChanged`), which is the same single data path the rest of the app uses. The
// command half lives in ExternalMediaSmtcControls so this file stays a layout.
//
// Rendered only from DevDebugOverlay, which Settings > Developer already gates. That is what makes
// this dev-only without a second visibility switch that could drift from the overlay's.
//
// This panel is the fastest way to diagnose the four prerequisites, because it shows each rung of the
// ladder separately (`bridgeAvailable` / `extensionConnected` / `connected` / `signedIn` /
// `storefrontMatches`). A user-visible "cannot play" almost always reduces to one of them being false,
// and the rung names say which.

type ExternalMediaStatus = {
    bridgeAvailable: boolean;
    helperState: string;
    connected: boolean;
    sourceAppUserModelId: string | null;
    title: string | null;
    artist: string | null;
    album: string | null;
    playbackStatus: string | null;
    positionMs: number | null;
    durationMs: number | null;
    hasThumbnail: boolean;
    updatedAt: number | null;
    lastEventAt: number | null;
    sessionCount: number | null;
    extensionConnected: boolean;
    extensionVersion: string | null;
    extensionCapabilities: string[];
    signedIn: boolean | null;
    storefrontMatches: boolean | null;
    lastCommand: {
        ok: boolean;
        command: string;
        targetSourceId: string | null;
        error: string | null;
        errorKind: string | null;
        completedAtMs: number | null;
    } | null;
    lastError: { message: string; kind: string | null } | null;
    isStale?: boolean;
};

interface ExternalMediaSmtcPanelProps {
    panelClass: string;
}

/** Renders a tri-state fact: `null` is "unknown", which is different from `false`. */
const tri = (value: boolean | null | undefined): string => (
    value === null || value === undefined ? 'unknown' : String(value)
);

const ExternalMediaSmtcPanel: React.FC<ExternalMediaSmtcPanelProps> = ({ panelClass }) => {
    const [status, setStatus] = useState<ExternalMediaStatus | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const bridge = window.electron;
        if (typeof bridge?.externalMediaGetState !== 'function') {
            setError('externalMediaGetState is unavailable: not an Electron window, or the preload bridge is missing.');
            return;
        }

        let disposed = false;
        // One initial read for the current value, then pushes keep it fresh. No interval: the main
        // process already broadcasts on every change, and a poll here would be a second source of
        // truth for the same number.
        void bridge.externalMediaGetState()
            .then((next) => {
                if (!disposed) setStatus(next);
            })
            .catch((cause: unknown) => {
                if (!disposed) setError(String((cause as Error)?.message || cause));
            });

        const unsubscribe = typeof bridge.onExternalMediaStateChanged === 'function'
            ? bridge.onExternalMediaStateChanged((next) => {
                if (!disposed) {
                    setStatus(next);
                    setError(null);
                }
            })
            : undefined;

        return () => {
            disposed = true;
            unsubscribe?.();
        };
    }, []);

    // The ladder is read top-down: each rung is a precondition for the next, and the first false one
    // is what the user has to fix.
    const connectionLabel = !status
        ? 'no data yet'
        : !status.bridgeAvailable
            ? 'bridge unavailable'
            : !status.extensionConnected
                ? 'extension not connected'
                : !status.connected
                    ? 'no music.apple.com tab'
                    : status.signedIn === false
                        ? 'not signed in'
                        : status.storefrontMatches === false
                            ? 'storefront mismatch'
                            : 'ready';

    return (
        <section className={panelClass}>
            <div className="mb-2 flex items-center justify-between gap-3">
                <div className="text-[10px] uppercase tracking-[0.16em] opacity-60">
                    External media · Chrome
                </div>
                <div className="flex items-center gap-2 text-[10px]">
                    {status?.isStale && <span className="opacity-70">stale</span>}
                    <span className="opacity-70">{connectionLabel}</span>
                </div>
            </div>

            {error && (
                <div className="mb-2 rounded-lg border border-red-500/30 px-2 py-1 text-[11px] text-red-400">
                    {error}
                </div>
            )}

            {status?.lastError && (
                <div className="mb-2 rounded-lg border border-amber-500/30 px-2 py-1 text-[11px] text-amber-400">
                    {status.lastError.message}
                    {status.lastError.kind ? ` (${status.lastError.kind})` : ''}
                </div>
            )}

            {/* The prerequisite ladder, in order. This is the block to read first when playback fails. */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
                <Field label="bridgeAvailable" value={status ? String(status.bridgeAvailable) : DASH} mono />
                <Field label="extensionConnected" value={status ? String(status.extensionConnected) : DASH} mono />
                <Field label="connected (SMTC)" value={status ? String(status.connected) : DASH} mono />
                <Field label="signedIn" value={tri(status?.signedIn)} mono />
                <Field label="storefrontMatches" value={tri(status?.storefrontMatches)} mono />
                <Field label="extensionVersion" value={text(status?.extensionVersion)} mono />
            </div>

            {status && status.extensionCapabilities.length > 0 && (
                <div className="mt-2 border-t border-current/10 pt-2">
                    <Field label="capabilities" value={status.extensionCapabilities.join(', ')} mono />
                </div>
            )}

            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-current/10 pt-2 sm:grid-cols-3">
                <Field label="helperState" value={text(status?.helperState)} />
                <Field label="playbackStatus" value={text(status?.playbackStatus)} />
                <Field label="positionMs" value={formatMs(status?.positionMs)} mono />
                <Field label="durationMs" value={formatMs(status?.durationMs)} mono />
                <Field label="hasThumbnail" value={status ? String(status.hasThumbnail) : DASH} mono />
                <Field label="updatedAt" value={formatTimestamp(status?.updatedAt)} mono />
                <Field label="title" value={text(status?.title)} />
                <Field label="artist" value={text(status?.artist)} />
                <Field label="album" value={text(status?.album)} />
            </div>

            <div className="mt-2 border-t border-current/10 pt-2">
                <Field label="sourceAppUserModelId" value={text(status?.sourceAppUserModelId)} mono />
            </div>

            <div className="mt-3">
                <ExternalMediaSmtcControls
                    connected={status?.extensionConnected === true}
                    initialResult={status?.lastCommand ?? null}
                />
            </div>
        </section>
    );
};

export default React.memo(ExternalMediaSmtcPanel);
