// The owner's server dashboard (electron/serverDashboard.js): activity
// aggregation (plays, watch time, top titles, per member), the owner-only
// "stop this stream" rule, disk figures, connection/device labels, the live
// byte counter, and the /api/admin/dashboard routes on a real server.
// Run: node --test test/server-dashboard.test.js   (no Electron, no network)
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const D = localRequire('./electron/serverDashboard')

const HOUR = 3600 * 1000
const DAY = 24 * HOUR
// Noon local time on a fixed day, so day buckets never straddle midnight.
const NOW = new Date(2026, 8, 17, 12, 0, 0).getTime()

const row = (o) => ({ sessionId: Math.random().toString(36).slice(2), userId: 'u1', userName: 'Nick', kind: 'movie', fileName: 'Heat (1995).mp4', title: 'Heat', startedAt: NOW - HOUR, lastUpdate: NOW - HOUR + 30 * 60 * 1000, currentTime: 1800, duration: 6000, ...o })

test('watch time: the smaller of time open, position reached and length; capped', () => {
  assert.equal(D.watchSecondsOf(row({})), 1800)
  // Resumed at 1h, watched 5 minutes: position says 65 min, the session was open 5.
  assert.equal(D.watchSecondsOf(row({ startedAt: NOW, lastUpdate: NOW + 5 * 60 * 1000, currentTime: 3900 })), 300)
  // Nothing reported yet: open time alone.
  assert.equal(D.watchSecondsOf(row({ currentTime: 0, startedAt: NOW, lastUpdate: NOW + 120000 })), 120)
  // Left open overnight on a paused film with no known length.
  assert.equal(D.watchSecondsOf(row({ currentTime: 0, duration: 0, startedAt: NOW - 20 * HOUR, lastUpdate: NOW })), 6 * 3600)
  assert.equal(D.watchSecondsOf(null), 0)
  assert.equal(D.watchSecondsOf({ startedAt: 'x', lastUpdate: null }), 0)
})

test('activity: plays per day and week, top titles, top members and watch time per member', () => {
  const entries = [
    row({ userId: 'u1', title: 'Heat' }),
    row({ userId: 'u2', userName: 'Old name', title: 'Heat', startedAt: NOW - 2 * DAY, lastUpdate: NOW - 2 * DAY + 40 * 60 * 1000, currentTime: 2400 }),
    row({ userId: 'u2', kind: 'tv', title: 'Friends — S2E3', fileName: 'Friends/S2/Friends S02E03.mkv', startedAt: NOW - 3 * DAY, lastUpdate: NOW - 3 * DAY + 22 * 60 * 1000, currentTime: 1320, duration: 1320 }),
    row({ userId: 'u2', kind: 'tv', title: 'Friends — S2E4', fileName: 'Friends/S2/Friends S02E04.mkv', startedAt: NOW - 3 * DAY + HOUR, lastUpdate: NOW - 3 * DAY + HOUR + 22 * 60 * 1000, currentTime: 1320, duration: 1320 }),
    // A click-in, click-out: not a play.
    row({ userId: 'u1', title: 'Alien', startedAt: NOW - 10 * 60 * 1000, lastUpdate: NOW - 10 * 60 * 1000 + 20000, currentTime: 20 }),
    // Outside a 7-day window, inside 30.
    row({ userId: 'u1', title: 'Up', startedAt: NOW - 12 * DAY, lastUpdate: NOW - 12 * DAY + 50 * 60 * 1000, currentTime: 3000 }),
    null, 'junk', { title: 'no dates' }
  ]
  const users = [{ id: 'u1', name: 'Nick' }, { id: 'u2', name: 'Sam' }]
  const week = D.aggregateActivity(entries, { now: NOW, days: 7, users })
  assert.equal(week.days, 7)
  assert.equal(week.daily.length, 7)
  assert.equal(week.daily[6].day, D.localDayKey(NOW), 'the last bucket is today')
  assert.equal(week.totals.plays, 4)
  assert.equal(week.totals.seconds, 1800 + 2400 + 1320 + 1320)
  assert.equal(week.daily[6].plays, 1)
  assert.equal(week.daily[4].plays, 1)
  assert.equal(week.daily[3].plays, 2)
  assert.equal(week.weekly.length, 1)
  assert.equal(week.weekly[0].plays, 4)
  // Episodes count toward their show; equal plays, more watch time first.
  assert.deepEqual(week.topTitles.map((t) => [t.title, t.plays, t.seconds]), [['Heat', 2, 4200], ['Friends', 2, 2640]])
  assert.equal(week.topTitles[1].kind, 'tv')
  // Current names, most watch time first.
  assert.deepEqual(week.watchTimeByMember.map((m) => [m.name, m.plays, m.seconds]), [['Sam', 3, 2400 + 2640], ['Nick', 1, 1800]])
  assert.equal(week.topUsers[0].name, 'Sam')

  const month = D.aggregateActivity(entries, { now: NOW, days: 30, users })
  assert.equal(month.daily.length, 30)
  assert.equal(month.totals.plays, 5)
  assert.equal(month.weekly.reduce((n, w) => n + w.plays, 0), 5)
  assert.ok(month.topTitles.some((t) => t.title === 'Up'))

  const empty = D.aggregateActivity([], { now: NOW, days: 7 })
  assert.equal(empty.totals.plays, 0)
  assert.equal(empty.topTitles.length, 0)
  assert.equal(D.groupTitleOf({ kind: 'tv', title: 'The Office - S1E2' }), 'The Office')
})

