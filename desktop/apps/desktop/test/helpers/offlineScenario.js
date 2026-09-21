'use strict'
// The household scenario used by the offline end-to-end tests (test/offline-e2e.test.js, offline-blackhole.test.js,
// offline-signed-in.test.js): a real server started with every public network address blocked, used the way a
// household uses it. See docs/OFFLINE-FIRST.md.
const assert = require('node:assert/strict')
const { startOfflineHarness } = require('./offlineHarness')

const FAST_MS = 2000
// Playback info and the first converted segment run ffmpeg/ffprobe, and the first look at what this PC's video encoders
// can do can take a minute on a busy computer. That is video work, not the internet, so these steps get a generous
// ceiling (they still must finish, and the run still fails if anything waits on the network: see `outstanding`).
const SLOW_LOCAL_MS = 90000
// Hosts the server may still TRY to reach when it starts with no internet (and why). Anything else fails the test.
const ALLOWED_OUTBOUND = new Set([
  'www.beeboentertainment.com' // the Beebo Relay price list, refreshed every 12 h; a bundled copy is used when it cannot be fetched
])
const BOOT_TIMERS_MS = 14000 // the server starts its background jobs 1 to 12 s after launch (router mapping, agent, pricing)

// Every resource a served page loads by itself (not links a person may click), as absolute URLs.
function loadedUrls(html) {
  const urls = []
  const add = (u) => { if (/^https?:\/\//i.test(u)) urls.push(u) }
  for (const m of html.matchAll(/<(?:img|script|iframe|source|video|audio|embed|object|input|track)\b[^>]*?\b(?:src|poster|data)\s*=\s*["']([^"']+)["']/gi)) add(m[1])
  for (const m of html.matchAll(/<link\b[^>]*?\bhref\s*=\s*["']([^"']+)["']/gi)) add(m[1])
  for (const m of html.matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi)) m[1].split(',').forEach((p) => add(p.trim().split(/\s+/)[0]))
  for (const m of html.matchAll(/url\(\s*["']?([^)"']+)/gi)) add(m[1])
  for (const m of html.matchAll(/@import\s+(?:url\()?\s*["']?([^"')\s;]+)/gi)) add(m[1])
  return urls
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function scenario(t, { mode, key }) {
  const timings = []
  const problems = []
  const h = await startOfflineHarness(t, { mode, extraEnv: key ? { BEEBO_TMDB_API_KEY: key } : {} })
  // On a computer that is busy with other work (a build, another test run) everything is slower, internet or not.
  // The limit is stretched by how slow a plain local ping is, up to 4x, so a loaded PC does not fail a healthy server;
  // a wait for the internet is seconds long or never ends, and is still caught.
  let stretch = 1
  const seen = (label, r, { status = 200, maxMs = FAST_MS } = {}) => {
    timings.push([label, r.status, r.ms])
    if (Array.isArray(status) ? !status.includes(r.status) : r.status !== status) problems.push(`${label}: status ${r.status}, wanted ${status}`)
    if (r.ms > maxMs * stretch) problems.push(`${label}: took ${r.ms} ms, limit ${Math.round(maxMs * stretch)} ms`)
    return r
  }
  const get = async (label, p, o = {}) => seen(label, await h.get(p, o), o)

  // ---- first run and sign-in with a local account (no Beebo account, no internet) ---------------------------------
  const pings = []
  for (let i = 0; i < 5; i++) pings.push((await h.get('/api/ping')).ms)
  pings.sort((a, b) => a - b)
  stretch = Math.min(4, Math.max(1, pings[2] / 30))
  const ping = await get('ping', '/api/ping')
  assert.equal(ping.json.app, 'beeboentertainment')
  const setupPage = await get('first-run setup page', '/setup')
  assert.match(setupPage.text, /Set up Beebo/)
  const owner = await h.setupOwner()
  assert.ok(owner.token, 'a local owner account was created and signed in')
  assert.ok(owner.formStatus === 302 || owner.formStatus === 200, 'the website login form works too')
  const me = await get('/api/me', '/api/me')
  assert.equal(me.json.ok, true)

  // Let the server's first look at its video encoders finish: that is ffmpeg, not the internet, and it is slow on a busy PC.
  await h.waitForEncoderCheck()
  // A moment for the start-up look-ups to have failed, so the pages below run in the state a real offline household is in.
  await wait(key ? 3500 : 500)

  // ---- browse: library from the saved metadata, posters from disk -----------------------------------------------
  const movies = await get('/api/movies', '/api/movies')
  assert.equal(movies.json.items.length, 3)
  const tiny = movies.json.items.find((m) => m.title === 'Tiny Test Movie')
  assert.ok(tiny, 'the film with saved metadata shows its saved title')
  assert.equal(tiny.overview, 'A movie that plays with the internet unplugged.')
  assert.equal(tiny.poster, '/media/poster/900001.jpg', 'its poster is served from this PC')
  for (const m of movies.json.items) assert.ok(m.poster === null || m.poster.startsWith('/'), `${m.title}: the phone API never hands out an internet poster address (${m.poster})`)
  const poster = await get('poster from disk', tiny.poster, { raw: true })
  assert.match(poster.headers['content-type'], /image\/jpeg/)
  const actor = await get('cast photo from disk', '/media/actor/800001.jpg', { raw: true })
  assert.match(actor.headers['content-type'], /image\/jpeg/)
  await get('a poster that was never saved is a plain 404, not a wait', '/media/poster/900003.jpg', { status: 404, raw: true })
  const shows = await get('/api/tvshows', '/api/tvshows')
  assert.equal(shows.json.items[0].name, 'Test Show')
  assert.equal(shows.json.items[0].poster, '/media/poster-tv/900002.jpg')
  await get('tv poster from disk', shows.json.items[0].poster, { raw: true })
  await get('/api/library-status', '/api/library-status')
  await get('/api/continue', '/api/continue')
  await get('/api/recently-added', '/api/recently-added')

  // ---- every page a person can open, and what each one loads by itself -----------------------------------------
  const pages = ['/', '/tvshows', '/music', '/audiobooks', '/photos', '/playlists', '/continue', '/surprise', '/appearance', '/account/security', '/get-app', '/school', '/login', '/privacy', '/watch?id=' + tiny.id]
  const external = []
  for (const p of pages) {
    const r = await get('page ' + p.split('?')[0], p)
    for (const u of loadedUrls(r.text)) external.push([p, u])
    assert.doesNotMatch(r.text, /fonts\.googleapis|gstatic\.com|cdnjs|unpkg\.com|jsdelivr|googletagmanager|google-analytics|bootstrapcdn|fontawesome/i, `${p}: no third-party fonts, libraries or analytics`)
    assert.doesNotMatch(r.text, /\b(?:fetch|XMLHttpRequest[^;]*open)\(\s*["']https?:\/\//, `${p}: no page script calls out to another site`)
  }
  const strangers = external.filter(([, u]) => !/^https:\/\/image\.tmdb\.org\//.test(u))
  assert.deepEqual(strangers, [], 'the only address a page loads from another site is a TMDB poster that is not saved on this PC')
  const home = await get('page / (again)', '/')
  assert.match(home.text, /data-offline-fallback/, 'a poster that cannot load from the internet becomes a plain poster shape, not a broken image')
  assert.equal(external.filter(([p]) => p !== '/').length, 0, 'only the library grid ever points at a TMDB poster, and only for a title whose poster was never saved')
  assert.match(home.text, /\/media\/poster\/900001\.jpg/)
  const hls = await get('hls.js is served from this PC', '/hls/hls.min.js', { raw: true })
  assert.ok(hls.buf.length > 100000)

  // ---- playback: direct file, HLS, subtitles ---------------------------------------------------------------------
  const direct = await get('direct stream (range)', tiny.stream, { status: 206, headers: { Range: 'bytes=0-1023' }, raw: true })
  assert.equal(direct.buf.length, 1024)
  const info = await get('playback info', '/api/playback/info?kind=movie&id=' + tiny.id, { maxMs: SLOW_LOCAL_MS, timeoutMs: SLOW_LOCAL_MS + 10000 })
  assert.equal(info.json.ok, true)
  const subs = await get('subtitle list', '/api/subtitles?kind=movie&id=' + tiny.id)
  assert.equal(subs.json.tracks.length, 1)
  const vtt = await get('subtitle file (saved next to the film)', subs.json.tracks[0].url)
  assert.match(vtt.text, /^WEBVTT/)
  assert.match(vtt.text, /Hello from the sidecar file/)
  const online = await get('online subtitle search with no key', '/api/subtitles/online?kind=movie&id=' + tiny.id)
  assert.equal(online.json.ok, false, 'answers "not set up" at once instead of waiting for a website')
  if (h.fixture.hasFfmpeg) {
    const slowOpts = { timeoutMs: SLOW_LOCAL_MS + 10000 }
    const began = seen('HLS start', await h.post('/api/playback/start', { kind: 'movie', id: tiny.id, quality: '480p' }, slowOpts), { maxMs: SLOW_LOCAL_MS })
    assert.match(began.json.url, /^\/hls\/.+\/index\.m3u8$/)
    const playlist = seen('HLS playlist', await h.get(began.json.url, slowOpts), { maxMs: SLOW_LOCAL_MS })
    assert.match(playlist.text, /#EXTM3U/)
    const seg = seen('HLS first segment', await h.get(began.json.url.replace('index.m3u8', 'seg-0.ts'), { raw: true, ...slowOpts }), { maxMs: SLOW_LOCAL_MS })
    assert.equal(seg.buf[0], 0x47, 'a real MPEG-TS segment')
    await h.post('/api/playback/stop', { ticket: began.json.ticket })
  }

  // ---- music and audiobooks ---------------------------------------------------------------------------------------
  // (Without ffmpeg on this machine the song and the book are placeholder bytes that no tag reader will accept.)
  const tracks = await get('music tracks', '/api/music/tracks')
  await h.post('/api/audiobooks/rescan', {})
  if (h.fixture.hasFfmpeg) {
    assert.equal(tracks.json.items.length, 1)
    const song = await get('music stream (range)', tracks.json.items[0].stream, { status: 206, headers: { Range: 'bytes=0-99' }, raw: true })
    assert.equal(song.buf.length, 100)
    let books = null
    for (let i = 0; i < 40 && !(books && books.json.items.length); i++) { await wait(250); books = await h.get('/api/audiobooks/books') }
    assert.equal(books.json.items.length, 1, 'the audiobook shelf finds its books from disk alone')
    seen('audiobook list', books)
    const book = await get('audiobook stream (range)', `/api/audiobooks/book/${books.json.items[0].id}/stream`, { status: 206, headers: { Range: 'bytes=0-99' }, raw: true })
    assert.equal(book.buf.length, 100)
  } else {
    await get('audiobook list', '/api/audiobooks/books')
  }

  // ---- settings and the owner's screens (https only) -----------------------------------------------------------------
  for (const p of ['/api/admin/settings', '/api/admin/summary', '/api/admin/dashboard', '/admin']) await get('owner ' + p, p, { secure: true })

  // ---- the internet is still gone at the end, and nothing waited for it ---------------------------------------------
  await wait(BOOT_TIMERS_MS)
  const after = await get('/api/ping after the background jobs ran', '/api/ping')
  assert.equal(after.json.app, 'beeboentertainment')
  await get('page / after the background jobs ran', '/')

  const attempted = h.publicAttempts()
  const surprises = attempted.filter((a) => !ALLOWED_OUTBOUND.has(a.target.replace(/:\d+$/, '')) && !(key && /^api\.themoviedb\.org/.test(a.target)))
  const outstanding = h.outstanding()
  t.diagnostic(`${mode}: ${timings.length} requests, slowest ${Math.max(...timings.map((x) => x[2]))} ms; outbound attempts: ${attempted.map((a) => `${a.kind} ${a.target} x${a.count}`).join(', ') || 'none'}; still waiting: ${outstanding.length}; most waiting on one host at once: ${h.peakConcurrentHung()}`)
  return { h, timings, problems, attempted, surprises, outstanding }
}

module.exports = { scenario, loadedUrls, wait, FAST_MS, SLOW_LOCAL_MS, ALLOWED_OUTBOUND, BOOT_TIMERS_MS }
