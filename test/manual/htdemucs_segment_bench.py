"""One-segment htdemucs benchmark: peak working set during run, and per-run seconds.

The Phase 0 measurement for 挂账 8b (candidate segment cuts) and the Phase 2 in-app
re-measure: feed the graph one segment of silence-shaped input at its declared length and
sample this process's RSS every 8ms DURING the run - the peak is inside session.run(), the
same sampling blind spot the app's own diagnostics had (see docs/automix-memory-optimization.md §2).

    python test/manual/htdemucs_segment_bench.py models/htdemucs.onnx [--runs 3]

Compares nothing by itself: run it once per model file and compare the two tables.
"""
import sys
import threading
import time

import numpy as np
import onnxruntime as ort
import psutil

MODEL = sys.argv[1] if len(sys.argv) > 1 else 'models/htdemucs.onnx'
RUNS = 3
if '--runs' in sys.argv:
    RUNS = int(sys.argv[sys.argv.index('--runs') + 1])

SESSION = ort.InferenceSession(MODEL, providers=['CPUExecutionProvider'])
FEED = {
    inp.name: np.zeros([d if isinstance(d, int) else 1 for d in inp.shape], dtype=np.float32)
    for inp in SESSION.get_inputs()
}

proc = psutil.Process()
peak_kb = 0
sampling = True


def sample_rss():
    global peak_kb
    while sampling:
        peak_kb = max(peak_kb, proc.memory_info().rss // 1024)
        time.sleep(0.008)


baseline_kb = proc.memory_info().rss // 1024
threading.Thread(target=sample_rss, daemon=True).start()

times = []
for run in range(RUNS):
    started = time.perf_counter()
    SESSION.run(None, FEED)
    times.append(time.perf_counter() - started)
    print(f"run {run + 1}: {times[-1]:.2f}s")

sampling = False
segment_sec = [d for inp in SESSION.get_inputs() for d in inp.shape if isinstance(d, int) and d > 1000]
print(f"model: {MODEL}")
print(f"input time dim: {segment_sec} ({(segment_sec[0] / 44100) if segment_sec else 0:.3f}s @44100)")
print(f"baseline RSS: {baseline_kb / 1024:.0f} MB")
print(f"peak RSS during run: {peak_kb / 1024:.0f} MB")
print(f"per-run seconds: {', '.join(f'{t:.2f}' for t in times)} (min {min(times):.2f})")
