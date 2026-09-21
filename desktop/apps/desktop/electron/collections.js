// --- Movie franchises (TMDB collections), grouped against the library ---
// One definition of "which franchises does this library own part of, and in
// what order do their films go". The website's Sequels view and the phone's
// /api/collections both read it, so the two can never disagree about order or
// counts again. Pure: no fs, no network. The caller hands in the owned TMDB
// ids and a lookup into the already-cached collections.json map.

// Release order, oldest first. A part TMDB has no date for yet (an announced
// sequel) goes last rather than first.
function sortPartsByRelease(parts) {
  return (Array.isArray(parts) ? parts : [])
    .filter((p) => p && p.id != null)
    .slice()
    .sort((a, b) => {
      const d = (a.release_date || '9999').localeCompare(b.release_date || '9999')
      return d || String(a.title || '').localeCompare(String(b.title || ''), undefined, { sensitivity: 'base' })
    })
}

// ownedTmdbIds: iterable of movie ids in the library (numbers or strings).
// collectionOf(id): the cached collection {id,name,parts} for that movie, or
// null/undefined when it is standalone or not looked up yet.
// Returns [{ id, name, parts (release order), ownedCount }] sorted by name,
// franchises with nothing owned left out.
function groupFranchises(ownedTmdbIds, collectionOf) {
  const owned = new Set()
  for (const id of ownedTmdbIds || []) if (id !== null && id !== undefined && id !== '') owned.add(String(id))
  const out = []
  const seen = new Set()
  for (const id of owned) {
    const collection = collectionOf(id)
    if (!collection || collection.id == null || seen.has(String(collection.id))) continue
    seen.add(String(collection.id))
    const parts = sortPartsByRelease(collection.parts)
    const ownedCount = parts.filter((p) => owned.has(String(p.id))).length
    if (!ownedCount) continue
    out.push({ id: collection.id, name: String(collection.name || 'Collection'), parts, ownedCount })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

// "The Alien Collection" is how TMDB names them already; a bare "Alien" is
// not, and the phone's "Part of the … Collection" line wants one form.
function collectionDisplayName(name) {
  const n = String(name || '').trim()
  if (!n) return 'Collection'
  return /collection$/i.test(n) ? n : `${n} Collection`
}

module.exports = { sortPartsByRelease, groupFranchises, collectionDisplayName }
