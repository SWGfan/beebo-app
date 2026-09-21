'use strict'
// Webhook formatters and templates (ntfy, Discord, Slack, Gotify, Pushover, generic JSON): the exact
// bytes each service receives, credentials that never show up anywhere, templates that are text and
// never code, the test-send button, and the SSRF wall still standing in front of every format.
// Run: node --test test/webhook-formats.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const webhooks = require('../electron/webhooks')
const formats = require('../electron/webhookFormats')
const { createFixture } = require('./helpers/publicApiFixture')

const fakeStore = (initial = {}) => {
  const data = { ...initial }
  return { data, get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] } }
}

async function receiver(status = 200) {
  const hits = []
  const srv = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => { hits.push({ method: req.method, url: req.url, headers: req.headers, raw: Buffer.concat(chunks).toString('utf8') }); res.writeHead(status); res.end('ok') })
  })
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${srv.address().port}/hook`, hits, close: () => new Promise((resolve) => { srv.closeAllConnections?.(); srv.close(resolve) }) }
}

test.beforeEach(() => {
  webhooks._reset()
  webhooks.configure({ retryDelaysMs: [5, 5], timeoutMs: 2000 })
})

const PLAYBACK = {
  user: { id: 'u1', name: 'Sam' },
  media: { kind: 'movie', title: 'Heat', year: 1995, ids: { tmdb: 949, imdb: 'tt0113277', tvdb: null } },
  positionSeconds: 600,
  durationSeconds: 6000,
  percent: 10,
  session: { id: 'abc', state: 'playing', device: 'Chrome on Windows', location: 'home', playback: 'transcode', transcode: { reason: 'Converting to 720p' } }
}

// ---- pure output ------------------------------------------------------------------------------

test('every format is listed once, and json is the default', () => {
  assert.deepEqual(formats.FORMATS.map((f) => f.id), ['json', 'ntfy', 'discord', 'slack', 'gotify', 'pushover'])
  assert.equal(formats.DEFAULT_FORMAT, 'json')
  assert.equal(formats.render('json', 'playback.started', PLAYBACK), null, 'the signed envelope is webhooks.js\'s own')
  assert.equal(formats.render('carrier-pigeon', 'playback.started', PLAYBACK), null)
})

test('the plain-English description says who did what, and how', () => {
  const started = formats.describe('playback.started', PLAYBACK)
  assert.equal(started.title, 'Sam started Heat')
  assert.equal(started.message, 'Sam started watching Heat. Chrome on Windows · transcoding · 10%')
  assert.equal(formats.describe('playback.paused', PLAYBACK).title, 'Sam paused Heat')
  assert.equal(formats.describe('playback.resumed', PLAYBACK).title, 'Sam resumed Heat')
  assert.equal(formats.describe('playback.stopped', PLAYBACK).title, 'Sam stopped Heat')
  assert.equal(formats.describe('playback.watched', PLAYBACK).title, 'Sam finished Heat')
  const added = formats.describe('request.added', { request: { title: 'Dune', year: 2021 }, requester: { name: 'Sam', note: 'family night' } })
  assert.equal(added.title, 'New request: Dune')
  assert.equal(added.message, 'Sam asked for Dune (2021). "family night"')
  assert.equal(formats.describe('request.approved', { request: { title: 'Dune' } }).title, 'Now available: Dune')
  assert.equal(formats.describe('request.declined', { request: { title: 'Dune' } }).title, 'Request declined: Dune')
  assert.equal(formats.describe('library.item_added', { item: { kind: 'movie', title: 'Ronin', year: 1998 } }).title, 'New in the library: Ronin (1998)')
  assert.equal(formats.describe('library.item_added', { item: { kind: 'episode', show: 'Severance', title: 'Severance — S1E3' } }).title, 'New in the library: Severance — S1E3')
  assert.match(formats.describe('webhook.test', {}, { hookName: 'Phone' }).message, /test from Beebo for "Phone"/)
  assert.equal(formats.describe('something.new', null).title, 'Beebo: something.new', 'an event it has never heard of still reads sensibly')
  const tv = formats.describe('playback.started', { user: { name: 'Sam' }, media: { kind: 'tv', show: 'Severance', season: 1, episode: 3 } })
  assert.equal(tv.title, 'Sam started Severance S1E3')
})

test('ntfy: a text body with Title / Priority / Tags headers, an optional bearer token, non-ASCII safe', () => {
  const out = formats.render('ntfy', 'playback.started', PLAYBACK, { credentials: { token: 'tk_abc123' } })
  assert.equal(out.contentType, 'text/plain; charset=utf-8')
  assert.equal(out.body, 'Sam started watching Heat. Chrome on Windows · transcoding · 10%')
  assert.deepEqual(out.headers, { Title: 'Sam started Heat', Priority: '3', Tags: 'arrow_forward', Authorization: 'Bearer tk_abc123' })
  const noAuth = formats.render('ntfy', 'playback.paused', PLAYBACK, {})
  assert.equal('Authorization' in noAuth.headers, false)
  assert.equal(noAuth.headers.Tags, 'pause_button')
  const accented = formats.render('ntfy', 'playback.started', { ...PLAYBACK, media: { ...PLAYBACK.media, title: 'Amélie 🍿' } }, {})
  assert.match(accented.headers.Title, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/, 'RFC 2047, which ntfy reads, instead of an illegal header byte')
  assert.equal(Buffer.from(accented.headers.Title.slice(10, -2), 'base64').toString('utf8'), 'Sam started Amélie 🍿')
  assert.equal(formats.headerSafe('line one\nInjected: yes'), 'line one Injected: yes', 'a newline can never start another header')
})

test('discord: one embed, no mentions possible, length limits kept', () => {
  const out = formats.render('discord', 'request.added', { request: { title: '@everyone Dune' }, requester: { name: '@here <@&123>', note: 'x'.repeat(5000) } }, { timestamp: '2026-09-21T12:00:00.000Z' })
  assert.equal(out.contentType, 'application/json')
  const body = JSON.parse(out.body)
  assert.deepEqual(body.allowed_mentions, { parse: [] }, 'nothing in a title can ping anyone')
  assert.equal(body.username, 'Beebo')
  assert.equal(body.embeds.length, 1)
  const e = body.embeds[0]
  assert.equal(e.title, 'New request: @everyone Dune')
  assert.equal(e.timestamp, '2026-09-21T12:00:00.000Z')
  assert.ok(e.description.length <= 4000 && e.title.length <= 256)
  assert.equal(typeof e.color, 'number')
  assert.equal(e.footer.text, 'Beebo')
  const playback = JSON.parse(formats.render('discord', 'playback.started', PLAYBACK, {}).body).embeds[0]
  assert.deepEqual(playback.fields.map((f) => f.name), ['Who', 'Type', 'IDs', 'Device', 'Playback', 'Progress'])
  assert.equal(playback.fields.find((f) => f.name === 'IDs').value, 'TMDB 949 · IMDb tt0113277')
  assert.equal(playback.fields.find((f) => f.name === 'Playback').value, 'Transcoding')
})

test('slack: mrkdwn escaped, header + section + context blocks', () => {
  const out = formats.render('slack', 'request.added', { request: { title: 'Fast & <Furious>' }, requester: { name: 'Sam' } }, {})
  const body = JSON.parse(out.body)
  assert.match(body.text, /Fast &amp; &lt;Furious&gt;/, 'the fallback text is escaped')
  assert.deepEqual(body.blocks.map((b) => b.type), ['header', 'section', 'context'])
  assert.equal(body.blocks[0].text.type, 'plain_text')
  assert.equal(body.blocks[1].text.type, 'mrkdwn')
  assert.match(body.blocks[1].text.text, /Fast &amp; &lt;Furious&gt;/, 'a title cannot become a Slack link or mention')
  assert.doesNotMatch(body.blocks[1].text.text, /<Furious>/)
  assert.match(body.blocks[2].elements[0].text, /request\.added/)
})

test('gotify: the app token goes in a header, priority scaled to gotify\'s 0-10', () => {
  const out = formats.render('gotify', 'playback.started', PLAYBACK, { credentials: { token: 'Aabc.def' } })
  assert.equal(out.headers['X-Gotify-Key'], 'Aabc.def')
  const body = JSON.parse(out.body)
  assert.equal(body.title, 'Sam started Heat')
  assert.equal(body.priority, 6)
  assert.equal(body.extras['client::display'].contentType, 'text/plain')
  assert.equal(out.body.includes('Aabc.def'), false, 'and never in the message')
})

test('pushover: token and user key in the JSON body, its own priority scale, a timestamp', () => {
  const out = formats.render('pushover', 'request.declined', { request: { title: 'Dune' } }, { credentials: { appToken: 'aaa', userKey: 'uuu' }, timestamp: '2026-09-21T12:00:00.000Z' })
  const body = JSON.parse(out.body)
  assert.equal(body.token, 'aaa')
  assert.equal(body.user, 'uuu')
  assert.equal(body.title, 'Request declined: Dune')
  assert.equal(body.priority, -1)
  assert.equal(body.timestamp, Date.parse('2026-09-21T12:00:00.000Z') / 1000)
  assert.equal(JSON.parse(formats.render('pushover', 'request.added', { request: { title: 'x' } }, { credentials: { appToken: 'a', userKey: 'u' } }).body).priority, 0)
})

test('templates are text substitution, never code', () => {
  const ctx = { ...PLAYBACK, event: 'playback.started', hook: { name: 'Phone' }, title: 'DEFAULT TITLE', message: 'DEFAULT MESSAGE' }
  const r = formats.renderTemplate
  assert.equal(r('{{user.name}} is watching {{media.title}} ({{media.year}})', ctx), 'Sam is watching Heat (1995)')
  assert.equal(r('{{ user.name }}: {{percent}}%', ctx), 'Sam: 10%')
  assert.equal(r('{{session.device}} / {{session.playback}} / {{media.ids.imdb}}', ctx), 'Chrome on Windows / transcode / tt0113277')
  assert.equal(r('{{nope}}|{{user.nope.deeper}}|{{media}}|{{user}}', ctx), '|||', 'unknown paths and whole objects are empty')
  assert.equal(r('{{__proto__.polluted}}{{constructor.name}}{{toString}}', ctx), '', 'nothing inherited is reachable')
  assert.equal(r('{{ process.env.HOME }}{{ require("fs") }}${1+1}{{1+1}}', ctx), '{{ require("fs") }}${1+1}{{1+1}}', 'nothing is evaluated: what is not a plain path is left as typed')
  assert.equal(r('{{message}} 🍿', ctx), 'DEFAULT MESSAGE 🍿', 'the default text can be extended')
  assert.equal(r('a\nb\r\nc\t{{user.name}}', ctx), 'a b c Sam', 'one line')
  assert.equal(formats.cleanTemplate('x'.repeat(formats.TEMPLATE_MAX + 1)).ok, false)
  assert.equal(formats.cleanTemplate('').template, '')
  assert.equal(formats.cleanTemplate(null).ok, true)

  const out = formats.render('ntfy', 'playback.started', PLAYBACK, { hook: { name: 'Phone', titleTemplate: '🎬 {{user.name}}', messageTemplate: '{{media.title}} on {{session.device}}' } })
  assert.equal(Buffer.from(out.headers.Title.slice(10, -2), 'base64').toString('utf8'), '🎬 Sam')
  assert.equal(out.body, 'Heat on Chrome on Windows')
})

test('credentials: only the fields a format knows, visible ASCII, length-limited, required ones enforced', () => {
  assert.deepEqual(formats.cleanCredentials('gotify', { token: ' Abc123 ', extra: 'ignored' }), { ok: true, credentials: { token: 'Abc123' } })
  assert.deepEqual(formats.cleanCredentials('discord', { token: 'ignored' }), { ok: true, credentials: {} }, 'a format with none keeps none')
  assert.equal(formats.cleanCredentials('gotify', { token: 'has space' }).ok, false)
  assert.equal(formats.cleanCredentials('gotify', { token: 'new\nline' }).ok, false, 'no header injection through a pasted token')
  assert.equal(formats.cleanCredentials('gotify', { token: 'x'.repeat(201) }).ok, false)
  assert.equal(formats.cleanCredentials('ntfy', { token: 'té' }).field, 'token')
  assert.equal(formats.missingCredential('gotify', {}, 'https://g.example/message'), 'token')
  assert.equal(formats.missingCredential('gotify', {}, 'https://g.example/message?token=abc'), null, 'a token in the address counts')
  assert.equal(formats.missingCredential('pushover', { appToken: 'a' }, ''), 'userKey')
  assert.equal(formats.missingCredential('ntfy', {}, 'https://ntfy.sh/x'), null, 'ntfy\'s token is optional')
  assert.equal(formats.missingCredential('slack', {}, 'https://hooks.slack.com/x'), null)
})

test('what a screen may show of an address: chat webhook paths and query strings are secrets', () => {
  assert.equal(formats.displayUrl('discord', 'https://discord.com/api/webhooks/123/SECRETTOKEN'), 'https://discord.com/…')
  assert.equal(formats.displayUrl('slack', 'https://hooks.slack.com/services/T0/B0/XXXX'), 'https://hooks.slack.com/…')
  assert.equal(formats.displayUrl('gotify', 'https://gotify.example/message?token=SECRET'), 'https://gotify.example/message?…')
  assert.equal(formats.displayUrl('ntfy', 'https://ntfy.sh/my-topic'), 'https://ntfy.sh/my-topic')
  assert.equal(formats.displayUrl('json', 'not a url'), '')
})

// ---- configuration ----------------------------------------------------------------------------

test('create and update: format, credentials, templates validated; credentials never listed', async (t) => {
  const store = fakeStore()
  const rx = await receiver()
  t.after(rx.close)
  const base = { name: 'Phone', url: rx.url, events: ['request.added'], allowPrivateNetwork: true }
  assert.equal((await webhooks.create(store, { ...base, format: 'carrier-pigeon' })).error, 'bad_format')
  assert.deepEqual(await webhooks.create(store, { ...base, format: 'gotify' }), { ok: false, error: 'bad_credentials', field: 'token' })
  assert.equal((await webhooks.create(store, { ...base, format: 'gotify', credentials: { token: 'bad token' } })).error, 'bad_credentials')
  assert.equal((await webhooks.create(store, { ...base, format: 'ntfy', messageTemplate: 'x'.repeat(600) })).error, 'bad_template')
  assert.equal((await webhooks.create(store, { ...base, format: 'pushover', credentials: { appToken: 'a' } })).field, 'userKey')
  assert.equal(store.data.webhooks, undefined, 'nothing was saved by any of those')

  const made = await webhooks.create(store, { ...base, format: 'gotify', credentials: { token: 'Gsecret1' }, titleTemplate: '{{title}}!' })
  assert.equal(made.ok, true)
  assert.equal(made.hook.format, 'gotify')
  assert.deepEqual(made.hook.credentialsSet, ['token'], 'only the NAME of what is set')
  assert.equal(made.hook.titleTemplate, '{{title}}!')
  assert.doesNotMatch(JSON.stringify(webhooks.list(store)), /Gsecret1/)
  assert.doesNotMatch(JSON.stringify(made), /Gsecret1/)
  assert.equal(store.data.webhooks[0].credentials.token, 'Gsecret1', 'kept for sending (encrypted at rest by secretSettings)')

  // A plain JSON hook is exactly what it always was.
  const json = await webhooks.create(store, base)
  assert.equal(json.hook.format, 'json')
  assert.deepEqual(json.hook.credentialsSet, [])
  assert.equal(json.hook.url, rx.url)
  const ignored = await webhooks.create(store, { ...base, titleTemplate: 'ignored for json' })
  assert.equal(ignored.hook.titleTemplate, '', 'the signed envelope is never reworded')

  // Update: credentials merge, an empty value removes, switching format drops the old format's credentials.
  const up = await webhooks.update(store, made.hook.id, { credentials: { token: 'Gnew2' } })
  assert.equal(up.ok, true)
  assert.equal(store.data.webhooks[0].credentials.token, 'Gnew2')
  assert.equal((await webhooks.update(store, made.hook.id, { credentials: { token: '' } })).error, 'bad_credentials', 'gotify cannot lose its only credential')
  assert.equal(store.data.webhooks[0].credentials.token, 'Gnew2', 'and a refused update changed nothing')
  const swapped = await webhooks.update(store, made.hook.id, { format: 'slack' })
  assert.equal(swapped.ok, true)
  assert.deepEqual(store.data.webhooks[0].credentials, {})
  assert.equal(swapped.hook.format, 'slack')
  const reworded = await webhooks.update(store, made.hook.id, { messageTemplate: '{{user.name}} did it' })
  assert.equal(reworded.hook.messageTemplate, '{{user.name}} did it')
  assert.equal(reworded.hook.format, 'slack', 'other fields untouched')
  assert.equal((await webhooks.update(store, made.hook.id, { format: 'nope' })).error, 'bad_format')
})

test('pushover needs no address: the service\'s own is filled in', async () => {
  const store = fakeStore()
  const made = await webhooks.create(store, { name: 'Pushover', format: 'pushover', credentials: { appToken: 'aaa', userKey: 'uuu' }, events: ['request.added'] })
  assert.equal(made.ok, true, JSON.stringify(made))
  assert.equal(made.hook.url, 'https://api.pushover.net/1/messages.json')
})

test('chat-service webhook addresses are shown masked, and the mask is what listings carry', async () => {
  const store = fakeStore()
  const made = await webhooks.create(store, { name: 'Discord', format: 'discord', url: 'https://discord.com/api/webhooks/123456/TOKENTOKENTOKEN', events: ['request.added'] })
  assert.equal(made.ok, true)
  assert.equal(made.hook.url, 'https://discord.com/…')
  assert.doesNotMatch(JSON.stringify(webhooks.list(store)), /TOKENTOKENTOKEN/)
  assert.equal(store.data.webhooks[0].url, 'https://discord.com/api/webhooks/123456/TOKENTOKENTOKEN', 'the real address is kept for sending')
})

// ---- delivery ---------------------------------------------------------------------------------

test('each format reaches its receiver with the right headers and body, signed, and the test button uses it', async (t) => {
  const store = fakeStore()
  const rx = await receiver()
  t.after(rx.close)
  const mk = async (format, extra = {}) => (await webhooks.create(store, { name: format, format, url: `${rx.url}/${format}`, events: ['request.added'], allowPrivateNetwork: true, ...extra })).hook
  const hooks = {
    json: await mk('json'),
    ntfy: await mk('ntfy', { credentials: { token: 'tk_ntfy' } }),
    discord: await mk('discord'),
    slack: await mk('slack'),
    gotify: await mk('gotify', { credentials: { token: 'Ggotify' } }),
    pushover: await mk('pushover', { credentials: { appToken: 'appT', userKey: 'usrK' } })
  }
  for (const h of Object.values(hooks)) {
    const r = await webhooks.sendTest(store, h.id)
    assert.equal(r.delivery.ok, true, h.name + ' ' + JSON.stringify(r))
  }
  const by = (format) => rx.hits.find((h) => h.url === `/hook/${format}`)
  for (const format of Object.keys(hooks)) {
    const hit = by(format)
    assert.ok(hit, format + ' arrived')
    assert.equal(hit.method, 'POST')
    assert.equal(hit.headers['x-beebo-event'], 'webhook.test', format)
    assert.match(hit.headers['x-beebo-signature'], /^t=\d+,v1=[0-9a-f]{64}$/, format + ' is signed whatever its shape')
    assert.equal(hit.headers['user-agent'], 'Beebo-Webhook/1')
  }
  const envelope = JSON.parse(by('json').raw)
  assert.equal(envelope.event, 'webhook.test')
  assert.equal(envelope.data.webhook.name, 'json')
  assert.equal(envelope.data.user.name, 'Test user', 'the test carries an example so a template can be tried')
  assert.equal(by('json').headers['content-type'], 'application/json')

  const ntfy = by('ntfy')
  assert.equal(ntfy.headers['content-type'], 'text/plain; charset=utf-8')
  assert.equal(ntfy.headers.title, 'Beebo test')
  assert.equal(ntfy.headers.authorization, 'Bearer tk_ntfy')
  assert.match(ntfy.raw, /^This is a test from Beebo for "ntfy"\./)
  assert.equal(JSON.parse(by('discord').raw).embeds[0].title, 'Beebo test')
  assert.equal(JSON.parse(by('slack').raw).blocks[0].text.text, 'Beebo test')
  assert.equal(by('gotify').headers['x-gotify-key'], 'Ggotify')
  assert.equal(JSON.parse(by('gotify').raw).title, 'Beebo test')
  const pushover = JSON.parse(by('pushover').raw)
  assert.equal(pushover.token, 'appT')
  assert.equal(pushover.user, 'usrK')

  // A real event, reworded by a template.
  await webhooks.update(store, hooks.ntfy.id, { titleTemplate: '{{requester.name}} asked', messageTemplate: '{{request.title}}? Sure.' })
  rx.hits.length = 0
  webhooks.emitRequestAdded(store, { id: 'r1', kind: 'movie', title: 'Dune', year: 2021, requestedBy: [{ userId: 'u1', userName: 'Sam' }] }, { userId: 'u1', userName: 'Sam' })
  await webhooks.whenIdle()
  const ask = by('ntfy')
  assert.equal(ask.headers.title, 'Sam asked')
  assert.equal(ask.raw, 'Dune? Sure.')
  assert.equal(JSON.parse(by('discord').raw).embeds[0].title, 'New request: Dune')
  assert.equal(rx.hits.length, 6)
})

test('credentials never reach the delivery log, the listing, or a template', async (t) => {
  const store = fakeStore()
  const rx = await receiver()
  t.after(rx.close)
  const made = await webhooks.create(store, { name: 'Gotify', format: 'gotify', url: rx.url + '?token=URLTOKEN', credentials: { token: 'HEADERTOKEN' }, messageTemplate: '{{credentials.token}}|{{hook.credentials}}|{{token}}', events: ['request.added'], allowPrivateNetwork: true })
  assert.equal(made.ok, true)
  await webhooks.sendTest(store, made.hook.id)
  const seen = JSON.stringify([webhooks.getLog(store), webhooks.list(store), made.hook])
  assert.doesNotMatch(seen, /HEADERTOKEN|URLTOKEN/)
  assert.equal(JSON.parse(rx.hits[0].raw).message, '||', 'no path in a template reaches a credential')
})

test('the SSRF wall stands in front of every format: LAN needs the box ticked, metadata never, redirects not followed', async (t) => {
  const store = fakeStore()
  const rx = await receiver()
  t.after(rx.close)
  for (const format of ['ntfy', 'discord', 'slack', 'gotify', 'pushover']) {
    const cred = { gotify: { token: 't' }, pushover: { appToken: 'a', userKey: 'u' } }[format]
    const lan = await webhooks.create(store, { name: format, format, url: 'http://192.168.1.50:8080/x', credentials: cred, events: ['request.added'] })
    assert.equal(lan.error, 'blocked_private', format + ': a home-network address is refused unless ticked')
    const local = await webhooks.create(store, { name: format, format, url: rx.url, credentials: cred, events: ['request.added'] })
    assert.equal(local.error, 'blocked_private', format + ': and so is this computer')
    const meta = await webhooks.create(store, { name: format, format, url: 'http://169.254.169.254/latest/meta-data', credentials: cred, events: ['request.added'], allowPrivateNetwork: true })
    assert.equal(meta.error, 'blocked_address', format + ': the cloud metadata address, whatever is ticked')
    const v6 = await webhooks.create(store, { name: format, format, url: 'http://[fe80::1]/x', credentials: cred, events: ['request.added'], allowPrivateNetwork: true })
    assert.equal(v6.error, 'blocked_address', format + ': link-local IPv6')
    const mapped = await webhooks.create(store, { name: format, format, url: 'http://[::ffff:169.254.169.254]/x', credentials: cred, events: ['request.added'], allowPrivateNetwork: true })
    assert.equal(mapped.error, 'blocked_address', format + ': the metadata address wearing an IPv6 coat')
    assert.equal((await webhooks.create(store, { name: format, format, url: 'file:///etc/passwd', credentials: cred, events: ['request.added'] })).error, 'bad_url')
    assert.equal((await webhooks.create(store, { name: format, format, url: 'http://user:pw@example.com/x', credentials: cred, events: ['request.added'] })).error, 'bad_url')
  }
  assert.equal(store.data.webhooks, undefined, 'none of those were saved')

  // Saved with the box ticked, then unticked: the next delivery is refused at send time, not just at save time.
  const made = await webhooks.create(store, { name: 'Phone', format: 'ntfy', url: rx.url, events: ['request.added'], allowPrivateNetwork: true })
  assert.equal(made.ok, true)
  assert.equal((await webhooks.update(store, made.hook.id, { allowPrivateNetwork: false })).error, 'blocked_private')
  store.data.webhooks[0].allowPrivateNetwork = false // as if edited by hand
  const test = await webhooks.sendTest(store, made.hook.id)
  assert.equal(test.delivery.ok, false)
  assert.match(test.delivery.error, /refused: private network/)
  assert.equal(rx.hits.length, 0, 'nothing was sent')

  // A receiver that redirects to the metadata address is not followed.
  const bounce = http.createServer((req, res) => { req.resume(); res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' }); res.end() })
  await new Promise((resolve) => bounce.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => { bounce.closeAllConnections?.(); bounce.close(resolve) }))
  const redirecting = await webhooks.create(store, { name: 'Bounce', format: 'slack', url: `http://127.0.0.1:${bounce.address().port}/x`, events: ['request.added'], allowPrivateNetwork: true })
  const r = await webhooks.sendTest(store, redirecting.hook.id)
  assert.equal(r.delivery.ok, false)
  assert.match(r.delivery.error, /redirects are not followed/)
})

