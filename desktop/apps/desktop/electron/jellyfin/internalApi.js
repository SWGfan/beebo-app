'use strict'

const { Readable, Writable } = require('stream')

const DROP_HEADERS = ['authorization', 'x-emby-authorization', 'x-mediabrowser-token', 'x-emby-token', 'content-length', 'content-type', 'transfer-encoding', 'range', 'if-none-match', 'if-modified-since', 'accept-encoding', 'cookie', 'expect', 'upgrade', 'connection']

class CaptureResponse extends Writable {
  constructor() {
    super()
    this.statusCode = 200
    this.headersSent = false
    this._headers = {}
    this._chunks = []
    this.req = null
  }
  setHeader(k, v) { this._headers[String(k).toLowerCase()] = v; return this }
  getHeader(k) { return this._headers[String(k).toLowerCase()] }
  removeHeader(k) { delete this._headers[String(k).toLowerCase()] }
  getHeaders() { return { ...this._headers } }
  hasHeader(k) { return String(k).toLowerCase() in this._headers }
  writeHead(status, a, b) {
    this.statusCode = status
    const h = (typeof a === 'object' && a) || b || {}
    for (const [k, v] of Object.entries(h)) this.setHeader(k, v)
    this.headersSent = true
    return this
  }
  flushHeaders() { this.headersSent = true }
  _write(chunk, _enc, cb) { this._chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); this.headersSent = true; cb() }
  body() { return Buffer.concat(this._chunks) }
}

function makeRequest(real, { method, path, headers, body }) {
  const payload = body === undefined || body === null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
  const req = Readable.from(payload ? [payload] : [])
  req.method = method
  req.url = path
  req.httpVersion = '1.1'
  req.socket = real ? real.socket : undefined
  req.connection = req.socket
  const base = {}
  for (const [k, v] of Object.entries((real && real.headers) || {})) {
    if (!DROP_HEADERS.includes(k.toLowerCase())) base[k.toLowerCase()] = v
  }
  req.headers = { ...base, ...headers }
  if (payload) {
    req.headers['content-type'] = 'application/json'
    req.headers['content-length'] = String(payload.length)
  }
  return req
}

// Runs Beebo's own request handler in-process, as one signed-in person, and returns what it answered.
// The bearer token is minted here and never leaves the process.
function createInternalApi({ store, dispatch, makeApiToken }) {
  return async function api(userId, method, pathAndQuery, body, realReq) {
    const token = makeApiToken(store, userId)
    if (!token) return { status: 401, body: null }
    const req = makeRequest(realReq, { method, path: pathAndQuery, headers: { authorization: 'Bearer ' + token }, body })
    const res = new CaptureResponse()
    res.req = req
    await Promise.race([
      dispatch(req, res).then(() => (res.writableEnded ? null : new Promise((resolve) => res.once('finish', resolve)))),
      new Promise((resolve) => setTimeout(resolve, 60000).unref())
    ])
    const text = res.body().toString('utf8')
    let parsed = null
    try { parsed = text ? JSON.parse(text) : null } catch { parsed = null }
    return { status: res.statusCode, body: parsed, text, headers: res.getHeaders() }
  }
}

module.exports = { createInternalApi, CaptureResponse, makeRequest }