test('stop-stream authorization: only the owner (the first approved admin), never another admin or a member', () => {
  const users = [
    { id: 'u-member', isAdmin: false, status: 'approved', createdAt: 1 },
    { id: 'u-admin2', isAdmin: true, status: 'approved', createdAt: 500 },
    { id: 'u-owner', isAdmin: true, status: 'approved', createdAt: 100 },
    { id: 'u-revoked', isAdmin: true, status: 'revoked', createdAt: 10 }
  ]
  assert.equal(D.ownerIdOf(users), 'u-owner')
  assert.equal(D.canStopStreams(users[2], users), true)
  assert.equal(D.canStopStreams(users[1], users), false)
  assert.equal(D.canStopStreams(users[0], users), false)
  assert.equal(D.canStopStreams(users[3], users), false)
  assert.equal(D.canStopStreams(null, users), false)
  assert.equal(D.canStopStreams({ id: 'u-owner', isAdmin: true }, []), false, 'no owner on record, nobody')
})

test('disk stats: storage per folder and free space per disk, tolerant of a missing folder', () => {
  const statfs = (dir) => {
    if (dir.includes('gone')) throw new Error('ENOENT')
    return { bsize: 4096, blocks: 1000, bavail: 250 }
  }
  const root = path.resolve(os.tmpdir(), 'lib')
  const movies = path.join(root, 'Movies')
  const tv = path.join(root, 'TV')
  const gone = path.join(root, 'gone')
  const files = [{ dir: movies, size: 100 }, { dir: movies, size: 50 }, { dir: tv, size: 7 }, { dir: null, size: 9 }]
  const s = D.storageStats([{ kind: 'movies', dir: movies }, { kind: 'tv', dir: tv }, { kind: 'movies', dir: gone }, { kind: 'movies', dir: movies }], files, { statfs })
  assert.equal(s.folders.length, 3, 'duplicates dropped')
  assert.deepEqual(s.folders.map((f) => [f.kind, f.usedBytes, f.files]), [['movies', 150, 2], ['tv', 7, 1], ['movies', 0, 0]])
  assert.equal(s.folders[0].freeBytes, 250 * 4096)
  assert.equal(s.folders[2].freeBytes, null)
  assert.equal(s.disks.length, 1, 'both folders are on one disk')
  assert.equal(s.disks[0].totalBytes, 4096000)
  assert.equal(s.disks[0].usedBytes, 750 * 4096)
  assert.equal(D.diskOf('', statfs), null)
  assert.equal(D.diskOf(movies, () => ({ bsize: 0, blocks: 0 })), null)
  // The real statfs on a real folder.
  const real = D.diskOf(os.tmpdir())
  assert.ok(real === null || real.totalBytes > 0)
})

