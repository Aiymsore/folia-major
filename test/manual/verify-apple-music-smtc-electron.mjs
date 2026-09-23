// test/manual/verify-apple-music-smtc-electron.mjs
//
// One-shot real-Electron acceptance run for the Apple Music SMTC chain:
//
//   read  : folia-apple-music-smtc-helper.exe -> electron/externalMediaSmtcBridge.cjs -> IPC
//           -> preload.cjs -> renderer
//   write : renderer -> preload.cjs -> IPC -> bridge stdin -> helper -> SMTC Try* -> Apple Music
//
// Not part of the app and not run by CI: it starts the Vite dev server, launches the real Electron
// binary with the dev helper-path override and the probe flag, captures the probe output, and shuts
// everything down. Written because the agent sandbox cannot download the Electron binary; run it from
// a normal shell after `npm ci` has fetched Electron.
//
// Usage:
//   node test/manual/verify-apple-music-smtc-electron.mjs [--commands] [--timeout-ms 90000]
//
// --commands is OFF by default and must be asked for: it makes Apple Music actually pause, seek, skip
// and toggle, which changes what the user is hearing.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOST = '127.0.0.1';
const PORT = 3000;
const HELPER = path.join(ROOT, 'build', 'folia-apple-music-smtc-helper.exe');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PROBE_PREFIX = '[apple-music-smtc-verify]';

// The probe's own command sequence, in order. The count is asserted, so a partial run cannot be read
// as a pass.
const EXPECTED_COMMANDS = ['pause', 'play', 'seek', 'next', 'previous', 'toggle-play-pause'];
const COMMAND_PHASE_TIMEOUT_MS = 30_000;

const commandsArg = process.argv.includes('--commands');
const timeoutArg = process.argv.indexOf('--timeout-ms');
const TIMEOUT_MS = timeoutArg > -1 ? Number(process.argv[timeoutArg + 1]) : 90_000;

function fail(message) {
  console.error(`\n[verify] FAIL: ${message}`);
  process.exit(1);
}

// Preconditions are checked up front so a missing piece reports itself instead of looking like a
// bridge failure twenty seconds later.
if (process.platform !== 'win32') fail('this verification only applies on Windows');
if (!existsSync(ELECTRON)) {
  fail(
    `Electron binary missing at ${ELECTRON}\n` +
      '        The npm package is present but its postinstall download never ran. Fix with:\n' +
      '          npx --yes @electron/get 2>NUL || node node_modules/electron/install.js',
  );
}
if (!existsSync(HELPER)) {
  fail(
    `helper missing at ${HELPER}\n` +
      '        Build and stage it first:\n' +
      '          cd packaging/windows/apple-music-smtc-helper && cargo build --release\n' +
      '          node packaging/windows/build-apple-music-smtc-helper.mjs',
  );
}

const children = [];
function track(child, name) {
  children.push({ child, name });
  return child;
}
function shutdown() {
  for (const { child } of children) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
}

const lines = [];
const timers = [];

function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const response = await fetch(url);
        if (response.ok) {
          resolve();
          return;
        }
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) {
        reject(new Error(`timed out waiting for ${url}`));
        return;
      }
      timers.push(setTimeout(tick, 500));
    };
    void tick();
  });
}

// Waits until `predicate` holds over the captured probe lines, or the deadline passes. Returning
// false on timeout lets the report say "incomplete" instead of printing a tally over a partial run.
// Waiting on the probe's own completion markers rather than a fixed sleep is also what leaves room
// for the command phase without guessing how long it takes.
function waitForProbe(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      if (lines.some(predicate)) {
        resolve(true);
        return;
      }
      if (Date.now() > deadline) {
        resolve(false);
        return;
      }
      timers.push(setTimeout(tick, 500));
    };
    tick();
  });
}

