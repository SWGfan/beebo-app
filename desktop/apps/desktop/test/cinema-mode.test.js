// Cinema Mode core: settings, local trailer discovery, the rating gate, the picker (rating limits,
// dedupe, offline fallback, tiers) and the service that ties them together. No network, no server.
// Run: node --test test/cinema-mode.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cm = require('../electron/cinemaMode')
const parental = require('../electron/parentalControls')

// ------------------------------------------------------------------ helpers

const memStore = (init = {}) => {
  const d = { ...init }
  return { get: (k) => d[k], set: (k, v) => { d[k] = v }, delete: (k) => { delete d[k] }, data: d }
}
const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-cinema-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
const touch = (file, size = 16) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.alloc(size, 1)) }
const seq = (n = 0) => () => (n = (n + 0.137) % 1)

// A fake TMDB source (same surface as cinemaOnline.createOnlineSource).
function fakeOnline({ key = true, details = {}, related = [], popular = [], reachable = true } = {}) {
  const calls = { details: [], related: [] }
  return {
    calls,
    hasKey: () => key,
    isReachable: () => reachable,
    details: async (id) => { calls.details.push(id); return details[id] || null },
    related: async (id) => { calls.related.push(id); return related },
    popular: async () => popular,
    comingSoon: async () => ({ upcoming: [], nowPlaying: [] })
  }
}
const YT = (n) => 'AbCdEfGhI' + String(n).padStart(2, '0') // 11 chars
const det = (tmdbId, o = {}) => ({ tmdbId, title: 'Film ' + tmdbId, year: 2020, genres: [28], certification: 'PG-13', collectionId: null, youtubeKey: YT(tmdbId), ...o })

// ------------------------------------------------------------------ settings

test('preferences are safe by default: off, two trailers, everything else on', () => {
  const p = cm.normalizePrefs(undefined)
  assert.equal(p.enabled, false)
  assert.equal(p.neverShow, false)
  assert.equal(p.count, 2)
  assert.deepEqual(p.sources, { local: true, owned: true, online: true })
  assert.equal(p.dedupeDays, 30)
})

test('preferences clamp junk: trailer count 0-5, days 0-365, only booleans are booleans', () => {
  const p = cm.normalizePrefs({ enabled: 'yes', count: 99, dedupeDays: -5, nightGapHours: 1000, sources: { online: false, local: 'nope' }, neverShow: 1 })
  assert.equal(p.enabled, false, 'a string is not true')
  assert.equal(p.neverShow, false)
  assert.equal(p.count, 5)
  assert.equal(p.dedupeDays, 0)
  assert.equal(p.nightGapHours, 24)
  assert.equal(p.sources.online, false)
  assert.equal(p.sources.local, true)
  assert.equal(cm.normalizePrefs({ count: -3 }).count, 0)
  assert.equal(cm.normalizePrefs({ count: 'x' }).count, 2)
})

test('preferences are per person and per profile, and setPrefs merges', () => {
  const store = memStore()
  cm.setPrefs(store, 'u1', '', { enabled: true, count: 3 })
  cm.setPrefs(store, 'u2', '', { neverShow: true })
  cm.setPrefs(store, 'u1', '', { sources: { online: false } })
  assert.deepEqual([cm.getPrefs(store, 'u1').enabled, cm.getPrefs(store, 'u1').count, cm.getPrefs(store, 'u1').sources.online, cm.getPrefs(store, 'u1').sources.local], [true, 3, false, true])
  assert.equal(cm.getPrefs(store, 'u2').enabled, false)
  assert.equal(cm.getPrefs(store, 'u2').neverShow, true)
  assert.equal(cm.getPrefs(store, 'u3').enabled, false)
  cm.setPrefs(store, 'u1', 'kid1', { count: 1 })
  assert.equal(cm.getPrefs(store, 'u1', 'kid1').count, 1)
  assert.equal(cm.getPrefs(store, 'u1').count, 3, 'a profile does not change the account setting')
})

test('owner config: intro must be a bare playable file name; nothing else is kept', () => {
  assert.equal(cm.normalizeConfig({ introFile: 'Feature Presentation.mp4' }).introFile, 'Feature Presentation.mp4')
  for (const bad of ['../evil.mp4', 'a/b.mp4', 'a\\b.mp4', '.hidden.mp4', 'clip.exe', 'clip.mkv', 'C:evil.mp4', '', null, 42]) {
    assert.equal(cm.normalizeConfig({ introFile: bad }).introFile, '', String(bad))
  }
  const c = cm.normalizeConfig({ available: false, maxTrailers: 50, maxTrailerSeconds: 5, folder: 'D:\\Cinema' })
  assert.equal(c.available, false)
  assert.equal(c.maxTrailers, 5)
  assert.equal(c.maxTrailerSeconds, 30)
  assert.equal(c.folder, 'D:\\Cinema')
  assert.equal(cm.normalizeConfig({}).available, true)
})

