'use strict'
// Trims the public Jellyfin OpenAPI document (api.jellyfin.org, MPL-2.0 spec data: used as a TEST tool only)
// down to the operations Beebo's Jellyfin-compatible mode implements, plus the schemas they reference.
//
//   node tools/jellyfin-openapi-trim.js <full-openapi.json> test/fixtures/jellyfin-openapi-<version>.json
//
// "Implemented" = a route registered in electron/jellyfin/router.js whose (method, path) is also in the spec.
// Routes that exist only for older clients (for example /Users/{userId}/Items) are not in the newest spec and are
// simply not part of the conformance check.
const fs = require('fs')
const path = require('path')
const { createRouter } = require('../electron/jellyfin/router')

const norm = (p) => p.replace(/\{[^}]+\}/g, '{}').toLowerCase().replace(/\/$/, '')

function implementedRoutes() {
  const stub = new Proxy({}, { get: () => () => {} })
  const router = createRouter({ services: stub, ids: stub, auth: stub, catalog: stub, mapper: stub, items: stub, playback: stub, sessions: stub, images: stub, host: {}, settingEnabled: () => true, log: () => {} })
  return router.routes.map((r) => ({ method: r.method, pattern: r.pattern }))
}

function collectRefs(node, out) {
  if (Array.isArray(node)) { node.forEach((n) => collectRefs(n, out)); return }
  if (!node || typeof node !== 'object') return
  for (const [k, v] of Object.entries(node)) {
    if (k === '$ref' && typeof v === 'string') out.add(v.replace('#/components/schemas/', ''))
    else collectRefs(v, out)
  }
}

function trim(spec, routes) {
  const wanted = new Set(routes.map((r) => r.method + ' ' + norm(r.pattern)))
  const paths = {}
  for (const [p, ops] of Object.entries(spec.paths)) {
    for (const [m, op] of Object.entries(ops)) {
      const method = m.toUpperCase()
      if (!wanted.has(method + ' ' + norm(p))) continue
      paths[p] = paths[p] || {}
      // Keep only what a conformance check reads: parameters and the 2xx response bodies.
      const responses = {}
      for (const [code, r] of Object.entries(op.responses || {})) if (/^2/.test(code)) responses[code] = r
      paths[p][m] = { operationId: op.operationId, tags: op.tags, parameters: op.parameters, requestBody: op.requestBody, responses }
    }
  }
  const need = new Set()
  collectRefs(paths, need)
  const schemas = {}
  const queue = [...need]
  while (queue.length) {
    const name = queue.pop()
    if (schemas[name] || !spec.components.schemas[name]) continue
    schemas[name] = spec.components.schemas[name]
    const inner = new Set()
    collectRefs(schemas[name], inner)
    inner.forEach((n) => { if (!schemas[n]) queue.push(n) })
  }
  return {
    openapi: spec.openapi,
    info: { ...spec.info, description: 'Trimmed copy of the public Jellyfin OpenAPI document, kept only as a conformance-test fixture. Source: https://api.jellyfin.org/openapi/jellyfin-openapi-stable.json' },
    paths,
    components: { schemas }
  }
}

if (require.main === module) {
  const [inFile, outFile] = process.argv.slice(2)
  if (!inFile || !outFile) { console.error('usage: node tools/jellyfin-openapi-trim.js <full.json> <out.json>'); process.exit(2) }
  const spec = JSON.parse(fs.readFileSync(inFile, 'utf8'))
  const out = trim(spec, implementedRoutes())
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, JSON.stringify(out))
  console.log('kept ' + Object.keys(out.paths).length + ' paths, ' + Object.keys(out.components.schemas).length + ' schemas -> ' + outFile)
}

module.exports = { trim, implementedRoutes, norm }
