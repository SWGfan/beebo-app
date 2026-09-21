'use strict'

const idsLib = require('./ids')
const { CORS, sendEmpty } = require('./util')

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
function createImages({ host, mapper }) {
  function serve(c) {
    const { req, res, params, q } = c
    const id = idsLib.normalize(params.itemid)
    const type = String(params.imagetype || '').toLowerCase()
    const src = id ? mapper.imageSources(id) : null
    if (!src) return sendEmpty(res, 404)
    const index = Number(params.imageindex || 0)
    if (index !== 0) return sendEmpty(res, 404)
    if (type === 'primary') {
      if (!src.primary || !SERVER_IMAGE.test(src.primary)) return sendEmpty(res, 404)
      req.url = src.primary
      return host.dispatch(req, res)
    }
    if (type === 'backdrop') {
      if (src.backdrop && SERVER_IMAGE.test(src.backdrop)) {
        req.url = src.backdrop
        return host.dispatch(req, res)
      }
      const m = src.backdrop ? TMDB_IMAGE.exec(src.backdrop) : null
      if (!m) return sendEmpty(res, 404)
      res.writeHead(302, { ...CORS, Location: 'https://image.tmdb.org/t/p/' + tmdbSizeFor(q('maxWidth')) + '/' + m[2], 'Cache-Control': 'public, max-age=86400' })
      res.end()
      return undefined
    }
    return sendEmpty(res, 404)
  }
  return { serve }
}

module.exports = { createImages, tmdbSizeFor }
