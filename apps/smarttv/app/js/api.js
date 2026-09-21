// HTTP client for the Beebo home server. DOM-free (XMLHttpRequest is injected so tests can fake it).
//
// - XMLHttpRequest, not fetch + AbortController: AbortController needs Chromium 66, and XHR gives
//   us a real timeout on every TV generation.
// - Bearer token goes in the Authorization header ONLY. It is never put in a URL, and no code path
//   here logs headers or bodies; errors carry a redacted URL.
// - Every failure is turned into an error object with a `kind` and a `friendly` message that is
//   safe to show on screen: 'offline' | 'timeout' | 'unauthorized' | 'server' | 'not_found' |
//   'bad_response' | 'blocked'.

import { routes, routeUrl, buildUrl, redactUrl } from './util/urls.js'
import { safeText } from './util/escape.js'
import { movieNightRoutes, normalizeStatus, tvUrlFromReply } from './util/movienight.js'
import {
  normalizeMovie, normalizeShow, normalizeList, normalizeContinue, normalizeRecent, normalizeEpisodes,
  normalizePlaybackInfo, normalizePlaybackStart, normalizeNeighbour, normalizeUser
} from './util/models.js'

export var TIMEOUT_MS = { quick: 8000, normal: 15000, list: 45000, start: 40000 }

export function makeError(kind, status, url, serverMessage) {
  var friendly
  switch (kind) {
    case 'offline': friendly = 'Can’t reach your Beebo server. Check that the computer is on and this TV is on the same network.'; break
    case 'timeout': friendly = 'Your Beebo server took too long to answer.'; break
    case 'unauthorized': friendly = 'This TV is no longer signed in.'; break
    case 'not_found': friendly = 'Beebo couldn’t find that.'; break
    case 'blocked': friendly = 'The TV blocked the connection to your server. See the setup notes (cross-origin access).'; break
    case 'bad_response': friendly = 'Your server sent something this app didn’t understand.'; break
    default: friendly = 'Your Beebo server had a problem (' + status + ').'
  }
  var e = new Error(kind + ' ' + redactUrl(url || ''))
  e.kind = kind
  e.status = status || 0
  e.friendly = friendly
  e.serverMessage = safeText(serverMessage, 200)
  return e
}

/**
 * @param {{XHR:Function, getOrigin:function():string, getToken:function():string, onUnauthorized?:function():void}} deps
 */
