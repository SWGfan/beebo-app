'use strict'
// ============================================================================
// metadataLocale.js - titles and descriptions in the owner's language.
// ----------------------------------------------------------------------------
// The setting "Metadata language" (default: the computer's language) and "Region" (for the
// age rating; default: the computer's region, else US) decide which TMDB translation is shown.
//
// How it stays safe:
//   - Matching a file to a film always uses the English database (titleMatch.js): the file
//     names people have are English or the original title, and switching language must never
//     change WHICH film a file is matched to.
//   - The translated text is a separate layer, <cache folder>/localized/<language>_<region>.json,
//     one small record per TMDB id. Each language has its own file, so switching languages and
//     back can neither poison nor lose anything, and English (US) uses no layer at all.
//   - A translation that is empty (or a title TMDB only has in its original language) is not
//     used: the English text stays. So does an age rating the region does not publish (US then).
//   - Requests go from the main process only and carry a TMDB id, the language and the region.
//     Missing translations are fetched in the background, a few at a time, and show up on the
//     next read; nothing waits on the network.
// ============================================================================

const path = require('path')
const { readJsonSafe, writeJsonAtomic } = require('./safeJson')

const DEFAULT_LANGUAGE = 'en-US'
const DEFAULT_REGION = 'US'
const DAY = 24 * 60 * 60 * 1000
const TTL_MS = 30 * DAY
const MISS_TTL_MS = DAY
const FLUSH_DELAY_MS = 1500
const MAX_QUEUE = 4000
const MAX_ENTRIES = 40000

/** Languages TMDB has translations for, as offered in Settings. [tag, name in that language] */
const LANGUAGES = [
  ['en-US', 'English (United States)'], ['en-GB', 'English (United Kingdom)'], ['en-CA', 'English (Canada)'], ['en-AU', 'English (Australia)'],
  ['fr-FR', 'Français (France)'], ['fr-CA', 'Français (Canada)'], ['es-ES', 'Español (España)'], ['es-MX', 'Español (México)'],
  ['de-DE', 'Deutsch'], ['it-IT', 'Italiano'], ['pt-BR', 'Português (Brasil)'], ['pt-PT', 'Português (Portugal)'],
  ['nl-NL', 'Nederlands'], ['sv-SE', 'Svenska'], ['da-DK', 'Dansk'], ['fi-FI', 'Suomi'], ['pl-PL', 'Polski'], ['cs-CZ', 'Čeština'],
  ['hu-HU', 'Magyar'], ['ro-RO', 'Română'], ['tr-TR', 'Türkçe'], ['el-GR', 'Ελληνικά'], ['ru-RU', 'Русский'], ['uk-UA', 'Українська'],
  ['he-IL', 'עברית'], ['ar-SA', 'العربية'], ['hi-IN', 'हिन्दी'], ['th-TH', 'ไทย'], ['vi-VN', 'Tiếng Việt'], ['id-ID', 'Bahasa Indonesia'],
  ['ja-JP', '日本語'], ['ko-KR', '한국어'], ['zh-CN', '简体中文'], ['zh-TW', '繁體中文']
]
const LANGUAGE_TAGS = new Set(LANGUAGES.map((l) => l[0]))
const DEFAULT_REGION_OF = { en: 'US', fr: 'FR', es: 'ES', de: 'DE', it: 'IT', pt: 'BR', nl: 'NL', sv: 'SE', da: 'DK', fi: 'FI', pl: 'PL', cs: 'CZ', hu: 'HU', ro: 'RO', tr: 'TR', el: 'GR', ru: 'RU', uk: 'UA', he: 'IL', ar: 'SA', hi: 'IN', th: 'TH', vi: 'VN', id: 'ID', ja: 'JP', ko: 'KR', zh: 'CN' }

/** 'fr', 'fr_ca', 'FR-fr' -> 'fr-FR' / 'fr-CA'. Null for anything that is not a language TMDB has. */
function normalizeLanguage(tag) {
  if (typeof tag !== 'string') return null
  const m = /^([A-Za-z]{2})(?:[-_]([A-Za-z]{2}))?(?:[.@][A-Za-z0-9_.@-]{0,30})?$/.exec(tag.trim())
  if (!m) return null
  const lang = m[1].toLowerCase()
  const region = m[2] ? m[2].toUpperCase() : DEFAULT_REGION_OF[lang]
  if (!region) return null
  const out = `${lang}-${region}`
  if (LANGUAGE_TAGS.has(out)) return out
  const base = LANGUAGES.find((l) => l[0].startsWith(`${lang}-`))
  return base ? base[0] : null
}

function normalizeRegion(value) {
  return typeof value === 'string' && /^[A-Za-z]{2}$/.test(value.trim()) ? value.trim().toUpperCase() : null
}

function regionOfTag(tag) {
  const m = typeof tag === 'string' ? /^[A-Za-z]{2}[-_]([A-Za-z]{2})\b/.exec(tag.trim()) : null
  return m ? m[1].toUpperCase() : null
}

/**
 * The setting values (empty / 'auto' = follow the computer) -> { language, region }.
 * Language falls back to English (US); region to the computer's region, then the language's, then US.
 */
