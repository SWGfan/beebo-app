'use strict'
// ============================================================================
// speechPack/index.js - the Speech Pack as the rest of the app sees it.
// ----------------------------------------------------------------------------
//   createSpeechPack({ store, listItems, libraries, isBusy, onBattery, ffmpegPath, ffprobePath, ... })
//     -> { queue, manager, api(name, args), adminApi(method, tail, body) }
//
// `api` is the one function the desktop's IPC handlers (electron/addonsIpc.js) call; `adminApi`
// backs the owner-only /api/admin/ai-subtitles/* routes in streamServer.js. Both go through the
// same queue methods, so there is exactly one set of rules.
// ============================================================================

const path = require('path')
const { createSubtitleQueue } = require('./jobs')
const { createMediaInfo } = require('../../mediaInfo')
const { getSharedManager } = require('../index')
const { ADDON_ID } = require('./manifest')

function createSpeechPack({
  store, manager, listItems, libraries, isBusy, onBattery, ffmpegPath, ffprobePath, log,
  ...queueOverrides
} = {}) {
  const addons = manager || getSharedManager({ log, store })

  // A file "has subtitles" when a subtitle file sits beside it (any language, AI-made ones included)
  // or it carries any subtitle stream. mediaInfo caches its answer, so a rescan is cheap.
  const mediaInfo = createMediaInfo({
    ffprobePath: () => (typeof ffprobePath === 'function' ? ffprobePath() : ffprobePath),
    getCacheDir: () => { try { return path.join(addons.dataDir(ADDON_ID), 'probe-cache') } catch { return null } }
  })
  async function hasSubtitles(videoPath) {
    const info = await mediaInfo.info(videoPath)
    if (!info.ok) return true // unreadable: do not guess, do not generate
    return (info.subtitles || []).length > 0
  }

  const queue = createSubtitleQueue({
    store, addons, listItems, libraries, hasSubtitles, isBusy, onBattery, ffmpegPath, ffprobePath, log,
    ...queueOverrides
  })

  const fnOf = {
    status: () => queue.status(),
    enqueue: (a) => queue.enqueue(a || {}),
    cancel: (a) => queue.cancel(a && a.id),
    cancelAll: () => queue.cancelAll(),
    retry: (a) => queue.retry(a && a.id),
    remove: (a) => queue.remove(a && a.id),
    clearFinished: () => queue.clearFinished(),
    search: (a) => queue.search(a && a.query),
    getSettings: () => queue.getSettings(),
    setSettings: (a) => queue.setSettings(a || {}),
    setLibrary: (a) => queue.setLibrary(a && a.dir, !!(a && a.enabled)),
    scanNow: () => queue.scanNow()
  }
  const api = async (name, args) => {
    const fn = Object.prototype.hasOwnProperty.call(fnOf, name) ? fnOf[name] : null
    if (!fn) return { ok: false, error: 'unknown_call' }
    return fn(args)
  }

  // Owner-only HTTP surface (the caller has already checked https + owner). tail: '' | '/enqueue' | '/cancel'
  async function adminApi(method, tail, body) {
    if (tail === '' && method === 'GET') return { status: 200, body: { ok: true, ...queue.status() } }
    if (method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } }
    const b = body && typeof body === 'object' ? body : {}
    if (tail === '/enqueue') {
      const r = await queue.enqueue({ kind: b.kind === 'tv' ? 'tv' : 'movie', id: String(b.id || ''), language: b.language, translate: b.translate === undefined ? undefined : b.translate === true })
      return { status: r.ok ? 200 : 400, body: r }
    }
    if (tail === '/cancel') {
      const r = queue.cancel(String(b.id || ''))
      return { status: r.ok ? 200 : 404, body: r }
    }
    return { status: 404, body: { ok: false, error: 'not_found' } }
  }

  return { queue, manager: addons, api, adminApi }
}

module.exports = { createSpeechPack, ADDON_ID }
