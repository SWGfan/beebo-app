'use strict'
// The CSS sanitizer for packs and profiles.
//
// A pack is DATA: JSON that names CSS custom properties from the theme registry (themeTokens.js) and gives
// each a value in a tiny grammar (color, gradient, small size). This module is the single gate every such
// value passes before it can reach a stylesheet:
//
//   screenText(text)          -> null when the text is plain, or the reason it is not. Runs BEFORE parsing so
//                                the answer is the same however a forbidden thing was spelled.
//   sanitizeVars(map)         -> { ok, vars, errors } for a { '--name': 'value' } map. Names must be in the
//                                registry; each value must pass screenText and then the type's grammar
//                                (theme.parseValue). What comes out is RE-SERIALISED from the parsed value, so
//                                a byte the grammar does not produce cannot appear in the CSS.
//   declarations(vars)        -> the `--a:v;--b:v;` text, rebuilt from sanitized vars only.
//   rule(selector, vars)      -> `selector{...}` for a fixed, code-supplied selector (never pack text).
//
// What is refused, on purpose: url() and every other function that fetches (image-set, src, element,
// paint, image), @import and every at-rule, expression()/behavior/-moz-binding, javascript:/data:/http(s):
// anywhere, braces, backslash escapes (CSS's `\75rl(` spelling), comments (`u/**/rl(`), quotes, angle
// brackets, non-ASCII look-alikes, control characters, var()/env()/attr()/calc(), unknown variable names,
// prototype-pollution keys, and anything over the size limits. A pack therefore has no way to load a remote
// resource or run script even if a browser had a CSS parser bug: there is nothing but colors and lengths.

const theme = require('./theme')
const { BY_NAME } = require('./themeTokens')
const { FORBIDDEN_KEYS, isPlainObject, hasOwn } = require('./schemaKit')

const LIMITS = Object.freeze({
  maxEntries: 120, // more than the registry has; the real cap is "in the registry"
  maxValueLength: theme.LIMITS.maxValueLength,
  maxTotalLength: 24 * 1024
})

const ASCII_ONLY = /^[\x20-\x7e]*$/ // no tab/newline inside a value: values are single-line
const FORBIDDEN = [
  [/[{}]/, 'braces'],
  [/\\/, 'backslash escapes'],
  [/\/\*|\*\//, 'comments'],
  [/[<>]/, 'angle brackets'],
  [/@/, 'at-rules such as @import'],
  [/["'`]/, 'quotes'],
  [/!/, '!important'],
  [/&/, 'ampersands'],
  [/;/, 'semicolons inside a value'],
  [/url\s*\(|image-set|image\s*\(|src\s*\(|element\s*\(|paint\s*\(|cross-fade|-webkit-image/i, 'url() or other functions that load images'],
  [/expression|javascript|vbscript|behavior|binding|import/i, 'script or import keywords'],
  [/\bvar\s*\(|\benv\s*\(|\battr\s*\(|\bcalc\s*\(|\bmin\s*\(|\bmax\s*\(|\bclamp\s*\(/i, 'var(), env(), attr() or calc()'],
  [/data:|https?:|ftp:|file:|\/\//i, 'links']
]

/** null when `text` is a plain value string; otherwise a short reason. */
function screenText(text) {
  if (typeof text !== 'string') return 'is not text'
  if (text.length > LIMITS.maxValueLength) return `is longer than ${LIMITS.maxValueLength} characters`
  if (!ASCII_ONLY.test(text)) return 'has characters other than plain keyboard ones (look-alike letters, hidden or control characters)'
  for (const [re, label] of FORBIDDEN) if (re.test(text)) return `uses something not allowed: ${label}`
  return null
}

/**
 * Sanitize a { '--name': 'value' } map against the theme registry.
 * Returns { ok:true, vars } (canonical values, registry order) or { ok:false, errors, vars:{} }.
 * Nothing is repaired: any bad entry fails the whole map (a pack is all or nothing).
 */
function sanitizeVars(input) {
  const errors = []
  const fail = (msg) => { if (errors.length < 20) errors.push(msg) }
  if (input === undefined || input === null) return { ok: true, vars: {}, errors }
  if (!isPlainObject(input)) return { ok: false, vars: {}, errors: ['The variable list must be an object of --name: value pairs.'] }
  const names = Object.keys(input)
  if (names.length > LIMITS.maxEntries) return { ok: false, vars: {}, errors: [`Too many variables (at most ${LIMITS.maxEntries}).`] }
  let total = 0
  const picked = {}
  for (const name of names) {
    if (FORBIDDEN_KEYS.has(name)) { fail('A reserved name was used as a variable name.'); continue }
    if (!/^--[a-z0-9-]{1,40}$/.test(name)) { fail('A variable name is not in the form --name.'); continue }
    const token = BY_NAME.get(name)
    if (!token) { fail(`${name} is not a Beebo theme variable.`); continue }
    const raw = input[name]
    const bad = screenText(raw)
    if (bad) { fail(`${name} ${bad}.`); continue }
    total += raw.length
    const parsed = theme.parseValue(token.type, raw)
    if (!parsed.ok) { fail(`${name} ${parsed.error}`); continue }
    picked[name] = parsed.value
  }
  if (total > LIMITS.maxTotalLength) fail(`The values together are longer than ${LIMITS.maxTotalLength} characters.`)
  if (errors.length) return { ok: false, vars: {}, errors }
  // registry order, so the output is stable
  const vars = {}
  for (const tok of theme.TOKENS) if (hasOwn(picked, tok.name)) vars[tok.name] = picked[tok.name]
  return { ok: true, vars, errors }
}

const DECL_SAFE = /^(?:--[a-z0-9-]+:[#a-z0-9%.,()\s-]+;)*$/

/** `--a:v;--b:v;` from vars that already passed sanitizeVars; re-validated here (never trust the caller). */
function declarations(vars) {
  const clean = sanitizeVars(vars)
  if (!clean.ok) return ''
  const body = Object.keys(clean.vars).map((name) => `${name}:${clean.vars[name]};`).join('')
  return DECL_SAFE.test(body) ? body : ''
}

const SELECTOR_SAFE = /^[a-zA-Z0-9\s:.\-[\]="_]+$/
/** `selector{...}` — the selector must be code-supplied and plain. Returns '' if anything is off. */
function rule(selector, vars) {
  if (typeof selector !== 'string' || !SELECTOR_SAFE.test(selector)) return ''
  const body = declarations(vars)
  return body ? `${selector}{${body}}` : ''
}

module.exports = { LIMITS, screenText, sanitizeVars, declarations, rule }
