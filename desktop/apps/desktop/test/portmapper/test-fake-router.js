/*
 * Stands up a fake router that speaks NAT-PMP and UPnP IGD, then drives the
 * REAL client code against it. This is the closest thing to a live router test
 * that can run without one.
 */
const dgram = require('dgram');
const http = require('http');
const { _internal: I } = require('../../electron/portMapper.js');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n + (x !== undefined ? '  -> ' + x : '')); } };

// ---------------------------------------------------------------- fake NAT-PMP
// Records exactly what the client sent so the wire format can be asserted.
const seen = { natpmp: [] };
function startNatPmp(externalIp, behaviour = {}) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    sock.on('message', (buf, rinfo) => {
      seen.natpmp.push(Buffer.from(buf));
      const version = buf[0], op = buf[1];
      if (version !== 0) return;
      if (op === 0) {                                   // external address
        const res = Buffer.alloc(12);
        res.writeUInt8(0, 0); res.writeUInt8(128, 1);
        res.writeUInt16BE(behaviour.extResult || 0, 2);
        res.writeUInt32BE(behaviour.sssoe || 1000, 4);
        externalIp.split('.').forEach((o, i) => res.writeUInt8(Number(o), 8 + i));
        sock.send(res, rinfo.port, rinfo.address);
      } else if (op === 2) {                            // TCP mapping
        const internal = buf.readUInt16BE(4);
        const suggested = buf.readUInt16BE(6);
        const lifetime = buf.readUInt32BE(8);
        const res = Buffer.alloc(16);
        res.writeUInt8(0, 0); res.writeUInt8(130, 1);
        res.writeUInt16BE(behaviour.mapResult || 0, 2);
        res.writeUInt32BE(behaviour.sssoe || 1000, 4);
        res.writeUInt16BE(internal, 8);
        // Deliberately hand back a DIFFERENT external port than requested, to
        // prove the client uses the router's answer and not its own suggestion.
        res.writeUInt16BE(lifetime === 0 ? 0 : (behaviour.grantPort || 51234), 10);
        res.writeUInt32BE(lifetime === 0 ? 0 : (behaviour.grantLifetime || 3600), 12);
        sock.send(res, rinfo.port, rinfo.address);
      }
    });
    sock.bind(0, '127.0.0.1', () => resolve({ sock, port: sock.address().port }));
  });
}

// ------------------------------------------------------------------ fake IGD
const seenSoap = [];
function startIgd(opts = {}) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/rootDesc.xml') {
        const base = opts.urlBase ? `<URLBase>${opts.urlBase}</URLBase>` : '';
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(`<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0">${base}
<device><deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>
<serviceList><service><serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType>
<controlURL>/ctl/WRONG</controlURL></service></serviceList>
<deviceList><device><deviceType>urn:schemas-upnp-org:device:WANConnectionDevice:1</deviceType>
<serviceList><service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
<controlURL>/ctl/IPConn</controlURL></service></serviceList>
</device></deviceList></device></root>`);
      }
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        const action = /<u:(\w+)\s/.exec(body);
        const name = action ? action[1] : '';
        seenSoap.push({ url: req.url, headers: req.headers, body, action: name });

        const fault = (code, desc) => {
          res.writeHead(500, { 'Content-Type': 'text/xml' });
          res.end(`<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault>
<faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail>
<UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode>
<errorDescription>${desc}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`);
        };
        const okRes = (inner) => {
          res.writeHead(200, { 'Content-Type': 'text/xml' });
          res.end(`<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
<u:${name}Response xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">${inner || ''}</u:${name}Response></s:Body></s:Envelope>`);
        };

        if (req.url === '/ctl/WRONG') return fault(401, 'Invalid Action');
        if (name === 'GetExternalIPAddress') return okRes(`<NewExternalIPAddress>${opts.externalIp || '81.2.69.142'}</NewExternalIPAddress>`);
        if (name === 'GetSpecificPortMappingEntry') {
          if (opts.occupiedBy) return okRes(`<NewInternalPort>1234</NewInternalPort><NewInternalClient>${opts.occupiedBy}</NewInternalClient><NewEnabled>1</NewEnabled><NewPortMappingDescription>other</NewPortMappingDescription><NewLeaseDuration>0</NewLeaseDuration>`);
          return fault(714, 'NoSuchEntryInArray');
        }
        if (name === 'AddPortMapping') {
          const lease = parseInt(I.tag(body, 'NewLeaseDuration'), 10);
          if (opts.onlyPermanent && lease !== 0) return fault(725, 'OnlyPermanentLeasesSupported');
          if (opts.bare501OnFiniteLease && lease !== 0) return fault(501, 'Action Failed');
          return okRes('');
        }
        if (name === 'DeletePortMapping') return okRes('');
        return fault(401, 'Invalid Action');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

