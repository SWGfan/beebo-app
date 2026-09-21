'use strict'
// A deliberately small XML reader for Kodi .nfo files.
//
// .nfo files come from other people's libraries and from downloads, so this reader does the
// opposite of a full XML engine: no DTD, no entity definitions, no external anything. A document
// that declares a DOCTYPE with an internal subset or an ENTITY is refused outright (that is the
// "billion laughs" and XXE door), only the five predefined entities and numeric character
// references are decoded, and size, depth and node count are capped. It never touches a file or a
// URL. The output is a plain tree; nothing is executed or resolved.
//
//   { name, attrs: {..}, children: [node], text }      text = the element's own text, trimmed

const MAX_BYTES = 2 * 1024 * 1024
const MAX_DEPTH = 40
const MAX_NODES = 60000
const MAX_TEXT = 20000

class XmlError extends Error {
  constructor(code) { super(code); this.code = code }
}

const NAMED = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

function decode(s) {
  if (s.indexOf('&') === -1) return s
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,4});/g, (m, body) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return ''
      if (cp < 32 && cp !== 9 && cp !== 10 && cp !== 13) return ''
      return String.fromCodePoint(cp)
    }
    return Object.prototype.hasOwnProperty.call(NAMED, body) ? NAMED[body] : m
  })
}

const NAME_START = /[A-Za-z_:À-￿]/
const NAME_CHAR = /[A-Za-z0-9_:.\-·À-￿]/

/**
 * @param {string|Buffer} input
 * @returns the root node. Throws XmlError('too_big' | 'doctype_refused' | 'malformed' | 'too_deep' | 'too_many_nodes').
 */
function parseXml(input, { maxBytes = MAX_BYTES, maxNodes = MAX_NODES } = {}) {
  let text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input == null ? '' : input)
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new XmlError('too_big')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const n = text.length
  let i = 0
  let nodes = 0
  const stack = []
  let root = null

  const readName = () => {
    const start = i
    if (i < n && NAME_START.test(text[i])) {
      i++
      while (i < n && NAME_CHAR.test(text[i])) i++
    }
    if (i === start) throw new XmlError('malformed')
    return text.slice(start, i)
  }
  const skipWs = () => { while (i < n && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++ }

  const addText = (raw) => {
    if (!stack.length) return
    const t = stack[stack.length - 1]
    if (t._len > MAX_TEXT) return
    t._parts.push(raw)
    t._len += raw.length
  }

  while (i < n) {
    const lt = text.indexOf('<', i)
    if (lt === -1) { addText(text.slice(i)); i = n; break }
    if (lt > i) addText(decode(text.slice(i, lt)))
    i = lt
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4)
      if (end === -1) throw new XmlError('malformed')
      i = end + 3
    } else if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i + 9)
      if (end === -1) throw new XmlError('malformed')
      addText(text.slice(i + 9, end))
      i = end + 3
    } else if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2)
      if (end === -1) throw new XmlError('malformed')
      i = end + 2
    } else if (text.startsWith('<!', i)) {
      // <!DOCTYPE ...> and <!ENTITY ...>: refused. A plain "<!DOCTYPE movie>" is harmless but
      // Kodi never writes one, so nothing legitimate is lost by refusing all of them.
      throw new XmlError('doctype_refused')
    } else if (text[i + 1] === '/') {
      i += 2
      const name = readName()
      skipWs()
      if (text[i] !== '>') throw new XmlError('malformed')
      i++
      const top = stack.pop()
      if (!top || top.name !== name) throw new XmlError('malformed')
      if (!stack.length) { root = top; break }
    } else {
      i++
      const name = readName()
      const attrs = {}
      let selfClose = false
      for (;;) {
        skipWs()
        if (i >= n) throw new XmlError('malformed')
        if (text[i] === '/' && text[i + 1] === '>') { selfClose = true; i += 2; break }
        if (text[i] === '>') { i++; break }
        const an = readName()
        skipWs()
        if (text[i] !== '=') throw new XmlError('malformed')
        i++
        skipWs()
        const q = text[i]
        if (q !== '"' && q !== "'") throw new XmlError('malformed')
        const end = text.indexOf(q, i + 1)
        if (end === -1) throw new XmlError('malformed')
        if (Object.keys(attrs).length < 30) attrs[an] = decode(text.slice(i + 1, end)).slice(0, 1000)
        i = end + 1
      }
      if (++nodes > maxNodes) throw new XmlError('too_many_nodes')
      const node = { name, attrs, children: [], text: '', _parts: [], _len: 0 }
      if (stack.length) stack[stack.length - 1].children.push(node)
      else if (root) throw new XmlError('malformed')
      if (selfClose) {
        if (!stack.length) { root = node; break }
      } else {
        if (stack.length >= MAX_DEPTH) throw new XmlError('too_deep')
        stack.push(node)
      }
    }
  }
  if (stack.length || !root) {
    // Kodi writes a bare URL after the XML in some .nfo files; a document that ended cleanly
    // before it is fine (we stop at the root's close tag above). Anything else is broken.
    throw new XmlError('malformed')
  }
  finish(root)
  return root
}

function finish(node) {
  const stackN = [node]
  while (stackN.length) {
    const cur = stackN.pop()
    cur.text = cur._parts.join('').trim().slice(0, MAX_TEXT)
    delete cur._parts
    delete cur._len
    for (const c of cur.children) stackN.push(c)
  }
}

// ---- reading helpers ---------------------------------------------------------------------------
const kids = (node, name) => (node ? node.children.filter((c) => c.name === name) : [])
const first = (node, name) => (node ? node.children.find((c) => c.name === name) || null : null)
const textOf = (node, name) => {
  const c = first(node, name)
  return c ? c.text : ''
}

module.exports = { parseXml, XmlError, kids, first, textOf, MAX_BYTES }
