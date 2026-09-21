'use strict'
// Reading what podcasters publish, and writing what other podcast apps read:
//
//   parseFeed(bytes)        RSS 2.0 (and a small Atom subset) -> { show, episodes } in one plain shape
//   parseOpml(bytes)        an OPML subscription list -> [{ title, xmlUrl }]
//   buildOpml(shows)        the same list back out, for another app
//   parseChaptersJson(...)  Podcasting 2.0 chapters (podcast:chapters, application/json+chapters)
//   parseItunesSearch(...)  the Apple iTunes Search API's JSON -> [{ title, author, feedUrl, artwork }]
//
// Everything that arrives is untrusted: XML goes through xmlLite.js (no entities, no DTD, capped),
// show notes through htmlSanitize.js, and every URL kept must be plain http(s). Nothing here does I/O.

const crypto = require('crypto')
const xml = require('./xmlLite')
const { sanitizeHtml, htmlToText } = require('./htmlSanitize')

const MAX_ITEMS_PARSED = 2000
const MAX_EPISODES_KEPT = 500
const MAX_OPML_FEEDS = 2000
const MAX_CHAPTERS = 500
const MAX_DURATION_S = 48 * 3600
const AUDIO_TYPES = /^(audio\/|video\/(mp4|x-m4v|mpeg|webm)|application\/(ogg|octet-stream))/i

const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex')
const clip = (s, n) => String(s == null ? '' : s).slice(0, n)

// Only plain web addresses survive: no javascript:, data:, file:, no credentials in the URL.
function cleanUrl(raw) {
  const t = String(raw == null ? '' : raw).trim()
  if (!t || t.length > 2000) return ''
  let u
  try { u = new URL(t) } catch { return '' }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname || u.username || u.password) return ''
  return u.toString()
}

// One feed URL has one id, however it was typed: scheme and host case, a trailing "/", a fragment.
function normalizeFeedUrl(raw) {
  const t = cleanUrl(raw)
  if (!t) return ''
  const u = new URL(t)
  u.hash = ''
  if (u.pathname === '/' && !u.search) return u.origin + '/'
  return u.toString()
}

const feedIdFor = (url) => sha1(normalizeFeedUrl(url) || url).slice(0, 12)
const episodeIdFor = (guid) => sha1(guid).slice(0, 16)

// "1:02:03", "62:03", "3723", "3723.5", "00:01:02.500" -> whole seconds (0 when unreadable).
function parseDuration(raw) {
  const t = String(raw == null ? '' : raw).trim()
  if (!t || t.length > 20) return 0
  const parts = t.split(':')
  if (parts.length > 3 || !parts.every((p) => /^\d+(\.\d+)?$/.test(p))) return 0
  let secs = 0
  for (const p of parts) secs = secs * 60 + parseFloat(p)
  return Number.isFinite(secs) ? Math.min(Math.round(secs), MAX_DURATION_S) : 0
}

function parseDate(raw) {
  const ms = Date.parse(String(raw || '').trim())
  return Number.isFinite(ms) && ms > 0 && ms < Date.now() + 366 * 86400000 * 5 ? ms : 0
}

const truthy = (v) => /^(yes|true|explicit)$/i.test(String(v || '').trim())

function imageOf(node) {
  const it = xml.kid(node, 'itunes:image')
  if (it && cleanUrl(it.attrs.href)) return cleanUrl(it.attrs.href)
  const img = xml.kid(node, 'image')
  if (img) {
    const u = cleanUrl(xml.firstText(img, 'url') || img.attrs.href)
    if (u) return u
  }
  const media = xml.kid(node, 'media:thumbnail')
  return media ? cleanUrl(media.attrs.url) : ''
}

