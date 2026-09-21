'use strict'
// ============================================================================
// Live TV - watching and recording TV from the owner's own antenna through their own network tuner
// (SiliconDust HDHomeRun). Beebo supplies no channels, no streams and no guide data; everything stays
// on the home network. See PLEX-PARITY-PLAN.md and docs/LIVE-TV.md.
//
// This file is the one entry point streamServer.js talks to:
//   const liveTv = require('./liveTv').createLiveTv({...})
//   liveTv.claimsPublic(pathname)  /livetv/hls/<ticket>/...   signed-ticket playlist + pieces (no login)
//   liveTv.claimsApi(path)         /api/livetv/...            JSON, bearer token (apps)
//   liveTv.claimsWeb(pathname)     /livetv, /livetv/watch, /livetv-api/...   browser pages + JSON, login cookie
//   liveTv.call(...)               the desktop app's Settings > Live TV and Live TV tabs (IPC), as the owner
// Who may use it: any signed-in, unrestricted household member. Profiles with parental controls and
// guests from a shared library are refused - parental controls rate films and shows, not channels, so
// there is nothing to filter a live channel by. Setting the tuners up (and, by default, recording) is
// for the owner (admin) only.
// ============================================================================

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const zlib = require('zlib')

const hdhr = require('./hdhr')
const guard = require('./netGuard')
const channelsLib = require('./channels')
const { createStateFile } = require('./stateFile')
const { createTunerPool, TunerBusyError } = require('./tunerPool')
const liveHls = require('./liveHls')
const { createGuide } = require('./guide')
const { createDvr } = require('./dvr')
const webUi = require('./webUi')

const M3U_NOTICE = 'Advanced: a generic "M3U + XMLTV" source is planned but is not available in this version. When it arrives it will be off unless you switch it on, and Beebo will not supply channels or lists: you may only use sources you are licensed to use.'
const RESTRICTED = { status: 403, body: { ok: false, error: 'restricted_profile', message: 'Live TV is not available on profiles with parental controls, because those limits are about films and shows, not channels. Ask the person who runs Beebo.' } }
const GUEST = { status: 403, body: { ok: false, error: 'not_available_to_guests', message: 'Live TV is not shared with other households.' } }

const bad = (message, error = 'bad_request', status = 400) => ({ status, body: { ok: false, error, message } })
const ok = (body = {}) => ({ status: 200, body: { ok: true, ...body } })

