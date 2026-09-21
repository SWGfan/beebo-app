'use strict'
// Webhook formatters: the same Beebo event, dressed for whatever is listening.
//
// A webhook is one of these formats:
//   json      Beebo's own signed envelope { event, timestamp, data } (the default; Home Assistant, n8n, scripts)
//   ntfy      https://ntfy.sh style: text body, Title / Priority / Tags headers, optional access token
//   discord   Discord incoming webhook: one embed, mentions switched off
//   slack     Slack incoming webhook (also accepted by Mattermost and Rocket.Chat): text + blocks
//   gotify    Gotify: JSON message, the app token goes in the X-Gotify-Key header
//   pushover  Pushover: JSON message with the app token and the user key
//
// Every format except `json` shows people a short notification, so they share one plain-English
// description of the event (describe()), which the owner can reword with a template
// ("{{user.name}} is watching {{media.title}}"). Templates are a tiny {{path}} substitution, never
// code: an unknown path is an empty string and nothing is evaluated.
//
// Nothing here talks to the network or the store. It turns (event, data) into
// { contentType, headers, body }; webhooks.js does the delivery, and only that code adds the
// signature header. Credentials (a Gotify token, a Pushover key) arrive as a plain object and are
// only ever placed in the outgoing request: they are not part of any text a template can reach.

const FORMATS = Object.freeze([
  { id: 'json', label: 'Generic JSON (signed)', blurb: 'Beebo\'s own message. Home Assistant, n8n, your own script.', needsUrl: true, credentials: [] },
  { id: 'ntfy', label: 'ntfy', blurb: 'Push notifications to your phone. Use the topic address, for example https://ntfy.sh/my-beebo.', needsUrl: true, credentials: [{ id: 'token', label: 'Access token (only for a protected topic)', required: false }] },
  { id: 'discord', label: 'Discord', blurb: 'A channel\'s webhook address (Channel settings, Integrations, Webhooks).', needsUrl: true, credentials: [] },
  { id: 'slack', label: 'Slack', blurb: 'An incoming-webhook address. Mattermost and Rocket.Chat accept the same.', needsUrl: true, credentials: [] },
  { id: 'gotify', label: 'Gotify', blurb: 'Your Gotify server\'s /message address, plus an application token.', needsUrl: true, credentials: [{ id: 'token', label: 'Application token', required: true }] },
  { id: 'pushover', label: 'Pushover', blurb: 'Needs your application token and your user key. The address is filled in for you.', needsUrl: false, defaultUrl: 'https://api.pushover.net/1/messages.json', credentials: [{ id: 'appToken', label: 'Application token', required: true }, { id: 'userKey', label: 'User key', required: true }] }
])
const FORMAT_IDS = new Set(FORMATS.map((f) => f.id))
const DEFAULT_FORMAT = 'json'

const TEMPLATE_MAX = 500
const CREDENTIAL_MAX = 200
const TITLE_MAX = 250
const MESSAGE_MAX = 1000

const str = (v) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v))
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const oneLine = (s) => str(s).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()

function formatInfo(id) {
  return FORMATS.find((f) => f.id === id) || null
}

// ----- credentials ---------------------------------------------------------------------------

// Visible ASCII only, no spaces: these end up in HTTP headers or JSON, and a stray newline in a
// pasted token must not become a header-injection.
function cleanCredentials(format, raw) {
  const info = formatInfo(format)
  const out = {}
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  for (const c of info ? info.credentials : []) {
    const v = src[c.id]
    if (v === undefined || v === null || v === '') continue
    const text = String(v).trim()
    if (!text || text.length > CREDENTIAL_MAX || !/^[\x21-\x7e]+$/.test(text)) return { ok: false, field: c.id }
    out[c.id] = text
  }
  return { ok: true, credentials: out }
}

