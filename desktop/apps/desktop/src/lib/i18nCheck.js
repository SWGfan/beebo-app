// i18nCheck.js - the checks behind `npm run i18n:report` and test/i18n.test.js. Pure: give it
// catalogs and source text, get back what is missing, extra, broken or unused.
import { placeholdersOf, SOURCE_LOCALE } from './i18n.js'

const PLURAL_FORMS = new Set(['zero', 'one', 'two', 'few', 'many', 'other'])

const isPluralEntry = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Everything wrong or unfinished in `target` compared with the English `source` catalog. */
export function compareCatalog(source, target, locale) {
  const out = { missing: [], extra: [], placeholders: [], plurals: [], types: [], identical: [] }
  for (const key of Object.keys(source)) {
    if (!Object.prototype.hasOwnProperty.call(target, key)) { out.missing.push(key); continue }
    const a = source[key]
    const b = target[key]
    if (isPluralEntry(a) !== isPluralEntry(b) || (typeof b !== 'string' && !isPluralEntry(b))) { out.types.push(key); continue }
    if (isPluralEntry(b)) {
      const bad = Object.keys(b).filter((form) => !PLURAL_FORMS.has(form) && !/^=\d+$/.test(form))
      if (bad.length || typeof b.other !== 'string') out.plurals.push(key)
      let valid = true
      try { valid = new Intl.PluralRules(locale).resolvedOptions().pluralCategories.length > 0 } catch { valid = false }
      if (!valid) out.plurals.push(key)
    }
    // Same placeholders in the same message (a form may drop {count} when the language says it in words).
    const want = placeholdersOf(a)
    const got = placeholdersOf(b)
    const isPlural = isPluralEntry(a)
    const okPlaceholders = isPlural
      ? got.every((name) => want.includes(name)) && want.filter((n) => n !== 'count').every((n) => got.includes(n))
      : JSON.stringify(want) === JSON.stringify(got)
    if (!okPlaceholders) out.placeholders.push(key)
    if (locale !== SOURCE_LOCALE && JSON.stringify(a) === JSON.stringify(b)) out.identical.push(key)
  }
  for (const key of Object.keys(target)) if (!Object.prototype.hasOwnProperty.call(source, key)) out.extra.push(key)
  return out
}

/** Keys a piece of source code asks for: literal keys, and the prefix of `nav.${id}` style keys. */
export function findKeyUsage(text) {
  const used = new Set()
  const prefixes = new Set()
  // t('a.b'), tr("a.b"), tOr('a.b', ...), tNow('a.b')
  for (const m of text.matchAll(/\b(?:t|tr|tOr|tNow|tt)\(\s*(['"])([A-Za-z][\w.]*)\1/g)) used.add(m[2])
  // t(`a.b.${x}`) and t(`a.b.${x}.title`)
  for (const m of text.matchAll(/\b(?:t|tr|tOr|tNow|tt)\(\s*`([A-Za-z][\w.]*\.)\$\{/g)) prefixes.add(m[1])
  for (const m of text.matchAll(/\btOr\(\s*(?:GROUP_KEYS\[[^\]]*\]\s*\|\|\s*)?`([A-Za-z][\w.]*\.)\$\{/g)) prefixes.add(m[1])
  // 'a.b' strings that are keys handed around as data
  for (const m of text.matchAll(/(['"])((?:nav|library|detail|firstrun|doctor|settings|sidebar|footer|logout|view|language|a11y|common|whatsNew)\.[A-Za-z][\w.]*)\1/g)) used.add(m[2])
  return { used, prefixes }
}

/** Keys in `en` that no source file uses (counting dynamic prefixes), and keys used but not in `en`. */
export function usageReport(en, usages) {
  const used = new Set()
  const prefixes = new Set()
  for (const u of usages) { u.used.forEach((k) => used.add(k)); u.prefixes.forEach((p) => prefixes.add(p)) }
  const keys = Object.keys(en)
  const unused = keys.filter((k) => !used.has(k) && ![...prefixes].some((p) => k.startsWith(p)))
  const undefinedKeys = [...used].filter((k) => !Object.prototype.hasOwnProperty.call(en, k))
  return { unused, undefinedKeys }
}

/** One-line summary per locale: how many keys, how many translated, what is wrong. */
export function summarize(en, catalogs) {
  const total = Object.keys(en).length
  return Object.keys(catalogs).filter((c) => c !== SOURCE_LOCALE).sort().map((code) => {
    const r = compareCatalog(en, catalogs[code], code)
    return {
      code,
      keys: Object.keys(catalogs[code]).length,
      total,
      missing: r.missing.length,
      extra: r.extra.length,
      broken: r.placeholders.length + r.plurals.length + r.types.length,
      identical: r.identical.length,
      detail: r
    }
  })
}
