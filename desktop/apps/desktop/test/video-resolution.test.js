// The Table view's resolution class (src/lib/videoResolution.js): a real video size in,
// "4K" / "1080p" / ... out. Film is the hard case: scope releases are cropped to 2.39:1,
// so their height alone says 720p for a 1080p movie.
// Run: node --test test/video-resolution.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const load = () => import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'lib', 'videoResolution.js')).href)

test('standard sizes', async () => {
  const { classifyResolution: c } = await load()
  assert.equal(c(7680, 4320), '8K')
  assert.equal(c(3840, 2160), '4K')
  assert.equal(c(4096, 2160), '4K')
  assert.equal(c(2560, 1440), '1440p')
  assert.equal(c(1920, 1080), '1080p')
  assert.equal(c(1280, 720), '720p')
  assert.equal(c(854, 480), '480p')
  assert.equal(c(720, 480), '480p')
  assert.equal(c(720, 576), '480p')
  assert.equal(c(640, 480), '480p')
})

test('scope (2.39:1) films keep the class of their width, not their cropped height', async () => {
  const { classifyResolution: c } = await load()
  assert.equal(c(1920, 800), '1080p')
  assert.equal(c(1920, 804), '1080p')
  assert.equal(c(3840, 1600), '4K')
  assert.equal(c(3840, 1608), '4K')
  assert.equal(c(4096, 1716), '4K')
  assert.equal(c(1280, 544), '720p')
  assert.equal(c(1280, 536), '720p')
  assert.equal(c(2560, 1072), '1440p')
})

test('odd, cropped and 4:3 sizes', async () => {
  const { classifyResolution: c } = await load()
  assert.equal(c(1920, 1040), '1080p', 'a little under 1080 tall')
  assert.equal(c(1920, 1036), '1080p')
  assert.equal(c(1904, 1072), '1080p', 'macroblock-cropped 1080p')
  assert.equal(c(1440, 1080), '1080p', '4:3 pillarbox: 1080 tall')
  assert.equal(c(1024, 768), '720p')
  assert.equal(c(3840, 2076), '4K')
  assert.equal(c(1276, 720), '720p')
})

test('small sizes are SD, not "other"', async () => {
  const { classifyResolution: c } = await load()
  assert.equal(c(640, 360), 'SD')
  assert.equal(c(480, 360), 'SD')
  assert.equal(c(320, 240), 'SD')
  assert.equal(c(176, 144), 'SD')
})

test('a rotated (portrait) phone clip is classed by its long side', async () => {
  const { classifyResolution: c } = await load()
  assert.equal(c(1080, 1920), '1080p')
  assert.equal(c(2160, 3840), '4K')
  assert.equal(c(720, 1280), '720p')
})

test('degenerate sizes are "Other"; missing data is null', async () => {
  const { classifyResolution: c } = await load()
  assert.equal(c(1, 1), 'Other', 'cover-art stream')
  assert.equal(c(100, 100), 'Other')
  assert.equal(c(5000, 4), 'Other', 'a one-pixel-tall strip')
  for (const [w, h] of [[null, null], [undefined, 1080], [1920, undefined], [0, 0], [-1920, 1080], ['abc', 1080], [NaN, 720], [1920, Infinity]]) {
    assert.equal(c(w, h), null, `${w}x${h}`)
  }
})

test('numeric strings from ffprobe are accepted', async () => {
  const { classifyResolution: c } = await load()
  assert.equal(c('1920', '800'), '1080p')
})

test('pixel count sorts by area, orientation-free', async () => {
  const { pixelCount: p } = await load()
  assert.equal(p(1920, 1080), 2073600)
  assert.equal(p(1080, 1920), 2073600)
  assert.ok(p(3840, 1608) > p(1920, 1080))
  assert.ok(p(1920, 1040) < p(1920, 1080))
  assert.equal(p(0, 1080), null)
  assert.equal(p(null, null), null)
})

test('ranks put sharper classes first and unknown last', async () => {
  const { resolutionRank: r, RESOLUTION_LABELS } = await load()
  const ranks = RESOLUTION_LABELS.map(r)
  assert.deepEqual(ranks, [...ranks].sort((a, b) => b - a), 'labels are listed sharpest first')
  assert.equal(r('nonsense'), -1)
  assert.equal(r(null), -1)
})

test('the app quality tier maps to a class, and an unknown tier to nothing', async () => {
  const { classFromTier: t, pixelsFromTier: px } = await load()
  assert.equal(t('2160p'), '4K')
  assert.equal(t('1080p'), '1080p')
  assert.equal(t('720p'), '720p')
  assert.equal(t('480p'), '480p')
  assert.equal(t('unknown'), null)
  assert.equal(t(undefined), null)
  assert.ok(px('2160p') > px('1080p') && px('1080p') > px('720p') && px('720p') > px('480p'))
  assert.equal(px('unknown'), null)
})

test('a show is described by its most common episode class, the sharper one on a tie', async () => {
  const { modeLabel: mode, bestLabel: best } = await load()
  assert.equal(mode(['1080p', '1080p', '720p']), '1080p')
  assert.equal(mode(['720p', '4K', '720p', '4K']), '4K')
  assert.equal(mode([null, null, '720p']), '720p', 'unknown episodes do not vote')
  assert.equal(mode([null, undefined]), null)
  assert.equal(mode([]), null)
  assert.equal(best(['480p', '1080p', null, '720p']), '1080p')
  assert.equal(best([null]), null)
})

test('dimensions are written WxH, or nothing when either is missing', async () => {
  const { formatDimensions: f } = await load()
  assert.equal(f(1920, 800), '1920x800')
  assert.equal(f(1919.6, 1080), '1920x1080')
  assert.equal(f(1920, 0), '')
  assert.equal(f(null, 1080), '')
})
