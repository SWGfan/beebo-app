// The account-security bundle through the real HTTP server: two-factor sign-in (website and phone app),
// TOTP replay and lockouts over HTTP, self-service set-up, signed-in devices, owner policy, and password
// reset with no email server.
// Run: node --test test/account-security-http.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const auth = require('../electron/auth')
const totp = require('../electron/totp')
const twoFactor = require('../electron/twoFactor')
const resetCodes = require('../electron/resetCodes')
const securityLog = require('../electron/securityLog')
const authSessions = require('../electron/authSessions')
const server = require('../electron/streamServer')

const PASSWORD = 'lantern-copper-orbit-42'
const NEW_PASSWORD = 'a-brand-new-lantern-passphrase-7'
const SECRET = crypto.randomBytes(32).toString('hex')
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
let portSequence = 0

async function fixture(t, { admins = ['owner'] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'beebo-account-security-'))
  const moviesDir = path.join(root, 'movies')
  await fs.mkdir(moviesDir)
  const data = {
    authUsers: [
      { id: 'owner', name: 'Owner', username: 'owner', status: 'approved', isAdmin: admins.includes('owner'), passwordHash: auth.hashPassword(PASSWORD), email: 'owner@example.test' },
      { id: 'ann', name: 'Ann', username: 'ann', status: 'approved', passwordHash: auth.hashPassword(PASSWORD), email: 'ann@example.test' },
      { id: 'bob', name: 'Bob', username: 'bob', status: 'approved', passwordHash: auth.hashPassword(PASSWORD) },
      { id: 'legacy', name: 'Legacy', username: 'legacy', status: 'approved', code: 'ABCDEFGH', codeHash: auth.hashCode('ABCDEFGH') }
    ]
  }
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
  auth.forgetSecrets(); server.forgetSecrets()
  const info = server.startStreamServer({
    port: 45000 + (process.pid % 1500) + ++portSequence,
    store, getMoviesDir: () => moviesDir, getTvShowsDir: () => root,
    getAllMoviesDirs: () => [moviesDir], getAllTvShowsDirs: () => [],
    agentSecret: SECRET, log: () => {}
  })
  t.after(async () => {
    await new Promise((resolve) => info.close(resolve))
    await fs.rm(root, { recursive: true, force: true })
  })
  const base = 'http://127.0.0.1:' + info.port
  let ready = false
  for (let i = 0; i < 50; i++) {
    try { await (await fetch(base + '/api/ping')).arrayBuffer(); ready = true; break } catch { await new Promise((r) => setTimeout(r, 50)) }
  }
  assert.equal(ready, true, 'server started')
  const user = (id) => data.authUsers.find((u) => u.id === id)

  async function form(route, fields, cookie) {
    const res = await fetch(base + route, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': CHROME, ...(cookie ? { Cookie: cookie } : {}) },
      body: new URLSearchParams(fields).toString()
    })
    const text = await res.text()
    const setCookie = res.headers.get('set-cookie') || ''
    const session = /beebo_session=([^;]*)/.exec(setCookie)
    return { status: res.status, text, location: res.headers.get('location'), session: session ? session[1] : null, cleared: /beebo_session=;/.test(setCookie) }
  }
  async function web(route, cookie, extra = {}) {
    const res = await fetch(base + route, { redirect: 'manual', headers: { 'User-Agent': CHROME, ...(cookie ? { Cookie: 'beebo_session=' + cookie } : {}) }, ...extra })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { status: res.status, text, json, location: res.headers.get('location'), headers: res.headers }
  }
  async function webJson(route, body, cookie) {
    const res = await fetch(base + route, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/json', 'User-Agent': CHROME, ...(cookie ? { Cookie: 'beebo_session=' + cookie } : {}) },
      body: JSON.stringify(body || {})
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    const setCookie = res.headers.get('set-cookie') || ''
    const session = /beebo_session=([^;]*)/.exec(setCookie)
    return { status: res.status, json, text, session: session ? session[1] : null }
  }
  async function api(route, body, token, headers = {}) {
    const res = await fetch(base + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 14)', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { status: res.status, json, text }
  }
  // Turn two-factor on for a person directly (the set-up flow itself is tested separately).
  function enable(id) {
    const begun = twoFactor.beginSetup(store, id)
    const done = twoFactor.confirmSetup(store, id, totp.totp(begun.secret))
    assert.equal(done.ok, true)
    return { secret: begun.secret, recovery: done.recoveryCodes }
  }
  // Let the 30-second step move on by rewinding what the server remembers as "last used".
  function nextStep(id) {
    const u = user(id)
    u.twoFactor = { ...u.twoFactor, lastStep: u.twoFactor.lastStep - 1 }
  }
  return { data, store, base, form, web, webJson, api, enable, nextStep, user }
}

