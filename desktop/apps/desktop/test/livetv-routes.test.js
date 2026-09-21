// Live TV over HTTP on a real stream server: who may call what (auth, restricted profiles, admin-only
// set-up), the tuner address never reaching a client, playlist + pieces through the signed ticket,
// tuner sharing/busy, guide and recording routes, and the browser pages. The converter is faked.
// Run: node --test test/livetv-routes.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const auth = require('../electron/auth')
const { createFixture } = require('./helpers/publicApiFixture')
const fake = require('./helpers/fakeHdhr')

const argAfter = (args, flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined }

function fakeSpawn() {
  return (exe, args) => {
    const child = new EventEmitter()
    child.pid = 1
    child.stdin = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => child.emit('exit', null)
    const dir = path.dirname(args[args.length - 1])
    const run = path.basename(args[args.length - 1])
    const start = Number(argAfter(args, '-start_number'))
    let n = 0
    child.timer = setInterval(() => {
      const seq = start + n++
      fs.writeFileSync(path.join(dir, `seg-${seq}.ts`), Buffer.concat([Buffer.from([0x47]), Buffer.alloc(999, 1)]))
      const lines = ['#EXTM3U']
      for (let i = 0; i < n; i++) lines.push('#EXTINF:2.000000,', `seg-${start + i}.ts`)
      fs.writeFileSync(path.join(dir, run), lines.join('\n') + '\n')
    }, 20)
    child.on('exit', () => clearInterval(child.timer))
    return child
  }
}

const XML = (from) => {
  const f = (ms) => new Date(ms).toISOString().replace(/[-:T]/g, '').replace(/\.\d+Z$/, '') + ' +0000'
  return `<tv><channel id="ktst"><display-name>KTST</display-name></channel><programme start="${f(from)}" stop="${f(from + 3600000)}" channel="ktst"><title>Evening News</title><new/></programme><programme start="${f(from + 3600000)}" stop="${f(from + 7200000)}" channel="ktst"><title>Quiz Night</title></programme></tv>`
}

