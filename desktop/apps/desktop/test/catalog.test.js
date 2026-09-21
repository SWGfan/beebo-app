const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const catalog = localRequire('./electron/catalog')

// A small library with every case the walk has an opinion about: nested season folders, flat
// files, a converted copy hiding its original, a "(converted)" copy, a converter temp file,
// a non-video file, and a second root that overlaps the first.
function makeLibrary() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-catalog-'))
  const put = (rel) => {
    const full = path.join(root, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, rel)
  }
  ;[
    'tv/Show A/Season 1/Show A S01E01.mkv',
    'tv/Show A/Season 1/Show A S01E01.mp4',
    'tv/Show A/Season 1/Show A S01E02.avi',
    'tv/Show A/Season 1/Show A S01E02 (converted).mp4',
    'tv/Show A/Season 1/Show A S01E03.converting.mp4',
    'tv/Show A/Season 1/Show A S01E03.mkv',
    'tv/Show A/Season 1/notes.txt',
    'tv/Flat Show S02E05.webm',
    'tv/extra/Show B/Show B S01E01.MP4',
    'movies/Film One (2001).mkv',
    'movies/Film One (2001).mp4',
    'movies/Film Two (2002).avi',
    'movies/readme.txt',
    'movies2/Film Three (2003).mov'
  ].forEach(put)
  return {
    root,
    tv: [path.join(root, 'tv'), path.join(root, 'tv', 'extra'), path.join(root, 'missing')],
    movies: [path.join(root, 'movies'), path.join(root, 'movies2')]
  }
}

test('the worker thread walks the library exactly as the main thread does', async () => {
  const lib = makeLibrary()
  const walker = catalog.createCatalogWalker()
  try {
    assert.deepEqual(await walker.scanTvShowsMulti(lib.tv), catalog.scanTvShowsMulti(lib.tv))
    assert.deepEqual(await walker.scanMoviesMulti(lib.movies), catalog.scanMoviesMulti(lib.movies))
    assert.deepEqual(await walker.scanVideoFilesMulti(lib.tv), catalog.scanVideoFilesMulti(lib.tv))
    // The cases above really were exercised.
    const names = catalog.scanTvShowsMulti(lib.tv).map((f) => f.fileName).sort()
    assert.deepEqual(names, ['Flat Show S02E05.webm', 'Show A S01E01.mp4', 'Show A S01E02 (converted).mp4', 'Show A S01E03.mkv', 'Show B S01E01.MP4'])
    assert.equal(catalog.scanVideoFilesMulti(lib.tv).length, 8)
  } finally {
    walker.close()
    fs.rmSync(lib.root, { recursive: true, force: true })
  }
})

test('a lookup answers what find() over the full walk would', async () => {
  const lib = makeLibrary()
  const walker = catalog.createCatalogWalker()
  try {
    const all = catalog.scanTvShowsMulti(lib.tv)
    for (const f of all) assert.deepEqual(await walker.findTvFile(lib.tv, f.relPath), f)
    assert.equal(await walker.findTvFile(lib.tv, path.join('Show A', 'Season 1', 'Show A S01E01.mkv')), null)
    assert.equal(await walker.findTvFile(lib.tv, '__proto__'), null)
    assert.equal((await walker.findMovie(lib.movies, 'Film Two (2002).avi')).dir, lib.movies[0])
    assert.equal(await walker.findMovie(lib.movies, 'Film One (2001).mkv'), null)
  } finally {
    walker.close()
    fs.rmSync(lib.root, { recursive: true, force: true })
  }
})

test('a burst of overlapping requests all get correct answers', async () => {
  const lib = makeLibrary()
  const walker = catalog.createCatalogWalker()
  try {
    const all = catalog.scanTvShowsMulti(lib.tv)
    const jobs = []
    for (let i = 0; i < 40; i++) {
      const f = all[i % all.length]
      jobs.push(walker.findTvFile(lib.tv, f.relPath).then((got) => assert.deepEqual(got, f)))
      if (i % 7 === 0) jobs.push(walker.scanTvShowsMulti(lib.tv).then((got) => assert.deepEqual(got, all)))
      if (i % 5 === 0) jobs.push(walker.findMovie(lib.movies, 'Film Three (2003).mov').then((got) => assert.equal(got.fileName, 'Film Three (2003).mov')))
    }
    await Promise.all(jobs)
    // Each caller gets its own array, so sorting one cannot reorder another's.
    const a = await walker.scanTvShowsMulti(lib.tv)
    a.reverse()
    assert.deepEqual(await walker.scanTvShowsMulti(lib.tv), all)
  } finally {
    walker.close()
    fs.rmSync(lib.root, { recursive: true, force: true })
  }
})

test('with no worker the same answers come from the calling thread', async () => {
  const lib = makeLibrary()
  const walker = catalog.createCatalogWalker()
  walker.close()
  try {
    assert.deepEqual(await walker.scanTvShowsMulti(lib.tv), catalog.scanTvShowsMulti(lib.tv))
    assert.equal((await walker.findMovie(lib.movies, 'Film Two (2002).avi')).fileName, 'Film Two (2002).avi')
  } finally {
    fs.rmSync(lib.root, { recursive: true, force: true })
  }
})

