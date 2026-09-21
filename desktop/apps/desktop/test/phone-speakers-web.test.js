// Phone speakers: the pages' source (electron/phoneSpeakersWeb.js, phoneSpeakersClient.js) is checked as text - the TV panel and the
// phone page never build markup from strings (names and titles come from other people) - and the small helpers around them:
// which address phones are sent to, which feeds a film needs.
// Run: NODE_PATH=<desktop node_modules> node --test test/phone-speakers-web.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const web = require('../electron/phoneSpeakersWeb')
const server = require('../electron/phoneSpeakersServer')
const ch = require('../electron/phoneSpeakersChannels')

const BANNED = ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'setTimeout("', "setTimeout('", 'srcdoc', 'javascript:']

test('the phone page script and the TV panel never turn a string into markup or code', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'electron', 'phoneSpeakersClient.js'), 'utf8')
  const panel = web.phoneSpeakersPanel.toString()
  for (const banned of BANNED) {
    assert.ok(!client.includes(banned), `client: ${banned}`)
    assert.ok(!panel.includes(banned), `panel: ${banned}`)
  }
  // no third-party code, no addresses off this computer
  for (const text of [client, panel]) { assert.ok(!/https?:\/\/(?!localhost|127\.0\.0\.1)/.test(text.replace(/\/\/ .*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')), 'no external address') }
  // the QR code is parsed as XML and imported as a node, never assigned as a string
  assert.match(panel, /DOMParser\(\)\.parseFromString\(text, 'image\/svg\+xml'\)/)
})

test('the panel block for the player page: styles, the shared script, and a config that cannot break out of the script', () => {
  const html = web.phoneSpeakersHtml({ kind: 'movie', mediaId: 'abc_-123', title: '</script><img src=x onerror=alert(1)> & \u2028 "quotes"' })
  assert.match(html, /<script src="\/speakers\/client\.js"><\/script>/)
  const inline = html.slice(html.indexOf('<script>\n'), html.lastIndexOf('</script>'))
  assert.ok(!inline.includes('</script>'), 'the title cannot close the script element')
  assert.ok(!inline.includes('<img'), 'the title is escaped inside the config')
  const BS = String.fromCharCode(92)
  assert.ok(inline.includes(BS + 'u003c/script' + BS + 'u003e'), 'the angle brackets are written as escapes')
  assert.match(html, /"owner":"\/phone-speakers-api"/); assert.match(html, /"kind":"movie"/); assert.match(html, /"id":"abc_-123"/)
  assert.equal(web.phoneSpeakersHtml({ kind: 'tv', mediaId: 'x' }).includes('"kind":"tv"'), true)
  // the panel is real code: it parses
  assert.doesNotThrow(() => new Function('return ' + web.phoneSpeakersPanel.toString()))
  assert.ok(web.PANEL_CSS.includes('#spkPanel') && web.PANEL_CSS.includes('#spkOverlay'))
})

test('addresses for phones: real Wi-Fi / Ethernet first, virtual adapters last, never a loopback', () => {
  const nics = {
    'vEthernet (WSL)': [{ family: 'IPv4', address: '172.28.96.1' }],
    'VirtualBox Host-Only Network': [{ family: 'IPv4', address: '192.168.56.1' }],
    'Wi-Fi': [{ family: 'IPv4', address: '192.168.1.23' }, { family: 'IPv6', address: 'fe80::1' }],
    Ethernet: [{ family: 'IPv4', address: '10.0.0.5' }],
    'Loopback Pseudo-Interface 1': [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    Tailscale: [{ family: 'IPv4', address: '100.101.102.103' }],
    'Link-local': [{ family: 'IPv4', address: '169.254.3.4' }]
  }
  assert.deepEqual(server.lanOrigins(47811, nics), ['http://192.168.1.23:47811', 'http://10.0.0.5:47811', 'http://172.28.96.1:47811', 'http://192.168.56.1:47811'])
  assert.deepEqual(server.lanOrigins(1, {}), ['http://127.0.0.1:1'])
  assert.deepEqual(server.lanOrigins(2, { en0: [{ family: 4, address: '192.168.0.9' }] }), ['http://192.168.0.9:2'])
  const real = server.lanOrigins(47811)
  assert.ok(real.length >= 1 && real.every((o) => /^http:\/\/[0-9.]+:47811$/.test(o)))
})

test('which feeds a film needs cut up front: surround films everything, stereo and mono only the mixes', () => {
  const s51 = ch.describeSource({ channels: 6, channelLayout: '5.1(side)', streamIndex: 0 })
  assert.deepEqual(server.feedsFor(s51), ['FL', 'FR', 'FC', 'SL', 'SR', 'LFE', 'DL', 'DR', 'DM'])
  assert.deepEqual(server.feedsFor(ch.describeSource({ channels: 8, channelLayout: '7.1', streamIndex: 0 })), ['FL', 'FR', 'FC', 'SL', 'SR', 'LFE', 'BL', 'BR', 'DL', 'DR', 'DM'])
  assert.deepEqual(server.feedsFor(ch.describeSource({ channels: 2, channelLayout: 'stereo', streamIndex: 0 })), ['DL', 'DR', 'DM'])
  assert.deepEqual(server.feedsFor(null), ['DL', 'DR', 'DM'])
  assert.equal(server.QUALITY_RATE.standard, 32000); assert.equal(server.QUALITY_RATE.high, 48000)
})
