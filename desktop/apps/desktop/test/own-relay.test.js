// The owner's own relay: credential derivation in the host agent.
// Needs werift for require() of the agent (same as rtc-host.e2e): set
// BEEBO_RTC_NODE_MODULES. Run: node --test test/own-relay.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const Module = require('node:module')

const appRoot = path.resolve(__dirname, '..')
const NM = [process.env.BEEBO_RTC_NODE_MODULES, path.join(appRoot, 'resources', 'beebo-rtc-host', 'node_modules')]
  .filter(Boolean).find((d) => fs.existsSync(path.join(d, 'werift', 'package.json')))
const skip = NM ? false : 'werift not found (set BEEBO_RTC_NODE_MODULES)'

function loadAgent() {
  // A token in the environment, so loading the agent never goes looking for the
  // real app's saved one.
  process.env.BEEBO_HOST_TOKEN = 'test.token'
  process.env.BEEBO_VERBOSE = '0'
  process.env.NODE_PATH = NM
  Module._initPaths()
  return require(path.join(appRoot, 'resources', 'beebo-rtc-host', 'beebo-rtc-host.js'))
}

test('HMAC-SHA1 matches RFC 2202 test case 2', { skip }, () => {
  const a = loadAgent()
  const hex = Buffer.from(a.turnRestCredential('Jefe', 'what do ya want for nothing?'), 'base64').toString('hex')
  assert.equal(hex, 'effcdf6ae5eb2fa2d27416d5f184df9c259a7c79')
})

test('TURN REST credential: username is expiry:beebo, password base64(HMAC-SHA1(secret, username))', { skip }, () => {
  const a = loadAgent()
  // Computed independently: printf '1789000000:beebo' | openssl dgst -sha1 -hmac north-ridge-shared-secret -binary | base64
  assert.equal(a.turnRestCredential('north-ridge-shared-secret', '1789000000:beebo'), 'FdWnqD6O29PdFA6D+IBxDjwgheM=')
  const now = 1789000000 - a.RELAY_TTL_S
  const [s] = a.turnRestIceServers({ kind: 'turn', urls: ['turn:relay.example.com:3478'], secret: 'north-ridge-shared-secret' }, now)
  assert.equal(s.username, '1789000000:beebo')
  assert.equal(s.credential, 'FdWnqD6O29PdFA6D+IBxDjwgheM=')
  assert.deepEqual(s.urls, ['turn:relay.example.com:3478'])
  assert.ok(a.RELAY_TTL_S <= 12 * 3600, 'short-lived')
  assert.ok(!JSON.stringify(s).includes('north-ridge-shared-secret'), 'the secret is not in what viewers get')
})

test('Cloudflare Realtime TURN: the documented call, port 53 dropped, token never returned', { skip }, async () => {
  const a = loadAgent()
  const seen = []
  const fakeFetch = async (url, opts) => {
    seen.push({ url, opts })
    return {
      ok: true, status: 201,
      json: async () => ({ iceServers: [
        { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
        { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'derived-user', credential: 'derived-pass' },
      ] }),
    }
  }
  const out = await a.cloudflareIceServers({ kind: 'cloudflare', keyId: 'abcdef0123456789', apiToken: 'CF-SECRET-TOKEN' }, fakeFetch)
  assert.equal(seen[0].url, 'https://rtc.live.cloudflare.com/v1/turn/keys/abcdef0123456789/credentials/generate-ice-servers')
  assert.equal(seen[0].opts.method, 'POST')
  assert.equal(seen[0].opts.headers.authorization, 'Bearer CF-SECRET-TOKEN')
  assert.deepEqual(JSON.parse(seen[0].opts.body), { ttl: a.RELAY_TTL_S })
  assert.deepEqual(out, [{ urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'derived-user', credential: 'derived-pass' }])
  assert.ok(!JSON.stringify(out).includes('CF-SECRET-TOKEN'))
  // The house itself uses the plain UDP address.
  assert.deepEqual(a.hostRelayEntry(out), { urls: 'turn:turn.cloudflare.com:3478?transport=udp', username: 'derived-user', credential: 'derived-pass' })
  await assert.rejects(a.cloudflareIceServers({ kind: 'cloudflare', keyId: 'abcdef0123456789', apiToken: 'x' }, async () => ({ ok: false, status: 401 })), /cloudflare_http_401/)
})

test('relay settings are checked; anything else means no relay', { skip }, () => {
  const a = loadAgent()
  assert.equal(a.cleanRelayConfig(null), null)
  assert.equal(a.cleanRelayConfig({ kind: 'beebo' }), null)
  assert.equal(a.cleanRelayConfig({ kind: 'cloudflare', keyId: 'short', apiToken: 't' }), null)
  assert.equal(a.cleanRelayConfig({ kind: 'turn', urls: ['http://evil.example'], secret: 'long enough secret' }), null)
  assert.equal(a.cleanRelayConfig({ kind: 'turn', urls: ['turn:relay.example.com'], secret: 'short' }), null)
  assert.deepEqual(a.cleanRelayConfig({ kind: 'turn', urls: ['turn:relay.example.com:3478', 'javascript:x'], secret: 'long enough secret' }),
    { kind: 'turn', urls: ['turn:relay.example.com:3478'], secret: 'long enough secret' })
})
