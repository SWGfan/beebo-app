// i18n.js - a small, dependency-free translation layer. Pure: no React, no DOM, no storage,
// so node --test covers all of it (test/i18n.test.js). The app wires it to the page in
// i18nApp.js.
//
// Catalogs are flat objects: { "nav.movies": "Movies", "movies.count": { one: "{count} movie",
// other: "{count} movies" } }. English (src/locales/en.json) is the source of truth: a key that
// is missing from the chosen language falls back to English, and a key missing everywhere shows
// the key itself (and is reported once through onMissing) so a typo is visible, never blank.
//
// Message syntax (deliberately tiny):
//   {name}          the value of vars.name
//   {n:number}      formatted for the language (1,234 / 1.234)      also :percent
//   {when:date}     a medium date;  :time  and  :datetime  likewise
//   {{ and }}       a literal { and }
//   plural entry    an object with any of zero/one/two/few/many/other, or "=0"/"=1" exact
//                   matches; chosen with Intl.PluralRules for the language. {count} inside a
//                   plural entry is formatted as a number automatically.

export const SOURCE_LOCALE = 'en'

// Written right-to-left. Only the base language matters.
export const RTL_LANGUAGES = Object.freeze(new Set(['ar', 'he', 'fa', 'ur', 'ps', 'sd', 'yi', 'dv', 'ckb']))

/** 'PT_br' / 'pt-br' -> 'pt-BR'; '' for anything that is not a language tag. */
export function canonicalize(tag) {
  if (typeof tag !== 'string') return ''
  const cleaned = tag.trim().replace(/_/g, '-')
  if (!cleaned || cleaned === '*') return ''
  try { return Intl.getCanonicalLocales(cleaned)[0] || '' } catch { return '' }
}

export const baseLanguage = (tag) => canonicalize(tag).split('-')[0].toLowerCase()

export function directionFor(tag) {
  return RTL_LANGUAGES.has(baseLanguage(tag)) ? 'rtl' : 'ltr'
}

/**
 * The best supported locale for an ordered list of wanted ones (what the person or the system
 * prefers, most wanted first), or null. An exact match wins; otherwise the same language in any
 * region (pt-PT gets pt-BR, es-MX gets es) is used.
 */
export function matchLocale(wanted, supported) {
  const have = (Array.isArray(supported) ? supported : []).map((code) => ({ code, canon: canonicalize(code) })).filter((x) => x.canon)
  const list = Array.isArray(wanted) ? wanted : [wanted]
  for (const want of list) {
    const canon = canonicalize(want)
    if (!canon) continue
    const exact = have.find((x) => x.canon.toLowerCase() === canon.toLowerCase())
    if (exact) return exact.code
    const base = baseLanguage(canon)
    const sameBase = have.filter((x) => baseLanguage(x.canon) === base)
    // Prefer the plain language ("es") over a regional one ("es-419") when both are shipped.
    const plain = sameBase.find((x) => x.canon.toLowerCase() === base)
    if (plain || sameBase.length) return (plain || sameBase[0]).code
  }
  return null
}

/**
 * Which language to show. `preference` is the person's choice: 'auto' (or empty) means the
 * system's, anything else is a locale code. Unknown or unsupported choices fall through to the
 * system list, then to English, so the app always has a language.
 */
export function resolveLocale({ preference = 'auto', systemLanguages = [], supported = [SOURCE_LOCALE], fallback = SOURCE_LOCALE } = {}) {
  const pref = typeof preference === 'string' ? preference.trim() : ''
  if (pref && pref.toLowerCase() !== 'auto') {
    const chosen = matchLocale([pref], supported)
    if (chosen) return { code: chosen, source: 'user' }
  }
  const system = matchLocale(systemLanguages, supported)
  if (system) return { code: system, source: 'system' }
  return { code: fallback, source: 'fallback' }
}

// ---------------------------------------------------------------- Intl caches

const cache = new Map()
function cached(kind, locale, options, make) {
  const key = kind + '|' + locale + '|' + JSON.stringify(options || null)
  let value = cache.get(key)
  if (!value) {
    try { value = make() } catch { value = null } // an unknown language tag: callers fall back to English
    if (value) cache.set(key, value)
  }
  return value
}

