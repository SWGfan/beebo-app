// Jellyfin-compatible API, no server: the id scheme, header parsing, the route table, DeviceProfile
// matching, the HLS master playlist / TranscodingUrl, and the DTO shape of every item type.
// Run: node --test test/jellyfin-compat-unit.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')

const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const jellyfin = localRequire('./electron/jellyfin')
const { createIds, kindOf, normalize, decodeNumeric } = localRequire('./electron/jellyfin/ids')
const util = localRequire('./electron/jellyfin/util')
const { createMapper } = localRequire('./electron/jellyfin/mapper')
const { createPlayback, profileAllowsDirect, vttToSrt } = localRequire('./electron/jellyfin/playback')
const { CaptureResponse, createInternalApi } = localRequire('./electron/jellyfin/internalApi')
const { tmdbSizeFor } = localRequire('./electron/jellyfin/images')
const { TYPE_TAG } = localRequire('./electron/jellyfin/constants')

const memoryStore = (seed = {}) => {
  const data = { ...seed }
  return { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, data }
}

test('ids: numeric kinds round-trip exactly, hashed kinds are stable, typed, distinct and unguessable without the key', () => {
  const ids = createIds(memoryStore())
  for (const kind of ['person', 'genre', 'boxset', 'view', 'studio']) {
    for (const n of [0, 1, 7, 28, 862, 116149, 4294967295, Number.MAX_SAFE_INTEGER]) {
      const id = ids.encode(kind, n)
      assert.match(id, /^[0-9a-f]{32}$/)
      assert.equal(kindOf(id), kind)
      assert.deepEqual(decodeNumeric(id), { kind, number: n })
    }
    for (let i = 0; i < 300; i++) {
      const n = crypto.randomInt(0, 2 ** 47)
      assert.deepEqual(decodeNumeric(ids.encode(kind, n)), { kind, number: n })
    }
  }
  assert.throws(() => ids.encode('person', -1))
  assert.throws(() => ids.encode('movie', 'x') && ids.encode('nonsense', 'x'))
  const store = memoryStore()
  const a = createIds(store)
  const seen = new Set()
  for (let i = 0; i < 10000; i++) {
    const id = a.encode(i % 2 ? 'movie' : 'episode', 'library/Some Show S01E' + i + '.mkv')
    assert.equal(id, a.encode(i % 2 ? 'movie' : 'episode', 'library/Some Show S01E' + i + '.mkv'), 'deterministic')
    assert.equal(kindOf(id), i % 2 ? 'movie' : 'episode')
    assert.equal(parseInt(id.slice(0, 2), 16), TYPE_TAG[i % 2 ? 'movie' : 'episode'])
    assert.ok(!seen.has(id), 'no collision in 10 000 ids')
    seen.add(id)
  }
  assert.notEqual(a.encode('movie', 'x'), a.encode('series', 'x'), 'the type is part of the id')
  assert.equal(createIds(store).encode('movie', 'x'), a.encode('movie', 'x'), 'the key is persisted: ids survive a restart')
  assert.notEqual(createIds(memoryStore()).encode('movie', 'x'), a.encode('movie', 'x'), 'another server derives different ids')
  assert.equal(decodeNumeric(a.encode('movie', 'x')), null, 'hashed ids are not numeric')
  assert.match(a.serverId(), /^[0-9a-f]{32}$/)
})

test('ids: malformed input is rejected, dashes and case are tolerated', () => {
  for (const bad of ['', null, undefined, 'zz', '01', '0100000000000000000000000000000g', '1'.repeat(31), '1'.repeat(33), '../etc/passwd', '01000000-0000-0000-0000-00000000000']) {
    assert.equal(normalize(bad), null, String(bad))
    assert.equal(kindOf(bad), null)
  }
  const id = '0A0000000000000000000000000000FF'
  assert.equal(normalize(id), id.toLowerCase())
  assert.equal(normalize('0a000000-0000-0000-0000-0000000000ff'), id.toLowerCase())
  assert.equal(decodeNumeric('01000000000000000000000000000001'), null, 'a movie tag is not numeric')
  assert.equal(decodeNumeric('05010000000000000000000000000001'), null, 'padding must be zero')
})

