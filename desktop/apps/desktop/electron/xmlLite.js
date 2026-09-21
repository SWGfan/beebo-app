'use strict'
// A small, deliberately limited XML reader for feeds someone else publishes (RSS, OPML).
//
// What makes it safe for untrusted input:
//   - <!DOCTYPE> is skipped when it is a bare name, and REFUSED when it declares anything
//     (<!ENTITY, an internal subset, SYSTEM/PUBLIC ids): no external entities (XXE), no
//     entity expansion ("billion laughs"). Only the five predefined entities and numeric
//     character references are decoded; any other &name; is left as literal text.
//   - Hard caps on input size, element count, nesting depth, attributes per element and
//     attribute length, so a hostile feed costs a bounded amount of memory and time.
//   - Linear-time scanning (indexOf and one character loop for tags), no backtracking regexes
//     over the whole document, no recursion (an explicit stack), no eval, no network.
//
// It is lenient about the mistakes real feeds make (a stray end tag, elements left open at the
// end) because a podcast that "does not parse" is worse than one with a slightly odd tree.
//
// Namespaces: an element's `name` is `prefix:local` with the prefix normalised for the
// vocabularies podcasts use (itunes, podcast, content, atom, media, dc, psc), whatever prefix the
// feed chose, so callers can ask for `itunes:image` without caring how it was spelled.

const LIMITS = Object.freeze({ maxBytes: 8 * 1024 * 1024, maxElements: 250000, maxDepth: 64, maxAttrs: 64, maxAttrLength: 8192 })

const KNOWN_NS = Object.freeze({
  'http://www.itunes.com/dtds/podcast-1.0.dtd': 'itunes',
  'https://podcastindex.org/namespace/1.0': 'podcast',
  'http://podcastindex.org/namespace/1.0': 'podcast',
  'http://purl.org/rss/1.0/modules/content/': 'content',
  'http://www.w3.org/2005/atom': 'atom',
  'http://search.yahoo.com/mrss/': 'media',
  'http://purl.org/dc/elements/1.1/': 'dc',
  'http://podlove.org/simple-chapters': 'psc'
})

class XmlError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'XmlError'
    this.code = code
  }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeEntities(s) {
  if (s.indexOf('&') === -1) return s
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,8});/g, (m, body) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      // NUL, surrogates and out-of-range values are not characters: a replacement character instead.
      if (!Number.isInteger(cp) || cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return String.fromCharCode(0xfffd)
      return String.fromCodePoint(cp)
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : m
  })
}

// Bytes to text: honours a BOM and the encoding named in the XML declaration, else UTF-8.
function decodeXmlBytes(buf) {
  if (typeof buf === 'string') return buf
  let label = 'utf-8'
  let start = 0
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) start = 3
  else if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) { label = 'utf-16le'; start = 2 }
  else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) { label = 'utf-16be'; start = 2 }
  else {
    const head = buf.subarray(0, 200).toString('latin1')
    const m = /^\s*<\?xml[^>]*\sencoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(head)
    if (m) label = m[1].toLowerCase()
  }
  try {
    return new TextDecoder(label).decode(buf.subarray(start))
  } catch {
    return new TextDecoder('utf-8').decode(buf.subarray(start))
  }
}

// Index of the '>' that ends the tag starting at `i` (which points at '<'), honouring quotes.
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

// Whitespace as a regex \s sees it, by code unit (the scanner below is a loop, not a regex).
const isWs = (c) => c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0xfeff || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000
// Characters that can never be part of a generic attribute name: space, "=", "/", "<", ">", quotes.
const isNameStop = (c) => isWs(c) || c === 61 || c === 47 || c === 60 || c === 62 || c === 34 || c === 39
// The stricter name shape some readers use: [A-Za-z_][A-Za-z0-9_:.-]*
const isStrictStart = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95
const isStrictChar = (c) => isStrictStart(c) || (c >= 48 && c <= 57) || c === 58 || c === 46 || c === 45

/**
 * name="value" / name='value' pairs of one tag's attribute text -> [{ name, raw }] (raw = the text between the
 * quotes, not decoded), at most `max` of them. A single pass with no backtracking: the regex this replaces
 * (name, optional spaces, "=") was quadratic on a tag holding one long run of name characters, and a feed, an
 * .nfo or a guide file is exactly where somebody can put one. `strict` uses the [A-Za-z_][\w:.-]* name shape.
 */
function scanAttrs(src, { max = Infinity, strict = false } = {}) {
  const out = []
  const s = String(src)
  const n = s.length
  let i = 0
  while (i < n && out.length < max) {
    const c = s.charCodeAt(i)
    if (strict ? !isStrictStart(c) : isNameStop(c)) { i++; continue }
    let j = i + 1
    if (strict) while (j < n && isStrictChar(s.charCodeAt(j))) j++
    else while (j < n && !isNameStop(s.charCodeAt(j))) j++
    let k = j
    while (k < n && isWs(s.charCodeAt(k))) k++
    if (s.charCodeAt(k) !== 61) { i = j; continue }
    k++
    while (k < n && isWs(s.charCodeAt(k))) k++
    const q = s.charCodeAt(k)
    if (q !== 34 && q !== 39) { i = j; continue }
    const end = s.indexOf(q === 34 ? '"' : "'", k + 1)
    if (end === -1) { i = j; continue }
    out.push({ name: s.slice(i, j), raw: s.slice(k + 1, end) })
    i = end + 1
  }
  return out
}

function parseAttrs(src, limits) {
  const out = {}
  let n = 0
  for (const a of scanAttrs(src, { max: limits.maxAttrs + 1 })) {
    if (++n > limits.maxAttrs) throw new XmlError('too_many_attributes')
    if (a.raw.length > limits.maxAttrLength) throw new XmlError('attribute_too_long')
    out[a.name] = decodeEntities(a.raw)
  }
  return out
}

