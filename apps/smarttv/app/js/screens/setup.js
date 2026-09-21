// First-run screens: welcome -> (pair code | typed address) -> sign in.

import { h, clear, setText } from '../dom.js'
import { button, stateBox, createKeyboard } from '../ui.js'
import { normalizeServerAddress } from '../util/urls.js'
import {
  runPairing, createTransport, exchangeViewerToken, displayUri, secondsLeft, PAIR_BASE_DEFAULT
} from '../pairing.js'
import { createPairTransport, createExchangePost } from '../api.js'
import { formatClock } from '../util/escape.js'

var ADDRESS_ERRORS = {
  empty: 'Type your server’s address first.',
  too_long: 'That address is too long.',
  invalid: 'That doesn’t look like an address. Try something like 192.168.1.20 or your Beebo name.',
  port: 'The port must be a number from 1 to 65535.',
  scheme: 'Only http:// and https:// addresses work.',
  credentials: 'Leave out any username or password in the address.',
  path: 'Only the address itself is needed, nothing after it.'
}

// ---------------------------------------------------------------------------------------------
export function welcome(ctx) {
  var el = h('div', { cls: 'screen' })
  var col = h('div', { cls: 'center-col' })
  col.appendChild(h('div', { cls: 'brand', text: 'Beebo', css: { marginTop: '40px' } }))
  var head = h('div', { cls: 'setup-head' }, [
    h('div', { cls: 'title', text: 'Connect this TV to your Beebo server' }),
    h('div', { cls: 'dim', text: 'Beebo plays the movies and shows on your own computer. Nothing is stored on the TV.' })
  ])
  col.appendChild(head)
  var row = h('div', { css: { marginTop: '50px' } })
  var b1 = button('Find my home with a code', function () { ctx.router.push('pair') }, 'primary')
  var b2 = button('Type my server address', function () { ctx.router.push('address') })
  row.appendChild(b1)
  row.appendChild(b2)
  col.appendChild(row)
  col.appendChild(h('div', { cls: 'hint', text: 'The code method needs no typing on the remote: you approve the TV from your phone.', css: { marginTop: '40px' } }))
  el.appendChild(col)
  return { el: el, onShow: function () { ctx.focus.focus(b1) } }
}

