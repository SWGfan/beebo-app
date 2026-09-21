// "Help us plan Beebo Relay": the optional payment survey on the PC — when it
// shows, the PC calls, "Not now" for 30 days, and the if-fees-start examples
// (cost at 0% markup and about how many short ads).
// Run: node --test test/relay-survey.test.js   (no Electron, no network)
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const appRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(appRoot, '..', '..', '..')
const { createConnectionTest } = require(path.join(appRoot, 'electron', 'connectionTest.js'))
const pricingMod = require(path.join(appRoot, 'electron', 'relayPricing.js'))
const policy = require(path.join(appRoot, 'electron', 'relayPolicy.js'))
const loadModel = () => import(pathToFileURL(path.join(appRoot, 'src', 'lib', 'connectionModel.js')).href)
const loadCosts = () => import(pathToFileURL(path.join(appRoot, 'src', 'lib', 'connectionCosts.js')).href)
// The website pricing table lives in the private site-pages/ folder; without it use the identical copy bundled with the app.
const SITE = JSON.parse(fs.readFileSync(fs.existsSync(path.join(repoRoot, 'site-pages', 'relay-pricing.json')) ? path.join(repoRoot, 'site-pages', 'relay-pricing.json') : path.join(appRoot, 'electron', 'relay-pricing.fallback.json'), 'utf8'))
const PUB = policy.publicPricing(pricingMod.parsePricing(SITE))
const src = (f) => fs.readFileSync(path.join(appRoot, 'src', 'components', f), 'utf8')

function memStore(init = {}) {
  const m = new Map(Object.entries(init))
  return { get: (k) => m.get(k), set: (k, v) => m.set(k, v), delete: (k) => m.delete(k), _m: m }
}
function fakeFetch(routes) {
  const calls = []
  const f = async (url, init) => {
    calls.push({ url, init })
    const r = routes[new URL(url).pathname]
    if (!r) return { status: 404, json: async () => ({ error: 'not_found' }) }
    if (r === 'throw') throw new Error('offline')
    return { status: r.status, json: async () => r.body }
  }
  f.calls = calls
  return f
}

test('where the survey shows: Settings until answered then "Your answer"; the wizard only for Beebo Relay; "Not now" for 30 days', async () => {
  const M = await loadModel()
  const now = 1_800_000_000_000
  const answer = { choice: 'ads', label: 'x' }
  assert.equal(M.surveyMode({ place: 'settings', answer: null, now }), 'ask')
  assert.equal(M.surveyMode({ place: 'settings', answer, now }), 'answer')
  assert.equal(M.surveyMode({ place: 'settings', answer: null, hiddenUntil: now + 1, now }), 'hidden')
  assert.equal(M.surveyMode({ place: 'settings', answer: null, hiddenUntil: now - 1, now }), 'ask')
  assert.equal(M.surveyMode({ place: 'settings', answer, hiddenUntil: now + 1, now }), 'answer', 'an answer always shows in Settings')
  assert.equal(M.surveyMode({ place: 'wizard', answer: null, now, choice: 'relay' }), 'ask')
  assert.equal(M.surveyMode({ place: 'wizard', answer: null, now, choice: 'cloudflare' }), 'hidden')
  assert.equal(M.surveyMode({ place: 'wizard', answer, now, choice: 'relay' }), 'hidden', 'answered: hidden in the wizard')
  assert.equal(M.surveyMode({ place: 'wizard', answer: null, hiddenUntil: now + 1, now, choice: 'relay' }), 'hidden')
  assert.equal(M.SURVEY.laterMs, 30 * 86400 * 1000)
  assert.equal(M.SURVEY.title, 'Help us plan Beebo Relay')
  assert.equal(M.SURVEY.question, 'Beebo Relay is free at this time. If we ever need to charge for extra GB, how would you prefer to pay?')
  assert.deepEqual(M.SURVEY.choices.map((c) => c.label), [
    'Pay by card up front (prepaid GB)',
    'Pay by card monthly for what I use',
    'Watch short ads to earn GB (never during your videos)',
    'A mix: ads when I want, card for the rest',
    'Not sure yet',
  ])
  assert.match(M.SURVEY.optional, /optional/)
  assert.match(M.SURVEY.optional, /doesn’t change your plan or what you pay/)
  assert.equal(M.SURVEY.thanks, 'Thanks! You can change your answer anytime.')
  assert.equal(M.SURVEY.commentMax, 300)
  // The same choices as the Worker.
  const worker = fs.existsSync(path.join(repoRoot, 'worker', 'relaySurvey.js')) ? fs.readFileSync(path.join(repoRoot, 'worker', 'relaySurvey.js'), 'utf8') : ''
  if (worker) for (const c of M.SURVEY.choices) assert.ok(worker.includes(`{ id: '${c.id}', label: '${c.label}' }`), c.id)
  assert.match(M.surveyErrorText('rate_limited'), /try again tomorrow/)
})

