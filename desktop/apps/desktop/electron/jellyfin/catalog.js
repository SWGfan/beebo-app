'use strict'

const { VIEW_NUMBER } = require('./constants')
const idsLib = require('./ids')

const SNAPSHOT_TTL_MS = 30 * 1000
const EPISODES_TTL_MS = 60 * 1000
const MUSIC_TTL_MS = 60 * 1000
const PLAYLISTS_TTL_MS = 5 * 1000
const REGISTRY_CAP = 40000
const USER_CACHE_CAP = 50

function lru(cap) {
  const m = new Map()
  return {
    get(k) {
      if (!m.has(k)) return undefined
      const v = m.get(k)
      m.delete(k)
      m.set(k, v)
      return v
    },
    set(k, v) {
      m.delete(k)
      m.set(k, v)
      if (m.size > cap) m.delete(m.keys().next().value)
    },
    delete(k) { m.delete(k) },
    get size() { return m.size }
  }
}

// Builds one signed-in person's view of the library out of Beebo's OWN api answers, fetched in-process
// as that person. Whatever Beebo's parental gate hides from them never gets an entry here.
// A stable number for a music genre name (music genres have no TMDB id): 2^31 + crc32, so it can never meet a TMDB genre id.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 }
  return t
})()
function musicGenreNumber(name) {
  let c = 0xffffffff
  const buf = Buffer.from(String(name || '').trim().toLowerCase(), 'utf8')
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return 2147483648 + ((c ^ 0xffffffff) >>> 0)
}

