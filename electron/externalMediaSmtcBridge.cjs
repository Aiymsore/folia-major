// electron/externalMediaSmtcBridge.cjs
// Apple Music SMTC bridge: supervises the folia-apple-music-smtc-helper.exe child process and turns
// its JSONL stdout into a status object the main process can serve over IPC.
//
// The helper is the only thing that can talk to the Windows Runtime, so everything here is about
// supervision rather than SMTC itself:
//   * one supervised child, respawned when it dies or goes silent (its Heartbeat is the liveness
//     proof, exactly like the wallpaper helper's);
//   * Apple Music is NOT required for the helper to be healthy. "No Apple Music session" is a
//     normal state reported as `connected: false`, not a failure to restart away.
//
// Phase 2 adds the reverse direction: `sendCommand` writes one JSON request line ({id, command}) and
// resolves with the helper's structured `response` event carrying the same id. The channel is the
// helper's existing stdin — there is no second bridge and no second process.
//
// Two correctness rules for that channel:
//   * Every failure resolves with a structured `{ok:false, errorKind}` rather than rejecting, so a
//     caller has exactly one shape to handle. The kinds match the helper's own error kinds where the
//     failure came from Windows, and use bridge-local kinds (`helper-unavailable`, `timeout`,
//     `helper-exited`) where the request never reached the helper.
//   * Pending commands are failed immediately when the child dies. Queueing them across a respawn
//     would replay a transport command against a session state the user has since changed.
//
// All side effects (spawn, timers, clock) are injected so the supervision state machine can be
// unit-tested without a Windows host or a real helper binary — same approach as
// electron/windowsWallpaperController.cjs.

const SNAPSHOT_STALE_MS = 10_000;
const HELPER_HEARTBEAT_TIMEOUT_MS = 15_000;
const RESPAWN_DELAY_MS = 2_000;
const STOP_GRACE_MS = 1_500;
const COMMAND_TIMEOUT_MS = 5_000;

// Bridge-local failure kinds. Not shared with the helper on purpose: these mean the request never
// reached Windows, which the helper cannot know about.
const ERR_KIND_HELPER_UNAVAILABLE = 'helper-unavailable';
const ERR_KIND_HELPER_EXITED = 'helper-exited';
const ERR_KIND_TIMEOUT = 'timeout';

// Transport command names the bridge will forward. This is the allow-list boundary: a request that
// is not in here is refused here and never reaches the helper, so a compromised or buggy renderer
// cannot invent a new stdin verb. `seek` needs `positionMs`; the others must not carry one.
const COMMAND_NAMES = ['play', 'pause', 'toggle-play-pause', 'previous', 'next', 'seek'];
const COMMANDS_WITH_POSITION = ['seek'];
const MAX_SEEK_MS = 3_600_000;

// Parses one JSONL line from the helper. Kept side-effect free and exported for direct unit tests.
function parseHelperEventLine(line) {
  if (typeof line !== 'string' || line.trim() === '') {
    return null;
  }
  try {
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed.event === 'string') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

// Validates one renderer-supplied command request. Exported so the IPC handler and the unit tests
// share exactly one definition of what a well-formed request is.
//
// Returns `{ request }` or `{ error }`; it never throws, because a bad request is a value the caller
// reports back, not an exception that would surface as an IPC rejection.
function validateCommandRequest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'request must be an object' };
  }
  const { command } = raw;
  if (typeof command !== 'string' || !COMMAND_NAMES.includes(command)) {
    return { error: `unsupported command: ${String(command)}` };
  }

  const wantsPosition = COMMANDS_WITH_POSITION.includes(command);
  const hasPosition = raw.positionMs !== undefined && raw.positionMs !== null;
  if (wantsPosition && !hasPosition) {
    return { error: `${command} requires an integer positionMs` };
  }
  if (!wantsPosition && hasPosition) {
    return { error: `positionMs does not apply to ${command}` };
  }

  if (wantsPosition) {
    const { positionMs } = raw;
    if (typeof positionMs !== 'number' || !Number.isInteger(positionMs)) {
      return { error: `positionMs must be an integer, got: ${String(positionMs)}` };
    }
    if (positionMs < 0 || positionMs > MAX_SEEK_MS) {
      return { error: `positionMs must be between 0 and ${MAX_SEEK_MS}, got: ${positionMs}` };
    }
    return { request: { command, positionMs } };
  }

  return { request: { command } };
}

