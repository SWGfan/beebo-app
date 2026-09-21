'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { createLicense } = require('../electron/license')
const { signToken } = require('../electron/licenseToken')
const { createLocalAccessPolicy } = require('../electron/localAccessPolicy')

const keys = crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
})
const NOW = 1800000000
function licence(payload) {
  const data = { 'license.deviceId': 'local-test-device' }
  if (payload) data['license.token'] = signToken(payload, keys.privateKey)
  const store = { get: key => data[key], set: (key, value) => { data[key] = value }, delete: key => { delete data[key] } }
  return createLicense({ store, now: () => NOW, config: { enabled: true, publicKey: keys.publicKey, backendUrl: 'https://example.test' } })
}
const subscription = { type: 'subscription', plan: 'beebo-standard', email: 'owner@example.test', deviceId: 'local-test-device', issuedAt: NOW - 100, expiresAt: NOW + 86400 }

test('home remains available when no paid entitlement exists; remote serve never becomes free', () => {
  for (const payload of [null, { ...subscription, expiresAt: NOW - 1 }, { ...subscription, deviceId: 'another-device' }, { type: 'trial', expiresAt: NOW + 86400 }]) {
    const service = licence(payload)
    const status = service.accessStatus()
    assert.equal(status.homeAllowed, true)
    assert.equal(status.awayAllowed, false)
    assert.equal(status.serve, false)
    assert.equal(service.evaluate().serve, false, 'existing remote-host and relay entitlement remains unchanged')
  }
  const service = licence(subscription)
  assert.equal(service.accessStatus().homeAllowed, true)
  assert.equal(service.accessStatus().awayAllowed, true)
  service.clearToken()
  assert.equal(service.accessStatus().homeAllowed, true)
  assert.equal(service.accessStatus().awayAllowed, false)
})

const network = {
  WiFi: [
    { address: '192.168.100.181', cidr: '192.168.100.181/24', internal: false },
    { address: '2001:db8:1234:1::a', cidr: '2001:db8:1234:1::a/64', internal: false },
    { address: 'fe80::abcd%18', netmask: 'ffff:ffff:ffff:ffff::', internal: false }
  ],
  Ethernet: [{ address: '10.20.30.5', netmask: '255.255.255.0', internal: false }],
  Tailscale: [{ address: '100.95.132.15', cidr: '100.95.132.15/10', internal: false }],
  'WireGuard VPN': [{ address: '10.44.0.1', cidr: '10.44.0.1/24', internal: false }]
}
const request = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers })

test('only real local subnets and loopback count as home, including mapped IPv4 and IPv6', () => {
  const policy = createLocalAccessPolicy({ interfaces: network })
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '192.168.100.25', '::ffff:c0a8:6419', '10.20.30.20', '2001:db8:1234:1::42', 'fe80::55%18']) {
    assert.equal(policy.isHomeRequest(request(ip)), true, ip)
  }
  for (const ip of ['192.168.101.25', '10.20.31.20', '172.16.0.8', '100.95.132.16', '10.44.0.3', '203.0.113.8', '2001:db8:1234:2::42', '', 'not-an-ip']) {
    assert.equal(policy.isHomeRequest(request(ip)), false, ip)
  }
})

test('remote identity and forwarded headers can never make an internet request free', () => {
  const policy = createLocalAccessPolicy({ interfaces: network, agentSecret: 'test-only-agent-secret' })
  const remote = request('127.0.0.1', { 'x-beebo-agent-key': 'test-only-agent-secret', 'x-beebo-viewer-ip': '192.168.100.25' })
  assert.deepEqual(policy.classify(remote), { home: false, reason: 'beebo_remote' })
  for (const headers of [
    { 'x-forwarded-for': '127.0.0.1' },
    { forwarded: 'for=192.168.100.25' },
    { 'x-beebo-viewer-ip': '192.168.100.25', 'x-beebo-agent-key': 'wrong' },
    { host: 'localhost:47811' },
    { 'x-forwarded-proto': 'https', 'cf-connecting-ip': '192.168.100.25' }
  ]) assert.equal(policy.isHomeRequest(request('203.0.113.8', headers)), false)
  // A reverse proxy on this PC or LAN is still forwarding an outside viewer.
  for (const ip of ['127.0.0.1', '192.168.100.2']) {
    assert.equal(policy.isHomeRequest(request(ip, { 'x-forwarded-for': '198.51.100.4' })), false)
    assert.equal(policy.isHomeRequest(request(ip, { 'x-beebo-remote': '0' })), false)
    assert.equal(policy.isHomeRequest(request(ip, { 'x-beebo-agent-key': 'wrong' })), false)
  }
})

test('network changes refresh the home boundary and discovery errors fail closed', () => {
  let clock = 0
  let current = network
  let fail = false
  let reads = 0
  const policy = createLocalAccessPolicy({ now: () => clock, cacheMs: 1000, interfaces: () => {
    reads++
    if (fail) throw new Error('adapter lookup failed')
    return current
  } })
  assert.equal(policy.isHomeRequest(request('192.168.100.25')), true)
  assert.equal(policy.isHomeRequest(request('192.168.100.26')), true)
  assert.equal(reads, 1)
  current = { WiFi: [{ address: '192.168.9.7', cidr: '192.168.9.7/24', internal: false }] }
  clock = 1001
  assert.equal(policy.isHomeRequest(request('192.168.100.25')), false)
  assert.equal(policy.isHomeRequest(request('192.168.9.10')), true)
  fail = true
  clock = 2002
  assert.equal(policy.isHomeRequest(request('192.168.9.10')), false)
  assert.equal(policy.isHomeRequest(request('127.0.0.1')), true)
})

test('invalid interface masks and broad IPv6 delegation do not admit neighboring networks', () => {
  const policy = createLocalAccessPolicy({ interfaces: {
    Broken: [{ address: '10.4.0.5', netmask: '255.0.255.0' }, { address: '192.168.1.2', cidr: '192.168.1.2/0' }],
    Public: [{ address: '203.0.113.2', cidr: '203.0.113.2/24' }],
    V6: [{ address: '2001:db8:1234:56::1', cidr: '2001:db8:1234:56::1/48' }]
  } })
  assert.equal(policy.isHomeRequest(request('10.4.2.1')), false)
  assert.equal(policy.isHomeRequest(request('192.168.1.3')), false)
  assert.equal(policy.isHomeRequest(request('203.0.113.3')), false)
  assert.equal(policy.isHomeRequest(request('2001:db8:1234:56::2')), true)
  assert.equal(policy.isHomeRequest(request('2001:db8:1234:57::2')), false)
})
