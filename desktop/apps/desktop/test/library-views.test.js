// The new ways to look at the library (Detailed list, Shelves, Backdrops, Grouped, Folders): grouping,
// card-line layout and keyboard movement, shelves, the folder tree, and the saved views / shared
// presets. All pure logic under src/lib.
// Run: node --test test/library-views.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const lib = (f) => import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'lib', f)).href)

const GB = 1024 ** 3
const NOW = Date.UTC(2026, 8, 21)
const DAY = 86400000

let n = 0
const movie = (over = {}) => {
  n++
  return { id: `m${n}`, kind: 'movies', title: `Film ${n}`, year: 2000, rating: 7, votes: 500, genres: ['Drama'], tierLabel: '1080p', sizeBytes: GB, mtimeMs: NOW - 10 * DAY, fileName: `film${n}.mkv`, ...over }
}

// ------------------------------------------------------------------ grouping

test('group by year: newest first, unknown last, rows keep their order', async () => {
  const { groupRows } = await lib('libraryGrouping.js')
  const rows = [movie({ year: 1999, title: 'B' }), movie({ year: 2010, title: 'A' }), movie({ year: null, title: 'X' }), movie({ year: 1999, title: 'C' })]
  const groups = groupRows(rows, 'year')
  assert.deepEqual(groups.map((g) => g.label), ['2010', '1999', 'Unknown year'])
  assert.deepEqual(groups[1].rows.map((r) => r.title), ['B', 'C'])
})

test('group by decade', async () => {
  const { groupRows } = await lib('libraryGrouping.js')
  const groups = groupRows([movie({ year: 1994 }), movie({ year: 1999 }), movie({ year: 2003 }), movie({ year: 1979 })], 'decade')
  assert.deepEqual(groups.map((g) => [g.label, g.rows.length]), [['2000s', 1], ['1990s', 2], ['1970s', 1]])
})

test('group by genre puts a row in each of its genres; a row with none goes last', async () => {
  const { groupRows } = await lib('libraryGrouping.js')
  const a = movie({ genres: ['Horror', 'Drama'] })
  const b = movie({ genres: ['Drama'] })
  const c = movie({ genres: [] })
  const groups = groupRows([a, b, c], 'genre')
  assert.deepEqual(groups.map((g) => g.label), ['Drama', 'Horror', 'No genre'])
  assert.deepEqual(groups[0].rows, [a, b])
  assert.deepEqual(groups[1].rows, [a])
})

test('group by collection, studio, resolution and first letter', async () => {
  const { groupRows } = await lib('libraryGrouping.js')
  const rows = [
    movie({ collection: 'Alien Collection', studio: '20th Century Fox', tierLabel: '4K', title: 'Alien' }),
    movie({ collection: '', studio: 'Pixar', tierLabel: '720p', title: 'up' }),
    movie({ collection: 'Alien Collection', studio: '', tierLabel: '480p', title: '9 to 5' }),
    movie({ collection: '', studio: '', tierLabel: null, title: 'Zulu', probePath: '' })
  ]
  assert.deepEqual(groupRows(rows, 'collection').map((g) => g.label), ['Alien Collection', 'Not in a collection'])
  assert.deepEqual(groupRows(rows, 'studio').map((g) => g.label), ['20th Century Fox', 'Pixar', 'Unknown studio'])
  assert.deepEqual(groupRows(rows, 'resolution').map((g) => g.label), ['4K', '720p', 'SD', 'Unknown resolution'], 'sharpest first')
  assert.deepEqual(groupRows(rows, 'letter').map((g) => g.label), ['#', 'A', 'U', 'Z'])
})

test('group by resolution uses the file when it has been read', async () => {
  const { groupRows } = await lib('libraryGrouping.js')
  const scope = movie({ tierLabel: '720p' })
  const groups = groupRows([scope], 'resolution', { infoOf: () => ({ probed: true, width: 1920, height: 800 }) })
  assert.deepEqual(groups.map((g) => g.label), ['1080p'])
})

test('studio and collection grouping are offered for movies only; a saved choice a screen lacks falls back', async () => {
  const { groupOptionsFor, normalizeGroupBy, DEFAULT_GROUP_BY } = await lib('libraryGrouping.js')
  assert.ok(groupOptionsFor('movies').some((g) => g.id === 'studio'))
  assert.ok(!groupOptionsFor('tv').some((g) => g.id === 'studio'))
  assert.ok(!groupOptionsFor('tv').some((g) => g.id === 'collection'))
  assert.equal(normalizeGroupBy('studio', 'tv'), DEFAULT_GROUP_BY)
  assert.equal(normalizeGroupBy('studio', 'movies'), 'studio')
  assert.equal(normalizeGroupBy('bogus', 'movies'), DEFAULT_GROUP_BY)
})

// ------------------------------------------------------------------ card lines

