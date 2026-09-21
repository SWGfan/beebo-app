'use strict'
// A small, defensive XMLTV reader. XMLTV is the plain guide format that guide tools (and services
// such as Schedules Direct, through their XMLTV exporters) produce. This is a tokenizer, not an XML
// engine: DOCTYPE/ENTITY declarations are never processed (nothing to expand, so nothing to bomb),
// tag text is decoded with a fixed set of entities, sizes and counts are capped.
//
// The file is somebody else's (a guide site, a download), so it is scanned in ONE pass per element:
// no regex with a lazy "anything up to the closing tag" that is re-tried from every opening tag (that
// is quadratic on a file full of unterminated tags), and no regex over an attribute run. A file made
// to be slow costs time in proportion to its size, like any other file.

const { scanAttrs } = require('../xmlLite')

const MAX_PROGRAMMES = 250000
const MAX_CHANNELS = 5000

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

// <![CDATA[ ... ]]> -> its text, with "&" protected so it is not read as an entity later.
function unwrapCdata(s) {
  if (s.indexOf('<![CDATA[') === -1) return s
  let out = ''
  let i = 0
  for (;;) {
    const a = s.indexOf('<![CDATA[', i)
    if (a === -1) { out += s.slice(i); break }
    const b = s.indexOf(']]>', a + 9)
    if (b === -1) { out += s.slice(i); break } // unterminated: no later section can end either
    out += s.slice(i, a) + s.slice(a + 9, b).replace(/&/g, '\x01amp;')
    i = b + 3
  }
  return out
}

// "<...>" removed. A "<" with no ">" after it is left as text.
function stripTags(s) {
  if (s.indexOf('<') === -1) return s
  let out = ''
  let i = 0
  for (;;) {
    const lt = s.indexOf('<', i)
    if (lt === -1) { out += s.slice(i); break }
    const gt = s.indexOf('>', lt + 1)
    if (gt === -1) { out += s.slice(i); break }
    out += s.slice(i, lt)
    i = gt + 1
  }
  return out
}

function decode(text) {
  return stripTags(unwrapCdata(String(text)))
    .replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,4});/g, (m, e) => {
      if (e[0] === '#') {
        const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
        return cp > 31 && cp < 0x110000 && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : ''
      }
      return Object.prototype.hasOwnProperty.call(ENTITIES, e) ? ENTITIES[e] : m
    })
    .replace(/\x01amp;/g, '&')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function attrs(text) {
  const out = {}
  for (const a of scanAttrs(text, { strict: true })) {
    const name = a.name.toLowerCase()
    if (name === '__proto__' || name === 'constructor') continue
    out[name] = decode(a.raw)
  }
  return out
}

/** "20260921180000 -0400" (offset optional, seconds optional) -> epoch ms, or null. */
function parseXmltvTime(text) {
  const m = /^\s*(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*(?:([+-])(\d{2}):?(\d{2}))?\s*$/.exec(String(text || ''))
  if (!m) return null
  const [, y, mo, d, h, mi, s, sign, oh, om] = m
  const t = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s || 0))
  if (!Number.isFinite(t) || Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31 || Number(h) > 23 || Number(mi) > 59) return null
  const off = sign ? (Number(oh) * 60 + Number(om)) * 60000 * (sign === '-' ? -1 : 1) : 0
  return t - off
}

/**
 * Calls fn(attributeText, bodyText) for every <tag ...>body</tag> in `text`, in order, until fn returns false.
 * One pass: an opening tag whose ">" or whose closing tag never comes ends the scan (nothing later can be
 * complete either), so a file of unterminated tags is read once, not once per tag. Tag names are matched
 * case-insensitively, as they always were.
 */
function forEachElement(text, tag, fn) {
  const openRe = new RegExp('<' + tag + '\\b', 'gi')
  const closeRe = new RegExp('</' + tag + '>', 'gi')
  let m
  while ((m = openRe.exec(text))) {
    const gt = text.indexOf('>', openRe.lastIndex)
    if (gt === -1) return
    closeRe.lastIndex = gt + 1
    const c = closeRe.exec(text)
    if (!c) return
    if (fn(text.slice(openRe.lastIndex, gt), text.slice(gt + 1, c.index)) === false) return
    openRe.lastIndex = c.index + c[0].length
  }
}

function firstBody(inner, tag) {
  let found = null
  forEachElement(inner, tag, (_a, body) => { found = body; return false })
  return found
}

function firstText(inner, tag, max) {
  const body = firstBody(inner, tag)
  return body === null ? '' : decode(body).slice(0, max)
}

function episodeOf(inner) {
  let out = null
  let result = null
  forEachElement(inner, 'episode-num', (a, body) => {
    const system = (attrs(a).system || '').toLowerCase()
    const text = decode(body)
    if (system === 'xmltv_ns') {
      const p = /^\s*(\d*)\s*(?:\/\s*\d+)?\s*\.\s*(\d*)\s*(?:\/\s*\d+)?\s*(?:\.\s*[\d/]*)?\s*$/.exec(text)
      if (p && (p[1] !== '' || p[2] !== '')) {
        const season = p[1] === '' ? null : Number(p[1]) + 1
        const episode = p[2] === '' ? null : Number(p[2]) + 1
        if ((season === null || season < 1000) && (episode === null || episode < 100000)) { result = { season, episode }; return false }
      }
    } else {
      const s = /S(\d{1,3})\s*E(\d{1,4})/i.exec(text)
      if (s) out = { season: Number(s[1]), episode: Number(s[2]) }
    }
    return true
  })
  return result || out
}

/**
 * -> { channels: [{ id, names[] }], programmes: [{ channel, start, stop, title, subTitle, desc, categories[], season, episode, isNew, rating }] }
 * Programmes without a usable title or time range are dropped.
 */
function parseXmltv(input) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input || '')
  const channels = []
  const programmes = []
  forEachElement(text, 'channel', (attrText, body) => {
    const id = attrs(attrText).id
    if (id) {
      const names = []
      forEachElement(body, 'display-name', (_a, nb) => { const v = decode(nb).slice(0, 80); if (v) names.push(v); return names.length < 8 })
      channels.push({ id: id.slice(0, 200), names })
    }
    return channels.length < MAX_CHANNELS
  })
  forEachElement(text, 'programme', (attrText, body) => {
    const a = attrs(attrText)
    const start = parseXmltvTime(a.start)
    const stop = parseXmltvTime(a.stop)
    const title = firstText(body, 'title', 200)
    if (!a.channel || start === null || stop === null || stop <= start || stop - start > 24 * 3600 * 1000 || !title) return true
    const cats = []
    forEachElement(body, 'category', (_a, cb) => { const v = decode(cb).slice(0, 40); if (v) cats.push(v); return cats.length < 6 })
    const ep = episodeOf(body)
    const ratingBody = firstBody(body, 'rating')
    programmes.push({
      channel: a.channel.slice(0, 200), start, stop, title,
      subTitle: firstText(body, 'sub-title', 200), desc: firstText(body, 'desc', 1000), categories: cats,
      season: ep ? ep.season : null, episode: ep ? ep.episode : null,
      isNew: /<new\b/i.test(body), rating: ratingBody !== null ? firstText(ratingBody, 'value', 20) : ''
    })
    return programmes.length < MAX_PROGRAMMES
  })
  return { channels, programmes }
}

module.exports = { parseXmltv, parseXmltvTime, MAX_PROGRAMMES }
