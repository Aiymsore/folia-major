const http = require('http');
const { WebSocketServer } = require('ws');

// electron/externalMediaBridge.cjs
// Folia external media bridge: the Electron-side half of "Folia controls music.apple.com in Chrome".
//
// Two clients, two transports, one session:
//   * the Folia renderer talks to this module over IPC (`sendCommand`, `getStatus`, `onObservation`);
//   * the Folia companion Chrome extension talks to it over loopback HTTP + WebSocket.
//
// The bridge is a relay plus a session manager and nothing else:
//   * it never writes a multi-track queue into Apple Music. Folia owns its queue and resolves "next"
//     itself into one `playById`. The command allow-list below is exactly the five transport verbs
//     and that boundary is load-bearing: a compromised or buggy renderer cannot invent a sixth verb,
//     and the extension is never asked to manage a queue it does not own.
//   * every failure of `sendCommand` resolves with a structured `{ok:false, errorKind}` rather than
//     rejecting, mirroring electron/externalMediaSmtcBridge.cjs, so a caller has exactly one shape to
//     handle.
//   * pending commands are failed immediately when the extension socket closes. Queueing them across
//     a reconnect would replay a transport command against a player state the user has since
//     changed — the same rule the SMTC bridge documents for its helper process.
//   * the extension is the untrusted side. Observations are validated and normalized before they are
//     stored, and the extension's own clock is never used to decide staleness.
//
// All side effects (server factory, WebSocket server factory, timers, clock, loggers) are injected so
// the whole state machine is unit-testable without binding a real port.

const DEFAULT_EXTERNAL_MEDIA_PORT = 32110;
const PROTOCOL_VERSION = 1;
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_STALE_OBSERVATION_MS = 10_000;

const SOURCE_APPLE_MUSIC_WEB = 'apple-music-web';
const HEALTH_PATH = '/external-media/health';
const STATUS_PATH = '/external-media/status';
const WS_PATH = '/external-media/ws';

// The only origin allowed to open the WebSocket. A service worker's upgrade may send no Origin at
// all (allow absent), but a page-context Origin must be a Chrome extension.
const CHROME_EXTENSION_ORIGIN_PREFIX = 'chrome-extension://';

// `ws` and the fake sockets used in tests both use the standard WebSocket readyState numbers. Kept as
// a local constant so this module does not depend on the ws export just for the value.
const SOCKET_OPEN = 1;

// How long a graceful close is given before the socket is terminated outright. Without it a client
// that never answers the close frame would keep `stop()` waiting on `server.close()`.
const STOP_TERMINATE_GRACE_MS = 500;

// The full error vocabulary. Every structured failure produced here or forwarded from the extension
// uses one of these; the renderer can switch on them exhaustively.
const ERR_BRIDGE_UNAVAILABLE = 'bridge-unavailable';
const ERR_TAB_NOT_FOUND = 'tab-not-found';
const ERR_NOT_SIGNED_IN = 'not-signed-in';
const ERR_STOREFRONT_MISMATCH = 'storefront-mismatch';
const ERR_PLAYER_DECLINED = 'player-declined';
const ERR_TIMEOUT = 'timeout';
const ERR_INVALID_ARGUMENT = 'invalid-argument';
const ERR_TRANSPORT_ERROR = 'transport-error';

const ERROR_KINDS = Object.freeze([
  ERR_BRIDGE_UNAVAILABLE,
  ERR_TAB_NOT_FOUND,
  ERR_NOT_SIGNED_IN,
  ERR_STOREFRONT_MISMATCH,
  ERR_PLAYER_DECLINED,
  ERR_TIMEOUT,
  ERR_INVALID_ARGUMENT,
  ERR_TRANSPORT_ERROR,
]);
const ERROR_KIND_SET = new Set(ERROR_KINDS);

// The playback vocabulary Folia already speaks on the SMTC path. The extension maps MusicKit's
// numeric PlaybackStates onto these three strings so downstream code has one vocabulary.
const PLAYBACK_STATUS_VALUES = new Set(['Playing', 'Paused', 'Stopped']);

