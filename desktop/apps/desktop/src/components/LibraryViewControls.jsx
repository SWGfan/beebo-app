import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  ADDED_OPTIONS,
  CODEC_OPTIONS,
  RESOLUTION_BUCKETS,
  activeFilterCount,
  clearFilterKey,
  describeFilters,
  normalizeFilters
} from '../lib/libraryFilters.js'
import { VIEW_MODES } from '../lib/libraryViews.js'
import { useI18n } from '../lib/i18nApp.js'
import '../libraryViews.css'

// The toolbar controls for the library views, all popovers built the same way:
//   ViewSwitcher    which of the seven views to show (Alt+1 ... Alt+7 also switch)
//   FilterMenu      the filter panel (genre, year, rating, resolution, HDR, codec, watched, in progress,
//                   subtitles, size, runtime, actor, added recently)
//   SavedViewsMenu  named saved views: apply, update, rename, delete, share as text, import
// Every control is a real button, select or input with a label; each popover opens on Enter / Space /
// click, closes on Escape (focus returns to its button) and on a click outside it.
// Colours come from libraryViews.css.

const PANEL_MARGIN = 12

// Open/closed state, placement next to the button (fixed, clamped to the window so it never widens the
// page) and the usual dismissals.
function usePopover(width) {
  const [open, setOpen] = useState(false)
  const [place, setPlace] = useState({ left: PANEL_MARGIN, top: 0 })
  const buttonRef = useRef(null)
  const panelRef = useRef(null)

  const toggle = useCallback(() => {
    if (!open && buttonRef.current) {
      const r = buttonRef.current.getBoundingClientRect()
      const w = Math.min(width, window.innerWidth - PANEL_MARGIN * 2)
      setPlace({ left: Math.max(PANEL_MARGIN, Math.min(r.left, window.innerWidth - w - PANEL_MARGIN)), top: r.bottom + 8 })
    }
    setOpen(!open)
  }, [open, width])
  const close = useCallback((refocus = false) => {
    setOpen(false)
    if (refocus && buttonRef.current) buttonRef.current.focus()
  }, [])

  useEffect(() => {
    if (!open) return undefined
    const away = (e) => {
      if (panelRef.current && panelRef.current.contains(e.target)) return
      if (buttonRef.current && buttonRef.current.contains(e.target)) return
      setOpen(false)
    }
    const esc = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      close(true)
    }
    const resize = () => setOpen(false)
    // Capture phase: a control inside the panel stops its own keys from bubbling to the screen's letter-jump
    // listener (see `contain`), which would also hide Escape from a bubbling listener.
    document.addEventListener('pointerdown', away, true)
    document.addEventListener('keydown', esc, true)
    window.addEventListener('resize', resize)
    return () => {
      document.removeEventListener('pointerdown', away, true)
      document.removeEventListener('keydown', esc, true)
      window.removeEventListener('resize', resize)
    }
  }, [open, close])

  return { open, place, buttonRef, panelRef, toggle, close }
}

// A letter typed in a control must not reach the screen's "press a letter to jump to it" listener.
// (Alt and Ctrl combinations are left alone: they are the app's own shortcuts.)
const contain = (e) => { if (e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) e.stopPropagation() }

// --------------------------------------------------------------------------- view switcher

export const modeShortcut = (index) => `Alt+${index + 1}`

