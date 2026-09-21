// The main-process side of the details page (electron/detailsIpc.js): how Play
// reaches a player with the chosen audio/subtitles, how the trailer address is
// built (never from a renderer-supplied URL), which files may be named, and the
// owner's watched / watchlist marks. Electron, the store and TMDB are faked.
// Run: node --test test/details-ipc.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const ipc = require('../electron/detailsIpc')
const watchedState = require('../electron/watchedState')
const { playbackPanelHtml } = require('../electron/playbackWebUi')

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url')

test('playerPath: the movie id, where to start, and the track choice as query parameters', () => {
  const p = ipc.playerPath({ kind: 'movie', fileName: 'Film (2010).mkv', audioStreamIndex: 2, subtitleKey: 'emb:5', startSeconds: 1234.9 })
  assert.equal(p, `/watch?id=${b64('Film (2010).mkv')}&t=1234&pbAudio=2&pbSub=emb%3A5`)
  const u = new URL(p, 'http://x')
  assert.equal(u.searchParams.get('pbAudio'), '2')
  assert.equal(u.searchParams.get('pbSub'), 'emb:5')
})

test('playerPath: episodes use /tvwatch, and nothing is added for choices that were not made', () => {
  assert.equal(ipc.playerPath({ kind: 'tv', fileName: 'Show/S01/e1.mkv' }), `/tvwatch?id=${b64('Show/S01/e1.mkv')}`)
  assert.equal(ipc.playerPath({ kind: 'movie', fileName: 'a.mkv', audioStreamIndex: null, subtitleKey: null, startSeconds: 0 }), `/watch?id=${b64('a.mkv')}`)
})

test('playerPath: only well-formed track choices are passed on', () => {
  const bad = ['emb:5&x=1', 'side:en#0;', '../../x', 'off ', '<script>', 'emb:', 'side:#']
  for (const s of bad) assert.ok(!ipc.playerPath({ kind: 'movie', fileName: 'a.mkv', subtitleKey: s }).includes('pbSub'), s)
  for (const s of ['off', 'emb:12', 'side:en#0', 'side:#1', 'side:pt-br#2']) assert.ok(ipc.playerPath({ kind: 'movie', fileName: 'a.mkv', subtitleKey: s }).includes('pbSub'), s)
  assert.ok(!ipc.playerPath({ kind: 'movie', fileName: 'a.mkv', audioStreamIndex: -1 }).includes('pbAudio'))
  assert.ok(!ipc.playerPath({ kind: 'movie', fileName: 'a.mkv', audioStreamIndex: 1.5 }).includes('pbAudio'))
  assert.ok(!ipc.playerPath({ kind: 'movie', fileName: 'a.mkv', audioStreamIndex: '2' }).includes('pbAudio'))
})

test('trailerUrl: a valid YouTube key gives the watch page', () => {
  assert.equal(ipc.trailerUrl({ youtubeKey: 'YoHD9XEInc0', title: 'Inception', year: '2010' }), 'https://www.youtube.com/watch?v=YoHD9XEInc0')
})

test('trailerUrl: no key means a YouTube search for "<title> <year> trailer"', () => {
  const u = new URL(ipc.trailerUrl({ title: 'Inception', year: '2010' }))
  assert.equal(u.origin, 'https://www.youtube.com')
  assert.equal(u.pathname, '/results')
  assert.equal(u.searchParams.get('search_query'), 'Inception 2010 trailer')
})

test('trailerUrl: a bad key never becomes part of a URL, and odd titles cannot change where it goes', () => {
  for (const key of ['bad key', 'a&b', '../x', '<x>', 'x'.repeat(40), '', 5, null, {}]) {
    const url = ipc.trailerUrl({ youtubeKey: key, title: 'T', year: 2001 })
    assert.match(url, /^https:\/\/www\.youtube\.com\/results\?search_query=/)
  }
  const nasty = 'Film & Friends #1?x=1\nhttp://evil.example/'
  const u = new URL(ipc.trailerUrl({ title: nasty, year: '1999' }))
  assert.equal(u.origin, 'https://www.youtube.com')
  assert.equal([...u.searchParams.keys()].join(','), 'search_query')
  assert.equal(u.searchParams.get('search_query').includes('\n'), false)
  assert.equal(u.hash, '')
  assert.equal(ipc.trailerUrl({ title: '   ' }), null)
  assert.equal(ipc.trailerUrl({}), null)
  assert.equal(ipc.trailerUrl(), null)
  const long = new URL(ipc.trailerUrl({ title: 'x'.repeat(5000) }))
  assert.ok(long.searchParams.get('search_query').length < 230)
  assert.equal(new URL(ipc.trailerUrl({ title: 'T', year: 'javascript:1' })).searchParams.get('search_query'), 'T trailer')
})

