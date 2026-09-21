// Missing metadata remains separate from playable files and watched/download counts.
function episodeGaps(owned, seasons, names = {}) {
  const bySeason = new Map()
  for (const ep of owned || []) {
    if (!Number.isInteger(ep.season) || ep.season < 0 || !Number.isInteger(ep.episode) || ep.episode < 1) continue
    if (!bySeason.has(ep.season)) bySeason.set(ep.season, new Set())
    bySeason.get(ep.season).add(ep.episode)
  }
  const result = new Map()
  for (const [season, have] of bySeason) {
    const count = (Array.isArray(seasons) ? seasons : []).find(s => s.season_number === season)?.episode_count
    const numbered = Object.keys(names).filter(k => k.startsWith(season + '|')).map(k => Number(k.split('|')[1])).filter(n => Number.isInteger(n) && n > 0 && n <= 1000)
    const counted = Number.isInteger(count) && count > 0 && count <= 1000
    const expected = counted ? Array.from({length:count}, (_, i) => i + 1) : [...new Set(numbered)].sort((a,b) => a-b)
    result.set(season, {
      checked: counted || numbered.length > 0,
      items: expected.filter(episode => !have.has(episode)).map(episode => ({
        season, episode,
        title: `S${season}E${episode}` + (names[season + '|' + episode] ? ` · ${String(names[season + '|' + episode]).slice(0,240)}` : '')
      }))
    })
  }
  return result
}
module.exports = { episodeGaps }
