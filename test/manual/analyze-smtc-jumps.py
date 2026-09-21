#!/usr/bin/env python3
"""test/manual/analyze-smtc-jumps.py

Phase-stability analysis for the SMTC Position integer jump. Reads the CSV written by
`test/manual/sample-smtc-jumps.ps1` and answers one question:

    Are the N*1000 -> (N+1)*1000 Position jumps spaced at a stable period, so that a local monotonic
    clock can be anchored on a jump and advanced freely until the next one?

Design note, because this is the part that was wrong in an earlier experiment: the reported Position
*magnitude* is never used as a time here. It is only an edge trigger. The measured quantity is the
interval between consecutive edges on the machine's monotonic stopwatch, which is what a lyric clock
would actually run on. Comparing a local clock against the reported Position would instead measure
the reported Position's own quantization lag - a different and much less useful number.

Two interval estimators are reported, because edge detection is limited by the sampling period:

  raw       - the stopwatch time of the first sample that already showed the new value. The true edge
              lies somewhere in the preceding sampling window, so raw intervals inherit that window's
              width as jitter.
  midpoint  - places each edge at the centre of its detection window. On average this removes the
              detection delay and is the better estimator of the true period; its residual spread is
              what remains after that correction.

Run:  python test/manual/analyze-smtc-jumps.py test-results/smtc-jumps-*.csv
"""

from __future__ import annotations

import csv
import math
import statistics
import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Sample:
    index: int
    stopwatch_ms: float
    status: str
    position_ms: float


@dataclass
class Jump:
    """One detected Position step, with the window in which it must have happened."""

    from_ms: float
    to_ms: float
    detect_ms: float      # stopwatch time of the sample that first showed the new value
    window_start_ms: float  # stopwatch time of the previous sample
    index: int

    @property
    def midpoint_ms(self) -> float:
        return (self.window_start_ms + self.detect_ms) / 2.0


def load(path: Path) -> list[Sample]:
    rows: list[Sample] = []
    with path.open(newline="", encoding="utf-8-sig") as handle:
        for raw in csv.DictReader(handle):
            position = raw["positionMs"]
            if position == "":
                continue
            rows.append(
                Sample(
                    index=int(raw["index"]),
                    stopwatch_ms=float(raw["stopwatchMs"]),
                    status=raw["playbackStatus"],
                    position_ms=float(position),
                )
            )
    return rows


def find_jumps(samples: list[Sample]) -> tuple[list[Jump], int]:
    """Returns detected up-jumps plus the count of steps that were not a clean +1000 ms edge."""
    jumps: list[Jump] = []
    irregular = 0
    for previous, current in zip(samples, samples[1:]):
        if current.position_ms <= previous.position_ms:
            continue
        step = current.position_ms - previous.position_ms
        if abs(step - 1000.0) < 0.5:
            jumps.append(
                Jump(
                    from_ms=previous.position_ms,
                    to_ms=current.position_ms,
                    detect_ms=current.stopwatch_ms,
                    window_start_ms=previous.stopwatch_ms,
                    index=current.index,
                )
            )
        else:
            irregular += 1
    return jumps, irregular


def describe(values: list[float]) -> dict:
    if not values:
        return {}
    ordered = sorted(values)

    def percentile(p: float) -> float:
        # Nearest-rank on the sorted list; adequate for the sample counts here and avoids assuming
        # a distribution for what may be a multimodal set.
        k = max(0, min(len(ordered) - 1, math.ceil(p * len(ordered)) - 1))
        return ordered[k]

    return {
        "n": len(ordered),
        "mean": statistics.fmean(ordered),
        "median": statistics.median(ordered),
        "std": statistics.stdev(ordered) if len(ordered) > 1 else 0.0,
        "p90": percentile(0.90),
        "p95": percentile(0.95),
        "min": ordered[0],
        "max": ordered[-1],
    }


def regression(xs: list[float], ys: list[float]) -> tuple[float, float, list[float]]:
    """Least-squares slope/intercept plus residuals. x = jump index, y = stopwatch time."""
    n = len(xs)
    mean_x = statistics.fmean(xs)
    mean_y = statistics.fmean(ys)
    sxx = sum((x - mean_x) ** 2 for x in xs)
    sxy = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys))
    slope = sxy / sxx if sxx else 0.0
    intercept = mean_y - slope * mean_x
    residuals = [y - (slope * x + intercept) for x, y in zip(xs, ys)]
    return slope, intercept, residuals