async function setup(t) {
  const dev = await fake.createFakeHdhr({ real: false, tunerCount: 2 })
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-livetv-routes-'))
  const f = await createFixture(t, {
    server: {
      playback: { tmpRoot: path.join(dataDir, 'tmp') },
      liveTv: {
        dataDir: path.join(dataDir, 'data'), ffmpegPath: () => 'ffmpeg', getEncoder: async () => ({ encoder: 'libx264', label: 'x264' }),
        hlsOverrides: { spawnFn: fakeSpawn(), sweepEveryMs: 0, waitTimeoutMs: 5000, pollMs: 20 }, tmpRoot: path.join(dataDir, 'hls'),
        discoverOverrides: { timeoutMs: 200, targets: ['127.0.0.1'], port: 9, allowNonLan: true }
      }
    }
  })
  t.after(async () => { await dev.close(); fs.rmSync(dataDir, { recursive: true, force: true }) })
  const owner = (sub, body, who = 'owner') => f.call(who, '/api/livetv/' + sub, { method: body === undefined ? 'GET' : 'POST', body })
  const cookie = (who) => `beebo_session=${auth.signSession(f.store, who)}`
  const web = async (who, route, { method = 'GET', body, headers = {} } = {}) => {
    const r = await fetch(f.base + route, { method, redirect: 'manual', headers: { ...(who ? { Cookie: cookie(who) } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* html */ }
    return { status: r.status, headers: r.headers, text, json }
  }
  return { f, dev, dataDir, owner, web, cookie }
}

async function addTuner(s) {
  const r = await s.owner('admin/device', { host: '127.0.0.1', port: s.dev.port, streamPort: s.dev.port, confirmNonLan: true })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  return r
}

test('auth: every route needs a signed-in person; restricted profiles and guests are refused; set-up is owner only', async (t) => {
  const s = await setup(t)
  assert.equal((await s.f.call(null, '/api/livetv/status')).status, 401)
  assert.equal((await s.f.call('garbage-token', '/api/livetv/channels')).status, 401)
  const kid = await s.owner('status', undefined, 'kid')
  assert.equal(kid.status, 403)
  assert.equal(kid.body.error, 'restricted_profile')
  assert.match(kid.body.message, /parental controls/)
  for (const [m, sub, b] of [['GET', 'channels'], ['POST', 'watch', { channel: '2.1' }], ['GET', 'guide'], ['GET', 'dvr'], ['POST', 'admin/device', { host: '192.168.1.5' }]]) {
    const r = await s.f.call('kid', '/api/livetv/' + sub, { method: m, body: b })
    assert.equal(r.status, 403, sub)
  }
  const member = await s.owner('status', undefined, 'member')
  assert.equal(member.status, 200)
  assert.equal(member.body.isAdmin, false)
  for (const [sub, b] of [['admin/discover', {}], ['admin/device', { host: '192.168.1.5' }], ['admin/settings', { dvrEnabled: true }], ['admin/channel', { channel: '2.1', hidden: true }], ['admin/guide/source', { type: 'url', url: 'http://x.example/g.xml' }], ['admin/lineup/refresh', { id: 'AAAAAAAA' }], ['admin/recordings/add-to-library', {}]]) {
    const r = await s.owner(sub, b, 'member')
    assert.equal(r.status, 403, sub)
    assert.equal(r.body.error, 'admin_only')
  }
  assert.equal((await s.owner('nope', undefined)).status, 404)
  assert.equal((await s.f.call('owner', '/api/livetv/status', { method: 'DELETE' })).status, 405)
})

test('set-up: address checks (LAN only unless confirmed), a device must answer like an HDHomeRun, lineup imported, DRM channels hidden with the reason', async (t) => {
  const s = await setup(t)
  const noConfirm = await s.owner('admin/device', { host: '127.0.0.1', port: s.dev.port })
  assert.equal(noConfirm.status, 409)
  assert.equal(noConfirm.body.needsConfirm, true)
  assert.equal(s.dev.stats.requests.length, 0, 'nothing was sent to an unconfirmed non-LAN address')
  for (const host of ['localhost', 'evil.example', '169.254.169.254', '0.0.0.0', 'http://10.0.0.1', '10.0.0.1/x']) {
    const r = await s.owner('admin/device', { host, confirmNonLan: true })
    assert.equal(r.status, 400, host)
  }
  assert.equal((await s.owner('admin/device', { host: '10.255.255.1', port: 1 })).status, 502, 'a LAN address that does not answer is a clean error')
  const notTuner = await fake.createFakeHdhr({ real: false, discover: { FriendlyName: 'Router', Hello: 1 } })
  t.after(() => notTuner.close())
  const r0 = await s.owner('admin/device', { host: '127.0.0.1', port: notTuner.port, confirmNonLan: true })
  assert.equal(r0.status, 502)
  assert.equal(r0.body.error, 'not_hdhomerun')
  const ok = await addTuner(s)
  assert.equal(ok.body.device.tunerCount, 2)
  assert.equal(ok.body.lineup.found, 4)
  assert.equal(ok.body.lineup.drmHidden, 1)
  assert.match(ok.body.lineup.drmNote, /copy-protected/)
  const list = await s.owner('channels', undefined, 'member')
  assert.deepEqual(list.body.channels.map((c) => c.number), ['2.1', '4.1', '9.1'], 'the DRM channel is not offered')
  assert.equal(list.body.drmHidden, 1)
  assert.match(list.body.drmNote, /copy-protected/)
  const st = await s.owner('status')
  assert.equal(st.body.enabled, true)
  assert.equal(st.body.devices[0].ip, '127.0.0.1', 'the owner sees the tuner')
  const memberStatus = await s.owner('status', undefined, 'member')
  assert.equal(typeof memberStatus.body.devices, 'number', 'a member only sees how many')
  assert.ok(!JSON.stringify(memberStatus.body).includes('127.0.0.1'))
  const found = await s.owner('admin/discover', {})
  assert.equal(found.status, 200)
  assert.deepEqual(found.body.devices, [], 'no answer, no devices')
})

test('channels: hide, renumber, rename, favourites per person', async (t) => {
  const s = await setup(t)
  await addTuner(s)
  assert.equal((await s.owner('admin/channel', { channel: '9.1', hidden: true })).status, 200)
  assert.equal((await s.owner('admin/channel', { channel: '2.1', number: '12', name: 'Home' })).status, 200)
  assert.equal((await s.owner('admin/channel', { channel: '4.1', number: 'not a number' })).status, 200)
  const member = (await s.owner('channels', undefined, 'member')).body.channels
  assert.deepEqual(member.map((c) => [c.number, c.name]), [['4.1', 'WNEWS'], ['12', 'Home']])
  const all = (await s.owner('channels?all=1', undefined, 'owner')).body.channels
  assert.equal(all.find((c) => c.key === '9.1').hidden, true, 'the owner can still see hidden channels to unhide them')
  assert.equal((await s.owner('watch', { channel: '9.1' }, 'member')).status, 404, 'a hidden channel cannot be tuned by a member')
  assert.equal((await s.owner('favourite', { channel: '2.1', on: true }, 'member')).status, 200)
  assert.equal((await s.owner('channels', undefined, 'member')).body.channels.find((c) => c.key === '2.1').favourite, true)
  assert.equal((await s.owner('channels', undefined, 'owner')).body.channels.find((c) => c.key === '2.1').favourite, false, 'favourites are per person')
  assert.equal((await s.owner('favourite', { channel: 'nope' }, 'member')).status, 404)
  assert.equal((await s.owner('admin/channel', { channel: '9.1', hidden: false })).status, 200)
  assert.equal((await s.owner('channels', undefined, 'member')).body.channels.length, 3)
})

test('watching: a signed ticket gives the playlist and pieces with no login, the tuner address never reaches a client, two viewers share one tuner, a third channel is refused politely', async (t) => {
  const s = await setup(t)
  await addTuner(s)
  const a = await s.owner('watch', { channel: '2.1', quality: '480p' }, 'member')
  assert.equal(a.status, 200, JSON.stringify(a.body))
  assert.equal(a.body.live, true)
  assert.match(a.body.url, /^\/livetv\/hls\/[A-Za-z0-9_.-]+\/index\.m3u8$/)
  const pl = await fetch(s.f.base + a.body.url)
  assert.equal(pl.status, 200)
  assert.match(pl.headers.get('content-type'), /mpegurl/)
  assert.equal(pl.headers.get('x-beebo-live'), '1')
  const text = await pl.text()
  assert.match(text, /#EXT-X-MEDIA-SEQUENCE:\d+/)
  assert.ok(!text.includes('ENDLIST'))
  const seg = text.match(/^(seg-\d+\.ts)$/m)[1]
  const base = a.body.url.replace(/index\.m3u8$/, '')
  const piece = await fetch(s.f.base + base + seg)
  assert.equal(piece.status, 200)
  assert.equal(piece.headers.get('content-type'), 'video/mp2t')
  assert.equal((await piece.arrayBuffer()).byteLength, 1000)
  assert.equal((await fetch(s.f.base + base + 'seg-999999.ts')).status, 404)
  const leaks = [JSON.stringify(a.body), text, s.f.base]
  for (const body of leaks.slice(0, 2)) for (const needle of ['127.0.0.1:' + s.dev.port, ':' + s.dev.port, '/auto/v', 'evil.example']) assert.ok(!body.includes(needle), needle + ' leaked')
  const tampered = a.body.url.replace(/\.[A-Za-z0-9_-]+\/index/, '.AAAA/index')
  assert.equal((await fetch(s.f.base + tampered)).status, 403)
  assert.equal((await fetch(s.f.base + '/livetv/hls/forged.ticket.value/index.m3u8')).status, 403)
  assert.equal((await fetch(s.f.base + base + 'seg-1.ts?x=1', { method: 'POST' })).status, 405)
  const b = await s.owner('watch', { channel: '2.1', quality: '480p' }, 'owner')
  assert.equal(b.status, 200)
  assert.equal(s.dev.activeStreams(), 1, 'two viewers, one tuner')
  const c = await s.owner('watch', { channel: '4.1', quality: '480p' }, 'owner')
  assert.equal(c.status, 200)
  assert.equal(s.dev.activeStreams(), 2)
  const d = await s.owner('watch', { channel: '9.1', quality: '480p' }, 'member')
  assert.equal(d.status, 503)
  assert.equal(d.body.error, 'tuners_busy')
  assert.match(d.body.message, /All 2 tuners are busy/)
  const status = await s.owner('status')
  assert.equal(status.body.sessions.length, 2)
  assert.equal(status.body.sessions.find((x) => x.channelKey === '2.1').viewers, 2)
  await s.owner('stop', { ticket: a.body.ticket }, 'member')
  assert.equal((await s.owner('status')).body.sessions.find((x) => x.channelKey === '2.1').viewers, 1)
  await s.owner('stop', { ticket: b.body.ticket }, 'member')
  assert.equal((await s.owner('status')).body.sessions.find((x) => x.channelKey === '2.1').viewers, 1, 'someone else’s ticket cannot stop your viewing')
  await s.owner('stop', { ticket: b.body.ticket }, 'owner')
  await s.owner('stop', { ticket: c.body.ticket }, 'owner')
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(s.dev.activeStreams(), 0, 'all tuners released')
  const e = await s.owner('watch', { channel: '9.1', quality: '480p' }, 'member')
  assert.equal(e.status, 200, 'a freed tuner can be used again')
})

test('watching: Live TV off, unknown channel and bad quality are handled', async (t) => {
  const s = await setup(t)
  assert.equal((await s.owner('watch', { channel: '2.1' }, 'member')).status, 409)
  await addTuner(s)
  assert.equal((await s.owner('watch', { channel: 'nope' }, 'member')).status, 404)
  const r = await s.owner('watch', { channel: '2.1', quality: '4k' }, 'member')
  assert.equal(r.status, 200)
  assert.equal(r.body.quality, '720p', 'an unknown quality falls back to the owner’s default')
  await s.owner('admin/settings', { enabled: false })
  assert.equal((await fetch(s.f.base + r.body.url)).status, 409)
})

test('guide: load an XMLTV file, see now/next and the grid; channel-names-only without one', async (t) => {
  const s = await setup(t)
  await addTuner(s)
  const noGuide = (await s.owner('guide?hours=3', undefined, 'member')).body
  assert.equal(noGuide.hasGuide, false)
  assert.equal(noGuide.rows.length, 3)
  assert.deepEqual(noGuide.rows[0].programmes, [])
  const file = path.join(s.dataDir, 'guide.xml')
  fs.writeFileSync(file, XML(Date.now() - 1800000))
  assert.equal((await s.owner('admin/guide/source', { type: 'file', path: 'relative.xml' })).status, 400)
  const set = await s.owner('admin/guide/source', { type: 'file', path: file })
  assert.equal(set.status, 200, JSON.stringify(set.body))
  const g = (await s.owner('guide?hours=3', undefined, 'member')).body
  assert.equal(g.hasGuide, true)
  assert.deepEqual(g.rows.find((r) => r.channel === '2.1').programmes.map((p) => p.title), ['Evening News', 'Quiz Night'])
  const ch = (await s.owner('channels', undefined, 'member')).body.channels.find((c) => c.key === '2.1')
  assert.equal(ch.now.title, 'Evening News')
  assert.equal(ch.next.title, 'Quiz Night')
  const badUrl = await s.owner('admin/guide/source', { type: 'url', url: 'ftp://x/y.xml' })
  assert.equal(badUrl.status, 400)
  const priv = await s.owner('admin/guide/source', { type: 'url', url: 'http://192.168.1.20/g.xml' })
  assert.equal(priv.body.ok, false)
  assert.match(priv.body.message, /own network/, 'a private guide address needs the owner’s confirmation')
  const meta = await s.owner('admin/guide/source', { type: 'url', url: 'http://169.254.169.254/latest' , allowPrivate: true })
  assert.equal(meta.body.ok, false)
  assert.equal((await s.owner('admin/guide/source', { type: 'none' })).status, 200)
})

test('recording: off until the owner turns it on; members only if allowed; conflicts reported; series rules; nothing records on its own', async (t) => {
  const s = await setup(t)
  await addTuner(s)
  const soon = Date.now() + 3600000
  const body = { channel: '2.1', title: 'Evening News', start: soon, end: soon + 3600000 }
  assert.equal((await s.owner('dvr/schedule', body)).status, 409)
  assert.equal((await s.owner('dvr/schedule', body)).body.error, 'dvr_off')
  const rec = path.join(s.dataDir, 'Recordings')
  assert.equal((await s.owner('admin/settings', { dvrEnabled: true, recordingsDir: 'relative/path' })).status, 400)
  assert.equal((await s.owner('admin/settings', { dvrEnabled: true, recordingsDir: rec, container: 'ts' })).status, 200)
  assert.ok(fs.existsSync(rec), 'the Recordings folder is created')
  const mem = await s.owner('dvr/schedule', body, 'member')
  assert.equal(mem.status, 403)
  assert.match(mem.body.message, /person who runs Beebo/)
  const ok = await s.owner('dvr/schedule', body)
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.equal(ok.body.item.status, 'scheduled')
  assert.equal((await s.owner('dvr/schedule', body)).body.error, 'already_scheduled')
  await s.owner('dvr/schedule', { ...body, channel: '4.1', title: 'Other' })
  const clash = await s.owner('dvr/schedule', { ...body, channel: '9.1', title: 'Third' })
  assert.equal(clash.status, 409)
  assert.equal(clash.body.error, 'conflict')
  assert.match(clash.body.message, /not enough tuners/)
  await s.owner('admin/settings', { allowMemberRecording: true })
  const memberOk = await s.owner('dvr/schedule', { ...body, start: soon + 4 * 3600000, end: soon + 5 * 3600000, title: 'Member Show' }, 'member')
  assert.equal(memberOk.status, 200)
  const list = (await s.owner('dvr', undefined, 'member')).body
  assert.equal(list.canRecord, true)
  assert.equal(list.recordingsDir, undefined, 'the folder path is not shown to members')
  const ownersItem = list.items.find((i) => i.title === 'Evening News')
  assert.equal((await s.owner('dvr/cancel', { id: ownersItem.id }, 'member')).status, 403, 'a member cannot cancel the owner’s recording')
  assert.equal((await s.owner('dvr/cancel', { id: memberOk.body.item.id }, 'member')).status, 200)
  assert.equal((await s.owner('dvr/cancel', { id: ownersItem.id })).status, 200)
  const rule = await s.owner('dvr/rule', { title: 'Evening News' })
  assert.equal(rule.status, 200)
  assert.equal((await s.owner('dvr/rule', { title: 'Evening News' })).status, 409)
  assert.equal((await s.owner('dvr')).body.rules.length, 1)
  assert.equal((await s.owner('dvr/rule/remove', { id: rule.body.rule.id })).status, 200)
  assert.deepEqual((await s.owner('dvr')).body.items.map((i) => i.title), ['Other'], 'only what a person asked for exists')
  const off = await s.owner('dvr/rule', { title: 'X' }, 'kid')
  assert.equal(off.status, 403)
})

test('recordings can be added to the library as a TV Shows folder by the owner', async (t) => {
  const s = await setup(t)
  assert.equal((await s.owner('admin/recordings/add-to-library', {})).status, 409)
  const rec = path.join(s.dataDir, 'Recordings')
  await s.owner('admin/settings', { dvrEnabled: true, recordingsDir: rec })
  const r = await s.owner('admin/recordings/add-to-library', {})
  assert.equal(r.body.added, true)
  assert.deepEqual(s.f.store.get('extraTvShowsDirs'), [rec])
  assert.equal((await s.owner('admin/recordings/add-to-library', {})).body.added, false, 'no duplicates')
})

test('M3U + XMLTV advanced option: a stub, off, with the plain warning', async (t) => {
  const s = await setup(t)
  const adv = await s.owner('advanced', undefined, 'member')
  assert.equal(adv.body.m3uEnabled, false)
  assert.match(adv.body.notice, /not supply channels/)
  assert.match(adv.body.notice, /licensed/)
  const post = await s.owner('admin/advanced/m3u', { url: 'http://x/list.m3u' })
  assert.equal(post.status, 501)
  assert.equal(post.body.error, 'not_implemented')
})

test('web: the pages need the login cookie, the sidebar shows Live TV only once it is set up, restricted profiles are told why, cookie POSTs must be same-site', async (t) => {
  const s = await setup(t)
  assert.equal((await s.web(null, '/livetv')).status, 302)
  assert.equal((await s.web(null, '/livetv/watch')).status, 302)
  assert.equal((await s.web(null, '/livetv-api/status')).status, 302)
  const before = await s.web('member', '/tvshows')
  assert.ok(!before.text.includes('href="/livetv"'), 'no Live TV link before a tuner is set up')
  await addTuner(s)
  const page = await s.web('member', '/livetv')
  assert.equal(page.status, 200)
  assert.match(page.text, /What's on/)
  assert.ok(page.text.includes('href="/livetv"'), 'the sidebar has Live TV')
  assert.ok(!page.text.includes('>Set up<'), 'members do not get the set-up tab')
  assert.ok((await s.web('owner', '/livetv')).text.includes('>Set up<'))
  assert.ok(!page.text.includes('127.0.0.1:' + s.dev.port))
  const watchPage = await s.web('member', '/livetv/watch?channel=2.1')
  assert.equal(watchPage.status, 200)
  assert.match(watchPage.text, /\/hls\/hls\.min\.js/)
  assert.match(watchPage.text, /Go live/)
  assert.match(watchPage.text, /"channel":"2\.1"/)
  const kid = await s.web('kid', '/livetv')
  assert.equal(kid.status, 403)
  assert.match(kid.text, /parental controls/)
  assert.equal((await s.web('kid', '/livetv-api/channels')).status, 403)
  const ch = await s.web('member', '/livetv-api/channels')
  assert.equal(ch.json.channels.length, 3)
  const fav = await s.web('member', '/livetv-api/favourite', { method: 'POST', body: { channel: '4.1', on: true } })
  assert.equal(fav.status, 200)
  const cross = await s.web('member', '/livetv-api/favourite', { method: 'POST', body: { channel: '4.1', on: false }, headers: { 'Sec-Fetch-Site': 'cross-site' } })
  assert.equal(cross.status, 403)
  assert.equal(cross.json.error, 'cross_site')
  assert.equal((await s.web('member', '/livetv-api/favourite', { method: 'POST', body: { channel: '4.1' }, headers: { Origin: 'https://evil.example' } })).status, 403)
  const notJson = await fetch(s.f.base + '/livetv-api/favourite', { method: 'POST', headers: { Cookie: s.cookie('member'), 'Content-Type': 'text/plain' }, body: '{}' })
  assert.equal(notJson.status, 415)
  const w = await s.web('member', '/livetv-api/watch', { method: 'POST', body: { channel: '2.1' } })
  assert.equal(w.status, 200)
  assert.equal((await fetch(s.f.base + w.json.url)).status, 200, 'the same ticket works for the web player')
})

test('the desktop app call() runs the same contract as the owner', async (t) => {
  const s = await setup(t)
  const liveTv = s.f.info.liveTv
  const r = await liveTv.call('POST', '/admin/device', {}, { host: '127.0.0.1', port: s.dev.port, streamPort: s.dev.port, confirmNonLan: true }, { id: 'owner', isAdmin: true })
  assert.equal(r.status, 200)
  const c = await liveTv.call('GET', 'channels', {}, {}, { id: 'owner', isAdmin: true })
  assert.equal(c.body.channels.length, 3)
  assert.equal((await liveTv.call('GET', 'channels', {}, {}, null)).status, 401)
  assert.equal((await liveTv.call('GET', 'channels', {}, {}, { id: 'g', guest: true })).status, 403)
  assert.equal(liveTv.navVisible(), true)
})

test('state survives a server restart (config in a safeJson file), and a damaged file never blocks start-up', async (t) => {
  const s = await setup(t)
  await addTuner(s)
  const file = path.join(s.dataDir, 'data', 'livetv.json')
  assert.ok(fs.existsSync(file))
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(saved.devices[0].id, '1A2B3C4D')
  assert.equal(saved.lineups['1A2B3C4D'].channels.length, 4)
  const { createLiveTv } = require('../electron/liveTv')
  const again = createLiveTv({ dataDir: path.join(s.dataDir, 'data'), ffmpegPath: () => null, getEncoder: async () => ({}), sign: () => 'x', verify: () => false, hlsOverrides: { sweepEveryMs: 0 }, tmpRoot: path.join(s.dataDir, 'hls2') })
  t.after(() => again.stop())
  assert.equal(again.navVisible(), true)
  fs.writeFileSync(file, '{"devices": [')
  const damaged = createLiveTv({ dataDir: path.join(s.dataDir, 'data'), ffmpegPath: () => null, getEncoder: async () => ({}), sign: () => 'x', verify: () => false, hlsOverrides: { sweepEveryMs: 0 }, tmpRoot: path.join(s.dataDir, 'hls3') })
  t.after(() => damaged.stop())
  assert.equal(damaged.config.get().devices.length, 1, 'the tuner list is restored from the last-good copy')
  assert.ok(fs.readdirSync(path.join(s.dataDir, 'data')).some((n) => n.startsWith('livetv.json.corrupt-')))
})
