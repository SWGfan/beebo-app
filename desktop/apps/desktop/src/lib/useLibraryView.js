// useLibraryView.js - React binding for one library screen's view settings ('movies' | 'tv'): the chosen
// view, grouping, sort, filters and the person's saved views, all remembered per person by
// libraryViewStore.js. The pure rules are in libraryViews.js.
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { getLibraryViewStore } from './libraryViewStore.js'
import {
  applySavedView,
  deleteSavedView,
  importPreset,
  isViewModified,
  parsePreset,
  patchCurrent,
  renameSavedView,
  resetFilters,
  saveCurrentAsView,
  serializePreset,
  updateActiveView
} from './libraryViews.js'

const subscribe = (cb) => getLibraryViewStore().subscribe(cb)
const snapshot = () => getLibraryViewStore().get()

export function useLibraryView(kind) {
  const state = useSyncExternalStore(subscribe, snapshot, snapshot)
  const block = state[kind]
  const dispatch = (fn) => getLibraryViewStore().dispatch(fn)

  const patch = useCallback((p) => dispatch((s) => patchCurrent(s, kind, p)), [kind])
  const setMode = useCallback((mode) => patch({ mode }), [patch])
  const setFilters = useCallback((filters) => patch({ filters }), [patch])
  const clearFilters = useCallback(() => dispatch((s) => resetFilters(s, kind)), [kind])
  const saveAs = useCallback((name) => dispatch((s) => saveCurrentAsView(s, kind, name)), [kind])
  const updateView = useCallback(() => dispatch((s) => updateActiveView(s, kind)), [kind])
  const applyView = useCallback((id) => dispatch((s) => applySavedView(s, kind, id)), [kind])
  const renameView = useCallback((id, name) => dispatch((s) => renameSavedView(s, kind, id, name)), [kind])
  const deleteView = useCallback((id) => dispatch((s) => deleteSavedView(s, kind, id)), [kind])
  // -> { ok: true } or { ok: false, error }
  const importText = useCallback((text) => {
    const parsed = parsePreset(text, kind)
    if (!parsed.ok) return parsed
    dispatch((s) => importPreset(s, kind, parsed.view))
    return { ok: true, name: parsed.view.name }
  }, [kind])
  const exportText = useCallback((id) => {
    const v = getLibraryViewStore().get()[kind].saved.find((x) => x.id === id)
    return v ? serializePreset(v, kind) : ''
  }, [kind])

  return useMemo(
    () => ({
      kind,
      mode: block.mode,
      groupBy: block.groupBy,
      sort: block.sort,
      filters: block.filters,
      saved: block.saved,
      active: block.active,
      modified: isViewModified(block, kind),
      patch,
      setMode,
      setGroupBy: (groupBy) => patch({ groupBy }),
      setSort: (sort) => patch({ sort }),
      setFilters,
      clearFilters,
      saveAs,
      updateView,
      applyView,
      renameView,
      deleteView,
      importText,
      exportText
    }),
    [kind, block, patch, setMode, setFilters, clearFilters, saveAs, updateView, applyView, renameView, deleteView, importText, exportText]
  )
}
