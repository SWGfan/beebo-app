// libraryViewStore.js - one shared, persisted copy of the person's library-view state (which view each
// screen uses, filters, saved views). The Movies and TV Shows screens both read and write it, so it is
// a single store rather than per-screen React state: two screens saving their own copy would overwrite
// each other's half. Storage and IPC are injected so node --test covers it (test/library-views.test.js).
//
// The main process is the source of truth (electron/uiPrefs.js, per person). localStorage is only a
// synchronous copy so the very first paint already has the right view instead of flashing "Posters".

import { emptyUserViews, normalizeUserViews } from './libraryViews.js'

const CACHE_KEY = 'beebo.libraryViews'
const SAVE_DELAY_MS = 350

export function createLibraryViewStore({
  api = null, // { getViews(): Promise<{ userId, views }>, setViews(views): Promise<any> }
  storage = null,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  migrate = null // async (state) => state | null, run once after the first load, e.g. to carry over the old Posters/Table choice
} = {}) {
  let state = null
  let loaded = false
  let loading = null
  let userId = null
  let saveTimer = null
  let dirty = false
  const listeners = new Set()

  const readCache = () => {
    try {
      const text = storage && storage.getItem(CACHE_KEY)
      return text ? normalizeUserViews(JSON.parse(text)) : null
    } catch { return null }
  }
  const writeCache = () => {
    try { if (storage) storage.setItem(CACHE_KEY, JSON.stringify(state)) } catch { /* private mode or quota: the store still has it */ }
  }
  const emit = () => { for (const l of [...listeners]) l() }

  const flush = async () => {
    if (saveTimer !== null) { clearTimer(saveTimer); saveTimer = null }
    if (!dirty || !api || typeof api.setViews !== 'function') return
    dirty = false
    try { await api.setViews(state) } catch { dirty = true /* the cache keeps it; the next change retries */ }
  }

  return {
    /** The current state (synchronous; the cached copy until load() finishes). */
    get() {
      if (!state) state = readCache() || emptyUserViews()
      return state
    },
    loaded: () => loaded,
    userId: () => userId,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /** Read the stored state once (later calls return the same promise). Never rejects. */
    load() {
      if (loading) return loading
      loading = (async () => {
        this.get()
        if (api && typeof api.getViews === 'function') {
          try {
            const res = await api.getViews()
            if (res && res.views && typeof res.views === 'object') {
              userId = res.userId || null
              const stored = normalizeUserViews(res.views)
              const hasAny = Object.keys(res.views).length > 0
              // Local changes made before the answer came back win over nothing, but a real stored value wins over the cache.
              if (!dirty) state = hasAny ? stored : state
              if (!hasAny && migrate) {
                try {
                  const migrated = await migrate(state)
                  if (migrated) { state = normalizeUserViews(migrated); dirty = true }
                } catch { /* keep the defaults */ }
              }
              writeCache()
            }
          } catch { /* keep the cached copy */ }
        }
        loaded = true
        emit()
        if (dirty) await flush()
        return state
      })()
      return loading
    },
    /** Change the state: `update` gets the current per-person state and returns the next one. Saved shortly after. */
    dispatch(update) {
      const next = normalizeUserViews(update(this.get()))
      if (JSON.stringify(next) === JSON.stringify(state)) return state
      state = next
      writeCache()
      dirty = true
      if (saveTimer === null) saveTimer = setTimer(() => { saveTimer = null; flush() }, SAVE_DELAY_MS)
      emit()
      return state
    },
    flush
  }
}

let shared = null
/** One store for the app, wired to the real localStorage and preload bridge. */
export function getLibraryViewStore() {
  if (!shared) {
    let storage = null
    try { storage = typeof window !== 'undefined' ? window.localStorage : null } catch { storage = null }
    const bridge = typeof window !== 'undefined' && window.beeboentertainment ? window.beeboentertainment.libraryTable : null
    shared = createLibraryViewStore({
      storage,
      api: bridge && bridge.getViews ? { getViews: () => bridge.getViews(), setViews: (v) => bridge.setViews(v) } : null,
      // The Posters | Table choice used to live with the table's own settings. A person who chose Table
      // keeps it after the upgrade: it is carried over once, when no library view has ever been saved.
      migrate: async (state) => {
        if (!bridge || typeof bridge.getPrefs !== 'function') return null
        const old = await bridge.getPrefs()
        const next = { ...state }
        let changed = false
        for (const kind of ['movies', 'tv']) {
          if (old && old[kind] && old[kind].mode === 'table') { next[kind] = { ...state[kind], mode: 'table' }; changed = true }
        }
        return changed ? next : null
      }
    })
    if (typeof window !== 'undefined') {
      shared.load()
      window.addEventListener('beforeunload', () => { shared.flush() })
    }
  }
  return shared
}
