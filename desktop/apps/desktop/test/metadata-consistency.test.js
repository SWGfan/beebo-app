// Edited titles, chosen artwork, .nfo files and translations must read the same everywhere:
// the phone/web JSON API, the Jellyfin-compatible API, the artwork route and the details merge.
// A real server over the fixture library; no TMDB key, so nothing touches the network.
// Run: node --test test/metadata-consistency.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { fixture } = require('./jellyfin-fixture')
const mo = require('../electron/metadataOverrides')
const merge = require('../electron/metadataMerge')
const artworkPicker = require('../electron/artworkPicker')
const locale = require('../electron/metadataLocale')

function jpeg(width, height, tag = 0) {
  const sof = Buffer.alloc(19)
  sof[0] = 0xff; sof[1] = 0xc0; sof.writeUInt16BE(17, 2); sof[4] = 8
  sof.writeUInt16BE(height, 5); sof.writeUInt16BE(width, 7); sof[9] = 3
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0'), sof, Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0]), Buffer.alloc(tag, 7), Buffer.from([0xff, 0xd9])])
}

const apiGet = async (f, u, who = 'u-owner') => {
  const res = await fetch(f.base + u, { headers: { Authorization: 'Bearer ' + f.server.makeApiToken(f.store, who) } })
  return { status: res.status, body: await res.json() }
}