test('headers: MediaBrowser and Emby authorization, encoded values, token precedence, case-insensitive query', () => {
  assert.deepEqual(util.parseAuthorizationHeader('MediaBrowser Client="Jellyfin Android", Device="Pixel%207", DeviceId="abc-123", Version="2.5.0", Token="t0k"'), { client: 'Jellyfin Android', device: 'Pixel 7', deviceid: 'abc-123', version: '2.5.0', token: 't0k' })
  assert.equal(util.parseAuthorizationHeader('Emby UserId="x", Client="K", Token="q"').token, 'q')
  assert.equal(util.parseAuthorizationHeader('Bearer abc'), null)
  assert.equal(util.parseAuthorizationHeader(''), null)
  const q = (s) => util.makeQuery(new URL('http://x/?' + s))
  const creds = (headers, qs = '') => util.readCredentials({ headers }, q(qs))
  assert.equal(creds({ authorization: 'MediaBrowser Token="a"', 'x-emby-authorization': 'MediaBrowser Token="b"', 'x-mediabrowser-token': 'c' }, 'api_key=d').token, 'a')
  assert.equal(creds({ 'x-emby-authorization': 'MediaBrowser Token="b"', 'x-mediabrowser-token': 'c' }, 'api_key=d').token, 'b')
  assert.equal(creds({ 'x-mediabrowser-token': 'c' }, 'api_key=d').token, 'c')
  assert.equal(creds({ 'x-emby-token': 'e' }).token, 'e')
  assert.equal(creds({}, 'api_key=d').token, 'd')
  assert.equal(creds({}, 'ApiKey=d2').token, 'd2')
  assert.equal(creds({}).token, '')
  const query = q('IncludeItemTypes=Movie,Series&startindex=5&Limit=x&IsPlayed=true&Fields=Overview|Genres')
  assert.deepEqual(query.list('includeItemTypes'), ['Movie', 'Series'])
  assert.equal(query.int('STARTINDEX'), 5)
  assert.equal(query.int('limit', 9), 9)
  assert.equal(query.bool('isplayed'), true)
  assert.deepEqual(query.list('fields'), ['Overview', 'Genres'])
  assert.deepEqual(util.prune({ a: null, b: undefined, c: [1, null, { d: null, e: 2 }], f: 0, g: false, h: '' }), { c: [1, null, { e: 2 }], f: 0, g: false, h: '' })
  assert.equal(util.toTicks(90.5), 905000000)
  assert.equal(util.fromTicks(905000000), 90.5)
})

function routerFor() {
  const store = memoryStore()
  return jellyfin.create({
    store, dispatch: async () => {}, makeApiToken: () => 't', verifyApiToken: () => null, attemptLogin: async () => ({ ok: false }),
    getUser: () => null, clientIp: () => '127.0.0.1', api: async () => ({ status: 404, body: null }),
  })
}

