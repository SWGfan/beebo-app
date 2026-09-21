'use strict';
/*
 * beebo-game-client.js  —  "Away Play" joiner
 * ---------------------------------------------------------------------------
 * The other half of the Home Game Server "mc" data channel bridge in
 * beebo-rtc-host.js. That file lets a home PC BRIDGE a local Minecraft server
 * onto a WebRTC data channel. This file lets ANOTHER computer — a household
 * member's, or an invited friend's, running the Beebo desktop app anywhere on
 * the internet — join it, with no router or firewall changes on either side.
 *
 * It does this by reusing, byte-for-byte, the SAME signalling and connection
 * path that already gets Beebo video through NATs:
 *   1) POST /rtc/login     signs in exactly as a video viewer would (owner
 *                          email+password, a named member's own pass, or the
 *                          household pass) and gets a short-lived viewer token
 *                          plus Beebo's own STUN server.
 *   2) A werift RTCPeerConnection is offered STUN-only first (direct P2P).
 *      POST /rtc/offer, GET /rtc/poll?box=<viewerId>, POST /rtc/candidate:
 *      the exact same three calls and shapes the <name>.beebo.tv browser page
 *      and beebo-rtc-host.js already use.
 *   3) If that does not reach "connected" within CONNECT_TIMEOUT_MS, this
 *      calls POST /rtc/relay/credentials itself (with the viewer token, same
 *      as the browser page does) and retries the WHOLE offer with Beebo
 *      Relay's TURN servers added — the identical direct-then-Beebo-Relay
 *      fallback used for video, just for a different data channel.
 *
 * The only thing new is the DATA CHANNEL: labelled "mc" instead of "http", and
 * carrying no HTTP semantics at all — just raw bytes, multiplexed by an opaque
 * id per local TCP connection, using the exact same [uint16 idLen][id][bytes]
 * framing beebo-rtc-host.js already uses for chunked HTTP bodies (frame()/
 * unframe() below are copied from there on purpose: the two ends must agree
 * byte-for-byte, and copying is simpler than sharing a module across two
 * processes that may run on different computers, on different Beebo versions).
 *
 * What this process actually does: listen on 127.0.0.1:<port> (25565 by
 * default — Minecraft's own default port). Point an ordinary, UNMODIFIED
 * Minecraft client at "localhost" and it connects here; every byte is piped
 * to the "mc" channel; the home PC's beebo-rtc-host.js pipes it on to the
 * real Minecraft server. Neither side ever sees anything but a normal TCP
 * connection to "localhost" — the WebRTC hop in between is invisible to
 * Minecraft, which is what lets an UNMODIFIED client work at all.
 *
 * Config is environment variables, mirroring beebo-rtc-host.js's own contract:
 *   BEEBO_JOIN_NAME       the house to join, e.g. "samplehouse86" (required)
 *   BEEBO_JOIN_URL        override the origin (default https://<name>.beebo.tv)
 *   BEEBO_JOIN_EMAIL / BEEBO_JOIN_PASSWORD       the owner's own account, or
 *   BEEBO_JOIN_USERNAME / BEEBO_JOIN_PASSWORD    a named household member, or
 *   BEEBO_JOIN_HOUSEHOLD_PASS                    the shared household pass
 *   BEEBO_JOIN_LOCAL_PORT the local port to listen on (default 25565)
 *   BEEBO_JOIN_VERBOSE    "0" to quiet the one-line-per-event log (default on)
 */
const net = require('net');
const crypto = require('crypto');
const { RTCPeerConnection } = require('werift');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
function loadConfig() {
  const name = String(process.env.BEEBO_JOIN_NAME || '').trim().toLowerCase();
  const base = (process.env.BEEBO_JOIN_URL || (name ? `https://${name}.beebo.tv` : '')).replace(/\/+$/, '');
  // "0" is a real, useful value here (let the OS pick a free port — tests use
  // this so many can run at once without picking ports by hand); unset or
  // invalid falls back to Minecraft's own default port, 25565.
  const raw = process.env.BEEBO_JOIN_LOCAL_PORT;
  const port = raw === undefined || raw === '' ? 25565 : Number(raw);
  return {
    name, base,
    email: process.env.BEEBO_JOIN_EMAIL || '',
    password: process.env.BEEBO_JOIN_PASSWORD || '',
    username: process.env.BEEBO_JOIN_USERNAME || '',
    householdPass: process.env.BEEBO_JOIN_HOUSEHOLD_PASS || '',
    localPort: Number.isInteger(port) && port >= 0 && port < 65536 ? port : 25565,
    verbose: String(process.env.BEEBO_JOIN_VERBOSE || '1') !== '0',
  };
}
const CFG = loadConfig();
function log(...a) { if (CFG.verbose) console.log('[beebo-join]', ...a); }
function warn(...a) { console.error('[beebo-join]', ...a); }

