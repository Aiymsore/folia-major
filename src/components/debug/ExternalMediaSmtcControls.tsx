import React, { useCallback, useState } from 'react';
import { DASH, formatCommandResult, text } from './externalMediaSmtcFormat';

// src/components/debug/ExternalMediaSmtcControls.tsx
// Transport acceptance surface: the transport buttons, and the raw structured result of the last one.
//
// Dev-only by construction: the only caller is ExternalMediaSmtcPanel, which DevDebugOverlay renders
// inside the Settings > Developer overlay.
//
// Every button goes through the single preload method `externalMediaSendCommand`, which is the same path
// the real player uses. The reply is always a structured object — the bridge resolves rather than
// rejects, so a failure here is displayed, not caught as an exception.
//
// The result box is deliberately the whole reply rather than a "done" flash: the point of this panel
// is to prove WHERE a command landed, so `targetSourceId` is shown even on success.
//
// Two changes from the desktop-era panel:
//   * **No next / previous buttons.** Folia owns the queue, so those are resolved by the queue layer
//     into `playById`; the bridge refuses them, and offering a button that always errors would be
//     misleading. The queue's own next/prev are exercised from the player UI instead.
//   * **A playById field**, which is the capability this whole architecture exists for and the one
//     thing that cannot be verified from the transport buttons.

type CommandName = 'play' | 'pause' | 'toggle' | 'seek' | 'playById';

type CommandResult = {
    ok: boolean;
    command: string;
    targetSourceId: string | null;
    error: string | null;
    errorKind: string | null;
    completedAtMs: number | null;
};

interface ExternalMediaSmtcControlsProps {
    /** False when the external media transport is not ready; the transport buttons are disabled then. */
    connected: boolean;
    /** Last result the bridge pushed with a status update, used to seed the log after a remount. */
    initialResult: CommandResult | null;
}

// Ordered for the layout, one entry per button, so adding a command later is a single line rather
// than another JSX block.
const BUTTONS: Array<{ command: CommandName; label: string }> = [
    { command: 'toggle', label: '⏯ Toggle' },
    { command: 'play', label: '▶ Play' },
    { command: 'pause', label: '⏸ Pause' },
];

const ExternalMediaSmtcControls: React.FC<ExternalMediaSmtcControlsProps> = ({ connected, initialResult }) => {
    const [result, setResult] = useState<CommandResult | null>(initialResult);
    const [pending, setPending] = useState<string | null>(null);
    const [seekMs, setSeekMs] = useState('42000');
    const [mediaId, setMediaId] = useState('');

    const send = useCallback(async (command: CommandName, extra?: { positionMs?: number; mediaId?: string }) => {
        const bridge = window.electron;
        if (typeof bridge?.externalMediaSendCommand !== 'function') {
            setResult({
                ok: false,
                command,
                targetSourceId: null,
                error: 'externalMediaSendCommand is unavailable: not an Electron window, or the preload bridge is missing.',
                errorKind: 'bridge-missing',
                completedAtMs: null,
            });
            return;
        }

        setPending(command);
        try {
            const reply = await bridge.externalMediaSendCommand({ command, ...(extra ?? {}) });
            setResult(reply);
        } catch (cause) {
            // The bridge resolves for every outcome, so reaching here means the IPC call itself
            // failed (window closing, handler removed). Reported in the same shape as a reply.
            setResult({
                ok: false,
                command,
                targetSourceId: null,
                error: String((cause as Error)?.message || cause),
                errorKind: 'ipc-failed',
                completedAtMs: null,
            });
        } finally {
            setPending(null);
        }
    }, []);

    // Seeking and playById stay available while the transport is not ready, so their structured
    // failures can be reproduced on demand; the transport buttons are disabled because the common
    // case (clicking "toggle" with no extension) would otherwise look like a broken app rather than
    // a missing prerequisite.
    const seekValue = Number.parseInt(seekMs, 10);
    const seekValid = Number.isFinite(seekValue) && seekValue >= 0;
    const mediaIdValid = mediaId.trim().length > 0;

    return (
        <section className="border-t border-current/10 pt-2">
            <div className="mb-2 flex items-center justify-between gap-3">
                <div className="text-[10px] uppercase tracking-[0.16em] opacity-60">Transport (dev)</div>
                <div className="text-[10px] opacity-60">{connected ? null : 'extension not connected — transport disabled'}</div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
                {BUTTONS.map(({ command, label }) => (
                    <button
                        key={command}
                        type="button"
                        disabled={!connected || pending !== null}
                        onClick={() => void send(command)}
                        title={`externalMediaSendCommand({ command: '${command}' })`}
                        className="rounded-md border border-current/20 px-2 py-1 text-[11px] disabled:opacity-40"
                    >
                        {pending === command ? '…' : label}
                    </button>
                ))}

                <span className="mx-1 opacity-30">|</span>

                <input
                    type="number"
                    min={0}
                    step={1000}
                    value={seekMs}
                    onChange={(event) => setSeekMs(event.target.value)}
                    aria-label="seek position in milliseconds"
                    className="w-24 rounded-md border border-current/20 bg-transparent px-2 py-1 text-[11px] tabular-nums"
                />
                <button
                    type="button"
                    disabled={!seekValid || pending !== null}
                    onClick={() => void send('seek', { positionMs: seekValue })}
                    title="externalMediaSendCommand({ command: 'seek', positionMs })"
                    className="rounded-md border border-current/20 px-2 py-1 text-[11px] disabled:opacity-40"
                >
                    {pending === 'seek' ? '…' : 'Seek ms'}
                </button>
            </div>

            {/* The one capability the desktop backend could not provide: play a specific track by id. */}
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <input
                    type="text"
                    value={mediaId}
                    onChange={(event) => setMediaId(event.target.value)}
                    placeholder="Apple Music catalog id"
                    aria-label="Apple Music catalog id"
                    className="w-56 rounded-md border border-current/20 bg-transparent px-2 py-1 text-[11px] tabular-nums"
                />
                <button
                    type="button"
                    disabled={!mediaIdValid || pending !== null}
                    onClick={() => void send('playById', { mediaId: mediaId.trim() })}
                    title="externalMediaSendCommand({ command: 'playById', mediaId })"
                    className="rounded-md border border-current/20 px-2 py-1 text-[11px] disabled:opacity-40"
                >
                    {pending === 'playById' ? '…' : 'Play by id'}
                </button>
            </div>

            <div className="mt-2 border-t border-current/10 pt-2">
                <div className="text-[9px] uppercase tracking-[0.16em] opacity-50">last command</div>
                <div
                    className={`truncate text-[11px] tabular-nums ${result && !result.ok ? 'text-amber-400' : ''}`}
                    title={result ? formatCommandResult(result) : DASH}
                >
                    {result ? formatCommandResult(result) : text(null)}
                </div>
                {result?.completedAtMs !== null && result?.completedAtMs !== undefined && (
                    <div className="truncate text-[10px] opacity-50">
                        completedAtMs {result.completedAtMs}
                    </div>
                )}
            </div>
        </section>
    );
};

export default React.memo(ExternalMediaSmtcControls);
