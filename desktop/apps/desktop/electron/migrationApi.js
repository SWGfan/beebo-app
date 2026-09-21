'use strict'
/**
 * The migration importer's contract, independent of transport. The desktop app (IPC 'migration:call'
 * as the owner) and the admin API (/api/admin/migration/..., admin bearer token over TLS) both end
 * in handle(), so they cannot disagree about who may do what.
 *
 * OWNER ONLY. Importing writes other people's watched marks, ratings and lists, so every route
 * needs viewer.isAdmin; anyone else gets 403 'owner_only' before anything is read.
 *
 *   GET    sources                     -> { ok, sources: [{ id, label, blurb, modes }] }
 *   POST   connect                     { source, baseUrl, apiKey | token, insecureTls? } -> { ok, serverName, users | sections }
 *                                       checks a Jellyfin/Emby/Plex address and key; keeps nothing
 *   POST   sessions                    { source, mode, files? | grantId? | baseUrl+apiKey+userIds | baseUrl+token } -> { ok, session }
 *   GET    sessions/:id                -> { ok, session }   (poll while status is reading / matching)
 *   GET    sessions/:id/preview        ?filter=review|ambiguous|unmatched|notInLibrary|matched|decided|all &type= &q= &offset= &limit=
 *   GET    sessions/:id/search         ?q= &type=movie|show   or   ?showKey= (that show's episodes)
 *   POST   sessions/:id/configure      { userMap?, options?, decisions?: { [ref]: 'skip' | { targetKey } | null } } -> { ok, session }
 *   POST   sessions/:id/import         { dryRun? } -> { ok, report }
 *   POST   sessions/:id/discard        (or DELETE sessions/:id)
 *   GET    imports                     -> { ok, imports: [{ id, source, at, status, counts }] }
 *   POST   imports/:id/undo            -> { ok, result: { reverted, changedSince } }
 *
 * Credentials (apiKey / token) travel only in the body of 'connect' and 'sessions', are used for
 * that one request's reading and are not stored, logged or echoed back.
 *
 * deps = the importer's deps (migrationImport.createImporter) plus the importer itself:
 *   deps.importer()   -> the shared importer instance
 */

const { ImportError } = require('./migrationImport')

const ok = (body) => ({ status: 200, body: { ok: true, ...body } })
const fail = (status, error, message) => ({ status, body: { ok: false, error, ...(message ? { message } : {}) } })

function handle(req, deps) {
  return route(req, deps).catch((err) => {
    if (err instanceof ImportError) return fail(err.status || 400, err.code, err.message && err.message !== err.code ? err.message : undefined)
    // An unexpected failure must not leak internals (or a credential that was in the call).
    return fail(500, 'server_error')
  })
}

async function route(req, deps) {
  const viewer = req.viewer
  if (!viewer || !viewer.id) return fail(401, 'unauthorized')
  if (!viewer.isAdmin) return fail(403, 'owner_only')
  const importer = deps.importer()
  const method = String(req.method || 'GET').toUpperCase()
  const parts = String(req.path || '').replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
  const q = req.query && typeof req.query.get === 'function' ? req.query : new URLSearchParams()
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
  const get = (k) => q.get(k) || ''

  if (parts[0] === 'sources' && parts.length === 1 && method === 'GET') {
    // "A folder of .nfo files" needs the desktop app's own file dialog, so it is only offered there.
    const local = req.transport === 'ipc'
    return ok({ sources: importer.sources().map((src) => ({ ...src, modes: src.modes.filter((m) => local || m.id !== 'folder') })) })
  }

  if (parts[0] === 'connect' && parts.length === 1 && method === 'POST') {
    const r = await importer.probe(body)
    return ok(r)
  }

  if (parts[0] === 'sessions') {
    if (parts.length === 1 && method === 'POST') {
      // A folder can only come from a grant the app's own file dialog made.
      if (req.transport !== 'ipc' && body.mode === 'folder') return fail(400, 'unknown_mode')
      const s = importer.start(viewer, body)
      return ok({ session: importer.snapshot(s) })
    }
    const id = parts[1]
    if (!id) return fail(404, 'not_found')
    if (parts.length === 2 && method === 'GET') return ok({ session: importer.snapshot(importer.getSession(viewer, id)) })
    if (parts.length === 2 && method === 'DELETE') { importer.discard(viewer, id); return ok({}) }
    const sub = parts[2]
    const s = importer.getSession(viewer, id)
    if (sub === 'preview' && method === 'GET') return ok(importer.preview(s, { filter: get('filter'), type: get('type'), q: get('q'), offset: get('offset'), limit: get('limit') }))
    if (sub === 'search' && method === 'GET') return ok(importer.search(s, { q: get('q'), type: get('type'), showKey: get('showKey') }))
    if (sub === 'configure' && method === 'POST') return ok({ session: importer.configure(s, body) })
    if (sub === 'import' && method === 'POST') return ok({ report: importer.run(s, { dryRun: body.dryRun === true }) })
    if (sub === 'discard' && method === 'POST') { importer.discard(viewer, id); return ok({}) }
    return fail(404, 'not_found')
  }

  if (parts[0] === 'imports') {
    if (parts.length === 1 && method === 'GET') return ok({ imports: importer.listJournals() })
    if (parts.length === 3 && parts[2] === 'undo' && method === 'POST') return ok({ result: importer.undo(parts[1]) })
  }
  return fail(404, 'not_found')
}

module.exports = { handle }