// --- the library cache ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const put = (file, text = 'x') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
// A watcher that never reports anything: what a lost notification looks like.
const deafWatch = () => ({ close() {} })

test('the cache answers exactly what the walk does, and every caller gets its own copy', async () => {
  const lib = makeLibrary()
  const walker = catalog.createCatalogWalker()
  const library = catalog.createLibraryCatalog({ walker })
  try {
    await library.run('t', async () => {
      await library.prime({ movies: lib.movies, tv: lib.tv })
      assert.deepEqual(library.scanTvShowsMulti(lib.tv), catalog.scanTvShowsMulti(lib.tv))
      assert.deepEqual(library.scanMoviesMulti(lib.movies), catalog.scanMoviesMulti(lib.movies))
      const a = library.scanTvShowsMulti(lib.tv)
      a.reverse()
      a[0].relPath = 'scribbled on'
      assert.deepEqual(library.scanTvShowsMulti(lib.tv), catalog.scanTvShowsMulti(lib.tv))
    })
  } finally {
    library.close()
    walker.close()
    fs.rmSync(lib.root, { recursive: true, force: true })
  }
})

test('a primed request reads the cached walk; outside one a change is walked for on the spot', async () => {
  const lib = makeLibrary()
  const walker = catalog.createCatalogWalker()
  let fire = null
  const watch = (dir, onChange) => { if (dir === path.resolve(lib.movies[0])) fire = onChange; return { close() {} } }
  const library = catalog.createLibraryCatalog({ walker, watch })
  try {
    const added = path.join(lib.movies[0], 'Film Four (2004).mp4')
    await library.run('request', async () => {
      await library.prime({ movies: lib.movies })
      put(added)
      fire('rename', 'Film Four (2004).mp4')
      // Primed: the request keeps reading the walk it primed, and walks nothing itself.
      assert.equal(library.scanMoviesMulti(lib.movies).some((m) => m.fileName === 'Film Four (2004).mp4'), false)
    })
    // Not primed and out of date: walked here, today's behaviour.
    assert.equal(library.scanMoviesMulti(lib.movies).some((m) => m.fileName === 'Film Four (2004).mp4'), true)
    // And the next primed request sees it too.
    await library.run('request 2', async () => {
      await library.prime({ movies: lib.movies })
      assert.equal(library.scanMoviesMulti(lib.movies).some((m) => m.fileName === 'Film Four (2004).mp4'), true)
    })
  } finally {
    library.close()
    walker.close()
    fs.rmSync(lib.root, { recursive: true, force: true })
  }
})

test('real change notifications: an added file is listed, a deleted one is not', async () => {
  const lib = makeLibrary()
  const walker = catalog.createCatalogWalker()
  const library = catalog.createLibraryCatalog({ walker })
  const primedTv = () => library.run('r', async () => { await library.prime({ tv: lib.tv }); return library.scanTvShowsMulti(lib.tv) })
  try {
    const rel = path.join('Show A', 'Season 2', 'Show A S02E01.mp4')
    assert.equal((await primedTv()).some((f) => f.relPath === rel), false)
    put(path.join(lib.tv[0], rel))
    // Well inside the 15 s cache age, so only a change notification can make it show up.
    let listed = false
    for (let i = 0; i < 100 && !listed; i++) { listed = (await primedTv()).some((f) => f.relPath === rel); if (!listed) await sleep(20) }
    assert.equal(listed, true)
    fs.rmSync(path.join(lib.tv[0], rel))
    let gone = false
    for (let i = 0; i < 100 && !gone; i++) { gone = !(await primedTv()).some((f) => f.relPath === rel); if (!gone) await sleep(20) }
    assert.equal(gone, true)
    assert.equal(await library.findTvFile(lib.tv, rel), null)
  } finally {
    library.close()
    walker.close()
    fs.rmSync(lib.root, { recursive: true, force: true })
  }
})