def analyze(path: Path) -> int:
    samples = load(path)
    if len(samples) < 20:
        print(f"{path.name}: only {len(samples)} usable samples")
        return 1

    print("=" * 78)
    print(f"FILE {path.name}")
    print("=" * 78)

    span_ms = samples[-1].stopwatch_ms - samples[0].stopwatch_ms
    deltas = [b.stopwatch_ms - a.stopwatch_ms for a, b in zip(samples, samples[1:])]
    print(f"samples            : {len(samples)}")
    print(f"span               : {span_ms / 1000:.3f} s")
    print(f"sampling cadence   : median={statistics.median(deltas):.2f} ms  max={max(deltas):.2f} ms")
    print(f"statuses           : {sorted({s.status for s in samples})}")

    jumps, irregular = find_jumps(samples)
    print()
    print(f"detected +1000 ms jumps : {len(jumps)}")
    print(f"irregular steps (skipped): {irregular}")
    if len(jumps) < 5:
        print("Not enough jumps to measure period stability.")
        return 1

    raw = [b.detect_ms - a.detect_ms for a, b in zip(jumps, jumps[1:])]
    mid = [b.midpoint_ms - a.midpoint_ms for a, b in zip(jumps, jumps[1:])]

    labels = {
        "mean": "mean", "median": "median", "std": "std", "p90": "p90", "p95": "p95",
        "min": "min", "max": "max", "n": "n",
    }
    for name, series in (("RAW (detect-to-detect)", raw), ("MIDPOINT (edge-centred)", mid)):
        stats = describe(series)
        print()
        print(f"--- INTERVAL {name} ---")
        for key in ("n", "mean", "median", "std", "p90", "p95", "min", "max"):
            print(f"  {labels[key]:<7}: {stats[key]:.3f} ms")
        print(f"  mean - 1000     : {stats['mean'] - 1000.0:+.3f} ms")
        print(f"  spread (max-min): {stats['max'] - stats['min']:.3f} ms")

    # Best-fit period absorbs any systematic cadence bias, so the residuals show pure jitter around
    # the clock the jumps actually define - the number a lyric clock would have to live with.
    xs = list(range(len(jumps)))
    slope, _, residuals = regression(xs, [j.midpoint_ms for j in jumps])
    print()
    print("--- BEST-FIT PERIOD (midpoint anchors vs jump index) ---")
    print(f"  period         : {slope:.3f} ms   (offset from 1000: {slope - 1000.0:+.3f} ms, {((slope / 1000) - 1) * 1e6:+.1f} ppm)")
    res_abs = [abs(r) for r in residuals]
    stats = describe(res_abs)
    print(f"  |residual|     : mean={stats['mean']:.2f} median={stats['median']:.2f} "
          f"p90={stats['p90']:.2f} p95={stats['p95']:.2f} max={stats['max']:.2f} ms")

    # Proves whether the spread is just the sampling window or something larger: nearest-value
    # quantization of the raw intervals is expected if limits are dominated by edge detection.
    rounded = [round(v / 10) * 10 for v in raw]
    print()
    print("--- SHAPE ---")
    print(f"  raw intervals rounded to 10 ms: {sorted({r for r in rounded})}")
    print(f"  distinct raw values           : {len(set(raw))} over {len(raw)} intervals")
    if raw:
        near = [v for v in raw if abs(v - 1000.0) <= 60]
        print(f"  within +/-60 ms of 1000       : {len(near)}/{len(raw)} ({100 * len(near) / len(raw):.1f}%)")

    print()
    print("--- VERDICT INPUTS ---")
    print(f"  sampling cadence (ms)      : {statistics.median(deltas):.2f}")
    print(f"  raw spread (ms)            : {max(raw) - min(raw):.3f}")
    print(f"  midpoint |residual| p95/max: {stats['p95']:.2f} / {stats['max']:.2f}")
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
