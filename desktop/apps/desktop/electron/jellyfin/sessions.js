'use strict'

const { pick, fromTicks } = require('./util')

const PLAYING_CAP = 1000

function createSessions({ host, ids, catalog, mapper, services }) {
  const playing = new Map()

  const playingKey = (userId, body) => userId + '|' + String(pick(body, 'PlaySessionId') || pick(body, 'ItemId') || '')

  const kindOf = (entry) => (entry.type === 'Episode' ? 'tv' : entry.type === 'Movie' ? 'movie' : null)

  const bodyRuntime = (body) => {
    const item = pick(body, 'Item')
    return fromTicks(pick(body, 'RunTimeTicks') || (item && pick(item, 'RunTimeTicks')) || 0)
  }

  function remember(key, rec) {
    playing.delete(key)
    playing.set(key, rec)
    if (playing.size > PLAYING_CAP) playing.delete(playing.keys().next().value)
  }

  async function ensureSession(user, entry, body, req) {
    const key = playingKey(user.id, body)
    const known = playing.get(key)
    if (known && known.jid === entry.jid) return { rec: known }
    const kind = kindOf(entry)
    const r = await host.api(user.id, 'POST', '/api/watch-session', { kind, id: entry.beeboId }, req)
    if (!r || r.status !== 200 || !r.body || !r.body.sessionId) return { error: r ? r.status : 500 }
    let duration = 0
    if (services.playback) {
      const info = await services.playback.beeboInfo(user, entry, req)
      duration = info ? info.durationSec || 0 : 0
    }
    if (!(duration > 0)) duration = bodyRuntime(body)
    const rec = { jid: entry.jid, sessionId: r.body.sessionId, duration }
    remember(key, rec)
    return { rec }
  }

  async function report(user, entry, rec, body, req) {
    const ticks = Number(pick(body, 'PositionTicks')) || 0
    if (!(rec.duration > 0)) rec.duration = bodyRuntime(body)
    const payload = { sessionId: rec.sessionId, currentTime: fromTicks(ticks), duration: rec.duration }
    if (!(payload.duration > 0)) delete payload.duration
    const r = await host.api(user.id, 'POST', '/api/progress', payload, req)
    return r
  }

  async function entryFor(user, body, req) {
    const id = pick(body, 'ItemId')
    if (!id) return null
    const entry = await catalog.resolve(user, String(id), req)
    return entry && kindOf(entry) ? entry : null
  }

  async function start(user, body, req) {
    if (!body) return { status: 400 }
    const id = pick(body, 'ItemId')
    if (!id) return { status: 400 }
    const entry = await catalog.resolve(user, String(id), req)
    if (!entry) return { status: 404 }
    if (!kindOf(entry)) return { status: 204 }
    const { rec, error } = await ensureSession(user, entry, body, req)
    if (!rec) return { status: error === 403 ? 403 : error === 404 ? 404 : 500 }
    await report(user, entry, rec, body, req)
    return { status: 204, entry }
  }

  async function progress(user, body, req) {
    const entry = await entryFor(user, body, req)
    if (!entry) return { status: pick(body, 'ItemId') ? 404 : 400 }
    const { rec, error } = await ensureSession(user, entry, body, req)
    if (!rec) return { status: error === 403 ? 403 : 500 }
    await report(user, entry, rec, body, req)
    return { status: 204, entry }
  }

  async function stopped(user, body, req) {
    const entry = await entryFor(user, body, req)
    if (!entry) return { status: pick(body, 'ItemId') ? 404 : 400 }
    const key = playingKey(user.id, body)
    const known = playing.get(key)
    const ensured = known ? { rec: known } : await ensureSession(user, entry, body, req)
    if (ensured.rec) await report(user, entry, ensured.rec, body, req)
    playing.delete(key)
    return { status: 204, entry }
  }

  async function userDataFor(user, entry) {
    return mapper.userDataFor(entry, services.state(user))
  }

  async function setPlayed(user, jid, played, req) {
    const entry = await catalog.resolve(user, jid, req)
    if (!entry) return null
    let r
    if (entry.type === 'Movie') r = await host.api(user.id, 'POST', '/api/watched/movie', { id: entry.beeboId, watched: played }, req)
    else if (entry.type === 'Episode') r = await host.api(user.id, 'POST', '/api/watched/episode', { id: entry.beeboId, watched: played }, req)
    else if (entry.type === 'Series') r = await host.api(user.id, 'POST', '/api/watched/show', { showKey: entry.showKey, watched: played }, req)
    else if (entry.type === 'Season') r = await host.api(user.id, 'POST', '/api/watched/season', { showKey: entry.showKey, season: entry.number, watched: played }, req)
    else return { entry, userData: await userDataFor(user, entry) }
    if (!r || r.status !== 200) return null
    return { entry, userData: await userDataFor(user, entry) }
  }

  async function setFavorite(user, jid, favorite, req) {
    const entry = await catalog.resolve(user, jid, req)
    if (!entry) return null
    let body
    if (entry.type === 'Movie') body = { kind: 'movie', id: entry.beeboId, favorite }
    else if (entry.type === 'Episode') body = { kind: 'tv', id: entry.beeboId, favorite }
    else if (entry.type === 'Series') body = { kind: 'tv', id: entry.showKey, favorite }
    else return { entry, userData: await userDataFor(user, entry) }
    const r = await host.api(user.id, 'POST', '/api/favorite', body, req)
    if (!r || r.status !== 200) return null
    return { entry, userData: await userDataFor(user, entry) }
  }

  return { start, progress, stopped, setPlayed, setFavorite, userDataFor, playingCount: () => playing.size }
}

module.exports = { createSessions }