function numberFormat(locale, options) {
  return cached('n', locale, options, () => new Intl.NumberFormat(locale, options)) || new Intl.NumberFormat('en', options)
}

export function formatNumber(value, locale = SOURCE_LOCALE, options) {
  const n = Number(value)
  if (!Number.isFinite(n)) return String(value)
  return numberFormat(locale, options).format(n)
}

const DATE_STYLES = {
  short: { dateStyle: 'short' },
  medium: { dateStyle: 'medium' },
  long: { dateStyle: 'long' },
  time: { timeStyle: 'short' },
  datetime: { dateStyle: 'medium', timeStyle: 'short' }
}

export function formatDate(value, locale = SOURCE_LOCALE, style = 'medium') {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const options = typeof style === 'object' && style ? style : DATE_STYLES[style] || DATE_STYLES.medium
  const fmt = cached('d', locale, options, () => new Intl.DateTimeFormat(locale, options)) || new Intl.DateTimeFormat('en', options)
  return fmt.format(date)
}

/** formatRelative(-3, 'day', 'es') -> "hace 3 días". */
export function formatRelative(amount, unit = 'day', locale = SOURCE_LOCALE) {
  const options = { numeric: 'auto' }
  const fmt = cached('r', locale, options, () => new Intl.RelativeTimeFormat(locale, options)) || new Intl.RelativeTimeFormat('en', options)
  return fmt.format(Number(amount), unit)
}

/** formatList(['a','b','c'], 'fr') -> "a, b et c". */
export function formatList(items, locale = SOURCE_LOCALE, type = 'conjunction') {
  const options = { style: 'long', type }
  const fmt = cached('l', locale, options, () => new Intl.ListFormat(locale, options)) || new Intl.ListFormat('en', options)
  return fmt.format((items || []).map(String))
}

/** formatListParts(['A','B','C'], 'es') -> [{type:'element',value:'A'},{type:'literal',value:', '},...]
 *  so a screen can put a link or button in every element and keep the language's own separators. */
export function formatListParts(items, locale = SOURCE_LOCALE, type = 'conjunction') {
  const options = { style: 'long', type }
  const fmt = cached('l', locale, options, () => new Intl.ListFormat(locale, options)) || new Intl.ListFormat('en', options)
  return fmt.formatToParts((items || []).map(String))
}

/** formatDuration(148, 'de') -> "2 Std. 28 Min." (minutes in, the language's own unit words out); '' when unusable. */
export function formatDuration(minutes, locale = SOURCE_LOCALE) {
  const total = Math.round(Number(minutes))
  if (!Number.isFinite(total) || total <= 0) return ''
  const h = Math.floor(total / 60)
  const m = total % 60
  const part = (value, unit) => formatNumber(value, locale, { style: 'unit', unit, unitDisplay: 'short' })
  return [h ? part(h, 'hour') : '', m || !h ? part(m, 'minute') : ''].filter(Boolean).join(' ')
}

// ---------------------------------------------------------------- messages

function pluralRules(locale) {
  return cached('p', locale, null, () => new Intl.PluralRules(locale)) || new Intl.PluralRules('en')
}

/** Picks the form of a plural entry for `count`. Returns '' when the entry has no usable form. */
export function selectPlural(entry, count, locale = SOURCE_LOCALE) {
  if (typeof entry === 'string') return entry
  if (!entry || typeof entry !== 'object') return ''
  const n = Number(count)
  if (Number.isFinite(n) && typeof entry['=' + n] === 'string') return entry['=' + n]
  const category = Number.isFinite(n) ? pluralRules(locale).select(n) : 'other'
  const form = entry[category] ?? entry.other ?? entry.many ?? entry.one
  return typeof form === 'string' ? form : ''
}

const TOKEN = /\{\{|\}\}|\{([A-Za-z_][\w.]*)(?::(number|percent|date|time|datetime))?\}/g

