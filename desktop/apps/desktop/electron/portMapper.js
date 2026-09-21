'use strict';
/*
 * portMapper.js — ask the router to open a port, so the user never has to.
 * ---------------------------------------------------------------------------
 * Beebo's media server listens on TCP 47811. For a phone on cell data to reach
 * it, something has to forward that port through the home router. Asking people
 * to configure port forwarding is the opposite of "click install and you're in",
 * so this module asks the router itself, using the two protocols consumer
 * routers actually implement:
 *
 *   NAT-PMP (RFC 6886)  — tiny binary UDP to the gateway. Fast, tried first.
 *   UPnP IGD            — SSDP discovery then SOAP. Slower, far more common.
 *
 * ZERO npm DEPENDENCIES, by design. This gets packaged into an Electron app by
 * electron-builder, and every dependency is a packaging risk. Everything here is
 * Node built-ins: dgram, http, os, fs, child_process, url.
 *
 * THREE THINGS THIS MODULE PROMISES:
 *
 *   1. It never blocks startup. Call start() after the window is up; the media
 *      server is useful on the LAN whether or not mapping ever succeeds.
 *   2. It never lies. If the "external" address the router reports is itself
 *      private or carrier-grade-NAT, inbound is IMPOSSIBLE and we say so rather
 *      than reporting a success the user will later discover is fictional.
 *   3. It cleans up after itself. Mappings are deleted on quit.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: verify from outside. Only a connection
 * originating on the internet proves the path works, and that needs a server we
 * control. status().externalIp/externalPort is what the router CLAIMS. Treat it
 * as a strong hint, not proof.
 */

const dgram = require('dgram');
const http = require('http');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const isIPv4 = (s) => typeof s === 'string' && /^(\d{1,3}\.){3}\d{1,3}$/.test(s) &&
  s.split('.').every((o) => Number(o) >= 0 && Number(o) <= 255);

const u32 = (ip) => ip.split('.').reduce((a, o) => ((a << 8) | (Number(o) & 255)) >>> 0, 0) >>> 0;

/** Is `ip` inside `net/bits`? Only used with bits >= 8, so no /0 special case needed. */
function inNet(ip, net, bits) {
  return (u32(ip) >>> (32 - bits)) === (u32(net) >>> (32 - bits));
}

/**
 * Classify a router-reported "external" address.
 *
 * The distinction matters because the user's options differ completely:
 * CGNAT is unfixable, double-NAT is fixable by them, and a down WAN is
 * temporary. Reporting all three as "port mapping failed" is useless.
 */
function classifyExternal(ip) {
  if (!isIPv4(ip)) return { ok: false, kind: 'none', message: 'The router did not report an external address.' };
  if (inNet(ip, '0.0.0.0', 8) || inNet(ip, '169.254.0.0', 16)) {
    return { ok: false, kind: 'wan-down', message: "The router has no internet address yet - it may still be connecting." };
  }
  if (inNet(ip, '100.64.0.0', 10)) {
    return {
      ok: false, kind: 'cgnat',
      message: 'Your internet provider uses carrier-grade NAT, so incoming connections cannot reach this computer. ' +
               'Port forwarding cannot fix this. Ask your provider for a public IP address.',
    };
  }
  if (inNet(ip, '10.0.0.0', 8) || inNet(ip, '172.16.0.0', 12) || inNet(ip, '192.168.0.0', 16)) {
    return {
      ok: false, kind: 'double-nat',
      message: 'There appear to be two routers between this computer and the internet. ' +
               'Putting the first one (usually the modem from your provider) into bridge mode normally fixes it.',
    };
  }
  if (inNet(ip, '127.0.0.0', 8) || inNet(ip, '224.0.0.0', 4) || inNet(ip, '240.0.0.0', 4) ||
      inNet(ip, '192.0.0.0', 24) || inNet(ip, '192.0.2.0', 24) || inNet(ip, '198.18.0.0', 15) ||
      inNet(ip, '198.51.100.0', 24) || inNet(ip, '203.0.113.0', 24)) {
    return { ok: false, kind: 'bogus', message: 'The router reported an address that cannot be reached from the internet.' };
  }
  return { ok: true, kind: 'public', message: '' };
}

const run = (cmd, args, ms = 1500) => new Promise((resolve) => {
  try {
    execFile(cmd, args, { timeout: ms, windowsHide: true, maxBuffer: 1 << 20 },
      (err, stdout) => resolve(err ? '' : String(stdout || '')));
  } catch (e) { resolve(''); }
});

// ---------------------------------------------------------------------------
// Gateway discovery
// ---------------------------------------------------------------------------

/**
 * The default gateway's IP. os.networkInterfaces() does NOT carry routing
 * information, so this reads the route table per-platform.
 *
 * Returns '' when it cannot be determined - which is not fatal, because SSDP is
 * multicast and needs no gateway address. It only costs us NAT-PMP and the
 * strongest SSDP ranking signal.
 */
