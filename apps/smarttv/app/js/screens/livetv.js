// Live TV channel list: number, name and what is on now / next, from the owner's own tuner (docs LIVE-TV.md).
// OK on a channel opens the live player (screens/liveplayer.js) on that channel; Up / Down there changes channel.

import { h, focusable, clear } from '../dom.js'
import { topbar, stateBox } from '../ui.js'

export function livetv(ctx) {
  var el = h('div', { cls: 'screen' })
  var bar = topbar('home', function (id) { ctx.goTab(id) })
  var scroller = h('div', { cls: 'page-scroll', attrs: { 'data-scroll': 'y', 'data-pad-y': '30' } })
  var col = h('div', { cls: 'rows', css: { marginLeft: 'var(--safe-x)' } })
  scroller.appendChild(col)
  el.appendChild(bar)
  el.appendChild(scroller)
  var dead = false
  var shown = false

  function build(channels) {
    clear(col)
    col.appendChild(h('div', { cls: 'heading', text: 'Live TV', css: { marginBottom: '20px' } }))
    if (!channels.length) {
      col.appendChild(h('div', { cls: 'state', text: 'No channels are available. The owner sets up a tuner in Beebo on the computer.' }))
      return null
    }
    var first = null
    channels.forEach(function (c, i) {
      var title = (c.number ? c.number + '   ' : '') + c.name + (c.hd ? '   HD' : '')
      var sub = c.now ? 'Now: ' + c.now.title + (c.next ? '   ·   Next: ' + c.next.title : '') : ''
      var row = focusable(h('div', { cls: 'row' }, [h('span', { cls: 'k clip1', text: title }), h('span', { cls: 'v clip1', text: sub })]), function () {
        ctx.router.push('liveplayer', { channels: channels, index: i })
      })
      col.appendChild(row)
      if (!first) first = row
    })
    return first
  }

  function load() {
    clear(col)
    col.appendChild(stateBox({ spinner: true, title: 'Loading channels…' }))
    ctx.api.liveRow().then(function (channels) {
      if (dead) return
      var first = build(channels)
      ctx.focus.focus(first || bar.tabs.home)
    })
  }

  return {
    el: el,
    onShow: function () {
      if (!shown) { shown = true; load(); return }
      ctx.focus.ensureFocus()
    },
    destroy: function () { dead = true },
    onKey: function (action) {
      if (action === 'back') { ctx.router.back(); return true }
      return false
    }
  }
}
