// profileStore.js - the desktop app's copy of the owner's preferences profile.
//
// The main process owns the truth (electron/prefsStore.js, over the prefsCall IPC). This module keeps the
// last answer, applies its render spec to <html> (density, card style, radius, text size, reduced motion...),
// exposes the sidebar choices to React, and caches the spec in localStorage so the very first paint already
// has the right layout instead of flashing the defaults while the IPC call is in flight (the same pattern as
// uiPrefs.js).
import { useSyncExternalStore } from 'react'
import { applyRenderSpec, readCachedSpec, writeCachedSpec } from './profileApply.js'

const NO_NAV = { order: [], hidden: [] }
let snapshot = { sidebar: NO_NAV, effective: null }
const listeners = new Set()

const storage = () => { try { return typeof window !== 'undefined' ? window.localStorage : null } catch { return null } }
const root = () => (typeof document !== 'undefined' ? document.documentElement : null)
const emit = () => listeners.forEach((fn) => fn())

function adopt(state) {
  if (!state || !state.effective) return
  const layout = state.effective.layout || {}
  snapshot = { sidebar: layout.sidebar || NO_NAV, effective: state.effective }
  applyRenderSpec(state.render, root())
  writeCachedSpec(storage(), { attrs: (state.render && state.render.attrs) || {}, vars: (state.render && state.render.vars) || {}, nav: snapshot.sidebar })
  emit()
}

/** Call once at start-up: apply the cached look now, then ask the main process. */
export function bootProfile() {
  const cached = readCachedSpec(storage())
  if (cached) {
    applyRenderSpec(cached, root())
    if (cached.nav) { snapshot = { sidebar: cached.nav, effective: null }; emit() }
  }
  refreshProfile()
}

export async function refreshProfile() {
  try {
    const api = typeof window !== 'undefined' ? window.beeboentertainment : null
    if (!api || typeof api.prefsCall !== 'function') return null
    const state = await api.prefsCall('get')
    if (state && state.ok) { adopt(state); return state }
  } catch { /* keep the cached look */ }
  return null
}

/** Called by the editor after a save or reset with the state the main process returned. */
export function adoptProfile(state) { adopt(state) }

const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn) }
const getSidebar = () => snapshot.sidebar

/** The owner's sidebar choices ({ order, hidden }), live. */
export function useSidebarPrefs() {
  return useSyncExternalStore(subscribe, getSidebar, getSidebar)
}