test('decideEnabled: default off; never-show beats everything; one-off asks; resuming; once per night; guests', () => {
  const config = cm.normalizeConfig({})
  const on = cm.normalizePrefs({ enabled: true })
  const now = 1_000_000_000
  assert.equal(cm.decideEnabled({ config, prefs: cm.normalizePrefs({}), now }).enabled, false, 'default OFF')
  assert.equal(cm.decideEnabled({ config, prefs: on, now }).enabled, true)
  assert.equal(cm.decideEnabled({ config, prefs: cm.normalizePrefs({ enabled: true, neverShow: true }), param: '1', now }).reason, 'never', 'never show trailers beats "Play with pre-show"')
  assert.equal(cm.decideEnabled({ config, prefs: cm.normalizePrefs({}), param: '1', now }).enabled, true, 'the Movie page toggle asks for one')
  assert.equal(cm.decideEnabled({ config, prefs: on, param: '0', now }).enabled, false)
  assert.equal(cm.decideEnabled({ config: cm.normalizeConfig({ available: false }), prefs: on, param: '1', now }).reason, 'unavailable', 'the owner can switch it off')
  assert.equal(cm.decideEnabled({ config, prefs: on, resuming: true, now }).reason, 'resuming')
  assert.equal(cm.decideEnabled({ config, prefs: on, resuming: true, param: '1', now }).enabled, true, 'explicit beats resuming')
  const once = cm.normalizePrefs({ enabled: true, oncePerNight: true, nightGapHours: 6 })
  assert.equal(cm.decideEnabled({ config, prefs: once, lastPreshowAt: now - 3600_000, now }).reason, 'once_per_night')
  assert.equal(cm.decideEnabled({ config, prefs: once, lastPreshowAt: now - 7 * 3600_000, now }).enabled, true)
  assert.equal(cm.decideEnabled({ config, prefs: once, lastPreshowAt: now - 3600_000, param: '1', now }).enabled, true, 'an explicit ask still plays')
  assert.equal(cm.decideEnabled({ config, prefs: on, isGuest: true, now }).reason, 'guest')
})

// ------------------------------------------------------------------ local trailer discovery

test('trailer file names: Kodi / Jellyfin / Plex conventions', () => {
  for (const ok of ['Movie-trailer.mp4', 'Movie_trailer.mp4', 'Movie.trailer.mp4', 'Movie - Trailer.mp4', 'Trailer.mp4', 'trailer2.webm', 'Movie (2020)-trailer.m4v', 'Movie [Teaser].mp4']) {
    assert.equal(cm.isTrailerFileName(ok), true, ok)
  }
  for (const no of ['Movie.mp4', 'The Trailer Park Boys.mp4', 'Trailers of Doom.mp4', 'Movie 2.mp4']) assert.equal(cm.isTrailerFileName(no), false, no)
  assert.equal(cm.stripTrailerMark('Movie (2020)-trailer'), 'Movie (2020)')
})

test('finds a trailer next to the film, in a trailers folder, and in a per-film folder', (t) => {
  const dir = tmp(t)
  touch(path.join(dir, 'Alpha (2020).mp4'))
  touch(path.join(dir, 'Alpha (2020)-trailer.mp4'))
  touch(path.join(dir, 'Beta (2019).mp4'))
  touch(path.join(dir, 'trailers', 'Beta (2019).mp4'))
  touch(path.join(dir, 'trailers', 'Gamma-trailer.webm')) // (Windows and macOS see "Trailers" and "trailers" as one folder)
  touch(path.join(dir, 'Gamma.mp4'))
  touch(path.join(dir, 'Delta (2018)', 'Trailer.mp4'))
  touch(path.join(dir, 'Delta (2018)', 'Delta (2018).mp4'))
  touch(path.join(dir, 'Epsilon.mp4'))
  touch(path.join(dir, 'Epsilon-trailer.mkv')) // not browser-playable: ignored
  touch(path.join(dir, 'Zeta.mp4'))
  touch(path.join(dir, 'Zeta-trailer.exe'))
  const idx = cm.buildTrailerIndex([dir])
  assert.deepEqual(idx.forMovie('Alpha (2020).mp4', dir), [path.join(dir, 'Alpha (2020)-trailer.mp4')])
  assert.deepEqual(idx.forMovie('Beta (2019).mp4', dir), [path.join(dir, 'trailers', 'Beta (2019).mp4')])
  assert.deepEqual(idx.forMovie('Gamma.mp4', dir), [path.join(dir, 'trailers', 'Gamma-trailer.webm')])
  assert.deepEqual(idx.forMovie('Delta (2018).mp4', dir), [path.join(dir, 'Delta (2018)', 'Trailer.mp4')])
  assert.deepEqual(idx.forMovie('Epsilon.mp4', dir), [])
  assert.deepEqual(idx.forMovie('Zeta.mp4', dir), [])
  assert.deepEqual(idx.forMovie('Nothing Here.mp4', dir), [])
})

test('a trailer is never matched to a different film with a similar name', (t) => {
  const dir = tmp(t)
  touch(path.join(dir, 'Star.mp4'))
  touch(path.join(dir, 'Star Wars-trailer.mp4'))
  touch(path.join(dir, 'Star Wars.mp4'))
  const idx = cm.buildTrailerIndex([dir])
  assert.deepEqual(idx.forMovie('Star.mp4', dir), [])
  assert.deepEqual(idx.forMovie('Star Wars.mp4', dir), [path.join(dir, 'Star Wars-trailer.mp4')])
})

test('symlinked trailers are ignored (a link cannot lead the pre-show outside the library)', (t) => {
  const dir = tmp(t)
  const outside = tmp(t)
  touch(path.join(outside, 'secret.mp4'))
  touch(path.join(dir, 'Alpha.mp4'))
  try { fs.symlinkSync(path.join(outside, 'secret.mp4'), path.join(dir, 'Alpha-trailer.mp4')) } catch { t.skip('symlinks not allowed on this machine'); return }
  assert.deepEqual(cm.buildTrailerIndex([dir]).forMovie('Alpha.mp4', dir), [])
})