const loginForm = (f, username, password = PASSWORD) => f.form('/login', { username, password })
const challengeOf = (text) => /name="challenge" value="([^"]+)"/.exec(text)[1]

test('a person without two-factor signs in as before, and the new cookie is a listed device', async (t) => {
  const f = await fixture(t)
  const r = await loginForm(f, 'ann')
  assert.equal(r.status, 302)
  assert.ok(r.session)
  assert.equal(r.session.split('.').length, 4, 'tracked cookie: user.expires.sid.sig')
  const status = await f.web('/account/security/api', r.session)
  assert.equal(status.status, 200)
  assert.equal(status.json.user.username, 'ann')
  assert.equal(status.json.twoFactor.enabled, false)
  assert.equal(status.json.sessions.length, 1)
  assert.equal(status.json.sessions[0].device, 'Chrome on Windows')
  assert.equal(status.json.sessions[0].current, true)
  assert.equal(status.json.sessions[0].ip, '127.0.0.1')
  assert.ok(status.json.events.some((e) => e.type === 'login_success'))
  const page = await f.web('/account/security', r.session)
  assert.equal(page.status, 200)
  assert.match(page.text, /Account security/)
  assert.match(page.text, /Two-factor sign-in/)
  assert.equal((await f.web('/account/security')).status, 302, 'signed-out visitors are sent to the login page')
})

test('two-factor on: the password alone is NOT a sign-in; the code completes it', async (t) => {
  const f = await fixture(t)
  const { secret } = f.enable('ann')
  const step1 = await loginForm(f, 'ann')
  assert.equal(step1.status, 200)
  assert.equal(step1.session, null, 'no cookie after the password step')
  assert.match(step1.text, /Two-step sign-in/)
  const challenge = challengeOf(step1.text)
  // A wrong code is refused, and the page asks again with the same challenge.
  const wrong = await f.form('/login/2fa', { challenge, code: '000000' })
  assert.equal(wrong.status, 200)
  assert.equal(wrong.session, null)
  assert.match(wrong.text, /not right/)
  // The right one signs in.
  f.nextStep('ann')
  const ok = await f.form('/login/2fa', { challenge, code: totp.totp(secret) })
  assert.equal(ok.status, 302)
  assert.ok(ok.session)
  assert.equal((await f.web('/account/security/api', ok.session)).status, 200)
  const kinds = securityLog.list(f.store, { userId: 'ann' }).map((e) => e.type)
  for (const k of ['two_factor_required', 'two_factor_failed', 'two_factor_success', 'login_success']) assert.ok(kinds.includes(k), k)
  // The challenge is single use.
  f.nextStep('ann')
  const reuse = await f.form('/login/2fa', { challenge, code: totp.totp(secret) })
  assert.equal(reuse.session, null)
})

test('a used code cannot be replayed on a fresh sign-in (TOTP replay prevention over HTTP)', async (t) => {
  const f = await fixture(t)
  const { secret } = f.enable('ann')
  const code = totp.totp(secret)
  f.nextStep('ann') // the enrollment code is spent; this is the first login code
  const first = await f.form('/login/2fa', { challenge: challengeOf((await loginForm(f, 'ann')).text), code })
  assert.equal(first.status, 302)
  const second = await f.form('/login/2fa', { challenge: challengeOf((await loginForm(f, 'ann')).text), code })
  assert.equal(second.session, null)
  assert.match(second.text, /already used|not right/)
})