test('a seek never needs a walk for a known file, and survives lost notifications', async () => {
  const lib = makeLibrary()
  const walker = catalog.createCatalogWalker()
  let walks = 0
  const counting = Object.assign({}, walker, { walkFresh: (op, dirs) => { walks++; return walker.walkFresh(op, dirs) } })
  const library = catalog.createLibraryCatalog({ walker: counting, watch: deafWatch })
  try {
    const rel = path.join('Show A', 'Season 1', 'Show A S01E03.mkv')
    const first = await library.findTvFile(lib.tv, rel)
    assert.deepEqual(first, catalog.scanTvShowsMulti(lib.tv).find((f) => f.relPath === rel))
    assert.equal(walks, 1)
    for (let i = 0; i < 20; i++) assert.equal((await library.findTvFile(lib.tv, rel)).relPath, rel)
    assert.equal(walks, 1)

    // Added with no notification: one fresh walk finds it.
    const added = path.join('Show A', 'Season 1', 'Show A S01E04.mp4')
    put(path.join(lib.tv[0], added))
    assert.equal((await library.findTvFile(lib.tv, added)).relPath, added)
    assert.equal(walks, 2)

    // Deleted with no notification: the cached entry is checked against the disk.
    fs.rmSync(path.join(lib.tv[0], added))
    assert.equal(await library.findTvFile(lib.tv, added), null)

    // A converted copy appears next to the original: the original is no longer playable by id,
    // exactly as a fresh walk would hide it.
    put(path.join(lib.tv[0], 'Show A', 'Season 1', 'Show A S01E03.mp4'))
    assert.equal(await library.findTvFile(lib.tv, rel), null)
    assert.equal((await library.findTvFile(lib.tv, path.join('Show A', 'Season 1', 'Show A S01E03.mp4'))).fileName, 'Show A S01E03.mp4')

    // Films too.
    assert.equal((await library.findMovie(lib.movies, 'Film Two (2002).avi')).dir, lib.movies[0])
    assert.equal(await library.findMovie(lib.movies, 'Film One (2001).mkv'), null)
    assert.equal(await library.findMovie(lib.movies, '__proto__'), null)
  } finally {
    library.close()
    walker.close()
    fs.rmSync(lib.root, { recursive: true, force: true })
  }
})

test('a lookup never resolves outside the folder that was walked', async () => {
  const lib = makeLibrary()
  const outside = path.join(lib.root, 'outside.mp4')
  put(outside)
  const evil = { name: 'x', fileName: 'outside.mp4', relPath: path.join('..', 'outside.mp4'), size: 1, mtimeMs: 1, dir: lib.tv[0] }
  const fake = { isBroken: () => false, walkFresh: async () => [evil] }
  const library = catalog.createLibraryCatalog({ walker: fake, watch: deafWatch })
  try {
    assert.equal(await library.findTvFile(lib.tv, evil.relPath), null)
    assert.equal(await library.findTvFile(lib.tv, evil.relPath), null) // cached this time
    assert.equal(await library.findMovie(lib.movies, path.join('..', 'movies2', 'Film Three (2003).mov')), null)
  } finally {
    library.close()
    fs.rmSync(lib.root, { recursive: true, force: true })
  }
})

test('with no worker, no watcher or an old walk, every read walks as it always did', async () => {
  const lib = makeLibrary()
  const hasFour = (list) => list.some((m) => m.fileName === 'Film Four (2004).mp4')
  const cases = [
    ['worker gone', () => { const w = catalog.createCatalogWalker(); w.close(); return { walker: w, watch: deafWatch } }],
    ['folder cannot be watched', () => ({ walker: catalog.createCatalogWalker(), watch: () => { throw new Error('EPERM') } })],
    ['walk too old', () => ({ walker: catalog.createCatalogWalker(), watch: deafWatch, maxAgeMs: 0 })]
  ]
  try {
    for (const [name, make] of cases) {
      const opts = make()
      const library = catalog.createLibraryCatalog(opts)
      const added = path.join(lib.movies[0], 'Film Four (2004).mp4')
      try {
        await library.run('r', async () => {
          await library.prime({ movies: lib.movies })
          assert.equal(hasFour(library.scanMoviesMulti(lib.movies)), false, name)
        })
        put(added)
        if (name === 'walk too old') await sleep(5)
        assert.equal(hasFour(library.scanMoviesMulti(lib.movies)), true, name)
        assert.equal((await library.findMovie(lib.movies, 'Film Four (2004).mp4')).fileName, 'Film Four (2004).mp4', name)
      } finally {
        fs.rmSync(added, { force: true })
        library.close()
        opts.walker.close()
      }
    }
  } finally {
    fs.rmSync(lib.root, { recursive: true, force: true })
  }
})

test("a request's primed mark ends with the request", async () => {
  const lib = makeLibrary()
  const walker = catalog.createCatalogWalker()
  const library = catalog.createLibraryCatalog({ walker, watch: deafWatch, maxAgeMs: 0 })
  try {
    let later = null
    await library.run('r', async () => {
      await library.prime({ movies: lib.movies })
      later = new Promise((resolve) => setTimeout(() => resolve(library.scanMoviesMulti(lib.movies)), 30))
    })
    put(path.join(lib.movies[0], 'Film Four (2004).mp4'))
    // The timer outlived the request, so it must not read the request's (now stale) walk.
    assert.equal((await later).some((m) => m.fileName === 'Film Four (2004).mp4'), true)
  } finally {
    library.close()
    walker.close()
    fs.rmSync(lib.root, { recursive: true, force: true })
  }
})

test('the worker source stands on its own', () => {
  // Every name the walk functions use must be defined in the worker, or a walk would throw there.
  const src = catalog.workerSource()
  for (const name of ['encodeId', 'scanMovies', 'scanMoviesMulti', 'hideStaleOriginals', 'scanMediaDir', 'scanTvShows', 'scanVideoFilesMulti', 'scanTvShowsMulti', 'VIDEO_EXTS']) {
    assert.match(src, new RegExp(`(function|const) ${name}\\b`))
  }
})
