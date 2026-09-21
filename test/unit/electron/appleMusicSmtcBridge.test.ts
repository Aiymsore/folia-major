import { EventEmitter } from 'events';
import { createRequire } from 'module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/electron/appleMusicSmtcBridge.test.ts
// Locks down the Apple Music SMTC bridge: JSONL parsing, the status/payload mapping, the
// "no session is not a failure" rule, the silence watchdog, respawn-on-exit, and (Phase 2) the
// outbound command channel — id correlation, timeouts, and refusing to queue a command for a helper
// that is not running. Every side effect is injected, so none of this needs a Windows host or a real
// helper binary.

const require = createRequire(import.meta.url);
const {
  HELPER_HEARTBEAT_TIMEOUT_MS,
  COMMAND_TIMEOUT_MS,
  parseHelperEventLine,
  validateCommandRequest,
  emptyAppleMusicSmtcStatus,
  createAppleMusicSmtcBridge,
} = require('../../../electron/appleMusicSmtcBridge.cjs') as {
  HELPER_HEARTBEAT_TIMEOUT_MS: number;
  COMMAND_TIMEOUT_MS: number;
  parseHelperEventLine: (line: unknown) => BridgeEvent | null;
  validateCommandRequest: (raw: unknown) => { request?: CommandRequest; error?: string };
  emptyAppleMusicSmtcStatus: () => BridgeStatus;
  createAppleMusicSmtcBridge: (options: BridgeOptions) => Bridge;
};

interface BridgeEvent {
  event: string;
  [key: string]: unknown;
}

interface CommandRequest {
  command: string;
  positionMs?: number;
}

interface CommandResult {
  ok: boolean;
  command: string;
  targetAppUserModelId: string | null;
  error: string | null;
  errorKind: string | null;
  completedAtMs: number | null;
}

interface BridgeStatus {
  bridgeAvailable: boolean;
  helperState: string;
  connected: boolean;
  sourceAppUserModelId: string | null;
  title: string | null;
  artist: string | null;
  album: string | null;
  playbackStatus: string | null;
  positionMs: number | null;
  durationMs: number | null;
  hasThumbnail: boolean;
  updatedAt: number | null;
  lastEventAt: number | null;
  sessionCount: number | null;
  lastCommand: CommandResult | null;
  lastError: { message: string; kind: string | null } | null;
  isStale?: boolean;
  snapshotStaleMs?: number;
}

interface FakeChild extends EventEmitter {
  stdout: EventEmitter & { setEncoding: (encoding: string) => void };
  stderr: EventEmitter & { setEncoding: (encoding: string) => void };
  stdin: { write: (chunk: string) => void; written: string[]; failNextWrite?: boolean };
  killed: boolean;
  kill: () => void;
}

interface BridgeOptions {
  spawnFn?: () => FakeChild;
  logWarn?: (...args: unknown[]) => void;
  logError?: (...args: unknown[]) => void;
  setTimeoutFn?: (handler: () => void, ms?: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  now?: () => number;
  helperPath?: string | (() => string | null);
  heartbeatTimeoutMs?: number;
  respawnDelayMs?: number;
  stopGraceMs?: number;
  commandTimeoutMs?: number;
  onStatusChanged?: (status: BridgeStatus) => void;
}

interface Bridge {
  start: () => string;
  dispose: () => void;
  killHelper: () => void;
  sendCommand: (request: unknown, options?: { timeoutMs?: number }) => Promise<CommandResult>;
  handleHelperEvent: (event: BridgeEvent) => void;
  consumeStdout: (chunk: string) => void;
  getStatus: () => BridgeStatus;
}

// A stdout that is a real EventEmitter, so the line splitter is exercised through the same path
// the child process would use.
function createFakeChild(): FakeChild {
  const stdout = new EventEmitter() as FakeChild['stdout'];
  stdout.setEncoding = () => {};
  const stderr = new EventEmitter() as FakeChild['stderr'];
  stderr.setEncoding = () => {};
  const written: string[] = [];
  const child = new EventEmitter() as FakeChild;
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = {
    written,
    write: (chunk: string) => {
      written.push(chunk);
    },
  };
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

// A `response` event exactly as the helper serializes it (see events.rs CommandReply::to_json).
function responseLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event: 'response',
    id: 'c1',
    command: 'play',
    ok: true,
    targetAppUserModelId: 'AppleInc.AppleMusicWin_nzyj5cx40ttqa!App',
    error: null,
    errorKind: null,
    completedAtMs: 1789471213330,
    ...overrides,
  });
}

