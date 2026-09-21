'use strict';
/*
 * Beebo host agent  —  makes  <name>.beebo.tv  work.
 * ---------------------------------------------------------------------------
 * The Worker (beebo.tv) serves a browser page at <name>.beebo.tv that:
 *   1) signs the viewer in     (POST /rtc/login)
 *   2) opens a WebRTC PeerConnection to THIS machine (the "host")
 *   3) opens a DataChannel labelled "http" and, via a service worker, tunnels
 *      ordinary HTTP range requests for the media library over that channel.
 *
 * Nothing on the PC currently answers those connections, so the page always
 * says the Beebo "isn't online". THIS program is the missing host half. It:
 *   A) registers + heartbeats with the Worker  (POST /rtc/register) so the
 *      viewer's  POST /rtc/offer  stops returning host_offline,
 *   B) polls  GET /rtc/poll?box=host  for viewer offers + ICE candidates,
 *   C) answers each offer with a werift RTCPeerConnection, and
 *   D) BRIDGES the "http" DataChannel to the local media server
 *      (http://127.0.0.1:47811) — every {kind:"req"} becomes a real local
 *      HTTP request whose response is streamed back over the channel.
 *
 * The media therefore flows  home PC -> viewer  peer-to-peer. The Worker only
 * ever shuttles tiny JSON signaling blobs; VIDEO NEVER PASSES THROUGH CLOUDFLARE.
 *
 * Pure-JS (werift) — no native build step, no ffmpeg, no transcoding: the
 * existing local media server already does range/seek/any-codec, and we just
 * proxy it byte-for-byte.
 *
 * Wire protocol (must match the Worker's VIEWER_HTML + SW_JS exactly):
 *   viewer -> host (text) : {kind:"req",  id, method, path, range, ctype, cookie, body(base64)}
 *                           {kind:"abort", id}
 *   host -> viewer (text) : {kind:"head", id, status, ctype, clen, crange, setcookie, location}
 *                           {kind:"end",  id}
 *                           {kind:"err",  id, status}
 *   host -> viewer (bin)  : [uint16 idLen big-endian][id utf8][payload bytes]
 * Version 2 (the phone app) adds a hello handshake, request headers, chunked
 * request bodies and fuller response heads; see "The HTTP-over-DataChannel
 * bridge" below. The browser page never says hello and sees no change.
 *
 * A SECOND kind of channel, labelled "mc", carries the Home Game Server
 * feature (a local Minecraft server) the exact same way, minus the HTTP
 * semantics: it is a raw byte pipe to 127.0.0.1:<game port> instead of an
 * HTTP bridge to 127.0.0.1:47811. Everything about FINDING the connection
 * (register/poll/offer/answer/candidates, STUN-then-Beebo-Relay, the fixed
 * UDP range, the meter) is identical and shared with the "http" channel
 * above; see "The Home Game Server bridge" below.
 */

// SOURCE OF TRUTH: the copy in the repository, desktop/apps/desktop/resources/
// beebo-rtc-host/beebo-rtc-host.js. Build-AlwaysOn-Installer.bat robocopies
// the developer's separate working copy over that folder before every build, so copy this
// file back to that working copy BEFORE building, or the build ships the older agent. The agent is deliberately one file so that copy is one file.
const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');
const net = require('net');
const { RTCPeerConnection } = require('werift');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// The UDP ports WebRTC uses on this PC. werift otherwise picks a random port for
// every viewer, on every network adapter, so "open a port on your router" had
// nothing to point at. werift has no single-port ICE mux: each viewer's
// connection needs its own socket. So a small fixed range, one port per viewer,
// bound to the one LAN address that faces the internet. 47820-47829 sits next
// to Beebo's TCP 47811 (media server) and 47812 (hub) without touching them,
// and is outside Windows' ephemeral range (49152+). Ten viewers at once; an
// eleventh still connects, on a random port, exactly as before this change.
const DEFAULT_ICE_PORTS = '47820-47829';

// "47820-47829", "47820" (one port), or "0" / "off" / "" for werift's random ports.
function parsePortRange(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s || s === '0' || s === 'off' || s === 'random') return null;
  const m = /^(\d{1,5})(?:\s*-\s*(\d{1,5}))?$/.exec(s);
  if (!m) return null;
  const min = Number(m[1]), max = m[2] ? Number(m[2]) : min;
  if (min < 1024 || max > 65535 || max < min || max - min > 199) return null;
  return { min, max };
}