test('columns and card width for a pane', async () => {
  const { columnsFor, cardWidthFor } = await lib('libraryGrouping.js')
  assert.equal(columnsFor(1000, 160, 16, 12), 5)
  assert.equal(columnsFor(100, 160, 16, 12), 1, 'never fewer than one')
  assert.equal(columnsFor(0, 160), 1)
  assert.equal(cardWidthFor(1000, 5, 16, 12), (1000 - 24 - 64) / 5)
})

function sampleGroups() {
  const mk = (label, count) => ({ key: label, label, rows: Array.from({ length: count }, (_, i) => ({ id: `${label}${i}` })) })
  return [mk('A', 5), mk('B', 2), mk('C', 4)]
}

test('layout: a header line then rows of cards, each with a fixed height', async () => {
  const { layoutCardLines } = await lib('libraryGrouping.js')
  const { lines, total, items, columns } = layoutCardLines(sampleGroups(), { columns: 3, headerH: 40, rowH: 100, gap: 10 })
  assert.equal(columns, 3)
  assert.deepEqual(lines.map((l) => l.type), ['header', 'cells', 'cells', 'header', 'cells', 'header', 'cells', 'cells'])
  assert.deepEqual(lines.filter((l) => l.type === 'cells').map((l) => l.count), [3, 2, 2, 3, 1])
  assert.equal(items.length, 11)
  assert.equal(lines[1].first, 0)
  assert.equal(lines[2].first, 3)
  assert.equal(lines[4].first, 5)
  assert.equal(lines[0].top, 0)
  assert.equal(lines[1].top, 40)
  assert.equal(lines[2].top, 150)
  assert.equal(total, 40 + 220 + 40 + 110 + 40 + 220)
  // lines never overlap
  for (let i = 1; i < lines.length; i++) assert.equal(lines[i].top, lines[i - 1].top + lines[i - 1].height)
})

test('layout without headers is one plain grid (Backdrops)', async () => {
  const { layoutCardLines } = await lib('libraryGrouping.js')
  const { lines } = layoutCardLines([{ key: 'all', label: '', rows: Array.from({ length: 7 }, (_, i) => ({ id: i })) }], { columns: 3, rowH: 50, headers: false })
  assert.deepEqual(lines.map((l) => l.type), ['cells', 'cells', 'cells'])
  assert.deepEqual(lines.map((l) => l.count), [3, 3, 1])
})

test('windowing finds the lines on screen by arithmetic, with overscan', async () => {
  const { layoutCardLines, linesWindow, lineAt } = await lib('libraryGrouping.js')
  const big = [{ key: 'g', label: 'g', rows: Array.from({ length: 3000 }, (_, i) => ({ id: i })) }]
  const { lines } = layoutCardLines(big, { columns: 6, headerH: 40, rowH: 200, gap: 0 })
  assert.equal(lines.length, 501)
  const w = linesWindow(lines, 10000, 800, 200)
  assert.ok(w.end - w.start <= 8, `drew ${w.end - w.start} lines`)
  assert.ok(lines[w.start].top <= 10000 - 200 && lines[w.end - 1].top < 10000 + 800 + 200)
  assert.equal(lineAt(lines, 0), 0)
  assert.equal(lineAt(lines, 39), 0)
  assert.equal(lineAt(lines, 40), 1)
  assert.equal(lineAt([], 5), -1)
  assert.deepEqual(linesWindow([], 0, 500), { start: 0, end: 0 })
})

test('sticky header: the last header at or above the scroll position', async () => {
  const { layoutCardLines, stickyHeaderAt } = await lib('libraryGrouping.js')
  const { lines } = layoutCardLines(sampleGroups(), { columns: 3, headerH: 40, rowH: 100, gap: 10 })
  assert.equal(stickyHeaderAt(lines, 0), 0)
  assert.equal(stickyHeaderAt(lines, 100), 0)
  const bTop = lines[3].top
  assert.equal(lines[stickyHeaderAt(lines, bTop)].label, 'B')
  assert.equal(lines[stickyHeaderAt(lines, bTop - 1)].label, 'A')
  assert.equal(lines[stickyHeaderAt(lines, 99999)].label, 'C')
  assert.equal(stickyHeaderAt([], 10), -1)
})

