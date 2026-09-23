// chrome-extension/musickit-time.js
// MusicKit's time units, in one place, because getting them wrong is silent.
//
// MusicKit JS is inconsistent with itself, and the two fields sit three lines apart in
// page-bridge.js:
//
//   mk.currentPlaybackTime        -> SECONDS   (e.g. 160 for a track 2:40 long)
//   mk.currentPlaybackDuration    -> SECONDS
//   item.attributes.durationInMillis -> MILLISECONDS
//
// Measured, not assumed: with a 160.5s track the reported `currentPlaybackTime` went 2 -> 159 -> 160
// and the track then ended. Read as milliseconds those values would describe the first fifth of a
// second, so the track could never have reached its end - the position was seconds all along.
//
// The protocol between the extension and Folia is milliseconds everywhere (`positionMs`,
// `durationMs`, and SMTC's own fields). So the conversion belongs here, at the edge, where the
// MusicKit value is read - not at every consumer, and not by hoping each consumer remembers.
//
// Loaded as a MAIN-world content script BEFORE page-bridge.js (see manifest.json): same world, so
// the global below is visible to it. Split into its own file so the conversion can be unit-tested
// without a browser (see test/unit/chrome-extension/musicKitTime.test.ts).

'use strict';

(function (global) {
  /**
   * A MusicKit second-valued time to the protocol's milliseconds, or null when unusable.
   *
   * Null rather than 0 for a missing/invalid value: "unknown" and "at the very start" are different
   * facts, and the decision layer's end-of-track test depends on the difference (it refuses to judge
   * an end without a known position).
   */
  function musicKitSecondsToMs(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return null;
    }
    return Math.max(0, Math.round(value * 1000));
  }

  global.FoliaMusicKitTime = { musicKitSecondsToMs };
})(typeof window !== 'undefined' ? window : globalThis);
