'use strict'
// Show notes are HTML written by whoever runs the podcast, so they are untrusted. This turns them
// into a small, fixed vocabulary of harmless markup before they are stored or shown:
//
//   - an ALLOW-LIST of tags (paragraphs, line breaks, lists, emphasis, quotes, code, headings) with
//     NO attributes at all, except links, which keep only an http(s) or mailto address and always
//     get rel="noopener noreferrer nofollow" target="_blank";
//   - script, style, iframe, object, embed, svg and friends are removed WITH their contents;
//     every other unknown tag is removed and its text kept;
//   - comments, CDATA, doctype and processing instructions are removed;
//   - text is entity-decoded once and escaped again, so what comes out cannot introduce a tag;
//   - open tags are closed at the end, nesting depth and total length are capped.
//
// It is a scanner, not a browser parser: it never builds a DOM and has no regex that backtracks
// over the whole input. Output is meant for innerHTML in an app whose page has no reason to trust it.

const MAX_INPUT = 200 * 1024
const MAX_OUTPUT = 40 * 1024
const MAX_DEPTH = 16

const ALLOWED = new Set(['p', 'br', 'a', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'u', 's', 'blockquote', 'code', 'pre', 'span', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
// Headings are shown small inside a page that has its own headings.
const RENAME = { h1: 'h4', h2: 'h4', h3: 'h4', h5: 'h4', h6: 'h4' }
const VOID = new Set(['br'])
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'svg', 'math', 'textarea', 'select', 'title', 'head', 'frameset', 'applet', 'audio', 'video', 'canvas', 'form'])
const LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:'])

const cp = (n) => String.fromCodePoint(n)
const REPLACEMENT = cp(0xfffd)
const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: cp(0xa0), copy: cp(0xa9), reg: cp(0xae), trade: cp(0x2122),
  hellip: cp(0x2026), mdash: cp(0x2014), ndash: cp(0x2013), lsquo: cp(0x2018), rsquo: cp(0x2019), ldquo: cp(0x201c), rdquo: cp(0x201d),
  bull: cp(0x2022), middot: cp(0xb7), laquo: cp(0xab), raquo: cp(0xbb), euro: cp(0x20ac), pound: cp(0xa3), yen: cp(0xa5), deg: cp(0xb0)
}

function decodeEntities(s) {
  if (s.indexOf('&') === -1) return s
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,8});/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (!Number.isInteger(code) || code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return REPLACEMENT
      return String.fromCodePoint(code)
    }
    return Object.prototype.hasOwnProperty.call(NAMED, body) ? NAMED[body] : m
  })
}

