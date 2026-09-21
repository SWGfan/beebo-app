// profileApply.js - applies a preferences-profile render spec to the page, and the small pure helpers the
// Appearance editor and the sidebar use. No React here, so node --test covers it.
//
// The spec ({ attrs, vars }) is computed by the main process (electron/prefsRender.js) and is the same one
// the website receives; this file only writes it onto <html>. Only attributes and variables this file owns are
// ever touched, so other code's data-* attributes on <html> (the poster display ones) are left alone.

export const OWNED_ATTRS = ['data-density', 'data-card-style', 'data-poster-aspect', 'data-radius', 'data-font-scale', 'data-large-text', 'data-reduce-motion']
export const OWNED_VARS = ['--poster-aspect', '--radius-card', '--radius-control', '--radius-button', '--ui-font-scale', '--ui-motion']

const SAFE_VALUE = /^[a-z0-9./-]{1,16}$/

/** Write `spec` onto `root` (an element). Anything the spec omits is removed, so switching back to defaults clears it. */
export function applyRenderSpec(spec, root) {
  if (!root || !root.setAttribute) return
  const attrs = (spec && spec.attrs) || {}
  const vars = (spec && spec.vars) || {}
  for (const name of OWNED_ATTRS) {
    if (Object.prototype.hasOwnProperty.call(attrs, name) && SAFE_VALUE.test(String(attrs[name]))) root.setAttribute(name, String(attrs[name]))
    else root.removeAttribute(name)
  }
  for (const name of OWNED_VARS) {
    if (Object.prototype.hasOwnProperty.call(vars, name) && SAFE_VALUE.test(String(vars[name]))) root.style.setProperty(name, String(vars[name]))
    else root.style.removeProperty(name)
  }
}

/**
 * The sidebar items for this client: the profile's order and hidden list applied to the client's own items
 * ([{ id, group?, ... }]). Items the profile does not mention keep their place after the ordered ones;
 * `locked` ids (Settings) can never be hidden; group headings follow the items rather than staying put.
 */
export function orderNav(items, sidebar, lockedIds = ['settings']) {
  const order = (sidebar && Array.isArray(sidebar.order)) ? sidebar.order : []
  const hidden = new Set(((sidebar && Array.isArray(sidebar.hidden)) ? sidebar.hidden : []).filter((id) => !lockedIds.includes(id)))
  // every item carries the group heading it sits under in the client's default order
  let current = ''
  const withGroup = items.map((item) => { if (item.group) current = item.group; return { item, group: current } })
  const byId = new Map(withGroup.map((x) => [x.item.id, x]))
  const ordered = []
  const seen = new Set()
  for (const id of order) if (byId.has(id) && !seen.has(id)) { ordered.push(byId.get(id)); seen.add(id) }
  for (const x of withGroup) if (!seen.has(x.item.id)) ordered.push(x)
  const out = []
  let previous = null
  for (const x of ordered) {
    if (hidden.has(x.item.id)) continue
    const heading = x.group !== previous ? x.group : ''
    previous = x.group
    out.push(heading ? { ...x.item, group: heading } : { ...x.item, group: undefined })
  }
  return out
}

/** Move the entry at `index` by `delta` (-1 up, +1 down); returns a new array (same array if it cannot move). */
export function moveEntry(list, index, delta) {
  const to = index + delta
  if (!Array.isArray(list) || index < 0 || index >= list.length || to < 0 || to >= list.length) return list
  const next = list.slice()
  const [item] = next.splice(index, 1)
  next.splice(to, 0, item)
  return next
}

/** Move the entry at `from` so it sits at `to` (drag and drop). */
export function moveTo(list, from, to) {
  if (!Array.isArray(list) || from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list
  const next = list.slice()
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

/**
 * Reorder inside a filtered view: `full` is the whole id list, `subset` the ids currently shown (in `full`'s
 * order). Moving subset[from] to position `to` permutes only the slots the subset occupies, so ids that are
 * not shown (the other client's items) keep exactly their place.
 */
export function reorderWithin(full, subset, from, to) {
  const next = moveTo(subset, from, to)
  if (next === subset) return full
  const shown = new Set(subset)
  let i = 0
  return full.map((id) => (shown.has(id) ? next[i++] : id))
}

/** The full ordered id list (profile order, then the rest in default order) for the editor's reorderable list. */
export function fullOrder(ids, order) {
  const head = (Array.isArray(order) ? order : []).filter((id) => ids.includes(id))
  return head.concat(ids.filter((id) => !head.includes(id)))
}

/** Shelves as the editor shows them: profile rows first, then any registry shelf the profile omits (on). */
export function fullShelves(shelfIds, rows) {
  const have = new Map((Array.isArray(rows) ? rows : []).map((r) => [r.id, r]))
  const head = (Array.isArray(rows) ? rows : []).filter((r) => shelfIds.includes(r.id)).map((r) => ({ id: r.id, on: !!r.on }))
  return head.concat(shelfIds.filter((id) => !have.has(id)).map((id) => ({ id, on: true })))
}

const CACHE_KEY = 'beebo.profileSpec'

/** First-paint cache: apply what we last knew before the IPC answer arrives. */
export function readCachedSpec(storage) {
  try {
    const text = storage && storage.getItem(CACHE_KEY)
    if (!text) return null
    const spec = JSON.parse(text)
    return spec && typeof spec === 'object' ? { attrs: spec.attrs || {}, vars: spec.vars || {}, nav: spec.nav || null } : null
  } catch { return null }
}

export function writeCachedSpec(storage, value) {
  try { if (storage) storage.setItem(CACHE_KEY, JSON.stringify(value)) } catch { /* private mode or quota: the store still has it */ }
}
