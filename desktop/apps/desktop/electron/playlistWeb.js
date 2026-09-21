'use strict'
/**
 * The website side of playlists. Three pieces of browser code, kept out of
 * streamServer.js:
 *
 *   LIBRARY_SCRIPT      on every library page: "+ Playlist", "Play next" and
 *                       "Add to queue" inside a poster's ℹ️ overlay, on episode
 *                       rows and on a show's page.
 *   PLAYER_QUEUE_SCRIPT on the player: when the video ends, the next thing in
 *                       the queue plays (a playlist, or what was queued by hand).
 *   pageBody()          the /playlists page itself.
 *
 * All of them talk to /playlists/api/*, the cookie-session twin of
 * /api/playlists/* (playlistApi.js). The queue lives in sessionStorage: it is
 * this browser tab's "what plays next", like a TV's.
 */

// --- the queue, shared by both scripts ---------------------------------------
// { items: [{kind, id, title}], pos, playlistId, shuffle, seed }
// pos is the index of the item playing now (-1 before the first).
const QUEUE_HELPERS = `
  var BQ_KEY = 'beeboQueue'
  function bqLoad() {
    try { var q = JSON.parse(sessionStorage.getItem(BQ_KEY) || 'null'); if (q && Array.isArray(q.items)) return q } catch (e) {}
    return { items: [], pos: -1, playlistId: null }
  }
  function bqSave(q) { try { sessionStorage.setItem(BQ_KEY, JSON.stringify(q)) } catch (e) {} }
  function bqHref(it) { return (it.kind === 'tv' ? '/tvwatch?id=' : '/watch?id=') + encodeURIComponent(it.id) }
  function bqToast(msg) {
    var t = document.createElement('div')
    t.textContent = msg
    t.setAttribute('role', 'status')
    t.style.cssText = 'position:fixed;left:50%;bottom:90px;transform:translateX(-50%);background:#232834;color:#fff;padding:10px 16px;border-radius:10px;z-index:99999;font:600 14px sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.5)'
    document.body.appendChild(t)
    setTimeout(function () { t.remove() }, 2200)
  }
  function bqJson(method, url, body) {
    return fetch(url, { method: method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return { ok: false } }) })
  }
`

