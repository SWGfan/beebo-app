'use strict'
// Media segments (Jellyfin 10.10+ "skip intro / skip credits" data) from what Beebo already knows:
// the intro/credits markers viewers saved plus the ones the local detector found (GET /api/markers, already gated for this person).

const { toTicks } = require('./util')

const TYPES = ['Unknown', 'Commercial', 'Preview', 'Recap', 'Outro', 'Intro']

function createSegments({ host, ids, services }) {
  const kindOf = (entry) => (entry.type === 'Episode' ? 'tv' : entry.type === 'Movie' ? 'movie' : null)

  async function forEntry(user, entry, q, req) {
    const kind = kindOf(entry)
    if (!kind) return []
    const info = services.playback ? await services.playback.beeboInfo(user, entry, req) : null
    const duration = info && info.durationSec > 0 ? info.durationSec : 0
    const r = await host.api(user.id, 'GET', '/api/markers?kind=' + kind + '&id=' + encodeURIComponent(entry.beeboId) + (duration ? '&duration=' + Math.round(duration) : ''), undefined, req)
    const eff = r && r.status === 200 && r.body && r.body.effective
    if (!eff) return []
    const want = new Set(q.list('includeSegmentTypes').concat(q.list('includeSegmentType')).filter((t) => TYPES.includes(t)))
    const out = []
    const push = (type, start, end) => {
      if (want.size && !want.has(type)) return
      if (!(end > start) || start < 0) return
      out.push({ Id: ids.encode('segment', entry.jid + ':' + type), ItemId: entry.jid, Type: type, StartTicks: toTicks(start), EndTicks: toTicks(end) })
    }
    if (typeof eff.introEndSeconds === 'number') push('Intro', typeof eff.introStartSeconds === 'number' ? eff.introStartSeconds : 0, eff.introEndSeconds)
    if (typeof eff.creditsStartSeconds === 'number' && duration > eff.creditsStartSeconds) push('Outro', eff.creditsStartSeconds, duration)
    return out
  }

  return { forEntry }
}

module.exports = { createSegments, TYPES }