test('keyboard through grouped cards: left/right cross groups, up/down keep the column', async () => {
  const { layoutCardLines, navigateLines, positionOfItem } = await lib('libraryGrouping.js')
  const { lines, items } = layoutCardLines(sampleGroups(), { columns: 3, headerH: 40, rowH: 100, gap: 10 })
  const N = items.length
  // positions
  assert.deepEqual(positionOfItem(lines, 0), { line: 1, col: 0 })
  assert.deepEqual(positionOfItem(lines, 4), { line: 2, col: 1 })
  assert.deepEqual(positionOfItem(lines, 5), { line: 4, col: 0 })
  assert.deepEqual(positionOfItem(lines, 9), { line: 6, col: 2 })
  assert.deepEqual(positionOfItem(lines, 10), { line: 7, col: 0 })
  assert.equal(positionOfItem(lines, 99), null)
  // first key press lands somewhere sensible
  assert.equal(navigateLines(lines, N, -1, 'ArrowDown'), 0)
  assert.equal(navigateLines(lines, N, -1, 'End'), N - 1)
  // left/right
  assert.equal(navigateLines(lines, N, 4, 'ArrowRight'), 5, 'crosses into the next group')
  assert.equal(navigateLines(lines, N, 5, 'ArrowLeft'), 4)
  assert.equal(navigateLines(lines, N, 0, 'ArrowLeft'), 0)
  assert.equal(navigateLines(lines, N, N - 1, 'ArrowRight'), N - 1)
  // down keeps the column, clamped to a shorter line, skipping headers
  assert.equal(navigateLines(lines, N, 1, 'ArrowDown'), 4, 'A row 1 col 1 -> A row 2 col 1')
  assert.equal(navigateLines(lines, N, 2, 'ArrowDown'), 4, 'col 2 clamps to the last card of the shorter line')
  assert.equal(navigateLines(lines, N, 4, 'ArrowDown'), 6, 'into group B (col 1), past its header')
  assert.equal(navigateLines(lines, N, 5, 'ArrowUp'), 3, 'back up into A col 0 of its last line')
  assert.equal(navigateLines(lines, N, 0, 'ArrowUp'), 0, 'nothing above the first line')
  assert.equal(navigateLines(lines, N, N - 1, 'ArrowDown'), N - 1)
  assert.equal(navigateLines(lines, N, 0, 'PageDown', 2), 5, 'two card lines down')
  assert.equal(navigateLines(lines, N, 0, 'PageDown', 99), 10, 'stops at the last line')
  assert.equal(navigateLines(lines, N, N - 1, 'Home'), 0)
  assert.equal(navigateLines(lines, 0, -1, 'ArrowDown'), -1, 'an empty view has nowhere to go')
})

test('revealing a card line keeps it clear of the pinned header', async () => {
  const { layoutCardLines, scrollTopToRevealLine } = await lib('libraryGrouping.js')
  const { lines } = layoutCardLines(sampleGroups(), { columns: 3, headerH: 40, rowH: 100, gap: 10 })
  const li = 2 // top 150, height 110
  assert.equal(scrollTopToRevealLine(lines, li, 200, 300, 40), 110, 'above the view: sit just under the pinned header')
  assert.equal(scrollTopToRevealLine(lines, li, 0, 200, 40), 60, 'below the view: bottom edge at the bottom')
  assert.equal(scrollTopToRevealLine(lines, li, 100, 300, 40), 100, 'already visible: no movement')
})

// ------------------------------------------------------------------ shelves

test('shelves: continue watching, recent, top rated, unwatched 4K and one per common genre', async () => {
  const { buildShelves, SHELF_CAP } = await lib('libraryShelves.js')
  const rows = []
  for (let i = 0; i < 12; i++) rows.push(movie({ genres: i < 6 ? ['Action'] : ['Comedy'], rating: 5 + (i % 5), tierLabel: i % 4 === 0 ? '4K' : '1080p', mtimeMs: NOW - (i + 1) * DAY * 20 }))
  const watchedRow = rows[0]
  const partRow = rows[1]
  const marks = { watchedMovies: new Set([watchedRow.fileName]), watchedEpisodes: new Set(), watchlistMovies: new Set() }
  const progress = new Map([[partRow.id, { pct: 40, at: NOW - 1000 }]])
  const shelves = buildShelves(rows, {
    marks, now: NOW,
    progressOf: (r) => (progress.get(r.id) || {}).pct || 0,
    progressAtOf: (r) => (progress.get(r.id) || {}).at || 0
  })
  const byId = Object.fromEntries(shelves.map((s) => [s.id, s]))
  assert.deepEqual(byId.continue.rows.map((r) => r.id), [partRow.id])
  assert.ok(byId.recent, 'recently added')
  assert.equal(byId.recent.rows[0].id, rows[0].id, 'newest first')
  assert.ok(byId['unwatched-4k'])
  assert.ok(byId['unwatched-4k'].rows.every((r) => r.tierLabel === '4K' && r.id !== watchedRow.id), 'watched 4K films are left out')
  assert.ok(byId['genre:Action'] && byId['genre:Comedy'])
  assert.ok(!byId['genre:Action'].rows.some((r) => !r.genres.includes('Action')))
  assert.ok(shelves.every((s) => s.rows.length > 0 && s.rows.length <= SHELF_CAP))
  // shelves come in a fixed, sensible order: personal ones first, genres last
  const ids = shelves.map((s) => s.id)
  assert.ok(ids.indexOf('continue') < ids.indexOf('recent'))
  assert.ok(ids.indexOf('recent') < ids.indexOf('genre:Action'))
})

