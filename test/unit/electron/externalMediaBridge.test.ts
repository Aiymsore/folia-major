import { EventEmitter } from 'events';
import { createRequire } from 'module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/electron/externalMediaBridge.test.ts
// Locks down the external media bridge: the five-verb command allow-list, the loopback HTTP + WS auth
// rules, the single-extension session, observation validation and staleness, and the "sendCommand
// never rejects" contract (including failing pending commands the moment the extension socket
// closes). Every side effect — server factory, WebSocket server factory, timers, clock, loggers — is
// injected, so none of this needs a real port, a real Chrome, or a real music.apple.com tab.
//
// The one exception is the last describe block: a real loopback server on an ephemeral port. It is
// reliable in CI because it binds 127.0.0.1:0 and asserts against Node's own fetch/WebSocket client
// rather than anything external.

const require = createRequire(import.meta.url);
const { WebSocket: WsClient } = require('ws') as {
  WebSocket: new (url: string) => WsClientLike;
};

const {
  DEFAULT_EXTERNAL_MEDIA_PORT,
  PROTOCOL_VERSION,
  validateMediaCommand,
  createExternalMediaBridge,
} = require('../../../electron/externalMediaBridge.cjs') as {
  DEFAULT_EXTERNAL_MEDIA_PORT: number;
  PROTOCOL_VERSION: number;
  validateMediaCommand: (raw: unknown) => { command?: MediaCommand; error?: string };
  createExternalMediaBridge: (options: BridgeOptions) => Bridge;
};

const TOKEN = 'test-token-abcdefghijklmnop';

interface MediaCommand {
  kind: string;
  positionMs?: number;
  mediaId?: string;
}

interface CommandResult {
  ok: boolean;
  command: string;
  targetSourceId: string | null;
  error: string | null;
  errorKind: string | null;
  completedAtMs: number | null;
}

interface Observation {
  connected: boolean;
  identity: { title: string; artist: string; album: string | null; durationMs: number | null } | null;
  playbackStatus: string | null;
  positionMs: number | null;
  positionEstablishedAtMs: number | null;
  observedAtMs: number;
}

interface BridgeStatus {
  available: boolean;
  port: number;
  extensionConnected: boolean;
  extensionVersion: string | null;
  capabilities: string[];
  lastObservation: Observation | null;
  lastObservationAtMs: number | null;
  isObservationStale: boolean;
  lastError: { message: string; kind: string | null } | null;
}

interface Bridge {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  getPort: () => number;
  getStatus: () => BridgeStatus;
  sendCommand: (command: unknown) => Promise<CommandResult>;
  getObservation: () => Observation | null;
  onObservation: (listener: (observation: Observation) => void) => () => void;
  onStatusChanged: (listener: (status: BridgeStatus) => void) => () => void;
}

// The WebSocket surface the bridge actually uses, plus the test-only bookkeeping.
interface FakeSocket extends EventEmitter {
  readyState: number;
  written: string[];
  rawWrites: string[];
  closedWith: { code: number; reason: string } | null;
  destroyed: boolean;
  terminated: boolean;
  send: (data: string) => void;
  write: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  destroy: () => void;
  terminate: () => void;
}

interface FakeUpgradeRequest {
  url: string;
  headers: Record<string, string>;
}

interface FakeResponse extends EventEmitter {
  statusCode: number | null;
  headers: Record<string, string> | null;
  body: string | null;
  writeHead: (statusCode: number, headers: Record<string, string>) => void;
  end: (body: string) => void;
}

interface FakeServer extends EventEmitter {
  listenCalls: { port: number; host: string }[];
  closed: boolean;
  listening: boolean;
  failListen: Error | null;
  // What `address()` reports once listening. Defaults to the port that was asked for; a test can
  // override it to prove the actually-bound port wins over the configured one (which is how a real
  // `port: 0` behaves).
  addressPort: number | null;
  address: () => { port: number } | null;
  listen: (port: number, host: string, callback: () => void) => void;
  close: (callback?: () => void) => void;
}

interface FakeWebSocketServer {
  upgrades: number;
  closed: boolean;
  handleUpgrade: (
    req: FakeUpgradeRequest,
    socket: FakeSocket,
    head: unknown,
    callback: (socket: FakeSocket) => void,
  ) => void;
  close: () => void;
}