function createCatalog({ host, ids, firstSeen, now = Date.now }) {
  const userCaches = lru(USER_CACHE_CAP)
  const noteSeen = (entries) => { try { if (firstSeen) firstSeen.note(entries) } catch {} }

  const viewId = (name) => ids.encode('view', VIEW_NUMBER[name])

  function cacheFor(userId) {
    let c = userCaches.get(userId)
    if (!c) {
      c = { snapshot: null, snapshotAt: 0, building: null, episodes: new Map(), registry: lru(REGISTRY_CAP), music: null, musicAt: 0, musicBuilding: null, allEpisodesAt: 0, allEpisodesBuilding: null }
      userCaches.set(userId, c)
    }
    return c
  }

  const okBody = (r) => (r && r.status === 200 && r.body && r.body.ok !== false ? r.body : null)

  function genreMap(...lists) {
    const out = new Map()
    for (const list of lists) for (const g of (list || [])) if (g && g.id != null && g.name) out.set(Number(g.id), String(g.name))
    return out
  }

  function movieEntry(m, genreNames) {
    return {
      type: 'Movie',
      kind: 'movie',
      jid: ids.encode('movie', m.id),
      beeboId: m.id,
      title: m.title || 'Untitled',
      year: m.year || null,
      overview: m.overview || null,
      rating: typeof m.voteAverage === 'number' ? m.voteAverage : null,
      genreIds: Array.isArray(m.genres) ? m.genres.map(Number).filter(Number.isFinite) : [],
      genres: (Array.isArray(m.genres) ? m.genres : []).map((g) => genreNames.get(Number(g))).filter(Boolean),
      tmdbId: m.tmdbId != null ? m.tmdbId : null,
      poster: m.poster || null,
      backdrop: m.backdrop || null,
      stream: m.stream || null,
      isNew: !!m.isNew,
      collectionId: m.collectionId != null ? m.collectionId : null,
      collectionName: m.collectionName || null
    }
  }

  function seriesEntry(s, genreNames) {
    return {
      type: 'Series',
      kind: 'tv',
      jid: ids.encode('series', s.key),
      showKey: s.key,
      beeboId: s.key,
      title: s.name || 'Untitled',
      year: s.year || null,
      overview: null,
      rating: typeof s.voteAverage === 'number' ? s.voteAverage : null,
      genreIds: Array.isArray(s.genres) ? s.genres.map(Number).filter(Number.isFinite) : [],
      genres: (Array.isArray(s.genres) ? s.genres : []).map((g) => genreNames.get(Number(g))).filter(Boolean),
      tmdbId: s.tmdbId != null ? s.tmdbId : null,
      poster: s.poster || null,
      backdrop: s.backdrop || null,
      episodeCount: s.episodeCount || 0,
      isNew: !!s.isNew
    }
  }

  async function buildSnapshot(user, realReq) {
    const [moviesR, showsR, byNewR] = await Promise.all([
      host.api(user.id, 'GET', '/api/movies', undefined, realReq),
      host.api(user.id, 'GET', '/api/tvshows', undefined, realReq),
      host.api(user.id, 'GET', '/api/movies?sort=new', undefined, realReq)
    ])
    const movies = okBody(moviesR) || { items: [], genres: [] }
    const shows = okBody(showsR) || { items: [], genres: [] }
    const byNew = okBody(byNewR) || { items: [] }
    const genreNames = genreMap(movies.genres, shows.genres)
    const movieEntries = movies.items.map((m) => movieEntry(m, genreNames))
    const seriesEntries = shows.items.map((s) => seriesEntry(s, genreNames))
    const rank = new Map(byNew.items.map((m, i) => [m.id, i]))
    movieEntries.forEach((e) => { e.addedRank = rank.has(e.beeboId) ? rank.get(e.beeboId) : 1e9 })

    const groups = new Map()
    for (const e of movieEntries) {
      if (e.collectionId == null) continue
      if (!groups.has(e.collectionId)) groups.set(e.collectionId, { name: e.collectionName, movies: [] })
      groups.get(e.collectionId).movies.push(e)
    }
    const boxsets = [...groups.entries()].map(([cid, g]) => {
      const sorted = g.movies.slice().sort((a, b) => (a.year || 0) - (b.year || 0))
      return {
        type: 'BoxSet',
        kind: 'movie',
        jid: ids.encode('boxset', cid),
        collectionId: cid,
        title: String(g.name || 'Collection').replace(/\s+Collection$/i, ''),
        year: sorted[0] ? sorted[0].year : null,
        poster: sorted[0] ? sorted[0].poster : null,
        backdrop: sorted[0] ? sorted[0].backdrop : null,
        genres: [],
        genreIds: [],
        overview: null,
        rating: null,
        memberJids: sorted.map((e) => e.jid),
        addedRank: Math.min(...sorted.map((e) => e.addedRank))
      }
    })

    const genres = [...genreNames.entries()].map(([id, name]) => ({ id, name, jid: ids.encode('genre', id) }))
    const byId = new Map()
    for (const e of [...movieEntries, ...seriesEntries, ...boxsets]) byId.set(e.jid, e)
    noteSeen([...movieEntries.slice().sort((a, b) => a.addedRank - b.addedRank).map((e, i) => ({ jid: e.jid, rank: e.addedRank < 1e9 ? e.addedRank : movieEntries.length + i })), ...seriesEntries.map((e) => ({ jid: e.jid })), ...boxsets.map((e) => ({ jid: e.jid, rank: e.addedRank }))])
    return { at: now(), movies: movieEntries, shows: seriesEntries, boxsets, genres, byId }
  }

  async function getSnapshot(user, realReq) {
    const c = cacheFor(user.id)
    if (c.snapshot && now() - c.snapshotAt < SNAPSHOT_TTL_MS) return c.snapshot
    if (!c.building) {
      c.building = buildSnapshot(user, realReq).then((s) => {
        c.snapshot = s
        c.snapshotAt = now()
        for (const e of s.byId.values()) c.registry.set(e.jid, e)
        return s
      }).finally(() => { c.building = null })
    }
    return c.building
  }

  function seasonJid(showKey, season) {
    return ids.encode('season', showKey + ':' + (season === null || season === undefined ? 'x' : season))
  }

  async function getEpisodes(user, series, realReq) {
    const c = cacheFor(user.id)
    const hit = c.episodes.get(series.showKey)
    if (hit && now() - hit.at < EPISODES_TTL_MS) return hit.value
    const r = await host.api(user.id, 'GET', '/api/tvshows/' + encodeURIComponent(series.showKey) + '/episodes', undefined, realReq)
    const body = okBody(r)
    const seasons = []
    const episodes = []
    if (body) {
      const overview = body.show && body.show.overview
      if (overview && !series.overview) series.overview = overview
      for (const s of body.seasons || []) {
        const number = s.season === null || s.season === undefined ? null : Number(s.season)
        const sj = seasonJid(series.showKey, number)
        const season = {
          type: 'Season', kind: 'tv', jid: sj, showKey: series.showKey, seriesJid: series.jid, seriesTitle: series.title,
          number, title: number === null ? 'Unsorted' : number === 0 ? 'Specials' : 'Season ' + number,
          poster: series.poster, backdrop: series.backdrop, genres: series.genres, genreIds: series.genreIds, year: series.year,
          episodeCount: (s.episodes || []).length, overview: null, rating: null
        }
        seasons.push(season)
        for (const ep of s.episodes || []) {
          episodes.push({
            type: 'Episode', kind: 'tv', jid: ids.encode('episode', ep.id), beeboId: ep.id, showKey: series.showKey,
            seriesJid: series.jid, seriesTitle: series.title, seasonJid: sj, seasonNumber: number, number: ep.episode == null ? null : Number(ep.episode),
            title: ep.episodeName || (ep.episode != null ? 'Episode ' + ep.episode : 'Episode'), stream: ep.stream || null,
            poster: series.poster, backdrop: series.backdrop, genres: series.genres, genreIds: series.genreIds, year: series.year,
            overview: null, rating: series.rating, watchedHint: !!ep.watched, watchedPercent: ep.watchedPercent || 0
          })
        }
      }
    }
    const value = { seasons, episodes }
    noteSeen([...seasons, ...episodes].map((e) => ({ jid: e.jid })))
    c.episodes.set(series.showKey, { at: now(), value })
    for (const e of [...seasons, ...episodes]) c.registry.set(e.jid, e)
    return value
  }

  async function getAllEpisodes(user, realReq) {
    const c = cacheFor(user.id)
    if (c.allEpisodes && now() - c.allEpisodesAt < EPISODES_TTL_MS) return c.allEpisodes
    if (!c.allEpisodesBuilding) {
      c.allEpisodesBuilding = (async () => {
        const snap = await getSnapshot(user, realReq)
        const out = { seasons: [], episodes: [] }
        let i = 0
        const worker = async () => {
          while (i < snap.shows.length) {
            const s = snap.shows[i++]
            const r = await getEpisodes(user, s, realReq)
            out.seasons.push(...r.seasons)
            out.episodes.push(...r.episodes)
          }
        }
        await Promise.all([worker(), worker(), worker(), worker()])
        c.allEpisodes = out
        c.allEpisodesAt = now()
        return out
      })().finally(() => { c.allEpisodesBuilding = null })
    }
    return c.allEpisodesBuilding
  }

  // An episode-shaped entry for a Beebo episode id, without loading every show: the show comes from
  // /api/episode-context, which Beebo's gate refuses for a title this person may not see.
  async function episodeByBeeboId(user, beeboId, realReq) {
    const jid = ids.encode('episode', beeboId)
    const c = cacheFor(user.id)
    const known = c.registry.get(jid)
    if (known) return known
    const r = await host.api(user.id, 'GET', '/api/episode-context?kind=tv&id=' + encodeURIComponent(beeboId), undefined, realReq)
    const ctx = okBody(r)
    if (!ctx || !ctx.showKey) return null
    const snap = await getSnapshot(user, realReq)
    const series = snap.byId.get(ids.encode('series', ctx.showKey))
    if (!series) return null
    const eps = await getEpisodes(user, series, realReq)
    return eps.episodes.find((e) => e.beeboId === beeboId) || null
  }

  async function resolve(user, jid, realReq) {
    const kind = idsLib.kindOf(jid)
    const normalized = idsLib.normalize(jid)
    if (!kind || !normalized) return null
    const c = cacheFor(user.id)
    const snap = await getSnapshot(user, realReq)
    const direct = snap.byId.get(normalized)
    if (direct) return direct
    if (kind === 'season' || kind === 'episode') {
      const known = c.registry.get(normalized)
      const found = known || (await getAllEpisodes(user, realReq)).episodes.concat((await getAllEpisodes(user, realReq)).seasons).find((e) => e.jid === normalized)
      return found && snap.byId.has(found.seriesJid) ? found : null
    }
    if (kind === 'album' || kind === 'artist' || kind === 'audio') {
      const music = await getMusic(user, realReq)
      return music.byId.get(normalized) || null
    }
    if (kind === 'playlist') return (await getPlaylists(user, realReq)).find((p) => p.jid === normalized) || null
    return null
  }

  async function getMusic(user, realReq) {
    const c = cacheFor(user.id)
    if (c.music && now() - c.musicAt < MUSIC_TTL_MS) return c.music
    if (!c.musicBuilding) {
      c.musicBuilding = (async () => {
        const [a, al, t] = await Promise.all([
          host.api(user.id, 'GET', '/api/music/artists', undefined, realReq),
          host.api(user.id, 'GET', '/api/music/albums', undefined, realReq),
          host.api(user.id, 'GET', '/api/music/tracks?limit=50000', undefined, realReq)
        ])
        const artists = (okBody(a) || { items: [] }).items.map((x) => ({
          type: 'MusicArtist', kind: 'music', jid: ids.encode('artist', x.id), beeboId: x.id, title: x.name, albumCount: x.albumCount, trackCount: x.trackCount,
          cover: x.cover || null, genres: [], genreIds: []
        }))
        const albums = (okBody(al) || { items: [] }).items.map((x) => ({
          type: 'MusicAlbum', kind: 'music', jid: ids.encode('album', x.id), beeboId: x.id, title: x.title, artist: x.artist, artistId: x.artistId,
          artistJid: x.artistId ? ids.encode('artist', x.artistId) : null, year: x.year || null, genres: x.genre ? [x.genre] : [], genreIds: x.genre ? [musicGenreNumber(x.genre)] : [],
          trackCount: x.trackCount, duration: x.duration || 0, cover: x.cover || null, addedAt: x.addedAt || 0
        }))
        const tracks = (okBody(t) || { items: [] }).items.map((x) => ({
          type: 'Audio', kind: 'music', jid: ids.encode('audio', x.id), beeboId: x.id, title: x.title, artist: x.artist, album: x.album, albumArtist: x.albumArtist,
          albumId: x.albumId, albumJid: x.albumId ? ids.encode('album', x.albumId) : null, artistId: x.artistId, artistJid: x.artistId ? ids.encode('artist', x.artistId) : null,
          number: x.trackNo || null, disc: x.discNo || null, year: x.year || null, genres: x.genre ? [x.genre] : [], genreIds: x.genre ? [musicGenreNumber(x.genre)] : [], duration: x.duration || 0,
          codec: x.codec || '', bitrate: x.bitrate || 0, sampleRate: x.sampleRate || 0, channels: x.channels || 0, cover: x.cover || null
        }))
        const byId = new Map()
        for (const e of [...artists, ...albums, ...tracks]) byId.set(e.jid, e)
        const genreMap = new Map()
        for (const e of [...albums, ...tracks]) e.genres.forEach((g, i) => { if (!genreMap.has(e.genreIds[i])) genreMap.set(e.genreIds[i], g) })
        const genres = [...genreMap.entries()].map(([number, name]) => ({ number, name, jid: ids.encode('genre', number) }))
        noteSeen([...albums.slice().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).map((e, i) => ({ jid: e.jid, rank: i })), ...artists.map((e) => ({ jid: e.jid })), ...tracks.map((e) => ({ jid: e.jid }))])
        const music = { artists, albums, tracks, byId, genres }
        c.music = music
        c.musicAt = now()
        return music
      })().finally(() => { c.musicBuilding = null })
    }
    return c.musicBuilding
  }

  // Beebo's playlists (the person's own and shared ones, exactly what /api/playlists answers for them) as Jellyfin playlists.
  async function getPlaylists(user, realReq) {
    const c = cacheFor(user.id)
    if (c.playlists && now() - c.playlistsAt < PLAYLISTS_TTL_MS) return c.playlists
    const r = await host.api(user.id, 'GET', '/api/playlists', undefined, realReq)
    const rows = (okBody(r) || { playlists: [] }).playlists || []
    const list = rows.filter((p) => p && p.id).map((p) => ({
      type: 'Playlist', kind: 'playlist', jid: ids.encode('playlist', p.id), beeboId: p.id, title: p.name || 'Playlist', itemCount: Number(p.itemCount) || 0,
      genres: [], genreIds: [], year: null, overview: null, rating: null, poster: null, backdrop: null
    }))
    noteSeen(list.map((e) => ({ jid: e.jid })))
    c.playlists = list
    c.playlistsAt = now()
    for (const e of list) c.registry.set(e.jid, e)
    return list
  }

  async function getPlaylistItems(user, playlist, realReq) {
    const r = await host.api(user.id, 'GET', '/api/playlists/' + encodeURIComponent(playlist.beeboId), undefined, realReq)
    const body = okBody(r)
    const rows = (body && body.items) || []
    const snap = await getSnapshot(user, realReq)
    const out = []
    let music = null
    for (const row of rows) {
      if (!row || row.available === false) continue
      let entry = null
      if (row.type === 'movie') entry = snap.byId.get(ids.encode('movie', row.id)) || null
      else if (row.type === 'episode') entry = await episodeByBeeboId(user, row.id, realReq)
      else if (row.type === 'track') { music = music || (await getMusic(user, realReq)); entry = music.byId.get(ids.encode('audio', row.id)) || null }
      if (entry) out.push(entry)
    }
    return out
  }

  function forget(userId) { userCaches.delete(userId) }

  return { getPlaylists, getPlaylistItems, viewId, getSnapshot, getEpisodes, getAllEpisodes, episodeByBeeboId, resolve, getMusic, seasonJid, forget, cacheFor }
}

module.exports = { createCatalog }
