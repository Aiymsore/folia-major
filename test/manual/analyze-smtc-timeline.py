#!/usr/bin/env python3
"""test/manual/analyze-smtc-timeline.py

Analysis half of the SMTC timeline experiment. Reads the CSV written by
`test/manual/sample-smtc-timeline.ps1` and answers one question:

    Is `Position` + `LastUpdatedTime` enough to anchor a local monotonic clock for
    word-by-word lyric sync?

Method: treat wall clock (`frameEpochMs`) as ground truth, because it comes from the machine running
the probe and advances monotonically. Then ask how well the *reported* timeline can be reproduced by
a local clock that only ever sees the OS values.

Two candidate local clocks are scored against the reported position:

  A. between-updates    - anchor on Position, advance by wall clock, re-anchor on every fresh
                          Position (detected via a changed LastUpdatedTime).
  B. lastUpdated-based  - anchor on (Position, LastUpdatedTime), advance by wall clock from
                          LastUpdatedTime rather than from the frame we happened to observe it on.

Clock A is what a naive implementation does. Clock B is what the OS is arguably offering. The
difference between them is the error the OS's own anchor timestamp removes.

Run:  python test/manual/analyze-smtc-timeline.py test-results/smtc-timeline-*.csv
"""

from __future__ import annotations

import csv
import statistics
import sys
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Sample:
    index: int
    frame_ms: int          # wall clock when the probe read the session
    status: str
    position_ms: float
    end_ms: float
    last_updated_ms: int   # OS anchor timestamp for `position_ms`


@dataclass
class UpdateRun:
    """One contiguous run of samples that reported the same Position."""
    position_ms: float
    first_frame_ms: int
    last_frame_ms: int
    last_updated_ms: int
    sample_count: int = 0

    @property
    def observed_span_ms(self) -> int:
        return self.last_frame_ms - self.first_frame_ms


def load(path: Path) -> list[Sample]:
    rows: list[Sample] = []
    with path.open(newline="", encoding="utf-8-sig") as handle:
        for raw in csv.DictReader(handle):
            rows.append(
                Sample(
                    index=int(raw["index"]),
                    frame_ms=int(raw["frameEpochMs"]),
                    status=raw["playbackStatus"],
                    position_ms=float(raw["positionMs"]),
                    end_ms=float(raw["endTimeMs"]),
                    last_updated_ms=int(raw["lastUpdatedEpochMs"]),
                )
            )
    return rows


def group_updates(samples: list[Sample]) -> list[UpdateRun]:
    """Collapses consecutive samples sharing a Position into one reported update."""
    runs: list[UpdateRun] = []
    for sample in samples:
        if runs and runs[-1].position_ms == sample.position_ms:
            runs[-1].last_frame_ms = sample.frame_ms
            runs[-1].last_updated_ms = sample.last_updated_ms
            runs[-1].sample_count += 1
            continue
        runs.append(
            UpdateRun(
                position_ms=sample.position_ms,
                first_frame_ms=sample.frame_ms,
                last_frame_ms=sample.frame_ms,
                last_updated_ms=sample.last_updated_ms,
                sample_count=1,
            )
        )
    return runs


def describe(values: list[float]) -> str:
    if not values:
        return "n/a"
    if len(values) == 1:
        return f"{values[0]:.0f} (single)"
    ordered = sorted(values)
    return (
        f"min={ordered[0]:.0f} median={statistics.median(ordered):.0f} "
        f"mean={statistics.fmean(ordered):.0f} max={ordered[-1]:.0f} p90={ordered[int(len(ordered) * 0.9) - 1]:.0f}"
    )


def score_clock(
    samples: list[Sample], anchor_position_of, anchor_time_of, label: str
) -> dict:
    """Replays a local clock against the reported position and returns its error profile."""
    errors: list[float] = []
    playing = False
    anchor_position = 0.0
    anchor_frame_ms = 0

    for sample in samples:
        if sample.status != "Playing":
            playing = False
            anchor_position = sample.position_ms
            anchor_frame_ms = sample.frame_ms
            continue

        new_anchor = anchor_position_of(sample)
        if not playing or new_anchor != anchor_position:
            anchor_position = new_anchor
            anchor_frame_ms = anchor_time_of(sample)

        if sample.frame_ms < anchor_frame_ms:
            # LastUpdatedTime can run ahead of our own read; a negative elapsed would rewind the
            # clock, which is exactly the failure the anti-rollback guard in Folia exists to hide.
            errors.append(sample.position_ms - anchor_position)
            playing = True
            continue

        elapsed = sample.frame_ms - anchor_frame_ms
        local_estimate = anchor_position + elapsed
        errors.append(sample.position_ms - local_estimate)
        playing = True

    abs_errors = [abs(e) for e in errors]
    return {
        "label": label,
        "n": len(errors),
        "abs_median": statistics.median(abs_errors) if abs_errors else 0.0,
        "abs_mean": statistics.fmean(abs_errors) if abs_errors else 0.0,
        "abs_max": max(abs_errors) if abs_errors else 0.0,
        "abs_p90": sorted(abs_errors)[int(len(abs_errors) * 0.9) - 1] if abs_errors else 0.0,
        "overshoot_max": max(errors) if errors else 0.0,
        "undershoot_min": min(errors) if errors else 0.0,
    }