test('shelves: without watched marks the personal shelves are dropped and "4K" replaces "Unwatched 4K"', async () => {
  const { buildShelves } = await lib('libraryShelves.js')
  const rows = [movie({ tierLabel: '4K' }), movie({ tierLabel: '1080p' })]
  const ids = (marks) => buildShelves(rows, { marks, now: NOW }).map((s) => s.id)
  for (const marks of [null, false]) {
    const got = ids(marks)
    assert.ok(!got.includes('continue') && !got.includes('unwatched') && !got.includes('unwatched-4k'))
    assert.ok(got.includes('4k'))
  }
})

test('shelves: top rated needs a good rating from enough voters; small genres get no shelf; each shelf is capped', async () => {
  const { buildShelves, SHELF_CAP } = await lib('libraryShelves.js')
  const rows = [
    movie({ rating: 9, votes: 5000 }), movie({ rating: 9.5, votes: 3 }), movie({ rating: 6, votes: 9000 }), movie({ rating: 8, votes: null }),
    ...Array.from({ length: 60 }, () => movie({ genres: ['Western'], rating: 8 })),
    movie({ genres: ['Musical'] })
  ]
  const shelves = buildShelves(rows, { now: NOW })
  const top = shelves.find((s) => s.id === 'top-rated')
  assert.ok(top.rows.every((r) => r.rating >= 7.5 && (r.votes === null || r.votes >= 100)))
  assert.ok(!top.rows.some((r) => r.votes === 3), 'a 9.5 from three voters is not "top rated"')
  const western = shelves.find((s) => s.id === 'genre:Western')
  assert.equal(western.rows.length, SHELF_CAP)
  assert.equal(western.total, 60, 'the shelf remembers how many there really are')
  assert.ok(!shelves.some((s) => s.id === 'genre:Musical'))
})

test('shelf windowing along x and keyboard moves between shelves', async () => {
  const { shelfWindow, scrollLeftToReveal, navigateShelves } = await lib('libraryShelves.js')
  assert.deepEqual(shelfWindow({ count: 40, step: 100, scrollLeft: 0, viewportWidth: 500, overscan: 2 }), { start: 0, end: 7 })
  const w = shelfWindow({ count: 40, step: 100, scrollLeft: 1500, viewportWidth: 500, overscan: 2 })
  assert.deepEqual(w, { start: 13, end: 22 })
  assert.deepEqual(shelfWindow({ count: 0, step: 100, scrollLeft: 0, viewportWidth: 500 }), { start: 0, end: 0 })
  assert.equal(scrollLeftToReveal({ index: 10, step: 100, cardWidth: 90, scrollLeft: 0, viewportWidth: 500 }), 590)
  assert.equal(scrollLeftToReveal({ index: 1, step: 100, cardWidth: 90, scrollLeft: 300, viewportWidth: 500 }), 100)
  assert.equal(scrollLeftToReveal({ index: 4, step: 100, cardWidth: 90, scrollLeft: 300, viewportWidth: 500 }), 300)
  const shelves = [{ rows: [1, 2, 3, 4] }, { rows: [1, 2] }, { rows: [1, 2, 3] }]
  assert.deepEqual(navigateShelves(shelves, null, 'ArrowDown'), { shelf: 0, index: 0 })
  assert.deepEqual(navigateShelves(shelves, { shelf: 0, index: 3 }, 'ArrowDown'), { shelf: 1, index: 1 }, 'column clamps to the shorter shelf')
  assert.deepEqual(navigateShelves(shelves, { shelf: 1, index: 1 }, 'ArrowDown'), { shelf: 2, index: 1 })
  assert.deepEqual(navigateShelves(shelves, { shelf: 2, index: 1 }, 'ArrowUp'), { shelf: 1, index: 1 })
  assert.deepEqual(navigateShelves(shelves, { shelf: 0, index: 0 }, 'ArrowUp'), { shelf: 0, index: 0 })
  assert.deepEqual(navigateShelves(shelves, { shelf: 0, index: 3 }, 'ArrowRight'), { shelf: 0, index: 3 })
  assert.deepEqual(navigateShelves(shelves, { shelf: 0, index: 1 }, 'End'), { shelf: 0, index: 3 })
  assert.equal(navigateShelves([], null, 'ArrowDown'), null)
})

// ------------------------------------------------------------------ folders

const at = (root, rel, over = {}) => movie({ root, rel, ...over })

