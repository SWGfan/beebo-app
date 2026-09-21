'use strict'
// Pack files: the validated, DATA-ONLY way a designer (or the household) hands Beebo a look.
//
//   { "format":"beebo-pack", "v":1, "kind":"theme"|"layout", "id", "name", "version", "description",
//     "author":{"name","url"?}, "license", "minBeebo"?, "integrity"?, "content":{...} }
//
//   kind "theme":  content = { scheme:"dark"|"light", themeColor:"#rrggbb", extends?:<preset id>, vars:{ "--token":"value" } }
//                  vars go through cssSafe.sanitizeVars: registry names only, colors/gradients/sizes only.
//   kind "layout": content = a `layout` section of the preferences profile (density, cardStyle, radius,
//                  posterAspect, fontScale, sidebar, home), validated by the same closed schema.
//
// There is no script, no CSS text, no url(), no font and no image in a pack. The file is ONE JSON document,
// at most 256 KB (no zip, so no zip-slip or zip-bomb). Unknown keys anywhere are errors. `integrity`, when
// present, is a sha256 of the content and must match. Applying a pack COPIES its validated values into the
// person's profile (with an `origin` of { id, ver } for update notices); nothing runs from the pack later.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const kit = require('./schemaKit')
const cssSafe = require('./cssSafe')
const schema = require('./prefsSchema')
const theme = require('./theme')
const contrast = require('./themeContrast')

const KINDS = ['theme', 'layout']
const ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/
const VER_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/
const TEXT_RE = /^[^\p{C}\p{Zl}\p{Zp}]*$/u // no control, format (bidi, zero-width), line-separator or unassigned characters
const HTTPS_URL = /^https:\/\/[a-z0-9.-]{1,120}(?:\/[A-Za-z0-9._~%\-/]{0,120})?$/
const HEX6 = /^#[0-9a-f]{6}$/
const ENVELOPE_KEYS = ['format', 'v', 'kind', 'id', 'name', 'version', 'description', 'author', 'license', 'minBeebo', 'integrity', 'content']

const text = (v, max, { min = 1 } = {}) => typeof v === 'string' && v.length >= min && v.length <= max && TEXT_RE.test(v)