test('Cinema folder: intros (root and Intros/), generic trailers (Trailers/), labelled ratings', (t) => {
  const dir = tmp(t)
  touch(path.join(dir, 'Feature Presentation.mp4'))
  touch(path.join(dir, 'Intros', 'Countdown.webm'))
  touch(path.join(dir, 'Trailers', 'Frozen 2 [PG].mp4'))
  touch(path.join(dir, 'Trailers', 'Saw (R).mp4'))
  touch(path.join(dir, 'notes.txt'))
  const l = cm.listCinemaFolder(dir)
  assert.deepEqual(l.intros.map((f) => f.name).sort(), ['Countdown.webm', 'Feature Presentation.mp4'])
  assert.deepEqual(l.trailers.map((f) => f.name).sort(), ['Frozen 2 [PG].mp4', 'Saw (R).mp4'])
  assert.equal(cm.certFromName('Frozen 2 [PG].mp4'), 'PG')
  assert.equal(cm.certFromName('Saw (R).mp4'), 'R')
  assert.equal(cm.certFromName('Plain.mp4'), null)
})

// ------------------------------------------------------------------ the rating gate

const policyFor = (raw) => parental.normalizePolicy({ enabled: true, preset: 'custom', ...raw })

test('a restricted profile never gets a trailer above its limit', () => {
  const policy = policyFor({ movieMax: 'PG', tvMax: 'TV-PG' })
  const ctx = { policy, restricted: true, featureLevel: null, matchFeatureRating: true }
  assert.equal(cm.evaluateCandidate({ kind: 'movie', certification: 'PG', genres: [] }, ctx).ok, true)
  assert.equal(cm.evaluateCandidate({ kind: 'movie', certification: 'G', genres: [] }, ctx).ok, true)
  const r = cm.evaluateCandidate({ kind: 'movie', certification: 'PG-13', genres: [] }, ctx)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'parental_rating')
  assert.equal(cm.evaluateCandidate({ kind: 'movie', certification: 'R', genres: [] }, ctx).ok, false)
})

test('an UNRATED trailer is refused for a restricted profile even when the profile allows unrated films', () => {
  const policy = policyFor({ movieMax: 'PG-13', blockUnrated: false })
  const ctx = { policy, restricted: true, featureLevel: null }
  const r = cm.evaluateCandidate({ kind: 'movie', certification: null, genres: [] }, ctx)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'parental_unrated')
  assert.equal(cm.evaluateCandidate({ kind: 'movie', certification: 'NR', genres: [] }, ctx).ok, false)
})

test('blocked genres, blocked titles, allow-list mode and CA scales are honoured', () => {
  const kids = policyFor({ movieMax: 'PG', blockedGenres: [27] })
  const ctx = { policy: kids, restricted: true }
  assert.equal(cm.evaluateCandidate({ kind: 'movie', certification: 'PG', genres: [27, 12] }, ctx).reason, 'parental_blocked_genre')
  const blocked = policyFor({ movieMax: 'R', blockedTitles: [{ kind: 'movie', tmdbId: 55 }] })
  assert.equal(cm.evaluateCandidate({ kind: 'movie', tmdbId: 55, certification: 'G', genres: [] }, { policy: blocked, restricted: true }).reason, 'parental_blocked_title')
  const allow = policyFor({ movieMax: 'R', allowListOnly: true, allowedTitles: [{ kind: 'movie', tmdbId: 7 }] })
  assert.equal(cm.evaluateCandidate({ kind: 'movie', tmdbId: 7, certification: 'PG', genres: [] }, { policy: allow, restricted: true }).ok, true)
  assert.equal(cm.evaluateCandidate({ kind: 'movie', tmdbId: 8, certification: 'PG', genres: [] }, { policy: allow, restricted: true }).reason, 'parental_not_on_allow_list')
  const ca = policyFor({ ratingSystem: 'CA', movieMax: '14A' })
  assert.equal(cm.evaluateCandidate({ kind: 'movie', certification: 'PG-13', genres: [] }, { policy: ca, restricted: true }).ok, true)
  assert.equal(cm.evaluateCandidate({ kind: 'movie', certification: 'R', genres: [] }, { policy: ca, restricted: true }).ok, false)
})

test('an unrestricted viewer sees anything the feature allows; theatre etiquette caps at the feature rating', () => {
  const free = { policy: parental.normalizePolicy(null), restricted: false, featureLevel: null, matchFeatureRating: true }
  assert.equal(cm.evaluateCandidate({ kind: 'movie', certification: 'R', genres: [27] }, free).ok, true, 'no feature rating known: no cap')
  const pg13 = { ...free, featureLevel: cm.levelOfCert('PG-13') }
  assert.equal(cm.evaluateCandidate({ kind: 'movie', certification: 'PG-13', genres: [] }, pg13).ok, true)
  assert.equal(cm.evaluateCandidate({ kind: 'movie', certification: 'PG', genres: [] }, pg13).ok, true)
  assert.equal(cm.evaluateCandidate({ kind: 'movie', certification: 'R', genres: [] }, pg13).reason, 'above_feature')
  assert.equal(cm.evaluateCandidate({ kind: 'movie', certification: null, genres: [] }, pg13).ok, true, 'unrated is fine before a teen film')
  const family = { ...free, featureLevel: cm.levelOfCert('G') }
  assert.equal(cm.evaluateCandidate({ kind: 'movie', certification: 'PG', genres: [] }, family).reason, 'above_feature')
  assert.equal(cm.evaluateCandidate({ kind: 'movie', certification: null, genres: [] }, family).reason, 'unrated_for_family_feature')
  assert.equal(cm.evaluateCandidate({ kind: 'movie', certification: 'G', genres: [27] }, family).reason, 'horror_for_family_feature')
  assert.equal(cm.evaluateCandidate({ kind: 'movie', certification: 'R', genres: [] }, { ...family, matchFeatureRating: false }).ok, true, 'the person can turn etiquette off')
})