function loadConfig() {
  // Precedence: env vars > config file > sensible defaults.
  const cfgFile = process.env.BEEBO_HOST_CONFIG || path.join(__dirname, 'beebo-rtc-host.config.json');
  let file = {};
  try { file = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch {}

  const name = process.env.BEEBO_NAME || file.name || '';           // e.g. "samplehouse86"
  // The base we talk to. Must be the <name>.beebo.tv origin so the Worker
  // derives the right subdomain from the Host header.
  const base = (process.env.BEEBO_HOST_URL || file.base ||
    (name ? `https://${name}.beebo.tv` : '')).replace(/\/+$/, '');
  const local = (process.env.BEEBO_LOCAL_URL || file.local || 'http://127.0.0.1:47811').replace(/\/+$/, '');
  let token = process.env.BEEBO_HOST_TOKEN || file.token || '';
  if (!token) token = discoverToken() || '';

  const icePortsRaw = process.env.BEEBO_ICE_PORTS !== undefined ? process.env.BEEBO_ICE_PORTS
    : (file.icePorts !== undefined ? file.icePorts : DEFAULT_ICE_PORTS);

  // From the app that spawned us, never from the config file: it lets the local
  // server believe the viewer address this agent passes on (X-Beebo-Viewer-Ip).
  const agentSecret = String(process.env.BEEBO_AGENT_SECRET || '');
  delete process.env.BEEBO_AGENT_SECRET;

  return {
    name, base, local, token, agentSecret,
    icePorts: parsePortRange(icePortsRaw),
    // BEEBO_FORCE_RELAY=1: answer with relay candidates only, so a connection that
    // could have gone direct is made to use the relay instead. For testing that the
    // relay really carries video, and for a house whose direct path is unreliable.
    forceRelay: String(process.env.BEEBO_FORCE_RELAY || file.forceRelay || '') === '1',
    // BEEBO_LOG_REQUESTS=1: one line per request through the tunnel (what was asked
    // for, what came back, how much and how long). For working out why a video
    // stalls after a seek. Paths only - never tokens, never anything about who.
    logRequests: String(process.env.BEEBO_LOG_REQUESTS || file.logRequests || '') === '1',
    registerEveryMs: Number(process.env.BEEBO_REGISTER_MS || file.registerEveryMs || 60000),
    pollEveryMs: Number(process.env.BEEBO_POLL_MS || file.pollEveryMs || 8000),
    chunkBytes: Number(process.env.BEEBO_CHUNK || file.chunkBytes || 16384),
    // Kept small on purpose: everything shares one data channel, so a big backlog
    // delays the viewer's own "stop that" and "give me this instead" messages too.
    maxBuffered: Number(process.env.BEEBO_MAX_BUFFERED || file.maxBuffered || 256 * 1024),
    verbose: String(process.env.BEEBO_VERBOSE || file.verbose || '1') !== '0',
  };
}

/*
 * Best-effort: read the account token the desktop app already stored after the
 * owner signed in, so the host can register without re-entering a password.
 * The Electron app persists it in its userData (electron-store style JSON).
 * We scan the likely files for a JWT-shaped ("a.b.c") string under common keys.
 */
function discoverToken() {
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const candidates = [
    path.join(roaming, 'beebo entertainment', 'config.json'),
    path.join(roaming, 'beeboentertainment-desktop', 'config.json'),
    path.join(roaming, 'Beebo Entertainment', 'config.json'),
    path.join(roaming, 'beebo-entertainment', 'config.json'),
    path.join(os.homedir(), '.beebo', 'account.json'),
  ];
  const keyHints = ['token', 'accountToken', 'authToken', 'licenseToken', 'jwt', 'sessionToken', 'beeboToken'];
  // Beebo license tokens are  base64url(payload).base64url(ed25519 sig)  — TWO
  // parts (not a 3-part JWT). Accept 2 parts, or 3 for safety, min lengths so we
  // don't match a stray "a.b".
  const tokLike = /^[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}(\.[A-Za-z0-9_-]+)?$/;
  for (const f of candidates) {
    let obj;
    try { obj = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    // Fast path: the desktop app stores it at electron-store key "license.token".
    if (obj && obj.license && typeof obj.license.token === 'string' && tokLike.test(obj.license.token)) return obj.license.token;
    if (typeof obj['license.token'] === 'string' && tokLike.test(obj['license.token'])) return obj['license.token'];
    // direct key hits (top-level or one level deep)
    const stack = [obj];
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object') continue;
      for (const k of Object.keys(cur)) {
        const v = cur[k];
        if (typeof v === 'string' && (keyHints.includes(k) || /token/i.test(k)) && tokLike.test(v)) return v;
        if (v && typeof v === 'object') stack.push(v);
      }
    }
  }
  return null;
}

const CFG = loadConfig();
function log(...a) { if (CFG.verbose) console.log('[beebo-host]', ...a); }
function warn(...a) { console.error('[beebo-host]', ...a); }
// diag() used to sync-append every bridged POST to a hard-coded local path.
// It grew past a megabyte on the developer's machine and would have been a
// silent no-op (or worse, a stray file) on anyone else's. Kept as a no-op so the
// call sites need no edit; `verbose` logging is the supported way to look inside.
function diag() {}

// ---------------------------------------------------------------------------
// Worker signaling helpers
// ---------------------------------------------------------------------------
// Every signalling call gets a deadline. fetch() has none of its own, and after a
// sleep or a Wi-Fi change a request can hang for minutes: the poll loop awaits
// it, so the house kept heartbeating "online" while nobody read the offers.
const API_TIMEOUT_MS = Number(process.env.BEEBO_API_TIMEOUT_MS || 15000);

// `signed` adds the licence token as a Bearer header. The Worker uses it to keep
// the host mailbox (every viewer's offer) readable only by this house.
// `opts.timeoutMs` shortens the deadline for calls that must not hold a viewer up.
async function api(pathname, opts = {}, signed = false) {
  const url = CFG.base + pathname;
  const headers = Object.assign({}, opts.headers || {});
  if (signed && CFG.token) headers.authorization = 'Bearer ' + CFG.token;
  const { timeoutMs, ...rest } = opts;
  const res = await fetch(url, Object.assign({}, rest, { headers, signal: AbortSignal.timeout(Number(timeoutMs) > 0 ? Number(timeoutMs) : API_TIMEOUT_MS) }));
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

// Beebo's own coturn on OVH answers STUN on 3478 (no credentials); it replaced
// Cloudflare's public stun.cloudflare.com (docs/LEAVING-CLOUDFLARE.md).
const DEFAULT_STUN_URL = 'stun:relay1.beebo.tv:3478';
let iceServers = [{ urls: DEFAULT_STUN_URL }];
let registeredName = '';
let registered = false;

// Belt as well as braces on "video never crosses Cloudflare". The worker is built
// to hand back STUN only, but this end refuses a relay even if one ever appears:
// a turn:/turns: entry is an offer to carry the film through somebody else's
// network, and this house does not take one from here. (The owner's OWN relay,
// if they set one up on this PC, is separate: see setRelay. So is Beebo Relay,
// which has its own route and account switch: see beeboIceServers.) STUN only helps the two ends find
// each other; no media passes through it.
function noRelay(list) {
  const keep = [];
  for (const e of list || []) {
    const urls = typeof e.urls === 'string' ? [e.urls] : (e.urls || []);
    const clean = urls.filter((u) => !/^turns?:/i.test(String(u)));
    if (clean.length) keep.push({ urls: clean.length === 1 ? clean[0] : clean });
  }
  return keep.length ? keep : [{ urls: DEFAULT_STUN_URL }];
}

async function register() {
  if (!CFG.base || !CFG.token) {
    warn('missing base URL or token — cannot register. base=', CFG.base, 'hasToken=', !!CFG.token);
    return false;
  }
  try {
    const { status, body } = await api('/rtc/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: CFG.token }),
      // Signed: tells the Worker this agent signs every mailbox call, so the
      // host mailbox locks to signed reads from registration on.
    }, true);
    if (status === 200 && body && body.ok) {
      if (Array.isArray(body.iceServers) && body.iceServers.length) iceServers = noRelay(body.iceServers);
      if (!registered) log(`registered as ${body.name}.beebo.tv — viewers can now connect`);
      if (typeof body.name === 'string') registeredName = body.name;
      registered = true;
      return true;
    }
    warn('register failed:', status, body && (body.error || JSON.stringify(body)));
    registered = false;
    return false;
  } catch (e) {
    warn('register error:', e.message);
    return false;
  }
}

// viewerId -> { pc, channel }
const sessions = new Map();

// ---------------------------------------------------------------------------
// Fixed UDP ports, and the router's public mapping of them
// ---------------------------------------------------------------------------
// The supervisor (main process) asks the router to forward the range and hands
// the answer over IPC: { externalIp, localIp, mappings: [{ internal, external }] }.
let portMap = null;

// The local address the OS would use to reach `target`. connect() on a UDP socket
// does a route lookup without sending a packet.
function routeSource(type, target) {
  return new Promise((resolve) => {
    let sock, done = false;
    const finish = (v) => { if (done) return; done = true; try { sock.close(); } catch {} resolve(v || ''); };
    try { sock = dgram.createSocket(type); } catch { return resolve(''); }
    sock.on('error', () => finish(''));
    setTimeout(() => finish(''), 1000);
    try { sock.connect(53, target, () => { try { finish(sock.address().address); } catch { finish(''); } }); } catch { finish(''); }
  });
}

// werift skips these interface names when it lists host addresses; restricting
// it to an address on one of them would leave it nothing to bind.
const WERIFT_SKIPS = ['ipsec', 'tun', 'utun', 'tap', 'vmnet', 'veth'];
function usableHere(addr) {
  const nets = os.networkInterfaces();
  for (const nic of Object.keys(nets)) {
    if (WERIFT_SKIPS.some((w) => nic.startsWith(w))) continue;
    if ((nets[nic] || []).some((a) => a.address === addr && !a.internal)) return true;
  }
  return false;
}

// The internet-facing LAN address (IPv4) and a global IPv6 address, if any.
// Prefers the address the router mapping was made for, so they always match.
async function iceAddresses() {
  let v4 = portMap && portMap.localIp && usableHere(portMap.localIp) ? portMap.localIp : '';
  if (!v4) {
    const a = await routeSource('udp4', '1.1.1.1');
    if (a && a !== '0.0.0.0' && !a.startsWith('127.') && !a.startsWith('169.254.') && usableHere(a)) v4 = a;
  }
  let v6 = await routeSource('udp6', '2606:4700:4700::1111');
  if (!/^[23][0-9a-f]{0,3}:/i.test(v6) || !usableHere(v6)) v6 = '';
  return { v4, v6 };
}

function canBind(type, address, port) {
  return new Promise((resolve) => {
    let sock;
    try { sock = dgram.createSocket(type); } catch { return resolve(false); }
    sock.once('error', () => { try { sock.close(); } catch {} resolve(false); });
    try { sock.bind({ port, address, exclusive: true }, () => sock.close(() => resolve(true))); } catch { resolve(false); }
  });
}

// One free port from the range for a new viewer, or 0 to let werift pick.
// Offers are handled one at a time (the poll loop awaits each), so two viewers
// never race for the same port.
async function pickIcePort(addrs) {
  const r = CFG.icePorts;
  if (!r || !addrs.v4) return 0;
  const busy = new Set();
  for (const s of sessions.values()) if (s.icePort) busy.add(s.icePort);
  for (let p = r.min; p <= r.max; p++) {
    if (busy.has(p)) continue;
    if (!(await canBind('udp4', addrs.v4, p))) continue;
    if (addrs.v6 && !(await canBind('udp6', addrs.v6, p))) continue;
    return p;
  }
  return 0;
}

// werift's own config check refuses min === max, but its port finder handles a
// one-port range fine, and the transport reads the config only when the offer
// arrives. So the range is set after construction, before setRemoteDescription.
function peerConfig(addrs, port, ownRelay) {
  const cfg = { iceServers: ownRelay ? iceServers.concat([ownRelay]) : iceServers };
  if (port) {
    cfg.iceInterfaceAddresses = addrs.v6 ? { udp4: addrs.v4, udp6: addrs.v6 } : { udp4: addrs.v4 };
  }
  return cfg;
}

// A host candidate on a mapped port gets a twin at the router's public address.
// STUN usually reports that same address as a server-reflexive candidate,
// because routers reuse a forwarded port for outgoing traffic from it, but not
// always: some pick a fresh outgoing port, NAT-PMP may grant a different outside
// port than the one asked for, and the STUN reply can simply be lost. The viewer
// can always reach the forward itself, so say where it is.
const CAND_RE = /^candidate:(\S+) (\d+) udp (\d+) (\S+) (\d+) typ (host|srflx)\b/i;
function mappedCandidate(cand) {
  const m = CAND_RE.exec(String((cand && cand.candidate) || ''));
  if (!m || m[6].toLowerCase() !== 'host' || m[2] !== '1' || !portMap || !portMap.externalIp) return null;
  const port = Number(m[5]);
  const map = (portMap.mappings || []).find((x) => x.internal === port);
  if (!map || m[4].includes(':')) return null;
  // srflx type preference 100, local preference 65535, component 1.
  const priority = (100 * 2 ** 24) + (65535 * 2 ** 8) + 255;
  return {
    candidate: `candidate:beebomap${port} 1 udp ${priority} ${portMap.externalIp} ${map.external} typ srflx raddr ${m[4]} rport ${port}`,
    sdpMid: cand.sdpMid, sdpMLineIndex: cand.sdpMLineIndex,
  };
}
function setPortMap(m) {
  if (!m || !/^\d{1,3}(\.\d{1,3}){3}$/.test(String(m.externalIp || '')) || !Array.isArray(m.mappings) || !m.mappings.length) { portMap = null; return; }
  const mappings = m.mappings
    .map((x) => ({ internal: Number(x && x.internal), external: Number(x && x.external) }))
    .filter((x) => x.internal > 0 && x.internal < 65536 && x.external > 0 && x.external < 65536);
  portMap = mappings.length ? { externalIp: String(m.externalIp), localIp: String(m.localIp || ''), mappings } : null;
  if (portMap) log(`router forwards ${mappings.length} UDP port(s) to this PC at ${portMap.externalIp}`);
}

// ---------------------------------------------------------------------------
// The customer's OWN relay (optional, off unless they set one up)
// ---------------------------------------------------------------------------
// Beebo hands out no relay of its own, and STUN only stays the default. An owner
// who wants connections that can't go direct to work anyway may enter their own
// relay in Settings and pay their provider for what it carries:
//   { kind: 'cloudflare', keyId, apiToken }  Cloudflare Realtime TURN
//   { kind: 'turn', urls: [...], secret }    any TURN server with a static auth
//                                            secret (coturn use-auth-secret)
// The app hands this over IPC only (never the environment, never a file). The
// secret or API token stays on this PC: what leaves it is a short-lived derived
// credential, in this house's signed answer, to this house's own viewers. It is
// never logged. The video stays DTLS-encrypted end to end, so a relay only ever
// forwards ciphertext.
// Relay credentials: 12 hours, not refreshed in place. Why not a transparent
// refresh for long sessions: a TURN allocation belongs to the username that
// created it (RFC 8656: a request on it with other credentials is refused, 441),
// and TURN REST / Cloudflare usernames change with every credential, so new
// credentials can only ever serve a NEW allocation, i.e. an ICE restart. werift
// 0.20.1 gathers candidates once per transport (its "restart" only forgets the
// nominated pair) and the viewer page would have to renegotiate through the
// Worker mid-film, so there is no clean restart to hang a refresh on. The
// allocation itself keeps refreshing (werift and browsers send Refresh with the
// credentials it was made with) for as long as the relay still accepts them.
// Cloudflare's own guidance is to make the TTL longer than a session, so: 12 h
// covers a long binge, and every new connection (including the viewer page's
// automatic reconnect) gets fresh ones. Handed out for 30 min at most, so a
// viewer always gets >= 11.5 h. See relayCredentialPlan below.
const RELAY_TTL_S = 12 * 3600;
const RELAY_REUSE_MS = 30 * 60 * 1000;         // issued credentials live >= 11.5 h
const CF_TURN_API = 'https://rtc.live.cloudflare.com/v1/turn/keys/';
let relay = null;
let relayCache = null;

// TURN REST API (draft-uberti-behave-turn-rest, coturn --use-auth-secret):
// username "<expiry unix time>:<id>", password base64(HMAC-SHA1(secret, username)).
function turnRestCredential(secret, username) {
  return require('crypto').createHmac('sha1', String(secret)).update(String(username)).digest('base64');
}
function turnRestIceServers(cfg, nowS) {
  const username = `${nowS + RELAY_TTL_S}:beebo`;
  return [{ urls: cfg.urls.slice(), username, credential: turnRestCredential(cfg.secret, username) }];
}

const RELAY_URL_RE = /^turns?:[A-Za-z0-9.\-[\]:]{3,200}(\?transport=(udp|tcp))?$/i;
// Cloudflare's docs: port 53 is blocked by browsers, so drop those URLs.
const usableRelayUrl = (u) => RELAY_URL_RE.test(String(u)) && !/:53(\?|$)/.test(String(u));

async function cloudflareIceServers(cfg, fetchImpl) {
  const res = await (fetchImpl || fetch)(CF_TURN_API + encodeURIComponent(cfg.keyId) + '/credentials/generate-ice-servers', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + cfg.apiToken, 'content-type': 'application/json' },
    body: JSON.stringify({ ttl: RELAY_TTL_S }),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error('cloudflare_http_' + res.status);
  const j = await res.json();
  const out = [];
  for (const e of (j && j.iceServers) || []) {
    const urls = (typeof e.urls === 'string' ? [e.urls] : (e.urls || [])).filter(usableRelayUrl);
    if (urls.length && typeof e.username === 'string' && typeof e.credential === 'string') {
      out.push({ urls, username: e.username, credential: e.credential });
    }
  }
  if (!out.length) throw new Error('cloudflare_no_relay');
  return out;
}

function cleanRelayConfig(r) {
  if (!r || typeof r !== 'object') return null;
  if (r.kind === 'cloudflare') {
    const keyId = String(r.keyId || ''), apiToken = String(r.apiToken || '');
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(keyId) || !apiToken || apiToken.length > 1024) return null;
    return { kind: 'cloudflare', keyId, apiToken };
  }
  if (r.kind === 'turn') {
    const urls = (Array.isArray(r.urls) ? r.urls : []).map((u) => String(u).trim()).filter(usableRelayUrl).slice(0, 6);
    const secret = String(r.secret || '');
    if (!urls.length || secret.length < 8 || secret.length > 1024) return null;
    return { kind: 'turn', urls, secret };
  }
  return null;
}