const LIBRARY_SCRIPT = `<script>
(function () {
${QUEUE_HELPERS}
  // What a link on this page points at, as a playlist item request.
  function refOf(href) {
    if (!href) return null
    var u
    try { u = new URL(href, location.href) } catch (e) { return null }
    if (u.pathname === '/watch' && u.searchParams.get('id')) return { type: 'movie', id: u.searchParams.get('id') }
    if (u.pathname === '/tvwatch' && u.searchParams.get('id')) return { type: 'episode', id: u.searchParams.get('id') }
    if (u.pathname === '/tvshows' && u.searchParams.get('show')) return { type: 'show', showKey: u.searchParams.get('show') }
    return null
  }
  function titleOf(el) {
    var t = el && el.querySelector && el.querySelector('.title')
    return (t && t.textContent) || (el && el.textContent) || ''
  }

  // Play next / Add to queue. A show or season is expanded by the server first.
  function enqueue(ref, title, next) {
    var go = function (items) {
      if (!items.length) { bqToast('Nothing to add.'); return }
      var q = bqLoad()
      var at = next ? q.pos + 1 : q.items.length
      q.items.splice.apply(q.items, [Math.max(0, at), 0].concat(items))
      bqSave(q)
      bqToast(next ? 'Plays next' : 'Added to your queue')
    }
    if (ref.type === 'movie' || ref.type === 'episode') {
      go([{ kind: ref.type === 'episode' ? 'tv' : 'movie', id: ref.id, title: String(title || '').trim() }])
      return
    }
    bqJson('POST', '/playlists/api/expand', { items: [ref] })
      .then(function (r) {
        if (!r.ok) { bqToast('Could not add that.'); return }
        go(r.items.map(function (e) { return { kind: e.kind, id: e.id, title: e.title } }))
      })
  }

  var modal = null
  function closeModal() { if (modal) { modal.remove(); modal = null } }
  function openPicker(ref, title) {
    closeModal()
    modal = document.createElement('div')
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-label', 'Add to playlist')
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:99998;display:flex;align-items:center;justify-content:center;padding:16px'
    modal.innerHTML = '<div style="background:#171a21;border:1px solid #2a2f3a;border-radius:14px;max-width:420px;width:100%;max-height:80vh;overflow:auto;padding:18px">' +
      '<div style="font-weight:700;font-size:17px;margin-bottom:4px">Add to playlist</div>' +
      '<div class="pl-sub" style="color:#8a8f98;font-size:13px;margin-bottom:12px"></div>' +
      '<div class="pl-list">Loading…</div>' +
      '<form class="pl-new" style="display:flex;gap:8px;margin-top:12px"><input name="n" maxlength="100" placeholder="New playlist name" style="margin:0;flex:1"><button type="submit">Create</button></form>' +
      '<button type="button" class="btn btn-secondary pl-close" style="margin-top:12px;width:100%">Close</button></div>'
    document.body.appendChild(modal)
    modal.querySelector('.pl-sub').textContent = String(title || '').trim()
    modal.addEventListener('click', function (e) { if (e.target === modal || e.target.closest('.pl-close')) closeModal() })
    modal.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal() })
    var add = function (id, name) {
      bqJson('POST', '/playlists/api/' + encodeURIComponent(id) + '/items', { items: [ref] }).then(function (r) {
        if (r.ok) { bqToast(r.added ? 'Added to ' + name : 'Already in ' + name); closeModal() }
        else bqToast('Could not add: ' + (r.error || 'error'))
      })
    }
    var nameInput = modal.querySelector('.pl-new input')
    var creating = false
    var createNew = function () {
      var n = nameInput.value.trim()
      if (!n || creating) return
      creating = true
      bqJson('POST', '/playlists/api/', { name: n, add: [ref] }).then(function (r) {
        creating = false
        if (r.ok) { bqToast('Created ' + n); closeModal() } else bqToast('Could not create: ' + (r.error || 'error'))
      })
    }
    modal.querySelector('.pl-new').addEventListener('submit', function (e) { e.preventDefault(); createNew() })
    nameInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); createNew() } })
    bqJson('GET', '/playlists/api/').then(function (r) {
      var box = modal && modal.querySelector('.pl-list')
      if (!box) return
      var mine = (r.playlists || []).filter(function (p) { return p.canEdit && !p.smart })
      box.innerHTML = mine.length ? '' : '<div style="color:#8a8f98;font-size:14px">No playlists yet — name one below.</div>'
      mine.forEach(function (p) {
        var b = document.createElement('button')
        b.type = 'button'
        b.className = 'btn btn-secondary'
        b.style.cssText = 'display:block;width:100%;text-align:left;margin-bottom:8px'
        b.textContent = p.name + ' (' + p.itemCount + ')'
        b.onclick = function () { add(p.id, p.name) }
        box.appendChild(b)
      })
      var first = box.querySelector('button') || modal.querySelector('input')
      if (first) first.focus()
    })
  }

  function actionsFor(ref, title) {
    var row = document.createElement('div')
    row.className = 'pl-actions'
    row.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-top:10px'
    var mk = function (label, fn) {
      var b = document.createElement('button')
      b.type = 'button'
      b.textContent = label
      b.style.cssText = 'padding:6px 10px;font-size:12px;border-radius:7px;background:#2a2f3a'
      b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); fn() }, true)
      row.appendChild(b)
    }
    mk('＋ Playlist', function () { openPicker(ref, title) })
    mk('⏭ Play next', function () { enqueue(ref, title, true) })
    mk('☰ Add to queue', function () { enqueue(ref, title, false) })
    return row
  }

  function decorate() {
    // Poster cards: inside the ℹ️ overlay.
    document.querySelectorAll('a.card').forEach(function (card) {
      var ov = card.querySelector('.info-overlay')
      if (!ov || ov.querySelector('.pl-actions')) return
      var ref = refOf(card.getAttribute('href'))
      if (ref) ov.appendChild(actionsFor(ref, titleOf(card)))
    })
    // Episode rows on a show page.
    document.querySelectorAll('a[href^="/tvwatch?id="]').forEach(function (a) {
      if (a.closest('.card .info-overlay') || a.dataset.plDone) return
      if (a.classList.contains('card') && a.querySelector('.info-overlay')) return
      a.dataset.plDone = '1'
      var ref = refOf(a.getAttribute('href'))
      var b = document.createElement('button')
      b.type = 'button'
      b.textContent = '＋'
      b.title = 'Add to playlist or queue'
      b.setAttribute('aria-label', 'Add to playlist or queue')
      b.style.cssText = 'margin-left:8px;padding:4px 9px;font-size:13px;border-radius:7px;background:#2a2f3a;vertical-align:middle'
      b.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation()
        var old = a.parentNode.querySelector('.pl-actions')
        if (old) { old.remove(); return }
        a.insertAdjacentElement('afterend', actionsFor(ref, a.textContent))
      }, true)
      a.insertAdjacentElement('afterend', b)
    })
    // A show's own page: the whole show.
    var u = new URL(location.href)
    if (u.pathname === '/tvshows' && u.searchParams.get('show') && !document.querySelector('.pl-show-actions')) {
      var h = document.querySelector('main h3, h3')
      if (h) {
        var wrap = actionsFor({ type: 'show', showKey: u.searchParams.get('show') }, h.textContent)
        wrap.classList.add('pl-show-actions')
        h.insertAdjacentElement('afterend', wrap)
      }
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', decorate)
  else decorate()
})()
</script>`

