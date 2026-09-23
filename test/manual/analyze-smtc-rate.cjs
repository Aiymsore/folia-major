// TEMP-ANALYSIS: rate and anchor-age from the 9/15 Apple Music jumps probes.
//
// Methodology note (this is the point of the script): the wall-clock interval associated with a
// position must be measured between *change events* — the frame where a position first appears —
// not between "last time I saw the previous value" and "first time I saw the next one". Sampling a
// 1000 ms step at ~31 ms resolution makes those two differ by roughly one sampling period plus the
// phase, which is enough to fake a ~10% rate error.
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(process.cwd(), 'test-results');
const files = process.argv.slice(2);
const targets = files.length ? files : ['smtc-jumps-20260915-193158.csv', 'smtc-jumps-20260915-193116.csv'];

const clean = (s) => String(s ?? '').replace(/^\uFEFF/, '').replace(/"/g, '').trim();

for (const file of targets) {
  const full = path.join(dir, file);
  if (!fs.existsSync(full)) continue;

  const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/).filter(Boolean);
  const header = lines[0].split(',').map(clean);
  const idx = (n) => header.findIndex((h) => h.toLowerCase() === n.toLowerCase());
  const rows = lines.slice(1).map((l) => l.split(',')).map((r) => ({
    stopwatch: Number(clean(r[idx('stopwatchMs')])),
    status: clean(r[idx('playbackStatus')]),
    pos: Number(clean(r[idx('positionMs')])),
    lastUpdated: Number(clean(r[idx('lastUpdatedEpochMs')])),
  })).filter((r) => Number.isFinite(r.pos) && Number.isFinite(r.stopwatch));

  const q = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : null);

  console.log(`\n================ ${file} ================`);
  console.log(`frames=${rows.length} statuses=${[...new Set(rows.map((r) => r.status))].join(',')}`);

  // ---- change events ----
  const posEvents = [];   // first frame at which each new position value appears
  const stampEvents = []; // first frame at which each new lastUpdated value appears
  let lastPos = rows[0].pos;
  let lastStamp = rows[0].lastUpdated;
  posEvents.push({ at: rows[0].stopwatch, pos: rows[0].pos, stamp: rows[0].lastUpdated });
  stampEvents.push({ at: rows[0].stopwatch, stamp: rows[0].lastUpdated });
  for (const r of rows) {
    if (r.pos !== lastPos) {
      posEvents.push({ at: r.stopwatch, pos: r.pos, stamp: r.lastUpdated });
      lastPos = r.pos;
    }
    if (r.lastUpdated !== lastStamp) {
      stampEvents.push({ at: r.stopwatch, stamp: r.lastUpdated });
      lastStamp = r.lastUpdated;
    }
  }

  // ---- rate: dPosition / dWall between change events ----
  const first = posEvents[0];
  const last = posEvents[posEvents.length - 1];
  const dPos = last.pos - first.pos;
  const dWall = last.at - first.at;
  console.log(`position events=${posEvents.length} span=${dPos}ms over wall=${dWall.toFixed(1)}ms`);
  console.log(`=> rate = ${(dPos / dWall).toFixed(5)} x wall  (${((dPos / dWall - 1) * 100).toFixed(2)}%)`);

  const stepDeltas = [];
  for (let i = 1; i < posEvents.length; i += 1) stepDeltas.push(posEvents[i].at - posEvents[i - 1].at);
  const sortedSteps = [...stepDeltas].sort((a, b) => a - b);
  console.log(`change-to-change wall delta: min=${sortedSteps[0].toFixed(1)} p25=${q(sortedSteps, 0.25).toFixed(1)} median=${q(sortedSteps, 0.5).toFixed(1)} p75=${q(sortedSteps, 0.75).toFixed(1)} max=${sortedSteps[sortedSteps.length - 1].toFixed(1)}`);
  // If the rate were exactly 1.0 and each step is 1000 ms, change-to-change would be ~1000 ms.
  console.log(`implied rate from median step (1000/median): ${(1000 / q(sortedSteps, 0.5)).toFixed(5)}`);

  // ---- is the position change reported exactly when a stamp changes? ----
  const stampAtPosEvent = posEvents.filter((e) => e.stamp !== undefined).length;
  console.log(`position events carrying a fresh stamp: ${stampAtPosEvent}/${posEvents.length}`);

  // ---- anchor age: how old is the *oldest* observation of the position that follows a change ----
  const stampIntervals = [];
  for (let i = 1; i < stampEvents.length; i += 1) stampIntervals.push(stampEvents[i].at - stampEvents[i - 1].at);
  const sortedStamp = [...stampIntervals].sort((a, b) => a - b);
  console.log(`stamp republish interval: min=${sortedStamp[0].toFixed(1)} median=${q(sortedStamp, 0.5).toFixed(1)} max=${sortedStamp[sortedStamp.length - 1].toFixed(1)}`);
  console.log(`stamps per position step ≈ ${(stampEvents.length / Math.max(1, posEvents.length - 1)).toFixed(2)}`);

  // ---- step size vs wall delta: is a "1000 ms" step always 1000 ms of wall clock? ----
  const pairs = [];
  for (let i = 1; i < posEvents.length; i += 1) {
    pairs.push({ step: posEvents[i].pos - posEvents[i - 1].pos, wall: posEvents[i].at - posEvents[i - 1].at });
  }
  const byStep = new Map();
  for (const p of pairs) {
    if (!byStep.has(p.step)) byStep.set(p.step, []);
    byStep.get(p.step).push(p.wall);
  }
  console.log('step -> wall delta (position advance vs monotonic wall time):');
  for (const [step, walls] of [...byStep.entries()].sort((a, b) => a[0] - b[0])) {
    const s = [...walls].sort((a, b) => a - b);
    console.log(`  step ${String(step).padStart(6)}ms  n=${String(s.length).padStart(3)}  wall min=${s[0].toFixed(1)} median=${q(s, 0.5).toFixed(1)} max=${s[s.length - 1].toFixed(1)}`);
  }

  // ---- per-step rate for the nominal steps only: a real rate fault shows up here ----
  const nominal = pairs.filter((p) => p.step === 1000).map((p) => 1000 / p.wall);
  if (nominal.length) {
    const s = [...nominal].sort((a, b) => a - b);
    console.log(`per-step rate over ${nominal.length} nominal steps: min=${s[0].toFixed(4)} median=${q(s, 0.5).toFixed(4)} max=${s[s.length - 1].toFixed(4)}`);
  }

  // ---- anchor freshness: between two consecutive position events, how stale can a read be? ----
  // A reader that polls at 500 ms sees the new position at most one republish period late.
  const staleUpperBound = q(sortedStamp, 0.5) + 500;
  console.log(`worst-case anchor age for a 500 ms poller (median republish + poll): ${staleUpperBound.toFixed(1)}ms`);
}
