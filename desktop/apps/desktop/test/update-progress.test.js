// Desktop updater: ETA smoothing/stalls/resume, resumable + verified download,
// install-duration estimate, "someone is watching" deferral, watchdog marker.
// Run: node --test test/update-progress.test.js   (no Electron, local HTTP only)
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const http = require('node:http')
const crypto = require('node:crypto')

const appRoot = path.resolve(__dirname, '..')
const M = require(path.join(appRoot, 'electron', 'updateModel.js'))
const { downloadResumable, parseContentRange } = require(path.join(appRoot, 'electron', 'updateDownload.js'))
const marker = require(path.join(appRoot, 'electron', 'updateMarker.js'))

const MB = 1024 * 1024
const cmp = (a, b) => {
  const pa = String(a).split('.').map(Number); const pb = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1 }
  return 0
}

// ---------------------------------------------------------------- ETA
test('ETA: steady 1 MB/s converges and reads as minutes', () => {
  const e = M.createEtaEstimator()
  const total = 180 * MB
  e.restart(0, total, 0)
  let snap
  for (let t = 500; t <= 20000; t += 500) snap = e.sample((t / 1000) * MB, t, total)
  assert.ok(Math.abs(snap.speedBps - MB) / MB < 0.02, 'speed ~1 MB/s, got ' + snap.speedBps)
  assert.ok(Math.abs(snap.etaSeconds - 160) < 4, 'eta ~160 s, got ' + snap.etaSeconds)
  assert.equal(M.formatEta(snap.etaSeconds), 'about 3 minutes left')
})

test('ETA: bursty chunks are smoothed (no wild swings)', () => {
  const e = M.createEtaEstimator()
  const total = 100 * MB
  e.restart(0, total, 0)
  let bytes = 0
  const etas = []
  // 2 MB arrives every other 500 ms tick (average 2 MB/s, instantaneous 0 or 4)
  for (let i = 1; i <= 60; i++) {
    if (i % 2 === 0) bytes += 2 * MB
    const s = e.sample(bytes, i * 500, total)
    // compare with the truth at the average rate (remaining / 2 MB/s)
    // (near the very end both round to "a few seconds left", so skip the tail)
    if (i > 12 && total - bytes > 20 * MB) etas.push(s.etaSeconds / ((total - bytes) / (2 * MB)))
  }
  const min = Math.min(...etas), max = Math.max(...etas)
  assert.ok(min > 0.75 && max < 1.35, 'ETA strays from the truth: ' + min + '..' + max)
})

test('ETA: speed drop is followed within a few half-lives', () => {
  const e = M.createEtaEstimator({ halfLifeMs: 4000 })
  const total = 500 * MB
  e.restart(0, total, 0)
  let bytes = 0, t = 0
  for (; t < 20000; t += 500) { bytes += 5 * MB / 2; e.sample(bytes, t + 500, total) }
  for (; t < 40000; t += 500) { bytes += MB / 2; e.sample(bytes, t + 500, total) }
  const s = e.snapshot(40000)
  assert.ok(s.speedBps < 1.3 * MB, 'should have slowed to ~1 MB/s, got ' + s.speedBps / MB)
})

test('ETA: a stall gives no estimate, then recovers', () => {
  const e = M.createEtaEstimator({ stallMs: 8000 })
  const total = 50 * MB
  e.restart(0, total, 0)
  for (let t = 500; t <= 5000; t += 500) e.sample((t / 1000) * MB, t, total)
  assert.equal(e.snapshot(9000).stalled, false)
  const stalled = e.snapshot(14000)
  assert.equal(stalled.stalled, true)
  assert.equal(stalled.etaSeconds, null)
  assert.equal(stalled.speedBps, 0)
  const back = e.sample(6 * MB, 14500, total)
  assert.equal(back.stalled, false)
})