test('folder tree: the real folders below the library folder, counts include everything below', async () => {
  const { buildFolderTree, listFolder, breadcrumbs, parentFolder } = await lib('libraryFolders.js')
  const rows = [
    at('D:\\Movies', 'Alien (1979)\\Alien.mkv', { title: 'Alien' }),
    at('D:\\Movies', 'Alien (1979)\\Extras\\Deleted.mkv', { title: 'Deleted' }),
    at('D:\\Movies', 'Heat.mkv', { title: 'Heat' }),
    at('D:\\Movies', 'Kids\\Up.mkv', { title: 'Up' })
  ]
  const tree = buildFolderTree(rows)
  assert.equal(tree.start, 'Movies', 'one library folder: the view opens inside it')
  const top = listFolder(tree, tree.start)
  assert.deepEqual(top.folders.map((f) => [f.name, f.count]), [['Alien (1979)', 2], ['Kids', 1]])
  assert.deepEqual(top.rows.map((r) => r.title), ['Heat'])
  const alien = listFolder(tree, top.folders[0].id)
  assert.deepEqual(alien.rows.map((r) => r.title), ['Alien'])
  assert.deepEqual(alien.folders.map((f) => f.name), ['Extras'])
  assert.deepEqual(breadcrumbs(tree, alien.folders[0].id).map((b) => b.name), ['Movies', 'Alien (1979)', 'Extras'], 'one library folder: it is the top of the trail')
  assert.equal(parentFolder(tree, alien.folders[0].id), top.folders[0].id)
  assert.equal(parentFolder(tree, tree.start), null, 'nothing above the only library folder')
  assert.equal(parentFolder(tree, tree.top), null)
  assert.equal(tree.nodes.get(tree.top).count, 4)
})

test('folder tree: several library folders share a top list; two roots with the same name stay apart', async () => {
  const { buildFolderTree, listFolder, parentFolder, breadcrumbs } = await lib('libraryFolders.js')
  const rows = [at('D:\\Movies', 'A.mkv'), at('E:\\Movies', 'B.mkv'), at('F:\\Films', 'sub\\C.mkv')]
  const tree = buildFolderTree(rows)
  assert.equal(tree.start, tree.top, 'several roots: start at the list of them')
  const top = listFolder(tree, tree.top)
  assert.equal(top.folders.length, 3)
  assert.deepEqual(top.folders.map((f) => f.name).sort(), ['Films', 'Movies', 'Movies (2)'])
  const films = top.folders.find((f) => f.name === 'Films')
  assert.deepEqual(listFolder(tree, films.id).folders.map((f) => f.name), ['sub'])
  assert.equal(parentFolder(tree, films.id), tree.top, 'several library folders: up leads to the list of them')
  assert.deepEqual(breadcrumbs(tree, films.id).map((b) => b.name), ['Library', 'Films'])
})

test('folder tree: a show sits in the library folder as its own entry; a drive root is labelled by its drive', async () => {
  const { buildFolderTree, listFolder, rootLabel, folderOfRow, folderEntries } = await lib('libraryFolders.js')
  const shows = [
    { id: 's1', kind: 'tv', title: 'Severance', root: 'D:\\TV', rel: 'Severance' },
    { id: 's2', kind: 'tv', title: 'Loose', root: 'D:\\TV', rel: '' }
  ]
  const tree = buildFolderTree(shows)
  assert.deepEqual(listFolder(tree, tree.start).rows.map((r) => r.title), ['Severance', 'Loose'])
  assert.equal(rootLabel('D:\\'), 'D:')
  assert.equal(rootLabel('/mnt/media/'), 'media')
  assert.equal(folderOfRow(tree, 's1'), tree.start)
  assert.equal(folderOfRow(tree, 'nope'), null)
  const oneRoot = buildFolderTree([at('D:\\M', 'a\\b.mkv'), at('D:\\M', 'c.mkv')])
  assert.deepEqual(folderEntries(oneRoot, 'M').map((e) => e.type), ['folder', 'row'], 'no way up from the only library folder')
  const inner = [...oneRoot.nodes.values()].find((nd) => nd.name === 'a')
  assert.deepEqual(folderEntries(oneRoot, inner.id).map((e) => e.type), ['up', 'row'])
  const twoRoots = buildFolderTree([at('D:\\M', 'c.mkv'), at('E:\\N', 'd.mkv')])
  assert.deepEqual(folderEntries(twoRoots, 'M').map((e) => e.type), ['up', 'row'], 'several library folders: up leads to the list of them')
  const noUp = folderEntries(buildFolderTree([at('D:\\M', 'c.mkv')]), '', {})
  assert.deepEqual(noUp.map((e) => e.type), ['folder'], 'the top has no way up')
})

test('folder tree handles forward-slash paths and rows with no location', async () => {
  const { buildFolderTree, listFolder } = await lib('libraryFolders.js')
  const tree = buildFolderTree([at('/mnt/media/movies', 'Drama/Heat.mkv'), { id: 'x', kind: 'movies', title: 'Nowhere' }])
  const roots = listFolder(tree, tree.top).folders
  assert.ok(roots.length >= 1)
  const movies = roots.find((f) => f.name === 'movies')
  assert.deepEqual(listFolder(tree, movies.id).folders.map((f) => f.name), ['Drama'])
})

