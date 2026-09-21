// Several files of one film: edition/resolution parsing, grouping, labels, primary choice,
// the client-aware default, true-duplicate detection, shared-progress siblings.
// Run: node --test test/movie-versions.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const mv = require('../electron/movieVersions')

const f = (fileName, size = 0, extra = {}) => ({ fileName, size, id: Buffer.from(fileName).toString('base64url'), ...extra })
const tags = mv.parseVersionTags

test('edition parsing from real-world names', () => {
  assert.equal(tags('Movie (2010) - Directors Cut.mkv').edition, "Director's Cut")
  assert.equal(tags("Movie (2010) - Director's Cut.mkv").edition, "Director's Cut")
  assert.equal(tags('Movie.2010.Directors.Cut.1080p.mkv').edition, "Director's Cut")
  assert.equal(tags('Movie (2010) {edition-Extended}.mkv').edition, 'Extended')
  assert.equal(tags('Movie (2010) {edition-Extended Cut}.mkv').edition, 'Extended')
  assert.equal(tags('Movie (2010) {edition-Cinema Restoration}.mkv').edition, 'Cinema Restoration')
  assert.equal(tags('Movie (2010) Extended.Edition.mkv').edition, 'Extended')
  assert.equal(tags('Movie (2010) - Theatrical.mp4').edition, 'Theatrical')
  assert.equal(tags('Movie (2010) IMAX.mkv').edition, 'IMAX')
  assert.equal(tags('Movie.2010.UNRATED.1080p.BluRay.mkv').edition, 'Unrated')
  assert.equal(tags('Movie (2010) Remastered.mkv').edition, 'Remastered')
  assert.equal(tags('Movie (1982) Final Cut 1080p.mkv').edition, 'Final Cut')
  assert.equal(tags('Movie (1982) Special Edition.mkv').edition, 'Special Edition')
  assert.equal(tags('Movie (1982) 25th Anniversary Edition.mkv').edition, 'Anniversary Edition')
  assert.equal(tags('Movie (2010).mkv').edition, '')
  assert.equal(tags('Movie (2010) - 4K.mkv').edition, '')
})

test('a title word that looks like an edition is not one', () => {
  assert.equal(tags('Extended Family (2015).mkv').edition, '')
  assert.equal(tags('The Ultimate Gift (2006).mkv').edition, '')
  assert.equal(tags('Unrated.mkv').edition, '')
  assert.equal(tags('Special (2019).mkv').edition, '')
})

test('resolution, HDR and source tags', () => {
  assert.equal(tags('Movie.2010.2160p.HDR.mkv').height, 2160)
  assert.equal(tags('Movie.2010.2160p.HDR.mkv').hdr, 'HDR')
  assert.equal(tags('Movie (2010) - 4K.mkv').height, 2160)
  assert.equal(tags('Movie (2010) [1080p].mkv').height, 1080)
  assert.equal(tags('Movie (2010) 720p.mkv').height, 720)
  assert.equal(tags('Movie (2010) 1920x1080.mkv').height, 1080)
  assert.equal(tags('Movie (2010) DVDRip.avi').height, 480)
  assert.equal(tags('Movie (2010).mkv').height, null)
  assert.equal(tags('Movie.2010.2160p.DV.mkv').hdr, 'Dolby Vision')
  assert.equal(tags('Movie.2010.2160p.Dolby.Vision.mkv').hdr, 'Dolby Vision')
  assert.equal(tags('Movie.2010.2160p.HDR10+.mkv').hdr, 'HDR10+')
  assert.equal(tags('Movie.2010.2160p.HDR10.mkv').hdr, 'HDR')
  assert.equal(tags('Movie.2010.1080p.DVD.mkv').hdr, '')
  assert.equal(tags('Movie.2010.1080p.BluRay.REMUX.mkv').source, 'Remux')
  assert.equal(tags('Movie.2010.1080p.WEB-DL.mkv').source, 'WEB-DL')
  assert.equal(tags('Movie.2010.1080p.BluRay.x264.mkv').source, 'BluRay')
})

test('heightClassOf handles cropped scope film', () => {
  assert.equal(mv.heightClassOf(1608, 3840), 2160)
  assert.equal(mv.heightClassOf(800, 1920), 1080)
  assert.equal(mv.heightClassOf(1080, 1920), 1080)
  assert.equal(mv.heightClassOf(720, 1280), 720)
  assert.equal(mv.heightClassOf(480, 854), 480)
  assert.equal(mv.heightClassOf(0, 0), null)
})

