// movieVersionsView.js - one card per film when a film has several files (a 4K next to a 1080p,
// a Director's Cut). Pure, so node --test checks it (test/movie-versions-view.test.js).
//
// movies:scan gives one record per FILE; the files of a film that has 2+ carry `version`
// ({ group, rank, order, label, height, hdr, edition, chosen }, see electron/movieVersionsDesktop.js).
// The screen shows the primary of each group (lowest rank) and hangs the others off it as `versions`.
// Grouping is redone from the files that are still there, so deleting a version (or the primary)
// needs no rescan: the next file in rank becomes the card.

/** [{ ...primary, versions: [{ path, fileName, name, ext, size, label, height, hdr, edition, chosen }] }] for a group; a lone file comes back untouched. */
export function collapseVersions(files) {
  const list = Array.isArray(files) ? files : []
  const byGroup = new Map()
  for (const f of list) {
    const g = f && f.version && f.version.group
    if (!g) continue
    if (!byGroup.has(g)) byGroup.set(g, [])
    byGroup.get(g).push(f)
  }
  const out = []
  for (const f of list) {
    const g = f && f.version && f.version.group
    const members = g ? byGroup.get(g) : null
    if (!members || members.length < 2) {
      out.push(f)
      continue
    }
    const primary = members.reduce((a, b) => (b.version.rank < a.version.rank ? b : a))
    if (f !== primary) continue
    const versions = members
      .slice()
      .sort((a, b) => a.version.order - b.version.order)
      .map((m) => ({
        path: m.path, fileName: m.fileName, name: m.name, ext: m.ext, size: m.size,
        label: m.version.label, height: m.version.height, hdr: m.version.hdr, edition: m.version.edition, chosen: !!m.version.chosen
      }))
    out.push({ ...primary, versions })
  }
  return out
}

/** Which file Play should act on: the one the owner picked before, else the best (first in display order). */
export function pickVersion(movie) {
  const versions = movie && Array.isArray(movie.versions) ? movie.versions : null
  if (!versions || versions.length < 2) return movie
  return versions.find((v) => v.chosen) || versions[0]
}

/** "1080p · 4.2 GB" - the picker's row text. */
export function versionRowText(v) {
  const size = v && v.size ? (v.size >= 1e9 ? `${(v.size / 1e9).toFixed(v.size >= 1e10 ? 0 : 1)} GB` : `${Math.max(1, Math.round(v.size / 1e6))} MB`) : ''
  return [v && v.label, size].filter(Boolean).join(' · ')
}

/** A remembered choice applied to the files the screen holds (all versions of the group; only `path` is chosen). */
export function withChoice(files, group, path) {
  return (Array.isArray(files) ? files : []).map((f) => (f && f.version && f.version.group === group
    ? { ...f, version: { ...f.version, chosen: f.path === path } }
    : f))
}