function setRelay(r) {
  relay = cleanRelayConfig(r);
  relayCache = null;
  if (!relay) { log('relay off'); return; }
  log('relay configured: ' + relay.kind);
  relayIceServers().catch(() => {});
}

// Fresh derived credentials for this house's relay, or [] when there is none or
// it can't be reached (then the connection is attempted direct, as without one).
// Reuse cached relay credentials, or get new ones? Reused only while young (so
// what a viewer receives always has nearly the full lifetime left) and never
// with less than an hour to go.
function relayCredentialPlan({ issuedAtMs, expiresAtS, nowMs, reuseMs = RELAY_REUSE_MS }) {
  if (!issuedAtMs || !expiresAtS) return 'renew';
  if (nowMs - issuedAtMs >= reuseMs || nowMs < issuedAtMs) return 'renew';
  return expiresAtS * 1000 - nowMs >= 3600 * 1000 ? 'reuse' : 'renew';
}

async function relayIceServers(fetchImpl) {
  if (!relay) return [];
  if (relayCache && relayCache.for === relay &&
    relayCredentialPlan({ issuedAtMs: relayCache.at, expiresAtS: relayCache.expiresAtS, nowMs: Date.now() }) === 'reuse') return relayCache.servers;
  const cfg = relay;
  try {
    const servers = cfg.kind === 'cloudflare'
      ? await cloudflareIceServers(cfg, fetchImpl)
      : turnRestIceServers(cfg, Math.floor(Date.now() / 1000));
    relayCache = { for: cfg, at: Date.now(), expiresAtS: Math.floor(Date.now() / 1000) + RELAY_TTL_S, servers };
    log(`relay ready: ${cfg.kind}, ${servers.reduce((n, s) => n + s.urls.length, 0)} address(es)`);
    return servers;
  } catch (e) {
    log('relay failed: ' + String((e && e.message) || 'error').replace(/[^a-z0-9_]/gi, '_').slice(0, 60));
    return [];
  }
}

// ---------------------------------------------------------------------------
// Beebo Relay, and which relay a NEW connection gets
// ---------------------------------------------------------------------------
// Beebo Relay is Beebo's own TURN relay, off unless the Worker has it switched on
// and this account has it enabled. This house asks the Worker for short-lived
// credentials with its licence token (POST /rtc/relay/credentials, the
// /relay/credentials route under <name>.beebo.tv); they reach the viewer the
// same way as the owner's own relay's: in this house's signed answer.
//
// The app (relayPolicy.js) decides the ORDER of providers to try, from the
// owner's mode and this month's usage: { order: ['beebo', 'cloudflare'] } etc.
// Without a plan (an older app, or tests) the owner's own relay is used if set.
// A connection keeps the relay it started with until it ends.
const RELAY_PROVIDERS = ['cloudflare', 'custom', 'beebo'];
const BEEBO_FAIL_PAUSE_MS = Number(process.env.BEEBO_RELAY_RETRY_MS || 10 * 60 * 1000);
// A viewer is never kept waiting on Beebo Relay: the credentials call gets two
// seconds, then the connection goes ahead direct. A timeout or a network error
// is asked again after a minute; a refusal (switched off, not enabled for this
// account, cap reached) only after BEEBO_FAIL_PAUSE_MS.
const BEEBO_RELAY_WAIT_MS = Number(process.env.BEEBO_RELAY_WAIT_MS || 2000);
const BEEBO_BLIP_PAUSE_MS = Number(process.env.BEEBO_RELAY_BLIP_RETRY_MS || 60 * 1000);
const beeboFailPause = (code) => (code === 'timeout' || code === 'unreachable' ? Math.min(BEEBO_BLIP_PAUSE_MS, BEEBO_FAIL_PAUSE_MS) : BEEBO_FAIL_PAUSE_MS);
let relayPlan = null;
let beeboCache = null;
let beeboFail = null;
let beeboReported = '';
let lastProvider = '';

function providerOf(cfg) { return cfg && cfg.kind === 'cloudflare' ? 'cloudflare' : cfg && cfg.kind === 'turn' ? 'custom' : ''; }

// The parent process, if there is one (the app). Never carries a secret.
function report(msg) {
  try { if (typeof process.send === 'function' && process.connected) { process.send(msg); return true; } } catch {}
  return false;
}

function setRelayPlan(p) {
  const order = [];
  for (const x of (p && Array.isArray(p.order) ? p.order : [])) if (RELAY_PROVIDERS.includes(x) && !order.includes(x)) order.push(x);
  const next = p ? { order } : null;
  if (JSON.stringify(next) === JSON.stringify(relayPlan)) return;
  relayPlan = next;
  // A changed plan may bring Beebo Relay back: ask again rather than wait out a pause.
  beeboFail = null;
  log('relay plan: ' + (next ? (order.join(',') || 'direct only') : 'own relay if set'));
  if (next && order.includes('beebo')) refreshBeeboUsage().catch(() => {});
}

// The Worker's reply to /rtc/relay/credentials -> { servers, expiresAt, ttl } or { error }.
function parseBeeboCredentials(status, body, nowS) {
  if (status === 404) return { error: 'not_offered' };      // BEEBO_RELAY_ENABLED is not "1"
  if (status !== 200) {
    const e = body && typeof body.error === 'string' && /^[a-z_]{3,40}$/.test(body.error) ? body.error : 'http_' + status;
    return { error: e };
  }
  const servers = [];
  for (const e of (body && Array.isArray(body.iceServers) ? body.iceServers : []).slice(0, 4)) {
    const urls = (typeof e.urls === 'string' ? [e.urls] : (Array.isArray(e.urls) ? e.urls : [])).map(String).filter(usableRelayUrl).slice(0, 8);
    if (urls.length && typeof e.username === 'string' && typeof e.credential === 'string' && e.username.length <= 512 && e.credential.length <= 512) {
      servers.push({ urls, username: e.username, credential: e.credential });
    }
  }
  if (!servers.length) return { error: 'relay_not_configured' };
  const expiresAt = Number(body.expiresAt) > nowS ? Number(body.expiresAt) : nowS + (Number(body.ttl) > 0 ? Number(body.ttl) : 3600);
  return { servers, expiresAt, ttl: expiresAt - nowS };
}

function reportBeebo(available, error, expiresAt) {
  const key = available + ':' + (error || '');
  if (key === beeboReported) return;
  beeboReported = key;
  if (available) log('relay beebo ready');
  else log('relay beebo unavailable: ' + String(error || 'error').replace(/[^a-z0-9_]/gi, '_').slice(0, 40));
  report({ type: 'relayStatus', beebo: { available, error: error || '', expiresAt: expiresAt || 0 } });
}