test('PC calls: answer, send, "Not now"', async () => {
  let t = 1_800_000_000_000
  const store = memStore()
  const f = fakeFetch({
    '/relay/survey/me': { status: 200, body: { answer: null, choices: [] } },
    '/relay/survey': { status: 200, body: { ok: true, answer: { choice: 'mix', label: 'A mix: ads when I want, card for the rest', comment: 'hi', updatedAt: 1 } } },
  })
  const ct = createConnectionTest({ store, getToken: () => 'LIC', backendUrl: 'https://svc.example', fetch: f, now: () => t })
  assert.deepEqual(await ct.survey(), { hiddenUntil: 0, now: t, answer: null })
  assert.equal(f.calls[0].init.method, 'GET')
  assert.equal(f.calls[0].init.headers.authorization, 'Bearer LIC')

  const later = ct.surveyLater()
  assert.equal(later.hiddenUntil, t + 30 * 86400 * 1000)
  assert.equal((await ct.survey()).hiddenUntil, t + 30 * 86400 * 1000)

  assert.deepEqual(await ct.surveySend('bitcoin', ''), { ok: false, error: 'bad_choice' })
  const r = await ct.surveySend('mix', 'x'.repeat(400))
  assert.equal(r.ok, true)
  assert.equal(r.answer.choice, 'mix')
  const sent = f.calls.at(-1)
  assert.equal(new URL(sent.url).pathname, '/relay/survey')
  assert.equal(sent.init.method, 'POST')
  const body = JSON.parse(sent.init.body)
  assert.equal(body.choice, 'mix')
  assert.equal(body.comment.length, 300)
  assert.equal(store.get('relaySurveyHiddenUntil'), undefined, 'answering clears "Not now"')

  const limited = createConnectionTest({ store: memStore(), getToken: () => 'LIC', backendUrl: 'https://svc.example', fetch: fakeFetch({ '/relay/survey': { status: 429, body: { error: 'rate_limited' } } }) })
  assert.deepEqual(await limited.surveySend('ads', ''), { ok: false, error: 'rate_limited' })
  const out = createConnectionTest({ store: memStore(), getToken: () => '', backendUrl: 'https://svc.example', fetch: fakeFetch({}) })
  assert.equal((await out.survey()).error, 'signed_out')
  const offline = createConnectionTest({ store: memStore(), getToken: () => 'LIC', backendUrl: 'https://svc.example', fetch: fakeFetch({ '/relay/survey/me': 'throw' }) })
  assert.equal((await offline.survey()).error, 'unreachable')

  // Usage/me's lifetime total and reset date reach the survey's usage line.
  const info = createConnectionTest({ store: memStore(), getToken: () => 'LIC', backendUrl: 'https://svc.example', fetch: fakeFetch({ '/relay/usage/me': { status: 200, body: { month: '2026-09', enabled: true, free: true, gb: 1.25, capGB: 200, lifetimeGB: 9.5, resetsOn: '2026-10-01' } } }) })
  const ri = await info.relayInfo()
  assert.equal(ri.gb, 1.25)
  assert.equal(ri.lifetimeGB, 9.5)
  assert.equal(ri.resetsOn, '2026-10-01')
  const main = fs.readFileSync(path.join(appRoot, 'electron', 'main.js'), 'utf8')
  for (const ch of ['connection:survey', 'connection:surveySend', 'connection:surveyLater']) assert.ok(main.includes(`ipcMain.handle('${ch}'`), ch)
  const preload = fs.readFileSync(path.join(appRoot, 'electron', 'preload.js'), 'utf8')
  for (const b of ['connectionSurvey:', 'connectionSurveySend:', 'connectionSurveyLater:']) assert.ok(preload.includes(b), b)
})

test('included relay retires the payment survey and offers no ad-funded or per-GB plan', async () => {
  const K = await loadCosts()
  assert.equal(SITE.ads.status, 'disabled')
  assert.equal(SITE.ads.estimatedRevenuePerAdUSD, 0)
  assert.equal(SITE.beeboRelay.usageBillingEnabled, false)
  for (const gb of [0, 1, 6, 60, 1500]) {
    const estimate = K.relayIfFeesStart(PUB, gb)
    assert.equal(estimate.cost, 0)
    assert.equal(estimate.charged, 0)
    assert.equal(estimate.ads, null)
  }
  const card = src('RelaySurvey.jsx')
  assert.match(card, /return null/)
  assert.doesNotMatch(card, /connectionSurveySend|<fieldset|<legend/)
})
