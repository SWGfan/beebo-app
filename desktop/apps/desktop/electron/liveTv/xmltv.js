'use strict'
// A small, defensive XMLTV reader. XMLTV is the plain guide format that guide tools (and services
// such as Schedules Direct, through their XMLTV exporters) produce. This is a tokenizer, not an XML
// engine: DOCTYPE/ENTITY declarations are never processed (nothing to expand, so nothing to bomb),
// tag text is decoded with a fixed set of entities, sizes and counts are capped.

const MAX_PROGRAMMES = 250000
const MAX_CHANNELS = 5000

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decode(text) {
  return String(text)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, c) => c.replace(/&/g, '\x01amp;'))
    .replace(/<[^>]*>/g, '')
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
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let m
  while ((m = re.exec(text))) out[m[1].toLowerCase()] = decode(m[2] !== undefined ? m[2] : m[3])
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

function firstText(inner, tag, max) {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(inner)
  return m ? decode(m[1]).slice(0, max) : ''
}

function episodeOf(inner) {
  const re = /<episode-num\b([^>]*)>([\s\S]*?)<\/episode-num>/gi
  let m
  let out = null
  while ((m = re.exec(inner))) {
    const system = (attrs(m[1]).system || '').toLowerCase()
    const text = decode(m[2])
    if (system === 'xmltv_ns') {
      const p = /^\s*(\d*)\s*(?:\/\s*\d+)?\s*\.\s*(\d*)\s*(?:\/\s*\d+)?\s*(?:\.\s*[\d/]*)?\s*$/.exec(text)
      if (p && (p[1] !== '' || p[2] !== '')) {
        const season = p[1] === '' ? null : Number(p[1]) + 1
        const episode = p[2] === '' ? null : Number(p[2]) + 1
        if ((season === null || season < 1000) && (episode === null || episode < 100000)) return { season, episode }
      }
    } else {
      const s = /S(\d{1,3})\s*E(\d{1,4})/i.exec(text)
      if (s) out = { season: Number(s[1]), episode: Number(s[2]) }
    }
  }
  return out
}

/**
 * -> { channels: [{ id, names[] }], programmes: [{ channel, start, stop, title, subTitle, desc, categories[], season, episode, isNew, rating }] }
 * Programmes without a usable title or time range are dropped.
 */
function parseXmltv(input) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input || '')
  const channels = []
  const programmes = []
  const chRe = /<channel\b([^>]*)>([\s\S]*?)<\/channel>/gi
  let m
  while ((m = chRe.exec(text)) && channels.length < MAX_CHANNELS) {
    const id = attrs(m[1]).id
    if (!id) continue
    const names = []
    const nRe = /<display-name\b[^>]*>([\s\S]*?)<\/display-name>/gi
    let n
    while ((n = nRe.exec(m[2])) && names.length < 8) { const v = decode(n[1]).slice(0, 80); if (v) names.push(v) }
    channels.push({ id: id.slice(0, 200), names })
  }
  const pRe = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/gi
  while ((m = pRe.exec(text)) && programmes.length < MAX_PROGRAMMES) {
    const a = attrs(m[1])
    const start = parseXmltvTime(a.start)
    const stop = parseXmltvTime(a.stop)
    const title = firstText(m[2], 'title', 200)
    if (!a.channel || start === null || stop === null || stop <= start || stop - start > 24 * 3600 * 1000 || !title) continue
    const cats = []
    const cRe = /<category\b[^>]*>([\s\S]*?)<\/category>/gi
    let c
    while ((c = cRe.exec(m[2])) && cats.length < 6) { const v = decode(c[1]).slice(0, 40); if (v) cats.push(v) }
    const ep = episodeOf(m[2])
    const ratingBlock = /<rating\b[^>]*>([\s\S]*?)<\/rating>/i.exec(m[2])
    programmes.push({
      channel: a.channel.slice(0, 200), start, stop, title,
      subTitle: firstText(m[2], 'sub-title', 200), desc: firstText(m[2], 'desc', 1000), categories: cats,
      season: ep ? ep.season : null, episode: ep ? ep.episode : null,
      isNew: /<new\b/i.test(m[2]), rating: ratingBlock ? firstText(ratingBlock[1], 'value', 20) : ''
    })
  }
  return { channels, programmes }
}

module.exports = { parseXmltv, parseXmltvTime, MAX_PROGRAMMES }