test('ETA: resume re-anchors so the bytes already on disk are not a speed spike', () => {
  const e = M.createEtaEstimator()
  const total = 200 * MB
  e.restart(0, total, 0)
  for (let t = 500; t <= 10000; t += 500) e.sample((t / 1000) * MB, t, total)
  // paused for a minute, the .part holds 10 MB; resume
  e.restart(10 * MB, total, 70000)
  const s = e.sample(10.5 * MB, 70500, total)
  assert.ok(s.speedBps < 2 * MB, 'no spike after resume, got ' + s.speedBps / MB + ' MB/s')
  assert.ok(s.etaSeconds > 120 && s.etaSeconds < 260, 'eta sane after resume: ' + s.etaSeconds)
})

test('ETA wording buckets', () => {
  assert.equal(M.formatEta(null), '')
  assert.equal(M.formatEta(3), 'a few seconds left')
  assert.equal(M.formatEta(30), 'less than a minute left')
  assert.equal(M.formatEta(70), 'about a minute left')
  assert.equal(M.formatEta(125), 'about 2 minutes left')
  assert.equal(M.formatEta(3600), 'about 1 hour left')
  assert.equal(M.formatDuration(45), '45 seconds')
  assert.equal(M.formatDuration(120), '2 minutes')
})

// ---------------------------------------------------------------- install estimate
test('install estimate: default, median of recent, rounded up, implausible ignored', () => {
  assert.equal(M.estimateInstallSeconds([]), M.DEFAULT_INSTALL_SECONDS)
  assert.equal(M.estimateInstallSeconds(undefined), M.DEFAULT_INSTALL_SECONDS)
  assert.equal(M.estimateInstallSeconds([{ seconds: 41 }]), 45)
  assert.equal(M.estimateInstallSeconds([{ seconds: 30 }, { seconds: 90 }, { seconds: 40 }]), 40)
  assert.equal(M.estimateInstallSeconds([{ seconds: 2 }, { seconds: 99999 }, { seconds: 'x' }]), M.DEFAULT_INSTALL_SECONDS)
  let h = []
  for (const s of [100, 100, 100, 30, 32, 31, 33, 34]) h = M.recordInstallDuration(h, s, { at: 1 })
  assert.equal(h.length, 5, 'keeps the last five')
  assert.equal(M.estimateInstallSeconds(h), 35)
  assert.equal(M.recordInstallDuration(h, 1).length, 5, 'implausible durations are not recorded')
})

test('after relaunch: updated / waiting / failed / forgotten', () => {
  const t0 = 1_000_000
  const pending = { from: '0.1.33', to: '0.1.34', launchedAt: t0 }
  assert.deepEqual(M.resolvePendingUpdate(pending, '0.1.34', t0 + 42000, cmp), { kind: 'updated', seconds: 42 })
  assert.equal(M.resolvePendingUpdate(pending, '0.1.33', t0 + 30000, cmp).kind, 'waiting')
  assert.equal(M.resolvePendingUpdate(pending, '0.1.33', t0 + 10 * 60000, cmp).kind, 'failed')
  assert.equal(M.resolvePendingUpdate(pending, '0.1.33', t0 + 3 * 86400000, cmp).kind, 'none')
  assert.equal(M.resolvePendingUpdate(null, '0.1.33', t0, cmp).kind, 'none')
})

// ---------------------------------------------------------------- viewers + deferral
function fakeStore(data) { return { get: (k) => data[k] } }

test('activeViewers: recent unfinished sessions only, both history keys', () => {
  const now = 10_000_000
  const store = fakeStore({
    watchHistory: [
      { sessionId: 'a', title: 'Up', userName: 'Nick', lastUpdate: now - 20000, currentTime: 600, duration: 5000 },
      { sessionId: 'b', title: 'Old', lastUpdate: now - 10 * 60000, currentTime: 10, duration: 5000 },
      { sessionId: 'c', title: 'Finished', lastUpdate: now - 5000, currentTime: 4998, duration: 5000 },
      null, 'junk', { sessionId: 'd' }
    ],
    watchHistoryPending: [{ sessionId: 'e', title: 'Surfing', lastUpdate: now - 1000, currentTime: 50, duration: 0 }]
  })
  const v = M.activeViewers(store, now)
  assert.deepEqual(v.map((x) => x.title).sort(), ['Surfing', 'Up'])
  assert.equal(v.find((x) => x.title === 'Up').user, 'Nick')
  assert.deepEqual(M.activeViewers(fakeStore({}), now), [])
  assert.deepEqual(M.activeViewers(null, now), [])
})

