// The default STUN server is Beebo's own coturn (stun:relay1.beebo.tv:3478), not
// Cloudflare's public stun.cloudflare.com: in the home host agent and in the
// in-page host of the stream server. (The customer's OWN Cloudflare relay option
// is separate and untouched.) Run: node --test test/default-stun.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const Module = require('node:module')

const appRoot = path.resolve(__dirname, '..')
const AGENT = path.join(appRoot, 'resources', 'beebo-rtc-host', 'beebo-rtc-host.js')
const STREAM = path.join(appRoot, 'electron', 'streamServer.js')
const STUN = 'stun:relay1.beebo.tv:3478'
const code = (file) => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n')

test('no Cloudflare STUN left in the host agent or the stream server', () => {
  for (const f of [AGENT, STREAM]) {
    const src = code(f)
    assert.ok(!/stun\.cloudflare\.com/.test(src), path.basename(f) + ' still names stun.cloudflare.com')
    assert.ok(src.includes(STUN), path.basename(f) + ' falls back to ' + STUN)
  }
})

const NM = [process.env.BEEBO_RTC_NODE_MODULES, path.join(appRoot, 'resources', 'beebo-rtc-host', 'node_modules'), path.join(appRoot, 'node_modules')]
  .filter(Boolean).find((d) => fs.existsSync(path.join(d, 'werift', 'package.json')))
const skip = NM ? false : 'werift not found (set BEEBO_RTC_NODE_MODULES)'

test('host agent: default ICE and the relay filter fall back to Beebo STUN', { skip }, () => {
  process.env.BEEBO_HOST_TOKEN = 'test.token'
  process.env.BEEBO_VERBOSE = '0'
  process.env.NODE_PATH = NM
  Module._initPaths()
  const a = require(AGENT)
  assert.equal(a.DEFAULT_STUN_URL, STUN)
  assert.deepEqual(a.noRelay([]), [{ urls: STUN }])
  assert.deepEqual(a.noRelay([{ urls: 'turns:x.example:443?transport=tcp' }]), [{ urls: STUN }], 'a relay-only list keeps Beebo STUN')
  assert.deepEqual(a.noRelay([{ urls: ['stun:stun.example.net:3478', 'turn:x:3478'] }]), [{ urls: 'stun:stun.example.net:3478' }], 'a STUN the Worker names is kept')
})
