'use strict'
// The away-from-home entitlement split (business decision, 2026-09-21):
//   - home is always free, whatever the plan (unaffected by any of this - see
//     away-quality-cap.test.js's own "home playback is never capped" test and
//     viewing-privacy-http.test.js's "keeps home API usable" test);
//   - a household that connects away from home DIRECTLY (peer-to-peer) or through its
//     OWN relay (relayPolicy.js mode 'own': their own Cloudflare account or their own
//     TURN server) is free at ANY quality, with no subscription required at all, because
//     it costs Beebo nothing extra to serve;
//   - only a connection that actually falls through to BEEBO'S OWN relay still needs an
//     active plan (checked again, independently, at TURN-credential issuance in
//     worker/relay.js's /relay/credentials - see worker/test/relay.test.mjs's
//     "subscriber gating") and still gets the existing plan-based quality cap.
//
// The server tells these apart with the x-beebo-remote-path header the trusted
// remote-host agent stamps on every request it forwards (see awayQualityPolicy.js's
// own long comment on REMOTE_PATH_HEADER for why trusting it is safe), read only once
// localAccess.fromHostAgent(req) proves the request really came through that agent
// (loopback + the per-run agent secret - the same bar every other x-beebo-remote-*
// header already has to clear).
//   - a request that did NOT come through the agent and is not from home (direct HTTPS to
//     the server's own port) can never have used Beebo's relay, which always terminates at
//     the agent, so it is 'direct' = free at any quality (awayQualityPolicy.remotePathFor).
//     Only a request FROM the agent that lacks the path header stays "not proven free".
//
// Run: node --test test/free-away-connection.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const server = require('../electron/streamServer')
const auth = require('../electron/auth')
const videoQuality = require('../electron/videoQuality')
const awayQualityPolicy = require('../electron/awayQualityPolicy')

const AGENT_SECRET = crypto.randomBytes(32).toString('hex')
const AWAY = { 'x-forwarded-for': '203.0.113.9' } // marks a request as NOT home, like away-quality-cap.test.js's AWAY_HEADERS
const fromAgent = (remotePath) => ({ ...AWAY, 'x-beebo-agent-key': AGENT_SECRET, [awayQualityPolicy.REMOTE_PATH_HEADER]: remotePath })