test('same TMDB id groups regardless of name; the primary keeps the old id', () => {
  const a = f('Inception (2010) 2160p.mkv', 40e9)
  const b = f('Inception (2010) 1080p.mkv', 9e9)
  const other = f('Dune (2021).mkv', 5e9)
  const metaOf = (n) => (/Inception/.test(n) ? { id: 27205 } : { id: 438631 })
  const { groups, groupOfFile } = mv.groupMovieFiles([a, other, b], { metaOf })
  assert.equal(groups.length, 2)
  const g = groupOfFile.get(a.fileName)
  assert.equal(groupOfFile.get(b.fileName), g)
  assert.equal(g.key, 'tmdb:27205')
  assert.equal(g.versions.length, 2)
  // phone-friendly default: the 1080p file keeps the film's id, the 4K stays a choice
  assert.equal(g.primary, b)
  assert.deepEqual(g.versions.map((v) => v.label), ['4K', '1080p'])
  assert.deepEqual(g.versions.map((v) => v.isDefault), [false, true])
  // group order follows the first file of each group
  assert.deepEqual(groups.map((x) => x.key), ['tmdb:27205', 'tmdb:438631'])
})

test('unmatched files group by cleaned title + year, and join a matched film', () => {
  const files = [
    f('Movie (2010) - Directors Cut.mkv'),
    f('Movie.2010.2160p.HDR.mkv'),
    f('Movie (2010) {edition-Extended}.mkv'),
    f('Movie (2011).mkv'),
    f('Other Film (2010).mkv')
  ]
  const { groups } = mv.groupMovieFiles(files, {})
  assert.equal(groups.length, 3)
  assert.equal(groups[0].files.length, 3)
  assert.equal(groups[1].files.length, 1)

  const matched = mv.groupMovieFiles([f('Odd Name.mkv'), f('Movie (2010) 1080p.mkv'), f('Movie (2010) 4K.mkv')], {
    metaOf: (n) => (n === 'Odd Name.mkv' || n === 'Movie (2010) 1080p.mkv' ? { id: 5 } : null)
  })
  assert.equal(matched.groups.length, 1, 'the unmatched 4K joins the matched film with the same title+year')
})

test('files with no readable title stand alone', () => {
  const { groups } = mv.groupMovieFiles([f('2010.mkv'), f('2011.mkv')], {})
  assert.equal(groups.length, 2)
})

test('labels: resolution when only resolution differs, edition when editions differ', () => {
  const res = mv.groupMovieFiles([f('M (2010) 2160p HDR.mkv', 40e9), f('M (2010) 1080p.mkv', 9e9), f('M (2010) 720p.mkv', 2e9)], {})
  assert.deepEqual(res.groups[0].versions.map((v) => v.label), ['4K HDR', '1080p', '720p'])

  const ed = mv.groupMovieFiles([f('M (2010).mkv', 9e9), f("M (2010) - Director's Cut.mkv", 10e9), f('M (2010) Extended.mkv', 11e9)], {})
  assert.deepEqual(ed.groups[0].versions.map((v) => v.label).sort(), ["Director's Cut", 'Extended', 'Standard'].sort())

  const both = mv.groupMovieFiles([f("M (2010) - Director's Cut 2160p.mkv", 40e9), f('M (2010) 1080p.mkv', 9e9)], {})
  assert.deepEqual(both.groups[0].versions.map((v) => v.label), ['Standard · 1080p', "Director's Cut · 4K"])
})

