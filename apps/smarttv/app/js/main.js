// Beebo TV - bootstrap: wires storage, API client, focus manager, router, screens and the remote.

import { createStore } from './store.js'
import { createClient } from './api.js'
import { createFocus } from './nav/focus.js'
import { createRouter } from './router.js'
import { keyToAction, directionOf } from './nav/keys.js'
import { shouldDropBack } from './nav/gamepad.js'
import { createPlatform } from './platform/platform.js'
import { createSession } from './session.js'
import { resumePosition } from './util/seek.js'
import { welcome, address, pair, signin } from './screens/setup.js'
import { home } from './screens/home.js'
import { library } from './screens/library.js'
import { search } from './screens/search.js'
import { detail } from './screens/detail.js'
import { player } from './screens/player.js'
import { settings } from './screens/settings.js'
import { movienight } from './screens/movienight.js'

var CANVAS_W = 1920
var CANVAS_H = 1080

function safeStorage() {
  try { return window.localStorage } catch (e) { return null }
}

function boot() {
  var store = createStore(safeStorage())
  var platform = createPlatform()
  var focus = createFocus()
  var stage = document.getElementById('stage')
  var toastEl = document.getElementById('toast')
  var toastTimer = null
  var router = null
  var signingOut = false

  // ---- scale the 1920x1080 canvas to the real screen (1280x720 TVs etc.) ---------------------------
  function applyScale() {
    var w = window.innerWidth || CANVAS_W
    var h = window.innerHeight || CANVAS_H
    var s = Math.min(w / CANVAS_W, h / CANVAS_H)
    if (Math.abs(s - 1) < 0.001) {
      stage.style.transform = ''
      stage.style.left = '0px'
      stage.style.top = '0px'
    } else {
      stage.style.transform = 'scale(' + s + ')'
      stage.style.left = Math.round((w - CANVAS_W * s) / 2) + 'px'
      stage.style.top = Math.round((h - CANVAS_H * s) / 2) + 'px'
    }
  }
  applyScale()
  window.addEventListener('resize', applyScale)

  function toast(text) {
    toastEl.textContent = String(text || '')
    toastEl.classList.add('on')
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(function () { toastEl.classList.remove('on') }, 3800)
  }

  // ---- services shared with screens ------------------------------------------------------------------
  var ctx = {
    store: store,
    platform: platform,
    focus: focus,
    XHR: window.XMLHttpRequest,
    toast: toast,
    origin: function () { return store.getServer() }
  }
  ctx.api = createClient({
    XHR: ctx.XHR,
    getOrigin: ctx.origin,
    getToken: function () { return store.getToken() },
    onUnauthorized: function () {
      // The token was revoked/expired: forget it and ask again (once, however many requests fail together).
      if (signingOut) return
      signingOut = true
      store.signOut()
      ctx.session.reset()
      toast('You were signed out. Please sign in again.')
      setTimeout(function () { signingOut = false; router.reset('signin') }, 0)
    }
  })
  ctx.makeClient = function (origin) {
    return createClient({ XHR: ctx.XHR, getOrigin: function () { return origin }, getToken: function () { return '' } })
  }
  ctx.session = createSession(function () { return ctx.api })

  var TAB_SCREENS = { library: 1, search: 1, settings: 1 }
  ctx.goTab = function (id) {
    if (id === 'home') { while (router.depth() > 1) router.back(); return }
    var name = id === 'movies' || id === 'tv' ? 'library' : id
    var params = id === 'movies' ? { kind: 'movie' } : id === 'tv' ? { kind: 'tv' } : {}
    if (TAB_SCREENS[router.currentName()]) router.replace(name, params)
    else router.push(name, params)
  }
  ctx.openDetail = function (item) { router.push('detail', { item: item }) }
  ctx.play = function (p) { router.push('player', p) }
  ctx.playItem = function (it) {
    ctx.play({ kind: it.kind, id: it.id, title: it.title, resumeSec: it.upNext ? 0 : resumePosition(it.currentTime, it.duration) })
  }
  ctx.startHome = function () { ctx.session.reset(); router.reset('home') }
  ctx.afterServerChosen = function () {
    if (store.getToken()) ctx.startHome()
    else router.reset('signin')
  }
  ctx.signOut = function () { store.signOut(); ctx.session.reset(); router.reset('signin') }
  ctx.changeServer = function () { store.signOut(); store.setServer(''); ctx.session.reset(); router.reset('welcome') }
  ctx.refreshContinue = function () {
    if (!store.getToken()) return
    ctx.api.continueWatching().then(function (items) { ctx.session.setContinue(items) }, function () { /* keep the old list */ })
  }

  router = createRouter(document.getElementById('screens'), focus, {
    welcome: welcome, address: address, pair: pair, signin: signin,
    home: home, library: library, search: search, detail: detail, player: player, settings: settings, movienight: movienight
  }, ctx)
  ctx.router = router
  // Xbox only: keep the shell's idea of "can the page use Back" current across every route change.
  if (typeof platform.reportBackState === 'function') {
    ;['push', 'replace', 'reset', 'back'].forEach(function (m) {
      var f = router[m]
      router[m] = function () { var r = f.apply(router, arguments); reportBackState(); return r }
    })
    setInterval(reportBackState, 500) // overlays open and close without going through the router
  }

  // ---- remote control ------------------------------------------------------------------------------------
  var lastBackAt = null

  // Xbox only: tell the shell whether a Back press is useful here. When it is not (Home, nothing open),
  // the shell lets the system take the B press, which returns to the Xbox Home screen.
  function reportBackState() {
    if (typeof platform.reportBackState !== 'function') return
    platform.reportBackState(router.depth() > 1 || focus.scopeDepth() > 1)
  }

  // One action, from a key press, a gamepad poll or the Xbox shell. `ev` is the key event or null.
  function route(action, ev) {
    if (action === 'ignore') return
    if (action === 'back') {
      // One physical B press can arrive twice on Xbox (key event + system back request): drop the echo.
      var now = Date.now()
      if (shouldDropBack(lastBackAt, now, platform.backDebounceMs)) return
      lastBackAt = now
    }
    var screen = router.currentScreen()
    if (screen && screen.onKey && screen.onKey(action, ev) === true) return
    var dir = directionOf(action)
    if (dir) { focus.move(dir); return }
    if (action === 'enter') { focus.activate(); return }
    if (action === 'search') {
      // Gamepad Y (Microsoft's recommended search shortcut): jump to Search from anywhere signed in except the player.
      if (store.getToken() && router.currentName() !== 'player' && router.currentName() !== 'search') ctx.goTab('search')
      return
    }
    if (action === 'back') { if (!router.back()) platform.exit() }
  }
  function handleAction(action, ev) {
    route(action, ev)
    reportBackState()
  }

  function onKeyDown(ev) {
    if (typeof platform.noteKey === 'function') platform.noteKey(ev)
    var action = keyToAction(ev)
    var screen = router.currentScreen()
    if (action === null) {
      // Not a remote key we know (digits, letters, volume...): only a screen with text entry may take it.
      if (screen && screen.onRawKey && screen.onRawKey(ev) === true) ev.preventDefault()
      return
    }
    ev.preventDefault()
    handleAction(action, ev)
  }
  document.addEventListener('keydown', onKeyDown, false)
  platform.registerKeys()
  // Xbox only: the shell's Back / media-remote calls and the Gamepad API fallback arrive here.
  if (typeof platform.installInput === 'function') platform.installInput(function (action) { handleAction(action, null) })

  window.onerror = function () { toast('Something went wrong. Press Back and try again.'); return true }
  window.addEventListener('unhandledrejection', function (e) { try { e.preventDefault() } catch (x) { /* ignore */ } })

  // ---- first screen --------------------------------------------------------------------------------------------
  if (!store.getServer()) router.reset('welcome')
  else if (!store.getToken()) router.reset('signin')
  else router.reset('home')

  reportBackState()
  var bootEl = document.getElementById('boot')
  if (bootEl) bootEl.className = 'boot gone'
}

try {
  boot()
} catch (e) {
  var b = document.getElementById('boot')
  if (b) b.textContent = 'Beebo could not start on this TV.'
}
