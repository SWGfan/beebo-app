// Settings: who is signed in, which server, default video quality, subtitles default, sign out.

import { h, focusable, clear, setText } from '../dom.js'
import { topbar } from '../ui.js'
import { BUILD } from '../buildinfo.js'

export function settings(ctx) {
  var el = h('div', { cls: 'screen' })
  var bar = topbar('settings', function (id) { ctx.goTab(id) })
  var col = h('div', { cls: 'center-col', css: { top: 'calc(var(--safe-y) + 100px)' } })
  var rows = h('div', { cls: 'rows' })
  col.appendChild(h('div', { cls: 'heading', text: 'Settings' }))
  col.appendChild(rows)
  el.appendChild(bar)
  el.appendChild(col)

  var QUALITIES = ['1080p', '720p', '480p']

  function row(key, value, onSelect) {
    var v = h('span', { cls: 'v', text: value })
    var r = focusable(h('div', { cls: 'row' }, [h('span', { cls: 'k', text: key }), v]), onSelect)
    r.valueEl = v
    return r
  }

  function build() {
    clear(rows)
    var user = ctx.store.getUserName()
    rows.appendChild(row('Signed in as', user || 'Unknown', function () { ctx.toast('Use “Sign out” below to switch person.') }))
    rows.appendChild(row('Server', ctx.origin().replace(/^https?:\/\//, ''), function () { ctx.toast('Use “Change server” below to connect to a different computer.') }))
    var q = row('Video quality', ctx.store.getQuality() + '   (OK to change)', function (r) {
      var next = QUALITIES[(QUALITIES.indexOf(ctx.store.getQuality()) + 1) % QUALITIES.length]
      ctx.store.setQuality(next)
      setText(r.valueEl, next + '   (OK to change)')
    })
    rows.appendChild(q)
    var s = row('Subtitles', ctx.store.getSubtitlesOn() ? 'On by default' : 'Off by default', function (r) {
      var on = !ctx.store.getSubtitlesOn()
      ctx.store.setSubtitlesOn(on)
      setText(r.valueEl, on ? 'On by default' : 'Off by default')
    })
    rows.appendChild(s)
    rows.appendChild(row('Sign out', 'Forget this person on this TV', function () { ctx.signOut() }))
    rows.appendChild(row('Change server', 'Connect to a different computer', function () { ctx.changeServer() }))
    rows.appendChild(row('About', 'Beebo TV ' + BUILD.version + ' · ' + ctx.platform.kind, function () { ctx.toast('Beebo TV ' + BUILD.version + ' (' + BUILD.platform + ')') }))
  }

  var shown = false
  return {
    el: el,
    onShow: function () {
      if (!shown) { shown = true; build(); ctx.focus.focus(rows.firstChild); return }
      ctx.focus.ensureFocus()
    }
  }
}