// Which required credential is missing (a Gotify hook may carry its token in the address instead).
function missingCredential(format, credentials, url) {
  const info = formatInfo(format)
  if (!info) return null
  for (const c of info.credentials) {
    if (!c.required || (credentials && credentials[c.id])) continue
    if (format === 'gotify' && /[?&]token=[^&\s]+/.test(str(url))) continue
    return c.id
  }
  return null
}

// ----- templates -----------------------------------------------------------------------------

function pick(obj, dotted) {
  let cur = obj
  for (const part of String(dotted).split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return ''
    if (!Object.prototype.hasOwnProperty.call(cur, part)) return ''
    cur = cur[part]
  }
  return typeof cur === 'string' || typeof cur === 'number' || typeof cur === 'boolean' ? String(cur) : ''
}

// {{path}} or {{ path }}: letters, digits, dot, underscore and dash only. Anything else is left as typed.
function renderTemplate(template, context) {
  return oneLine(str(template).slice(0, TEMPLATE_MAX).replace(/\{\{\s*([A-Za-z0-9_.-]{1,60})\s*\}\}/g, (_m, path) => pick(context, path)))
}

function cleanTemplate(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, template: '' }
  const text = String(raw).replace(/\r/g, '').trim()
  if (text.length > TEMPLATE_MAX) return { ok: false }
  return { ok: true, template: text }
}

// ----- what an event says, in words ----------------------------------------------------------

const mediaName = (media) => {
  if (!media) return 'something'
  const t = str(media.title)
  if (t) return t
  if (media.show) return `${media.show}${media.season != null && media.episode != null ? ` S${media.season}E${media.episode}` : ''}`
  return 'something'
}

const who = (data) => str((data && data.user && data.user.name) || (data && data.requester && data.requester.name)) || 'Someone'

function playbackLine(data) {
  const s = data.session || {}
  const bits = []
  if (s.device) bits.push(str(s.device))
  if (s.playback) bits.push(s.playback === 'transcode' ? 'transcoding' : 'direct play')
  if (Number.isFinite(data.percent) && data.durationSeconds > 0) bits.push(`${data.percent}%`)
  return bits.join(' · ')
}

// { title, message, priority (1 low - 5 urgent), tags[], color (int), fields[{name,value}], link }
function describe(event, data, { hookName = '' } = {}) {
  const d = data && typeof data === 'object' ? data : {}
  const at = playbackLine(d)
  const item = mediaName(d.media)
  let out
  switch (event) {
    case 'request.added': {
      const r = d.request || {}
      out = { title: `New request: ${str(r.title) || 'a title'}`, message: `${who(d)} asked for ${str(r.title) || 'a title'}${r.year ? ` (${r.year})` : ''}.${d.requester && d.requester.note ? ` "${str(d.requester.note)}"` : ''}`, priority: 3, tags: ['inbox_tray'], color: 0x5865f2 }
      break
    }
    case 'request.approved': {
      const r = d.request || {}
      out = { title: `Now available: ${str(r.title) || 'your request'}`, message: `${str(r.title) || 'A requested title'} is in the library.`, priority: 3, tags: ['white_check_mark'], color: 0x2ecc71 }
      break
    }
    case 'request.declined': {
      const r = d.request || {}
      out = { title: `Request declined: ${str(r.title) || 'a title'}`, message: `${str(r.title) || 'A request'} will not be added.`, priority: 2, tags: ['x'], color: 0xe74c3c }
      break
    }
    case 'playback.started':
      out = { title: `${who(d)} started ${item}`, message: [`${who(d)} started watching ${item}.`, at].filter(Boolean).join(' '), priority: 3, tags: ['arrow_forward'], color: 0x3498db }
      break
    case 'playback.paused':
      out = { title: `${who(d)} paused ${item}`, message: [`${who(d)} paused ${item}.`, at].filter(Boolean).join(' '), priority: 2, tags: ['pause_button'], color: 0xf1c40f }
      break
    case 'playback.resumed':
      out = { title: `${who(d)} resumed ${item}`, message: [`${who(d)} is watching ${item} again.`, at].filter(Boolean).join(' '), priority: 2, tags: ['arrow_forward'], color: 0x3498db }
      break
    case 'playback.stopped':
      out = { title: `${who(d)} stopped ${item}`, message: [`${who(d)} stopped watching ${item}.`, at].filter(Boolean).join(' '), priority: 2, tags: ['stop_button'], color: 0x95a5a6 }
      break
    case 'playback.progress':
      out = { title: `${who(d)} is watching ${item}`, message: [`${who(d)} is watching ${item}.`, at].filter(Boolean).join(' '), priority: 1, tags: ['movie_camera'], color: 0x3498db }
      break
    case 'playback.watched':
      out = { title: `${who(d)} finished ${item}`, message: `${who(d)} finished ${item}.`, priority: 2, tags: ['tada'], color: 0x2ecc71 }
      break
    case 'library.item_added': {
      const it = d.item || {}
      const name = it.kind === 'episode' ? str(it.title) || str(it.show) : `${str(it.title) || 'A title'}${it.year ? ` (${it.year})` : ''}`
      out = { title: `New in the library: ${name}`, message: `${name} was added to the library.`, priority: 2, tags: ['sparkles'], color: 0x9b59b6 }
      break
    }
    case 'webhook.test':
      out = { title: 'Beebo test', message: `This is a test from Beebo${hookName ? ` for "${hookName}"` : ''}. If you can read this, it works.`, priority: 2, tags: ['white_check_mark'], color: 0x2ecc71 }
      break
    default:
      out = { title: `Beebo: ${event}`, message: `Beebo sent the event ${event}.`, priority: 3, tags: ['bell'], color: 0x95a5a6 }
  }
  out.fields = fieldsFor(d)
  out.link = null
  return out
}