test('a big flat folder builds quickly', async () => {
  const { buildFolderTree, listFolder } = await lib('libraryFolders.js')
  const rows = Array.from({ length: 5000 }, (_, i) => at('D:\\Movies', `Genre ${i % 20}\\Film ${i}.mkv`))
  const t = process.hrtime.bigint()
  const tree = buildFolderTree(rows)
  const ms = Number(process.hrtime.bigint() - t) / 1e6
  assert.equal(listFolder(tree, tree.start).folders.length, 20)
  assert.ok(ms < 300, `took ${ms.toFixed(1)} ms`)
})

// ------------------------------------------------------------------ modes and sorting

test('view modes: the seven ways, a saved value that no longer exists falls back, and the switcher wraps', async () => {
  const { VIEW_MODES, normalizeMode, stepMode, DEFAULT_MODE } = await lib('libraryViews.js')
  assert.deepEqual(VIEW_MODES.map((m) => m.id), ['posters', 'table', 'detailed', 'shelves', 'backdrops', 'grouped', 'folders'])
  assert.equal(normalizeMode('shelves'), 'shelves')
  assert.equal(normalizeMode('cover-flow'), DEFAULT_MODE)
  assert.equal(normalizeMode(undefined), DEFAULT_MODE)
  assert.equal(stepMode('posters', 1), 'table')
  assert.equal(stepMode('folders', 1), 'posters')
  assert.equal(stepMode('posters', -1), 'folders')
  assert.equal(stepMode('nonsense', 1), 'table')
})

test('sorting for the list views: rows with no value last either way, ties by title', async () => {
  const { sortForView, normalizeSort } = await lib('libraryViews.js')
  const rows = [
    movie({ id: 'a', title: 'Alpha', year: 1990, rating: 6, sizeBytes: 3 * GB, mtimeMs: 100 }),
    movie({ id: 'b', title: 'Bravo', year: 2010, rating: null, sizeBytes: null, mtimeMs: null }),
    movie({ id: 'c', title: 'Charlie', year: 2010, rating: 9, sizeBytes: 1 * GB, mtimeMs: 300 }),
    movie({ id: 'd', title: 'delta', year: null, rating: 6, sizeBytes: 2 * GB, mtimeMs: 200 })
  ]
  const ids = (sort) => sortForView(rows, sort).map((r) => r.id)
  assert.deepEqual(ids({ id: 'title', dir: 'asc' }), ['a', 'b', 'c', 'd'])
  assert.deepEqual(ids({ id: 'title', dir: 'desc' }), ['d', 'c', 'b', 'a'])
  assert.deepEqual(ids({ id: 'year', dir: 'desc' }), ['b', 'c', 'a', 'd'], 'ties by title, no year last')
  assert.deepEqual(ids({ id: 'year', dir: 'asc' }), ['a', 'b', 'c', 'd'])
  assert.deepEqual(ids({ id: 'rating', dir: 'desc' }), ['c', 'a', 'd', 'b'])
  assert.deepEqual(ids({ id: 'added', dir: 'desc' }), ['c', 'd', 'a', 'b'])
  assert.deepEqual(ids({ id: 'size', dir: 'asc' }), ['c', 'd', 'a', 'b'])
  assert.deepEqual(ids({ id: 'nonsense' }), ids({ id: 'title', dir: 'asc' }))
  assert.deepEqual(normalizeSort({ id: 'rating' }), { id: 'rating', dir: 'desc' }, 'a missing direction takes the sort\'s natural one')
  assert.notEqual(sortForView(rows, {}), rows, 'never sorts in place')
})

// ------------------------------------------------------------------ saved views and presets

test('a fresh person has movies and tv blocks with defaults', async () => {
  const { emptyUserViews, normalizeUserViews } = await lib('libraryViews.js')
  const v = emptyUserViews()
  assert.equal(v.movies.mode, 'posters')
  assert.equal(v.tv.mode, 'posters')
  assert.deepEqual(v.movies.saved, [])
  assert.deepEqual(normalizeUserViews(null), v)
  assert.deepEqual(normalizeUserViews('junk'), v)
})