/** sha256 over the canonical (key-sorted) JSON of `content`, as "sha256-<base64>". */
function contentIntegrity(content) {
  const canon = (v) => (Array.isArray(v) ? v.map(canon) : kit.isPlainObject(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v)
  return 'sha256-' + crypto.createHash('sha256').update(JSON.stringify(canon(content)), 'utf8').digest('base64')
}

function checkAuthor(a, errors) {
  if (!kit.isPlainObject(a) || Object.keys(a).some((k) => k !== 'name' && k !== 'url')) { errors.push('author must be { name, url? }'); return null }
  if (!text(a.name, 60)) { errors.push('author.name must be 1 to 60 plain characters'); return null }
  if (a.url !== undefined && (typeof a.url !== 'string' || !HTTPS_URL.test(a.url))) { errors.push('author.url must be a plain https:// address'); return null }
  return a.url === undefined ? { name: a.name } : { name: a.name, url: a.url }
}

function checkThemeContent(content, errors) {
  if (!kit.isPlainObject(content)) { errors.push('content must be an object'); return null }
  for (const k of Object.keys(content)) if (!['scheme', 'themeColor', 'extends', 'vars'].includes(k)) errors.push(`content.${k} is not a known setting`)
  if (!['dark', 'light'].includes(content.scheme)) errors.push('content.scheme must be dark or light')
  if (typeof content.themeColor !== 'string' || !HEX6.test(content.themeColor)) errors.push('content.themeColor must be #rrggbb')
  if (content.extends !== undefined && !(typeof content.extends === 'string' && theme.hasPreset(content.extends))) errors.push('content.extends must be one of the built-in preset ids')
  const vars = cssSafe.sanitizeVars(content.vars)
  if (!vars.ok) errors.push(...vars.errors.map((e) => 'content.vars: ' + e))
  if (content.vars === undefined || (vars.ok && !Object.keys(vars.vars).length)) errors.push('content.vars must set at least one variable')
  if (errors.length) return null
  return { scheme: content.scheme, themeColor: content.themeColor, extends: content.extends, vars: vars.vars }
}

function checkLayoutContent(content, errors) {
  if (!kit.isPlainObject(content)) { errors.push('content must be an object'); return null }
  if (Object.prototype.hasOwnProperty.call(content, 'pack')) errors.push('content.pack is set by Beebo, not by the pack')
  const { pack: _pack, ...rest } = content
  const layoutOnly = Object.assign({}, schema.LAYOUT)
  delete layoutOnly.pack
  const r = kit.validate(layoutOnly, rest, { partial: true }, 'content')
  if (!r.ok) errors.push(...r.errors)
  return errors.length ? null : r.value
}

/**
 * Validate a parsed pack file. Returns { ok, pack, errors }. `pack` is a normalized copy (never the input).
 * `expectKind` restricts the kind when the caller knows it.
 */
function validatePack(input, { expectKind } = {}) {
  const errors = []
  if (!kit.isPlainObject(input)) return { ok: false, errors: ['This is not a Beebo pack file.'] }
  if (!kit.withinDepth(input, 8) || kit.hasForbiddenKey(input)) return { ok: false, errors: ['This pack is nested too deeply or uses a reserved key.'] }
  if (kit.byteSize(input) > schema.LIMITS.maxFileBytes) return { ok: false, errors: ['This pack is larger than 256 KB.'] }
  if (input.format !== schema.PACK_FORMAT) return { ok: false, errors: ['This is not a Beebo pack file (format).'] }
  if (input.v !== 1) return { ok: false, errors: [Number(input.v) > 1 ? 'This pack was made by a newer version of Beebo. Update Beebo to use it.' : 'Unsupported pack version.'] }
  for (const k of Object.keys(input)) if (!ENVELOPE_KEYS.includes(k)) errors.push(`${k} is not a known pack field`)
  if (!KINDS.includes(input.kind)) errors.push('kind must be theme or layout')
  if (expectKind && input.kind !== expectKind) errors.push(`This is a ${input.kind} pack, not a ${expectKind} pack.`)
  if (typeof input.id !== 'string' || !ID_RE.test(input.id)) errors.push('id must be lowercase letters, numbers, dots, dashes (2 to 64 characters)')
  if (!text(input.name, 40)) errors.push('name must be 1 to 40 plain characters')
  if (typeof input.version !== 'string' || !VER_RE.test(input.version)) errors.push('version must look like 1.0.0')
  if (input.description !== undefined && !text(input.description, 240, { min: 0 })) errors.push('description must be at most 240 plain characters')
  if (!text(input.license, 40)) errors.push('license must be 1 to 40 plain characters (for example CC0-1.0)')
  if (input.minBeebo !== undefined && (typeof input.minBeebo !== 'string' || !VER_RE.test(input.minBeebo))) errors.push('minBeebo must look like 0.2.0')
  const author = checkAuthor(input.author, errors)
  let content = null
  if (input.kind === 'theme') content = checkThemeContent(input.content, errors)
  else if (input.kind === 'layout') content = checkLayoutContent(input.content, errors)
  if (input.integrity !== undefined) {
    if (typeof input.integrity !== 'string' || !/^sha256-[A-Za-z0-9+/]{43}=$/.test(input.integrity)) errors.push('integrity must be sha256-<base64>')
    else if (kit.isPlainObject(input.content) && input.integrity !== contentIntegrity(input.content)) errors.push('integrity does not match the content: the file was changed after it was made')
  }
  if (errors.length || !content || !author) return { ok: false, errors: errors.slice(0, 20) }
  return {
    ok: true,
    errors: [],
    pack: {
      format: schema.PACK_FORMAT, v: 1, kind: input.kind, id: input.id, name: input.name, version: input.version,
      description: input.description || '', author, license: input.license, minBeebo: input.minBeebo, content
    }
  }
}

/** Parse pack/profile file text: size cap, JSON only. Returns { ok, value } or { ok:false, errors }. */
function parseFileText(textIn) {
  if (typeof textIn !== 'string') return { ok: false, errors: ['The file is not text.'] }
  if (Buffer.byteLength(textIn, 'utf8') > schema.LIMITS.maxFileBytes) return { ok: false, errors: ['The file is larger than 256 KB.'] }
  const trimmed = textIn.replace(/^﻿/, '')
  try {
    const value = JSON.parse(trimmed)
    return { ok: true, value }
  } catch { return { ok: false, errors: ['The file is not valid JSON.'] } }
}

/** A pack as a file the person can save: the envelope with a fresh integrity hash. */
function toFile(pack) {
  const out = Object.assign({}, pack)
  if (out.minBeebo === undefined) delete out.minBeebo
  out.integrity = contentIntegrity(out.content)
  return out
}

// ---- bundled packs -------------------------------------------------------------------------------------
const PACK_DIR = path.join(__dirname, 'packs')
let bundled = null

function loadBundled({ force = false } = {}) {
  if (bundled && !force) return bundled
  const out = { theme: [], layout: [], problems: [] }
  let files = []
  try { files = fs.readdirSync(PACK_DIR).filter((f) => f.endsWith('.json')).sort() } catch { files = [] }
  for (const file of files) {
    try {
      const parsed = parseFileText(fs.readFileSync(path.join(PACK_DIR, file), 'utf8'))
      if (!parsed.ok) { out.problems.push(`${file}: ${parsed.errors[0]}`); continue }
      const r = validatePack(parsed.value)
      if (!r.ok) { out.problems.push(`${file}: ${r.errors[0]}`); continue }
      out[r.pack.kind].push(r.pack)
    } catch (e) { out.problems.push(`${file}: ${e && e.message}`) }
  }
  bundled = out
  return out
}

const findBundled = (kind, id) => (loadBundled()[kind] || []).find((p) => p.id === id) || null
const meta = (p) => ({ id: p.id, name: p.name, version: p.version, description: p.description, kind: p.kind, author: p.author, license: p.license })
const catalog = () => {
  const b = loadBundled()
  return { theme: b.theme.map((p) => Object.assign(meta(p), { scheme: p.content.scheme, themeColor: p.content.themeColor, vars: p.content.vars })), layout: b.layout.map((p) => Object.assign(meta(p), { content: p.content })) }
}

// ---- theme pack application ----------------------------------------------------------------------------
const baseOf = (pack) => pack.content.extends || (pack.content.scheme === 'light' ? 'daylight' : 'graphite')

/** What applying a theme pack would do: contrast warnings (AA) and whether auto-fix resolves them. */
function previewThemePack(pack) {
  const base = baseOf(pack)
  const before = contrast.check(base, pack.content.vars)
  const fix = before.failures.length ? contrast.autoFix(base, pack.content.vars) : null
  return {
    base,
    warnings: before.failures,
    checked: before.checked,
    fixable: !!fix && fix.remaining.length === 0,
    fixes: fix ? fix.changes : [],
    remaining: fix ? fix.remaining : []
  }
}

/** The vars to store for a theme pack, optionally with contrast fixes applied. */
function themeVarsFor(pack, { autoFix = false } = {}) {
  if (!autoFix) return pack.content.vars
  const fix = contrast.autoFix(baseOf(pack), pack.content.vars)
  return fix.vars
}

module.exports = {
  KINDS, contentIntegrity, validatePack, parseFileText, toFile, loadBundled, findBundled, catalog, meta,
  baseOf, previewThemePack, themeVarsFor, PACK_DIR
}
