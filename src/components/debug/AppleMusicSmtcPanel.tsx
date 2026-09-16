import React, { useEffect, useState } from 'react';
import AppleMusicSmtcControls from './AppleMusicSmtcControls';
import { DASH, Field, formatMs, formatTimestamp, text } from './appleMusicSmtcFormat';

// src/components/debug/AppleMusicSmtcPanel.tsx
// Apple Music SMTC acceptance surface: shows what the bridge currently reports, and (Phase 2) offers
// the transport commands through the same preload method a real player will use.
//
// Presentation and orchestration only. It owns no IPC channel, no polling timer on the main side and
// no state beyond the last status object: it reads through the preload bridge
// (`appleMusicGetState`) and follows pushes (`onAppleMusicStateChanged`), which is the same single
// data path the rest of the app will use. The command half lives in AppleMusicSmtcControls so this
// file stays a layout.
//
// Rendered only from DevDebugOverlay, which Settings > Developer already gates. That is what makes
// this dev-only without a second visibility switch that could drift from the overlay's.

type AppleMusicSmtcStatus = {
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
    lastCommand: {
        ok: boolean;
        command: string;
        targetAppUserModelId: string | null;
        error: string | null;
        errorKind: string | null;
        completedAtMs: number | null;
    } | null;
    lastError: { message: string; kind: string | null } | null;
    isStale?: boolean;
};

interface AppleMusicSmtcPanelProps {
    panelClass: string;
}

const AppleMusicSmtcPanel: React.FC<AppleMusicSmtcPanelProps> = ({ panelClass }) => {
    const [status, setStatus] = useState<AppleMusicSmtcStatus | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const bridge = window.electron;
        if (typeof bridge?.appleMusicGetState !== 'function') {
            setError('appleMusicGetState is unavailable: not an Electron window, or the preload bridge is missing.');
            return;
        }

        let disposed = false;
        // One initial read for the current value, then pushes keep it fresh. No interval: the main
        // process already broadcasts on every change, and a poll here would be a second source of
        // truth for the same number.
        void bridge.appleMusicGetState()
            .then((next) => {
                if (!disposed) setStatus(next);
            })
            .catch((cause: unknown) => {
                if (!disposed) setError(String((cause as Error)?.message || cause));
            });

        const unsubscribe = typeof bridge.onAppleMusicStateChanged === 'function'
            ? bridge.onAppleMusicStateChanged((next) => {
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

    const connectionLabel = !status
        ? 'no data yet'
        : status.connected
            ? 'session found'
            : 'no Apple Music session';

    return (
        <section className={panelClass}>
            <div className="mb-2 flex items-center justify-between gap-3">
                <div className="text-[10px] uppercase tracking-[0.16em] opacity-60">
                    Apple Music · SMTC
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

            <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
                <Field label="connected" value={status ? String(status.connected) : DASH} mono />
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
                <AppleMusicSmtcControls
                    connected={status?.connected === true}
                    initialResult={status?.lastCommand ?? null}
                />
            </div>
        </section>
    );
};

export default React.memo(AppleMusicSmtcPanel);
