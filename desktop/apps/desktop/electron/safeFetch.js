'use strict'
// Downloads from a third party's JSON-supplied link (security review F10): https only, a host
// allowlist checked on every redirect hop, a size cap enforced while streaming, a timeout, and a
// content-type check. Nothing here follows a redirect to a host that is not on the list.

const DEFAULT_MAX_REDIRECTS = 3

/** hostname must equal an allowed host or be a subdomain of an entry written as '.example.com'. */
function hostAllowed(hostname, allowHosts) {
  const h = String(hostname || '').toLowerCase()
  return (allowHosts || []).some((a) => {
    const x = String(a).toLowerCase()
    return x.startsWith('.') ? h.endsWith(x) && h.length > x.length : h === x
  })
}

/** Parse and vet one URL. -> URL, or null. `allowHttp` (tests pointing at a local fake) also permits http and any port. */
function vetUrl(raw, allowHosts, { allowHttp = false } = {}) {
  let u
  try { u = new URL(String(raw)) } catch { return null }
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) return null
  if (u.username || u.password) return null
  if (!allowHttp && u.port && u.port !== '443') return null
  if (!hostAllowed(u.hostname, allowHosts)) return null
  return u
}

/**
 * GET `url` and return { ok, status, buf, contentType } or { ok:false, reason }.
 * Options: allowHosts (required), maxBytes, timeoutMs, contentType (RegExp tested against the
 * response's content-type; a missing header fails), fetchImpl, headers, maxRedirects.
 */
async function fetchLimited(url, opts = {}) {
  const { allowHosts, maxBytes = 5 * 1024 * 1024, timeoutMs = 20000, contentType, headers, maxRedirects = DEFAULT_MAX_REDIRECTS } = opts
  const fetchImpl = opts.fetchImpl || fetch
  const vet = (u) => vetUrl(u, allowHosts, { allowHttp: !!opts.allowHttp })
  let current = vet(url)
  if (!current) return { ok: false, reason: 'blocked_url' }
  const signal = AbortSignal.timeout(timeoutMs)
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let res
    try {
      res = await fetchImpl(current.href, { redirect: 'manual', signal, headers })
    } catch {
      return { ok: false, reason: 'network' }
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers && res.headers.get && res.headers.get('location')
      try { await res.arrayBuffer() } catch { /* drain */ }
      if (!loc) return { ok: false, reason: 'bad_redirect' }
      let next
      try { next = new URL(loc, current) } catch { return { ok: false, reason: 'bad_redirect' } }
      current = vet(next.href)
      if (!current) return { ok: false, reason: 'blocked_redirect' }
      continue
    }
    if (!res.ok) return { ok: false, reason: 'http_' + res.status, status: res.status }
    const ct = String((res.headers && res.headers.get && res.headers.get('content-type')) || '')
    if (contentType && !contentType.test(ct)) return { ok: false, reason: 'bad_content_type', contentType: ct }
    const declared = Number(res.headers && res.headers.get && res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: 'too_large' }
    // Stream, so a server that lies about (or omits) Content-Length still stops at the cap.
    const chunks = []
    let total = 0
    try {
      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.length
          if (total > maxBytes) { try { await reader.cancel() } catch { /* ignore */ } return { ok: false, reason: 'too_large' } }
          chunks.push(Buffer.from(value))
        }
      } else {
        const b = Buffer.from(await res.arrayBuffer())
        if (b.length > maxBytes) return { ok: false, reason: 'too_large' }
        chunks.push(b)
      }
    } catch {
      return { ok: false, reason: 'network' }
    }
    return { ok: true, status: res.status, buf: Buffer.concat(chunks), contentType: ct }
  }
  return { ok: false, reason: 'too_many_redirects' }
}

module.exports = { fetchLimited, vetUrl, hostAllowed }