// The five command kinds, and the fields each one may carry. Anything else is refused here and never
// reaches the extension: there is deliberately no `next` / `previous` / queue command, because Folia
// owns the queue and resolves "next" itself into a `playById`.
const COMMAND_KINDS = Object.freeze(['play', 'pause', 'toggle', 'seek', 'playById']);
const COMMAND_FIELDS = Object.freeze({
  play: Object.freeze([]),
  pause: Object.freeze([]),
  toggle: Object.freeze([]),
  seek: Object.freeze(['positionMs']),
  playById: Object.freeze(['mediaId']),
});
const MAX_SEEK_MS = 3_600_000;

// Human-readable text for the error kinds the extension reports on a `state` frame. The renderer
// shows `lastError.message`, and "storefront-mismatch" alone is not something a user can act on.
const STATE_ERROR_MESSAGES = Object.freeze({
  [ERR_TAB_NOT_FOUND]: 'the extension has no music.apple.com tab to control',
  [ERR_NOT_SIGNED_IN]: 'the Apple Music web player is not signed in',
  [ERR_STOREFRONT_MISMATCH]: 'the page storefront does not match the Apple Music account storefront',
  [ERR_PLAYER_DECLINED]: 'the Apple Music web player is not available on this page',
  [ERR_TIMEOUT]: 'the Apple Music web player did not answer in time',
  [ERR_TRANSPORT_ERROR]: 'the extension could not reach the Apple Music web player',
});

// Validates one renderer-supplied command. Exported (like `validateCommandRequest` in
// electron/externalMediaSmtcBridge.cjs) so the IPC handler and the unit tests share exactly one
// definition of what a well-formed command is.
//
// Two verb spellings reach this seam, and both are legitimate shapes of their own layer:
//   * `kind`    — the command contract sent to the extension on the wire (the vocabulary is
//                 `ElectronExternalMediaCommandName` in src/vite-env.d.ts).
//   * `command` — the renderer's IPC request shape (`ElectronExternalMediaCommandRequest`).
// Normalizing here rather than at each call site keeps ONE validation definition; a request that
// carries both spellings with different values is ambiguous and refused.
//
// Returns `{ command }` or `{ error }`; it never throws, because a bad command is a value the caller
// reports back, not an exception that would surface as an IPC rejection.
function validateMediaCommand(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'command must be an object' };
  }

  const { kind: kindField, command: commandField, ...rest } = raw;
  if (kindField !== undefined && commandField !== undefined && kindField !== commandField) {
    return { error: `kind and command disagree: ${String(kindField)} vs ${String(commandField)}` };
  }
  const kind = kindField !== undefined ? kindField : commandField;
  if (typeof kind !== 'string' || !COMMAND_KINDS.includes(kind)) {
    return { error: `unsupported command kind: ${String(kind)}` };
  }

  // Strict allow-list: a field that does not belong to this kind is a mistake on the caller's side
  // and is refused rather than silently dropped, so a `seek` that forgot `positionMs` cannot look
  // like a successful `play`.
  const allowedFields = COMMAND_FIELDS[kind];
  for (const key of Object.keys(rest)) {
    if (!allowedFields.includes(key)) {
      return { error: `${key} does not apply to ${kind}` };
    }
  }

  if (kind === 'seek') {
    const { positionMs } = rest;
    if (typeof positionMs !== 'number' || !Number.isInteger(positionMs)) {
      return { error: `seek requires an integer positionMs, got: ${String(positionMs)}` };
    }
    if (positionMs < 0 || positionMs > MAX_SEEK_MS) {
      return { error: `positionMs must be between 0 and ${MAX_SEEK_MS}, got: ${positionMs}` };
    }
    return { command: { kind, positionMs } };
  }

  if (kind === 'playById') {
    const { mediaId } = rest;
    if (typeof mediaId !== 'string' || mediaId.trim() === '') {
      return { error: `playById requires a non-empty mediaId, got: ${String(mediaId)}` };
    }
    return { command: { kind, mediaId } };
  }

  return { command: { kind } };
}

// Normalizes the identity block of an observation. A missing or non-object identity is "no item",
// which is a normal state (idle player), not a malformed frame.
function normalizeIdentity(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  return {
    title: typeof raw.title === 'string' ? raw.title : '',
    artist: typeof raw.artist === 'string' ? raw.artist : '',
    album: typeof raw.album === 'string' ? raw.album : null,
    durationMs: Number.isFinite(raw.durationMs) ? raw.durationMs : null,
  };
}