async function findGateway() {
  const platform = process.platform;

  if (platform === 'linux') {
    try {
      const txt = fs.readFileSync('/proc/net/route', 'utf8');
      const rows = txt.split('\n').slice(1)
        .map((l) => l.split(/\s+/))
        .filter((c) => c.length >= 8 && c[1] === '00000000' && (parseInt(c[3], 16) & 0x0002))
        .sort((a, b) => Number(a[6]) - Number(b[6]));
      if (rows.length) {
        const h = rows[0][2]; // little-endian hex u32
        const ip = [6, 4, 2, 0].map((i) => parseInt(h.substr(i, 2), 16)).join('.');
        if (isIPv4(ip) && ip !== '0.0.0.0') return ip;
      }
    } catch (e) { /* fall through */ }
    const out = await run('ip', ['route', 'show', 'default']);
    const m = /\bdefault\s+via\s+(\d{1,3}(?:\.\d{1,3}){3})/.exec(out);
    return m ? m[1] : '';
  }

  if (platform === 'darwin') {
    const out = await run('/sbin/route', ['-n', 'get', 'default']);
    const m = /^\s*gateway:\s*([0-9.]+)\s*$/m.exec(out);
    // On point-to-point links this can be an interface name, not an address.
    if (m && isIPv4(m[1])) return m[1];
    const net = await run('/usr/sbin/netstat', ['-rn', '-f', 'inet']);
    const row = net.split('\n').map((l) => l.trim().split(/\s+/)).find((c) => c[0] === 'default' && isIPv4(c[1]));
    return row ? row[1] : '';
  }

  if (platform === 'win32') {
    // The row FORMAT is locale-independent even though the headings are not.
    // Require all five fields so the "Persistent Routes" section (different
    // column count) and "On-link" rows can't match.
    const out = await run('route', ['print', '-4']);
    const re = /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d+)\s*$/gm;
    const rows = [];
    let m;
    while ((m = re.exec(out)) !== null) rows.push({ gw: m[1], iface: m[2], metric: Number(m[3]) });
    if (rows.length) {
      rows.sort((a, b) => a.metric - b.metric);
      if (isIPv4(rows[0].gw) && rows[0].gw !== '0.0.0.0') return rows[0].gw;
    }
    // wmic is removed in recent Windows; PowerShell is the supported fallback.
    const ps = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', "(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1).NextHop"], 4000);
    const g = ps.trim().split(/\s+/)[0];
    return isIPv4(g) ? g : '';
  }

  return '';
}

/**
 * Our LAN address *as the gateway sees it*.
 *
 * This matters more than it looks. NAT-PMP has no "internal client" field - the
 * router maps to whatever source IP the request arrives from. On a machine with
 * a VPN, Docker bridge or Hyper-V switch, sending from the wrong interface
 * creates a mapping to an address that isn't reachable, and everything fails
 * silently. dgram.connect() does a real route lookup WITHOUT sending a packet,
 * which is exactly the answer we need.
 */
/** First private, non-internal IPv4 address from node:os, or ''. */
function lanIpFromOs() {
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) {
        const fam = a.family === 4 ? 'IPv4' : a.family;
        if (fam !== 'IPv4' || a.internal || !isIPv4(a.address)) continue;
        if (inNet(a.address, '10.0.0.0', 8) || inNet(a.address, '172.16.0.0', 12) || inNet(a.address, '192.168.0.0', 16)) return a.address;
      }
    }
  } catch (e) {}
  return '';
}

function localIpFor(gateway) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { sock.close(); } catch (e) {} resolve(v); } };
    const sock = dgram.createSocket('udp4');
    sock.on('error', () => finish(''));
    try {
      sock.bind(0, () => {
        try {
          sock.connect(5351, gateway, () => {
            const a = sock.address();
            finish(a && isIPv4(a.address) && a.address !== '0.0.0.0' ? a.address : '');
          });
        } catch (e) { finish(''); }
      });
    } catch (e) { finish(''); }
    setTimeout(() => finish(''), 1000);
  });
}

// ---------------------------------------------------------------------------
// NAT-PMP (RFC 6886)
// ---------------------------------------------------------------------------

const NATPMP_PORT = 5351;

/**
 * One NAT-PMP request/response exchange.
 *
 * RFC 6886 specifies 9 retries out to 64s (total ~127s). That is a daemon's
 * schedule, not an app-startup schedule, so `timeouts` is passed in: short at
 * startup, RFC-ish for background renewal. Do not "fix" this back to 9 retries.
 */
function natpmpExchange(gateway, request, expectOpcode, timeouts) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let done = false, attempt = 0, timer = null;
    const finish = (v) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try { sock.close(); } catch (e) {}
      resolve(v);
    };
    sock.on('error', () => finish(null));
    sock.on('message', (buf, rinfo) => {
      // A PCP server or something unrelated can also answer on 5351. Require
      // the exact shape we asked for and keep listening otherwise.
      if (rinfo.address !== gateway) return;
      if (buf.length < 12 || buf[0] !== 0 || buf[1] !== expectOpcode) return;
      finish(buf);
    });
    const send = () => {
      if (done) return;
      if (attempt >= timeouts.length) return finish(null);
      const wait = timeouts[attempt++];
      try { sock.send(request, 0, request.length, NATPMP_PORT, gateway); } catch (e) { return finish(null); }
      timer = setTimeout(send, wait);
    };
    try { sock.bind(0, send); } catch (e) { finish(null); }
  });
}

async function natpmpExternalIp(gateway, timeouts) {
  const buf = await natpmpExchange(gateway, Buffer.from([0x00, 0x00]), 128, timeouts);
  if (!buf) return null;
  const result = buf.readUInt16BE(2);
  if (result !== 0) return { error: result };
  // Bytes 8-11 are the address in natural order - do NOT byte-swap.
  return { ip: `${buf[8]}.${buf[9]}.${buf[10]}.${buf[11]}`, sssoe: buf.readUInt32BE(4) };
}