function fieldsFor(d) {
  const f = []
  if (d.user && d.user.name) f.push({ name: 'Who', value: str(d.user.name) })
  if (d.media) {
    if (d.media.kind) f.push({ name: 'Type', value: d.media.kind === 'tv' ? 'Episode' : 'Movie' })
    const ids = d.media.ids || {}
    const idText = [ids.tmdb ? `TMDB ${ids.tmdb}` : '', ids.imdb ? `IMDb ${ids.imdb}` : '', ids.tvdb ? `TVDB ${ids.tvdb}` : ''].filter(Boolean).join(' · ')
    if (idText) f.push({ name: 'IDs', value: idText })
  }
  const s = d.session
  if (s) {
    if (s.device) f.push({ name: 'Device', value: str(s.device) })
    if (s.playback) f.push({ name: 'Playback', value: s.playback === 'transcode' ? 'Transcoding' : 'Direct play' })
  }
  if (Number.isFinite(d.percent) && d.durationSeconds > 0) f.push({ name: 'Progress', value: `${d.percent}%` })
  return f
}

// The words a template can use: everything in `data`, plus event, hook.name, title and message
// (the defaults), so "{{message}} 🍿" adds to the standard text instead of replacing it.
function templateContext(event, data, note, hookName) {
  return { ...(data && typeof data === 'object' ? data : {}), event, hook: { name: hookName || '' }, title: note.title, message: note.message }
}

function compose(event, data, { hookName = '', titleTemplate = '', messageTemplate = '' } = {}) {
  const note = describe(event, data, { hookName })
  const ctx = templateContext(event, data, note, hookName)
  const title = titleTemplate ? renderTemplate(titleTemplate, ctx) : ''
  const message = messageTemplate ? renderTemplate(messageTemplate, ctx) : ''
  return { ...note, title: clip(oneLine(title || note.title), TITLE_MAX), message: clip(message || oneLine(note.message), MESSAGE_MAX) }
}

// ----- per-service bodies --------------------------------------------------------------------

// HTTP header values are Latin-1 at best; ntfy reads RFC 2047 encoded words, so an accented title
// or an emoji survives instead of throwing in Node's header check.
function headerSafe(text) {
  const t = oneLine(text)
  return /^[\x20-\x7e]*$/.test(t) ? t : `=?UTF-8?B?${Buffer.from(t, 'utf8').toString('base64')}?=`
}

