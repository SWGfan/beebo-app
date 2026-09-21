// contrast.js - WCAG 2.x contrast maths, used by the tests that keep the theme colours at AA
// (test/a11y-helpers.test.js) and handy when choosing a new colour.
//   AA normal text 4.5:1 - large text (18px, or 14px bold) and UI outlines 3:1.

/** '#rgb', '#rrggbb' or '#rrggbbaa' -> { r, g, b, a } (0-255, a 0-1), or null. */
export function parseColor(value) {
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(String(value || '').trim())
  if (!m) return null
  let hex = m[1]
  if (hex.length <= 4) hex = hex.split('').map((c) => c + c).join('')
  const num = (i) => parseInt(hex.slice(i, i + 2), 16)
  return { r: num(0), g: num(2), b: num(4), a: hex.length === 8 ? num(6) / 255 : 1 }
}

/** The colour `fg` (with any alpha) looks like drawn over the opaque `bg`. */
export function over(fg, bg) {
  const f = typeof fg === 'string' ? parseColor(fg) : fg
  const b = typeof bg === 'string' ? parseColor(bg) : bg
  if (!f || !b) return null
  const mix = (x, y) => Math.round(x * f.a + y * (1 - f.a))
  return { r: mix(f.r, b.r), g: mix(f.g, b.g), b: mix(f.b, b.b), a: 1 }
}

const channel = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }

export function luminance(color) {
  const c = typeof color === 'string' ? parseColor(color) : color
  return c ? 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b) : 0
}

/** Contrast ratio (1-21) of text `fg` on `bg`; a translucent fg is first blended onto bg. */
export function contrastRatio(fg, bg) {
  const back = typeof bg === 'string' ? parseColor(bg) : bg
  const front = over(fg, back)
  if (!front || !back) return 0
  const a = luminance(front)
  const b = luminance(back)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

export const AA_TEXT = 4.5
export const AA_LARGE_OR_UI = 3
export const meetsAA = (fg, bg, { large = false } = {}) => contrastRatio(fg, bg) >= (large ? AA_LARGE_OR_UI : AA_TEXT)