test('where and what: home, away direct, away through Beebo Relay, cast; device names', () => {
  assert.equal(D.classifyConnection({ socketIp: '192.168.1.20' }).where, 'home')
  assert.equal(D.classifyConnection({ socketIp: '127.0.0.1' }).where, 'home')
  assert.equal(D.classifyConnection({ socketIp: '203.0.113.9' }).where, 'away_direct')
  assert.equal(D.classifyConnection({ socketIp: '127.0.0.1', fromAgent: true, remotePath: 'direct' }).where, 'away_direct')
  const relayed = D.classifyConnection({ socketIp: '127.0.0.1', fromAgent: true, remotePath: 'relay-beebo' })
  assert.deepEqual([relayed.where, relayed.provider], ['away_relay', 'beebo'])
  assert.equal(D.classifyConnection({ socketIp: '192.168.1.30', userAgent: 'Mozilla/5.0 (X11; Linux armv7l) CrKey/1.56' }).where, 'cast')
  assert.equal(D.deviceFromUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari'), 'Android phone (browser)')
  assert.equal(D.deviceFromUserAgent('BeeboEntertainment/1.30 (Linux;Android 14) ExoPlayerLib/1.4.1'), 'Beebo app (Android)')
  assert.equal(D.deviceFromUserAgent('okhttp/4.12.0'), 'Beebo app')
  assert.equal(D.deviceFromUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)'), 'iPhone')
  assert.equal(D.deviceFromUserAgent(''), 'Unknown device')
})

function fakeReqRes({ ip = '192.168.1.20', ua = 'Mozilla/5.0 (Windows NT 10.0)', headers = {} } = {}) {
  const req = { socket: { remoteAddress: ip }, headers: { 'user-agent': ua, ...headers } }
  const res = new EventEmitter()
  res.written = 0
  res.destroyed = false
  res.write = function (chunk) { this.written += chunk.length; return true }
  res.end = function () { this.emit('close') }
  res.destroy = function () { this.destroyed = true; this.emit('close') }
  return { req, res }
}

test('live: bytes and rate per stream, peak today, joined to the member watching, and stop', () => {
  let t = NOW
  const data = {
    authUsers: [{ id: 'u-owner', name: 'Nick', isAdmin: true, status: 'approved', createdAt: 1 }],
    watchHistory: [row({ sessionId: 's1', userId: 'u-owner', fileName: 'Heat (1995).mp4', startedAt: NOW - 60000, lastUpdate: NOW - 5000, currentTime: 55, duration: 6000 })]
  }
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = v } }
  const dash = D.createServerDashboard({ store, history: localRequire('./electron/history'), auth: localRequire('./electron/auth'), now: () => t })
  const { req, res } = fakeReqRes()
  assert.equal(dash.trackStream(req, res, { filePath: path.join(os.tmpdir(), 'Heat (1995).mp4'), kind: 'movie', fileName: 'Heat (1995).mp4', sizeBytes: 6000 * 1000 }), true)
  dash.noteSession(req, 's1')
  res.write(Buffer.alloc(1_000_000))
  t += 1000
  res.write(Buffer.alloc(1_000_000))
  t += 1000

  const bw = dash.bandwidth()
  assert.equal(bw.streams.length, 1)
  assert.equal(bw.currentBytesPerSec, 1_000_000, '2 MB over the 2 s the stream has run')
  assert.equal(bw.peakTodayBytesPerSec, 1_000_000)
  assert.equal(bw.sentTodayBytes, 2_000_000)

  const rows = dash.nowPlaying()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].user, 'Nick')
  assert.equal(rows[0].title, 'Heat')
  assert.equal(rows[0].where, 'home')
  assert.equal(rows[0].device, 'Windows PC (browser)')
  assert.equal(rows[0].playback, 'direct')
  assert.equal(rows[0].currentBitsPerSec, 8_000_000)
  assert.equal(rows[0].fileBitsPerSec, 8000)
  assert.ok(rows[0].streamId)

  // The live transcoder's seam.
  dash.setTranscodeProvider(() => [{ streamId: rows[0].streamId, label: 'Converting to H.264', reason: 'hevc' }])
  assert.equal(dash.nowPlaying()[0].playback, 'transcode')
  dash.setTranscodeProvider(null)

  // Stop: the open response is closed and the same viewer is refused for a while.
  assert.deepEqual(dash.stopStream('nope'), { ok: false, error: 'not_found' })
  const stopped = dash.stopStream(rows[0].streamId)
  assert.equal(stopped.ok, true)
  assert.equal(res.destroyed, true)
  const again = fakeReqRes()
  assert.equal(dash.trackStream(again.req, again.res, { filePath: path.join(os.tmpdir(), 'Heat (1995).mp4'), fileName: 'Heat (1995).mp4' }), false)
  const otherViewer = fakeReqRes({ ip: '192.168.1.99' })
  assert.equal(dash.trackStream(otherViewer.req, otherViewer.res, { filePath: path.join(os.tmpdir(), 'Heat (1995).mp4'), fileName: 'Heat (1995).mp4' }), true, 'only that viewer')
  t += D.STOP_BLOCK_MS + 1
  const later = fakeReqRes()
  assert.equal(dash.trackStream(later.req, later.res, { filePath: path.join(os.tmpdir(), 'Heat (1995).mp4'), fileName: 'Heat (1995).mp4' }), true, 'the block wears off')
})