test('label collisions are resolved by source, then size, then a number', () => {
  const bySource = mv.groupMovieFiles([f('M.2010.1080p.BluRay.REMUX.mkv', 30e9), f('M.2010.1080p.WEB-DL.mkv', 5e9)], {})
  assert.deepEqual(bySource.groups[0].versions.map((v) => v.label).sort(), ['1080p · Remux', '1080p · WEB-DL'])

  const bySize = mv.groupMovieFiles([f('M (2010) 1080p.mkv', 8e9), f('M (2010) 1080p copy.mkv', 4.2e9)], {})
  assert.deepEqual(bySize.groups[0].versions.map((v) => v.label).sort(), ['1080p · 4.2 GB', '1080p · 8.0 GB'])

  const same = mv.groupMovieFiles([f('M (2010) 1080p.mkv', 8e9), f('M (2010) 1080p copy.mkv', 8e9)], {})
  const labels = same.groups[0].versions.map((v) => v.label)
  assert.equal(new Set(labels).size, 2)
  assert.ok(labels.some((l) => /#2$/.test(l)))

  const untagged = mv.groupMovieFiles([f('M (2010).mkv', 3e9), f('M (2010) copy.mkv', 5e9)], {})
  const ul = untagged.groups[0].versions.map((v) => v.label)
  assert.equal(new Set(ul).size, 2)
  assert.ok(ul.every(Boolean))
})

test('a probed height beats a missing name tag (cleanup strips resolution from names)', () => {
  const a = f('M (2010).mkv', 40e9)
  const b = f('M (2010) copy.mkv', 9e9)
  const heights = { [a.fileName]: 2160, [b.fileName]: 1080 }
  const { groups } = mv.groupMovieFiles([a, b], { heightOf: (x) => heights[x.fileName], hdrOf: (x) => (x === a ? 'HDR' : '') })
  assert.deepEqual(groups[0].versions.map((v) => v.label), ['4K HDR', '1080p'])
  assert.equal(groups[0].primary, b)
})

test('primary choice: ordinary edition, then the tallest <= 1080p, a lone 4K only if nothing else', () => {
  const only4k = mv.groupMovieFiles([f('M (2010) 2160p.mkv', 40e9), f('M (2010) 2160p HDR.mkv', 45e9)], {})
  assert.equal(only4k.groups[0].primary.fileName, 'M (2010) 2160p.mkv'.length ? only4k.groups[0].primary.fileName : '')
  const dc = mv.groupMovieFiles([f("M (2010) Director's Cut 1080p.mkv", 12e9), f('M (2010) 720p.mkv', 2e9)], {})
  assert.equal(dc.groups[0].primary.fileName, 'M (2010) 720p.mkv', 'an ordinary edition beats a special one for the old-client default')
  const t = mv.groupMovieFiles([f('M (2010) 2160p.mkv', 40e9), f('M (2010) 1080p.mkv', 9e9), f('M (2010) 720p.mkv', 3e9)], {})
  assert.equal(t.groups[0].primary.fileName, 'M (2010) 1080p.mkv')
  const only = mv.groupMovieFiles([f('M (2010) 2160p.mkv', 40e9), f('M (2010) 2160p.HDR.mkv', 41e9)], {})
  assert.equal(only.groups[0].versions.length, 2)
})

test('primaryFiles keeps input order and drops the other versions', () => {
  const a = f('A (2001) 1080p.mkv')
  const b = f('B (2002).mkv')
  const c = f('A (2001) 4K.mkv')
  const out = mv.primaryFiles([a, b, c], {})
  assert.deepEqual(out.map((x) => x.fileName), ['A (2001) 1080p.mkv', 'B (2002).mkv'])
  assert.equal(out[0], a)
})

test('publicVersions: only for 2+, exact field set, isCurrent optional', () => {
  const single = mv.groupMovieFiles([f('Solo (2010).mkv')], {})
  assert.equal(mv.publicVersions(single.groups[0]), null)
  const pair = mv.groupMovieFiles([f('M (2010) 2160p.mkv', 40e9), f('M (2010) 1080p.mkv', 9e9)], {})
  const g = pair.groups[0]
  const pub = mv.publicVersions(g, { currentId: g.versions[1].id })
  assert.deepEqual(Object.keys(pub[0]).sort(), ['edition', 'hdr', 'height', 'id', 'isCurrent', 'isDefault', 'label', 'sizeBytes'])
  assert.deepEqual(pub.map((v) => v.isCurrent), [false, true])
  assert.equal(Object.keys(mv.publicVersions(g)[0]).includes('isCurrent'), false)
})

test('preferredVersion: remembered choice wins, then cap, then direct-playable, then tallest', () => {
  const versions = [
    { id: 'k', label: '4K HDR', height: 2160, hdr: 'HDR', isDefault: false, direct: { android: false } },
    { id: 'h', label: '1080p', height: 1080, hdr: '', isDefault: true, direct: { android: true } },
    { id: 's', label: '720p', height: 720, hdr: '', isDefault: false, direct: { android: true } }
  ]
  assert.equal(mv.preferredVersion(versions, { remembered: 's' }), 's')
  assert.equal(mv.preferredVersion(versions, { remembered: 'gone' }), 'h', 'a stale choice is ignored')
  assert.equal(mv.preferredVersion(versions, {}), 'h', 'the phone that cannot direct-play 4K HEVC HDR gets 1080p')
  const capable = versions.map((v) => ({ ...v, direct: { android: true } }))
  assert.equal(mv.preferredVersion(capable, {}), 'k')
  assert.equal(mv.preferredVersion(capable, { prefs: { quality: '720p' } }), 's')
  assert.equal(mv.preferredVersion(capable, { prefs: { quality: 'auto' }, capHeight: 1080 }), 'h')
  assert.equal(mv.preferredVersion(capable, { capHeight: 480 }), 's', 'nothing under the cap: the smallest')
  assert.equal(mv.preferredVersion([], {}), null)
  const noVerdict = versions.map(({ direct, ...v }) => v)
  assert.equal(mv.preferredVersion(noVerdict, {}), 'k')
})

test('true duplicates need the same edition AND the same resolution class', () => {
  const files = [
    f('M (2010) 1080p.mkv'), f('M (2010) 1080p copy.mkv'),
    f('M (2010) 2160p.mkv'),
    f("M (2010) Director's Cut 1080p.mkv"),
    f('M (2010).mkv')
  ]
  const sets = mv.trueDuplicateSets(files, {})
  assert.equal(sets.length, 1)
  assert.deepEqual(sets[0].map((x) => x.fileName), ['M (2010) 1080p.mkv', 'M (2010) 1080p copy.mkv'])

  // no tags in the names: probed heights decide; unknown is never a duplicate of a known one
  const a = f('M (2010).mkv'); const b = f('M (2010) copy.mkv'); const c = f('M (2010) x.mkv')
  const h = { [a.fileName]: 1080, [b.fileName]: 1080, [c.fileName]: 0 }
  const s2 = mv.trueDuplicateSets([a, b, c], { heightOf: (x) => h[x.fileName] })
  assert.equal(s2.length, 1)
  assert.equal(s2[0].length, 2)
  // two unprobed, untagged copies: still duplicates (as before)
  assert.equal(mv.trueDuplicateSets([f('M (2010).mkv'), f('M (2010) copy.mkv')], {}).length, 1)
  // a 4K and a 1080p, and two editions: no duplicates at all
  assert.equal(mv.trueDuplicateSets([f('M (2010) 2160p.mkv'), f('M (2010) 1080p.mkv'), f('M (2010) Extended.mkv')], {}).length, 0)
})

test('siblingsOf: alone by default, the group once the server registers a resolver', () => {
  assert.deepEqual(mv.siblingsOf('A.mkv'), ['A.mkv'])
  mv.setSiblingResolver((n) => (n === 'A.mkv' || n === 'B.mkv' ? ['A.mkv', 'B.mkv'] : [n]))
  try {
    assert.deepEqual(mv.siblingsOf('B.mkv'), ['A.mkv', 'B.mkv'])
    assert.deepEqual(mv.siblingsOf('C.mkv'), ['C.mkv'])
  } finally { mv.setSiblingResolver(null) }
  mv.setSiblingResolver(() => { throw new Error('boom') })
  try { assert.deepEqual(mv.siblingsOf('A.mkv'), ['A.mkv']) } finally { mv.setSiblingResolver(null) }
})

test('rememberChoice is bounded and moves the newest to the end', () => {
  let all = {}
  for (let i = 0; i < 320; i++) all = mv.rememberChoice(all, 'u1', `g${i}`, `v${i}`)
  assert.equal(Object.keys(all.u1).length, 300)
  assert.equal(all.u1.g319, 'v319')
  assert.equal(all.u1.g0, undefined)
  all = mv.rememberChoice(all, 'u1', 'g319', '')
  assert.equal(all.u1.g319, undefined, 'an empty id clears the choice')
  let users = {}
  for (let i = 0; i < 510; i++) users = mv.rememberChoice(users, `u${i}`, 'g', 'v')
  assert.equal(Object.keys(users).length, 500)
})