test('a restricted viewer is capped by the profile even when etiquette is turned off', () => {
  const policy = policyFor({ movieMax: 'PG' })
  const ctx = { policy, restricted: true, featureLevel: cm.levelOfCert('R'), matchFeatureRating: false }
  assert.equal(cm.evaluateCandidate({ kind: 'movie', certification: 'R', genres: [] }, ctx).ok, false)
})

// ------------------------------------------------------------------ the picker

const cand = (tier, id, o = {}) => ({ tier, kind: 'movie', tmdbId: id, title: 'T' + id, year: 2020, genres: [28], certification: 'PG', collectionId: null,
  local: tier === 'local' ? { path: '/lib/t' + id + '-trailer.mp4' } : null, youtubeKey: null, key: 'l:' + id, titleKey: 't:m' + id, ...o })
const allow = () => ({ ok: true })

test('picker takes one from each tier in turn, up to count', async () => {
  const tiers = { local: [cand('local', 1), cand('local', 2)], owned: [cand('owned', 3, { key: 'y:t3' })], online: [cand('online', 4, { key: 'y:t4' })] }
  const resolve = async (c) => ({ ...c, youtubeKey: YT(c.tmdbId) })
  const r = await cm.pickTrailers({ tiers, count: 3, evaluate: allow, resolve })
  assert.deepEqual(r.picked.map((c) => c.tmdbId), [1, 3, 4])
  const two = await cm.pickTrailers({ tiers, count: 2, evaluate: allow, resolve })
  assert.deepEqual(two.picked.map((c) => c.tmdbId), [1, 3])
  const many = await cm.pickTrailers({ tiers, count: 5, evaluate: allow, resolve })
  assert.deepEqual(many.picked.map((c) => c.tmdbId), [1, 3, 4, 2])
  assert.equal((await cm.pickTrailers({ tiers, count: 0, evaluate: allow, resolve })).picked.length, 0)
})

test('picker: no repeats - by trailer key, by title key, and one film only once per night', async () => {
  const tiers = { local: [cand('local', 1), cand('local', 2), cand('local', 3, { titleKey: 't:m1', key: 'l:3' })], owned: [], online: [] }
  const recent = new Set(['l:1'])
  const r = await cm.pickTrailers({ tiers, count: 3, evaluate: allow, recent })
  assert.deepEqual(r.picked.map((c) => c.tmdbId), [2, 3], 'l:1 was shown; film 3 is a different file of film 1 and is allowed by key')
  const byTitle = await cm.pickTrailers({ tiers, count: 3, evaluate: allow, recent: new Set(['t:m1']) })
  assert.deepEqual(byTitle.picked.map((c) => c.tmdbId), [2], 'film 1 shown in any form is not shown again')
  const dup = await cm.pickTrailers({ tiers: { local: [cand('local', 1), cand('local', 3, { titleKey: 't:m1', key: 'l:3' })], owned: [], online: [] }, count: 2, evaluate: allow })
  assert.equal(dup.picked.length, 1, 'the same film is never picked twice in one pre-show')
  assert.ok(r.skipped.some((s) => s.reason === 'recent'))
})

test('picker: the rating gate is applied to every candidate, after the network step', async () => {
  const tiers = { local: [cand('local', 1, { certification: 'R' })], owned: [], online: [cand('online', 2, { key: 'y:t2', certification: null }), cand('online', 3, { key: 'y:t3', certification: null })] }
  const details = { 2: { certification: 'R' }, 3: { certification: 'PG' } }
  const resolve = async (c) => ({ ...c, certification: details[c.tmdbId].certification, youtubeKey: YT(c.tmdbId) })
  const evaluate = (c) => cm.evaluateCandidate(c, { policy: policyFor({ movieMax: 'PG' }), restricted: true })
  const r = await cm.pickTrailers({ tiers, count: 3, evaluate, resolve })
  assert.deepEqual(r.picked.map((c) => c.tmdbId), [3])
  assert.deepEqual(r.skipped.map((s) => s.reason).sort(), ['parental_rating', 'parental_rating'])
})

test('picker: a title with no trailer is skipped, probes are capped, a slow network stops probing', async () => {
  const online = Array.from({ length: 30 }, (_, i) => cand('online', i + 1, { key: 'y:t' + (i + 1) }))
  let calls = 0
  const none = async () => { calls++; return null }
  const r = await cm.pickTrailers({ tiers: { local: [], owned: [], online }, count: 2, evaluate: allow, resolve: none, maxProbes: 6 })
  assert.equal(r.picked.length, 0)
  assert.equal(calls, 6, 'never more than maxProbes lookups')
  let up = false
  const slow = async (c) => { up = true; return { ...c, youtubeKey: YT(c.tmdbId) } }
  const r2 = await cm.pickTrailers({ tiers: { local: [], owned: [], online }, count: 2, evaluate: allow, resolve: slow, timeUp: () => up })
  assert.equal(r2.picked.length, 1, 'time is up after the first lookup')
  const r3 = await cm.pickTrailers({ tiers: { local: [], owned: [], online }, count: 2, evaluate: allow, resolve: async () => { throw new Error('boom') }, maxProbes: 3 })
  assert.equal(r3.picked.length, 0, 'a throwing lookup is just no trailer')
})

