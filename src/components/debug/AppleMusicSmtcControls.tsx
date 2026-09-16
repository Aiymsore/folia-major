import React, { useCallback, useState } from 'react';
import { DASH, formatCommandResult, text } from './appleMusicSmtcFormat';

// src/components/debug/AppleMusicSmtcControls.tsx
// Phase 2 acceptance surface: the transport buttons, and the raw structured result of the last one.
//
// Dev-only by construction: the only caller is AppleMusicSmtcPanel, which DevDebugOverlay renders
// inside the Settings > Developer overlay.
//
// Every button goes through the single preload method `appleMusicSendCommand`, which is the same path
// a real player will use later. The reply is always a structured object — the bridge resolves rather
// than rejects, so a failure here is displayed, not caught as an exception.
//
// The result box is deliberately the whole reply rather than a "done" flash: the point of this panel
// is to prove WHERE a command landed, so `targetAppUserModelId` is shown even on success.

type CommandName = 'play' | 'pause' | 'toggle-play-pause' | 'previous' | 'next' | 'seek';

type CommandResult = {
    ok: boolean;
    command: string;
    targetAppUserModelId: string | null;
    error: string | null;
    errorKind: string | null;
    completedAtMs: number | null;
};

interface AppleMusicSmtcControlsProps {
    /** False when no Apple Music session is visible; the transport buttons are disabled then. */
    connected: boolean;
    /** Last result the bridge pushed with a status update, used to seed the log after a remount. */
    initialResult: CommandResult | null;
}

// Ordered for the layout, one entry per button, so adding a command later is a single line rather
// than another JSX block.
const BUTTONS: Array<{ command: CommandName; label: string }> = [
    { command: 'previous', label: '⏮ Previous' },
    { command: 'toggle-play-pause', label: '⏯ Toggle' },
    { command: 'next', label: '⏭ Next' },
    { command: 'play', label: '▶ Play' },
    { command: 'pause', label: '⏸ Pause' },
];

const AppleMusicSmtcControls: React.FC<AppleMusicSmtcControlsProps> = ({ connected, initialResult }) => {
    const [result, setResult] = useState<CommandResult | null>(initialResult);
    const [pending, setPending] = useState<string | null>(null);
    const [seekMs, setSeekMs] = useState('42000');

    const send = useCallback(async (command: CommandName, positionMs?: number) => {
        const bridge = window.electron;
        if (typeof bridge?.appleMusicSendCommand !== 'function') {
            setResult({
                ok: false,
                command,
                targetAppUserModelId: null,
                error: 'appleMusicSendCommand is unavailable: not an Electron window, or the preload bridge is missing.',
                errorKind: 'bridge-missing',
                completedAtMs: null,
            });
            return;
        }

        setPending(command);
        try {
            const reply = await bridge.appleMusicSendCommand(positionMs === undefined
                ? { command }
                : { command, positionMs });
            setResult(reply);
        } catch (cause) {
            // The bridge resolves for every outcome, so reaching here means the IPC call itself
            // failed (window closing, handler removed). Reported in the same shape as a reply.
            setResult({
                ok: false,
                command,
                targetAppUserModelId: null,
                error: String((cause as Error)?.message || cause),
                errorKind: 'ipc-failed',
                completedAtMs: null,
            });
        } finally {
            setPending(null);
        }
    }, []);

    // Seeking stays available while no session is visible so the `session-not-found` result can be
    // reproduced on demand; the transport buttons are disabled because the common case (clicking
    // "next" with nothing playing) would otherwise look like a broken app rather than a missing
    // session.
    const seekValue = Number.parseInt(seekMs, 10);
    const seekValid = Number.isFinite(seekValue) && seekValue >= 0;

    return (
        <section className="border-t border-current/10 pt-2">
            <div className="mb-2 flex items-center justify-between gap-3">
                <div className="text-[10px] uppercase tracking-[0.16em] opacity-60">Transport (dev)</div>
                <div className="text-[10px] opacity-60">{connected ? null : 'no session — transport disabled'}</div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
                {BUTTONS.map(({ command, label }) => (
                    <button
                        key={command}
                        type="button"
                        disabled={!connected || pending !== null}
                        onClick={() => void send(command)}
                        title={`appleMusicSendCommand({ command: '${command}' })`}
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
                    onClick={() => void send('seek', seekValue)}
                    title="appleMusicSendCommand({ command: 'seek', positionMs })"
                    className="rounded-md border border-current/20 px-2 py-1 text-[11px] disabled:opacity-40"
                >
                    {pending === 'seek' ? '…' : 'Seek ms'}
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

export default React.memo(AppleMusicSmtcControls);
