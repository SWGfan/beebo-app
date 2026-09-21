'use strict'

const idsLib = require('./ids')
const { CORS, sendEmpty } = require('./util')
const { tagOf } = require('./mapper')

const TMDB_IMAGE = /^https:\/\/image\.tmdb\.org\/t\/p\/(w\d{2,4}|original)\/([A-Za-z0-9_.-]+)$/
const SERVER_IMAGE = /^\/(media\/(poster|poster-tv|actor)\/[A-Za-z0-9_-]+\.jpg|media\/artwork\/[a-f0-9]{32}\.jpg|api\/music\/cover\/[A-Za-z0-9_-]+)$/

function tmdbSizeFor(maxWidth) {
  const w = Number(maxWidth) || 0
  if (!w || w > 1000) return w > 1600 ? 'original' : 'w1280'
  if (w <= 300) return 'w300'
  if (w <= 500) return 'w500'
  return 'w780'
}

// Images are anonymous in this API (an <img> tag cannot send a token). Only art that was already handed
// to a signed-in person inside one of their item lists can be asked for, and it is only ever public art:
// a Beebo cached poster or cover, or a TMDB address.
//
// Sizing: Beebo keeps posters at one size (w300) and has no resizer, so maxWidth/maxHeight/fillWidth/quality/format are accepted and
// ignored for cached art; TMDB-hosted art (backdrops, episode art) is redirected to the size that best fits maxWidth.
// Caching: when the app passes the `tag` it got in ImageTags, the answer is cacheable for a year and answers If-None-Match with 304.
function createImages({ host, mapper }) {
  const sourceFor = (src, type) => {
    if (type === 'primary') return src.primary
    if (type === 'backdrop' || type === 'thumb') return src.backdrop
    return null
  }

  function list(jid) {
    const src = mapper.imageSources(jid)
    const out = []
    if (src && src.primary) out.push({ ImageType: 'Primary', ImageTag: tagOf(src.primary) })
    if (src && src.backdrop) out.push({ ImageType: 'Backdrop', ImageIndex: 0, ImageTag: tagOf(src.backdrop) })
    return out
  }

  function serve(c) {
    const { req, res, params, q } = c
    const id = idsLib.normalize(params.itemid)
    const type = String(params.imagetype || '').toLowerCase()
    const src = id ? mapper.imageSources(id) : null
    if (!src) return sendEmpty(res, 404)
    const index = Number(params.imageindex || 0)
    if (index !== 0) return sendEmpty(res, 404)
    const want = sourceFor(src, type)
    if (!want) return sendEmpty(res, 404)
    const tag = String(q('tag') || '').trim()
    const etag = '"' + tagOf(want) + '"'
    if (tag && tag === tagOf(want) && String(req.headers['if-none-match'] || '').includes(etag)) {
      res.writeHead(304, { ...CORS, ETag: etag, 'Cache-Control': 'public, max-age=31536000, immutable' })
      res.end()
      return undefined
    }
    const cacheHeaders = tag && tag === tagOf(want) ? { ETag: etag, 'Cache-Control': 'public, max-age=31536000, immutable' } : { 'Cache-Control': 'public, max-age=3600' }
    if (SERVER_IMAGE.test(want)) {
      const real = res.writeHead
      res.writeHead = function (status, a, b) {
        const h = (typeof a === 'object' && a) || b || {}
        return real.call(res, status, status === 200 ? { ...h, ...cacheHeaders } : h)
      }
      req.url = want
      return host.dispatch(req, res)
    }
    const m = TMDB_IMAGE.exec(want)
    if (!m) return sendEmpty(res, 404)
    res.writeHead(302, { ...CORS, Location: 'https://image.tmdb.org/t/p/' + tmdbSizeFor(q('maxWidth') || q('fillWidth')) + '/' + m[2], ...cacheHeaders })
    res.end()
    return undefined
  }
  return { serve, list }
}

module.exports = { createImages, tmdbSizeFor }