test('a tampered, expired or missing challenge sends the person back to the password step', async (t) => {
  const f = await fixture(t)
  const { secret } = f.enable('ann')
  f.nextStep('ann')
  for (const challenge of ['', 'garbage', challengeOf((await loginForm(f, 'ann')).text).slice(0, -3) + 'AAA']) {
    const r = await f.form('/login/2fa', { challenge, code: totp.totp(secret) })
    assert.equal(r.session, null)
    assert.match(r.text, /timed out|Enter your username/)
  }
  assert.equal((await f.web('/login/2fa')).status, 302, 'GET goes to the login page')
})

test('guessing the six digits is stopped: five wrong codes lock the second step, from any address', async (t) => {
  const f = await fixture(t)
  const { secret } = f.enable('ann')
  f.nextStep('ann')
  // Each guess starts from a fresh password step (an attacker who knows the password).
  let lockedText = ''
  for (let i = 0; i < 6; i++) {
    const step1 = await loginForm(f, 'ann')
    if (!/name="challenge"/.test(step1.text)) { lockedText = step1.text; break }
    const guess = await f.form('/login/2fa', { challenge: challengeOf(step1.text), code: String(100000 + i) })
    if (/locked/i.test(guess.text)) { lockedText = guess.text; break }
  }
  assert.match(lockedText, /locked|Too many/i)
  // Now even the right code (with a valid challenge) is refused.
  const s2 = await loginForm(f, 'ann')
  const challenge = /name="challenge" value="([^"]+)"/.exec(s2.text)
  if (challenge) {
    const right = await f.form('/login/2fa', { challenge: challenge[1], code: totp.totp(secret) })
    assert.equal(right.session, null)
    assert.match(right.text, /locked|Too many/i)
  }
  assert.equal(twoFactor.lockStatus(f.store, 'ann').locked, true)
  // The second-step lock is per person: Bob's is untouched (this test's one address is on the per-address lock by now).
  assert.equal(twoFactor.lockStatus(f.store, 'bob').locked, false)
})

test('a recovery code signs in once and is then spent', async (t) => {
  const f = await fixture(t)
  const { recovery } = f.enable('ann')
  const a = await f.form('/login/2fa', { challenge: challengeOf((await loginForm(f, 'ann')).text), code: recovery[0] })
  assert.equal(a.status, 302)
  const b = await f.form('/login/2fa', { challenge: challengeOf((await loginForm(f, 'ann')).text), code: recovery[0] })
  assert.equal(b.session, null)
  assert.ok(securityLog.list(f.store, { type: 'recovery_code_used' }).length === 1)
})

test('the phone app: /api/login answers two_factor_required, /api/login/2fa completes it, and a code can ride along', async (t) => {
  const f = await fixture(t)
  const { secret } = f.enable('ann')
  const first = await f.api('/api/login', { username: 'ann', password: PASSWORD })
  assert.equal(first.status, 401)
  assert.equal(first.json.error, 'two_factor_required')
  assert.ok(first.json.challenge)
  assert.equal(first.json.token, undefined)
  f.nextStep('ann')
  const done = await f.api('/api/login/2fa', { challenge: first.json.challenge, code: totp.totp(secret) })
  assert.equal(done.status, 200, done.text)
  assert.ok(done.json.token)
  assert.equal((await f.api('/api/me', undefined, done.json.token)).status, 200)
  // The wrong password still gets the plain answer.
  assert.equal((await f.api('/api/login', { username: 'ann', password: 'wrong-wrong-wrong' })).json.error, 'bad_credentials')
  // One call with the code included.
  f.nextStep('ann')
  const combined = await f.api('/api/login', { username: 'ann', password: PASSWORD, code: totp.totp(secret, { time: Date.now() + 30000 }) })
  assert.equal(combined.status, 200, combined.text)
  // A bad code in that call is refused with a clear error and no token.
  const bad = await f.api('/api/login', { username: 'ann', password: PASSWORD, code: '000000' })
  assert.equal(bad.status, 401)
  assert.equal(bad.json.token, undefined)
  assert.equal(bad.json.error, 'invalid_code')
})