test('one edit reads the same in /api/movies, /api/tvshows, the Jellyfin-compatible API and the artwork route; reset undoes it; the files never change', async () => {
  const f = await fixture()
  try {
    const before = fs.readdirSync(f.moviesDir).sort()
    const store = mo.forDir(f.cacheDir)
    const poster = artworkPicker.saveBytes(f.cacheDir, jpeg(600, 900, 1))
    const backdrop = artworkPicker.saveBytes(f.cacheDir, jpeg(1600, 900, 2))
    const saved = mo.edit(store, 'movie', 'Toy Story (1995).mp4', {
      fields: { title: 'Toy Story: The Remaster', sortTitle: 'Aaa Toy', year: 2020, overview: 'Edited overview.', genres: ['Drama'], rating: 9.1, collection: 'Pixar Set' },
      poster: { file: poster, source: 'upload' }, backdrop: { file: backdrop, source: 'upload' }
    })
    assert.equal(saved.ok, true)

    let r = await apiGet(f, '/api/movies')
    const toy = r.body.items.find((m) => m.tmdbId === 862)
    assert.equal(toy.title, 'Toy Story: The Remaster')
    assert.equal(toy.year, 2020)
    assert.equal(toy.overview, 'Edited overview.')
    assert.deepEqual(toy.genres, [18])
    assert.equal(toy.voteAverage, 9.1)
    assert.equal(toy.poster, `/media/artwork/${poster}`)
    assert.equal(toy.backdrop, `/media/artwork/${backdrop}`)
    assert.equal(toy.collectionName, 'Pixar Set')
    assert.ok(r.body.genres.some((g) => g.name === 'Drama'))
    assert.equal(r.body.items[0].tmdbId, 862, 'the sort title puts it first')
    assert.equal(r.body.items.find((m) => m.tmdbId === 949).title, 'Heat', 'other films are untouched')

    const art = await fetch(f.base + `/media/artwork/${poster}`)
    assert.equal(art.status, 200)
    assert.equal(art.headers.get('content-type'), 'image/jpeg')
    assert.deepEqual(Buffer.from(await art.arrayBuffer()), fs.readFileSync(path.join(f.cacheDir, 'artwork', poster)))
    const rawGet = (p) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: new URL(f.base).port, path: p, method: 'GET' }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
      req.on('error', reject)
      req.end()
    })
    for (const bad of ['../manifest.json', '..%2Fmanifest.json', '..\\manifest.json', '%2e%2e/manifest.json', `${poster}.png`, 'a'.repeat(32) + '.jpg', 'x', '']) {
      const status = await rawGet('/media/artwork/' + bad)
      assert.notEqual(status, 200, bad + ' -> ' + status)
    }

    const owner = await f.signIn('owner')
    const t = f.tokens.owner
    const items = await f.jf('GET', '/Items?IncludeItemTypes=Movie&Recursive=true', { token: t })
    const jm = items.json.Items.find((i) => i.ProviderIds && i.ProviderIds.Tmdb === '862')
    assert.equal(jm.Name, 'Toy Story: The Remaster')
    assert.equal(jm.ProductionYear, 2020)
    assert.equal(jm.Overview, 'Edited overview.')
    assert.deepEqual(jm.Genres, ['Drama'])
    assert.equal(jm.CommunityRating, 9.1)
    assert.ok(jm.ImageTags.Primary && jm.BackdropImageTags.length)
    const img = await f.jf('GET', `/Items/${jm.Id}/Images/Primary`, { token: null, raw: true })
    assert.equal(img.status, 200)
    assert.deepEqual(img.buf, fs.readFileSync(path.join(f.cacheDir, 'artwork', poster)))
    const bd = await f.jf('GET', `/Items/${jm.Id}/Images/Backdrop/0`, { token: null, raw: true })
    assert.equal(bd.status, 200, 'a custom backdrop is served, not redirected to TMDB')
    assert.deepEqual(bd.buf, fs.readFileSync(path.join(f.cacheDir, 'artwork', backdrop)))
    assert.ok(owner.AccessToken)

    mo.edit(store, 'show', 'bluey', { fields: { title: 'Bluey (My Copy)', year: 2019, overview: 'Mine.' }, poster: { file: poster, source: 'upload' } })
    r = await apiGet(f, '/api/tvshows')
    const bluey = r.body.items.find((s) => s.tmdbId === 82728)
    assert.equal(bluey.name, 'Bluey (My Copy)')
    assert.equal(bluey.year, 2019)
    assert.equal(bluey.poster, `/media/artwork/${poster}`)
    await f.signIn('adult')
    const shows = await f.jf('GET', '/Items?IncludeItemTypes=Series&Recursive=true', { token: f.tokens.adult }) // a fresh person: the compat catalog snapshot is kept 30 s per person
    assert.ok(shows.json.Items.some((s) => s.Name === 'Bluey (My Copy)'))

    mo.reset(store, 'movie', 'Toy Story (1995).mp4')
    mo.reset(store, 'show', 'bluey')
    r = await apiGet(f, '/api/movies')
    const back = r.body.items.find((m) => m.tmdbId === 862)
    assert.equal(back.title, 'Toy Story')
    assert.equal(back.year, 1995)
    assert.equal(back.poster, '/media/poster/862.jpg')
    assert.equal(back.backdrop, 'https://image.tmdb.org/t/p/w780/toyback.jpg')
    assert.deepEqual(fs.readdirSync(f.moviesDir).sort(), before, 'no media file was renamed, added or removed')
    const manifest = JSON.parse(fs.readFileSync(path.join(f.cacheDir, 'manifest.json'), 'utf8'))
    assert.equal(manifest['Toy Story (1995).mp4'].title, 'Toy Story', 'the TMDB cache never received an edit')
  } finally { await f.close() }
})

test('an edited age rating is what parental controls see, and only the owner\'s record can change it', async () => {
  const f = await fixture()
  try {
    let r = await apiGet(f, '/api/movies', 'u-kid')
    assert.ok(r.body.items.some((m) => m.tmdbId === 862), 'a G film is visible to the kids profile')
    mo.edit(mo.forDir(f.cacheDir), 'movie', 'Toy Story (1995).mp4', { fields: { certification: 'R' } })
    r = await apiGet(f, '/api/movies', 'u-kid')
    assert.ok(!r.body.items.some((m) => m.tmdbId === 862), 'the edited R rating hides it from the kids profile')
    r = await apiGet(f, '/api/movies', 'u-owner')
    assert.ok(r.body.items.some((m) => m.tmdbId === 862))
  } finally { await f.close() }
})