test('health: errors in the last 24 h, relay usage this month, last backup and hooks', async () => {
  let t = NOW
  const data = { relayUsage: { periodStart: 1, periodEnd: 2, bytes: { beebo: 2e9, cloudflare: 1e9, custom: 0 }, reported: { beebo: { bytes: 3e9 } } }, lastBackupAt: NOW - DAY }
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = v } }
  const dash = D.createServerDashboard({ store, now: () => t })
  dash.noteLog('Stream server listening on 0.0.0.0:47811')
  dash.noteLog('could not hand off a connection: boom')
  t += 2 * DAY
  dash.noteLog('convert failed: disk full')
  dash.setHooks({ getAwayStatus: () => ({ registeredName: 'nickhouse', online: true, connection: 'direct' }), getUpdateStatus: () => ({ available: true, latest: '0.1.49' }), getAppVersion: () => '0.1.48' })
  const h = dash.health()
  assert.equal(h.errors24h.count, 1, 'the old error has aged out, the info line never counted')
  assert.match(h.errors24h.recent[0].message, /disk full/)
  assert.equal(h.relay.bytes.beebo, 3e9, "Beebo Relay's own figure wins when higher")
  assert.equal(h.relay.totalBytes, 4e9)
  assert.equal(h.lastBackupAt, NOW - DAY)
  assert.equal(h.away.address, 'nickhouse.beebo.tv')
  assert.equal(h.update.available, true)
  assert.equal(h.versions.app, '0.1.48')
  assert.ok(h.memoryBytes > 0)
  // A hook that throws reads as unknown, never breaks the dashboard.
  dash.setHooks({ getAwayStatus: () => { throw new Error('x') } })
  assert.equal(dash.health().away.registered, false)
  const snap = await dash.snapshot({ sections: ['health', 'bogus'] })
  assert.ok(snap.health && !snap.nowPlaying && !snap.library)
})

test('dashboard wording: bytes, bitrate, durations', async () => {
  const { pathToFileURL } = require('node:url')
  const F = await import(pathToFileURL(path.join(appRoot, 'src', 'lib', 'dashboardFormat.js')).href)
  assert.equal(F.formatBytes(0), '0 B')
  assert.equal(F.formatBytes(1500), '1.5 KB')
  assert.equal(F.formatBytes(4.2e9), '4.2 GB')
  assert.equal(F.formatBitrate(8_000_000), '8.0 Mbps')
  assert.equal(F.formatBitrate(640_000), '640 kbps')
  assert.equal(F.formatDuration(3 * 3600 + 5 * 60), '3h 5m')
  assert.equal(F.formatDuration(50 * 3600), '2d 2h')
  assert.equal(F.formatClock(3725), '1:02:05')
  assert.equal(F.timeAgo(null), 'never')
  assert.equal(F.timeAgo(1000, 1000 + 2 * 86400000), '2 days ago')
})