test('picker: a resolved candidate must carry a valid 11-character video id', async () => {
  const online = [cand('online', 1, { key: 'y:t1' }), cand('online', 2, { key: 'y:t2' }), cand('online', 3, { key: 'y:t3' })]
  const keys = { 1: 'short', 2: '<script>alert(1)', 3: YT(3) }
  const r = await cm.pickTrailers({ tiers: { local: [], owned: [], online }, count: 3, evaluate: allow, resolve: async (c) => ({ ...c, youtubeKey: keys[c.tmdbId] }) })
  assert.deepEqual(r.picked.map((c) => c.tmdbId), [3])
})

test('scoring prefers shared genres, a close decade and a close rating', () => {
  const feature = { genres: [28, 12], year: 2019, certification: 'PG-13' }
  const flat = () => 0
  const near = cm.scoreCandidate({ genres: [28, 12], year: 2020, certification: 'PG-13' }, feature, flat)
  const far = cm.scoreCandidate({ genres: [99], year: 1970, certification: 'G' }, feature, flat)
  assert.ok(near > far + 2)
  assert.ok(cm.scoreCandidate({ genres: [28], year: 2019, certification: 'PG-13' }, feature, flat) > cm.scoreCandidate({ genres: [35], year: 2019, certification: 'PG-13' }, feature, flat))
})

// ------------------------------------------------------------------ the service

function world(t, over = {}) {
  const movies = tmp(t)
  const cinemaDir = tmp(t)
  const store = memStore({ cinemaDefaultDir: cinemaDir, authUsers: [{ id: 'owner', isAdmin: true, status: 'approved' }, { id: 'kid', status: 'approved' }] })
  const files = over.files || {}
  const owned = Object.entries(files).map(([fileName, meta]) => {
    touch(path.join(movies, fileName))
    return { id: Buffer.from(fileName).toString('base64url'), fileName, dir: movies, watched: !!meta.watched, meta: { tmdbId: meta.tmdbId || null, title: meta.title || path.basename(fileName, path.extname(fileName)), year: meta.year || 2020, genres: meta.genres || [28], certification: meta.certification === undefined ? 'PG-13' : meta.certification, collectionId: null } }
  })
  for (const f of over.extraFiles || []) touch(path.join(movies, ...f.split('/')))
  const online = over.online || fakeOnline()
  const feature = 'feature' in over ? over.feature : { fileName: 'Feature.mp4', dir: movies, meta: { tmdbId: 1000, title: 'Feature', year: 2020, genres: [28], certification: 'PG-13', collectionId: null } }
  const svc = cm.createCinemaService({
    store, getMovieDirs: () => [movies], listOwned: () => owned, resolveFeature: () => feature, online,
    sign: (id) => 'tok-' + id.replace(/[^a-z0-9]/gi, '').padEnd(12, 'x'), check: () => true, getPolicy: over.getPolicy, random: seq(), now: over.now || (() => 2_000_000_000_000), ...(over.deps || {})
  })
  return { svc, store, movies, cinemaDir, online }
}
const on = (store, patch = {}) => cm.setPrefs(store, 'owner', '', { enabled: true, count: 3, ...patch })
const ask = (svc, extra = {}) => svc.preroll({ userId: 'owner', kind: 'movie', id: 'FeatureId', ...extra })

test('service: default OFF answers with no items and never touches the network', async (t) => {
  const { svc, online } = world(t)
  const r = await ask(svc)
  assert.equal(r.ok, true)
  assert.equal(r.enabled, false)
  assert.equal(r.reason, 'disabled')
  assert.deepEqual(r.items, [])
  assert.equal(online.calls.details.length + online.calls.related.length, 0)
})

test('service: local trailers of unwatched owned films come first, with attribution and a signed url', async (t) => {
  const { svc, store } = world(t, { files: { 'Alpha (2020).mp4': { tmdbId: 1, watched: false }, 'Beta.mp4': { tmdbId: 2, watched: true } }, extraFiles: ['Alpha (2020)-trailer.mp4', 'Beta-trailer.mp4'] })
  on(store, { sources: { online: false, owned: false } })
  const r = await ask(svc)
  assert.equal(r.enabled, true)
  assert.equal(r.items.length, 1, 'the watched film is not advertised')
  const it = r.items[0]
  assert.equal(it.type, 'local')
  assert.equal(it.title, 'Alpha (2020)')
  assert.match(it.url, /^\/cinema\/media\/[a-f0-9]{20}\?mt=/)
  assert.equal(typeof it.attribution, 'string')
  assert.match(it.key, /^l:/)
  assert.equal(it.titleKey, 't:m1')
  assert.ok(!('path' in it) && !JSON.stringify(it).includes(path.sep + 'Alpha'), 'no file path leaks to the client')
})

test('service: trailer-named files are never offered as films to advertise', async (t) => {
  const { svc, store } = world(t, { files: { 'Alpha-trailer.mp4': { tmdbId: 9 }, 'Real.mp4': { tmdbId: 3 } }, extraFiles: ['Real-trailer.mp4'] })
  on(store, { sources: { online: false, owned: false } })
  const r = await ask(svc)
  assert.deepEqual(r.items.map((i) => i.title), ['Real'])
})

test('service: the feature\'s own trailer is not shown before it', async (t) => {
  const { svc, store } = world(t, { files: { 'Feature.mp4': { tmdbId: 1000 } }, extraFiles: ['Feature-trailer.mp4'] })
  on(store, { sources: { online: false, owned: false } })
  assert.equal((await ask(svc)).items.length, 0)
})

