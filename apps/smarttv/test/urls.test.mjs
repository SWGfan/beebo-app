import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeServerAddress, buildQuery, buildUrl, assetUrl, routes, routeUrl, redactUrl, isPrivateHost, originOf
} from '../app/js/util/urls.js'

test('LAN address: bare IP gets http and the default port', () => {
  const r = normalizeServerAddress('192.168.1.20')
  assert.equal(r.ok, true)
  assert.equal(r.origin, 'http://192.168.1.20:47811')
  assert.equal(r.kind, 'lan')
})

test('LAN address with port and scheme', () => {
  assert.equal(normalizeServerAddress('192.168.1.20:8080').origin, 'http://192.168.1.20:8080')
  assert.equal(normalizeServerAddress('http://10.0.0.5:47811/').origin, 'http://10.0.0.5:47811')
  assert.equal(normalizeServerAddress('  192.168.1.20  ').origin, 'http://192.168.1.20:47811')
})

test('bare Beebo name and name.beebo.tv map to the direct home address over https', () => {
  assert.equal(normalizeServerAddress('nick').origin, 'https://nick.home.beebo.tv:47811')
  assert.equal(normalizeServerAddress('Nick').origin, 'https://nick.home.beebo.tv:47811')
  assert.equal(normalizeServerAddress('nick.beebo.tv').origin, 'https://nick.home.beebo.tv:47811')
  assert.equal(normalizeServerAddress('nick.home.beebo.tv').origin, 'https://nick.home.beebo.tv:47811')
  assert.equal(normalizeServerAddress('nick.beebo.tv').kind, 'beebo-name')
})

test('other hostnames default to https, explicit scheme wins', () => {
  assert.equal(normalizeServerAddress('media.example.com:47811').origin, 'https://media.example.com:47811')
  // plain http is only for private LAN addresses; anything else typed as http:// is upgraded to https
  assert.equal(normalizeServerAddress('http://media.example.com:47811').origin, 'https://media.example.com:47811')
  assert.equal(normalizeServerAddress('http://8.8.8.8:47811').origin, 'https://8.8.8.8:47811')
  assert.equal(normalizeServerAddress('http://nick.home.beebo.tv').origin, 'https://nick.home.beebo.tv:47811')
  assert.equal(normalizeServerAddress('https://192.168.1.4:47811').origin, 'https://192.168.1.4:47811')
  assert.equal(normalizeServerAddress('https://media.example.com:443').origin, 'https://media.example.com')
})

test('public IPs are https by default', () => {
  const r = normalizeServerAddress('8.8.8.8')
  assert.equal(r.origin, 'https://8.8.8.8:47811')
  assert.equal(r.kind, 'ip')
})

test('bad addresses are rejected with a reason', () => {
  const cases = [
    ['', 'empty'], ['   ', 'empty'],
    ['ftp://x.example', 'scheme'],
    ['http://user:pw@192.168.1.2', 'credentials'],
    ['192.168.1.2:99999', 'port'], ['192.168.1.2:0', 'port'],
    ['192.168.1.300', 'invalid'],
    ['999.1.1', 'invalid'],
    ['bad host', 'invalid'],
    ['http://x.example/path/deeper', 'path'],
    ['192.168.1.2?token=abc', 'invalid'],
    ['a'.repeat(300), 'too_long'],
    ['-bad-.example.com', 'invalid'],
    ['[::1]:80', 'invalid']
  ]
  for (const [input, error] of cases) {
    const r = normalizeServerAddress(input)
    assert.equal(r.ok, false, input)
    assert.equal(r.error, error, input)
  }
})

test('normalizeServerAddress never returns a URL with a path, query or credentials', () => {
  for (const input of ['192.168.1.20', 'nick', 'https://a.example:1234/']) {
    const r = normalizeServerAddress(input)
    assert.match(r.origin, /^https?:\/\/[a-z0-9.-]+(:\d+)?$/)
  }
})

