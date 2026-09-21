'use strict'

const idsLib = require('./ids')
const { VIEW_NUMBER } = require('./constants')

const MAX_PAGE = 5000

const ARTICLE = /^(the|a|an)\s+/i
const sortKey = (title) => String(title || '').toLowerCase().replace(ARTICLE, '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
const fold = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')

const TYPE_MEDIA = { Movie: 'Video', Episode: 'Video', Audio: 'Audio' }

function createItems({ host, ids, auth, catalog, mapper, services }) {
  const rootJid = ids.encode('view', 0)
  const viewJid = (name) => ids.encode('view', VIEW_NUMBER[name])
  const viewNameOf = (jid) => {
    const d = idsLib.decodeNumeric(jid)
    if (!d || d.kind !== 'view') return null
    return Object.keys(VIEW_NUMBER).find((k) => VIEW_NUMBER[k] === d.number) || (d.number === 0 ? 'root' : null)
  }

  function dtoCtx(user, extra = {}) {
    return { state: services.state(user), viewJid, rootJid, enableUserData: true, ...extra }
  }

  const page = (items, startIndex, total) => ({ Items: items, TotalRecordCount: total === undefined ? items.length : total, StartIndex: startIndex || 0 })

  async function musicPresent(user, req) {
    const r = await host.api(user.id, 'GET', '/api/music/status', undefined, req)
    return !!(r && r.status === 200 && r.body && Number(r.body.trackCount) > 0)
  }

  async function views(user, req) {
    const snap = await catalog.getSnapshot(user, req)
    const ctx = dtoCtx(user)
    const out = []
    if (snap.movies.length) out.push(mapper.viewDto('movies', snap.movies.length, ctx))
    if (snap.shows.length) out.push(mapper.viewDto('tvshows', snap.shows.length, ctx))
    if (snap.boxsets.length) out.push(mapper.viewDto('boxsets', snap.boxsets.length, ctx))
    if (await musicPresent(user, req)) out.push(mapper.viewDto('music', 1, ctx))
    const lists = await catalog.getPlaylists(user, req)
    if (lists.length) out.push(mapper.viewDto('playlists', lists.length, ctx))
    return out
  }

  const wantsTypes = (types, ...names) => !types.length || names.some((n) => types.includes(n))

  async function pool(user, q, req) {
    const types = q.list('includeItemTypes')
    const recursive = q.bool('recursive')
    const snap = await catalog.getSnapshot(user, req)
    const idsParam = q.list('ids')
    if (idsParam.length) {
      const out = []
      for (const id of idsParam.slice(0, 500)) {
        const e = await catalog.resolve(user, id, req)
        if (e) out.push(e)
      }
      return out
    }
    const seriesId = q('seriesId')
    const parentId = q('parentId') || seriesId
    if (parentId) {
      const normalized = idsLib.normalize(parentId)
      const kind = idsLib.kindOf(parentId)
      if (!normalized || !kind) return []
      if (kind === 'view') {
        const name = viewNameOf(normalized)
        if (name === 'movies') return snap.movies
        if (name === 'boxsets') return snap.boxsets
        if (name === 'tvshows') {
          if (recursive && types.some((t) => t === 'Episode' || t === 'Season')) {
            const all = await catalog.getAllEpisodes(user, req)
            return types.includes('Episode') ? all.episodes : all.seasons
          }
          return snap.shows
        }
        if (name === 'music') {
          const music = await catalog.getMusic(user, req)
          if (recursive && types.includes('Audio')) return music.tracks
          if (recursive && types.includes('MusicArtist')) return music.artists
          return music.albums
        }
        if (name === 'playlists') return catalog.getPlaylists(user, req)
        if (name === 'root') return [...snap.movies, ...snap.shows]
        return []
      }
      const entry = await catalog.resolve(user, normalized, req)
      if (!entry) return []
      if (entry.type === 'Series') {
        const eps = await catalog.getEpisodes(user, entry, req)
        return recursive || types.includes('Episode') ? eps.episodes : eps.seasons
      }
      if (entry.type === 'Season') {
        const series = snap.byId.get(entry.seriesJid)
        if (!series) return []
        const eps = await catalog.getEpisodes(user, series, req)
        return eps.episodes.filter((e) => e.seasonJid === entry.jid)
      }
      if (entry.type === 'BoxSet') return entry.memberJids.map((j) => snap.byId.get(j)).filter(Boolean)
      if (entry.type === 'Playlist') return catalog.getPlaylistItems(user, entry, req)
      if (entry.type === 'MusicAlbum') {
        const music = await catalog.getMusic(user, req)
        return music.tracks.filter((t) => t.albumJid === entry.jid).sort((a, b) => (a.disc || 0) - (b.disc || 0) || (a.number || 0) - (b.number || 0))
      }
      if (entry.type === 'MusicArtist') {
        const music = await catalog.getMusic(user, req)
        return recursive && types.includes('Audio') ? music.tracks.filter((t) => t.artistJid === entry.jid) : music.albums.filter((a) => a.artistJid === entry.jid)
      }
      return []
    }
    const out = []
    if (wantsTypes(types, 'Movie')) out.push(...snap.movies)
    if (wantsTypes(types, 'Series')) out.push(...snap.shows)
    if (types.includes('BoxSet')) out.push(...snap.boxsets)
    if (types.includes('Playlist')) out.push(...(await catalog.getPlaylists(user, req)))
    if (types.includes('Episode')) out.push(...(await catalog.getAllEpisodes(user, req)).episodes)
    if (types.includes('Season')) out.push(...(await catalog.getAllEpisodes(user, req)).seasons)
    if (types.some((t) => t === 'MusicAlbum' || t === 'Audio' || t === 'MusicArtist')) {
      const music = await catalog.getMusic(user, req)
      if (types.includes('MusicAlbum')) out.push(...music.albums)
      if (types.includes('Audio')) out.push(...music.tracks)
      if (types.includes('MusicArtist')) out.push(...music.artists)
    }
    return out
  }

  async function personFilter(user, q, req, list) {
    const persons = q.list('personIds').map((p) => idsLib.decodeNumeric(p)).filter((d) => d && d.kind === 'person')
    if (!persons.length) return list
    const allowed = new Set()
    for (const p of persons) {
      const [m, t] = await Promise.all([
        host.api(user.id, 'GET', '/api/movies?actor=' + p.number, undefined, req),
        host.api(user.id, 'GET', '/api/tvshows?actor=' + p.number, undefined, req)
      ])
      for (const x of (m && m.body && m.body.items) || []) allowed.add(idsLib.normalize(ids.encode('movie', x.id)))
      for (const x of (t && t.body && t.body.items) || []) allowed.add(idsLib.normalize(ids.encode('series', x.key)))
    }
    return list.filter((e) => allowed.has(e.jid))
  }

  function filterEntries(list, q, state) {
    const types = q.list('includeItemTypes')
    const exclude = q.list('excludeItemTypes')
    const mediaTypes = q.list('mediaTypes')
    const term = fold(q('searchTerm'))
    const filters = q.list('filters')
    const genres = q.list('genres').map(fold)
    const genreIds = q.list('genreIds').map((g) => idsLib.decodeNumeric(g)).filter((d) => d && d.kind === 'genre').map((d) => d.number)
    const years = q.list('years').map(Number).filter(Number.isFinite)
    const startsWith = fold(q('nameStartsWith'))
    const startsOrGreater = fold(q('nameStartsWithOrGreater'))
    const lessThan = fold(q('nameLessThan'))
    const artistIds = q.list('artistIds').concat(q.list('albumArtistIds'), q.list('contributingArtistIds')).map(idsLib.normalize).filter(Boolean)
    const albumIds = q.list('albumIds').map(idsLib.normalize).filter(Boolean)
    const favOnly = q.bool('isFavorite') || filters.includes('IsFavorite')
    const playedOnly = filters.includes('IsPlayed') || (q.has('isPlayed') && q.bool('isPlayed'))
    const unplayedOnly = filters.includes('IsUnplayed') || (q.has('isPlayed') && !q.bool('isPlayed'))
    const resumable = filters.includes('IsResumable')
    const kindOf = (e) => (e.type === 'Movie' ? 'movie' : e.type === 'Episode' ? 'tv' : null)
    return list.filter((e) => {
      if (types.length && !types.includes(e.type)) return false
      if (exclude.includes(e.type)) return false
      if (mediaTypes.length && !mediaTypes.includes(TYPE_MEDIA[e.type] || 'Unknown')) return false
      if (term && !fold(e.title).includes(term) && !fold(e.artist || '').includes(term) && !fold(e.album || '').includes(term)) return false
      const name = fold(e.title)
      if (startsWith && !name.startsWith(startsWith)) return false
      if (startsOrGreater && name < startsOrGreater) return false
      if (lessThan && name >= lessThan) return false
      if (genres.length && !genres.some((g) => (e.genres || []).some((n) => fold(n) === g))) return false
      if (genreIds.length && !genreIds.some((g) => (e.genreIds || []).includes(g))) return false
      if (years.length && !years.includes(e.year)) return false
      if (artistIds.length && !artistIds.includes(e.artistJid) && !artistIds.includes(e.jid)) return false
      if (albumIds.length && !albumIds.includes(e.albumJid) && !albumIds.includes(e.jid)) return false
      const kind = kindOf(e)
      if (favOnly) {
        const fav = kind ? state.favorite(kind, e.beeboId) : e.type === 'Series' ? state.favorite('tv', e.showKey) : false
        if (!fav) return false
      }
      if (playedOnly || unplayedOnly || resumable) {
        if (!kind) return !playedOnly && !resumable
        const played = state.watched(kind, e.beeboId)
        if (playedOnly && !played) return false
        if (unplayedOnly && played) return false
        if (resumable && (played || !state.resume(kind, e.beeboId))) return false
      }
      return true
    })
  }

  function sortEntries(list, q, state) {
    const keys = q.list('sortBy')
    const orders = q.list('sortOrder')
    const by = keys.length ? keys : ['SortName']
    const dir = (i) => (String(orders[i] || orders[0] || 'Ascending').toLowerCase().startsWith('desc') ? -1 : 1)
    const kindOf = (e) => (e.type === 'Movie' ? 'movie' : e.type === 'Episode' ? 'tv' : null)
    const value = (e, k) => {
      switch (k.toLowerCase()) {
        case 'random': return Math.random()
        case 'datecreated': case 'datelastcontentadded': return -(e.addedRank === undefined ? 1e9 : e.addedRank)
        case 'premieredate': case 'productionyear': return e.year || 0
        case 'communityrating': case 'criticrating': return e.rating || 0
        case 'dateplayed': return kindOf(e) ? state.lastPlayedAt(kindOf(e), e.beeboId) : 0
        case 'playcount': return kindOf(e) && state.watched(kindOf(e), e.beeboId) ? 1 : 0
        case 'indexnumber': return e.number === null || e.number === undefined ? 1e9 : e.number
        case 'parentindexnumber': return e.seasonNumber === null || e.seasonNumber === undefined ? 1e9 : e.seasonNumber
        case 'album': return sortKey(e.album || e.title)
        case 'albumartist': return sortKey(e.albumArtist || e.artist || '')
        case 'artist': return sortKey(e.artist || '')
        default: return sortKey(e.title)
      }
    }
    const cmp = (a, b) => {
      for (let i = 0; i < by.length; i++) {
        const va = value(a, by[i])
        const vb = value(b, by[i])
        if (va === vb) continue
        const r = va < vb ? -1 : 1
        return r * dir(i)
      }
      return sortKey(a.title) < sortKey(b.title) ? -1 : sortKey(a.title) > sortKey(b.title) ? 1 : 0
    }
    return list.slice().sort(cmp)
  }

  async function runtimeMap(user, entries, req) {
    const map = new Map()
    const state = services.state(user)
    for (const e of entries) {
      const kind = e.type === 'Movie' ? 'movie' : e.type === 'Episode' ? 'tv' : null
      if (!kind) continue
      const r = state.resume(kind, e.beeboId)
      if (r && r.duration > 0) map.set(e.jid, r.duration)
    }
    return map
  }

  // Lists carry MediaSources only when the app asks for them with Fields=MediaSources (Swiftfin does, for its home rows), and only for
  // a short list: each one is a look at the file's tracks.
  const WITH_SOURCES_MAX = 25
  const wantsSources = (q) => q.list('fields').some((f) => f.toLowerCase() === 'mediasources')

  async function toDtos(user, entries, req, extra = {}) {
    const { withSources, ...ctxExtra } = extra
    const runtimes = await runtimeMap(user, entries, req)
    const base = dtoCtx(user, ctxExtra)
    const out = []
    for (const e of entries) {
      const dto = mapper.toDto(e, { ...base, runtimeSec: runtimes.get(e.jid) })
      if (!dto) continue
      if (withSources && entries.length <= WITH_SOURCES_MAX && (e.type === 'Movie' || e.type === 'Episode') && services.playback) {
        try {
          const info = await services.playback.mediaSourcesFor(user, e, req)
          if (info && info.sources) {
            dto.MediaSources = info.sources
            dto.MediaStreams = info.sources[0] ? info.sources[0].MediaStreams : undefined
            dto.Container = info.sources[0] ? info.sources[0].Container : undefined
            if (info.runtimeSec) dto.RunTimeTicks = Math.round(info.runtimeSec * 10000000)
          }
        } catch {}
      }
      out.push(dto)
    }
    return out
  }

  async function query(user, q, req) {
    const state = services.state(user)
    let list = await pool(user, q, req)
    list = filterEntries(list, q, state)
    list = await personFilter(user, q, req, list)
    // A playlist keeps its own order unless the app asks for another.
    const parentKind = q('parentId') ? idsLib.kindOf(q('parentId')) : null
    if (!(parentKind === 'playlist' && !q.has('sortBy'))) list = sortEntries(list, q, state)
    const total = list.length
    const start = Math.max(0, q.int('startIndex', 0))
    const limitRaw = q.int('limit', 0)
    const limit = limitRaw > 0 ? Math.min(limitRaw, MAX_PAGE) : MAX_PAGE
    const slice = list.slice(start, start + limit)
    return page(await toDtos(user, slice, req, { withSources: wantsSources(q) }), start, total)
  }

  async function latest(user, q, req) {
    const limit = Math.min(Math.max(q.int('limit', 16), 1), 200)
    const types = q.list('includeItemTypes')
    const parent = q('parentId')
    const snap = await catalog.getSnapshot(user, req)
    const view = parent ? viewNameOf(parent) : null
    let list
    if (view === 'tvshows' || (!view && types.includes('Series'))) {
      const r = await host.api(user.id, 'GET', '/api/recently-added', undefined, req)
      const order = ((r && r.body && r.body.items) || []).filter((x) => x.kind === 'tv').map((x) => x.showKey || x.id)
      const byKey = new Map(snap.shows.map((s) => [s.showKey, s]))
      list = order.map((k) => byKey.get(k)).filter(Boolean)
      if (!list.length) list = snap.shows.slice(0, limit)
    } else if (view === 'movies' || types.includes('Movie') || !view) {
      list = snap.movies.slice().sort((a, b) => a.addedRank - b.addedRank)
    } else if (view === 'boxsets') {
      list = snap.boxsets
    } else if (view === 'music') {
      list = (await catalog.getMusic(user, req)).albums.slice().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
    } else {
      list = []
    }
    if (q.bool('isPlayed') === false && q.has('isPlayed')) list = filterEntries(list, q, services.state(user))
    return toDtos(user, list.slice(0, limit), req, { withSources: wantsSources(q) })
  }

  async function resume(user, q, req) {
    const r = await host.api(user.id, 'GET', '/api/continue', undefined, req)
    const rows = ((r && r.body && r.body.items) || []).filter((x) => !x.upNext)
    const snap = await catalog.getSnapshot(user, req)
    const entries = []
    for (const row of rows) {
      let entry = null
      if (row.kind === 'tv') entry = await catalog.episodeByBeeboId(user, row.id, req)
      else entry = snap.byId.get(ids.encode('movie', row.id)) || null
      if (entry) entries.push(entry)
    }
    let list = entries
    const mediaTypes = q.list('mediaTypes')
    if (mediaTypes.length) list = list.filter((e) => mediaTypes.includes(TYPE_MEDIA[e.type] || 'Unknown'))
    const parent = q('parentId')
    if (parent) {
      const view = viewNameOf(parent)
      if (view === 'movies') list = list.filter((e) => e.type === 'Movie')
      else if (view === 'tvshows') list = list.filter((e) => e.type === 'Episode')
      else if (!view) list = list.filter((e) => e.seriesJid === idsLib.normalize(parent) || e.seasonJid === idsLib.normalize(parent))
    }
    const limit = q.int('limit', 0)
    const total = list.length
    if (limit > 0) list = list.slice(0, limit)
    return page(await toDtos(user, list, req, { withSources: wantsSources(q) }), 0, total)
  }

  async function nextUp(user, q, req) {
    // Jellyfin's rule: for every show the person has started, the first unwatched episode after the last watched one; shows are
    // ordered by when they were last watched. Worked out from the person's own watched marks (so "mark as played" moves it too);
    // an episode that is part-watched counts as the next one only while the app leaves enableResumable on (its default), which
    // is how a home screen asks for a Next Up row that does not repeat Continue Watching.
    const state = services.state(user)
    const includeResumable = !q.has('enableResumable') || q.bool('enableResumable')
    const wantSeries = idsLib.normalize(q('seriesId'))
    let groups
    if (wantSeries) {
      const series = await catalog.resolve(user, wantSeries, req)
      groups = series && series.type === 'Series' ? [(await catalog.getEpisodes(user, series, req)).episodes] : []
    } else {
      const bySeries = new Map()
      for (const e of (await catalog.getAllEpisodes(user, req)).episodes) {
        if (!bySeries.has(e.seriesJid)) bySeries.set(e.seriesJid, [])
        bySeries.get(e.seriesJid).push(e)
      }
      groups = [...bySeries.values()]
    }
    const order = (n) => (n === null || n === undefined ? 1e9 : n)
    const found = []
    for (const eps of groups) {
      const sorted = eps.slice().sort((a, b) => order(a.seasonNumber) - order(b.seasonNumber) || order(a.number) - order(b.number))
      let last = -1
      let lastAt = 0
      sorted.forEach((e, i) => {
        if (state.watched('tv', e.beeboId)) { last = i; lastAt = Math.max(lastAt, state.lastPlayedAt('tv', e.beeboId)) }
      })
      if (last < 0) continue
      const next = sorted.slice(last + 1).find((e) => !state.watched('tv', e.beeboId))
      if (!next) continue
      if (!includeResumable && state.resume('tv', next.beeboId)) continue
      found.push({ entry: next, at: lastAt })
    }
    found.sort((a, b) => b.at - a.at || sortKey(a.entry.seriesTitle).localeCompare(sortKey(b.entry.seriesTitle)))
    const out = found.map((x) => x.entry)
    const start = Math.max(0, q.int('startIndex', 0))
    const limit = q.int('limit', 0)
    const total = out.length
    return page(await toDtos(user, out.slice(start, limit > 0 ? start + limit : undefined), req, { withSources: wantsSources(q) }), start, total)
  }

  async function seasonsOf(user, seriesJid, q, req) {
    const series = await catalog.resolve(user, seriesJid, req)
    if (!series || series.type !== 'Series') return null
    const eps = await catalog.getEpisodes(user, series, req)
    const state = services.state(user)
    const ctxFor = (season) => ({ unplayed: eps.episodes.filter((e) => e.seasonJid === season.jid && !state.watched('tv', e.beeboId)).length })
    const base = dtoCtx(user)
    return page(eps.seasons.map((s) => mapper.toDto(s, { ...base, ...ctxFor(s) })), 0)
  }

  async function episodesOf(user, seriesJid, q, req) {
    const series = await catalog.resolve(user, seriesJid, req)
    if (!series || series.type !== 'Series') return null
    const eps = await catalog.getEpisodes(user, series, req)
    let list = eps.episodes
    const seasonId = idsLib.normalize(q('seasonId'))
    if (seasonId) list = list.filter((e) => e.seasonJid === seasonId)
    else if (q.has('season')) list = list.filter((e) => e.seasonNumber === q.int('season', -1))
    const startItem = idsLib.normalize(q('startItemId'))
    if (startItem) {
      const at = list.findIndex((e) => e.jid === startItem)
      if (at > 0) list = list.slice(at)
    }
    if (q.has('isMissing') && q.bool('isMissing')) list = []
    const state = services.state(user)
    if (q.has('isPlayed')) list = list.filter((e) => state.watched('tv', e.beeboId) === q.bool('isPlayed'))
    const start = Math.max(0, q.int('startIndex', 0))
    const limit = q.int('limit', 0)
    const total = list.length
    const slice = list.slice(start, limit > 0 ? start + limit : undefined)
    return page(await toDtos(user, slice, req, { withSources: wantsSources(q) }), start, total)
  }

  async function peopleFor(user, entry, req) {
    if (entry.type !== 'Movie' && entry.type !== 'Series') return []
    const kind = entry.type === 'Series' ? 'tv' : 'movie'
    const r = await host.api(user.id, 'GET', '/api/credits?kind=' + kind + '&id=' + encodeURIComponent(entry.beeboId), undefined, req)
    const cast = (r && r.status === 200 && r.body && r.body.cast) || []
    return cast.filter((c) => c && c.name).map((c) => {
      const id = c.id != null && Number.isFinite(Number(c.id)) ? ids.encode('person', Number(c.id)) : null
      if (id && c.profile) mapper.rememberImages(id, { primary: c.profile, backdrop: null })
      return { Name: c.name, Id: id || undefined, Role: c.character || undefined, Type: 'Actor', PrimaryImageTag: id && c.profile ? mapper.tagOf(c.profile) : undefined }
    })
  }

  async function detail(user, jid, req) {
    const viewName = viewNameOf(jid)
    if (viewName && viewName !== 'root') {
      const list = await views(user, req)
      return list.find((v) => v.Id === idsLib.normalize(jid)) || null
    }
    const entry = await catalog.resolve(user, jid, req)
    if (!entry) return null
    const base = dtoCtx(user)
    let dto
    if (entry.type === 'Series') {
      const eps = await catalog.getEpisodes(user, entry, req)
      const state = services.state(user)
      dto = mapper.toDto(entry, { ...base, seasonCount: eps.seasons.length, unplayed: eps.episodes.filter((e) => !state.watched('tv', e.beeboId)).length })
    } else if (entry.type === 'Season') {
      const series = (await catalog.resolve(user, entry.seriesJid, req))
      const eps = series ? await catalog.getEpisodes(user, series, req) : { episodes: [] }
      const state = services.state(user)
      dto = mapper.toDto(entry, { ...base, unplayed: eps.episodes.filter((e) => e.seasonJid === entry.jid && !state.watched('tv', e.beeboId)).length })
    } else {
      dto = mapper.toDto(entry, base)
    }
    if (!dto) return null
    dto.People = await peopleFor(user, entry, req)
    if ((entry.type === 'Movie' || entry.type === 'Episode' || entry.type === 'Audio') && services.playback) {
      const info = await services.playback.mediaSourcesFor(user, entry, req)
      if (info) {
        dto.MediaSources = info.sources
        dto.MediaStreams = info.sources[0] ? info.sources[0].MediaStreams : undefined
        dto.Container = info.sources[0] ? info.sources[0].Container : undefined
        if (info.runtimeSec) dto.RunTimeTicks = Math.round(info.runtimeSec * 10000000)
        const chapters = (info.info && Array.isArray(info.info.chapters)) ? info.info.chapters : []
        if (chapters.length) dto.Chapters = chapters.filter((c) => c && Number.isFinite(Number(c.startSec))).map((c) => ({ StartPositionTicks: Math.round(Number(c.startSec) * 10000000), Name: c.title || undefined }))
      }
      if ((entry.type === 'Movie' || entry.type === 'Episode') && services.trickplay) {
        try { const tp = await services.trickplay.dtoFor(user, entry, req); if (tp) dto.Trickplay = tp } catch {}
      }
    }
    return dto
  }

  async function genresList(user, q, req) {
    const snap = await catalog.getSnapshot(user, req)
    const types = q.list('includeItemTypes')
    const view = q('parentId') ? viewNameOf(q('parentId')) : null
    const wantMovie = view === 'movies' || (!view && wantsTypes(types, 'Movie', 'BoxSet'))
    const wantTv = view === 'tvshows' || (!view && wantsTypes(types, 'Series', 'Episode', 'Season'))
    const present = new Set()
    if (wantMovie) for (const m of snap.movies) for (const g of m.genreIds) present.add(g)
    if (wantTv) for (const s of snap.shows) for (const g of s.genreIds) present.add(g)
    let list = snap.genres.filter((g) => present.has(g.id)).sort((a, b) => a.name.localeCompare(b.name))
    const term = fold(q('searchTerm'))
    if (term) list = list.filter((g) => fold(g.name).includes(term))
    const total = list.length
    const start = Math.max(0, q.int('startIndex', 0))
    const limit = q.int('limit', 0)
    list = list.slice(start, limit > 0 ? start + limit : undefined)
    return page(list.map((g) => ({ Name: g.name, ServerId: auth.serverId(), Id: g.jid, Type: 'Genre', ImageTags: {}, BackdropImageTags: [], UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false, Key: g.name, ItemId: g.jid } })), start, total)
  }

  async function searchHints(user, q, req) {
    const term = fold(q('searchTerm'))
    if (!term) return { SearchHints: [], TotalRecordCount: 0 }
    const types = q.list('includeItemTypes')
    const snap = await catalog.getSnapshot(user, req)
    let list = []
    if (wantsTypes(types, 'Movie')) list.push(...snap.movies)
    if (wantsTypes(types, 'Series')) list.push(...snap.shows)
    if (types.some((t) => t === 'MusicAlbum' || t === 'Audio' || t === 'MusicArtist')) {
      const music = await catalog.getMusic(user, req)
      if (types.includes('MusicAlbum')) list.push(...music.albums)
      if (types.includes('MusicArtist')) list.push(...music.artists)
      if (types.includes('Audio')) list.push(...music.tracks)
    }
    list = list.filter((e) => fold(e.title).includes(term)).sort((a, b) => sortKey(a.title).localeCompare(sortKey(b.title)))
    const limit = Math.min(Math.max(q.int('limit', 20), 1), 200)
    const total = list.length
    const hints = list.slice(0, limit).map((e) => {
      const primary = e.poster || e.cover || null
      if (primary) mapper.rememberImages(e.jid, { primary, backdrop: e.backdrop || null })
      return {
        ItemId: e.jid, Id: e.jid, Name: e.title, MatchedTerm: q('searchTerm'), ProductionYear: e.year || undefined, Type: e.type,
        PrimaryImageTag: primary ? mapper.tagOf(primary) : undefined, PrimaryImageAspectRatio: primary ? 0.6667 : undefined,
        MediaType: TYPE_MEDIA[e.type] || 'Unknown', IsFolder: !TYPE_MEDIA[e.type], Series: e.seriesTitle, Album: e.album, Artists: e.artist ? [e.artist] : []
      }
    })
    return { SearchHints: hints, TotalRecordCount: total }
  }

  async function filtersLegacy(user, q, req) {
    const snap = await catalog.getSnapshot(user, req)
    const view = q('parentId') ? viewNameOf(q('parentId')) : null
    const pool = view === 'tvshows' ? snap.shows : view === 'movies' ? snap.movies : [...snap.movies, ...snap.shows]
    const genres = [...new Set(pool.flatMap((e) => e.genres))].sort()
    const years = [...new Set(pool.map((e) => e.year).filter(Boolean))].sort((a, b) => b - a)
    return { Genres: genres, Tags: [], OfficialRatings: [], Years: years }
  }

  async function filters2(user, q, req) {
    const snap = await catalog.getSnapshot(user, req)
    const view = q('parentId') ? viewNameOf(q('parentId')) : null
    const pool = view === 'tvshows' ? snap.shows : view === 'movies' ? snap.movies : [...snap.movies, ...snap.shows]
    const present = new Set(pool.flatMap((e) => e.genreIds))
    return { Genres: snap.genres.filter((g) => present.has(g.id)).map((g) => ({ Name: g.name, Id: g.jid })).sort((a, b) => a.Name.localeCompare(b.Name)), Tags: [] }
  }

  async function artists(user, q, req) {
    const music = await catalog.getMusic(user, req)
    const term = fold(q('searchTerm'))
    let list = music.artists
    if (term) list = list.filter((a) => fold(a.title).includes(term))
    list = list.slice().sort((a, b) => sortKey(a.title).localeCompare(sortKey(b.title)))
    const total = list.length
    const start = Math.max(0, q.int('startIndex', 0))
    const limit = q.int('limit', 0)
    return page(await toDtos(user, list.slice(start, limit > 0 ? start + limit : undefined), req), start, total)
  }

  // A small seeded shuffle: the same person sees the same "suggestions" for an hour, a different set the next hour.
  function seededShuffle(list, seedText) {
    let h = 2166136261
    for (let i = 0; i < seedText.length; i++) { h ^= seedText.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
    const rnd = () => { h = (Math.imul(h, 1664525) + 1013904223) >>> 0; return h / 4294967296 }
    const a = list.slice()
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] }
    return a
  }

  // GET /Items/Suggestions: unwatched films and shows, best rated first within a per-hour shuffle.
  async function suggestions(user, q, req) {
    const types = q.list('type').concat(q.list('includeItemTypes'))
    const state = services.state(user)
    const snap = await catalog.getSnapshot(user, req)
    let pool = []
    if (wantsTypes(types, 'Movie')) pool.push(...snap.movies)
    if (wantsTypes(types, 'Series')) pool.push(...snap.shows)
    pool = pool.filter((e) => (e.type === 'Movie' ? !state.watched('movie', e.beeboId) : true))
    const hour = Math.floor(Date.now() / 3600000)
    const shuffled = seededShuffle(pool, user.id + '|' + hour)
    const top = shuffled.sort((a, b) => Math.round((b.rating || 0) / 2) - Math.round((a.rating || 0) / 2))
    const limit = Math.min(Math.max(q.int('limit', 12), 1), 100)
    const start = Math.max(0, q.int('startIndex', 0))
    return page(await toDtos(user, top.slice(start, start + limit), req), start, top.length)
  }

  // GET /Items/{id}/Similar: same kind, most genres in common, then better rated.
  async function similar(user, entry, q, req) {
    const limit = Math.min(Math.max(q.int('limit', 12), 1), 100)
    const snap = await catalog.getSnapshot(user, req)
    let pool = []
    if (entry.type === 'Movie') pool = snap.movies
    else if (entry.type === 'Series') pool = snap.shows
    else if (entry.type === 'Episode' || entry.type === 'Season') pool = snap.shows.filter((s) => s.jid !== entry.seriesJid)
    else if (entry.type === 'MusicAlbum') pool = (await catalog.getMusic(user, req)).albums
    else return page([], 0)
    const mine = new Set(entry.genreIds || [])
    const scored = pool.filter((e) => e.jid !== entry.jid).map((e) => ({ e, n: (e.genreIds || []).filter((g) => mine.has(g)).length })).filter((x) => x.n > 0)
    scored.sort((a, b) => b.n - a.n || (b.e.rating || 0) - (a.e.rating || 0) || sortKey(a.e.title).localeCompare(sortKey(b.e.title)))
    return page(await toDtos(user, scored.slice(0, limit).map((x) => x.e), req), 0, Math.min(scored.length, limit))
  }

  // Instant mix: the seed's own tracks first, then more from the same artist and genre, up to `limit` (default 100).
  async function instantMix(user, entry, q, req) {
    const limit = Math.min(Math.max(q.int('limit', 100), 1), 500)
    const music = await catalog.getMusic(user, req)
    let seed = []
    if (entry.type === 'Audio') seed = [entry]
    else if (entry.type === 'MusicAlbum') seed = music.tracks.filter((t) => t.albumJid === entry.jid)
    else if (entry.type === 'MusicArtist') seed = music.tracks.filter((t) => t.artistJid === entry.jid)
    else if (entry.type === 'Playlist') seed = (await catalog.getPlaylistItems(user, entry, req)).filter((e) => e.type === 'Audio')
    else if (entry.type === 'Genre') seed = music.tracks.filter((t) => (t.genreIds || []).includes(entry.number))
    seed = seed.slice().sort((a, b) => (a.disc || 0) - (b.disc || 0) || (a.number || 0) - (b.number || 0))
    const artistJids = new Set(seed.map((t) => t.artistJid).filter(Boolean))
    const genreIds = new Set(seed.flatMap((t) => t.genreIds || []))
    const seen = new Set(seed.map((t) => t.jid))
    const rest = music.tracks.filter((t) => !seen.has(t.jid) && (artistJids.has(t.artistJid) || (t.genreIds || []).some((g) => genreIds.has(g))))
    const mix = seed.concat(seededShuffle(rest, entry.jid + '|' + Math.floor(Date.now() / 3600000))).slice(0, limit)
    return page(await toDtos(user, mix, req), 0, mix.length)
  }

  // GET /MusicGenres: the genre names on the person's albums and tracks.
  async function musicGenres(user, q, req) {
    const music = await catalog.getMusic(user, req)
    const term = fold(q('searchTerm'))
    let list = music.genres.filter((g) => !term || fold(g.name).includes(term)).sort((a, b) => a.name.localeCompare(b.name))
    const total = list.length
    const start = Math.max(0, q.int('startIndex', 0))
    const limit = q.int('limit', 0)
    list = list.slice(start, limit > 0 ? start + limit : undefined)
    return page(list.map((g) => ({ Name: g.name, ServerId: auth.serverId(), Id: g.jid, Type: 'MusicGenre', ImageTags: {}, BackdropImageTags: [], UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false, Key: g.name, ItemId: g.jid } })), start, total)
  }

  return { suggestions, similar, instantMix, musicGenres, views, query, latest, resume, nextUp, seasonsOf, episodesOf, detail, genresList, searchHints, filtersLegacy, filters2, artists, dtoCtx, toDtos, page, rootJid, viewJid, viewNameOf }
}

module.exports = { createItems }