/**
 * @param {string|Buffer} input
 * @returns {{ name: string, attrs: object, children: object[], text: string }} the root element
 */
function parseXml(input, opts = {}) {
  const limits = { ...LIMITS, ...opts }
  if (Buffer.isBuffer(input) && input.length > limits.maxBytes) throw new XmlError('too_large')
  let s = decodeXmlBytes(input)
  if (s.length > limits.maxBytes) throw new XmlError('too_large')
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1)

  const root = { name: '#document', attrs: {}, children: [], text: '', _ns: { xml: 'xml' } }
  const stack = [root]
  let elements = 0
  let i = 0
  const n = s.length
  const addText = (t) => { if (t) stack[stack.length - 1].text += t }

  while (i < n) {
    const lt = s.indexOf('<', i)
    if (lt === -1) { addText(decodeEntities(s.slice(i))); break }
    if (lt > i) addText(decodeEntities(s.slice(i, lt)))
    if (s.startsWith('<!--', lt)) {
      const end = s.indexOf('-->', lt + 4)
      if (end === -1) throw new XmlError('unterminated_comment')
      i = end + 3
    } else if (s.startsWith('<![CDATA[', lt)) {
      const end = s.indexOf(']]>', lt + 9)
      if (end === -1) throw new XmlError('unterminated_cdata')
      addText(s.slice(lt + 9, end))
      i = end + 3
    } else if (s.startsWith('<?', lt)) {
      const end = s.indexOf('?>', lt + 2)
      if (end === -1) throw new XmlError('unterminated_pi')
      i = end + 2
    } else if (s.startsWith('<!', lt)) {
      // <!DOCTYPE name> only. Anything that declares entities, has an internal subset or points at
      // an external identifier is refused outright.
      const end = findTagEnd(s, lt)
      if (end === -1) throw new XmlError('unterminated_doctype')
      const decl = s.slice(lt, end + 1)
      if (!/^<!DOCTYPE\s+[A-Za-z_][\w:.-]*\s*>$/i.test(decl)) throw new XmlError('doctype_not_allowed')
      i = end + 1
    } else if (s.charCodeAt(lt + 1) === 47) { // </name>
      const end = s.indexOf('>', lt + 2)
      if (end === -1) throw new XmlError('unterminated_tag')
      const raw = s.slice(lt + 2, end).trim()
      // Close the nearest open element with this (raw) name; a stray end tag is ignored.
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k]._raw === raw) { stack.length = k; break }
      }
      i = end + 1
    } else { // <name attr="v" ...> or <name ... />
      const end = findTagEnd(s, lt)
      if (end === -1) throw new XmlError('unterminated_tag')
      let inner = s.slice(lt + 1, end)
      const selfClose = inner.endsWith('/')
      if (selfClose) inner = inner.slice(0, -1)
      const sp = inner.search(/\s/)
      const raw = sp === -1 ? inner : inner.slice(0, sp)
      if (!raw || !/^[A-Za-z_:][\w:.-]*$/.test(raw)) throw new XmlError('bad_element_name')
      if (++elements > limits.maxElements) throw new XmlError('too_many_elements')
      if (stack.length > limits.maxDepth) throw new XmlError('too_deep')
      const attrs = sp === -1 ? {} : parseAttrs(inner.slice(sp), limits)
      const parent = stack[stack.length - 1]
      // Namespace scope: this element's xmlns declarations over the parent's.
      let ns = parent._ns
      for (const k of Object.keys(attrs)) {
        if (k === 'xmlns' || k.startsWith('xmlns:')) {
          if (ns === parent._ns) ns = Object.assign({}, parent._ns)
          ns[k === 'xmlns' ? '' : k.slice(6)] = attrs[k]
        }
      }
      const colon = raw.indexOf(':')
      const prefix = colon === -1 ? '' : raw.slice(0, colon)
      const local = colon === -1 ? raw : raw.slice(colon + 1)
      const uri = Object.prototype.hasOwnProperty.call(ns, prefix) ? String(ns[prefix]).toLowerCase() : ''
      const canon = Object.prototype.hasOwnProperty.call(KNOWN_NS, uri) ? KNOWN_NS[uri] : prefix
      const node = { name: canon ? `${canon}:${local}` : local, attrs, children: [], text: '', _raw: raw, _ns: ns }
      parent.children.push(node)
      if (!selfClose) stack.push(node)
      i = end + 1
    }
  }
  if (root.children.length !== 1) throw new XmlError('no_root_element')
  return strip(root.children[0])
}

// Drop the scanner's private fields so the tree is plain data (iteratively: no recursion on input depth).
function strip(rootNode) {
  const todo = [rootNode]
  while (todo.length) {
    const nd = todo.pop()
    delete nd._raw
    delete nd._ns
    for (const c of nd.children) todo.push(c)
  }
  return rootNode
}

const kids = (node, name) => (node ? node.children.filter((c) => c.name === name) : [])
const kid = (node, name) => (node ? node.children.find((c) => c.name === name) || null : null)
const textOf = (node) => (node ? node.text.replace(/\s+/g, ' ').trim() : '')
// First non-empty text among the named children.
function firstText(node, ...names) {
  for (const nm of names) {
    for (const c of kids(node, nm)) {
      const t = textOf(c)
      if (t) return t
    }
  }
  return ''
}

module.exports = { parseXml, decodeXmlBytes, decodeEntities, scanAttrs, XmlError, kids, kid, textOf, firstText, LIMITS }
