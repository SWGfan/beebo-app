'use strict'
// ============================================================================
// dvr.js - recording live TV.
// ----------------------------------------------------------------------------
//   * Nothing is ever recorded unless a person asked: a one-off recording of a programme or a time
//     range, or a "series rule" (record programmes with this title). Both are explicit requests.
//   * A recording takes the tuner through tunerPool (so it shares the tuner with someone already
//     watching the same channel) from `padBefore` before the start to `padAfter` after the end,
//     and writes the stream as it arrives: to .mkv through ffmpeg `-c copy`, or the raw .ts.
//   * Two recordings that need more tuners than a device has are a CONFLICT. It is detected when
//     the recording is scheduled (with a plain message naming what is in the way), not discovered
//     at air time.
//   * Schedules and rules live in dvr.json (safeJson), so they survive a restart; a recording cut
//     short by a restart resumes into a new file if the programme is still on.
//   * Files go under the owner's Recordings folder as Show/Season/Show - SxxEyy.ext so the normal
//     library scan can pick the folder up as a TV Shows source. Keep-N rules delete the oldest
//     recordings of a series - and only ever files inside that folder.
// ============================================================================

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')
const { createStateFile } = require('./stateFile')

const MIN_MS = 60 * 1000
const HOUR = 3600 * 1000
const DAY = 24 * HOUR
const MAX_RULES = 100
const MAX_ITEMS = 1000
const MAX_RECORDED = 5000
const MIN_FREE_BYTES = 300 * 1024 * 1024
const MIN_USEFUL_BYTES = 256 * 1024

const str = (v, max) => String(v == null ? '' : v).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max)
const intIn = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d }
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
const newId = (p) => p + crypto.randomBytes(6).toString('hex')

const STATUSES = ['scheduled', 'recording', 'done', 'failed', 'missed']

function normalizeItem(i) {
  if (!i || typeof i !== 'object') return null
  const start = Number(i.start)
  const end = Number(i.end)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !/^[0-9A-Za-z._@-]{1,40}$/.test(String(i.channel || ''))) return null
  return {
    id: /^[a-z]{1,4}[0-9a-f]{12}$/.test(String(i.id)) ? i.id : newId('r'),
    kind: i.kind === 'rule' ? 'rule' : 'once', ruleId: i.ruleId ? str(i.ruleId, 20) : null,
    channel: String(i.channel), channelName: str(i.channelName, 60), title: str(i.title, 200) || 'Recording',
    subTitle: str(i.subTitle, 200), season: Number.isInteger(i.season) ? i.season : null, episode: Number.isInteger(i.episode) ? i.episode : null,
    start, end, padBeforeSec: intIn(i.padBeforeSec, 0, 1800, 60), padAfterSec: intIn(i.padAfterSec, 0, 3600, 120),
    container: i.container === 'ts' ? 'ts' : 'mkv', userId: str(i.userId, 128), createdAt: Number(i.createdAt) || 0,
    status: STATUSES.includes(i.status) ? i.status : 'scheduled', file: str(i.file, 600), size: Number(i.size) || 0,
    startedAt: Number(i.startedAt) || 0, endedAt: Number(i.endedAt) || 0, error: str(i.error, 200), part: intIn(i.part, 1, 20, 1),
    identity: str(i.identity, 300)
  }
}

function normalizeRule(r) {
  if (!r || typeof r !== 'object') return null
  const title = str(r.title, 200)
  if (!title) return null
  return {
    id: /^[a-z]{1,4}[0-9a-f]{12}$/.test(String(r.id)) ? r.id : newId('s'), title, match: r.match === 'contains' ? 'contains' : 'exact',
    channel: r.channel ? str(r.channel, 40) : null, onlyNew: r.onlyNew !== false, keepN: r.keepN == null || r.keepN === '' ? null : intIn(r.keepN, 1, 200, null),
    padBeforeSec: intIn(r.padBeforeSec, 0, 1800, 60), padAfterSec: intIn(r.padAfterSec, 0, 3600, 120), container: r.container === 'ts' ? 'ts' : 'mkv',
    enabled: r.enabled !== false, userId: str(r.userId, 128), createdAt: Number(r.createdAt) || 0, lastSkipped: intIn(r.lastSkipped, 0, 100000, 0)
  }
}