// Validates and normalizes one extension observation. Returns the stored shape or null.
//
// Two things are fatal (the frame is dropped): the observation is not an object, or `observedAtMs` is
// not a finite number. Everything else is coerced into the documented shape, because an extension
// that reports an unknown playbackStatus is reporting "unknown", not a reason to lose the position.
function normalizeObservation(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  if (!Number.isFinite(raw.observedAtMs)) {
    return null;
  }
  return {
    connected: raw.connected === true,
    identity: normalizeIdentity(raw.identity),
    playbackStatus: PLAYBACK_STATUS_VALUES.has(raw.playbackStatus) ? raw.playbackStatus : null,
    positionMs: Number.isFinite(raw.positionMs) ? raw.positionMs : null,
    positionEstablishedAtMs: Number.isFinite(raw.positionEstablishedAtMs)
      ? raw.positionEstablishedAtMs
      : null,
    observedAtMs: raw.observedAtMs,
  };
}

// A defensive copy, so a renderer that mutates what it got from `getStatus()` cannot corrupt the
// session state. The observation is six fields, so this stays cheap enough for a polling caller.
function cloneObservation(observation) {
  if (!observation) {
    return null;
  }
  return {
    ...observation,
    identity: observation.identity ? { ...observation.identity } : null,
  };
}

// The shape every command outcome has, success or failure, so a caller never has to branch on
// whether the promise resolved or rejected.
//
// `completedAtMs` stays null here on purpose: the bridge fills it in only when the command was
// actually attempted on the wire. A null therefore means "refused before anything was sent".
function commandFailure(kind, errorKind, error) {
  return {
    ok: false,
    command: typeof kind === 'string' ? kind : '',
    targetSourceId: null,
    error,
    errorKind,
    completedAtMs: null,
  };
}

// Reads a bearer token off an HTTP request. Header first, `?token=` as the fallback.
//
// The query fallback exists for exactly one caller: a browser cannot set custom headers on
// `new WebSocket()`, so the extension has no way to send `Authorization` on the upgrade request.
// The tradeoff is real and accepted — a URL can end up in a log, a proxy trace or a crash report,
// while a header cannot. It is the only place the token can reach a log, it is loopback-only, and
// the token is regenerated by Folia whenever the user asks for a new one.
function getBearerTokenFromRequest(req, requestUrl) {
  const authorizationHeader = req?.headers?.authorization;
  if (typeof authorizationHeader === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
    if (match) {
      return match[1];
    }
  }

  if (requestUrl) {
    const queryToken = requestUrl.searchParams.get('token');
    if (queryToken) {
      return queryToken;
    }
  }

  return null;
}

// A service worker's upgrade may legitimately carry no Origin. A page-context Origin must be a Chrome
// extension. The extension id itself is not pinned (Folia has no way to know it before the user
// loads the unpacked build) and is not the security boundary — the token is.
function isAllowedExtensionOrigin(origin) {
  if (origin === undefined || origin === null || origin === '') {
    return true;
  }
  if (typeof origin !== 'string' || !origin.startsWith(CHROME_EXTENSION_ORIGIN_PREFIX)) {
    return false;
  }
  const extensionId = origin.slice(CHROME_EXTENSION_ORIGIN_PREFIX.length);
  return extensionId.length > 0 && extensionId.length <= 128 && !/[\s/]/.test(extensionId);
}

