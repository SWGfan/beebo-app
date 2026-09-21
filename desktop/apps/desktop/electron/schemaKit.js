'use strict'
// Small closed-schema toolkit shared by the preferences profile, layout packs and theme packs.
//
// Rules every schema built on this keeps (they mirror what theme.js already does for the Custom slot):
//   * closed: an unknown key is an error, never silently repaired or kept;
//   * `__proto__`, `constructor` and `prototype` are never accepted as keys, at any depth;
//   * bounded: depth, string length, list length and total serialized size all have hard caps;
//   * plain data only: functions, symbols, class instances, NaN and Infinity are refused.
//
// A schema is a tree. A node is either a plain object of child nodes (a "section") or a leaf made by one
// of the helpers below (enumOf, intOf, numOf, boolOf, strOf, idListOf, listOf, nullable, custom).
// validate() walks it and returns { ok, value, errors }; with { partial:true } missing keys are allowed
// (used for stored sparse layers and merge-patches) and with { dropInvalid:true } a bad leaf is dropped
// instead of failing (used when reading storage: a hand-edited store must never break a page).

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const MAX_DEPTH = 6

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const isPlainObject = (v) => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/** true when the value is JSON-like and no deeper than `max` levels (arrays and objects count). */
function withinDepth(value, max = MAX_DEPTH, level = 0) {
  if (value === null || typeof value !== 'object') return true
  if (level >= max) return false
  const kids = Array.isArray(value) ? value : Object.values(value)
  return kids.every((k) => withinDepth(k, max, level + 1))
}

/** true when no object anywhere in the value has a forbidden key. */
function hasForbiddenKey(value, level = 0) {
  if (value === null || typeof value !== 'object' || level > 12) return false
  if (Array.isArray(value)) return value.some((v) => hasForbiddenKey(v, level + 1))
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) return true
    if (hasForbiddenKey(value[key], level + 1)) return true
  }
  return false
}

function byteSize(value) {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8') } catch { return Infinity }
}

// ---- leaf builders -------------------------------------------------------------------------------------
const leaf = (kind, spec) => Object.freeze(Object.assign({ __leaf: kind }, spec))

const enumOf = (values, def) => leaf('enum', { values: Object.freeze([...values]), default: def })
const intOf = (min, max, def) => leaf('int', { min, max, default: def })
const numOf = (min, max, def, step = 0.05) => leaf('num', { min, max, default: def, step })
const boolOf = (def) => leaf('bool', { default: def })
const strOf = (max, re, def = '') => leaf('str', { max, re, default: def })
/** A list of ids from a closed registry (a Set/array): no duplicates, capped. */
const idListOf = (registry, max, def = []) => leaf('idList', { registry: new Set(registry), max, default: def })
/** A list of { id, on } rows (home shelves): ids from the registry, no duplicates. */
const rowListOf = (registry, max, def = []) => leaf('rowList', { registry: new Set(registry), max, default: def })
/** null, or whatever `inner` accepts. */
const nullable = (inner, def = null) => leaf('nullable', { inner, default: def })
/** A leaf checked by your own function: (value) => { ok, value } | { ok:false, error }. */
const custom = (check, def) => leaf('custom', { check, default: def })

const isLeaf = (node) => node && typeof node === 'object' && typeof node.__leaf === 'string'

function checkLeaf(node, value) {
  switch (node.__leaf) {
    case 'enum':
      return node.values.includes(value) ? { ok: true, value } : { ok: false, error: `must be one of ${node.values.join(', ')}` }
    case 'bool':
      return typeof value === 'boolean' ? { ok: true, value } : { ok: false, error: 'must be true or false' }
    case 'int':
      return Number.isInteger(value) && value >= node.min && value <= node.max
        ? { ok: true, value } : { ok: false, error: `must be a whole number from ${node.min} to ${node.max}` }
    case 'num': {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < node.min || value > node.max) {
        return { ok: false, error: `must be a number from ${node.min} to ${node.max}` }
      }
      const snapped = Math.round(value / node.step) * node.step
      return { ok: true, value: Math.round(Math.min(node.max, Math.max(node.min, snapped)) * 1000) / 1000 }
    }
    case 'str':
      if (typeof value !== 'string') return { ok: false, error: 'must be text' }
      if (value.length > node.max) return { ok: false, error: `must be at most ${node.max} characters` }
      if (node.re && !node.re.test(value)) return { ok: false, error: 'has characters that are not allowed' }
      return { ok: true, value }
    case 'idList': {
      if (!Array.isArray(value)) return { ok: false, error: 'must be a list' }
      if (value.length > node.max) return { ok: false, error: `has more than ${node.max} entries` }
      const seen = new Set()
      for (const id of value) {
        if (typeof id !== 'string' || !node.registry.has(id)) return { ok: false, error: 'contains an unknown id' }
        if (seen.has(id)) return { ok: false, error: 'lists the same id twice' }
        seen.add(id)
      }
      return { ok: true, value: value.slice() }
    }
    case 'rowList': {
      if (!Array.isArray(value)) return { ok: false, error: 'must be a list' }
      if (value.length > node.max) return { ok: false, error: `has more than ${node.max} rows` }
      const seen = new Set()
      const out = []
      for (const row of value) {
        if (!isPlainObject(row) || Object.keys(row).some((k) => k !== 'id' && k !== 'on')) return { ok: false, error: 'has a row that is not { id, on }' }
        if (typeof row.id !== 'string' || !node.registry.has(row.id)) return { ok: false, error: 'has an unknown row id' }
        if (typeof row.on !== 'boolean') return { ok: false, error: 'has a row whose "on" is not true or false' }
        if (seen.has(row.id)) return { ok: false, error: 'lists the same row twice' }
        seen.add(row.id)
        out.push({ id: row.id, on: row.on })
      }
      return { ok: true, value: out }
    }
    case 'nullable':
      if (value === null) return { ok: true, value: null }
      return checkNode(node.inner, value)
    case 'custom':
      return node.check(value)
    default:
      return { ok: false, error: 'unsupported schema node' }
  }
}