// ---------------------------------------------------------------------------
// Worker calls — the exact same routes the video viewer page uses.
// ---------------------------------------------------------------------------
const API_TIMEOUT_MS = Number(process.env.BEEBO_JOIN_API_TIMEOUT_MS || 15000);
async function api(pathname, opts = {}) {
  const res = await fetch(CFG.base + pathname, Object.assign({}, opts, { signal: AbortSignal.timeout(API_TIMEOUT_MS) }));
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}
const postJson = (pathname, obj, headers = {}) => api(pathname, {
  method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers), body: JSON.stringify(obj),
});

// Which credentials to sign in with, in the order the Worker itself checks them.
function loginBody() {
  if (CFG.username && CFG.password) return { username: CFG.username, pass: CFG.password };
  if (CFG.householdPass) return { householdPass: CFG.householdPass };
  return { email: CFG.email, password: CFG.password };
}

async function login() {
  const { status, body } = await postJson('/rtc/login', loginBody());
  if (status !== 200 || !body || !body.token) {
    const err = new Error('sign-in failed: ' + status + ' ' + ((body && body.error) || ''));
    err.code = (body && body.error) || 'login_failed';
    throw err;
  }
  return body; // { token, iceServers: [stun...] }
}

// The same call the <name>.beebo.tv browser page makes for itself: Beebo
// Relay's own short-lived TURN credentials, keyed to this viewer token.
async function beeboRelayServers(token) {
  try {
    const { status, body } = await postJson('/rtc/relay/credentials', {}, { authorization: 'Bearer ' + token });
    if (status !== 200 || !body || !Array.isArray(body.iceServers)) return [];
    return body.iceServers;
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Wire framing — MUST match beebo-rtc-host.js's frame()/unframe() exactly.
// ---------------------------------------------------------------------------
function frame(id, payload) {
  const idBuf = Buffer.from(id, 'utf8');
  const head = Buffer.allocUnsafe(2 + idBuf.length);
  head.writeUInt16BE(idBuf.length, 0);
  idBuf.copy(head, 2);
  return Buffer.concat([head, payload]);
}
function unframe(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 2) return null;
  const idLen = buf.readUInt16BE(0);
  if (buf.length < 2 + idLen) return null;
  return { id: buf.subarray(2, 2 + idLen).toString('utf8'), payload: buf.subarray(2 + idLen) };
}
function sendControl(channel, obj) { try { channel.send(JSON.stringify(obj)); } catch {} }

// ---------------------------------------------------------------------------
// Connecting to the house: STUN-only first, Beebo Relay only if that fails.
// ---------------------------------------------------------------------------
const CONNECT_TIMEOUT_MS = Number(process.env.BEEBO_JOIN_CONNECT_TIMEOUT_MS || 10000);

// One attempt at a full offer/answer handshake with a given ICE server list.
// Resolves { pc, dc } once the "mc" channel is open, or null if it never gets
// there within CONNECT_TIMEOUT_MS (the caller decides what to try next).
function attempt(token, iceServers) {
  return new Promise((resolve) => {
    let settled = false, viewerId = null, pollTimer = null;
    const early = [];
    const pc = new RTCPeerConnection({ iceServers });
    const dc = pc.createDataChannel('mc');
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pollTimer) clearInterval(pollTimer);
      if (ok) resolve({ pc, dc }); else { try { pc.close(); } catch {} resolve(null); }
    };
    const timer = setTimeout(() => finish(false), CONNECT_TIMEOUT_MS);

    pc.onIceCandidate.subscribe((c) => {
      if (!c) return;
      const cand = { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex };
      if (viewerId) postJson('/rtc/candidate', { to: 'host', viewerId, token, candidate: cand }).catch(() => {});
      else early.push(cand);
    });
    const sub = dc.stateChanged || dc.onStateChange;
    if (sub && typeof sub.subscribe === 'function') sub.subscribe((s) => { if (s === 'open') finish(true); });

    (async () => {
      await pc.setLocalDescription(await pc.createOffer());
      const offer = await postJson('/rtc/offer', { token, sdp: pc.localDescription.sdp });
      if (offer.status !== 200 || !offer.body || !offer.body.viewerId) { finish(false); return; }
      viewerId = offer.body.viewerId;
      for (const c of early) postJson('/rtc/candidate', { to: 'host', viewerId, token, candidate: c }).catch(() => {});
      pollTimer = setInterval(async () => {
        if (settled) return;
        try {
          const r = await api('/rtc/poll?box=' + viewerId);
          for (const m of (r.body && r.body.msgs) || []) {
            if (m.type === 'answer' && m.sdp) await pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }).catch(() => {});
            else if (m.type === 'candidate' && m.candidate) await pc.addIceCandidate(m.candidate).catch(() => {});
          }
        } catch { /* try again next tick */ }
      }, 400);
    })().catch(() => finish(false));
  });
}

// A live session: the peer connection, its "mc" channel, and the local TCP
// sockets it is currently proxying (id -> net.Socket).
function makeSession(pc, dc) {
  const sockets = new Map();
  return { pc, dc, sockets };
}

let session = null;   // the current live session, or null
let connecting = null; // in-flight connect() promise, so concurrent joiners share it

