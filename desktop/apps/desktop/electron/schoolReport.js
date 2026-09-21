'use strict'

/**
 * schoolReport.js
 *
 * Renders a printable parent "report card" web page (a full HTML document
 * string) for the BeeboSchool children's learning feature.
 *
 * This page is served by the parent's OWN computer on their local network and
 * viewed in their browser. The data never leaves the family's hardware, and
 * the page says so. It is an adults-only view: children never see scores or
 * levels — this page is the only place levels appear.
 *
 * Pure and dependency-free: no external packages, no network, no fs — just
 * string building from the input object.
 *
 * Public API:
 *   renderReportPage(report, opts) -> string (full HTML document)
 */

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Escape a value for safe interpolation into HTML text/attributes.
 * A child's name could contain `<`, `&`, quotes, etc.
 */
function esc (value) {
  if (value === null || value === undefined) return ''
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Is this a usable, finite number? */
function isNum (n) {
  return typeof n === 'number' && isFinite(n)
}

/** Coerce to a non-negative integer count, defaulting to 0. */
function count (n) {
  return isNum(n) && n > 0 ? Math.round(n) : 0
}

/**
 * Format a millisecond duration as a rough, human phrase.
 * e.g. "about 12 minutes", "under a minute", "about 1 hour".
 */
function roughTime (ms) {
  if (!isNum(ms) || ms <= 0) return null
  const mins = Math.round(ms / 60000)
  if (mins < 1) return 'under a minute'
  if (mins === 1) return 'about 1 minute'
  if (mins < 60) return 'about ' + mins + ' minutes'
  const hours = Math.round(mins / 60)
  if (hours === 1) return 'about 1 hour'
  return 'about ' + hours + ' hours'
}

/**
 * Format an epoch-ms range as a readable date span.
 * Returns null if there is nothing meaningful to show.
 */
function formatRange (fromMs, toMs) {
  const from = isNum(fromMs) && fromMs > 0 ? new Date(fromMs) : null
  const to = isNum(toMs) && toMs > 0 ? new Date(toMs) : null
  if (!from && !to) return null
  if (from && to) {
    const a = formatDate(from)
    const b = formatDate(to)
    return a === b ? a : a + ' – ' + b
  }
  return formatDate(from || to)
}

/** Format a Date as e.g. "3 Sep 2026". */
function formatDate (d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return ''
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear()
}

/** Format an epoch-ms timestamp (from a `did` entry) as a short date. */
function formatEntryDate (ms) {
  if (!isNum(ms) || ms <= 0) return ''
  return formatDate(new Date(ms))
}

/** Pluralise a noun for a given count: "1 lesson" / "3 lessons". */
function plural (n, singular, pluralForm) {
  const word = n === 1 ? singular : (pluralForm || singular + 's')
  return n + ' ' + word
}

// The four recognised levels, mapped to a CSS pill class. Anything else falls
// back to the neutral "unknown" styling. Levels are shown as WORDS only —
// never letter grades, never percentages, never percentiles.
const LEVEL_CLASS = {
  'Secure': 'lvl-secure',
  'Developing': 'lvl-developing',
  'Beginning': 'lvl-beginning',
  'Not enough yet': 'lvl-none'
}

// ---------------------------------------------------------------------------
// The verbatim spec text (must not be altered)
// ---------------------------------------------------------------------------

const CAVEAT_HOW =
  'Slower is not worse — a long pause often means a child is looking before ' +
  'they leap. A pause can also mean an unfamiliar tablet, or a bump in the ' +
  'road, rather than an unfamiliar question. Treat these as things to ask ' +
  'about, never as findings.'

// ---------------------------------------------------------------------------
// Section builders — each returns an HTML string, or '' to skip the section.
// ---------------------------------------------------------------------------

/** 1. Header: name, age, date range, sessions, rough total time. */
function sectionHeader (report) {
  const name = report.childName ? esc(report.childName) : 'This child'
  const bits = []

  if (isNum(report.childAge)) {
    bits.push('age ' + esc(report.childAge))
  }
  const range = formatRange(report.fromMs, report.toMs)
  if (range) bits.push(esc(range))

  const sessions = count(report.sessionCount)
  if (sessions > 0) bits.push(esc(plural(sessions, 'session')))

  const time = roughTime(report.totalMs)
  if (time) bits.push(esc(time) + ' of play')

  const sub = bits.length
    ? '<p class="sub">' + bits.join(' &middot; ') + '</p>'
    : ''

  return '' +
    '<header class="report-head">' +
    '<h1>' + name + '</h1>' +
    sub +
    '</header>'
}

/** 2. Where they played: "6 lessons: 2 parked, 4 on the move." */
function sectionWherePlayed (report) {
  const parked = count(report.parkedCount)
  const moving = count(report.movingCount)
  const total = parked + moving
  if (total === 0) return ''

  const parts = []
  if (parked > 0) parts.push(parked + ' parked')
  if (moving > 0) parts.push(moving + ' on the move')

  return '' +
    '<section class="where">' +
    '<p>' + esc(plural(total, 'lesson')) + ': ' +
    esc(parts.join(', ')) + '.</p>' +
    '</section>'
}

/** 3. Unmeasured banner (only if report.unmeasured). */
function sectionUnmeasured (report) {
  if (!report.unmeasured) return ''
  return '' +
    '<section class="banner">' +
    '<p>Some play happened <strong>on the move</strong>. When it does, ' +
    'BeeboSchool records what was done but doesn’t time or score it — ' +
    'because, from the numbers alone, a bumpy road looks exactly like a ' +
    'child hesitating.</p>' +
    '</section>'
}

/** 4. What they did: a folder of work, oldest first. */
function sectionWhatDid (report) {
  const did = Array.isArray(report.did) ? report.did : []
  if (did.length === 0) return ''

  const rows = did.map(function (entry) {
    if (!entry || typeof entry !== 'object') return ''
    const label = esc(entry.label || entry.lesson || 'Lesson')
    const items = count(entry.items)
    const date = formatEntryDate(entry.date)

    const meta = []
    if (items > 0) meta.push(esc(plural(items, 'item')) + ' answered')
    if (date) meta.push(esc(date))

    return '' +
      '<li>' +
      '<span class="did-label">' + label + '</span>' +
      (meta.length
        ? '<span class="did-meta">' + meta.join(' &middot; ') + '</span>'
        : '') +
      '</li>'
  }).filter(Boolean).join('')

  if (!rows) return ''

  return '' +
    '<section class="what-did">' +
    '<h2>What they did</h2>' +
    '<ul class="did-list">' + rows + '</ul>' +
    '</section>'
}

/** Books read: the storybooks this child has read, oldest first. */
function sectionBooksRead (report) {
  const books = Array.isArray(report.booksRead) ? report.booksRead : []
  if (books.length === 0) return ''
  const rows = books.map(function (b) {
    if (!b || typeof b !== 'object') return ''
    const title = esc(b.title || b.slug || 'A story')
    const date = formatEntryDate(b.date)
    return '' +
      '<li>' +
      '<span class="did-label">' + title + '</span>' +
      (date ? '<span class="did-meta">' + esc(date) + '</span>' : '') +
      '</li>'
  }).filter(Boolean).join('')
  if (!rows) return ''
  return '' +
    '<section class="what-did">' +
    '<h2>Books read</h2>' +
    '<ul class="did-list">' + rows + '</ul>' +
    '</section>'
}

/** Where to explore next: gentle, supportive; never a deficit or diagnosis. */
function sectionFocusAreas (report) {
  const areas = Array.isArray(report.focusAreas) ? report.focusAreas : []
  if (areas.length === 0) return ''
  const items = areas.map(function (a) {
    if (!a || typeof a !== 'object') return ''
    const label = esc(a.label || '')
    if (!label) return ''
    const note = a.note ? esc(a.note) : ''
    return '' +
      '<li>' +
      '<span class="focus-label">' + label + '</span>' +
      (note ? '<span class="focus-note">' + note + '</span>' : '') +
      '</li>'
  }).filter(Boolean).join('')
  if (!items) return ''
  return '' +
    '<section class="focus">' +
    '<h2>Where to explore next</h2>' +
    '<ul class="focus-list">' + items + '</ul>' +
    '</section>'
}

/** 5. At a glance: one row per lesson type, with a level word. */
function sectionAtGlance (report) {
  const rows = Array.isArray(report.atGlance) ? report.atGlance : []
  if (rows.length === 0) return ''

  const body = rows.map(function (r) {
    if (!r || typeof r !== 'object') return ''
    const label = esc(r.label || r.lesson || 'Lesson')
    const howMuch = count(r.count) > 0
      ? esc(plural(count(r.count), 'item'))
      : ''
    const measure = r.measure ? esc(r.measure) : ''
    const level = r.level && LEVEL_CLASS[r.level] ? r.level : 'Not enough yet'
    const pillClass = LEVEL_CLASS[level] || 'lvl-none'

    return '' +
      '<tr>' +
      '<td class="g-label">' + label + '</td>' +
      '<td class="g-count">' + howMuch + '</td>' +
      '<td class="g-measure">' + measure + '</td>' +
      '<td class="g-level">' +
      '<span class="pill ' + pillClass + '">' + esc(level) + '</span>' +
      '</td>' +
      '</tr>'
  }).filter(Boolean).join('')

  if (!body) return ''

  return '' +
    '<section class="at-glance">' +
    '<h2>At a glance</h2>' +
    '<table class="glance-table">' +
    '<thead><tr>' +
    '<th>What</th><th>How much</th><th>Measure</th><th>Level</th>' +
    '</tr></thead>' +
    '<tbody>' + body + '</tbody>' +
    '</table>' +
    '</section>'
}

/** 6. How they went about it: descriptive only, then the verbatim caveat. */
function sectionHowWent (report) {
  const lines = []

  if (isNum(report.howPauseMs) && report.howPauseMs > 0) {
    const secs = Math.max(1, Math.round(report.howPauseMs / 1000))
    lines.push('Typical pause before answering ~' + secs + 's.')
  }
  if (isNum(report.hintRate) && report.hintRate > 0) {
    const pct = Math.round(Math.min(1, report.hintRate) * 100)
    lines.push('A hint appeared on ~' + pct + '% of items.')
  }

  if (lines.length === 0) return ''

  const paras = lines.map(function (l) {
    return '<p>' + esc(l) + '</p>'
  }).join('')

  return '' +
    '<section class="how-went">' +
    '<h2>How they went about it</h2>' +
    paras +
    '<blockquote class="caveat">' + esc(CAVEAT_HOW) + '</blockquote>' +
    '</section>'
}

/** 7. Try this before next time: from suggestions. */
function sectionSuggestions (report) {
  const list = Array.isArray(report.suggestions)
    ? report.suggestions.filter(function (s) {
      return typeof s === 'string' && s.trim() !== ''
    })
    : []
  if (list.length === 0) return ''

  const items = list.map(function (s) {
    return '<li>' + esc(s) + '</li>'
  }).join('')

  return '' +
    '<section class="suggestions">' +
    '<h2>Try this before next time</h2>' +
    '<ul>' + items + '</ul>' +
    '</section>'
}

/** 8. What this is: quiet footer, verbatim text. */
function sectionWhatThisIs () {
  return '' +
    '<section class="what-is">' +
    '<p>' +
    '<strong>What this is.</strong> A record of what happened during play ' +
    'on this device — closer to a folder of work than to an assessment. It ' +
    'cannot tell you <em>why</em> anything was easy or hard, and it is ' +
    '<strong>not a screening tool</strong>: nothing here should be read as ' +
    '&ldquo;no concerns&rdquo;. A handful of sessions is a small sample. ' +
    'Treat all of it as a conversation starter. Nothing on this page has ' +
    'been sent anywhere.' +
    '</p>' +
    '</section>'
}

/** Optional header nav: switch child, export, clear. Omitted if no opts. */
function navBar (report, opts) {
  if (!opts || typeof opts !== 'object') return ''

  const nav = Array.isArray(opts.childrenNav) ? opts.childrenNav : []
  const hasNav = nav.length > 0
  const hasExport = typeof opts.exportHref === 'string' && opts.exportHref
  const hasClear = typeof opts.clearHref === 'string' && opts.clearHref
  if (!hasNav && !hasExport && !hasClear) return ''

  let childBits = ''
  if (hasNav) {
    const links = nav.map(function (c) {
      if (!c || typeof c !== 'object') return ''
      const id = esc(c.id)
      const name = esc(c.name || c.id)
      const selected = String(c.id) === String(opts.selectedId)
      return '<a class="child-link' + (selected ? ' is-selected' : '') +
        '" href="?child=' + id + '"' +
        (selected ? ' aria-current="true"' : '') +
        '>' + name + '</a>'
    }).filter(Boolean).join('')
    if (links) childBits = '<div class="child-switch">' + links + '</div>'
  }

  const actions = []
  if (hasExport) {
    actions.push('<a class="btn" href="' + esc(opts.exportHref) +
      '">Export</a>')
  }
  if (hasClear) {
    // Deleting is a POST (a link, which another site can send someone to, must never delete anything), with a confirm.
    actions.push('<form class="inline-form" method="POST" action="' + esc(opts.clearHref) +
      '" onsubmit="return confirm(\'Clear all of the saved sessions for this child? This cannot be undone.\')">' +
      '<button type="submit" class="btn btn-danger">Clear all</button></form>')
  }
  const actionBits = actions.length
    ? '<div class="nav-actions">' + actions.join('') + '</div>'
    : ''

  return '' +
    '<nav class="topnav no-print">' + childBits + actionBits + '</nav>'
}

// ---------------------------------------------------------------------------
// Empty-state detection
// ---------------------------------------------------------------------------

/**
 * Essentially no data: no sessions and nothing in any of the content arrays.
 */
function isEmpty (report) {
  if (count(report.sessionCount) > 0) return false
  const did = Array.isArray(report.did) ? report.did : []
  const glance = Array.isArray(report.atGlance) ? report.atGlance : []
  const books = Array.isArray(report.booksRead) ? report.booksRead : []
  if (did.length > 0 || glance.length > 0 || books.length > 0) return false
  if (count(report.parkedCount) + count(report.movingCount) > 0) return false
  return true
}

// ---------------------------------------------------------------------------
// The stylesheet — inline, self-contained, offline-friendly, print-aware.
// ---------------------------------------------------------------------------

function styles () {
  return '' +
    ':root{' +
    '--ink:#2c2a26;--muted:#6b665e;--line:#e6e1d8;--bg:#faf7f1;' +
    '--card:#ffffff;--accent:#7a5c2e;--danger:#8a3b2e;' +
    '}' +
    '*{box-sizing:border-box}' +
    'html{-webkit-text-size-adjust:100%}' +
    'body{margin:0;background:var(--bg);color:var(--ink);' +
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,' +
    'Helvetica,Arial,sans-serif;line-height:1.65;' +
    'font-size:17px;padding:24px 16px 64px}' +
    '.wrap{max-width:760px;margin:0 auto}' +
    'h1{font-size:2rem;margin:0 0 4px;line-height:1.2}' +
    'h2{font-size:1.15rem;margin:0 0 10px;letter-spacing:.01em;' +
    'color:var(--accent)}' +
    'p{margin:0 0 12px}' +
    'section{background:var(--card);border:1px solid var(--line);' +
    'border-radius:12px;padding:18px 22px;margin:0 0 18px}' +
    '.report-head{background:none;border:none;padding:8px 0 6px;margin:0 0 8px}' +
    '.report-head .sub{color:var(--muted);font-size:1rem;margin:0}' +
    // where-played line: quiet, no card chrome needed but keep card for rhythm
    '.where p{margin:0;color:var(--muted)}' +
    // banner
    '.banner{background:#fbf3e2;border-color:#e6d8b8}' +
    '.banner p{margin:0}' +
    // what they did
    '.did-list{list-style:none;margin:0;padding:0}' +
    '.did-list li{display:flex;justify-content:space-between;' +
    'gap:16px;padding:9px 0;border-bottom:1px solid var(--line)}' +
    '.did-list li:last-child{border-bottom:none}' +
    '.did-label{font-weight:600}' +
    '.did-meta{color:var(--muted);text-align:right;white-space:nowrap;' +
    'font-size:.92rem}' +
    // at a glance table
    '.glance-table{width:100%;border-collapse:collapse;' +
    'font-variant-numeric:tabular-nums}' +
    '.glance-table th{text-align:left;font-size:.8rem;font-weight:600;' +
    'text-transform:uppercase;letter-spacing:.04em;color:var(--muted);' +
    'padding:0 10px 8px 0;border-bottom:2px solid var(--line)}' +
    '.glance-table td{padding:11px 10px 11px 0;' +
    'border-bottom:1px solid var(--line);vertical-align:top}' +
    '.glance-table tr:last-child td{border-bottom:none}' +
    '.g-label{font-weight:600}' +
    '.g-count,.g-measure{color:var(--muted)}' +
    '.g-level{text-align:right;white-space:nowrap}' +
    // level pills
    '.pill{display:inline-block;padding:2px 11px;border-radius:999px;' +
    'font-size:.85rem;font-weight:600;border:1px solid transparent}' +
    '.lvl-secure{background:#e3efe1;color:#2f5d34;border-color:#c4ddc2}' +
    '.lvl-developing{background:#e6eef6;color:#2c4d6b;border-color:#c6d8ea}' +
    '.lvl-beginning{background:#f6ecdd;color:#6b4a20;border-color:#e6d3b4}' +
    '.lvl-none{background:#efece7;color:#6b665e;border-color:#ddd7cd}' +
    // caveat blockquote
    '.caveat{margin:14px 0 0;padding:12px 16px;border-left:3px solid ' +
    'var(--accent);background:#f7f2e8;color:#4a4640;border-radius:0 8px 8px 0;' +
    'font-size:.96rem}' +
    // suggestions
    '.suggestions ul{margin:0;padding-left:20px}' +
    '.suggestions li{margin:0 0 6px}' +
    // where to explore next
    '.focus-list{list-style:none;margin:0;padding:0}' +
    '.focus-list li{padding:8px 0;border-bottom:1px solid var(--line)}' +
    '.focus-list li:last-child{border-bottom:none}' +
    '.focus-label{display:block;font-weight:600}' +
    '.focus-note{display:block;color:var(--muted);font-size:.94rem}' +
    // what this is — quiet footer
    '.what-is{background:none;border:none;padding:14px 0 0;margin:8px 0 0;' +
    'border-top:1px solid var(--line);border-radius:0}' +
    '.what-is p{color:var(--muted);font-size:.9rem;margin:0}' +
    // nav
    '.topnav{display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between;' +
    'align-items:center;margin:0 0 20px}' +
    '.child-switch{display:flex;flex-wrap:wrap;gap:6px}' +
    '.child-link{display:inline-block;padding:5px 12px;border-radius:999px;' +
    'text-decoration:none;color:var(--ink);border:1px solid var(--line);' +
    'background:var(--card);font-size:.9rem}' +
    '.child-link.is-selected{background:var(--accent);color:#fff;' +
    'border-color:var(--accent)}' +
    '.nav-actions{display:flex;gap:8px}' +
    '.btn{display:inline-block;padding:5px 14px;border-radius:8px;' +
    'text-decoration:none;font-size:.9rem;border:1px solid var(--line);' +
    'background:var(--card);color:var(--ink)}' +
    '.btn-danger{color:var(--danger);border-color:#e0c4bd}' +
    'button.btn{font:inherit;font-size:.9rem;cursor:pointer}' +
    '.inline-form{display:inline;margin:0}' +
    // empty state
    '.empty{text-align:center;padding:48px 22px}' +
    '.empty h1{color:var(--accent);margin-bottom:10px}' +
    '.empty p{color:var(--muted)}' +
    // print stylesheet
    '@media print{' +
    'body{background:#fff;color:#000;font-size:12pt;padding:0}' +
    '.no-print,.topnav{display:none !important}' +
    'section{border:1px solid #ccc;border-radius:0;page-break-inside:avoid;' +
    'padding:10px 0;margin:0 0 12px;background:#fff}' +
    '.report-head,.what-is,.where{border:none}' +
    'h2{color:#000}' +
    '.banner{background:#fff;border:1px solid #999}' +
    '.caveat{background:#fff;border-left:3px solid #000;color:#000}' +
    '.pill{background:#fff !important;color:#000 !important;' +
    'border:1px solid #000 !important}' +
    '.what-is p,.where p,.did-meta,.g-count,.g-measure{color:#333}' +
    'a{color:#000;text-decoration:none}' +
    '}'
}

// ---------------------------------------------------------------------------
// Document shell
// ---------------------------------------------------------------------------

function documentShell (title, bodyInner) {
  return '<!DOCTYPE html>\n' +
    '<html lang="en">\n' +
    '<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<meta name="robots" content="noindex, nofollow">\n' +
    '<title>' + esc(title) + '</title>\n' +
    '<style>' + styles() + '</style>\n' +
    '</head>\n' +
    '<body>\n' +
    '<div class="wrap">\n' + bodyInner + '\n</div>\n' +
    '</body>\n' +
    '</html>\n'
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Render the full HTML document for a parent report page.
 *
 * @param {object} report - see module docstring for shape (all optional).
 * @param {object} [opts] - optional { childrenNav, selectedId, exportHref,
 *   clearHref }.
 * @returns {string} a complete HTML document.
 */
function renderReportPage (report, opts) {
  report = report && typeof report === 'object' ? report : {}
  const nav = navBar(report, opts)

  // Raw title — documentShell() escapes it exactly once.
  const title = report.childName
    ? report.childName + ' — BeeboSchool'
    : 'BeeboSchool report'

  // Gentle empty state when there is essentially nothing to show.
  if (isEmpty(report)) {
    const who = report.childName ? esc(report.childName) : 'this child'
    const empty =
      nav +
      '<div class="empty">' +
      '<h1>No lessons recorded yet</h1>' +
      '<p>Once ' + who + ' has played a few BeeboSchool lessons on this ' +
      'device, a summary of what they did will appear here.</p>' +
      '<p class="what-is-note" style="margin-top:24px;font-size:.9rem">' +
      'Nothing on this page is ever sent anywhere — it lives only on this ' +
      'computer.</p>' +
      '</div>'
    return documentShell(title, empty)
  }

  // Assemble sections in the required order, skipping empties.
  // "What they did" leads when present (a folder of work, not a scorecard),
  // so it is placed ahead of the summary/where lines per the spec's emphasis.
  const sections = [
    sectionHeader(report),
    sectionWherePlayed(report),
    sectionUnmeasured(report),
    sectionWhatDid(report),
    sectionBooksRead(report),
    sectionAtGlance(report),
    sectionHowWent(report),
    sectionFocusAreas(report),
    sectionSuggestions(report),
    sectionWhatThisIs()
  ].filter(Boolean).join('\n')

  return documentShell(title, nav + '\n' + sections)
}

module.exports = { renderReportPage }