test('isPrivateHost', () => {
  for (const h of ['192.168.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '169.254.1.1', '100.64.0.1', 'localhost', '127.0.0.1']) assert.equal(isPrivateHost(h), true, h)
  for (const h of ['172.32.0.1', '8.8.8.8', '100.128.0.1', 'example.com', '192.169.0.1']) assert.equal(isPrivateHost(h), false, h)
})

test('buildQuery encodes, sorts and skips empties', () => {
  assert.equal(buildQuery({ q: 'a b&c', genre: '', sort: null, limit: 0 }), '?limit=0&q=a%20b%26c')
  assert.equal(buildQuery({}), '')
  assert.equal(buildQuery(null), '')
})

test('buildUrl / assetUrl refuse unsafe paths', () => {
  assert.equal(buildUrl('http://h:1/', '/api/movies', { q: 'x' }), 'http://h:1/api/movies?q=x')
  assert.throws(() => buildUrl('http://h', 'api/movies'))
  assert.throws(() => buildUrl('http://h', '//evil/x'))
  assert.equal(assetUrl('http://h:1', '/media/poster/1.jpg'), 'http://h:1/media/poster/1.jpg')
  assert.equal(assetUrl('http://h:1', '//evil.example/x.jpg'), '')
  assert.equal(assetUrl('http://h:1', 'https://evil.example/x.jpg'), '')
  assert.equal(assetUrl('http://h:1', null), '')
})

test('route table produces the existing Beebo API paths', () => {
  const o = 'http://h:47811'
  assert.equal(routeUrl(o, routes.ping()), o + '/api/ping')
  assert.equal(routeUrl(o, routes.login()), o + '/api/login')
  assert.equal(routeUrl(o, routes.movies({ q: 'star wars' })), o + '/api/movies?q=star%20wars')
  assert.equal(routeUrl(o, routes.movies({ limit: 60, offset: 120 })), o + '/api/movies?limit=60&offset=120')
  assert.equal(routeUrl(o, routes.tvShows()), o + '/api/tvshows')
  assert.equal(routeUrl(o, routes.libraryMovies({ limit: 100, offset: 200 })), o + '/api/v1/library/movies?limit=100&offset=200')
  assert.equal(routeUrl(o, routes.libraryTvShows({ q: 'the wire', limit: 50, offset: 0 })), o + '/api/v1/library/tvshows?limit=50&offset=0&q=the%20wire')
  assert.equal(routeUrl(o, routes.episodes('Game of Thrones (2011)')), o + '/api/tvshows/Game%20of%20Thrones%20(2011)/episodes')
  assert.equal(routeUrl(o, routes.episodes('a/b')), o + '/api/tvshows/a%2Fb/episodes')
  assert.equal(routeUrl(o, routes.continueWatching()), o + '/api/continue')
  assert.equal(routeUrl(o, routes.recentlyAdded()), o + '/api/recently-added')
  assert.equal(routeUrl(o, routes.upNext('tv', 'abc')), o + '/api/upnext?id=abc&kind=tv')
  assert.equal(routeUrl(o, routes.upNext('whatever', 'abc')), o + '/api/upnext?id=abc&kind=movie')
  assert.equal(routeUrl(o, routes.playbackInfo('movie', 'x y')), o + '/api/playback/info?id=x%20y&kind=movie')
  assert.equal(routeUrl(o, routes.playbackStart()), o + '/api/playback/start')
  assert.equal(routeUrl(o, routes.playbackStop()), o + '/api/playback/stop')
  assert.equal(routeUrl(o, routes.watchSession()), o + '/api/watch-session')
  assert.equal(routeUrl(o, routes.progress()), o + '/api/progress')
})

test('redactUrl strips media tokens, ticket path and codes', () => {
  assert.equal(redactUrl('http://h/file?id=abc&mt=1700.aGVsbG8'), 'http://h/file?id=abc&mt=[redacted]')
  assert.equal(redactUrl('/subtitles/file?kind=tv&id=1&i=0&mt=SECRET'), '/subtitles/file?kind=tv&id=1&i=0&mt=[redacted]')
  assert.equal(redactUrl('http://h/hls/TICKETVALUE/index.m3u8'), 'http://h/hls/[redacted]/index.m3u8')
  assert.equal(redactUrl('https://x/cb?token=abc&user_code=ABCD-1234'), 'https://x/cb?token=[redacted]&user_code=[redacted]')
  assert.equal(redactUrl(null), '')
  assert.ok(!redactUrl('/file?mt=TOPSECRET').includes('TOPSECRET'))
})

test('originOf', () => {
  assert.equal(originOf('http://Host:47811/path?x'), 'http://host:47811')
  assert.equal(originOf('/relative'), '')
})