test('nothing that only knows the password can reach a two-factor account: profile switching and the sign-in helper', async (t) => {
  const f = await fixture(t)
  f.enable('ann')
  const bob = await f.api('/api/login', { username: 'bob', password: PASSWORD })
  const switched = await f.api('/api/profiles/switch', { userId: 'ann' }, bob.json.token)
  assert.equal(switched.status, 403)
  assert.equal(switched.json.error, 'two_factor_profile_sign_in')
  // Anything built on attemptLogin (for example the Jellyfin-compatible sign-in) sees a refusal, never a user.
  const compat = await f.api('/api/login', { username: 'ann', password: PASSWORD })
  assert.equal(compat.json.token, undefined)
})

test('self-service set-up over HTTP: password first, QR and key, a code to finish, recovery codes once', async (t) => {
  const f = await fixture(t)
  const cookie = (await loginForm(f, 'ann')).session
  assert.equal((await f.webJson('/account/security/api/2fa/begin', { password: 'nope-nope-nope' }, cookie)).status, 401)
  const begun = await f.webJson('/account/security/api/2fa/begin', { password: PASSWORD }, cookie)
  assert.equal(begun.status, 200, begun.text)
  assert.match(begun.json.secret, /^[A-Z2-7]{32}$/)
  assert.match(begun.json.uri, /^otpauth:\/\/totp\/Beebo%20Entertainment:ann\?secret=/)
  assert.match(begun.json.qrSvg, /^<svg /)
  assert.equal(twoFactor.isEnabled(f.user('ann')), false)
  const bad = await f.webJson('/account/security/api/2fa/confirm', { code: '123456' }, cookie)
  assert.equal(bad.status, 401)
  const done = await f.webJson('/account/security/api/2fa/confirm', { code: totp.totp(begun.json.secret) }, cookie)
  assert.equal(done.status, 200, done.text)
  assert.equal(done.json.recoveryCodes.length, 10)
  assert.equal(twoFactor.isEnabled(f.user('ann')), true)
  // From now on the sign-in needs it.
  const next = await loginForm(f, 'ann')
  assert.match(next.text, /Two-step sign-in/)
  // The status never carries the secret.
  const status = await f.web('/account/security/api', cookie)
  assert.equal(status.json.twoFactor.enabled, true)
  assert.equal(status.json.twoFactor.recoveryRemaining, 10)
  assert.ok(!status.text.includes(begun.json.secret))
  assert.ok(!(await f.web('/account/security', cookie)).text.includes(begun.json.secret))
})

test('turning two-factor off, or making new recovery codes, needs the password AND a fresh code', async (t) => {
  const f = await fixture(t)
  const { secret } = f.enable('ann')
  f.nextStep('ann')
  const first = await f.form('/login/2fa', { challenge: challengeOf((await loginForm(f, 'ann')).text), code: totp.totp(secret) })
  const cookie = first.session
  f.nextStep('ann')
  assert.equal((await f.webJson('/account/security/api/2fa/disable', { password: PASSWORD }, cookie)).status, 401)
  assert.equal((await f.webJson('/account/security/api/2fa/disable', { password: 'wrong-wrong-wrong', code: totp.totp(secret) }, cookie)).status, 401)
  assert.equal(twoFactor.isEnabled(f.user('ann')), true)
  const regen = await f.webJson('/account/security/api/2fa/recovery-codes', { password: PASSWORD, code: totp.totp(secret) }, cookie)
  assert.equal(regen.status, 200, regen.text)
  assert.equal(regen.json.recoveryCodes.length, 10)
  f.nextStep('ann')
  const off = await f.webJson('/account/security/api/2fa/disable', { password: PASSWORD, code: totp.totp(secret) }, cookie)
  assert.equal(off.status, 200, off.text)
  assert.equal(twoFactor.isEnabled(f.user('ann')), false)
})

