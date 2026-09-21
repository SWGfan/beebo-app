'use strict'
// Trip sharing: the page a link opens, and the rules for what may go on it.
//
// The phone sends a "manifest" (the trip as plain data). Nothing in it is trusted:
//  - sanitizeManifest() copies only known fields, caps every length and count, strips control and
//    bidirectional-override characters, and keeps a media reference only when the PC really holds
//    that file for this trip. Location and the song are dropped unless the share's own options allow
//    them, whatever the phone sent.
//  - renderPage() escapes every string it prints. The page has no script at all (lazy loading is the
//    browser's own loading="lazy" / preload="none"), so the Content-Security-Policy can forbid scripts.
//
// Pure functions, no I/O, so both are unit tested.

const KINDS = new Set(['departed', 'home', 'game', 'story', 'hunt', 'badge', 'packing', 'photo', 'video'])
const KIND_LABEL = { departed: 'Setting off', home: 'Home again', game: 'Game', story: 'Story', hunt: 'Scavenger hunt', badge: 'Badges', packing: 'Packing', photo: 'Photo', video: 'Video' }

const LIMITS = {
  title: 120, dates: 100, crew: 200, stat: 60, stats: 8,
  dayLabel: 80, days: 60, itemsPerDay: 150, itemsTotal: 500, undated: 150,
  itemTitle: 140, text: 2400, line: 220, lines: 24, caption: 200,
  places: 40, placeLabel: 100, song: 100
}

// C0/C1 controls except tab and newline, line and paragraph separators, and the bidi override and
// isolate characters that can make text read backwards or hide what follows.
const BAD_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\u200e\u200f\ufeff]/g

/** One line: controls removed, whitespace collapsed, trimmed, cut at [max] characters. */
function line(value, max) {
  if (value === null || value === undefined || typeof value === 'object') return ''
  return String(value).normalize('NFC').replace(BAD_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

/** Several lines of text: newlines kept (at most one blank line in a row), everything else as [line]. */
function text(value, max) {
  if (value === null || value === undefined || typeof value === 'object') return ''
  return String(value).normalize('NFC').replace(/\r\n?/g, '\n').replace(BAD_CHARS, ' ')
    .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max)
}

function int(value, min, max) {
  const n = Number(value)
  return Number.isInteger(n) && n >= min && n <= max ? n : 0
}

function coord(value, limit) {
  const n = Number(value)
  return Number.isFinite(n) && Math.abs(n) <= limit ? Math.round(n * 1e5) / 1e5 : null
}

/**
 * Turn what the phone sent into what the page may show.
 *
 * @param {object} raw     the phone's manifest (untrusted)
 * @param {object} ctx
 * @param {(sha:string)=>({kind:string,mime:string}|null)} ctx.lookup  the PC's record for a media hash in this trip
 * @param {boolean} ctx.includeLocation  from the share's options, not from [raw]
 * @param {boolean} ctx.includeSong      from the share's options, not from [raw]
 * @returns {{ page: object, mediaRefs: {sha:string,kind:string,mime:string}[], dropped: string[] }}
 */
function sanitizeManifest(raw, { lookup, includeLocation = false, includeSong = false } = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const mediaRefs = []
  const refIndex = new Map()
  const dropped = []
  let total = 0

  const refFor = (sha, wantKinds) => {
    const key = typeof sha === 'string' ? sha.toLowerCase() : ''
    if (!/^[a-f0-9]{64}$/.test(key)) return -1
    if (refIndex.has(key)) {
      const at = refIndex.get(key)
      return wantKinds.includes(mediaRefs[at].kind) ? at : -1
    }
    const rec = typeof lookup === 'function' ? lookup(key) : null
    if (!rec || !wantKinds.includes(rec.kind)) return -1
    mediaRefs.push({ sha: key, kind: rec.kind, mime: rec.mime })
    refIndex.set(key, mediaRefs.length - 1)
    return mediaRefs.length - 1
  }

  const cleanItem = (it) => {
    if (!it || typeof it !== 'object' || !KINDS.has(it.kind)) return null
    if (total >= LIMITS.itemsTotal) return null
    const out = {
      kind: it.kind,
      at: int(it.at, 0, 4102444800000),
      title: line(it.title, LIMITS.itemTitle),
      text: text(it.text, LIMITS.text),
      lines: Array.isArray(it.lines) ? it.lines.slice(0, LIMITS.lines).map((l) => line(l, LIMITS.line)).filter(Boolean) : [],
      media: -1, w: 0, h: 0, caption: ''
    }
    if (it.kind === 'photo' || it.kind === 'video') {
      const m = it.media && typeof it.media === 'object' ? it.media : {}
      out.media = refFor(m.sha, [it.kind])
      if (out.media < 0) { dropped.push(it.kind); return null }
      out.w = int(m.w, 1, 20000)
      out.h = int(m.h, 1, 20000)
      out.caption = line(m.caption, LIMITS.caption)
    }
    total++
    return out
  }

  const days = []
  for (const d of Array.isArray(src.days) ? src.days.slice(0, LIMITS.days) : []) {
    if (!d || typeof d !== 'object') continue
    const items = (Array.isArray(d.items) ? d.items.slice(0, LIMITS.itemsPerDay) : []).map(cleanItem).filter(Boolean)
    if (!items.length) continue
    days.push({ label: line(d.label, LIMITS.dayLabel), items })
  }
  const undated = (Array.isArray(src.undated) ? src.undated.slice(0, LIMITS.undated) : []).map(cleanItem).filter(Boolean)

  let places = []
  if (includeLocation && Array.isArray(src.places)) {
    places = src.places.slice(0, LIMITS.places).map((p) => {
      const lat = coord(p && p.lat, 90)
      const lng = coord(p && p.lng, 180)
      return lat === null || lng === null ? null : { label: line(p.label, LIMITS.placeLabel), lat, lng }
    }).filter(Boolean)
  } else if (Array.isArray(src.places) && src.places.length) dropped.push('places')

  let song = null
  if (includeSong && src.song && typeof src.song === 'object') {
    const at = refFor(src.song.sha, ['audio'])
    if (at >= 0) song = { media: at, title: line(src.song.title, LIMITS.song) }
  } else if (src.song) dropped.push('song')

  const page = {
    title: line(src.title, LIMITS.title) || 'Our trip',
    dates: line(src.dates, LIMITS.dates),
    crew: line(src.crew, LIMITS.crew),
    stats: (Array.isArray(src.stats) ? src.stats.slice(0, LIMITS.stats) : []).map((s) => line(s, LIMITS.stat)).filter(Boolean),
    days, undated, places, song
  }
  return { page, mediaRefs, dropped }
}

/* --------------------------------- page --------------------------------- */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }
const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"'`]/g, (c) => ESC[c])