test('.nfo next to a film sits between TMDB and the owner\'s edits; sidecar pictures are imported once; a hostile .nfo changes nothing', async () => {
  const f = await fixture()
  try {
    merge.configure({ artwork: artworkPicker.createArtwork({ getCacheDir: () => f.cacheDir, getLocale: () => ({ language: 'en-US' }), sidecars: merge.state.sidecars, reencode: null }), getMovieDirs: () => [f.moviesDir], getTvDirs: () => [f.tvDir], nfoEnabled: () => true })
    const artwork = merge.state.artwork
    fs.writeFileSync(path.join(f.moviesDir, 'Heat (1995).nfo'), '<movie><title>Heat (Director\'s Cut)</title><plot>From the nfo.</plot><genre>Thriller</genre><year>1996</year></movie>')
    fs.writeFileSync(path.join(f.moviesDir, 'Heat (1995)-poster.jpg'), jpeg(500, 750, 3))
    fs.writeFileSync(path.join(f.moviesDir, 'Paddington (2014).nfo'), '<?xml version="1.0"?>\n<!DOCTYPE x [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]>\n<movie><title>&b;</title><plot>' + 'z'.repeat(9000) + '</plot></movie>')
    merge.state.sidecars.clear()

    let r = await apiGet(f, '/api/movies')
    let heat = r.body.items.find((m) => m.tmdbId === 949)
    assert.equal(heat.title, "Heat (Director's Cut)")
    assert.equal(heat.overview, 'From the nfo.')
    assert.equal(heat.year, 1996)
    assert.deepEqual(heat.genres, [53])
    assert.equal(heat.poster, null, 'first read: the picture is still being prepared')
    await artwork.whenImported()
    r = await apiGet(f, '/api/movies')
    heat = r.body.items.find((m) => m.tmdbId === 949)
    assert.match(heat.poster, /^\/media\/artwork\/[a-f0-9]{32}\.jpg$/)
    const served = await fetch(f.base + heat.poster)
    assert.equal(served.status, 200)
    await served.arrayBuffer()

    const padd = r.body.items.find((m) => m.tmdbId === 116149)
    assert.equal(padd.title, '&b;', 'an entity reference is text, never expanded')
    assert.ok(padd.overview.length <= 4000)

    mo.edit(mo.forDir(f.cacheDir), 'movie', 'Heat (1995).mp4', { fields: { title: 'Heat (mine)' } })
    r = await apiGet(f, '/api/movies')
    heat = r.body.items.find((m) => m.tmdbId === 949)
    assert.equal(heat.title, 'Heat (mine)', 'the owner beats the .nfo')
    assert.equal(heat.overview, 'From the nfo.', 'fields the owner did not touch still come from the .nfo')

    merge.configure({ nfoEnabled: () => false })
    r = await apiGet(f, '/api/movies')
    assert.equal(r.body.items.find((m) => m.tmdbId === 949).overview, 'Cops and robbers.', 'switching .nfo import off goes back to TMDB')
    assert.equal(fs.readFileSync(path.join(f.moviesDir, 'Heat (1995).nfo'), 'utf8').startsWith('<movie>'), true, 'the .nfo is never written')
  } finally {
    merge.configure({ artwork: null, nfoEnabled: () => true, getMovieDirs: () => [], getTvDirs: () => [] })
    await f.close()
  }
})

