// Movie Night: party games on the TV, played from phones (docs/MOVIE-NIGHT.md). The server draws the shared
// screen; this screen only starts a room and then opens that page. Back returns to Home.

import { h, focusable, clear, setText } from '../dom.js'
import { button, topbar } from '../ui.js'
import { explainFailure } from '../util/movienight.js'

export function movienight(ctx) {
  var el = h('div', { cls: 'screen' })
  var bar = topbar('home', function (id) { ctx.goTab(id) })
  var col = h('div', { cls: 'center-col', css: { top: 'calc(var(--safe-y) + 100px)' } })
  var body = h('div')
  col.appendChild(h('div', { cls: 'heading', text: 'Movie Night' }))
  col.appendChild(body)
  el.appendChild(bar)
  el.appendChild(col)
  var dead = false
  var busy = false
  var note = h('div', { cls: 'state', text: '' })

  function start() {
    if (busy) return
    busy = true
    setText(note, 'Starting Movie Night…')
    ctx.api.movieNightStart().then(function (t) {
      busy = false
      if (dead) return
      // A code and a QR appear on the TV; phones on the same Wi-Fi join with no account.
      if (!ctx.platform.openMovieNight(ctx.origin(), t.url)) setText(note, 'This TV could not open Movie Night.')
    }, function (err) {
      busy = false
      if (dead) return
      setText(note, explainFailure(err))
      ctx.focus.ensureFocus()
    })
  }

  function build() {
    clear(body)
    body.appendChild(h('div', { cls: 'synopsis', text: 'Trivia, a movie-poster guessing game and a fair group vote for tonight’s film, made from your own library. Everyone joins from their phone by scanning a code on the TV. No account, no internet needed.' }))
    var go = button('Start Movie Night', start, 'primary')
    body.appendChild(h('div', { css: { marginTop: '32px' } }, [go]))
    body.appendChild(note)
    ctx.api.movieNightStatus().then(function (s) {
      if (dead || s.available) return
      setText(note, s.message || 'Movie Night is not available right now.')
    }, function () { /* the Start button reports a real problem when pressed */ })
    return go
  }

  var shown = false
  return {
    el: el,
    onShow: function () {
      if (!shown) { shown = true; ctx.focus.focus(build()); return }
      ctx.focus.ensureFocus()
    },
    destroy: function () { dead = true },
    onKey: function (action) {
      if (action === 'back') { ctx.router.back(); return true }
      return false
    }
  }
}

// Kept so a tile elsewhere can reuse the same look.
export function movieNightTile(onSelect) {
  var poster = h('div', { cls: 'poster' }, [h('div', { cls: 'ph', text: 'Movie Night' })])
  var cap = h('div', { cls: 'cap' }, [h('span', { cls: 'clip1', text: 'Movie Night' }), h('span', { cls: 'sub clip1', text: 'Games with phones' })])
  return focusable(h('div', { cls: 'tile' }, [poster, cap]), onSelect)
}