function fmtExpiry(ms) {
  try {
    return new Date(ms).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }) + ' (UTC)'
  } catch { return '' }
}

const CSS = `
:root{color-scheme:light dark;--bg:#fbf7ef;--fg:#1f1b16;--muted:#5b5348;--card:#fff;--line:#e2d9c8;--accent:#8a3b12}
@media (prefers-color-scheme:dark){:root{--bg:#161310;--fg:#f4ede1;--muted:#c2b8a6;--card:#211d18;--line:#3a332a;--accent:#f2a56e}}
*{box-sizing:border-box}
html{font-size:clamp(20px,2.3vw,24px);-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;line-height:1.6}
main{max-width:46rem;margin:0 auto;padding:1.2rem 1rem 3rem}
h1{font-size:2rem;line-height:1.2;margin:.2rem 0 .4rem}
h2{font-size:1.5rem;margin:2.2rem 0 .8rem;padding-bottom:.3rem;border-bottom:2px solid var(--line)}
.sub{color:var(--muted);margin:.1rem 0}
.stats{display:flex;flex-wrap:wrap;gap:.5rem;list-style:none;padding:0;margin:1rem 0}
.stats li{background:var(--card);border:1px solid var(--line);border-radius:999px;padding:.25rem .9rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:1rem 1.1rem;margin:0 0 1rem}
.kind{font-size:.75rem;text-transform:uppercase;letter-spacing:.08em;color:var(--accent);font-weight:700;margin:0 0 .2rem}
.card h3{font-size:1.25rem;margin:.1rem 0 .4rem}
.card p{margin:.3rem 0;white-space:pre-line}
.card ul{margin:.4rem 0;padding-left:1.3rem}
figure{margin:0}
figure img,figure video{display:block;width:100%;height:auto;border-radius:10px;background:#0002}
figure video{max-height:80vh}
figcaption{color:var(--muted);margin-top:.4rem}
audio{width:100%;margin-top:.5rem}
.note{color:var(--muted);font-size:.85rem}
footer{margin-top:3rem;padding-top:1rem;border-top:1px solid var(--line);color:var(--muted);text-align:center;font-size:.9rem}
`.replace(/\n/g, '')