function checkNode(node, value) {
  if (isLeaf(node)) return checkLeaf(node, value)
  return { ok: false, error: 'internal: a section was used as a value' }
}

/**
 * Validate `input` against a section tree.
 * options: { partial, dropInvalid, path }
 * Returns { ok, value, errors:[string] }. `value` only holds keys that were present (partial) or every key
 * (full, missing ones filled from the leaf defaults).
 */
function validate(schema, input, options = {}, pathPrefix = '') {
  const { partial = false, dropInvalid = false } = options
  const errors = []
  const out = {}
  if (!isPlainObject(input)) {
    return { ok: false, value: partial ? {} : defaultsOf(schema), errors: [`${pathPrefix || 'value'} must be an object`] }
  }
  if (!pathPrefix && (!withinDepth(input) || hasForbiddenKey(input))) {
    return { ok: false, value: partial ? {} : defaultsOf(schema), errors: ['value is nested too deeply or uses a reserved key'] }
  }
  for (const key of Object.keys(input)) {
    if (!hasOwn(schema, key)) {
      if (!dropInvalid) errors.push(`${pathPrefix ? pathPrefix + '.' : ''}${key} is not a known setting`)
    }
  }
  for (const key of Object.keys(schema)) {
    const here = pathPrefix ? `${pathPrefix}.${key}` : key
    const node = schema[key]
    const present = hasOwn(input, key) && input[key] !== undefined
    if (!present) {
      if (!partial) out[key] = isLeaf(node) ? clone(node.default) : validate(node, {}, options, here).value
      continue
    }
    if (isLeaf(node)) {
      const r = checkLeaf(node, input[key])
      if (r.ok) out[key] = r.value
      else if (dropInvalid) { if (!partial) out[key] = clone(node.default) }
      else errors.push(`${here} ${r.error}`)
    } else {
      const sub = validate(node, input[key], options, here)
      if (sub.ok || dropInvalid) out[key] = sub.value
      errors.push(...(dropInvalid ? [] : sub.errors))
    }
  }
  return { ok: errors.length === 0, value: out, errors }
}

function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)) }

/** Every leaf default, as a plain object. */
function defaultsOf(schema) {
  const out = {}
  for (const key of Object.keys(schema)) {
    const node = schema[key]
    out[key] = isLeaf(node) ? clone(node.default) : defaultsOf(node)
  }
  return out
}

/** JSON merge-patch (RFC 7386 flavoured): objects merge, arrays and scalars replace, null deletes. */
function mergePatch(target, patch) {
  if (!isPlainObject(patch)) return clone(patch)
  const out = isPlainObject(target) ? clone(target) : {}
  for (const key of Object.keys(patch)) {
    if (FORBIDDEN_KEYS.has(key)) continue
    if (patch[key] === null) delete out[key]
    else if (isPlainObject(patch[key])) out[key] = mergePatch(out[key], patch[key])
    else out[key] = clone(patch[key])
  }
  return out
}

/** Deep merge of layers, later wins per key, arrays replace whole. Never null-deletes. */
function overlay(...layers) {
  let out = {}
  for (const layer of layers) {
    if (!isPlainObject(layer)) continue
    for (const key of Object.keys(layer)) {
      if (FORBIDDEN_KEYS.has(key)) continue
      const v = layer[key]
      if (isPlainObject(v)) out[key] = overlay(out[key], v)
      else out[key] = clone(v)
    }
  }
  return out
}

/** List the dotted paths at which two plain trees differ (for import previews). */
function diffPaths(a, b, prefix = '') {
  const out = []
  const keys = new Set([...Object.keys(isPlainObject(a) ? a : {}), ...Object.keys(isPlainObject(b) ? b : {})])
  for (const key of keys) {
    const path = prefix ? `${prefix}.${key}` : key
    const x = isPlainObject(a) ? a[key] : undefined
    const y = isPlainObject(b) ? b[key] : undefined
    if (isPlainObject(x) && isPlainObject(y)) out.push(...diffPaths(x, y, path))
    else if (JSON.stringify(x) !== JSON.stringify(y)) out.push({ path, from: x === undefined ? null : x, to: y === undefined ? null : y })
  }
  return out
}

module.exports = {
  FORBIDDEN_KEYS, MAX_DEPTH, hasOwn, isPlainObject, withinDepth, hasForbiddenKey, byteSize, clone,
  enumOf, intOf, numOf, boolOf, strOf, idListOf, rowListOf, nullable, custom, isLeaf,
  validate, defaultsOf, mergePatch, overlay, diffPaths
}
