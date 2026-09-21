'use strict'
// ============================================================================
// tunerPool.js - who is using which tuner.
// ----------------------------------------------------------------------------
// An HDHomeRun has 2-6 tuners and each carries one channel at a time. Beebo opens ONE connection
// per channel (a "feed") and lets everyone who wants that channel share it:
//   * several viewers of one channel, and a recording of that same channel, cost one tuner;
//   * a new channel takes a free tuner; when none is free a recording may take over the tuner of a
//     feed that only has viewers on it (they are told), a viewer never takes over a recording, and
//     otherwise the caller gets a TunerBusyError with a plain-words reason;
//   * a feed is closed - and the tuner released - the moment its last holder lets go, or when the
//     tuner stops sending data.
// A tuner may also be in use by something outside Beebo (Plex, the SiliconDust app): the device
// then answers 503 and the pool reports "in use by another app".
// ============================================================================

const http = require('http')
const guard = require('./netGuard')
const hdhr = require('./hdhr')

const PRIORITY = { live: 1, record: 2 }
const MAX_BUFFERED_PER_CONSUMER = 48 * 1024 * 1024

class TunerBusyError extends Error {
  constructor(message, detail = {}) { super(message); this.code = 'tuners_busy'; this.detail = detail }
}
class TunerError extends Error {
  constructor(code, message) { super(message || code); this.code = code }
}

function defaultOpen({ device, channel, timeoutMs = 10000, requestImpl = http.request }) {
  return new Promise((resolve, reject) => {
    const check = guard.validateTunerTarget({ host: device.ip, port: device.streamPort }, { confirmNonLan: device.allowNonLan === true })
    if (!check.ok) { reject(new TunerError('bad_address', check.message)); return }
    let done = false
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); fn(v) } }
    const req = requestImpl({
      host: device.ip, port: device.streamPort, path: hdhr.streamPath(channel.guideNumber), method: 'GET', agent: false,
      headers: { 'User-Agent': 'Beebo-LiveTV', Connection: 'close' }
    }, (res) => {
      if (res.statusCode === 200) { finish(resolve, { res, req }); return }
      res.resume()
      req.destroy()
      finish(reject, res.statusCode === 503
        ? new TunerError('tuner_external_busy', 'The tuner says all of its channels are in use.')
        : new TunerError('tuner_refused', 'The tuner would not tune that channel (' + res.statusCode + ').'))
    })
    const timer = setTimeout(() => { req.destroy(); finish(reject, new TunerError('tuner_timeout', 'The tuner did not answer.')) }, timeoutMs)
    if (timer.unref) timer.unref()
    req.on('error', () => finish(reject, new TunerError('tuner_unreachable', 'The tuner could not be reached.')))
    req.end()
  })
}

