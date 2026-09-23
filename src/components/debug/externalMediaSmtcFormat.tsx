import React from 'react';

// src/components/debug/externalMediaSmtcFormat.tsx
// Shared presentation helpers for the dev-only external-media SMTC diagnostic surface. Split out of
// ExternalMediaSmtcPanel so the status panel and the control panel render identical formatting instead
// of keeping two copies of the same millisecond formatter.

export const DASH = '—';

export const text = (value: string | number | null | undefined) => (
    value === null || value === undefined || value === '' ? DASH : String(value)
);

// Milliseconds to m:ss.mmm. Apple Music's position is quantized to whole seconds, but other SMTC
// sources report real milliseconds, so the format keeps them rather than implying sub-second
// precision this source does not have.
export const formatMs = (value: number | null | undefined) => {
    if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
    const totalSeconds = Math.max(0, value) / 1000;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds - minutes * 60;
    return `${minutes}:${seconds.toFixed(3).padStart(6, '0')}`;
};

export const formatTimestamp = (value: number | null | undefined) => {
    if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
    return new Date(value).toLocaleTimeString();
};

/**
 * The command result as one short line for the diagnostic log. Kept terse on purpose: the panel
 * exists to show whether a command reached the external player, and `errorKind` is the machine-readable
 * part of that answer — the free-text `error` follows it for a human reading over the shoulder.
 *
 * `targetSourceId` is shown even on success: "which media source did this land on" is the question
 * this panel answers, and a null target is the proof that nothing was controlled.
 */
export const formatCommandResult = (result: {
    ok: boolean;
    command: string;
    targetSourceId: string | null;
    error: string | null;
    errorKind: string | null;
}) => {
    const target = result.targetSourceId ? ` · ${result.targetSourceId}` : ' · no target';
    if (result.ok) return `${result.command} → ok${target}`;
    const kind = result.errorKind ?? 'error';
    return `${result.command} → ${kind}${target}${result.error ? ` · ${result.error}` : ''}`;
};

export const Field: React.FC<{ label: string; value: string; mono?: boolean }> = ({ label, value, mono = false }) => (
    <div className="min-w-0">
        <div className="text-[9px] uppercase tracking-[0.16em] opacity-50">{label}</div>
        <div className={`truncate text-[12px] ${mono ? 'tabular-nums' : ''}`} title={value}>{value}</div>
    </div>
);