test('routes: a table of paths -> the route it lands on (case, trailing slash, /emby prefix, parameters)', () => {
  const { internals } = routerFor()
  const m = (method, p) => internals.router.match(method, p)
  const table = [
    ['GET', '/System/Info/Public', '/System/Info/Public'],
    ['GET', '/system/info/public/', '/System/Info/Public'],
    ['GET', '/emby/System/Info/Public', '/System/Info/Public'],
    ['GET', '/MediaBrowser/System/Info/Public', '/System/Info/Public'],
    ['POST', '/USERS/AUTHENTICATEBYNAME', '/Users/AuthenticateByName'],
    ['GET', '/Users/Public', '/Users/Public'],
    ['GET', '/Users/Me', '/Users/Me'],
    ['GET', '/Users/abc', '/Users/{userId}'],
    ['GET', '/Items/Latest', '/Items/Latest'],
    ['GET', '/Items/Resume', '/Items/Resume'],
    ['GET', '/Items/0123', '/Items/{itemId}'],
    ['GET', '/items/0123/images/primary', '/Items/{itemId}/Images/{imageType}'],
    ['GET', '/Items/0123/Images/Backdrop/2', '/Items/{itemId}/Images/{imageType}/{imageIndex}'],
    ['POST', '/Items/0123/PlaybackInfo', '/Items/{itemId}/PlaybackInfo'],
    ['GET', '/Users/u1/Items/Resume', '/Users/{userId}/Items/Resume'],
    ['GET', '/Users/u1/Items/i1', '/Users/{userId}/Items/{itemId}'],
    ['GET', '/Videos/i1/master.m3u8', '/Videos/{itemId}/master.m3u8'],
    ['GET', '/Videos/i1/stream.mp4', '/Videos/{itemId}/stream.{container}'],
    ['GET', '/Videos/i1/ms1/Subtitles/3/Stream.srt', '/Videos/{itemId}/{mediaSourceId}/Subtitles/{index}/Stream.{format}'],
    ['GET', '/Videos/i1/ms1/Subtitles/3/0/Stream.vtt', '/Videos/{itemId}/{mediaSourceId}/Subtitles/{index}/{startPositionTicks}/Stream.{format}'],
    ['GET', '/Audio/i1/universal', '/Audio/{itemId}/universal'],
    ['POST', '/Sessions/Playing/Progress', '/Sessions/Playing/Progress'],
    ['DELETE', '/UserPlayedItems/i1', '/UserPlayedItems/{itemId}'],
    ['POST', '/Users/u1/FavoriteItems/i1', '/Users/{userId}/FavoriteItems/{itemId}'],
    ['GET', '/Shows/i1/Episodes', '/Shows/{itemId}/Episodes'],
  ]
  for (const [method, p, pattern] of table) {
    const hit = m(method, p)
    assert.ok(hit, method + ' ' + p)
    assert.equal(hit.route.pattern, pattern, method + ' ' + p)
  }
  assert.equal(m('GET', '/Items/0123/Images/Primary').params.itemid, '0123')
  assert.equal(m('GET', '/Videos/i1/ms1/Subtitles/3/Stream.srt').params.format, 'srt')
  assert.equal(m('GET', '/Users/Me').route.pattern, '/Users/Me', 'literal routes win over parameters')
  for (const [method, p] of [['GET', '/nonsense'], ['GET', '/api/movies'], ['GET', '/'], ['GET', '/Items/a/b/c/d'], ['PATCH', '/Items'], ['GET', '/hls/x/index.m3u8'], ['GET', '/file'], ['GET', '/tvfile'], ['GET', '/media/poster/1.jpg']]) {
    assert.equal(m(method, p), null, method + ' ' + p)
  }
})

test('routes: no path of Beebo\'s own server is claimed by the compat table', () => {
  const { claims } = routerFor()
  const src = fs.readFileSync(path.join(appRoot, 'electron', 'streamServer.js'), 'utf8')
  const literals = new Set()
  for (const re of [/pathname === '(\/[^']*)'/g, /pathname\.startsWith\('(\/[^']*)'\)/g, /\bp === '(\/[^']*)'/g]) {
    let m
    while ((m = re.exec(src))) literals.add(m[1])
  }
  assert.ok(literals.size > 100, 'found the server\'s literal routes (' + literals.size + ')')
  const collisions = [...literals].filter((l) => claims(l) || claims(l.toUpperCase()) || claims(l + '/x'))
  assert.deepEqual(collisions, [])
  for (const known of ['/health', '/login', '/watch', '/tvwatch', '/file', '/tvfile', '/hls/abc/index.m3u8', '/api/ping', '/media/poster/862.jpg', '/subtitles/embedded', '/search', '/music', '/photos', '/upload', '/tvshows']) {
    assert.equal(claims(known), false, known)
  }
})