def analyze(path: Path) -> int:
    samples = load(path)
    if not samples:
        print(f"{path}: no rows")
        return 1

    print("=" * 78)
    print(f"FILE {path.name}")
    print("=" * 78)

    span_ms = samples[-1].frame_ms - samples[0].frame_ms
    print(f"samples            : {len(samples)}")
    print(f"wall-clock span    : {span_ms / 1000:.2f} s")
    print(f"effective interval : {span_ms / max(1, len(samples) - 1):.1f} ms")

    frame_deltas = [b.frame_ms - a.frame_ms for a, b in zip(samples, samples[1:])]
    print(f"frame delta        : {describe(frame_deltas)}  (monotonic={all(d > 0 for d in frame_deltas)})")
    print(f"statuses           : {sorted({s.status for s in samples})}")

    runs = group_updates(samples)
    print()
    print("--- POSITION GRANULARITY ---")
    distinct_positions = sorted({s.position_ms for s in samples})
    print(f"distinct Position  : {len(distinct_positions)} over {len(samples)} samples")
    position_deltas = [
        b - a for a, b in zip(distinct_positions, distinct_positions[1:]) if b > a
    ]
    print(f"Position step      : {describe(position_deltas)} ms")
    print(f"Position values    : {distinct_positions[:12]}{' ...' if len(distinct_positions) > 12 else ''}")

    update_gaps = [b.first_frame_ms - a.first_frame_ms for a, b in zip(runs, runs[1:])]
    print(f"gap between updates: {describe(update_gaps)} ms  ({len(runs)} reported updates)")

    regressions = [
        (a.position_ms, b.position_ms)
        for a, b in zip(runs, runs[1:])
        if b.position_ms < a.position_ms
    ]
    print(f"backward jumps     : {len(regressions)} {regressions[:5]}")

    print()
    print("--- LastUpdatedTime BEHAVIOUR ---")
    distinct_lu = sorted({s.last_updated_ms for s in samples})
    print(f"distinct LU values : {len(distinct_lu)} over {len(samples)} samples")
    lu_changes = sum(1 for a, b in zip(distinct_lu, distinct_lu[1:]) if b != a)
    print(f"LU distinct changes: {lu_changes} (vs {max(1, len(runs) - 1)} Position changes)")
    lu_deltas = [b - a for a, b in zip(distinct_lu, distinct_lu[1:])]
    print(f"LU step            : {describe(lu_deltas)} ms")

    # How stale is Position when we read it? Fractional part shows whether LU is a real sub-second
    # anchor or just a rounded copy of the frame time.
    lu_lag = [s.frame_ms - s.last_updated_ms for s in samples]
    print(f"frame - LU         : {describe(lu_lag)} ms")
    fractional = [s.last_updated_ms % 1000 for s in samples]
    print(f"LU fractional ms   : {sorted({int(f) for f in fractional})}")

    print()
    print("--- LOCAL CLOCK ERROR (ms; + = local clock behind OS) ---")
    clock_a = score_clock(samples, lambda s: s.position_ms, lambda s: s.frame_ms, "A between-updates")
    clock_b = score_clock(
        samples,
        lambda s: s.position_ms,
        lambda s: max(s.last_updated_ms, s.frame_ms - 1000),
        "B lastUpdated-anchored",
    )
    for clock in (clock_a, clock_b):
        print(
            f"{clock['label']:<22} n={clock['n']:<4} "
            f"|err| median={clock['abs_median']:7.1f} p90={clock['abs_p90']:7.1f} "
            f"max={clock['abs_max']:7.1f}  range=[{clock['undershoot_min']:.0f}, {clock['overshoot_max']:.0f}]"
        )

    print()
    print("--- VERDICT INPUTS ---")
    worst_step = max(position_deltas) if position_deltas else 0
    print(f"coarsest position step : {worst_step:.0f} ms")
    print(f"median update gap      : {statistics.median(update_gaps) if update_gaps else 0:.0f} ms")
    print(f"|err| max (clock A)    : {clock_a['abs_max']:.0f} ms")
    return 0


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2

    status = 0
    for arg in argv[1:]:
        path = Path(arg)
        if not path.exists():
            print(f"missing: {path}")
            status = 1
            continue
        status |= analyze(path)
    return status


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