function normalizeState(raw) {
  const s = raw && typeof raw === 'object' ? raw : {}
  return {
    v: 1,
    rules: (Array.isArray(s.rules) ? s.rules : []).map(normalizeRule).filter(Boolean).slice(0, MAX_RULES),
    items: (Array.isArray(s.items) ? s.items : []).map(normalizeItem).filter(Boolean).slice(0, MAX_ITEMS),
    recorded: (Array.isArray(s.recorded) ? s.recorded : []).filter((x) => typeof x === 'string').slice(-MAX_RECORDED)
  }
}

function defaultFreeBytes(p) {
  try { const s = fs.statfsSync(p); return Number(s.bavail) * Number(s.bsize) } catch { return Infinity }
}

const windowOf = (i) => ({ from: i.start - i.padBeforeSec * 1000, to: i.end + i.padAfterSec * 1000 })

// ------------------------------------------------------- tuner planning (pure)
/**
 * Decides which tuner each recording would use and which cannot be served.
 *   items      [{ id, channel, from, to, priority }]   lower priority number wins a tuner
 *   devicesOf  (channelKey) => [{ id, tunerCount }]    tuners that can receive that channel
 * Recordings of the same channel that overlap share one tuner. Greedy by priority, then who asked first (`created`), then start: exact for
 * one device, and a good answer for a household with two.
 * -> { assignments: { itemId: deviceId }, conflicts: [{ id, blockedBy: [itemId...] }] }
 */
function planTuners(items, devicesOf) {
  const placed = []
  const assignments = {}
  const conflicts = []
  const seq = new Map(items.map((it, n) => [it.id, n]))
  const order = [...items].sort((a, b) => a.priority - b.priority || (a.created || 0) - (b.created || 0) || a.from - b.from || seq.get(a.id) - seq.get(b.id))
  for (const it of order) {
    const devs = devicesOf(it.channel) || []
    let chosen = null
    const blockers = new Set()
    const ranked = devs.map((d) => {
      const overlapping = placed.filter((p) => p.device === d.id && p.from < it.to && p.to > it.from)
      return { d, overlapping }
    }).sort((a, b) => a.overlapping.length - b.overlapping.length)
    for (const { d, overlapping } of ranked) {
      const points = new Set([it.from])
      for (const p of overlapping) { if (p.from > it.from && p.from < it.to) points.add(p.from) }
      let ok = true
      for (const t of points) {
        const channels = new Set(overlapping.filter((p) => p.from <= t && p.to > t).map((p) => p.channel))
        channels.add(it.channel)
        if (channels.size > d.tunerCount) { ok = false; break }
      }
      if (ok) { chosen = d; break }
      for (const p of overlapping) blockers.add(p.id)
    }
    if (chosen) {
      placed.push({ id: it.id, channel: it.channel, from: it.from, to: it.to, device: chosen.id })
      assignments[it.id] = chosen.id
    } else {
      conflicts.push({ id: it.id, blockedBy: [...blockers] })
    }
  }
  return { assignments, conflicts }
}

// ------------------------------------------------------------- file naming
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
function safeName(text, fallback = 'Recording') {
  let s = String(text || '').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').replace(/[. ]+$/g, '').trim().slice(0, 90)
  s = s.replace(/^[. ]+/, '')
  if (!s || RESERVED.test(s)) s = fallback
  return s
}
const pad2 = (n) => String(n).padStart(2, '0')

