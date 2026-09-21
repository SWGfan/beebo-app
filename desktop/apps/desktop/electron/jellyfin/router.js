'use strict'

const idsLib = require('./ids')
const { PRODUCT_NAME, COMPAT_API_VERSION } = require('./constants')
const { CORS, sendJson, sendEmpty, sendText, readBody, readCredentials, makeQuery, pick } = require('./util')

const PREFIXES = ['/emby', '/mediabrowser']

function compile(method, pattern, opts) {
  const names = []
  const re = new RegExp('^' + pattern.split('/').map((seg) => {
    const m = /^\{(\w+)\}$/.exec(seg)
    if (m) { names.push(m[1].toLowerCase()); return '([^/]+)' }
    const dot = /^(.*)\{(\w+)\}$/.exec(seg)
    if (dot) { names.push(dot[2].toLowerCase()); return dot[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^/]+)' }
    const suffixed = /^\{(\w+)\}(\..+)$/.exec(seg)
    if (suffixed) { names.push(suffixed[1].toLowerCase()); return '([^/]+?)' + suffixed[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }).join('/') + '/?$', opts && opts.caseSensitive ? '' : 'i')
  return { method, pattern, re, names, ...opts }
}

function stripPrefix(pathname) {
  const lower = pathname.toLowerCase()
  for (const p of PREFIXES) if (lower === p || lower.startsWith(p + '/')) return pathname.slice(p.length) || '/'
  return pathname
}

function safeDecode(s) {
  try { return decodeURIComponent(s) } catch { return s }
}

function createRouter({ services, ids, auth, catalog, mapper, items, playback, sessions, images, host, settingEnabled, log, segments, trickplay, hub }) {
  const routes = []
  const on = (method, pattern, handler, opts = {}) => routes.push(compile(method, pattern, { handler, ...opts }))
  const anyOf = (methods, pattern, handler, opts) => { for (const m of methods) on(m, pattern, handler, opts) }
  const publicRoute = { anonymous: true }

  const serverName = () => {
    try { return String(host.serverName ? host.serverName() : '') || PRODUCT_NAME } catch { return PRODUCT_NAME }
  }

  const publicInfo = () => ({
    LocalAddress: undefined,
    ServerName: serverName(),
    Version: COMPAT_API_VERSION,
    ProductName: PRODUCT_NAME,
    OperatingSystem: '',
    Id: auth.serverId(),
    StartupWizardCompleted: true,
    BeeboCompat: { api: 'Jellyfin-compatible API, 12.1-level subset', product: PRODUCT_NAME, notJellyfin: true }
  })

  // ---- public ----
  on('GET', '/System/Info/Public', (c) => sendJson(c.res, 200, publicInfo()), publicRoute)
  anyOf(['GET', 'POST'], '/System/Ping', (c) => sendText(c.res, 200, PRODUCT_NAME, 'text/plain; charset=utf-8'), publicRoute)
  on('GET', '/Branding/Configuration', (c) => sendJson(c.res, 200, { LoginDisclaimer: '', CustomCss: '', SplashscreenEnabled: false }), publicRoute)
  anyOf(['GET'], '/Branding/Css', (c) => sendText(c.res, 200, '', 'text/css; charset=utf-8'), publicRoute)
  anyOf(['GET'], '/Branding/Css.css', (c) => sendText(c.res, 200, '', 'text/css; charset=utf-8'), publicRoute)
  on('GET', '/Users/Public', (c) => sendJson(c.res, 200, []), publicRoute)

  on('POST', '/Users/AuthenticateByName', async (c) => {
    const body = await readBody(c.req)
    const username = pick(body, 'Username', 'Name')
    const password = pick(body, 'Pw', 'Password')
    if (typeof username !== 'string' || !username.trim()) return sendJson(c.res, 400, { Message: 'Username is required.' })
    const out = await auth.login({ username, password: typeof password === 'string' ? password : '', device: c.device, ip: c.ip })
    if (!out.ok) {
      if (out.locked) return sendJson(c.res, 429, { Message: 'Too many failed attempts. Try again later.' }, { 'Retry-After': String((out.minutesRemaining || 5) * 60) })
      // Two-factor accounts cannot sign in with a password here; the message tells them the way in.
      if (out.twoFactor) return sendJson(c.res, 401, { Message: 'This account uses two-factor sign-in, which Jellyfin-compatible apps cannot ask for. Ask the person who runs this Beebo server for an app password (Settings > Jellyfin apps) and use it as the password here.' })
      return sendJson(c.res, 401, { Message: 'Invalid username or password.' })
    }
    sendJson(c.res, 200, out.body)
  }, publicRoute)

  on('GET', '/QuickConnect/Enabled', (c) => sendJson(c.res, 200, true), publicRoute)
  anyOf(['GET', 'POST'], '/QuickConnect/Initiate', (c) => {
    const out = auth.quickConnectInitiate({ device: c.device, ip: c.ip })
    if (!out.ok) return sendJson(c.res, 429, { Message: 'Too many Quick Connect requests. Try again in a few minutes.' })
    sendJson(c.res, 200, out.body)
  }, publicRoute)
  on('GET', '/QuickConnect/Connect', (c) => {
    const state = auth.quickConnectState(c.q('secret'))
    if (!state) return sendJson(c.res, 404, { Message: 'Unknown or expired secret.' })
    sendJson(c.res, 200, state)
  }, publicRoute)
  on('POST', '/Users/AuthenticateWithQuickConnect', async (c) => {
    const body = await readBody(c.req)
    const out = auth.quickConnectRedeem({ secret: pick(body, 'Secret'), device: c.device, ip: c.ip })
    if (!out) return sendJson(c.res, 401, { Message: 'Quick Connect has not been approved.' })
    sendJson(c.res, 200, out)
  }, publicRoute)

  anyOf(['GET', 'HEAD'], '/Items/{itemId}/Images/{imageType}', (c) => images.serve(c), publicRoute)
  anyOf(['GET', 'HEAD'], '/Items/{itemId}/Images/{imageType}/{imageIndex}', (c) => images.serve(c), publicRoute)
  on('GET', '/Users/{userId}/Images/{imageType}', (c) => sendEmpty(c.res, 404), publicRoute)
  // The live-updates socket is a WebSocket upgrade handled by websocket.js; a plain GET is told so.
  on('GET', '/socket', (c) => sendText(c.res, 426, 'Upgrade Required', 'text/plain; charset=utf-8', { Upgrade: 'websocket' }), publicRoute)

  // ---- signed in: identity ----
  on('POST', '/QuickConnect/Authorize', (c) => {
    const out = auth.quickConnectAuthorize(c.user, c.q('code'))
    if (out.limited) return sendJson(c.res, 429, { Message: 'Too many wrong codes. Try again in a few minutes.' })
    sendJson(c.res, 200, out.ok)
  })
  on('GET', '/System/Info', (c) => sendJson(c.res, 200, { ...publicInfo(), HasPendingRestart: false, IsShuttingDown: false, SupportsLibraryMonitor: false, WebSocketPortNumber: 0, CanSelfRestart: false, CanLaunchWebBrowser: false, HasUpdateAvailable: false }))
  on('GET', '/System/Endpoint', (c) => sendJson(c.res, 200, { IsLocal: false, IsInNetwork: true }))
  anyOf(['POST'], '/System/Restart', (c) => sendJson(c.res, 403, { Message: 'Not available.' }))
  anyOf(['POST'], '/System/Shutdown', (c) => sendJson(c.res, 403, { Message: 'Not available.' }))
  on('GET', '/Users/Me', (c) => sendJson(c.res, 200, auth.userDto(c.user)))
  on('GET', '/Users', (c) => sendJson(c.res, 200, [auth.userDto(c.user)]))
  on('GET', '/Users/{userId}', (c) => (c.ownUser() ? sendJson(c.res, 200, auth.userDto(c.user)) : sendEmpty(c.res, 403)))
  on('GET', '/Users/{userId}/GroupingOptions', (c) => sendJson(c.res, 200, []))
  anyOf(['POST', 'DELETE'], '/Users/{userId}/Password', (c) => sendJson(c.res, 403, { Message: 'Change your password in Beebo.' }))

  // ---- browse ----
  const viewsHandler = async (c) => {
    if (c.params.userid && !c.ownUser()) return sendEmpty(c.res, 403)
    const list = await items.views(c.user, c.req)
    sendJson(c.res, 200, items.page(list, 0))
  }
  on('GET', '/UserViews', viewsHandler)
  on('GET', '/Users/{userId}/Views', viewsHandler)

  const queryHandler = async (c) => {
    if (c.params.userid && !c.ownUser()) return sendEmpty(c.res, 403)
    sendJson(c.res, 200, await items.query(c.user, c.q, c.req))
  }
  on('GET', '/Items', queryHandler)
  on('GET', '/Users/{userId}/Items', queryHandler)

  const latestHandler = async (c) => {
    if (c.params.userid && !c.ownUser()) return sendEmpty(c.res, 403)
    sendJson(c.res, 200, await items.latest(c.user, c.q, c.req))
  }
  on('GET', '/Items/Latest', latestHandler)
  on('GET', '/Users/{userId}/Items/Latest', latestHandler)

  const resumeHandler = async (c) => {
    if (c.params.userid && !c.ownUser()) return sendEmpty(c.res, 403)
    sendJson(c.res, 200, await items.resume(c.user, c.q, c.req))
  }
  on('GET', '/Items/Resume', resumeHandler)
  on('GET', '/UserItems/Resume', resumeHandler)
  on('GET', '/Users/{userId}/Items/Resume', resumeHandler)

  on('GET', '/Items/Filters', async (c) => sendJson(c.res, 200, await items.filtersLegacy(c.user, c.q, c.req)))
  on('GET', '/Items/Filters2', async (c) => sendJson(c.res, 200, await items.filters2(c.user, c.q, c.req)))

  // Registered before /Items/{itemId} so that "Suggestions" is never mistaken for an item id.
  const suggestionsHandler = async (c) => {
    if (c.params.userid && !c.ownUser()) return sendEmpty(c.res, 403)
    sendJson(c.res, 200, await items.suggestions(c.user, c.q, c.req))
  }
  on('GET', '/Items/Suggestions', suggestionsHandler)
  on('GET', '/Suggestions', suggestionsHandler)
  on('GET', '/Users/{userId}/Suggestions', suggestionsHandler)
  on('GET', '/Items/Root', async (c) => sendJson(c.res, 200, await items.detail(c.user, ids.encode('view', 0), c.req) || { Name: 'Media Folders', Id: items.rootJid, Type: 'AggregateFolder', IsFolder: true, ServerId: auth.serverId() }))
  on('GET', '/Items/Counts', async (c) => {
    const snap = await catalog.getSnapshot(c.user, c.req)
    const eps = await catalog.getAllEpisodes(c.user, c.req)
    const music = await catalog.getMusic(c.user, c.req)
    sendJson(c.res, 200, { MovieCount: snap.movies.length, SeriesCount: snap.shows.length, EpisodeCount: eps.episodes.length, ArtistCount: music.artists.length, ProgramCount: 0, TrailerCount: 0, SongCount: music.tracks.length, AlbumCount: music.albums.length, MusicVideoCount: 0, BoxSetCount: snap.boxsets.length, BookCount: 0, ItemCount: snap.movies.length + snap.shows.length + eps.episodes.length + music.tracks.length })
  })
  on('GET', '/MusicGenres', async (c) => sendJson(c.res, 200, await items.musicGenres(c.user, c.q, c.req)))
  on('GET', '/Playback/BitrateTest', (c) => {
    // A few bytes of noise so an app can time the connection; capped, and only for signed-in people.
    const size = Math.min(Math.max(c.q.int('size', 102400), 1), 10 * 1024 * 1024)
    const buf = require('crypto').randomBytes(size)
    c.res.writeHead(200, { ...CORS, 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length, 'Cache-Control': 'no-store' })
    c.res.end(buf)
  })
  anyOf(['DELETE'], '/Videos/ActiveEncodings', (c) => sendEmpty(c.res, 204))
  anyOf(['POST'], '/Users/Configuration', (c) => sendEmpty(c.res, 204))
  anyOf(['POST'], '/Users/{userId}/Configuration', (c) => sendEmpty(c.res, 204))
  // Answers an app's item page may ask for and that Beebo has nothing for (empty, so the page still draws).
  on('GET', '/Videos/{itemId}/AdditionalParts', async (c) => { if (await requireEntry(c)) sendJson(c.res, 200, items.page([], 0)) })
  on('GET', '/Items/{itemId}/Collections', async (c) => { if (await requireEntry(c)) sendJson(c.res, 200, items.page([], 0)) })
  on('GET', '/Audio/{itemId}/Lyrics', (c) => sendJson(c.res, 404, { Message: 'No lyrics.' }))
  anyOf(['GET'], '/FallbackFont/Fonts', (c) => sendJson(c.res, 200, []))
  // Findroid renames its own device this way; the name is only kept in the app.
  anyOf(['POST'], '/Devices/Options', (c) => sendEmpty(c.res, 204))
  // Sign-out by key: an app may only end its own sign-in (making or listing keys is an administrator's job in Jellyfin, and is not offered).
  on('GET', '/Auth/Keys', (c) => sendJson(c.res, 403, { Message: 'Not available.' }))
  on('DELETE', '/Auth/Keys/{key}', (c) => {
    if (c.params.key !== c.token) return sendJson(c.res, 403, { Message: 'An app can only sign itself out.' })
    auth.revoke(c.token, c.user)
    sendEmpty(c.res, 204)
  })

  const detailHandler = async (c) => {
    if (c.params.userid && !c.ownUser()) return sendEmpty(c.res, 403)
    const dto = await items.detail(c.user, c.params.itemid, c.req)
    if (!dto) return sendJson(c.res, 404, { Message: 'Item not found.' })
    sendJson(c.res, 200, dto)
  }
  on('GET', '/Items/{itemId}', detailHandler)
  on('GET', '/Users/{userId}/Items/{itemId}', detailHandler)

  const requireEntry = async (c) => {
    const entry = await catalog.resolve(c.user, c.params.itemid, c.req)
    if (!entry) { sendJson(c.res, 404, { Message: 'Item not found.' }); return null }
    return entry
  }
  const emptyItems = (c) => sendJson(c.res, 200, items.page([], 0))
  const emptyArray = (c) => sendJson(c.res, 200, [])
  on('GET', '/Items/{itemId}/Ancestors', async (c) => { if (await requireEntry(c)) sendJson(c.res, 200, []) })
  for (const tail of ['Intros']) {
    on('GET', '/Items/{itemId}/' + tail, async (c) => { if (await requireEntry(c)) emptyItems(c) })
    on('GET', '/Users/{userId}/Items/{itemId}/' + tail, async (c) => { if (await requireEntry(c)) emptyItems(c) })
  }
  const similarHandler = async (c) => {
    const entry = await requireEntry(c)
    if (entry) sendJson(c.res, 200, await items.similar(c.user, entry, c.q, c.req))
  }
  for (const base of ['/Items/{itemId}', '/Users/{userId}/Items/{itemId}', '/Movies/{itemId}', '/Shows/{itemId}', '/Albums/{itemId}', '/Artists/{itemId}']) on('GET', base + '/Similar', similarHandler)
  for (const tail of ['ThemeSongs', 'ThemeVideos']) {
    on('GET', '/Items/{itemId}/' + tail, async (c) => { if (await requireEntry(c)) sendJson(c.res, 200, { Items: [], TotalRecordCount: 0, StartIndex: 0 }) })
  }
  // Instant mix: a run of tracks from an album, artist, song, playlist or music genre.
  const mixHandler = async (c) => {
    const entry = await requireEntry(c)
    if (entry) sendJson(c.res, 200, await items.instantMix(c.user, entry, c.q, c.req))
  }
  for (const base of ['/Items/{itemId}', '/Songs/{itemId}', '/Albums/{itemId}', '/Artists/{itemId}']) on('GET', base + '/InstantMix', mixHandler)
  on('GET', '/Playlists/{itemId}/InstantMix', mixHandler, { caseSensitive: true })
  const genreMix = async (c) => {
    const d = idsLib.decodeNumeric(c.q('id') || '')
    const music = await catalog.getMusic(c.user, c.req)
    const name = c.params.name
    const g = d && d.kind === 'genre' ? music.genres.find((x) => x.number === d.number) : music.genres.find((x) => x.name.toLowerCase() === String(name || '').toLowerCase())
    if (!g) return sendJson(c.res, 404, { Message: 'Genre not found.' })
    sendJson(c.res, 200, await items.instantMix(c.user, { type: 'Genre', jid: g.jid, number: g.number }, c.q, c.req))
  }
  on('GET', '/MusicGenres/InstantMix', genreMix)
  on('GET', '/MusicGenres/{name}/InstantMix', genreMix)
  for (const tail of ['LocalTrailers', 'SpecialFeatures']) {
    on('GET', '/Items/{itemId}/' + tail, async (c) => { if (await requireEntry(c)) emptyArray(c) })
    on('GET', '/Users/{userId}/Items/{itemId}/' + tail, async (c) => { if (await requireEntry(c)) emptyArray(c) })
  }
  on('GET', '/Items/{itemId}/ThemeMedia', async (c) => {
    if (!(await requireEntry(c))) return
    const empty = { Items: [], TotalRecordCount: 0, OwnerId: c.params.itemid }
    sendJson(c.res, 200, { ThemeVideosResult: empty, ThemeSongsResult: empty, SoundtrackSongsResult: empty })
  })
  on('GET', '/MediaSegments/{itemId}', async (c) => {
    const entry = await requireEntry(c)
    if (!entry) return
    const list = segments ? await segments.forEntry(c.user, entry, c.q, c.req) : []
    sendJson(c.res, 200, items.page(list, 0))
  })
  // Seek-bar preview tiles built from Beebo's own preview frames (trickplay.js).
  on('GET', '/Videos/{itemId}/Trickplay/{width}/tiles.m3u8', async (c) => {
    const entry = await catalog.resolve(c.user, c.params.itemid, c.req)
    if (!entry || (entry.type !== 'Movie' && entry.type !== 'Episode') || !trickplay) return sendEmpty(c.res, 404)
    return trickplay.playlist(c.user, entry, c.params.width, c)
  })
  anyOf(['GET', 'HEAD'], '/Videos/{itemId}/Trickplay/{width}/{index}.jpg', async (c) => {
    const entry = await catalog.resolve(c.user, c.params.itemid, c.req)
    if (!entry || (entry.type !== 'Movie' && entry.type !== 'Episode') || !trickplay) return sendEmpty(c.res, 404)
    return trickplay.serveSheet(c.user, entry, c.params.width, c.params.index, c)
  })
  anyOf(['GET'], '/Items/{itemId}/Images', async (c) => {
    const entry = await requireEntry(c)
    if (entry) sendJson(c.res, 200, images.list(entry.jid))
  })
  anyOf(['GET'], '/Items/{itemId}/Download', (c) => sendJson(c.res, 403, { Message: 'Downloads are not available.' }))

  on('GET', '/Shows/NextUp', async (c) => sendJson(c.res, 200, await items.nextUp(c.user, c.q, c.req)))
  on('GET', '/Shows/Upcoming', emptyItems)
  on('GET', '/Shows/{itemId}/Seasons', async (c) => {
    const out = await items.seasonsOf(c.user, c.params.itemid, c.q, c.req)
    if (!out) return sendJson(c.res, 404, { Message: 'Item not found.' })
    sendJson(c.res, 200, out)
  })
  on('GET', '/Shows/{itemId}/Episodes', async (c) => {
    const out = await items.episodesOf(c.user, c.params.itemid, c.q, c.req)
    if (!out) return sendJson(c.res, 404, { Message: 'Item not found.' })
    sendJson(c.res, 200, out)
  })

  on('GET', '/Genres', async (c) => sendJson(c.res, 200, await items.genresList(c.user, c.q, c.req)))
  on('GET', '/Search/Hints', async (c) => sendJson(c.res, 200, await items.searchHints(c.user, c.q, c.req)))
  anyOf(['GET'], '/Artists', async (c) => sendJson(c.res, 200, await items.artists(c.user, c.q, c.req)))
  anyOf(['GET'], '/Artists/AlbumArtists', async (c) => sendJson(c.res, 200, await items.artists(c.user, c.q, c.req)))
  for (const p of ['/Persons', '/Studios', '/Years', '/Trailers', '/Channels', '/LiveTv/Channels', '/LiveTv/Programs', '/LiveTv/Programs/Recommended', '/LiveTv/Recordings', '/Devices', '/Library/MediaFolders']) {
    on('GET', p, emptyItems)
  }
  for (const p of ['/Playlists', '/Collections']) on('GET', p, emptyItems, { caseSensitive: true })
  // Beebo's playlists as Jellyfin playlists (read only here; making and editing them is done in Beebo).
  const playlistOf = async (c) => {
    const entry = await catalog.resolve(c.user, c.params.playlistid || c.params.itemid, c.req)
    if (!entry || entry.type !== 'Playlist') { sendJson(c.res, 404, { Message: 'Playlist not found.' }); return null }
    return entry
  }
  on('GET', '/Playlists/{playlistId}', async (c) => {
    const entry = await playlistOf(c)
    if (!entry) return
    const list = await catalog.getPlaylistItems(c.user, entry, c.req)
    sendJson(c.res, 200, { OpenAccess: false, Shares: [], ItemIds: list.map((e) => e.jid) })
  }, { caseSensitive: true })
  on('GET', '/Playlists/{playlistId}/Items', async (c) => {
    const entry = await playlistOf(c)
    if (!entry) return
    const list = await catalog.getPlaylistItems(c.user, entry, c.req)
    const start = Math.max(0, c.q.int('startIndex', 0))
    const limit = c.q.int('limit', 0)
    const dtos = await items.toDtos(c.user, list.slice(start, limit > 0 ? start + limit : undefined), c.req)
    for (const d of dtos) d.PlaylistItemId = d.Id
    sendJson(c.res, 200, items.page(dtos, start, list.length))
  }, { caseSensitive: true })
  anyOf(['POST', 'DELETE'], '/Playlists', (c) => sendJson(c.res, 403, { Message: 'Make and change playlists in Beebo.' }), { caseSensitive: true })
  anyOf(['POST', 'DELETE'], '/Playlists/{playlistId}/Items', (c) => sendJson(c.res, 403, { Message: 'Make and change playlists in Beebo.' }), { caseSensitive: true })
  on('GET', '/Movies/Recommendations', emptyArray)
  for (const p of ['/Plugins', '/Packages', '/ScheduledTasks', '/Library/VirtualFolders', '/Localization/Cultures', '/Localization/Countries', '/Localization/ParentalRatings', '/Notifications/Services', '/Repositories']) {
    on('GET', p, emptyArray)
  }
  on('GET', '/Localization/Options', emptyArray)
  on('GET', '/LiveTv/Info', (c) => sendJson(c.res, 200, { Services: [], IsEnabled: false, EnabledUsers: [] }))

  // ---- playback ----
  const playbackInfoHandler = async (c) => {
    const entry = await requireEntry(c)
    if (!entry) return
    const body = c.req.method === 'POST' ? await readBody(c.req) : {}
    sendJson(c.res, 200, await playback.playbackInfo(c.user, entry, { req: c.req, body, q: c.q, token: c.token, device: c.device }))
  }
  anyOf(['GET', 'POST'], '/Items/{itemId}/PlaybackInfo', playbackInfoHandler)

  const withVideo = (fn) => async (c) => {
    const entry = await catalog.resolve(c.user, c.params.itemid, c.req)
    if (!entry || (entry.type !== 'Movie' && entry.type !== 'Episode')) return sendEmpty(c.res, 404)
    return fn(entry, c)
  }
  const master = withVideo((entry, c) => playback.hlsMaster(c.user, entry, c))
  anyOf(['GET', 'HEAD'], '/Videos/{itemId}/master.m3u8', master)
  anyOf(['GET', 'HEAD'], '/Videos/{itemId}/main.m3u8', master)
  const videoStream = withVideo(async (entry, c) => {
    if (c.q.bool('static')) return playback.directStream(c.user, entry, c)
    c.res.writeHead(302, { ...CORS, Location: '/Videos/' + entry.jid + '/master.m3u8' + (c.url.search || '') })
    c.res.end()
  })
  anyOf(['GET', 'HEAD'], '/Videos/{itemId}/stream', videoStream)
  anyOf(['GET', 'HEAD'], '/Videos/{itemId}/stream.{container}', videoStream)
  const subtitles = withVideo((entry, c) => playback.subtitleStream(c.user, entry, Number(c.params.index), c.params.format, c))
  anyOf(['GET'], '/Videos/{itemId}/{mediaSourceId}/Subtitles/{index}/Stream.{format}', subtitles)
  anyOf(['GET'], '/Videos/{itemId}/{mediaSourceId}/Subtitles/{index}/{startPositionTicks}/Stream.{format}', subtitles)

  // The file itself, as music apps (Finamp) ask for it: the same gated route as Static=true / Audio universal.
  anyOf(['GET', 'HEAD'], '/Items/{itemId}/File', async (c) => {
    const entry = await catalog.resolve(c.user, c.params.itemid, c.req)
    if (!entry) return sendEmpty(c.res, 404)
    if (entry.type === 'Audio') return playback.audioStream(c.user, entry, c, false)
    if (entry.type === 'Movie' || entry.type === 'Episode') return playback.directStream(c.user, entry, c)
    return sendEmpty(c.res, 404)
  })
  const audio = (universal) => async (c) => {
    const entry = await catalog.resolve(c.user, c.params.itemid, c.req)
    if (!entry || entry.type !== 'Audio') return sendEmpty(c.res, 404)
    return playback.audioStream(c.user, entry, c, universal)
  }
  anyOf(['GET', 'HEAD'], '/Audio/{itemId}/stream', audio(false))
  anyOf(['GET', 'HEAD'], '/Audio/{itemId}/stream.{container}', audio(false))
  anyOf(['GET', 'HEAD'], '/Audio/{itemId}/universal', audio(true))

  // ---- progress and marks ----
  const sessionResult = (c, out) => (out.status === 204 ? sendEmpty(c.res, 204) : sendJson(c.res, out.status, { Message: out.status === 404 ? 'Item not found.' : out.status === 403 ? 'Playback is not allowed right now.' : 'Bad request.' }))
  // What the session list (and Home Assistant style dashboards) show as "now playing", and a UserDataChanged push to the person's other apps.
  const reportFlow = (kind) => async (c) => {
    const body = await readBody(c.req)
    const out = await sessions[kind](c.user, body, c.req)
    if (out.status === 204 && out.entry) {
      try {
        const stopped = kind === 'stopped'
        let item
        if (kind === 'start') item = (await items.toDtos(c.user, [out.entry], c.req))[0]
        auth.notePlayback(c.user, c.device, c.ip, { item, stopped, positionTicks: pick(body, 'PositionTicks'), isPaused: pick(body, 'IsPaused') === true, canSeek: pick(body, 'CanSeek'), playMethod: pick(body, 'PlayMethod'), mediaSourceId: pick(body, 'MediaSourceId') })
        if (stopped && hub) {
          const data = await sessions.userDataFor(c.user, out.entry)
          hub.userDataChanged(c.user, [data])
        }
      } catch {}
    }
    sessionResult(c, out)
  }
  on('POST', '/Sessions/Playing', reportFlow('start'))
  on('POST', '/Sessions/Playing/Progress', reportFlow('progress'))
  on('POST', '/Sessions/Playing/Stopped', reportFlow('stopped'))
  on('POST', '/Sessions/Playing/Ping', (c) => sendEmpty(c.res, 204))
  anyOf(['POST'], '/Sessions/Capabilities', (c) => { auth.setCapabilities(c.user, c.device, { PlayableMediaTypes: c.q.list('playableMediaTypes') }); sendEmpty(c.res, 204) })
  anyOf(['POST'], '/Sessions/Capabilities/Full', async (c) => { auth.setCapabilities(c.user, c.device, await readBody(c.req)); sendEmpty(c.res, 204) })
  on('GET', '/Sessions', (c) => {
    auth.touchSession(c.user, c.device, c.ip)
    sendJson(c.res, 200, auth.sessionsFor(c.user))
  })
  on('POST', '/Sessions/Logout', (c) => { auth.revoke(c.token, c.user); sendEmpty(c.res, 204) })

  const played = (value) => async (c) => {
    if (c.params.userid && !c.ownUser()) return sendEmpty(c.res, 403)
    const out = await sessions.setPlayed(c.user, c.params.itemid, value, c.req)
    if (!out) return sendJson(c.res, 404, { Message: 'Item not found.' })
    if (hub) hub.userDataChanged(c.user, [out.userData])
    sendJson(c.res, 200, out.userData)
  }
  const favorite = (value) => async (c) => {
    if (c.params.userid && !c.ownUser()) return sendEmpty(c.res, 403)
    const out = await sessions.setFavorite(c.user, c.params.itemid, value, c.req)
    if (!out) return sendJson(c.res, 404, { Message: 'Item not found.' })
    if (hub) hub.userDataChanged(c.user, [out.userData])
    sendJson(c.res, 200, out.userData)
  }
  on('POST', '/UserPlayedItems/{itemId}', played(true))
  on('DELETE', '/UserPlayedItems/{itemId}', played(false))
  on('POST', '/Users/{userId}/PlayedItems/{itemId}', played(true))
  on('DELETE', '/Users/{userId}/PlayedItems/{itemId}', played(false))
  on('POST', '/UserFavoriteItems/{itemId}', favorite(true))
  on('DELETE', '/UserFavoriteItems/{itemId}', favorite(false))
  on('POST', '/Users/{userId}/FavoriteItems/{itemId}', favorite(true))
  on('DELETE', '/Users/{userId}/FavoriteItems/{itemId}', favorite(false))
  const userData = async (c) => {
    const entry = await requireEntry(c)
    if (entry) sendJson(c.res, 200, await sessions.userDataFor(c.user, entry))
  }
  on('GET', '/UserItems/{itemId}/UserData', userData)
  // Updating an item's data: only the two marks Beebo keeps (watched, favourite) are honoured; resume points come from playback reports.
  on('POST', '/UserItems/{itemId}/UserData', async (c) => {
    const body = await readBody(c.req)
    let out = null
    const played = pick(body, 'Played')
    const fav = pick(body, 'IsFavorite')
    if (typeof played === 'boolean') out = await sessions.setPlayed(c.user, c.params.itemid, played, c.req)
    if (typeof fav === 'boolean') out = await sessions.setFavorite(c.user, c.params.itemid, fav, c.req) || out
    if (!out) {
      const entry = await requireEntry(c)
      if (!entry) return undefined
      return sendJson(c.res, 200, await sessions.userDataFor(c.user, entry))
    }
    if (hub) hub.userDataChanged(c.user, [out.userData])
    return sendJson(c.res, 200, out.userData)
  })
  on('GET', '/Users/{userId}/Items/{itemId}/UserData', userData)

  const displayPrefs = new Map()
  const dpKey = (c) => c.user.id + '|' + c.params.displaypreferencesid + '|' + c.q('client')
  on('GET', '/DisplayPreferences/{displayPreferencesId}', (c) => {
    const saved = displayPrefs.get(dpKey(c))
    sendJson(c.res, 200, saved || { Id: c.params.displaypreferencesid, SortBy: 'SortName', SortOrder: 'Ascending', RememberIndexing: false, PrimaryImageHeight: 250, PrimaryImageWidth: 250, CustomPrefs: {}, ScrollDirection: 'Horizontal', ShowBackdrop: true, RememberSorting: false, ShowSidebar: false, Client: c.q('client') || 'unknown' })
  })
  on('POST', '/DisplayPreferences/{displayPreferencesId}', async (c) => {
    const body = await readBody(c.req)
    displayPrefs.delete(dpKey(c))
    displayPrefs.set(dpKey(c), body)
    if (displayPrefs.size > 2000) displayPrefs.delete(displayPrefs.keys().next().value)
    sendEmpty(c.res, 204)
  })

  // ---- matching ----
  function match(method, pathname) {
    const p = stripPrefix(pathname)
    for (const r of routes) {
      if (r.method !== method) continue
      const m = r.re.exec(p)
      if (m) {
        const params = {}
        r.names.forEach((n, i) => { params[n] = safeDecode(m[i + 1]) })
        return { route: r, params }
      }
    }
    return null
  }

  function claims(pathname) {
    const p = stripPrefix(pathname)
    return routes.some((r) => r.re.test(p))
  }

  async function handle(req, res, url) {
    const method = String(req.method || 'GET').toUpperCase()
    if (!settingEnabled()) {
      sendText(res, 404, 'Not found', 'text/plain; charset=utf-8')
      return true
    }
    if (method === 'OPTIONS') {
      res.writeHead(204, { ...CORS, 'Content-Length': 0 })
      res.end()
      return true
    }
    const hit = match(method === 'HEAD' && !routes.some((r) => r.method === 'HEAD' && r.re.test(stripPrefix(url.pathname))) ? 'GET' : method, url.pathname)
    if (!hit) {
      if (claims(url.pathname)) { sendJson(res, 405, { Message: 'Method not allowed.' }, { Allow: 'GET, POST, DELETE, HEAD, OPTIONS' }); return true }
      sendJson(res, 404, { Message: 'Not found.' })
      return true
    }
    const q = makeQuery(url)
    const creds = readCredentials(req, q)
    const ip = host.clientIp(req)
    const c = { req, res, url, q, params: hit.params, device: creds.device, token: creds.token, ip, user: null, ownUser: () => false }
    try {
      if (!hit.route.anonymous) {
        const user = auth.userForToken(creds.token)
        if (!user || auth.isRevoked(creds.token)) {
          sendJson(res, 401, { Message: 'Unauthorized.' }, { 'WWW-Authenticate': 'MediaBrowser realm="' + PRODUCT_NAME + '"' })
          return true
        }
        c.user = user
        c.ownUser = () => {
          const want = idsLib.normalize(c.params.userid)
          return !!want && want === auth.idFor(user)
        }
        req.beeboUserId = user.id
        auth.touchSession(user, creds.device, ip)
      }
      await hit.route.handler(c)
    } catch (err) {
      try { log('jellyfin compat error: ' + (err && err.message)) } catch {}
      if (!res.headersSent) sendJson(res, 500, { Message: 'Server error.' })
      else { try { res.end() } catch {} }
    }
    return true
  }

  return { handle, claims, match, routes }
}

module.exports = { createRouter, stripPrefix }
