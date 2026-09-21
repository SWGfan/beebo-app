'use strict'
/**
 * The playlist HTTP contract, independent of transport. The phone API
 * (/api/playlists..., bearer token), the website (/playlists/api/..., cookie
 * session) and the desktop app (IPC, as the owner) all call handle(), so the
 * three can never disagree about validation or who may do what.
 *
 *   GET    ''                      -> { ok, playlists, templates, canShare }
 *   POST   ''                      { name, smart?, rules?, template?, shared?, add? } -> { ok, playlist }
 *   GET    'fields'                -> { ok, fields, sorts, templates }
 *   POST   'preview'               { rules, seed? } -> { ok, count, items (first 30) }
 *   GET    ':id'                   ?seed= -> { ok, playlist, items, count, skipped, progress }
 *   POST   ':id/update'            { name?, shared?, rules? } -> { ok, playlist }
 *   POST   ':id/delete'  (DELETE ':id')
 *   POST   ':id/items'             { items: [{type,id}|{type:'show',showKey}|{type:'season',showKey,season}], position? } -> { ok, added, playlist }
 *   POST   ':id/items/remove'      { entryIds } -> { ok, removed, playlist }
 *   POST   ':id/items/move'        { entryId, toIndex } | { order } -> { ok, playlist }
 *   GET    ':id/play'              ?shuffle=1&seed=&resume=1 -> { ok, items, startIndex, shuffle, seed }
 *   POST   ':id/progress'          { entryId, index, shuffle, seed } -> { ok }
 *
 * deps = {
 *   store,
 *   catalog()          -> { catalog, index }   (cached by the caller)
 *   context(viewer)    -> viewer context        (playlistCatalog.buildViewerContext)
 *   decorate(item)     -> { poster, stream }    server-relative URLs
 *   allow(viewer)      -> (item) => boolean     PARENTAL-CONTROLS SEAM: the one place
 *                                               per-viewer visibility is decided
 *   userName(userId)   -> display name
 * }
 */

const playlists = require('./playlists')
const playlistCatalog = require('./playlistCatalog')

const PREVIEW_ROWS = 30

function ok(body) {
  return { status: 200, body: { ok: true, ...body } }
}

function fail(err) {
  if (err instanceof playlists.PlaylistError) return { status: err.status || 400, body: { ok: false, error: err.code } }
  throw err
}

function seedParam(raw) {
  if (raw === null || raw === undefined || raw === '') return null
  return playlists.normalizeSeed(raw)
}

function detail(p, viewer, deps, { seed } = {}) {
  const { catalog, index } = deps.catalog()
  const ctx = deps.context(viewer)
  const allow = deps.allow ? deps.allow(viewer) : null
  const useSeed = seed || playlists.normalizeSeed(p.id + '|' + viewer.id)
  const { entries, skipped } = playlistCatalog.resolveEntries(p, { index, catalog, ctx, seed: useSeed, allow, decorate: deps.decorate })
  return {
    playlist: {
      ...playlists.summary(p, viewer, deps.userName ? deps.userName(p.ownerId) : null),
      itemCount: entries.length,
      rules: p.rules
    },
    items: entries,
    count: entries.length,
    skipped,
    seed: useSeed,
    progress: playlists.progressFor(deps.store, viewer, p.id)
  }
}

/**
 * req = { method, path, query: URLSearchParams | {get}, body, viewer: {id, isAdmin, name} }
 * Returns { status, body }.
 */