async function beeboIceServers() {
  const now = Date.now();
  if (beeboCache && relayCredentialPlan({ issuedAtMs: beeboCache.at, expiresAtS: beeboCache.expiresAt, nowMs: now }) === 'reuse') return beeboCache.servers;
  if (beeboFail && now - beeboFail.at < beeboFailPause(beeboFail.code)) throw new Error(beeboFail.code);
  let r;
  try {
    const { status, body } = await api('/rtc/relay/credentials', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', timeoutMs: BEEBO_RELAY_WAIT_MS,
    }, true);
    r = parseBeeboCredentials(status, body, Math.floor(Date.now() / 1000));
  } catch (e) {
    r = { error: e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'unreachable' };
  }
  if (r.error) {
    beeboFail = { at: Date.now(), code: r.error };
    beeboCache = null;
    reportBeebo(false, r.error);
    throw new Error(r.error);
  }
  beeboFail = null;
  beeboCache = { at: Date.now(), expiresAt: r.expiresAt, servers: r.servers };
  reportBeebo(true, '', r.expiresAt);
  return r.servers;
}

// Beebo Relay's own meter for this account, this month (GET /rtc/relay/usage/me).
let beeboUsageAt = 0;
async function refreshBeeboUsage(force = false) {
  if (!relayPlan || !relayPlan.order.includes('beebo')) return;
  // Nothing to count while Beebo Relay is off, or not on for this account.
  if (!force && beeboFail && (beeboFail.code === 'not_offered' || beeboFail.code === 'relay_not_enabled')) return;
  if (!force && Date.now() - beeboUsageAt < 30 * 60 * 1000) return;
  beeboUsageAt = Date.now();
  try {
    const { status, body } = await api('/rtc/relay/usage/me', {}, true);
    if (status !== 200 || !body || !Number.isFinite(Number(body.bytes))) return;
    report({ type: 'relayStatus', beeboUsage: { month: String(body.month || ''), bytes: Number(body.bytes) } });
  } catch {}
}

// The relay for a new connection: the first provider in the plan that can give
// credentials right now. -> { provider, servers } or null (direct only).
async function pickRelay() {
  const order = relayPlan ? relayPlan.order : (relay ? [providerOf(relay)] : []);
  for (const p of order) {
    if (p === 'beebo') {
      try { return { provider: 'beebo', servers: await beeboIceServers() }; } catch { continue; }
    }
    if (relay && providerOf(relay) === p) {
      const servers = await relayIceServers();
      if (servers.length) return { provider: p, servers };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Relay metering: bytes that really went through a relay, per provider
// ---------------------------------------------------------------------------
// werift 0.20.1 has no getStats(), so the meter sits on each connection's ICE
// layer: every datagram this house sends (Connection.sendTo) or receives
// (Connection.onData) after DTLS, counted only while the NOMINATED candidate
// pair has a relay candidate on either side, and attributed to the provider
// whose credentials this connection was given.
//
// What a TURN provider bills: Cloudflare bills bytes sent FROM its servers, to
// either end. Relayed, both directions leave the relay: the film to the viewer
// (what this house sends) and the viewer's requests and acknowledgements to the
// house (what it receives). So both are counted. If BOTH ends use a relay
// candidate the data may leave the provider twice, so it is counted twice.
//
// Deliberately a little high, never low:
//   - each datagram is charged METER_PACKET_OVERHEAD bytes for headers we can't
//     see (IPv6 40 + UDP 8 + TURN ChannelData 4 = 52; a viewer on TURN over
//     TLS/TCP 443 pays about 20+20+29+4 = 73 plus padding): 80;
//   - then x METER_OVERHEAD_FACTOR (1.03) for STUN consent checks, TURN
//     Refresh/permission traffic and anything else outside DTLS.
// Caveats: STUN checks before nomination aren't seen; a viewer that relays
// through a server this house didn't hand out isn't counted (not the owner's
// bill); reports are every 15 s, so up to 15 s of use can be lost if the agent
// is killed. The provider's own figure, where the app can get it, wins when higher.
const METER_PACKET_OVERHEAD = 80;
const METER_OVERHEAD_FACTOR = 1.03;
const METER_FLUSH_MS = Number(process.env.BEEBO_METER_FLUSH_MS || 15000);
const meterPending = { cloudflare: { bytes: 0, packets: 0 }, custom: { bytes: 0, packets: 0 }, beebo: { bytes: 0, packets: 0 } };

function billableBytes(bytes, packets) {
  return Math.ceil((bytes + packets * METER_PACKET_OVERHEAD) * METER_OVERHEAD_FACTOR);
}

// How many relay hops the nominated pair has: 0 (direct), 1 or 2.
function pairRelayHops(pair) {
  if (!pair) return 0;
  let n = 0;
  try { if (pair.localCandidate && pair.localCandidate.type === 'relay') n++; } catch {}
  try { if (pair.remoteCandidate && pair.remoteCandidate.type === 'relay') n++; } catch {}
  return n;
}

// ---------------------------------------------------------------------------
// "Direct connection" or "Through Beebo Relay", for the app's status line
// ---------------------------------------------------------------------------
// From the pair ICE nominated (werift has no getStats()). A relay on this
// house's side is the provider it handed this connection. A relay only on the
// viewer's side is Beebo Relay when its address is one of the Beebo Relay hosts
// this house got credentials for (the viewer page and the phone app ask Beebo
// Relay for their own), else just "a relay".
function nominatedPair(pc) {
  let transports = [];
  try { transports = pc.iceTransports || []; } catch {}
  for (const t of transports) { const n = t && t.connection && t.connection.nominated; if (n) return n; }
  return null;
}
function relayHostsOf(servers) {
  const out = [];
  for (const s of servers || []) {
    for (const u of s.urls || []) {
      const m = /^turns?:(\[[^\]]+\]|[^:?]+)/i.exec(String(u));
      if (m && !out.includes(m[1].toLowerCase())) out.push(m[1].toLowerCase());
    }
  }
  return out;
}
// -> { path: 'direct' | 'relay', provider: 'beebo' | 'cloudflare' | 'custom' | '' }
function connectionPath(pair, ownProvider, beeboAddresses) {
  if (!pair) return null;
  let local = '', remote = '', remoteHost = '';
  try { local = pair.localCandidate && pair.localCandidate.type; } catch {}
  try { remote = pair.remoteCandidate && pair.remoteCandidate.type; remoteHost = String(pair.remoteCandidate.host || ''); } catch {}
  if (local !== 'relay' && remote !== 'relay') return { path: 'direct', provider: '' };
  if (local === 'relay') return { path: 'relay', provider: ownProvider || '' };
  return { path: 'relay', provider: (beeboAddresses || []).includes(remoteHost) ? 'beebo' : '' };
}
async function beeboRelayAddresses() {
  const hosts = relayHostsOf(beeboCache && beeboCache.servers);
  const out = [];
  for (const h of hosts) {
    try { for (const a of await require('dns').promises.lookup(h.replace(/^\[|\]$/g, ''), { all: true })) out.push(a.address); } catch {}
  }
  return out;
}
async function reportConnection(viewerId, session) {
  const pair = nominatedPair(session.pc);
  const addrs = pair && pairRelayHops(pair) ? await beeboRelayAddresses() : [];
  const p = connectionPath(pair, session.relayProvider, addrs);
  if (!p || !sessions.has(viewerId)) return;
  // Passed on with this viewer's requests (x-beebo-remote-path) so the owner's
  // server dashboard can say "away, direct" or "away, through Beebo Relay".
  session.remotePath = p.path === 'direct' ? 'direct' : 'relay-' + (p.provider || 'other');
  log('viewer', viewerId, p.path === 'direct' ? 'connected directly' : 'connected through ' + (p.provider === 'beebo' ? 'Beebo Relay' : p.provider ? p.provider + ' relay' : 'a relay'));
  report({ type: 'connection', viewerId, state: 'open', path: p.path, provider: p.provider });
}

function meterCount(session, conn, len) {
  const prov = session.relayProvider;
  if (!prov || !meterPending[prov]) return;
  const hops = pairRelayHops(conn.nominated);
  if (!hops) return;
  meterPending[prov].bytes += len * hops;
  meterPending[prov].packets += hops;
}

function attachMeter(session, pc) {
  let transports = [];
  try { transports = pc.iceTransports || []; } catch {}
  for (const t of transports) {
    const conn = t && t.connection;
    if (!conn || conn.__beeboMeter || typeof conn.sendTo !== 'function') continue;
    Object.defineProperty(conn, '__beeboMeter', { value: true });
    const send = conn.sendTo.bind(conn);
    conn.sendTo = (data) => { try { meterCount(session, conn, data ? data.length : 0); } catch {} return send(data); };
    try { conn.onData.subscribe((data) => { try { meterCount(session, conn, data ? data.length : 0); } catch {} }); } catch {}
  }
}

// { cloudflare: billable bytes, ... } since the last flush; resets the counters.
function takeMeterDeltas() {
  const out = {};
  for (const p of Object.keys(meterPending)) {
    const m = meterPending[p];
    if (m.bytes || m.packets) out[p] = billableBytes(m.bytes, m.packets);
    m.bytes = 0; m.packets = 0;
  }
  return out;
}
let meterUnsent = {};
function flushMeter() {
  const d = takeMeterDeltas();
  for (const p of Object.keys(d)) meterUnsent[p] = (meterUnsent[p] || 0) + d[p];
  if (!Object.keys(meterUnsent).length) return;
  // Kept until the app has it: a moment without the IPC channel loses nothing.
  if (report({ type: 'relayUsage', deltas: meterUnsent, at: Date.now() })) meterUnsent = {};
}

// Does the relay answer at all, over UDP, from here? werift waits for its relay
// allocation before it answers a viewer, and against a relay that isn't there
// that wait never ended: one typo in Settings and nobody could connect. So the
// house only uses its relay itself after a STUN Binding request to it gets a
// reply (every TURN server answers those). Remembered for ten minutes.
const relayProbeCache = new Map();
const RELAY_GATHER_MS = Number(process.env.BEEBO_RELAY_GATHER_MS || 8000);
function probeRelayUdp(url, timeoutMs = 1500) {
  const m = /^turn:([^?]+?)(?::(\d+))?(\?.*)?$/i.exec(String(url));
  if (!m) return Promise.resolve(false);
  const host = m[1].replace(/^\[|\]$/g, ''), port = Number(m[2] || 3478);
  const hit = relayProbeCache.get(url);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return Promise.resolve(hit.ok);
  return new Promise((resolve) => {
    const id = require('crypto').randomBytes(12);
    const req = Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00, 0x21, 0x12, 0xa4, 0x42]), id]);
    let sock, done = false;
    const finish = (ok) => {
      if (done) return; done = true;
      try { sock.close(); } catch {}
      relayProbeCache.set(url, { at: Date.now(), ok });
      resolve(ok);
    };
    try { sock = dgram.createSocket(host.includes(':') ? 'udp6' : 'udp4'); } catch { return resolve(false); }
    sock.on('error', () => finish(false));
    sock.on('message', (buf) => { if (buf.length >= 20 && buf.subarray(8, 20).equals(id)) finish(true); });
    setTimeout(() => finish(false), timeoutMs);
    try { sock.send(req, port, host, (err) => { if (err) finish(false); }); } catch { finish(false); }
  });
}