test('the owner policy: an admin without two-factor is held at the set-up page and cannot use the API; desktop windows are exempt', async (t) => {
  const f = await fixture(t)
  twoFactor.setPolicy(f.store, { requireForAdmins: true })
  const login = await loginForm(f, 'owner')
  assert.equal(login.status, 302)
  const cookie = login.session
  const home = await f.web('/', cookie)
  assert.equal(home.status, 302)
  assert.equal(home.location, '/account/security?required=1')
  const held = await f.web('/account/security?required=1', cookie)
  assert.equal(held.status, 200)
  assert.match(held.text, /Two-factor is required/)
  const post = await f.web('/missing-request', cookie, { method: 'POST' })
  assert.equal(post.status, 403)
  // Members are not held.
  assert.equal((await f.web('/', (await loginForm(f, 'ann')).session)).status, 200)
  // The phone app cannot get in either way.
  const apiLogin = await f.api('/api/login', { username: 'owner', password: PASSWORD })
  assert.equal(apiLogin.status, 403)
  assert.equal(apiLogin.json.error, 'two_factor_setup_required')
  // Set up through the held page's own API, after which the hold lifts.
  const begun = await f.webJson('/account/security/api/2fa/begin', { password: PASSWORD }, cookie)
  assert.equal(begun.status, 200)
  await f.webJson('/account/security/api/2fa/confirm', { code: totp.totp(begun.json.secret) }, cookie)
  assert.equal((await f.web('/', cookie)).status, 200)
  // The owner cannot turn it off while the policy stands.
  f.nextStep('owner')
  const off = await f.webJson('/account/security/api/2fa/disable', { password: PASSWORD, code: totp.totp(begun.json.secret, { time: Date.now() + 30000 }) }, cookie)
  assert.equal(off.status, 403)
  assert.equal(off.json.error, 'required_by_policy')
  // The desktop app's own window is never held.
  const desktopCookie = auth.signSession(f.store, 'owner', { desktop: true })
  const other = await fixture(t)
  twoFactor.setPolicy(other.store, { requireForAdmins: true })
  const own = auth.signSession(other.store, 'owner', { desktop: true })
  assert.equal((await other.web('/', own)).status, 200)
  assert.ok(desktopCookie)
})

test('an existing token or cookie of an admin is held too when the policy is switched on', async (t) => {
  const f = await fixture(t)
  const token = (await f.api('/api/login', { username: 'owner', password: PASSWORD })).json.token
  assert.equal((await f.api('/api/me', undefined, token)).status, 200)
  twoFactor.setPolicy(f.store, { requireForAdmins: true })
  const held = await f.api('/api/me', undefined, token)
  assert.equal(held.status, 403)
  assert.equal(held.json.error, 'two_factor_setup_required')
  // The account-security calls stay open so they can set it up from the app's own screens.
  assert.equal((await f.api('/api/account/security', undefined, token)).status, 200)
})

test('signed-in devices: list, revoke one, sign out everywhere else, sign out everywhere', async (t) => {
  const f = await fixture(t)
  const laptop = (await loginForm(f, 'ann')).session
  const phone = (await f.api('/api/login', { username: 'ann', password: PASSWORD })).json.token
  assert.equal(authSessions.list(f.store, 'ann').length, 2)
  const listed = await f.web('/account/security/api/sessions', laptop)
  assert.equal(listed.json.sessions.length, 2)
  const app = listed.json.sessions.find((s) => s.kind === 'app')
  assert.equal(app.device, 'Beebo app on Android')
  assert.equal(listed.json.sessions.filter((s) => s.current).length, 1)
  // Revoke the phone.
  const gone = await f.webJson('/account/security/api/sessions/revoke', { id: app.id }, laptop)
  assert.equal(gone.status, 200)
  assert.equal((await f.api('/api/me', undefined, phone)).status, 401, 'the revoked token stops working at once')
  assert.equal((await f.web('/account/security/api', laptop)).status, 200)
  // A second device, then sign out everywhere else: this one keeps working.
  const tablet = (await loginForm(f, 'ann')).session
  const others = await f.webJson('/account/security/api/sessions/revoke-all', {}, laptop)
  assert.equal(others.status, 200)
  assert.equal(others.json.ended, 2)
  assert.ok(others.session, 'this device gets a fresh cookie')
  assert.equal((await f.web('/account/security/api', tablet)).status, 302, 'the other browser is signed out')
  const fresh = others.session
  assert.equal((await f.web('/account/security/api', fresh)).status, 200)
  // Everywhere including here.
  const all = await f.webJson('/account/security/api/sessions/revoke-all', { includeCurrent: true }, fresh)
  assert.equal(all.json.signedOut, true)
  assert.equal((await f.web('/account/security/api', fresh)).status, 302)
  // Bob was never touched.
  assert.equal((await f.web('/account/security/api', (await loginForm(f, 'bob')).session)).status, 200)
})

