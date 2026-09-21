import { beforeEach, describe, expect, it } from 'vitest';
import { applyAppleMusicClockTick } from '../../../src/hooks/usePlaybackVisualizerBridge';
import { currentTime, lyricCurrentTime } from '../../../src/stores/motionSignals';

// test/unit/playback/appleMusicClockTick.test.ts
//
// The Apple Music backend had no writer for the global playback clock: all four existing sources
// (Folia's audio element, now-playing Stage, PlayerCap, synthetic Stage lyrics) describe a Folia
// deck or a Stage session, so in apple-music mode the chain matched nothing and `currentTime` stayed
// at 0 - which is why the progress bar sat at 00:00 and a completed drag never became visible.
//
// A seek hold ("keep the target until the backend catches up") was tried and REVERTED: measured on
// the real machine it only postponed the snap-back instead of making Apple Music move, so it was
// masking the symptom. The seek behaviour is being diagnosed separately; nothing here fakes a
// position the OS did not report.

const OFFSET_MS = 0;

/** One loop iteration. */
const tick = (
    backend: 'folia' | 'apple-music',
    positionMs: number | null | undefined,
    offsetMs = OFFSET_MS,
) => applyAppleMusicClockTick(backend, positionMs, offsetMs);

beforeEach(() => {
    currentTime.set(0);
    lyricCurrentTime.set(0);
});

describe('applyAppleMusicClockTick', () => {
    it('writes the SMTC position into the shared playback clock, in seconds', () => {
        const wrote = tick('apple-music', 164_000);

        expect(wrote).toBe(true);
        expect(currentTime.get()).toBe(164);
        expect(lyricCurrentTime.get()).toBe(164);
    });

    it('keeps the lyric clock on the same offset rule as the other sources', () => {
        tick('apple-music', 30_000, 250);

        expect(currentTime.get()).toBe(30);
        expect(lyricCurrentTime.get()).toBe(29.75);
    });

    it('writes nothing while another backend owns the transport', () => {
        // The regression this guards: a late SMTC snapshot overwriting the position of a Folia deck
        // that is actually playing.
        currentTime.set(12.5);
        lyricCurrentTime.set(12.5);

        const wrote = tick('folia', 164_000);

        expect(wrote).toBe(false);
        expect(currentTime.get()).toBe(12.5);
        expect(lyricCurrentTime.get()).toBe(12.5);
    });

    it('writes nothing when the snapshot carries no position', () => {
        // "Unknown" must not become "the very beginning": writing 0 would snap the bar back.
        currentTime.set(12.5);

        for (const positionMs of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(tick('apple-music', positionMs)).toBe(false);
        }

        expect(currentTime.get()).toBe(12.5);
    });

    it('clamps a negative position to zero instead of refusing it', () => {
        expect(tick('apple-music', -1000)).toBe(true);
        expect(currentTime.get()).toBe(0);
    });

    it('steps the clock forward as the snapshot advances', () => {
        tick('apple-music', 60_000);
        expect(currentTime.get()).toBe(60);

        tick('apple-music', 61_000);
        expect(currentTime.get()).toBe(61);
    });

    it('always mirrors the snapshot, so a seek that did not take effect stays visible', () => {
        // This is the property the reverted hold broke: if the backend keeps reporting 80s after a
        // seek to 84s, the clock must say 80s - a bar that keeps claiming 84s is how a failed seek
        // stayed hidden.
        tick('apple-music', 80_000);
        expect(currentTime.get()).toBe(80);
    });
});