test('libraryFile: only files inside a managed folder may be named', () => {
  const movies = path.join(os.tmpdir(), 'lib-movies')
  const tv = path.join(os.tmpdir(), 'lib-tv')
  const roots = [movies, tv, null]
  assert.equal(ipc.libraryFile(path.join(movies, 'a.mkv'), roots), path.join(movies, 'a.mkv'))
  assert.equal(ipc.libraryFile(path.join(tv, 'Show', 'e.mkv'), roots), path.join(tv, 'Show', 'e.mkv'))
  assert.equal(ipc.libraryFile(path.join(movies, '..', 'elsewhere', 'a.mkv'), roots), null)
  assert.equal(ipc.libraryFile(path.join(os.tmpdir(), 'lib-movies-evil', 'a.mkv'), roots), null, 'a folder that merely starts with the same letters')
  assert.equal(ipc.libraryFile(path.join(movies, 'a\0.mkv'), roots), null)
  for (const bad of ['', null, undefined, 5, {}, 'x'.repeat(5000)]) assert.equal(ipc.libraryFile(bad, roots), null)
})

test('buildLibrarySnapshot: owned movies and shows that TMDB knows, with episode numbers', () => {
  const snap = ipc.buildLibrarySnapshot({
    movieFiles: [{ path: '/m/Film (2010).mkv', fileName: 'Film (2010).mkv' }, { path: '/m/Unknown.mkv', fileName: 'Unknown.mkv' }],
    tvFiles: [
      { path: '/t/House/Season 1/House.S01E01.mkv', fileName: 'House.S01E01.mkv', relPath: 'House/Season 1/House.S01E01.mkv' },
      { path: '/t/House/Season 1/House.S01E02.mkv', fileName: 'House.S01E02.mkv', relPath: 'House/Season 1/House.S01E02.mkv' },
      { path: '/t/House/Extras/behind the scenes.mkv', fileName: 'behind the scenes.mkv', relPath: 'House/Extras/behind the scenes.mkv' },
      { path: '/t/Nobody/Nobody.S01E01.mkv', fileName: 'Nobody.S01E01.mkv', relPath: 'Nobody/Nobody.S01E01.mkv' }
    ],
    movieManifest: { 'Film (2010).mkv': { id: 27205, title: 'Inception', release_date: '2010-07-15', poster_path: '/p.jpg' }, 'Unknown.mkv': null },
    tvManifest: { house: { id: 1408, name: 'House', poster_path: '/h.jpg' }, nobody: null }
  })
  assert.deepEqual(snap.movies.map((m) => [m.tmdbId, m.title, m.year]), [[27205, 'Inception', '2010']])
  assert.equal(snap.shows.length, 1)
  assert.equal(snap.shows[0].tmdbId, 1408)
  assert.deepEqual(snap.shows[0].episodes.map((e) => [e.season, e.episode]), [[1, 1], [1, 2]], 'a file with no episode number is not an appearance')
  assert.deepEqual(ipc.buildLibrarySnapshot({}), { movies: [], shows: [] })
})

// ---- the handlers -----------------------------------------------------------------------------------
function fakeStore(initial = {}) {
  const data = { ...initial }
  return { get: (k) => (k in data ? JSON.parse(JSON.stringify(data[k])) : undefined), set: (k, v) => { data[k] = JSON.parse(JSON.stringify(v)) }, data }
}

