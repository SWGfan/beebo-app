// libraryFolders.js - the Folder view: the real folder tree of the library folders, built from where
// each row's file (a film) or folder (a show) actually lives. Pure, so node --test checks it
// (test/library-views.test.js).
//
// A row carries `root` (the library folder it was found under, absolute) and `rel` (its path below
// that root). A film's rel is 'Alien (1979)/Alien.mkv'; a show's is its show folder, 'Breaking Bad'
// (or '' for a file dropped straight into the root). Nothing here touches the disk: the tree is
// only the folders that hold something in the library.

const splitRel = (rel) => String(rel || '').split(/[\\/]+/).filter(Boolean)

const baseName = (p) => {
  const s = String(p || '').replace(/[\\/]+$/, '')
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'))
  const name = i >= 0 ? s.slice(i + 1) : s
  return name || s || 'Library'
}

/** "D:\Movies" -> "Movies", "D:\" -> "D:", "/mnt/media" -> "media". */
export function rootLabel(root) {
  const s = String(root || '')
  const name = baseName(s)
  return name || s
}

export const TOP_ID = ''

const childId = (parent, name) => (parent === TOP_ID ? name : `${parent}\u0000${name}`)

/**
 * The tree for `rows`: { top, nodes }. `nodes` maps an id to
 * { id, name, parent, path (absolute folder path or ''), folders: [ids], rows: [row], count }.
 * `count` is every row at or below the folder. With more than one library folder the top node lists
 * them; with exactly one, `start` is that folder so the view opens inside it rather than on a
 * one-item list.
 */
export function buildFolderTree(rows) {
  const nodes = new Map()
  const top = { id: TOP_ID, name: 'Library', parent: null, path: '', folders: [], rows: [], count: 0, folderNames: new Map() }
  nodes.set(TOP_ID, top)
  const rootIds = new Map() // root path -> node id (the id is the root's own label, made unique)

  const ensureRoot = (root) => {
    let id = rootIds.get(root)
    if (id !== undefined) return id
    let label = rootLabel(root) || 'Library'
    let unique = label
    let n = 2
    while ([...rootIds.values()].includes(unique)) unique = `${label} (${n++})`
    id = unique
    rootIds.set(root, id)
    nodes.set(id, { id, name: unique, parent: TOP_ID, path: root, folders: [], rows: [], count: 0, folderNames: new Map() })
    top.folders.push(id)
    return id
  }

  const ensureChild = (parentNode, name) => {
    const existing = parentNode.folderNames.get(name)
    if (existing) return nodes.get(existing)
    const id = childId(parentNode.id, name)
    const sep = /\\/.test(parentNode.path) ? '\\' : '/'
    const node = { id, name, parent: parentNode.id, path: parentNode.path ? `${parentNode.path.replace(/[\\/]+$/, '')}${sep}${name}` : name, folders: [], rows: [], count: 0, folderNames: new Map() }
    nodes.set(id, node)
    parentNode.folders.push(id)
    parentNode.folderNames.set(name, id)
    return node
  }

  for (const row of rows) {
    const root = row.root || ''
    const rootNode = nodes.get(ensureRoot(root))
    const segs = splitRel(row.rel)
    // A film's last segment is its file; a show's rel is only folders. Either way the row sits in the
    // folder that holds it: everything but the last segment for a film, every segment for a show's own folder
    // is the row itself, so it sits in the folder above it.
    const dirs = segs.slice(0, Math.max(0, segs.length - 1))
    let node = rootNode
    node.count++
    for (const d of dirs) {
      node = ensureChild(node, d)
      node.count++
    }
    node.rows.push(row)
  }
  top.count = rows.length

  // Folder names A-Z; rows keep the order they came in (the screen's sort).
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  for (const node of nodes.values()) {
    node.folders.sort((a, b) => collator.compare(nodes.get(a).name, nodes.get(b).name))
    delete node.folderNames
  }
  const start = top.folders.length === 1 ? top.folders[0] : TOP_ID
  return { top: TOP_ID, start, nodes }
}

/** A folder's own listing: { folders: [{ id, name, count }], rows }. */
export function listFolder(tree, id) {
  const node = tree.nodes.get(id) || tree.nodes.get(tree.top)
  return {
    id: node.id,
    folders: node.folders.map((f) => {
      const child = tree.nodes.get(f)
      return { id: child.id, name: child.name, count: child.count }
    }),
    rows: node.rows
  }
}

// With one library folder there is no list of library folders to go "up" to: that folder is the top.
const singleRoot = (tree) => tree.nodes.get(tree.top).folders.length === 1

/** The path from the top to `id`: [{ id, name }], the top node first (the library folder itself when there is only one). */
export function breadcrumbs(tree, id) {
  const out = []
  let node = tree.nodes.get(id)
  while (node) {
    out.unshift({ id: node.id, name: node.name })
    node = node.parent === null ? null : tree.nodes.get(node.parent)
  }
  return singleRoot(tree) && out.length > 1 ? out.slice(1) : out
}

/** The folder above `id`, or null at the top. */
export function parentFolder(tree, id) {
  const node = tree.nodes.get(id)
  if (!node || node.parent === null) return null
  return node.parent === tree.top && singleRoot(tree) ? null : node.parent
}

/** Whether `id` is still a folder in `tree` (a rescan can remove one). */
export const hasFolder = (tree, id) => tree.nodes.has(id)

/** The folder that holds `rowId`, for jumping back to it (e.g. after its details page). */
export function folderOfRow(tree, rowId) {
  for (const node of tree.nodes.values()) {
    if (node.rows.some((r) => r.id === rowId)) return node.id
  }
  return null
}

/**
 * The listing as one flat array of entries for a windowed list: folders first (A-Z), then rows.
 * Entry: { type: 'up', id } (when not at the top and `withUp`), { type: 'folder', id, name, count }, { type: 'row', row }.
 */
export function folderEntries(tree, id, { withUp = true } = {}) {
  const listing = listFolder(tree, id)
  const out = []
  const parent = parentFolder(tree, listing.id)
  if (withUp && parent !== null) out.push({ type: 'up', id: parent })
  for (const f of listing.folders) out.push({ type: 'folder', id: f.id, name: f.name, count: f.count })
  for (const row of listing.rows) out.push({ type: 'row', row })
  return out
}
