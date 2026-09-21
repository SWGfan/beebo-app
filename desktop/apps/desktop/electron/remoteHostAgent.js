'use strict';
/*
 * remoteHostAgent.js
 * ---------------------------------------------------------------------------
 * Runs the PROVEN Beebo host agent (resources/beebo-rtc-host/beebo-rtc-host.js)
 * as a CHILD PROCESS of the Electron main process.
 *
 * WHY A CHILD PROCESS (and not the old hidden BrowserWindow):
 *   The host agent uses werift (a pure-JS WebRTC stack) to answer viewer
 *   PeerConnections directly. Video therefore flows PEER-TO-PEER:
 *
 *       home PC  ->  viewer      (media, over WebRTC/SCTP data channel)
 *
 *   Only the tiny sign-in / signaling handshake ever touches Cloudflare
 *   (the beebo.tv Worker). The bulk media NEVER passes through Cloudflare and
 *   there is NO cloud relay by default (STUN only), so the owner is never
 *   billed for people watching. This module does not change that protocol at
 *   all — it merely supervises the process that implements it.
 *
 * The agent is a plain CommonJS Node script. In a packaged Electron app the
 * Electron binary IS the Node runtime, so we launch it with
 * child_process.fork(..., { env: { ELECTRON_RUN_AS_NODE: '1', ... } }) which
 * tells Electron to behave as a bare Node process for the child.
 *
 * The agent is configured ENTIRELY through environment variables (its proven
 * contract — see beebo-rtc-host.js loadConfig()):
 *   BEEBO_NAME        the username -> registers https://<name>.beebo.tv
 *   BEEBO_HOST_TOKEN  the license/owner token string (contains the email)
 *   BEEBO_LOCAL_URL   the local media/library server, http://127.0.0.1:<port>
 * (We deliberately do NOT set BEEBO_HOST_CONFIG so file config can't override
 *  the values we pass. BEEBO_HOST_URL is left unset so the agent derives the
 *  origin from BEEBO_NAME, exactly as before.)
 *
 * No external npm deps here — only Node built-ins (child_process, path).
 */

const { fork } = require('child_process');
const path = require('path');

// Regex that matches the agent's success line, e.g.
//   [beebo-host] registered as samplehouse86.beebo.tv — viewers can now connect
// We capture the "<name>.beebo.tv" token to expose via status().
const REGISTERED_RE = /registered as (\S+)/;
// ...and its refusal line, e.g.  [beebo-host] register failed: 403 name_taken
// The Worker's error code is what the UI needs: without it a taken or reserved
// name looked exactly like "still connecting", for ever.
const REGISTER_FAILED_RE = /register failed: (\d{3}) ([a-z_]+)/;
// The agent's own-relay status lines: "relay ready: cloudflare, 5 address(es)",
// "relay failed: cloudflare_http_401", "relay configured: turn", "relay off".
const RELAY_RE = /\brelay (ready|failed|configured|off)(?::\s*([A-Za-z0-9_ ,()]+))?/;
// How often to check for a renewed licence token to hand the running agent.
const TOKEN_CHECK_MS = 60 * 1000;

/**
 * Create a supervisor for the bundled host agent.
 *
 * @param {object}   deps
 * @param {object}   deps.app          Electron `app` (needs .isPackaged).
 * @param {function} deps.getName      () => string username (may be '').
 * @param {function} deps.getToken     () => string|null license token (may be null).
 * @param {function} deps.getLocalPort () => number streamServer port.
 * @param {function} deps.getLicense   () => license module with .evaluate().
 * @param {function} [deps.log]        (msg:string) => void  optional logger.
 * @returns {{ start:Function, stop:Function, restart:Function, status:Function }}
 */
