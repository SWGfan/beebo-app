/*
 * The host agent's WebRTC port range, mapped as UDP, against a FAKE router on
 * 127.0.0.1. createPortMapper runs with its _test seams (fixed gateway, LAN
 * address and UPnP service), so nothing here can reach the real router: no SSDP,
 * no route lookup, no packets to the real gateway.
 *
 * Run: node test/portmapper/test-udp-range.js
 */
const dgram = require('dgram');
const http = require('http');
const { createPortMapper, _internal: I } = require('../../electron/portMapper.js');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n + (x !== undefined ? '  -> ' + x : '')); } };

// A tiny IGD: records every SOAP call; some ports are someone else's; `refuse`
// answers every AddPortMapping with that UPnP error code.
function startIgd({ occupied = {}, refuse = 0 } = {}) {
  const calls = [];
  const table = new Map();   // "UDP:47821" -> client
  for (const [k, v] of Object.entries(occupied)) table.set(k, v);
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        const action = (/<u:(\w+)\s/.exec(body) || [])[1] || '';
        const proto = I.tag(body, 'NewProtocol');
        const port = I.tag(body, 'NewExternalPort');
        calls.push({ action, proto, port, lease: I.tag(body, 'NewLeaseDuration'), client: I.tag(body, 'NewInternalClient'), internal: I.tag(body, 'NewInternalPort') });
        const okRes = (inner) => { res.writeHead(200, { 'Content-Type': 'text/xml' }); res.end(`<s:Envelope><s:Body><u:${action}Response>${inner || ''}</u:${action}Response></s:Body></s:Envelope>`); };
        const fault = (code) => { res.writeHead(500, { 'Content-Type': 'text/xml' }); res.end(`<s:Envelope><s:Body><s:Fault><detail><UPnPError><errorCode>${code}</errorCode></UPnPError></detail></s:Fault></s:Body></s:Envelope>`); };
        const key = proto + ':' + port;
        if (action === 'GetExternalIPAddress') return okRes('<NewExternalIPAddress>81.2.69.142</NewExternalIPAddress>');
        if (action === 'GetSpecificPortMappingEntry') {
          if (!table.has(key)) return fault(714);
          return okRes(`<NewInternalPort>${port}</NewInternalPort><NewInternalClient>${table.get(key)}</NewInternalClient>`);
        }
        if (action === 'AddPortMapping') {
          if (refuse) return fault(refuse);
          if (table.has(key) && table.get(key) !== I.tag(body, 'NewInternalClient')) return fault(718);
          table.set(key, I.tag(body, 'NewInternalClient'));
          return okRes('');
        }
        if (action === 'DeletePortMapping') { table.delete(key); return okRes(''); }
        return fault(401);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, calls, table, svc: { serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:1', controlUrl: `http://127.0.0.1:${server.address().port}/ctl`, fallbackUrl: '' } }));
  });
}

const waitFor = async (fn, ms = 5000) => { const until = Date.now() + ms; while (Date.now() < until) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); } return null; };