/** Create (lifetime>0) or delete (lifetime=0, suggested=0) a TCP or UDP mapping. */
async function natpmpMap(gateway, internalPort, suggestedExternal, lifetime, timeouts, protocol = 'TCP') {
  const op = String(protocol).toUpperCase() === 'UDP' ? 1 : 2;   // RFC 6886: 1 = UDP, 2 = TCP
  const req = Buffer.alloc(12);
  req.writeUInt8(0, 0);
  req.writeUInt8(op, 1);
  req.writeUInt16BE(0, 2);                    // reserved, MUST be zero
  req.writeUInt16BE(internalPort, 4);
  req.writeUInt16BE(suggestedExternal, 6);
  req.writeUInt32BE(lifetime, 8);
  const buf = await natpmpExchange(gateway, req, 128 + op, timeouts);
  if (!buf || buf.length < 16) return null;
  const result = buf.readUInt16BE(2);
  if (result !== 0) return { error: result };
  return {
    // The router's answers are authoritative and may differ from what we asked.
    internalPort: buf.readUInt16BE(8),
    externalPort: buf.readUInt16BE(10),
    lifetime: buf.readUInt32BE(12),
    sssoe: buf.readUInt32BE(4),
  };
}

const NATPMP_ERRORS = {
  1: 'the router does not support this version',
  2: 'the router has port mapping turned off',
  3: 'the router has no internet connection',
  4: 'the router is out of mapping resources',
  5: 'the router does not support this operation',
};

// ---------------------------------------------------------------------------
// UPnP IGD — SSDP discovery
// ---------------------------------------------------------------------------

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;

// miniupnpc's search order, which is what firmware is tested against.
const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
  'upnp:rootdevice',
];

const UA = `${process.platform}/${os.release()} UPnP/1.1 Beebo/1.0`;

/** Case-insensitive header lookup over a raw SSDP response. */
function header(text, name) {
  const re = new RegExp('^' + name + '\\s*:\\s*(.*)$', 'im');
  const m = re.exec(text);
  return m ? m[1].trim() : '';
}

/**
 * Find IGDs on the LAN.
 *
 * Two details that decide whether this works at all:
 *   - Bind an EPHEMERAL port, not 1900. Responses to M-SEARCH come back unicast
 *     to our source port, and binding 1900 collides with Windows' own SSDP
 *     Discovery service.
 *   - Bind to the gateway-facing localIp and setMulticastInterface. Binding
 *     0.0.0.0 on a machine with a VPN or Docker bridge sends the multicast out
 *     an arbitrary interface and yields nothing. This is the single most common
 *     cause of "UPnP works for everyone but me".
 */