interface BridgeOptions {
  port?: number;
  token?: string;
  logInfo?: (...args: unknown[]) => void;
  logWarn?: (...args: unknown[]) => void;
  now?: () => number;
  createServer?: (handler: (req: unknown, res: FakeResponse) => void) => FakeServer;
  webSocketServerFactory?: () => FakeWebSocketServer;
  commandTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  staleObservationMs?: number;
  setTimeoutFn?: (handler: () => void, ms?: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

interface WsClientLike extends EventEmitter {
  readyState: number;
  send: (data: string) => void;
  close: () => void;
}

// Manual timers: command timeouts, heartbeats and the close grace period must all be steppable
// without real waiting, and distinguishable by their delay.
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
    // Runs the first pending timer whose delay matches, so a test can target a command timeout
    // without also firing the heartbeat.
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

function createFakeSocket(): FakeSocket {
  const socket = new EventEmitter() as FakeSocket;
  socket.readyState = 1;
  socket.written = [];
  socket.rawWrites = [];
  socket.closedWith = null;
  socket.destroyed = false;
  socket.terminated = false;
  socket.send = (data: string) => {
    socket.written.push(data);
  };
  // The raw HTTP rejection the bridge writes before destroying a socket that failed the upgrade
  // checks. Kept separate from `written` so a frame assertion is never confused by it.
  socket.write = (data: string) => {
    socket.rawWrites.push(data);
  };
  socket.close = (code = 1000, reason = '') => {
    socket.closedWith = { code, reason };
    socket.readyState = 3;
  };
  socket.destroy = () => {
    socket.destroyed = true;
    socket.readyState = 3;
  };
  socket.terminate = () => {
    socket.terminated = true;
  };
  return socket;
}

function createFakeServer(handler: (req: unknown, res: FakeResponse) => void): FakeServer {
  const server = new EventEmitter() as FakeServer;
  server.listenCalls = [];
  server.closed = false;
  server.listening = false;
  server.failListen = null;
  server.addressPort = null;
  server.address = () => (server.listening ? { port: server.addressPort ?? 0 } : null);
  server.listen = (port: number, host: string, callback: () => void) => {
    server.listenCalls.push({ port, host });
    if (server.failListen) {
      // Emitted synchronously, exactly like a real EADDRINUSE from net.Server#listen.
      server.emit('error', server.failListen);
      return;
    }
    server.listening = true;
    if (server.addressPort === null) {
      server.addressPort = port;
    }
    callback();
  };
  server.close = (callback?: () => void) => {
    server.closed = true;
    server.listening = false;
    callback?.();
  };
  // The HTTP handler is invoked through the same function the bridge handed to createServer.
  server.on('request', handler);
  return server;
}

function createFakeWebSocketServer(): FakeWebSocketServer {
  const wss: FakeWebSocketServer = {
    upgrades: 0,
    closed: false,
    handleUpgrade: (_req, socket, _head, callback) => {
      wss.upgrades += 1;
      callback(socket);
    },
    close: () => {
      wss.closed = true;
    },
  };
  return wss;
}

function createFakeResponse(): FakeResponse {
  const res = new EventEmitter() as FakeResponse;
  res.statusCode = null;
  res.headers = null;
  res.body = null;
  res.writeHead = (statusCode: number, headers: Record<string, string>) => {
    res.statusCode = statusCode;
    res.headers = headers;
  };
  res.end = (body: string) => {
    res.body = body;
  };
  return res;
}

function upgradeRequest(overrides: Partial<FakeUpgradeRequest> = {}): FakeUpgradeRequest {
  return {
    url: `/external-media/ws?token=${TOKEN}`,
    headers: {},
    ...overrides,
  };
}

function httpRequest(url: string, headers: Record<string, string> = {}) {
  return { method: 'GET', url, headers };
}

function stateFrame(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'state',
    observation: {
      connected: true,
      identity: { title: 'MaringCode', artist: '神楽 めあ', album: null, durationMs: 218_000 },
      playbackStatus: 'Playing',
      positionMs: 13_000,
      positionEstablishedAtMs: 1_000_000,
      observedAtMs: 1_000_000,
      ...overrides,
    },
  });
}

function helloFrame(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'hello',
    extensionVersion: '0.1.0',
    sourceId: 'apple-music-web',
    capabilities: ['observe', 'play', 'pause', 'toggle', 'seek', 'playById'],
    ...overrides,
  });
}

function responseFrame(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'response',
    id: 'm1',
    ok: true,
    errorKind: null,
    error: null,
    targetSourceId: 'apple-music-web',
    ...overrides,
  });
}

describe('validateMediaCommand', () => {
  it('accepts exactly the five transport kinds', () => {
    expect(validateMediaCommand({ kind: 'play' })).toEqual({ command: { kind: 'play' } });
    expect(validateMediaCommand({ kind: 'pause' })).toEqual({ command: { kind: 'pause' } });
    expect(validateMediaCommand({ kind: 'toggle' })).toEqual({ command: { kind: 'toggle' } });
    expect(validateMediaCommand({ kind: 'seek', positionMs: 42_000 })).toEqual({
      command: { kind: 'seek', positionMs: 42_000 },
    });
    expect(validateMediaCommand({ kind: 'playById', mediaId: '1440833098' })).toEqual({
      command: { kind: 'playById', mediaId: '1440833098' },
    });
  });

  it('refuses next, previous and every queue verb', () => {
    // This is the load-bearing boundary of the whole refactor: Folia owns the queue and resolves
    // "next" itself into a playById, so no queue verb may ever reach the extension.
    for (const kind of ['next', 'previous', 'prev', 'skip', 'queue', 'setQueue', 'enqueue', 'playNext', 'stop']) {
      expect(validateMediaCommand({ kind }).error).toContain('unsupported command kind');
    }
    expect(validateMediaCommand({ kind: 'playById', mediaId: '1', queue: ['1', '2'] }).error).toContain(
      'does not apply',
    );
  });

  it('refuses anything that is not a known command, and never throws', () => {
    expect(validateMediaCommand({}).error).toContain('unsupported command kind');
    expect(validateMediaCommand(null).error).toBe('command must be an object');
    expect(validateMediaCommand('play').error).toBe('command must be an object');
    expect(validateMediaCommand(['play']).error).toBe('command must be an object');
    expect(validateMediaCommand({ kind: 'play; rm -rf /' }).error).toContain('unsupported command kind');
    expect(validateMediaCommand({ kind: 42 }).error).toContain('unsupported command kind');
  });

  it('requires an integer position in range for seek', () => {
    expect(validateMediaCommand({ kind: 'seek' }).error).toContain('requires an integer positionMs');
    expect(validateMediaCommand({ kind: 'seek', positionMs: -1 }).error).toContain('between 0');
    expect(validateMediaCommand({ kind: 'seek', positionMs: 3_600_001 }).error).toContain('between 0');
    expect(validateMediaCommand({ kind: 'seek', positionMs: 1.5 }).error).toContain('integer positionMs');
    expect(validateMediaCommand({ kind: 'seek', positionMs: '1000' }).error).toContain('integer positionMs');
    expect(validateMediaCommand({ kind: 'seek', positionMs: null }).error).toContain('integer positionMs');
    // Zero is a real seek to the start of the track, and the upper bound is inclusive.
    expect(validateMediaCommand({ kind: 'seek', positionMs: 0 })).toEqual({
      command: { kind: 'seek', positionMs: 0 },
    });
    expect(validateMediaCommand({ kind: 'seek', positionMs: 3_600_000 }).error).toBeUndefined();
  });

  it('requires a non-empty mediaId for playById', () => {
    expect(validateMediaCommand({ kind: 'playById' }).error).toContain('non-empty mediaId');
    expect(validateMediaCommand({ kind: 'playById', mediaId: '' }).error).toContain('non-empty mediaId');
    expect(validateMediaCommand({ kind: 'playById', mediaId: '   ' }).error).toContain('non-empty mediaId');
    expect(validateMediaCommand({ kind: 'playById', mediaId: 1440833098 }).error).toContain('non-empty mediaId');
    expect(validateMediaCommand({ kind: 'playById', mediaId: null }).error).toContain('non-empty mediaId');
  });

  it('refuses extra fields on the kinds that take none', () => {
    expect(validateMediaCommand({ kind: 'play', positionMs: 1000 }).error).toContain('does not apply');
    expect(validateMediaCommand({ kind: 'pause', mediaId: '1' }).error).toContain('does not apply');
    expect(validateMediaCommand({ kind: 'toggle', volume: 0.5 }).error).toContain('does not apply');
  });

  it('accepts the renderer IPC spelling (`command`) and normalizes it to `kind`', () => {
    // Two verb spellings reach this seam: `kind` (the MediaCommand shape the extension also uses)
    // and `command` (the renderer's `ElectronExternalMediaCommandRequest`). Both must validate to
    // the same normalized command — otherwise every renderer command is refused as
    // invalid-argument before it reaches the extension.
    expect(validateMediaCommand({ command: 'play' })).toEqual({ command: { kind: 'play' } });
    expect(validateMediaCommand({ command: 'seek', positionMs: 42_000 })).toEqual({
      command: { kind: 'seek', positionMs: 42_000 },
    });
    expect(validateMediaCommand({ command: 'playById', mediaId: '1440833098' })).toEqual({
      command: { kind: 'playById', mediaId: '1440833098' },
    });
    // Agreeing spellings are interchangeable…
    expect(validateMediaCommand({ kind: 'play', command: 'play' })).toEqual({ command: { kind: 'play' } });
    // …disagreeing ones are ambiguous and refused rather than guessed at.
    expect(validateMediaCommand({ kind: 'play', command: 'pause' }).error).toContain('disagree');
    // And the renderer spelling obeys exactly the same allow-list as the wire spelling.
    expect(validateMediaCommand({ command: 'next' }).error).toContain('unsupported command kind');
    expect(validateMediaCommand({ command: 'play', volume: 0.5 }).error).toContain('does not apply');
    expect(validateMediaCommand({ command: 'seek', positionMs: 1.5 }).error).toContain('integer positionMs');
  });
});