function createTunerPool({ getDevices, open = defaultOpen, now = Date.now, log = () => {}, stallMs = 15000, firstDataMs = 15000, watchEveryMs = 3000 } = {}) {
  const feeds = new Map()
  let nextFeedId = 1
  let nextHolderId = 1
  let watch = null

  const devices = () => { try { return getDevices() || [] } catch { return [] } }
  const usedOn = (deviceId) => [...feeds.values()].filter((f) => f.deviceId === deviceId).length
  const feedPriority = (f) => Math.max(0, ...[...f.holders].map((h) => PRIORITY[h.purpose] || 1))

  function ensureWatch() {
    if (watch || !feeds.size) return
    watch = setInterval(() => {
      const t = now()
      for (const f of [...feeds.values()]) {
        if (f.state !== 'streaming') continue
        const limit = f.bytes === 0 ? firstDataMs : stallMs
        if (t - (f.lastData || f.startedAt) > limit) endFeed(f, new TunerError('no_signal', f.bytes === 0 ? 'The tuner sent no picture (no signal on this channel?).' : 'The tuner stopped sending video.'))
      }
      if (!feeds.size) { clearInterval(watch); watch = null }
    }, watchEveryMs)
    if (watch.unref) watch.unref()
  }

  function describe(candidateIds) {
    const bits = []
    for (const f of feeds.values()) {
      if (!candidateIds.includes(f.deviceId)) continue
      const what = [...f.holders].map((h) => h.label).filter(Boolean)
      const rec = [...f.holders].some((h) => h.purpose === 'record')
      bits.push((rec ? 'recording ' : 'watching ') + (what[0] || 'channel ' + f.guideNumber))
    }
    return bits
  }

  function endFeed(f, err) {
    if (f.state === 'ended') return
    const wasConnecting = f.state === 'connecting'
    f.state = 'ended'
    f.error = err || null
    feeds.delete(f.id)
    try { if (f.res) f.res.destroy() } catch { /* already gone */ }
    try { if (f.req) f.req.destroy() } catch { /* already gone */ }
    if (!wasConnecting) for (const c of [...f.consumers]) { f.consumers.delete(c); try { c.end(err || null) } catch { /* consumer's problem */ } }
    for (const h of [...f.holders]) { if (h.onEnd) { try { h.onEnd(err || null) } catch { /* holder's problem */ } } }
  }

  function makeLease(f, holder) {
    let released = false
    return {
      feedId: f.id, deviceId: f.deviceId, channelKey: f.channelKey, holderId: holder.id,
      /** Starts delivering bytes: consumer = { write(buf), end(err), buffered?() }. Returns an unsubscribe function. */
      subscribe(consumer) {
        if (f.state === 'ended') { setImmediate(() => { try { consumer.end(f.error || null) } catch { /* ignore */ } }); return () => {} }
        f.consumers.add(consumer)
        if (f.res && f.res.isPaused()) f.res.resume()
        return () => { f.consumers.delete(consumer) }
      },
      release() {
        if (released) return
        released = true
        f.holders.delete(holder)
        if (!f.holders.size) endFeed(f, null)
      },
      isLive: () => f.state !== 'ended'
    }
  }

  function startFeed(dev, channel) {
    const f = {
      id: nextFeedId++, deviceId: dev.id, channelKey: channel.key, guideNumber: channel.guideNumber,
      state: 'connecting', holders: new Set(), consumers: new Set(), req: null, res: null, bytes: 0, startedAt: now(), lastData: 0, error: null, ready: null
    }
    feeds.set(f.id, f)
    f.ready = open({ device: dev, channel }).then(({ res, req }) => {
      if (f.state === 'ended') { try { res.destroy(); req.destroy() } catch { /* ignore */ } throw new TunerError('cancelled', 'Cancelled.') }
      f.res = res
      f.req = req
      f.state = 'streaming'
      f.lastData = now()
      res.pause()
      res.on('data', (chunk) => {
        f.bytes += chunk.length
        f.lastData = now()
        for (const c of [...f.consumers]) {
          let ok = true
          try { ok = c.write(chunk) !== false } catch { ok = false }
          if (!ok && typeof c.buffered === 'function' && c.buffered() > MAX_BUFFERED_PER_CONSUMER) {
            f.consumers.delete(c)
            try { c.end(new TunerError('slow_consumer', 'Cannot keep up with the tuner.')) } catch { /* ignore */ }
          }
        }
      })
      res.on('end', () => endFeed(f, new TunerError('tuner_ended', 'The tuner stopped the stream.')))
      res.on('error', () => endFeed(f, new TunerError('tuner_lost', 'The connection to the tuner dropped.')))
      res.on('close', () => endFeed(f, new TunerError('tuner_lost', 'The connection to the tuner dropped.')))
      ensureWatch()
      return f
    }).catch((e) => { feeds.delete(f.id); f.state = 'ended'; throw e })
    f.ready.catch(() => {})
    return f
  }

  async function acquire({ channel, purpose = 'live', label = '', userId = '', onPreempt, onEnd } = {}) {
    if (!channel || !Array.isArray(channel.devices)) throw new TunerError('no_channel', 'Unknown channel.')
    const prio = PRIORITY[purpose] || 1
    const candidates = devices().filter((d) => channel.devices.includes(d.id))
    if (!candidates.length) throw new TunerError('no_device', 'No tuner is set up for that channel.')
    const holder = { id: nextHolderId++, purpose, label, userId, onPreempt, onEnd }

    const attach = async (f) => {
      f.holders.add(holder)
      try { await f.ready } catch (e) { f.holders.delete(holder); throw e }
      return makeLease(f, holder)
    }

    for (const f of feeds.values()) {
      if (f.channelKey === channel.key && f.state !== 'ended' && candidates.some((d) => d.id === f.deviceId)) return attach(f)
    }

    let sawExternal = false
    const tryOpen = async (dev) => {
      const f = startFeed(dev, channel)
      f.holders.add(holder)
      try { await f.ready } catch (e) { f.holders.delete(holder); throw e }
      return makeLease(f, holder)
    }
    const byLoad = [...candidates].sort((a, b) => usedOn(a.id) / a.tunerCount - usedOn(b.id) / b.tunerCount)
    for (const dev of byLoad) {
      if (usedOn(dev.id) >= dev.tunerCount) continue
      try { return await tryOpen(dev) } catch (e) {
        if (e && e.code === 'tuner_external_busy') { sawExternal = true; continue }
        throw e
      }
    }

    const victims = [...feeds.values()]
      .filter((f) => candidates.some((d) => d.id === f.deviceId) && f.state !== 'ended' && feedPriority(f) < prio)
      .sort((a, b) => feedPriority(a) - feedPriority(b) || a.startedAt - b.startedAt)
    if (victims.length) {
      const v = victims[0]
      const dev = candidates.find((d) => d.id === v.deviceId)
      for (const h of [...v.holders]) { if (h.onPreempt) { try { h.onPreempt('needed_for_recording') } catch { /* holder's problem */ } } }
      endFeed(v, new TunerError('preempted', 'The tuner was needed for a recording.'))
      // The tuner frees its slot a moment after we hang up.
      for (let n = 0; ; n++) {
        try { return await tryOpen(dev) } catch (e) {
          if (!e || e.code !== 'tuner_external_busy' || n >= 15) throw e
          await new Promise((r) => { const w = setTimeout(r, 120); if (w.unref) w.unref() })
        }
      }
    }

    const total = candidates.reduce((n, d) => n + d.tunerCount, 0)
    const inUse = describe(candidates.map((d) => d.id))
    const who = inUse.length ? ` (${inUse.join(', ')})` : ''
    throw new TunerBusyError(
      `All ${total} tuner${total === 1 ? ' is' : 's are'} busy right now${who}${sawExternal ? '; the tuner reports some are in use by another app such as Plex' : ''}. Try again in a little while.`,
      { total, ours: inUse.length, sawExternal }
    )
  }

  function status() {
    return devices().map((d) => ({
      deviceId: d.id, name: d.name, tunerCount: d.tunerCount,
      feeds: [...feeds.values()].filter((f) => f.deviceId === d.id).map((f) => ({
        channelKey: f.channelKey, guideNumber: f.guideNumber, state: f.state, bytes: f.bytes,
        holders: [...f.holders].map((h) => ({ purpose: h.purpose, label: h.label })), startedAt: f.startedAt
      })),
      free: Math.max(0, d.tunerCount - usedOn(d.id))
    }))
  }

  function closeAll() {
    for (const f of [...feeds.values()]) endFeed(f, new TunerError('shutdown', 'Shutting down.'))
    if (watch) { clearInterval(watch); watch = null }
  }

  return { acquire, status, closeAll, size: () => feeds.size, busyChannelKeys: () => [...feeds.values()].map((f) => f.channelKey) }
}

module.exports = { createTunerPool, defaultOpen, TunerBusyError, TunerError, PRIORITY }