// Reads the id out of the one request line the bridge wrote, then answers it.
function answerLastCommand(child: FakeChild, overrides: Record<string, unknown> = {}) {
  const line = child.stdin.written[child.stdin.written.length - 1];
  const request = JSON.parse(line) as { id: string; command: string };
  child.stdout.emit('data', `${responseLine({ id: request.id, command: request.command, ...overrides })}\n`);
}

// Manual timers: the watchdog and respawn paths must be steppable without real waiting.
function createTimerHarness() {
  const pending = new Map<number, { handler: () => void; ms: number }>();
  let nextId = 0;
  return {
    pending,
    setTimeoutFn: (handler: () => void, ms?: number) => {
      const id = ++nextId;
      pending.set(id, { handler, ms: ms ?? 0 });
      return id;
    },
    clearTimeoutFn: (handle: unknown) => {
      pending.delete(handle as number);
    },
    // Runs the first pending timer whose delay matches, so tests can target watchdog vs respawn.
    runTimer: (ms: number) => {
      for (const [id, entry] of pending) {
        if (entry.ms === ms) {
          pending.delete(id);
          entry.handler();
          return true;
        }
      }
      return false;
    },
    countWithDelay: (ms: number) => [...pending.values()].filter((entry) => entry.ms === ms).length,
  };
}

function snapshotLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event: 'snapshot',
    sourceAppUserModelId: 'AppleInc.AppleMusicWin_nzyj5cx40ttqa!App',
    title: 'MaringCode',
    artist: '神楽 めあ',
    album: null,
    playbackStatus: 'Playing',
    positionMs: 13000,
    durationMs: 218000,
    hasThumbnail: true,
    updatedAtMs: 1789471213330,
    ...overrides,
  });
}

describe('parseHelperEventLine', () => {
  it('parses a JSONL event and rejects everything else', () => {
    expect(parseHelperEventLine('{"event":"heartbeat"}')).toEqual({ event: 'heartbeat' });
    expect(parseHelperEventLine('')).toBeNull();
    expect(parseHelperEventLine('   ')).toBeNull();
    expect(parseHelperEventLine('not json')).toBeNull();
    expect(parseHelperEventLine('{"noEvent":1}')).toBeNull();
    expect(parseHelperEventLine('{"event":123}')).toBeNull();
  });
});

describe('emptyAppleMusicSmtcStatus', () => {
  it('describes an unavailable bridge without claiming a disconnected session', () => {
    const status = emptyAppleMusicSmtcStatus();
    expect(status.bridgeAvailable).toBe(false);
    expect(status.helperState).toBe('stopped');
    expect(status.connected).toBe(false);
    expect(status.title).toBeNull();
  });
});