export function ViewSwitcher({ mode, onChange }) {
  const { t: tr } = useI18n()
  const pop = usePopover(280)
  const itemRefs = useRef([])
  const current = VIEW_MODES.find((m) => m.id === mode) || VIEW_MODES[0]
  const id = useId()

  useEffect(() => {
    if (!pop.open) return
    const i = Math.max(0, VIEW_MODES.findIndex((m) => m.id === mode))
    const t = setTimeout(() => itemRefs.current[i] && itemRefs.current[i].focus(), 0)
    return () => clearTimeout(t)
  }, [pop.open, mode])

  const choose = (m) => {
    pop.close(true)
    if (m.id !== mode) onChange(m.id)
  }
  const onItemKey = (e, i) => {
    const n = VIEW_MODES.length
    let next = null
    if (e.key === 'ArrowDown') next = (i + 1) % n
    else if (e.key === 'ArrowUp') next = (i - 1 + n) % n
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = n - 1
    else if (e.key === 'Tab') { pop.close(false); return }
    if (next === null) return
    e.preventDefault()
    itemRefs.current[next].focus()
  }

  return (
    <span className="lv-menu-wrap" onKeyDown={contain}>
      <button
        ref={pop.buttonRef}
        type="button"
        className="subtab genre-chip lv-button lv-switch-button"
        aria-haspopup="menu"
        aria-expanded={pop.open}
        aria-controls={pop.open ? `${id}-menu` : undefined}
        title={tr('viewmode.title')}
        onClick={pop.toggle}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' && !pop.open) { e.preventDefault(); pop.toggle() } }}
      >
        <svg viewBox="0 0 24 24" className="nav-icon lv-icon" aria-hidden="true"><path d="M4 5h7v6H4zM13 5h7v6h-7zM4 13h7v6H4zM13 13h7v6h-7z" /></svg>
        <span className="lv-button-label">{tr('viewmode.current', { mode: tr(`viewmode.${current.id}.label`) })}</span>
      </button>
      {pop.open && (
        <div ref={pop.panelRef} id={`${id}-menu`} className="lv-popover lv-switch-menu" role="menu" aria-label={tr('library.viewGroup')} style={{ left: pop.place.left, top: pop.place.top, width: 280 }}>
          {VIEW_MODES.map((m, i) => (
            <button
              key={m.id}
              ref={(el) => { itemRefs.current[i] = el }}
              type="button"
              role="menuitemradio"
              aria-checked={m.id === mode}
              tabIndex={-1}
              className={`lv-menu-item ${m.id === mode ? 'is-on' : ''}`}
              onClick={() => choose(m)}
              onKeyDown={(e) => onItemKey(e, i)}
            >
              <span className="lv-menu-name">{tr(`viewmode.${m.id}.label`)}</span>
              <span className="lv-menu-hint">{tr(`viewmode.${m.id}.hint`)}</span>
              <kbd className="lv-kbd">{modeShortcut(i)}</kbd>
            </button>
          ))}
        </div>
      )}
    </span>
  )
}

// --------------------------------------------------------------------------- filter panel

// A number box that lets a person type "19" on the way to "1985": the text is kept as typed and only
// committed (as a number, or null when emptied) when they pause, press Enter or leave the box.
function NumberBox({ label, value, onCommit, placeholder, step = 1, min = 0, max }) {
  const [text, setText] = useState(value === null || value === undefined ? '' : String(value))
  const last = useRef(value)
  const inputRef = useRef(null)
  // A change that came from outside (Clear all, a chip's x, a saved view) is shown; while the person is
  // typing here their own text stays, even if it is not a usable number yet ("19" on the way to "1985").
  useEffect(() => {
    if (value !== last.current && document.activeElement !== inputRef.current) {
      last.current = value
      setText(value === null || value === undefined ? '' : String(value))
    }
  }, [value])
  const timer = useRef(0)
  const commit = (t) => {
    clearTimeout(timer.current)
    const n = t.trim() === '' ? null : Number(t)
    const next = n === null || !Number.isFinite(n) ? null : n
    last.current = next
    onCommit(next)
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <input
      ref={inputRef}
      type="number"
      className="lv-num"
      inputMode="decimal"
      aria-label={label}
      placeholder={placeholder}
      value={text}
      step={step}
      min={min}
      max={max}
      onChange={(e) => { setText(e.target.value); clearTimeout(timer.current); const v = e.target.value; timer.current = setTimeout(() => commit(v), 500) }}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(e.currentTarget.value) } }}
    />
  )
}