function makeStore(initial = {}) {
  const data = { ...initial }
  return { data, get: (k, d) => (k in data ? data[k] : d), set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
}

// enforced:true, serve:false is exactly what a household with no active subscription
// (or a lapsed one) looks like once licensing is enforced - see license.js's evaluate().
const licenseNoSubscription = { evaluate: () => ({ enforced: true, serve: false, state: 'none', payload: {} }) }
const licenseStandard = { evaluate: () => ({ enforced: true, serve: true, payload: { plan: 'beebo-standard' } }) }

async function startServer({ dir, cacheDir, license } = {}) {
  const store = makeStore()
  const { user } = auth.createUser(store, 'Viewer', 'viewer@example.com')
  const port = 48200 + Math.floor(Math.random() * 400)
  const info = server.startStreamServer({
    port, store, getMoviesDir: () => dir, getTvShowsDir: () => null,
    getAllMoviesDirs: () => [dir], getAllTvShowsDirs: () => [],
    getTmdbCacheDir: () => cacheDir, log: () => {},
    agentSecret: AGENT_SECRET,
    ...(license ? { license } : {}),
    playback: { tmpRoot: path.join(dir, '..', 'tmp'), ffmpegPath: () => null, ffprobePath: () => null }
  })
  const base = 'http://127.0.0.1:' + info.port
  for (let i = 0; i < 50; i++) {
    try { await (await fetch(base + '/api/ping')).arrayBuffer(); break } catch { await new Promise((r) => setTimeout(r, 100)) }
  }
  const cookie = 'beebo_session=' + auth.signSession(store, user.id)
  return { info, base, store, user, cookie }
}

// /api/* routes authenticate with a Bearer API token (see viewing-privacy-http.test.js
// and away-quality-cap.test.js's own '/api/playback/info' test), not the browser
// session cookie the /file and /tvfile routes use.
function apiAuth(s) {
  return { Authorization: 'Bearer ' + server.makeApiToken(s.store, s.user.id) }
}

function markQualityTier(cacheDir, filePath, tier) {
  const stat = fs.statSync(filePath)
  const data = videoQuality.readCache(cacheDir)
  data[videoQuality.keyFor(filePath, stat)] = tier
  videoQuality.writeCache(cacheDir, data)
}

async function withServer(license, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-free-away-'))
  const cacheDir = path.join(dir, 'cache')
  const file = path.join(dir, 'Movie (2020).mkv')
  fs.writeFileSync(file, 'x'.repeat(2000))
  const s = await startServer({ dir, cacheDir, license })
  try {
    await fn({ ...s, dir, cacheDir, file })
  } finally {
    await new Promise((r) => s.info.close(r))
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// --- (a) home is unaffected: no agent headers, no away path, straight through -------
test('home playback needs no x-beebo-remote-path and is never touched by the free-connection logic', async () => {
  await withServer(licenseNoSubscription, async (s) => {
    const r = await fetch(s.base + '/api/me', { headers: { ...apiAuth(s) } })
    assert.equal(r.status, 200, await r.text())
  })
})

// --- (b)/(c) the license gate (streamServer.js's "remote_requires_plan") -------------
for (const [label, remotePath] of [['direct P2P', 'direct'], ["the household's own Cloudflare relay", 'relay-cloudflare'], ["the household's own TURN server", 'relay-custom']]) {
  test(`away + no active subscription + ${label}: free - the license gate does not fire`, async () => {
    await withServer(licenseNoSubscription, async (s) => {
      const r = await fetch(s.base + '/api/me', { headers: { ...apiAuth(s), ...fromAgent(remotePath) } })
      assert.equal(r.status, 200, await r.text())
    })
  })
}

for (const [label, remotePath] of [['Beebo Relay', 'relay-beebo'], ['an unidentified relay hop', 'relay-other']]) {
  test(`away + no active subscription + ${label}: still refused by the license gate`, async () => {
    await withServer(licenseNoSubscription, async (s) => {
      const r = await fetch(s.base + '/api/me', { headers: { ...apiAuth(s), ...fromAgent(remotePath) } })
      assert.equal(r.status, 402)
      const body = await r.json()
      assert.equal(body.error, 'remote_requires_plan')
    })
  })
}

test('away + no active subscription + no x-beebo-remote-path at all (older host-agent build): still refused - fails closed', async () => {
  await withServer(licenseNoSubscription, async (s) => {
    const r = await fetch(s.base + '/api/me', { headers: { ...apiAuth(s), ...AWAY, 'x-beebo-agent-key': AGENT_SECRET } })
    assert.equal(r.status, 402)
  })
})

// Direct HTTPS is free (owner-approved product model): a request that reaches this server's own
// socket, is not from home, and did NOT come through the host agent can never have used Beebo's
// relay (that always terminates at the agent), so it is 'direct' and never needs the plan.
test('away + no active subscription + a direct HTTPS request (not through the agent): free - no 402', async () => {
  await withServer(licenseNoSubscription, async (s) => {
    const r = await fetch(s.base + '/api/me', { headers: { ...apiAuth(s), ...AWAY } })
    assert.equal(r.status, 200, await r.text())
  })
})

test('away + no active subscription + a forged x-beebo-remote-path with NO/wrong agent key: ignored - it is direct (free) whatever it claims', async () => {
  await withServer(licenseNoSubscription, async (s) => {
    for (const forged of [
      { [awayQualityPolicy.REMOTE_PATH_HEADER]: 'direct' },
      { [awayQualityPolicy.REMOTE_PATH_HEADER]: 'relay-beebo' },
      { 'x-beebo-agent-key': 'not-the-secret', [awayQualityPolicy.REMOTE_PATH_HEADER]: 'relay-beebo' },
      { 'x-beebo-remote': '1', [awayQualityPolicy.REMOTE_PATH_HEADER]: 'relay-other' }
    ]) {
      const r = await fetch(s.base + '/api/me', { headers: { ...apiAuth(s), ...AWAY, ...forged } })
      assert.equal(r.status, 200, JSON.stringify(forged) + ' ' + await r.text())
    }
  })
})

test('a lapsed plan does not touch a direct client, but the same request through the agent as Beebo Relay is still 402', async () => {
  await withServer(licenseNoSubscription, async (s) => {
    const direct = await fetch(s.base + '/api/me', { headers: { ...apiAuth(s), ...AWAY } })
    assert.equal(direct.status, 200)
    await direct.arrayBuffer()
    const relayed = await fetch(s.base + '/api/me', { headers: { ...apiAuth(s), ...fromAgent('relay-beebo') } })
    assert.equal(relayed.status, 402)
    assert.equal((await relayed.json()).error, 'remote_requires_plan')
  })
})

test('an active subscription is untouched by any of this: away + Beebo Relay still works when serve is true', async () => {
  await withServer(licenseStandard, async (s) => {
    const r = await fetch(s.base + '/api/me', { headers: { ...apiAuth(s), ...fromAgent('relay-beebo') } })
    assert.equal(r.status, 200, await r.text())
  })
})

// --- (d) the away-quality cap: free connections bypass it, Beebo Relay keeps it -----
for (const [label, remotePath] of [['direct P2P', 'direct'], ['own Cloudflare relay', 'relay-cloudflare'], ['own TURN server', 'relay-custom']]) {
  test(`away quality cap: no active subscription + ${label} + a 2160p file: served uncapped`, async () => {
    await withServer(licenseNoSubscription, async (s) => {
      markQualityTier(s.cacheDir, s.file, '2160p')
      const id = server.encodeId('Movie (2020).mkv')
      const r = await fetch(s.base + `/file?id=${encodeURIComponent(id)}`, { headers: { Cookie: s.cookie, ...fromAgent(remotePath) }, redirect: 'manual' })
      assert.equal(r.status, 200)
      assert.equal((await r.arrayBuffer()).byteLength, 2000, 'the original file, not a capped/transcoded redirect')
    })
  })
}

test('away quality cap: an ACTIVE beebo-standard subscription through Beebo Relay still caps a 2160p file to 1080p', async () => {
  await withServer(licenseStandard, async (s) => {
    markQualityTier(s.cacheDir, s.file, '2160p')
    const id = server.encodeId('Movie (2020).mkv')
    // No ffmpeg/ffprobe wired in (see startServer above), so the transcode redirect
    // cannot start either - the point here is only that the cap is NOT bypassed.
    const r = await fetch(s.base + `/file?id=${encodeURIComponent(id)}`, { headers: { Cookie: s.cookie, ...fromAgent('relay-beebo') }, redirect: 'manual' })
    assert.notEqual(r.status, 200, 'never falls back to serving the uncapped original')
    const body = await r.json()
    assert.equal(body.error, 'away_quality_capped')
    assert.equal(body.maxAwayQuality, '1080p')
  })
})

test('away quality cap: an unidentified relay hop (relay-other) is treated the same as Beebo Relay - fails closed to the cap', async () => {
  await withServer(licenseStandard, async (s) => {
    markQualityTier(s.cacheDir, s.file, '2160p')
    const id = server.encodeId('Movie (2020).mkv')
    const r = await fetch(s.base + `/file?id=${encodeURIComponent(id)}`, { headers: { Cookie: s.cookie, ...fromAgent('relay-other') }, redirect: 'manual' })
    assert.notEqual(r.status, 200)
    const body = await r.json()
    assert.equal(body.error, 'away_quality_capped')
  })
})

test('away quality cap: a request that is not from the agent is direct = uncapped; a forged path header (either way) changes nothing', async () => {
  await withServer(licenseStandard, async (s) => {
    markQualityTier(s.cacheDir, s.file, '2160p')
    const id = server.encodeId('Movie (2020).mkv')
    for (const claim of [undefined, 'direct', 'relay-beebo']) {
      const r = await fetch(s.base + `/file?id=${encodeURIComponent(id)}`, {
        headers: { Cookie: s.cookie, ...AWAY, ...(claim ? { [awayQualityPolicy.REMOTE_PATH_HEADER]: claim } : {}) }, redirect: 'manual'
      })
      assert.equal(r.status, 200, 'claim ' + claim)
      assert.equal((await r.arrayBuffer()).byteLength, 2000, 'the original file: nothing Beebo pays for was used')
    }
  })
})

test('away quality cap: the agent with no path header (older host-agent build) is not proven free - still capped', async () => {
  await withServer(licenseStandard, async (s) => {
    markQualityTier(s.cacheDir, s.file, '2160p')
    const id = server.encodeId('Movie (2020).mkv')
    const r = await fetch(s.base + `/file?id=${encodeURIComponent(id)}`, { headers: { Cookie: s.cookie, ...AWAY, 'x-beebo-agent-key': AGENT_SECRET }, redirect: 'manual' })
    assert.notEqual(r.status, 200)
    assert.equal((await r.json()).error, 'away_quality_capped')
  })
})
