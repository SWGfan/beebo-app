// The website's Movies page ('/') and TV Shows page ('/tvshows') share one
// layout: the same tab row, the same toolbar (genre chips, search, A-Z bar),
// the same letter sections and the same poster card. A real server on a spare
// port over a fixture library and a fixture TMDB cache. No TMDB key, so no network.
// Run: node --test test/library-layout.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))

// A card with every value and all text taken out: what is left is its shape.
const skeleton = (cardHtml) =>
  cardHtml
    .replace(/\s(href|data-name|id|src|alt|title|data-href)="[^"]*"/g, '')
    .replace(/>[^<]*</g, '><')
    .replace(/\s+/g, ' ')
const firstCard = (html) => (html.match(/<a class="card"[\s\S]*?<\/a>/) || [])[0] || ''
const cardSubs = (html) => [...html.matchAll(/<div class="sub">([^<]*)<\/div>/g)].map((m) => m[1])
const order = (html, needles) => needles.map((n) => html.indexOf(n))

test('Movies and TV Shows pages render the same toolbar, sections and cards', async () => {
  const server = localRequire('./electron/streamServer')
  const auth = localRequire('./electron/auth')
  const savedKey = process.env.TMDB_API_KEY
  delete process.env.TMDB_API_KEY
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'beebo-layout-test-'))
  const movies = path.join(root, 'Movies')
  const tv = path.join(root, 'TV')
  const cacheDir = path.join(root, 'tmdb')
  let info
  try {
    await fs.mkdir(movies, { recursive: true })
    await fs.mkdir(cacheDir, { recursive: true })
    for (const f of ['Alien (1979).mp4', 'Heat (1995).mp4']) await fs.writeFile(path.join(movies, f), 'x')
    await fs.mkdir(path.join(tv, 'Breaking Bad', 'Season 1'), { recursive: true })
    await fs.mkdir(path.join(tv, 'Star Wars Andor'), { recursive: true })
    await fs.writeFile(path.join(tv, 'Breaking Bad', 'Season 1', 'Breaking Bad S01E01.mp4'), 'x')
    await fs.writeFile(path.join(tv, 'Breaking Bad', 'Season 1', 'Breaking Bad S01E02.mp4'), 'x')
    await fs.writeFile(path.join(tv, 'Star Wars Andor', 'Star Wars Andor S01E01.mp4'), 'x')
    await fs.writeFile(path.join(cacheDir, 'manifest.json'), JSON.stringify({
      'Alien (1979).mp4': { id: 348, title: 'Alien', release_date: '1979-05-25', poster_path: null, genre_ids: [28, 12] },
      'Heat (1995).mp4': { id: 949, title: 'Heat', release_date: '1995-12-15', poster_path: null, genre_ids: [80, 18] }
    }))
    await fs.writeFile(path.join(cacheDir, 'tv-manifest.json'), JSON.stringify({
      'breaking bad': { id: 1396, name: 'Breaking Bad', first_air_date: '2008-01-20', poster_path: null, genre_ids: [80, 18] },
      // The folder name and the TMDB title start with different letters.
      'star wars andor': { id: 83867, name: 'Andor', first_air_date: '2022-09-21', poster_path: null, genre_ids: [10759] }
    }))

    const data = {}
    const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
    const { user } = auth.createUser(store, 'Viewer', 'viewer@example.com')
    const port = 47000 + Math.floor(Math.random() * 900) + 50
    info = server.startStreamServer({
      port, store, getMoviesDir: () => movies, getTvShowsDir: () => tv,
      getAllMoviesDirs: () => [movies], getAllTvShowsDirs: () => [tv],
      getTmdbCacheDir: () => cacheDir, log: () => {}
    })
    const base = 'http://127.0.0.1:' + info.port
    for (let i = 0; i < 50; i++) {
      try { await (await fetch(base + '/api/ping')).arrayBuffer(); break } catch { await new Promise((r) => setTimeout(r, 100)) }
    }
    const cookie = 'beebo_session=' + auth.signSession(store, user.id)
    const get = async (p) => {
      const res = await fetch(base + p, { headers: { cookie }, redirect: 'manual' })
      assert.equal(res.status, 200, p)
      return res.text()
    }

    const film = await get('/')
    const shows = await get('/tvshows')

    // Same tab row: the shared tabs come first, in the same order.
    for (const html of [film, shows]) {
      const tabs = html.match(/<div class="tabs beebo-library-tabs">([\s\S]*?)<\/div>/)
      assert.ok(tabs, 'shared tab row')
      const labels = [...tabs[1].matchAll(/class="tab[^"]*">([^<]*)</g)].map((m) => m[1])
      assert.deepEqual(labels.slice(1, 4), ['By Release Date', 'By Actor', '🆕 New'])
      assert.match(labels[0], /^All (Movies|Shows)$/)
    }

    // Same toolbar, in the same order: genre chips, search, A-Z bar, letter sections.
    for (const html of [film, shows]) {
      const at = order(html, ['class="beebo-genres"', '<input id="q"', 'class="beebo-alphabet"', 'id="letter-'])
      assert.ok(at.every((i) => i >= 0), 'toolbar parts present: ' + at)
      assert.deepEqual(at.slice().sort((a, b) => a - b), at, 'toolbar parts in order')
    }

    // Same poster card, down to the markup.
    assert.ok(firstCard(film) && firstCard(shows))
    assert.equal(skeleton(firstCard(film)), skeleton(firstCard(shows)))
    assert.match(firstCard(shows), /info-btn/)
    assert.match(firstCard(shows), /class="info-overlay"/)
    // Films say the year, shows how many episodes (and the year).
    assert.deepEqual(cardSubs(film), ['1979', '1995'])
    assert.deepEqual(cardSubs(shows), ['1 episode · 2022', '2 episodes · 2008'])

    // Shows are sorted and lettered by the title on the card, like films.
    assert.match(shows, /id="letter-A"[\s\S]*?Andor[\s\S]*?id="letter-B"/)
    assert.doesNotMatch(shows, /id="letter-S"/)
    // Search matches the shown title and the folder/file name.
    assert.match(shows, /data-name="andor \| star wars andor"/)

    // Genre filter works the same way on both (and old TV ids still open).
    const actionFilms = await get('/?genre=28')
    const actionShows = await get('/tvshows?genre=10759')
    assert.deepEqual(cardSubs(actionFilms), ['1979'])
    assert.deepEqual(cardSubs(actionShows), ['1 episode · 2022'])
    assert.match(actionFilms, /beebo-genre-active/)
    assert.match(actionShows, /beebo-genre-active/)

    // By Release Date: year headings plus the side A-Z rail on both.
    const filmYears = await get('/?view=year')
    const showYears = await get('/tvshows?view=year')
    for (const html of [filmYears, showYears]) {
      assert.match(html, /<h3 style="margin:24px 0 10px;">\d{4}<\/h3>/)
      assert.match(html, /<a class="card" id="letter-[A-Z#]"/)
      assert.match(html, /href="#letter-[A-Z#]"/)
    }
    assert.ok(showYears.indexOf('Andor') < showYears.indexOf('Breaking Bad'), 'newest first')

    // Old links keep working.
    for (const p of ['/?view=actor', '/?view=new', '/?view=sequels', '/tvshows?view=actor', '/tvshows?view=new', '/tvshows?tab=missing', '/tvshows?tab=related']) {
      await get(p)
    }
  } finally {
    if (info) await new Promise((r) => info.close(r))
    if (savedKey !== undefined) process.env.TMDB_API_KEY = savedKey
    await fs.rm(root, { recursive: true, force: true })
  }
})