// Slack's only escapes: & < >
const slackEscape = (s) => str(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const priorityForPushover = (p) => (p >= 5 ? 1 : p >= 4 ? 1 : p <= 1 ? -1 : p === 2 ? -1 : 0)

function serialize(format, note, { event, timestamp, credentials = {} } = {}) {
  const iso = timestamp || new Date().toISOString()
  switch (format) {
    case 'ntfy': {
      const headers = { Title: headerSafe(note.title), Priority: String(note.priority), Tags: note.tags.join(',') }
      if (credentials.token) headers.Authorization = `Bearer ${credentials.token}`
      return { contentType: 'text/plain; charset=utf-8', headers, body: note.message }
    }
    case 'discord': {
      const embed = {
        title: clip(note.title, 256),
        description: clip(note.message, 4000),
        color: note.color,
        timestamp: iso,
        footer: { text: 'Beebo' },
        fields: note.fields.slice(0, 10).map((f) => ({ name: clip(f.name, 256), value: clip(f.value || '-', 1024), inline: true }))
      }
      // No @everyone / @here / role pings, whatever a title or a note contains.
      return { contentType: 'application/json', headers: {}, body: JSON.stringify({ username: 'Beebo', allowed_mentions: { parse: [] }, embeds: [embed] }) }
    }
    case 'slack': {
      const blocks = [
        { type: 'header', text: { type: 'plain_text', text: clip(note.title, 150), emoji: true } },
        { type: 'section', text: { type: 'mrkdwn', text: clip(slackEscape(note.message), 2900) } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: `Beebo · ${slackEscape(event)}` }] }
      ]
      return { contentType: 'application/json', headers: {}, body: JSON.stringify({ text: clip(slackEscape(`${note.title}: ${note.message}`), 3000), blocks }) }
    }
    case 'gotify': {
      const headers = credentials.token ? { 'X-Gotify-Key': credentials.token } : {}
      return { contentType: 'application/json', headers, body: JSON.stringify({ title: note.title, message: note.message, priority: Math.min(10, note.priority * 2), extras: { 'client::display': { contentType: 'text/plain' } } }) }
    }
    case 'pushover': {
      return {
        contentType: 'application/json',
        headers: {},
        body: JSON.stringify({ token: credentials.appToken || '', user: credentials.userKey || '', title: clip(note.title, 250), message: clip(note.message, 1024), priority: priorityForPushover(note.priority), timestamp: Math.floor(Date.parse(iso) / 1000) || undefined })
      }
    }
    default:
      return null
  }
}

// One call for the delivery code. `json` is deliberately not handled here: it is the envelope the
// signature is defined over, so webhooks.js builds it itself. Returns null for it.
function render(format, event, data, { hook = {}, credentials = {}, timestamp } = {}) {
  if (!format || format === 'json') return null
  if (!FORMAT_IDS.has(format)) return null
  const note = compose(event, data, { hookName: hook.name || '', titleTemplate: hook.titleTemplate || '', messageTemplate: hook.messageTemplate || '' })
  return serialize(format, note, { event, timestamp, credentials })
}

// What a screen may show of a target address. Chat webhook addresses carry their secret in the
// path (Discord, Slack), and any query string can carry a token, so both are hidden.
function displayUrl(format, rawUrl) {
  let u
  try { u = new URL(String(rawUrl)) } catch { return '' }
  if (format === 'discord' || format === 'slack') return `${u.protocol}//${u.host}/…`
  return `${u.protocol}//${u.host}${u.pathname}${u.search ? '?…' : ''}`
}

module.exports = {
  FORMATS,
  FORMAT_IDS,
  DEFAULT_FORMAT,
  TEMPLATE_MAX,
  formatInfo,
  cleanCredentials,
  missingCredential,
  cleanTemplate,
  renderTemplate,
  describe,
  compose,
  render,
  displayUrl,
  headerSafe
}