function createRemoteHost(deps) {
  const {
    app,
    getName,
    getToken,
    getLocalPort,
    getLicense,
    log: rawLog,
    onRegistered,   // optional (name) => void, once per fresh registration
    onProblem,      // optional (code) => void, when the Worker refuses the name/token
    getIcePorts,    // optional () => '47820-47829', the agent's fixed WebRTC UDP range
    agentSecret,    // optional string shared with streamServer: lets the agent vouch for viewer IPs
    onAgentMessage, // optional (msg) => void: the agent's relay usage / Beebo Relay status reports
    onConnection,   // optional ({ state: 'open'|'failed', path, provider }) => void: the Connection test
  } = deps || {};

  // --- resolve the bundled agent path -------------------------------------
  // This EXACT path is a contract with the packaging step: electron-builder
  // copies the agent (and its node_modules, incl. werift) into
  //   <resources>/beebo-rtc-host/beebo-rtc-host.js
  // In dev, `resources/` sits next to this file's parent (electron/..).
  const base = app && app.isPackaged
    ? process.resourcesPath
    : path.join(__dirname, '..', 'resources');
  const AGENT_SCRIPT = path.join(base, 'beebo-rtc-host', 'beebo-rtc-host.js');

  // --- internal state ------------------------------------------------------
  let child = null;               // the current ChildProcess, or null
  let intentionalStop = false;    // true while we deliberately stop()/restart()
  let registeredName = null;      // "<name>.beebo.tv" once the agent registers
  let currentName = '';           // the BEEBO_NAME we launched with
  let restartTimer = null;        // pending auto-restart timer
  let runStartedAt = 0;           // Date.now() when the current child spawned
  let stdoutBuf = '';             // line-buffering for child stdout
  let stderrBuf = '';             // line-buffering for child stderr
  let problem = null;             // last Worker refusal code, e.g. 'name_taken'
  let sentToken = null;           // the token the current child is using
  let tokenTimer = null;          // periodic renewed-token hand-over
  let portMap = null;             // the router's forward of the UDP range, for the agent
  let relayCfg = null;            // the owner's own relay (holds a secret: memory only, IPC only)
  let relayState = { state: 'off', detail: '' };  // from the agent's "relay ..." lines
  let relayPlan = null;           // { order: ['beebo','cloudflare'] } from relayPolicy.js, or null
  let gameCfg = null;             // { enabled, port } from gameHostIpc.js's Home Game Server, or null (off)
  const connections = new Map();  // viewerId -> { path: 'direct'|'relay', provider }, viewers connected now

  function noteConnection(m) {
    const id = String(m.viewerId || '').slice(0, 64);
    if (!id) return;
    if (m.state === 'open') {
      if (connections.size >= 50 && !connections.has(id)) return;
      connections.set(id, { path: m.path === 'relay' ? 'relay' : 'direct', provider: String(m.provider || '').replace(/[^a-z]/g, '').slice(0, 20) });
    } else {
      connections.delete(id);
    }
    // The Connection wizard's away-from-home test: how each viewer connected, or
    // that one never got through ('failed'). No viewer id is passed on.
    if (typeof onConnection === 'function' && (m.state === 'open' || m.state === 'failed')) {
      try { onConnection({ state: m.state, path: m.path === 'relay' ? 'relay' : 'direct', provider: String(m.provider || '').replace(/[^a-z]/g, '').slice(0, 20) }); } catch (e) { /* ignore */ }
    }
  }

  // Auto-restart backoff: 3s, doubling to a 60s cap. Reset after a healthy run.
  const BACKOFF_MIN_MS = 3000;
  const BACKOFF_MAX_MS = 60000;
  const HEALTHY_RUN_MS = 30000;   // a run lasting this long is "healthy"
  let backoffMs = BACKOFF_MIN_MS;

  function log(msg) {
    try { if (typeof rawLog === 'function') rawLog(String(msg)); } catch (e) { /* never throw from logging */ }
  }

  // Emit each complete line to log(); keep any trailing partial line buffered.
  function pump(prevBuf, chunk, onLine) {
    let buf = prevBuf + chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line.length) onLine(line);
    }
    return buf; // remaining partial line
  }

  function handleLine(line) {
    log('[remote-host] ' + line);
    // Detect the agent's success line and remember the registered name.
    // The agent prints the full "<name>.beebo.tv"; we store the BARE name so
    // consumers (the UI) can append ".beebo.tv" themselves without doubling it.
    try {
      const m = REGISTERED_RE.exec(line);
      if (m && m[1]) {
        registeredName = m[1].replace(/\.beebo\.tv$/i, '');
        problem = null;
        if (typeof onRegistered === 'function') { try { onRegistered(registeredName); } catch (e) { /* ignore */ } }
      }
      const rl = RELAY_RE.exec(line);
      if (rl) relayState = { state: rl[1] === 'ready' ? 'ready' : rl[1] === 'failed' ? 'failed' : rl[1] === 'off' ? 'off' : 'checking', detail: rl[2] || '' };
      const f = REGISTER_FAILED_RE.exec(line);
      if (f && f[2]) {
        const changed = problem !== f[2];
        problem = f[2];
        registeredName = null;
        if (changed && typeof onProblem === 'function') { try { onProblem(problem); } catch (e) { /* ignore */ } }
      }
    } catch (e) { /* ignore */ }
  }

  // Hand a renewed licence token to the running agent. Returns true if one was sent.
  function refreshToken() {
    try {
      const c = child;
      if (!c || !c.connected || typeof c.send !== 'function') return false;
      const t = safeCall(getToken, null);
      if (!t || t === sentToken) return false;
      c.send({ type: 'token', token: t });
      sentToken = t;
      log('[remote-host] handed the agent a renewed licence token');
      return true;
    } catch (e) {
      return false;
    }
  }
  // The router mapping of the agent's UDP range: { externalIp, localIp,
  // mappings:[{internal, external}] }, or null when there is none. The agent
  // advertises the public side as a candidate. Kept here so a restarted agent
  // gets it again.
  function sendPortMap() {
    try {
      const c = child;
      if (!c || !c.connected || typeof c.send !== 'function') return false;
      c.send(Object.assign({ type: 'portmap' }, portMap || { externalIp: '', mappings: [] }));
      return true;
    } catch (e) { return false; }
  }
  function setPortMap(pm) {
    const next = pm && pm.externalIp && Array.isArray(pm.mappings) && pm.mappings.length
      ? { externalIp: String(pm.externalIp), localIp: String(pm.localIp || ''), mappings: pm.mappings.map((m) => ({ internal: m.internal, external: m.external })) }
      : null;
    if (JSON.stringify(next) === JSON.stringify(portMap)) return;
    portMap = next;
    sendPortMap();
  }

  // The owner's own relay, or null for none (the default). It carries a secret,
  // so it only ever travels over the IPC channel, never the child's environment.
  function sendRelay() {
    try {
      const c = child;
      if (!c || !c.connected || typeof c.send !== 'function') return false;
      c.send({ type: 'relay', relay: relayCfg });
      return true;
    } catch (e) { return false; }
  }
  function setRelay(cfg) {
    const next = cfg && (cfg.kind === 'cloudflare' || cfg.kind === 'turn') ? cfg : null;
    if (JSON.stringify(next) === JSON.stringify(relayCfg)) return;
    relayCfg = next;
    relayState = { state: next ? 'checking' : 'off', detail: '' };
    sendRelay();
  }

  // Which relay providers new connections try, in order (relayController.js).
  function sendRelayPlan() {
    try {
      const c = child;
      if (!c || !c.connected || typeof c.send !== 'function') return false;
      c.send({ type: 'relayPlan', plan: relayPlan });
      return true;
    } catch (e) { return false; }
  }
  function setRelayPlan(plan) {
    const next = plan && Array.isArray(plan.order) ? { order: plan.order.map(String) } : null;
    if (JSON.stringify(next) === JSON.stringify(relayPlan)) return;
    relayPlan = next;
    sendRelayPlan();
  }

  // Home Game Server (gameHostIpc.js): whether a local Minecraft server is
  // running right now, and which local port it listens on. The agent bridges
  // its "mc" data channel to 127.0.0.1:<port> only while enabled, so a house
  // that never turned Home Game Server on never opens a socket toward it.
  function sendGame() {
    try {
      const c = child;
      if (!c || !c.connected || typeof c.send !== 'function') return false;
      c.send({ type: 'game', game: gameCfg || { enabled: false, port: 25565 } });
      return true;
    } catch (e) { return false; }
  }
  function setGame(cfg) {
    const port = Number(cfg && cfg.port);
    const next = { enabled: !!(cfg && cfg.enabled), port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 25565 };
    if (JSON.stringify(next) === JSON.stringify(gameCfg)) return;
    gameCfg = next;
    sendGame();
  }

  function startTokenTimer() {
    if (tokenTimer) return;
    tokenTimer = setInterval(refreshToken, TOKEN_CHECK_MS);
    if (tokenTimer && typeof tokenTimer.unref === 'function') tokenTimer.unref();
  }
  function stopTokenTimer() {
    if (tokenTimer) { try { clearInterval(tokenTimer); } catch (e) { /* ignore */ } tokenTimer = null; }
  }

  function clearRestartTimer() {
    if (restartTimer) {
      try { clearTimeout(restartTimer); } catch (e) { /* ignore */ }
      restartTimer = null;
    }
  }

  function scheduleRestart() {
    // Never spin-loop: always wait at least backoffMs before respawning.
    clearRestartTimer();
    const delay = backoffMs;
    log('[remote-host] scheduling restart in ' + Math.round(delay / 1000) + 's');
    // Grow backoff for the NEXT failure (capped). A healthy run resets it (below).
    backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      try { start(); } catch (e) { log('[remote-host] restart error: ' + (e && e.message)); }
    }, delay);
  }

  // ------------------------------------------------------------------------
  // start(): spawn the agent if all preconditions are met.
  // ------------------------------------------------------------------------
  function start() {
    try {
      // Single instance: never run two agents (would double-register).
      if (child) return;

      // Resolve name + token. If either is missing the app may be signed out
      // or not yet licensed — do nothing quietly.
      const name = safeCall(getName, '');
      const token = safeCall(getToken, null);
      if (!name || !token) {
        log('[remote-host] not starting: ' + (!name ? 'no name' : 'no token'));
        return;
      }

      // No blanket paid-remote gate here any more: a household with no active plan is
      // still entitled to FREE away-from-home access when it connects directly or
      // through its own relay (see awayQualityPolicy.isFreeRemoteConnection in
      // streamServer.js), and this agent has to be running for that to work at all -
      // it does the signaling AND carries the P2P/own-relay media itself. Blocking
      // the agent from starting at all whenever there's no active plan would have
      // wrongly denied that free tier too. The real subscription check now lives
      // exactly where Beebo's own relay would actually cost money: TURN-credential
      // issuance (worker/relay.js's /relay/credentials) and, per HTTP request,
      // streamServer.js's license gate and away-quality cap, both of which only
      // apply once a connection is confirmed to be using Beebo's own relay.

      const port = Number(safeCall(getLocalPort, 47811)) || 47811;
      const localUrl = 'http://127.0.0.1:' + port;

      currentName = name;
      registeredName = null; // reset until the fresh child registers
      connections.clear();
      stdoutBuf = '';
      stderrBuf = '';

      log('[remote-host] launching agent ' + AGENT_SCRIPT + ' name=' + name + ' local=' + localUrl);

      const c = fork(AGENT_SCRIPT, [], {
        env: {
          ...process.env,
          // Make Electron run the child as a plain Node process.
          ELECTRON_RUN_AS_NODE: '1',
          // The proven env-var contract of beebo-rtc-host.js:
          BEEBO_NAME: name,
          BEEBO_HOST_TOKEN: token,
          BEEBO_LOCAL_URL: localUrl,
          // The fixed UDP range; the router is asked to forward the same one.
          BEEBO_ICE_PORTS: String(safeCall(getIcePorts, '') || process.env.BEEBO_ICE_PORTS || '47820-47829'),
          // Proves to the local server that a viewer-IP header came from this
          // agent. Only ever sent to BEEBO_LOCAL_URL; never logged.
          BEEBO_AGENT_SECRET: typeof agentSecret === 'string' ? agentSecret : '',
        },
        // Pipe stdout/stderr so we can mirror the agent's logs; keep an IPC
        // channel open (fork requires it) even though we don't send messages.
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      child = c;
      sentToken = token;
      startTokenTimer();
      if (portMap) sendPortMap();
      if (relayCfg) sendRelay();
      if (relayPlan) sendRelayPlan();
      if (gameCfg) sendGame();

      runStartedAt = Date.now();
      intentionalStop = false;

      // All handlers below reference the LOCAL `c`, and no-op if `c` is no
      // longer the current child. This prevents a just-replaced (stop()/
      // restart()) child's delayed 'exit' from nulling the new child or
      // scheduling a duplicate spawn -> which would double-register the name.
      if (c.stdout) {
        c.stdout.setEncoding('utf8');
        c.stdout.on('data', (chunk) => { if (child === c) stdoutBuf = pump(stdoutBuf, chunk, handleLine); });
      }
      if (c.stderr) {
        c.stderr.setEncoding('utf8');
        c.stderr.on('data', (chunk) => { if (child === c) stderrBuf = pump(stderrBuf, chunk, handleLine); });
      }

      // Relay usage and Beebo Relay status from the agent. Only these two types,
      // and only from the current child.
      c.on('message', (m) => {
        if (child !== c || !m) return;
        if (m.type === 'connection') { noteConnection(m); return; }
        if (m.type !== 'relayUsage' && m.type !== 'relayStatus') return;
        if (typeof onAgentMessage === 'function') { try { onAgentMessage(m); } catch (e) { /* ignore */ } }
      });

      c.on('error', (err) => {
        // e.g. EACCES/EAGAIN before the process ever runs — these emit 'error'
        // with NO following 'exit', which would leave `child` truthy forever and
        // block every future start(). So clear it and schedule a retry ourselves.
        log('[remote-host] child error: ' + (err && err.message));
        if (child !== c) return;
        child = null;
        registeredName = null;
        connections.clear();
        if (!intentionalStop) scheduleRestart();
      });

      c.on('exit', (code, signal) => {
        const ranMs = Date.now() - runStartedAt;
        log('[remote-host] agent exited code=' + code + ' signal=' + signal + ' after ' + Math.round(ranMs / 1000) + 's');

        // If this isn't the current child (we already stopped/replaced it),
        // do nothing: the newer child owns the shared state now.
        if (child !== c) return;

        child = null;
        registeredName = null;
        connections.clear();

        // A healthy run means our backoff can reset to the minimum.
        if (ranMs > HEALTHY_RUN_MS) backoffMs = BACKOFF_MIN_MS;

        // Auto-restart only if we did NOT ask it to stop.
        if (!intentionalStop) {
          scheduleRestart();
        }
      });
    } catch (e) {
      // Never throw out of start().
      log('[remote-host] start() failed: ' + (e && e.message));
      child = null;
    }
  }

  // ------------------------------------------------------------------------
  // stop(): intentional shutdown — kill the child, cancel any restart.
  // ------------------------------------------------------------------------
  function stop() {
    try {
      intentionalStop = true;
      clearRestartTimer();
      stopTokenTimer();
      problem = null;
      backoffMs = BACKOFF_MIN_MS; // fresh backoff for the next start()
      registeredName = null;
      connections.clear();
      if (child) {
        const c = child;
        child = null;
        try { c.kill(); } catch (e) { /* ignore */ }
      }
    } catch (e) {
      log('[remote-host] stop() failed: ' + (e && e.message));
    }
  }

  // ------------------------------------------------------------------------
  // restart(): used when the username or license changes.
  // ------------------------------------------------------------------------
  function restart() {
    try {
      stop();
      // intentionalStop is set by stop(); clear it so the fresh child's exit
      // will auto-restart normally.
      intentionalStop = false;
      start();
    } catch (e) {
      log('[remote-host] restart() failed: ' + (e && e.message));
    }
  }

  // ------------------------------------------------------------------------
  // status(): snapshot for the IPC handler / UI.
  // ------------------------------------------------------------------------
  function status() {
    try {
      const name = safeCall(getName, '') || currentName || '';
      const hostname = name ? name + '.beebo.tv' : '';
      const running = !!child;
      return {
        running,
        name,
        hostname,
        registeredName,                       // "<name>.beebo.tv" or null
        online: running && !!registeredName,  // truly serving viewers
        problem,                              // e.g. 'name_taken', or null
        relay: relayCfg ? { kind: relayCfg.kind, state: relayState.state, detail: relayState.detail } : { kind: '', state: 'off', detail: '' },
        connection: running ? connectionText([...connections.values()]) : '',
        game: gameCfg || { enabled: false, port: 25565 },
      };
    } catch (e) {
      return { running: false, name: '', hostname: '', registeredName: null, online: false, problem: null };
    }
  }

  // Call a possibly-undefined dependency safely, returning `fallback` on error.
  function safeCall(fn, fallback) {
    try {
      return typeof fn === 'function' ? fn() : fallback;
    } catch (e) {
      return fallback;
    }
  }

  return { start, stop, restart, status, refreshToken, setPortMap, setRelay, setRelayPlan, setGame };
}

// One short line for the viewers connected right now: '' when nobody is,
// "Direct connection" / "Through Beebo Relay" for one, and a count for several.
function pathLabel(c) {
  if (!c || c.path !== 'relay') return 'Direct connection';
  if (c.provider === 'beebo') return 'Through Beebo Relay';
  if (c.provider === 'cloudflare') return 'Through your Cloudflare relay';
  if (c.provider === 'custom') return 'Through your relay';
  return 'Through a relay';
}
function connectionText(list) {
  const items = Array.isArray(list) ? list : [];
  if (!items.length) return '';
  if (items.length === 1) return pathLabel(items[0]);
  const counts = new Map();
  for (const c of items) { const l = pathLabel(c); counts.set(l, (counts.get(l) || 0) + 1); }
  const parts = [...counts.entries()].map(([l, n]) => n + ' ' + (l === 'Direct connection' ? 'direct' : l.charAt(0).toLowerCase() + l.slice(1)));
  return items.length + ' viewers: ' + parts.join(', ');
}

module.exports = { createRemoteHost, connectionText };