// ---- over HTTP --------------------------------------------------------------------------------

test('admin routes: formats are listed, created, edited and tested; only admins reach them', async (t) => {
  const f = await createFixture(t)
  const rx = await receiver()
  t.after(rx.close)
  const list = await f.admin('/api/admin/webhooks')
  assert.equal(list.status, 200)
  assert.deepEqual(list.body.formats.map((x) => x.id), ['json', 'ntfy', 'discord', 'slack', 'gotify', 'pushover'])
  assert.ok(list.body.events.some((e) => e.id === 'playback.paused'))

  const bad = await f.admin('/api/admin/webhooks/create', { name: 'G', url: rx.url, events: ['request.added'], allowPrivateNetwork: true, format: 'gotify' })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error, 'bad_credentials')
  assert.equal(bad.body.field, 'token')

  const made = await f.admin('/api/admin/webhooks/create', { name: 'Gotify', url: rx.url, events: ['request.added'], allowPrivateNetwork: true, format: 'gotify', credentials: { token: 'Gover-http' }, messageTemplate: '{{title}} :)' })
  assert.equal(made.status, 200, made.text)
  assert.equal(made.body.hook.format, 'gotify')
  const listed = await f.admin('/api/admin/webhooks')
  assert.doesNotMatch(listed.text, /Gover-http/, 'the listing carries no credential')
  assert.deepEqual(listed.body.hooks[0].credentialsSet, ['token'])

  const test = await f.admin('/api/admin/webhooks/test', { id: made.body.hook.id })
  assert.equal(test.body.delivery.ok, true)
  assert.equal(rx.hits[0].headers['x-gotify-key'], 'Gover-http')
  assert.equal(JSON.parse(rx.hits[0].raw).message, 'Beebo test :)')

  const edited = await f.admin('/api/admin/webhooks/update', { id: made.body.hook.id, messageTemplate: '' })
  assert.equal(edited.status, 200)
  assert.equal(edited.body.hook.messageTemplate, '')

  assert.equal((await f.admin('/api/admin/webhooks/create', { name: 'x', url: 'https://93.184.216.34/', events: ['request.added'], format: 'ntfy' }, 'member')).status, 403)
  const key = await f.admin('/api/admin/api-keys/create', { name: 'k', scopes: ['library', 'history', 'now-playing', 'metrics'] })
  const viaKey = await f.call(key.body.token, '/api/admin/webhooks/test', { method: 'POST', body: { id: made.body.hook.id } })
  assert.equal(viaKey.status, 403)
  assert.equal(viaKey.body.error, 'api_key_scope')
  assert.equal(rx.hits.length, 1, 'no second test was sent through a key')
})