test('service: online trailers come from TMDB recommendations, as ids only, official ones', async (t) => {
  const online = fakeOnline({ related: [{ tmdbId: 11, title: 'Rec Eleven', year: 2021, popularity: 5 }, { tmdbId: 12, title: 'Rec Twelve', year: 2019, popularity: 9 }], details: { 11: det(11, { title: 'Rec Eleven' }), 12: det(12, { title: 'Rec Twelve', certification: 'PG' }) } })
  const { svc, store } = world(t, { online })
  on(store, { count: 2 })
  const r = await ask(svc)
  assert.equal(r.enabled, true)
  assert.equal(r.items.length, 2)
  for (const it of r.items) {
    assert.equal(it.type, 'youtube')
    assert.match(it.videoId, /^[A-Za-z0-9_-]{11}$/)
    assert.ok(!('url' in it), 'a YouTube item carries an id, never a url to fetch')
    assert.match(it.attribution, /YouTube/)
  }
  assert.deepEqual(online.calls.related, [1000])
  assert.equal(r.online, true)
  assert.match(r.tmdbAttribution, /TMDB/)
})

test('service: OFFLINE - no TMDB key or unreachable TMDB gives local trailers only, and says so', async (t) => {
  const localOnly = { files: { 'Alpha.mp4': { tmdbId: 1 } }, extraFiles: ['Alpha-trailer.mp4'] }
  const noKey = world(t, { ...localOnly, online: fakeOnline({ key: false }) })
  on(noKey.store)
  const a = await ask(noKey.svc)
  assert.deepEqual(a.items.map((i) => i.type), ['local'])
  assert.equal(a.online, null)
  const down = world(t, { ...localOnly, online: fakeOnline({ related: [], details: {}, reachable: false }) })
  on(down.store)
  const b = await down.svc.preroll({ userId: 'owner', kind: 'movie', id: 'X' })
  assert.deepEqual(b.items.map((i) => i.type), ['local'])
  assert.equal(b.online, false)
  const none = world(t, { online: fakeOnline({ key: false }) })
  on(none.store)
  const c = await ask(none.svc)
  assert.equal(c.enabled, true)
  assert.deepEqual(c.items, [], 'nothing to show is fine: the feature just plays')
  const blocked = world(t, { ...localOnly, online: fakeOnline({ related: [{ tmdbId: 5, title: 'x' }], details: { 5: det(5) } }) })
  on(blocked.store)
  cm.setConfig(blocked.store, { allowOnline: false })
  const d = await ask(blocked.svc)
  assert.deepEqual(d.items.map((i) => i.type), ['local'], 'the owner can forbid online trailers')
})

test('service: a TMDB lookup that throws never breaks the answer', async (t) => {
  const online = { ...fakeOnline({ related: [] }), related: async () => { throw new Error('tmdb down') } }
  const { svc, store } = world(t, { online, files: { 'A.mp4': { tmdbId: 1 } }, extraFiles: ['A-trailer.mp4'] })
  on(store)
  const r = await ask(svc)
  assert.equal(r.ok, true)
  assert.equal(r.items.length, 1)
})

test('service: PARENTAL GATE - a restricted profile gets nothing above its limit, from any tier', async (t) => {
  const online = fakeOnline({
    related: [{ tmdbId: 21, title: 'Fine' }, { tmdbId: 22, title: 'Too strong' }, { tmdbId: 23, title: 'Unrated' }],
    details: { 21: det(21, { title: 'Fine', certification: 'PG' }), 22: det(22, { title: 'Too strong', certification: 'R' }), 23: det(23, { title: 'Unrated', certification: null }) }
  })
  const { svc, store } = world(t, {
    online,
    files: { 'Kids (2020).mp4': { tmdbId: 31, certification: 'G' }, 'Grown.mp4': { tmdbId: 32, certification: 'R' }, 'Mystery.mp4': { tmdbId: 33, certification: null }, 'Teen.mp4': { tmdbId: 34, certification: 'PG-13' } },
    extraFiles: ['Kids (2020)-trailer.mp4', 'Grown-trailer.mp4', 'Mystery-trailer.mp4', 'Teen-trailer.mp4'],
    getPolicy: (u) => (u === 'kid' ? policyFor({ movieMax: 'PG', tvMax: 'TV-PG' }) : parental.normalizePolicy(null)),
    feature: { fileName: 'Feature.mp4', meta: { tmdbId: 1000, title: 'Feature', year: 2020, genres: [16], certification: 'PG', collectionId: null } }
  })
  cm.setPrefs(store, 'kid', '', { enabled: true, count: 5 })
  const r = await svc.preroll({ userId: 'kid', kind: 'movie', id: 'F' })
  const titles = r.items.map((i) => i.title).sort()
  assert.deepEqual(titles, ['Fine', 'Kids (2020)'], 'only G/PG, rated, allowed titles')
  for (const it of r.items) assert.notEqual(it.title, 'Grown')
  // the very same library for an unrestricted viewer at a PG-13 feature: the strong ones are allowed only up to the feature
  const free = world(t, { online, files: { 'Grown.mp4': { tmdbId: 32, certification: 'R' }, 'Teen.mp4': { tmdbId: 34, certification: 'PG-13' } }, extraFiles: ['Grown-trailer.mp4', 'Teen-trailer.mp4'] })
  on(free.store, { count: 5 })
  const f = await ask(free.svc)
  assert.ok(!f.items.some((i) => i.title === 'Grown' || i.title === 'Too strong'), 'no R trailer before a PG-13 feature')
  assert.ok(f.items.some((i) => i.title === 'Teen'))
})