// The shape every command outcome has, success or failure, so a caller never has to branch on
// whether the promise resolved or rejected.
function commandFailure(command, errorKind, error) {
  return {
    ok: false,
    command: typeof command === 'string' ? command : '',
    targetAppUserModelId: null,
    error,
    errorKind,
    // Filled in by the bridge when a real clock is available; null keeps this serializable and
    // makes it obvious that the failure was produced here rather than by the helper.
    completedAtMs: null,
  };
}

// Empty status: the shape every consumer sees before the helper has said anything, and the shape
// the renderer clears itself to when the bridge is unavailable.
function emptyExternalMediaStatus() {
  return {
    bridgeAvailable: false,
    helperState: 'stopped',
    connected: false,
    sourceAppUserModelId: null,
    title: null,
    artist: null,
    album: null,
    playbackStatus: null,
    positionMs: null,
    durationMs: null,
    hasThumbnail: false,
    updatedAt: null,
    lastUpdatedAt: null,
    lastEventAt: null,
    sessionCount: null,
    lastCommand: null,
    lastError: null,
  };
}

function createExternalMediaSmtcBridge(options = {}) {
  const {
    spawnFn = require('child_process').spawn,
    logWarn = console.warn.bind(console),
    logError = console.error.bind(console),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    now = () => Date.now(),
    helperPath, // () => string | null, resolved lazily so a missing binary is not fatal at import
    heartbeatTimeoutMs = HELPER_HEARTBEAT_TIMEOUT_MS,
    respawnDelayMs = RESPAWN_DELAY_MS,
    stopGraceMs = STOP_GRACE_MS,
    commandTimeoutMs = COMMAND_TIMEOUT_MS,
    /**
     * AUMID substring the helper should match, passed through as `--match <value>`.
     *
     * The observation layer targets the **Chrome** session — the controller is a Chrome extension
     * driving music.apple.com, and an observer that watched a different media source than the
     * controller addresses would report a track nobody is hearing. `observer` and `controller` must
     * name the same source; see docs/external-media-backend.md ("拓扑").
     *
     * The helper's own default is `Chrome` for the same reason. A function is accepted so the value
     * can be resolved lazily and changed between restarts; returning null/'' omits the flag entirely
     * and keeps that default.
     *
     * NOTE: substring matching means a Chrome-scoped helper also sees non-Apple media in Chrome
     * (YouTube, etc). SMTC does not expose a URL, so this cannot be filtered at the helper. The
     * reconciliation layer (`utils/externalMediaQueueReconcile.ts`) is what decides whether an
     * observation belongs to Folia's queue; until it says so, an observation is not trusted.
     */
    matchSubstring = null,
    onStatusChanged = () => {},
  } = options;

  let child = null;
  let helperState = 'stopped'; // stopped | starting | running | missing
  let status = emptyExternalMediaStatus();
  let lastProcessedEventAt = 0;
  let stdoutBuffer = '';
  let watchdogTimer = null;
  let respawnTimer = null;
  let generation = 0;
  let disposed = false;
  let nextCommandId = 0;
  // id -> { command, resolve, timer }. A Map, not a queue: the helper may answer out of order, and
  // the id is the only thing that ties a response to its request.
  const pendingCommands = new Map();

  function publish(patch) {
    status = { ...status, ...patch, bridgeAvailable: true, helperState };
    onStatusChanged(getStatus());
  }

  function noteEvent() {
    lastProcessedEventAt = now();
  }

  // Fails every in-flight command. Used when the child dies, on disposal, and on timeout: in all
  // three cases the response can never arrive, and leaving the promises pending would make a
  // diagnostic surface look frozen rather than failed.
  function failPendingCommands(errorKind, message) {
    for (const [id, pending] of pendingCommands) {
      pendingCommands.delete(id);
      if (pending.timer !== null) {
        clearTimeoutFn(pending.timer);
      }
      pending.resolve({ ...commandFailure(pending.command, errorKind, message), completedAtMs: now() });
    }
  }

  // The helper's own response event, already validated as JSON by the line parser. The payload is
  // passed through rather than re-derived: the helper knows whether Windows accepted the call, and
  // the bridge must not second-guess it into a success.
  function handleCommandResponse(event) {
    const id = typeof event.id === 'string' ? event.id : '';
    const pending = pendingCommands.get(id);
    if (!pending) {
      // Late (already timed out) or unknown id. Logged, not surfaced: there is no caller left.
      logWarn('[ExternalMediaSmtc] response for unknown command id', id);
      return;
    }
    pendingCommands.delete(id);
    if (pending.timer !== null) {
      clearTimeoutFn(pending.timer);
    }

    const reply = {
      ok: event.ok === true,
      command: typeof event.command === 'string' ? event.command : pending.command,
      targetAppUserModelId:
        typeof event.targetAppUserModelId === 'string' ? event.targetAppUserModelId : null,
      error: typeof event.error === 'string' ? event.error : null,
      errorKind: typeof event.errorKind === 'string' ? event.errorKind : null,
      completedAtMs: Number.isFinite(event.completedAtMs) ? event.completedAtMs : now(),
    };
    // Kept on the status so the diagnostic UI can show the last outcome without subscribing to
    // anything extra, and so a test can assert what the helper actually answered.
    publish({ lastCommand: reply });
    pending.resolve(reply);
  }

  function applySnapshot(event) {
    publish({
      connected: true,
      sourceAppUserModelId: typeof event.sourceAppUserModelId === 'string' ? event.sourceAppUserModelId : null,
      title: event.title ?? null,
      artist: event.artist ?? null,
      album: event.album ?? null,
      playbackStatus: event.playbackStatus ?? null,
      positionMs: Number.isFinite(event.positionMs) ? event.positionMs : null,
      durationMs: Number.isFinite(event.durationMs) ? event.durationMs : null,
      hasThumbnail: event.hasThumbnail === true,
      updatedAt: Number.isFinite(event.updatedAtMs) ? event.updatedAtMs : null,
      lastUpdatedAt: Number.isFinite(event.lastUpdatedMs) ? event.lastUpdatedMs : null,
      lastEventAt: lastProcessedEventAt,
      lastError: null,
    });
  }

  // The helper emits no-session when Apple Music is not running. The bridge stays healthy and
  // running; only the payload is cleared, so a later session is reported without a respawn.
  function clearSession() {
    publish({
      connected: false,
      sourceAppUserModelId: null,
      title: null,
      artist: null,
      album: null,
      playbackStatus: null,
      positionMs: null,
      durationMs: null,
      hasThumbnail: false,
      updatedAt: null,
      lastUpdatedAt: null,
      lastEventAt: lastProcessedEventAt,
    });
  }

  function handleHelperEvent(event) {
    noteEvent();

    switch (event.event) {
      case 'ready':
        helperState = 'running';
        publish({
          sessionCount: Number.isFinite(event.sessionCount) ? event.sessionCount : null,
          lastError: null,
        });
        return;
      case 'snapshot':
        helperState = 'running';
        applySnapshot(event);
        return;
      case 'no-session':
        helperState = 'running';
        clearSession();
        return;
      case 'heartbeat':
        // Liveness only: refreshes lastEventAt and nothing else, so an idle Apple Music never
        // looks like a state change downstream.
        helperState = 'running';
        publish({ lastEventAt: lastProcessedEventAt });
        return;
      case 'response':
        // Not a state change: the command's own result is published above, and the session payload
        // is left alone so a transport command does not blank the read-only view.
        handleCommandResponse(event);
        return;
      case 'stopped':
        helperState = 'stopped';
        publish({ lastEventAt: lastProcessedEventAt });
        return;
      case 'error':
        publish({
          lastEventAt: lastProcessedEventAt,
          lastError: {
            message: typeof event.message === 'string' ? event.message : 'helper error',
            kind: typeof event.kind === 'string' ? event.kind : null,
          },
        });
        return;
      default:
        logWarn('[ExternalMediaSmtc] unknown helper event', event.event);
    }
  }

  // Splits the child's stdout into whole lines; a chunk can carry several events or half of one.
  function consumeStdout(chunk) {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const event = parseHelperEventLine(line);
      if (event) {
        handleHelperEvent(event);
      }
    }
  }

  function stopWatchdog() {
    if (watchdogTimer) {
      clearTimeoutFn(watchdogTimer);
      watchdogTimer = null;
    }
  }

  function armWatchdog() {
    stopWatchdog();
    watchdogTimer = setTimeoutFn(() => {
      watchdogTimer = null;
      // The helper is alive but silent past its heartbeat window. Kill and let the respawn path
      // restart it rather than reporting stale data forever.
      logWarn('[ExternalMediaSmtc] helper went silent; restarting');
      killHelper();
      scheduleRespawn();
    }, heartbeatTimeoutMs);
  }

  function scheduleRespawn() {
    if (disposed || respawnTimer) {
      return;
    }
    respawnTimer = setTimeoutFn(() => {
      respawnTimer = null;
      start();
    }, respawnDelayMs);
  }

  function killHelper() {
    stopWatchdog();
    const current = child;
    // Drop the reference first so the late `exit` event cannot mistake an intentional kill for a
    // crash and schedule a second respawn.
    child = null;
    // Nothing can be answered any more: the write below is the helper's last input, and it is not a
    // command. A pending promise must fail rather than wait for a response that cannot come.
    failPendingCommands(ERR_KIND_HELPER_EXITED, 'the helper was stopped before it answered');
    if (!current) {
      return;
    }
    // Report the gap honestly: the helper is gone right now, and only the respawn timer is
    // pending. Leaving the previous state in place made a killed-on-silence helper still read as
    // `starting`/`running` for the whole respawn delay.
    helperState = 'stopped';
    publish({});
    try {
      current.stdin?.write('stop\n');
    } catch {
      // helper already gone
    }
    setTimeoutFn(() => {
      try {
        current.kill();
      } catch {
        // already dead
      }
    }, stopGraceMs);
  }

  // Writes one request line and resolves with the helper's structured reply. Never rejects: every
  // outcome — including "the helper is not running" — comes back as a value with `ok: false` and an
  // `errorKind`, so a caller has exactly one shape to handle.
  function sendCommand(request, { timeoutMs = commandTimeoutMs } = {}) {
    const validation = validateCommandRequest(request);
    if (validation.error) {
      return Promise.resolve(commandFailure(request?.command, 'invalid-argument', validation.error));
    }
    const command = validation.request;

    // No child means the helper is stopped, starting or missing. The command is refused rather than
    // queued: replaying a transport command after a respawn would act on a session state the user
    // has since changed.
    if (!child || !child.stdin) {
      return Promise.resolve(
        commandFailure(command.command, ERR_KIND_HELPER_UNAVAILABLE, `the helper is ${helperState}`),
      );
    }

    const id = `c${++nextCommandId}`;
    const line = JSON.stringify({ id, ...command });

    return new Promise((resolve) => {
      const pending = { command: command.command, resolve, timer: null };
      pendingCommands.set(id, pending);

      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        pending.timer = setTimeoutFn(() => {
          // delete before resolving: the timeout handler must not be re-entered by the resolve path.
          if (pendingCommands.get(id) === pending) {
            pendingCommands.delete(id);
          }
          resolve(
            commandFailure(command.command, ERR_KIND_TIMEOUT, `no response within ${timeoutMs}ms`),
          );
        }, timeoutMs);
      }

      try {
        child.stdin.write(`${line}\n`);
      } catch (error) {
        pendingCommands.delete(id);
        if (pending.timer !== null) {
          clearTimeoutFn(pending.timer);
        }
        resolve(
          commandFailure(
            command.command,
            ERR_KIND_HELPER_UNAVAILABLE,
            `the request could not be written to the helper: ${String(error?.message || error)}`,
          ),
        );
      }
    });
  }

  function start() {
    if (disposed || child) {
      return helperState;
    }

    const resolved = typeof helperPath === 'function' ? helperPath() : helperPath;
    if (!resolved) {
      helperState = 'missing';
      publish({ lastError: { message: 'folia-apple-music-smtc-helper.exe not found', kind: 'helper-missing' } });
      return helperState;
    }

    const thisGeneration = ++generation;
    helperState = 'starting';
    stdoutBuffer = '';
    lastProcessedEventAt = now();
    publish({});

    let spawned;
    try {
      // `--match` is appended only when configured, so the un-retargeted case spawns the helper with
      // exactly the argument list it has always had.
      const matchValue = typeof matchSubstring === 'function' ? matchSubstring() : matchSubstring;
      const helperArgs = typeof matchValue === 'string' && matchValue.trim()
        ? ['watch', '--match', matchValue.trim()]
        : ['watch'];
      spawned = spawnFn(resolved, helperArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      // spawn throws synchronously on invalid arguments; without this the bridge would latch on a
      // child that never existed and never retry.
      logError('[ExternalMediaSmtc] helper spawn threw', error);
      helperState = 'stopped';
      publish({ lastError: { message: String(error?.message || error), kind: 'spawn-failed' } });
      scheduleRespawn();
      return helperState;
    }

    child = spawned;
    armWatchdog();

    spawned.stdout?.setEncoding?.('utf8');
    spawned.stdout?.on('data', (chunk) => {
      if (thisGeneration !== generation) {
        return;
      }
      consumeStdout(String(chunk));
      armWatchdog();
    });
    spawned.stderr?.setEncoding?.('utf8');
    spawned.stderr?.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) {
        logWarn('[ExternalMediaSmtc] helper stderr', text);
      }
    });
    spawned.on?.('error', (error) => {
      if (thisGeneration !== generation) {
        return;
      }
      logError('[ExternalMediaSmtc] helper process error', error);
      publish({ lastError: { message: String(error?.message || error), kind: 'process-error' } });
    });
    spawned.on?.('exit', (code, signal) => {
      // A superseded child's late exit must not touch the live session.
      if (thisGeneration !== generation) {
        return;
      }
      stopWatchdog();
      child = null;
      helperState = 'stopped';
      // The child is gone, so no in-flight command can be answered. Failing them here (rather than
      // on the next status read) is what keeps a diagnostic surface from waiting on a dead helper.
      failPendingCommands(
        ERR_KIND_HELPER_EXITED,
        `the helper exited (code=${code ?? 'null'} signal=${signal ?? 'null'}) before it answered`,
      );
      publish({
        lastError: code === 0 || signal === 'SIGTERM'
          ? status.lastError
          : { message: `helper exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`, kind: 'helper-exit' },
      });
      scheduleRespawn();
    });

    return helperState;
  }

  function getStatus() {
    const fresh = status.lastEventAt !== null && now() - status.lastEventAt <= heartbeatTimeoutMs;
    return {
      ...status,
      bridgeAvailable: helperState !== 'missing',
      isStale: !fresh,
      snapshotStaleMs: SNAPSHOT_STALE_MS,
    };
  }

  function dispose() {
    disposed = true;
    if (respawnTimer) {
      clearTimeoutFn(respawnTimer);
      respawnTimer = null;
    }
    killHelper();
  }

  return {
    start,
    dispose,
    killHelper,
    sendCommand,
    handleHelperEvent,
    consumeStdout,
    parseHelperEventLine,
    getStatus,
    createStatus: emptyExternalMediaStatus,
  };
}

module.exports = {
  SNAPSHOT_STALE_MS,
  HELPER_HEARTBEAT_TIMEOUT_MS,
  COMMAND_TIMEOUT_MS,
  COMMAND_NAMES,
  MAX_SEEK_MS,
  ERR_KIND_HELPER_UNAVAILABLE,
  ERR_KIND_HELPER_EXITED,
  ERR_KIND_TIMEOUT,
  parseHelperEventLine,
  validateCommandRequest,
  emptyExternalMediaStatus,
  createExternalMediaSmtcBridge,
};
