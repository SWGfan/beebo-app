'use strict'
// Shared helpers for the migration importer tests: fixture files, an in-memory zip writer, a mock
// Jellyfin / Emby / Plex server on 127.0.0.1, a fake store and a small library catalog.
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const zlib = require('node:zlib')

const FIX = path.join(__dirname, '..', 'fixtures', 'migration')
const fixturePath = (...p) => path.join(FIX, ...p)
const fixtureText = (...p) => fs.readFileSync(fixturePath(...p), 'utf8')
const fixtureJson = (...p) => JSON.parse(fixtureText(...p))

// ---- zip writer ---------------------------------------------------------------------------------
function crc32(buf) {
  let c
  let crc = -1
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ -1) >>> 0
}

/**
 * entries: [{ name, data: Buffer|string, method?: 0|8, lieAboutSize?: number, flags?: number, crc?: number }]
 */
function makeZip(entries) {
  const locals = []
  const central = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8')
    const method = e.method === 0 ? 0 : 8
    const body = method === 0 ? raw : zlib.deflateRawSync(raw)
    const crc = e.crc !== undefined ? e.crc : crc32(raw)
    const usize = e.lieAboutSize !== undefined ? e.lieAboutSize : raw.length
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE((e.flags || 0) | 0x800, 6)
    lh.writeUInt16LE(method, 8)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(body.length, 18)
    lh.writeUInt32LE(usize, 22)
    lh.writeUInt16LE(name.length, 26)
    locals.push(lh, name, body)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE((e.flags || 0) | 0x800, 8)
    ch.writeUInt16LE(method, 10)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(body.length, 20)
    ch.writeUInt32LE(usize, 24)
    ch.writeUInt16LE(name.length, 28)
    ch.writeUInt32LE(offset, 42)
    central.push(ch, name)
    offset += lh.length + name.length + body.length
  }
  const cd = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

/** The Letterboxd fixture folder as an export zip, the way Letterboxd names its entries. */
function letterboxdZip() {
  const t = (...p) => fixtureText('letterboxd', ...p)
  return makeZip([
    { name: 'watched.csv', data: t('watched.csv') },
    { name: 'ratings.csv', data: t('ratings.csv') },
    { name: 'watchlist.csv', data: t('watchlist.csv') },
    { name: 'diary.csv', data: t('diary.csv') },
    { name: 'likes/films.csv', data: t('likes', 'films.csv') },
    { name: 'lists/road-trip-night.csv', data: t('lists', 'road-trip-night.csv') },
    { name: 'reviews.csv', data: 'Date,Name\n' }
  ])
}

// ---- mock media server --------------------------------------------------------------------------
/**
 * handler({ method, url, path, query, headers }) -> { status?, body?, headers? } (body is JSON-encoded unless a string)
 * `requests` records every request (headers included) so a test can prove where a key travelled.
 */
function startMockServer(handler) {
  const requests = []
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    const info = { method: req.method, url: req.url, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: req.headers }
    requests.push(info)
    let out
    try { out = handler(info) || { status: 404, body: { error: 'nope' } } } catch (err) { out = { status: 500, body: { error: 'boom' } } }
    const body = typeof out.body === 'string' ? out.body : JSON.stringify(out.body === undefined ? {} : out.body)
    res.writeHead(out.status || 200, { 'content-type': 'application/json', ...(out.headers || {}) })
    res.end(body)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({ port, url: 'http://127.0.0.1:' + port, requests, close: () => new Promise((r) => { server.close(r); server.closeAllConnections && server.closeAllConnections() }) })
    })
  })
}

function paged(list, query, startKey = 'StartIndex', limitKey = 'Limit') {
  const start = Number(query[startKey] || 0)
  const limit = Number(query[limitKey] || 500)
  return list.slice(start, start + limit)
}

/** A Jellyfin/Emby server over test/fixtures/migration/jellyfin/server.json. */
function jellyfinHandler(apiKey, data = fixtureJson('jellyfin', 'server.json')) {
  return ({ path: p, query, headers }) => {
    const key = headers['x-emby-token'] || ''
    if (key !== apiKey) return { status: 401, body: { error: 'bad key' } }
    if (p === '/System/Info') return { body: data.info }
    if (p === '/Users') return { body: data.users }
    let m = /^\/Users\/([^/]+)\/Items$/.exec(p)
    if (m) {
      const types = String(query.IncludeItemTypes || '')
      const uid = m[1]
      const pick = { Series: data.series, Movie: data.movies, Episode: data.episodes }[types]
      if (pick) {
        const all = pick[uid] || []
        return { body: { Items: paged(all, query), TotalRecordCount: all.length } }
      }
      if (types === 'Playlist') {
        const all = (data.playlists && data.playlists[uid]) || []
        return { body: { Items: paged(all, query), TotalRecordCount: all.length } }
      }
      return { body: { Items: [], TotalRecordCount: 0 } }
    }
    m = /^\/Playlists\/([^/]+)\/Items$/.exec(p)
    if (m) return { body: { Items: (data.playlistItems && data.playlistItems[m[1]]) || [] } }
    return { status: 404, body: {} }
  }
}

