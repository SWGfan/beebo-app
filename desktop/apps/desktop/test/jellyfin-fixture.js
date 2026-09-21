// Shared fixture for the Jellyfin-compatible API tests: a real Beebo server over a tiny fixture library
// (three films, two shows, a rating-restricted profile, an adult and an owner), with the compat mode
// switched on or off by the caller. Not a test file itself.
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')

const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const enc = (s) => Buffer.from(s, 'utf8').toString('base64url')

let portSeq = 0

async function fixture({ compat = true, extra = {}, prepare, serverExtra = {}, withStandardFiles = true } = {}) {
  const server = localRequire('./electron/streamServer')
  const auth = localRequire('./electron/auth')
  const parental = localRequire('./electron/parentalControls')
  delete process.env.TMDB_API_KEY
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'beebo-jf-'))
  const moviesDir = path.join(root, 'Movies')
  const tvDir = path.join(root, 'TV')
  const cacheDir = path.join(root, 'tmdb')
  await fs.mkdir(moviesDir, { recursive: true })
  await fs.mkdir(path.join(tvDir, 'Bluey'), { recursive: true })
  await fs.mkdir(path.join(tvDir, 'Breaking Bad'), { recursive: true })
  await fs.mkdir(path.join(cacheDir, 'posters'), { recursive: true })
  const bytes = Buffer.alloc(8192, 7)
  const films = ['Toy Story (1995).mp4', 'Heat (1995).mp4', 'Paddington (2014).mp4']
  if (withStandardFiles) {
    for (const f of films) await fs.writeFile(path.join(moviesDir, f), bytes)
    await fs.writeFile(path.join(tvDir, 'Bluey', 'Bluey S01E01.mp4'), bytes)
    await fs.writeFile(path.join(tvDir, 'Bluey', 'Bluey S01E02.mp4'), bytes)
    await fs.writeFile(path.join(tvDir, 'Bluey', 'Bluey S02E01.mp4'), bytes)
    await fs.writeFile(path.join(tvDir, 'Breaking Bad', 'Breaking Bad S01E01.mp4'), bytes)
  }
  if (prepare) await prepare({ root, moviesDir, tvDir, cacheDir })
  await fs.writeFile(path.join(cacheDir, 'manifest.json'), JSON.stringify({
    'Toy Story (1995).mp4': { id: 862, title: 'Toy Story', release_date: '1995-11-22', genre_ids: [16, 35], certification: 'G', overview: 'Toys come alive.', vote_average: 8.3, poster_path: '/toy.jpg', backdrop_path: '/toyback.jpg' },
    'Heat (1995).mp4': { id: 949, title: 'Heat', release_date: '1995-12-15', genre_ids: [80], certification: 'R', overview: 'Cops and robbers.', vote_average: 8.0 },
    'Paddington (2014).mp4': { id: 116149, title: 'Paddington', release_date: '2014-11-28', genre_ids: [16, 35], certification: 'PG', vote_average: 7.1 },
  }))
  await fs.writeFile(path.join(cacheDir, 'tv-manifest.json'), JSON.stringify({
    bluey: { id: 82728, name: 'Bluey', genre_ids: [16], certification: 'TV-Y', first_air_date: '2018-10-01', overview: 'A puppy family.' },
    'breaking bad': { id: 1396, name: 'Breaking Bad', genre_ids: [80], certification: 'TV-MA', first_air_date: '2008-01-20' },
  }))
  await fs.writeFile(path.join(cacheDir, 'credits.json'), JSON.stringify({
    862: [{ id: 31, name: 'Tom Hanks', character: 'Woody' }],
    949: [{ id: 1158, name: 'Al Pacino', character: 'Vincent' }],
  }))
  await fs.writeFile(path.join(cacheDir, 'collections.json'), JSON.stringify({
    862: { id: 10194, name: 'Toy Story Collection', parts: [{ id: 862, title: 'Toy Story', release_date: '1995-11-22' }] },
  }))
  await fs.writeFile(path.join(cacheDir, 'posters', '862.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))

  const data = {
    loginLockoutThreshold: 3,
    authUsers: [
      { id: 'u-owner', name: 'Nick', username: 'nick', status: 'approved', isAdmin: true },
      { id: 'u-kid', name: 'Sam', username: 'sam', status: 'approved' },
      { id: 'u-adult', name: 'Robin', username: 'robin', status: 'approved' },
    ],
    ...(compat ? { jellyfinCompat: true } : {}),
    ...extra,
  }
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
  for (const [id, pw] of [['u-owner', 'owner-password-1'], ['u-kid', 'kid-password-1'], ['u-adult', 'adult-password-1']]) auth.setUserPassword(store, id, pw)
  parental.setPolicy(store, 'u-kid', parental.presetPolicy('kids'))

  const port = 47500 + (process.pid % 300) + 11 * (++portSeq)
  const info = server.startStreamServer({
    port, store, getMoviesDir: () => moviesDir, getTvShowsDir: () => tvDir,
    getAllMoviesDirs: () => [moviesDir], getAllTvShowsDirs: () => [tvDir],
    getTmdbCacheDir: () => cacheDir, log: () => {}, agentSecret: 'agent-secret-for-jf-tests-0123456789', ...serverExtra,
  })
  const base = 'http://127.0.0.1:' + info.port
  for (let i = 0; i < 50; i++) {
    try { await (await fetch(base + '/api/ping')).arrayBuffer(); break } catch { await new Promise((r) => setTimeout(r, 100)) }
  }

  const authHeader = (token, device = {}) =>
    'MediaBrowser Client="TestClient", Device="' + (device.name || 'Test TV') + '", DeviceId="' + (device.id || 'dev-1') + '", Version="1.0.0"' + (token ? ', Token="' + token + '"' : '')
  const jf = async (method, u, { token, body, headers = {}, raw = false } = {}) => {
    const h = { ...headers }
    if (token !== null) h['x-emby-authorization'] = authHeader(token)
    if (body !== undefined) h['content-type'] = 'application/json'
    const res = await fetch(base + u, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' })
    const buf = Buffer.from(await res.arrayBuffer())
    const text = buf.toString('utf8')
    let json = null
    if (!raw) { try { json = JSON.parse(text) } catch { json = null } }
    return { status: res.status, json, text, headers: res.headers, buf }
  }
  const login = async (username, password) => {
    const r = await jf('POST', '/Users/AuthenticateByName', { token: '', body: { Username: username, Pw: password } })
    return r
  }
  const tokens = {}
  const signIn = async (who) => {
    const creds = { owner: ['nick', 'owner-password-1'], kid: ['sam', 'kid-password-1'], adult: ['robin', 'adult-password-1'] }[who]
    const r = await login(creds[0], creds[1])
    if (r.status !== 200) throw new Error('login failed for ' + who + ': ' + r.status + ' ' + r.text)
    tokens[who] = r.json.AccessToken
    return r.json
  }
  const close = async () => {
    await new Promise((r) => info.close(r))
    await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }).catch(() => {}) // Windows: ffmpeg/Defender can hold a file for a moment after the server stops
  }
  return { server, info, auth, store, data, base, jf, login, signIn, tokens, close, enc, moviesDir, tvDir, parental, root, cacheDir }
}

module.exports = { fixture, enc, localRequire, appRoot }