const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escAttr = (s) => escText(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;')

// C0 controls, space, DEL, C1 controls and the two Unicode line separators.
const UNSAFE_URL_CHARS = new RegExp('[\\x00-\\x20\\x7f-\\x9f' + cp(0x2028) + cp(0x2029) + ']', 'g')

// A link target that is safe to keep, or ''. Entities are decoded and control characters and
// spaces removed first, because "java&#x09;script:" is how these checks get bypassed.
function safeHref(raw) {
  const cleaned = decodeEntities(String(raw || '')).replace(UNSAFE_URL_CHARS, '')
  if (!cleaned || cleaned.length > 2000) return ''
  let u
  try { u = new URL(cleaned) } catch { return '' }
  if (!LINK_SCHEMES.has(u.protocol)) return ''
  if ((u.protocol === 'http:' || u.protocol === 'https:') && (!u.hostname || u.username || u.password)) return ''
  return u.toString()
}

function findTagEnd(s, i) {
  let quote = 0
  for (let j = i + 1; j < s.length; j++) {
    const c = s.charCodeAt(j)
    if (quote) { if (c === quote) quote = 0 }
    else if (c === 34 || c === 39) quote = c
    else if (c === 62) return j
  }
  return -1
}

// End of the element that opened at `from`, i.e. just past the next "</tag ...>"; the input length when there is none.
function skipElement(s, from, tag) {
  const close = '</' + tag
  let at = from
  for (;;) {
    at = s.indexOf('</', at)
    if (at === -1) return s.length
    if (s.substr(at, close.length).toLowerCase() === close) {
      const gt = s.indexOf('>', at)
      return gt === -1 ? s.length : gt + 1
    }
    at += 2
  }
}

const HREF_RE = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i

/** Untrusted show notes in, safe markup out. Plain text (no tags) becomes paragraphs. */
function sanitizeHtml(input, { maxOutput = MAX_OUTPUT } = {}) {
  let s = String(input == null ? '' : input)
  if (s.length > MAX_INPUT) s = s.slice(0, MAX_INPUT)
  if (!s.trim()) return ''
  if (s.indexOf('<') === -1) {
    const paras = decodeEntities(s).replace(/\r\n?/g, '\n').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
    let text = ''
    for (const p of paras) {
      if (text.length >= maxOutput) break
      text += '<p>' + escText(p.slice(0, maxOutput - text.length)).replace(/\n/g, '<br>') + '</p>'
    }
    return text
  }
  let out = ''
  // Text is cut BEFORE it is escaped, so a cap can never split a tag or an entity.
  const addText = (raw) => { out += escText(decodeEntities(raw).slice(0, Math.max(0, maxOutput - out.length))) }
  const open = [] // the allowed tags currently open, by output name
  let i = 0
  const n = s.length
  while (i < n && out.length < maxOutput) {
    const lt = s.indexOf('<', i)
    if (lt === -1) { addText(s.slice(i)); break }
    if (lt > i) addText(s.slice(i, lt))
    const next = s.charCodeAt(lt + 1)
    const isLetter = (next >= 65 && next <= 90) || (next >= 97 && next <= 122)
    if (s.startsWith('<!--', lt)) {
      const end = s.indexOf('-->', lt + 4)
      i = end === -1 ? n : end + 3
      continue
    }
    if (next === 33 || next === 63) { // <! ... > and <? ... >
      const end = s.indexOf('>', lt + 2)
      i = end === -1 ? n : end + 1
      continue
    }
    if (!isLetter && next !== 47) { out += '&lt;'; i = lt + 1; continue }
    const end = findTagEnd(s, lt)
    if (end === -1) { addText(s.slice(lt)); break }
    const inner = s.slice(lt + 1, end)
    i = end + 1
    const closing = inner.charCodeAt(0) === 47
    const m = /^\/?\s*([A-Za-z][A-Za-z0-9-]*)/.exec(inner)
    if (!m) continue
    const tag = m[1].toLowerCase()
    if (!closing && DROP_WITH_CONTENT.has(tag)) { i = skipElement(s, i, tag); continue }
    if (!ALLOWED.has(tag)) continue
    const name = RENAME[tag] || tag
    if (closing) {
      const k = open.lastIndexOf(name)
      if (k === -1) continue
      while (open.length > k) out += `</${open.pop()}>`
      continue
    }
    if (VOID.has(name)) { out += '<br>'; continue }
    if (open.length >= MAX_DEPTH) continue
    if (name === 'a') {
      const hm = HREF_RE.exec(inner.slice(m[0].length))
      const href = hm ? safeHref(hm[1] !== undefined ? hm[1] : hm[2] !== undefined ? hm[2] : hm[3]) : ''
      if (!href) continue // no usable address: the link text stays, the link goes
      out += `<a href="${escAttr(href)}" rel="noopener noreferrer nofollow" target="_blank">`
    } else {
      out += `<${name}>`
    }
    open.push(name)
  }
  while (open.length) out += `</${open.pop()}>`
  return out
}

/** Show notes as plain text: tags gone, entities decoded, whitespace tidied. */
function htmlToText(input, max = 2000) {
  // Through the sanitizer first: what is left is a fixed vocabulary of tags and escaped text, so the
  // replacements below cannot be steered into a slow match by hostile input.
  let s = sanitizeHtml(input)
  s = s.replace(/<\/?(?:br|p|div|li|h4|blockquote|pre|ul|ol)>/g, '\n').replace(/<[^>]*>/g, '')
  s = decodeEntities(s).replace(/[ \t\xa0]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return s.length > max ? s.slice(0, max - 1).trimEnd() + cp(0x2026) : s
}

module.exports = { sanitizeHtml, htmlToText, safeHref, decodeEntities }