/** A Plex server over test/fixtures/migration/plex/server.json. */
function plexHandler(token, data = fixtureJson('plex', 'server.json')) {
  return ({ path: p, query, headers }) => {
    if (headers['x-plex-token'] !== token) return { status: 401, body: {} }
    if (p === '/identity') return { body: data.identity }
    if (p === '/library/sections') return { body: data.sections }
    let m = /^\/library\/sections\/(\d+)\/all$/.exec(p)
    if (m) {
      const list = query.type === '4' ? data.episodes : m[1] === '1' ? data.movies : data.shows
      const md = list.MediaContainer.Metadata
      const start = Number(query['X-Plex-Container-Start'] || 0)
      const size = Number(query['X-Plex-Container-Size'] || 200)
      return { body: { MediaContainer: { ...list.MediaContainer, Metadata: md.slice(start, start + size) } } }
    }
    if (p === '/playlists') return { body: data.playlists }
    m = /^\/playlists\/(\d+)\/items$/.exec(p)
    if (m) return { body: data.playlistItems[m[1]] || { MediaContainer: { Metadata: [] } } }
    return { status: 404, body: {} }
  }
}

// ---- store, users, library ----------------------------------------------------------------------
function fakeStore(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial))
  return {
    data,
    get: (k) => (data[k] === undefined ? undefined : JSON.parse(JSON.stringify(data[k]))),
    set: (k, v) => { data[k] = JSON.parse(JSON.stringify(v)) },
    delete: (k) => { delete data[k] },
    onDidChange: () => () => {}
  }
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url')

const movie = (fileName, title, year, tmdbId, extra = {}) => ({ type: 'movie', id: b64(fileName), key: 'movie:' + fileName, fileName, title, year, tmdbId, durationSeconds: 7200, ...extra })
const episode = (showName, season, episodeNo, tmdbId, relPathBase, extra = {}) => {
  const relPath = (relPathBase || showName + '/Season ' + season) + '/' + showName + ' S' + String(season).padStart(2, '0') + 'E' + String(episodeNo).padStart(2, '0') + '.mkv'
  return {
    type: 'episode', id: b64(relPath), key: 'tv:' + relPath, fileName: relPath, title: showName + ' — S' + season + 'E' + episodeNo, year: extra.showYear || null,
    tmdbId, showKey: b64(showName.toLowerCase()), showName, season, episode: episodeNo, durationSeconds: 3000, ...extra
  }
}

/** A library that lines up with the fixtures. */
function fixtureCatalog() {
  return [
    movie('The Matrix (1999).mkv', 'The Matrix', 1999, 603),
    movie('Heat (1995).mkv', 'Heat', 1995, 949),
    movie('Alien (1979).mkv', 'Alien', 1979, 348),
    movie('Amelie (2001).mkv', 'Amélie', 2001, 194),
    movie('Dune (1984).mkv', 'Dune', 1984, 841),
    movie('Dune (2021).mkv', 'Dune', 2021, 438631),
    movie('Everything Everywhere All at Once (2022).mkv', 'Everything Everywhere All at Once', 2022, 545611),
    movie('Url Only (2001).mkv', 'Url Only', 2001, 1234),
    episode('Severance', 1, 1, 95396, null, { showYear: 2022 }),
    episode('Severance', 1, 2, 95396, null, { showYear: 2022 }),
    episode('Severance', 1, 3, 95396, null, { showYear: 2022 }),
    episode('Chernobyl', 1, 1, 87108, null, { showYear: 2019 })
  ]
}

const owner = { id: 'u-owner', name: 'Nick', isAdmin: true, status: 'approved' }
const sam = { id: 'u-sam', name: 'Sam', isAdmin: false, status: 'approved' }

/** An importer wired to a fake store and the fixture library. */
function makeImporter(overrides = {}) {
  const os = require('node:os')
  const { createImporter } = require('../../electron/migrationImport')
  const store = overrides.store || fakeStore()
  const journalDir = overrides.journalDir || fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-mig-'))
  const catalog = overrides.catalog || fixtureCatalog()
  const logs = []
  const importer = createImporter({
    store, journalDir,
    users: () => overrides.users || [owner, sam],
    library: () => ({ catalog }),
    log: (m) => logs.push(m),
    ...overrides.deps
  })
  return { importer, store, journalDir, logs, catalog }
}

async function waitReady(importer, viewer, session, ms = 8000) {
  const t0 = Date.now()
  for (;;) {
    const snap = importer.snapshot(importer.getSession(viewer, session.id))
    if (snap.status === 'ready' || snap.status === 'error') return snap
    if (Date.now() - t0 > ms) throw new Error('session did not finish: ' + JSON.stringify(snap))
    await new Promise((r) => setTimeout(r, 15))
  }
}

module.exports = {
  fixturePath, fixtureText, fixtureJson, makeZip, letterboxdZip, crc32, startMockServer, jellyfinHandler, plexHandler,
  fakeStore, movie, episode, fixtureCatalog, owner, sam, makeImporter, waitReady, b64
}