// The actor box keeps what is typed (spaces included) and applies it once typing pauses.
function PersonBox({ value, onCommit }) {
  const [text, setText] = useState(value)
  const last = useRef(value)
  const timer = useRef(0)
  const inputRef = useRef(null)
  useEffect(() => {
    if (value !== last.current && document.activeElement !== inputRef.current) { last.current = value; setText(value) }
  }, [value])
  useEffect(() => () => clearTimeout(timer.current), [])
  const commit = (t) => { clearTimeout(timer.current); last.current = t.trim(); onCommit(t) }
  return (
    <input
      ref={inputRef}
      type="search"
      className="lv-text"
      placeholder="Part of an actor's name"
      value={text}
      onChange={(e) => { setText(e.target.value); clearTimeout(timer.current); const v = e.target.value; timer.current = setTimeout(() => commit(v), 450) }}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(e.currentTarget.value) } }}
    />
  )
}

function Chips({ label, options, selected, onToggle }) {
  return (
    <div className="lv-chips" role="group" aria-label={label}>
      {options.map((o) => {
        const on = selected.includes(o.key)
        return (
          <button key={o.key} type="button" className={`lv-chip-toggle ${on ? 'is-on' : ''}`} aria-pressed={on} onClick={() => onToggle(o.key)} title={o.title}>
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

const toggleIn = (list, key) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key])

const RATING_OPTIONS = [0, 5, 6, 7, 7.5, 8, 9]

/**
 * `options`: { genres: [{ name, count }], years: { min, max } | null, marksAvailable: bool | null }.
 */
export function FilterMenu({ filters, onChange, options, onOpen }) {
  const pop = usePopover(600)
  const f = useMemo(() => normalizeFilters(filters), [filters])
  const count = activeFilterCount(f)
  const id = useId()
  const set = (patch) => onChange({ ...f, ...patch })
  const years = options && options.years

  const toggle = () => {
    if (!pop.open && onOpen) onOpen()
    pop.toggle()
  }
  useEffect(() => {
    if (!pop.open) return
    const t = setTimeout(() => { const el = pop.panelRef.current && pop.panelRef.current.querySelector('input, select, button'); if (el) el.focus() }, 0)
    return () => clearTimeout(t)
  }, [pop.open, pop.panelRef])

  return (
    <span className="lv-menu-wrap" onKeyDown={contain}>
      <button
        ref={pop.buttonRef}
        type="button"
        className={`subtab genre-chip lv-button ${count ? 'is-on' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={pop.open}
        aria-controls={pop.open ? `${id}-panel` : undefined}
        title="Filter by genre, year, rating, resolution, HDR, codec, watched and more"
        onClick={toggle}
      >
        <svg viewBox="0 0 24 24" className="nav-icon lv-icon" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4" /></svg>
        <span className="lv-button-label">Filters{count ? ` (${count})` : ''}</span>
      </button>
      {pop.open && (
        <div ref={pop.panelRef} id={`${id}-panel`} className="lv-popover lv-filter-panel" role="dialog" aria-label="Filters" style={{ left: pop.place.left, top: pop.place.top, width: 600, maxHeight: `calc(100vh - ${pop.place.top + 16}px)` }}>
          <div className="lv-field lv-field-wide">
            <span className="lv-field-label" id={`${id}-genre`}>Genre <span className="lv-field-hint">any of</span></span>
            {options && options.genres && options.genres.length ? (
              <div className="lv-chips lv-chips-scroll" role="group" aria-labelledby={`${id}-genre`}>
                {options.genres.map((g) => {
                  const on = f.genres.includes(g.name)
                  return (
                    <button key={g.name} type="button" className={`lv-chip-toggle ${on ? 'is-on' : ''}`} aria-pressed={on} onClick={() => set({ genres: toggleIn(f.genres, g.name) })}>
                      {g.name} <span className="lv-chip-count">{g.count}</span>
                    </button>
                  )
                })}
              </div>
            ) : <span className="lv-field-hint">No genres known yet.</span>}
          </div>

          <div className="lv-field">
            <span className="lv-field-label" id={`${id}-year`}>Year</span>
            <span className="lv-range" role="group" aria-labelledby={`${id}-year`}>
              <NumberBox label="From year" value={f.yearMin} placeholder={years ? String(years.min) : 'from'} min={1800} max={2200} onCommit={(v) => set({ yearMin: v })} />
              <span aria-hidden="true">to</span>
              <NumberBox label="To year" value={f.yearMax} placeholder={years ? String(years.max) : 'to'} min={1800} max={2200} onCommit={(v) => set({ yearMax: v })} />
            </span>
          </div>

          <label className="lv-field">
            <span className="lv-field-label">Rating</span>
            <select value={f.ratingMin === null ? '0' : String(f.ratingMin)} onChange={(e) => set({ ratingMin: Number(e.target.value) > 0 ? Number(e.target.value) : null })}>
              {RATING_OPTIONS.map((r) => <option key={r} value={String(r)}>{r === 0 ? 'Any' : `${r}+ out of 10`}</option>)}
            </select>
          </label>

          <div className="lv-field">
            <span className="lv-field-label" id={`${id}-res`}>Resolution</span>
            <Chips label="Resolution" options={RESOLUTION_BUCKETS.map((r) => ({ key: r, label: r }))} selected={f.resolutions} onToggle={(k) => set({ resolutions: toggleIn(f.resolutions, k) })} />
          </div>

          <label className="lv-field">
            <span className="lv-field-label">HDR</span>
            <select value={f.hdr} onChange={(e) => set({ hdr: e.target.value })}>
              <option value="any">Any</option>
              <option value="hdr">HDR (Dolby Vision, HDR10, HLG)</option>
              <option value="sdr">SDR only</option>
            </select>
          </label>

          <div className="lv-field lv-field-wide">
            <span className="lv-field-label">Video codec</span>
            <Chips label="Video codec" options={CODEC_OPTIONS} selected={f.codecs} onToggle={(k) => set({ codecs: toggleIn(f.codecs, k) })} />
          </div>

          <label className="lv-field">
            <span className="lv-field-label">Watched</span>
            <select value={f.watched} onChange={(e) => set({ watched: e.target.value })}>
              <option value="any">Any</option>
              <option value="unwatched">Unwatched</option>
              <option value="watched">Watched</option>
            </select>
          </label>

          <div className="lv-field">
            <span className="lv-field-label">Progress</span>
            <label className="lv-check">
              <input type="checkbox" checked={f.inProgress} onChange={(e) => set({ inProgress: e.target.checked })} />
              <span>Started but not finished</span>
            </label>
          </div>

          <label className="lv-field">
            <span className="lv-field-label">Subtitles</span>
            <select value={f.subtitles} onChange={(e) => set({ subtitles: e.target.value })}>
              <option value="any">Any</option>
              <option value="yes">Has subtitles in the file</option>
              <option value="no">No subtitles in the file</option>
            </select>
          </label>

          <label className="lv-field">
            <span className="lv-field-label">Added</span>
            <select value={f.addedDays === null ? '' : String(f.addedDays)} onChange={(e) => set({ addedDays: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Any time</option>
              {ADDED_OPTIONS.map((o) => <option key={o.days} value={String(o.days)}>{o.label}</option>)}
            </select>
          </label>

          <div className="lv-field">
            <span className="lv-field-label" id={`${id}-size`}>File size (GB)</span>
            <span className="lv-range" role="group" aria-labelledby={`${id}-size`}>
              <NumberBox label="Smallest size in GB" value={f.sizeMinGB} placeholder="min" step={0.5} onCommit={(v) => set({ sizeMinGB: v })} />
              <span aria-hidden="true">to</span>
              <NumberBox label="Largest size in GB" value={f.sizeMaxGB} placeholder="max" step={0.5} onCommit={(v) => set({ sizeMaxGB: v })} />
            </span>
          </div>

          <div className="lv-field">
            <span className="lv-field-label" id={`${id}-rt`}>Length (minutes)</span>
            <span className="lv-range" role="group" aria-labelledby={`${id}-rt`}>
              <NumberBox label="Shortest length in minutes" value={f.runtimeMin} placeholder="min" step={5} onCommit={(v) => set({ runtimeMin: v })} />
              <span aria-hidden="true">to</span>
              <NumberBox label="Longest length in minutes" value={f.runtimeMax} placeholder="max" step={5} onCommit={(v) => set({ runtimeMax: v })} />
            </span>
          </div>

          <label className="lv-field lv-field-wide">
            <span className="lv-field-label">Actor <span className="lv-field-hint">cast lists are looked up as needed</span></span>
            <PersonBox value={f.person} onCommit={(v) => set({ person: v })} />
          </label>

          {options && options.marksAvailable === false && (f.watched !== 'any' || f.inProgress) ? (
            <p className="lv-note" role="status">Watched marks are not available here (viewing privacy is on, or nobody has signed up), so the watched and progress filters are ignored.</p>
          ) : null}

          <div className="lv-panel-foot">
            <button type="button" className="lv-btn" disabled={count === 0} onClick={() => onChange(normalizeFilters(null))}>Clear all</button>
            <button type="button" className="lv-btn is-primary" onClick={() => pop.close(true)}>Done</button>
          </div>
        </div>
      )}
    </span>
  )
}

// --------------------------------------------------------------------------- filter chips

/** The strip of switched-on filters, each removable. */
export function FilterChips({ filters, onChange }) {
  const chips = describeFilters(filters)
  if (chips.length === 0) return null
  return (
    <ul className="lv-active" aria-label="Active filters">
      {chips.map((c) => (
        <li key={c.key}>
          <button type="button" className="lv-active-chip" title={`Remove: ${c.label}`} onClick={() => onChange(clearFilterKey(filters, c.key))}>
            <span>{c.label}</span>
            <span className="lv-x" aria-hidden="true">x</span>
            <span className="lv-sr">remove filter</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

// --------------------------------------------------------------------------- saved views

async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true }
  } catch { /* fall through */ }
  return false
}

export function SavedViewsMenu({ view }) {
  const pop = usePopover(380)
  const id = useId()
  const [name, setName] = useState('')
  const [renaming, setRenaming] = useState(null) // { id, text }
  const [deleting, setDeleting] = useState(null)
  const [importText, setImportText] = useState('')
  const [shareText, setShareText] = useState('')
  const [message, setMessage] = useState('')
  const active = view.saved.find((v) => v.id === view.active)

  useEffect(() => {
    if (!pop.open) { setRenaming(null); setDeleting(null); setMessage(''); setShareText('') }
  }, [pop.open])

  const save = () => {
    const label = name.trim()
    if (!label) { setMessage('Give the view a name first.'); return }
    view.saveAs(label)
    setName('')
    setMessage(`Saved "${label}".`)
  }
  const share = async (v) => {
    const text = view.exportText(v.id)
    if (!text) return
    setShareText(text)
    setMessage((await copyText(text)) ? `Copied "${v.name}". Paste it to someone to share it.` : 'Select the text below and copy it to share this view.')
  }
  const doImport = () => {
    const res = view.importText(importText)
    if (res.ok) { setImportText(''); setMessage(`Added "${res.name}" and switched to it.`) } else setMessage(res.error)
  }
  const commitRename = () => {
    if (renaming) view.renameView(renaming.id, renaming.text)
    setRenaming(null)
  }

  return (
    <span className="lv-menu-wrap" onKeyDown={contain}>
      <button
        ref={pop.buttonRef}
        type="button"
        className={`subtab genre-chip lv-button ${active ? 'is-on' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={pop.open}
        aria-controls={pop.open ? `${id}-panel` : undefined}
        title="Save the current view and filters under a name, or open one you saved"
        onClick={pop.toggle}
      >
        <svg viewBox="0 0 24 24" className="nav-icon lv-icon" aria-hidden="true"><path d="M6 4h12v16l-6-4-6 4z" /></svg>
        <span className="lv-button-label">{active ? active.name : 'Saved views'}{active && view.modified ? ' *' : ''}</span>
      </button>
      {pop.open && (
        <div ref={pop.panelRef} id={`${id}-panel`} className="lv-popover lv-saved-panel" role="dialog" aria-label="Saved views" style={{ left: pop.place.left, top: pop.place.top, width: 380, maxHeight: `calc(100vh - ${pop.place.top + 16}px)` }}>
          {view.saved.length === 0 ? <p className="lv-note">Nothing saved yet. Set up the view and filters you like, then save them here.</p> : (
            <ul className="lv-saved-list">
              {view.saved.map((v) => (
                <li key={v.id} className={`lv-saved-item ${v.id === view.active ? 'is-active' : ''}`}>
                  {renaming && renaming.id === v.id ? (
                    <span className="lv-inline-edit">
                      <input
                        type="text"
                        className="lv-text"
                        aria-label={`New name for ${v.name}`}
                        maxLength={60}
                        autoFocus
                        value={renaming.text}
                        onChange={(e) => setRenaming({ id: v.id, text: e.target.value })}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitRename() } else if (e.key === 'Escape') { e.stopPropagation(); setRenaming(null) } }}
                      />
                      <button type="button" className="lv-btn" onClick={commitRename}>Save</button>
                    </span>
                  ) : deleting === v.id ? (
                    <span className="lv-inline-edit">
                      <span>Delete "{v.name}"?</span>
                      <button type="button" className="lv-btn is-danger" onClick={() => { view.deleteView(v.id); setDeleting(null) }}>Delete</button>
                      <button type="button" className="lv-btn" onClick={() => setDeleting(null)}>Keep</button>
                    </span>
                  ) : (
                    <>
                      <button type="button" className="lv-saved-apply" aria-pressed={v.id === view.active} onClick={() => { view.applyView(v.id); pop.close(true) }}>
                        {v.name}{v.id === view.active && view.modified ? ' (changed)' : ''}
                      </button>
                      <button type="button" className="lv-btn" aria-label={`Share ${v.name}`} onClick={() => share(v)}>Share</button>
                      <button type="button" className="lv-btn" aria-label={`Rename ${v.name}`} onClick={() => setRenaming({ id: v.id, text: v.name })}>Rename</button>
                      <button type="button" className="lv-btn" aria-label={`Delete ${v.name}`} onClick={() => setDeleting(v.id)}>Delete</button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}

          {active && view.modified ? (
            <button type="button" className="lv-btn is-primary lv-wide" onClick={() => { view.updateView(); setMessage(`Updated "${active.name}".`) }}>Update "{active.name}" with what is on screen</button>
          ) : null}

          <div className="lv-save-row">
            <input
              type="text"
              className="lv-text"
              aria-label="Name for the current view"
              placeholder="Name this view"
              maxLength={60}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save() } }}
            />
            <button type="button" className="lv-btn is-primary" onClick={save}>Save</button>
          </div>

          <details className="lv-import">
            <summary>Import a shared view</summary>
            <textarea className="lv-text" rows={3} aria-label="Shared view text" placeholder="Paste a shared view here" value={importText} onChange={(e) => setImportText(e.target.value)} />
            <button type="button" className="lv-btn" disabled={!importText.trim()} onClick={doImport}>Import</button>
          </details>

          {shareText ? <textarea className="lv-text lv-share-text" readOnly rows={3} aria-label="Shared view text to copy" value={shareText} onFocus={(e) => e.currentTarget.select()} /> : null}
          <p className="lv-note" role="status" aria-live="polite">{message}</p>
        </div>
      )}
    </span>
  )
}

/** The three controls together, ready to drop into the toolbar row. Also owns the Alt+1 ... Alt+7 shortcuts. */
export default function LibraryViewControls({ view, options, onNeedOptions }) {
  const wrapRef = useRef(null)
  const setMode = view.setMode
  useEffect(() => {
    const onKey = (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      const m = /^(?:Digit|Numpad)([1-7])$/.exec(e.code || '')
      if (!m) return
      // Only while this screen is showing (its toolbar is hidden behind a details page or another tab otherwise).
      if (!wrapRef.current || wrapRef.current.offsetParent === null) return
      e.preventDefault()
      setMode(VIEW_MODES[Number(m[1]) - 1].id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setMode])
  return (
    <span className="lv-controls" ref={wrapRef}>
      <ViewSwitcher mode={view.mode} onChange={view.setMode} />
      <FilterMenu filters={view.filters} onChange={view.setFilters} options={options} onOpen={onNeedOptions} />
      <SavedViewsMenu view={view} />
    </span>
  )
}
