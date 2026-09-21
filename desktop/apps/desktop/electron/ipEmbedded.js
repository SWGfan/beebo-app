'use strict'
// An IPv6 address can carry an IPv4 address inside it, and the two spellings reach the same machine:
//
//   ::ffff:127.0.0.1   ::ffff:7f00:1   (IPv4-mapped; a URL parser always writes the hex form)
//   ::127.0.0.1                        (IPv4-compatible, deprecated but still routed by some stacks)
//   64:ff9b::a9fe:a9fe                 (NAT64: a gateway turns it into 169.254.169.254)
//   2002:7f00:1::                      (6to4)
//   ::ffff:0:a9fe:a9fe                 (SIIT)
//
// A guard that only knew the dotted "::ffff:1.2.3.4" spelling let "http://[::ffff:7f00:1]/" through as
// a public address (a redirect target or a DNS answer is all it takes). embeddedIPv4() finds the IPv4
// address inside any of these, so the caller can judge THAT address instead. Pure, no I/O.

const net = require('net')

/** Eight 16-bit groups of an IPv6 literal (zone id, "::" and a dotted tail understood), or null. */
function expandIpv6(ip) {
  let s = String(ip).toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (dotted) {
    if (!net.isIPv4(dotted[1])) return null
    const o = dotted[1].split('.').map(Number)
    s = s.slice(0, dotted.index) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16)
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null
  const groups = [...head, ...Array(fill).fill('0'), ...tail].map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN))
  return groups.length === 8 && groups.every((g) => Number.isInteger(g)) ? groups : null
}

/** "a.b.c.d" when `ip` is an IPv6 literal that wraps an IPv4 address, else null (also null for anything that is not IPv6). */
function embeddedIPv4(ip) {
  const g = expandIpv6(ip)
  if (!g) return null
  const dotted = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
  const zeros = (from, to) => g.slice(from, to).every((x) => x === 0)
  // ::ffff:a.b.c.d (mapped) and ::ffff:0:a.b.c.d (SIIT)
  if (zeros(0, 5) && g[5] === 0xffff) return dotted(g[6], g[7])
  if (zeros(0, 4) && g[4] === 0xffff && g[5] === 0) return dotted(g[6], g[7])
  // ::a.b.c.d (compatible), but not "::" and "::1"
  if (zeros(0, 6) && (g[6] !== 0 || g[7] > 1)) return dotted(g[6], g[7])
  // 64:ff9b::/96 (NAT64)
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return dotted(g[6], g[7])
  // 2002::/16 (6to4): the IPv4 address is groups 1 and 2
  if (g[0] === 0x2002) return dotted(g[1], g[2])
  return null
}

module.exports = { embeddedIPv4, expandIpv6 }