test('service: a restricted profile\'s Cinema-folder trailer needs a rating label in its file name', async (t) => {
  const { svc, store, cinemaDir } = world(t, { getPolicy: () => policyFor({ movieMax: 'PG' }), feature: { fileName: 'Feature.mp4', meta: { tmdbId: 1000, title: 'Feature', year: 2020, genres: [16], certification: 'PG', collectionId: null } } })
  touch(path.join(cinemaDir, 'Trailers', 'Unlabelled.mp4'))
  touch(path.join(cinemaDir, 'Trailers', 'Family Film [G].mp4'))
  touch(path.join(cinemaDir, 'Trailers', 'Scary Film [R].mp4'))
  cm.setPrefs(store, 'owner', '', { enabled: true, count: 5, sources: { owned: false, online: false } })
  const r = await ask(svc)
  assert.deepEqual(r.items.map((i) => i.title), ['Family Film'])
})

test('service: NO REPEATS - trailers reported as seen are left out for N days, then come back', async (t) => {
  let clock = 2_000_000_000_000
  const w = world(t, { files: { 'A.mp4': { tmdbId: 1 }, 'B.mp4': { tmdbId: 2 } }, extraFiles: ['A-trailer.mp4', 'B-trailer.mp4'], now: () => clock })
  on(w.store, { count: 1, dedupeDays: 10, sources: { online: false, owned: false } })
  const seenTitles = new Set()
  for (let i = 0; i < 2; i++) {
    const r = await ask(w.svc)
    assert.equal(r.items.length, 1)
    seenTitles.add(r.items[0].title)
    assert.equal(w.svc.markSeen({ userId: 'owner', body: { items: r.items.map((x) => ({ key: x.key, titleKey: x.titleKey })) } }).ok, true)
    clock += 60_000
  }
  assert.deepEqual([...seenTitles].sort(), ['A', 'B'], 'the second night showed the other film')
  assert.equal((await ask(w.svc)).items.length, 0, 'both shown within 10 days: nothing left to show')
  clock += 11 * 24 * 3600_000
  assert.equal((await ask(w.svc)).items.length, 1, 'after the window they are eligible again')
})

test('service: dedupe is per person and can be turned off (0 days)', async (t) => {
  const w = world(t, { files: { 'A.mp4': { tmdbId: 1 } }, extraFiles: ['A-trailer.mp4'] })
  cm.setPrefs(w.store, 'owner', '', { enabled: true, count: 1, dedupeDays: 30, sources: { online: false, owned: false } })
  cm.setPrefs(w.store, 'kid', '', { enabled: true, count: 1, dedupeDays: 0, sources: { online: false, owned: false } })
  const first = await ask(w.svc)
  w.svc.markSeen({ userId: 'owner', body: { items: first.items.map((x) => ({ key: x.key, titleKey: x.titleKey })) } })
  assert.equal((await ask(w.svc)).items.length, 0)
  assert.equal((await w.svc.preroll({ userId: 'kid', kind: 'movie', id: 'F' })).items.length, 1, 'another person still sees it')
  w.svc.markSeen({ userId: 'kid', body: { items: first.items.map((x) => ({ key: x.key, titleKey: x.titleKey })) } })
  assert.equal((await w.svc.preroll({ userId: 'kid', kind: 'movie', id: 'F' })).items.length, 1, '0 days = never remember')
})

test('service: once per movie night', async (t) => {
  let clock = 2_000_000_000_000
  const w = world(t, { files: { 'A.mp4': { tmdbId: 1 }, 'B.mp4': { tmdbId: 2 }, 'C.mp4': { tmdbId: 3 } }, extraFiles: ['A-trailer.mp4', 'B-trailer.mp4', 'C-trailer.mp4'], now: () => clock })
  on(w.store, { count: 1, oncePerNight: true, nightGapHours: 4, sources: { online: false, owned: false } })
  const first = await ask(w.svc)
  assert.equal(first.enabled, true)
  w.svc.markSeen({ userId: 'owner', body: { items: [{ key: first.items[0].key }] } })
  clock += 2 * 3600_000
  const second = await ask(w.svc)
  assert.equal(second.enabled, false)
  assert.equal(second.reason, 'once_per_night')
  assert.equal((await ask(w.svc, { param: '1' })).enabled, true, 'Play with pre-show still plays one')
  clock += 3 * 3600_000
  assert.equal((await ask(w.svc)).enabled, true, 'a new night')
})

test('service: never-show and the owner switch stop everything, including a Movie-page request', async (t) => {
  const w = world(t, { files: { 'A.mp4': { tmdbId: 1 } }, extraFiles: ['A-trailer.mp4'] })
  on(w.store, { neverShow: true })
  assert.equal((await ask(w.svc, { param: '1' })).reason, 'never')
  on(w.store, { neverShow: false })
  assert.equal((await ask(w.svc, { param: '1' })).enabled, true)
  cm.setConfig(w.store, { available: false })
  assert.equal((await ask(w.svc, { param: '1' })).reason, 'unavailable')
})

test('service: no pre-show when resuming a film, for guests, for shows, or for a film that does not exist', async (t) => {
  const w = world(t)
  on(w.store)
  assert.equal((await ask(w.svc, { resuming: true })).reason, 'resuming')
  assert.equal((await ask(w.svc, { isGuest: true })).reason, 'guest')
  assert.equal((await ask(w.svc, { kind: 'tv' })).reason, 'not_a_movie')
  assert.equal((await ask(w.svc, { id: 'bad id!' })).reason, 'bad_id')
  const gone = world(t, { feature: null })
  on(gone.store)
  assert.equal((await ask(gone.svc)).reason, 'not_found')
})

