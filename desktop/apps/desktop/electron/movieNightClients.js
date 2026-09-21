'use strict'
// ============================================================================
// movieNightClients.js - the three browser programs of Movie Night, written as real functions.
// ----------------------------------------------------------------------------
//   movieNightTvClient     the shared screen (10-foot UI, D-pad, TV remote keys)
//   movieNightGuestClient  the phone (controller)
//   movieNightOverlayClient  reactions over a film in the player page (only when the launcher opted in)
//
// Each is pasted into its page with toString(), so it is syntax-checked with the rest of the code and needs no
// escaping. They run on old TV browsers (Chromium 53+), so they are written in plain ES5: no arrow functions,
// let / const, template strings, optional chaining, flexbox `gap` or CSS min() / max() / clamp().
//
// SECURITY: names, titles, taglines, actor names and every other string here came from other people or from
// file names. NOTHING in these functions builds HTML: text reaches the screen through textContent only (no
// innerHTML, insertAdjacentHTML, outerHTML, document.write or eval anywhere; a test scans for them). QR codes
// are drawn on a canvas from a matrix of 0/1, and colours are only used after they match #rrggbb.
// ============================================================================

/* eslint-disable no-undef, no-var, prefer-const, no-inner-declarations -- runs in the browser */

function movieNightTvClient(CFG) {
  'use strict'
  var API = CFG.api
  var enc = encodeURIComponent
  var root = document.getElementById('app')
  var S = {
    ticket: '', st: null, info: null, es: null, esFails: 0, pollTimer: 0, offset: 0, dialog: '', ended: false, err: '', focusId: '',
    sound: false, audio: null, prev: null, tickAt: 0, qrKey: '', reactions: 0, loading: true, seenLaunch: 0
  }
  var HEX = /^#[0-9a-fA-F]{6}$/
  var reduced = false
  try { reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) } catch (e) { reduced = false }

  function el(tag, cls, text) {
    var e = document.createElement(tag)
    if (cls) e.className = cls
    if (text !== undefined && text !== null) e.textContent = String(text)
    return e
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild) }
  function sget(k) { try { return sessionStorage.getItem(k) || '' } catch (e) { return '' } }
  function sset(k, v) { try { if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v) } catch (e) { /* private mode */ } }
  function lget(k) { try { return localStorage.getItem(k) || '' } catch (e) { return '' } }
  function lset(k, v) { try { localStorage.setItem(k, v) } catch (e) { /* ignore */ } }
  function color(c) { return HEX.test(String(c)) ? c : '#cccccc' }
  function now() { return Date.now() + S.offset }

  function req(method, path, body) {
    var opts = { method: method, credentials: 'same-origin', cache: 'no-store', headers: {} }
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body) }
    return fetch(API + path, opts).then(function (r) { return r.json().catch(function () { return { ok: false, error: 'bad_reply' } }) }, function () { return { ok: false, error: 'network', message: 'Could not reach the server.' } })
  }
  function act(type, extra) {
    var b = { ticket: S.ticket, type: type }
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) b[k] = extra[k]
    return req('POST', '/act', b).then(function (r) { if (r && r.ok === false && r.message) toast(r.message); return r })
  }

  // ---- sound: generated with WebAudio, nothing to download; off until someone turns it on --------------------------
  function ctxAudio() {
    if (!S.sound) return null
    if (!S.audio) { try { var C = window.AudioContext || window.webkitAudioContext; S.audio = C ? new C() : null } catch (e) { S.audio = null } }
    if (S.audio && S.audio.state === 'suspended') { try { S.audio.resume() } catch (e) { /* needs a key press first */ } }
    return S.audio
  }
  function tone(freq, start, dur, type, vol) {
    var a = ctxAudio()
    if (!a) return
    try {
      var o = a.createOscillator(), g = a.createGain(), t0 = a.currentTime + start
      o.type = type || 'sine'
      o.frequency.value = freq
      g.gain.setValueAtTime(0.0001, t0)
      g.gain.exponentialRampToValueAtTime(vol || 0.12, t0 + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
      o.connect(g); g.connect(a.destination)
      o.start(t0); o.stop(t0 + dur + 0.05)
    } catch (e) { /* audio is a bonus */ }
  }
  function sfx(name) {
    if (!S.sound) return
    if (name === 'join') { tone(523, 0, 0.12); tone(784, 0.1, 0.16) }
    else if (name === 'next') { tone(440, 0, 0.1, 'triangle') }
    else if (name === 'reveal') { tone(392, 0, 0.12, 'triangle'); tone(523, 0.12, 0.2, 'triangle') }
    else if (name === 'good') { tone(523, 0, 0.1); tone(659, 0.1, 0.1); tone(784, 0.2, 0.22) }
    else if (name === 'tick') { tone(880, 0, 0.05, 'square', 0.05) }
    else if (name === 'fanfare') { tone(523, 0, 0.15); tone(659, 0.15, 0.15); tone(784, 0.3, 0.15); tone(1047, 0.45, 0.4) }
    else if (name === 'pop') { tone(700, 0, 0.06, 'sine', 0.06) }
  }
  function setSound(on) {
    S.sound = !!on
    lset('mn.sound', S.sound ? '1' : '0')
    if (S.sound) { ctxAudio(); sfx('good') }
    render()
  }

  // ---- toast + reactions ------------------------------------------------------------------------------------------
  var toastBox = el('div', 'toast'); toastBox.setAttribute('role', 'status'); toastBox.setAttribute('aria-live', 'polite')
  var toastTimer = 0
  function toast(msg) {
    toastBox.textContent = String(msg || '')
    toastBox.className = 'toast on'
    clearTimeout(toastTimer)
    toastTimer = setTimeout(function () { toastBox.className = 'toast' }, 4200)
  }
  var floatBox = el('div', 'floats'); floatBox.setAttribute('aria-hidden', 'true')
  function showReaction(ev) {
    if (!ev || typeof ev.emoji !== 'string' || S.reactions > 8) return
    S.reactions++
    var f = el('div', 'fl' + (reduced ? ' still' : ''))
    f.style.left = (8 + Math.floor(Math.random() * 78)) + '%'
    f.appendChild(el('span', 'fe', ev.emoji.slice(0, 8)))
    var who = el('span', 'fn', String(ev.name || '').slice(0, 16)); who.style.borderColor = color(ev.color)
    f.appendChild(who)
    floatBox.appendChild(f)
    sfx('pop')
    setTimeout(function () { if (f.parentNode) f.parentNode.removeChild(f); S.reactions-- }, reduced ? 1600 : 3400)
  }

  // ---- pieces of screen -------------------------------------------------------------------------------------------
  function badge(g, big) {
    var b = el('span', 'badge' + (big ? ' big' : ''))
    b.style.background = color(g.color)
    b.appendChild(el('span', 'glyph', g.glyph || ''))
    b.appendChild(el('span', 'bn', g.name))
    if (g.host) b.appendChild(el('span', 'hostTag', 'HOST'))
    return b
  }
  function btn(label, fid, fn, cls) {
    var b = el('button', 'btn' + (cls ? ' ' + cls : ''), label)
    b.type = 'button'
    b.setAttribute('data-fid', fid)
    b.onclick = function () { if (S.audio === null) ctxAudio(); fn() }
    return b
  }
  function drawQr(canvas, qr, px) {
    var n = qr.n, q = 4, cell = Math.max(2, Math.floor(px / (n + q * 2)))
    var size = cell * (n + q * 2)
    canvas.width = size; canvas.height = size
    canvas.style.width = size + 'px'; canvas.style.height = size + 'px'
    var c = canvas.getContext('2d')
    c.fillStyle = '#ffffff'; c.fillRect(0, 0, size, size)
    c.fillStyle = '#000000'
    for (var r = 0; r < n; r++) for (var k = 0; k < n; k++) if (qr.rows[r].charAt(k) === '1') c.fillRect((k + q) * cell, (r + q) * cell, cell, cell)
  }
  function qrCanvas(px) {
    var cv = el('canvas', 'qr')
    cv.setAttribute('role', 'img')
    cv.setAttribute('aria-label', 'QR code to join Movie Night')
    if (S.info && S.info.qr) drawQr(cv, S.info.qr, px)
    return cv
  }
  function countdown() {
    var box = el('div', 'cd')
    var bar = el('div', 'bar'); var fill = el('div', 'fill'); fill.id = 'cdFill'; bar.appendChild(fill)
    var num = el('div', 'cdnum'); num.id = 'cdNum'
    box.appendChild(bar); box.appendChild(num)
    return box
  }
  function topbar(st) {
    var bar = el('div', 'top')
    var left = el('div', 'brand')
    left.appendChild(el('span', 'logo', 'MOVIE NIGHT'))
    if (st.hostName) left.appendChild(el('span', 'hostname', st.hostName))
    bar.appendChild(left)
    var right = el('div', 'topright')
    if (st.phase !== 'lobby') {
      var j = el('div', 'joinmini')
      j.appendChild(el('div', 'jl', 'Join: ' + st.code))
      if (S.info && S.info.qr) j.appendChild(qrCanvas(Math.round(window.innerHeight * 0.16)))
      right.appendChild(j)
    }
    var snd = btn(S.sound ? 'Sound: On' : 'Sound: Off', 'sound', function () { setSound(!S.sound) }, 'small')
    right.appendChild(snd)
    bar.appendChild(right)
    return bar
  }
  function footer(st) {
    var f = el('div', 'foot')
    f.appendChild(el('span', '', st.attribution || ''))
    return f
  }

  // ---- screens ----------------------------------------------------------------------------------------------------
  function hostRow(st, items) {
    var row = el('div', 'hostrow')
    for (var i = 0; i < items.length; i++) row.appendChild(items[i])
    return row
  }

  function screenLobby(st) {
    var wrap = el('div', 'lobby')
    var left = el('div', 'lobbyleft')
    left.appendChild(el('div', 'h2', 'Join on your phone'))
    left.appendChild(qrCanvas(Math.round(window.innerHeight * 0.4)))
    var code = el('div', 'bigcode', st.code); code.setAttribute('aria-label', 'Room code ' + st.code.split('').join(' '))
    left.appendChild(code)
    if (!st.qrOnly) left.appendChild(el('div', 'hint', 'Or open ' + (S.info ? S.info.codeAddress : 'the join page') + ' and type the code'))
    else left.appendChild(el('div', 'hint', 'Scan the QR code to join (typing the code is switched off)'))
    if (st.locked) left.appendChild(el('div', 'note', 'Room locked: nobody new can join'))
    wrap.appendChild(left)

    var right = el('div', 'lobbyright')
    right.appendChild(el('div', 'h2', st.guests.length ? 'Players (' + st.guests.length + '/' + st.settings.maxGuests + ')' : 'Waiting for players…'))
    var list = el('div', 'guests')
    for (var i = 0; i < st.guests.length; i++) {
      var g = st.guests[i]
      var b = badge(g)
      if (st.teams && g.team !== null) { b.appendChild(el('span', 'teamTag', st.teams[g.team].name.split(' ')[0])) }
      if (!g.connected) b.className += ' away'
      list.appendChild(b)
    }
    right.appendChild(list)
    if (st.featured) right.appendChild(el('div', 'featured', 'Tonight: ' + st.featured.title + (st.featured.year ? ' (' + st.featured.year + ')' : '')))
    if (st.suggestions && st.suggestions.length) {
      var sg = el('div', 'sugg', 'Suggested: ')
      for (var s = 0; s < st.suggestions.length; s++) sg.appendChild(el('span', 'sg', st.suggestions[s].title + ' (' + st.suggestions[s].by + ')'))
      right.appendChild(sg)
    }
    right.appendChild(el('div', 'h3', st.guests.length ? 'Pick a game' : 'Games unlock when someone joins'))
    var menu = el('div', 'menu')
    var menuItems = st.menu || []
    for (var m = 0; m < menuItems.length; m++) {
      (function (it) {
        var can = it.ready && st.guests.length > 0
        var b2 = btn(it.title, 'game-' + it.id, function () { if (can) act('start', { game: it.id }); else toast(it.ready ? 'Waiting for the first player to join.' : 'Not ready: ' + it.why) }, 'game' + (can ? '' : ' off'))
        b2.appendChild(el('span', 'blurb', it.ready ? it.blurb : 'Needs ' + it.why))
        menu.appendChild(b2)
      })(menuItems[m])
    }
    right.appendChild(menu)
    if (st.pool.message) right.appendChild(el('div', 'note', st.pool.message))
    if (st.featured) {
      var pl = btn('Play tonight’s movie: ' + st.featured.title, 'launch', function () { act('launch') }, 'wide primary')
      right.appendChild(pl)
      right.appendChild(btn('Intermission quiz', 'intermission', function () { act('start', { game: 'intermission' }) }, 'wide'))
    }
    var opts = []
    opts.push(btn('Teams: ' + (st.settings.teams ? st.settings.teams : 'Off'), 'teams', function () { act('teams', { teams: st.settings.teams === 0 ? 2 : st.settings.teams >= 4 ? 0 : st.settings.teams + 1 }) }, 'small'))
    if (st.settings.teams) opts.push(btn('Shuffle teams', 'shuffle', function () { act('shuffleTeams') }, 'small'))
    opts.push(btn('Rounds: ' + (st.settings.rounds || 'default'), 'rounds', function () { var c = [0, 3, 5, 8, 10, 15]; var i2 = c.indexOf(st.settings.rounds); act('rounds', { rounds: c[(i2 + 1) % c.length] }) }, 'small'))
    opts.push(btn(st.locked ? 'Room: Locked' : 'Room: Open', 'lock', function () { act('lock', { value: !st.locked }) }, 'small'))
    opts.push(btn(st.qrOnly ? 'Join: QR only' : 'Join: QR or code', 'qronly', function () { act('qrOnly', { value: !st.qrOnly }) }, 'small'))
    opts.push(btn('End Movie Night', 'end', function () { S.dialog = 'end'; render() }, 'small danger'))
    right.appendChild(hostRow(st, opts))
    wrap.appendChild(right)
    return wrap
  }

  function optionTile(o, i, cls, extra) {
    var t = el('div', 'opt ' + (cls || ''))
    t.appendChild(el('span', 'ol', o.id.toUpperCase()))
    var body = el('span', 'ot', o.text)
    if (o.photo) { var im = el('img', 'ph'); im.alt = ''; im.src = o.photo; t.appendChild(im) }
    t.appendChild(body)
    if (extra) t.appendChild(el('span', 'ox', extra))
    return t
  }

  var poster = { cv: null, img: null, src: '', stage: -1 }
  function drawPoster(cv, src, stage) {
    // Stage 0..2: chunky pixels that get finer; stage 3: the whole poster. Nothing moves, so reduced motion changes nothing.
    var cells = [10, 22, 46, 0][Math.max(0, Math.min(3, stage))]
    function paint(im) {
      var w = Math.min(im.naturalWidth || 300, 600), h = Math.round(w * ((im.naturalHeight || 450) / (im.naturalWidth || 300)))
      cv.width = w; cv.height = h
      var c = cv.getContext('2d')
      c.imageSmoothingEnabled = false
      if (!cells) { c.imageSmoothingEnabled = true; c.drawImage(im, 0, 0, w, h); return }
      var sw = cells, sh = Math.max(1, Math.round(cells * h / w))
      var tiny = document.createElement('canvas'); tiny.width = sw; tiny.height = sh
      var tc = tiny.getContext('2d'); tc.imageSmoothingEnabled = true; tc.drawImage(im, 0, 0, sw, sh)
      c.drawImage(tiny, 0, 0, sw, sh, 0, 0, w, h)
    }
    if (poster.img && poster.src === src && poster.img.complete) { paint(poster.img); return }
    var im = new Image()
    im.onload = function () { poster.img = im; poster.src = src; paint(im) }
    im.src = src
  }
  function posterBox(src, stage, pixelate) {
    var box = el('div', 'posterbox')
    if (!src) { box.className += ' none'; box.appendChild(el('div', 'noposter', 'No poster saved for this one')); return box }
    if (pixelate) {
      var cv = el('canvas', 'poster'); cv.setAttribute('role', 'img'); cv.setAttribute('aria-label', 'A movie poster that becomes clearer over time')
      box.appendChild(cv)
      drawPoster(cv, src, stage)
    } else {
      var im = el('img', 'poster'); im.alt = 'Movie poster'; im.src = src; box.appendChild(im)
    }
    return box
  }

  function screenAsk(st) {
    var g = st.game, q = g.question
    var wrap = el('div', 'ask')
    var head = el('div', 'qhead')
    head.appendChild(el('span', 'qnum', g.title + ' · ' + g.index + ' of ' + g.total))
    head.appendChild(el('span', 'answered', 'Answered ' + g.answered + ' of ' + Math.max(g.answered, g.expected)))
    wrap.appendChild(head)
    wrap.appendChild(countdown())
    var body = el('div', 'qbody')
    var left = el('div', 'qleft')
    if (q.type === 'name-that-movie') left.appendChild(posterBox(q.poster, q.stage, true))
    else if (q.type === 'before-after') { /* both posters sit with the options */ }
    else if (q.poster) left.appendChild(posterBox(q.poster, 3, false))
    body.appendChild(left)
    var right = el('div', 'qright')
    right.appendChild(el('div', 'prompt', q.prompt))
    if (q.type === 'name-that-movie') {
      var cl = el('div', 'clues')
      if (!q.clues.length) cl.appendChild(el('div', 'clue dim', 'Clues appear as time runs out…'))
      for (var i = 0; i < q.clues.length; i++) cl.appendChild(el('div', 'clue', (q.clues[i].kind === 'cast' ? 'Starring: ' : q.clues[i].kind === 'year' ? 'Year: ' : '“') + q.clues[i].text + (q.clues[i].kind === 'tagline' ? '”' : '')))
      right.appendChild(cl)
    }
    if (q.type === 'year-guess') {
      right.appendChild(el('div', 'clue', 'Pick a year on your phone: ' + q.min + ' to ' + q.max))
    } else {
      var opts = el('div', 'opts n' + q.options.length + (q.type === 'before-after' ? ' ba' : ''))
      for (var o = 0; o < q.options.length; o++) {
        var tile = optionTile(q.options[o], o, '')
        if (q.type === 'before-after' && q.options[o].poster) { var pim = el('img', 'ph tall'); pim.alt = ''; pim.src = q.options[o].poster; tile.insertBefore(pim, tile.firstChild.nextSibling) }
        opts.appendChild(tile)
      }
      right.appendChild(opts)
    }
    body.appendChild(right)
    wrap.appendChild(body)
    if (g.paused) wrap.appendChild(el('div', 'paused', 'Paused'))
    var controls = [btn('Skip', 'skip', function () { act('skip') }, 'small'), btn(g.paused ? 'Resume' : 'Pause', 'pause', function () { act(g.paused ? 'resume' : 'pause') }, 'small'), btn('End game', 'endgame', function () { act('endGame') }, 'small danger')]
    wrap.appendChild(hostRow(st, controls))
    return wrap
  }

  function nameOf(st, id) { for (var i = 0; i < st.guests.length; i++) if (st.guests[i].id === id) return st.guests[i]; return null }

  function screenReveal(st) {
    var g = st.game, q = g.question
    var wrap = el('div', 'ask reveal')
    var head = el('div', 'qhead')
    head.appendChild(el('span', 'qnum', g.title + ' · ' + g.index + ' of ' + g.total))
    head.appendChild(el('span', 'answered', 'The answer'))
    wrap.appendChild(head)
    var body = el('div', 'qbody')
    var left = el('div', 'qleft')
    if (q.type === 'name-that-movie') left.appendChild(posterBox(q.poster, 3, false))
    else if (q.poster) left.appendChild(posterBox(q.poster, 3, false))
    body.appendChild(left)
    var right = el('div', 'qright')
    right.appendChild(el('div', 'prompt', q.prompt))
    var ans = el('div', 'answer', g.reveal.correctText)
    ans.setAttribute('role', 'status')
    right.appendChild(ans)
    if (q.title && q.type !== 'name-that-movie' && q.type !== 'before-after') right.appendChild(el('div', 'clue dim', q.title + (q.year ? ' (' + q.year + ')' : '')))
    if (q.type === 'name-that-movie' && q.year) right.appendChild(el('div', 'clue dim', String(q.year)))
    if (q.type === 'before-after') {
      var yl = el('div', 'clue dim', ''); var parts = []
      for (var oi = 0; oi < q.options.length; oi++) parts.push(q.options[oi].text + ': ' + q.years[q.options[oi].id])
      yl.textContent = parts.join('   ·   ')
      right.appendChild(yl)
    }
    var res = el('div', 'results')
    var rr = g.reveal.results
    for (var i = 0; i < rr.length; i++) {
      var p = nameOf(st, rr[i].id); if (!p) continue
      var row = el('div', 'res ' + (rr[i].correct ? 'ok' : rr[i].answered ? 'no' : 'skip'))
      row.appendChild(badge(p))
      var mark = rr[i].correct ? '✓ Correct' : rr[i].answered ? (q.type === 'year-guess' ? String(rr[i].value) : '✗ Not this time') : 'No answer'
      if (q.type === 'year-guess' && rr[i].answered) mark = rr[i].value + (rr[i].detail && rr[i].detail.closest ? ' — closest' : '')
      row.appendChild(el('span', 'rmark', mark))
      row.appendChild(el('span', 'rpts', rr[i].points > 0 ? '+' + rr[i].points : '0'))
      res.appendChild(row)
    }
    right.appendChild(res)
    body.appendChild(right)
    wrap.appendChild(body)
    var lb = el('div', 'lb')
    var lbRows = g.reveal.leaderboard
    for (var l = 0; l < lbRows.length; l++) {
      var it = el('div', 'lbrow')
      it.appendChild(el('span', 'rk', '#' + lbRows[l].rank))
      var mini = el('span', 'badge'); mini.style.background = color(lbRows[l].color); mini.appendChild(el('span', 'glyph', lbRows[l].glyph)); mini.appendChild(el('span', 'bn', lbRows[l].name))
      it.appendChild(mini)
      it.appendChild(el('span', 'rpts', String(lbRows[l].points)))
      lb.appendChild(it)
    }
    wrap.appendChild(lb)
    wrap.appendChild(countdown())
    wrap.appendChild(hostRow(st, [btn(g.index >= g.total ? 'Final scores' : 'Next question', 'next', function () { act('next') }, 'primary'), btn('Pause', 'pause', function () { act(g.paused ? 'resume' : 'pause') }, 'small'), btn('End game', 'endgame', function () { act('endGame') }, 'small danger')]))
    return wrap
  }

  function screenVote(st) {
    var g = st.game
    var wrap = el('div', 'vote')
    var head = el('div', 'qhead')
    head.appendChild(el('span', 'qnum', g.title))
    head.appendChild(el('span', 'answered', 'Voted ' + g.voted + ' of ' + Math.max(g.voted, g.expected)))
    wrap.appendChild(head)
    wrap.appendChild(countdown())
    wrap.appendChild(el('div', 'prompt', 'What are we watching? Approve any you would be happy with, and veto one you would not.'))
    var grid = el('div', 'cands n' + g.candidates.length)
    for (var i = 0; i < g.candidates.length; i++) {
      var c = g.candidates[i]
      var tile = el('div', 'cand')
      if (c.poster) { var im = el('img', 'cposter'); im.alt = ''; im.src = c.poster; tile.appendChild(im) } else tile.appendChild(el('div', 'cposter none', ''))
      tile.appendChild(el('div', 'ctitle', c.title))
      tile.appendChild(el('div', 'cyear', (c.year ? String(c.year) : '') + (c.by ? (c.year ? ' · ' : '') + 'from ' + c.by : '')))
      grid.appendChild(tile)
    }
    wrap.appendChild(grid)
    if (g.paused) wrap.appendChild(el('div', 'paused', 'Paused'))
    wrap.appendChild(hostRow(st, [btn('Close the vote now', 'skip', function () { act('skip') }, 'small'), btn(g.paused ? 'Resume' : 'Pause', 'pause', function () { act(g.paused ? 'resume' : 'pause') }, 'small'), btn('Cancel', 'endgame', function () { act('endGame') }, 'small danger')]))
    return wrap
  }

  function methodText(d) {
    if (d.method === 'votes') return 'Most approved'
    if (d.method === 'fewest-vetoes') return 'A tie on approvals: fewest vetoes wins'
    if (d.method === 'draw-no-votes') return 'Nobody voted, so it was drawn at random'
    return 'A tie all the way: drawn fairly at random'
  }
  function screenResult(st) {
    var g = st.game, w = g.winner
    var wrap = el('div', 'result')
    wrap.appendChild(el('div', 'qhead', 'Tonight’s movie'))
    var body = el('div', 'qbody')
    var left = el('div', 'qleft')
    left.appendChild(posterBox(w && w.poster, 3, false))
    body.appendChild(left)
    var right = el('div', 'qright')
    var t = el('div', 'answer', w ? w.title : ''); t.setAttribute('role', 'status'); right.appendChild(t)
    right.appendChild(el('div', 'clue dim', methodText(g.decision)))
    var bars = el('div', 'bars')
    var rows = g.decision.rows
    var max = 1
    for (var r = 0; r < rows.length; r++) max = Math.max(max, rows[r].approvals)
    for (var i = 0; i < g.candidates.length; i++) {
      var row = null
      for (var k = 0; k < rows.length; k++) if (rows[k].key === g.candidates[i].key) row = rows[k]
      var line = el('div', 'barline' + (g.candidates[i].key === g.decision.winner ? ' win' : ''))
      line.appendChild(el('span', 'bl', g.candidates[i].title))
      var track = el('span', 'track'); var fill = el('span', 'fill2'); fill.style.width = Math.round(100 * (row ? row.approvals : 0) / max) + '%'; track.appendChild(fill)
      line.appendChild(track)
      line.appendChild(el('span', 'bv', (row ? row.approvals : 0) + ' yes' + (row && row.vetoes ? ', ' + row.vetoes + ' veto' + (row.vetoes > 1 ? 'es' : '') : '') + (row && row.out ? ' (out)' : '')))
      bars.appendChild(line)
    }
    right.appendChild(bars)
    body.appendChild(right)
    wrap.appendChild(body)
    wrap.appendChild(hostRow(st, [btn('Play it', 'launch', function () { act('launch') }, 'primary'), btn('Vote again', 'again', function () { act('start', { game: 'pick-tonight' }) }, 'small'), btn('Back to games', 'lobby', function () { act('lobby') }, 'small')]))
    return wrap
  }

  function screenScoreboard(st) {
    var sb = st.scoreboard
    var wrap = el('div', 'board')
    wrap.appendChild(el('div', 'h1', sb.title + ' — final scores'))
    var top = sb.rows.length ? sb.rows[0] : null
    if (top && top.points > 0) {
      var w = el('div', 'winner', (top.rank === 1 && sb.rows.length > 1 && sb.rows[1].rank === 1 ? 'A tie at the top! ' : 'Winner: ') + top.name); w.setAttribute('role', 'status'); wrap.appendChild(w)
    }
    var cols = el('div', 'cols')
    var list = el('div', 'rank' + (sb.rows.length > 6 ? ' two' : ''))
    for (var i = 0; i < sb.rows.length; i++) {
      var r = sb.rows[i]
      var row = el('div', 'lbrow big' + (r.rank === 1 && r.points > 0 ? ' first' : ''))
      row.appendChild(el('span', 'rk', '#' + r.rank))
      var b = el('span', 'badge'); b.style.background = color(r.color); b.appendChild(el('span', 'glyph', r.glyph)); b.appendChild(el('span', 'bn', r.name))
      row.appendChild(b)
      row.appendChild(el('span', 'rpts', r.points + ' pts'))
      row.appendChild(el('span', 'tot', 'tonight ' + r.total))
      list.appendChild(row)
    }
    cols.appendChild(list)
    if (sb.teams) {
      var tl = el('div', 'teams')
      tl.appendChild(el('div', 'h3', 'Teams (average per player)'))
      for (var t = 0; t < sb.teams.length; t++) {
        var tr = el('div', 'teamrow'); tr.style.borderColor = color(sb.teams[t].color)
        tr.appendChild(el('span', 'rk', '#' + sb.teams[t].rank))
        tr.appendChild(el('span', 'tn', sb.teams[t].name))
        tr.appendChild(el('span', 'rpts', sb.teams[t].score + ' pts'))
        tl.appendChild(tr)
      }
      cols.appendChild(tl)
    }
    wrap.appendChild(cols)
    var items = [btn('Back to games', 'lobby', function () { act('lobby') }, 'primary')]
    if (st.featured) items.push(btn('Play tonight’s movie', 'launch', function () { act('launch') }, ''))
    wrap.appendChild(hostRow(st, items))
    return wrap
  }

  function screenMessage(title, text, buttons) {
    var wrap = el('div', 'msg')
    wrap.appendChild(el('div', 'h1', title))
    if (text) wrap.appendChild(el('div', 'hint', text))
    var row = el('div', 'hostrow')
    for (var i = 0; i < buttons.length; i++) row.appendChild(buttons[i])
    wrap.appendChild(row)
    return wrap
  }

  function dialogBox(st) {
    var d = el('div', 'dialog'); d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true')
    var card = el('div', 'card')
    card.appendChild(el('div', 'h2', 'End Movie Night?'))
    card.appendChild(el('div', 'hint', 'Ending closes the room for everyone and scores are not kept. Leaving keeps it going.'))
    var row = el('div', 'hostrow')
    row.appendChild(btn('Keep going', 'dlg-stay', function () { S.dialog = ''; render() }, 'primary'))
    row.appendChild(btn('End it', 'dlg-end', function () { act('close').then(function () { closedScreen('ended_by_host') }) }, 'danger'))
    // Leave this screen but keep the room going (phones stay connected; open /tv again on this TV to come back to it).
    row.appendChild(btn('Leave, keep the room', 'dlg-leave', function () { if (history.length > 1) history.back(); else location.replace('/') }, ''))
    card.appendChild(row)
    d.appendChild(card)
    return d
  }

  // ---- render + focus -------------------------------------------------------------------------------------------------
  function closedScreen(reason) {
    S.ended = true
    if (S.es) { try { S.es.close() } catch (e) { /* ignore */ } S.es = null }
    clearTimeout(S.pollTimer)
    sset('mn.tv', null)
    S.st = null
    S.dialog = ''
    clear(root)
    root.appendChild(screenMessage('Movie Night is over', reason === 'ended_by_host' ? 'Thanks for playing.' : 'The room was closed.', [
      btn('Start a new Movie Night', 'again', function () { location.replace(location.pathname) }, 'primary')
    ]))
    focusFirst()
  }
  function focusables() {
    var list = root.querySelectorAll('.btn')
    var out = []
    for (var i = 0; i < list.length; i++) { var r = list[i].getBoundingClientRect(); if (r.width > 0 && r.height > 0) out.push(list[i]) }
    return out
  }
  function focusFirst() {
    var list = focusables(), pick = null
    var dlg = root.querySelector('.dialog .btn')
    if (dlg) pick = dlg
    else if (S.focusId) for (var i = 0; i < list.length; i++) if (list[i].getAttribute('data-fid') === S.focusId) pick = list[i]
    if (!pick) pick = root.querySelector('.btn.primary') || list[0] || null
    if (pick) { try { pick.focus() } catch (e) { /* ignore */ } }
  }
  function render() {
    var st = S.st
    if (S.ended) return
    clear(root)
    root.className = 'app' + (st ? ' ph-' + st.phase : '')
    if (S.err && !st) {
      root.appendChild(screenMessage('Movie Night', S.err, [btn('Try again', 'retry', function () { S.err = ''; boot() }, 'primary')].concat(S.needSignIn ? [btn('Sign in', 'signin', function () { location.href = '/login' }, '')] : [])))
      root.appendChild(toastBox); root.appendChild(floatBox)
      focusFirst(); return
    }
    if (!st) { root.appendChild(el('div', 'loading', 'Starting Movie Night…')); root.appendChild(toastBox); return }
    root.appendChild(topbar(st))
    var main = el('div', 'main')
    var g = st.game
    if (st.phase === 'lobby') main.appendChild(screenLobby(st))
    else if (st.phase === 'scoreboard' && st.scoreboard) main.appendChild(screenLobbyBoard(st))
    else if (st.phase === 'result' && g) main.appendChild(screenResult(st))
    else if (g && g.kind === 'vote') main.appendChild(screenVote(st))
    else if (g && g.kind === 'quiz') main.appendChild(g.phase === 'reveal' ? screenReveal(st) : screenAsk(st))
    else main.appendChild(screenLobby(st))
    root.appendChild(main)
    root.appendChild(footer(st))
    if (S.dialog === 'end') root.appendChild(dialogBox(st))
    if (st.paused) { /* the game screens show their own "Paused" banner */ }
    root.appendChild(toastBox)
    root.appendChild(floatBox)
    focusFirst()
    tick()
  }
  function screenLobbyBoard(st) { return screenScoreboard(st) }

  function tick() {
    var st = S.st
    if (!st || !st.game) return
    var g = st.game
    var fill = document.getElementById('cdFill'), num = document.getElementById('cdNum')
    if (!fill || !num) return
    var total = g.kind === 'vote' ? 60000 : g.phase === 'reveal' ? 6000 : (g.question && g.question.timeMs) || 20000
    var left = g.paused ? g.remainingMs : Math.max(0, (g.deadline || 0) - now())
    fill.style.width = Math.max(0, Math.min(100, (100 * left) / total)) + '%'
    num.textContent = Math.ceil(left / 1000) + 's'
    if (!g.paused && g.phase === 'ask' && left < 5100 && left > 0) {
      var sec = Math.ceil(left / 1000)
      if (S.tickAt !== sec) { S.tickAt = sec; sfx('tick') }
    }
  }

  // ---- D-pad / remote keys --------------------------------------------------------------------------------------------
  function moveFocus(dir) {
    var list = focusables()
    var cur = document.activeElement
    if (!cur || cur.className.indexOf('btn') < 0) { focusFirst(); return }
    var a = cur.getBoundingClientRect()
    var ax = a.left + a.width / 2, ay = a.top + a.height / 2
    var best = null, bestScore = 1e12
    for (var i = 0; i < list.length; i++) {
      if (list[i] === cur) continue
      var r = list[i].getBoundingClientRect()
      var bx = r.left + r.width / 2, by = r.top + r.height / 2
      var dx = bx - ax, dy = by - ay
      var main = dir === 'left' ? -dx : dir === 'right' ? dx : dir === 'up' ? -dy : dy
      if (main <= 2) continue
      var side = (dir === 'left' || dir === 'right') ? Math.abs(dy) : Math.abs(dx)
      var score = main + side * 2.5
      if (score < bestScore) { bestScore = score; best = list[i] }
    }
    if (best) { best.focus(); S.focusId = best.getAttribute('data-fid') || ''; try { best.scrollIntoView({ block: 'nearest' }) } catch (e) { /* ignore */ } }
  }
  var KEYS = { 37: 'left', 38: 'up', 39: 'right', 40: 'down' }
  document.addEventListener('keydown', function (e) {
    var k = e.keyCode
    if (KEYS[k]) { e.preventDefault(); moveFocus(KEYS[k]); return }
    if (k === 8 || k === 27 || k === 10009 || k === 461 || k === 166 || e.key === 'BrowserBack' || e.key === 'GoBack') {
      e.preventDefault()
      if (S.ended || !S.st) { try { history.back() } catch (x) { /* ignore */ } return }
      S.dialog = S.dialog ? '' : 'end'
      render()
      return
    }
    if (k === 83 && !e.ctrlKey && !e.metaKey) { setSound(!S.sound); return }
    if (k === 415 || k === 13) { /* OK / Enter on a focused button clicks it natively */ }
  })
  document.addEventListener('focusin', function (e) { var t = e.target; if (t && t.getAttribute && t.getAttribute('data-fid')) S.focusId = t.getAttribute('data-fid') })
  // On a TV the pointer is a remote: keep a focused button under it.
  document.addEventListener('click', function () { if (S.audio === null && S.sound) ctxAudio() })

  // ---- talking to the server -----------------------------------------------------------------------------------------
  function onState(st) {
    var prev = S.st
    S.offset = (typeof st.now === 'number' ? st.now : Date.now()) - Date.now()
    S.st = st
    S.loading = false
    S.err = ''
    // sounds and one-shot effects from what changed
    if (prev) {
      if (st.guests.length > prev.guests.length) sfx('join')
      var pg = prev.game, ng = st.game
      if (ng && pg && ng.kind === 'quiz') {
        if (pg.phase === 'ask' && ng.phase === 'reveal') { var any = false; for (var i = 0; i < ng.reveal.results.length; i++) if (ng.reveal.results[i].correct) any = true; sfx(any ? 'good' : 'reveal') }
        else if (ng.index !== pg.index) sfx('next')
      }
      if (ng && !pg) sfx('next')
      if (st.phase === 'scoreboard' && prev.phase !== 'scoreboard') sfx('fanfare')
      if (st.phase === 'result' && prev.phase !== 'result') sfx('fanfare')
    }
    if (!prev || st.code !== prev.code || !S.info) loadInfo()
    render()
  }
  function loadInfo() {
    if (!S.ticket) return
    req('GET', '/tv/info?ticket=' + enc(S.ticket)).then(function (r) { if (r && r.ok) { S.info = r; render() } })
  }
  function connect() {
    if (S.es) { try { S.es.close() } catch (e) { /* ignore */ } S.es = null }
    if (!window.EventSource || S.esFails >= 4) { startPolling(); return }
    var es = new EventSource(API + '/events?ticket=' + enc(S.ticket))
    S.es = es
    es.addEventListener('state', function (m) { S.esFails = 0; try { onState(JSON.parse(m.data)) } catch (e) { /* ignore a bad frame */ } })
    es.addEventListener('reaction', function (m) { try { showReaction(JSON.parse(m.data)) } catch (e) { /* ignore */ } })
    es.addEventListener('launch', function (m) {
      try {
        var d = JSON.parse(m.data)
        if (d && typeof d.href === 'string' && d.href.charAt(0) === '/' && d.href.charAt(1) !== '/' && d.n !== S.seenLaunch) {
          S.seenLaunch = d.n
          var ov = S.st && S.st.overlayTicket ? '#mn=' + S.st.overlayTicket : ''
          location.href = d.href + ov
        }
      } catch (e) { /* ignore */ }
    })
    es.addEventListener('closed', function (m) { var r = ''; try { r = JSON.parse(m.data).reason } catch (e) { r = '' } closedScreen(r) })
    es.onerror = function () {
      S.esFails++
      if (S.esFails >= 4) { try { es.close() } catch (e) { /* ignore */ } startPolling() }
      else if (es.readyState === 2) { setTimeout(connect, 1500) }
    }
  }
  function startPolling() {
    clearTimeout(S.pollTimer)
    var last = -1
    function once() {
      if (S.ended) return
      req('GET', '/poll?ticket=' + enc(S.ticket) + '&since=' + last).then(function (r) {
        if (r && r.ok) { last = r.seq; if (r.changed) onState(r.state) }
        else if (r && r.error === 'not_found') { closedScreen('gone'); return }
        S.pollTimer = setTimeout(once, 1000)
      })
    }
    once()
  }

  function boot() {
    S.loading = true
    render()
    var fromHash = ''
    var m = /(?:^#|&)k=([A-Za-z0-9_-]{32})(?:&|$)/.exec(location.hash || '')
    if (m) { fromHash = m[1]; try { history.replaceState(null, '', location.pathname) } catch (e) { /* ignore */ } }
    var have = fromHash || sget('mn.tv')
    function start(ticket) {
      S.ticket = ticket; sset('mn.tv', ticket)
      connect()
    }
    if (have) {
      // Is it still a live room? If not, make a new one.
      req('GET', '/poll?ticket=' + enc(have)).then(function (r) {
        if (r && r.ok) start(have)
        else { sset('mn.tv', null); create() }
      })
      return
    }
    create()
  }
  function create() {
    req('POST', '/tv/create', {}).then(function (r) {
      if (r && r.ok && r.ticket) { S.ticket = r.ticket; sset('mn.tv', r.ticket); connect(); return }
      S.needSignIn = !!(r && r.error === 'sign_in_needed')
      S.err = (r && r.message) || 'Could not start Movie Night.'
      render()
    })
  }

  S.sound = lget('mn.sound') === '1' || (lget('mn.sound') === '' && !!CFG.sounds)
  setInterval(tick, 200)
  boot()
}

// ---------------------------------------------------------------------------------------------------------------------------

function movieNightGuestClient(CFG) {
  'use strict'
  var API = CFG.api
  var enc = encodeURIComponent
  var root = document.getElementById('app')
  var HEX = /^#[0-9a-fA-F]{6}$/
  var S = { code: CFG.code || '', key: CFG.key || '', ticket: '', st: null, es: null, esFails: 0, pollTimer: 0, offset: 0, ended: false, colors: [], colorId: '', busy: false, msg: '', open: false, year: null, yearFor: '', suggest: [], sug: '', reactOpen: false, joined: false, endedReason: '' }

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = String(text); return e }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild) }
  function sget(k) { try { return sessionStorage.getItem(k) || '' } catch (e) { return '' } }
  function sset(k, v) { try { if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v) } catch (e) { /* ignore */ } }
  function lget(k) { try { return localStorage.getItem(k) || '' } catch (e) { return '' } }
  function lset(k, v) { try { localStorage.setItem(k, v) } catch (e) { /* ignore */ } }
  function color(c) { return HEX.test(String(c)) ? c : '#cccccc' }
  function now() { return Date.now() + S.offset }
  function req(method, path, body) {
    var o = { method: method, credentials: 'same-origin', cache: 'no-store', headers: {} }
    if (body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body) }
    return fetch(API + path, o).then(function (r) { return r.json().catch(function () { return { ok: false, error: 'bad_reply' } }) }, function () { return { ok: false, error: 'network', message: 'Could not reach the server. Are you on the same Wi-Fi?' } })
  }
  function act(type, extra) {
    var b = { ticket: S.ticket, type: type }
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) b[k] = extra[k]
    return req('POST', '/act', b).then(function (r) { if (r && r.ok === false) say(r.message || 'That did not work.'); return r })
  }
  var live = el('div', 'live'); live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite')
  function say(msg) { S.msg = String(msg || ''); live.textContent = S.msg }
  function buzz(ms) { try { if (navigator.vibrate) navigator.vibrate(ms) } catch (e) { /* ignore */ } }

  function chip(g) {
    var c = el('span', 'chip'); c.style.background = color(g.color)
    c.appendChild(el('span', 'gl', g.glyph)); c.appendChild(el('span', '', g.name))
    return c
  }
  function button(label, fn, cls) { var b = el('button', 'b' + (cls ? ' ' + cls : ''), label); b.type = 'button'; b.onclick = fn; return b }

  // ---- joining ------------------------------------------------------------------------------------------------------
  function screenJoin() {
    var wrap = el('div', 'card')
    wrap.appendChild(el('h1', '', 'Join Movie Night'))
    var codeRow = null, codeIn = null
    if (!CFG.code) {
      codeRow = el('div', 'field'); codeRow.appendChild(el('label', '', 'Room code'))
      codeIn = el('input', 'in'); codeIn.type = 'text'; codeIn.maxLength = 6; codeIn.autocapitalize = 'characters'; codeIn.autocomplete = 'off'; codeIn.setAttribute('inputmode', 'text'); codeIn.id = 'code'
      codeRow.firstChild.setAttribute('for', 'code'); codeRow.appendChild(codeIn); wrap.appendChild(codeRow)
    } else {
      wrap.appendChild(el('p', 'sub', 'Room ' + CFG.code))
    }
    var nameRow = el('div', 'field'); var lab = el('label', '', 'Your nickname'); lab.setAttribute('for', 'nick'); nameRow.appendChild(lab)
    var nick = el('input', 'in'); nick.type = 'text'; nick.id = 'nick'; nick.maxLength = 16; nick.autocomplete = 'off'; nick.value = lget('mn.nick'); nameRow.appendChild(nick); wrap.appendChild(nameRow)
    wrap.appendChild(el('p', 'sub', 'Pick a colour'))
    var pal = el('div', 'palette'); pal.setAttribute('role', 'radiogroup'); pal.setAttribute('aria-label', 'Colour')
    var colors = S.colors.length ? S.colors : defaultColors()
    for (var i = 0; i < colors.length; i++) {
      (function (c) {
        var sw = el('button', 'sw' + (S.colorId === c.id ? ' on' : '') + (c.taken ? ' taken' : ''))
        sw.type = 'button'; sw.style.background = color(c.hex); sw.disabled = !!c.taken
        sw.setAttribute('role', 'radio'); sw.setAttribute('aria-checked', S.colorId === c.id ? 'true' : 'false'); sw.setAttribute('aria-label', c.name + ' ' + (c.taken ? '(taken)' : ''))
        sw.appendChild(el('span', 'glyph', c.glyph))
        sw.onclick = function () { S.colorId = c.id; renderJoin() }
        pal.appendChild(sw)
      })(colors[i])
    }
    wrap.appendChild(pal)
    var go = button('Join', function () {
      if (S.busy) return
      var name = (nick.value || '').replace(/^\s+|\s+$/g, '')
      if (!name) { say('Type a nickname first.'); nick.focus(); return }
      var code = CFG.code || (codeIn.value || '').toUpperCase().replace(/[\s-]/g, '')
      if (!code) { say('Type the room code shown on the TV.'); return }
      S.busy = true; say('Joining…'); go.disabled = true
      req('POST', '/join', { code: code, key: CFG.key || '', name: name, colorId: S.colorId }).then(function (r) {
        S.busy = false
        if (r && r.ok) { lset('mn.nick', name); S.code = code; S.ticket = r.ticket; sset('mn.g', r.ticket); S.joined = true; say(''); connect() }
        else { go.disabled = false; say((r && r.message) || 'Could not join.') }
      })
    }, 'primary'); go.id = 'go'
    wrap.appendChild(go)
    wrap.appendChild(live)
    wrap.appendChild(el('p', 'fine', 'No account needed. Only your nickname is shared with the room, and nothing is saved after the night ends.'))
    return wrap
  }
  function defaultColors() {
    return [['coral', 'Coral', '#ff6b6b', '●'], ['orange', 'Orange', '#ffa94d', '■'], ['yellow', 'Yellow', '#ffe066', '▲'], ['lime', 'Lime', '#a9e34b', '◆'], ['mint', 'Mint', '#38d9a9', '★'], ['cyan', 'Cyan', '#22b8cf', '✚'],
      ['sky', 'Sky', '#4dabf7', '▼'], ['indigo', 'Indigo', '#748ffc', '♥'], ['violet', 'Violet', '#da77f2', '♣'], ['pink', 'Pink', '#f783ac', '♠'], ['white', 'White', '#f1f3f5', '⬢'], ['silver', 'Silver', '#adb5bd', '☾']].map(function (a) { return { id: a[0], name: a[1], hex: a[2], glyph: a[3], taken: false } })
  }
  function renderJoin() {
    var keep = document.getElementById('nick') ? document.getElementById('nick').value : ''
    var keepCode = document.getElementById('code') ? document.getElementById('code').value : ''
    clear(root); root.appendChild(screenJoin())
    if (keep) document.getElementById('nick').value = keep
    if (keepCode && document.getElementById('code')) document.getElementById('code').value = keepCode
  }

  // ---- playing ---------------------------------------------------------------------------------------------------------
  function header(st) {
    var me = st.me
    var h = el('div', 'hdr')
    var c = chip(me); h.appendChild(c)
    if (me.host) h.appendChild(el('span', 'tag', 'HOST'))
    if (st.settings.teams && me.team !== null) { var t = el('span', 'tag team', st.teams ? st.teams[me.team].name : 'Team'); h.appendChild(t) }
    h.appendChild(el('span', 'pts', me.total + ' pts'))
    return h
  }
  function timerBar(g) {
    var box = el('div', 'tbar'); var fill = el('div', 'tfill'); fill.id = 'tf'; box.appendChild(fill); return box
  }
  function tickBar() {
    var g = S.st && S.st.game
    var f = document.getElementById('tf')
    if (!g || !f) return
    var total = g.kind === 'vote' ? 60000 : g.phase === 'reveal' ? 6000 : (g.question && g.question.timeMs) || 20000
    var left = g.paused ? g.remainingMs : Math.max(0, (g.deadline || 0) - now())
    f.style.width = Math.max(0, Math.min(100, 100 * left / total)) + '%'
  }

  function screenAsk(st) {
    var g = st.game, q = g.question, wrap = el('div', 'stack')
    wrap.appendChild(el('div', 'meta', g.title + ' · ' + g.index + '/' + g.total))
    wrap.appendChild(timerBar(g))
    wrap.appendChild(el('div', 'prompt', q.prompt))
    if (g.paused) wrap.appendChild(el('div', 'note', 'Paused by the host'))
    var mine = g.mine
    if (mine && mine.answered) {
      var done = el('div', 'locked', 'Locked in!')
      wrap.appendChild(done)
      if (q.type !== 'year-guess') {
        for (var i = 0; i < q.options.length; i++) if (q.options[i].id === mine.value) wrap.appendChild(el('div', 'yours', 'Your answer: ' + q.options[i].id.toUpperCase() + ' — ' + q.options[i].text))
      } else wrap.appendChild(el('div', 'yours', 'Your answer: ' + mine.value))
      wrap.appendChild(el('div', 'sub', g.answered + ' of ' + Math.max(g.answered, g.expected) + ' have answered'))
      return wrap
    }
    if (q.type === 'year-guess') {
      if (S.yearFor !== q.id) { S.yearFor = q.id; S.year = Math.round((q.min + q.max) / 2) }
      var big = el('div', 'yearbig', String(S.year)); big.id = 'yb'
      wrap.appendChild(big)
      var row = el('div', 'yrow')
      row.appendChild(button('−5', function () { setYear(q, S.year - 5) }, 'step'))
      row.appendChild(button('−1', function () { setYear(q, S.year - 1) }, 'step'))
      row.appendChild(button('+1', function () { setYear(q, S.year + 1) }, 'step'))
      row.appendChild(button('+5', function () { setYear(q, S.year + 5) }, 'step'))
      wrap.appendChild(row)
      var rg = el('input', 'range'); rg.type = 'range'; rg.min = q.min; rg.max = q.max; rg.step = 1; rg.value = S.year; rg.id = 'yr'; rg.setAttribute('aria-label', 'Year')
      rg.oninput = function () { setYear(q, parseInt(rg.value, 10)) }
      hold(rg)
      wrap.appendChild(rg)
      wrap.appendChild(button('Lock in ' + S.year, function () { buzz(30); act('answer', { value: S.year }) }, 'primary big'))
      return wrap
    }
    var opts = el('div', 'options')
    for (var o = 0; o < q.options.length; o++) {
      (function (opt) {
        var b = el('button', 'opt'); b.type = 'button'
        b.appendChild(el('span', 'ol', opt.id.toUpperCase()))
        b.appendChild(el('span', 'ot', opt.text))
        b.onclick = function () { buzz(30); b.disabled = true; act('answer', { value: opt.id }) }
        opts.appendChild(b)
      })(q.options[o])
    }
    wrap.appendChild(opts)
    return wrap
  }
  function setYear(q, y) {
    S.year = Math.max(q.min, Math.min(q.max, y))
    var b = document.getElementById('yb'); if (b) b.textContent = String(S.year)
    var r = document.getElementById('yr'); if (r) r.value = S.year
    var g = root.querySelector('.b.primary.big'); if (g) g.textContent = 'Lock in ' + S.year
    if (g) g.onclick = function () { buzz(30); act('answer', { value: S.year }) }
  }

  function screenReveal(st) {
    var g = st.game, q = g.question, wrap = el('div', 'stack')
    wrap.appendChild(el('div', 'meta', g.title + ' · ' + g.index + '/' + g.total))
    wrap.appendChild(el('div', 'prompt', q.prompt))
    var res = g.mine && g.mine.result
    var line = res && res.answered ? (res.correct ? 'Correct! +' + res.points : q.type === 'year-guess' ? 'You said ' + res.value + '. +' + res.points : 'Not this time') : 'No answer this time'
    var v = el('div', 'verdict ' + (res && res.correct ? 'ok' : 'no'), line); v.setAttribute('role', 'status'); wrap.appendChild(v)
    wrap.appendChild(el('div', 'answerline', 'The answer: ' + g.reveal.correctText))
    var lb = el('div', 'lb')
    var rows = g.reveal.leaderboard
    for (var i = 0; i < rows.length; i++) {
      var r = el('div', 'lbr' + (rows[i].id === st.me.id ? ' me' : ''))
      r.appendChild(el('span', 'rk', '#' + rows[i].rank))
      var c = el('span', 'chip'); c.style.background = color(rows[i].color); c.appendChild(el('span', 'gl', rows[i].glyph)); c.appendChild(el('span', '', rows[i].name)); r.appendChild(c)
      r.appendChild(el('span', 'rp', String(rows[i].points)))
      lb.appendChild(r)
    }
    wrap.appendChild(lb)
    return wrap
  }

  function ballotSend(done) {
    var chosen = [], veto = ''
    var cs = S.st.game.candidates
    for (var i = 0; i < cs.length; i++) { if (S.ballot[cs[i].key] === 'yes') chosen.push(cs[i].key); if (S.ballot[cs[i].key] === 'veto') veto = cs[i].key }
    return act('vote', { approve: chosen, veto: veto || null, done: done === true })
  }
  function screenVote(st) {
    var g = st.game, wrap = el('div', 'stack')
    wrap.appendChild(el('div', 'meta', g.title))
    wrap.appendChild(timerBar(g))
    wrap.appendChild(el('div', 'prompt', 'Tap Yes on every film you would be happy to watch. You get one Veto.'))
    var mine = g.mine && g.mine.ballot
    if (!S.ballot || S.ballotRoom !== st.code) { S.ballot = {}; S.ballotRoom = st.code }
    if (mine && !S.ballotTouched) { S.ballot = {}; for (var a = 0; a < mine.approve.length; a++) S.ballot[mine.approve[a]] = 'yes'; if (mine.veto) S.ballot[mine.veto] = 'veto' }
    var list = el('div', 'cands')
    for (var i = 0; i < g.candidates.length; i++) {
      (function (c) {
        var row = el('div', 'cand')
        row.appendChild(el('div', 'ct', c.title + (c.year ? ' (' + c.year + ')' : '')))
        var st2 = S.ballot[c.key]
        var yes = button(st2 === 'yes' ? '✓ Yes' : 'Yes', function () { S.ballotTouched = true; S.ballot[c.key] = st2 === 'yes' ? '' : 'yes'; ballotSend(false); renderGame() }, 'yes' + (st2 === 'yes' ? ' on' : ''))
        var vt = button(st2 === 'veto' ? '✗ Vetoed' : 'Veto', function () {
          S.ballotTouched = true
          var keys = Object.keys(S.ballot); for (var z = 0; z < keys.length; z++) if (S.ballot[keys[z]] === 'veto') S.ballot[keys[z]] = ''
          S.ballot[c.key] = st2 === 'veto' ? '' : 'veto'; ballotSend(false); renderGame()
        }, 'veto' + (st2 === 'veto' ? ' on' : ''))
        var acts = el('div', 'vact'); acts.appendChild(yes); acts.appendChild(vt); row.appendChild(acts)
        list.appendChild(row)
      })(g.candidates[i])
    }
    wrap.appendChild(list)
    var isDone = !!(mine && mine.done)
    wrap.appendChild(button(isDone ? '✓ Vote sent (change anything to edit it)' : 'Send my vote', function () { S.ballotTouched = true; ballotSend(true).then(function () { say('Vote sent.') }) }, 'primary big' + (isDone ? ' sent' : '')))
    wrap.appendChild(el('div', 'sub', g.voted + ' of ' + Math.max(g.voted, g.expected) + ' have sent their vote'))
    if (st.settings.allowSuggestions) wrap.appendChild(suggestBox(st))
    return wrap
  }

  function screenResult(st) {
    var g = st.game, wrap = el('div', 'stack')
    wrap.appendChild(el('div', 'meta', 'The group has chosen'))
    var t = el('div', 'verdict ok', g.winner ? g.winner.title : ''); t.setAttribute('role', 'status'); wrap.appendChild(t)
    wrap.appendChild(el('div', 'sub', g.decision.method === 'votes' ? 'Most approved' : g.decision.method === 'fewest-vetoes' ? 'Tie on approvals: fewest vetoes wins' : 'A tie all the way: drawn fairly at random'))
    return wrap
  }
  function screenBoard(st) {
    var sb = st.scoreboard, wrap = el('div', 'stack')
    wrap.appendChild(el('div', 'meta', sb.title + ' — final'))
    var lb = el('div', 'lb')
    for (var i = 0; i < sb.rows.length; i++) {
      var r = el('div', 'lbr' + (sb.rows[i].id === st.me.id ? ' me' : ''))
      r.appendChild(el('span', 'rk', '#' + sb.rows[i].rank))
      var c = el('span', 'chip'); c.style.background = color(sb.rows[i].color); c.appendChild(el('span', 'gl', sb.rows[i].glyph)); c.appendChild(el('span', '', sb.rows[i].name)); r.appendChild(c)
      r.appendChild(el('span', 'rp', sb.rows[i].points + ' pts'))
      lb.appendChild(r)
    }
    wrap.appendChild(lb)
    if (sb.teams) for (var t = 0; t < sb.teams.length; t++) wrap.appendChild(el('div', 'sub', '#' + sb.teams[t].rank + ' ' + sb.teams[t].name + ': ' + sb.teams[t].score + ' pts'))
    return wrap
  }

  function suggestBox(st) {
    var box = el('div', 'suggest')
    box.appendChild(el('div', 'meta', 'Suggest a movie'))
    var inp = el('input', 'in'); inp.type = 'search'; inp.placeholder = 'Search the library…'; inp.value = S.sug; inp.setAttribute('aria-label', 'Search the library'); inp.autocomplete = 'off'; inp.maxLength = 40
    var timer = 0
    hold(inp)
    inp.oninput = function () {
      S.sug = inp.value; clearTimeout(timer)
      timer = setTimeout(function () {
        if (S.sug.length < 2) { S.suggest = []; renderSuggest(list); return }
        req('GET', '/search?ticket=' + enc(S.ticket) + '&q=' + enc(S.sug)).then(function (r) { S.suggest = r && r.ok ? r.results : []; renderSuggest(list) })
      }, 300)
    }
    box.appendChild(inp)
    var list = el('div', 'slist'); box.appendChild(list)
    renderSuggest(list)
    return box
  }
  function renderSuggest(list) {
    clear(list)
    for (var i = 0; i < S.suggest.length; i++) {
      (function (m) {
        var b = button(m.title + (m.year ? ' (' + m.year + ')' : ''), function () { act('suggest', { key: m.key }).then(function (r) { if (r && r.ok) { say('Suggested: ' + m.title); S.suggest = []; S.sug = ''; renderGame() } }) }, 'sug')
        list.appendChild(b)
      })(S.suggest[i])
    }
  }

  function hostPanel(st) {
    var d = el('details', 'host'); d.open = S.open
    d.ontoggle = function () { S.open = d.open }
    d.appendChild(el('summary', '', 'Host controls'))
    var p = el('div', 'hp')
    var ph = st.phase
    if (ph === 'lobby' || ph === 'scoreboard') {
      var menu = st.menu || []
      for (var i = 0; i < menu.length; i++) {
        (function (m) {
          var b = button(m.title, function () { act('start', { game: m.id }) }, 'hb' + (m.ready ? '' : ' off')); b.disabled = !m.ready
          p.appendChild(b)
          if (!m.ready) p.appendChild(el('div', 'fine', 'Needs ' + m.why))
        })(menu[i])
      }
      if (st.featured) { p.appendChild(button('Play: ' + st.featured.title, function () { act('launch') }, 'hb')); p.appendChild(button('Intermission quiz', function () { act('start', { game: 'intermission' }) }, 'hb')) }
      if (ph === 'scoreboard') p.appendChild(button('Back to games', function () { act('lobby') }, 'hb'))
      p.appendChild(button('Teams: ' + (st.settings.teams || 'Off'), function () { act('teams', { teams: st.settings.teams === 0 ? 2 : st.settings.teams >= 4 ? 0 : st.settings.teams + 1 }) }, 'hb'))
      p.appendChild(button(st.locked ? 'Unlock room' : 'Lock room', function () { act('lock', { value: !st.locked }) }, 'hb'))
    } else {
      p.appendChild(button('Skip / next', function () { act('skip') }, 'hb'))
      p.appendChild(button(st.paused ? 'Resume' : 'Pause', function () { act(st.paused ? 'resume' : 'pause') }, 'hb'))
      p.appendChild(button('End game', function () { act('endGame') }, 'hb'))
      if (ph === 'result') { p.appendChild(button('Play it', function () { act('launch') }, 'hb')); p.appendChild(button('Back to games', function () { act('lobby') }, 'hb')) }
    }
    p.appendChild(el('div', 'meta', 'Players'))
    for (var g = 0; g < st.guests.length; g++) {
      (function (gu) {
        var row = el('div', 'prow'); row.appendChild(chip(gu))
        if (gu.id !== st.me.id) {
          row.appendChild(button('Make host', function () { act('makeHost', { target: gu.id }) }, 'mini'))
          row.appendChild(button('Remove', function () { act('kick', { target: gu.id }) }, 'mini danger'))
        }
        p.appendChild(row)
      })(st.guests[g])
    }
    p.appendChild(button('End Movie Night for everyone', function () { if (window.confirm('End Movie Night for everyone?')) act('close') }, 'hb danger'))
    d.appendChild(p)
    return d
  }
  function reactBar(st) {
    var bar = el('div', 'reacts'); bar.setAttribute('role', 'group'); bar.setAttribute('aria-label', 'Reactions')
    var list = st.reactions || []
    for (var i = 0; i < list.length; i++) {
      (function (e) { var b = el('button', 'rx', e); b.type = 'button'; b.setAttribute('aria-label', 'React ' + e); b.onclick = function () { buzz(15); act('react', { emoji: e }) }; bar.appendChild(b) })(list[i])
    }
    return bar
  }

  // While someone is typing a search or dragging the year slider, a redraw would throw their input away:
  // hold the redraw until they let go, unless the game has moved on to a new question or phase.
  function hold(input) {
    function on() { S.typing = true }
    function off() { S.typing = false; if (S.dirty) { S.dirty = false; renderGame() } }
    input.addEventListener('focus', on); input.addEventListener('touchstart', on); input.addEventListener('mousedown', on)
    input.addEventListener('blur', off); input.addEventListener('touchend', off); input.addEventListener('mouseup', off); input.addEventListener('touchcancel', off)
  }
  function stateKey(st) { return st.phase + ':' + (st.game ? st.game.type + ':' + st.game.phase + ':' + (st.game.index || 0) : '') }
  function renderGame() {
    var st = S.st
    if (!st || S.ended) return
    var key = stateKey(st)
    if (S.typing && key === S.renderedKey) { S.dirty = true; return }
    S.renderedKey = key
    clear(root)
    var page = el('div', 'page')
    page.appendChild(header(st))
    var g = st.game
    var body
    if (st.phase === 'lobby') {
      body = el('div', 'stack')
      body.appendChild(el('div', 'prompt', 'You’re in!'))
      body.appendChild(el('div', 'sub', 'Look at the TV. The host picks a game.'))
      if (st.featured) body.appendChild(el('div', 'sub', 'Tonight: ' + st.featured.title))
      if (st.settings.allowSuggestions) body.appendChild(suggestBox(st))
      if (st.suggestions.length) body.appendChild(el('div', 'sub', 'Suggested: ' + st.suggestions.map(function (s) { return s.title }).join(', ')))
    } else if (st.phase === 'scoreboard' && st.scoreboard) body = screenBoard(st)
    else if (st.phase === 'result' && g) body = screenResult(st)
    else if (g && g.kind === 'vote') body = screenVote(st)
    else if (g && g.kind === 'quiz') body = g.phase === 'reveal' ? screenReveal(st) : screenAsk(st)
    else body = el('div', 'stack')
    page.appendChild(body)
    if (st.me.host) page.appendChild(hostPanel(st))
    page.appendChild(reactBar(st))
    page.appendChild(button('Leave', function () { if (window.confirm('Leave Movie Night?')) act('leave').then(function () { endScreen('You left Movie Night.') }) }, 'link'))
    page.appendChild(live)
    root.appendChild(page)
    tickBar()
  }
  function endScreen(text) {
    S.ended = true
    if (S.es) { try { S.es.close() } catch (e) { /* ignore */ } }
    clearTimeout(S.pollTimer)
    sset('mn.g', null)
    clear(root)
    var c = el('div', 'card'); c.appendChild(el('h1', '', text)); c.appendChild(el('p', 'sub', 'You can close this page.'))
    root.appendChild(c)
  }

  function onState(st) {
    var prevPhase = S.st && S.st.game ? S.st.game.phase + ':' + S.st.game.index : ''
    S.offset = (typeof st.now === 'number' ? st.now : Date.now()) - Date.now()
    var newQ = st.game ? st.game.phase + ':' + st.game.index : ''
    if (newQ !== prevPhase) { S.ballotTouched = false; if (st.game && st.game.phase === 'reveal') buzz(40) }
    S.st = st
    renderGame()
  }
  function connect() {
    if (S.es) { try { S.es.close() } catch (e) { /* ignore */ } S.es = null }
    if (!window.EventSource || S.esFails >= 4) { startPolling(); return }
    var es = new EventSource(API + '/events?ticket=' + enc(S.ticket))
    S.es = es
    es.addEventListener('state', function (m) { S.esFails = 0; try { onState(JSON.parse(m.data)) } catch (e) { /* ignore */ } })
    es.addEventListener('kicked', function () { endScreen('You were removed from this room.') })
    es.addEventListener('closed', function () { endScreen('Movie Night has ended.') })
    es.onerror = function () { S.esFails++; if (S.esFails >= 4) { try { es.close() } catch (e) { /* ignore */ } startPolling() } else if (es.readyState === 2) setTimeout(connect, 1500) }
  }
  function startPolling() {
    clearTimeout(S.pollTimer)
    var last = -1
    function once() {
      if (S.ended) return
      req('GET', '/poll?ticket=' + enc(S.ticket) + '&since=' + last).then(function (r) {
        if (r && r.ok) { last = r.seq; onState(r.state) } else if (r && r.error === 'not_found') { endScreen('Movie Night has ended.'); return }
        S.pollTimer = setTimeout(once, 1200)
      })
    }
    once()
  }

  function start() {
    // Strip the join key from the address bar as soon as we have read it.
    try { if (location.search) history.replaceState(null, '', location.pathname + (CFG.code ? '?c=' + CFG.code : '')) } catch (e) { /* ignore */ }
    var have = sget('mn.g')
    if (have) {
      req('GET', '/poll?ticket=' + enc(have)).then(function (r) { if (r && r.ok) { S.ticket = have; connect() } else { sset('mn.g', null); firstScreen() } })
      return
    }
    firstScreen()
  }
  function firstScreen() {
    if (CFG.code) {
      req('GET', '/preview?c=' + enc(CFG.code) + '&k=' + enc(CFG.key || '')).then(function (r) {
        if (r && r.ok) { S.colors = r.colors || []; var free = null; for (var i = 0; i < S.colors.length; i++) if (!S.colors[i].taken) { free = S.colors[i]; break } if (free) S.colorId = free.id; renderJoin() }
        else { clear(root); var c = el('div', 'card'); c.appendChild(el('h1', '', 'Can’t join')); c.appendChild(el('p', 'sub', (r && r.message) || 'That Movie Night is not available.')); root.appendChild(c) }
      })
      return
    }
    renderJoin()
  }
  setInterval(tickBar, 250)
  start()
}