describe('createAppleMusicSmtcBridge', () => {
  let timers: ReturnType<typeof createTimerHarness>;
  let child: FakeChild;
  let now: number;

  function createBridge(overrides: Partial<BridgeOptions> = {}) {
    return createAppleMusicSmtcBridge({
      spawnFn: () => {
        child = createFakeChild();
        return child;
      },
      helperPath: () => 'C:/fake/folia-apple-music-smtc-helper.exe',
      now: () => now,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      logWarn: () => {},
      logError: () => {},
      ...overrides,
    });
  }

  beforeEach(() => {
    timers = createTimerHarness();
    now = 1_000_000;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('spawns the helper in watch mode and reports starting', () => {
    const bridge = createBridge();
    expect(bridge.start()).toBe('starting');
    expect(bridge.getStatus().helperState).toBe('starting');
  });

  it('does not spawn twice while a child is alive', () => {
    let spawns = 0;
    const bridge = createBridge({
      spawnFn: () => {
        spawns += 1;
        child = createFakeChild();
        return child;
      },
    });
    bridge.start();
    bridge.start();
    expect(spawns).toBe(1);
  });

  it('reports missing rather than spawning when the binary is absent', () => {
    const bridge = createBridge({ helperPath: () => null });
    expect(bridge.start()).toBe('missing');
    const status = bridge.getStatus();
    expect(status.helperState).toBe('missing');
    expect(status.bridgeAvailable).toBe(false);
    expect(status.lastError?.kind).toBe('helper-missing');
  });

  it('maps a snapshot event onto the documented status fields', () => {
    const bridge = createBridge();
    bridge.start();
    bridge.handleHelperEvent(parseHelperEventLine(snapshotLine())!);

    const status = bridge.getStatus();
    expect(status.helperState).toBe('running');
    expect(status.connected).toBe(true);
    expect(status.sourceAppUserModelId).toBe('AppleInc.AppleMusicWin_nzyj5cx40ttqa!App');
    expect(status.title).toBe('MaringCode');
    expect(status.artist).toBe('神楽 めあ');
    expect(status.playbackStatus).toBe('Playing');
    expect(status.positionMs).toBe(13000);
    expect(status.durationMs).toBe(218000);
    expect(status.hasThumbnail).toBe(true);
    expect(status.updatedAt).toBe(1789471213330);
  });

  it('treats a missing position as null rather than zero', () => {
    const bridge = createBridge();
    bridge.start();
    bridge.handleHelperEvent(parseHelperEventLine(snapshotLine({ positionMs: null, durationMs: null }))!);
    const status = bridge.getStatus();
    expect(status.positionMs).toBeNull();
    expect(status.durationMs).toBeNull();
  });

  it('keeps the helper running and clears the payload on no-session', () => {
    // The regression this guards: treating "Apple Music is closed" as a helper failure would
    // respawn the process forever while the user simply has the app shut.
    const bridge = createBridge();
    bridge.start();
    bridge.handleHelperEvent(parseHelperEventLine(snapshotLine())!);
    bridge.handleHelperEvent({ event: 'no-session' });

    const status = bridge.getStatus();
    expect(status.helperState).toBe('running');
    expect(status.connected).toBe(false);
    expect(status.title).toBeNull();
    expect(status.sourceAppUserModelId).toBeNull();
  });

  it('records ready session count without claiming a connected session', () => {
    const bridge = createBridge();
    bridge.start();
    bridge.handleHelperEvent({ event: 'ready', sessionCount: 2 });
    const status = bridge.getStatus();
    expect(status.sessionCount).toBe(2);
    expect(status.connected).toBe(false);
    expect(status.helperState).toBe('running');
  });

  it('surfaces an error event without dropping the session payload rules', () => {
    const bridge = createBridge();
    bridge.start();
    bridge.handleHelperEvent({ event: 'error', message: 'manager request failed', kind: 'manager-unavailable' });
    expect(bridge.getStatus().lastError).toEqual({
      message: 'manager request failed',
      kind: 'manager-unavailable',
    });
  });

  it('reassembles events split across stdout chunks', () => {
    const bridge = createBridge();
    bridge.start();
    const line = snapshotLine();
    const cut = Math.floor(line.length / 2);
    child.stdout.emit('data', line.slice(0, cut));
    expect(bridge.getStatus().connected).toBe(false);
    child.stdout.emit('data', `${line.slice(cut)}\n`);
    expect(bridge.getStatus().title).toBe('MaringCode');
  });

  it('handles several events arriving in one chunk', () => {
    const bridge = createBridge();
    bridge.start();
    child.stdout.emit('data', `{"event":"heartbeat"}\n${snapshotLine()}\n{"event":"heartbeat"}\n`);
    expect(bridge.getStatus().connected).toBe(true);
    expect(bridge.getStatus().title).toBe('MaringCode');
  });

  it('ignores a partial trailing line instead of parsing it', () => {
    const bridge = createBridge();
    bridge.start();
    child.stdout.emit('data', '{"event":"snap');
    expect(bridge.getStatus().connected).toBe(false);
  });

  it('restarts the helper when it goes silent past the heartbeat window', () => {
    const bridge = createBridge();
    bridge.start();
    expect(timers.countWithDelay(HELPER_HEARTBEAT_TIMEOUT_MS)).toBe(1);

    timers.runTimer(HELPER_HEARTBEAT_TIMEOUT_MS);
    expect(child.killed).toBe(false); // kill is deferred by the stop grace timer
    expect(bridge.getStatus().helperState).toBe('stopped'); // the gap is reported honestly
    expect(timers.countWithDelay(2000)).toBe(1); // respawn scheduled
  });

  it('respawns after an unexpected exit but not after disposal', () => {
    const bridge = createBridge();
    bridge.start();
    child.emit('exit', 1, null);
    expect(bridge.getStatus().helperState).toBe('stopped');
    expect(timers.countWithDelay(2000)).toBe(1);

    bridge.dispose();
    expect(timers.countWithDelay(2000)).toBe(0);
  });

  it('does not respawn for a superseded child exit', () => {
    const bridge = createBridge();
    bridge.start();
    const first = child;
    // Kill the first child; its exit event arrives after a new generation has started.
    bridge.killHelper();
    bridge.start();
    first.emit('exit', 1, null);
    // Only the respawn timer scheduled by killHelper's own path may exist, never a second one.
    expect(timers.countWithDelay(2000)).toBeLessThanOrEqual(1);
    expect(bridge.getStatus().helperState).toBe('starting');
  });

  it('marks a stale status when nothing has been heard for a whole heartbeat window', () => {
    const bridge = createBridge();
    bridge.start();
    bridge.handleHelperEvent({ event: 'heartbeat' });
    expect(bridge.getStatus().isStale).toBe(false);

    now += HELPER_HEARTBEAT_TIMEOUT_MS + 1;
    expect(bridge.getStatus().isStale).toBe(true);
  });

  it('writes stop to stdin when shutting the helper down', () => {
    const bridge = createBridge();
    bridge.start();
    bridge.killHelper();
    expect(child.stdin.written).toContain('stop\n');
  });

  it('sends nothing but stop and command requests to the helper', () => {
    // Replaces the Phase 1 assertion that stdin could ONLY ever carry `stop`. Phase 2 adds one more
    // legal line shape and nothing else: `stop`, or a single-line JSON object with an id and a
    // command. A bare word or a multi-line payload would be a protocol break.
    const bridge = createBridge();
    bridge.start();
    void bridge.sendCommand({ command: 'next' });
    bridge.killHelper();

    for (const line of child.stdin.written) {
      const trimmed = line.trim();
      if (trimmed === 'stop') continue;
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      expect(typeof parsed.id).toBe('string');
      expect(typeof parsed.command).toBe('string');
      expect(Object.keys(parsed).every((key) => key === 'id' || key === 'command' || key === 'positionMs')).toBe(true);
    }
  });
});

describe('validateCommandRequest', () => {
  it('accepts every transport command and normalizes it', () => {
    expect(validateCommandRequest({ command: 'play' })).toEqual({ request: { command: 'play' } });
    expect(validateCommandRequest({ command: 'pause' })).toEqual({ request: { command: 'pause' } });
    expect(validateCommandRequest({ command: 'toggle-play-pause' })).toEqual({
      request: { command: 'toggle-play-pause' },
    });
    expect(validateCommandRequest({ command: 'previous' })).toEqual({ request: { command: 'previous' } });
    expect(validateCommandRequest({ command: 'next' })).toEqual({ request: { command: 'next' } });
    expect(validateCommandRequest({ command: 'seek', positionMs: 42_000 })).toEqual({
      request: { command: 'seek', positionMs: 42_000 },
    });
  });

  it('refuses anything that is not a known command', () => {
    // The allow-list is the security boundary: an unknown name must never reach the helper's stdin.
    expect(validateCommandRequest({ command: 'stop' }).error).toContain('unsupported command');
    expect(validateCommandRequest({ command: 'quit' }).error).toContain('unsupported command');
    expect(validateCommandRequest({ command: 'play; rm -rf' }).error).toContain('unsupported command');
    expect(validateCommandRequest({}).error).toContain('unsupported command');
    expect(validateCommandRequest(null).error).toBe('request must be an object');
    expect(validateCommandRequest('play').error).toBe('request must be an object');
    expect(validateCommandRequest(['play']).error).toBe('request must be an object');
  });

  it('requires a valid position for seek and rejects it everywhere else', () => {
    expect(validateCommandRequest({ command: 'seek' }).error).toContain('requires an integer positionMs');
    expect(validateCommandRequest({ command: 'seek', positionMs: -1 }).error).toContain('between 0');
    expect(validateCommandRequest({ command: 'seek', positionMs: 3_600_001 }).error).toContain('between 0');
    expect(validateCommandRequest({ command: 'seek', positionMs: 1.5 }).error).toContain('must be an integer');
    expect(validateCommandRequest({ command: 'seek', positionMs: '1000' }).error).toContain('must be an integer');
    expect(validateCommandRequest({ command: 'next', positionMs: 1000 }).error).toContain('does not apply');
    // Zero is a real seek to the start of the track, not a missing value.
    expect(validateCommandRequest({ command: 'seek', positionMs: 0 })).toEqual({
      request: { command: 'seek', positionMs: 0 },
    });
  });
});

describe('sendCommand', () => {
  let timers: ReturnType<typeof createTimerHarness>;
  // Undefined on purpose: "no child" is exactly the state one of these tests asserts, so the
  // variable has to be able to hold it (see the reset in beforeEach below).
  let child: FakeChild | undefined;
  let now: number;

  function createBridge(overrides: Partial<BridgeOptions> = {}) {
    return createAppleMusicSmtcBridge({
      spawnFn: () => {
        child = createFakeChild();
        return child;
      },
      helperPath: () => 'C:/fake/folia-apple-music-smtc-helper.exe',
      now: () => now,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      logWarn: () => {},
      logError: () => {},
      ...overrides,
    });
  }

  beforeEach(() => {
    timers = createTimerHarness();
    now = 1_000_000;
    // Reset the module-level fake explicitly. `createBridge` only assigns it inside `spawnFn`, which
    // never runs for a bridge that was not started — so without this reset, a test asserting "no
    // child exists" reads the PREVIOUS test's fake and fails on a bridge that behaved correctly.
    child = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes one JSON request line and resolves with the matching response', async () => {
    const bridge = createBridge();
    bridge.start();

    const pendingResult = bridge.sendCommand({ command: 'play' });
    expect(child!.stdin.written).toHaveLength(1);
    const request = JSON.parse(child!.stdin.written[0]) as Record<string, unknown>;
    expect(request.command).toBe('play');
    expect(typeof request.id).toBe('string');

    child!.stdout.emit('data', `${responseLine({ id: request.id })}\n`);
    await expect(pendingResult).resolves.toEqual({
      ok: true,
      command: 'play',
      targetAppUserModelId: 'AppleInc.AppleMusicWin_nzyj5cx40ttqa!App',
      error: null,
      errorKind: null,
      completedAtMs: 1789471213330,
    });
  });

  it('carries the seek position into the request line', async () => {
    const bridge = createBridge();
    bridge.start();
    const pendingResult = bridge.sendCommand({ command: 'seek', positionMs: 42_000 });
    const request = JSON.parse(child!.stdin.written[0]) as Record<string, unknown>;
    expect(request.command).toBe('seek');
    expect(request.positionMs).toBe(42_000);
    answerLastCommand(child!, { id: request.id, command: 'seek' });
    await pendingResult;
  });

  it('matches responses by id when a later command answers first', async () => {
    // The response stream is asynchronous, so order is not identity. This is the regression the id
    // exists for: without it, `next`'s reply would have resolved the `play` promise.
    const bridge = createBridge();
    bridge.start();

    const first = bridge.sendCommand({ command: 'play' });
    const second = bridge.sendCommand({ command: 'next' });
    const [firstRequest, secondRequest] = child!.stdin.written.map(
      (line) => JSON.parse(line) as { id: string },
    );

    child!.stdout.emit('data', `${responseLine({ id: secondRequest.id, command: 'next' })}\n`);
    child!.stdout.emit('data', `${responseLine({ id: firstRequest.id, command: 'play' })}\n`);

    await expect(second).resolves.toMatchObject({ ok: true, command: 'next' });
    await expect(first).resolves.toMatchObject({ ok: true, command: 'play' });
  });

  it('resolves a declined command as a structured failure, not a rejection', async () => {
    const bridge = createBridge();
    bridge.start();
    const pendingResult = bridge.sendCommand({ command: 'pause' });
    answerLastCommand(child!, {
      ok: false,
      command: 'pause',
      error: 'the session refused the command',
      errorKind: 'controller-declined',
      targetAppUserModelId: null,
    });

    await expect(pendingResult).resolves.toMatchObject({
      ok: false,
      errorKind: 'controller-declined',
      targetAppUserModelId: null,
    });
  });

  it('reports why a command never reached Windows', async () => {
    const bridge = createBridge();
    bridge.start();
    const result = await bridge.sendCommand({ command: 'stop' });
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('invalid-argument');
    // Nothing was written for a refused request.
    expect(child!.stdin.written).toHaveLength(0);
  });

  it('refuses to queue a command while the helper is not running', async () => {
    // Replaying a transport command after a respawn would act on a session state the user has since
    // changed, so the request fails immediately instead of waiting for the new child.
    const bridge = createBridge();
    const result = await bridge.sendCommand({ command: 'play' });
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('helper-unavailable');
    // Never started, so nothing was spawned: the fake is undefined because no spawnFn call happened,
    // not because the assertion was loosened. See the reset in beforeEach.
    expect(child).toBeUndefined();
  });

  it('times out a command the helper never answers', async () => {
    const bridge = createBridge();
    bridge.start();
    const pendingResult = bridge.sendCommand({ command: 'play' });
    expect(timers.countWithDelay(COMMAND_TIMEOUT_MS)).toBe(1);

    timers.runTimer(COMMAND_TIMEOUT_MS);
    await expect(pendingResult).resolves.toMatchObject({ ok: false, errorKind: 'timeout' });
  });

  it('ignores a response that arrives after its timeout', async () => {
    const bridge = createBridge();
    bridge.start();
    const pendingResult = bridge.sendCommand({ command: 'play' });
    const request = JSON.parse(child!.stdin.written[0]) as { id: string };

    timers.runTimer(COMMAND_TIMEOUT_MS);
    await pendingResult;

    // A late reply for a timed-out id must not throw or resurrect the promise.
    expect(() => child!.stdout.emit('data', `${responseLine({ id: request.id })}\n`)).not.toThrow();
  });

  it('fails pending commands when the helper exits', async () => {
    const bridge = createBridge();
    bridge.start();
    const pendingResult = bridge.sendCommand({ command: 'next' });

    child!.emit('exit', 1, null);
    await expect(pendingResult).resolves.toMatchObject({ ok: false, errorKind: 'helper-exited' });
  });

  it('fails pending commands when the helper is stopped', async () => {
    const bridge = createBridge();
    bridge.start();
    const pendingResult = bridge.sendCommand({ command: 'next' });

    bridge.killHelper();
    await expect(pendingResult).resolves.toMatchObject({ ok: false, errorKind: 'helper-exited' });
  });

  it('surfaces a write failure instead of leaving the promise pending', async () => {
    const bridge = createBridge();
    bridge.start();
    child!.stdin.write = () => {
      throw new Error('EPIPE');
    };

    await expect(bridge.sendCommand({ command: 'play' })).resolves.toMatchObject({
      ok: false,
      errorKind: 'helper-unavailable',
    });
  });

  it('records the last command on the status for the diagnostic surface', async () => {
    const bridge = createBridge();
    bridge.start();
    const pendingResult = bridge.sendCommand({ command: 'toggle-play-pause' });
    answerLastCommand(child!, { command: 'toggle-play-pause' });
    await pendingResult;

    expect(bridge.getStatus().lastCommand).toMatchObject({ ok: true, command: 'toggle-play-pause' });
  });

  it('does not clear the read-only session payload on a command response', async () => {
    // The response is not a state change: a transport command must not blank the snapshot the panel
    // is displaying.
    const bridge = createBridge();
    bridge.start();
    bridge.handleHelperEvent(parseHelperEventLine(snapshotLine())!);

    const pendingResult = bridge.sendCommand({ command: 'play' });
    answerLastCommand(child!);
    await pendingResult;

    // `consumeStdout` is the path the fake child's stdout feeds, so drive the same event through it.
    const status = bridge.getStatus();
    expect(status.connected).toBe(true);
    expect(status.title).toBe('MaringCode');
  });

  it('fails pending commands on disposal', async () => {
    const bridge = createBridge();
    bridge.start();
    const pendingResult = bridge.sendCommand({ command: 'play' });

    bridge.dispose();
    await expect(pendingResult).resolves.toMatchObject({ ok: false, errorKind: 'helper-exited' });
  });
});
