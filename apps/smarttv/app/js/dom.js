// Tiny DOM helpers. THE rule of this app: data goes in with textContent (h({text}) / setText), never
// innerHTML. There is deliberately no helper here that takes an HTML string.

/**
 * h('div', { cls:'tile', text:'Hello', attrs:{ role:'button' }, data:{ f:'1' }, on:{ click: fn }, css:{ width:'10px' } }, [children])
 * `text` is applied with textContent. Attributes named on*, style, href, src, srcdoc and formaction
 * are refused (src goes through setImage(); handlers go through `on`).
 */
export function h(tag, props, children) {
  var el = document.createElement(tag)
  var p = props || {}
  if (p.cls) el.className = p.cls
  if (p.text !== undefined && p.text !== null) el.textContent = String(p.text)
  if (p.attrs) {
    for (var k in p.attrs) {
      if (/^(on|style$|href$|src$|srcdoc$|formaction$)/i.test(k)) continue
      el.setAttribute(k, String(p.attrs[k]))
    }
  }
  if (p.data) for (var d in p.data) el.setAttribute('data-' + d, String(p.data[d]))
  if (p.css) for (var c in p.css) el.style[c] = p.css[c]
  if (p.on) for (var e in p.on) el.addEventListener(e, p.on[e], false)
  if (children) {
    for (var i = 0; i < children.length; i++) {
      var ch = children[i]
      if (ch === null || ch === undefined || ch === false) continue
      el.appendChild(typeof ch === 'string' ? document.createTextNode(ch) : ch)
    }
  }
  return el
}

/** Replace all children with plain text. */
export function setText(el, text) {
  el.textContent = text === null || text === undefined ? '' : String(text)
}

/** Remove every child (cheap, frees the subtree). */
export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild)
}

export function show(el, on) {
  el.style.display = on ? '' : 'none'
}

/** Make an element keyboard/remote focusable and give it its select handler. */
export function focusable(el, onSelect) {
  el.setAttribute('data-f', '1')
  el.onSelect = onSelect || null
  return el
}