// ---------------------------------------------------------------------------------------------
export function address(ctx, params) {
  var el = h('div', { cls: 'screen' })
  var col = h('div', { cls: 'center-col' })
  var saved = ctx.store.getServer().replace(/^https?:\/\//, '')
  var err = h('div', { cls: 'err' })
  var busy = false

  var kb = createKeyboard({ mode: 'address', value: (params && params.value) || saved, maxLen: 80, placeholder: '192.168.1.20', focus: ctx.focus, onChange: function () { setText(err, '') } })
  col.appendChild(h('div', { cls: 'setup-head' }, [
    h('div', { cls: 'title', text: 'Server address' }),
    h('div', { cls: 'dim', text: 'On the computer running Beebo, its address is shown in Settings. Use the numbers (like 192.168.1.20) at home, or your Beebo name (like nick) from anywhere.' })
  ]))
  col.appendChild(kb.field)
  col.appendChild(err)
  col.appendChild(kb.el)
  var actions = h('div', { css: { marginTop: '20px' } })
  var connect = button('Connect', doConnect, 'primary')
  var cancel = button('Back', function () { ctx.router.back() })
  actions.appendChild(connect)
  actions.appendChild(cancel)
  col.appendChild(actions)
  el.appendChild(col)

  function doConnect() {
    if (busy) return
    var r = normalizeServerAddress(kb.getValue())
    if (!r.ok) { setText(err, ADDRESS_ERRORS[r.error] || ADDRESS_ERRORS.invalid); return }
    busy = true
    setText(err, 'Connecting to ' + r.origin.replace(/^https?:\/\//, '') + '…')
    ctx.makeClient(r.origin).ping().then(
      function () {
        busy = false
        ctx.store.setServer(r.origin)
        ctx.afterServerChosen()
      },
      function (e) {
        busy = false
        var extra = r.kind === 'beebo-name' ? ' (For a Beebo name, the computer must be reachable from the internet. At home, use its numeric address instead.)' : ''
        setText(err, (e && e.friendly ? e.friendly : 'Could not connect.') + extra)
      }
    )
  }

  return {
    el: el,
    onShow: function () { ctx.focus.focus(kb.firstKey()) },
    onRawKey: function (ev) {
      if (ev.key === 'Enter') return false
      return kb.typeRaw(ev)
    },
    onKey: function (action) {
      if (action === 'back' && kb.getValue().length > 0 && ctx.focus.current() && ctx.focus.current().classList.contains('key')) {
        // Back on the keyboard deletes a character; it leaves the screen from the buttons row.
        kb.backspace()
        return true
      }
      return false
    }
  }
}

// ---------------------------------------------------------------------------------------------
export function pair(ctx) {
  var el = h('div', { cls: 'screen' })
  var col = h('div', { cls: 'center-col' })
  el.appendChild(col)
  var run = null
  var countdown = null
  var lastState = null
  var dead = false

  function stop() {
    if (run) { run.cancel(); run = null }
    if (countdown) { clearInterval(countdown); countdown = null }
  }

  function renderWaiting(s) {
    clear(col)
    col.appendChild(h('div', { cls: 'setup-head' }, [
      h('div', { cls: 'title', text: 'Approve this TV from your phone' }),
      h('div', { cls: 'pair-steps', text: '1. On your phone or computer, open the address below and sign in to Beebo.   2. Enter this code and choose Approve.' })
    ]))
    col.appendChild(h('div', { cls: 'pair-uri', text: displayUri(s.verificationUri) }))
    col.appendChild(h('div', { cls: 'pair-code', text: s.userCode }))
    var wait = h('div', { cls: 'pair-wait' }, [h('span', { cls: 'spinner' }), h('span', { cls: 'left', text: 'Waiting for approval…' })])
    col.appendChild(wait)
    var cancel = button('Cancel', function () { ctx.router.back() })
    col.appendChild(cancel)
    ctx.focus.focus(cancel)
  }

  function tickCountdown() {
    if (!lastState || lastState.phase !== 'waiting') return
    var left = col.querySelector('.left')
    if (left) setText(left, 'Waiting for approval…  code expires in ' + formatClock(secondsLeft(lastState, Date.now())))
  }

  function renderBox(opts) {
    clear(col)
    var box = stateBox(opts)
    col.appendChild(box)
    ctx.focus.focusFirst()
  }

  function typeInstead() { ctx.router.replace('address') }

  function onApproved(a) {
    var origin = normalizeServerAddress(a.houseName).origin
    var token = a.viewerToken
    a = null
    renderBox({ spinner: true, title: 'Approved', message: 'Finding your home…' })
    var client = ctx.makeClient(origin)
    client.ping().then(function () {
      var post = createExchangePost(ctx.XHR)
      return exchangeViewerToken({ post: post }, origin, token, ctx.platform.deviceName).then(function (r) {
        token = '' // discard the viewer token now, whatever the outcome
        if (dead) return
        ctx.store.setServer(origin)
        if (r.status === 'signed_in') {
          ctx.store.setToken(r.token)
          ctx.store.setUserName(r.userName)
          ctx.startHome()
          return
        }
        // Older server (404), refused, rate limited...: fall back to the person's own username + password.
        var note = 'Found your home. Now sign in with your Beebo username and password.'
        if (r.status === 'rate_limited') note = 'Too many attempts. Sign in with your username and password instead.'
        ctx.router.replace('signin', { note: note })
      })
    }).then(null, function (e) {
      token = ''
      if (dead) return
      renderBox({
        title: 'Your home is not reachable from this TV',
        message: (e && e.friendly ? e.friendly : '') + ' If the TV is on the same Wi-Fi as the computer, type its numeric address instead.',
        actions: [{ label: 'Type the address', onSelect: typeInstead }, { label: 'Try the code again', onSelect: start }]
      })
    })
  }

  function start() {
    stop()
    renderBox({ spinner: true, title: 'Getting a code…' })
    var base = ctx.store.getPairBase() || PAIR_BASE_DEFAULT
    var transport = createTransport(createPairTransport(ctx.XHR, base).post, { deviceName: ctx.platform.deviceName, deviceModel: ctx.platform.deviceModel() })
    run = runPairing({
      start: transport.start,
      poll: transport.poll,
      now: function () { return Date.now() },
      setTimer: function (fn, ms) { return setTimeout(fn, ms) },
      clearTimer: function (t) { clearTimeout(t) },
      onApproved: onApproved,
      onState: function (s) {
        if (dead) return
        var prevPhase = lastState ? lastState.phase : ''
        lastState = s
        if (s.phase === 'waiting' && prevPhase !== 'waiting') {
          renderWaiting(s)
          countdown = setInterval(tickCountdown, 1000)
        } else if (s.phase === 'unavailable') {
          ctx.toast('Code sign-in isn’t switched on yet. Type your server address instead.')
          typeInstead()
        } else if (s.phase === 'denied') {
          renderBox({ title: 'Not approved', message: 'The request was declined on the phone.', actions: [{ label: 'Try again', onSelect: start }, { label: 'Type the address', onSelect: typeInstead }] })
        } else if (s.phase === 'expired') {
          renderBox({ title: 'The code expired', message: 'Codes only last a few minutes.', actions: [{ label: 'Get a new code', onSelect: start }, { label: 'Type the address', onSelect: typeInstead }] })
        } else if (s.phase === 'error') {
          renderBox({ title: 'Couldn’t reach the sign-in service', message: (s.error || '') + ' You can still type your server address.', actions: [{ label: 'Try again', onSelect: start }, { label: 'Type the address', onSelect: typeInstead }] })
        }
      }
    })
  }

  return {
    el: el,
    onShow: function () { if (!run && !lastState) start() },
    destroy: function () { dead = true; stop() }
  }
}

// ---------------------------------------------------------------------------------------------
export function signin(ctx, params) {
  var el = h('div', { cls: 'screen' })
  var col = h('div', { cls: 'center-col' })
  el.appendChild(col)
  var step = 'user'
  var username = ''
  var kb = null
  var err = h('div', { cls: 'err' })
  var busy = false
  var note = params && params.note ? params.note : ''

  function render() {
    clear(col)
    var isPass = step === 'pass'
    col.appendChild(h('div', { cls: 'setup-head' }, [
      h('div', { cls: 'title', text: isPass ? 'Your password' : 'Sign in to Beebo' }),
      h('div', { cls: 'dim', text: isPass ? 'Signing in as ' + username : (note || 'Use the same username and password as on the Beebo phone app.') })
    ]))
    kb = createKeyboard({ mode: isPass ? 'password' : 'text', mask: isPass, value: isPass ? '' : username, maxLen: 100, placeholder: isPass ? 'Password' : 'Username', focus: ctx.focus, onChange: function () { setText(err, '') } })
    col.appendChild(kb.field)
    setText(err, '')
    col.appendChild(err)
    col.appendChild(kb.el)
    var actions = h('div', { css: { marginTop: '20px' } })
    var next = button(isPass ? 'Sign in' : 'Next', isPass ? doLogin : doNext, 'primary')
    var back = button('Back', function () { if (isPass) { step = 'user'; render(); ctx.focus.focus(kb.firstKey()) } else ctx.router.back() })
    actions.appendChild(next)
    actions.appendChild(back)
    col.appendChild(actions)
    ctx.focus.focusFirst(kb.firstKey())
  }

  function doNext() {
    var u = kb.getValue().trim()
    if (!u) { setText(err, 'Type your username first.'); return }
    username = u
    step = 'pass'
    render()
  }

  function doLogin() {
    if (busy) return
    var pw = kb.getValue()
    if (!pw) { setText(err, 'Type your password first.'); return }
    busy = true
    setText(err, 'Signing in…')
    ctx.api.login(username, pw).then(
      function (r) {
        pw = ''
        busy = false
        ctx.store.setToken(r.token)
        ctx.store.setUserName(r.user.name || username)
        ctx.startHome()
      },
      function (e) {
        pw = ''
        busy = false
        if (e && e.locked) setText(err, 'Too many wrong tries. Try again in ' + (e.locked.minutes || 'a few') + ' minutes.')
        else if (e && e.kind === 'unauthorized') setText(err, 'That username or password is not right.')
        else setText(err, e && e.friendly ? e.friendly : 'Could not sign in.')
        step = 'user'
        setTimeout(function () { if (!busy) { var msg = err.textContent; render(); setText(err, msg); ctx.focus.focusFirst(kb.firstKey()) } }, 0)
      }
    )
  }

  return {
    el: el,
    onShow: function () { render() },
    onRawKey: function (ev) { return kb ? kb.typeRaw(ev) : false },
    onKey: function (action) {
      if (action === 'back' && kb && kb.getValue().length > 0 && ctx.focus.current() && ctx.focus.current().classList.contains('key')) { kb.backspace(); return true }
      return false
    },
    destroy: function () { username = ''; kb = null }
  }
}