// werift itself can use one plain turn: address over UDP or TCP (no turns:).
function hostRelayEntry(servers) {
  for (const s of servers) {
    // UDP only: that is what probeRelayUdp can confirm before werift waits on it.
    const url = s.urls.find((u) => /^turn:/i.test(u) && !/transport=tcp/i.test(u));
    if (url) return { urls: url, username: s.username, credential: s.credential };
  }
  return null;
}

// How often to ask the worker "anything for me?". This was a flat 3 s, for ever,
// whether or not a single person was watching: ~28,800 Cloudflare requests a day
// from one idle house, 30% of the free allowance, spent on silence. Now: 400 ms
// for half a minute after any signalling message, 8 s otherwise. Deliberately NOT
// "fast while a viewer is connected" - once the handshake is done the data channel
// carries everything and there is nothing left here to fetch, so holding the fast
// rate through a two-hour film would cost thousands of requests for a film that
// needs about a dozen. Worst case a viewer waits one idle tick, once.
const HOT_MS = 400, IDLE_MS = Math.max(2000, CFG.pollEveryMs), STAY_HOT_MS = 30000;
let hotUntil = Date.now() + STAY_HOT_MS;   // quick for the first half-minute after start
function nextDelay() { return Date.now() < hotUntil ? HOT_MS : IDLE_MS; }

async function poll() {
  if (!registered) return;
  let body, status;
  try { ({ status, body } = await api('/rtc/poll?box=host', {}, true)); } catch { return; }
  // Refused: stop polling until the next heartbeat registers us again.
  if (status === 401) { warn('poll refused: 401 unauthorized'); registered = false; return; }
  const msgs = (body && body.msgs) || [];
  if (msgs.length) hotUntil = Date.now() + STAY_HOT_MS;
  for (const m of msgs) {
    try {
      if (m.type === 'offer') await onOffer(m.viewerId, m.sdp, m.ip, m.vt);
      else if (m.type === 'candidate') await onViewerCandidate(m.viewerId, m.candidate);
    } catch (e) { warn('signal handling error:', e.message); }
  }
}

// The address the Worker saw this viewer's offer come from (only the house can
// read the host mailbox). Anything that isn't a plain IP is dropped.
function cleanIp(v) {
  const s = String(v || '').trim();
  return require('net').isIP(s) ? s : '';
}

async function onOffer(viewerId, sdp, viewerIp, viewerToken) {
  if (!viewerId || !sdp) return;
  if (sessions.has(viewerId)) closeSession(viewerId);
  log('viewer', viewerId, 'connecting…');

  const addrs = CFG.icePorts ? await iceAddresses() : { v4: '', v6: '' };
  const icePort = await pickIcePort(addrs);
  const picked = await pickRelay();
  const relayServers = picked ? picked.servers : [];
  if (picked && picked.provider !== lastProvider) { lastProvider = picked.provider; log('relay provider: ' + picked.provider); }
  let ownRelay = relayServers.length ? hostRelayEntry(relayServers) : null;
  if (ownRelay && !(await probeRelayUdp(ownRelay.urls))) {
    ownRelay = null;
    log('relay ' + (picked.provider === 'beebo' ? 'beebo note' : 'failed') + ': no_udp_reply_from_this_pc (viewers are still offered it)');
  }
  const pc = new RTCPeerConnection(peerConfig(addrs, icePort, ownRelay));
  if (icePort) pc.config.icePortRange = [icePort, icePort];
  // relayProvider: whose relay this connection was offered, for the meter.
  const session = { viewerId, pc, channel: null, inflight: new Map(), uploads: new Map(), cookies: {}, icePort, viewerIp: cleanIp(viewerIp), viewer: verifyViewerToken(viewerToken), relayProvider: picked ? picked.provider : '', lastMoveAt: Date.now() };
  sessions.set(viewerId, session);
  if (CFG.icePorts) log('viewer', viewerId, icePort ? `on UDP ${addrs.v4}:${icePort}` : 'on a random UDP port (fixed range full or no LAN address)');

  // The Worker forwards ONLY the `candidate` field to the viewer, so pack the
  // full ICE candidate init object into it.
  const sendCandidate = (c) => api('/rtc/candidate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: viewerId, viewerId, candidate: c }),
  }, true).catch(() => {});
  const announced = new Set();
  pc.onIceCandidate.subscribe((cand) => {
    if (!cand) return;
    const c = { candidate: cand.candidate, sdpMid: cand.sdpMid, sdpMLineIndex: cand.sdpMLineIndex };
    const m = CAND_RE.exec(String(c.candidate || ''));
    const where = m ? m[4] + ':' + m[5] : '';
    // STUN often reports exactly the router's forward; don't send it twice.
    if (m && m[6].toLowerCase() === 'srflx' && announced.has(where)) return;
    if (where) announced.add(where);
    sendCandidate(c);
    const twin = mappedCandidate(c);
    if (twin) {
      const tm = CAND_RE.exec(twin.candidate);
      const twhere = tm[4] + ':' + tm[5];
      if (!announced.has(twhere)) { announced.add(twhere); sendCandidate(twin); }
    }
  });

  pc.connectionStateChange.subscribe((state) => {
    if (state === 'connected') { session.everConnected = true; reportConnection(viewerId, session).catch(() => {}); }
    // A viewer that never got through at all: the app's Connection test shows it.
    if (state === 'failed' && !session.everConnected && sessions.get(viewerId) === session) report({ type: 'connection', viewerId, state: 'failed' });
    if (state === 'failed' || state === 'closed' || state === 'disconnected') closeSession(viewerId);
  });

  // The viewer (offerer) creates a DataChannel; we receive it. "http" is the
  // proven media bridge (above). "mc" is the Home Game Server bridge (below):
  // a second, independent kind of channel on the SAME peer connection, so a
  // game-joining client gets the exact same direct-then-Beebo-Relay path,
  // ports and metering as a video viewer, without touching the http protocol.
  pc.onDataChannel.subscribe((channel) => {
    if (channel.label === 'http') {
      session.channel = channel;
      // werift exposes inbound messages via `.message` (Event). Support `.onMessage` too.
      const sub = channel.message || channel.onMessage;
      if (sub && typeof sub.subscribe === 'function') sub.subscribe((data) => onHttpMessage(session, channel, data));
      log('viewer', viewerId, 'data channel open — bridging to', CFG.local);
      return;
    }
    if (channel.label === 'mc') {
      session.gameChannel = channel;
      const sub = channel.message || channel.onMessage;
      if (sub && typeof sub.subscribe === 'function') sub.subscribe((data) => onGameMessage(session, channel, data));
      log('viewer', viewerId, 'game data channel open — bridging to 127.0.0.1:' + gameCfg.port);
      return;
    }
  });

  // werift gathers (and allocates on the owner's relay) inside these calls. A
  // relay that answers a probe but never completes an allocation must not hold
  // the viewer up: after RELAY_GATHER_MS, answer again without it.
  const answered = (async () => {
    await pc.setRemoteDescription({ type: 'offer', sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    return true;
  })();
  const ok = ownRelay
    ? await Promise.race([answered, new Promise((r) => setTimeout(() => r(false), RELAY_GATHER_MS))])
    : await answered;
  if (!ok) {
    answered.catch(() => {});
    relayProbeCache.set(ownRelay.urls, { at: Date.now(), ok: false });
    log('relay ' + (picked && picked.provider === 'beebo' ? 'beebo note' : 'failed') + ': house_allocation_timeout (viewers are still offered it)');
    closeSession(viewerId);
    return onOffer(viewerId, sdp, viewerIp, viewerToken);
  }
  attachMeter(session, pc);
  let answerSdp = pc.localDescription.sdp;
  if (CFG.forceRelay) {
    const lines = answerSdp.split(RegExp(String.fromCharCode(92) + 'r?' + String.fromCharCode(92) + 'n'));
    const kept = lines.filter((l) => !l.startsWith('a=candidate:') || l.indexOf(' typ relay') !== -1);
    const relayCount = kept.filter((l) => l.startsWith('a=candidate:')).length;
    if (relayCount) {
      answerSdp = kept.join(String.fromCharCode(13) + String.fromCharCode(10));
      log('viewer', viewerId, 'forced relay: offering ' + relayCount + ' relay candidate(s) only');
    } else {
      log('viewer', viewerId, 'forced relay asked for, but no relay candidate was gathered - answering normally');
    }
  }
  await api('/rtc/answer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // With the owner's own relay, the viewer gets short-lived credentials for it
    // in this signed answer, for a second attempt if the direct one fails.
    body: JSON.stringify(relayServers.length
      ? { viewerId, sdp: answerSdp, iceServers: relayServers }
      : { viewerId, sdp: answerSdp }),
  }, true);
}