test('DeviceProfile: direct play only when container, codecs and conditions all fit', () => {
  const profile = { DirectPlayProfiles: [{ Type: 'Video', Container: 'mp4,m4v', VideoCodec: 'h264,hevc', AudioCodec: 'aac,mp3,ac3' }, { Type: 'Video', Container: 'mkv', VideoCodec: 'h264', AudioCodec: 'aac' }, { Type: 'Audio', Container: 'flac' }] }
  const ok = (extra) => profileAllowsDirect(profile, { container: 'mp4', vcodec: 'h264', acodec: 'aac', width: 1920, height: 1080, bitrate: 6e6, channels: 2, ...extra })
  assert.equal(ok({}), true)
  assert.equal(ok({ vcodec: 'hevc' }), true)
  assert.equal(ok({ vcodec: 'av1' }), false)
  assert.equal(ok({ acodec: 'dts' }), false)
  assert.equal(ok({ container: 'avi' }), false)
  assert.equal(ok({ container: 'mkv' }), true, 'mkv listed with h264/aac')
  assert.equal(ok({ container: 'mkv', vcodec: 'hevc' }), false, 'mkv only with h264')
  assert.equal(ok({ container: 'flac' }), false, 'an Audio profile is not a Video profile')
  const limited = { ...profile, CodecProfiles: [{ Type: 'Video', Codec: 'h264', Conditions: [{ Condition: 'LessThanEqual', Property: 'Width', Value: '1280', IsRequired: true }, { Condition: 'LessThanEqual', Property: 'VideoBitrate', Value: '4000000' }] }, { Type: 'VideoAudio', Conditions: [{ Condition: 'LessThanEqual', Property: 'AudioChannels', Value: '2' }] }] }
  assert.equal(profileAllowsDirect(limited, { container: 'mp4', vcodec: 'h264', acodec: 'aac', width: 1280, bitrate: 3e6, channels: 2 }), true)
  assert.equal(profileAllowsDirect(limited, { container: 'mp4', vcodec: 'h264', acodec: 'aac', width: 1920, bitrate: 3e6, channels: 2 }), false, 'too wide')
  assert.equal(profileAllowsDirect(limited, { container: 'mp4', vcodec: 'h264', acodec: 'aac', width: 1280, bitrate: 8e6, channels: 2 }), false, 'too much video bitrate')
  assert.equal(profileAllowsDirect(limited, { container: 'mp4', vcodec: 'h264', acodec: 'aac', width: 1280, bitrate: 3e6, channels: 6 }), false, '5.1 audio')
  assert.equal(profileAllowsDirect({ DirectPlayProfiles: [] }, { container: 'mp4', vcodec: 'h264', acodec: 'aac' }), false)
  assert.equal(profileAllowsDirect(null, { container: 'mp4' }), false)
})

function playbackHarness({ info, startAnswer, status } = {}) {
  const calls = []
  const store = memoryStore()
  const host = {
    store,
    api: async (userId, method, url, body) => {
      calls.push({ userId, method, url, body })
      if (url.startsWith('/api/playback/info')) return { status: 200, body: info || null }
      if (url === '/api/playback/start') return startAnswer || { status: 200, body: { ok: true, url: '/hls/TICKET.abc/index.m3u8', quality: body.quality, height: 720, videoKbps: 4000 } }
      if (url === '/api/parental/status') return { status: 200, body: { ok: true, canWatchNow: status !== 'blocked' } }
      return { status: 404, body: null }
    },
  }
  const ids = createIds(store)
  const auth = { serverId: () => ids.serverId(), idFor: (u) => ids.encode('user', u.id) }
  const mapper = createMapper({ ids, auth, catalog: null })
  const playback = createPlayback({ host, ids, auth, catalog: null, mapper, services: {} })
  return { calls, playback, ids, host }
}

const VIDEO_INFO = {
  ok: true, durationSec: 7200, bitrateKbps: 6000, video: { codec: 'h264', width: 1920, height: 1080, fps: 24, hdr: false },
  audio: [{ ordinal: 0, streamIndex: 1, label: 'English 5.1', language: 'en', codec: 'ac3', channels: 6, isDefault: true }, { ordinal: 1, streamIndex: 2, label: 'French', language: 'fr', codec: 'aac', channels: 2 }],
  subtitles: [{ key: 'emb:3', source: 'embedded', kind: 'text', label: 'English', language: 'en', streamIndex: 3, url: '/subtitles/embedded?kind=movie&id=X&s=3&mt=OLD' }, { key: 'emb:4', source: 'embedded', kind: 'image', label: 'PGS', language: 'en', streamIndex: 4, url: '' }],
  qualities: [{ id: '1080p', videoKbps: 8000, audioKbps: 192, upscale: false }, { id: '720p', videoKbps: 4000, audioKbps: 160, upscale: false }, { id: '480p', videoKbps: 1500, audioKbps: 128, upscale: false }],
  direct: { android: true }, transcode: { available: true }, awayQualityCapHeight: null,
}