function harness(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-detailsipc-'))
  const movies = path.join(dir, 'Movies')
  fs.mkdirSync(movies)
  const movie = path.join(movies, 'Film (2010).mkv')
  fs.writeFileSync(movie, 'x')
  const handlers = new Map()
  const opened = { path: [], external: [], windows: [], cookies: [], loaded: [] }
  const store = fakeStore({ users: [] })
  const users = [{ id: 'kid', isAdmin: false, status: 'approved' }, { id: 'owner', isAdmin: true, status: 'approved' }]
  class FakeWindow {
    constructor(opts) {
      opened.windows.push(opts)
      this.webContents = { session: { cookies: { set: async (c) => { opened.cookies.push(c) } } } }
    }
    async loadURL(u) { opened.loaded.push(u) }
  }
  const trailerCalls = []
  const deps = {
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    shell: { openPath: async (p) => { opened.path.push(p); return '' }, openExternal: (u) => { opened.external.push(u) } },
    BrowserWindow: FakeWindow,
    store,
    auth: { getUsers: () => users, signSession: (s, id) => `signed-for-${id}` },
    history: { resumeFor: (s, id, fileName) => (fileName === 'Film (2010).mkv' && id === 'owner' ? { currentTime: 600, duration: 5400 } : null) },
    watchedState,
    details: { movie: async () => ({ ok: true, data: { cast: [{ id: 1 }, { id: 2 }] } }), tv: async () => ({ ok: true, data: {} }), tvSeason: async () => ({}), tvEpisode: async () => ({}), person: async () => ({ ok: true, data: { id: 9 } }) },
    mediaInfo: { info: async (p) => ({ ok: true, echoed: p }) },
    // The Trailers service (trailersBrowse.js) opens the browser itself; this fake records what it was asked.
    trailersService: {
      watchTrailer: async (req) => {
        trailerCalls.push(req)
        if (overrides.watch instanceof Error) throw overrides.watch
        return overrides.watch === undefined ? { ok: true, opened: 'trailer', name: 'T' } : overrides.watch
      }
    },
    tmdbCache: { localActorPhotoPath: (dir2, id) => (id === 2 ? '/cache/actors/2.jpg' : null), getManifest: () => ({}), getTvManifest: () => ({}) },
    getCacheDir: () => path.join(dir, 'cache'),
    getStreamPort: () => 4321,
    getMoviesDirs: () => [movies],
    getTvDirs: () => [],
    scanMovies: async () => [],
    scanTv: async () => []
  }
  ipc.register({ ...deps, ...(overrides.deps || {}) })
  return { handlers, opened, movie, store, trailerCalls, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}
const call = (h, name, arg) => h.handlers.get(name)({}, arg)

test('Play with nothing special asked for opens the computer\'s own player, as clicking a poster always did', async () => {
  const h = harness()
  try {
    const r = await call(h, 'details:play', { kind: 'movie', path: h.movie, fileName: 'Film (2010).mkv' })
    assert.deepEqual(r, { ok: true, via: 'system' })
    assert.deepEqual(h.opened.path, [path.resolve(h.movie)])
    assert.equal(h.opened.windows.length, 0)
  } finally { h.cleanup() }
})

test('Play with an audio track chosen opens the web player signed in as the owner, with that track in the address', async () => {
  const h = harness()
  try {
    const r = await call(h, 'details:play', { kind: 'movie', path: h.movie, fileName: 'Film (2010).mkv', audioStreamIndex: 2, subtitleKey: 'emb:5', title: 'Inception' })
    assert.deepEqual(r, { ok: true, via: 'web-player' })
    assert.equal(h.opened.path.length, 0)
    assert.equal(h.opened.cookies[0].value, 'signed-for-owner')
    assert.equal(h.opened.cookies[0].url, 'http://127.0.0.1:4321')
    assert.equal(h.opened.cookies[0].httpOnly, true)
    const u = new URL(h.opened.loaded[0])
    assert.equal(u.origin, 'http://127.0.0.1:4321')
    assert.equal(u.pathname, '/watch')
    assert.equal(u.searchParams.get('pbAudio'), '2')
    assert.equal(u.searchParams.get('pbSub'), 'emb:5')
    assert.equal(Buffer.from(u.searchParams.get('id'), 'base64url').toString(), 'Film (2010).mkv')
    assert.equal(h.opened.windows[0].webPreferences.nodeIntegration, false)
    assert.equal(h.opened.windows[0].webPreferences.contextIsolation, true)
  } finally { h.cleanup() }
})

test('Resume goes through the web player at the saved position; subtitles Off alone do not need it', async () => {
  const h = harness()
  try {
    await call(h, 'details:play', { kind: 'movie', path: h.movie, fileName: 'Film (2010).mkv', startSeconds: 600 })
    assert.equal(new URL(h.opened.loaded[0]).searchParams.get('t'), '600')
    const off = await call(h, 'details:play', { kind: 'movie', path: h.movie, fileName: 'Film (2010).mkv', subtitleKey: 'off' })
    assert.equal(off.via, 'system')
    await call(h, 'details:play', { kind: 'movie', path: h.movie, fileName: 'Film (2010).mkv', audioStreamIndex: 3, subtitleKey: 'off' })
    assert.equal(new URL(h.opened.loaded[1]).searchParams.get('pbSub'), 'off', 'an explicit Off overrides remembered subtitles in the player')
  } finally { h.cleanup() }
})

test('Play refuses a file outside the library and one that does not exist', async () => {
  const h = harness()
  try {
    assert.equal((await call(h, 'details:play', { kind: 'movie', path: path.join(os.tmpdir(), 'elsewhere.mkv') })).error, 'not_found')
    assert.equal((await call(h, 'details:play', { kind: 'movie', path: path.join(path.dirname(h.movie), 'missing.mkv') })).error, 'not_found')
    assert.equal((await call(h, 'details:play', {})).error, 'not_found')
    assert.equal(h.opened.path.length + h.opened.windows.length, 0)
  } finally { h.cleanup() }
})

test('a matched title goes to the Trailers service with only its id and kind; a URL from the renderer is ignored', async () => {
  const h = harness()
  try {
    const r = await call(h, 'details:trailer', { kind: 'tv', tmdbId: 1408, title: 'House', year: '2004', url: 'https://evil.example/', youtubeKey: 'evilkey' })
    assert.deepEqual(r, { ok: true, source: 'youtube' })
    assert.deepEqual(h.trailerCalls, [{ tmdbId: 1408, mediaType: 'tv' }], 'exactly { tmdbId, mediaType }, which is all the service accepts')
    assert.deepEqual(h.opened.external, [], 'the service opens the browser, not this handler')
  } finally { h.cleanup() }
})

test('when the Trailers service falls back to a search that is reported as a search', async () => {
  const h = harness({ watch: { ok: true, opened: 'search', title: 'Obscure' } })
  try {
    assert.deepEqual(await call(h, 'details:trailer', { kind: 'movie', tmdbId: 5, title: 'Obscure Film', year: '1971' }), { ok: true, source: 'search' })
    assert.equal(h.opened.external.length, 0)
  } finally { h.cleanup() }
})

test('a title with no TMDB match searches YouTube for "<title> <year> trailer" from the text alone', async () => {
  const h = harness()
  try {
    const r = await call(h, 'details:trailer', { kind: 'movie', title: 'Never Matched', year: '2001' })
    assert.equal(r.source, 'search')
    assert.equal(h.trailerCalls.length, 0, 'no TMDB id, no lookup')
    assert.equal(new URL(h.opened.external[0]).searchParams.get('search_query'), 'Never Matched 2001 trailer')
    assert.equal((await call(h, 'details:trailer', { kind: 'movie' })).ok, false)
    assert.equal(h.opened.external.length, 1)
  } finally { h.cleanup() }
})

test('a failing Trailers service still ends in a YouTube search rather than nothing', async () => {
  for (const watch of [new Error('offline'), { ok: false, error: 'rate_limited' }]) {
    const h = harness({ watch })
    try {
      const r = await call(h, 'details:trailer', { kind: 'movie', tmdbId: 5, title: 'X', year: '2000' })
      assert.equal(r.source, 'search')
      assert.equal(new URL(h.opened.external[0]).hostname, 'www.youtube.com')
    } finally { h.cleanup() }
  }
})

test('media info only answers for files inside the library', async () => {
  const h = harness()
  try {
    assert.equal((await call(h, 'details:mediaInfo', h.movie)).echoed, path.resolve(h.movie))
    assert.deepEqual(await call(h, 'details:mediaInfo', path.join(os.tmpdir(), 'x.mkv')), { ok: false, error: 'bad_path' })
    assert.deepEqual(await call(h, 'details:mediaInfo', '-i evil'), { ok: false, error: 'bad_path' })
  } finally { h.cleanup() }
})

test('cast photos already on disk are served locally; the rest come from TMDB by the renderer', async () => {
  const h = harness()
  try {
    const r = await call(h, 'details:movie', 1)
    assert.equal(r.data.cast[0].localPhotoPath, undefined)
    assert.equal(r.data.cast[1].localPhotoPath, 'http://localhost:4321/media/actor/2.jpg')
  } finally { h.cleanup() }
})

test('the owner\'s watched mark and watchlist entry are written to the same stores the website reads', async () => {
  const h = harness()
  try {
    const key = 'Film (2010).mkv'
    let s = await call(h, 'details:state', { kind: 'movie', fileName: key })
    assert.deepEqual(s, { watched: false, resume: { currentTime: 600, duration: 5400 }, inWatchlist: false })

    await call(h, 'details:setWatched', { kind: 'movie', fileName: key, watched: true })
    assert.equal(watchedState.isWatched(h.store, 'owner', 'movie', key), true)
    assert.equal(watchedState.isWatched(h.store, 'kid', 'movie', key), false, 'only the owner\'s marks are touched')

    await call(h, 'details:setWatchlist', { kind: 'movie', fileName: key, on: true, title: 'Inception', posterPath: '/p.jpg' })
    s = await call(h, 'details:state', { kind: 'movie', fileName: key })
    assert.equal(s.inWatchlist, true)
    assert.equal(s.watched, true)
    const entry = h.store.data.watchlist.owner[0]
    assert.equal(entry.id, b64(key))
    assert.equal(entry.kind, 'movie')
    assert.equal(entry.title, 'Inception')
    assert.equal(entry.poster, 'https://image.tmdb.org/t/p/w300/p.jpg')

    await call(h, 'details:setWatchlist', { kind: 'movie', fileName: key, on: true, title: 'Inception again' })
    assert.equal(h.store.data.watchlist.owner.length, 1, 'adding twice keeps one entry')

    await call(h, 'details:setWatchlist', { kind: 'movie', fileName: key, on: false })
    assert.equal((await call(h, 'details:state', { kind: 'movie', fileName: key })).inWatchlist, false)
    await call(h, 'details:setWatched', { kind: 'movie', fileName: key, watched: false })
    assert.equal(watchedState.isWatched(h.store, 'owner', 'movie', key), false)
  } finally { h.cleanup() }
})

test('a poster path that is not a plain TMDB path is not stored', async () => {
  const h = harness()
  try {
    await call(h, 'details:setWatchlist', { kind: 'movie', fileName: 'a.mkv', on: true, title: 'A', posterPath: 'https://evil.example/x.jpg' })
    assert.equal(h.store.data.watchlist.owner[0].poster, null)
  } finally { h.cleanup() }
})

// ---- the player page reads the track choice ---------------------------------------------------------------
function playerHelpers() {
  const html = playbackPanelHtml({ kind: 'movie', mediaId: 'abc' })
  const grab = (name) => {
    const start = html.indexOf(`function ${name}(`)
    assert.ok(start > 0, `${name} is in the player script`)
    let depth = 0
    for (let i = html.indexOf('{', start); i < html.length; i++) {
      if (html[i] === '{') depth++
      else if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1)
    }
    throw new Error('unbalanced')
  }
  return (search, info) => {
    const ctx = { location: { search }, info, URLSearchParams }
    vm.createContext(ctx)
    vm.runInContext(`${grab('preselect')}\n${grab('preselectedSubtitle')}`, ctx)
    return { preselect: () => JSON.parse(vm.runInContext('JSON.stringify(preselect())', ctx)), subtitle: (k) => JSON.parse(vm.runInContext(`JSON.stringify(preselectedSubtitle(${JSON.stringify(k)}))`, ctx)) }
  }
}

