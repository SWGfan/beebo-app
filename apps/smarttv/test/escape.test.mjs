import test from 'node:test'
import assert from 'node:assert/strict'
import {
  safeText, safeLine, escapeHtml, isSafeRelPath, safeRelPath, safeImageUrl, hasControlChars,
  formatClock, formatRuntime, formatRating, formatYear, clampNumber, safeInt
} from '../app/js/util/escape.js'

const C = (...codes) => String.fromCharCode(...codes)

test('safeText passes normal text and coerces primitives', () => {
  assert.equal(safeText('Alien: Resurrection'), 'Alien: Resurrection')
  assert.equal(safeText(42), '42')
  assert.equal(safeText(null), '')
  assert.equal(safeText(undefined), '')
})

test('safeText refuses objects, arrays and functions (never "[object Object]")', () => {
  assert.equal(safeText({ toString: () => '<b>x</b>' }), '')
  assert.equal(safeText(['a']), '')
  assert.equal(safeText(function () {}), '')
})

test('safeText strips control, bidi-override and zero-width characters', () => {
  assert.equal(safeText('a' + C(0) + 'b' + C(7) + 'c'), 'abc')
  assert.equal(safeText('safe' + C(0x202e) + 'txt.exe'), 'safetxt.exe') // right-to-left override trick
  assert.equal(safeText('a' + C(0x200b) + 'b' + C(0x2066) + 'c' + C(0x2069) + 'd'), 'abcd')
  assert.equal(safeText('x' + C(0x85) + 'y' + C(0x7f) + 'z' + C(0xfeff)), 'xyz')
  assert.equal(safeText('a' + C(0x2028) + 'b' + C(0x2029) + 'c'), 'abc')
  assert.equal(safeText('keep\ttab\nnewline'), 'keep\ttab\nnewline')
})

test('safeText caps length with an ellipsis and stays bounded on huge input', () => {
  const out = safeText('x'.repeat(50), 10)
  assert.equal(out.length, 10)
  assert.ok(out.endsWith(C(0x2026)))
  const big = safeText('y'.repeat(5 * 1024 * 1024), 100)
  assert.equal(big.length, 100)
})

test('safeLine collapses whitespace and newlines', () => {
  assert.equal(safeLine('  a \n\n  b\t c  '), 'a b c')
  assert.equal(safeLine('abcdefghij', 5).length, 5)
})

test('hostile markup survives as inert text (the DOM layer uses textContent, and escapeHtml is correct)', () => {
  const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>"\'`&'
  // safeText leaves markup characters alone (textContent makes them harmless)...
  assert.equal(safeText(evil), evil)
  // ...and the HTML escaper neutralises every one of them.
  const esc = escapeHtml(evil)
  assert.ok(!/[<>"'`]/.test(esc.replace(/&(lt|gt|quot|#39|#96|amp);/g, '')))
  assert.equal(escapeHtml('<b>'), '&lt;b&gt;')
  assert.equal(escapeHtml('a&b'), 'a&amp;b')
})

test('hasControlChars', () => {
  assert.equal(hasControlChars('abc'), false)
  assert.equal(hasControlChars('a' + C(10) + 'b'), true)
  assert.equal(hasControlChars('a' + C(0) + 'b'), true)
  assert.equal(hasControlChars('a' + C(0x7f)), true)
})

test('isSafeRelPath accepts server-relative paths only', () => {
  assert.ok(isSafeRelPath('/media/poster/12.jpg'))
  assert.ok(isSafeRelPath('/file?id=abc&mt=1.2.3'))
  const bad = ['', 'media/x', '//evil.example/x', '/\\evil', 'http://evil.example/', 'javascript:alert(1)',
    '/javascript:alert(1)', '/a' + C(0) + 'b', '/a\nb', '/a\\b', null, undefined, 5, {}]
  for (const b of bad) assert.equal(isSafeRelPath(b), false, String(b))
  assert.equal(safeRelPath('//x'), null)
  assert.equal(safeRelPath('/ok'), '/ok')
  assert.equal(isSafeRelPath('/' + 'a'.repeat(3000)), false)
})

test('safeImageUrl only allows https TMDB CDN images', () => {
  assert.equal(safeImageUrl('https://image.tmdb.org/t/p/w780/abc.jpg'), 'https://image.tmdb.org/t/p/w780/abc.jpg')
  const bad = ['http://image.tmdb.org/t/p/w780/a.jpg', 'https://evil.example/a.jpg', 'https://image.tmdb.org.evil.example/a.jpg',
    'https://image.tmdb.org/a"onerror="x', 'data:image/png;base64,AAAA', 'javascript:alert(1)', '', null, 7]
  for (const b of bad) assert.equal(safeImageUrl(b), null, String(b))
})

test('number helpers are total (never NaN)', () => {
  assert.equal(clampNumber('abc', 0, 10, 3), 3)
  assert.equal(clampNumber(99, 0, 10, 3), 10)
  assert.equal(clampNumber(-5, 0, 10, 3), 0)
  assert.equal(safeInt('12.7', 0), 12)
  assert.equal(safeInt(12.7, 0), 13)
  assert.equal(safeInt(undefined, -1), -1)
})

test('formatters', () => {
  assert.equal(formatClock(65), '1:05')
  assert.equal(formatClock(3725), '1:02:05')
  assert.equal(formatClock(-4), '0:00')
  assert.equal(formatClock(NaN), '0:00')
  assert.equal(formatRuntime(6300), '1 h 45 min')
  assert.equal(formatRuntime(2700), '45 min')
  assert.equal(formatRuntime(7200), '2 h')
  assert.equal(formatRuntime(0), '')
  assert.equal(formatRating(7.84), '7.8')
  assert.equal(formatRating(0), '')
  assert.equal(formatRating('x'), '')
  assert.equal(formatYear(1999), '1999')
  assert.equal(formatYear(0), '')
  assert.equal(formatYear('abc'), '')
})