/** Show/Season N/Show - SxxEyy[ - Title].ext (no episode numbers in the guide: season = two-digit year, episode = day of year, so the library can group them). */
function recordingRelPath(item, ext) {
  const show = safeName(item.title)
  const d = new Date(item.start)
  let season = item.season
  let episode = item.episode
  let tail = safeName(item.subTitle, '')
  if (!(season > 0 && season < 100) || !(episode > 0 && episode < 1000)) {
    const yy = d.getFullYear() % 100
    const doy = Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 0)) / DAY)
    season = yy || 1
    episode = doy
    if (!tail) tail = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}${pad2(d.getMinutes())}`
  }
  const partTag = item.part > 1 ? ` (part ${item.part})` : ''
  const file = `${show} - S${pad2(season)}E${String(episode).padStart(2, '0')}${tail ? ' - ' + tail : ''}${partTag}.${ext}`
  return path.join(show, `Season ${season}`, file)
}

const inside = (root, file) => {
  const r = path.resolve(root)
  const f = path.resolve(file)
  return f !== r && f.startsWith(r + path.sep)
}

function identityOf(title, p) {
  const t = norm(title)
  if (p && p.season != null && p.episode != null) return `${t}|s${p.season}e${p.episode}`
  if (p && p.subTitle) return `${t}|${norm(p.subTitle)}`
  return `${t}|@${p ? p.start : 0}`
}

function titleMatches(rule, title) {
  const a = norm(rule.title)
  const b = norm(title)
  if (!a || !b) return false
  return rule.match === 'contains' ? (a.length >= 3 && b.includes(a)) : a === b
}

function createDvr({
  dir, getConfig, getChannels, guide, pool, ffmpegPath, now = Date.now, log = () => {}, libraryIdFor = () => '',
  spawnFn = spawn, freeBytes = defaultFreeBytes, tickMs = 10000, timers = { setInterval, clearInterval }, onChange = () => {}
}) {
  const state = createStateFile(path.join(dir, 'dvr.json'), { v: 1, rules: [], items: [], recorded: [] }, normalizeState)
  const active = new Map()
  const starting = new Set()
  let tickTimer = null
  let lastRuleRun = 0

  const settings = () => getConfig().settings
  const recordingsRoot = () => settings().recordingsDir
  const channelByKey = (k) => getChannels().find((c) => c.key === k) || null
  const deviceMap = () => new Map(getConfig().devices.map((d) => [d.id, d]))
  const devicesOf = (channelKey) => {
    const ch = channelByKey(channelKey)
    const dm = deviceMap()
    return ch ? ch.devices.map((id) => dm.get(id)).filter(Boolean).map((d) => ({ id: d.id, tunerCount: d.tunerCount })) : []
  }
  const resolveFfmpeg = () => (typeof ffmpegPath === 'function' ? ffmpegPath() : ffmpegPath)

  const live = (i) => i.status === 'scheduled' || i.status === 'recording'
  const planInput = (items) => items.filter(live).map((i) => ({ id: i.id, channel: i.channel, ...windowOf(i), priority: i.status === 'recording' ? 0 : i.kind === 'once' ? 1 : 2, created: i.createdAt }))

  function conflictsFor(items) {
    const plan = planTuners(planInput(items), devicesOf)
    const byId = new Map(items.map((i) => [i.id, i]))
    return plan.conflicts.map((c) => ({
      id: c.id,
      blockedBy: c.blockedBy.map((id) => byId.get(id)).filter(Boolean).map((i) => ({ id: i.id, title: i.title, channelName: i.channelName, start: i.start, end: i.end }))
    }))
  }

  function friendlyConflict(c, item) {
    const who = c.blockedBy.length ? c.blockedBy.map((b) => `"${b.title}"`).join(', ') : 'other recordings'
    return `There are not enough tuners free to record "${item.title}" then: ${who} already use${c.blockedBy.length === 1 ? 's' : ''} them at that time. Cancel one of them, or pick another airing.`
  }

  // ------------------------------------------------------------ validation
  function validate(input, user) {
    const cfg = getConfig()
    if (!cfg.settings.dvrEnabled) return { ok: false, status: 409, error: 'dvr_off', message: 'Recording is turned off. The owner can turn it on in Settings > Live TV.' }
    if (!cfg.settings.recordingsDir) return { ok: false, status: 409, error: 'no_folder', message: 'Choose a Recordings folder first (Settings > Live TV).' }
    const ch = channelByKey(String(input && input.channel))
    if (!ch) return { ok: false, status: 404, error: 'unknown_channel', message: 'That channel is not in your lineup.' }
    const t = now()
    let start = Number(input.start)
    const end = Number(input.end)
    if (!Number.isFinite(start) || !Number.isFinite(end)) return { ok: false, status: 400, error: 'bad_time', message: 'Give a start and end time.' }
    if (end <= t) return { ok: false, status: 400, error: 'in_past', message: 'That programme has already finished.' }
    if (start < t) start = t
    if (end - start < MIN_MS || end - start > 12 * HOUR) return { ok: false, status: 400, error: 'bad_length', message: 'A recording must be between 1 minute and 12 hours long.' }
    if (start > t + 30 * DAY) return { ok: false, status: 400, error: 'too_far', message: 'That is too far ahead to schedule.' }
    const title = str(input.title, 200)
    if (!title) return { ok: false, status: 400, error: 'no_title', message: 'Give the recording a title.' }
    return {
      ok: true,
      item: normalizeItem({
        kind: 'once', channel: ch.key, channelName: ch.name, title, subTitle: input.subTitle, season: input.season, episode: input.episode,
        start, end, padBeforeSec: input.padBeforeSec == null ? cfg.settings.padBeforeSec : input.padBeforeSec,
        padAfterSec: input.padAfterSec == null ? cfg.settings.padAfterSec : input.padAfterSec,
        container: input.container || cfg.settings.container, userId: user && user.id, createdAt: t, status: 'scheduled',
        identity: identityOf(title, { season: input.season, episode: input.episode, subTitle: input.subTitle, start })
      })
    }
  }

  function schedule(input, user, { force = false } = {}) {
    const v = validate(input, user)
    if (!v.ok) return v
    const items = state.get().items
    if (items.some((i) => live(i) && i.channel === v.item.channel && i.start === v.item.start && norm(i.title) === norm(v.item.title))) {
      return { ok: false, status: 409, error: 'already_scheduled', message: 'That is already scheduled.' }
    }
    const trial = [...items, v.item]
    const c = conflictsFor(trial).find((x) => x.id === v.item.id)
    if (c && !force) return { ok: false, status: 409, error: 'conflict', message: friendlyConflict(c, v.item), blockedBy: c.blockedBy }
    state.update((s) => { s.items.push(v.item) })
    log(`DVR: scheduled "${v.item.title}"${c ? ' (over capacity)' : ''}`)
    kick()
    onChange()
    return { ok: true, item: publicItem(v.item), conflict: !!c }
  }

  function cancel(id) {
    const s = state.get()
    const i = s.items.find((x) => x.id === id)
    if (!i) return { ok: false, status: 404, error: 'not_found' }
    if (i.status === 'recording') { stopRecording(i.id, 'done'); return { ok: true, stopped: true } }
    if (!live(i)) return { ok: false, status: 409, error: 'not_active', message: 'That recording is not scheduled any more.' }
    state.update((st) => { st.items = st.items.filter((x) => x.id !== id) })
    onChange()
    return { ok: true }
  }

  function removeFile(item) {
    const root = recordingsRoot()
    if (!item.file || !root || !inside(root, item.file)) return false
    try { fs.unlinkSync(item.file) } catch (e) { if (!e || e.code !== 'ENOENT') return false }
    let d = path.dirname(item.file)
    for (let n = 0; n < 3 && inside(root, d); n++) { try { fs.rmdirSync(d) } catch { break }; d = path.dirname(d) }
    return true
  }

  /** Deletes a finished recording (the file and its entry). The programme stays "recorded" so a rule does not fetch it again. */
  function deleteRecording(id) {
    const i = state.get().items.find((x) => x.id === id)
    if (!i) return { ok: false, status: 404, error: 'not_found' }
    if (i.status === 'recording' || i.status === 'scheduled') return { ok: false, status: 409, error: 'active', message: 'Cancel it first.' }
    if (!removeFile(i) && i.file && fs.existsSync(i.file)) return { ok: false, status: 500, error: 'delete_failed', message: 'The file could not be deleted.' }
    state.update((s) => { s.items = s.items.filter((x) => x.id !== id) })
    onChange()
    return { ok: true }
  }

  // ----------------------------------------------------------------- rules
  function addRule(input, user) {
    if (!getConfig().settings.dvrEnabled) return { ok: false, status: 409, error: 'dvr_off', message: 'Recording is turned off. The owner can turn it on in Settings > Live TV.' }
    if (!getConfig().settings.recordingsDir) return { ok: false, status: 409, error: 'no_folder', message: 'Choose a Recordings folder first (Settings > Live TV).' }
    const cfg = getConfig().settings
    const rule = normalizeRule({
      ...input, id: undefined, createdAt: now(), userId: user && user.id, lastSkipped: 0,
      padBeforeSec: input && input.padBeforeSec != null ? input.padBeforeSec : cfg.padBeforeSec,
      padAfterSec: input && input.padAfterSec != null ? input.padAfterSec : cfg.padAfterSec,
      container: input && input.container ? input.container : cfg.container
    })
    if (!rule) return { ok: false, status: 400, error: 'no_title', message: 'Give the series a title to look for.' }
    if (rule.channel && !channelByKey(rule.channel)) return { ok: false, status: 404, error: 'unknown_channel', message: 'That channel is not in your lineup.' }
    if (state.get().rules.length >= MAX_RULES) return { ok: false, status: 409, error: 'too_many', message: 'That is the most series rules allowed.' }
    if (state.get().rules.some((r) => norm(r.title) === norm(rule.title) && r.channel === rule.channel)) return { ok: false, status: 409, error: 'duplicate', message: 'You already record that series.' }
    state.update((s) => { s.rules.push(rule) })
    const applied = applyRules()
    onChange()
    return { ok: true, rule, scheduled: applied.added }
  }

  function removeRule(id, { cancelUpcoming = true } = {}) {
    const s = state.get()
    if (!s.rules.some((r) => r.id === id)) return { ok: false, status: 404, error: 'not_found' }
    state.update((st) => {
      st.rules = st.rules.filter((r) => r.id !== id)
      if (cancelUpcoming) st.items = st.items.filter((i) => !(i.ruleId === id && i.status === 'scheduled'))
      else for (const i of st.items) if (i.ruleId === id) i.ruleId = null
    })
    onChange()
    return { ok: true }
  }

  function setRule(id, patch) {
    const r = state.get().rules.find((x) => x.id === id)
    if (!r) return { ok: false, status: 404, error: 'not_found' }
    state.update(() => {
      if (patch && typeof patch.enabled === 'boolean') r.enabled = patch.enabled
      if (patch && 'keepN' in patch) r.keepN = patch.keepN == null || patch.keepN === '' ? null : intIn(patch.keepN, 1, 200, null)
      if (patch && typeof patch.onlyNew === 'boolean') r.onlyNew = patch.onlyNew
    })
    cleanup()
    applyRules()
    onChange()
    return { ok: true, rule: r }
  }

  /** Looks ahead in the guide and schedules the airings each enabled rule asks for. Skips airings that would not fit the tuners. */
  function applyRules() {
    const cfg = getConfig().settings
    const out = { added: 0, skipped: 0 }
    lastRuleRun = now()
    if (!cfg.dvrEnabled || !cfg.recordingsDir) return out
    const rules = state.get().rules.filter((r) => r.enabled)
    if (!rules.length) return out
    const t = now()
    const upcoming = guide.upcoming(t, t + cfg.lookaheadDays * DAY).sort((a, b) => a.start - b.start)
    const recorded = new Set(state.get().recorded)
    const added = []
    for (const rule of rules) {
      const matches = upcoming.filter((p) => p.stop > t && titleMatches(rule, p.title) && (!rule.channel || rule.channel === p.channel))
      const flagged = matches.some((p) => p.isNew)
      let skipped = 0
      for (const p of matches) {
        if (rule.onlyNew && flagged && !p.isNew) continue
        const identity = identityOf(rule.title, p)
        const known = recorded.has(identity) || [...state.get().items, ...added].some((i) => i.identity === identity && (live(i) || i.status === 'done'))
        if (known) continue
        const item = normalizeItem({
          kind: 'rule', ruleId: rule.id, channel: p.channel, channelName: (channelByKey(p.channel) || {}).name, title: p.title, subTitle: p.subTitle,
          season: p.season, episode: p.episode, start: p.start, end: p.stop, padBeforeSec: rule.padBeforeSec, padAfterSec: rule.padAfterSec,
          container: rule.container, userId: rule.userId, createdAt: t, status: 'scheduled', identity
        })
        if (!item) continue
        const trial = [...state.get().items, ...added, item]
        if (conflictsFor(trial).some((c) => c.id === item.id)) { skipped++; continue }
        added.push(item)
      }
      if (skipped !== rule.lastSkipped) state.update(() => { rule.lastSkipped = skipped })
      out.skipped += skipped
    }
    if (added.length) {
      state.update((s) => { s.items.push(...added) })
      out.added = added.length
      log(`DVR: series rules scheduled ${added.length} recording(s)`)
      kick()
    }
    return out
  }

  /** Keep-N: for each rule with keepN, delete the oldest finished recordings beyond N (files inside the Recordings folder only). */
  function cleanup() {
    const s = state.get()
    let removed = 0
    for (const rule of s.rules) {
      if (!rule.keepN) continue
      const done = s.items.filter((i) => i.ruleId === rule.id && i.status === 'done').sort((a, b) => b.start - a.start)
      for (const i of done.slice(rule.keepN)) {
        if (removeFile(i) || !i.file || !fs.existsSync(i.file)) {
          state.update((st) => { st.items = st.items.filter((x) => x.id !== i.id) })
          removed++
        }
      }
    }
    if (removed) { log(`DVR: keep-latest removed ${removed} old recording(s)`); onChange() }
    return removed
  }

  // ------------------------------------------------------------ recording
  function fileFor(item) {
    const ext = item.container === 'ts' || !resolveFfmpeg() ? 'ts' : 'mkv'
    let rel = recordingRelPath(item, ext)
    let abs = path.join(recordingsRoot(), rel)
    for (let n = 2; fs.existsSync(abs) && n < 50; n++) abs = path.join(recordingsRoot(), rel.replace(/(\.[a-z0-9]+)$/i, ` (${n})$1`))
    return { abs, ext }
  }

  async function startRecording(item) {
    const channel = channelByKey(item.channel)
    const cfg = settings()
    if (!channel || !cfg.dvrEnabled || !cfg.recordingsDir) { markFailed(item.id, 'Recording is not set up any more.'); return }
    const { abs, ext } = fileFor(item)
    try { fs.mkdirSync(path.dirname(abs), { recursive: true }) } catch { markFailed(item.id, 'The Recordings folder cannot be written to.'); return }
    if (freeBytes(path.dirname(abs)) < MIN_FREE_BYTES) { markFailed(item.id, 'Not enough free disk space to record.'); return }
    let lease
    try {
      lease = await pool.acquire({ channel, purpose: 'record', label: item.title, onEnd: (err) => { const r = active.get(item.id); if (r && !r.stopping) stopRecording(item.id, 'done', err && err.code !== 'shutdown' ? err.message : '') } })
    } catch (e) {
      const w = windowOf(item)
      state.update(() => { item.error = String(e && e.message || 'No tuner').slice(0, 200) })
      if (now() >= w.to - 30000) markFailed(item.id, item.error)
      return
    }
    const rec = { id: item.id, lease, unsub: null, out: null, proc: null, bytes: 0, file: abs, ext, stopping: false, done: null }
    let sink
    if (ext === 'ts') {
      const out = fs.createWriteStream(abs)
      out.on('error', () => stopRecording(item.id, 'done', 'The disk could not be written to.'))
      rec.out = out
      sink = { write: (b) => { rec.bytes += b.length; return out.write(b) }, buffered: () => out.writableLength }
    } else {
      const args = ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-fflags', '+genpts', '-f', 'mpegts', '-i', 'pipe:0', '-map', '0:v?', '-map', '0:a?', '-map', '0:s?', '-c', 'copy', '-f', 'matroska', abs]
      let child
      try { child = spawnFn(resolveFfmpeg(), args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true }) } catch (e) { lease.release(); markFailed(item.id, 'The converter could not be started.'); return }
      child.stdin.on('error', () => {})
      child.on('error', () => stopRecording(item.id, 'done', 'The converter stopped.'))
      child.on('exit', () => { if (!rec.stopping) stopRecording(item.id, 'done', 'The converter stopped.') })
      rec.proc = child
      sink = { write: (b) => { rec.bytes += b.length; return child.stdin.writable ? child.stdin.write(b) : true }, buffered: () => child.stdin.writableLength }
    }
    rec.unsub = lease.subscribe({ ...sink, end: (err) => { if (!rec.stopping) stopRecording(item.id, 'done', err && err.code !== 'shutdown' ? err.message : '') } })
    active.set(item.id, rec)
    state.update(() => { item.status = 'recording'; item.file = abs; item.startedAt = now(); item.error = '' })
    log(`DVR: recording "${item.title}" to ${path.basename(abs)}`)
    onChange()
  }

  function markFailed(id, message) {
    const i = state.get().items.find((x) => x.id === id)
    if (!i) return
    state.update(() => { i.status = 'failed'; i.error = message; i.endedAt = now() })
    log(`DVR: "${i.title}" failed: ${message}`)
    onChange()
  }

  function stopRecording(id, finalStatus = 'done', note = '') {
    const rec = active.get(id)
    const item = state.get().items.find((x) => x.id === id)
    if (!rec || rec.stopping) return
    rec.stopping = true
    active.delete(id)
    try { rec.unsub() } catch { /* already unsubscribed */ }
    try { rec.lease.release() } catch { /* already released */ }
    const finish = () => {
      let size = 0
      try { size = fs.statSync(rec.file).size } catch { size = 0 }
      if (!item) return
      const useful = size >= MIN_USEFUL_BYTES
      state.update(() => {
        item.size = size
        item.endedAt = now()
        if (!useful) {
          item.status = 'failed'
          item.error = note || 'No picture was received (is the antenna connected, and is the channel strong enough?).'
          item.file = ''
        } else {
          item.status = finalStatus
          if (note && now() < windowOf(item).to - 60000) item.error = note
        }
      })
      if (!useful) { try { fs.unlinkSync(rec.file) } catch { /* nothing to remove */ } }
      else if (item.identity) state.update((s) => { if (!s.recorded.includes(item.identity)) s.recorded.push(item.identity); s.recorded = s.recorded.slice(-MAX_RECORDED) })
      log(`DVR: finished "${item.title}" (${Math.round(size / 1048576)} MB)`)
      cleanup()
      onChange()
    }
    if (rec.out) rec.out.end(finish)
    else if (rec.proc) {
      let done = false
      const once = () => { if (!done) { done = true; clearTimeout(kill); finish() } }
      const kill = setTimeout(() => { try { rec.proc.kill('SIGKILL') } catch { /* gone */ } once() }, 10000)
      if (kill.unref) kill.unref()
      rec.proc.on('exit', once)
      try { rec.proc.stdin.end() } catch { once() }
    } else finish()
  }

  function tick() {
    const t = now()
    for (const i of [...state.get().items]) {
      const w = windowOf(i)
      if (i.status === 'scheduled') {
        if (t >= w.to) markMissed(i)
        else if (t >= w.from && !active.has(i.id) && !starting.has(i.id)) { starting.add(i.id); startRecording(i).finally(() => starting.delete(i.id)) }
      } else if (i.status === 'recording') {
        if (!active.has(i.id)) recover(i, t)
        else if (t >= w.to) stopRecording(i.id, 'done')
        else if (freeBytes(path.dirname(active.get(i.id).file)) < MIN_FREE_BYTES) stopRecording(i.id, 'done', 'The disk is nearly full, so the recording was stopped.')
      }
    }
    if (t - lastRuleRun > 5 * MIN_MS) applyRules()
  }

  function markMissed(i) {
    state.update(() => { i.status = 'missed'; i.error = i.error || 'Beebo was not running when this was due to record.'; i.endedAt = now() })
    onChange()
  }

  /** A 'recording' entry with nothing behind it: the app was restarted (or the recording died). Resume into a new file while the show is on. */
  function recover(i, t) {
    const w = windowOf(i)
    let size = 0
    try { size = i.file ? fs.statSync(i.file).size : 0 } catch { size = 0 }
    state.update(() => {
      if (t < w.to - 30000) { i.status = 'scheduled'; i.part = (i.part || 1) + 1; i.error = ''; return }
      i.endedAt = t
      if (size >= MIN_USEFUL_BYTES) { i.status = 'done'; i.size = size; i.error = 'Recording was interrupted.' } else { i.status = 'failed'; i.error = 'Recording was interrupted.' }
    })
    onChange()
  }

  function kick() { setImmediate(() => { try { tick() } catch (e) { log('DVR tick failed') } }) }

  function start() {
    if (tickTimer) return
    // A recording that was running when the app stopped is picked up by tick() -> recover().
    tickTimer = timers.setInterval(() => { try { tick() } catch { log('DVR tick failed') } }, tickMs)
    if (tickTimer && tickTimer.unref) tickTimer.unref()
    kick()
  }

  function stop() {
    if (tickTimer) timers.clearInterval(tickTimer)
    tickTimer = null
    for (const id of [...active.keys()]) stopRecording(id, 'done', 'Beebo was closed.')
  }

  const publicItem = (i) => {
    const w = windowOf(i)
    return {
      id: i.id, kind: i.kind, ruleId: i.ruleId, channel: i.channel, channelName: i.channelName, title: i.title, subTitle: i.subTitle,
      season: i.season, episode: i.episode, start: i.start, end: i.end, recordFrom: w.from, recordTo: w.to, status: i.status,
      container: i.container, size: i.size, error: i.error, part: i.part,
      ...(i.status === 'done' && i.file ? { fileName: path.basename(i.file), libraryId: libraryIdFor(i.file) || '' } : {})
    }
  }

  function list() {
    const s = state.get()
    const conflicts = conflictsFor(s.items)
    const cm = new Map(conflicts.map((c) => [c.id, c]))
    return {
      enabled: getConfig().settings.dvrEnabled && !!getConfig().settings.recordingsDir,
      items: s.items.map((i) => ({ ...publicItem(i), conflict: cm.has(i.id) })).sort((a, b) => a.start - b.start),
      rules: s.rules.map((r) => ({ ...r })),
      conflicts: conflicts.map((c) => ({ id: c.id, message: friendlyConflict(c, s.items.find((i) => i.id === c.id) || { title: '' }) })),
      recording: [...active.keys()]
    }
  }

  return {
    schedule, cancel, deleteRecording, addRule, removeRule, setRule, applyRules, cleanup, tick, start, stop, list, conflictsFor,
    itemById: (id) => state.get().items.find((i) => i.id === id) || null,
    isRecording: () => active.size > 0,
    recordingChannelKeys: () => [...active.keys()].map((id) => (state.get().items.find((i) => i.id === id) || {}).channel).filter(Boolean),
    state
  }
}

module.exports = { createDvr, planTuners, recordingRelPath, safeName, identityOf, titleMatches, windowOf, normalizeState, MIN_USEFUL_BYTES }