const PLAYER_QUEUE_SCRIPT = `<script>
(function () {
${QUEUE_HELPERS}
  var v = document.getElementById('v')
  if (!v) return
  var u = new URL(location.href)
  var kind = u.pathname === '/tvwatch' ? 'tv' : 'movie'
  var id = u.searchParams.get('id') || ''
  var q = bqLoad()
  if (!q.items.length) return
  // Where are we? The playing item if it is in the queue (at or after pos),
  // otherwise something played in between: the queue carries on after it.
  var here = -1
  for (var i = Math.max(0, q.pos); i < q.items.length; i++) {
    if (q.items[i].id === id && (q.items[i].kind || 'movie') === kind) { here = i; break }
  }
  if (here >= 0) {
    q.pos = here
    bqSave(q)
    if (q.playlistId) bqJson('POST', '/playlists/api/' + encodeURIComponent(q.playlistId) + '/progress', { entryId: q.items[here].entryId || '', index: here, shuffle: !!q.shuffle, seed: q.seed || 0 })
  }
  var next = q.items[q.pos + 1]
  if (!next) return

  // The queue wins over "up next" for this video.
  var style = document.createElement('style')
  style.textContent = '#upnext{display:none!important}'
  document.head.appendChild(style)
  var card = document.createElement('div')
  card.setAttribute('role', 'status')
  card.style.cssText = 'position:fixed;right:12px;bottom:64px;max-width:360px;background:rgba(23,26,33,.95);border:1px solid #2a2f3a;border-radius:12px;padding:12px 14px;color:#fff;z-index:50;display:none;font:14px sans-serif'
  card.innerHTML = '<div style="font-size:12px;color:#8a8f98;text-transform:uppercase;letter-spacing:.4px">Next in your queue</div><div class="qt" style="font-weight:700;margin:4px 0 8px"></div>' +
    '<button type="button" class="qp" style="padding:8px 12px;border-radius:8px;background:#4f9dff;color:#fff;border:0">▶ Play now</button> ' +
    '<button type="button" class="qc" style="padding:8px 12px;border-radius:8px;background:#2a2f3a;color:#fff;border:0">Stop after this</button>'
  document.body.appendChild(card)
  card.querySelector('.qt').textContent = next.title || ''
  var stopped = false
  var go = function () {
    if (stopped) return
    q = bqLoad()
    q.pos = Math.max(q.pos, here >= 0 ? here : q.pos)
    bqSave(q)
    location.href = bqHref(next)
  }
  card.querySelector('.qp').onclick = function (e) { e.stopPropagation(); go() }
  card.querySelector('.qc').onclick = function (e) { e.stopPropagation(); stopped = true; card.style.display = 'none' }
  v.addEventListener('timeupdate', function () {
    var d = Number(v.duration)
    if (!stopped && isFinite(d) && d > 0 && d - v.currentTime <= 20) card.style.display = 'block'
  })
  v.addEventListener('ended', function () {
    if (here < 0) { q = bqLoad(); bqSave(q) }
    go()
  })
})()
</script>`