function createExternalMediaBridge(options = {}) {
  const {
    port = DEFAULT_EXTERNAL_MEDIA_PORT,
    token = '',
    logInfo = console.info.bind(console),
    logWarn = console.warn.bind(console),
    now = () => Date.now(),
    createServer = (handler) => http.createServer(handler),
    webSocketServerFactory = () => new WebSocketServer({ noServer: true }),
    commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
    heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
    staleObservationMs = DEFAULT_STALE_OBSERVATION_MS,
    // Not part of the documented renderer-facing options, but injected the same way
    // externalMediaSmtcBridge injects its timers, so tests can step time instead of waiting on it.
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = options;

  let server = null;
  let webSocketServer = null;
  let listening = false;
  let boundPort = null;
  let startPromise = null;

  // The one extension session. `extensionSocket` is set as soon as the upgrade succeeds, so
  // `extensionConnected` is honest before `hello` arrives; version and capabilities only exist once
  // the extension has introduced itself.
  let extensionSocket = null;
  let extensionVersion = null;
  let capabilities = [];

  let lastObservation = null;
  let lastObservationAtMs = null;
  let lastError = null;

  let heartbeatTimer = null;
  let nextCommandId = 0;
  // id -> { command, resolve, timer }. A Map, not a queue: the extension may answer out of order and
  // the id is the only thing that ties a reply to its request.
  const pendingCommands = new Map();
  const observationListeners = new Set();
  const statusListeners = new Set();

  function isExtensionConnected() {
    return Boolean(extensionSocket && extensionSocket.readyState === SOCKET_OPEN);
  }

  function getBoundPort() {
    if (!listening) {
      return port;
    }
    try {
      const address = server?.address?.();
      if (address && typeof address === 'object' && Number.isFinite(address.port) && address.port > 0) {
        return address.port;
      }
    } catch {
      // Not listening any more; fall through to the configured port.
    }
    return port;
  }

  // Cheap and serializable: this is called on every renderer poll, and everything in it survives
  // structured clone for the IPC hop.
  function getStatus() {
    const observationAt = lastObservationAtMs;
    const isObservationStale =
      observationAt === null ||
      (Number.isFinite(staleObservationMs) && now() - observationAt > staleObservationMs);

    return {
      available: listening,
      port: getBoundPort(),
      extensionConnected: isExtensionConnected(),
      extensionVersion,
      capabilities: [...capabilities],
      lastObservation: cloneObservation(lastObservation),
      lastObservationAtMs: observationAt,
      isObservationStale,
      lastError: lastError ? { message: lastError.message, kind: lastError.kind } : null,
    };
  }

  function publishStatus() {
    const status = getStatus();
    for (const listener of statusListeners) {
      try {
        listener(status);
      } catch (error) {
        // A listener is renderer-side code. One broken subscriber must not take the bridge down.
        logWarn('[ExternalMedia] status listener threw', error);
      }
    }
  }

  function publishObservation(observation) {
    for (const listener of observationListeners) {
      try {
        listener(cloneObservation(observation));
      } catch (error) {
        logWarn('[ExternalMedia] observation listener threw', error);
      }
    }
  }

  function setLastError(message, kind) {
    lastError = { message, kind: kind ?? null };
  }

  // Fails every in-flight command. Used when the socket closes, when a new extension replaces the
  // old one, and on stop(): in all three cases the reply can never arrive, and leaving the promises
  // pending would make the renderer wait forever on a transport that is gone.
  function failPendingCommands(errorKind, message) {
    for (const [id, pending] of pendingCommands) {
      pendingCommands.delete(id);
      if (pending.timer !== null) {
        clearTimeoutFn(pending.timer);
      }
      pending.resolve({
        ...commandFailure(pending.command.kind, errorKind, message),
        completedAtMs: now(),
      });
    }
  }

  function sendFrame(socket, frame) {
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch (error) {
      // A write failure is a transport failure, not a "the player said no".
      logWarn('[ExternalMedia] failed to write a frame to the extension', error);
      setLastError(
        `a frame could not be written to the extension: ${String(error?.message || error)}`,
        ERR_TRANSPORT_ERROR,
      );
      return false;
    }
  }

  function closeSocket(socket, code, reason) {
    if (!socket) {
      return;
    }
    try {
      socket.close(code, reason);
    } catch (error) {
      logWarn('[ExternalMedia] failed to close an extension socket', error);
    }
    // The graceful close is the message; the terminate is the guarantee that `stop()` cannot hang on
    // a client that never answers it.
    setTimeoutFn(() => {
      try {
        socket.terminate?.();
      } catch {
        // Already gone.
      }
    }, STOP_TERMINATE_GRACE_MS);
  }

  function stopHeartbeat() {
    if (heartbeatTimer !== null) {
      clearTimeoutFn(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function armHeartbeat() {
    if (!Number.isFinite(heartbeatIntervalMs) || heartbeatIntervalMs <= 0) {
      return;
    }
    heartbeatTimer = setTimeoutFn(() => {
      heartbeatTimer = null;
      const socket = extensionSocket;
      if (!socket || socket.readyState !== SOCKET_OPEN) {
        return;
      }
      // The ping doubles as the extension's service-worker keepalive: MV3 kills an idle worker, and
      // a WebSocket frame arriving is one of the events that resets that idle timer.
      sendFrame(socket, { type: 'ping', at: now() });
      armHeartbeat();
    }, heartbeatIntervalMs);
  }

  function startHeartbeat() {
    stopHeartbeat();
    armHeartbeat();
  }

  function handleSocketClosed(socket) {
    // A superseded socket's late close must not clear the live session.
    if (extensionSocket !== socket) {
      return;
    }
    extensionSocket = null;
    extensionVersion = null;
    capabilities = [];
    stopHeartbeat();
    // Fail in-flight commands right here rather than on the next status read: the reply can never
    // arrive, and a replayed transport command would act on state the user has since changed.
    failPendingCommands(ERR_TRANSPORT_ERROR, 'the extension disconnected before it answered');
    publishStatus();
  }

  function handleHelloFrame(frame) {
    const sourceId = typeof frame.sourceId === 'string' ? frame.sourceId : null;
    if (sourceId !== null && sourceId !== SOURCE_APPLE_MUSIC_WEB) {
      // Not fatal: this bridge only ever serves one source, and the session is still usable. It is
      // worth a warning because it means the extension build and the bridge disagree.
      logWarn('[ExternalMedia] hello from an unexpected sourceId', sourceId);
    }
    extensionVersion = typeof frame.extensionVersion === 'string' ? frame.extensionVersion : null;
    capabilities = Array.isArray(frame.capabilities)
      ? frame.capabilities.filter((capability) => typeof capability === 'string')
      : [];
    // The extension is talking again, so whatever went wrong before is no longer the current state.
    lastError = null;
    logInfo(
      `[ExternalMedia] extension ${extensionVersion ?? 'unknown'} connected with ${capabilities.length} capabilities`,
    );
    publishStatus();
  }

  function handleStateFrame(frame) {
    const observation = normalizeObservation(frame.observation);
    if (!observation) {
      // Do not trust the extension blindly: a frame we cannot read is dropped, and the previous
      // observation is left in place so a single bad frame does not blank the renderer.
      logWarn('[ExternalMedia] ignoring a state frame with a malformed observation');
      setLastError('the extension sent a state frame with a malformed observation', ERR_TRANSPORT_ERROR);
      publishStatus();
      return;
    }

    lastObservation = observation;
    // Arrival time on the bridge's own clock, deliberately not `observation.observedAtMs`: staleness
    // must not be something the extension can lie about by republishing an old timestamp.
    lastObservationAtMs = now();

    // Optional sibling field on the state frame (the observation shape itself has no error slot).
    // It is how "not signed in" / "storefront mismatch" reach the renderer as a passive state rather
    // than only as a command reply.
    const reportedKind = typeof frame.errorKind === 'string' ? frame.errorKind : null;
    if (reportedKind === null) {
      lastError = null;
    } else if (ERROR_KIND_SET.has(reportedKind)) {
      setLastError(STATE_ERROR_MESSAGES[reportedKind] ?? reportedKind, reportedKind);
    } else {
      logWarn('[ExternalMedia] state frame carries an unknown errorKind', reportedKind);
      lastError = null;
    }

    publishObservation(observation);
    publishStatus();
  }

  function handleResponseFrame(frame) {
    const id = typeof frame.id === 'string' ? frame.id : '';
    const pending = pendingCommands.get(id);
    if (!pending) {
      // Late (already timed out or failed) or unknown id. Logged, not surfaced: there is no caller
      // left to hand it to.
      logWarn('[ExternalMedia] response for an unknown or already settled command id', id);
      return;
    }
    pendingCommands.delete(id);
    if (pending.timer !== null) {
      clearTimeoutFn(pending.timer);
    }

    if (typeof frame.ok !== 'boolean') {
      // A reply we cannot read is a failed command, never a successful one.
      pending.resolve({
        ...commandFailure(
          pending.command.kind,
          ERR_TRANSPORT_ERROR,
          'the extension sent a malformed response frame',
        ),
        completedAtMs: now(),
      });
      return;
    }

    const errorKind = typeof frame.errorKind === 'string' ? frame.errorKind : null;
    if (errorKind !== null && !ERROR_KIND_SET.has(errorKind)) {
      // Passed through rather than coerced: an unknown kind is still the most useful diagnostic the
      // extension gave us, and the renderer's default branch handles it.
      logWarn('[ExternalMedia] response carries an unknown errorKind', errorKind);
    }

    pending.resolve({
      ok: frame.ok,
      command: pending.command.kind,
      targetSourceId: typeof frame.targetSourceId === 'string' ? frame.targetSourceId : null,
      error: frame.ok ? null : typeof frame.error === 'string' ? frame.error : null,
      errorKind: frame.ok ? null : errorKind,
      completedAtMs: now(),
    });
  }

  function handleSocketMessage(socket, data) {
    // A replaced socket can still deliver a queued frame; it belongs to a session that is over.
    if (extensionSocket !== socket) {
      return;
    }

    let frame = null;
    try {
      frame = JSON.parse(typeof data === 'string' ? data : String(data));
    } catch {
      frame = null;
    }

    if (!frame || typeof frame !== 'object' || Array.isArray(frame) || typeof frame.type !== 'string') {
      // Never throw on a bad frame: the extension is the untrusted side and a decode failure is a
      // dropped message, not a bridge fault.
      logWarn('[ExternalMedia] ignoring a frame that is not a JSON object with a type');
      setLastError('the extension sent a frame that is not a JSON object', ERR_TRANSPORT_ERROR);
      publishStatus();
      return;
    }

    switch (frame.type) {
      case 'hello':
        handleHelloFrame(frame);
        return;
      case 'state':
        handleStateFrame(frame);
        return;
      case 'response':
        handleResponseFrame(frame);
        return;
      case 'pong':
        // Liveness only. The value is not used for staleness (observations are), so it is not stored.
        return;
      default:
        // Forward compatibility: a future frame type from a newer extension is ignored, not fatal.
        logWarn('[ExternalMedia] ignoring an unknown frame type', frame.type);
    }
  }

  // Accepts one upgraded socket as the extension session. One extension at a time: a new connection
  // replaces the previous one, and the previous one is closed explicitly rather than left to linger.
  function handleSocketConnection(socket) {
    const previous = extensionSocket;
    if (previous && previous !== socket) {
      // The old session's in-flight commands can never be answered now.
      failPendingCommands(ERR_TRANSPORT_ERROR, 'the extension reconnected before it answered');
      // Drop the reference before closing so the old socket's close handler cannot mistake a
      // replacement for a disconnection and clear the new session.
      extensionSocket = null;
      extensionVersion = null;
      capabilities = [];
      closeSocket(previous, 1000, 'replaced by a new extension connection');
    }

    extensionSocket = socket;
    extensionVersion = null;
    capabilities = [];
    lastError = null;

    // Always attach an error handler: an 'error' event with no listener would throw in the process.
    // 'close' follows, and that is where the session is actually torn down.
    socket.on('error', (error) => {
      logWarn('[ExternalMedia] extension socket error', error);
    });
    socket.on('close', () => {
      handleSocketClosed(socket);
    });
    socket.on('message', (data) => {
      handleSocketMessage(socket, data);
    });

    // Sent immediately, before the extension introduces itself: it carries the protocol version and
    // the heartbeat cadence, which is what the extension needs to configure itself.
    sendFrame(socket, { type: 'welcome', version: PROTOCOL_VERSION, heartbeatIntervalMs });
    startHeartbeat();
    publishStatus();
  }

  function sendJson(res, statusCode, payload) {
    const body = JSON.stringify(payload);
    // No Access-Control-Allow-Origin on purpose. The only HTTP client is the extension, which is
    // exempt from CORS through its 127.0.0.1 host permission; a wildcard here would let any page in
    // any browser on this machine probe the bridge.
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  }

  function matchesBearerToken(req, requestUrl) {
    const requestToken = getBearerTokenFromRequest(req, requestUrl);
    return Boolean(requestToken && token && requestToken === token);
  }

  function handleHttpRequest(req, res) {
    try {
      const requestUrl = new URL(req?.url || '/', 'http://127.0.0.1');
      const method = typeof req?.method === 'string' ? req.method.toUpperCase() : 'GET';
      if (method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      if (requestUrl.pathname !== HEALTH_PATH && requestUrl.pathname !== STATUS_PATH) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      if (!matchesBearerToken(req, requestUrl)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      if (requestUrl.pathname === HEALTH_PATH) {
        // The extension's "are these port and token right?" probe.
        sendJson(res, 200, {
          ok: true,
          version: PROTOCOL_VERSION,
          sources: [SOURCE_APPLE_MUSIC_WEB],
          extensionConnected: isExtensionConnected(),
        });
        return;
      }
      sendJson(res, 200, getStatus());
    } catch (error) {
      logWarn('[ExternalMedia] HTTP request failed', error);
      try {
        sendJson(res, 500, { error: 'internal error' });
      } catch {
        // The response is already gone; nothing left to do.
      }
    }
  }

  function rejectUpgrade(socket, statusCode, message) {
    try {
      socket.write(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\n\r\n`);
    } catch {
      // The socket is already unusable.
    }
    try {
      socket.destroy();
    } catch {
      // Already destroyed.
    }
  }

  function handleWebSocketUpgrade(req, socket, head) {
    const requestUrl = new URL(req?.url || '/', 'http://127.0.0.1');
    if (requestUrl.pathname !== WS_PATH) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    if (!isAllowedExtensionOrigin(req?.headers?.origin)) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    if (!matchesBearerToken(req, requestUrl)) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }

    const activeWebSocketServer = webSocketServer;
    if (!activeWebSocketServer) {
      rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }

    activeWebSocketServer.handleUpgrade(req, socket, head, (webSocket) => {
      handleSocketConnection(webSocket);
    });
  }

  // Writes one command frame and resolves with the extension's structured reply. Never rejects: every
  // outcome — including "no extension is connected" — comes back as a value with `ok: false` and an
  // `errorKind`, so a caller has exactly one shape to handle.
  function sendCommand(rawCommand) {
    try {
      const validation = validateMediaCommand(rawCommand);
      if (validation.error) {
        // The allow-list boundary: a refused command is never written to the socket, so the
        // extension never sees a verb the bridge does not know how to reason about.
        return Promise.resolve(
          commandFailure(rawCommand?.kind ?? rawCommand?.command, ERR_INVALID_ARGUMENT, validation.error),
        );
      }
      const command = validation.command;

      if (!isExtensionConnected()) {
        // Refused rather than queued: replaying a transport command after a reconnect would act on a
        // player state the user has since changed.
        return Promise.resolve(
          commandFailure(
            command.kind,
            ERR_BRIDGE_UNAVAILABLE,
            extensionSocket ? 'the extension connection is not open' : 'no extension is connected',
          ),
        );
      }

      const socket = extensionSocket;
      const id = `m${++nextCommandId}`;

      return new Promise((resolve) => {
        const pending = { command, resolve, timer: null };
        pendingCommands.set(id, pending);

        if (Number.isFinite(commandTimeoutMs) && commandTimeoutMs > 0) {
          pending.timer = setTimeoutFn(() => {
            // Delete before resolving: the timeout path must not be re-entered by a late reply.
            if (pendingCommands.get(id) === pending) {
              pendingCommands.delete(id);
            }
            resolve({
              ...commandFailure(command.kind, ERR_TIMEOUT, `no response within ${commandTimeoutMs}ms`),
              completedAtMs: now(),
            });
          }, commandTimeoutMs);
        }

        try {
          socket.send(JSON.stringify({ type: 'command', id, command }));
        } catch (error) {
          pendingCommands.delete(id);
          if (pending.timer !== null) {
            clearTimeoutFn(pending.timer);
          }
          resolve({
            ...commandFailure(
              command.kind,
              ERR_TRANSPORT_ERROR,
              `the command could not be written to the extension: ${String(error?.message || error)}`,
            ),
            completedAtMs: now(),
          });
        }
      });
    } catch (error) {
      // Belt and braces: this function is documented as never rejecting, so even an unexpected throw
      // on the way in has to come back as a value.
      return Promise.resolve(
        commandFailure(
          rawCommand?.kind,
          ERR_TRANSPORT_ERROR,
          `the command could not be dispatched: ${String(error?.message || error)}`,
        ),
      );
    }
  }

  // Idempotent. Resolves once the server is listening; rejects if the port cannot be bound (the
  // caller decides whether that is fatal, and a second `start()` is free to try again).
  async function start() {
    if (listening) {
      return;
    }
    if (startPromise) {
      return startPromise;
    }

    const attempt = (async () => {
      try {
        const created = createServer((req, res) => {
          handleHttpRequest(req, res);
        });
        server = created;
        webSocketServer = webSocketServerFactory();
        created.on('upgrade', handleWebSocketUpgrade);

        await new Promise((resolve, reject) => {
          const onListenError = (error) => {
            created.off?.('error', onListenError);
            reject(error);
          };
          created.once('error', onListenError);
          created.listen(port, '127.0.0.1', () => {
            created.off?.('error', onListenError);
            resolve();
          });
        });

        listening = true;
        boundPort = getBoundPort();
        created.on('error', (error) => {
          // A post-listen server error does not take the bridge down; it is reported and the caller
          // can decide to stop and start again.
          logWarn('[ExternalMedia] server error', error);
          setLastError(String(error?.message || error), ERR_TRANSPORT_ERROR);
          publishStatus();
        });
        lastError = null;
        logInfo(`[ExternalMedia] bridge listening on http://127.0.0.1:${boundPort}`);
        publishStatus();
      } catch (error) {
        // Leave nothing half-open: a failed listen must be retryable.
        listening = false;
        server = null;
        webSocketServer = null;
        boundPort = null;
        setLastError(
          `the bridge could not listen on 127.0.0.1:${port}: ${String(error?.message || error)}`,
          ERR_BRIDGE_UNAVAILABLE,
        );
        publishStatus();
        throw error;
      }
    })();

    // The in-flight guard is cleared by whichever caller's `finally` runs first, which is why the
    // promise is stored here rather than inside the attempt.
    startPromise = attempt.finally(() => {
      startPromise = null;
    });
    return startPromise;
  }

  // Idempotent. Closes the extension socket, clears every timer, fails in-flight commands and closes
  // the server, so `stop()` followed by `start()` is a clean restart of the whole transport.
  async function stop() {
    stopHeartbeat();

    // The transport is going away, so no reply can arrive. These resolve (never reject) with a
    // structured failure, like every other outcome of `sendCommand`.
    failPendingCommands(ERR_BRIDGE_UNAVAILABLE, 'the bridge stopped before the command was answered');

    const socket = extensionSocket;
    extensionSocket = null;
    extensionVersion = null;
    capabilities = [];
    if (socket) {
      closeSocket(socket, 1001, 'the Folia bridge is stopping');
    }

    const activeWebSocketServer = webSocketServer;
    webSocketServer = null;
    if (activeWebSocketServer) {
      try {
        activeWebSocketServer.close();
      } catch (error) {
        logWarn('[ExternalMedia] failed to close the WebSocket server', error);
      }
    }

    const activeServer = server;
    server = null;
    listening = false;
    boundPort = null;
    if (activeServer) {
      await new Promise((resolve) => {
        try {
          activeServer.close(() => resolve());
        } catch {
          // Never listening, or already closed.
          resolve();
        }
      });
    }

    // The last observation is kept on purpose: it is history, and `isObservationStale` is what tells
    // the renderer it can no longer be trusted. `available: false` is the "the bridge is off" signal.
    publishStatus();
  }

  function getObservation() {
    return cloneObservation(lastObservation);
  }

  // Both subscription helpers return their own unsubscribe, so a renderer can wire them straight to a
  // React effect's cleanup.
  function onObservation(listener) {
    if (typeof listener !== 'function') {
      return () => {};
    }
    observationListeners.add(listener);
    return () => {
      observationListeners.delete(listener);
    };
  }

  function onStatusChanged(listener) {
    if (typeof listener !== 'function') {
      return () => {};
    }
    statusListeners.add(listener);
    return () => {
      statusListeners.delete(listener);
    };
  }

  return {
    start,
    stop,
    getPort: getBoundPort,
    getStatus,
    sendCommand,
    getObservation,
    onObservation,
    onStatusChanged,
  };
}

module.exports = {
  DEFAULT_EXTERNAL_MEDIA_PORT,
  PROTOCOL_VERSION,
  validateMediaCommand,
  createExternalMediaBridge,
};