function renderItem(it, mediaUrl, refs) {
  const label = KIND_LABEL[it.kind] || ''
  let body = ''
  if (it.kind === 'photo' && it.media >= 0) {
    const dims = it.w && it.h ? ` width="${it.w}" height="${it.h}" style="aspect-ratio:${it.w}/${it.h}"` : ''
    body = `<figure><img src="${esc(mediaUrl(it.media))}" alt="${esc(it.caption || 'A photo from the trip')}" loading="lazy" decoding="async"${dims}>` +
      (it.caption ? `<figcaption>${esc(it.caption)}</figcaption>` : '') + '</figure>'
  } else if (it.kind === 'video' && it.media >= 0 && refs[it.media]) {
    body = `<figure><video controls playsinline preload="none" src="${esc(mediaUrl(it.media))}">Your browser cannot play this clip.</video>` +
      (it.caption ? `<figcaption>${esc(it.caption)}</figcaption>` : '') + '</figure>'
  } else {
    body = (it.title ? `<h3>${esc(it.title)}</h3>` : '') +
      (it.text ? `<p>${esc(it.text)}</p>` : '') +
      (it.lines.length ? `<ul>${it.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : '')
  }
  return `<article class="card"><p class="kind">${esc(label)}</p>${body}</article>`
}

/**
 * The whole page for one live share.
 * @param {{page:object, mediaRefs:object[], expiresAt:number, options:{includeLocation:boolean,includeSong:boolean}}} share
 * @param {(index:number)=>string} mediaUrl  URL for media reference [index]; already-escaped-safe path built by the server
 */
function renderPage(share, mediaUrl) {
  const p = share.page
  const refs = share.mediaRefs || []
  const out = []
  out.push('<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="robots" content="noindex,nofollow,noarchive">',
    '<meta name="referrer" content="no-referrer">',
    `<title>${esc(p.title)}</title><style>${CSS}</style></head><body><main>`)
  out.push(`<header><h1>${esc(p.title)}</h1>`)
  if (p.dates) out.push(`<p class="sub">${esc(p.dates)}</p>`)
  if (p.crew) out.push(`<p class="sub">${esc(p.crew)}</p>`)
  if (p.stats.length) out.push(`<ul class="stats">${p.stats.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`)
  out.push(`<p class="note">A private page, view only. This link works until ${esc(fmtExpiry(share.expiresAt))}.</p></header>`)

  if (p.song) {
    const label = p.song.title ? esc(p.song.title) : 'A song chosen by the sender'
    out.push(`<section class="card" aria-label="Music"><p class="kind">Music</p><h3>${label}</h3>` +
      `<audio controls preload="none" src="${esc(mediaUrl(p.song.media))}">Your browser cannot play this song.</audio>` +
      '<p class="note">Played from the sender’s own file, for the people they sent this link to. Please don’t pass it on.</p></section>')
  }
  for (const d of p.days) {
    out.push(`<section>${d.label ? `<h2>${esc(d.label)}</h2>` : ''}${d.items.map((it) => renderItem(it, mediaUrl, refs)).join('')}</section>`)
  }
  if (p.undated.length) {
    out.push(`<section><h2>More from the trip</h2>${p.undated.map((it) => renderItem(it, mediaUrl, refs)).join('')}</section>`)
  }
  if (p.places.length) {
    out.push('<section><h2>Places</h2><div class="card"><ul>' + p.places.map((pl) =>
      `<li>${pl.label ? esc(pl.label) + ': ' : ''}${esc(pl.lat)}, ${esc(pl.lng)} ` +
      `<a href="https://www.openstreetmap.org/?mlat=${esc(pl.lat)}&amp;mlon=${esc(pl.lng)}#map=16/${esc(pl.lat)}/${esc(pl.lng)}" rel="noopener noreferrer nofollow">(open a map)</a></li>`
    ).join('') + '</ul><p class="note">The sender chose to include these places.</p></div></section>')
  }
  if (!p.days.length && !p.undated.length && !p.song) out.push('<p class="card">Nothing has been added to this trip yet.</p>')
  out.push('<footer>Made with Beebo<br><span class="note">Served privately from the sender’s own computer.</span></footer></main></body></html>')
  return out.join('')
}

function renderUnavailable() {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex,nofollow"><title>Link not available</title>' +
    `<style>${CSS}</style></head><body><main><h1>This link isn’t available</h1>` +
    '<p class="card">It may have expired, or the person who sent it turned it off. Please ask them for a new one.</p>' +
    '<footer>Made with Beebo</footer></main></body></html>'
}

module.exports = { sanitizeManifest, renderPage, renderUnavailable, esc, line, text, LIMITS, KINDS, CSP: "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" }
