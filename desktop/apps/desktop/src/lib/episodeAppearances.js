// episodeAppearances.js - which episodes each actor is in, and how to say so
// ("Season 2: eps 3, 5–8; Season 4: ep 1"). Pure functions: no React, no IPC,
// so node --test checks them (test/episode-appearances.test.js).
//
// Inputs come from TMDB (fetched and cached in the main process):
//   aggregateCast  the show's series-wide cast: [{ id, name, profilePath, characters, episodeCount, order }]
//   records        one entry per episode we know credits for:
//                  { season, episode, cast?: [person], guests?: [person] }
//                  where person = { id, name, character?, profilePath? }
//   owned          the episodes that are in the library: [{ season, episode }]

const isCount = (n) => Number.isInteger(n) && n >= 0

const keyOf = (season, episode) => `${season}:${episode}`

const validEp = (x) => !!x && isCount(x.season) && Number.isInteger(x.episode) && x.episode > 0

/** [3, 5, 6, 7, 8] -> [[3, 3], [5, 8]]. Sorted, de-duplicated, junk dropped. */
export function compactRanges(numbers) {
  const sorted = Array.from(new Set((Array.isArray(numbers) ? numbers : []).filter((n) => Number.isInteger(n) && n > 0))).sort((a, b) => a - b)
  const out = []
  for (const n of sorted) {
    const last = out[out.length - 1]
    if (last && n === last[1] + 1) last[1] = n
    else out.push([n, n])
  }
  return out
}

/** [3, 5, 6, 7, 8] -> "3, 5–8". */
export function formatRanges(numbers) {
  return compactRanges(numbers)
    .map(([a, b]) => (a === b ? String(a) : `${a}–${b}`))
    .join(', ')
}

export function seasonName(season) {
  if (season === 0) return 'Specials'
  if (season === null || season === undefined) return 'Unsorted'
  return `Season ${season}`
}

/** "Season 2: eps 3, 5–8"  /  "Season 4: ep 1"  /  "Specials: ep 2". */
export function formatSeasonLine(season, episodes) {
  const ranges = compactRanges(episodes)
  if (!ranges.length) return ''
  const single = ranges.length === 1 && ranges[0][0] === ranges[0][1]
  return `${seasonName(season)}: ${single ? 'ep' : 'eps'} ${formatRanges(episodes)}`
}

/** [{season, episode}] -> [{ season, episodes: [n, ...] }] in season order, episodes ascending and unique. */
export function groupBySeason(list) {
  const bySeason = new Map()
  for (const x of Array.isArray(list) ? list : []) {
    if (!validEp(x)) continue
    if (!bySeason.has(x.season)) bySeason.set(x.season, new Set())
    bySeason.get(x.season).add(x.episode)
  }
  return Array.from(bySeason.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([season, set]) => ({ season, episodes: Array.from(set).sort((a, b) => a - b) }))
}

/** [{season, episode}] -> "Season 2: eps 3, 5–8; Season 4: ep 1". */
export function formatAppearances(list) {
  return groupBySeason(list).map((g) => formatSeasonLine(g.season, g.episodes)).join('; ')
}

function ownedKeySet(owned) {
  const set = new Set()
  for (const x of Array.isArray(owned) ? owned : []) if (validEp(x)) set.add(keyOf(x.season, x.episode))
  return set
}

/**
 * Merges the series cast and the per-episode records into one row per person.
 *
 * Each row: { id, name, profilePath, characters, kind: 'series' | 'guest', order,
 *             episodeCount, owned: [{season, episode}], notOwned: [{season, episode}] }
 * `owned` is only ever episodes that are in the library; `notOwned` is what TMDB
 * says they are in that we do not have (only known from records we fetched).
 * Series cast come first in billing order, then guests, most-seen first.
 */
export function buildAppearanceMap({ aggregateCast, records, owned } = {}) {
  const ownedKeys = ownedKeySet(owned)
  const people = new Map()

  const ensure = (p) => {
    const id = Number(p && p.id)
    if (!Number.isInteger(id) || id <= 0) return null
    let row = people.get(id)
    if (!row) {
      row = { id, name: '', profilePath: null, characters: [], kind: 'guest', order: Infinity, episodeCount: 0, ownedSet: new Set(), notOwnedSet: new Set() }
      people.set(id, row)
    }
    if (p.name && !row.name) row.name = String(p.name)
    if (p.profilePath && !row.profilePath) row.profilePath = String(p.profilePath)
    return row
  }
  const addCharacter = (row, character) => {
    const c = String(character || '').trim()
    if (c && !row.characters.includes(c)) row.characters.push(c)
  }

  for (const c of Array.isArray(aggregateCast) ? aggregateCast : []) {
    const row = ensure(c)
    if (!row) continue
    row.kind = 'series'
    row.order = Number.isFinite(c.order) ? c.order : row.order
    row.episodeCount = isCount(c.episodeCount) ? c.episodeCount : row.episodeCount
    for (const ch of Array.isArray(c.characters) ? c.characters : []) addCharacter(row, ch)
  }

  const seen = new Set()
  for (const rec of Array.isArray(records) ? records : []) {
    if (!validEp(rec)) continue
    const k = keyOf(rec.season, rec.episode)
    const target = ownedKeys.has(k) ? 'ownedSet' : 'notOwnedSet'
    for (const list of [rec.cast, rec.guests]) {
      for (const p of Array.isArray(list) ? list : []) {
        const row = ensure(p)
        if (!row) continue
        addCharacter(row, p.character)
        row[target].add(k)
        seen.add(k)
      }
    }
  }

  const expand = (set) =>
    Array.from(set)
      .map((k) => { const [s, e] = k.split(':').map(Number); return { season: s, episode: e } })
      .sort((a, b) => a.season - b.season || a.episode - b.episode)

  const rows = Array.from(people.values()).map((r) => {
    const { ownedSet, notOwnedSet, ...rest } = r
    return { ...rest, owned: expand(ownedSet), notOwned: expand(notOwnedSet) }
  })
  rows.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'series' ? -1 : 1
    if (a.kind === 'series') return a.order - b.order || a.name.localeCompare(b.name)
    return b.owned.length - a.owned.length || a.name.localeCompare(b.name)
  })
  return rows
}

/** How much of the library has credits so far: { covered, total }. Drives "checking episodes 34/177". */
export function coverage({ records, owned } = {}) {
  const ownedKeys = ownedKeySet(owned)
  const covered = new Set()
  for (const rec of Array.isArray(records) ? records : []) {
    if (validEp(rec) && ownedKeys.has(keyOf(rec.season, rec.episode)) && (rec.cast || rec.guests)) covered.add(keyOf(rec.season, rec.episode))
  }
  return { covered: covered.size, total: ownedKeys.size }
}

/** One person's appearances, from the rows buildAppearanceMap returned. */
export function appearancesFor(rows, personId) {
  const row = (Array.isArray(rows) ? rows : []).find((r) => r.id === Number(personId))
  return row ? { owned: row.owned, notOwned: row.notOwned } : { owned: [], notOwned: [] }
}