test('HLS: PlaybackInfo hands out a TranscodingUrl on the compat route, honouring bitrate, audio and subtitle choices', async () => {
  const h = playbackHarness({ info: VIDEO_INFO })
  const entry = { type: 'Movie', jid: h.ids.encode('movie', 'M1'), beeboId: Buffer.from('Film (2001).mkv').toString('base64url'), title: 'Film', stream: '/file?id=X&mt=1.abc' }
  const user = { id: 'u1' }
  const q = util.makeQuery(new URL('http://x/'))
  const profile = { MaxStreamingBitrate: 3000000, DirectPlayProfiles: [{ Type: 'Video', Container: 'mp4', VideoCodec: 'h264', AudioCodec: 'aac' }] }
  const out = await h.playback.playbackInfo(user, entry, { req: {}, body: { DeviceProfile: profile, AudioStreamIndex: 2, SubtitleStreamIndex: 4 }, q, token: 'jf.TOK', device: { id: 'dev-9' } })
  const src = out.MediaSources[0]
  assert.equal(src.SupportsDirectPlay, false, 'mkv is not in this profile')
  assert.equal(src.SupportsTranscoding, true)
  assert.equal(src.TranscodingSubProtocol, 'hls')
  assert.equal(src.TranscodingContainer, 'ts')
  const url = new URL('http://x' + src.TranscodingUrl)
  assert.equal(url.pathname, '/Videos/' + entry.jid + '/master.m3u8')
  assert.equal(url.searchParams.get('AudioStreamIndex'), '2')
  assert.equal(url.searchParams.get('SubtitleStreamIndex'), '4')
  assert.equal(url.searchParams.get('SubtitleMethod'), 'Encode', 'a picture subtitle is burnt in')
  assert.equal(url.searchParams.get('Quality'), '480p', '3 Mbps fits only the 480p step')
  assert.equal(url.searchParams.get('api_key'), 'jf.TOK')
  assert.equal(url.searchParams.get('MediaSourceId'), entry.jid)
  assert.equal(url.searchParams.get('PlaySessionId'), out.PlaySessionId)
  assert.ok(!('DirectStreamUrl' in src))
  const streams = src.MediaStreams
  assert.deepEqual(streams.map((s) => s.Type), ['Video', 'Audio', 'Audio', 'Subtitle', 'Subtitle'])
  assert.equal(streams.find((s) => s.Index === 3).DeliveryMethod, 'External')
  assert.equal(streams.find((s) => s.Index === 3).DeliveryUrl, '/Videos/' + entry.jid + '/' + entry.jid + '/Subtitles/3/0/Stream.vtt')
  assert.equal(streams.find((s) => s.Index === 4).DeliveryMethod, 'Encode')
  assert.equal(streams.find((s) => s.Index === 1).Language, 'eng')
  assert.equal(src.RunTimeTicks, 72000000000)
  assert.ok(!JSON.stringify(out).includes('Film (2001)'), 'no file name')

  const direct = await h.playback.playbackInfo(user, { ...entry, beeboId: Buffer.from('Film (2001).mp4').toString('base64url') }, { req: {}, body: { DeviceProfile: { DirectPlayProfiles: [{ Type: 'Video', Container: 'mp4', VideoCodec: 'h264', AudioCodec: 'ac3,aac' }] } }, q, token: 'jf.TOK', device: { id: 'd' } })
  assert.equal(direct.MediaSources[0].SupportsDirectPlay, true)
  assert.match(direct.MediaSources[0].DirectStreamUrl, /^\/Videos\/[0-9a-f]{32}\/stream\?Static=true&MediaSourceId=/)
  assert.ok(!('TranscodingUrl' in direct.MediaSources[0]))

  const noTranscode = await h.playback.playbackInfo(user, entry, { req: {}, body: { DeviceProfile: profile, EnableTranscoding: false }, q, token: 't', device: {} })
  assert.equal(noTranscode.ErrorCode, 'NoCompatibleStream')

  const blocked = playbackHarness({ info: VIDEO_INFO, status: 'blocked' })
  const denied = await blocked.playback.playbackInfo(user, entry, { req: {}, body: {}, q, token: 't', device: {} })
  assert.equal(denied.ErrorCode, 'NotAllowed', 'bedtime and the daily limit reach the TV as NotAllowed')
  assert.deepEqual(denied.MediaSources, [])
})

