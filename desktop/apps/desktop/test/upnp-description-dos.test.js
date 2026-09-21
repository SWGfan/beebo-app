// Security review #19: a LAN device answering SSDP could freeze the main thread
// with a description full of unclosed <service> tags (catastrophic regex), serve
// half a megabyte, and point LOCATION at any host. Nothing here touches a real
// router: the "device" is a local HTTP server on 127.0.0.1.
// Run: node --test test/upnp-description-dos.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')
const { _internal: I } = require(path.join(__dirname, '..', 'electron', 'portMapper.js'))

// The review's body: 20k unclosed <service> tags, ~180 KB.
function maliciousBody() {
  return '<?xml version="1.0"?><root><device><serviceList>' + '<service>'.repeat(20000) + '</serviceList></device></root>'
}

const GOOD = `<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0">
<URLBase>http://192.168.1.1:5000/</URLBase>
<device><serviceList>
 <service><serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType><controlURL>/ctl/L3F</controlURL></service>
 <SERVICE><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
  <u:controlURL>/ctl/IPConn?a=1&amp;b=2</u:controlURL></SERVICE>
</serviceList></device></root>`

test('the 180 KB unclosed-<service> body is scanned in under 50 ms', () => {
  const body = maliciousBody()
  assert.ok(body.length >= 180000)
  const started = process.hrtime.bigint()
  const services = I.servicesFrom(body, 'http://192.168.1.1:5000/desc.xml')
  const tagged = I.tag(body, 'controlURL') + I.tag('<a>' + '<controlURL>'.repeat(20000), 'controlURL')
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  assert.deepEqual(services, [])
  assert.equal(tagged, '')
  assert.ok(ms < 50, `took ${ms} ms`)
})

test('the linear scanner still reads real descriptions and SOAP replies', () => {
  const services = I.servicesFrom(GOOD, 'http://192.168.1.1:5000/desc.xml')
  assert.equal(services.length, 1)
  assert.equal(services[0].serviceType, 'urn:schemas-upnp-org:service:WANIPConnection:1')
  assert.equal(services[0].controlUrl, 'http://192.168.1.1:5000/ctl/IPConn?a=1&b=2')
  assert.equal(I.tag('<errorCode xmlns="x">718</errorCode>', 'errorcode'), '718')
  assert.equal(I.tag('<NewExternalPortRange>9</NewExternalPortRange><NewExternalPort>5</NewExternalPort>', 'NewExternalPort'), '5')
  assert.equal(I.tag('<s:Body><u:R><NewExternalIPAddress>81.2.69.142</NewExternalIPAddress></u:R>', 'NewExternalIPAddress'), '81.2.69.142')
})

test('only a description on the default gateway is accepted', () => {
  const a = I.acceptLocation
  assert.equal(a('http://192.168.1.1:5000/desc.xml', { gateway: '192.168.1.1', localIp: '192.168.1.20' }), true)
  assert.equal(a('http://192.168.1.77:80/evil.xml', { gateway: '192.168.1.1', localIp: '192.168.1.20', responderIp: '192.168.1.77' }), false)
  assert.equal(a('http://8.8.8.8/desc.xml', { gateway: '192.168.1.1' }), false)
  assert.equal(a('https://192.168.1.1/desc.xml', { gateway: '192.168.1.1' }), false, 'http only')
  assert.equal(a('http://router.local/desc.xml', { gateway: '192.168.1.1' }), false)
  // Gateway unknown: the responder itself, on our subnet's .1.
  assert.equal(a('http://10.0.0.1:1900/d.xml', { gateway: '', localIp: '10.0.0.9', responderIp: '10.0.0.1' }), true)
  assert.equal(a('http://10.0.0.1:1900/d.xml', { gateway: '', localIp: '10.0.0.9', responderIp: '10.0.0.44' }), false, 'spoofed LOCATION')
  assert.equal(a('http://10.0.0.44/d.xml', { gateway: '', localIp: '10.0.0.9', responderIp: '10.0.0.44' }), false)
  assert.equal(a('http://10.0.1.1/d.xml', { gateway: '', localIp: '10.0.0.9', responderIp: '10.0.1.1' }), false)
  // A controlURL on another host is dropped.
  assert.deepEqual(I.sameHostServices(I.servicesFrom(GOOD.replace('http://192.168.1.1:5000/', 'http://203.0.113.5/'), 'http://192.168.1.1:5000/d.xml'), 'http://192.168.1.1:5000/d.xml').map((s) => s.controlUrl), ['http://192.168.1.1:5000/ctl/IPConn?a=1&b=2'])
})

test('description downloads stop at 64 KB', async (t) => {
  let aborted = false
  const server = http.createServer((req, res) => {
    res.on('close', () => { aborted = true })
    res.on('error', () => {})
    // 100 KB streamed (no Content-Length), then the connection is held open:
    // only a streaming cap returns before httpGet's 3 s timeout.
    res.writeHead(200, { 'Content-Type': 'text/xml' })
    res.write('<root>' + 'x'.repeat(100 * 1024))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => { if (server.closeAllConnections) server.closeAllConnections(); server.close() })
  const url = `http://127.0.0.1:${server.address().port}/desc.xml`
  const started = Date.now()
  assert.equal(await I.httpGet(url), '', 'oversized description rejected')
  const ms = Date.now() - started
  assert.ok(ms < 1500, `aborted as soon as it passed 64 KB, took ${ms} ms`)
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(aborted, true, 'connection closed')
  const small = http.createServer((req, res) => res.end(GOOD))
  await new Promise((r) => small.listen(0, '127.0.0.1', r))
  t.after(() => small.close())
  assert.equal(await I.httpGet(`http://127.0.0.1:${small.address().port}/`), GOOD)
})
