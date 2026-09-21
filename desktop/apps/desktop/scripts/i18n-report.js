#!/usr/bin/env node
'use strict'
// i18n-report.js - lists what still needs translating and what is no longer used.
//
//   npm run i18n:report               summary per language + unused / undefined keys
//   npm run i18n:report -- --verbose  also every missing key and the English text next to it
//   npm run i18n:report -- --strict   exit 1 when anything is missing, broken, unused or undefined
//   npm run i18n:report -- --lang=fr  only that language
//
// English (src/locales/en.json) is the source of truth. A language may be behind (its missing
// keys show in English at run time), but it may never disagree with English about placeholders.
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')
const localesDir = path.join(root, 'src', 'locales')
const args = process.argv.slice(2)
const verbose = args.includes('--verbose')
const strict = args.includes('--strict')
const only = (args.find((a) => a.startsWith('--lang=')) || '').slice(7)

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'vendor' || /^i18n(Check)?\.js$/.test(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(jsx?|mjs)$/.test(entry.name)) out.push(full)
  }
  return out
}

async function main() {
  const check = await import(pathToFileURL(path.join(root, 'src', 'lib', 'i18nCheck.js')).href)
  const catalogs = {}
  for (const file of fs.readdirSync(localesDir).filter((f) => f.endsWith('.json'))) {
    catalogs[file.replace(/\.json$/, '')] = JSON.parse(fs.readFileSync(path.join(localesDir, file), 'utf8'))
  }
  const en = catalogs.en
  if (!en) { console.error('src/locales/en.json is missing'); process.exit(2) }

  let problems = 0
  console.log(`English (source): ${Object.keys(en).length} keys\n`)
  console.log('language   keys  missing  extra  broken  same-as-English')
  for (const row of check.summarize(en, catalogs)) {
    if (only && row.code !== only) continue
    console.log(`${row.code.padEnd(9)} ${String(row.keys).padStart(5)} ${String(row.missing).padStart(8)} ${String(row.extra).padStart(6)} ${String(row.broken).padStart(7)} ${String(row.identical).padStart(16)}`)
    problems += row.missing + row.extra + row.broken
    if (verbose) {
      for (const key of row.detail.missing) console.log(`    missing      ${key}   ${JSON.stringify(en[key])}`)
      for (const key of row.detail.extra) console.log(`    extra        ${key}`)
      for (const key of row.detail.placeholders) console.log(`    placeholders ${key}   en: ${JSON.stringify(en[key])}   ${row.code}: ${JSON.stringify(catalogs[row.code][key])}`)
      for (const key of row.detail.plurals) console.log(`    plural forms ${key}`)
      for (const key of row.detail.types) console.log(`    wrong type   ${key}`)
    }
  }

  const usages = walk(path.join(root, 'src')).map((file) => check.findKeyUsage(fs.readFileSync(file, 'utf8')))
  const { unused, undefinedKeys } = check.usageReport(en, usages)
  console.log(`\nKeys in en.json that no source file uses: ${unused.length}`)
  for (const key of unused) console.log(`    unused       ${key}`)
  console.log(`Keys used in source but not in en.json: ${undefinedKeys.length}`)
  for (const key of undefinedKeys) console.log(`    undefined    ${key}`)
  problems += unused.length + undefinedKeys.length

  if (strict && problems) { console.error(`\n${problems} problem(s).`); process.exit(1) }
  console.log(problems ? `\n${problems} item(s) to look at.` : '\nAll clear.')
}

main().catch((error) => { console.error(error); process.exit(2) })