function categoriesOf(node) {
  const out = []
  const walk = (n, depth) => {
    for (const c of xml.kids(n, 'itunes:category')) {
      const t = clip(c.attrs.text, 80).trim()
      if (t && !out.includes(t)) out.push(t)
      if (depth < 2) walk(c, depth + 1)
    }
  }
  walk(node, 0)
  const plain = xml.kids(node, 'category').map((c) => clip(xml.textOf(c), 80)).filter(Boolean)
  for (const t of plain) if (!out.includes(t)) out.push(t)
  return out.slice(0, 10)
}

// <psc:chapters><psc:chapter start="00:01:02.500" title="..."/></psc:chapters> (Podlove Simple Chapters)
function inlineChapters(item) {
  const box = xml.kid(item, 'psc:chapters')
  if (!box) return []
  const list = []
  for (const c of xml.kids(box, 'psc:chapter')) {
    const start = parseDuration(String(c.attrs.start || '').replace(/\.\d+$/, ''))
    const title = clip(c.attrs.title, 200).trim()
    if (title) list.push({ start, title, img: cleanUrl(c.attrs.image), url: cleanUrl(c.attrs.href) })
    if (list.length >= MAX_CHAPTERS) break
  }
  return list.sort((a, b) => a.start - b.start)
}

function parseRssItem(item) {
  const enc = xml.kids(item, 'enclosure').find((e) => cleanUrl(e.attrs.url) && (!e.attrs.type || AUDIO_TYPES.test(e.attrs.type)))
  if (!enc) return null
  const audioUrl = cleanUrl(enc.attrs.url)
  const guid = xml.firstText(item, 'guid') || audioUrl
  const title = clip(xml.firstText(item, 'title', 'itunes:title'), 300) || 'Untitled episode'
  const notesRaw = (item.children.find((c) => c.name === 'content:encoded') || {}).text || (xml.kid(item, 'description') || {}).text || (xml.kid(item, 'itunes:summary') || {}).text || ''
  const notesHtml = sanitizeHtml(notesRaw)
  const chaptersEl = xml.kids(item, 'podcast:chapters').find((c) => cleanUrl(c.attrs.url))
  const transcripts = xml.kids(item, 'podcast:transcript').map((t) => ({ url: cleanUrl(t.attrs.url), type: clip(t.attrs.type, 60) })).filter((t) => t.url).slice(0, 4)
  const size = Number(enc.attrs.length)
  return {
    id: episodeIdFor(guid),
    guid: clip(guid, 500),
    title,
    publishedAt: parseDate(xml.firstText(item, 'pubDate', 'dc:date')),
    durationSec: parseDuration(xml.firstText(item, 'itunes:duration')),
    audioUrl,
    audioType: clip(enc.attrs.type, 60),
    sizeBytes: Number.isFinite(size) && size > 0 ? Math.round(size) : 0,
    summary: htmlToText(notesRaw, 300),
    notesHtml,
    link: cleanUrl(xml.firstText(item, 'link')),
    image: imageOf(item),
    season: parseInt(xml.firstText(item, 'itunes:season'), 10) || null,
    episode: parseInt(xml.firstText(item, 'itunes:episode'), 10) || null,
    episodeType: /^(trailer|bonus)$/i.test(xml.firstText(item, 'itunes:episodeType')) ? xml.firstText(item, 'itunes:episodeType').toLowerCase() : 'full',
    explicit: truthy(xml.firstText(item, 'itunes:explicit')),
    chaptersUrl: chaptersEl ? cleanUrl(chaptersEl.attrs.url) : '',
    chapters: inlineChapters(item),
    transcripts
  }
}