async function main() {
  console.log('[verify] staging check ok');
  console.log(`[verify] helper : ${HELPER}`);
  console.log(`[verify] electron: ${ELECTRON}`);
  console.log(
    `[verify] commands: ${commandsArg ? 'WILL BE SENT (playback will change)' : 'skipped (read-only run; pass --commands to test transport)'}`,
  );

  console.log('[verify] starting vite dev server...');
  const vite = track(
    spawn(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
    'vite',
  );
  vite.stdout.on('data', (chunk) => process.stdout.write(`[vite] ${chunk}`));
  vite.stderr.on('data', (chunk) => process.stdout.write(`[vite:err] ${chunk}`));

  await waitForHttp(`http://${HOST}:${PORT}/`, 60_000);
  console.log('[verify] vite is up');

  console.log('[verify] launching electron with probe enabled...');
  const electron = track(
    spawn(ELECTRON, ['.', `--remote-debugging-port=0`], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ELECTRON_DEV: 'true',
        // Dev runs have no resources/ dir, so both helpers are pointed at build/ explicitly,
        // mirroring how npm run dev:electron wires the wallpaper helper.
        FOLIA_APPLE_MUSIC_SMTC_HELPER_PATH: HELPER,
        FOLIA_APPLE_MUSIC_SMTC_VERIFY: '1',
        ...(commandsArg ? { FOLIA_APPLE_MUSIC_SMTC_VERIFY_COMMANDS: '1' } : {}),
        FOLIA_WINDOWTOLAYER_PATH: path.join(ROOT, 'build', 'windowtolayer'),
      },
    }),
    'electron',
  );

  const capture = (chunk, tag) => {
    const text = String(chunk);
    process.stdout.write(`[${tag}] ${text}`);
    for (const line of text.split('\n')) {
      if (line.includes(PROBE_PREFIX)) lines.push(line.trim());
    }
  };
  electron.stdout.on('data', (chunk) => capture(chunk, 'electron'));
  electron.stderr.on('data', (chunk) => capture(chunk, 'electron:err'));

  electron.on('exit', (code) => {
    console.log(`[verify] electron exited (code=${code})`);
  });

  // The read probe pulls five times at 2 s intervals and prints `done` afterwards.
  const readPhaseFinished = await waitForProbe(
    (line) => line.includes(`${PROBE_PREFIX} done`),
    TIMEOUT_MS,
  );
  const commandPhaseFinished = commandsArg
    ? await waitForProbe((line) => line.includes(`${PROBE_PREFIX} commands-done`), COMMAND_PHASE_TIMEOUT_MS)
    : null;
  shutdown();

  console.log('\n================ probe output ================');
  if (lines.length === 0) {
    console.log('(no probe lines captured)');
  } else {
    for (const line of lines) console.log(line);
  }
  console.log('=============================================\n');

  const hasPull = lines.some((line) => line.includes('pull#1'));
  const hasBridge = lines.some((line) => line.includes('preload-bridge'));
  const hasPush = lines.some((line) => line.includes('pushed-count'));
  const pushCount = Number(
    ((lines.find((line) => line.includes('pushed-count')) || '').match(/"count":(\d+)/) || [])[1] || 0,
  );
  const connected = lines.some((line) => line.includes('"connected":true'));
  const anyError = lines.some((line) => line.includes('"error":'));

  console.log(`[verify] preload bridge visible in renderer : ${hasBridge ? 'YES' : 'no'}`);
  console.log(
    `[verify] preload command API visible        : ${lines.some((line) => line.includes('"hasSend":"function"')) ? 'YES' : 'no'}`,
  );
  console.log(`[verify] renderer pulled state via preload  : ${hasPull ? 'YES' : 'no'}`);
  console.log(`[verify] renderer received pushed changes   : ${hasPush ? `YES (${pushCount})` : 'no'}`);
  console.log(`[verify] a real media session was read     : ${connected ? 'YES' : 'no'}`);
  if (!readPhaseFinished) console.log('[verify] note: the read probe never reported completion');
  if (anyError) console.log('[verify] note: at least one probe call reported a failure');

  let commandVerdict = 'not requested (pass --commands)';
  let commandsOk = true;
  if (commandsArg) {
    const reported = EXPECTED_COMMANDS.map((command) => {
      const line = lines.find((entry) => entry.includes(`command#${command}`));
      if (!line) return { command, ok: false, errorKind: 'no-response', target: null };
      let reply = {};
      try {
        reply = JSON.parse(line.slice(line.indexOf('{')));
      } catch {
        return { command, ok: false, errorKind: 'unparsable', target: null };
      }
      return {
        command,
        ok: reply.ok === true,
        errorKind: reply.errorKind ?? null,
        target: reply.targetAppUserModelId ?? null,
      };
    });

    const delivered = reported.filter((entry) => entry.ok).length;
    commandVerdict = `${delivered}/${reported.length} delivered`;
    commandsOk = commandPhaseFinished === true && delivered === reported.length;

    for (const entry of reported) {
      // Fields are padded rather than concatenated so the columns line up regardless of which
      // optional values are present.
      const status = entry.ok ? 'ok' : `FAILED(${entry.errorKind})`;
      console.log(
        `[verify]   ${entry.command.padEnd(18)} ${status.padEnd(28)} ${entry.target ?? 'no target'}`,
      );
    }
    if (commandPhaseFinished !== true) {
      console.log('[verify] note: the command phase did not report completion before the deadline');
    }
  }
  console.log(`[verify] transport commands                  : ${commandVerdict}`);

  // The chain is proven by the bridge being visible in the renderer plus a successful pull. With
  // --commands every command must also have been delivered, or the run is a failure: "most of them
  // worked" is not a pass for a transport surface.
  const ok = hasBridge && hasPull && commandsOk;
  console.log(`\n[verify] ${ok ? 'CHAIN OK' : 'CHAIN INCOMPLETE'}`);
  process.exit(ok ? 0 : 1);
}

process.on('exit', shutdown);
process.on('SIGINT', () => {
  shutdown();
  process.exit(130);
});

main().catch((error) => {
  shutdown();
  fail(error?.stack || String(error));
});
