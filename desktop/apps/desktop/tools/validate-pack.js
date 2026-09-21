#!/usr/bin/env node
'use strict'
// Check a Beebo theme or layout pack from the command line, the way the app will.
//
//   node tools/validate-pack.js my-pack.json            validate; for a theme, list WCAG AA contrast problems
//   node tools/validate-pack.js my-pack.json --fix      also write my-pack.fixed.json with the automatic contrast fix applied
//   node tools/validate-pack.js my-pack.json --seal     also write my-pack.sealed.json with an integrity hash added
//
// Exit code 0 = valid (contrast warnings do not fail it, they are advice), 1 = refused.
// See docs/CUSTOMIZATION.md.

const fs = require('fs')
const path = require('path')
const packs = require('../electron/packs')
const contrast = require('../electron/themeContrast')

const [file, ...flags] = process.argv.slice(2)
if (!file) {
  console.error('Usage: node tools/validate-pack.js <pack.json> [--fix] [--seal]')
  process.exit(2)
}

let text
try { text = fs.readFileSync(file, 'utf8') } catch (e) { console.error('Cannot read ' + file); process.exit(2) }
const parsed = packs.parseFileText(text)
if (!parsed.ok) { console.error('REFUSED: ' + parsed.errors.join(' ')); process.exit(1) }
const result = packs.validatePack(parsed.value)
if (!result.ok) {
  console.error('REFUSED:')
  for (const e of result.errors) console.error('  - ' + e)
  process.exit(1)
}
const pack = result.pack
console.log(`OK: ${pack.kind} pack "${pack.name}" (${pack.id} ${pack.version}) by ${pack.author.name}, ${pack.license}`)

const outName = (suffix) => path.join(path.dirname(file), path.basename(file, path.extname(file)) + '.' + suffix + '.json')

if (pack.kind === 'theme') {
  const base = packs.baseOf(pack)
  const check = contrast.check(base, pack.content.vars)
  console.log(`Contrast: ${check.checked} text/background pairs checked against WCAG AA (base preset: ${base}).`)
  if (!check.failures.length) console.log('  All pairs pass.')
  for (const f of check.failures) console.log(`  LOW  ${f.fg} on ${f.bg}: ${f.ratio}:1, needs ${f.min}:1 (${f.what})`)
  if (check.failures.length && flags.includes('--fix')) {
    const fixed = contrast.autoFix(base, pack.content.vars)
    const out = Object.assign({}, parsed.value, { content: Object.assign({}, parsed.value.content, { vars: fixed.vars }) })
    delete out.integrity
    fs.writeFileSync(outName('fixed'), JSON.stringify(out, null, 2) + '\n')
    console.log(`Wrote ${outName('fixed')}: ${fixed.changes.length} color(s) adjusted` + (fixed.remaining.length ? `, ${fixed.remaining.length} pair(s) cannot be fixed by changing text alone (change a background)` : '.'))
    for (const c of fixed.changes) console.log(`  ${c.name}: ${c.from} -> ${c.to}`)
  }
}
if (flags.includes('--seal')) {
  fs.writeFileSync(outName('sealed'), JSON.stringify(packs.toFile(pack), null, 2) + '\n')
  console.log('Wrote ' + outName('sealed'))
}
