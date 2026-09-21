'use strict'
/*
 * Who is really asking, for lockouts and rate limits.
 *
 * Every away-from-home request reaches the media server through the host agent
 * (resources/beebo-rtc-host), which connects from 127.0.0.1. Keyed on the socket
 * address, one person guessing passwords at name.beebo.tv locked out every
 * remote viewer at once, and the Admin tab showed them all as 127.0.0.1.
 *
 * The agent now adds two headers: X-Beebo-Viewer-Ip, the address the Worker saw
 * the viewer's offer come from, and X-Beebo-Agent-Key, a random secret the app
 * generates at start and hands only to the agent it spawns (in its environment).
 * The viewer-ip header is believed ONLY when the request comes from this
 * machine's loopback AND carries that exact secret. From anyone else, including
 * a LAN device or a browser sending the header itself, it is ignored and the
 * socket address is used, as before.
 *
 * IPv6 viewers are keyed on their /64: one home or phone gets a whole /64, so
 * the full address would let a guesser dodge a lockout by changing suffix.
 */

const crypto = require('crypto')
const net = require('net')

const VIEWER_IP_HEADER = 'x-beebo-viewer-ip'
const AGENT_KEY_HEADER = 'x-beebo-agent-key'

function socketIp(req) {
  const raw = (req && req.socket && req.socket.remoteAddress) || ''
  return raw.replace(/^::ffff:/, '') || null
}

function isLoopback(ip) {
  if (!ip) return false
  return ip === '::1' || /^127\./.test(ip)
}

function sameSecret(given, secret) {
  if (typeof given !== 'string' || typeof secret !== 'string' || !secret) return false
  const a = Buffer.from(given)
  const b = Buffer.from(secret)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// "2001:db8:1:2:aaaa::1" -> "2001:db8:1:2::/64"
function v6Prefix64(ip) {
  let head = ip.split('%')[0]
  if (head.includes('::')) {
    const [l, r] = head.split('::')
    const left = l ? l.split(':') : []
    const right = r ? r.split(':') : []
    head = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right].join(':')
  }
  const groups = head.split(':').slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16))
  return groups.join(':') + '::/64'
}

/** The viewer address the host agent vouches for, or null if it isn't vouched for. */
function agentViewerIp(req, secret) {
  if (!secret || !req || !req.headers) return null
  if (!isLoopback(socketIp(req))) return null
  if (!sameSecret(req.headers[AGENT_KEY_HEADER], secret)) return null
  const raw = String(req.headers[VIEWER_IP_HEADER] || '').trim().replace(/^::ffff:/i, '')
  const kind = net.isIP(raw)
  if (kind === 4) return raw
  if (kind === 6) return v6Prefix64(raw)
  return null
}

/**
 * Did this request really come through the host agent? Loopback plus the exact
 * secret. Such a request crossed the internet inside the WebRTC data channel,
 * which is DTLS-encrypted from the viewer to the agent; only its last hop (the
 * agent to this server, on this machine's own loopback) is plain HTTP.
 */
function fromHostAgent(req, secret) {
  if (!secret || !req || !req.headers) return false
  if (!isLoopback(socketIp(req))) return false
  return sameSecret(req.headers[AGENT_KEY_HEADER], secret)
}

const REMOTE_VIA_HEADER = 'x-beebo-remote-via'
const REMOTE_MEMBER_HEADER = 'x-beebo-remote-member'
// A guest from another household (a library share): the share id and the invited email.
const REMOTE_SHARE_HEADER = 'x-beebo-remote-share'
const REMOTE_GUEST_HEADER = 'x-beebo-remote-guest'

/**
 * Who signed in at name.beebo.tv, as the host agent vouches for it: it checked the
 * Worker's Ed25519 signature on the viewer token itself (and its expiry and name)
 * before saying so. { via: 'member', member } | { via: 'owner' } | { via: 'household' }
 * | { via: 'guest', share, guest }, or null. Believed only from the agent (loopback plus
 * the secret), like the address.
 */
function remoteViewer(req, secret) {
  if (!fromHostAgent(req, secret)) return null
  const via = String(req.headers[REMOTE_VIA_HEADER] || '')
  if (via === 'owner' || via === 'household') return { via }
  if (via === 'guest') {
    const share = String(req.headers[REMOTE_SHARE_HEADER] || '').trim()
    const guest = String(req.headers[REMOTE_GUEST_HEADER] || '').trim().toLowerCase()
    return /^sh_[a-f0-9]{16}$/.test(share) && /^[^\s@]{1,64}@[^\s@]{1,190}$/.test(guest) ? { via, share, guest } : null
  }
  if (via !== 'member') return null
  const member = String(req.headers[REMOTE_MEMBER_HEADER] || '').trim().toLowerCase()
  return /^[a-z0-9._-]{1,64}$/.test(member) ? { via, member } : null
}

/** The key for lockouts, failed-login logs and last-seen: vouched viewer, else the socket. */
function clientIp(req, secret) {
  return agentViewerIp(req, secret) || socketIp(req)
}

module.exports = { clientIp, agentViewerIp, fromHostAgent, remoteViewer, REMOTE_VIA_HEADER, REMOTE_MEMBER_HEADER, REMOTE_SHARE_HEADER, REMOTE_GUEST_HEADER, VIEWER_IP_HEADER, AGENT_KEY_HEADER, _v6Prefix64: v6Prefix64 }