test('parental controls judge by TMDB\'s rating and genres or the owner\'s edit, never by an .nfo or a translation', async () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'beebo-gate-'))
  try {
    fs.writeFileSync(path.join(dir, 'Scary.nfo'), '<movie><title>Cuddly</title><mpaa>G</mpaa><genre>Family</genre></movie>')
    merge.configure({ getMovieDirs: () => [dir], nfoEnabled: () => true })
    merge.state.sidecars.clear()
    const entry = { id: 9, title: 'Scary', certification: 'R', genre_ids: [27] }
    const m = merge.mergeMovie(entry, { cacheDir: dir, fileName: 'Scary.mkv' })
    assert.equal(m.title, 'Cuddly')
    assert.equal(m.certification, 'G', 'people see what the .nfo says')
    assert.deepEqual(m.genre_ids, [10751])
    assert.deepEqual(m.gate, { certification: 'R', genre_ids: [27] }, 'the gate still sees TMDB\'s')
    mo.edit(mo.forDir(dir), 'movie', 'Scary.mkv', { fields: { certification: 'PG-13', genres: ['Horror'] } })
    const edited = merge.mergeMovie(entry, { cacheDir: dir, fileName: 'Scary.mkv' })
    assert.deepEqual(edited.gate, { certification: 'PG-13', genre_ids: [27] }, 'the owner\'s own edit counts')
    assert.equal(merge.mergeMovie(null, { cacheDir: dir, fileName: 'Nothing.mkv' }), null)
  } finally {
    merge.configure({ getMovieDirs: () => [] })
    fs.rmSync(dir, { recursive: true, force: true })
  }

  const f = await fixture()
  try {
    merge.configure({ getMovieDirs: () => [f.moviesDir], nfoEnabled: () => true })
    merge.state.sidecars.clear()
    let r = await apiGet(f, '/api/movies', 'u-kid')
    assert.ok(!r.body.items.some((m) => m.tmdbId === 949), 'the kids profile does not see R-rated Heat')
    fs.writeFileSync(path.join(f.moviesDir, 'Heat (1995).nfo'), '<movie><title>Heat</title><mpaa>G</mpaa><genre>Family</genre></movie>')
    merge.state.sidecars.clear()
    r = await apiGet(f, '/api/movies', 'u-kid')
    assert.ok(!r.body.items.some((m) => m.tmdbId === 949), 'an .nfo claiming G does not let it through')
    r = await apiGet(f, '/api/movies', 'u-owner')
    assert.equal(r.body.items.find((m) => m.tmdbId === 949).genres[0], 10751, 'but the owner sees the .nfo\'s genres')
  } finally {
    merge.configure({ getMovieDirs: () => [] })
    await f.close()
  }
})