(async () => {
  // ============================ NAT-PMP =====================================
  {
    const { sock, port } = await startNatPmp('81.2.69.142');
    // The client always talks to :5351, so temporarily point it at our port by
    // calling the wire functions with a host:port-aware shim is not possible -
    // instead we verify by binding the fake on 5351 if we can, else skip.
    sock.close();
  }

  // Bind the fake NAT-PMP responder on the real port so the client can reach it.
  const pmp = await new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    sock.on('error', () => resolve(null));
    sock.bind(5351, '127.0.0.1', () => resolve(sock));
  });

  if (pmp) {
    pmp.on('message', (buf, rinfo) => {
      seen.natpmp.push(Buffer.from(buf));
      const op = buf[1];
      if (buf[0] !== 0) return;
      if (op === 0) {
        const res = Buffer.alloc(12);
        res.writeUInt8(0, 0); res.writeUInt8(128, 1);
        res.writeUInt16BE(0, 2); res.writeUInt32BE(4242, 4);
        [81, 2, 69, 142].forEach((o, i) => res.writeUInt8(o, 8 + i));
        pmp.send(res, rinfo.port, rinfo.address);
      } else if (op === 2) {
        const internal = buf.readUInt16BE(4), lifetime = buf.readUInt32BE(8);
        const res = Buffer.alloc(16);
        res.writeUInt8(0, 0); res.writeUInt8(130, 1);
        res.writeUInt16BE(0, 2); res.writeUInt32BE(4242, 4);
        res.writeUInt16BE(internal, 8);
        res.writeUInt16BE(lifetime === 0 ? 0 : 51234, 10);
        res.writeUInt32BE(lifetime === 0 ? 0 : 3600, 12);
        pmp.send(res, rinfo.port, rinfo.address);
      }
    });

    const ext = await I.natpmpExternalIp('127.0.0.1', [250, 500]);
    ok('NAT-PMP external IP parsed (natural byte order)', ext && ext.ip === '81.2.69.142', JSON.stringify(ext));
    ok('NAT-PMP SSSoE read', ext && ext.sssoe === 4242);

    const req0 = seen.natpmp[0];
    ok('NAT-PMP op0 request is exactly 2 bytes', req0 && req0.length === 2, req0 && req0.length);
    ok('NAT-PMP op0 request is 00 00', req0 && req0[0] === 0 && req0[1] === 0);

    const map = await I.natpmpMap('127.0.0.1', 47811, 47811, 7200, [250, 500]);
    ok('NAT-PMP mapping succeeded', map && !map.error, JSON.stringify(map));
    ok('client uses the ROUTER-GRANTED external port, not its suggestion', map && map.externalPort === 51234, map && map.externalPort);
    ok('client uses the ROUTER-GRANTED lifetime', map && map.lifetime === 3600, map && map.lifetime);

    const req2 = seen.natpmp[1];
    ok('NAT-PMP op2 request is 12 bytes', req2 && req2.length === 12, req2 && req2.length);
    ok('NAT-PMP op2 opcode is 2 (TCP)', req2 && req2[1] === 2);
    ok('NAT-PMP op2 reserved is zero', req2 && req2.readUInt16BE(2) === 0);
    ok('NAT-PMP op2 internal port', req2 && req2.readUInt16BE(4) === 47811);
    ok('NAT-PMP op2 lifetime big-endian 7200', req2 && req2.readUInt32BE(8) === 7200);

    // delete = suggested external port AND lifetime both zero
    seen.natpmp.length = 0;
    await I.natpmpMap('127.0.0.1', 47811, 0, 0, [250]);
    const del = seen.natpmp[0];
    ok('delete sets suggested external port to 0', del && del.readUInt16BE(6) === 0);
    ok('delete sets lifetime to 0', del && del.readUInt32BE(8) === 0);

    pmp.close();
  } else {
    console.log('  (skipped NAT-PMP wire tests - could not bind udp/5351 in this sandbox)');
  }

  // ============================== UPnP ======================================
  const igd = await startIgd({});
  const loc = `http://127.0.0.1:${igd.port}/rootDesc.xml`;
  const xml = await new Promise((r) => http.get(loc, (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => r(b)); }));
  const svcs = I.servicesFrom(xml, loc);
  ok('fake IGD yields one service', svcs.length === 1, JSON.stringify(svcs.map(s => s.controlUrl)));
  ok('picked /ctl/IPConn not /ctl/WRONG', svcs[0] && svcs[0].controlUrl.endsWith('/ctl/IPConn'), svcs[0] && svcs[0].controlUrl);

  const ip = await I.upnpExternalIp(svcs[0]);
  ok('UPnP GetExternalIPAddress round-trip', ip === '81.2.69.142', ip);

  const soapReq = seenSoap.find((s) => s.action === 'GetExternalIPAddress');
  ok('SOAPAction header is quoted', soapReq && soapReq.headers.soapaction === '"urn:schemas-upnp-org:service:WANIPConnection:1#GetExternalIPAddress"', soapReq && soapReq.headers.soapaction);
  ok('Content-Type is text/xml with quoted charset', soapReq && soapReq.headers['content-type'] === 'text/xml; charset="utf-8"', soapReq && soapReq.headers['content-type']);
  ok('explicit Content-Length, not chunked', soapReq && !!soapReq.headers['content-length'] && !soapReq.headers['transfer-encoding'], JSON.stringify(soapReq && soapReq.headers['transfer-encoding']));
  ok('Connection: close', soapReq && soapReq.headers.connection === 'close', soapReq && soapReq.headers.connection);
  ok('Content-Length matches actual byte length', soapReq && Number(soapReq.headers['content-length']) === Buffer.byteLength(soapReq.body, 'utf8'));

  const add = await I.upnpAddMapping(svcs[0], 47811, 47811, '192.168.1.23', 'Beebo Media', '');
  ok('UPnP AddPortMapping succeeded', add.ok === true, JSON.stringify(add));
  ok('finite lease accepted -> leaseMode finite', add.leaseMode === 'finite', add.leaseMode);

  const got = await I.upnpGetMapping(svcs[0], 47811);
  ok('GetSpecificPortMappingEntry 714 -> missing:true', got.missing === true, JSON.stringify(got));
  ok('DeletePortMapping succeeds', (await I.upnpDelete(svcs[0], 47811)) === true);
  igd.server.close();

  // --- 725 OnlyPermanentLeasesSupported: must retry with lease 0 ------------
  seenSoap.length = 0;
  const igd2 = await startIgd({ onlyPermanent: true });
  const loc2 = `http://127.0.0.1:${igd2.port}/rootDesc.xml`;
  const xml2 = await new Promise((r) => http.get(loc2, (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => r(b)); }));
  const s2 = I.servicesFrom(xml2, loc2);
  const add2 = await I.upnpAddMapping(s2[0], 47811, 47811, '192.168.1.23', 'Beebo Media', '');
  ok('725 -> falls back to permanent lease and succeeds', add2.ok === true && add2.leaseMode === 'permanent', JSON.stringify(add2));
  const adds = seenSoap.filter((s) => s.action === 'AddPortMapping');
  ok('exactly two AddPortMapping attempts', adds.length === 2, adds.length);
  ok('first attempt used lease 3600', adds[0] && I.tag(adds[0].body, 'NewLeaseDuration') === '3600');
  ok('second attempt used lease 0 and changed NOTHING else',
     adds[1] && I.tag(adds[1].body, 'NewLeaseDuration') === '0' &&
     I.tag(adds[1].body, 'NewExternalPort') === I.tag(adds[0].body, 'NewExternalPort') &&
     I.tag(adds[1].body, 'NewInternalClient') === I.tag(adds[0].body, 'NewInternalClient'));
  igd2.server.close();

  // --- bare 501 on a finite lease: same fallback must apply -----------------
  seenSoap.length = 0;
  const igd3 = await startIgd({ bare501OnFiniteLease: true });
  const loc3 = `http://127.0.0.1:${igd3.port}/rootDesc.xml`;
  const xml3 = await new Promise((r) => http.get(loc3, (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => r(b)); }));
  const s3 = I.servicesFrom(xml3, loc3);
  const add3 = await I.upnpAddMapping(s3[0], 47811, 47811, '192.168.1.23', 'Beebo Media', '');
  ok('bare 501 on finite lease -> permanent fallback works', add3.ok === true && add3.leaseMode === 'permanent', JSON.stringify(add3));
  igd3.server.close();

  // --- leaseMode remembered: must SKIP the doomed first rung ---------------
  seenSoap.length = 0;
  const igd4 = await startIgd({ onlyPermanent: true });
  const loc4 = `http://127.0.0.1:${igd4.port}/rootDesc.xml`;
  const xml4 = await new Promise((r) => http.get(loc4, (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => r(b)); }));
  const s4 = I.servicesFrom(xml4, loc4);
  await I.upnpAddMapping(s4[0], 47811, 47811, '192.168.1.23', 'Beebo Media', 'permanent');
  const adds4 = seenSoap.filter((s) => s.action === 'AddPortMapping');
  ok('remembered permanent mode -> only ONE attempt', adds4.length === 1, adds4.length);
  ok('that attempt used lease 0', adds4[0] && I.tag(adds4[0].body, 'NewLeaseDuration') === '0');
  igd4.server.close();

  // --- CGNAT external address must be detected, not celebrated -------------
  const igd5 = await startIgd({ externalIp: '100.71.4.9' });
  const loc5 = `http://127.0.0.1:${igd5.port}/rootDesc.xml`;
  const xml5 = await new Promise((r) => http.get(loc5, (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => r(b)); }));
  const s5 = I.servicesFrom(xml5, loc5);
  const cgIp = await I.upnpExternalIp(s5[0]);
  ok('CGNAT address reported by router is classified as cgnat', I.classifyExternal(cgIp).kind === 'cgnat', cgIp);
  igd5.server.close();

  console.log(`\nfake-router integration: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