export function createClient(deps) {
  var XHR = deps.XHR

  function request(method, url, opts) {
    opts = opts || {}
    return new Promise(function (resolve, reject) {
      var xhr = new XHR()
      var done = false
      function finish(fn, value) { if (!done) { done = true; fn(value) } }
      try {
        xhr.open(method, url, true)
      } catch (e) {
        finish(reject, makeError('offline', 0, url))
        return
      }
      xhr.timeout = opts.timeout || TIMEOUT_MS.normal
      xhr.setRequestHeader('Accept', 'application/json')
      if (opts.auth !== false) {
        var tok = deps.getToken()
        if (tok) xhr.setRequestHeader('Authorization', 'Bearer ' + tok)
      } else if (opts.bearer) {
        // An explicit one-off credential (the pairing viewer token). Callers must only use it over
        // https or a private LAN address - see pairing.js isSafeExchangeOrigin().
        xhr.setRequestHeader('Authorization', 'Bearer ' + opts.bearer)
      }
      var body = null
      if (opts.json !== undefined) {
        xhr.setRequestHeader('Content-Type', 'application/json')
        body = JSON.stringify(opts.json)
      }
      xhr.onload = function () {
        var status = xhr.status
        var parsed = null
        var text = ''
        try { text = xhr.responseText || '' } catch (e) { text = '' }
        if (text) { try { parsed = JSON.parse(text) } catch (e) { parsed = null } }
        if (status >= 200 && status < 300) {
          if (opts.expectJson !== false && parsed === null) return finish(reject, makeError('bad_response', status, url))
          return finish(resolve, { status: status, body: parsed, text: text })
        }
        var msg = parsed && typeof parsed === 'object' ? parsed.message || parsed.error : ''
        // Non-2xx with a JSON body is often a meaningful answer (409 transcode_off, 429 slow_down,
        // a locked login...): keep the parsed body on the error.
        var kind = status === 401 ? 'unauthorized' : status === 404 ? 'not_found' : 'server'
        if (status === 401 && opts.auth !== false && deps.onUnauthorized) { try { deps.onUnauthorized() } catch (e) { /* ignore */ } }
        var err = makeError(kind, status, url, msg)
        err.body = parsed
        return finish(reject, err)
      }
      xhr.onerror = function () { finish(reject, makeError(xhr.status === 0 ? 'offline' : 'server', xhr.status, url)) }
      xhr.ontimeout = function () { finish(reject, makeError('timeout', 0, url)) }
      xhr.onabort = function () { finish(reject, makeError('offline', 0, url)) }
      try { xhr.send(body) } catch (e) { finish(reject, makeError('blocked', 0, url)) }
    })
  }

  function origin() { return deps.getOrigin() }
  function get(route, opts) { return request('GET', routeUrl(origin(), route), opts) }
  function post(route, json, opts) {
    opts = opts || {}
    opts.json = json === undefined ? {} : json
    return request('POST', routeUrl(origin(), route), opts)
  }

  // --- list fetching --------------------------------------------------------------------------
  // Preferred: the paged public API (/api/v1/library/*, limit<=500, answers { total, items }).
  // If that route is missing or refused (404 / 403 / 405: older server, or a share guest), fall back
  // - for the rest of this session - to the legacy unpaged routes, whose answer is the whole list;
  // that is flagged { all: true } so the pager takes it once and never asks again. Paging is only
  // recognised when the server announces "total" (a server that ignored offset would otherwise
  // repeat the same rows forever).
  var pagedApi = true
  var MAX_LIMIT = 500

  function shapePage(r, normalize) {
    var b = r.body || {}
    var items = normalizeList(Array.isArray(b.items) ? b.items : [], normalize)
    var total = typeof b.total === 'number' && b.total >= 0 ? b.total : null
    return total === null ? { items: items, all: true } : { items: items, total: total }
  }
  function listPage(v1Route, legacyRoute, normalize, extra) {
    return function (offset, limit) {
      var lim = Math.min(Math.max(1, limit), MAX_LIMIT)
      var legacy = function () {
        return get(legacyRoute(extra || {}), { timeout: TIMEOUT_MS.list }).then(function (r) {
          var b = r.body || {}
          return { items: normalizeList(Array.isArray(b.items) ? b.items : [], normalize), all: true }
        })
      }
      if (!pagedApi) return legacy()
      var q = Object.assign({}, extra || {}, { limit: lim, offset: offset })
      return get(v1Route(q), { timeout: TIMEOUT_MS.list }).then(
        function (r) { return shapePage(r, normalize) },
        function (err) {
          if (err && (err.kind === 'not_found' || err.status === 403 || err.status === 405)) {
            pagedApi = false
            return legacy()
          }
          throw err
        }
      )
    }
  }

  return {
    request: request,

    // discovery / sign-in (no token needed)
    ping: function () {
      return get(routes.ping(), { auth: false, timeout: TIMEOUT_MS.quick }).then(function (r) {
        var b = r.body || {}
        if (b.app !== 'beeboentertainment') throw makeError('bad_response', r.status, '/api/ping')
        return { apiVersion: b.apiVersion }
      })
    },
    login: function (username, password) {
      return post(routes.login(), { username: username, password: password }, { auth: false, timeout: TIMEOUT_MS.normal }).then(
        function (r) {
          var b = r.body || {}
          if (!b.ok || typeof b.token !== 'string' || !b.token) throw makeError('unauthorized', 401, '/api/login')
          return { token: b.token, user: normalizeUser(b.user) }
        },
        function (err) {
          // Lockout after too many wrong tries: { locked:true, minutesRemaining }
          if (err && err.body && err.body.locked) err.locked = { minutes: Number(err.body.minutesRemaining) || 0 }
          throw err
        }
      )
    },
    me: function () {
      return get(routes.me(), { timeout: TIMEOUT_MS.quick }).then(function (r) { return normalizeUser(r.body && r.body.user) })
    },

    // library
    moviePage: function (extra) { return listPage(routes.libraryMovies, routes.movies, normalizeMovie, extra) },
    showPage: function (extra) { return listPage(routes.libraryTvShows, routes.tvShows, normalizeShow, extra) },
    usingPagedApi: function () { return pagedApi },
    continueWatching: function () {
      return get(routes.continueWatching()).then(function (r) { return normalizeList(r.body && r.body.items, normalizeContinue, 60) })
    },
    recentlyAdded: function () {
      return get(routes.recentlyAdded()).then(function (r) { return normalizeList(r.body && r.body.items, normalizeRecent, 40) })
    },
    episodes: function (showKey) {
      return get(routes.episodes(showKey), { timeout: TIMEOUT_MS.list }).then(function (r) { return normalizeEpisodes(r.body) })
    },
    episodeContext: function (id) {
      return get(routes.episodeContext(id), { timeout: TIMEOUT_MS.quick }).then(function (r) {
        var b = r.body || {}
        return typeof b.showKey === 'string' && b.showKey ? { showKey: b.showKey } : null
      })
    },

    // playback
    playbackInfo: function (kind, id) {
      return get(routes.playbackInfo(kind, id), { timeout: TIMEOUT_MS.start }).then(function (r) { return normalizePlaybackInfo(r.body) })
    },
    playbackStart: function (kind, id, quality, audioStreamIndex) {
      var body = { kind: kind === 'tv' ? 'tv' : 'movie', id: id, quality: quality }
      if (audioStreamIndex !== null && audioStreamIndex !== undefined) body.audio = audioStreamIndex
      return post(routes.playbackStart(), body, { timeout: TIMEOUT_MS.start }).then(function (r) {
        var s = normalizePlaybackStart(r.body)
        if (!s) throw makeError('bad_response', r.status, '/api/playback/start')
        return s
      })
    },
    playbackStop: function (ticket) {
      if (!ticket) return Promise.resolve()
      return post(routes.playbackStop(), { ticket: ticket }, { timeout: TIMEOUT_MS.quick }).then(function () {}, function () {})
    },
    watchSession: function (kind, id) {
      return post(routes.watchSession(), { kind: kind === 'tv' ? 'tv' : 'movie', id: id }, { timeout: TIMEOUT_MS.normal }).then(function (r) {
        var sid = r.body && r.body.sessionId
        return typeof sid === 'string' && sid ? sid : ''
      })
    },
    progress: function (sessionId, currentTime, duration) {
      if (!sessionId) return Promise.resolve()
      return post(routes.progress(), { sessionId: sessionId, currentTime: currentTime, duration: duration }, { timeout: TIMEOUT_MS.quick }).then(function () {}, function () {})
    },
    upNext: function (kind, id) {
      return get(routes.upNext(kind, id), { timeout: TIMEOUT_MS.quick }).then(
        function (r) { return normalizeNeighbour(r.body && r.body.next) },
        function () { return null }
      )
    },
    // Movie Night (docs/MOVIE-NIGHT.md): is it available, and start a room whose shared screen this TV then opens.
    movieNightStatus: function () {
      return get(movieNightRoutes.status(), { timeout: TIMEOUT_MS.quick }).then(function (r) { return normalizeStatus(r.body) })
    },
    movieNightStart: function () {
      return post(movieNightRoutes.create(), {}, { timeout: TIMEOUT_MS.normal }).then(function (r) {
        var t = tvUrlFromReply(origin(), r.body)
        if (!t.ok) throw makeError('bad_response', r.status, '/api/movie-night/tv/create')
        return t
      })
    },
    /** Plain-text GET (subtitle files). Same auth-free media token in the URL as the server issued. */
    getText: function (relPath) {
      var url = buildUrl(origin(), relPath)
      return request('GET', url, { auth: false, expectJson: false, timeout: TIMEOUT_MS.normal }).then(function (r) { return r.text })
    }
  }
}

/**
 * post(origin, path, json, bearer) for pairing.exchangeViewerToken(): resolves { status, body } for ANY
 * HTTP status (so the caller can tell 404 / 401 / 429 apart) and rejects only on network failure
 * (err.status === 0).
 */
export function createExchangePost(XHR) {
  return function (origin, path, json, bearer) {
    var client = createClient({ XHR: XHR, getOrigin: function () { return origin }, getToken: function () { return '' } })
    return client.request('POST', buildUrl(origin, path), { json: json, auth: false, bearer: bearer, timeout: TIMEOUT_MS.normal }).then(
      function (r) { return { status: r.status, body: r.body } },
      function (err) {
        if (err && err.status > 0) return { status: err.status, body: err.body }
        throw err
      }
    )
  }
}

/** Cross-origin JSON POST used by pairing (different origin from the home server). */
export function createPairTransport(XHR, base) {
  var client = createClient({ XHR: XHR, getOrigin: function () { return base }, getToken: function () { return '' } })
  return {
    post: function (path, json) {
      return client.request('POST', buildUrl(base, path), { json: json, auth: false, timeout: TIMEOUT_MS.normal }).then(function (r) { return r.body })
    }
  }
}