/** Fills {placeholders}; a name with no value is left as written so the gap is visible. */
export function interpolate(template, vars, locale = SOURCE_LOCALE, { autoNumber = [] } = {}) {
  return String(template).replace(TOKEN, (match, name, type) => {
    if (match === '{{') return '{'
    if (match === '}}') return '}'
    const value = vars ? vars[name] : undefined
    if (value === undefined || value === null) return match
    if (type === 'number') return formatNumber(value, locale)
    if (type === 'percent') return formatNumber(value, locale, { style: 'percent' })
    if (type === 'date' || type === 'time' || type === 'datetime') return formatDate(value, locale, type === 'date' ? 'medium' : type)
    if (autoNumber.includes(name) && typeof value === 'number') return formatNumber(value, locale)
    return String(value)
  })
}

/** Names of the {placeholders} in a message (every form of a plural entry). Used by the checks. */
export function placeholdersOf(entry) {
  const forms = typeof entry === 'string' ? [entry] : entry && typeof entry === 'object' ? Object.values(entry) : []
  const names = new Set()
  for (const form of forms) {
    for (const m of String(form).matchAll(TOKEN)) if (m[1]) names.add(m[1])
  }
  return [...names].sort()
}

// ---------------------------------------------------------------- the translator

/**
 * createI18n({ catalogs, supported?, locale?, fallback?, onMissing? })
 *   catalogs   { en: {...}, es: {...} }; en is the fallback and the source of truth.
 * Returns a small store:
 *   getSnapshot() -> { locale, dir, t, n, d, ... } (a new object per locale change, so React
 *   re-renders), subscribe(listener), setLocale(code), t(key, vars), has(key).
 */
export function createI18n({ catalogs, locale = SOURCE_LOCALE, fallback = SOURCE_LOCALE, onMissing = null } = {}) {
  const all = catalogs && typeof catalogs === 'object' ? catalogs : {}
  const supported = Object.keys(all)
  const listeners = new Set()
  const reported = new Set()
  let snapshot = null

  const build = (code) => {
    const chosen = matchLocale([code], supported) || fallback
    const primary = all[chosen] || {}
    const source = all[fallback] || {}
    const lookup = (key) => (Object.prototype.hasOwnProperty.call(primary, key) ? primary[key] : undefined)
    const lookupSource = (key) => (Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined)

    const has = (key) => lookup(key) !== undefined || lookupSource(key) !== undefined

    // t(key, vars): the message in the chosen language, else in English, else the key.
    // tOr(key, fallbackText, vars): the same, but a missing key shows `fallbackText` instead
    // (for text that comes from data, such as a tab a plug-in added).
    const resolve = (key, vars, fallbackText) => {
      let entry = lookup(key)
      let usedLocale = chosen
      if (entry === undefined) {
        entry = lookupSource(key)
        usedLocale = fallback
      }
      if (entry === undefined) {
        if (onMissing && !reported.has(key)) { reported.add(key); try { onMissing(key, chosen) } catch { /* reporting must never break the page */ } }
        return fallbackText !== undefined ? interpolate(fallbackText, vars, chosen) : key
      }
      const isPlural = typeof entry === 'object'
      const count = vars && vars.count
      const text = isPlural ? selectPlural(entry, count, usedLocale) : String(entry)
      // A message in English keeps English number formats; one in the chosen language, its own.
      return interpolate(text, vars, usedLocale === chosen ? chosen : fallback, { autoNumber: isPlural ? ['count'] : [] })
    }

    return Object.freeze({
      locale: chosen,
      dir: directionFor(chosen),
      supported,
      t: (key, vars) => resolve(key, vars),
      tOr: (key, fallbackText, vars) => resolve(key, vars, fallbackText),
      has,
      n: (value, options) => formatNumber(value, chosen, options),
      d: (value, style) => formatDate(value, chosen, style),
      rel: (amount, unit) => formatRelative(amount, unit, chosen),
      list: (items, type) => formatList(items, chosen, type),
      listParts: (items, type) => formatListParts(items, chosen, type),
      dur: (minutes) => formatDuration(minutes, chosen),
      // Locale-aware, natural-order comparison for sorting lists of titles.
      compare: (a, b) => String(a).localeCompare(String(b), chosen, { sensitivity: 'base', numeric: true })
    })
  }

  snapshot = build(locale)

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    setLocale(code) {
      const next = build(code)
      if (next.locale === snapshot.locale) return snapshot
      snapshot = next
      for (const listener of [...listeners]) listener()
      return snapshot
    },
    supported,
    get t() { return snapshot.t }
  }
}