test('normalizing repairs a damaged stored value instead of trusting it', async () => {
  const { normalizeUserViews, MAX_SAVED_VIEWS } = await lib('libraryViews.js')
  const v = normalizeUserViews({
    movies: {
      mode: 'shelves', groupBy: 'studio', sort: { id: 'rating', dir: 'sideways' }, filters: { genres: ['Drama', 3], hdr: 'hdr' }, active: 'gone',
      saved: [
        { id: 'ok', name: '  4K night  ', mode: 'grouped', groupBy: 'decade', filters: { resolutions: ['4K'] } },
        { id: 'ok', name: 'duplicate id' },
        { id: 'no name' },
        { id: 'bad id!', name: 'x' },
        { id: 'w', name: 'Weird', mode: 'cover-flow', groupBy: 'zzz', sort: 5, filters: 'x' },
        'text', null, 4
      ]
    },
    tv: { mode: 'table', groupBy: 'studio' },
    evil: 1
  })
  assert.equal(v.movies.mode, 'shelves')
  assert.equal(v.movies.groupBy, 'studio')
  assert.deepEqual(v.movies.sort, { id: 'rating', dir: 'desc' })
  assert.deepEqual(v.movies.filters.genres, ['Drama'])
  assert.equal(v.movies.active, null, 'an active id that no longer exists is dropped')
  assert.deepEqual(v.movies.saved.map((s) => [s.id, s.name]), [['ok', '4K night'], ['w', 'Weird']])
  assert.equal(v.movies.saved[1].mode, 'posters')
  assert.equal(v.movies.saved[1].groupBy, 'year')
  assert.equal(v.tv.mode, 'table')
  assert.equal(v.tv.groupBy, 'year', 'studio is not a TV grouping')
  assert.ok(!('evil' in v))
  const many = normalizeUserViews({ movies: { saved: Array.from({ length: 200 }, (_, i) => ({ id: `v${i}`, name: `View ${i}` })) } })
  assert.equal(many.movies.saved.length, MAX_SAVED_VIEWS)
})

test('save the current settings as a named view, then change and reapply it', async () => {
  const v = await lib('libraryViews.js')
  let state = v.emptyUserViews()
  state = v.patchCurrent(state, 'movies', { mode: 'grouped', groupBy: 'decade', sort: { id: 'rating', dir: 'desc' }, filters: { resolutions: ['4K'], watched: 'unwatched' } })
  state = v.saveCurrentAsView(state, 'movies', '  Movie night  ', 1000)
  assert.equal(state.movies.saved.length, 1)
  const saved = state.movies.saved[0]
  assert.equal(saved.name, 'Movie night')
  assert.equal(saved.mode, 'grouped')
  assert.equal(saved.groupBy, 'decade')
  assert.deepEqual(saved.filters.resolutions, ['4K'])
  assert.equal(state.movies.active, saved.id)
  assert.equal(v.isViewModified(state.movies, 'movies'), false)
  // the other screen is untouched
  assert.deepEqual(state.tv.saved, [])
  // changing something marks it modified; reapplying restores it
  state = v.patchCurrent(state, 'movies', { mode: 'table', filters: {} })
  assert.equal(v.isViewModified(state.movies, 'movies'), true)
  state = v.applySavedView(state, 'movies', saved.id)
  assert.equal(state.movies.mode, 'grouped')
  assert.deepEqual(state.movies.filters.resolutions, ['4K'])
  assert.equal(v.isViewModified(state.movies, 'movies'), false)
  // update the active view in place
  state = v.patchCurrent(state, 'movies', { groupBy: 'genre' })
  state = v.updateActiveView(state, 'movies')
  assert.equal(state.movies.saved[0].groupBy, 'genre')
  assert.equal(v.isViewModified(state.movies, 'movies'), false)
})

test('saving under an existing name updates it; empty names and a full list change nothing', async () => {
  const v = await lib('libraryViews.js')
  let state = v.emptyUserViews()
  state = v.saveCurrentAsView(state, 'tv', 'Weekend', 1)
  state = v.patchCurrent(state, 'tv', { mode: 'shelves' })
  state = v.saveCurrentAsView(state, 'tv', 'weekend', 2)
  assert.equal(state.tv.saved.length, 1, 'same name (any case) is the same view')
  assert.equal(state.tv.saved[0].mode, 'shelves')
  assert.equal(v.saveCurrentAsView(state, 'tv', '   ', 3), state)
  let full = v.emptyUserViews()
  for (let i = 0; i < v.MAX_SAVED_VIEWS; i++) full = v.saveCurrentAsView(full, 'movies', `V${i}`, i)
  assert.equal(full.movies.saved.length, v.MAX_SAVED_VIEWS)
  assert.equal(v.saveCurrentAsView(full, 'movies', 'One too many', 999), full)
  const ids = new Set(full.movies.saved.map((s) => s.id))
  assert.equal(ids.size, v.MAX_SAVED_VIEWS, 'every saved view has its own id even when saved in the same millisecond')
})