async function onViewerCandidate(viewerId, candidate) {
  const s = sessions.get(viewerId);
  if (!s || !candidate) return;
  try {
    const c = typeof candidate === 'string' ? { candidate } : candidate;
    await s.pc.addIceCandidate(c);
  } catch (e) { /* ignore late/duplicate candidates */ }
}

// A session that is waiting on the house but has moved nothing for this long is
// dead in the water: the viewer's network changed, or the relay's connection died
// under us and werift kept writing to it. Closing it makes the phone reconnect at
// once instead of sitting on a spinner (the owner's own phone did exactly that
// when it moved from mobile data to a friend's Wi-Fi, 2026-09-18).
const STALLED_MS = Number(process.env.BEEBO_STALLED_MS || 20000);
function sweepStalledSessions() {
  const now = Date.now();
  for (const [viewerId, s] of sessions) {
    if (!s.channel || !s.inflight || s.inflight.size === 0) continue;
    if (now - (s.lastMoveAt || 0) < STALLED_MS) continue;
    log('viewer', viewerId, 'nothing moving for ' + Math.round((now - s.lastMoveAt) / 1000) + 's while it waits on us - closing so it can reconnect');
    closeSession(viewerId);
  }
}

function releaseStreamLease(session) {
  if (!session || !session.streamLeaseActive) return;
  session.streamLeaseActive = false;
  api('/rtc/stream-lease', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ viewerId: session.viewerId, action: 'release' }), timeoutMs: 5000,
  }, true).catch(() => {});
}
function closeSession(viewerId) {
  const s = sessions.get(viewerId);
  if (!s) return;
  sessions.delete(viewerId);
  releaseStreamLease(s);
  for (const ctrl of s.inflight.values()) { try { ctrl.abort(); } catch {} }
  if (s.uploads) s.uploads.clear();
  if (s.gameSockets) { for (const sock of s.gameSockets.values()) { try { sock.destroy(); } catch {} } s.gameSockets.clear(); }
  try { s.channel && s.channel.close(); } catch {}
  try { s.gameChannel && s.gameChannel.close(); } catch {}
  try { s.pc.close(); } catch {}
  report({ type: 'connection', viewerId, state: 'closed' });
  log('viewer', viewerId, 'disconnected');
}

// ---------------------------------------------------------------------------
// Who signed in at <name>.beebo.tv
// ---------------------------------------------------------------------------
// The Worker puts the viewer's signed token in the offer (only this house can read
// its mailbox). It is checked HERE, with the Worker's Ed25519 public key (the same
// one that signs licences), before the local server is told who this viewer is:
// a valid signature, typ "viewer", this house's name, not expired. Then:
//   { via: 'member', member }  a household member, by their own home-server username
//   { via: 'owner' }           the Beebo account owner
//   { via: 'household' }       the shared household pass (not a person)
// Anything else: null, and the local server hears nothing (it asks for a sign-in).
const LICENSE_PUBLIC_KEY = process.env.BEEBO_LICENSE_PUBLIC_KEY ||
  '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAq9BmDwiIr7GmE29BirIyGGw9ghJ/Du1bPH0/vnFEQKo=\n-----END PUBLIC KEY-----\n';

function verifyViewerToken(token, opts = {}) {
  try {
    const key = opts.publicKey || LICENSE_PUBLIC_KEY;
    const name = opts.name !== undefined ? opts.name : (registeredName || CFG.name);
    const nowS = opts.nowS || Math.floor(Date.now() / 1000);
    const parts = String(token || '').split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1] || token.length > 4096) return null;
    const payloadBytes = Buffer.from(parts[0], 'base64url');
    const sig = Buffer.from(parts[1], 'base64url');
    if (!require('crypto').verify(null, payloadBytes, key, sig)) return null;
    const p = JSON.parse(payloadBytes.toString('utf8'));
    if (!p || p.typ !== 'viewer' || !name || p.name !== name) return null;
    if (!Number.isFinite(Number(p.exp)) || Number(p.exp) <= nowS) return null;
    if (p.via === 'member') {
      const m = String(p.member || '').trim().toLowerCase();
      return /^[a-z0-9._-]{1,64}$/.test(m) ? { via: 'member', member: m } : null;
    }
    if (p.via === 'household') return { via: 'household' };
    // Someone from another household, through a library share ({ via: 'guest', share, guest }).
    if (p.via === 'guest') {
      const share = String(p.share || '');
      const guest = String(p.guest || '').trim().toLowerCase();
      return /^sh_[a-f0-9]{16}$/.test(share) && /^[^\s@]{1,64}@[^\s@]{1,190}$/.test(guest) ? { via: 'guest', share, guest } : null;
    }
    if (p.via === undefined || p.via === '') return { via: 'owner' };
    return null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// The HTTP-over-DataChannel bridge  (the heart of it)
// ---------------------------------------------------------------------------
//
// Protocol version 2 (what the phone app speaks) adds, on top of the browser
// page's exact messages, which are unchanged and still work:
//
//   viewer -> host (text) {kind:"hello", proto:2}
//   host -> viewer (text) {kind:"hello", proto:2, features:[...], maxBody, bodyChunk}
//       Only ever sent in reply, so the browser page (which never says hello)
//       sees nothing new. An older agent ignores the hello, and the app treats
//       silence as "version 1".
//
//   "headers"      req.headers {name: value}: request headers to pass on
//                  (Authorization, X-Beebo-Media-Token, Accept...). Hop-by-hop
//                  headers and the ones this agent vouches for are never taken.
//   "body-chunks"  a body too big for one message:
//                    {kind:"req", id, ..., bodyChunks:true, blen:N}
//                    binary frames [uint16 idLen][id][payload], exactly as
//                    responses are framed, in order
//                    {kind:"bend", id}
//                  Small bodies still go inline as base64 `body`, as the browser
//                  does. Anything over MAX_BODY_BYTES is refused with err 413.
//   "set-cookies"  head.setcookies: every Set-Cookie, not one folded string.
//   "resp-headers" head.headers: a short allowlist of response headers.
//
// Cookies: this agent keeps a jar per viewer connection and replays it (the
// browser page relies on that: its service worker can't read HttpOnly cookies).
// A client may also send its own `cookie`, e.g. a phone that reconnected and
// so has a new connection with an empty jar here; the two are merged by name,
// this connection's jar winning.
const PROTO = 2;
const FEATURES = ['headers', 'body-chunks', 'set-cookies', 'resp-headers'];
const MAX_BODY_BYTES = Number(process.env.BEEBO_MAX_BODY || 8 * 1024 * 1024);

// Request headers a viewer may not set: hop-by-hop ones, what the bridge sets
// itself (range, content-type, cookie come from their own fields), and the
// headers the local server trusts this agent for.
const BLOCKED_REQ_HEADERS = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'keep-alive', 'te', 'trailer',
  'expect', 'proxy-authorization', 'proxy-connection', 'cookie', 'range', 'content-type', 'accept-encoding',
  'forwarded', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-real-ip',
  'x-beebo-remote', 'x-beebo-viewer-ip', 'x-beebo-agent-key', 'x-beebo-remote-via', 'x-beebo-remote-member',
  'x-beebo-remote-path',
  'x-beebo-remote-share', 'x-beebo-remote-guest',
]);
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;

// Response headers worth handing back (head.headers). Framing ones travel in
// their own fields (ctype, clen, crange, location, setcookies).
const RESP_HEADERS = ['cache-control', 'etag', 'last-modified', 'accept-ranges', 'content-disposition',
  'content-language', 'retry-after', 'www-authenticate', 'x-beebo-media-token-header', 'x-beebo-remote-error'];

function requestHeaders(fromViewer) {
  const out = {};
  if (!fromViewer || typeof fromViewer !== 'object' || Array.isArray(fromViewer)) return out;
  let n = 0;
  for (const k of Object.keys(fromViewer)) {
    if (++n > 64) break;
    const v = fromViewer[k];
    const lower = String(k).toLowerCase();
    if (!HEADER_NAME_RE.test(k) || BLOCKED_REQ_HEADERS.has(lower) || lower.startsWith('proxy-')) continue;
    if (typeof v !== 'string' || v.length > 8192 || /[\r\n\0]/.test(v)) continue;
    out[lower] = v;
  }
  return out;
}

// "a=1; b=2" -> Map, keeping the first of any repeated name.
function parseCookieHeader(s) {
  const m = new Map();
  for (const part of String(s || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k && !m.has(k) && !/[\r\n]/.test(k + v)) m.set(k, v);
  }
  return m;
}

function mergeCookies(fromViewer, jar) {
  const m = parseCookieHeader(fromViewer);
  for (const k of Object.keys(jar || {})) m.set(k, jar[k]);
  return Array.from(m, ([k, v]) => k + '=' + v).join('; ');
}

function setCookiesOf(res) {
  try {
    if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie();
    const one = res.headers.get('set-cookie');
    return one ? [one] : [];
  } catch { return []; }
}

// The `head` message for a local response.
function headMessage(id, res) {
  const setcookies = setCookiesOf(res);
  const headers = {};
  for (const h of RESP_HEADERS) { const v = res.headers.get(h); if (v) headers[h] = v; }
  // fetch() has already decoded a compressed body, so its Content-Length (of the
  // compressed bytes) would be a lie about what we send.
  const encoded = !!res.headers.get('content-encoding');
  return {
    kind: 'head', id,
    status: res.status,
    ctype: res.headers.get('content-type') || 'application/octet-stream',
    clen: encoded ? '' : (res.headers.get('content-length') || ''),
    crange: res.headers.get('content-range') || '',
    setcookie: res.headers.get('set-cookie') || '',
    setcookies,
    location: res.headers.get('location') || '',
    headers,
  };
}