function ssdpDiscover(localIp, gateway, windowMs = 3000) {
  return new Promise((resolve) => {
    const found = new Map(); // LOCATION -> { location, st, usn }
    let sock;
    const finish = () => {
      try { sock.close(); } catch (e) {}
      const list = [...found.values()];
      // Rank: the default gateway is the strongest signal we have, then
      // anything self-describing as an IGD, then the rest.
      list.sort((a, b) => rank(a) - rank(b));
      resolve(list.slice(0, 3));
    };
    const rank = (r) => {
      let host = '';
      try { host = new URL(r.location).hostname; } catch (e) {}
      if (gateway && host === gateway) return 0;
      if (/InternetGatewayDevice|WAN(IP|PPP)Connection/i.test(r.st + ' ' + r.usn)) return 1;
      return 2;
    };

    try {
      sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    } catch (e) { return resolve([]); }

    sock.on('error', () => { try { sock.close(); } catch (e) {} resolve([]); });
    sock.on('message', (buf, rinfo) => {
      if (buf.length > 4096) return;   // an SSDP reply is a few hundred bytes
      const text = buf.toString('utf8');
      if (!/^HTTP\/1\.\d\s+200/i.test(text)) return;
      const location = header(text, 'LOCATION');
      if (!location || found.has(location)) return;
      // Only the router: see acceptLocation (security review #19).
      if (!acceptLocation(location, { gateway, localIp, responderIp: rinfo && rinfo.address })) return;
      found.set(location, { location, st: header(text, 'ST'), usn: header(text, 'USN') });
    });

    const blast = () => {
      for (const st of SEARCH_TARGETS) {
        // MAN's value is quoted; ST's is not. Getting that wrong is a classic
        // cause of zero replies. MX is mandatory for multicast M-SEARCH.
        const msg = Buffer.from(
          'M-SEARCH * HTTP/1.1\r\n' +
          `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
          'MAN: "ssdp:discover"\r\n' +
          'MX: 2\r\n' +
          `ST: ${st}\r\n` +
          `USER-AGENT: ${UA}\r\n` +
          '\r\n', 'utf8');
        try { sock.send(msg, 0, msg.length, SSDP_PORT, SSDP_ADDR); } catch (e) {}
      }
    };

    try {
      sock.bind(0, localIp || undefined, () => {
        try {
          sock.setMulticastTTL(2);                       // UDA v1.1 default
          if (localIp) sock.setMulticastInterface(localIp);
        } catch (e) {}
        blast();
        // Multicast is lossy and unretransmitted; a second blast roughly halves
        // the miss rate for nothing.
        setTimeout(blast, 600);
        setTimeout(finish, windowMs);
      });
    } catch (e) { resolve([]); }
  });
}

// ---------------------------------------------------------------------------
// UPnP IGD — device description
// ---------------------------------------------------------------------------

const XML_ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
const decodeXml = (s) => String(s).replace(/&(amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m]).trim();

// Everything below scans with indexOf, never a regex over the document. The old
// lazy `[\s\S]*?` patterns went quadratic on a description full of unclosed
// tags: 20k `<service>` (180 KB) froze the main thread for 3.4 s, on every
// rediscovery (security review #19). Each scan here is linear: it finds the
// FIRST matching open tag and one close after it; if that close is missing, no
// later open tag can have one either, so it stops.

// ASCII-only lowercase keeps every index identical to the original string.
const asciiLower = (s) => String(s).replace(/[A-Z]/g, (c) => c.toLowerCase());
const isNameChar = (c) => {
  const n = c.charCodeAt(0);
  return (n >= 97 && n <= 122) || (n >= 65 && n <= 90) || (n >= 48 && n <= 58) || n === 95 || n === 46 || n === 45;
};

/** The local (unprefixed) name of the tag starting at lower[i] === '<'. */
function tagNameAt(lower, i) {
  let j = i + 1;
  if (lower[j] === '/') j++;
  const start = j;
  while (j < lower.length && isNameChar(lower[j])) j++;
  const full = lower.slice(start, j);
  const colon = full.indexOf(':');
  return { local: colon >= 0 ? full.slice(colon + 1) : full, prefixed: colon >= 0, end: j };
}

/**
 * Find <[prefix:]name ...> ... </[prefix:]name> from `from`. Returns
 * { openStart, contentStart, contentEnd, closeEnd } or null.
 */
function findElement(xml, lower, name, from = 0, { allowPrefix = true } = {}) {
  const want = asciiLower(name);
  let i = lower.indexOf('<', from);
  while (i !== -1) {
    if (lower[i + 1] !== '/') {
      const t = tagNameAt(lower, i);
      if (t.local === want && (allowPrefix || !t.prefixed)) {
        const gt = lower.indexOf('>', t.end);
        if (gt === -1) return null;
        let k = lower.indexOf('</', gt + 1);
        while (k !== -1) {
          const c = tagNameAt(lower, k);
          if (c.local === want && (allowPrefix || !c.prefixed)) {
            const closeGt = lower.indexOf('>', c.end);
            if (closeGt === -1) return null;
            return { openStart: i, contentStart: gt + 1, contentEnd: k, closeEnd: closeGt + 1 };
          }
          k = lower.indexOf('</', k + 2);
        }
        return null;   // no close anywhere after the first open: none will match
      }
    }
    i = lower.indexOf('<', i + 1);
  }
  return null;
}

/** Read one element by LOCAL name, tolerating a namespace prefix. */
function tag(xml, name) {
  const s = String(xml || '');
  const el = findElement(s, asciiLower(s), name);
  return el ? decodeXml(s.slice(el.contentStart, el.contentEnd)) : '';
}

// A real IGD description is a few KB; anything this size is not one.
const MAX_DESCRIPTION_BYTES = 64 * 1024;

function httpGet(url, timeoutMs = 3000, maxBytes = MAX_DESCRIPTION_BYTES) {
  return new Promise((resolve) => {
    let req;
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    const abort = () => { try { req.destroy(); } catch (e) {} finish(''); };
    try {
      req = http.get(url, { agent: false, headers: { Connection: 'close', 'User-Agent': UA } }, (res) => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) { res.resume(); return finish(''); }
        if (Number(res.headers['content-length']) > maxBytes) return abort();
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          // Stop reading the moment it's too big, rather than keeping a prefix.
          if (size > maxBytes) return abort();
          chunks.push(c);
        });
        res.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
        res.on('error', () => finish(''));
      });
    } catch (e) { return finish(''); }
    req.on('error', () => finish(''));
    req.setTimeout(timeoutMs, abort);
  });
}

/**
 * Should we fetch this SSDP LOCATION at all? Any LAN device can answer an
 * M-SEARCH, and fetching wherever it points gives it a blind GET (and later a
 * SOAP POST) to any host. Only the default gateway is the router we want.
 *
 * When the route lookup found no gateway, fall back to: the device answering
 * is the host in its own LOCATION, and that host is .1 on our /24 — where
 * consumer routers sit.
 */
function acceptLocation(location, { gateway, localIp, responderIp } = {}) {
  let u;
  try { u = new URL(location); } catch (e) { return false; }
  if (u.protocol !== 'http:' || !isIPv4(u.hostname)) return false;
  const host = u.hostname;
  if (gateway) return host === gateway;
  if (!isIPv4(localIp) || responderIp !== host) return false;
  return inNet(host, localIp, 24) && host.endsWith('.1');
}

/** Drop services whose control URL leaves the description's own host. */
function sameHostServices(services, locationUrl) {
  let host = '';
  try { host = new URL(locationUrl).host; } catch (e) { return []; }
  const onHost = (url) => { try { return new URL(url).host === host; } catch (e) { return false; } };
  const out = [];
  for (const s of services) {
    const primary = onHost(s.controlUrl) ? s.controlUrl : '';
    const fallback = s.fallbackUrl && onHost(s.fallbackUrl) ? s.fallbackUrl : '';
    if (!primary && !fallback) continue;
    out.push({ ...s, controlUrl: primary || fallback, fallbackUrl: primary && fallback ? fallback : '' });
  }
  return out;
}

// Preference order. WANPPPConnection is DSL/PPPoE gateways; the action
// signatures are identical, only the serviceType string differs.
const SERVICE_ORDER = [
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANPPPConnection:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];

/**
 * Pull every usable connection service out of a description document.
 *
 * The important subtlety: controlURL must come from INSIDE the same <service>
 * block as its serviceType. Grabbing the document's first controlURL is a
 * classic bug - it usually belongs to Layer3Forwarding or
 * WANCommonInterfaceConfig, and then every SOAP call fails with 404 or 500.
 */
function servicesFrom(xml, locationUrl) {
  xml = String(xml || '');
  const urlBase = tag(xml, 'URLBase');
  const out = [];
  const lower = asciiLower(xml);
  const blocks = [];
  for (let pos = 0; ;) {
    const el = findElement(xml, lower, 'service', pos, { allowPrefix: false });
    if (!el) break;
    blocks.push(xml.slice(el.contentStart, el.contentEnd));
    pos = el.closeEnd;
  }
  for (const block of blocks) {
    const serviceType = tag(block, 'serviceType');
    const controlURL = tag(block, 'controlURL');
    if (!serviceType || !controlURL) continue;
    if (!SERVICE_ORDER.includes(serviceType)) continue;
    // URLBase is deprecated in UDA 1.1 but must still be honoured for 1.0
    // devices. new URL() gives us RFC 3986 resolution for free.
    let resolved = '', viaLocation = '';
    try { resolved = new URL(controlURL, urlBase || locationUrl).toString(); } catch (e) { continue; }
    try { viaLocation = new URL(controlURL, locationUrl).toString(); } catch (e) {}
    out.push({ serviceType, controlUrl: resolved, fallbackUrl: viaLocation !== resolved ? viaLocation : '' });
  }
  out.sort((a, b) => SERVICE_ORDER.indexOf(a.serviceType) - SERVICE_ORDER.indexOf(b.serviceType));
  return out;
}

// ---------------------------------------------------------------------------
// UPnP IGD — SOAP
// ---------------------------------------------------------------------------

/**
 * One SOAP call.
 *
 * Every framing detail below is load-bearing against real firmware:
 *   - SOAPAction's value INCLUDES the surrounding double quotes. Unquoted gets
 *     401 or 500 from many devices.
 *   - Content-Type must be text/xml with charset="utf-8" quoted. SOAP 1.2's
 *     application/soap+xml is rejected; IGD is SOAP 1.1.
 *   - Explicit Content-Length, never chunked. Node chunks by default and a
 *     meaningful share of IGD firmware cannot parse chunked bodies.
 *   - Connection: close and agent:false. Node's keep-alive agent hangs against
 *     firmware that never sends a proper terminator.
 *   - 5s timeout: writing a NAT rule to flash is slow on cheap hardware, and 2s
 *     produces spurious failures.
 */
function soapCall(controlUrl, serviceType, action, argsXml, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const body =
      '<?xml version="1.0"?>\n' +
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
      's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
      '<s:Body>' +
      `<u:${action} xmlns:u="${serviceType}">${argsXml}</u:${action}>` +
      '</s:Body></s:Envelope>';
    const payload = Buffer.from(body, 'utf8');

    let target;
    try { target = new URL(controlUrl); } catch (e) { return resolve({ ok: false, transport: true }); }

    const opts = {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 80,
      path: target.pathname + target.search,
      method: 'POST',
      agent: false,
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPAction: `"${serviceType}#${action}"`,
        'Content-Length': payload.length,   // BYTE length, from Buffer
        Connection: 'close',
        'User-Agent': UA,
      },
    };

    let req;
    try {
      req = http.request(opts, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { if (text.length < 256 * 1024) text += c; });
        res.on('end', () => {
          // Do NOT branch on status first. Faults are specified as HTTP 500,
          // but some firmware sends a Fault body with 200 and some sends 500
          // with a success body. The body is the truth.
          const codeText = tag(text, 'errorCode');
          if (codeText) {
            return resolve({ ok: false, errorCode: parseInt(codeText, 10), errorText: tag(text, 'errorDescription'), body: text });
          }
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) return resolve({ ok: true, body: text });
          resolve({ ok: false, status: res.statusCode, body: text });
        });
      });
    } catch (e) { return resolve({ ok: false, transport: true }); }

    req.on('error', () => resolve({ ok: false, transport: true }));
    req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch (e) {} resolve({ ok: false, transport: true }); });
    // One writev, no prior write(): old Linksys firmware only honoured SOAP
    // requests that arrived in a single packet.
    req.end(payload);
  });
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function upnpExternalIp(svc) {
  // Open+close pair rather than a self-closing tag: that is what miniupnpc
  // emits and what firmware is tested against.
  const r = await soapCall(svc.controlUrl, svc.serviceType, 'GetExternalIPAddress', '');
  if (!r.ok) return null;
  const ip = tag(r.body, 'NewExternalIPAddress');
  return ip || null;   // empty string means "WAN not up", not an address
}

/**
 * Argument ORDER is load-bearing - some firmware parses positionally and
 * returns 402 Invalid Args if you reorder. Argument elements are unqualified;
 * only the action element carries the namespace.
 */
const protoArg = (p) => (String(p || 'TCP').toUpperCase() === 'UDP' ? 'UDP' : 'TCP');

function addMappingArgs(externalPort, internalPort, internalClient, description, lease, protocol = 'TCP') {
  return '<NewRemoteHost></NewRemoteHost>' +
    `<NewExternalPort>${externalPort}</NewExternalPort>` +
    `<NewProtocol>${protoArg(protocol)}</NewProtocol>` +
    `<NewInternalPort>${internalPort}</NewInternalPort>` +
    `<NewInternalClient>${esc(internalClient)}</NewInternalClient>` +
    '<NewEnabled>1</NewEnabled>' +
    `<NewPortMappingDescription>${esc(description)}</NewPortMappingDescription>` +
    `<NewLeaseDuration>${lease}</NewLeaseDuration>`;
}

const tupleArgs = (externalPort, protocol = 'TCP') =>
  '<NewRemoteHost></NewRemoteHost>' +
  `<NewExternalPort>${externalPort}</NewExternalPort>` +
  `<NewProtocol>${protoArg(protocol)}</NewProtocol>`;

async function upnpGetMapping(svc, externalPort, protocol = 'TCP') {
  const r = await soapCall(svc.controlUrl, svc.serviceType, 'GetSpecificPortMappingEntry', tupleArgs(externalPort, protocol));
  if (!r.ok) return { missing: r.errorCode === 714, errorCode: r.errorCode };
  return {
    internalPort: parseInt(tag(r.body, 'NewInternalPort'), 10) || 0,
    internalClient: tag(r.body, 'NewInternalClient'),
    description: tag(r.body, 'NewPortMappingDescription'),
    leaseRemaining: parseInt(tag(r.body, 'NewLeaseDuration'), 10) || 0,
  };
}

async function upnpDelete(svc, externalPort, protocol = 'TCP') {
  const r = await soapCall(svc.controlUrl, svc.serviceType, 'DeletePortMapping', tupleArgs(externalPort, protocol));
  // 714 NoSuchEntryInArray means it was already gone - that IS success.
  return r.ok || r.errorCode === 714;
}

/**
 * Add a mapping, working around the two things routers most often get wrong.
 *
 * LEASE DURATION is the highest-value detail in the whole UPnP path. IGD:1 says
 * plainly that not all NAT implementations support non-infinite leases; many
 * consumer routers accept only 0. Some report that correctly as 725, but plenty
 * return a bare 501 or 402. So: try a finite lease, and on any of those three
 * fall back to 0 - changing ONLY the lease, so the outcome stays interpretable.
 *
 * `leaseMode` is threaded through so a caller can remember the answer and skip
 * the doomed first rung on later calls.
 */
async function upnpAddMapping(svc, externalPort, internalPort, internalClient, description, leaseMode, protocol = 'TCP') {
  const attempt = async (lease) =>
    soapCall(svc.controlUrl, svc.serviceType, 'AddPortMapping',
      addMappingArgs(externalPort, internalPort, internalClient, description, lease, protocol));

  if (leaseMode !== 'permanent') {
    const r = await attempt(3600);
    if (r.ok) return { ok: true, leaseMode: 'finite' };
    if (![725, 501, 402].includes(r.errorCode)) return { ok: false, errorCode: r.errorCode, transport: r.transport };
  }
  const r0 = await attempt(0);
  if (r0.ok) return { ok: true, leaseMode: 'permanent' };
  return { ok: false, errorCode: r0.errorCode, transport: r0.transport };
}

const UPNP_ERRORS = {
  402: 'the router rejected the request as malformed',
  501: 'the router refused the request',
  606: 'the router requires authorised UPnP access',
  715: 'the router rejected the internal address',
  716: 'the router rejected the external port',
  718: 'that port is already forwarded to a different device',
  724: 'the router cannot forward one port to a different one',
  725: 'the router only supports permanent forwards',
  727: 'the router can only forward every port at once, not a single one',
  728: "the router's port-forwarding table is full",
  729: 'the port conflicts with an existing rule on the router',
};

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

// Startup budget: short, because nothing here may delay the app being usable.
const NATPMP_STARTUP_TIMEOUTS = [250, 500];
// Renewal runs in the background with nobody waiting, so it can be patient.
const NATPMP_RENEW_TIMEOUTS = [250, 500, 1000, 2000, 4000];

/** IANA dynamic range, for when our preferred port is already taken. */
function alternatePorts(n) {
  const out = [];
  while (out.length < n) {
    const p = 49152 + Math.floor(Math.random() * (65535 - 49152));
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * Create a port mapper.
 *
 *   port         the port the service listens on (47811 for the media server)
 *   externalPort what the router should listen on outside (default: port)
 *   protocol     'TCP' (default) or 'UDP'
 *   count        how many consecutive ports, starting at port/externalPort
 *                (default 1). The host agent's WebRTC range uses this.
 *   alternates   try random outside ports when ours is taken (default: only
 *                for a single port; a range keeps its numbers or skips one)
 *   description  short ASCII marker written into the router's table
 *   log          optional (message) => void
 *   onChange     optional (status) => void after every attempt and on stop
 *
 * Returns { start, stop, refresh, status }.
 */
function createPortMapper(opts) {
  const PORT = (opts && opts.port) || 47811;
  // The port the OUTSIDE world uses. Normally the same as PORT, but some
  // providers block particular ports inbound, so the owner can ask the router
  // to listen on a different number and forward it to ours. A router that
  // cannot map one port to another answers 724/727 and we fall back below.
  const EXTERNAL_PORT = (opts && opts.externalPort) || PORT;
  const PROTOCOL = protoArg(opts && opts.protocol);
  const COUNT = Math.max(1, Math.min(64, Math.floor(Number(opts && opts.count) || 1)));
  const ALTERNATES = opts && typeof opts.alternates === 'boolean' ? opts.alternates : COUNT === 1;
  const DESCRIPTION = (opts && opts.description) || 'Beebo Media';
  const rawLog = opts && opts.log;
  const onChange = opts && opts.onChange;
  // Test seams ONLY, so tests never reach a real router: a fixed gateway and LAN
  // address, and a fixed UPnP service list instead of SSDP discovery.
  const T = (opts && opts._test) || null;
  const log = (m) => { try { if (typeof rawLog === 'function') rawLog('[port-map' + (PROTOCOL === 'UDP' ? ' udp' : '') + '] ' + m); } catch (e) {} };
  const changed = () => { try { if (typeof onChange === 'function') onChange(status()); } catch (e) {} };

  let state = {
    active: false,
    method: '',            // 'nat-pmp' | 'upnp' | ''
    protocol: PROTOCOL,
    externalIp: '',
    externalPort: 0,       // the first mapping's outside port (single-port callers)
    mappings: [],          // [{ internal, external }] actually granted
    wanted: COUNT,         // how many ports were asked for
    localIp: '',
    gateway: '',
    reachable: false,      // external address is actually routable
    reason: '',            // human-readable when not reachable
    kind: '',              // 'cgnat' | 'double-nat' | 'wan-down' | ...
    lastAttempt: 0,
  };

  let stopped = false;
  let timer = null;
  let upnpService = null;       // the service we successfully used
  let leaseMode = '';           // remembered across renewals
  let lastSssoe = 0, lastSssoeAt = 0;
  let running = false;

  const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };

  function schedule(seconds) {
    clearTimer();
    if (stopped) return;
    // Renew at half the granted lifetime (RFC 6886), with jitter so a houseful
    // of devices doesn't re-map in lockstep.
    const base = Math.max(60, Math.floor(seconds / 2));
    const jitter = base * (0.9 + Math.random() * 0.2);
    log(`next refresh in ${Math.round(jitter / 60)} min`);
    timer = setTimeout(() => { attempt(false).catch(() => {}); }, jitter * 1000);
  }

  /** Did the router reboot and lose our mapping? RFC 6886 SSSoE check. */
  function gatewayRebooted(sssoe) {
    if (!lastSssoe || !lastSssoeAt) return false;
    const elapsed = (Date.now() - lastSssoeAt) / 1000;
    return sssoe < (lastSssoe + 0.875 * elapsed) - 2;
  }

  /** The outside port previously GRANTED for an internal one, if any. */
  const grantedFor = (method, internal) => {
    if (state.method !== method) return 0;
    const m = state.mappings.find((x) => x.internal === internal);
    return m ? m.external : 0;
  };

  async function tryNatPmp(gateway, timeouts) {
    const ext = await natpmpExternalIp(gateway, timeouts);
    if (!ext) return null;                       // no NAT-PMP here
    if (ext.error) {
      log(`NAT-PMP: ${NATPMP_ERRORS[ext.error] || 'error ' + ext.error}`);
      // 2 = administratively disabled. Still fall through to UPnP: some
      // firmware gates the two mechanisms independently.
      return null;
    }
    if (ext.sssoe) {
      if (gatewayRebooted(ext.sssoe)) log('router appears to have restarted; re-creating the mapping');
      lastSssoe = ext.sssoe; lastSssoeAt = Date.now();
    }

    const mappings = [];
    let lifetime = 7200;
    for (let i = 0; i < COUNT; i++) {
      const internal = PORT + i;
      // Renewals must suggest the port we were previously GIVEN, not the one we
      // originally wanted - that is the one field that differs on renewal.
      const suggest = grantedFor('nat-pmp', internal) || (EXTERNAL_PORT + i);
      const map = await natpmpMap(gateway, internal, suggest, 7200, timeouts, PROTOCOL);
      if (!map) { if (!mappings.length) return null; break; }   // stopped answering
      if (map.error) {
        log(`NAT-PMP mapping ${PROTOCOL} ${internal}: ${NATPMP_ERRORS[map.error] || 'error ' + map.error}`);
        if (!mappings.length && i === 0) return null;
        continue;
      }
      mappings.push({ internal, external: map.externalPort });
      lifetime = Math.min(lifetime, map.lifetime || 7200);
    }
    if (!mappings.length) return null;
    return { externalIp: ext.ip, mappings, lifetime };
  }

  async function tryUpnp(localIp, gateway) {
    // Reuse the service we already proved works, rather than re-discovering.
    let services = upnpService ? [upnpService] : (T && T.upnpServices) || null;

    if (!services) {
      if (T) return null;   // a test never discovers the real LAN
      const devices = await ssdpDiscover(localIp, gateway);
      if (!devices.length) { log('no UPnP gateway answered'); return null; }
      services = [];
      for (const d of devices) {
        const xml = await httpGet(d.location);
        if (!xml) continue;
        // SOAP only ever goes to the host that served the description.
        for (const s of sameHostServices(servicesFrom(xml, d.location), d.location)) services.push(s);
        if (services.length) break;   // first device that yields a service wins
      }
      if (!services.length) { log('UPnP gateway had no usable connection service'); return null; }
    }

    for (const svc of services) {
      let ip = await upnpExternalIp(svc);
      if (!ip && svc.fallbackUrl) {
        // Some firmware emits a URLBase with the wrong port or an unresolvable
        // host. Retry once resolved against LOCATION instead.
        const alt = { ...svc, controlUrl: svc.fallbackUrl, fallbackUrl: '' };
        ip = await upnpExternalIp(alt);
        if (ip) { svc.controlUrl = alt.controlUrl; }
      }
      if (!ip) continue;

      const mappings = [];
      let refused = false;
      for (let i = 0; i < COUNT && !refused; i++) {
        const internal = PORT + i;
        // Our preferred port, then (single port only) a few from the dynamic
        // range if it's taken. A range keeps its numbers, so a taken one is skipped.
        const preferred = grantedFor('upnp', internal) || (EXTERNAL_PORT + i);
        const candidates = ALTERNATES ? [preferred, ...alternatePorts(3)] : [preferred];
        for (const ext of candidates) {
          const existing = await upnpGetMapping(svc, ext, PROTOCOL);
          if (existing && existing.internalClient && existing.internalClient !== localIp) {
            log(`${PROTOCOL} ${ext} is already forwarded to ${existing.internalClient}; ${ALTERNATES ? 'trying another' : 'skipping it'}`);
            continue;                                   // someone else's mapping
          }
          if (existing && existing.internalClient === localIp && existing.internalPort !== internal) {
            // Ours, but stale and pointing at the wrong internal port.
            await upnpDelete(svc, ext, PROTOCOL);
          }

          const r = await upnpAddMapping(svc, ext, internal, localIp, DESCRIPTION, leaseMode, PROTOCOL);
          if (r.ok) {
            leaseMode = r.leaseMode;
            mappings.push({ internal, external: ext });
            break;
          }
          if (r.errorCode === 724 || r.errorCode === 727) {
            // This router cannot map one port to a different one, or can only do
            // DMZ-style wildcards. Walking the ladder is pointless.
            log(`UPnP: ${UPNP_ERRORS[r.errorCode]}`);
            break;
          }
          if (r.errorCode && r.errorCode !== 718 && r.errorCode !== 729) {
            // A flat refusal (606 not authorised, 501, ...) will not change for
            // the next port in a range either. Stop asking.
            log(`UPnP: ${UPNP_ERRORS[r.errorCode] || 'error ' + r.errorCode}`);
            refused = true;
            break;
          }
        }
      }
      if (mappings.length) {
        upnpService = svc;
        // Even in "permanent" mode we re-add periodically: on an IGD:2 device
        // a lease of 0 is silently reinterpreted as one week, not forever.
        return { externalIp: ip, mappings, lifetime: 3600, service: svc };
      }
    }
    return null;
  }

  async function attempt(isStartup) {
    if (stopped || running) return status();
    running = true;
    try {
      state.lastAttempt = Date.now();
      const gateway = state.gateway || (T ? T.gateway || '' : await findGateway());
      state.gateway = gateway;
      // No route found: a private address from node:os still lets UPnP accept
      // the router at .1 on our subnet (acceptLocation's fallback).
      const localIp = T ? T.localIp || '' : (gateway ? await localIpFor(gateway) : lanIpFromOs());
      state.localIp = localIp;
      log(gateway ? `gateway ${gateway}, this machine ${localIp || 'unknown'}` : 'no default gateway found');

      let result = null;
      if (gateway) {
        result = await tryNatPmp(gateway, isStartup ? NATPMP_STARTUP_TIMEOUTS : NATPMP_RENEW_TIMEOUTS);
        if (result) { state.method = 'nat-pmp'; log(`NAT-PMP mapped ${result.mappings.length} of ${COUNT} ${PROTOCOL} port(s)`); }
      }
      if (!result) {
        result = await tryUpnp(localIp, gateway);
        if (result) { state.method = 'upnp'; log(`UPnP mapped ${result.mappings.length} of ${COUNT} ${PROTOCOL} port(s)`); }
      }

      if (!result) {
        state.active = false; state.reachable = false;
        state.mappings = []; state.externalPort = 0;
        state.reason = 'This router did not accept an automatic port request.';
        state.kind = 'no-mapping';
        log('no mapping: ' + state.reason);
        schedule(1800);          // try again in ~15 min; routers come and go
        return status();
      }

      state.active = true;
      state.externalIp = result.externalIp;
      state.mappings = result.mappings;
      state.externalPort = result.mappings[0].external;

      // The mapping "succeeded" - but if the address behind it is CGNAT or
      // another private range, inbound still cannot work. Say so rather than
      // reporting a success the user will discover is fictional.
      const verdict = classifyExternal(result.externalIp);
      state.reachable = verdict.ok;
      state.reason = verdict.message;
      state.kind = verdict.kind;
      if (!verdict.ok) log(`mapped, but not reachable: ${verdict.message}`);
      else log(`reachable at ${result.externalIp}:${state.externalPort}${COUNT > 1 ? ' (+' + (result.mappings.length - 1) + ' more)' : ''}`);

      // CGNAT never resolves itself, so stop burning cycles on it.
      if (verdict.kind === 'cgnat') { clearTimer(); return status(); }
      schedule(result.lifetime);
      return status();
    } catch (e) {
      log('attempt failed: ' + (e && e.message));
      schedule(1800);
      return status();
    } finally {
      running = false;
      changed();
    }
  }

  function status() { return { ...state, mappings: state.mappings.map((m) => ({ ...m })) }; }

  /**
   * Begin. Never throws, never blocks - call it after the window is up.
   */
  function start() {
    stopped = false;
    setTimeout(() => { attempt(true).catch(() => {}); }, 0);
  }

  /** Force an immediate re-attempt (e.g. the network changed). */
  function refresh() { clearTimer(); return attempt(false); }

  /**
   * Remove the mapping. Call on quit.
   *
   * This matters most when leaseMode landed on 'permanent': on an IGD:1 device
   * that mapping genuinely survives the process dying, the machine rebooting,
   * and the app being uninstalled. Leaving it behind is leaving a hole open.
   */
  async function stop() {
    stopped = true;
    clearTimer();
    if (!state.active) return;
    try {
      for (const m of state.mappings) {
        if (state.method === 'nat-pmp' && state.gateway) {
          // Delete = same request with suggested external port AND lifetime zero.
          await natpmpMap(state.gateway, m.internal, 0, 0, [250], PROTOCOL);
        } else if (state.method === 'upnp' && upnpService && m.external) {
          await upnpDelete(upnpService, m.external, PROTOCOL);
        }
      }
      log('mapping removed');
    } catch (e) { /* best effort */ }
    state.active = false;
    state.mappings = [];
    changed();
  }

  return { start, stop, refresh, status };
}

module.exports = {
  createPortMapper,
  // exported for tests
  _internal: {
    classifyExternal, inNet, u32, tag, servicesFrom, addMappingArgs, alternatePorts, isIPv4,
    acceptLocation, sameHostServices, httpGet, MAX_DESCRIPTION_BYTES,
    // wire-level, exported so the protocol encoders/decoders can be tested
    // against a fake router without needing a real one on the LAN
    natpmpExternalIp, natpmpMap, soapCall, upnpExternalIp, upnpAddMapping, upnpGetMapping, upnpDelete,
  },
};