test('rename and delete', async () => {
  const v = await lib('libraryViews.js')
  let state = v.saveCurrentAsView(v.emptyUserViews(), 'movies', 'One', 1)
  state = v.saveCurrentAsView(v.patchCurrent(state, 'movies', { mode: 'table' }), 'movies', 'Two', 2)
  const [one, two] = state.movies.saved
  assert.equal(v.renameSavedView(state, 'movies', one.id, 'two'), state, 'a name already used is refused')
  assert.equal(v.renameSavedView(state, 'movies', one.id, ' '), state)
  state = v.renameSavedView(state, 'movies', one.id, 'Uno')
  assert.equal(state.movies.saved[0].name, 'Uno')
  assert.equal(state.movies.active, two.id)
  state = v.deleteSavedView(state, 'movies', two.id)
  assert.deepEqual(state.movies.saved.map((s) => s.name), ['Uno'])
  assert.equal(state.movies.active, null, 'deleting the active view detaches it')
  assert.equal(v.deleteSavedView(state, 'movies', 'nope'), state)
})

test('resetting the filters detaches the saved view', async () => {
  const v = await lib('libraryViews.js')
  let state = v.patchCurrent(v.emptyUserViews(), 'movies', { filters: { genres: ['Horror'] } })
  state = v.saveCurrentAsView(state, 'movies', 'Scary', 1)
  state = v.resetFilters(state, 'movies')
  assert.deepEqual(state.movies.filters.genres, [])
  assert.equal(state.movies.active, null)
  assert.equal(state.movies.saved.length, 1, 'the saved view itself is kept')
})

test('a shared preset is one tagged line of JSON that round-trips', async () => {
  const v = await lib('libraryViews.js')
  let state = v.patchCurrent(v.emptyUserViews(), 'movies', { mode: 'grouped', groupBy: 'studio', sort: { id: 'year', dir: 'desc' }, filters: { genres: ['Comedy'], yearMin: 1980, yearMax: 1989, resolutions: ['1080p'] } })
  state = v.saveCurrentAsView(state, 'movies', '80s comedies', 1)
  const text = v.serializePreset(state.movies.saved[0], 'movies')
  assert.ok(!text.includes('\n'), 'one line')
  const data = JSON.parse(text)
  assert.equal(data[v.PRESET_TAG], v.PRESET_VERSION)
  assert.ok(!('id' in data), 'a preset carries no ids from this computer')
  const parsed = v.parsePreset(text, 'movies')
  assert.equal(parsed.ok, true)
  assert.equal(parsed.view.name, '80s comedies')
  assert.equal(parsed.view.mode, 'grouped')
  assert.equal(parsed.view.groupBy, 'studio')
  assert.deepEqual(parsed.view.filters.genres, ['Comedy'])
  assert.equal(parsed.view.filters.yearMin, 1980)
  // importing it on a fresh person adds a view and makes it current
  const other = v.importPreset(v.emptyUserViews(), 'movies', parsed.view, 5)
  assert.equal(other.movies.saved.length, 1)
  assert.equal(other.movies.saved[0].name, '80s comedies')
  assert.equal(other.movies.mode, 'grouped')
  assert.equal(other.movies.active, other.movies.saved[0].id)
  // whitespace around it is fine
  assert.equal(v.parsePreset(`\n  ${text}  \n`).ok, true)
})

test('a pasted preset is validated and cleaned; nothing else gets in', async () => {
  const v = await lib('libraryViews.js')
  const bad = (text) => { const r = v.parsePreset(text); assert.equal(r.ok, false, String(text).slice(0, 40)); assert.ok(r.error) }
  bad('')
  bad('   ')
  bad('not json')
  bad('[1,2,3]')
  bad('{"hello":"world"}')
  bad(JSON.stringify({ [v.PRESET_TAG]: 99, name: 'Future' }))
  bad(JSON.stringify({ [v.PRESET_TAG]: v.PRESET_VERSION }))
  bad(JSON.stringify({ [v.PRESET_TAG]: v.PRESET_VERSION, name: '   ' }))
  bad('x'.repeat(50000))
  const r = v.parsePreset(JSON.stringify({
    [v.PRESET_TAG]: v.PRESET_VERSION, name: 'A\u0000B\nC', kind: 'evil', mode: 'cover-flow', groupBy: 'x', sort: 7,
    filters: { genres: ['Drama'], hdr: '<b>', yearMin: 'abc', __proto__: { polluted: true }, extra: 1 }, id: 'v1', script: '<script>'
  }))
  assert.equal(r.ok, true)
  assert.equal(r.view.name, 'A B C')
  assert.equal(r.view.mode, 'posters')
  assert.equal(r.view.groupBy, 'year')
  assert.deepEqual(r.view.sort, { id: 'title', dir: 'asc' })
  assert.equal(r.view.filters.hdr, 'any')
  assert.equal(r.view.filters.yearMin, null)
  assert.ok(!('extra' in r.view.filters))
  assert.ok(!('script' in r.view) && !('id' in r.view))
  assert.equal({}.polluted, undefined)
})