function handle(req, deps) {
  const method = String(req.method || 'GET').toUpperCase()
  const viewer = req.viewer
  if (!viewer || !viewer.id) return { status: 401, body: { ok: false, error: 'unauthorized' } }
  const q = req.query && typeof req.query.get === 'function' ? req.query : new URLSearchParams()
  const body = req.body && typeof req.body === 'object' ? req.body : {}
  const parts = String(req.path || '').split('/').filter(Boolean)
  const { store } = deps

  try {
    if (!parts.length) {
      if (method === 'GET') {
        const list = playlists.listFor(store, viewer)
        let counted = null
        const rows = list.map((p) => {
          const s = playlists.summary(p, viewer, deps.userName ? deps.userName(p.ownerId) : null)
          if (p.kind === 'smart') {
            // A smart playlist's size changes with the library; count it now.
            try {
              counted = counted || { cat: deps.catalog(), ctx: deps.context(viewer), allow: deps.allow ? deps.allow(viewer) : null }
              s.itemCount = playlists.evaluateRules(p.rules, counted.cat.catalog, counted.ctx, { allow: counted.allow }).length
            } catch {
              s.itemCount = null
            }
          }
          return s
        })
        return ok({
          playlists: rows,
          templates: playlists.TEMPLATES.map((t) => ({ id: t.id, name: t.name })),
          canShare: !!viewer.isAdmin
        })
      }
      if (method === 'POST') {
        let add = null
        if (Array.isArray(body.add) && body.add.length) add = playlistCatalog.expandAdd(body.add, deps.catalog().index)
        const p = playlists.create(store, viewer, { ...body, items: undefined })
        if (add) playlists.addItems(store, viewer, p.id, add)
        return ok(detail(playlists.get(store, viewer, p.id), viewer, deps))
      }
      return { status: 405, body: { ok: false, error: 'method_not_allowed' } }
    }

    if (parts.length === 1 && parts[0] === 'fields') {
      return ok({
        fields: playlists.FIELDS,
        sorts: playlists.SORTS,
        templates: playlists.TEMPLATES
      })
    }

    if (parts.length === 1 && parts[0] === 'preview') {
      if (method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } }
      const rules = playlists.validateRules(body.rules)
      const { catalog, index } = deps.catalog()
      const ctx = deps.context(viewer)
      const allow = deps.allow ? deps.allow(viewer) : null
      const seed = seedParam(body.seed) || 1
      const { entries } = playlistCatalog.resolveEntries({ kind: 'smart', rules }, { index, catalog, ctx, seed, allow, decorate: deps.decorate })
      return ok({ count: entries.length, items: entries.slice(0, PREVIEW_ROWS) })
    }

    // "Play next" / "Add to queue" for a show or season: its episodes as
    // playable rows, in watching order, filtered like everything else.
    if (parts.length === 1 && parts[0] === 'expand') {
      if (method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } }
      const { catalog, index } = deps.catalog()
      const refs = playlistCatalog.expandAdd(Array.isArray(body.items) ? body.items : [body], index)
      const temp = { kind: 'manual', items: refs.map((r, i) => ({ ...r, entryId: 'q_' + i, addedAt: 0 })) }
      const { entries, skipped } = playlistCatalog.resolveEntries(temp, {
        index, catalog, ctx: deps.context(viewer), allow: deps.allow ? deps.allow(viewer) : null, decorate: deps.decorate
      })
      return ok({ items: entries.filter((e) => e.available), skipped })
    }

    const id = parts[0]
    const rest = parts.slice(1).join('/')

    if (!rest) {
      if (method === 'GET') return ok(detail(playlists.get(store, viewer, id), viewer, deps, { seed: seedParam(q.get('seed')) }))
      if (method === 'DELETE') {
        playlists.remove(store, viewer, id)
        return ok({})
      }
      if (method === 'POST') {
        playlists.update(store, viewer, id, body)
        return ok(detail(playlists.get(store, viewer, id), viewer, deps))
      }
      return { status: 405, body: { ok: false, error: 'method_not_allowed' } }
    }

    if (rest === 'update' && method === 'POST') {
      playlists.update(store, viewer, id, body)
      return ok(detail(playlists.get(store, viewer, id), viewer, deps))
    }
    if (rest === 'delete' && method === 'POST') {
      playlists.remove(store, viewer, id)
      return ok({})
    }
    if (rest === 'items' && method === 'POST') {
      // Check the playlist first, so a stranger learns nothing from item errors.
      const p = playlists.get(store, viewer, id)
      if (!playlists.canEdit(p, viewer)) throw new playlists.PlaylistError('forbidden', 403)
      const items = playlistCatalog.expandAdd(Array.isArray(body.items) ? body.items : [body], deps.catalog().index)
      const out = playlists.addItems(store, viewer, id, items, { position: body.position, dedupe: body.allowDuplicates !== true })
      return ok({ added: out.added, ...detail(out.playlist, viewer, deps) })
    }
    if ((rest === 'items/remove' && method === 'POST') || (rest === 'items' && method === 'DELETE')) {
      const ids = Array.isArray(body.entryIds) ? body.entryIds : body.entryId ? [body.entryId] : q.get('entry') ? [q.get('entry')] : []
      const out = playlists.removeItems(store, viewer, id, ids)
      return ok({ removed: out.removed, ...detail(out.playlist, viewer, deps) })
    }
    if (rest === 'items/move' && method === 'POST') {
      const p = playlists.moveItems(store, viewer, id, body)
      return ok(detail(p, viewer, deps))
    }
    if (rest === 'play' && method === 'GET') {
      const p = playlists.get(store, viewer, id)
      const shuffle = q.get('shuffle') === '1' || q.get('shuffle') === 'true'
      const saved = playlists.progressFor(store, viewer, id)
      const resume = q.get('resume') === '1' || q.get('resume') === 'true'
      // Resuming a shuffled session keeps its order: same seed as last time.
      const seed = seedParam(q.get('seed')) || (resume && saved && saved.seed) || playlists.normalizeSeed(Date.now())
      const d = detail(p, viewer, deps, { seed })
      const playable = d.items.filter((e) => e.available)
      const ordered = playlists.playOrder(playable, { shuffle, seed })
      const startIndex = resume ? playlists.resumeIndex(ordered, saved) : 0
      return ok({ playlist: d.playlist, items: ordered, startIndex, shuffle, seed, skipped: d.skipped })
    }
    if (rest === 'progress' && method === 'POST') {
      const rec = playlists.recordProgress(store, viewer, id, body)
      return ok({ progress: rec })
    }
    return { status: 404, body: { ok: false, error: 'not_found' } }
  } catch (err) {
    return fail(err)
  }
}

module.exports = { handle, PREVIEW_ROWS }