describe('createExternalMediaBridge', () => {
  let timers: ReturnType<typeof createTimerHarness>;
  let server: FakeServer | null;
  // Every server the bridge has created, in order: `stop()` then `start()` builds a new one, so the
  // latest reference is not enough to assert on the first bind.
  let servers: FakeServer[];
  let webSocketServer: FakeWebSocketServer | null;
  let now: number;
  let warnings: unknown[][];
  // Applied to the next fake server the bridge creates. Needed because the server does not exist
  // until `start()` calls `createServer`, and a listen failure has to be armed before that.
  let nextListenError: Error | null;
  let nextAddressPort: number | null;

  function createBridge(overrides: Partial<BridgeOptions> = {}) {
    return createExternalMediaBridge({
      port: DEFAULT_EXTERNAL_MEDIA_PORT,
      token: TOKEN,
      now: () => now,
      createServer: (handler) => {
        server = createFakeServer(handler);
        server.failListen = nextListenError;
        server.addressPort = nextAddressPort;
        servers.push(server);
        return server;
      },
      webSocketServerFactory: () => {
        webSocketServer = createFakeWebSocketServer();
        return webSocketServer;
      },
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      logInfo: () => {},
      logWarn: (...args: unknown[]) => {
        warnings.push(args);
      },
      ...overrides,
    });
  }

  // Drives one upgrade through the real handler the bridge registered on the server, so auth, origin
  // and route checks are exercised rather than bypassed.
  function upgrade(_bridge: Bridge, request: FakeUpgradeRequest = upgradeRequest()) {
    const socket = createFakeSocket();
    server!.emit('upgrade', request, socket, Buffer.alloc(0));
    return socket;
  }

  function http(_bridge: Bridge, url: string, headers: Record<string, string> = {}) {
    const res = createFakeResponse();
    server!.emit('request', httpRequest(url, headers), res);
    return { status: res.statusCode, headers: res.headers, body: res.body ? JSON.parse(res.body) : null };
  }

  const authHeaders = { authorization: `Bearer ${TOKEN}` };

  beforeEach(() => {
    timers = createTimerHarness();
    server = null;
    servers = [];
    webSocketServer = null;
    now = 1_000_000;
    warnings = [];
    nextListenError = null;
    nextAddressPort = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('lifecycle', () => {
    it('binds 127.0.0.1 on the configured port and reports itself available', async () => {
      const bridge = createBridge();
      expect(bridge.getStatus().available).toBe(false);

      await bridge.start();

      expect(server!.listenCalls).toEqual([{ port: DEFAULT_EXTERNAL_MEDIA_PORT, host: '127.0.0.1' }]);
      const status = bridge.getStatus();
      expect(status.available).toBe(true);
      expect(status.port).toBe(DEFAULT_EXTERNAL_MEDIA_PORT);
      expect(status.extensionConnected).toBe(false);
    });

    it('is idempotent: a second start does not bind a second time', async () => {
      const bridge = createBridge();
      await bridge.start();
      await bridge.start();
      await Promise.all([bridge.start(), bridge.start()]);
      expect(server!.listenCalls).toHaveLength(1);
    });

    it('stops and starts again cleanly', async () => {
      const bridge = createBridge();
      await bridge.start();
      await bridge.stop();
      expect(bridge.getStatus().available).toBe(false);
      expect(server!.closed).toBe(true);

      await bridge.start();
      expect(bridge.getStatus().available).toBe(true);
      // A second start after a stop is a fresh bind, not a no-op on the dead server.
      expect(servers).toHaveLength(2);
      expect(servers[1].listenCalls).toEqual([{ port: DEFAULT_EXTERNAL_MEDIA_PORT, host: '127.0.0.1' }]);
    });

    it('is idempotent on stop', async () => {
      const bridge = createBridge();
      await bridge.start();
      await bridge.stop();
      await expect(bridge.stop()).resolves.toBeUndefined();
    });

    it('reports a failed listen as unavailable and stays retryable', async () => {
      // Armed before start(), because createServer is only called inside it.
      nextListenError = new Error('EADDRINUSE');
      const failing = createBridge();

      await expect(failing.start()).rejects.toThrow('EADDRINUSE');
      expect(failing.getStatus().available).toBe(false);
      expect(failing.getStatus().lastError?.kind).toBe('bridge-unavailable');

      // Nothing is left half-open, so the retry is free to succeed. The retry creates a NEW server, so
      // the armed failure has to be cleared rather than the old instance patched.
      nextListenError = null;
      await expect(failing.start()).resolves.toBeUndefined();
      expect(failing.getStatus().available).toBe(true);
      expect(failing.getStatus().lastError).toBeNull();
    });

    it('reports the port the server actually bound, not the one that was asked for', async () => {
      // The `port: 0` contract: the caller asks for "any free port" and has to be told which one.
      nextAddressPort = 54_321;
      const bridge = createBridge({ port: 0 });
      await bridge.start();
      expect(bridge.getStatus().port).toBe(54_321);
      expect(bridge.getPort()).toBe(54_321);
    });
  });

  describe('HTTP routes', () => {
    it('serves health with the protocol version and the known sources', async () => {
      const bridge = createBridge();
      await bridge.start();
      const response = http(bridge, '/external-media/health', authHeaders);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        ok: true,
        version: PROTOCOL_VERSION,
        sources: ['apple-music-web'],
        extensionConnected: false,
      });
    });

    it('serves status with the same shape getStatus returns', async () => {
      const bridge = createBridge();
      await bridge.start();
      const response = http(bridge, '/external-media/status', authHeaders);
      expect(response.status).toBe(200);
      expect(response.body).toEqual(bridge.getStatus());
    });

    it('requires the bearer token and never sends a wildcard CORS header', async () => {
      const bridge = createBridge();
      await bridge.start();

      expect(http(bridge, '/external-media/health').status).toBe(401);
      expect(http(bridge, '/external-media/health', { authorization: 'Bearer nope' }).status).toBe(401);
      expect(http(bridge, '/external-media/status').status).toBe(401);

      const response = http(bridge, '/external-media/health', authHeaders);
      // The regression this guards: a wildcard would let any page in any browser on this machine
      // probe the bridge. There is no CORS header at all.
      expect(response.headers).not.toHaveProperty('Access-Control-Allow-Origin');
      expect(response.headers).not.toHaveProperty('access-control-allow-origin');
    });

    it('404s an unknown route and 405s a non-GET method', async () => {
      const bridge = createBridge();
      await bridge.start();
      expect(http(bridge, '/external-media/nope', authHeaders).status).toBe(404);
      const res = createFakeResponse();
      server!.emit('request', { method: 'POST', url: '/external-media/health', headers: authHeaders }, res);
      expect(res.statusCode).toBe(405);
    });
  });

  describe('WebSocket upgrade', () => {
    it('accepts the query token and sends welcome immediately', async () => {
      const bridge = createBridge();
      await bridge.start();

      const socket = upgrade(bridge);
      expect(socket.written).toHaveLength(1);
      expect(JSON.parse(socket.written[0])).toEqual({
        type: 'welcome',
        version: PROTOCOL_VERSION,
        heartbeatIntervalMs: 15_000,
      });
      expect(bridge.getStatus().extensionConnected).toBe(true);
    });

    it('accepts the Authorization header too', async () => {
      const bridge = createBridge();
      await bridge.start();
      const socket = upgrade(bridge, upgradeRequest({ url: '/external-media/ws', headers: authHeaders }));
      expect(bridge.getStatus().extensionConnected).toBe(true);
      expect(socket.written).toHaveLength(1);
    });

    it('rejects an upgrade with no token, a wrong token, or the wrong path', async () => {
      const bridge = createBridge();
      await bridge.start();

      const unauthenticated = upgrade(bridge, upgradeRequest({ url: '/external-media/ws' }));
      expect(unauthenticated.rawWrites[0]).toContain('401');
      expect(unauthenticated.destroyed).toBe(true);

      const wrongToken = upgrade(bridge, upgradeRequest({ url: '/external-media/ws?token=wrong' }));
      expect(wrongToken.rawWrites[0]).toContain('401');

      const wrongPath = upgrade(bridge, upgradeRequest({ url: '/external-media/nope?token=' + TOKEN }));
      expect(wrongPath.rawWrites[0]).toContain('404');

      expect(bridge.getStatus().extensionConnected).toBe(false);
      expect(webSocketServer!.upgrades).toBe(0);
    });

    it('rejects a page origin but allows an absent one', async () => {
      const bridge = createBridge();
      await bridge.start();

      const webPage = upgrade(bridge, upgradeRequest({ headers: { origin: 'https://evil.example' } }));
      expect(webPage.rawWrites[0]).toContain('403');

      // A service worker's upgrade may carry no Origin at all; the token is still required.
      const noOrigin = upgrade(bridge);
      expect(noOrigin.written[0]).toContain('welcome');

      const extensionOrigin = upgrade(
        bridge,
        upgradeRequest({ headers: { origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' } }),
      );
      expect(extensionOrigin.written[0]).toContain('welcome');
    });

    it('stops the heartbeat when the extension disconnects', async () => {
      const bridge = createBridge({ heartbeatIntervalMs: 15_000 });
      await bridge.start();
      const socket = upgrade(bridge);
      expect(timers.countWithDelay(15_000)).toBe(1);

      socket.readyState = 3;
      socket.emit('close');
      // A stopped bridge must not leave a heartbeat running against a dead socket.
      expect(timers.countWithDelay(15_000)).toBe(0);
    });
  });

  describe('session', () => {
    it('tracks extensionVersion and capabilities from hello', async () => {
      const bridge = createBridge();
      await bridge.start();
      const socket = upgrade(bridge);
      socket.emit('message', helloFrame({ extensionVersion: '1.2.3', capabilities: ['observe', 'seek', 42] }));

      const status = bridge.getStatus();
      expect(status.extensionVersion).toBe('1.2.3');
      // Non-string capabilities are dropped rather than trusted.
      expect(status.capabilities).toEqual(['observe', 'seek']);
    });

    it('replaces the previous socket when a new one connects', async () => {
      const bridge = createBridge();
      await bridge.start();

      const first = upgrade(bridge);
      first.emit('message', helloFrame({ extensionVersion: '0.1.0' }));
      const pending = bridge.sendCommand({ kind: 'play' });

      const second = upgrade(bridge);
      second.emit('message', helloFrame({ extensionVersion: '0.2.0' }));

      // One extension at a time: the old socket is closed and its in-flight command can never be
      // answered, so it fails immediately instead of waiting for a reply from the new session.
      expect(first.closedWith?.code).toBe(1000);
      await expect(pending).resolves.toMatchObject({ ok: false, errorKind: 'transport-error' });
      expect(bridge.getStatus().extensionConnected).toBe(true);
      expect(bridge.getStatus().extensionVersion).toBe('0.2.0');
    });

    it('clears the session when the socket closes', async () => {
      const bridge = createBridge();
      await bridge.start();
      const socket = upgrade(bridge);
      socket.emit('message', helloFrame());
      expect(bridge.getStatus().extensionVersion).toBe('0.1.0');

      socket.readyState = 3;
      socket.emit('close');

      const status = bridge.getStatus();
      expect(status.extensionConnected).toBe(false);
      expect(status.extensionVersion).toBeNull();
      expect(status.capabilities).toEqual([]);
    });

    it('ignores a late close from a socket that was already replaced', async () => {
      const bridge = createBridge();
      await bridge.start();
      const first = upgrade(bridge);
      const second = upgrade(bridge);
      second.emit('message', helloFrame({ extensionVersion: '0.2.0' }));

      first.emit('close');

      expect(bridge.getStatus().extensionConnected).toBe(true);
      expect(bridge.getStatus().extensionVersion).toBe('0.2.0');
    });
  });

  describe('sendCommand', () => {
    it('resolves bridge-unavailable with no extension connected, and never rejects', async () => {
      const bridge = createBridge();
      await bridge.start();
      await expect(bridge.sendCommand({ kind: 'play' })).resolves.toEqual({
        ok: false,
        command: 'play',
        targetSourceId: null,
        error: 'no extension is connected',
        errorKind: 'bridge-unavailable',
        completedAtMs: null,
      });
    });

    it('refuses an unknown kind without forwarding it', async () => {
      const bridge = createBridge();
      await bridge.start();
      const socket = upgrade(bridge);
      const before = socket.written.length;

      const result = await bridge.sendCommand({ kind: 'next' });
      expect(result.ok).toBe(false);
      expect(result.errorKind).toBe('invalid-argument');
      // The allow-list boundary: nothing was written for the refused command.
      expect(socket.written).toHaveLength(before);
    });

    it('normalizes a renderer-shaped request into the wire `kind` shape', async () => {
      // The IPC boundary sends `ElectronExternalMediaCommandRequest` ({command, mediaId}); the
      // extension receives the `MediaCommand` shape ({kind, mediaId}). Dropping this seam is what
      // made every renderer command fail as invalid-argument before it reached the extension.
      const bridge = createBridge();
      await bridge.start();
      const socket = upgrade(bridge);
      socket.emit('message', helloFrame());

      const pending = bridge.sendCommand({ command: 'playById', mediaId: '1440833098' });
      const frame = JSON.parse(socket.written[1]) as { type: string; id: string; command: MediaCommand };
      expect(frame.type).toBe('command');
      expect(frame.command).toEqual({ kind: 'playById', mediaId: '1440833098' });

      socket.emit('message', responseFrame({ id: frame.id }));
      await expect(pending).resolves.toMatchObject({ ok: true, command: 'playById' });
    });

    it('completes a round trip: hello, command frame, matching response', async () => {
      const bridge = createBridge();
      await bridge.start();
      const socket = upgrade(bridge);
      socket.emit('message', helloFrame());

      const pending = bridge.sendCommand({ kind: 'play' });
      expect(socket.written).toHaveLength(2);
      const frame = JSON.parse(socket.written[1]) as { type: string; id: string; command: MediaCommand };
      expect(frame.type).toBe('command');
      expect(frame.command).toEqual({ kind: 'play' });
      expect(typeof frame.id).toBe('string');

      socket.emit('message', responseFrame({ id: frame.id }));

      await expect(pending).resolves.toEqual({
        ok: true,
        command: 'play',
        targetSourceId: 'apple-music-web',
        error: null,
        errorKind: null,
        completedAtMs: now,
      });
    });

    it('carries the seek position and the playById media id through unchanged', async () => {
      const bridge = createBridge();
      await bridge.start();
      const socket = upgrade(bridge);

      const seek = bridge.sendCommand({ kind: 'seek', positionMs: 42_000 });
      const seekFrame = JSON.parse(socket.written[socket.written.length - 1]) as {
        id: string;
        command: MediaCommand;
      };
      expect(seekFrame.command).toEqual({ kind: 'seek', positionMs: 42_000 });
      socket.emit('message', responseFrame({ id: seekFrame.id }));
      await seek;

      const playById = bridge.sendCommand({ kind: 'playById', mediaId: '1440833098' });
      const playFrame = JSON.parse(socket.written[socket.written.length - 1]) as {
        id: string;
        command: MediaCommand;
      };
      expect(playFrame.command).toEqual({ kind: 'playById', mediaId: '1440833098' });
      socket.emit('message', responseFrame({ id: playFrame.id }));
      await playById;
    });

    it('passes a declined command through as a structured failure', async () => {
      const bridge = createBridge();
      await bridge.start();
      const socket = upgrade(bridge);

      const pending = bridge.sendCommand({ kind: 'toggle' });
      const frame = JSON.parse(socket.written[socket.written.length - 1]) as { id: string };
      socket.emit(
        'message',
        responseFrame({
          id: frame.id,
          ok: false,
          errorKind: 'storefront-mismatch',
          error: 'the page storefront does not match the account storefront',
          targetSourceId: null,
        }),
      );

      await expect(pending).resolves.toMatchObject({
        ok: false,
        command: 'toggle',
        errorKind: 'storefront-mismatch',
        targetSourceId: null,
      });
    });

    it('matches responses by id when a later command answers first', async () => {
      const bridge = createBridge();
      await bridge.start();
      const socket = upgrade(bridge);

      const first = bridge.sendCommand({ kind: 'play' });
      const second = bridge.sendCommand({ kind: 'pause' });
      const frames = socket.written
        .slice(1)
        .map((line) => JSON.parse(line) as { id: string; command: MediaCommand });

      socket.emit('message', responseFrame({ id: frames[1].id }));
      socket.emit('message', responseFrame({ id: frames[0].id }));

      await expect(second).resolves.toMatchObject({ ok: true, command: 'pause' });
      await expect(first).resolves.toMatchObject({ ok: true, command: 'play' });
    });

    it('times out a command the extension never answers', async () => {
      const bridge = createBridge();
      await bridge.start();
      upgrade(bridge);

      const pending = bridge.sendCommand({ kind: 'play' });
      expect(timers.countWithDelay(10_000)).toBe(1);

      timers.runTimer(10_000);
      await expect(pending).resolves.toMatchObject({
        ok: false,
        command: 'play',
        errorKind: 'timeout',
      });
    });

    it('ignores a response that arrives after its timeout', async () => {
      const bridge = createBridge();
      await bridge.start();
      const socket = upgrade(bridge);
      const pending = bridge.sendCommand({ kind: 'play' });
      const frame = JSON.parse(socket.written[socket.written.length - 1]) as { id: string };

      timers.runTimer(10_000);
      await pending;

      expect(() => socket.emit('message', responseFrame({ id: frame.id }))).not.toThrow();
    });

    it('treats a malformed response frame as a transport failure, never a success', async () => {
      const bridge = createBridge();
      await bridge.start();
      const socket = upgrade(bridge);

      const pending = bridge.sendCommand({ kind: 'play' });
      const frame = JSON.parse(socket.written[socket.written.length - 1]) as { id: string };
      socket.emit('message', JSON.stringify({ type: 'response', id: frame.id }));

      await expect(pending).resolves.toMatchObject({ ok: false, errorKind: 'transport-error' });
    });

    it('surfaces a write failure instead of leaving the promise pending', async () => {
      const bridge = createBridge();
      await bridge.start();
      const socket = upgrade(bridge);
      socket.send = () => {
        throw new Error('socket is closing');
      };

      await expect(bridge.sendCommand({ kind: 'play' })).resolves.toMatchObject({
        ok: false,
        errorKind: 'transport-error',
      });
    });

    it('fails pending commands immediately when the socket closes', async () => {
      const bridge = createBridge();
      await bridge.start();
      const socket = upgrade(bridge);

      const pending = bridge.sendCommand({ kind: 'playById', mediaId: '1440833098' });
      socket.readyState = 3;
      socket.emit('close');

      // Immediately, not on the next status read, and never queued across a reconnect.
      await expect(pending).resolves.toMatchObject({
        ok: false,
        command: 'playById',
        errorKind: 'transport-error',
        error: 'the extension disconnected before it answered',
      });
      expect(bridge.getStatus().extensionConnected).toBe(false);
    });

    it('fails pending commands on stop with bridge-unavailable and clears their timers', async () => {
      const bridge = createBridge();
      await bridge.start();
      upgrade(bridge);

      const pending = bridge.sendCommand({ kind: 'play' });
      expect(timers.countWithDelay(10_000)).toBe(1);

      await bridge.stop();

      await expect(pending).resolves.toMatchObject({ ok: false, errorKind: 'bridge-unavailable' });
      expect(timers.countWithDelay(10_000)).toBe(0);
      // The transport is gone, so a new command is refused rather than queued.
      await expect(bridge.sendCommand({ kind: 'play' })).resolves.toMatchObject({
        ok: false,
        errorKind: 'bridge-unavailable',
      });
    });

    it('refuses to queue a command while the socket is not open', async () => {
      const bridge = createBridge();
      await bridge.start();
      const socket = upgrade(bridge);
      socket.readyState = 2; // CLOSING
      await expect(bridge.sendCommand({ kind: 'pause' })).resolves.toMatchObject({
        ok: false,
        errorKind: 'bridge-unavailable',
        error: 'the extension connection is not open',
      });
    });
  });

  describe('frames', () => {
    it('ignores an unknown frame type without throwing', async () => {
      const bridge = createBridge();
      await bridge.start();
      const socket = upgrade(bridge);
      expect(() => socket.emit('message', JSON.stringify({ type: 'telemetry', value: 1 }))).not.toThrow();
      expect(bridge.getStatus().available).toBe(true);
    });

    it('ignores a frame that is not JSON, or not an object with a type', async () => {
      const bridge = createBridge();
      await bridge.start();
      const socket = upgrade(bridge);

      expect(() => socket.emit('message', 'not json at all')).not.toThrow();
      expect(() => socket.emit('message', 'null')).not.toThrow();
      expect(() => socket.emit('message', '[1,2,3]')).not.toThrow();
      expect(() => socket.emit('message', JSON.stringify({ noType: true }))).not.toThrow();

      expect(bridge.getObservation()).toBeNull();
      expect(warnings.length).toBeGreaterThan(0);
    });

    it('answers nothing to pong and keeps the session alive', async () => {
      const bridge = createBridge();
      await bridge.start();
      const socket = upgrade(bridge);
      const before = socket.written.length;
      socket.emit('message', JSON.stringify({ type: 'pong', at: now }));
      expect(socket.written).toHaveLength(before);
      expect(bridge.getStatus().extensionConnected).toBe(true);
    });

    it('pings on the heartbeat interval while an extension is connected', async () => {
      const bridge = createBridge({ heartbeatIntervalMs: 15_000 });
      await bridge.start();
      const socket = upgrade(bridge);

      expect(timers.countWithDelay(15_000)).toBe(1);
      timers.runTimer(15_000);

      const ping = JSON.parse(socket.written[socket.written.length - 1]) as { type: string; at: number };
      expect(ping).toEqual({ type: 'ping', at: now });
      // Re-armed, so the connection keeps being kept alive.
      expect(timers.countWithDelay(15_000)).toBe(1);
    });
  });

  describe('observations', () => {
    it('stores a validated observation and notifies subscribers', async () => {
      const bridge = createBridge();
      await bridge.start();
      const socket = upgrade(bridge);

      const seen: Observation[] = [];
      const unsubscribe = bridge.onObservation((observation) => seen.push(observation));

      socket.emit('message', stateFrame());

      const observation = bridge.getObservation();
      expect(observation).toEqual({
        connected: true,
        identity: { title: 'MaringCode', artist: '神楽 めあ', album: null, durationMs: 218_000 },
        playbackStatus: 'Playing',
        positionMs: 13_000,
        positionEstablishedAtMs: 1_000_000,
        observedAtMs: 1_000_000,
      });
      expect(seen).toHaveLength(1);
      expect(bridge.getStatus().lastObservationAtMs).toBe(now);

      unsubscribe();
      socket.emit('message', stateFrame({ positionMs: 14_000 }));
      expect(seen).toHaveLength(1);
    });

    it('rejects a malformed observation instead of storing it', async () => {
      const bridge = createBridge();
      await bridge.start();
      const socket = upgrade(bridge);

      for (const observation of [null, 'nope', 42, [], { connected: true }]) {
        socket.emit('message', JSON.stringify({ type: 'state', observation }));
      }
      // observedAtMs is the one field the bridge insists on: without it staleness cannot be computed.
      socket.emit('message', JSON.stringify({ type: 'state', observation: { observedAtMs: 'soon' } }));
      socket.emit('message', JSON.stringify({ type: 'state', observation: { observedAtMs: Number.NaN } }));

      expect(bridge.getObservation()).toBeNull();
      expect(bridge.getStatus().lastObservationAtMs).toBeNull();
      expect(bridge.getStatus().lastError?.kind).toBe('transport-error');
    });

    it('normalizes an unknown playbackStatus to null but keeps the position', async () => {
      const bridge = createBridge();
      await bridge.start();
      const socket = upgrade(bridge);

      socket.emit('message', stateFrame({ playbackStatus: 'Buffering', positionMs: 900 }));

      const observation = bridge.getObservation();
      expect(observation?.playbackStatus).toBeNull();
      expect(observation?.positionMs).toBe(900);
    });

    it('surfaces an errorKind carried by a state frame as lastError', async () => {
      const bridge = createBridge();
      await bridge.start();
      const socket = upgrade(bridge);

      socket.emit(
        'message',
        JSON.stringify({ type: 'state', observation: { observedAtMs: now, connected: false }, errorKind: 'not-signed-in' }),
      );
      expect(bridge.getStatus().lastError).toEqual({
        message: 'the Apple Music web player is not signed in',
        kind: 'not-signed-in',
      });

      socket.emit('message', stateFrame());
      expect(bridge.getStatus().lastError).toBeNull();
    });

    it('flips isObservationStale as the observation ages', async () => {
      const bridge = createBridge({ staleObservationMs: 10_000 });
      await bridge.start();
      const socket = upgrade(bridge);

      // No observation at all counts as stale: there is nothing trustworthy to report.
      expect(bridge.getStatus().isObservationStale).toBe(true);

      socket.emit('message', stateFrame());
      expect(bridge.getStatus().isObservationStale).toBe(false);

      now += 10_000;
      expect(bridge.getStatus().isObservationStale).toBe(false);
      now += 1;
      expect(bridge.getStatus().isObservationStale).toBe(true);
    });

    it('keeps the last observation when the extension disconnects, and marks it stale', async () => {
      const bridge = createBridge({ staleObservationMs: 10_000 });
      await bridge.start();
      const socket = upgrade(bridge);
      socket.emit('message', stateFrame());

      socket.readyState = 3;
      socket.emit('close');

      expect(bridge.getObservation()?.identity?.title).toBe('MaringCode');
      expect(bridge.getStatus().extensionConnected).toBe(false);
      now += 20_000;
      expect(bridge.getStatus().isObservationStale).toBe(true);
    });

    it('hands out copies, so a renderer cannot corrupt the session state', async () => {
      const bridge = createBridge();
      await bridge.start();
      const socket = upgrade(bridge);
      socket.emit('message', stateFrame());

      const first = bridge.getStatus();
      first.lastObservation!.positionMs = -1;
      first.lastObservation!.identity!.title = 'tampered';
      first.capabilities.push('tampered');

      const second = bridge.getStatus();
      expect(second.lastObservation?.positionMs).toBe(13_000);
      expect(second.lastObservation?.identity?.title).toBe('MaringCode');
      expect(second.capabilities).toEqual([]);
    });

    it('returns a serializable status safe for the IPC hop', async () => {
      const bridge = createBridge();
      await bridge.start();
      const socket = upgrade(bridge);
      socket.emit('message', helloFrame());
      socket.emit('message', stateFrame());

      const status = bridge.getStatus();
      expect(JSON.parse(JSON.stringify(status))).toEqual(status);
      expect(Object.keys(status).sort()).toEqual(
        [
          'available',
          'capabilities',
          'extensionConnected',
          'extensionVersion',
          'isObservationStale',
          'lastError',
          'lastObservation',
          'lastObservationAtMs',
          'port',
        ].sort(),
      );
    });

    it('notifies status subscribers and returns an unsubscribe', async () => {
      const bridge = createBridge();
      await bridge.start();

      const seen: BridgeStatus[] = [];
      const unsubscribe = bridge.onStatusChanged((status) => seen.push(status));
      const socket = upgrade(bridge);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[seen.length - 1].extensionConnected).toBe(true);

      unsubscribe();
      const after = seen.length;
      socket.emit('message', helloFrame());
      expect(seen).toHaveLength(after);
    });

    it('survives a throwing listener', async () => {
      const bridge = createBridge();
      await bridge.start();
      bridge.onObservation(() => {
        throw new Error('renderer bug');
      });
      const socket = upgrade(bridge);
      expect(() => socket.emit('message', stateFrame())).not.toThrow();
      expect(bridge.getObservation()?.positionMs).toBe(13_000);
    });
  });

  describe('getPort', () => {
    it('reports the configured port before start and the bound port after', async () => {
      nextAddressPort = 54_321;
      const bridge = createBridge({ port: 32_999 });
      expect(bridge.getPort()).toBe(32_999);
      await bridge.start();
      expect(bridge.getPort()).toBe(54_321);
      // After stop there is no bound port any more, so the configured one is what a restart would use.
      await bridge.stop();
      expect(bridge.getPort()).toBe(32_999);
    });
  });
});

// Real loopback sockets, ephemeral port, no injected fakes. This is the only place the wire format is
// checked end to end (Node's own fetch and ws client against the real http server), and it is
// reliable in CI because it never leaves 127.0.0.1 and never waits on an external service.
describe('createExternalMediaBridge (real loopback integration)', () => {
  it('serves health over HTTP and completes a command round trip over a real WebSocket', async () => {
    const bridge = createExternalMediaBridge({
      port: 0,
      token: TOKEN,
      logInfo: () => {},
      logWarn: () => {},
    });

    await bridge.start();
    const port = bridge.getPort();
    expect(port).toBeGreaterThan(0);

    try {
      const health = await fetch(`http://127.0.0.1:${port}/external-media/health`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(health.status).toBe(200);
      await expect(health.json()).resolves.toMatchObject({ ok: true, sources: ['apple-music-web'] });

      const unauthorized = await fetch(`http://127.0.0.1:${port}/external-media/health`);
      expect(unauthorized.status).toBe(401);

      const client = new WsClient(`ws://127.0.0.1:${port}/external-media/ws?token=${TOKEN}`);
      // The collector is attached before `open` resolves, because `welcome` is written the moment the
      // upgrade completes and would otherwise race the first assertion.
      const frames: Record<string, unknown>[] = [];
      const waiters: { type: string; resolve: (frame: Record<string, unknown>) => void }[] = [];
      client.on('message', (data: Buffer) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        frames.push(frame);
        for (let index = waiters.length - 1; index >= 0; index -= 1) {
          if (waiters[index].type === frame.type) {
            const [waiter] = waiters.splice(index, 1);
            waiter.resolve(frame);
          }
        }
      });
      const waitForFrame = (type: string) => {
        const existing = frames.find((frame) => frame.type === type);
        if (existing) {
          return Promise.resolve(existing);
        }
        return new Promise<Record<string, unknown>>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 4_000);
          waiters.push({
            type,
            resolve: (frame) => {
              clearTimeout(timer);
              resolve(frame);
            },
          });
        });
      };

      await new Promise<void>((resolve, reject) => {
        client.once('open', () => resolve());
        client.once('error', reject);
      });

      const welcome = await waitForFrame('welcome');
      expect(welcome).toEqual({
        type: 'welcome',
        version: PROTOCOL_VERSION,
        heartbeatIntervalMs: 15_000,
      });

      // The extension's own handshake and first observation, over the real socket.
      client.send(
        JSON.stringify({
          type: 'hello',
          extensionVersion: '0.1.0',
          sourceId: 'apple-music-web',
          capabilities: ['observe', 'seek'],
        }),
      );
      await vi.waitFor(() => {
        expect(bridge.getStatus().extensionVersion).toBe('0.1.0');
      });
      expect(bridge.getStatus().capabilities).toEqual(['observe', 'seek']);

      client.send(
        JSON.stringify({
          type: 'state',
          observation: {
            connected: true,
            identity: { title: 'MaringCode', artist: '神楽 めあ', album: null, durationMs: 218_000 },
            playbackStatus: 'Playing',
            positionMs: 13_000,
            positionEstablishedAtMs: Date.now(),
            observedAtMs: Date.now(),
          },
        }),
      );
      await vi.waitFor(() => {
        expect(bridge.getObservation()?.identity?.title).toBe('MaringCode');
      });
      expect(bridge.getStatus().isObservationStale).toBe(false);

      const commandFrame = waitForFrame('command');
      const pending = bridge.sendCommand({ kind: 'seek', positionMs: 1_500 });
      const frame = await commandFrame;
      expect(frame.command).toEqual({ kind: 'seek', positionMs: 1_500 });

      client.send(
        JSON.stringify({
          type: 'response',
          id: frame.id,
          ok: true,
          errorKind: null,
          error: null,
          targetSourceId: 'apple-music-web',
        }),
      );
      await expect(pending).resolves.toMatchObject({ ok: true, command: 'seek' });

      expect(bridge.getStatus().extensionConnected).toBe(true);

      // A real close has to clear the session, which is the path the renderer depends on.
      const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
      client.close();
      await closed;
      await vi.waitFor(() => {
        expect(bridge.getStatus().extensionConnected).toBe(false);
      });
    } finally {
      await bridge.stop();
    }
  }, 15_000);
});