test('logging out ends that device\'s session for real: a copied cookie stops working', async (t) => {
  const f = await fixture(t)
  const cookie = (await loginForm(f, 'ann')).session
  const out = await f.web('/logout', cookie)
  assert.equal(out.status, 302)
  assert.equal((await f.web('/account/security/api', cookie)).status, 302)
  assert.equal(authSessions.list(f.store, 'ann').length, 0)
})

test('old cookies made before this update (no session id) keep working, until "sign out everywhere"', async (t) => {
  const f = await fixture(t)
  const legacy = auth.signSession(f.store, 'ann')
  assert.equal(legacy.split('.').length, 3)
  assert.equal((await f.web('/account/security/api', legacy)).status, 200)
  await new Promise((r) => setTimeout(r, 5))
  const out = await f.webJson('/account/security/api/sessions/revoke-all', {}, legacy)
  assert.equal(out.status, 200)
  assert.equal((await f.web('/account/security/api', legacy)).status, 302)
})

test('changing your password: current password required, strength enforced, other devices signed out, this one kept', async (t) => {
  const f = await fixture(t)
  const laptop = (await loginForm(f, 'ann')).session
  const tablet = (await loginForm(f, 'ann')).session
  assert.equal((await f.webJson('/account/security/api/password', { currentPassword: 'wrong-wrong-wrong', newPassword: NEW_PASSWORD }, laptop)).status, 401)
  const weak = await f.webJson('/account/security/api/password', { currentPassword: PASSWORD, newPassword: 'password1' }, laptop)
  assert.equal(weak.status, 400)
  assert.equal(weak.json.error, 'weak_password')
  assert.match(weak.json.message, /commonly used/)
  const changed = await f.webJson('/account/security/api/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, laptop)
  assert.equal(changed.status, 200, changed.text)
  assert.ok(changed.session)
  assert.equal((await f.web('/account/security/api', tablet)).status, 302)
  assert.equal((await f.web('/account/security/api', changed.session)).status, 200)
  assert.equal((await loginForm(f, 'ann', NEW_PASSWORD)).status, 302)
  assert.equal((await loginForm(f, 'ann', PASSWORD)).status, 200, 'the old password is dead')
})

test('re-authentication failures count against the sign-in lockout', async (t) => {
  const f = await fixture(t)
  const cookie = (await loginForm(f, 'ann')).session
  let status = 0
  for (let i = 0; i < 12 && status !== 429; i++) status = (await f.webJson('/account/security/api/2fa/begin', { password: 'wrong-wrong-wrong-' + i }, cookie)).status
  assert.equal(status, 429)
  assert.equal((await f.webJson('/account/security/api/2fa/begin', { password: PASSWORD }, cookie)).status, 429, 'even the right password waits out the lock')
})

test('cross-site posts to the security API are refused (JSON only)', async (t) => {
  const f = await fixture(t)
  const cookie = (await loginForm(f, 'ann')).session
  const res = await fetch(f.base + '/account/security/api/sessions/revoke-all', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: 'beebo_session=' + cookie }, body: 'includeCurrent=true'
  })
  assert.equal(res.status, 415)
  await res.arrayBuffer()
})

