'use strict'
// The away-from-home household plan quality cap: beebo-standard limits
// AWAY-FROM-HOME "Original"/direct-file playback to 1080p; beebo-standard-4k
// does not. Home playback is never touched. This is the server-side
// enforcement point for the two-tier pricing split in
// site-pages/relay-pricing.json - see electron/awayQualityPolicy.js for the
// pure plan->cap mapping and electron/streamServer.js's enforceAwayQualityCap
// for the wiring (the /file and /tvfile routes).
//
// Run: node --test test/away-quality-cap.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const server = require('../electron/streamServer')
const auth = require('../electron/auth')
const videoQuality = require('../electron/videoQuality')
const { testPort } = require('./helpers/testPort')

// Shared secret for the "really came through the trusted remote-host agent" checks
// below (see localAccessPolicy.js's fromHostAgent / viewerIdentity.js). Requests in
// these tests run from Node's own loopback fetch(), so with this secret set at server
// start and sent back as X-Beebo-Agent-Key, they are treated exactly like a real
// forwarded away-from-home request from resources/beebo-rtc-host/beebo-rtc-host.js.
const AGENT_SECRET = crypto.randomBytes(32).toString('hex')

function findTool(name) {
  const convert = require('../electron/convert')
  const fromApp = name === 'ffmpeg' ? convert.ffmpegPath() : convert.ffprobePath()
  if (fromApp) return fromApp
  const r = spawnSync(name, ['-version'], { windowsHide: true })
  return r.status === 0 ? name : null
}
const FFMPEG = findTool('ffmpeg')
const FFPROBE = findTool('ffprobe')

