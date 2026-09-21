import React, { forwardRef, memo, useEffect, useImperativeHandle, useMemo, useState } from 'react'
import { useFillPane } from '../lib/useFillPane.js'
import { breadcrumbs, buildFolderTree, folderEntries, folderOfRow, hasFolder, parentFolder } from '../lib/libraryFolders.js'
import { computeWindow, moveIndex, scrollTopForIndex, scrollTopToReveal } from '../lib/virtualRows.js'
import { scrollBelowStickyBar } from './LibraryControls.jsx'
import { ratingText, sizeText } from './libraryViewParts.jsx'

// The Folders view: the real folder tree of the library folders, one folder at a time, with a
// breadcrumb trail. A folder lists its sub-folders first, then the titles in it; a title opens
// exactly like a poster does. The list is windowed (a folder with thousands of files draws a
// screenful) and keyboard-operable: Up/Down move, Enter or Right opens a folder or a title,
// Left / Backspace / Alt+Left go up a level.

const ROW_H = 40

const FolderIcon = () => (
  <svg viewBox="0 0 24 24" className="lv-icon" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2.2h8.4A1.5 1.5 0 0 1 21 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" /></svg>
)
const FileIcon = () => (
  <svg viewBox="0 0 24 24" className="lv-icon" aria-hidden="true"><path d="M7 4h7l4 4v12H7zM14 4v4h4M10 13l4 2.5-4 2.5z" /></svg>
)
const UpIcon = () => (
  <svg viewBox="0 0 24 24" className="lv-icon" aria-hidden="true"><path d="M12 19V6M6 11l6-6 6 6" /></svg>
)

const Entry = memo(function Entry({ entry, index, active, id }) {
  const common = { id, role: 'option', 'aria-selected': active, 'data-i': index, className: `lv-folder-row ${index % 2 ? 'is-odd' : ''} ${active ? 'is-active' : ''}`, style: { height: ROW_H } }
  if (entry.type === 'up') {
    return (
      <div {...common} aria-label="Up one level">
        <UpIcon /><span className="lv-folder-name">..</span>
      </div>
    )
  }
  if (entry.type === 'folder') {
    return (
      <div {...common} aria-label={`Folder ${entry.name}, ${entry.count} title${entry.count === 1 ? '' : 's'}`}>
        <FolderIcon /><span className="lv-folder-name">{entry.name}</span>
        <span className="lv-folder-meta">{entry.count.toLocaleString()} title{entry.count === 1 ? '' : 's'}</span>
      </div>
    )
  }
  const row = entry.row
  return (
    <div {...common} aria-label={row.title}>
      <FileIcon /><span className="lv-folder-name">{row.title}</span>
      <span className="lv-folder-meta">
        {[row.year, ratingText(row), row.kind === 'tv' ? (row.episodes ? `${row.episodes} episode${row.episodes === 1 ? '' : 's'}` : '') : row.tierLabel, sizeText(row)].filter(Boolean).join(' · ')}
      </span>
    </div>
  )
})