async function connect() {
  const { token, iceServers } = await login();
  log('signed in to', CFG.name + '.beebo.tv — trying a direct connection first');
  let got = await attempt(token, iceServers);
  if (!got) {
    log('direct connection did not complete — trying Beebo Relay');
    const relayServers = await beeboRelayServers(token);
    got = await attempt(token, (iceServers || []).concat(relayServers));
  }
  if (!got) throw new Error('could not reach ' + CFG.name + '.beebo.tv (direct or Beebo Relay)');
  log('connected — bridging to local Minecraft clients on 127.0.0.1:' + CFG.localPort);
  const sess = makeSession(got.pc, got.dc);
  bindChannel(sess);
  session = sess;
  return sess;
}

// Only ever one connect attempt in flight: a burst of local Minecraft
// (re)connections all wait on the same handshake instead of racing it.
function ensureConnected() {
  if (session && session.pc.connectionState !== 'failed' && session.pc.connectionState !== 'closed') return Promise.resolve(session);
  if (connecting) return connecting;
  connecting = connect().catch((e) => { connecting = null; throw e; }).then((s) => { connecting = null; return s; });
  return connecting;
}

function teardown(sess) {
  if (session !== sess) return;
  session = null;
  for (const sock of sess.sockets.values()) { try { sock.destroy(); } catch {} }
  sess.sockets.clear();
  try { sess.pc.close(); } catch {}
}

function bindChannel(sess) {
  const sub = sess.dc.message || sess.dc.onMessage;
  if (sub && typeof sub.subscribe === 'function') sub.subscribe((data) => onHostMessage(sess, data));
  const csub = sess.pc.connectionStateChange;
  if (csub && typeof csub.subscribe === 'function') {
    csub.subscribe((state) => {
      if (state === 'failed' || state === 'closed' || state === 'disconnected') {
        log('connection to', CFG.name + '.beebo.tv', 'ended (' + state + ')');
        teardown(sess);
      }
    });
  }
}

// A control frame from the house: {kind:"close", id, reason} — the far side
// (the real Minecraft server, or the bridge itself) ended that connection.
function onHostMessage(sess, data) {
  if (Buffer.isBuffer(data) || data instanceof Uint8Array) return onHostData(sess, Buffer.from(data));
  if (typeof data !== 'string') return;
  let msg;
  try { msg = JSON.parse(data); } catch { return; }
  if (!msg || typeof msg !== 'object' || typeof msg.id !== 'string') return;
  if (msg.kind === 'close') {
    const sock = sess.sockets.get(msg.id);
    if (sock) { sess.sockets.delete(msg.id); try { sock.destroy(); } catch {} }
    if (msg.reason) log('server closed a connection:', msg.reason);
  }
}
function onHostData(sess, buf) {
  const f = unframe(buf);
  if (!f) return;
  const sock = sess.sockets.get(f.id);
  if (!sock) return;
  try { sock.write(f.payload); } catch {}
}

// ---------------------------------------------------------------------------
// The local side: an ordinary TCP listener a real Minecraft client connects to.
// ---------------------------------------------------------------------------
async function handleLocalConnection(sock) {
  let sess;
  try { sess = await ensureConnected(); } catch (e) { warn('could not connect:', e.message); try { sock.destroy(); } catch {} return; }
  const id = crypto.randomBytes(8).toString('hex');
  sess.sockets.set(id, sock);
  sendControl(sess.dc, { kind: 'open', id });
  sock.on('data', (chunk) => { try { sess.dc.send(frame(id, chunk)); } catch {} });
  const cleanup = () => {
    if (sess.sockets.get(id) !== sock) return;
    sess.sockets.delete(id);
    sendControl(sess.dc, { kind: 'close', id });
  };
  sock.once('close', cleanup);
  sock.once('error', cleanup);
}

function startLocalListener() {
  const server = net.createServer((sock) => { handleLocalConnection(sock); });
  server.on('error', (e) => warn('local listener error:', e.message));
  server.listen(CFG.localPort, '127.0.0.1', () => {
    // CFG.localPort may be 0 (let the OS pick); report the port it actually bound.
    log('ready — point your Minecraft client at "localhost" (port ' + server.address().port + ') to join ' + (CFG.name || '<name>') + '.beebo.tv');
  });
  return server;
}

async function main() {
  if (!CFG.name) { warn('No BEEBO_JOIN_NAME set (the house to join). Exiting.'); process.exit(2); }
  const hasCreds = (CFG.username && CFG.password) || CFG.householdPass || (CFG.email && CFG.password);
  if (!hasCreds) { warn('No sign-in provided. Set BEEBO_JOIN_EMAIL/BEEBO_JOIN_PASSWORD, BEEBO_JOIN_USERNAME/BEEBO_JOIN_PASSWORD, or BEEBO_JOIN_HOUSEHOLD_PASS. Exiting.'); process.exit(3); }
  startLocalListener();
}

if (require.main === module) main().catch((e) => { warn('fatal:', e.stack || e.message); process.exit(1); });

module.exports = {
  loadConfig, loginBody, frame, unframe, attempt, connect, ensureConnected, startLocalListener,
  CONNECT_TIMEOUT_MS,
  _resetForTests() { session = null; connecting = null; },
};
