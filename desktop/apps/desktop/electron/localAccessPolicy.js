'use strict'

const net = require('node:net')
const os = require('node:os')
const { fromHostAgent } = require('./viewerIdentity')

// Proxy headers are never evidence of home access. Their presence can only
// tighten the decision, including a local reverse proxy forwarding the internet.
const PROXY_HEADERS = new Set([
  'forwarded', 'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip',
  'cf-connecting-ip', 'true-client-ip', 'x-beebo-remote', 'x-beebo-viewer-ip',
  'x-beebo-agent-key', 'x-beebo-remote-via'
])
const VPN_INTERFACE = /tailscale|zerotier|wireguard|\bvpn\b|^tun\d|^tap\d/i

function address(raw) {
  if (typeof raw !== 'string') return null
  const ip = raw.trim().split('%')[0]
  const family = net.isIP(ip)
  if (family === 4) {
    return { family: 4, bits: ip.split('.').reduce((value, part) => (value << 8n) | BigInt(part), 0n) }
  }
  if (family !== 6) return null
  let expanded = ip
  if (expanded.includes('.')) {
    const cut = expanded.lastIndexOf(':')
    const tail = address(expanded.slice(cut + 1))
    if (!tail || tail.family !== 4) return null
    expanded = expanded.slice(0, cut + 1) + (tail.bits >> 16n).toString(16) + ':' + (tail.bits & 65535n).toString(16)
  }
  const halves = expanded.split('::')
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves[1] ? halves[1].split(':') : []
  const groups = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left
  const bits = groups.reduce((value, part) => (value << 16n) | BigInt('0x' + part), 0n)
  // Normalize both dotted and hexadecimal IPv4-mapped socket addresses.
  if ((bits >> 32n) === 65535n) return { family: 4, bits: bits & 0xffffffffn }
  return { family: 6, bits }
}
function loopback(value) {
  return value.family === 4 ? (value.bits >> 24n) === 127n : value.bits === 1n
}
function privateV4(value) {
  return (value >> 24n) === 10n || (value >> 20n) === 2753n || (value >> 16n) === 49320n || (value >> 16n) === 43518n
}
function prefixOf(entry, family) {
  const width = family === 4 ? 32 : 128
  if (typeof entry.cidr === 'string') {
    const raw = entry.cidr.slice(entry.cidr.lastIndexOf('/') + 1)
    if (/^\d+$/.test(raw)) {
      const n = Number(raw)
      if (n > 0 && n <= width) return n
    }
  }
  const mask = address(entry.netmask)
  if (!mask || mask.family !== family) return null
  const binary = mask.bits.toString(2).padStart(width, '0')
  if (!/^1+0*$/.test(binary)) return null
  return binary.indexOf('0') < 0 ? width : binary.indexOf('0')
}
function localSubnets(interfaces) {
  const subnets = []
  for (const [name, entries] of Object.entries(interfaces || {})) {
    if (VPN_INTERFACE.test(name) || !Array.isArray(entries)) continue
    for (const entry of entries) {
      if (!entry || entry.internal) continue
      const ip = address(entry.address)
      if (!ip || loopback(ip)) continue
      // A public IPv4 neighbor is not a home device. Carrier-grade NAT and
      // tunnel address ranges likewise never become a free home subnet.
      if (ip.family === 4 && !privateV4(ip.bits)) continue
      const prefix = prefixOf(entry, ip.family)
      if (prefix === null) continue
      // A delegated IPv6 block can contain other routed networks; only the
      // actual interface's /64 (or narrower configured subnet) is local.
      const safePrefix = ip.family === 6 ? Math.max(64, prefix) : prefix
      const shift = BigInt((ip.family === 4 ? 32 : 128) - safePrefix)
      subnets.push({ family: ip.family, network: ip.bits >> shift, shift })
    }
  }
  return subnets
}
function createLocalAccessPolicy({ agentSecret = '', interfaces = () => os.networkInterfaces(), now = () => Date.now(), cacheMs = 15000 } = {}) {
  let cached = []
  let refreshedAt = -Infinity
  function refresh() {
    const time = now()
    if (time < refreshedAt || time - refreshedAt >= cacheMs) {
      // Failed discovery must never retain a stale network as trusted.
      try { cached = localSubnets(typeof interfaces === 'function' ? interfaces() : interfaces) }
      catch { cached = [] }
      refreshedAt = time
    }
    return cached
  }
  function classify(req) {
    if (fromHostAgent(req, agentSecret)) return { home: false, reason: 'beebo_remote' }
    const headers = (req && req.headers) || {}
    if (Object.keys(headers).some(key => PROXY_HEADERS.has(key.toLowerCase()))) return { home: false, reason: 'forwarded_connection' }
    const peer = address(req && req.socket && req.socket.remoteAddress)
    if (!peer) return { home: false, reason: 'unknown_address' }
    if (loopback(peer)) return { home: true, reason: 'this_computer' }
    if (refresh().some(subnet => subnet.family === peer.family && (peer.bits >> subnet.shift) === subnet.network)) {
      return { home: true, reason: 'home_network' }
    }
    return { home: false, reason: 'outside_home_network' }
  }
  // Exposed so callers (streamServer.js's away-connection-type gate) can tell a request
  // that really came through the trusted remote-host agent (loopback + the per-run
  // agent secret, see viewerIdentity.js) from one that merely claims to have, before
  // trusting any of the other x-beebo-remote-* headers the agent stamps on forwarded
  // requests (viewer ip, member, and - for the free-away-connection entitlement -
  // which relay path this connection actually negotiated).
  return { classify, isHomeRequest: req => classify(req).home, fromHostAgent: req => fromHostAgent(req, agentSecret) }
}

module.exports = { createLocalAccessPolicy }
