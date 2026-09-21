// Cinema Mode "pre-show" for films (desktop/apps/desktop/docs/CINEMA-MODE.md). DOM-free.
//
//   GET  /api/playback/preroll?kind=movie&id=<id>   -> { enabled, items:[{ type:'local'|'youtube', role, url, title, key, titleKey }] }
//   POST /api/playback/preroll/seen { items:[{key,titleKey}] }   when an item really started, so it is not repeated
//
// A TV web view plays only the `local` items (the owner's own trailer / intro files, a plain progressive video the server
// serves from /cinema/media/<id>?mt=<token>). `youtube` items must be played in YouTube's own embedded player and are
// left out here (the server's rules forbid playing them any other way). The feature is OFF for everybody until they turn it
// on, so most of the time the answer is `enabled: false` and the film simply starts.

import { safeLine } from './escape.js'

export var PREROLL_PATH = '/api/playback/preroll'
export var SEEN_PATH = '/api/playback/preroll/seen'
export var MAX_ITEMS = 6

var LOCAL_URL = /^\/cinema\/media\/[a-f0-9]{20}\?mt=[A-Za-z0-9._~%-]+$/
var KEY_RE = /^[a-z]:[A-Za-z0-9_-]{1,80}$/

/** The reply -> the local items to play, in order. [] for anything else (no pre-show, guest, offline...). */
export function normalizePreroll(body) {
  var b = body && typeof body === 'object' ? body : null
  if (!b || b.ok !== true || b.enabled !== true || !Array.isArray(b.items)) return []
  var out = []
  for (var i = 0; i < b.items.length && out.length < MAX_ITEMS; i++) {
    var it = b.items[i]
    if (!it || typeof it !== 'object' || it.type !== 'local') continue
    if (typeof it.url !== 'string' || !LOCAL_URL.test(it.url)) continue
    out.push({
      url: it.url,
      role: it.role === 'intro' ? 'intro' : 'trailer',
      title: safeLine(it.title, 80) || (it.role === 'intro' ? 'Feature Presentation' : 'Trailer'),
      key: typeof it.key === 'string' && KEY_RE.test(it.key) ? it.key : '',
      titleKey: typeof it.titleKey === 'string' && KEY_RE.test(it.titleKey) ? it.titleKey : ''
    })
  }
  return out
}

/** The body for POST .../preroll/seen for one item that started (intro keys are never reported), or null. */
export function seenBody(item) {
  if (!item || !item.key || item.key.charAt(0) === 'i') return null
  var e = { key: item.key }
  if (item.titleKey) e.titleKey = item.titleKey
  return { items: [e] }
}