test('deferral: now always installs; idle waits for viewers then a quiet spell', () => {
  const now = Date.UTC(2026, 8, 16, 18, 0, 0)
  assert.equal(M.decideInstallTiming({ mode: 'now', viewerCount: 3, now }).action, 'install')
  const watching = M.decideInstallTiming({ mode: 'idle', viewerCount: 1, now, idleSince: null })
  assert.equal(watching.action, 'wait')
  assert.equal(watching.reason, 'watching')
  const settling = M.decideInstallTiming({ mode: 'idle', viewerCount: 0, now, idleSince: now - 30000 })
  assert.equal(settling.action, 'wait')
  assert.equal(settling.reason, 'settling')
  assert.ok(settling.nextCheckMs <= 30000)
  assert.equal(M.decideInstallTiming({ mode: 'idle', viewerCount: 0, now, idleSince: now - M.IDLE_MS }).action, 'install')
})

test('deferral: tonight waits for the quiet window, still respects viewers, and never slips a day', () => {
  const local = (d, h, m = 0) => new Date(2026, 8, d, h, m, 0).getTime()
  const requestedAt = local(16, 20)
  const evening = M.decideInstallTiming({ mode: 'tonight', viewerCount: 0, now: local(16, 21), idleSince: local(16, 20), requestedAt })
  assert.equal(evening.action, 'wait')
  assert.equal(evening.reason, 'tonight')
  assert.equal(evening.installAt, local(17, 3))
  const threeAmWatching = M.decideInstallTiming({ mode: 'tonight', viewerCount: 1, now: local(17, 3, 5), idleSince: null, requestedAt })
  assert.equal(threeAmWatching.action, 'wait')
  assert.equal(threeAmWatching.reason, 'watching')
  const threeAmQuiet = M.decideInstallTiming({ mode: 'tonight', viewerCount: 0, now: local(17, 3, 5), idleSince: local(17, 1), requestedAt })
  assert.equal(threeAmQuiet.action, 'install')
  // Someone watched right through the window: afterwards it behaves like "idle"
  const afterWindow = M.decideInstallTiming({ mode: 'tonight', viewerCount: 0, now: local(17, 7), idleSince: local(17, 6, 50), requestedAt })
  assert.equal(afterWindow.action, 'install')
  assert.equal(M.nextQuietStart(local(16, 2), 3), local(16, 3))
})

