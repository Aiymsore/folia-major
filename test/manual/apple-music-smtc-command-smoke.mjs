// test/manual/external-media-smtc-command-smoke.mjs
//
// Side-effect-free smoke check for the Phase 2 command channel in
// electron/externalMediaSmtcBridge.cjs: id correlation, the structured failure kinds, timeouts, and
// refusing to queue a command for a helper that is not running.
//
// Why this exists next to the vitest suite: the vitest run needs Vite to load vitest.config.ts, and
// Vite's Windows real-path resolution spawns a child process that the agent sandbox denies
// (spawn EPERM). This file needs nothing but `node`, so it is what can actually be run here;
// `npm test` remains the real gate and this is a convenience, not a replacement.
//
// Usage:  node test/manual/external-media-smtc-command-smoke.mjs

import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  COMMAND_TIMEOUT_MS,
  validateCommandRequest,
  createExternalMediaSmtcBridge,
} = require('../../electron/externalMediaSmtcBridge.cjs');

let failures = 0;
let checks = 0;

function check(label, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
}

function equal(label, actual, expected) {
  check(label, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}`);
}

// A stdout that is a real EventEmitter, so the line splitter is exercised the same way the child
// process would drive it.
function createFakeChild() {
  const stdout = new EventEmitter();
  stdout.setEncoding = () => {};
  const stderr = new EventEmitter();
  stderr.setEncoding = () => {};
  const written = [];
  const child = new EventEmitter();
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = {
    written,
    write: (chunk) => written.push(chunk),
  };
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

// Manual timers, so the timeout path is steppable without waiting.
function createTimerHarness() {
  const pending = new Map();
  let nextId = 0;
  return {
    setTimeoutFn: (handler, ms) => {
      const id = ++nextId;
      pending.set(id, { handler, ms: ms ?? 0 });
      return id;
    },
    clearTimeoutFn: (handle) => {
      pending.delete(handle);
    },
    runTimer: (ms) => {
      for (const [id, entry] of pending) {
        if (entry.ms === ms) {
          pending.delete(id);
          entry.handler();
          return true;
        }
      }
      return false;
    },
    countWithDelay: (ms) => [...pending.values()].filter((entry) => entry.ms === ms).length,
  };
}

function responseLine(overrides = {}) {
  return JSON.stringify({
    event: 'response',
    id: 'c1',
    command: 'play',
    ok: true,
    targetAppUserModelId: 'Chrome',
    error: null,
    errorKind: null,
    completedAtMs: 1789471213330,
    ...overrides,
  });
}

function createHarness() {
  const timers = createTimerHarness();
  let child = null;
  const bridge = createExternalMediaSmtcBridge({
    spawnFn: () => {
      child = createFakeChild();
      return child;
    },
    helperPath: () => 'C:/fake/folia-apple-music-smtc-helper.exe',
    now: () => 1_000_000,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    logWarn: () => {},
    logError: () => {},
  });
  return { bridge, timers, getChild: () => child };
}

// Answers the most recent request line, echoing its id the way the helper does.
function answerLast(getChild, overrides = {}) {
  const child = getChild();
  const request = JSON.parse(child.stdin.written[child.stdin.written.length - 1]);
  child.stdout.emit('data', `${responseLine({ id: request.id, command: request.command, ...overrides })}\n`);
  return request;
}

async function main() {
  console.log('validateCommandRequest');
  equal('accepts play', validateCommandRequest({ command: 'play' }), { request: { command: 'play' } });
  equal('accepts seek with a position', validateCommandRequest({ command: 'seek', positionMs: 0 }), {
    request: { command: 'seek', positionMs: 0 },
  });
  check('refuses an unknown command', Boolean(validateCommandRequest({ command: 'stop' }).error));
  check('refuses a naked string', validateCommandRequest('play').error === 'request must be an object');
  check('refuses a negative seek', Boolean(validateCommandRequest({ command: 'seek', positionMs: -1 }).error));
  check('refuses a fractional seek', Boolean(validateCommandRequest({ command: 'seek', positionMs: 1.5 }).error));
  check(
    'refuses a position on a non-seek command',
    Boolean(validateCommandRequest({ command: 'next', positionMs: 1 }).error),
  );

  console.log('\nsendCommand: success path');
  {
    const { bridge, getChild } = createHarness();
    bridge.start();
    const pending = bridge.sendCommand({ command: 'play' });
    const child = getChild();
    check('wrote exactly one line', child.stdin.written.length === 1);
    const request = JSON.parse(child.stdin.written[0]);
    check('request carries an id and the command', typeof request.id === 'string' && request.command === 'play');
    child.stdout.emit('data', `${responseLine({ id: request.id })}\n`);
    equal('reply is the helper response', await pending, {
      ok: true,
      command: 'play',
      targetAppUserModelId: 'Chrome',
      error: null,
      errorKind: null,
      completedAtMs: 1789471213330,
    });
    equal('status keeps the last command', bridge.getStatus().lastCommand?.ok, true);
  }

  console.log('\nsendCommand: id correlation is not stream order');
  {
    const { bridge, getChild } = createHarness();
    bridge.start();
    const first = bridge.sendCommand({ command: 'play' });
    const second = bridge.sendCommand({ command: 'next' });
    const child = getChild();
    const [firstRequest, secondRequest] = child.stdin.written.map((line) => JSON.parse(line));
    child.stdout.emit('data', `${responseLine({ id: secondRequest.id, command: 'next' })}\n`);
    child.stdout.emit('data', `${responseLine({ id: firstRequest.id, command: 'play' })}\n`);
    equal('second resolves as next', (await second).command, 'next');
    equal('first resolves as play', (await first).command, 'play');
  }

  console.log('\nsendCommand: failure kinds');
  {
    const { bridge, getChild } = createHarness();
    bridge.start();
    const declined = bridge.sendCommand({ command: 'pause' });
    answerLast(getChild, { ok: false, errorKind: 'controller-declined', targetAppUserModelId: null });
    const declinedReply = await declined;
    equal('a declined call is not ok', declinedReply.ok, false);
    equal('a declined call keeps its kind', declinedReply.errorKind, 'controller-declined');
  }
  {
    const { bridge } = createHarness();
    const reply = await bridge.sendCommand({ command: 'play' });
    equal('a stopped helper is helper-unavailable', reply.errorKind, 'helper-unavailable');
  }
  {
    const { bridge, timers } = createHarness();
    bridge.start();
    const pending = bridge.sendCommand({ command: 'play' });
    check('a timeout timer was armed', timers.countWithDelay(COMMAND_TIMEOUT_MS) === 1);
    timers.runTimer(COMMAND_TIMEOUT_MS);
    equal('a timeout is reported', (await pending).errorKind, 'timeout');
  }
  {
    const { bridge, getChild } = createHarness();
    bridge.start();
    const pending = bridge.sendCommand({ command: 'next' });
    getChild().emit('exit', 1, null);
    equal('an exited helper fails the command', (await pending).errorKind, 'helper-exited');
  }
  {
    const { bridge, getChild } = createHarness();
    bridge.start();
    getChild().stdin.write = () => {
      throw new Error('EPIPE');
    };
    equal('a write failure is reported', (await bridge.sendCommand({ command: 'play' })).errorKind, 'helper-unavailable');
  }
  {
    const { bridge, getChild } = createHarness();
    bridge.start();
    const pending = bridge.sendCommand({ command: 'stop' });
    equal('an invalid request never reaches stdin', getChild().stdin.written.length, 0);
    equal('an invalid request is invalid-argument', (await pending).errorKind, 'invalid-argument');
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