function createLiveTv({
  store, dataDir, ffmpegPath, getEncoder, sign, verify, isRestricted = () => false, crossSite = () => false,
  addToLibrary, log = () => {}, tmpRoot, poolOverrides = {}, hlsOverrides = {}, dvrOverrides = {}, guideOverrides = {}, discoverOverrides = {}, now = Date.now
} = {}) {
  const dir = dataDir || (store && typeof store.path === 'string' && store.path ? path.join(path.dirname(store.path), 'livetv') : path.join(os.tmpdir(), 'beebo-livetv-data'))
  const config = createStateFile(path.join(dir, 'livetv.json'), {}, channelsLib.normalizeConfig)
  const prefs = createStateFile(path.join(dir, 'livetv-users.json'), {}, channelsLib.normalizePrefs)
  const cfg = () => config.get()
  const updateCfg = (fn) => config.update(fn)
  const settings = () => cfg().settings

  const channelList = () => channelsLib.buildChannels(cfg()).channels
  const visibleChannels = () => channelList().filter((c) => !c.hidden)
  const channelByKey = (k) => channelList().find((c) => c.key === k) || null

  const pool = createTunerPool({ getDevices: () => cfg().devices, log, ...poolOverrides })
  const live = liveHls.createLiveHls({
    pool, ffmpegPath, getEncoder, settings, log, tmpRoot: tmpRoot || path.join(os.tmpdir(), 'beebo-livetv'), ...hlsOverrides
  })
  const guide = createGuide({ dir, getConfig: cfg, updateConfig: updateCfg, getChannels: channelList, log, now, ...guideOverrides })
  const dvr = createDvr({ dir, getConfig: cfg, getChannels: channelList, guide, pool, ffmpegPath, log, now, ...dvrOverrides })

  let navListener = null
  const notify = () => { try { if (navListener) navListener(navVisible()) } catch { /* UI only */ } }
  const navVisible = () => cfg().enabled && cfg().devices.length > 0 && channelList().length > 0

  const start = () => { if (cfg().enabled) { guide.schedule(); dvr.start() } }
  const stop = () => { try { guide.stop() } catch { /* stopping */ } try { dvr.stop() } catch { /* stopping */ } try { live.closeAll() } catch { /* stopping */ } try { pool.closeAll() } catch { /* stopping */ } }

  // ------------------------------------------------------------- shapes
  const deviceShape = (d) => ({ id: d.id, name: d.name, model: d.model, firmware: d.firmware, ip: d.ip, tunerCount: d.tunerCount, nonLan: d.allowNonLan === true, addedAt: d.addedAt, lineupAt: (cfg().lineups[d.id] || {}).fetchedAt || 0, channels: ((cfg().lineups[d.id] || {}).channels || []).length })

  function channelShape(ch, userId, map, t) {
    const favs = (prefs.get().users[userId] || {}).favourites || []
    const nn = guide.nowNext(ch.key, t, map)
    const slim = (p) => (p ? { title: p.title, subTitle: p.subTitle, start: p.start, stop: p.stop, isNew: p.isNew } : null)
    return { key: ch.key, number: ch.number, name: ch.name, hd: ch.hd, hidden: ch.hidden, favourite: favs.includes(ch.key), now: slim(nn.now), next: slim(nn.next), guide: !!map[ch.key] }
  }

  function statusBody(user) {
    const built = channelsLib.buildChannels(cfg())
    return {
      enabled: cfg().enabled, devices: user.isAdmin ? cfg().devices.map(deviceShape) : cfg().devices.length,
      channelCount: built.channels.filter((c) => !c.hidden).length, drmHidden: built.drmHidden, drmNote: built.drmHidden ? channelsLib.DRM_NOTE : '',
      guide: guide.status(), dvr: { enabled: settings().dvrEnabled && !!settings().recordingsDir, canRecord: canRecord(user), allowMemberRecording: settings().allowMemberRecording },
      isAdmin: !!user.isAdmin, quality: settings().quality, timeshiftMinutes: settings().timeshiftMinutes,
      tuners: user.isAdmin ? pool.status() : undefined, sessions: user.isAdmin ? live.list() : undefined,
      lan: 'All tuner traffic stays on your home network. Beebo does not supply channels or guide data.'
    }
  }

  const canRecord = (user) => !!(settings().dvrEnabled && settings().recordingsDir && (user.isAdmin || settings().allowMemberRecording))

  // -------------------------------------------------------------- watch
  async function watch(body, user) {
    if (!cfg().enabled) return bad('Live TV is turned off. The owner can turn it on in Settings > Live TV.', 'off', 409)
    const ch = channelByKey(String(body.channel || ''))
    if (!ch || (ch.hidden && !user.isAdmin)) return bad('That channel is not available.', 'unknown_channel', 404)
    const quality = channelsLib.QUALITY_IDS.includes(body.quality) ? body.quality : settings().quality
    const nonce = crypto.randomBytes(8).toString('hex')
    try {
      const session = await live.open({ channel: ch, quality, userId: String(user.id), nonce })
      const ticket = liveHls.makeLiveTicket(sign, { c: ch.key, q: quality, u: String(user.id), n: nonce })
      const nn = guide.nowNext(ch.key)
      return ok({
        url: `/livetv/hls/${ticket}/index.m3u8`, ticket, mimeType: 'application/x-mpegURL', live: true, quality, encoder: session.encoderLabel || session.encoder,
        channel: { key: ch.key, number: ch.number, name: ch.name }, timeshiftMinutes: settings().timeshiftMinutes,
        now: nn.now ? { title: nn.now.title, start: nn.now.start, stop: nn.now.stop } : null
      })
    } catch (e) {
      if (e instanceof TunerBusyError) return { status: 503, body: { ok: false, error: 'tuners_busy', message: e.message } }
      if (e && e.code && /^(no_encoder|no_ffmpeg|bad_quality)$/.test(e.code)) return bad(e.message, e.code, 409)
      if (e && e.code === 'no_signal') return bad(e.message, e.code, 502)
      if (e && typeof e.code === 'string' && e.code.startsWith('tuner_')) return bad(e.message, e.code, 502)
      if (e && typeof e.code === 'string' && (e.code === 'no_device' || e.code === 'bad_address')) return bad(e.message, e.code, 409)
      log('live TV watch failed: ' + (e && e.code || e && e.message || 'error'))
      return bad('Live TV could not start.', 'failed', 500)
    }
  }

  function stopWatch(body, user) {
    const t = liveHls.readLiveTicket(verify, body.ticket)
    if (t && t.userId === String(user.id)) live.leave(live.keyOf(t.channel, t.quality), t.nonce || String(user.id))
    return ok()
  }

  // -------------------------------------------------------------- admin
  async function refreshLineup(deviceId) {
    const d = cfg().devices.find((x) => x.id === deviceId)
    if (!d) return bad('That tuner is not set up.', 'not_found', 404)
    try {
      const rows = await hdhr.fetchLineup(d.ip, d.apiPort)
      updateCfg((c) => { c.lineups[d.id] = { fetchedAt: now(), channels: rows }; const dev = c.devices.find((x) => x.id === d.id); if (dev) dev.lastSeenAt = now() })
      notify()
      const built = channelsLib.buildChannels(cfg())
      return ok({ found: rows.length, drmHidden: rows.filter((r) => r.drm).length, drmNote: rows.some((r) => r.drm) ? channelsLib.DRM_NOTE : '', channels: built.channels.length })
    } catch (e) {
      return bad('Could not read the channel list from the tuner (' + (e && e.code || 'error') + '). Is it switched on and on this network?', 'lineup_failed', 502)
    }
  }

  async function addDevice(body) {
    const check = guard.validateTunerTarget({ host: body.host, port: body.port }, { confirmNonLan: body.confirmNonLan === true })
    if (!check.ok) return { status: check.needsConfirm ? 409 : 400, body: { ok: false, error: check.error, message: check.message, needsConfirm: !!check.needsConfirm } }
    const probe = await hdhr.probeDevice(check.ip, check.port)
    if (!probe.ok) return bad(probe.message, probe.error, 502)
    const dev = probe.device
    const existing = cfg().devices.find((d) => d.id === dev.deviceId)
    const streamPort = Number.isInteger(Number(body.streamPort)) && Number(body.streamPort) > 0 && Number(body.streamPort) < 65536 ? Number(body.streamPort) : 5004
    const row = channelsLib.normalizeDevice({
      id: dev.deviceId, ip: check.ip, apiPort: check.port, streamPort, name: dev.name, model: dev.model, firmware: dev.firmware,
      tunerCount: dev.tunerCount, allowNonLan: !guard.isLan(check.klass), addedAt: existing ? existing.addedAt : now(), lastSeenAt: now()
    })
    if (!row) return bad('That tuner could not be added.', 'bad_device')
    if (!existing && cfg().devices.length >= channelsLib.MAX_DEVICES) return bad('That is the most tuners allowed.', 'too_many', 409)
    updateCfg((c) => { const i = c.devices.findIndex((d) => d.id === row.id); if (i >= 0) c.devices[i] = row; else c.devices.push(row); c.enabled = true })
    const lineup = await refreshLineup(row.id)
    start()
    notify()
    return ok({ device: deviceShape(cfg().devices.find((d) => d.id === row.id)), lineup: lineup.body })
  }

  function removeDevice(id) {
    if (!cfg().devices.some((d) => d.id === id)) return bad('That tuner is not set up.', 'not_found', 404)
    live.closeWhere((s) => s.channel.devices.every((x) => x === id))
    updateCfg((c) => { c.devices = c.devices.filter((d) => d.id !== id); delete c.lineups[id] })
    notify()
    return ok()
  }

  async function discover() {
    const found = await hdhr.discoverDevices(discoverOverrides)
    const known = new Set(cfg().devices.map((d) => d.id))
    return ok({ devices: found.map((f) => ({ ip: f.ip, deviceId: f.deviceId, tunerCount: f.tunerCount, added: known.has(f.deviceId) })) })
  }

  function setChannel(body) {
    const ch = channelByKey(String(body.channel || ''))
    if (!ch) return bad('Unknown channel.', 'unknown_channel', 404)
    updateCfg((c) => {
      const o = { ...(c.overrides[ch.key] || {}) }
      if (typeof body.hidden === 'boolean') { if (body.hidden) o.hidden = true; else delete o.hidden }
      if ('number' in body) { if (body.number === '' || body.number === null) delete o.number; else if (/^[0-9]{1,5}(\.[0-9]{1,3})?$/.test(String(body.number).trim())) o.number = String(body.number).trim(); else return }
      if ('name' in body) { const n = String(body.name || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 60); if (n) o.name = n; else delete o.name }
      if (Object.keys(o).length) c.overrides[ch.key] = o; else delete c.overrides[ch.key]
    })
    return ok()
  }

  function patchSettings(body) {
    const patch = {}
    const cur = settings()
    for (const k of Object.keys(channelsLib.DEFAULT_SETTINGS)) if (k in body) patch[k] = body[k]
    const next = channelsLib.normalizeSettings({ ...cur, ...patch })
    for (const k of ['recordingsDir', 'timeshiftDir']) {
      if (next[k] && (!path.isAbsolute(next[k]) || next[k].includes('\0'))) return bad('Choose a full folder path.', 'bad_folder')
    }
    updateCfg((c) => { c.settings = next; if (typeof body.enabled === 'boolean') c.enabled = body.enabled })
    if (next.recordingsDir && next.dvrEnabled) { try { fs.mkdirSync(next.recordingsDir, { recursive: true }) } catch { return bad('That Recordings folder cannot be created or written to.', 'bad_folder') } }
    start()
    notify()
    return ok({ settings: settings() })
  }

  async function setGuideSource(body) {
    const type = body.type === 'file' || body.type === 'url' ? body.type : 'none'
    const source = { type, path: '', url: '', allowPrivate: false }
    if (type === 'file') {
      source.path = String(body.path || '').trim()
      if (!path.isAbsolute(source.path)) return bad('Choose the guide file.', 'bad_file')
    } else if (type === 'url') {
      source.url = String(body.url || '').trim()
      if (!guard.parseGuideUrl(source.url)) return bad('Enter a web address that starts with http:// or https://.', 'bad_url')
      source.allowPrivate = body.allowPrivate === true
    }
    updateCfg((c) => { c.guide.source = source; c.guide.lastError = ''; if (Number(body.refreshEveryHours) > 0) c.guide.refreshEveryHours = Math.min(168, Math.round(Number(body.refreshEveryHours))) })
    const status = type === 'none' ? guide.status() : await guide.refresh()
    guide.schedule()
    if (type !== 'none' && status.lastError) return { status: 200, body: { ok: false, error: 'guide_failed', message: status.lastError, guide: guide.status() } }
    dvr.applyRules()
    return ok({ guide: guide.status() })
  }

  // ------------------------------------------------------------- router
  /**
   * The one JSON contract, whatever carries it. `sub` is the path after /livetv (no leading slash),
   * `user` = { id, isAdmin, guest }. Returns { status, body }.
   */
  async function handle(method, sub, query, body, user) {
    if (!user || !user.id) return { status: 401, body: { ok: false, error: 'unauthorized' } }
    if (user.guest) return GUEST
    if (isRestricted(user)) return RESTRICTED
    body = body && typeof body === 'object' ? body : {}
    const q = query instanceof URLSearchParams ? query : new URLSearchParams(query || {})
    const admin = !!user.isAdmin
    const needAdmin = () => (admin ? null : { status: 403, body: { ok: false, error: 'admin_only', message: 'Only the person who runs Beebo can change this.' } })
    const userId = String(user.id)

    if (method === 'GET' && sub === 'status') return ok(statusBody(user))
    if (method === 'GET' && sub === 'channels') {
      const t = now()
      const map = guide.mapping()
      const list = (admin && q.get('all') === '1' ? channelList() : visibleChannels()).map((c) => channelShape(c, userId, map, t))
      return ok({ channels: list, hasGuide: guide.status().hasGuide, drmHidden: channelsLib.buildChannels(cfg()).drmHidden, drmNote: channelsLib.buildChannels(cfg()).drmHidden ? channelsLib.DRM_NOTE : '' })
    }
    if (method === 'POST' && sub === 'favourite') {
      const ch = channelByKey(String(body.channel || ''))
      if (!ch) return bad('Unknown channel.', 'unknown_channel', 404)
      prefs.update((p) => {
        const u = p.users[userId] || (p.users[userId] = { favourites: [] })
        u.favourites = u.favourites.filter((k) => k !== ch.key)
        if (body.on !== false) u.favourites.push(ch.key)
      })
      return ok({ favourite: body.on !== false })
    }
    if (method === 'GET' && sub === 'guide') {
      const hours = Math.min(12, Math.max(1, Number(q.get('hours')) || 3))
      const from = Number(q.get('from')) || now()
      const g = guide.grid({ from, hours, channels: visibleChannels() })
      const favs = (prefs.get().users[userId] || {}).favourites || []
      g.rows = g.rows.map((r) => ({ ...r, favourite: favs.includes(r.channel) }))
      return ok(g)
    }
    if (method === 'POST' && sub === 'watch') return watch(body, user)
    if (method === 'POST' && sub === 'stop') return stopWatch(body, user)
    if (method === 'GET' && sub === 'advanced') return ok({ m3uEnabled: false, available: false, notice: M3U_NOTICE })

    // ---- recording
    if (sub === 'dvr' && method === 'GET') return ok({ ...dvr.list(), canRecord: canRecord(user), isAdmin: admin, recordingsDir: admin ? settings().recordingsDir : undefined })
    if (sub.startsWith('dvr/') && method === 'POST') {
      if (!canRecord(user)) {
        if (!settings().dvrEnabled || !settings().recordingsDir) return bad('Recording is not set up. The owner can turn it on in Settings > Live TV.', 'dvr_off', 409)
        return { status: 403, body: { ok: false, error: 'admin_only', message: 'Only the person who runs Beebo can record. They can allow everyone in Settings > Live TV.' } }
      }
      const actor = { id: userId }
      const own = (id) => { const i = dvr.itemById(id); return admin || !i || i.userId === userId }
      if (sub === 'dvr/schedule') return wrap(dvr.schedule(body, actor, { force: admin && body.force === true }))
      if (sub === 'dvr/cancel') return own(String(body.id)) ? wrap(dvr.cancel(String(body.id))) : bad('That is not your recording.', 'not_yours', 403)
      if (sub === 'dvr/delete') return own(String(body.id)) ? wrap(dvr.deleteRecording(String(body.id))) : bad('That is not your recording.', 'not_yours', 403)
      if (sub === 'dvr/rule') return wrap(dvr.addRule(body, actor))
      if (sub === 'dvr/rule/remove') return wrap(dvr.removeRule(String(body.id), { cancelUpcoming: body.cancelUpcoming !== false }))
      if (sub === 'dvr/rule/set') return wrap(dvr.setRule(String(body.id), body))
    }

    // ---- setting up (owner)
    if (sub.startsWith('admin/')) {
      const no = needAdmin()
      if (no) return no
      if (method === 'POST' || method === 'GET') {
        if (sub === 'admin/discover' && method === 'POST') return discover()
        if (sub === 'admin/device' && method === 'POST') return addDevice(body)
        if (sub === 'admin/device/remove' && method === 'POST') return removeDevice(String(body.id || ''))
        if (sub === 'admin/lineup/refresh' && method === 'POST') return refreshLineup(String(body.id || ''))
        if (sub === 'admin/scan' && method === 'POST') {
          const d = cfg().devices.find((x) => x.id === String(body.id || ''))
          if (!d) return bad('That tuner is not set up.', 'not_found', 404)
          if (pool.status().some((p) => p.deviceId === d.id && p.feeds.length)) return bad('Stop watching and recording first: a channel scan needs every tuner.', 'tuners_busy', 409)
          try { return ok(await hdhr.startChannelScan(d.ip, d.apiPort, body.source)) } catch { return bad('The tuner would not start a scan.', 'scan_failed', 502) }
        }
        if (sub === 'admin/scan/status' && method === 'GET') {
          const d = cfg().devices.find((x) => x.id === String(q.get('id') || ''))
          if (!d) return bad('That tuner is not set up.', 'not_found', 404)
          try { return ok({ status: await hdhr.fetchLineupStatus(d.ip, d.apiPort) }) } catch { return bad('The tuner did not answer.', 'no_answer', 502) }
        }
        if (sub === 'admin/channel' && method === 'POST') return setChannel(body)
        if (sub === 'admin/settings' && method === 'POST') return patchSettings(body)
        if (sub === 'admin/guide/source' && method === 'POST') return setGuideSource(body)
        if (sub === 'admin/guide/refresh' && method === 'POST') { const s = await guide.refresh(); return s.lastError ? { status: 200, body: { ok: false, error: 'guide_failed', message: s.lastError } } : ok({ guide: guide.status() }) }
        if (sub === 'admin/guide/map' && method === 'POST') {
          if (!channelByKey(String(body.channel || ''))) return bad('Unknown channel.', 'unknown_channel', 404)
          updateCfg((c) => { if (body.xmltvId) c.guide.map[String(body.channel)] = String(body.xmltvId).slice(0, 200); else delete c.guide.map[String(body.channel)] })
          return ok()
        }
        if (sub === 'admin/guide/channels' && method === 'GET') return ok({ xmltv: guide.xmltvChannels().slice(0, 2000), unmatched: guide.unmatched() })
        if (sub === 'admin/recordings/add-to-library' && method === 'POST') {
          const root = settings().recordingsDir
          if (!root) return bad('Choose a Recordings folder first.', 'no_folder', 409)
          if (typeof addToLibrary !== 'function') return bad('This server cannot add folders to the library from here.', 'unsupported', 501)
          return ok({ added: !!addToLibrary(root), dir: root })
        }
        if (sub === 'admin/advanced/m3u' && method === 'POST') return { status: 501, body: { ok: false, error: 'not_implemented', message: M3U_NOTICE } }
      }
    }
    return { status: 404, body: { ok: false, error: 'not_found' } }
  }

  const wrap = (r) => (r && r.ok ? { status: 200, body: r } : { status: (r && r.status) || 400, body: { ok: false, error: r && r.error || 'failed', message: r && r.message, ...(r && r.blockedBy ? { blockedBy: r.blockedBy } : {}) } })

  // --------------------------------------------------------- transports
  const claimsApi = (p) => p === '/api/livetv' || p.startsWith('/api/livetv/')
  const claimsWeb = (p) => p === '/livetv' || p === '/livetv/watch' || p.startsWith('/livetv-api/')
  const claimsPublic = (p) => p.startsWith('/livetv/hls/')

  async function readBody(req, limit = 64 * 1024) {
    const chunks = []
    let size = 0
    for await (const c of req) { size += c.length; if (size > limit) return null; chunks.push(c) }
    try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {} } catch { return null }
  }

  function sendJson(req, res, r) {
    const s = JSON.stringify(r.body)
    res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(s) })
    res.end((req.method || 'GET') === 'HEAD' ? undefined : s)
  }

  /** JSON over HTTP; `sub` is the path after the prefix. `cookieAuth` requests must be same-site to change anything. */
  async function serveJson(req, res, url, sub, user, { cookieAuth }) {
    const method = req.method || 'GET'
    if (method !== 'GET' && method !== 'HEAD' && cookieAuth && crossSite(req.headers)) { req.resume(); sendJson(req, res, { status: 403, body: { ok: false, error: 'cross_site' } }); return }
    let body = {}
    if (method === 'POST') {
      if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) { req.resume(); sendJson(req, res, { status: 415, body: { ok: false, error: 'json_only' } }); return }
      body = await readBody(req)
      if (body === null) { sendJson(req, res, { status: 400, body: { ok: false, error: 'bad_request' } }); return }
    } else if (method !== 'GET' && method !== 'HEAD') { sendJson(req, res, { status: 405, body: { ok: false, error: 'method_not_allowed' } }); return }
    sendJson(req, res, await handle(method === 'HEAD' ? 'GET' : method, sub, url.searchParams, body, user))
  }

  const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Range, Content-Type', 'Access-Control-Expose-Headers': 'Content-Length' }
  const HLS_RE = /^\/livetv\/hls\/([A-Za-z0-9_.-]{10,1024})\/(index\.m3u8|seg-(\d{1,9})\.ts)$/

  /** The playlist and pieces a player fetches; the signed ticket in the path is the credential (no login: Cast and apps cannot send cookies). */
  async function handlePublic(req, res, url) {
    const method = req.method || 'GET'
    if (method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return true }
    const fail = (status, text, extra = {}) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...CORS, ...extra }); res.end(text); return true }
    if (method !== 'GET' && method !== 'HEAD') return fail(405, 'Method not allowed')
    const m = HLS_RE.exec(url.pathname)
    const t = m ? liveHls.readLiveTicket(verify, m[1]) : null
    if (!t) return fail(403, 'Forbidden')
    if (!cfg().enabled) return fail(409, 'Live TV is turned off.')
    const viewerId = t.nonce || t.userId
    const key = live.keyOf(t.channel, t.quality)
    let session = live.get(key)
    if (m[2] === 'index.m3u8') {
      if (!session || session.state === 'ended') {
        const ch = channelByKey(t.channel)
        if (!ch) return fail(404, 'Not found')
        try { session = await live.open({ channel: ch, quality: t.quality, userId: t.userId, nonce: viewerId }) } catch (e) {
          return e instanceof TunerBusyError ? fail(503, e.message, { 'Retry-After': '10' }) : fail(502, (e && e.message) || 'Live TV could not start', { 'Retry-After': '10' })
        }
      }
      if (!(await live.ready(session))) return fail(503, session.endMessage || 'The channel is not sending a picture yet.', { 'Retry-After': '3' })
      let text = live.playlist(session, viewerId)
      const ended = session.state === 'ended'
      let out = Buffer.from(text, 'utf8')
      const headers = { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store', 'X-Beebo-Live': ended ? '0' : '1', ...CORS }
      if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || '')) && out.length > 1024) { out = zlib.gzipSync(out); headers['Content-Encoding'] = 'gzip'; headers.Vary = 'Accept-Encoding' }
      headers['Content-Length'] = out.length
      res.writeHead(200, headers)
      res.end(method === 'HEAD' ? undefined : out)
      return true
    }
    if (!session) return fail(404, 'Not found')
    const file = live.segmentFile(session, Number(m[3]), viewerId)
    if (!file) return fail(404, 'That part of the buffer is no longer available.')
    let st
    try { st = fs.statSync(file) } catch { return fail(404, 'Not found') }
    res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': st.size, 'Cache-Control': 'private, max-age=600', ...CORS })
    if (method === 'HEAD') { res.end(); return true }
    const rs = fs.createReadStream(file)
    rs.on('error', () => res.destroy())
    res.on('close', () => rs.destroy())
    rs.pipe(res)
    return true
  }

  async function handleApi(req, res, url, user) {
    await serveJson(req, res, url, url.pathname.replace(/^\/api\/livetv\/?/, ''), user, { cookieAuth: false })
    return true
  }

  /** Browser pages and the cookie-signed JSON they use. Caller has already checked the login. */
  async function handleWeb(req, res, url, { user, renderPage, nav }) {
    const p = url.pathname
    if (p.startsWith('/livetv-api/')) {
      await serveJson(req, res, url, p.slice('/livetv-api/'.length), user, { cookieAuth: true })
      return true
    }
    if (!user || user.guest || isRestricted(user)) {
      const r = user && user.guest ? GUEST : RESTRICTED
      res.writeHead(r.status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(renderPage(`<div class="topbar"><h2 style="margin:0;">Beebo Entertainment</h2><a href="/logout" class="muted" style="color:#8a8f98;">Log out</a></div>${nav}<p class="empty">${webUi.esc(r.body.message)}</p>`))
      return true
    }
    if (p === '/livetv/watch') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(webUi.watchPage({ channel: url.searchParams.get('channel') || '', quality: url.searchParams.get('q') || '' }))
      return true
    }
    if (p === '/livetv') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(renderPage(webUi.guidePage({ nav, isAdmin: !!user.isAdmin })))
      return true
    }
    return false
  }

  return {
    handle, handleApi, handleWeb, handlePublic, claimsApi, claimsWeb, claimsPublic,
    /** For the desktop app (main.js 'livetv:call') and tests: the owner, no HTTP. */
    call: (method, sub, query, body, user) => handle(String(method || 'GET').toUpperCase(), String(sub || '').replace(/^\/+/, ''), query, body, user),
    start, stop, guide, dvr, pool, live, config, prefs,
    navVisible, onNavChange: (fn) => { navListener = typeof fn === 'function' ? fn : null },
    busy: () => live.size() > 0 || dvr.isRecording(),
    dataDir: dir
  }
}

module.exports = { createLiveTv, M3U_NOTICE, RESTRICTED }