function parseAtomEntry(entry) {
  const links = xml.kids(entry, 'atom:link').concat(xml.kids(entry, 'link'))
  const enc = links.find((l) => l.attrs.rel === 'enclosure' && cleanUrl(l.attrs.href))
  if (!enc) return null
  const audioUrl = cleanUrl(enc.attrs.href)
  const guid = xml.firstText(entry, 'id', 'atom:id') || audioUrl
  const notesRaw = (xml.kid(entry, 'content') || xml.kid(entry, 'summary') || {}).text || ''
  const alt = links.find((l) => (!l.attrs.rel || l.attrs.rel === 'alternate') && cleanUrl(l.attrs.href))
  return {
    id: episodeIdFor(guid), guid: clip(guid, 500),
    title: clip(xml.firstText(entry, 'title'), 300) || 'Untitled episode',
    publishedAt: parseDate(xml.firstText(entry, 'published', 'updated')),
    durationSec: parseDuration(xml.firstText(entry, 'itunes:duration')),
    audioUrl, audioType: clip(enc.attrs.type, 60), sizeBytes: Math.max(0, Math.round(Number(enc.attrs.length) || 0)),
    summary: htmlToText(notesRaw, 300), notesHtml: sanitizeHtml(notesRaw), link: alt ? cleanUrl(alt.attrs.href) : '',
    image: imageOf(entry), season: null, episode: null, episodeType: 'full', explicit: false, chaptersUrl: '', chapters: [], transcripts: []
  }
}

// A feed that declares Atom as its default namespace has every element named "atom:x"; use the plain names.
function unprefixAtom(root) {
  const todo = [root]
  while (todo.length) {
    const nd = todo.pop()
    if (nd.name.startsWith('atom:')) nd.name = nd.name.slice(5)
    for (const c of nd.children) todo.push(c)
  }
}

/** @returns {{ show: object, episodes: object[] }}  throws xml.XmlError / Error('not_a_podcast_feed') */
function parseFeed(bytes) {
  const root = xml.parseXml(bytes)
  let show
  let items
  let parseItem
  if (root.name === 'rss') {
    const ch = xml.kid(root, 'channel')
    if (!ch) throw Object.assign(new Error('not_a_podcast_feed'), { code: 'not_a_podcast_feed' })
    const notesRaw = (xml.kid(ch, 'description') || {}).text || (xml.kid(ch, 'itunes:summary') || {}).text || ''
    show = {
      title: clip(xml.firstText(ch, 'title', 'itunes:title'), 300) || 'Untitled podcast',
      description: htmlToText(notesRaw, 1000),
      author: clip(xml.firstText(ch, 'itunes:author', 'managingEditor', 'dc:creator'), 200),
      link: cleanUrl(xml.firstText(ch, 'link')),
      language: clip(xml.firstText(ch, 'language'), 20),
      image: imageOf(ch),
      explicit: truthy(xml.firstText(ch, 'itunes:explicit')),
      categories: categoriesOf(ch),
      newFeedUrl: normalizeFeedUrl(xml.firstText(ch, 'itunes:new-feed-url')),
      showType: /^serial$/i.test(xml.firstText(ch, 'itunes:type')) ? 'serial' : 'episodic'
    }
    items = xml.kids(ch, 'item')
    parseItem = parseRssItem
  } else if (root.name === 'atom:feed' || root.name === 'feed') {
    unprefixAtom(root)
    show = {
      title: clip(xml.firstText(root, 'title'), 300) || 'Untitled podcast',
      description: htmlToText((xml.kid(root, 'subtitle') || {}).text || '', 1000),
      author: clip(xml.firstText(xml.kid(root, 'author'), 'name'), 200),
      link: '', language: '', image: cleanUrl(xml.firstText(root, 'logo', 'icon')), explicit: false, categories: [], newFeedUrl: '', showType: 'episodic'
    }
    items = xml.kids(root, 'entry')
    parseItem = parseAtomEntry
  } else {
    throw Object.assign(new Error('not_a_podcast_feed'), { code: 'not_a_podcast_feed' })
  }
  const seen = new Set()
  const episodes = []
  for (const it of items.slice(0, MAX_ITEMS_PARSED)) {
    const ep = parseItem(it)
    if (!ep || seen.has(ep.id)) continue
    seen.add(ep.id)
    episodes.push(ep)
  }
  // Newest first; an undated episode keeps its place in the feed (feeds list newest first).
  episodes.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0))
  return { show, episodes: episodes.slice(0, MAX_EPISODES_KEPT) }
}

// ----- OPML --------------------------------------------------------------------------------