test('/api/admin/dashboard on a real server: sections, a stream in Now playing, owner-only stop', async () => {
  const server = localRequire('./electron/streamServer')
  const SECRET = 'k'.repeat(40)
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beebo-dash-test-'))
  let info
  try {
    await fs.writeFile(path.join(dir, 'Clip (2020).mp4'), Buffer.alloc(200000, 1))
    const data = {
      authUsers: [
        { id: 'u-owner', name: 'Owner', username: 'owner', status: 'approved', isAdmin: true, createdAt: 1 },
        { id: 'u-admin2', name: 'Helper', username: 'helper', status: 'approved', isAdmin: true, createdAt: 2 },
        { id: 'u-sam', name: 'Sam', username: 'sam', status: 'approved', createdAt: 3 }
      ]
    }
    const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
    const port = 47000 + Math.floor(Math.random() * 900) + 50
    info = server.startStreamServer({
      port, store, getMoviesDir: () => dir, getTvShowsDir: () => dir,
      getAllMoviesDirs: () => [dir], getAllTvShowsDirs: () => [],
      log: () => {}, agentSecret: SECRET
    })
    const base = 'http://127.0.0.1:' + info.port
    for (let i = 0; i < 50; i++) {
      try { await (await fetch(base + '/login', { redirect: 'manual' })).arrayBuffer(); break } catch { await new Promise((r) => setTimeout(r, 100)) }
    }
    const as = (userId) => ({ authorization: 'Bearer ' + server.makeApiToken(store, userId), 'x-beebo-agent-key': SECRET })
    const call = async (method, u, headers, body) => {
      const r = await fetch(base + u, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
      return { status: r.status, body: await r.json() }
    }

    // Plain HTTP with no agent key: the usual https_required, before anything else.
    let r = await call('GET', '/api/admin/dashboard', { authorization: 'Bearer ' + server.makeApiToken(store, 'u-owner') })
    assert.equal(r.body.error, 'https_required')
    r = await call('GET', '/api/admin/dashboard', as('u-sam'))
    assert.equal(r.status, 403)
    assert.equal(r.body.error, 'admin_only')

    // A viewer on the house network starts the film and keeps its response open.
    const id = server.encodeId('Clip (2020).mp4')
    const mt = server.makeMediaToken(store, id)
    const ws = await fetch(base + '/api/watch-session', { method: 'POST', headers: { ...as('u-sam'), 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'movie', id }) }).then((x) => x.json())
    assert.ok(ws.sessionId)
    const video = await fetch(base + '/file?id=' + encodeURIComponent(id) + '&mt=' + encodeURIComponent(mt), { headers: { Range: 'bytes=0-99999' } })
    assert.equal(video.status, 206)
    await video.arrayBuffer()

    r = await call('GET', '/api/admin/dashboard?sections=now,bandwidth,health,activity,library&days=30', as('u-owner'))
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.equal(r.body.canStopStreams, true)
    assert.equal(r.body.library.counts.movies, 1)
    assert.equal(r.body.library.storage.folders[0].usedBytes, 200000)
    assert.equal(r.body.activity.days, 30)
    assert.ok(r.body.bandwidth.sentTodayBytes >= 100000)
    const playing = r.body.nowPlaying.find((x) => x.streamId)
    assert.ok(playing, 'the stream is on the dashboard')
    assert.equal(playing.user, 'Sam')
    assert.equal(playing.where, 'home')

    // Helper can see the dashboard but not stop anyone.
    r = await call('GET', '/api/admin/dashboard?sections=now', as('u-admin2'))
    assert.equal(r.body.canStopStreams, false)
    r = await call('POST', '/api/admin/dashboard/stop', as('u-admin2'), { streamId: playing.streamId })
    assert.equal(r.status, 403)
    assert.equal(r.body.error, 'owner_only')
    r = await call('GET', '/api/admin/dashboard/stop', as('u-owner'))
    assert.equal(r.status, 405)
    r = await call('POST', '/api/admin/dashboard/stop', as('u-owner'), { streamId: playing.streamId })
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    const refused = await fetch(base + '/file?id=' + encodeURIComponent(id) + '&mt=' + encodeURIComponent(mt), { headers: { Range: 'bytes=0-9' } })
    assert.equal(refused.status, 403)
    await refused.text()
  } finally {
    if (info) await new Promise((r) => info.close(r))
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('private viewing: live streams and errors reveal no title while byte and watch-time totals remain intact', async () => {
  let t = NOW
  const privateTitle = 'Secret Sunrise'
  const privateFile = 'Secret Sunrise S01E07.mp4'
  const data = {
    authUsers: [{ id: 'private', name: 'Private Member', adult: true, viewingHistoryPrivate: true }, { id: 'public', name: 'Public Member' }],
    watchHistory: [
      row({ sessionId: 'private-session', userId: 'private', title: privateTitle, fileName: privateFile, startedAt: NOW - 600000, lastUpdate: NOW, currentTime: 900, duration: 5000 }),
      row({ sessionId: 'public-session', userId: 'public', title: 'Public Film', fileName: 'Public Film.mp4', startedAt: NOW - 600000, lastUpdate: NOW, currentTime: 900, duration: 5000 })
    ]
  }
  const store = { get: key => data[key] }
  const dash = D.createServerDashboard({ store, history: { getHistory: () => data.watchHistory }, auth: { getUsers: () => data.authUsers }, now: () => t })
  const a = fakeReqRes(), b = fakeReqRes(), unknown = fakeReqRes({ ip: '192.168.1.21' })
  a.req.beeboUserId = 'private'
  b.req.beeboUserId = 'public'
  dash.trackStream(a.req, a.res, { filePath: path.join(os.tmpdir(), privateFile), fileName: privateFile, sizeBytes: 50_000_000 })
  dash.trackStream(b.req, b.res, { filePath: path.join(os.tmpdir(), 'Public Film.mp4'), fileName: 'Public Film.mp4', sizeBytes: 50_000_000 })
  dash.trackStream(unknown.req, unknown.res, { filePath: path.join(os.tmpdir(), 'Unattributed Secret.mp4'), fileName: 'Unattributed Secret.mp4' })
  dash.noteSession(a.req, 'private-session')
  dash.noteSession(b.req, 'public-session')
  a.res.write(Buffer.alloc(1000)); b.res.write(Buffer.alloc(2000)); unknown.res.write(Buffer.alloc(3000)); t += 1000
  const privateStreamId = dash.nowPlaying().find(r => r.userId === 'private').streamId
  dash.setTranscodeProvider(() => [{ streamId: privateStreamId, label: privateTitle, reason: privateFile, videoCodec: privateTitle, audioCodec: privateTitle, speed: 1 }])
  dash.noteLog('Conversion failed: ' + privateFile)
  const snapshot = await dash.snapshot({ sections: ['now', 'bandwidth', 'activity', 'health'] })
  const serialized = JSON.stringify(snapshot)
  for (const secret of [privateTitle, privateFile, 'Unattributed Secret', 'private-session']) assert.equal(serialized.includes(secret), false, secret)
  const privateRow = snapshot.nowPlaying.find(r => r.userId === 'private')
  assert.equal(privateRow.title, 'Private viewing')
  for (const field of ['kind', 'positionSeconds', 'durationSeconds', 'progress', 'fileBitsPerSec']) assert.equal(privateRow[field], null)
  assert.equal(privateRow.bytesSent, 1000)
  assert.equal(privateRow.transcode.speed, 1)
  assert.equal(snapshot.bandwidth.sentTodayBytes, 6000)
  assert.equal(snapshot.bandwidth.currentBytesPerSec, 6000)
  assert.equal(snapshot.activity.totals.plays, 2)
  assert.equal(snapshot.activity.totals.seconds, 1200)
  assert.deepEqual(snapshot.activity.topTitles.map(r => r.title), ['Public Film'])
  assert.equal(snapshot.activity.watchTimeByMember.find(r => r.userId === 'private').seconds, 600)
  assert.equal(snapshot.health.errors24h.count, 1)

  // Settings take effect for existing streams, without changing live usage.
  data.authUsers[0].adult = false
  assert.equal(dash.nowPlaying().find(r => r.userId === 'private').title, 'Private viewing')
  data.authUsers[0].viewingHistoryPrivate = false
  assert.equal(dash.nowPlaying().find(r => r.userId === 'private').title, privateTitle)
  assert.equal(dash.bandwidth().sentTodayBytes, 6000)
})

test('members sharing the same IP, app and file remain separate, including an unreported private stream', () => {
  const data = { authUsers: [{ id: 'private', viewingHistoryPrivate: true }, { id: 'public' }], watchHistory: [row({ userId: 'public', sessionId: 'public-session', lastUpdate: NOW })] }
  const store = { get: key => data[key] }
  const dash = D.createServerDashboard({ store, history: { getHistory: () => data.watchHistory }, now: () => NOW })
  const a = fakeReqRes(), b = fakeReqRes()
  a.req.beeboUserId = 'private'; b.req.beeboUserId = 'public'
  const file = { filePath: path.join(os.tmpdir(), 'Heat (1995).mp4'), fileName: 'Heat (1995).mp4' }
  dash.trackStream(a.req, a.res, file); dash.trackStream(b.req, b.res, file)
  a.res.write(Buffer.alloc(10)); b.res.write(Buffer.alloc(20))
  const rows = dash.nowPlaying()
  assert.equal(rows.length, 2)
  const privateRow = rows.find(r => r.userId === 'private'), publicRow = rows.find(r => r.userId === 'public')
  assert.equal(privateRow.title, 'Private viewing')
  assert.equal(privateRow.bytesSent, 10)
  assert.equal(publicRow.title, 'Heat')
  assert.equal(publicRow.bytesSent, 20)
  assert.notEqual(privateRow.streamId, publicRow.streamId)
  dash.stopStream(privateRow.streamId)
  assert.equal(a.res.destroyed, true)
  assert.equal(b.res.destroyed, false)
})
