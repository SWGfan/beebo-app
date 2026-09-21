// pairLink.js: the QR / invite link the desktop shows and the phone app reads.
//
//   beebo://pair?server=<host:port>&name=<house name>
//
//   server  this computer's address on the home network, e.g. 192.168.1.20:47811 (required)
//   name    the <name> of <name>.beebo.tv, lowercase letters, digits and hyphens (optional; only
//           present once this Beebo has a beebo.tv address)
//
// The phone only PRE-FILLS its sign-in screen from it. A link never signs anyone in, never carries
// a password or token, and unknown parameters are ignored so the format can grow. Documented for
// other clients in docs/pairing-link.md; the phone-side parser is core/PairLink.kt. The plain
// http://<host:port> address keeps working: the phone app also accepts it, and the screen still
// prints it for typing.

export const PAIR_PREFIX = 'beebo://pair'

const HOSTPORT = /^[A-Za-z0-9.\-_]{1,253}:\d{1,5}$|^\[[0-9A-Fa-f:.]{2,45}\]:\d{1,5}$/
const HOUSE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export function cleanHostPort(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  if (!HOSTPORT.test(s)) return ''
  const port = Number(s.slice(s.lastIndexOf(':') + 1))
  return port >= 1 && port <= 65535 ? s : ''
}

export function cleanHouseName(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase().replace(/\.beebo\.tv$/, '')
  return HOUSE_NAME.test(s) ? s : ''
}

// '' when there is no usable address, so callers can fall back to the plain address.
export function buildPairLink({ server, name } = {}) {
  const hp = cleanHostPort(server)
  if (!hp) return ''
  const enc = (v) => encodeURIComponent(v).replace(/%3A/gi, ':')
  const house = cleanHouseName(name)
  return PAIR_PREFIX + '?server=' + enc(hp) + (house ? '&name=' + enc(house) : '')
}

export const plainAddress = (server) => { const hp = cleanHostPort(server); return hp ? 'http://' + hp : '' }

// A plain http://host:port address becomes a pairing link; anything else (a beebo.tv address, a
// path) is returned as it was, so a caller can pass any link it has.
export function pairFromAddress(url, name) {
  const m = /^http:\/\/([^/?#]+)\/?$/i.exec(String(url || '').trim())
  return (m && buildPairLink({ server: m[1], name })) || url
}