test('the player page reads pbAudio and pbSub from its address, and ignores anything malformed', () => {
  const make = playerHelpers()
  assert.deepEqual(make('?id=x&pbAudio=2&pbSub=emb%3A5', {}).preselect(), { audio: 2, sub: 'emb:5' })
  assert.deepEqual(make('?pbSub=off', {}).preselect(), { audio: null, sub: 'off' })
  assert.deepEqual(make('?pbAudio=0', {}).preselect(), { audio: 0, sub: '' })
  assert.deepEqual(make('?id=x', {}).preselect(), { audio: null, sub: '' })
  assert.deepEqual(make('?pbAudio=abc&pbSub=javascript%3A1', {}).preselect(), { audio: null, sub: '' })
  assert.deepEqual(make('?pbAudio=-1&pbSub=emb%3A1%3Bx', {}).preselect(), { audio: null, sub: '' })
})

test('the player page finds the subtitle track a key names: by stream number, or the nth file of a language', () => {
  const info = {
    subtitles: [
      { key: 'side:0', source: 'sidecar', language: 'fr' },
      { key: 'side:1', source: 'sidecar', language: 'en' },
      { key: 'side:2', source: 'sidecar', language: 'en' },
      { key: 'emb:5', source: 'embedded', language: 'en', streamIndex: 5 }
    ]
  }
  const p = playerHelpers()('', info)
  assert.equal(p.subtitle('emb:5').streamIndex, 5)
  assert.equal(p.subtitle('emb:9'), null)
  assert.equal(p.subtitle('side:en#0').key, 'side:1')
  assert.equal(p.subtitle('side:en#1').key, 'side:2')
  assert.equal(p.subtitle('side:en#2'), null)
  assert.equal(p.subtitle('side:fr#0').key, 'side:0')
  assert.equal(p.subtitle('nonsense'), null)
})

test('the player script starts a conversion when a picture-subtitle or a non-default audio track was pre-chosen', () => {
  const html = playbackPanelHtml({ kind: 'movie', mediaId: 'abc' })
  assert.match(html, /quality === 'original' && audioIdx == null && burnIdx == null/)
  assert.match(html, /audioIdx != null \|\| burnIdx != null/)
  assert.match(html, /prefs\.subtitlesOn && !pre\.sub/)
})