test('web admin: the webhooks tab offers the formats and saves a notification hook with its credentials', async (t) => {
  const { webAdmin } = require('./helpers/publicApiFixture')
  const f = await createFixture(t)
  const web = webAdmin(f)
  if (!web) { t.skip('openssl not available'); return }
  const page = await web('GET', '/admin?tab=webhooks')
  assert.equal(page.status, 200)
  for (const label of ['Generic JSON (signed)', 'ntfy', 'Discord', 'Slack', 'Gotify', 'Pushover']) assert.ok(page.body.includes(label), label)
  assert.match(page.body, /name="credential_token"/)
  assert.match(page.body, /name="titleTemplate"/)
  assert.match(page.body, /Playback paused/)

  const made = await web('POST', '/admin/webhooks/create', { tab: 'webhooks', name: 'Phone', format: 'gotify', url: 'https://93.184.216.34/message', credential_token: 'WEBGOTIFYTOKEN', credential_appToken: '', credential_userKey: '', titleTemplate: '', messageTemplate: '{{message}}!', 'event_playback.started': '1' })
  assert.equal(made.status, 303)
  assert.equal(f.data.webhooks.length, 1)
  assert.equal(f.data.webhooks[0].format, 'gotify')
  assert.deepEqual(f.data.webhooks[0].credentials, { token: 'WEBGOTIFYTOKEN' }, 'the empty boxes are not empty credentials')
  assert.equal(f.data.webhooks[0].messageTemplate, '{{message}}!')
  const tab = await web('GET', '/admin?tab=webhooks')
  assert.match(tab.body, /Gotify \u00b7 credentials saved/)
  assert.doesNotMatch(tab.body, /WEBGOTIFYTOKEN/, 'the credential is never shown again')
  const missing = await web('POST', '/admin/webhooks/create', { tab: 'webhooks', name: 'No token', format: 'gotify', url: 'https://93.184.216.34/message', 'event_playback.started': '1' })
  assert.equal(missing.status, 303)
  assert.match((await web('GET', missing.headers.location)).body, /needs a token or key that is missing/)
  assert.equal(f.data.webhooks.length, 1)
})

test('switching a hook to Pushover fills in its fixed address; switching between others keeps the address', async (t) => {
  const store = fakeStore()
  const rx = await receiver()
  t.after(rx.close)
  const made = await webhooks.create(store, { name: 'Hook', url: rx.url, events: ['request.added'], allowPrivateNetwork: true })
  const up = await webhooks.update(store, made.hook.id, { format: 'pushover', credentials: { appToken: 'a', userKey: 'u' } })
  assert.equal(up.ok, true, JSON.stringify(up))
  assert.equal(store.data.webhooks[0].url, 'https://api.pushover.net/1/messages.json')
  assert.equal(up.hook.url, 'https://api.pushover.net/1/messages.json')
  const back = await webhooks.update(store, made.hook.id, { format: 'json', url: rx.url })
  assert.equal(back.ok, true)
  assert.equal(store.data.webhooks[0].url, rx.url)
  assert.deepEqual(store.data.webhooks[0].credentials, {}, 'a format that has none keeps none')
})