// ---------------------------------------------------------------- download
function makeServer(payload, opts = {}) {
  let requests = []
  let failNext = opts.failFirstAfterBytes || 0
  const server = http.createServer((req, res) => {
    requests.push({ range: req.headers.range || null })
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/file' }); return res.end() }
    if (req.url === '/missing') { res.writeHead(404); return res.end() }
    let start = 0
    const m = /^bytes=(\d+)-$/.exec(req.headers.range || '')
    if (m && !opts.ignoreRange) {
      start = Number(m[1])
      if (start >= payload.length) { res.writeHead(416, { 'Content-Range': 'bytes */' + payload.length }); return res.end() }
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${payload.length - 1}/${payload.length}`, 'Content-Length': payload.length - start })
    } else {
      res.writeHead(200, { 'Content-Length': payload.length })
    }
    const body = payload.subarray(start)
    if (failNext) {
      const cut = failNext
      failNext = 0
      res.write(body.subarray(0, cut), () => setTimeout(() => res.socket.destroy(), 20))
      return
    }
    res.end(body)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server, url: (p = '/file') => 'http://127.0.0.1:' + server.address().port + p, requests: () => requests
  })))
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-upd-test-')) }
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')

test('download: follows a redirect, verifies sha256, renames into place', async () => {
  const payload = crypto.randomBytes(300 * 1024)
  const s = await makeServer(payload)
  const dir = tmpDir()
  try {
    const dest = path.join(dir, 'Setup.exe')
    const phases = []
    let last = null
    const r = await downloadResumable({ url: s.url('/redirect'), dest, expectedSha256: sha(payload), onPhase: (p) => phases.push(p), onProgress: (p) => { last = p } })
    assert.equal(r.sha256, sha(payload))
    assert.equal(fs.readFileSync(dest).length, payload.length)
    assert.ok(!fs.existsSync(dest + '.part'))
    assert.ok(phases.includes('verifying'))
    assert.equal(last.received, payload.length)
    assert.equal(last.total, payload.length)
  } finally { s.server.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('download: a dropped connection resumes with a Range request', async () => {
  const payload = crypto.randomBytes(2 * MB)
  const s = await makeServer(payload, { failFirstAfterBytes: 700 * 1024 })
  const dir = tmpDir()
  try {
    const dest = path.join(dir, 'Setup.exe')
    const phases = []
    const r = await downloadResumable({ url: s.url(), dest, expectedSha256: sha(payload), retryDelayMs: () => 10, onPhase: (p) => phases.push(p) })
    assert.equal(r.sha256, sha(payload))
    assert.ok(phases.includes('retrying'))
    const ranges = s.requests().map((q) => q.range)
    assert.equal(ranges[0], null)
    assert.match(String(ranges[1]), /^bytes=\d+-$/)
    assert.ok(Number(/\d+/.exec(ranges[1])[0]) > 0)
  } finally { s.server.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('download: pause keeps the .part, resume continues from it', async () => {
  const payload = crypto.randomBytes(3 * MB)
  const s = await makeServer(payload)
  const dir = tmpDir()
  try {
    const dest = path.join(dir, 'Setup.exe')
    // Pre-seed a .part as if an earlier run was paused at 1 MB.
    fs.writeFileSync(dest + '.part', payload.subarray(0, MB))
    fs.writeFileSync(dest + '.part.json', JSON.stringify({ url: s.url(), sha256: sha(payload) }))
    const r = await downloadResumable({ url: s.url(), dest, expectedSha256: sha(payload) })
    assert.equal(r.resumedFrom, MB)
    assert.equal(s.requests()[0].range, 'bytes=' + MB + '-')
    assert.equal(r.sha256, sha(payload))

    // A real pause: abort mid-flight.
    fs.rmSync(dest)
    const ac = new AbortController()
    let paused = null
    await downloadResumable({
      url: s.url(), dest, expectedSha256: sha(payload), signal: ac.signal,
      onProgress: ({ received }) => { if (received > 256 * 1024) ac.abort() }
    }).catch((e) => { paused = e })
    assert.equal(paused && paused.code, 'PAUSED')
    assert.ok(!fs.existsSync(dest))
    const r2 = await downloadResumable({ url: s.url(), dest, expectedSha256: sha(payload) })
    assert.equal(r2.sha256, sha(payload))
  } finally { s.server.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('download: a leftover .part from a different release is not resumed', async () => {
  const payload = crypto.randomBytes(512 * 1024)
  const s = await makeServer(payload)
  const dir = tmpDir()
  try {
    const dest = path.join(dir, 'Setup.exe')
    fs.writeFileSync(dest + '.part', Buffer.alloc(100 * 1024, 7))
    fs.writeFileSync(dest + '.part.json', JSON.stringify({ url: s.url(), sha256: 'someoldsha' }))
    const r = await downloadResumable({ url: s.url(), dest, expectedSha256: sha(payload) })
    assert.equal(s.requests()[0].range, null)
    assert.equal(r.sha256, sha(payload))
  } finally { s.server.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('download: a server that ignores Range restarts cleanly instead of appending', async () => {
  const payload = crypto.randomBytes(400 * 1024)
  const s = await makeServer(payload, { ignoreRange: true })
  const dir = tmpDir()
  try {
    const dest = path.join(dir, 'Setup.exe')
    fs.writeFileSync(dest + '.part', payload.subarray(0, 100 * 1024))
    fs.writeFileSync(dest + '.part.json', JSON.stringify({ url: s.url(), sha256: sha(payload) }))
    const r = await downloadResumable({ url: s.url(), dest, expectedSha256: sha(payload) })
    assert.equal(r.sha256, sha(payload))
    assert.equal(fs.statSync(dest).size, payload.length)
  } finally { s.server.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('download: sha256 mismatch deletes the file and reports SHA_MISMATCH', async () => {
  const payload = crypto.randomBytes(200 * 1024)
  const s = await makeServer(payload)
  const dir = tmpDir()
  try {
    const dest = path.join(dir, 'Setup.exe')
    let err = null
    await downloadResumable({ url: s.url(), dest, expectedSha256: 'a'.repeat(64) }).catch((e) => { err = e })
    assert.equal(err && err.code, 'SHA_MISMATCH')
    assert.ok(!fs.existsSync(dest), 'unverified installer must not exist')
    assert.ok(!fs.existsSync(dest + '.part'), 'corrupt .part must not be resumed')
  } finally { s.server.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('download: an already verified installer is reused without downloading', async () => {
  const payload = crypto.randomBytes(100 * 1024)
  const s = await makeServer(payload)
  const dir = tmpDir()
  try {
    const dest = path.join(dir, 'Setup.exe')
    fs.writeFileSync(dest, payload)
    const r = await downloadResumable({ url: s.url(), dest, expectedSha256: sha(payload) })
    assert.equal(r.sha256, sha(payload))
    assert.equal(s.requests().length, 0)
  } finally { s.server.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('download: HTTP 404 fails straight away; repeated network failure gives up', async () => {
  const payload = crypto.randomBytes(1024)
  const s = await makeServer(payload)
  const dir = tmpDir()
  try {
    let err = null
    await downloadResumable({ url: s.url('/missing'), dest: path.join(dir, 'a.exe') }).catch((e) => { err = e })
    assert.equal(err.code, 'HTTP')
    assert.equal(s.requests().length, 1)
    let err2 = null
    const port = s.server.address().port
    s.server.close()
    await downloadResumable({ url: 'http://127.0.0.1:' + port + '/file', dest: path.join(dir, 'b.exe'), maxRetries: 2, retryDelayMs: () => 5 }).catch((e) => { err2 = e })
    assert.equal(err2.code, 'NETWORK')
  } finally { try { s.server.close() } catch (e) {} fs.rmSync(dir, { recursive: true, force: true }) }
})

test('parseContentRange', () => {
  assert.deepEqual(parseContentRange('bytes 10-19/100'), { start: 10, end: 19, total: 100 })
  assert.equal(parseContentRange('garbage'), null)
})

// ---------------------------------------------------------------- watchdog marker
test('marker: write, fresh, stale, clear', () => {
  const dir = tmpDir()
  try {
    const f = marker.markerPath({ ProgramData: dir })
    assert.equal(f, path.join(dir, 'Beebo Entertainment', 'update-in-progress.json'))
    assert.equal(marker.readMarker(f).exists, false)
    assert.equal(marker.writeMarker({ to: '0.1.34' }, f), true)
    const m = marker.readMarker(f)
    assert.equal(m.exists, true)
    assert.equal(m.fresh, true)
    assert.equal(marker.readMarker(f, Date.now() + marker.MAX_AGE_MS + 1000).fresh, false)
    assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).to, '0.1.34')
    assert.equal(marker.clearMarker(f), true)
    assert.equal(marker.readMarker(f).exists, false)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('update deferral counts private viewers without exposing their titles or pending filenames', () => {
  const now = Date.now()
  const data = {
    authUsers: [{ id: 'private', adult: true, viewingHistoryPrivate: true }],
    watchHistory: [{ userId: 'private', userName: 'Sam', title: 'Private title', lastUpdate: now, currentTime: 20, duration: 5000 }],
    watchHistoryPending: [{ userId: 'private', userName: 'Sam', fileName: 'Private pending.mkv', lastUpdate: now, currentTime: 20, duration: 5000 }, { userId: 'public', userName: 'Public Member', title: 'Public title', lastUpdate: now, currentTime: 20, duration: 5000 }]
  }
  const viewers = M.activeViewers({ get: key => data[key] }, now)
  assert.equal(viewers.length, 3)
  assert.equal(viewers.filter(v => v.title === 'Private viewing').length, 2)
  assert.equal(viewers.find(v => v.user === 'Public Member').title, 'Public title')
  assert.equal(JSON.stringify(viewers).includes('Private title'), false)
  assert.equal(JSON.stringify(viewers).includes('Private pending'), false)
  assert.deepEqual(M.activeViewers(null), [])
})
