// Reading a Jellyfin, Emby or Plex server over HTTP with a key the person typed in: what is asked,
// what is kept, and what can never happen (a key in an address or a log, a redirect followed, a
// request to a link-local address). A real HTTP server on 127.0.0.1 plays the media server.
// Run: node --test test/migration-servers.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const safeFetch = require('../electron/migration/safeFetch')
const jellyfin = require('../electron/migration/jellyfin')
const plex = require('../electron/migration/plex')
const fx = require('./helpers/migrationFixtures')

const KEY = 'abcdef0123456789ABCDEF'
const TOKEN = 'plex-Token_0123456789'

// ---- safeFetch ----------------------------------------------------------------------------------
test('safeFetch: only http(s) addresses with no credentials, query or odd port are accepted', () => {
  for (const ok of ['http://192.168.1.20:8096', '192.168.1.20:8096', 'https://media.example.com', 'http://localhost:32400/', 'http://[::1]:8096', 'http://10.0.0.5/jellyfin']) {
    assert.doesNotThrow(() => safeFetch.parseBaseUrl(ok), ok)
  }
  for (const bad of ['', 'ftp://host', 'file:///etc/passwd', 'javascript:alert(1)', 'http://user:pw@host', 'http://host?api_key=abc', 'http://host/#x', 'http://host:0', 'http://host:70000', 'http://a b', 'http://', 'x'.repeat(400)]) {
    assert.throws(() => safeFetch.parseBaseUrl(bad), (e) => e.code === 'bad_address', JSON.stringify(bad))
  }
})

test('safeFetch: link-local, "this host" and multicast are never reachable; private and loopback are (it is the owner’s own network)', () => {
  const c = safeFetch.classifyAddress
  for (const ip of ['169.254.169.254', '169.254.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', 'fe80::1', '::', 'ff02::1', 'fd00:ec2::254', '::ffff:169.254.169.254']) assert.equal(c(ip), 'blocked', ip)
  for (const ip of ['192.168.1.5', '10.1.2.3', '172.16.0.1', '172.31.255.1', '100.64.0.1', 'fd12:3456::1']) assert.equal(c(ip), 'private', ip)
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(c(ip), 'loopback', ip)
  for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111']) assert.equal(c(ip), 'public', ip)
  assert.equal(c('not-an-ip'), 'blocked')
})

test('safeFetch: metadata addresses are refused before any connection, by literal or by name', async () => {
  await assert.rejects(() => safeFetch.getJson('http://169.254.169.254', '/latest/meta-data/'), (e) => e.code === 'blocked_address')
  await assert.rejects(() => safeFetch.getJson('http://[fe80::1]:8096', '/x'), (e) => e.code === 'blocked_address')
  // A name that resolves to a blocked address is refused too, and the check is on what it resolves to.
  const lookup = (host, cb) => cb(null, [{ address: '169.254.169.254', family: 4 }])
  await assert.rejects(() => safeFetch.getJson('http://metadata.example.test', '/x', { lookup }), (e) => e.code === 'blocked_address')
  // One bad answer among good ones is enough to refuse.
  const mixed = (host, cb) => cb(null, [{ address: '192.168.1.5', family: 4 }, { address: '169.254.169.254', family: 4 }])
  await assert.rejects(() => safeFetch.getJson('http://mixed.example.test', '/x', { lookup: mixed }), (e) => e.code === 'blocked_address')
  // publicOnly (plex.tv) refuses private and loopback names as well.
  const priv = (host, cb) => cb(null, [{ address: '192.168.1.5', family: 4 }])
  await assert.rejects(() => safeFetch.getJson('https://plex.example.test', '/x', { lookup: priv, publicOnly: true }), (e) => e.code === 'blocked_address')
  await assert.rejects(() => safeFetch.getJson('http://127.0.0.1:9', '/x', { publicOnly: true }), (e) => e.code === 'blocked_address')
  const nothing = (host, cb) => cb(new Error('ENOTFOUND'))
  await assert.rejects(() => safeFetch.getJson('http://nowhere.example.test', '/x', { lookup: nothing }), (e) => e.code === 'unresolved')
})

