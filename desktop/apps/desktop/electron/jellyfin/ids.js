'use strict'

const crypto = require('crypto')
const { TYPE_TAG, NUMERIC_KINDS, ID_KEY_SETTING } = require('./constants')

const KIND_BY_TAG = new Map(Object.entries(TYPE_TAG).map(([kind, tag]) => [tag, kind]))
const HEX32 = /^[0-9a-f]{32}$/

function keyFor(store) {
  let key = store.get(ID_KEY_SETTING)
  if (typeof key !== 'string' || key.length < 32) {
    key = crypto.randomBytes(32).toString('hex')
    store.set(ID_KEY_SETTING, key)
  }
  return key
}

function createIds(store) {
  let memo = null
  const key = () => memo || (memo = keyFor(store))

  function encode(kind, canonical) {
    const tag = TYPE_TAG[kind]
    if (tag === undefined) throw new Error('unknown_kind')
    const out = Buffer.alloc(16)
    out[0] = tag
    if (NUMERIC_KINDS.has(kind)) {
      const n = BigInt(canonical)
      if (n < 0n || n > 0xffffffffffffffffn) throw new Error('number_out_of_range')
      out.writeBigUInt64BE(n, 8)
      return out.toString('hex')
    }
    const mac = crypto.createHmac('sha256', key()).update(Buffer.from([tag, 0])).update(String(canonical), 'utf8').digest()
    mac.copy(out, 1, 0, 15)
    return out.toString('hex')
  }

  const serverId = () => crypto.createHmac('sha256', key()).update('server-id').digest().subarray(0, 16).toString('hex')

  return { encode, serverId }
}

function normalize(id) {
  const s = String(id || '').trim().toLowerCase().replace(/-/g, '')
  return HEX32.test(s) ? s : null
}

function kindOf(id) {
  const s = normalize(id)
  return s ? KIND_BY_TAG.get(parseInt(s.slice(0, 2), 16)) || null : null
}

function decodeNumeric(id) {
  const s = normalize(id)
  if (!s) return null
  const kind = KIND_BY_TAG.get(parseInt(s.slice(0, 2), 16))
  if (!kind || !NUMERIC_KINDS.has(kind)) return null
  if (!/^0{14}$/.test(s.slice(2, 16))) return null
  const n = BigInt('0x' + s.slice(16))
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) return null
  return { kind, number: Number(n) }
}

module.exports = { createIds, normalize, kindOf, decodeNumeric, HEX32 }