test('HLS: master.m3u8 starts a Beebo ticket and points at the signed /hls playlist', async () => {
  const h = playbackHarness({ info: VIDEO_INFO })
  const entry = { type: 'Movie', jid: h.ids.encode('movie', 'M1'), beeboId: 'abc', title: 'Film' }
  const res = new CaptureResponse()
  res.req = { method: 'GET' }
  const q = util.makeQuery(new URL('http://x/?Quality=720p&AudioStreamIndex=2&SubtitleStreamIndex=4&SubtitleMethod=Encode'))
  await h.playback.hlsMaster({ id: 'u1' }, entry, { req: {}, res, q })
  assert.equal(res.statusCode, 200)
  assert.equal(res.getHeader('content-type'), 'application/vnd.apple.mpegurl')
  const lines = res.body().toString('utf8').split('\n')
  assert.equal(lines[0], '#EXTM3U')
  const inf = lines.find((l) => l.startsWith('#EXT-X-STREAM-INF'))
  assert.match(inf, /BANDWIDTH=4160000/)
  assert.match(inf, /RESOLUTION=1280x720/)
  assert.equal(lines[lines.indexOf(inf) + 1], '/hls/TICKET.abc/index.m3u8')
  const start = h.calls.find((c) => c.url === '/api/playback/start')
  assert.deepEqual(start.body, { kind: 'movie', id: 'abc', quality: '720p', audio: 2, burnSubtitle: 4 })
  assert.equal(start.userId, 'u1')

  const busy = playbackHarness({ info: VIDEO_INFO, startAnswer: { status: 503, body: { ok: false, error: 'busy', message: 'Busy right now.' } } })
  const res2 = new CaptureResponse()
  res2.req = { method: 'GET' }
  await busy.playback.hlsMaster({ id: 'u1' }, entry, { req: {}, res: res2, q: util.makeQuery(new URL('http://x/')) })
  assert.equal(res2.statusCode, 503)
  assert.equal(res2.getHeader('retry-after'), '10')
})

test('subtitles: WebVTT becomes SubRip with numbered cues and comma timestamps', () => {
  const vtt = 'WEBVTT\n\nNOTE a note\n\n00:00.500 --> 00:02.000\nHello\n\n1:02:03.004 --> 01:02:05.000 align:start\nBye\n'
  const out = vttToSrt(vtt)
  assert.match(out, /^1\n00:00:00,500 --> 00:00:02,000\nHello/m)
  assert.match(out, /^2\n01:02:03,004 --> 01:02:05,000$/m)
  assert.ok(!/WEBVTT|NOTE|align/.test(out))
})

test('images: TMDB backdrop sizes follow maxWidth', () => {
  assert.equal(tmdbSizeFor(0), 'w1280')
  assert.equal(tmdbSizeFor(200), 'w300')
  assert.equal(tmdbSizeFor(480), 'w500')
  assert.equal(tmdbSizeFor(780), 'w780')
  assert.equal(tmdbSizeFor(1920), 'original')
})