test('safeFetch: connects to the address it checked, not to whatever the name says later (no DNS rebinding)', async () => {
  const srv = await fx.startMockServer(() => ({ body: { hit: true } }))
  try {
    let calls = 0
    // First answer (used for the check) is the mock server's loopback address; a rebinding server
    // would answer differently on a second lookup. safeFetch must not do a second lookup.
    const lookup = (host, cb) => { calls++; cb(null, [{ address: '127.0.0.1', family: 4 }]) }
    const r = await safeFetch.getJson('http://rebind.example.test:' + srv.port, '/x', { lookup })
    assert.deepEqual(r, { hit: true })
    assert.equal(calls, 1)
    assert.equal(srv.requests[0].headers.host, 'rebind.example.test:' + srv.port)
  } finally { await srv.close() }
})

test('safeFetch: a redirect is an error and is not followed', async () => {
  const target = await fx.startMockServer(() => ({ body: { reached: true } }))
  const srv = await fx.startMockServer(() => ({ status: 302, headers: { location: target.url + '/x' }, body: '' }))
  try {
    await assert.rejects(() => safeFetch.getJson(srv.url, '/x', { headers: { 'X-Emby-Token': KEY } }), (e) => e.code === 'redirect_refused')
    assert.equal(target.requests.length, 0, 'the key was not sent on to the redirect target')
  } finally { await srv.close(); await target.close() }
})