function resolve(languageSetting, regionSetting, systemLocale) {
  const wantsAuto = (v) => v === undefined || v === null || v === '' || v === 'auto'
  const systemOk = normalizeLanguage(systemLocale) !== null
  const language = (wantsAuto(languageSetting) ? normalizeLanguage(systemLocale) : normalizeLanguage(languageSetting)) || DEFAULT_LANGUAGE
  const region = (wantsAuto(regionSetting) ? null : normalizeRegion(regionSetting)) || (systemOk ? regionOfTag(systemLocale) : null) || regionOfTag(language) || DEFAULT_REGION
  return { language, region }
}

function isDefault(loc) {
  return !loc || (loc.language === DEFAULT_LANGUAGE && loc.region === DEFAULT_REGION)
}

/** '' for English (US), else something safe to put in a file name. */
function tagOf(loc) {
  return isDefault(loc) ? '' : `${loc.language}_${loc.region}`
}

/** A setting value that may be stored: '' / 'auto' or a language we know. */
function validLanguageSetting(v) {
  return v === '' || v === 'auto' || (typeof v === 'string' && LANGUAGE_TAGS.has(v))
}
function validRegionSetting(v) {
  return v === '' || v === 'auto' || normalizeRegion(v) !== null
}

/** The rating a region publishes: theatrical first, then any; that region's, else the US one, else null. */
function pickCertification(results, region, { movie }) {
  const list = Array.isArray(results) ? results : []
  const forRegion = (code) => list.find((r) => r && r.iso_3166_1 === code)
  const rowOf = (entry) => {
    if (!entry) return null
    if (movie) {
      const rows = (Array.isArray(entry.release_dates) ? entry.release_dates : []).filter((rd) => rd && typeof rd.certification === 'string' && rd.certification.trim())
      const theatrical = rows.find((rd) => rd.type === 3)
      return (theatrical || rows[0] || {}).certification || null
    }
    return typeof entry.rating === 'string' && entry.rating.trim() ? entry.rating : null
  }
  return rowOf(forRegion(region)) || rowOf(forRegion(DEFAULT_REGION)) || null
}

const str = (v) => (typeof v === 'string' ? v.trim() : '')

/** TMDB's /movie/{id} or /tv/{id} answer in one language -> the few fields the layer keeps. */
function toLayerRecord(kind, data, loc, now) {
  if (!data || typeof data !== 'object') return { at: now, none: true }
  const movie = kind === 'movie'
  const title = str(movie ? data.title : data.name)
  const original = str(movie ? data.original_title : data.original_name)
  const lang2 = loc.language.slice(0, 2)
  // TMDB answers with the original-language title when there is no translation; that is not a translation.
  const untranslated = !!title && title === original && str(data.original_language) !== lang2
  const rec = { at: now }
  if (title && !untranslated) rec.title = title.slice(0, 300)
  if (str(data.overview)) rec.overview = str(data.overview).slice(0, 4000)
  if (movie && str(data.tagline)) rec.tagline = str(data.tagline).slice(0, 300)
  const cert = pickCertification(movie ? data.release_dates && data.release_dates.results : data.content_ratings && data.content_ratings.results, loc.region, { movie })
  if (cert && cert.length <= 12) rec.certification = cert
  return rec
}