test('DTO shape: every item type carries the fields Jellyfin clients require, and never a path', () => {
  const store = memoryStore()
  const ids = createIds(store)
  const auth = { serverId: () => ids.serverId(), idFor: (u) => ids.encode('user', u.id) }
  const mapper = createMapper({ ids, auth, catalog: null })
  const state = { watched: (k, id) => id === 'w', resume: (k, id) => (id === 'r' ? { currentTime: 60, duration: 600, percent: 10 } : null), favorite: () => true, lastPlayedAt: () => 1700000000000 }
  const ctx = { state, viewJid: (n) => ids.encode('view', { movies: 1, tvshows: 2, music: 3, boxsets: 4 }[n]), rootJid: ids.encode('view', 0), seasonCount: 2, unplayed: 3 }
  const series = { type: 'Series', jid: ids.encode('series', 'k'), showKey: 'k', beeboId: 'k', title: 'Show', year: 2010, genres: ['Drama'], genreIds: [18], poster: '/media/poster-tv/1.jpg', backdrop: 'https://image.tmdb.org/t/p/w780/b.jpg', episodeCount: 5, rating: 8.44, tmdbId: 1 }
  const season = { type: 'Season', jid: ids.encode('season', 'k:1'), showKey: 'k', seriesJid: series.jid, seriesTitle: 'Show', number: 1, title: 'Season 1', poster: series.poster, backdrop: null, genres: [], genreIds: [], episodeCount: 5 }
  const episode = { type: 'Episode', jid: ids.encode('episode', 'e'), beeboId: 'r', showKey: 'k', seriesJid: series.jid, seriesTitle: 'Show', seasonJid: season.jid, seasonNumber: 1, number: 3, title: 'Pilot', poster: series.poster, backdrop: null, genres: [], genreIds: [] }
  const movie = { type: 'Movie', jid: ids.encode('movie', 'm'), beeboId: 'w', title: 'Film', year: 1999, genres: ['Action'], genreIds: [28], poster: null, backdrop: null, overview: 'Words', rating: 7.25 }
  const boxset = { type: 'BoxSet', jid: ids.encode('boxset', 5), title: 'Saga', memberJids: [movie.jid], genres: [], genreIds: [], poster: null, backdrop: null }
  const artist = { type: 'MusicArtist', jid: ids.encode('artist', 'a'), beeboId: 'a', title: 'Band', albumCount: 2, cover: '/api/music/cover/c1', genres: [], genreIds: [] }
  const album = { type: 'MusicAlbum', jid: ids.encode('album', 'b'), beeboId: 'b', title: 'Record', artist: 'Band', artistJid: artist.jid, year: 2001, trackCount: 9, duration: 2400, cover: '/api/music/cover/c1', genres: [], genreIds: [] }
  const track = { type: 'Audio', jid: ids.encode('audio', 't'), beeboId: 't', title: 'Song', artist: 'Band', artistJid: artist.jid, album: 'Record', albumJid: album.jid, albumArtist: 'Band', number: 4, disc: 1, duration: 200, codec: 'flac', genres: [], genreIds: [] }
  const common = ['Id', 'Name', 'Type', 'ServerId', 'IsFolder', 'Etag', 'ImageTags', 'BackdropImageTags', 'UserData', 'Genres', 'People']
  for (const [entry, extra] of [[series, ['ChildCount', 'RecursiveItemCount', 'ProductionYear', 'CommunityRating']], [season, ['SeriesId', 'SeriesName', 'IndexNumber', 'ParentId']], [episode, ['SeriesId', 'SeasonId', 'SeriesName', 'SeasonName', 'IndexNumber', 'ParentIndexNumber', 'MediaType']], [movie, ['ProductionYear', 'Overview', 'CommunityRating', 'MediaType', 'ParentId']], [boxset, ['ChildCount']], [artist, ['ChildCount']], [album, ['AlbumArtist', 'Artists', 'ArtistItems', 'RunTimeTicks']], [track, ['Album', 'AlbumId', 'Artists', 'IndexNumber', 'RunTimeTicks', 'MediaType']]]) {
    const dto = mapper.toDto(entry, ctx)
    for (const k of [...common, ...extra]) assert.ok(dto[k] !== undefined, entry.type + ' has ' + k)
    assert.equal(dto.Type, entry.type)
    assert.equal(dto.Id, entry.jid)
    assert.equal(dto.ServerId, ids.serverId())
    assert.match(dto.Id, /^[0-9a-f]{32}$/)
    assert.deepEqual(Object.keys(dto.UserData).filter((k) => ['PlaybackPositionTicks', 'PlayCount', 'Played', 'IsFavorite'].includes(k)).sort(), ['IsFavorite', 'PlayCount', 'PlaybackPositionTicks', 'Played'], entry.type + ' UserData')
    assert.ok(!('Path' in dto), entry.type + ' has no Path')
    assert.ok(!JSON.stringify(dto).includes('/Users/'), 'no local path')
  }
  assert.equal(mapper.toDto(movie, ctx).UserData.Played, true)
  assert.equal(mapper.toDto(movie, ctx).UserData.PlayCount, 1)
  assert.equal(mapper.toDto(episode, ctx).UserData.PlaybackPositionTicks, 600000000)
  assert.equal(mapper.toDto(episode, ctx).UserData.PlayedPercentage, 10)
  assert.equal(mapper.toDto(series, ctx).UserData.UnplayedItemCount, 3)
  assert.equal(mapper.toDto(movie, ctx).CommunityRating, 7.3)
  assert.equal(mapper.toDto(series, ctx).ImageTags.Primary.length, 32)
  assert.equal(mapper.toDto(series, ctx).BackdropImageTags.length, 1)
  assert.deepEqual(mapper.toDto(movie, ctx).ImageTags, {})
  assert.equal(mapper.toDto(track, ctx).MediaType, 'Audio')
  assert.equal(mapper.toDto(track, ctx).RunTimeTicks, 2000000000)
  assert.equal(mapper.toDto({ type: 'Nothing' }, ctx), null)
  assert.deepEqual(mapper.imageSources(series.jid), { primary: '/media/poster-tv/1.jpg', backdrop: 'https://image.tmdb.org/t/p/w780/b.jpg' })
  const view = mapper.viewDto('movies', 12, ctx)
  assert.equal(view.CollectionType, 'movies')
  assert.equal(view.Type, 'CollectionFolder')
  assert.equal(view.IsFolder, true)
  assert.equal(view.Id, ctx.viewJid('movies'))
})

