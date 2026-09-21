// uiPrefs.js - the look-and-feel choices that survive a restart: the sidebar mode,
// the poster size and the two poster display toggles. The source of truth is the main
// process's electron-store (electron/uiPrefs.js, over IPC); localStorage is only a
// synchronous copy so the very first paint already has the right layout instead of
// flashing the defaults while the IPC round trip is in flight. Storage and IPC are
// injected so node --test covers it.
import { normalizeSidebarMode } from './sidebarMode.js'
import { POSTER_DEFAULT, clampPosterSize } from './posterZoom.js'

const CACHE_KEY = 'beebo.uiPrefs'

export function normalizeUiPrefs(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  return {
    sidebarMode: normalizeSidebarMode(source.sidebarMode),
    posterSize: source.posterSize === undefined ? POSTER_DEFAULT : clampPosterSize(source.posterSize),
    showPosterIcons: source.showPosterIcons !== false,
    showPosterTitles: source.showPosterTitles !== false
  }
}

export function createUiPrefs({ storage = null, api = null } = {}) {
  let current = null

  const readCache = () => {
    try {
      const text = storage && storage.getItem(CACHE_KEY)
      return text ? normalizeUiPrefs(JSON.parse(text)) : null
    } catch { return null }
  }
  const writeCache = (prefs) => {
    try { if (storage) storage.setItem(CACHE_KEY, JSON.stringify(prefs)) } catch { /* private mode or quota: the store still has it */ }
  }

  return {
    // Synchronous, for the first render.
    cached() {
      if (!current) current = readCache() || normalizeUiPrefs(null)
      return current
    },
    // The stored values; falls back to the cache when there is no IPC (plain browser, tests).
    async load() {
      const base = this.cached()
      if (!api || typeof api.uiPrefsGet !== 'function') return base
      try {
        const stored = await api.uiPrefsGet()
        if (stored && typeof stored === 'object') {
          current = normalizeUiPrefs({ ...base, ...stored })
          writeCache(current)
        }
      } catch { /* keep the cached values */ }
      return current
    },
    async save(partial) {
      current = normalizeUiPrefs({ ...this.cached(), ...partial })
      writeCache(current)
      if (!api || typeof api.uiPrefsSet !== 'function') return current
      try { await api.uiPrefsSet(partial) } catch { /* the cache keeps it until the next successful save */ }
      return current
    }
  }
}

let shared = null
// One instance for the app, wired to the real localStorage and preload bridge.
export function getUiPrefs() {
  if (!shared) {
    let storage = null
    try { storage = typeof window !== 'undefined' ? window.localStorage : null } catch { storage = null }
    shared = createUiPrefs({ storage, api: typeof window !== 'undefined' ? window.beeboentertainment : null })
  }
  return shared
}
