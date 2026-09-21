'use strict'
const crypto = require('crypto')

const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
const SETUP_PAGE = '/setup'
const SETUP_API = '/api/headless/setup'
const MAX_BODY_BYTES = 4096
const MIN_PASSWORD_CHARS = 8

const DEFAULT_LIMITS = {
  maxCodeFailures: 5,
  lockMs: 10 * 60 * 1000,
  perIpMax: 8,
  perIpWindowMs: 60 * 1000
}

function newCode(randomBytes) {
  const bytes = randomBytes(12)
  let out = ''
  for (let i = 0; i < 12; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
    if (i % 4 === 3 && i < 11) out += '-'
  }
  return out
}

function normalizeCode(text) {
  return String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function codesMatch(supplied, actual) {
  const a = crypto.createHash('sha256').update(normalizeCode(supplied)).digest()
  const b = crypto.createHash('sha256').update(normalizeCode(actual)).digest()
  return crypto.timingSafeEqual(a, b)
}

function createSetupFlow({ store, auth, print = (line) => process.stdout.write(line + '\n'), now = Date.now, randomBytes = crypto.randomBytes, getUrls = () => [], limits = {} }) {
  const cfg = Object.assign({}, DEFAULT_LIMITS, limits)
  let code = null
  let codeFailures = 0
  let lockedUntil = 0
  let done = false
  const ipHits = new Map()

  const needsSetup = () => {
    if (done) return false
    let owner = false
    try { owner = auth.hasOwner(store) } catch { owner = false }
    if (owner) done = true
    return !owner
  }

  function rotate(reason) {
    code = newCode(randomBytes)
    codeFailures = 0
    announce(reason)
  }

  function announce(reason) {
    if (!needsSetup()) return
    if (!code) code = newCode(randomBytes)
    const urls = getUrls().map((base) => base.replace(/\/+$/, '') + SETUP_PAGE)
    print('[setup] ------------------------------------------------------------')
    print('[setup] ' + (reason || 'First-run setup: this server has no owner account yet.'))
    for (const url of urls) print('[setup]   Open ' + url)
    if (urls.some((u) => u.startsWith('https:'))) print('[setup]   (your browser will warn about the certificate: Beebo made it itself; accept it to continue)')
    print('[setup]   Setup code: ' + code)
    print('[setup] The code works once, until an owner account exists. It changes if the server restarts.')
    print('[setup] ------------------------------------------------------------')
  }

  function ipAllowed(ip) {
    const t = now()
    const hits = (ipHits.get(ip) || []).filter((at) => t - at < cfg.perIpWindowMs)
    if (hits.length >= cfg.perIpMax) {
      ipHits.set(ip, hits)
      return false
    }
    hits.push(t)
    ipHits.set(ip, hits)
    if (ipHits.size > 500) for (const [key, list] of ipHits) if (!list.some((at) => t - at < cfg.perIpWindowMs)) ipHits.delete(key)
    return true
  }

  function attempt({ code: supplied, username, password, ip = '' } = {}) {
    if (!needsSetup()) return { status: 404, body: { ok: false, error: 'not_found' } }
    const t = now()
    if (t < lockedUntil) return { status: 429, retryAfter: Math.ceil((lockedUntil - t) / 1000), body: { ok: false, error: 'too_many_attempts' } }
    if (!ipAllowed(String(ip))) return { status: 429, retryAfter: Math.ceil(cfg.perIpWindowMs / 1000), body: { ok: false, error: 'too_many_attempts' } }
    if (typeof supplied !== 'string' || !code || !codesMatch(supplied, code)) {
      codeFailures += 1
      if (codeFailures >= cfg.maxCodeFailures) {
        lockedUntil = t + cfg.lockMs
        rotate('Too many wrong setup codes: setup is locked for ' + Math.round(cfg.lockMs / 60000) + ' minutes and the code has changed.')
        return { status: 429, retryAfter: Math.ceil(cfg.lockMs / 1000), body: { ok: false, error: 'too_many_attempts' } }
      }
      return { status: 403, body: { ok: false, error: 'invalid_code' } }
    }
    if (typeof username !== 'string' || typeof password !== 'string') return { status: 400, body: { ok: false, error: 'Enter a username and a password.' } }
    if (password.length < MIN_PASSWORD_CHARS) return { status: 400, body: { ok: false, error: `Password must be at least ${MIN_PASSWORD_CHARS} characters.` } }
    if (password.length > 200) return { status: 400, body: { ok: false, error: 'That password is too long.' } }
    let result
    try {
      result = auth.createOwner(store, { username, password })
    } catch {
      return { status: 500, body: { ok: false, error: 'Could not create the owner account.' } }
    }
    if (!result || result.error || result.ok === false || !result.user) {
      const message = (result && (result.error || result.message)) || 'Could not create the owner account.'
      return { status: 400, body: { ok: false, error: String(message) } }
    }
    done = true
    code = null
    return { status: 200, body: { ok: true } }
  }

  function readJson(req, cb) {
    let size = 0
    const chunks = []
    let finished = false
    const end = (err, value) => {
      if (finished) return
      finished = true
      cb(err, value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        end(new Error('too_large'))
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { end(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { end(new Error('bad_json')) }
    })
    req.on('error', () => end(new Error('read_error')))
  }

  function sendJson(res, status, body, extra = {}) {
    const text = JSON.stringify(body)
    res.writeHead(status, Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }, extra))
    res.end(text)
  }

  function sameOrigin(req) {
    const origin = req.headers.origin
    if (!origin) return true
    try { return new URL(origin).host === req.headers.host } catch { return false }
  }

  function page(res) {
    const nonce = randomBytes(16).toString('base64')
    const html = renderPage(nonce)
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`
    })
    res.end(html)
  }

  function hook(req, res, url) {
    const p = url.pathname.replace(/\/+$/, '') || '/'
    const method = (req.method || 'GET').toUpperCase()
    const relevant = p === SETUP_PAGE || p === SETUP_API || (p === '/' && method === 'GET')
    if (!relevant || !needsSetup()) return false
    if (p === '/') {
      if (!String(req.headers.accept || '').includes('text/html')) return false
      res.writeHead(302, { Location: SETUP_PAGE, 'Cache-Control': 'no-store' })
      res.end()
      return true
    }
    if (p === SETUP_PAGE) {
      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(res, 405, { ok: false, error: 'method_not_allowed' }, { Allow: 'GET, HEAD' })
        return true
      }
      page(res)
      return true
    }
    if (method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method_not_allowed' }, { Allow: 'POST' })
      return true
    }
    if (!sameOrigin(req) || !/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
      sendJson(res, 403, { ok: false, error: 'forbidden' })
      return true
    }
    const ip = (req.socket && req.socket.remoteAddress) || ''
    readJson(req, (err, body) => {
      if (err || !body || typeof body !== 'object') {
        const tooLarge = !!err && err.message === 'too_large'
        sendJson(res, tooLarge ? 413 : 400, { ok: false, error: 'bad_request' }, tooLarge ? { Connection: 'close' } : {})
        return
      }
      const out = attempt({ code: body.code, username: body.username, password: body.password, ip })
      if (out.status === 200) print('[setup] The owner account was created. Setup is now closed.')
      sendJson(res, out.status, out.body, out.retryAfter ? { 'Retry-After': String(out.retryAfter) } : {})
    })
    return true
  }

  return { needsSetup, announce, attempt, hook, paths: { page: SETUP_PAGE, api: SETUP_API }, _codeForTests: () => code }
}

function renderPage(nonce) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Set up Beebo</title>
<style nonce="${nonce}">
:root{color-scheme:dark;--bg:#0f1115;--card:#171a21;--line:#2a2f3a;--fg:#e8eaf0;--mut:#9aa3b2;--acc:#f5a524;--bad:#ff6b6b;--ok:#4cd07d}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,Segoe UI,Roboto,sans-serif;padding:16px}
main{width:100%;max-width:420px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px}
h1{margin:0 0 4px;font-size:1.5rem}p{color:var(--mut);margin:0 0 18px}label{display:block;font-size:.85rem;color:var(--mut);margin:14px 0 6px}
input{width:100%;padding:11px 12px;border-radius:9px;border:1px solid var(--line);background:#0f1115;color:var(--fg);font:inherit}
input:focus{outline:2px solid var(--acc);outline-offset:1px}
button{margin-top:22px;width:100%;padding:12px;border:0;border-radius:9px;background:var(--acc);color:#1a1200;font:inherit;font-weight:700;cursor:pointer}
button:disabled{opacity:.6;cursor:wait}#msg{min-height:1.4em;margin-top:14px;font-size:.92rem}.bad{color:var(--bad)}.ok{color:var(--ok)}
a{color:var(--acc)}
</style></head><body><main>
<h1>Set up Beebo</h1>
<p>Create the owner account for this server. The setup code is printed in the server log (for Docker: <code>docker logs</code>).</p>
<p id="plain" class="bad" hidden>This page is not encrypted. Open it with https:// so the password cannot be read on your network.</p>
<form id="f" autocomplete="off">
<label for="code">Setup code</label><input id="code" name="code" required maxlength="20" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-XXXX">
<label for="user">Owner username</label><input id="user" name="user" required minlength="3" maxlength="40" autocomplete="username">
<label for="pw">Password (8 or more characters)</label><input id="pw" name="pw" type="password" required minlength="8" maxlength="200" autocomplete="new-password">
<label for="pw2">Repeat password</label><input id="pw2" name="pw2" type="password" required minlength="8" maxlength="200" autocomplete="new-password">
<button id="go" type="submit">Create owner account</button>
<div id="msg" role="status" aria-live="polite"></div>
</form></main>
<script nonce="${nonce}">
if(location.protocol==='http:'&&!/^(localhost|127\\.0\\.0\\.1|\\[::1\\])$/.test(location.hostname))document.getElementById('plain').hidden=false;
var f=document.getElementById('f'),msg=document.getElementById('msg'),go=document.getElementById('go');
function say(t,c){msg.className=c||'';msg.textContent=t}
f.addEventListener('submit',function(e){
e.preventDefault();
if(f.pw.value!==f.pw2.value){say('The two passwords do not match.','bad');return}
go.disabled=true;say('Creating the account...');
fetch('${SETUP_API}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:f.code.value,username:f.user.value,password:f.pw.value})})
.then(function(r){return r.json().catch(function(){return{}}).then(function(j){return{status:r.status,body:j}})})
.then(function(o){
if(o.body&&o.body.ok){f.style.display='none';msg.className='ok';msg.textContent='';var a=document.createElement('a');a.href='/';a.textContent='Open Beebo and sign in';msg.appendChild(document.createTextNode('Owner account created. '));msg.appendChild(a);return}
var e=o.body&&o.body.error;
say(o.status===403?'That setup code is not right.':o.status===429?'Too many attempts. Wait a few minutes and check the server log for a new code.':o.status===404?'Setup is already finished.':(e||'Something went wrong.'),'bad');go.disabled=false})
.catch(function(){say('Could not reach the server.','bad');go.disabled=false})});
</script></body></html>`
}

module.exports = { createSetupFlow, normalizeCode, SETUP_PAGE, SETUP_API, MIN_PASSWORD_CHARS }
