// Old-Chromium compatibility check for everything under app/ (run: npm run lint).
//
//  1. Every .js file must PARSE as an ES2018 module (acorn, ecmaVersion 2018). That alone rejects
//     optional chaining, ??, optional catch binding, class fields, BigInt, dynamic import(),
//     import.meta, numeric separators, Array/Object spread in newer positions, etc.
//  2. A banned-API pass over the token stream (comments and strings are never scanned): built-ins
//     newer than Chromium 63 (Tizen 5.0 / the oldest engine we target).
//  3. A CSS pass (comments stripped) for properties/selectors newer than Chromium 63.
//
// Exit code 1 on any finding. Also exported for test/compat.test.mjs.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const TARGET = 'Chromium 63 (Tizen 5.0, 2019) - see README "Supported TVs"'

// Member names / globals introduced after Chromium 63.
export const BANNED_MEMBERS = {
  replaceAll: 'Chromium 85', matchAll: 'Chromium 73', flat: 'Chromium 69', flatMap: 'Chromium 69',
  fromEntries: 'Chromium 73', allSettled: 'Chromium 76', at: 'Chromium 92', findLast: 'Chromium 97',
  findLastIndex: 'Chromium 97', toSorted: 'Chromium 110', replaceChildren: 'Chromium 86',
  randomUUID: 'Chromium 92', trimStart: 'Chromium 66', trimEnd: 'Chromium 66',
  description: 'Chromium 70 (Symbol.description)', queueMicrotask: 'Chromium 71', hasOwn: 'Chromium 93'
}
export const BANNED_GLOBALS = {
  globalThis: 'Chromium 71', AbortController: 'Chromium 66', ResizeObserver: 'Chromium 64',
  structuredClone: 'Chromium 98', BigInt: 'Chromium 67', queueMicrotask: 'Chromium 71',
  requestIdleCallback: 'not on every TV engine', ReadableStream: 'Chromium 43 partial - avoid'
}
// Text patterns worth flagging even inside code (checked on the token stream, not raw text).
export const BANNED_OPTION_NAMES = { preventScroll: 'focus({preventScroll}) needs Chromium 64' }

export const BANNED_CSS = [
  [/(^|[;{\s])(row-|column-)?gap\s*:/i, 'CSS gap (flexbox: Chromium 84; grid: 66) - use margins or grid-gap'],
  [/aspect-ratio\s*:/i, 'aspect-ratio needs Chromium 88 - use the padding-top trick'],
  [/(^|[;{\s])inset\s*:/i, 'inset needs Chromium 87 - use top/right/bottom/left'],
  [/:focus-visible/i, ':focus-visible needs Chromium 86 - use a .is-focused class'],
  [/:(is|where|has)\(/i, ':is()/:where()/:has() need Chromium 88+'],
  [/@container/i, '@container needs Chromium 105'],
  [/(^|[^-\w])(clamp|min|max)\(/i, 'CSS min()/max()/clamp() need Chromium 79'],
  [/(^|[^-\w])env\(/i, 'env() needs Chromium 69'],
  [/backdrop-filter/i, 'backdrop-filter needs Chromium 76 and is heavy on TV GPUs'],
  [/scroll-snap-type|overscroll-behavior/i, 'scroll snap / overscroll-behavior: avoid on old TVs'],
  [/@layer|@property/i, 'cascade layers / @property need Chromium 99 / 85'],
  [/translate\s*:|(^|[;{\s])scale\s*:|(^|[;{\s])rotate\s*:/i, 'individual transform properties need Chromium 104'],
  [/content-visibility|contain-intrinsic/i, 'content-visibility needs Chromium 85'],
  [/color-mix\(|oklch\(|lab\(/i, 'modern colour functions need Chromium 111+'],
  [/(^|[;{\s])(display\s*:\s*contents)/i, 'display: contents needs Chromium 65']
]

async function loadAcorn() {
  try {
    return await import('acorn')
  } catch (e) {
    return null
  }
}

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

/** @returns {Promise<string[]>} human-readable findings for one JS source */
export async function checkJs(source, file, acorn) {
  const findings = []
  const at = (line, msg) => findings.push(file + ':' + line + ' ' + msg)
  let tokens = []
  try {
    const tk = acorn.tokenizer(source, { ecmaVersion: 2018, sourceType: 'module', locations: true })
    for (const t of tk) tokens.push(t)
    acorn.parse(source, { ecmaVersion: 2018, sourceType: 'module' }) // full syntax check
  } catch (err) {
    at(err.loc ? err.loc.line : 0, 'not valid ES2018 module syntax: ' + err.message)
    return findings
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    const prev = tokens[i - 1]
    if (t.type.label === 'name') {
      const isMember = prev && prev.type.label === '.'
      if (isMember && Object.prototype.hasOwnProperty.call(BANNED_MEMBERS, t.value)) {
        // a property that merely shares a name (obj.flat = ...) is rare here; flag conservatively
        at(t.loc.start.line, '.' + t.value + ' is ' + BANNED_MEMBERS[t.value])
      }
      if (!isMember && Object.prototype.hasOwnProperty.call(BANNED_GLOBALS, t.value)) {
        at(t.loc.start.line, t.value + ' is ' + BANNED_GLOBALS[t.value])
      }
      if (Object.prototype.hasOwnProperty.call(BANNED_OPTION_NAMES, t.value)) at(t.loc.start.line, BANNED_OPTION_NAMES[t.value])
    }
  }
  return findings
}

export function checkCss(source, file) {
  const findings = []
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  const lines = stripped.split('\n')
  lines.forEach((line, i) => {
    for (const [re, msg] of BANNED_CSS) if (re.test(line)) findings.push(file + ':' + (i + 1) + ' ' + msg)
  })
  return findings
}

export async function checkTree(appDir) {
  const acorn = await loadAcorn()
  const findings = []
  let files = 0
  for (const f of walk(appDir, [])) {
    const rel = path.relative(appDir, f)
    if (f.endsWith('.js')) {
      if (!acorn) { findings.push('acorn is not installed - run "npm install" in apps/smarttv'); break }
      files++
      findings.push(...(await checkJs(fs.readFileSync(f, 'utf8'), rel, acorn)))
    } else if (f.endsWith('.css')) {
      files++
      findings.push(...checkCss(fs.readFileSync(f, 'utf8'), rel))
    }
  }
  return { findings, files }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app')
  const { findings, files } = await checkTree(appDir)
  if (findings.length) {
    console.error('Compatibility check FAILED (target: ' + TARGET + '):')
    for (const f of findings) console.error('  ' + f)
    process.exit(1)
  }
  console.log('Compatibility check passed: ' + files + ' files parse as ES2018 modules / CSS with no APIs newer than ' + TARGET + '.')
}
