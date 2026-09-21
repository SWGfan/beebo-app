// i18nApp.js - connects the pure translator (i18n.js) to this app: the person's saved language
// choice, the operating system's language for "Automatic", the <html lang/dir> attributes and
// React. One shared instance; components use useI18n(), other code uses t().
//
// The choice is stored in localStorage (synchronously readable, so the very first paint is
// already in the right language). "Automatic" follows the system: the renderer's own
// navigator.languages, plus the real Windows list from the main process when it can give one,
// because a packaged Electron build reports only the one language it ships resources for.
import { useSyncExternalStore } from 'react'
import { createI18n, resolveLocale, directionFor, SOURCE_LOCALE } from './i18n.js'
import { CATALOGS } from '../locales/index.js'

export const LANGUAGE_KEY = 'beebo.language'
const SYSTEM_KEY = 'beebo.language.system'

const storage = () => { try { return typeof window !== 'undefined' ? window.localStorage : null } catch { return null } }
const read = (key) => { try { const s = storage(); return s ? s.getItem(key) : null } catch { return null } }
const write = (key, value) => { try { const s = storage(); if (s) s.setItem(key, value) } catch { /* private mode: the choice lasts until restart */ } }

let systemLanguages = null
function currentSystemLanguages() {
  if (systemLanguages) return systemLanguages
  let list = []
  try { list = JSON.parse(read(SYSTEM_KEY) || '[]') } catch { list = [] }
  if (!Array.isArray(list)) list = []
  const nav = typeof navigator !== 'undefined' ? [...(navigator.languages || []), navigator.language].filter(Boolean) : []
  systemLanguages = [...list, ...nav]
  return systemLanguages
}

export function getLanguagePreference() {
  const stored = read(LANGUAGE_KEY)
  return stored && stored.trim() ? stored.trim() : 'auto'
}

const supported = Object.keys(CATALOGS)
const resolveNow = () => resolveLocale({ preference: getLanguagePreference(), systemLanguages: currentSystemLanguages(), supported })

const dev = (() => { try { return !!(import.meta.env && import.meta.env.DEV) } catch { return false } })()
const i18n = createI18n({
  catalogs: CATALOGS,
  locale: resolveNow().code,
  onMissing: dev ? (key, locale) => console.warn(`[i18n] missing key "${key}" (${locale})`) : null
})

function paintDocument(snapshot) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.lang = snapshot.locale
  root.dir = directionFor(snapshot.locale)
}

function apply() {
  const before = i18n.getSnapshot().locale
  const snapshot = i18n.setLocale(resolveNow().code)
  paintDocument(snapshot)
  return snapshot.locale !== before
}

export const subscribeI18n = i18n.subscribe
export const getI18n = () => i18n.getSnapshot()
/** The current language's translator, for code that is not a React component. */
export const t = (key, vars) => i18n.getSnapshot().t(key, vars)

export function useI18n() {
  return useSyncExternalStore(i18n.subscribe, i18n.getSnapshot, i18n.getSnapshot)
}

/** 'auto' or a locale code. Applies at once and is remembered. */
export function setLanguagePreference(preference) {
  write(LANGUAGE_KEY, preference && preference !== '' ? preference : 'auto')
  apply()
  return i18n.getSnapshot().locale
}

/** Language shown for 'Automatic' right now (so Settings can say "Automatic (Français)"). */
export function systemLocale() {
  return resolveLocale({ preference: 'auto', systemLanguages: currentSystemLanguages(), supported }).code
}

let booted = false
/** Once, before the first render: paints lang/dir, then asks Windows for its real language list. */
export function bootI18n() {
  if (booted) return
  booted = true
  paintDocument(i18n.getSnapshot())
  const bridge = typeof window !== 'undefined' ? window.beeboentertainment : null
  if (bridge && typeof bridge.systemLanguages === 'function') {
    Promise.resolve(bridge.systemLanguages()).then((list) => {
      if (!Array.isArray(list) || !list.length) return
      write(SYSTEM_KEY, JSON.stringify(list))
      systemLanguages = [...list, ...(typeof navigator !== 'undefined' ? navigator.languages || [] : [])]
      apply()
    }).catch(() => { /* navigator.languages stays the answer */ })
  }
}

export { SOURCE_LOCALE }