test('in-process api: a captured response carries status, headers and body; nothing reaches a socket', async () => {
  const store = memoryStore()
  const seen = []
  const api = createInternalApi({
    store, makeApiToken: (s, id) => 'tok-' + id,
    dispatch: async (req, res) => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, cookie: req.headers.cookie, body: await new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c).toString())) }) })
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, echo: 1 }))
    },
  })
  const real = { socket: { remoteAddress: '10.0.0.5' }, headers: { authorization: 'MediaBrowser Token="jf.x"', cookie: 'beebo_session=abc', 'x-forwarded-for': '1.2.3.4', range: 'bytes=0-1' } }
  const out = await api('u9', 'POST', '/api/thing?x=1', { a: 1 }, real)
  assert.equal(out.status, 201)
  assert.deepEqual(out.body, { ok: true, echo: 1 })
  assert.deepEqual(seen[0], { method: 'POST', url: '/api/thing?x=1', auth: 'Bearer tok-u9', cookie: undefined, body: '{"a":1}' })
  const none = await createInternalApi({ store, makeApiToken: () => null, dispatch: async () => {} })('u', 'GET', '/api/x')
  assert.equal(none.status, 401)
})

test('settings: jellyfinCompat is a whitelisted boolean the desktop can write, and nothing else widened', () => {
  const policy = localRequire('./electron/desktopSettingsPolicy')
  const store = memoryStore()
  assert.equal(policy.writeSettings(store, { jellyfinCompat: true }), true)
  assert.equal(store.data.jellyfinCompat, true)
  assert.throws(() => policy.writeSettings(store, { jellyfinCompat: true, apiTokenSecret: 'x' }), /dedicated/)
  assert.throws(() => policy.writeSettings(store, { jellyfinIdKey: 'x' }), /dedicated/)
  assert.throws(() => policy.writeSettings(store, { jellyfinCompat: 'yes' }), /dedicated/)
  assert.equal(store.data.apiTokenSecret, undefined)
})