function parseOpml(bytes) {
  const root = xml.parseXml(bytes)
  if (root.name !== 'opml') throw Object.assign(new Error('not_opml'), { code: 'not_opml' })
  const body = xml.kid(root, 'body')
  const out = []
  const seen = new Set()
  const stack = body ? body.children.slice().reverse() : []
  while (stack.length && out.length < MAX_OPML_FEEDS) {
    const o = stack.pop()
    if (o.name !== 'outline') continue
    const attr = (name) => {
      for (const k of Object.keys(o.attrs)) if (k.toLowerCase() === name) return o.attrs[k]
      return ''
    }
    const url = normalizeFeedUrl(attr('xmlurl'))
    if (url && !seen.has(url)) {
      seen.add(url)
      out.push({ title: clip(attr('title') || attr('text'), 300), xmlUrl: url, htmlUrl: cleanUrl(attr('htmlurl')) })
    }
    for (let i = o.children.length - 1; i >= 0; i--) stack.push(o.children[i])
  }
  return out
}

const escXml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function buildOpml(shows, { title = 'Beebo Entertainment podcasts', now = new Date() } = {}) {
  const lines = (Array.isArray(shows) ? shows : []).filter((s) => s && s.url).map((s) =>
    `    <outline type="rss" text="${escXml(s.title || s.url)}" title="${escXml(s.title || s.url)}" xmlUrl="${escXml(s.url)}"${s.link ? ` htmlUrl="${escXml(s.link)}"` : ''}/>`)
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head>\n    <title>${escXml(title)}</title>\n    <dateCreated>${now.toUTCString()}</dateCreated>\n  </head>\n  <body>\n${lines.join('\n')}\n  </body>\n</opml>\n`
}

// ----- chapters ----------------------------------------------------------------------------

/** Podcasting 2.0 chapters JSON -> [{ start (seconds), end, title, img, url, hidden }] sorted by start. */
function parseChaptersJson(bytes) {
  let doc
  try { doc = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes)) } catch { return [] }
  const list = doc && Array.isArray(doc.chapters) ? doc.chapters : Array.isArray(doc) ? doc : []
  const out = []
  for (const c of list.slice(0, MAX_CHAPTERS * 2)) {
    if (!c || typeof c !== 'object') continue
    const start = Number(c.startTime)
    if (!Number.isFinite(start) || start < 0 || start > MAX_DURATION_S) continue
    const end = Number(c.endTime)
    out.push({
      start,
      end: Number.isFinite(end) && end > start ? end : null,
      title: clip(c.title, 200).trim(),
      img: cleanUrl(c.img),
      url: cleanUrl(c.url),
      hidden: c.toc === false
    })
    if (out.length >= MAX_CHAPTERS) break
  }
  return out.sort((a, b) => a.start - b.start)
}

// ----- Apple iTunes Search API (discovery only) --------------------------------------------

/** https://itunes.apple.com/search?media=podcast&term=... -> the fields the search screen shows. */
function parseItunesSearch(json) {
  const list = json && Array.isArray(json.results) ? json.results : []
  const out = []
  for (const r of list) {
    if (!r || typeof r !== 'object') continue
    const feedUrl = normalizeFeedUrl(r.feedUrl)
    if (!feedUrl) continue
    out.push({
      title: clip(r.collectionName || r.trackName, 300),
      author: clip(r.artistName, 200),
      feedUrl,
      artwork: cleanUrl(r.artworkUrl600 || r.artworkUrl100 || r.artworkUrl60),
      genre: clip(r.primaryGenreName, 60),
      episodeCount: Number.isFinite(Number(r.trackCount)) ? Number(r.trackCount) : null
    })
  }
  return out
}

module.exports = {
  parseFeed, parseOpml, buildOpml, parseChaptersJson, parseItunesSearch,
  parseDuration, cleanUrl, normalizeFeedUrl, feedIdFor, episodeIdFor, MAX_EPISODES_KEPT
}