// --- /playlists ----------------------------------------------------------------
function pageBody() {
  return `
  <div class="topbar">
    <h2 style="margin:0;">Playlists</h2>
    <a href="/logout" class="muted" style="color:#8a8f98;">Log out</a>
  </div>
  <div id="pl-app" aria-live="polite"><p class="muted">Loading…</p></div>
  <style>
    #pl-app button:focus-visible, #pl-app a:focus-visible, #pl-app select:focus-visible, #pl-app input:focus-visible { outline:3px solid #ffd54a; outline-offset:2px }
    .pl-row { display:flex; gap:10px; align-items:center; padding:10px 12px; margin-bottom:8px; }
    .pl-row img, .pl-row .noimg { width:46px; height:69px; object-fit:cover; border-radius:5px; background:#22262f; flex-shrink:0 }
    .pl-grow { flex:1; min-width:0 }
    .pl-small { padding:7px 11px; font-size:13px }
    .pl-rule { display:flex; gap:6px; flex-wrap:wrap; align-items:center; margin-bottom:8px }
    .pl-rule select, .pl-rule input { width:auto; margin:0; padding:8px; font-size:14px; background:#171a21; color:#eee; border:1px solid #2a2f3a; border-radius:7px }
    .pl-chip { display:inline-block; padding:8px 12px; margin:0 8px 8px 0; border-radius:99px; background:#2a2f3a; color:#eee; border:0; font-size:14px; cursor:pointer }
  </style>
  <script>
  (function () {
${QUEUE_HELPERS}
    var app = document.getElementById('pl-app')
    var state = { list: null, fields: null, open: null }
    var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] }) }
    var api = function (method, path, body) { return bqJson(method, '/playlists/api/' + path, body) }
    var ERR = { missing_name: 'Give it a name.', name_too_long: 'That name is too long.', only_owner_can_share: 'Only the owner can share playlists.', too_many_playlists: 'You have the most playlists allowed.', playlist_full: 'That playlist is full.' }
    var errText = function (r) { var c = (r && r.error) || ''; return ERR[c] || (c.indexOf('bad_rules') === 0 ? 'One of the rules is not complete.' : 'Something went wrong (' + c + ').') }

    function playItems(r, playlistId) {
      if (!r.ok) { bqToast(errText(r)); return }
      if (!r.items.length) { bqToast('Nothing playable in this playlist yet.'); return }
      var items = r.items.map(function (e) { return { kind: e.kind, id: e.id, title: e.title, entryId: e.entryId } })
      bqSave({ items: items, pos: r.startIndex - 1, playlistId: playlistId, shuffle: r.shuffle, seed: r.seed })
      location.href = bqHref(items[r.startIndex] || items[0])
    }
    function play(id, how) {
      var qs = how === 'shuffle' ? '?shuffle=1' : how === 'resume' ? '?resume=1' + (state.open && state.open.progress && state.open.progress.shuffle ? '&shuffle=1' : '') : ''
      api('GET', encodeURIComponent(id) + '/play' + qs).then(function (r) { playItems(r, id) })
    }

    function renderList() {
      var r = state.list
      var h = '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px">' +
        '<button type="button" id="pl-new">＋ New playlist</button>' +
        '<button type="button" id="pl-new-smart" class="btn-secondary">✨ New smart playlist</button></div>'
      h += '<div class="muted" style="margin:0 0 8px">One tap to start from a ready-made smart playlist:</div><div>' +
        (r.templates || []).map(function (t) { return '<button type="button" class="pl-chip" data-tpl="' + esc(t.id) + '">' + esc(t.name) + '</button>' }).join('') + '</div>'
      var q = bqLoad()
      if (q.items.length > q.pos + 1) {
        h += '<div class="card pl-row"><div class="pl-grow"><div class="title">Your queue</div><div class="sub">' + (q.items.length - q.pos - 1) + ' to play</div></div>' +
          '<button type="button" class="pl-small" id="pl-q-play">▶ Play</button><button type="button" class="pl-small btn-secondary" id="pl-q-clear">Clear</button></div>'
      }
      h += '<h3 style="margin:18px 0 10px">Your playlists</h3>'
      var rows = r.playlists || []
      if (!rows.length) h += '<p class="empty">No playlists yet.</p>'
      rows.forEach(function (p) {
        h += '<div class="card pl-row"><div class="pl-grow"><a href="#" class="title" data-open="' + esc(p.id) + '" style="color:#eee;text-decoration:none;font-size:15px">' +
          (p.smart ? '✨ ' : '') + esc(p.name) + '</a><div class="sub">' + (p.itemCount == null ? '' : p.itemCount + ' item' + (p.itemCount === 1 ? '' : 's')) +
          (p.shared ? ' · shared with the household' : '') + (!p.mine && p.ownerName ? ' · from ' + esc(p.ownerName) : '') + '</div></div>' +
          '<button type="button" class="pl-small" data-play="' + esc(p.id) + '">▶ Play</button>' +
          '<button type="button" class="pl-small btn-secondary" data-shuffle="' + esc(p.id) + '">🔀</button></div>'
      })
      app.innerHTML = h
    }

    function loadList() {
      state.open = null
      return api('GET', '').then(function (r) { state.list = r; if (r.ok) renderList(); else app.innerHTML = '<p class="error">' + esc(errText(r)) + '</p>' })
    }

    function ruleRow(c, idx) {
      var f = state.fields.fields
      var def = f[c.field] || f.mediaType
      var h = '<div class="pl-rule" data-idx="' + idx + '"><select data-k="field" aria-label="Rule">' +
        Object.keys(f).map(function (k) { return '<option value="' + esc(k) + '"' + (k === c.field ? ' selected' : '') + '>' + esc(f[k].label) + '</option>' }).join('') + '</select>' +
        '<select data-k="op" aria-label="Condition">' + def.ops.map(function (o) { return '<option' + (o === c.op ? ' selected' : '') + '>' + esc(o) + '</option>' }).join('') + '</select>'
      var val = c.value
      if (def.value === 'enum') h += '<select data-k="value">' + def.options.map(function (o) { return '<option' + (o === val ? ' selected' : '') + '>' + esc(o) + '</option>' }).join('') + '</select>'
      else if (def.value === 'bool') h += '<select data-k="value"><option value="true"' + (val !== false ? ' selected' : '') + '>yes</option><option value="false"' + (val === false ? ' selected' : '') + '>no</option></select>'
      else if (c.op === 'between') h += '<input data-k="v0" size="6" value="' + esc(Array.isArray(val) ? val[0] : '') + '"> and <input data-k="v1" size="6" value="' + esc(Array.isArray(val) ? val[1] : '') + '">'
      else h += '<input data-k="value" size="14" value="' + esc(val == null ? '' : val) + '" placeholder="' + esc(def.value) + '">'
      return h + '<button type="button" class="pl-small btn-secondary" data-rm="' + idx + '" aria-label="Remove rule">✕</button></div>'
    }

    function readRules(box) {
      var conds = []
      box.querySelectorAll('.pl-rule[data-idx]').forEach(function (row) {
        var field = row.querySelector('[data-k=field]').value
        var def = state.fields.fields[field]
        var op = row.querySelector('[data-k=op]').value
        var numeric = ['year', 'decade', 'rating', 'days', 'minutes'].indexOf(def.value) >= 0
        var conv = function (s) { s = String(s).trim(); return numeric || (def.value !== 'text' && /^\\d+$/.test(s) && field !== 'show') ? Number(s) : s }
        var value
        if (op === 'between') value = [conv(row.querySelector('[data-k=v0]').value), conv(row.querySelector('[data-k=v1]').value)]
        else {
          var el = row.querySelector('[data-k=value]')
          value = def.value === 'bool' ? el.value === 'true' : def.value === 'enum' ? el.value : conv(el.value)
        }
        conds.push({ field: field, op: op, value: value })
      })
      var limit = Number(box.querySelector('[data-k=limit]').value) || null
      return { match: box.querySelector('[data-k=match]').value, conditions: conds, sort: { by: box.querySelector('[data-k=sort]').value, dir: box.querySelector('[data-k=dir]').value }, limit: limit }
    }

    function rulesEditor(rules, onSave) {
      var r = JSON.parse(JSON.stringify(rules || { match: 'all', conditions: [], sort: { by: 'added', dir: 'desc' }, limit: null }))
      var box = document.createElement('div')
      box.className = 'card'
      box.style.padding = '14px'
      var draw = function () {
        box.innerHTML = '<div style="margin-bottom:10px">Match <select data-k="match"><option value="all"' + (r.match !== 'any' ? ' selected' : '') + '>all</option><option value="any"' + (r.match === 'any' ? ' selected' : '') + '>any</option></select> of these rules</div>' +
          r.conditions.map(ruleRow).join('') +
          '<button type="button" class="pl-small btn-secondary" data-addrule>＋ Add rule</button>' +
          '<div class="pl-rule" style="margin-top:12px">Sort by <select data-k="sort">' + state.fields.sorts.map(function (s) { return '<option' + (s === (r.sort || {}).by ? ' selected' : '') + '>' + esc(s) + '</option>' }).join('') + '</select>' +
          '<select data-k="dir"><option value="desc"' + ((r.sort || {}).dir !== 'asc' ? ' selected' : '') + '>newest / highest first</option><option value="asc"' + ((r.sort || {}).dir === 'asc' ? ' selected' : '') + '>oldest / A–Z first</option></select>' +
          ' Limit <input data-k="limit" size="5" value="' + esc(r.limit || '') + '" placeholder="none"></div>' +
          '<div class="sub" data-count style="margin:8px 0">…</div><button type="button" data-save>Save</button>'
        preview()
      }
      var timer = null
      var preview = function () {
        clearTimeout(timer)
        timer = setTimeout(function () {
          var rules2
          try { rules2 = readRules(box) } catch (e) { return }
          api('POST', 'preview', { rules: rules2 }).then(function (p) {
            var el = box.querySelector('[data-count]')
            if (el) el.textContent = p.ok ? p.count + ' item' + (p.count === 1 ? '' : 's') + ' match right now' + (p.items.length ? ': ' + p.items.slice(0, 5).map(function (i) { return i.title }).join(', ') + (p.count > 5 ? '…' : '') : '') : errText(p)
          })
        }, 250)
      }
      box.addEventListener('change', function (e) {
        var row = e.target.closest('.pl-rule[data-idx]')
        if (row && e.target.dataset.k === 'field') {
          r = readRules(box)
          var i = Number(row.dataset.idx)
          var def = state.fields.fields[e.target.value]
          r.conditions[i] = { field: e.target.value, op: def.ops[0], value: def.value === 'enum' ? def.options[0] : def.value === 'bool' ? true : '' }
          draw()
          return
        }
        if (row && e.target.dataset.k === 'op') { r = readRules(box); draw(); return }
        preview()
      })
      box.addEventListener('input', preview)
      box.addEventListener('click', function (e) {
        if (e.target.closest('[data-addrule]')) { r = readRules(box); r.conditions.push({ field: 'genre', op: 'is', value: '' }); draw() }
        var rm = e.target.closest('[data-rm]')
        if (rm) { r = readRules(box); r.conditions.splice(Number(rm.dataset.rm), 1); draw() }
        if (e.target.closest('[data-save]')) onSave(readRules(box))
      })
      draw()
      return box
    }

    function renderOpen() {
      var d = state.open
      var p = d.playlist
      var h = '<p><a href="#" data-back style="color:#8a8f98">← All playlists</a></p>' +
        '<h3 style="margin:0 0 6px">' + (p.smart ? '✨ ' : '') + esc(p.name) + '</h3>' +
        '<div class="sub" style="margin-bottom:12px">' + d.count + ' item' + (d.count === 1 ? '' : 's') + (p.shared ? ' · shared with the household' : '') + (d.skipped ? ' · ' + d.skipped + ' not playable here yet' : '') + '</div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">' +
        '<button type="button" data-play="' + esc(p.id) + '">▶ Play</button>' +
        '<button type="button" class="btn-secondary" data-shuffle="' + esc(p.id) + '">🔀 Shuffle</button>' +
        (d.progress ? '<button type="button" class="btn-secondary" data-resume="' + esc(p.id) + '">⏯ Resume</button>' : '') +
        (p.canEdit ? '<button type="button" class="btn-secondary" data-rename>✎ Rename</button>' +
          (state.list && state.list.canShare ? '<button type="button" class="btn-secondary" data-share>' + (p.shared ? 'Stop sharing' : '👪 Share with household') + '</button>' : '') +
          '<button type="button" class="btn-secondary" data-delete>🗑 Delete</button>' : '') + '</div><div id="pl-rules"></div>'
      d.items.forEach(function (it, i) {
        h += '<div class="card pl-row" data-entry="' + esc(it.entryId) + '">' +
          (it.poster ? '<img src="' + esc(it.poster) + '" alt="" loading="lazy">' : '<div class="noimg"></div>') +
          '<div class="pl-grow"><div class="title">' + esc(it.title) + '</div><div class="sub">' +
          (it.available === false ? 'No longer in the library' : esc([it.year, it.quality, it.durationSeconds ? Math.round(it.durationSeconds / 60) + ' min' : '', it.watched ? '✓ watched' : it.percent ? it.percent + '% watched' : ''].filter(Boolean).join(' · '))) + '</div></div>' +
          (it.available === false ? '' : '<button type="button" class="pl-small" data-playat="' + i + '" aria-label="Play from here">▶</button>') +
          (p.canEdit && !p.smart ? '<button type="button" class="pl-small btn-secondary" data-up="' + i + '" aria-label="Move up"' + (i === 0 ? ' disabled' : '') + '>▲</button>' +
            '<button type="button" class="pl-small btn-secondary" data-down="' + i + '" aria-label="Move down"' + (i === d.items.length - 1 ? ' disabled' : '') + '>▼</button>' +
            '<button type="button" class="pl-small btn-secondary" data-remove="' + esc(it.entryId) + '" aria-label="Remove">✕</button>' : '') + '</div>'
      })
      if (!d.items.length) h += '<p class="empty">' + (p.smart ? 'Nothing matches these rules right now.' : 'Empty. Add titles with ＋ Playlist in a poster’s ℹ️ panel.') + '</p>'
      app.innerHTML = h
      if (p.smart && p.canEdit) {
        document.getElementById('pl-rules').appendChild(rulesEditor(p.rules, function (rules) {
          api('POST', encodeURIComponent(p.id) + '/update', { rules: rules }).then(function (r) { if (r.ok) { state.open = r; renderOpen(); bqToast('Saved') } else bqToast(errText(r)) })
        }))
      }
    }

    function openPlaylist(id) {
      return ensureFields().then(function () { return api('GET', encodeURIComponent(id)) }).then(function (r) {
        if (!r.ok) { bqToast(errText(r)); return loadList() }
        state.open = r
        renderOpen()
      })
    }
    function ensureFields() {
      if (state.fields) return Promise.resolve()
      return api('GET', 'fields').then(function (r) { state.fields = r })
    }

    app.addEventListener('click', function (e) {
      var t = e.target.closest('button, a')
      if (!t) return
      var ds = t.dataset
      var p = state.open && state.open.playlist
      var after = function (r) { if (r.ok) { state.open = r; renderOpen() } else bqToast(errText(r)) }
      if (ds.open) { e.preventDefault(); openPlaylist(ds.open) }
      else if (ds.back !== undefined) { e.preventDefault(); loadList() }
      else if (ds.play) play(ds.play, 'order')
      else if (ds.shuffle) play(ds.shuffle, 'shuffle')
      else if (ds.resume) play(ds.resume, 'resume')
      else if (ds.tpl) api('POST', '', { template: ds.tpl }).then(function (r) { if (r.ok) openPlaylist(r.playlist.id); else bqToast(errText(r)) })
      else if (t.id === 'pl-new' || t.id === 'pl-new-smart') {
        var n = prompt(t.id === 'pl-new' ? 'Name your playlist' : 'Name your smart playlist')
        if (n) api('POST', '', t.id === 'pl-new' ? { name: n } : { name: n, smart: true, rules: { match: 'all', conditions: [] } }).then(function (r) { if (r.ok) openPlaylist(r.playlist.id); else bqToast(errText(r)) })
      }
      else if (t.id === 'pl-q-play') { var q = bqLoad(); location.href = bqHref(q.items[q.pos + 1]) }
      else if (t.id === 'pl-q-clear') { bqSave({ items: [], pos: -1, playlistId: null }); renderList() }
      else if (ds.playat !== undefined && p) {
        var playable = state.open.items.filter(function (x) { return x.available !== false })
        var at = playable.indexOf(state.open.items[Number(ds.playat)])
        playItems({ ok: true, items: playable, startIndex: Math.max(0, at), shuffle: false, seed: 0 }, p.id)
      }
      else if (ds.rename !== undefined && p) { var nn = prompt('New name', p.name); if (nn) api('POST', encodeURIComponent(p.id) + '/update', { name: nn }).then(after) }
      else if (ds.share !== undefined && p) api('POST', encodeURIComponent(p.id) + '/update', { shared: !p.shared }).then(after)
      else if (ds.delete !== undefined && p) { if (confirm('Delete "' + p.name + '"? The titles stay in your library.')) api('POST', encodeURIComponent(p.id) + '/delete').then(loadList) }
      else if (ds.remove && p) api('POST', encodeURIComponent(p.id) + '/items/remove', { entryIds: [ds.remove] }).then(after)
      else if ((ds.up !== undefined || ds.down !== undefined) && p) {
        var i = Number(ds.up !== undefined ? ds.up : ds.down)
        var to = ds.up !== undefined ? i - 1 : i + 1
        api('POST', encodeURIComponent(p.id) + '/items/move', { entryId: state.open.items[i].entryId, toIndex: to }).then(function (r) {
          after(r)
          var btn = app.querySelector('[data-' + (ds.up !== undefined ? 'up' : 'down') + '="' + to + '"]')
          if (btn && !btn.disabled) btn.focus()
        })
      }
    })
    loadList()
  })()
  </script>`
}

module.exports = { LIBRARY_SCRIPT, PLAYER_QUEUE_SCRIPT, pageBody, QUEUE_HELPERS }