// ---------------------------------------------------------------------------------------------------------------------------

function movieNightOverlayClient(CFG) {
  'use strict'
  // Opt-in only: the launcher puts #mn=<read-only ticket> on the player address. No ticket, no overlay, no requests.
  var m = /(?:^#|&)mn=([A-Za-z0-9_-]{32})(?:&|$)/.exec(location.hash || '')
  var ticket = ''
  try {
    if (m) { ticket = m[1]; sessionStorage.setItem('mn.ov', ticket); history.replaceState(null, '', location.pathname + location.search) }
    else ticket = sessionStorage.getItem('mn.ov') || ''
  } catch (e) { ticket = m ? m[1] : '' }
  if (!ticket || !window.EventSource) return
  var reduced = false
  try { reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) } catch (e) { reduced = false }
  var box = document.createElement('div')
  box.id = 'mnOverlay'; box.setAttribute('aria-hidden', 'true')
  document.body.appendChild(box)
  var HEX = /^#[0-9a-fA-F]{6}$/
  var count = 0, last = 0, fails = 0
  function place() { var fs = document.fullscreenElement || document.webkitFullscreenElement; var host = fs && fs.tagName !== 'VIDEO' ? fs : document.body; if (box.parentNode !== host) host.appendChild(box) }
  document.addEventListener('fullscreenchange', place); document.addEventListener('webkitfullscreenchange', place)
  var es = new EventSource(CFG.api + '/events?ticket=' + encodeURIComponent(ticket))
  es.addEventListener('state', function () { fails = 0 })
  es.addEventListener('reaction', function (ev) {
    var d
    try { d = JSON.parse(ev.data) } catch (e) { return }
    var t = Date.now()
    if (!d || typeof d.emoji !== 'string' || count >= 6 || t - last < 250) return
    last = t; count++
    var b = document.createElement('div')
    b.className = 'mnr' + (reduced ? ' still' : '')
    b.style.right = (8 + Math.floor(Math.random() * 70)) + 'px'
    var e1 = document.createElement('span'); e1.className = 'mne'; e1.textContent = d.emoji.slice(0, 8)
    var n1 = document.createElement('span'); n1.className = 'mnn'; n1.textContent = String(d.name || '').slice(0, 12)
    if (HEX.test(String(d.color))) n1.style.borderColor = d.color
    b.appendChild(e1); b.appendChild(n1)
    box.appendChild(b)
    setTimeout(function () { if (b.parentNode) b.parentNode.removeChild(b); count-- }, reduced ? 1400 : 3200)
  })
  es.addEventListener('closed', function () { try { es.close() } catch (e) { /* ignore */ } try { sessionStorage.removeItem('mn.ov') } catch (e2) { /* ignore */ } if (box.parentNode) box.parentNode.removeChild(box) })
  es.onerror = function () { fails++; if (fails >= 6) { try { es.close() } catch (e) { /* ignore */ } try { sessionStorage.removeItem('mn.ov') } catch (e2) { /* ignore */ } } }
}

module.exports = { movieNightTvClient, movieNightGuestClient, movieNightOverlayClient }