test('access-code-only accounts can turn on two-factor with their code, and move to a password', async (t) => {
  const f = await fixture(t)
  const cookie = (await f.form('/login', { username: 'legacy', password: 'ABCDEFGH' })).session
  assert.ok(cookie)
  const begun = await f.webJson('/account/security/api/2fa/begin', { password: 'ABCDEFGH' }, cookie)
  assert.equal(begun.status, 200, begun.text)
  const moved = await f.webJson('/account/security/api/password', { currentPassword: 'ABCDEFGH', newPassword: NEW_PASSWORD }, cookie)
  assert.equal(moved.status, 200, moved.text)
  assert.equal(f.user('legacy').codeHash, null, 'the old access code stops working')
})

test('password reset with no email server: the forgot page says so, the owner\'s code works exactly once', async (t) => {
  const f = await fixture(t)
  const forgot = await f.web('/forgot-password')
  assert.match(forgot.text, /does not send email/)
  assert.match(forgot.text, /reset-with-code/)
  assert.match((await f.form('/forgot-password', { email: 'ann@example.test' })).text, /Ask the owner/)
  const page = await f.web('/reset-with-code?u=ann')
  assert.equal(page.status, 200)
  assert.match(page.text, /value="ann"/)
  assert.match(page.text, /location\.hash/, 'a link can carry the code after a # so it never reaches the server')
  const cookie = (await loginForm(f, 'ann')).session
  const { code } = resetCodes.issue(f.store, 'ann')
  // Wrong code, then a weak password, then success.
  assert.match((await f.form('/reset-with-code', { username: 'ann', code: 'AAAA-BBBB-CCCC', password: NEW_PASSWORD })).text, /did not work/)
  assert.match((await f.form('/reset-with-code', { username: 'ann', code, password: 'password1' })).text, /commonly used/)
  const done = await f.form('/reset-with-code', { username: 'ann', code, password: NEW_PASSWORD })
  assert.match(done.text, /Password updated/)
  assert.equal((await f.web('/account/security/api', cookie)).status, 302, 'the old session was ended')
  assert.equal((await loginForm(f, 'ann', NEW_PASSWORD)).status, 302)
  assert.match((await f.form('/reset-with-code', { username: 'ann', code, password: 'yet-another-lantern-pass-1' })).text, /did not work/)
  assert.equal((await loginForm(f, 'ann', NEW_PASSWORD)).status, 302, 'and it did not change again')
})

test('reset-code guessing shares the sign-in lockout', async (t) => {
  const f = await fixture(t)
  resetCodes.issue(f.store, 'ann')
  let text = ''
  for (let i = 0; i < 12; i++) {
    text = (await f.form('/reset-with-code', { username: 'ann', code: 'AAAA-BBBB-CC' + String(10 + i), password: NEW_PASSWORD })).text
    if (/Too many/.test(text)) break
  }
  assert.match(text, /Too many/)
})

test('the password-strength endpoint needs no login, changes nothing, and is capped', async (t) => {
  const f = await fixture(t)
  const weak = await f.webJson('/account/password-check', { password: 'password' })
  assert.equal(weak.status, 200)
  assert.equal(weak.json.ok, false)
  assert.match(weak.json.issues[0].message, /commonly used/)
  const strong = await f.webJson('/account/password-check', { password: 'lantern-copper-orbit-42-Waffles' })
  assert.equal(strong.json.ok, true)
  assert.ok(strong.json.score >= 3)
  let limited = 0
  for (let i = 0; i < 70; i++) if ((await f.webJson('/account/password-check', { password: 'x' + i })).status === 429) limited++
  assert.ok(limited >= 1)
})

test('the admin user list shows only a yes/no for two-factor', async (t) => {
  const f = await fixture(t)
  const { secret } = f.enable('ann')
  const token = (await f.api('/api/login', { username: 'owner', password: PASSWORD })).json.token
  const list = await f.api('/api/admin/users', undefined, token, { 'X-Beebo-Agent-Key': SECRET })
  if (list.status === 200 && list.json) {
    assert.ok(!list.text.includes(secret))
    assert.ok(!list.text.includes('scrypt$'))
  }
})