function sendText(channel, obj) {
  try { channel.send(JSON.stringify(obj)); } catch {}
}

// Binary frame: [uint16 idLen][id utf8][payload]
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

function bufferedAmount(channel) {
  try {
    const v = channel.bufferedAmount;
    return typeof v === 'number' ? v : 0;
  } catch { return 0; }
}

async function waitForDrain(channel, signal) {
  // Flow control so a fast disk read can't outrun the SCTP send buffer.
  // Abort-aware: stop waiting the instant the viewer seeks (aborts this request),
  // so the new position isn't stuck behind the old stream. Stale-gauge-aware:
  // werift's bufferedAmount only falls on far-end acks, so if it hasn't moved in
  // 2s we proceed rather than freezing.
  let waited = 0, stuck = 0, last = bufferedAmount(channel);
  while (bufferedAmount(channel) > CFG.maxBuffered && waited < 30000) {
    if (signal && signal.aborted) return;
    await new Promise((r) => setTimeout(r, 15));
    waited += 15;
    const now = bufferedAmount(channel);
    if (now < last) { stuck = 0; last = now; } else { stuck += 15; if (stuck >= 2000) return; }
  }
}

function onHttpMessage(session, channel, data) {
  session.lastMoveAt = Date.now();
  if (Buffer.isBuffer(data) || data instanceof Uint8Array) return onBodyChunk(session, channel, Buffer.from(data));
  if (typeof data !== 'string') return;
  let msg;
  try { msg = JSON.parse(data); } catch { return; }
  if (!msg || typeof msg !== 'object') return;

  if (msg.kind === 'hello') {
    sendText(channel, { kind: 'hello', proto: PROTO, features: FEATURES, maxBody: MAX_BODY_BYTES, bodyChunk: CFG.chunkBytes });
    return;
  }
  const uploads = session.uploads || (session.uploads = new Map());
  if (msg.kind === 'abort') {
    uploads.delete(msg.id);
    const ctrl = session.inflight.get(msg.id);
    if (ctrl) { try { ctrl.abort(); } catch {} session.inflight.delete(msg.id); }
    return;
  }
  if (msg.kind === 'bend') {
    const up = uploads.get(msg.id);
    if (!up) return;
    uploads.delete(msg.id);
    return runRequest(session, channel, up.msg, Buffer.concat(up.parts, up.size));
  }
  if (msg.kind !== 'req' || !msg.id || typeof msg.id !== 'string') return;

  if (msg.bodyChunks) {
    const blen = Number(msg.blen);
    if (!(blen >= 0) || blen > MAX_BODY_BYTES) { sendText(channel, { kind: 'err', id: msg.id, status: 413 }); return; }
    if (uploads.size >= 16) { sendText(channel, { kind: 'err', id: msg.id, status: 429 }); return; }
    uploads.set(msg.id, { msg, parts: [], size: 0, blen });
    return;
  }
  let body;
  if (msg.body) {
    try { body = Buffer.from(String(msg.body), 'base64'); } catch { body = undefined; }
    if (body && body.length > MAX_BODY_BYTES) { sendText(channel, { kind: 'err', id: msg.id, status: 413 }); return; }
  }
  return runRequest(session, channel, msg, body);
}

// A binary frame FROM the viewer: part of a chunked request body.
function onBodyChunk(session, channel, buf) {
  const f = unframe(buf);
  if (!f) return;
  const uploads = session.uploads || (session.uploads = new Map());
  const up = uploads.get(f.id);
  if (!up) return;
  up.size += f.payload.length;
  if (up.size > up.blen || up.size > MAX_BODY_BYTES) {
    uploads.delete(f.id);
    sendText(channel, { kind: 'err', id: f.id, status: 413 });
    return;
  }
  up.parts.push(Buffer.from(f.payload));
}

// A slot is taken only when the local server has returned a video response. An
// SDP offer or a tunnel used for browsing does not count as an active stream.
const STREAM_LEASE_RENEW_MS = 45 * 1000;
function isVideoResponse(res, method) {
  return String(method || '').toUpperCase() !== 'HEAD' && /^video\//i.test(String(res.headers.get('content-type') || ''));
}
async function acquireStreamLease(session) {
  const now = Date.now();
  if (session.streamLeaseActive && Number(session.streamLeaseRenewAt || 0) > now) return { ok: true };
  try {
    const { status, body } = await api('/rtc/stream-lease', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ viewerId: session.viewerId }), timeoutMs: 5000,
    }, true);
    if (status === 200 && body && body.ok) {
      session.streamLeaseActive = true;
      session.streamLeaseRenewAt = now + STREAM_LEASE_RENEW_MS;
      return { ok: true };
    }
    return { ok: false, error: body && body.error === 'away_stream_limit' ? 'away_stream_limit' : 'stream_capacity_unavailable' };
  } catch (_) {
    // Capacity enforcement must fail closed: without a verified lease this host
    // cannot know whether the household has a free remote viewing spot.
    return { ok: false, error: 'stream_capacity_unavailable' };
  }
}
function capacityHead(id, error) {
  const limited = error === 'away_stream_limit';
  return {
    kind: 'head', id, status: limited ? 429 : 503, ctype: 'application/json', clen: '', crange: '',
    setcookie: '', setcookies: [], location: '',
    headers: { 'x-beebo-remote-error': error, 'retry-after': limited ? '30' : '15' },
  };
}
async function runRequest(session, channel, msg, reqBody) {
  const id = msg.id;
  const ctrl = new AbortController();
  // Seeking: the player asks for a new part of the SAME file and abandons the old
  // request, but its "stop that one" message queues behind the video already on its
  // way, so the old stream kept going for another 10-15 s and the new part crawled
  // in behind it. Playing would start, starve, and pick up again several seconds
  // later (the owner's own phone at a friend's house, 2026-09-18). A new range on a
  // file this viewer is already streaming now stops the old one immediately.
  const pathOf = (m) => String((m && m.path) || '').split('?')[0];
  if (msg.range && pathOf(msg) && session.inflight.size) {
    for (const [otherId, other] of session.inflight) {
      if (otherId === id || !other || other.path !== pathOf(msg)) continue;
      try { other.abort(); } catch (_e) {}
      session.inflight.delete(otherId);
      log('viewer', session.viewerId || '', 'seek: stopped the earlier stream of', pathOf(msg));
    }
  }
  ctrl.path = pathOf(msg);
  session.inflight.set(id, ctrl);
  const startedAt = Date.now();
  let sentBytes = 0;
  const reqLog = (what) => {
    if (!CFG.logRequests) return;
    const shortPath = String(msg.path || '').split('?')[0].slice(0, 80);
    log('req', id, String(msg.method || 'GET').toUpperCase(), shortPath,
      msg.range ? 'range=' + String(msg.range).slice(0, 40) : '', what,
      sentBytes ? sentBytes + 'B' : '', (Date.now() - startedAt) + 'ms');
  };

  try {
    const headers = requestHeaders(msg.headers);
    // Marks the request as away-from-home, exactly as the old in-app host did, so
    // the local server's remote-only rules apply. Set here, never taken from msg.
    headers['x-beebo-remote'] = '1';
    // The key tells the local server this request really came through this
    // agent (and so over an encrypted data channel); with it, who the viewer
    // really is, for its lockouts: without that every remote viewer is
    // 127.0.0.1 and one guesser locks them all out. Neither comes from msg.
    if (CFG.agentSecret) {
      headers['x-beebo-agent-key'] = CFG.agentSecret;
      if (session.viewerIp) headers['x-beebo-viewer-ip'] = session.viewerIp;
      if (session.remotePath) headers['x-beebo-remote-path'] = session.remotePath;
      // Who signed in, only as checked by verifyViewerToken.
      if (session.viewer) {
        headers['x-beebo-remote-via'] = session.viewer.via;
        if (session.viewer.member) headers['x-beebo-remote-member'] = session.viewer.member;
        if (session.viewer.share) headers['x-beebo-remote-share'] = session.viewer.share;
        if (session.viewer.guest) headers['x-beebo-remote-guest'] = session.viewer.guest;
      }
    }
    if (msg.range) headers['range'] = String(msg.range);
    if (msg.ctype) headers['content-type'] = String(msg.ctype);
    // Cookie jar: the browser can't hand its HttpOnly session cookie to the
    // service worker, so THIS host keeps each viewer's cookies and replays them.
    const jar = session.cookies || (session.cookies = {});
    const cookieStr = mergeCookies(typeof msg.cookie === 'string' ? msg.cookie : '', jar);
    if (cookieStr) headers['cookie'] = cookieStr;
    const method = String(msg.method || 'GET').toUpperCase();
    const target = CFG.local + (msg.path && String(msg.path).startsWith('/') ? String(msg.path) : '/' + (msg.path || ''));

    // Do NOT auto-follow redirects so a login's 302 + Set-Cookie reaches the viewer.
    const init = { method, headers, redirect: 'manual', signal: ctrl.signal };
    if (reqBody && reqBody.length && method !== 'GET' && method !== 'HEAD') init.body = reqBody;
    const res = await fetch(target, init);
    // This is the enforcement boundary: local playback and ordinary remote
    // browsing never call it; only a successful video response reserves a slot.
    if (res.ok && isVideoResponse(res, method)) {
      const lease = await acquireStreamLease(session);
      if (!lease.ok) {
        try { res.body && await res.body.cancel(); } catch (_) {}
        sendText(channel, capacityHead(id, lease.error));
        sendText(channel, { kind: 'end', id });
        reqLog(lease.error);
        return;
      }
    }
    if (CFG.logRequests) log('req', id, method, String(msg.path || '').split('?')[0].slice(0, 80), msg.range ? 'range=' + String(msg.range).slice(0, 40) : '', '->', res.status);
    // Remember any Set-Cookie for this viewer's session (name=value only).
    for (const sc of setCookiesOf(res)) {
      const kv = String(sc).split(';')[0]; const i = kv.indexOf('=');
      if (i > 0) {
        const k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim();
        if (/max-age=0\b/i.test(sc) || /expires=thu, 01 jan 1970/i.test(sc)) delete jar[k]; else jar[k] = v;
      }
    }

    sendText(channel, headMessage(id, res));

    if (method === 'HEAD' || !res.body) {
      sendText(channel, { kind: 'end', id });
      return;
    }

    // Stream the body in bounded chunks, framed for the data channel.
    const reader = res.body.getReader();
    let leftover = Buffer.alloc(0);
    const CH = CFG.chunkBytes;
    while (true) {
      const { done, value } = await reader.read();
      if (ctrl.signal.aborted) break;
      if (done) break;
      let buf = value && value.length ? Buffer.concat([leftover, Buffer.from(value)]) : leftover;
      while (buf.length >= CH) {
        await waitForDrain(channel, ctrl.signal);
        if (ctrl.signal.aborted) break;
        try { channel.send(frame(id, buf.subarray(0, CH))); sentBytes += CH; session.lastMoveAt = Date.now(); } catch {}
        buf = buf.subarray(CH);
      }
      leftover = buf;
    }
    if (!ctrl.signal.aborted && leftover.length) {
      await waitForDrain(channel, ctrl.signal);
      try { channel.send(frame(id, leftover)); } catch {}
    }
    if (!ctrl.signal.aborted) sendText(channel, { kind: 'end', id });
    reqLog(ctrl.signal.aborted ? 'stopped (viewer moved on)' : 'done');
  } catch (e) {
    if (!ctrl.signal.aborted) sendText(channel, { kind: 'err', id, status: 502 });
    reqLog('failed: ' + (e && e.message ? String(e.message).slice(0, 80) : 'unknown'));
  } finally {
    session.inflight.delete(id);
  }
}

