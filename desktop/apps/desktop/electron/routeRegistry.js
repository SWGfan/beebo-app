'use strict'
// A small seam so new features add a module and a line here instead of editing the middle of the 17,000-line
// streamServer.js. A route module exports:
//
//   matchApi(p)              -> true when it serves this /api path (bearer-token clients)
//   handleApi(ctx)           -> { status, body }                     ctx: { p, method, url, user, store, headers, crossSite, readBody }
//   matchWeb(pathname)       -> true when it serves this cookie-session page/route
//   handleWeb(ctx)           -> true when it answered the request    ctx: { req, res, url, store, userId, currentUser, readBody, crossSite }
//
// streamServer calls dispatchApi() once, after authentication and the admin block, and dispatchWeb() once,
// after the person is known. Both return quickly (null / false) when no module claims the path.

const MODULES = ['./prefsWeb']

let loaded = null
function modules() {
  if (!loaded) loaded = MODULES.map((m) => require(m))
  return loaded
}

async function dispatchApi(ctx) {
  for (const m of modules()) {
    if (typeof m.matchApi === 'function' && m.matchApi(ctx.p)) return await m.handleApi(ctx)
  }
  return null
}

async function dispatchWeb(ctx) {
  const pathname = ctx.url.pathname
  for (const m of modules()) {
    if (typeof m.matchWeb === 'function' && m.matchWeb(pathname)) {
      if (await m.handleWeb(ctx)) return true
    }
  }
  return false
}

module.exports = { dispatchApi, dispatchWeb, MODULES }
