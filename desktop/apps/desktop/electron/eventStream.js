'use strict'
// The live event stream for dashboards: GET /api/v1/events (Server-Sent Events).
//
// A dashboard (Home Assistant's custom card, a wall display, a small script with `curl -N`) opens
// one long-lived request and hears playback events as they happen instead of polling now-playing:
//
//   retry: 5000
//
//   event: snapshot                      <- once, on connect: the same JSON as GET /api/v1/now-playing
//   data: { "ok": true, "count": 1, "items": [ ... ] }
//
//   id: 41
//   event: playback.paused               <- then every playback.* event, as it happens
//   data: { "event": "playback.paused", "timestamp": "...", "data": { ...same as the webhook... } }
//
//   event: snapshot                      <- and a fresh snapshot every 15 seconds (this is also the
//   data: { ... }                           keep-alive, and how positions and bandwidth stay current)
//
// Events carry the same payload, and the same privacy rules, as the playback webhooks (webhooks.js
// decides what may be announced; nothing about a private or limited profile ever gets here). A
// client that reconnects with `Last-Event-ID` is sent what it missed, up to the last 50 events.
//
// A connection costs a socket and a timer, so the number is capped (per server and per key), and a
// stream ends by itself the moment the key behind it is removed or loses its scope.

const DEFAULTS = {
  maxConnections: 20,
  maxPerPrincipal: 3,
  snapshotEveryMs: 15 * 1000,
  backlog: 50
}

// `webhooks` is electron/webhooks.js (only onEvent() is used); options are for tests.
function createEventStream({ webhooks, ...opts } = {}) {
  const o = { ...DEFAULTS, ...opts }
  const clients = new Set()
  const recent = [] // [{ id, event, frame }]
  let nextId = 1
  let unsubscribe = null

  const frame = (event, data, id) => `${id !== undefined ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

  function onMessage(message) {
    const id = nextId++
    const text = frame(message.event, message, id)
    recent.push({ id, text })
    if (recent.length > o.backlog) recent.shift()
    for (const c of [...clients]) c.write(text)
  }

  // Listening (and so tracking sessions) only costs anything while someone is connected.
  function ensureListening() {
    if (!unsubscribe && webhooks && typeof webhooks.onEvent === 'function') unsubscribe = webhooks.onEvent(onMessage)
  }
  function maybeStopListening() {
    if (!clients.size && unsubscribe) { unsubscribe(); unsubscribe = null }
  }

  // principal: { key: 'k:<id>' | 'u:<userId>' } (what the per-principal cap counts),
  // snapshot(): the now-playing JSON, isValid(): false once the credential behind the stream is gone.
  function attach(req, res, { key, snapshot, isValid }) {
    if (clients.size >= o.maxConnections) return { ok: false, status: 503, error: 'too_many_streams' }
    let mine = 0
    for (const c of clients) if (c.key === key) mine++
    if (mine >= o.maxPerPrincipal) return { ok: false, status: 429, error: 'too_many_streams' }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
    let closed = false
    const client = {
      key,
      write(text) {
        if (closed) return
        try { res.write(text) } catch { end() }
      }
    }
    function end() {
      if (closed) return
      closed = true
      clearInterval(timer)
      clients.delete(client)
      try { res.end() } catch { /* already gone */ }
      maybeStopListening()
    }
    const tick = () => {
      let valid = true
      try { valid = typeof isValid === 'function' ? isValid() !== false : true } catch { valid = false }
      if (!valid) { client.write(frame('revoked', { ok: false, error: 'unauthorized' })); end(); return }
      try { client.write(frame('snapshot', snapshot())) } catch { client.write(': snapshot failed\n\n') }
    }
    const timer = setInterval(tick, o.snapshotEveryMs)
    if (timer.unref) timer.unref()
    client.close = end
    req.on('close', end)
    res.on('close', end)
    res.on('error', end)

    clients.add(client)
    ensureListening()
    client.write('retry: 5000\n\n')
    // What a reconnecting client missed.
    const last = Number(req.headers['last-event-id'])
    if (Number.isInteger(last) && last >= 0) for (const r of recent) if (r.id > last) client.write(r.text)
    try { client.write(frame('snapshot', snapshot())) } catch { client.write(': snapshot failed\n\n') }
    return { ok: true }
  }

  function closeAll() {
    for (const c of [...clients]) c.close()
    maybeStopListening()
  }

  return { attach, closeAll, size: () => clients.size, _recent: recent }
}

module.exports = { createEventStream, DEFAULTS }