test('a big library stays quick: 3000 films with 300 .nfo files merge in well under two seconds, and a repeat pass reads no directory', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'beebo-big-'))
  try {
    for (let i = 0; i < 3000; i++) {
      fs.writeFileSync(path.join(dir, `Film ${i} (2000).mkv`), '')
      if (i % 10 === 0) fs.writeFileSync(path.join(dir, `Film ${i} (2000).nfo`), `<movie><title>Film ${i} nfo</title></movie>`)
    }
    merge.configure({ getMovieDirs: () => [dir], nfoEnabled: () => true, artwork: artworkPicker.createArtwork({ getCacheDir: () => dir, getLocale: () => ({ language: 'en-US' }), sidecars: merge.state.sidecars, reencode: null }) })
    merge.state.sidecars.clear()
    const pass = () => {
      let edited = 0
      for (let i = 0; i < 3000; i++) {
        const m = merge.mergeMovie({ id: i + 1, title: `Film ${i}`, release_date: '2000-01-01' }, { cacheDir: dir, fileName: `Film ${i} (2000).mkv` })
        if (m.title.endsWith('nfo')) edited++
      }
      return edited
    }
    const started = Date.now()
    assert.equal(pass(), 300)
    assert.equal(pass(), 300)
    assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`)
  } finally {
    merge.configure({ getMovieDirs: () => [], artwork: null })
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('mergeDetails: the details page gets the same edits, and untouched records come back as they were', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'beebo-md-'))
  const details = { id: 862, title: 'Toy Story', tagline: 'Woody', overview: 'TMDB.', releaseDate: '1995-11-22', year: '1995', genres: ['Animation', 'Comedy'], certification: 'G', voteAverage: 8.3, posterPath: '/p.jpg', backdropPath: '/b.jpg', cast: [{ id: 1 }] }
  const ctx = { cacheDir: dir, fileName: 'Toy Story (1995).mp4' }
  try {
    assert.equal(merge.mergeDetails('movie', details, ctx), details)
    const poster = artworkPicker.saveBytes(dir, jpeg(600, 900))
    mo.edit(mo.forDir(dir), 'movie', ctx.fileName, { fields: { title: 'TS', year: 2001, genres: ['Drama', 'Family'], certification: 'PG', tagline: '' }, poster: { file: poster, source: 'upload' } })
    const out = merge.mergeDetails('movie', details, ctx)
    assert.equal(out.title, 'TS')
    assert.equal(out.releaseDate, '2001-11-22')
    assert.equal(out.year, '2001')
    assert.deepEqual(out.genres, ['Drama', 'Family'])
    assert.equal(out.certification, 'PG')
    assert.equal(out.tagline, '')
    assert.equal(out.overview, 'TMDB.')
    assert.equal(out.voteAverage, 8.3)
    assert.equal(out.customPosterUrl, `/media/artwork/${poster}`)
    assert.equal(out.posterPath, null)
    assert.equal(out.backdropPath, '/b.jpg')
    assert.deepEqual(out.cast, [{ id: 1 }])
    assert.ok(out.edited.includes('title'))
    assert.equal(details.title, 'Toy Story')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('translations fold in through the same merge point and yield to edits', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'beebo-ml-'))
  try {
    let current = { language: 'fr-FR', region: 'FR' }
    const localizer = locale.createLocalizer({
      getApiKey: () => 'k', getLocale: () => current,
      createApi: () => ({ get: async () => ({ ok: true, data: { title: 'Toy Story FR', original_title: 'Toy Story', original_language: 'en', overview: 'Des jouets.', release_dates: { results: [] } } }) })
    })
    merge.configure({ localizer })
    const entry = { id: 862, title: 'Toy Story', overview: 'Toys.', release_date: '1995-11-22' }
    const ctx = { cacheDir: dir, fileName: 'a.mp4' }
    assert.equal(merge.mergeMovie(entry, ctx).title, 'Toy Story', 'first read is English, the fetch is queued')
    return localizer.whenIdle().then(() => {
      let m = merge.mergeMovie(entry, ctx)
      assert.equal(m.title, 'Toy Story FR')
      assert.equal(m.overview, 'Des jouets.')
      mo.edit(mo.forDir(dir), 'movie', 'a.mp4', { fields: { title: 'Mon titre' } })
      m = merge.mergeMovie(entry, ctx)
      assert.equal(m.title, 'Mon titre')
      assert.equal(m.overview, 'Des jouets.')
      current = { language: 'en-US', region: 'US' }
      assert.equal(merge.mergeMovie(entry, ctx).overview, 'Toys.', 'back to English')
    }).finally(() => merge.configure({ localizer: null }))
  } finally { setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 2500).unref() }
})

test('enrichParsed feeds .nfo ids and title into matching, and leaves episodes and unknown files alone', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'beebo-ep-'))
  try {
    fs.writeFileSync(path.join(dir, 'Some.Weird.Name.nfo'), '<movie><title>The Real Title</title><year>2004</year><uniqueid type="imdb">tt1234567</uniqueid><tmdbid>77</tmdbid></movie>')
    merge.configure({ getMovieDirs: () => [dir], nfoEnabled: () => true })
    merge.state.sidecars.clear()
    const parsed = { title: 'Some Weird Name', year: null, imdbId: null, episode: null }
    assert.deepEqual(merge.enrichParsed('Some.Weird.Name.mkv', parsed), { title: 'The Real Title', year: '2004', imdbId: 'tt1234567', episode: null, tmdbId: 77 })
    assert.equal(merge.enrichParsed('Other.mkv', parsed), parsed)
    const ep = { title: 'Show', episode: { season: 1, episode: 2 } }
    assert.equal(merge.enrichParsed('Some.Weird.Name.mkv', ep), ep)
  } finally {
    merge.configure({ getMovieDirs: () => [] })
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