// ---------------------------------------------------------------------------
// The Home Game Server bridge  ("mc" data channel)
// ---------------------------------------------------------------------------
// Deliberately NOT the HTTP-over-DataChannel bridge above: a Minecraft client
// speaks a raw TCP protocol, not HTTP, so this channel carries arbitrary bytes
// instead. It is a SECOND, independent kind of channel on the very same peer
// connection a viewer already gets (same offer/answer via the Worker mailbox,
// same STUN-then-Beebo-Relay path, same fixed UDP port range, same meter) —
// nothing about how a connection is FOUND changes, only what flows once it is.
//
// Wire protocol on the "mc" channel (id: an opaque string the joiner makes up,
// one per local TCP connection it is proxying — usually just one, but a
// reconnecting Minecraft client or more than one local player gets its own):
//   joiner -> host (text)   {kind:"open",  id}   a new local TCP connection
//   joiner -> host (text)   {kind:"close", id}   that local connection ended
//   host -> joiner (text)   {kind:"close", id, reason}  the far side ended
//                           (reason: "" ended normally, "connect_failed" the
//                           local Minecraft server refused/is not there,
//                           "game_server_offline" Home Game Server isn't
//                           running, "too_many_connections")
//   either way (binary)     [uint16 idLen big-endian][id utf8][payload bytes]
//                           — the exact `frame`/`unframe` used by the HTTP
//                           bridge for chunked bodies, reused byte-for-byte.
// There is no head/body framing, no method or path: once "open" is sent,
// every byte on that id goes straight to (or came straight from) the TCP
// socket, in order, both directions — a plain proxy, not a protocol.
let gameCfg = { enabled: false, port: 25565 };
function setGame(g) {
  const port = Number(g && g.port);
  const next = { enabled: !!(g && g.enabled), port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 25565 };
  if (JSON.stringify(next) === JSON.stringify(gameCfg)) return;
  gameCfg = next;
  log('game host ' + (next.enabled ? ('on, bridging to 127.0.0.1:' + next.port) : 'off'));
}
// At most this many local TCP connections proxied at once FOR ONE viewer
// (one peer connection): far more than a single Minecraft client ever opens,
// enough for a client's own reconnects, and small enough that a runaway
// joiner can't open unbounded sockets against the home PC.
const MAX_GAME_SOCKETS_PER_SESSION = 8;

function sendGameControl(channel, obj) { try { channel.send(JSON.stringify(obj)); } catch {} }

function openGameSocket(session, channel, id) {
  const sockets = session.gameSockets || (session.gameSockets = new Map());
  if (sockets.has(id)) return; // duplicate "open": ignore, the socket already exists
  if (sockets.size >= MAX_GAME_SOCKETS_PER_SESSION) { sendGameControl(channel, { kind: 'close', id, reason: 'too_many_connections' }); return; }
  if (!gameCfg.enabled) { sendGameControl(channel, { kind: 'close', id, reason: 'game_server_offline' }); return; }
  let sock;
  try { sock = net.connect({ host: '127.0.0.1', port: gameCfg.port }); } catch { sendGameControl(channel, { kind: 'close', id, reason: 'connect_failed' }); return; }
  sockets.set(id, sock);
  session.lastMoveAt = Date.now();
  sock.on('data', (chunk) => { session.lastMoveAt = Date.now(); try { channel.send(frame(id, chunk)); } catch {} });
  const finish = (reason) => {
    if (sockets.get(id) !== sock) return; // already replaced/removed
    sockets.delete(id);
    sendGameControl(channel, { kind: 'close', id, reason: reason || '' });
  };
  sock.once('error', () => finish('connect_failed'));
  sock.once('close', () => finish(''));
}

function closeGameSocket(session, id) {
  const sockets = session.gameSockets;
  if (!sockets || !sockets.has(id)) return;
  const sock = sockets.get(id);
  sockets.delete(id);
  try { sock.destroy(); } catch {}
}

// A text control frame from the joiner: {kind:"open"|"close", id}.
function onGameMessage(session, channel, data) {
  session.lastMoveAt = Date.now();
  if (Buffer.isBuffer(data) || data instanceof Uint8Array) return onGameData(session, Buffer.from(data));
  if (typeof data !== 'string') return;
  let msg;
  try { msg = JSON.parse(data); } catch { return; }
  if (!msg || typeof msg !== 'object' || typeof msg.id !== 'string' || !msg.id || msg.id.length > 64) return;
  if (msg.kind === 'open') return openGameSocket(session, channel, msg.id);
  if (msg.kind === 'close') return closeGameSocket(session, msg.id);
}

// A binary frame from the joiner: bytes to write to that id's local socket.
function onGameData(session, buf) {
  const f = unframe(buf);
  if (!f || !session.gameSockets) return;
  const sock = session.gameSockets.get(f.id);
  if (!sock) return;
  try { sock.write(f.payload); } catch {}
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
async function main() {
  log('starting. base=', CFG.base || '(unset)', ' local=', CFG.local, ' token=', CFG.token ? 'found' : 'MISSING',
    ' udp=', CFG.icePorts ? CFG.icePorts.min + '-' + CFG.icePorts.max : 'random');
  if (!CFG.base) { warn('No base URL / name configured. Set BEEBO_NAME or BEEBO_HOST_URL. Exiting.'); process.exit(2); }
  if (!CFG.token) { warn('No account token found. Sign in on the desktop app, or set BEEBO_HOST_TOKEN. Exiting.'); process.exit(3); }

  // The desktop app renews its licence token every 12 hours, but a token passed
  // in the environment is frozen at spawn. A token lasts at most 30 days, so an
  // always-on PC used to fall offline a month after Beebo last restarted. The
  // supervisor now hands over each renewed token on the IPC channel.
  if (typeof process.send === 'function') {
    process.on('message', (m) => {
      if (!m) return;
      if (m.type === 'portmap') { setPortMap(m); return; }
      if (m.type === 'relay') { setRelay(m.relay); return; }
      if (m.type === 'relayPlan') { setRelayPlan(m.plan); return; }
      if (m.type === 'game') { setGame(m.game); return; }
      if (m.type !== 'token' || typeof m.token !== 'string' || !m.token || m.token === CFG.token) return;
      CFG.token = m.token;
      log('licence token updated');
      register();
    });
  }

  await register();
  setInterval(register, CFG.registerEveryMs);
  setInterval(flushMeter, METER_FLUSH_MS).unref();
  setInterval(sweepStalledSessions, 5000).unref();
  setInterval(() => { refreshBeeboUsage().catch(() => {}); }, 5 * 60 * 1000).unref();

  (async function pollLoop() {
    for (;;) {
      await poll();
      await new Promise((r) => setTimeout(r, nextDelay()));
    }
  })();

  log('running. Open  ' + (CFG.base || 'https://<name>.beebo.tv') + '  on any device, sign in, and it streams peer-to-peer.');
}

if (require.main === module) main().catch((e) => { warn('fatal:', e.stack || e.message); process.exit(1); });

module.exports = {
  loadConfig, discoverToken, verifyViewerToken, frame, unframe, onHttpMessage, requestHeaders, mergeCookies, headMessage,
  PROTO, FEATURES, MAX_BODY_BYTES, parsePortRange, mappedCandidate, setPortMap,
  turnRestCredential, turnRestIceServers, cloudflareIceServers, cleanRelayConfig, hostRelayEntry, RELAY_TTL_S,
  RELAY_REUSE_MS, relayCredentialPlan, parseBeeboCredentials, billableBytes, pairRelayHops, attachMeter, takeMeterDeltas,
  METER_PACKET_OVERHEAD, METER_OVERHEAD_FACTOR,
  beeboIceServers, setRelayPlan, pickRelay, connectionPath, relayHostsOf, BEEBO_RELAY_WAIT_MS,
  noRelay, DEFAULT_STUN_URL,
  setGame, onGameMessage, onGameData, openGameSocket, closeGameSocket, sendGameControl, MAX_GAME_SOCKETS_PER_SESSION,
  _getGameCfgForTests() { return gameCfg; },
  _resetBeeboForTests() { beeboCache = null; beeboFail = null; beeboReported = ''; relayPlan = null; },
};
