'use strict'
// The owner's side of the Jellyfin-compatible mode (Settings > Jellyfin apps). Reached only over Electron IPC from the desktop
// window (electron/jellyfinIpc.js), never over HTTP: status, Quick Connect approval, the list of signed-in apps with "sign out",
// app passwords, and a self-check that exercises the mode the way an app would and says plainly what is wrong.

const http = require('http')
const https = require('https')
const crypto = require('crypto')
const authLib = require('../auth')
const twoFactor = require('../twoFactor')
const { CaptureResponse, makeRequest } = require('./internalApi')
const { TOKEN_PREFIX, PRODUCT_NAME, COMPAT_API_VERSION } = require('./constants')

function createAdmin({ store, host, auth, hub, router, settingEnabled }) {
  const approvedUsers = () => {
    try { return authLib.getUsers(store).filter((u) => u && u.status === 'approved' && !u.guest) } catch { return [] }
  }
  const owner = () => approvedUsers().find((u) => u.isAdmin) || approvedUsers()[0] || null

  function status() {
    return {
      enabled: settingEnabled(),
      version: COMPAT_API_VERSION,
      product: PRODUCT_NAME,
      apps: auth.adminSessions().length,
      liveSockets: hub.count(),
      pendingQuickConnect: auth.quickConnectPending(),
      appPasswords: auth.appPasswords.count()
    }
  }

  const users = () => approvedUsers().map((u) => ({ id: u.id, name: u.name || u.username || '', username: u.username || '', isAdmin: !!u.isAdmin, twoFactor: twoFactor.isEnabled(u) }))

  function approveQuickConnect(code, userId) {
    if (!settingEnabled()) return { ok: false, error: 'off' }
    const clean = String(code || '').replace(/\D/g, '')
    if (clean.length !== 6) return { ok: false, error: 'bad_code' }
    const who = userId || (owner() && owner().id)
    if (!who) return { ok: false, error: 'no_person' }
    const r = auth.quickConnectApprove({ userId: who, code: clean })
    if (r.limited) return { ok: false, error: 'too_many_wrong' }
    return r.ok ? { ok: true, app: r.device && r.device.client, device: r.device && r.device.name } : { ok: false, error: r.error || 'unknown_code' }
  }

  function revokeSession(userId, handle) {
    const r = auth.adminRevoke(userId, handle)
    try { hub.closeAllForUser(userId) } catch {}
    return r
  }

  function createAppPassword(userId, label) {
    const u = approvedUsers().find((x) => x.id === userId)
    if (!u) return { ok: false, error: 'no_person' }
    return auth.appPasswords.create(u.id, label)
  }
  const appPasswordList = () => {
    const names = new Map(approvedUsers().map((u) => [u.id, u.name || u.username || '']))
    return auth.appPasswords.list().filter((r) => names.has(r.userId)).map((r) => ({ ...r, userName: names.get(r.userId) }))
  }

  // ---- self-check ----
  function localCall(token, method, path, { body, headers } = {}) {
    const req = makeRequest(null, {
      method,
      path,
      headers: { 'x-emby-authorization': 'MediaBrowser Client="Beebo self-check", Device="This computer", DeviceId="beebo-self-check", Version="1", Token="' + token + '"', ...(headers || {}) },
      body
    })
    req.socket = { remoteAddress: '127.0.0.1' }
    const res = new CaptureResponse()
    res.req = req
    return Promise.race([
      router.handle(req, res, new URL(path, 'http://localhost')).then(() => (res.writableEnded ? null : new Promise((resolve) => res.once('finish', resolve)))),
      new Promise((resolve) => setTimeout(resolve, 20000).unref())
    ]).then(() => {
      const buf = res.body()
      let json = null
      try { json = buf.length && buf.length < 5e6 ? JSON.parse(buf.toString('utf8')) : null } catch { json = null }
      return { status: res.statusCode, json, bytes: buf.length, headers: res.getHeaders() }
    })
  }

  function realConnect(port, token) {
    const key = crypto.randomBytes(16).toString('base64')
    const attempt = (secure) => new Promise((resolve) => {
      const lib = secure ? https : http
      const req = lib.request({ host: '127.0.0.1', port, path: '/socket?api_key=' + encodeURIComponent(token) + '&deviceId=beebo-self-check', method: 'GET', rejectUnauthorized: false, servername: 'localhost', timeout: 6000, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key } })
      req.on('upgrade', (_res, socket) => { try { socket.destroy() } catch {} resolve({ ok: true }) })
      req.on('response', (res) => { res.resume(); resolve({ ok: false, status: res.statusCode, redirected: res.statusCode >= 300 && res.statusCode < 400 }) })
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, timeout: true }) })
      req.on('error', (e) => resolve({ ok: false, error: e && e.code }))
      req.end()
    })
    return attempt(false).then((r) => (r.redirected ? attempt(true) : r)).then((r) => (r.ok || r.status || r.timeout ? r : attempt(true)))
  }

  async function selfTest({ userId } = {}) {
    const checks = []
    const add = (id, label, state, detail, hint) => checks.push({ id, label, state, detail: detail || '', hint: state === 'fail' ? hint || '' : '' })
    if (!settingEnabled()) {
      add('enabled', 'Jellyfin-compatible API is switched on', 'fail', 'The switch is off, so apps get "not found".', 'Turn on "Jellyfin-compatible API" above, then run the check again.')
      return finish(checks)
    }
    add('enabled', 'Jellyfin-compatible API is switched on', 'pass')
    const user = userId ? approvedUsers().find((u) => u.id === userId) : owner()
    if (!user) {
      add('person', 'A person to check with', 'fail', 'No approved account was found.', 'Create or approve an account in Beebo first.')
      return finish(checks)
    }
    const raw = host.makeApiToken(store, user.id)
    if (!raw) { add('token', 'Sign-in works', 'fail', 'Could not make a sign-in for ' + (user.name || user.username) + '.', 'Restart Beebo and try again.'); return finish(checks) }
    const token = TOKEN_PREFIX + raw

    const anon = async (path) => {
      const req = makeRequest(null, { method: 'GET', path, headers: {} })
      req.socket = { remoteAddress: '127.0.0.1' }
      const res = new CaptureResponse()
      res.req = req
      await router.handle(req, res, new URL(path, 'http://localhost'))
      let json = null
      try { json = JSON.parse(res.body().toString('utf8')) } catch {}
      return { status: res.statusCode, json }
    }
    try {
      const pub = await anon('/System/Info/Public')
      add('info', 'Apps can find the server (System/Info/Public)', pub.status === 200 && pub.json && pub.json.Id && pub.json.Version ? 'pass' : 'fail', pub.json ? 'Reports version ' + pub.json.Version + ' as "' + (pub.json.ServerName || '') + '".' : 'HTTP ' + pub.status, 'Restart Beebo. If it still fails, another program may be using its port.')
      const qc = await anon('/QuickConnect/Enabled')
      add('quickconnect', 'Quick Connect is available', qc.status === 200 && qc.json === true ? 'pass' : 'fail', '', 'Turn the Jellyfin-compatible API off and on again.')

      const me = await localCall(token, 'GET', '/Users/Me')
      add('me', 'Signed-in requests are accepted for ' + (user.name || user.username), me.status === 200 ? 'pass' : 'fail', 'HTTP ' + me.status, 'Sign-ins may be blocked for this account; check Parental controls and the account status.')

      const views = await localCall(token, 'GET', '/UserViews')
      const viewList = (views.json && views.json.Items) || []
      add('views', 'Libraries show up (Movies, TV, Music...)', viewList.length ? 'pass' : 'fail', viewList.length ? viewList.map((v) => v.Name).join(', ') : 'No libraries are visible to this account.', 'Add a movies or TV folder in Beebo, or check that this account is allowed to see something.')

      const movies = await localCall(token, 'GET', '/Items?includeItemTypes=Movie&recursive=true&limit=1&sortBy=SortName')
      let item = movies.json && movies.json.Items && movies.json.Items[0]
      if (!item) {
        const eps = await localCall(token, 'GET', '/Items?includeItemTypes=Episode&recursive=true&limit=1')
        item = eps.json && eps.json.Items && eps.json.Items[0]
      }
      add('items', 'Films or episodes can be listed', item ? 'pass' : 'skip', item ? 'e.g. "' + item.Name + '"' : 'There is nothing to list yet, so the playback checks were skipped.')
      if (item) {
        const detail = await localCall(token, 'GET', '/Items/' + item.Id)
        const src = detail.json && detail.json.MediaSources && detail.json.MediaSources[0]
        add('detail', 'An item opens with its file details', detail.status === 200 && src ? 'pass' : 'fail', src ? (src.Container || '') + ' ' + ((src.MediaStreams || []).length) + ' tracks' : 'HTTP ' + detail.status, 'The file may have moved. Rescan the library.')
        const pb = await localCall(token, 'POST', '/Items/' + item.Id + '/PlaybackInfo', { body: { DeviceProfile: { DirectPlayProfiles: [{ Type: 'Video', Container: 'mp4,mkv,m4v,mov,webm', VideoCodec: 'h264,hevc,vp9,av1', AudioCodec: 'aac,mp3,ac3,eac3,opus,flac' }], TranscodingProfiles: [], CodecProfiles: [] }, MaxStreamingBitrate: 120000000 } })
        const ms = pb.json && pb.json.MediaSources && pb.json.MediaSources[0]
        if (pb.json && pb.json.ErrorCode === 'NotAllowed') add('playback', 'Playback is offered', 'skip', 'Playback is paused for this account right now (bedtime or daily limit).')
        else add('playback', 'Playback is offered (direct file or a converted stream)', ms && (ms.DirectStreamUrl || ms.TranscodingUrl) ? 'pass' : 'fail', ms ? (ms.DirectStreamUrl ? 'Direct play' : 'Converted stream') : 'HTTP ' + pb.status, 'Nothing can play this file. Check that the video encoder works (Settings > Playback).')
        if (ms && ms.DirectStreamUrl) {
          const rng = await localCall(token, 'GET', ms.DirectStreamUrl, { headers: { range: 'bytes=0-1023' } })
          add('range', 'The file can be read in pieces (seeking works)', (rng.status === 206 || rng.status === 200) && rng.bytes > 0 && rng.bytes <= 1024 ? 'pass' : 'fail', 'HTTP ' + rng.status + ', ' + rng.bytes + ' bytes', 'Direct streaming is refused for this file. Try another item, or check the away-from-home quality cap.')
        }
        if (item.ImageTags && item.ImageTags.Primary) {
          const img = await localCall(token, 'GET', '/Items/' + item.Id + '/Images/Primary?tag=' + item.ImageTags.Primary)
          add('images', 'Posters load', img.status === 200 || img.status === 302 ? 'pass' : 'fail', 'HTTP ' + img.status, 'Refresh the library so posters download.')
        } else add('images', 'Posters load', 'skip', 'This item has no poster yet.')
        const seg = await localCall(token, 'GET', '/MediaSegments/' + item.Id)
        add('segments', 'Skip-intro data is answered', seg.status === 200 ? 'pass' : 'fail', seg.json && seg.json.Items ? seg.json.Items.length + ' segment(s)' : '', '')
        const hint = String(item.Name || '').slice(0, 3)
        if (hint.length >= 2) {
          const s = await localCall(token, 'GET', '/Search/Hints?searchTerm=' + encodeURIComponent(hint))
          add('search', 'Search finds titles', s.status === 200 && s.json && s.json.SearchHints && s.json.SearchHints.length ? 'pass' : 'fail', '', 'The library may still be loading. Try again in a minute.')
        }
      }
      for (const [id, label, path] of [['resume', 'Continue Watching answers', '/UserItems/Resume'], ['nextup', 'Next Up answers', '/Shows/NextUp'], ['latest', 'Recently added answers', '/Items/Latest'], ['suggestions', 'Suggestions answer', '/Items/Suggestions']]) {
        const r = await localCall(token, 'GET', path)
        add(id, label, r.status === 200 ? 'pass' : 'fail', 'HTTP ' + r.status, 'Restart Beebo and run the check again.')
      }
      if (typeof host.localPort === 'function') {
        const port = host.localPort()
        if (port) {
          const ws = await realConnect(port, token)
          add('socket', 'Live updates connection (WebSocket) opens on the real port', ws.ok ? 'pass' : 'fail', ws.ok ? '' : ws.status ? 'HTTP ' + ws.status : ws.timeout ? 'timed out' : String(ws.error || ''), 'Apps still work without it, but they will not refresh by themselves. A firewall or proxy on this PC may be blocking WebSockets.')
        }
      }
    } catch (err) {
      add('error', 'The check ran to the end', 'fail', String((err && err.message) || err), 'Restart Beebo and try again.')
    }
    return finish(checks)
  }

  function finish(checks) {
    const failed = checks.filter((c) => c.state === 'fail')
    const passed = checks.filter((c) => c.state === 'pass').length
    return {
      ok: failed.length === 0,
      ranAt: Date.now(),
      passed,
      failed: failed.length,
      checks,
      summary: failed.length === 0
        ? 'All ' + passed + ' checks passed. Jellyfin apps should be able to connect, browse and play.'
        : failed.length + ' of ' + (passed + failed.length) + ' checks failed: ' + failed.map((c) => c.label).join('; ') + '.'
    }
  }

  return {
    status,
    users,
    sessions: () => auth.adminSessions(),
    revokeSession,
    quickConnectPending: () => auth.quickConnectPending(),
    approveQuickConnect,
    appPasswords: appPasswordList,
    createAppPassword,
    removeAppPassword: (id) => auth.appPasswords.remove(id),
    selfTest
  }
}

module.exports = { createAdmin }