export const FolderView = forwardRef(function FolderView({ kind, rows, onOpen, layoutKey, label }, ref) {
  const pane = useFillPane({ layoutKey })
  const tree = useMemo(() => buildFolderTree(rows), [rows])
  const [node, setNode] = useState(null)
  const [active, setActive] = useState(-1)
  const current = node !== null && hasFolder(tree, node) ? node : tree.start
  const entries = useMemo(() => folderEntries(tree, current), [tree, current])
  const trail = useMemo(() => breadcrumbs(tree, current), [tree, current])
  useEffect(() => { setActive(-1) }, [current, tree])

  const win = computeWindow({ count: entries.length, rowHeight: ROW_H, scrollTop: pane.scrollTop, viewportHeight: pane.viewH, overscan: 6 })
  const idOf = (i) => `lv-${kind}-folder-${i}`

  const go = (id) => {
    setNode(id)
    pane.scrollTo(0)
  }
  const activate = (i) => {
    const entry = entries[i]
    if (!entry) return
    if (entry.type === 'row') onOpen(entry.row, pane.rootRef.current)
    else go(entry.id)
  }
  const goUp = () => {
    const parent = parentFolder(tree, current)
    if (parent !== null) go(parent)
  }
  const reveal = (i) => {
    const s = pane.scrollerRef.current
    if (s) pane.scrollTo(scrollTopToReveal({ index: i, rowHeight: ROW_H, scrollTop: s.scrollTop, viewportHeight: pane.viewH }))
  }

  const onKeyDown = (e) => {
    if (e.ctrlKey || e.metaKey) return
    if (e.altKey) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); goUp() }
      return
    }
    if (e.key === 'Backspace' || e.key === 'ArrowLeft') { e.preventDefault(); goUp(); return }
    if ((e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') && active >= 0) { e.preventDefault(); activate(active); return }
    const page = Math.max(1, Math.floor(pane.viewH / ROW_H) - 1)
    const moves = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page }
    let next = null
    if (e.key in moves) next = active < 0 ? Math.min(entries.length - 1, win.firstVisible) : moveIndex(active, moves[e.key], entries.length)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = entries.length - 1
    else return
    e.preventDefault()
    if (next === null || next < 0) return
    setActive(next)
    reveal(next)
  }
  const onFocus = (e) => {
    if (e.target === e.currentTarget && active < 0 && entries.length) setActive(Math.min(entries.length - 1, win.firstVisible))
  }
  const onBodyClick = (e) => {
    const el = e.target.closest ? e.target.closest('[data-i]') : null
    if (!el) return
    const i = Number(el.dataset.i)
    setActive(i)
    activate(i)
  }

  useImperativeHandle(ref, () => ({
    // Letter keys jump within the folder being shown (its titles are in the screen's A-Z order).
    scrollToLetter(letter) {
      const i = entries.findIndex((en) => en.type === 'row' && (letter === 'NoINFO' ? !en.row.poster : !!en.row.poster && en.row.letter === letter))
      if (i < 0) return false
      if (pane.rootRef.current) scrollBelowStickyBar(pane.rootRef.current, { gap: 8 })
      pane.scrollTo(scrollTopForIndex({ index: i, count: entries.length, rowHeight: ROW_H, viewportHeight: pane.viewH }))
      setActive(i)
      return true
    },
    // Back from a details page: show the folder the title lives in, with the title highlighted.
    scrollToId(id) {
      const folder = folderOfRow(tree, id)
      if (folder === null) return false
      setNode(folder)
      return true
    }
  }))

  const visible = []
  for (let i = win.start; i < win.end; i++) {
    const entry = entries[i]
    visible.push(<Entry key={entry.type === 'row' ? entry.row.id : `${entry.type}:${entry.id}`} entry={entry} index={i} id={idOf(i)} active={i === active} />)
  }
  const activeInWindow = active >= win.start && active < win.end
  return (
    <div className="lv-pane-wrap" ref={pane.rootRef}>
      <nav className="lv-crumbs" aria-label="Folder path">
        <ol>
          {trail.map((c, i) => {
            const last = i === trail.length - 1
            return (
              <li key={c.id === '' ? '(top)' : c.id}>
                {last ? <span className="lv-crumb is-current" aria-current="page">{c.name}</span> : <button type="button" className="lv-crumb" onClick={() => go(c.id)}>{c.name}</button>}
                {last ? null : <span className="lv-crumb-sep" aria-hidden="true">/</span>}
              </li>
            )
          })}
        </ol>
        <span className="lv-crumbs-count">{(tree.nodes.get(current) || { count: 0 }).count.toLocaleString()} in this folder and below</span>
      </nav>
      <div
        className="lv-pane"
        role="listbox"
        aria-label={label}
        aria-activedescendant={activeInWindow ? idOf(active) : undefined}
        tabIndex={0}
        ref={pane.scrollerRef}
        style={{ height: pane.height }}
        onScroll={pane.onScroll}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
      >
        <div className="lv-body" role="presentation" style={{ height: entries.length * ROW_H }} onClick={onBodyClick}>
          <div className="lv-window" role="presentation" style={{ transform: `translateY(${win.offset}px)` }}>{visible}</div>
        </div>
        {entries.length === 0 ? <div className="lv-empty" role="status">This folder is empty.</div> : null}
      </div>
    </div>
  )
})