function createLocalizer({ getApiKey, getLocale, createApi, now = () => Date.now(), log = () => {}, concurrency = 3, onUpdate = null } = {}) {
  const layers = new Map() // file -> { map, dirty, timer }
  const queue = []
  const queued = new Set()
  let running = 0
  let failures = 0
  let pausedUntil = 0
  const waiters = []

  const locale = () => { try { return getLocale ? getLocale() : { language: DEFAULT_LANGUAGE, region: DEFAULT_REGION } } catch { return { language: DEFAULT_LANGUAGE, region: DEFAULT_REGION } } }

  function layerFile(cacheDir, loc) {
    return path.join(cacheDir, 'localized', `${tagOf(loc)}.json`)
  }
  function layerFor(cacheDir, loc) {
    const file = layerFile(cacheDir, loc)
    let layer = layers.get(file)
    if (!layer) {
      if (layers.size > 6) layers.delete(layers.keys().next().value)
      const raw = readJsonSafe(file, {}).data
      const map = new Map()
      const records = raw && typeof raw === 'object' && raw.records && typeof raw.records === 'object' ? Object.entries(raw.records) : []
      for (const [key, rec] of records) if (/^(movie|tv):\d{1,9}$/.test(key) && rec && typeof rec === 'object' && map.size < MAX_ENTRIES) map.set(key, rec)
      layer = { file, map, dirty: false, timer: null }
      layers.set(file, layer)
    }
    return layer
  }
  function scheduleFlush(layer) {
    layer.dirty = true
    if (layer.timer) return
    layer.timer = setTimeout(() => flushLayer(layer), FLUSH_DELAY_MS)
    if (layer.timer.unref) layer.timer.unref()
  }
  function flushLayer(layer) {
    if (layer.timer) { clearTimeout(layer.timer); layer.timer = null }
    if (!layer.dirty) return
    layer.dirty = false
    try { writeJsonAtomic(layer.file, { v: 1, records: Object.fromEntries(layer.map) }, { indent: 0, backupEveryMs: 60000 }) } catch (err) { log(`[locale] could not save ${path.basename(layer.file)}: ${err && err.code}`) }
  }

  const idle = () => !running && (!queue.length || now() < pausedUntil)
  function settle() {
    if (!idle()) return
    while (waiters.length) waiters.shift()()
  }

  async function fetchOne(job) {
    const key = getApiKey ? getApiKey() : ''
    const api = key && createApi ? createApi(key) : null
    if (!api) return
    const { kind, id, cacheDir, loc } = job
    const append = kind === 'movie' ? 'release_dates' : 'content_ratings'
    const res = await api.get(`/${kind}/${id}`, { language: loc.language, include_adult: 'false', append_to_response: append })
    const layer = layerFor(cacheDir, loc)
    if (res && res.ok) {
      failures = 0
      layer.map.set(`${kind}:${id}`, toLayerRecord(kind, res.data, loc, now()))
      scheduleFlush(layer)
      if (onUpdate) { try { onUpdate({ kind, id }) } catch { /* listeners must not break the queue */ } }
    } else if (res && res.status === 404) {
      layer.map.set(`${kind}:${id}`, { at: now(), none: true })
      scheduleFlush(layer)
    } else if (++failures >= 5) {
      pausedUntil = now() + 5 * 60 * 1000
      failures = 0
    }
  }

  function pump() {
    while (running < concurrency && queue.length && now() >= pausedUntil) {
      const job = queue.shift()
      queued.delete(job.token)
      running++
      fetchOne(job).catch(() => {}).finally(() => { running--; pump(); settle() })
    }
    settle()
  }

  function needs(rec) {
    if (!rec) return true
    return now() - rec.at > (rec.none ? MISS_TTL_MS : TTL_MS)
  }

  function ensure(cacheDir, kind, id, loc = locale()) {
    if (isDefault(loc) || !cacheDir || !Number.isSafeInteger(id) || id <= 0) return false
    const rec = layerFor(cacheDir, loc).map.get(`${kind}:${id}`)
    if (!needs(rec)) return false
    const token = `${layerFile(cacheDir, loc)}|${kind}:${id}`
    if (queued.has(token) || queue.length >= MAX_QUEUE) return false
    queued.add(token)
    queue.push({ kind, id, cacheDir, loc, token })
    pump()
    return true
  }

  /**
   * The entry with the translation laid over it (title/name, overview, tagline, certification);
   * the same object when the language is English (US) or nothing is known yet. Missing
   * translations are queued and appear on a later read.
   */
  function apply(kind, entry, cacheDir) {
    const loc = locale()
    if (isDefault(loc) || !entry || !cacheDir || !Number.isSafeInteger(entry.id) || entry.id <= 0) return entry
    const rec = layerFor(cacheDir, loc).map.get(`${kind}:${entry.id}`)
    if (needs(rec)) ensure(cacheDir, kind, entry.id, loc)
    if (!rec || rec.none) return entry
    const out = { ...entry }
    let changed = false
    const titleKey = kind === 'movie' ? 'title' : 'name'
    for (const [from, to] of [['title', titleKey], ['overview', 'overview'], ['tagline', 'tagline'], ['certification', 'certification']]) {
      if (rec[from] && out[to] !== rec[from]) { out[to] = rec[from]; changed = true }
    }
    if (!changed) return entry
    out.localized = loc.language
    return out
  }

  /** Fetches the translation of every listed title; resolves when the queue has drained. Progress: (done, total). */
  function localizeAll(cacheDir, items, onProgress) {
    const loc = locale()
    const list = (items || []).filter((it) => it && (it.kind === 'movie' || it.kind === 'tv') && Number.isSafeInteger(it.id) && it.id > 0)
    const total = list.length
    let started = 0
    for (const it of list) if (ensure(cacheDir, it.kind, it.id, loc)) started++
    if (onProgress) onProgress(total - started, total)
    return new Promise((resolve) => {
      const tick = setInterval(() => {
        const left = list.filter((it) => queued.has(`${layerFile(cacheDir, loc)}|${it.kind}:${it.id}`)).length + running
        if (onProgress) onProgress(Math.max(0, total - left), total)
        if (!left || now() < pausedUntil) { clearInterval(tick); flush(); resolve({ total, remaining: left }) }
      }, 500)
      if (tick.unref) tick.unref()
    })
  }

  function flush() {
    for (const layer of layers.values()) flushLayer(layer)
  }

  return { apply, ensure, localizeAll, flush, locale, whenIdle: () => new Promise((resolve) => (idle() ? resolve() : waiters.push(resolve))) }
}

module.exports = {
  LANGUAGES,
  DEFAULT_LANGUAGE,
  DEFAULT_REGION,
  normalizeLanguage,
  normalizeRegion,
  resolve,
  isDefault,
  tagOf,
  validLanguageSetting,
  validRegionSetting,
  pickCertification,
  toLayerRecord,
  createLocalizer
}