test('safeFetch: size, time, non-json and error statuses become short codes', async () => {
  const srv = await fx.startMockServer(({ path: p }) => {
    if (p === '/big') return { body: '[' + '1,'.repeat(50000) + '1]' }
    if (p === '/text') return { body: 'hello' }
    if (p === '/401') return { status: 401, body: 'secret detail' }
    if (p === '/500') return { status: 500, body: '' }
    return { body: { ok: true } }
  })
  try {
    await assert.rejects(() => safeFetch.getJson(srv.url, '/big', { maxBytes: 1000 }), (e) => e.code === 'too_big')
    await assert.rejects(() => safeFetch.getJson(srv.url, '/text'), (e) => e.code === 'not_json')
    await assert.rejects(() => safeFetch.getJson(srv.url, '/401'), (e) => e.code === 'http_401' && !/secret/.test(e.message))
    await assert.rejects(() => safeFetch.getJson(srv.url, '/500'), (e) => e.code === 'http_500')
    assert.deepEqual(await safeFetch.getJson(srv.url, '/fine'), { ok: true })
    assert.deepEqual(await safeFetch.getJson(srv.url + '/base/', '/fine'), { ok: true })
    assert.equal(srv.requests.at(-1).path, '/base/fine', 'a server behind a path prefix works')
  } finally { await srv.close() }
  const hang = http.createServer(() => {})
  await new Promise((r) => hang.listen(0, '127.0.0.1', r))
  try {
    await assert.rejects(() => safeFetch.getJson('http://127.0.0.1:' + hang.address().port, '/x', { timeoutMs: 150 }), (e) => e.code === 'timeout')
  } finally { hang.closeAllConnections(); await new Promise((r) => hang.close(r)) }
  await assert.rejects(() => safeFetch.getJson('http://127.0.0.1:1', '/x', { timeoutMs: 2000 }), (e) => e.code === 'network')
  assert.match(safeFetch.explain('http_401'), /refused the key/)
  assert.doesNotMatch(safeFetch.explain('anything'), /http|:\/\//i)
})

// ---- Jellyfin / Emby ----------------------------------------------------------------------------
test('jellyfin: probe lists the people; a wrong key is a short code that names no key', async () => {
  const srv = await fx.startMockServer(fx.jellyfinHandler(KEY))
  try {
    const info = await jellyfin.probe({ baseUrl: srv.url, apiKey: KEY })
    assert.equal(info.serverName, 'Den Jellyfin')
    assert.deepEqual(info.users.map((u) => u.name), ['Nick', 'Sam'])
    await assert.rejects(() => jellyfin.probe({ baseUrl: srv.url, apiKey: 'wrongwrongwrong1' }), (e) => e.code === 'http_401' && !e.message.includes('wrongwrongwrong1'))
    for (const bad of ['', 'short', 'has space in it 1234', 'quote"inject12345', 'line\nbreak12345', 'a'.repeat(300), null, 42]) {
      await assert.rejects(() => jellyfin.probe({ baseUrl: srv.url, apiKey: bad }), (e) => e.code === 'bad_key', JSON.stringify(bad))
    }
  } finally { await srv.close() }
})

test('jellyfin: reads two people’s state, merges shared items, and never puts the key in an address', async () => {
  const srv = await fx.startMockServer(fx.jellyfinHandler(KEY))
  try {
    const progress = []
    const b = await jellyfin.fetchBundle({ kind: 'jellyfin', baseUrl: srv.url, apiKey: KEY, userIds: [], onProgress: (p) => progress.push(p.phase) })
    assert.equal(b.source, 'jellyfin')
    assert.match(b.label, /Den Jellyfin/)
    assert.deepEqual(b.users.map((u) => u.name), ['Nick', 'Sam'])
    assert.ok(progress.some((p) => /Reading movies/.test(p)))
    const nickKey = b.users[0].key
    const samKey = b.users[1].key
    const matrix = b.items.find((i) => i.title === 'The Matrix')
    assert.deepEqual(matrix.ids, { tmdb: '603', imdb: 'tt0133093' })
    assert.equal(matrix.fileHint, 'The Matrix (1999).mkv')
    assert.deepEqual(matrix.state[nickKey], { watched: true, playCount: 3, lastPlayedAt: Date.UTC(2023, 3, 1, 20), favorite: true })
    assert.equal(matrix.state[samKey], undefined, 'Sam has nothing on it, so nothing is carried')
    const heat = b.items.find((i) => i.title === 'Heat')
    assert.equal(heat.state[nickKey].resumeSeconds, 2713, 'ticks to whole seconds')
    assert.equal(heat.state[nickKey].durationSeconds, 10200)
    const alien = b.items.find((i) => i.title === 'Alien')
    assert.equal(alien.state[nickKey].rating, 8)
    assert.equal(alien.state[samKey].watched, true, 'one shared item, two people')
    assert.ok(!b.items.some((i) => i.title === 'Never Touched'), 'an item nobody touched is not carried')
    const ep1 = b.items.find((i) => i.type === 'episode' && i.episode === 1)
    assert.deepEqual([ep1.show.title, ep1.show.year, ep1.show.ids.tvdb, ep1.season], ['Severance', 2022, '371980', 1])
    assert.equal(b.items.find((i) => i.type === 'episode' && i.episode === 2).state[nickKey].resumeSeconds, 601)
    const showRating = b.items.find((i) => i.type === 'show' && i.title === 'Chernobyl')
    assert.equal(showRating.state[nickKey].rating, 9.5)
    assert.match(b.warnings.join(' '), /1 favourite show\(s\) were not imported/)
    // The playlist keeps its order and brings along an item nobody had touched.
    assert.equal(b.lists.length, 1)
    assert.deepEqual(b.lists[0].refs.map((r) => b.items.find((i) => i.ref === r).title), ['Heat', 'The Matrix', 'Untouched Playlist Film'])
    // The key travelled only in headers, on every request.
    assert.ok(srv.requests.length > 8)
    for (const r of srv.requests) {
      assert.ok(!r.url.includes(KEY), 'the key is never in an address: ' + r.path)
      assert.equal(r.headers['x-emby-token'], KEY)
      assert.match(r.headers.authorization, /^MediaBrowser .*Token="/)
    }
    assert.ok(!JSON.stringify(b).includes(KEY), 'and it is not in the result')
  } finally { await srv.close() }
})

test('jellyfin: only the chosen people are read, and a server that pages is read to the end', async () => {
  const data = fx.fixtureJson('jellyfin', 'server.json')
  const uid = data.users[0].Id
  data.movies[uid] = Array.from({ length: 1200 }, (_, i) => ({ Id: 'mm' + i, Name: 'Film ' + i, ProductionYear: 2000, ProviderIds: { Tmdb: String(1000 + i) }, UserData: { Played: true, PlayCount: 1 } }))
  const srv = await fx.startMockServer(fx.jellyfinHandler(KEY, data))
  try {
    const b = await jellyfin.fetchBundle({ kind: 'emby', baseUrl: srv.url, apiKey: KEY, userIds: [uid] })
    assert.equal(b.source, 'emby')
    assert.match(b.label, /^Emby server/)
    assert.deepEqual(b.users.map((u) => u.name), ['Nick'])
    assert.equal(b.items.filter((i) => i.type === 'movie' && /^Film /.test(i.title)).length, 1200)
    assert.ok(!srv.requests.some((r) => r.path.includes(data.users[1].Id)), 'the other person was never asked about')
    await assert.rejects(() => jellyfin.fetchBundle({ kind: 'jellyfin', baseUrl: srv.url, apiKey: KEY, userIds: ['00000000-0000-0000-0000-000000000000'] }), (e) => e.code === 'no_users')
  } finally { await srv.close() }
})

test('jellyfin: one playlist that cannot be read does not lose the rest', async () => {
  const data = fx.fixtureJson('jellyfin', 'server.json')
  const uid = data.users[0].Id
  data.playlists[uid].push({ Id: 'pl-bad', Name: 'Broken' })
  const base = fx.jellyfinHandler(KEY, data)
  const srv = await fx.startMockServer((r) => (r.path === '/Playlists/pl-bad/Items' ? { status: 500, body: {} } : base(r)))
  try {
    const b = await jellyfin.fetchBundle({ kind: 'jellyfin', baseUrl: srv.url, apiKey: KEY, userIds: [uid] })
    assert.equal(b.lists.length, 1)
    assert.match(b.warnings.join(' '), /A playlist could not be read/)
  } finally { await srv.close() }
})

// ---- Plex ---------------------------------------------------------------------------------------
test('plex: reads one person’s movies, shows, episodes and playlists; the token is only ever a header', async () => {
  const srv = await fx.startMockServer(fx.plexHandler(TOKEN))
  try {
    // plex.tv and the discovery host are public-only hosts and are not reachable from a test, so
    // the watchlist calls are answered by an injected transport.
    const data = fx.fixtureJson('plex', 'server.json')
    const seenHosts = []
    const getJson = (base, path, opts) => {
      const host = base instanceof URL ? base.origin : String(base)
      if (host === 'https://plex.tv') { seenHosts.push('plex.tv'); assert.equal(opts.publicOnly, true); return Promise.resolve(data.user) }
      if (host === 'https://discover.provider.plex.tv') { seenHosts.push('discover'); assert.equal(opts.publicOnly, true); return Promise.resolve(data.watchlist) }
      return safeFetch.getJson(base, path, opts)
    }
    const b = await plex.fetchBundle({ baseUrl: srv.url, token: TOKEN, getJson })
    assert.equal(b.source, 'plex')
    assert.match(b.label, /Den Plex/)
    assert.deepEqual(b.users, [{ key: 'plex', name: 'nickplex' }])
    assert.deepEqual(seenHosts, ['plex.tv', 'discover'])
    const s = (title) => b.items.find((i) => i.title === title).state.plex
    assert.deepEqual(s('The Matrix'), { watched: true, playCount: 2, lastPlayedAt: 1682971200000, rating: 9 })
    assert.deepEqual(b.items.find((i) => i.title === 'The Matrix').ids, { imdb: 'tt0133093', tmdb: '603', tvdb: '169' })
    assert.equal(b.items.find((i) => i.title === 'The Matrix').fileHint, 'The Matrix (1999).mkv')
    assert.deepEqual(s('Heat'), { lastPlayedAt: 1672689600000, resumeSeconds: 2713, durationSeconds: 10200 })
    assert.deepEqual(s('Rated Only'), { rating: 7.5 })
    assert.ok(!b.items.some((i) => i.title === 'Unwatched One'), 'nothing to carry, so not carried')
    const sev = b.items.find((i) => i.type === 'show' && i.title === 'Severance')
    assert.equal(sev.state.plex.rating, 10)
    const ep = b.items.find((i) => i.type === 'episode' && i.episode === 1)
    assert.deepEqual([ep.show.title, ep.show.ids.tvdb, ep.season], ['Severance', '371980', 1])
    assert.equal(b.items.find((i) => i.type === 'episode' && i.episode === 2).state.plex.resumeSeconds, 601)
    assert.ok(!b.items.some((i) => i.title === 'In Perpetuity'))
    // Watchlist items come from the discovery host; a non-video entry is ignored.
    assert.deepEqual(b.items.filter((i) => i.state.plex && i.state.plex.watchlist).map((i) => [i.type, i.title]), [['movie', 'Blade Runner 2049'], ['show', 'Chernobyl']])
    // Playlists: the smart one is skipped, the manual one keeps its order.
    assert.deepEqual(b.lists.map((l) => l.name), ['Plex Marathon'])
    assert.deepEqual(b.lists[0].refs.map((r) => b.items.find((i) => i.ref === r).title), ['Heat', 'The Matrix'])
    for (const r of srv.requests) {
      assert.ok(!r.url.includes(TOKEN), 'the token is never in an address: ' + r.path)
      assert.equal(r.headers['x-plex-token'], TOKEN)
    }
    assert.ok(!JSON.stringify(b).includes(TOKEN))
    assert.ok(!srv.requests.some((r) => r.path.includes('/library/sections/3/')), 'music sections are not read')
  } finally { await srv.close() }
})

test('plex: probe lists the libraries; a bad token or address is a short code', async () => {
  const srv = await fx.startMockServer(fx.plexHandler(TOKEN))
  try {
    const p = await plex.probe({ baseUrl: srv.url, token: TOKEN })
    assert.equal(p.serverName, 'Den Plex')
    assert.deepEqual(p.sections.map((s) => s.title), ['Movies', 'TV Shows'])
    await assert.rejects(() => plex.probe({ baseUrl: srv.url, token: 'not-the-token-0000' }), (e) => e.code === 'http_401')
    await assert.rejects(() => plex.probe({ baseUrl: srv.url, token: 'short' }), (e) => e.code === 'bad_key')
    await assert.rejects(() => plex.probe({ baseUrl: 'ftp://x', token: TOKEN }), (e) => e.code === 'bad_address')
    await assert.rejects(() => plex.probe({ baseUrl: 'http://169.254.169.254', token: TOKEN }), (e) => e.code === 'blocked_address')
  } finally { await srv.close() }
})

test('plex: a watchlist-only read needs no server address', async () => {
  const data = fx.fixtureJson('plex', 'server.json')
  const getJson = (base) => Promise.resolve(String(base).includes('discover') ? data.watchlist : data.user)
  const b = await plex.fetchBundle({ token: TOKEN, getJson })
  assert.equal(b.label, 'Plex Watchlist')
  assert.equal(b.items.length, 2)
  await assert.rejects(() => plex.fetchBundle({ token: TOKEN, getJson: () => Promise.reject(Object.assign(new Error('x'), { code: 'http_401' })) }), (e) => e.code === 'http_401')
})
