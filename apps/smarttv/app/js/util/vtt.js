// Tiny WebVTT (and SRT-ish) parser + cue lookup. DOM-free.
//
// Why not <track>? A <track src> from a packaged TV app to the home server is a cross-origin
// request in "cors" mode, so it would need Access-Control-Allow-Origin from the server. We fetch the
// text with our normal API client instead and draw cues ourselves (also lets the theme restyle
// captions for a 3-metre viewing distance). Cue text is plain text only: every tag is dropped and
// the result goes on screen via textContent.

import { safeText } from './escape.js'

var MAX_CUES = 20000
var MAX_TEXT = 400

function parseTime(str) {
  // 00:01:02.345 | 01:02.345 | 00:01:02,345
  var m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(str.trim())
  if (!m) return NaN
  var h = m[1] ? parseInt(m[1], 10) : 0
  var frac = parseInt((m[4] + '00').slice(0, 3), 10)
  return h * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + frac / 1000
}

function cleanCueText(lines) {
  var t = lines.join('\n')
  t = t.replace(/<[^>]*>/g, '') // <i>, <b>, <c.color>, <v Name>, timestamps
  t = t.replace(/\{\\[^}]*\}/g, '') // SSA-style {\an8}
  t = t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&lrm;|&rlm;/g, '')
  return safeText(t, MAX_TEXT).replace(/[ \t]+\n/g, '\n').trim()
}

/** @returns {Array<{start:number,end:number,text:string}>} sorted by start */
export function parseVtt(source) {
  var text = typeof source === 'string' ? source : ''
  if (text.length > 4 * 1024 * 1024) text = text.slice(0, 4 * 1024 * 1024)
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  text = text.replace(/\r\n?/g, '\n')
  var blocks = text.split(/\n{2,}/)
  var cues = []
  for (var i = 0; i < blocks.length && cues.length < MAX_CUES; i++) {
    var lines = blocks[i].split('\n')
    var ti = -1
    for (var j = 0; j < lines.length && j < 3; j++) {
      if (lines[j].indexOf('-->') >= 0) { ti = j; break }
    }
    if (ti < 0) continue // WEBVTT header, NOTE, STYLE, REGION, bare SRT index
    var parts = lines[ti].split('-->')
    var start = parseTime(parts[0])
    var end = parseTime(parts[1].trim().split(/\s+/)[0]) // drop cue settings ("align:start")
    if (!isFinite(start) || !isFinite(end) || end <= start) continue
    var body = cleanCueText(lines.slice(ti + 1))
    if (!body) continue
    cues.push({ start: start, end: end, text: body })
  }
  cues.sort(function (a, b) { return a.start - b.start })
  return cues
}

/**
 * The cue text to show at time t (seconds), or ''. `hint` is the index returned last time - cues
 * are sorted, so playback normally moves forward and we avoid a full scan every timeupdate.
 * Returns { text, index }.
 */
export function cueAt(cues, t, hint) {
  if (!cues || !cues.length) return { text: '', index: 0 }
  var i = typeof hint === 'number' && hint >= 0 && hint < cues.length ? hint : 0
  if (cues[i].start > t) i = 0 // user seeked backwards
  // Find the last cue that starts at or before t (binary search from the hint would also do; cues are few).
  var lo = i
  var hi = cues.length - 1
  while (lo < hi) {
    var mid = (lo + hi + 1) >> 1
    if (cues[mid].start <= t) lo = mid
    else hi = mid - 1
  }
  // Overlapping cues: walk back a few to find one still active.
  for (var k = lo; k >= 0 && k > lo - 4; k--) {
    if (cues[k].start <= t && t < cues[k].end) return { text: cues[k].text, index: k }
  }
  return { text: '', index: lo }
}