function makeStore(initial = {}) {
  const data = { ...initial }
  return { data, get: (k, d) => (k in data ? data[k] : d), set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
}

// A license stub in the same shape license.js's real evaluate() returns
// (see viewing-privacy-http.test.js for the same plain-object-stub pattern -
// no need to sign a real token to exercise streamServer.js's own logic).
const licenseStub = (overrides) => ({ evaluate: () => ({ enforced: true, serve: true, payload: { plan: 'beebo-standard' }, ...overrides }) })
const licenseDisabled = { evaluate: () => ({ enforced: false, serve: true }) }

async function startServer({ dir, cacheDir, license, extra = {}, agentSecret } = {}) {
  const store = makeStore()
  const { user } = auth.createUser(store, 'Viewer', 'viewer@example.com')
  const port = testPort()
  const info = server.startStreamServer({
    port, store, getMoviesDir: () => dir, getTvShowsDir: () => null,
    getAllMoviesDirs: () => [dir], getAllTvShowsDirs: () => [],
    getTmdbCacheDir: () => cacheDir, log: () => {},
    ...(license ? { license } : {}),
    agentSecret: agentSecret || AGENT_SECRET,
    playback: { tmpRoot: path.join(dir, '..', 'tmp'), ffmpegPath: () => FFMPEG, ffprobePath: () => FFPROBE, ...extra }
  })
  const base = 'http://127.0.0.1:' + info.port
  for (let i = 0; i < 50; i++) {
    try { await (await fetch(base + '/api/ping')).arrayBuffer(); break } catch { await new Promise((r) => setTimeout(r, 100)) }
  }
  const cookie = 'beebo_session=' + auth.signSession(store, user.id)
  return { info, base, store, user, cookie }
}

function markQualityTier(cacheDir, filePath, tier) {
  const stat = fs.statSync(filePath)
  const data = videoQuality.readCache(cacheDir)
  data[videoQuality.keyFor(filePath, stat)] = tier
  videoQuality.writeCache(cacheDir, data)
}

// A request that came through Beebo's OWN relay: it reaches the server through the
// trusted remote-host agent (loopback + the per-run secret) stamped 'relay-beebo'. That is
// the only away-from-home connection the plan cap applies to: a direct HTTPS connection
// (below) and the household's own relay are free at any quality. Home is loopback with
// no proxy header and no agent secret.
const AWAY_HEADERS = { 'x-forwarded-for': '203.0.113.8', 'x-beebo-agent-key': AGENT_SECRET, 'x-beebo-remote-path': 'relay-beebo' }
// Direct HTTPS from a non-home address, NOT through the agent (a forwarded port, the
// household's own reverse proxy): any proxy header marks it as "away" on the loopback test socket.
const DIRECT_HEADERS = { 'x-forwarded-for': '203.0.113.8' }

test('home playback is never capped, whatever the plan says', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-away-cap-home-'))
  const cacheDir = path.join(dir, 'cache')
  const file = path.join(dir, 'Movie (2020).mkv')
  fs.writeFileSync(file, 'x'.repeat(2000))
  const s = await startServer({ dir, cacheDir, license: licenseStub() })
  try {
    markQualityTier(cacheDir, file, '2160p')
    const id = server.encodeId('Movie (2020).mkv')
    const r = await fetch(s.base + `/file?id=${encodeURIComponent(id)}`, { headers: { Cookie: s.cookie }, redirect: 'manual' })
    assert.equal(r.status, 200, 'home requests are served the original directly, capped plan or not')
    assert.equal((await r.arrayBuffer()).byteLength, 2000)
  } finally {
    await new Promise((r) => s.info.close(r))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('away + beebo-standard + an above-1080p file: the original is refused, not silently served', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-away-cap-refuse-'))
  const cacheDir = path.join(dir, 'cache')
  const file = path.join(dir, 'Movie (2020).mkv')
  fs.writeFileSync(file, 'x'.repeat(2000))
  // No working ffmpeg/ffprobe wired in: the transcode redirect cannot start,
  // so the server must refuse outright rather than fall back to the original.
  const s = await startServer({ dir, cacheDir, license: licenseStub(), extra: { ffmpegPath: () => null, ffprobePath: () => null } })
  try {
    markQualityTier(cacheDir, file, '2160p')
    const id = server.encodeId('Movie (2020).mkv')
    const r = await fetch(s.base + `/file?id=${encodeURIComponent(id)}`, { headers: { Cookie: s.cookie, ...AWAY_HEADERS }, redirect: 'manual' })
    assert.notEqual(r.status, 200, 'never falls back to serving the uncapped original')
    const body = await r.json()
    assert.equal(body.error, 'away_quality_capped')
    assert.equal(body.maxAwayQuality, '1080p')
  } finally {
    await new Promise((r) => s.info.close(r))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('away + beebo-standard + an above-1080p file: an offline download is a plain 403 with the reason, whatever the transcoder could do', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-away-cap-download-'))
  const cacheDir = path.join(dir, 'cache')
  const file = path.join(dir, 'Movie (2020).mkv')
  fs.writeFileSync(file, 'x'.repeat(2000))
  const s = await startServer({ dir, cacheDir, license: licenseStub() })
  try {
    markQualityTier(cacheDir, file, '2160p')
    const id = server.encodeId('Movie (2020).mkv')
    const r = await fetch(s.base + `/file?id=${encodeURIComponent(id)}`, { headers: { Cookie: s.cookie, ...AWAY_HEADERS, 'X-Beebo-Download': '1' }, redirect: 'manual' })
    assert.equal(r.status, 403)
    assert.equal(r.headers.get('location'), null)
    const body = await r.json()
    assert.equal(body.error, 'away_quality_capped')
    assert.equal(body.maxAwayQuality, '1080p')
    assert.match(body.message, /download/i)
  } finally {
    await new Promise((r) => s.info.close(r))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('away + beebo-standard + a file at or below 1080p: served directly, no cap', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-away-cap-ok-'))
  const cacheDir = path.join(dir, 'cache')
  const file = path.join(dir, 'Movie (2020).mkv')
  fs.writeFileSync(file, 'x'.repeat(1500))
  const s = await startServer({ dir, cacheDir, license: licenseStub() })
  try {
    markQualityTier(cacheDir, file, '1080p')
    const id = server.encodeId('Movie (2020).mkv')
    const r = await fetch(s.base + `/file?id=${encodeURIComponent(id)}`, { headers: { Cookie: s.cookie, ...AWAY_HEADERS }, redirect: 'manual' })
    assert.equal(r.status, 200)
    assert.equal((await r.arrayBuffer()).byteLength, 1500)
  } finally {
    await new Promise((r) => s.info.close(r))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('away + a not-yet-probed file: served directly (no proof it exceeds the cap)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-away-cap-unknown-'))
  const cacheDir = path.join(dir, 'cache')
  const file = path.join(dir, 'Movie (2020).mkv')
  fs.writeFileSync(file, 'x'.repeat(900))
  const s = await startServer({ dir, cacheDir, license: licenseStub() })
  try {
    // Deliberately never call markQualityTier: this file has no cache entry.
    const id = server.encodeId('Movie (2020).mkv')
    const r = await fetch(s.base + `/file?id=${encodeURIComponent(id)}`, { headers: { Cookie: s.cookie, ...AWAY_HEADERS }, redirect: 'manual' })
    assert.equal(r.status, 200)
  } finally {
    await new Promise((r) => s.info.close(r))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('away + beebo-standard-4k: an above-1080p file is served directly, uncapped', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-away-cap-4k-'))
  const cacheDir = path.join(dir, 'cache')
  const file = path.join(dir, 'Movie (2020).mkv')
  fs.writeFileSync(file, 'x'.repeat(2000))
  const s = await startServer({ dir, cacheDir, license: licenseStub({ payload: { plan: 'beebo-standard-4k' } }) })
  try {
    markQualityTier(cacheDir, file, '2160p')
    const id = server.encodeId('Movie (2020).mkv')
    const r = await fetch(s.base + `/file?id=${encodeURIComponent(id)}`, { headers: { Cookie: s.cookie, ...AWAY_HEADERS }, redirect: 'manual' })
    assert.equal(r.status, 200)
    assert.equal((await r.arrayBuffer()).byteLength, 2000)
  } finally {
    await new Promise((r) => s.info.close(r))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('away + an unrecognized/missing plan value fails closed to the 1080p cap, never open to 4K', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-away-cap-failclosed-'))
  const cacheDir = path.join(dir, 'cache')
  const file = path.join(dir, 'Movie (2020).mkv')
  fs.writeFileSync(file, 'x'.repeat(2000))
  const s = await startServer({ dir, cacheDir, license: licenseStub({ payload: { plan: 'some-future-plan' } }), extra: { ffmpegPath: () => null, ffprobePath: () => null } })
  try {
    markQualityTier(cacheDir, file, '2160p')
    const id = server.encodeId('Movie (2020).mkv')
    const r = await fetch(s.base + `/file?id=${encodeURIComponent(id)}`, { headers: { Cookie: s.cookie, ...AWAY_HEADERS }, redirect: 'manual' })
    assert.notEqual(r.status, 200)
    const body = await r.json()
    assert.equal(body.maxAwayQuality, '1080p')
  } finally {
    await new Promise((r) => s.info.close(r))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('licensing not enforced (dark launch): no quality cap anywhere, matching existing away-access behaviour', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-away-cap-disabled-'))
  const cacheDir = path.join(dir, 'cache')
  const file = path.join(dir, 'Movie (2020).mkv')
  fs.writeFileSync(file, 'x'.repeat(2000))
  const s = await startServer({ dir, cacheDir, license: licenseDisabled })
  try {
    markQualityTier(cacheDir, file, '2160p')
    const id = server.encodeId('Movie (2020).mkv')
    const r = await fetch(s.base + `/file?id=${encodeURIComponent(id)}`, { headers: { Cookie: s.cookie, ...AWAY_HEADERS }, redirect: 'manual' })
    assert.equal(r.status, 200)
    assert.equal((await r.arrayBuffer()).byteLength, 2000)
  } finally {
    await new Promise((r) => s.info.close(r))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('no license wired at all: identical to today - unrestricted (matches every other test that omits license)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-away-cap-nolicense-'))
  const cacheDir = path.join(dir, 'cache')
  const file = path.join(dir, 'Movie (2020).mkv')
  fs.writeFileSync(file, 'x'.repeat(2000))
  const s = await startServer({ dir, cacheDir })
  try {
    markQualityTier(cacheDir, file, '2160p')
    const id = server.encodeId('Movie (2020).mkv')
    const r = await fetch(s.base + `/file?id=${encodeURIComponent(id)}`, { headers: { Cookie: s.cookie, ...AWAY_HEADERS }, redirect: 'manual' })
    assert.equal(r.status, 200)
  } finally {
    await new Promise((r) => s.info.close(r))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('real ffmpeg: an over-cap away request is redirected into the existing 1080p HLS pipeline', { skip: !(FFMPEG && FFPROBE) ? 'ffmpeg/ffprobe not found' : false, timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-away-cap-redirect-'))
  const cacheDir = path.join(dir, 'cache')
  const file = path.join(dir, 'Movie (2020).mkv')
  const enc = spawnSync(FFMPEG, ['-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=25:d=6', '-f', 'lavfi', '-i', 'sine=f=440:d=6',
    '-map', '0', '-map', '1', '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'aac', file], { encoding: 'utf8', windowsHide: true })
  assert.equal(enc.status, 0, enc.stderr)
  const s = await startServer({ dir, cacheDir, license: licenseStub() })
  try {
    // The probe cache says this file is above the cap (it doesn't have to
    // match the fixture's real 720p pixels - only the enforcement path is
    // under test here, the real transcode is playback-api.test.js's job).
    markQualityTier(cacheDir, file, '2160p')
    const id = server.encodeId('Movie (2020).mkv')
    const r = await fetch(s.base + `/file?id=${encodeURIComponent(id)}`, { headers: { Cookie: s.cookie, ...AWAY_HEADERS }, redirect: 'manual' })
    assert.equal(r.status, 302)
    assert.match(r.headers.get('location'), /^\/hls\/[A-Za-z0-9_.-]+\/index\.m3u8$/)
    const pl = await fetch(s.base + r.headers.get('location'))
    assert.equal(pl.status, 200)
    assert.match(pl.headers.get('content-type'), /mpegurl/)

    // The phone app's offline download marks its request; a download saves whatever comes
    // back as the film, so it is refused with a reason instead of being handed a playlist.
    const dl = await fetch(s.base + `/file?id=${encodeURIComponent(id)}`, { headers: { Cookie: s.cookie, ...AWAY_HEADERS, 'X-Beebo-Download': '1' }, redirect: 'manual' })
    assert.equal(dl.status, 403)
    assert.equal(dl.headers.get('location'), null)
    const body = await dl.json()
    assert.equal(body.error, 'away_quality_capped')
    assert.match(body.message, /at home/i)
  } finally {
    await new Promise((r) => s.info.close(r))
    await new Promise((r) => setTimeout(r, 300))
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

test('/api/playback/info advertises the plan cap height so the client can explain itself (advisory only)', async (t) => {
  const dirs = [
    fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-away-cap-info-std-')),
    fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-away-cap-info-4k-')),
    fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-away-cap-info-off-'))
  ]
  for (const d of dirs) fs.writeFileSync(path.join(d, 'Movie (2020).mkv'), 'x'.repeat(500))
  const standard = await startServer({ dir: dirs[0], cacheDir: path.join(dirs[0], 'cache'), license: licenseStub() })
  const fourK = await startServer({ dir: dirs[1], cacheDir: path.join(dirs[1], 'cache'), license: licenseStub({ payload: { plan: 'beebo-standard-4k' } }) })
  const disabled = await startServer({ dir: dirs[2], cacheDir: path.join(dirs[2], 'cache'), license: licenseDisabled })
  try {
    const id = server.encodeId('Movie (2020).mkv')
    const token = (s) => 'Bearer ' + server.makeApiToken(s.store, s.user.id)
    const infoStd = await fetch(standard.base + `/api/playback/info?kind=movie&id=${encodeURIComponent(id)}`, { headers: { Authorization: token(standard) } }).then((r) => r.json())
    assert.equal(infoStd.awayQualityCapHeight, 1080, 'beebo-standard advertises the 1080p cap')
    const info4k = await fetch(fourK.base + `/api/playback/info?kind=movie&id=${encodeURIComponent(id)}`, { headers: { Authorization: token(fourK) } }).then((r) => r.json())
    assert.equal(info4k.awayQualityCapHeight, null, 'beebo-standard-4k advertises no cap')
    const infoOff = await fetch(disabled.base + `/api/playback/info?kind=movie&id=${encodeURIComponent(id)}`, { headers: { Authorization: token(disabled) } }).then((r) => r.json())
    assert.equal(infoOff.awayQualityCapHeight, null, 'licensing not enforced advertises no cap')
  } finally {
    await Promise.all([standard, fourK, disabled].map((s) => new Promise((r) => s.info.close(r))))
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
  }
})

test('awayQualityPolicy: pure plan->cap mapping fails closed', () => {
  const policy = require('../electron/awayQualityPolicy')
  assert.equal(policy.awayQualityCapForPlan('beebo-standard'), '1080p')
  assert.equal(policy.awayQualityCapForPlan('beebo-standard-4k'), '4k')
  for (const bad of [undefined, null, '', 'beebo-vpn', 'beebo-standard-4K', 'anything-else']) {
    assert.equal(policy.awayQualityCapForPlan(bad), '1080p', `fails closed for ${JSON.stringify(bad)}`)
  }
  assert.equal(policy.tierExceedsAwayCap('2160p', '1080p'), true)
  assert.equal(policy.tierExceedsAwayCap('1080p', '1080p'), false)
  assert.equal(policy.tierExceedsAwayCap('720p', '1080p'), false)
  assert.equal(policy.tierExceedsAwayCap(null, '1080p'), false)
  assert.equal(policy.tierExceedsAwayCap('2160p', '4k'), false)
})

test('awayQualityPolicy: isFreeRemoteConnection - only a proven direct or own-relay path is free', () => {
  const policy = require('../electron/awayQualityPolicy')
  assert.equal(policy.isFreeRemoteConnection('direct'), true)
  assert.equal(policy.isFreeRemoteConnection('relay-cloudflare'), true)
  assert.equal(policy.isFreeRemoteConnection('relay-custom'), true)
  // Fails closed: Beebo's own relay, an unidentified relay hop, a missing/empty value,
  // and anything this module doesn't recognize all fall through to the paid gate/cap.
  for (const notFree of ['relay-beebo', 'relay-other', '', undefined, null, 'Direct', 'RELAY-CLOUDFLARE', 'own', 'beebo']) {
    assert.equal(policy.isFreeRemoteConnection(notFree), false, `${JSON.stringify(notFree)} must not be treated as free`)
  }
})

// --- direct HTTPS is free: a request that did not come through the host agent can never have
// used Beebo's relay, so it is 'direct' whatever the plan says ------------------------------
async function rawCapRequest({ headers, plan = 'beebo-standard', extra } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-away-cap-direct-'))
  const cacheDir = path.join(dir, 'cache')
  const file = path.join(dir, 'Movie (2020).mkv')
  fs.writeFileSync(file, 'x'.repeat(2000))
  const s = await startServer({ dir, cacheDir, license: licenseStub({ payload: { plan } }), extra: extra || { ffmpegPath: () => null, ffprobePath: () => null } })
  try {
    markQualityTier(cacheDir, file, '2160p')
    const id = server.encodeId('Movie (2020).mkv')
    const r = await fetch(s.base + `/file?id=${encodeURIComponent(id)}`, { headers: { Cookie: s.cookie, ...headers }, redirect: 'manual' })
    const bytes = r.status === 200 ? (await r.arrayBuffer()).byteLength : null
    const body = r.status === 200 ? null : await r.json()
    return { status: r.status, bytes, body }
  } finally {
    await new Promise((r) => s.info.close(r))
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('direct HTTPS (non-agent, non-home) + beebo-standard + a 2160p file: served uncapped, the plan cap only applies to Beebo Relay', async () => {
  const r = await rawCapRequest({ headers: DIRECT_HEADERS })
  assert.equal(r.status, 200)
  assert.equal(r.bytes, 2000, 'the original, not a capped redirect')
})

test('direct HTTPS: an offline download is not refused either', async () => {
  const r = await rawCapRequest({ headers: { ...DIRECT_HEADERS, 'X-Beebo-Download': '1' } })
  assert.equal(r.status, 200)
})

test('a forged x-beebo-remote-path from a non-agent socket changes nothing: direct is free whatever it claims', async () => {
  for (const claim of ['direct', 'relay-beebo', 'relay-other', 'nonsense']) {
    const r = await rawCapRequest({ headers: { ...DIRECT_HEADERS, 'x-beebo-remote-path': claim } })
    assert.equal(r.status, 200, 'claim ' + claim)
    assert.equal(r.bytes, 2000)
  }
  // A wrong agent key is the same as no agent key: not the agent, so direct.
  const wrong = await rawCapRequest({ headers: { ...DIRECT_HEADERS, 'x-beebo-agent-key': 'wrong', 'x-beebo-remote-path': 'relay-beebo' } })
  assert.equal(wrong.status, 200)
})

test('the agent path is unchanged: relay-beebo and relay-other are capped, a missing path header fails closed (not free)', async () => {
  for (const headers of [
    { ...DIRECT_HEADERS, 'x-beebo-agent-key': AGENT_SECRET, 'x-beebo-remote-path': 'relay-beebo' },
    { ...DIRECT_HEADERS, 'x-beebo-agent-key': AGENT_SECRET, 'x-beebo-remote-path': 'relay-other' },
    { ...DIRECT_HEADERS, 'x-beebo-agent-key': AGENT_SECRET },
    { ...DIRECT_HEADERS, 'x-beebo-agent-key': AGENT_SECRET, 'x-beebo-remote-path': 'Direct' }
  ]) {
    const r = await rawCapRequest({ headers })
    assert.notEqual(r.status, 200, JSON.stringify(headers))
    assert.equal(r.body.error, 'away_quality_capped')
    assert.equal(r.body.maxAwayQuality, '1080p')
  }
  for (const claim of ['direct', 'relay-cloudflare', 'relay-custom']) {
    const r = await rawCapRequest({ headers: { ...DIRECT_HEADERS, 'x-beebo-agent-key': AGENT_SECRET, 'x-beebo-remote-path': claim } })
    assert.equal(r.status, 200, 'the agent says ' + claim)
  }
})

test('awayQualityPolicy.remotePathFor: agent claim trusted as-is, non-agent away is direct, anything undecidable is not free', () => {
  const policy = require('../electron/awayQualityPolicy')
  const free = (o) => policy.isFreeRemoteConnection(policy.remotePathFor(o))
  // From the agent: exactly the header, no home test at all.
  assert.equal(policy.remotePathFor({ fromHostAgent: true, isHomeRequest: false, header: 'relay-beebo' }), 'relay-beebo')
  assert.equal(policy.remotePathFor({ fromHostAgent: true, isHomeRequest: false, header: 'relay-custom' }), 'relay-custom')
  assert.equal(free({ fromHostAgent: true, isHomeRequest: false }), false, 'agent without the header')
  assert.equal(free({ fromHostAgent: true, isHomeRequest: undefined, header: undefined }), false)
  // Not the agent, away from home: direct, regardless of what the header claims.
  for (const header of [undefined, '', 'direct', 'relay-beebo', 'relay-other', 'junk']) {
    assert.equal(policy.remotePathFor({ fromHostAgent: false, isHomeRequest: false, header }), 'direct')
  }
  // Not the agent, at home: nothing is proven (home never reads this).
  assert.equal(policy.remotePathFor({ fromHostAgent: false, isHomeRequest: true, header: 'direct' }), '')
  // Undecidable answers fail closed.
  for (const o of [undefined, {}, { fromHostAgent: undefined, isHomeRequest: false }, { fromHostAgent: false }, { fromHostAgent: 'no', isHomeRequest: false }, { fromHostAgent: false, isHomeRequest: 'no' }, { fromHostAgent: false, isHomeRequest: 0 }]) {
    assert.equal(free(o), false, JSON.stringify(o))
  }
})