test('service: trailer count is capped by the owner and by the person; 0 trailers = intro only', async (t) => {
  const files = {}
  const extra = []
  for (let i = 1; i <= 8; i++) { files['F' + i + '.mp4'] = { tmdbId: i }; extra.push('F' + i + '-trailer.mp4') }
  const w = world(t, { files, extraFiles: extra })
  on(w.store, { count: 5, sources: { online: false, owned: false } })
  assert.equal((await ask(w.svc)).items.length, 5)
  cm.setConfig(w.store, { maxTrailers: 2 })
  assert.equal((await ask(w.svc)).items.length, 2)
  cm.setConfig(w.store, { maxTrailers: 5 })
  cm.setPrefs(w.store, 'owner', '', { count: 0 })
  assert.equal((await ask(w.svc)).items.length, 0)
})

test('service: the intro plays first, only when picked and present, and is never recorded as seen', async (t) => {
  const w = world(t, { files: { 'A.mp4': { tmdbId: 1 } }, extraFiles: ['A-trailer.mp4'] })
  touch(path.join(w.cinemaDir, 'Feature Presentation.mp4'))
  on(w.store, { count: 1, sources: { online: false, owned: false } })
  assert.deepEqual((await ask(w.svc)).items.map((i) => i.role), ['trailer'], 'no intro chosen yet')
  cm.setConfig(w.store, { introFile: 'Feature Presentation.mp4' })
  const r = await ask(w.svc)
  assert.deepEqual(r.items.map((i) => i.role), ['intro', 'trailer'])
  assert.equal(r.items[0].title, 'Feature Presentation')
  assert.equal(w.svc.markSeen({ userId: 'owner', body: { items: [{ key: r.items[0].key }] } }).recorded, 0, 'the intro is not part of the no-repeat history')
  cm.setPrefs(w.store, 'owner', '', { useIntro: false })
  assert.deepEqual((await ask(w.svc)).items.map((i) => i.role), ['trailer'], 'a person can skip the intro')
  cm.setPrefs(w.store, 'owner', '', { useIntro: true })
  cm.setConfig(w.store, { introFile: 'missing.mp4' })
  assert.deepEqual((await ask(w.svc)).items.map((i) => i.role), ['trailer'], 'a missing intro is just skipped')
})

test('service: files outside the library and Cinema folders are never handed out', async (t) => {
  const w = world(t)
  const outside = tmp(t)
  touch(path.join(outside, 'x.mp4'))
  assert.equal(w.svc.register(path.join(outside, 'x.mp4')), null)
  touch(path.join(w.movies, 'ok.mp4'))
  assert.ok(w.svc.register(path.join(w.movies, 'ok.mp4')))
  assert.equal(w.svc.register(path.join(w.movies, 'ok.exe')), null)
  assert.equal(w.svc.register(path.join(w.movies, '..', path.basename(outside), 'x.mp4')), null, 'a .. path out of the library')
})

test('seen: only well-formed keys are stored, capped, and never the intro', (t) => {
  const w = world(t)
  const out = w.svc.markSeen({ userId: 'owner', body: { items: [{ key: 'l:abc123', titleKey: 't:m5' }, { key: '<script>', titleKey: 'x' }, { key: 'y:AbCdEfGhIjK' }, 'nope', { key: 'i:intro1' }] } })
  assert.equal(out.ok, true)
  assert.equal(out.recorded, 3)
  assert.deepEqual([...w.svc.shown.recent('owner', 30)].sort(), ['l:abc123', 't:m5', 'y:AbCdEfGhIjK'])
  assert.equal(w.svc.markSeen({ userId: 'owner', body: {} }).ok, false)
  assert.equal(w.svc.markSeen({ userId: 'owner', body: { items: 'x' } }).ok, false)
  const many = w.svc.markSeen({ userId: 'owner', body: { items: Array.from({ length: 50 }, (_, i) => ({ key: 'l:k' + i })) } })
  assert.ok(many.recorded <= 12)
})

test('coming soon: a restricted profile gets no cards (they carry no age rating)', async (t) => {
  const w = world(t, { getPolicy: (u) => (u === 'kid' ? policyFor({ movieMax: 'PG' }) : parental.normalizePolicy(null)), online: { ...fakeOnline(), comingSoon: async () => ({ upcoming: [{ tmdbId: 1, title: 'Soon' }], nowPlaying: [] }) } })
  const kid = await w.svc.comingSoon('kid')
  assert.equal(kid.restricted, true)
  assert.deepEqual(kid.upcoming, [])
  const owner = await w.svc.comingSoon('owner')
  assert.equal(owner.upcoming.length, 1)
  assert.match(owner.attribution, /TMDB/)
})

test('service: a restricted profile asking for a film above its limit (the cookie route has no other check) gets nothing', async (t) => {
  const w = world(t, {
    getPolicy: () => policyFor({ movieMax: 'PG' }),
    feature: { fileName: 'Strong.mp4', meta: { tmdbId: 5, title: 'Strong', year: 2020, genres: [28], certification: 'R', collectionId: null } },
    files: { 'A.mp4': { tmdbId: 1, certification: 'G' } }, extraFiles: ['A-trailer.mp4']
  })
  on(w.store)
  const r = await ask(w.svc)
  assert.equal(r.enabled, false)
  assert.equal(r.reason, 'not_found')
  assert.deepEqual(r.items, [])
})