(async () => {
  // ---- UPnP: a UDP range, one port already someone else's -----------------
  {
    const igd = await startIgd({ occupied: { 'UDP:47821': '192.168.1.99' } });
    const changes = [];
    const m = createPortMapper({
      port: 47820, count: 3, protocol: 'UDP', description: 'Beebo Remote',
      onChange: (s) => changes.push(s),
      _test: { gateway: '', localIp: '192.168.1.23', upnpServices: [igd.svc] },
    });
    m.start();
    const st = await waitFor(() => changes.find((s) => s.lastAttempt));
    ok('UDP range: attempt finished and onChange fired', !!st);
    ok('UDP range: active with the two free ports', st && st.active && st.mappings.length === 2, JSON.stringify(st && st.mappings));
    ok('UDP range: kept its own numbers, skipped the taken one',
      st && JSON.stringify(st.mappings) === JSON.stringify([{ internal: 47820, external: 47820 }, { internal: 47822, external: 47822 }]), JSON.stringify(st && st.mappings));
    ok('UDP range: reports UDP and how many were wanted', st && st.protocol === 'UDP' && st.wanted === 3);
    ok('UDP range: public external address', st && st.externalIp === '81.2.69.142' && st.reachable === true);
    const adds = igd.calls.filter((c) => c.action === 'AddPortMapping');
    ok('every SOAP call says UDP', igd.calls.filter((c) => c.action !== 'GetExternalIPAddress').every((c) => c.proto === 'UDP'));
    ok('no random alternate ports for a range', adds.length === 2 && adds.every((c) => ['47820', '47822'].includes(c.port)), JSON.stringify(adds.map((c) => c.port)));
    ok('maps to this machine, same internal port', adds.every((c) => c.client === '192.168.1.23' && c.internal === c.port));
    ok('the other device\'s forward is untouched', igd.table.get('UDP:47821') === '192.168.1.99');
    await m.stop();
    const dels = igd.calls.filter((c) => c.action === 'DeletePortMapping');
    ok('stop removes exactly our two UDP mappings', dels.length === 2 && dels.every((c) => c.proto === 'UDP'), JSON.stringify(dels));
    ok('stop leaves the other device alone', igd.table.size === 1 && igd.table.get('UDP:47821') === '192.168.1.99');
    ok('status after stop is inactive', m.status().active === false && m.status().mappings.length === 0);
    igd.server.close();
  }

  // ---- UPnP: router refuses outright (606 not authorised) -------------------
  {
    const igd = await startIgd({ refuse: 606 });
    const m = createPortMapper({ port: 47820, count: 10, protocol: 'UDP', _test: { localIp: '192.168.1.23', upnpServices: [igd.svc] } });
    const st = await m.refresh();
    ok('refused: no mapping, no throw', st && st.active === false && st.kind === 'no-mapping', JSON.stringify(st));
    ok('refused: stops asking after the first flat refusal', igd.calls.filter((c) => c.action === 'AddPortMapping').length === 1, igd.calls.filter((c) => c.action === 'AddPortMapping').length);
    await m.stop();
    ok('refused: stop with nothing mapped sends nothing', igd.calls.filter((c) => c.action === 'DeletePortMapping').length === 0);
    igd.server.close();
  }

  // ---- NAT-PMP: UDP opcode 1 for each port, and deletes on stop ------------
  const pmp = await new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    sock.on('error', () => resolve(null));
    sock.bind(5351, '127.0.0.1', () => resolve(sock));
  });
  if (pmp) {
    const seen = [];
    pmp.on('message', (buf, rinfo) => {
      seen.push(Buffer.from(buf));
      const op = buf[1];
      if (op === 0) {
        const r = Buffer.alloc(12); r.writeUInt8(128, 1); r.writeUInt32BE(5000, 4); [81, 2, 69, 142].forEach((o, i) => r.writeUInt8(o, 8 + i));
        return pmp.send(r, rinfo.port, rinfo.address);
      }
      if (op === 1 || op === 2) {
        const internal = buf.readUInt16BE(4), suggested = buf.readUInt16BE(6), life = buf.readUInt32BE(8);
        const r = Buffer.alloc(16); r.writeUInt8(128 + op, 1); r.writeUInt32BE(5000, 4);
        r.writeUInt16BE(internal, 8); r.writeUInt16BE(life ? suggested : 0, 10); r.writeUInt32BE(life ? 3600 : 0, 12);
        return pmp.send(r, rinfo.port, rinfo.address);
      }
    });
    const m = createPortMapper({ port: 47820, count: 3, protocol: 'UDP', _test: { gateway: '127.0.0.1', localIp: '127.0.0.1' } });
    const st = await m.refresh();
    ok('NAT-PMP UDP: method and three mappings', st.method === 'nat-pmp' && st.mappings.length === 3, JSON.stringify(st));
    const maps = seen.filter((b) => b.length === 12);
    ok('NAT-PMP UDP: opcode 1 on every mapping request', maps.length === 3 && maps.every((b) => b[1] === 1), maps.map((b) => b[1]).join(','));
    ok('NAT-PMP UDP: internal ports 47820-47822', maps.map((b) => b.readUInt16BE(4)).join(',') === '47820,47821,47822');
    seen.length = 0;
    await m.stop();
    const dels = seen.filter((b) => b.length === 12);
    ok('NAT-PMP UDP: stop deletes all three (lifetime 0, opcode 1)', dels.length === 3 && dels.every((b) => b[1] === 1 && b.readUInt32BE(8) === 0), dels.length);
    pmp.close();
  } else {
    console.log('  (skipped NAT-PMP UDP tests - could not bind udp/5351 on 127.0.0.1)');
  }

  // ---- wire: the single-port TCP path is unchanged ---------------------------
  ok('addMappingArgs defaults to TCP', I.tag(I.addMappingArgs(1, 1, 'a', 'd', 0), 'NewProtocol') === 'TCP');
  ok('addMappingArgs UDP', I.tag(I.addMappingArgs(1, 1, 'a', 'd', 0, 'udp'), 'NewProtocol') === 'UDP');

  console.log(`\nudp range: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
