import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { applyRenderSpec, fullOrder, fullShelves, moveEntry, moveTo, reorderWithin } from '../lib/profileApply.js'
import { adoptProfile } from '../lib/profileStore.js'
import { useI18n } from '../lib/i18nApp.js'

// Settings > Appearance: the owner's per-user layout, theme and accessibility profile.
//
// Everything here is DATA the main process validates (electron/prefsStore.js): the editor only sends choices
// from closed lists, and every change previews live on the whole app before it is saved. Reordering works with
// buttons and the keyboard (Alt+Up / Alt+Down on a row); dragging is an extra, never the only way.
// Every visible string goes through the i18n layer (appearance.* in src/locales). Messages that come back from the
// main process's validator (errors[]) are shown as they are.

const DEFAULT_LAYOUT = {
  pack: null, density: 'comfortable', cardStyle: 'classic', radius: null, posterAspect: '2:3', fontScale: 1,
  sidebar: { mode: 'pinned', order: [], hidden: [] },
  home: { shelves: [] }
}
const box = { border: '1px solid var(--line, #2a2f3a)', borderRadius: 8, padding: '12px 14px', margin: '12px 0' }
const small = { color: 'var(--muted)', fontSize: 12, margin: '4px 0 8px' }

const layoutFrom = (effective) => {
  const l = effective.layout
  return {
    pack: l.pack || null, density: l.density, cardStyle: l.cardStyle, radius: l.radius, posterAspect: l.posterAspect, fontScale: l.fontScale,
    sidebar: { mode: l.sidebar.mode, order: l.sidebar.order.slice(), hidden: l.sidebar.hidden.slice() },
    home: { shelves: l.home.shelves.map((r) => ({ id: r.id, on: r.on })) }
  }
}

const firstError = (res, fallback) => (res && res.errors && res.errors[0]) || fallback

function ReorderList({ id, title, hint, rows, onMove, onToggle, onDrop, announce, t }) {
  // `announce` is { id, text }: only the list that was just changed speaks, so a screen reader hears each move once.
  const drag = useRef(null)
  const focusKey = useRef(null)
  useEffect(() => {
    if (!focusKey.current) return
    const el = document.getElementById(focusKey.current)
    focusKey.current = null
    if (el) el.focus()
  })
  const move = (index, delta, dir) => { focusKey.current = `${id}-${rows[index].id}-${dir}`; onMove(index, delta) }
  return (
    <fieldset style={{ ...box, minInlineSize: 0 }}>
      <legend style={{ padding: '0 6px' }}>{title}</legend>
      <p style={small} id={`${id}-hint`}>{hint}</p>
      <ul aria-describedby={`${id}-hint`} style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {rows.map((row, index) => (
          <li
            key={row.id}
            draggable
            onDragStart={(e) => { drag.current = index; try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', row.id) } catch { /* some engines need data set */ } }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); if (drag.current !== null && drag.current !== index) onDrop(drag.current, index); drag.current = null }}
            onKeyDown={(e) => {
              if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
              e.preventDefault()
              move(index, e.key === 'ArrowUp' ? -1 : 1, e.key === 'ArrowUp' ? 'up' : 'down')
            }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderTop: index ? '1px solid var(--line, #2a2f3a)' : 'none' }}
          >
            <span aria-hidden="true" title={t('appearance.dragHint')} style={{ cursor: 'grab', color: 'var(--muted)' }}>{'⠇'}</span>
            <label style={{ flex: 1, display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={row.on} disabled={row.locked} onChange={() => onToggle(index)} aria-label={t('appearance.show', { label: row.label })} />
              <span>{row.label}{row.locked ? ' ' + t('appearance.alwaysShown') : ''}{row.both ? <em style={{ color: 'var(--muted)', fontSize: 11 }}> {t('appearance.tagBoth')}</em> : null}</span>
            </label>
            <button type="button" id={`${id}-${row.id}-up`} aria-label={t('appearance.moveUp', { label: row.label })} disabled={index === 0} onClick={() => move(index, -1, 'up')}>{'↑'}</button>
            <button type="button" id={`${id}-${row.id}-down`} aria-label={t('appearance.moveDown', { label: row.label })} disabled={index === rows.length - 1} onClick={() => move(index, 1, 'down')}>{'↓'}</button>
          </li>
        ))}
      </ul>
      <div className="sr-only" role="status" aria-live="polite" style={{ position: 'absolute', left: -9999 }}>{announce && announce.id === id ? announce.text : ''}</div>
    </fieldset>
  )
}

export default function AppearanceSettings() {
  const { t, tOr } = useI18n()
  const api = typeof window !== 'undefined' ? window.beeboentertainment : null
  const [state, setState] = useState(null)
  const [draft, setDraft] = useState(null)
  const [access, setAccess] = useState(null)
  const [orderTouched, setOrderTouched] = useState(false)
  const [view, setView] = useState('app') // which sidebar the list shows: app | site
  const [msg, setMsg] = useState({ text: '', bad: false })
  const [announce, setAnnounce] = useState(null)
  const [busy, setBusy] = useState(false)
  const [themePick, setThemePick] = useState(null)
  const [themeCheck, setThemeCheck] = useState(null)
  const [imp, setImp] = useState(null)
  const savedSpec = useRef(null)
  const dirty = useRef(false)
  const timer = useRef(null)

  const call = useCallback((op, arg) => (api && api.prefsCall ? api.prefsCall(op, arg) : Promise.resolve({ ok: false, errors: ['Preferences are not available here.'] })), [api])
  const say = (text, bad = false) => setMsg({ text, bad })

  const load = useCallback(async () => {
    const res = await call('get')
    if (!res || !res.ok) { say(firstError(res, t('appearance.loadError')), true); return }
    setState(res)
    setDraft(layoutFrom(res.effective))
    setAccess({ reduceMotion: res.effective.access.reduceMotion, largeText: res.effective.access.largeText })
    setOrderTouched(res.effective.layout.sidebar.order.length > 0)
    savedSpec.current = res.render
    dirty.current = false
    const chk = await call('themeCheck', { preset: res.effective.theme.preset, custom: res.effective.theme.custom })
    setThemeCheck(chk && chk.ok ? chk : null)
  }, [call, t])

  useEffect(() => { load() }, [load])

  // Leaving the page with unsaved changes puts the saved look back.
  useEffect(() => () => {
    clearTimeout(timer.current)
    if (dirty.current && savedSpec.current) applyRenderSpec(savedSpec.current, document.documentElement)
  }, [])

  const items = state ? state.schema.navItems : []
  const ids = useMemo(() => items.map((n) => n.id), [items])
  const locked = useMemo(() => new Set(state ? state.schema.lockedNav : []), [state])
  const payload = (d, a, touched) => ({
    layout: {
      pack: d.pack, density: d.density, cardStyle: d.cardStyle, radius: d.radius, posterAspect: d.posterAspect, fontScale: d.fontScale,
      sidebar: { mode: d.sidebar.mode, order: touched ? d.sidebar.order : [], hidden: d.sidebar.hidden.filter((id) => !locked.has(id)) },
      home: { shelves: d.home.shelves }
    },
    access: a
  })

  const schedulePreview = (d, a, touched) => {
    dirty.current = true
    clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      const res = await call('preview', payload(d, a, touched))
      if (res && res.ok && res.spec) applyRenderSpec(res.spec, document.documentElement)
      else if (res && res.errors) say(res.errors[0], true)
    }, 120)
  }

  const edit = (fn, { touchOrder = false, keepPack = false } = {}) => {
    const next = fn(JSON.parse(JSON.stringify(draft)))
    if (!keepPack) next.pack = null // any manual change means it is no longer exactly that pack
    const touched = orderTouched || touchOrder
    if (touchOrder) setOrderTouched(true)
    setDraft(next)
    schedulePreview(next, access, touched)
  }
  const editAccess = (patch) => {
    const next = { ...access, ...patch }
    setAccess(next)
    schedulePreview(draft, next, orderTouched)
  }

  if (!state || !draft || !access) {
    return <div id="appearance-settings" style={box}><h3 style={{ marginTop: 0 }}>{t('appearance.title')}</h3><p style={small} role="status">{msg.text || t('common.loading')}</p></div>
  }

  const layoutPacks = state.packs.layout
  const themePacks = state.packs.theme
  const shelfName = (id) => tOr(`appearance.shelf.${id}`, id)
  const navLabel = Object.fromEntries(items.map((n) => [n.id, tOr(`nav.${n.id}`, n.label)]))
  const surfaceOf = Object.fromEntries(items.map((n) => [n.id, n.surfaces]))
  const moved = (label, position, total) => t('appearance.moved', { label, position, total })

  // ---- sidebar list (filtered by surface, reordering only permutes the shown slots) ----------------------
  const fullNav = fullOrder(ids, draft.sidebar.order)
  const surface = view === 'app' ? 'desktop' : 'web'
  const shown = fullNav.filter((id) => surfaceOf[id].includes(surface))
  const hidden = new Set(draft.sidebar.hidden)
  const navRows = shown.map((id) => ({ id, label: navLabel[id], on: !hidden.has(id) || locked.has(id), locked: locked.has(id), both: surfaceOf[id].length === 2 }))
  const moveNav = (index, delta) => {
    const nextOrder = reorderWithin(fullNav, shown, index, index + delta)
    edit((d) => { d.sidebar.order = nextOrder; return d }, { touchOrder: true })
    setAnnounce({ id: 'prefs-nav', text: moved(navLabel[shown[index]], index + delta + 1, shown.length) })
  }
  const dropNav = (from, to) => {
    edit((d) => { d.sidebar.order = reorderWithin(fullNav, shown, from, to); return d }, { touchOrder: true })
    setAnnounce({ id: 'prefs-nav', text: moved(navLabel[shown[from]], to + 1, shown.length) })
  }
  const toggleNav = (index) => edit((d) => {
    const id = shown[index]
    d.sidebar.hidden = hidden.has(id) ? d.sidebar.hidden.filter((x) => x !== id) : d.sidebar.hidden.concat(id)
    d.sidebar.order = fullNav
    return d
  }, { touchOrder: false })

  // ---- home shelves ---------------------------------------------------------------------------------------
  const shelves = fullShelves(state.schema.shelves.map((s) => s.id), draft.home.shelves)
  const shelfRows = shelves.map((r) => ({ id: r.id, label: shelfName(r.id), on: r.on }))
  const setShelves = (next, note) => { edit((d) => { d.home.shelves = next; return d }); if (note) setAnnounce({ id: 'prefs-shelves', text: note }) }

  const chooseLayoutPack = (p) => {
    const c = p.content
    const next = {
      pack: { id: p.id, ver: p.version },
      density: c.density || DEFAULT_LAYOUT.density, cardStyle: c.cardStyle || DEFAULT_LAYOUT.cardStyle,
      radius: c.radius === undefined ? null : c.radius, posterAspect: c.posterAspect || DEFAULT_LAYOUT.posterAspect,
      fontScale: c.fontScale || 1,
      sidebar: { mode: (c.sidebar && c.sidebar.mode) || 'pinned', order: (c.sidebar && c.sidebar.order) || [], hidden: (c.sidebar && c.sidebar.hidden) || [] },
      home: { shelves: (c.home && c.home.shelves) || [] }
    }
    const touched = next.sidebar.order.length > 0
    setOrderTouched(touched)
    setDraft(next)
    schedulePreview(next, access, touched)
    say(t('appearance.previewingPack', { name: p.name }))
  }

  const save = async () => {
    setBusy(true)
    const res = await call('patch', { ...payload(draft, access, orderTouched), ifMatch: state.rev })
    setBusy(false)
    if (res && res.ok) { dirty.current = false; adoptProfile(res); setState(res); savedSpec.current = res.render; say(t('appearance.saved')) }
    else if (res && res.error === 'conflict') { say(t('appearance.conflict'), true); load() }
    else say(firstError(res, t('appearance.saveFail')), true)
  }
  const revert = async () => { await load(); if (savedSpec.current) applyRenderSpec(savedSpec.current, document.documentElement); say(t('appearance.discarded')) }
  const reset = async () => {
    if (typeof window !== 'undefined' && !window.confirm(t('appearance.resetConfirm'))) return
    setBusy(true)
    const res = await call('reset', { section: 'all' })
    setBusy(false)
    if (res && res.ok) { adoptProfile(res); await load(); say(t('appearance.resetDone')) } else say(firstError(res, t('appearance.resetFail')), true)
  }
  const exportFile = async () => {
    const res = await call('exportFile')
    if (res && res.ok) say(t('appearance.exported'))
    else if (!res || !res.canceled) say(firstError(res, t('appearance.exportFail')), true)
  }
  const importPick = async () => {
    const res = await call('importPick')
    if (res && res.ok) setImp({ file: res.file, name: res.fileName, kind: res.kind, diff: res.diff || [], check: res.themeCheck || null, pack: res.pack || null })
    else if (!res || !res.canceled) say(firstError(res, t('appearance.importFail')), true)
  }
  const importApply = async (autoFix) => {
    setBusy(true)
    const res = await call('importApply', { file: imp.file, autoFix })
    setBusy(false)
    if (res && res.ok) { setImp(null); adoptProfile(res); await load(); say(t('appearance.imported')) } else say(firstError(res, t('appearance.importApplyFail')), true)
  }

  const pickTheme = async (p) => {
    setThemePick(p)
    const res = await call('themeCheck', { preset: p.scheme === 'light' ? 'daylight' : 'graphite', custom: p.vars })
    setThemeCheck(res && res.ok ? res : null)
  }
  const useTheme = async (autoFix) => {
    setBusy(true)
    const res = await call('pack', { kind: 'theme', id: themePick.id, autoFix })
    setBusy(false)
    if (res && res.ok) { adoptProfile(res); const name = themePick.name; setThemePick(null); await load(); say(t('appearance.themeApplied', { name })) } else say(firstError(res, t('appearance.themeApplyFail')), true)
  }
  const fixCurrentTheme = async () => {
    setBusy(true)
    const res = await call('patch', { theme: { custom: themeCheck.fixedVars }, ifMatch: state.rev })
    setBusy(false)
    if (res && res.ok) { adoptProfile(res); await load(); say(t('appearance.fixed')) } else say(firstError(res, t('appearance.fixFail')), true)
  }

  const swatch = (v) => (/^#[0-9a-f]{6}$/i.test(v || '') ? v : '#808080')
  const warnings = themeCheck ? themeCheck.warnings : []
  const basePack = draft.pack ? layoutPacks.find((p) => p.id === draft.pack.id) : null

  return (
    <div id="appearance-settings" style={box}>
      <h3 style={{ marginTop: 0 }}>{t('appearance.title')}</h3>
      <p style={small}>{t('appearance.intro')}</p>

      <fieldset style={{ ...box, minInlineSize: 0 }}>
        <legend style={{ padding: '0 6px' }}>{t('appearance.layoutPacks')}</legend>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {layoutPacks.map((p) => (
            <button key={p.id} type="button" aria-pressed={!!(draft.pack && draft.pack.id === p.id)} title={p.description} onClick={() => chooseLayoutPack(p)}>{p.name}</button>
          ))}
        </div>
        <p style={small}>{draft.pack ? t('appearance.packBasedOn', { name: (basePack || { name: draft.pack.id }).name }) : t('appearance.packCustom')}</p>
      </fieldset>

      <fieldset style={{ ...box, minInlineSize: 0 }}>
        <legend style={{ padding: '0 6px' }}>{t('appearance.lookTitle')}</legend>
        <div role="radiogroup" aria-label={t('appearance.density.label')} style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {state.schema.densities.map((d) => (
            <label key={d}><input type="radio" name="prefs-density" checked={draft.density === d} onChange={() => edit((x) => { x.density = d; return x })} /> {t(`appearance.density.${d}`)}</label>
          ))}
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <label htmlFor="prefs-card">{t('appearance.cardStyle.label')}</label>
          <select id="prefs-card" value={draft.cardStyle} onChange={(e) => edit((x) => { x.cardStyle = e.target.value; return x })}>
            {state.schema.cardStyles.map((c) => <option key={c} value={c}>{t(`appearance.cardStyle.${c}`)}</option>)}
          </select>
          <label htmlFor="prefs-aspect">{t('appearance.posterShape')}</label>
          <select id="prefs-aspect" value={draft.posterAspect} onChange={(e) => edit((x) => { x.posterAspect = e.target.value; return x })}>
            {state.schema.posterAspects.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="row">
          <label htmlFor="prefs-radius">{t('appearance.radius')}</label>
          <input id="prefs-radius" type="range" min={state.schema.limits.radius[0]} max={state.schema.limits.radius[1]} step="1" value={draft.radius === null ? 12 : draft.radius} disabled={draft.radius === null} onChange={(e) => edit((x) => { x.radius = Number(e.target.value); return x })} aria-valuetext={draft.radius === null ? t('appearance.radiusThemeValue') : t('appearance.radiusPx', { px: draft.radius })} />
          <label><input type="checkbox" checked={draft.radius === null} onChange={(e) => edit((x) => { x.radius = e.target.checked ? null : 12; return x })} /> {t('appearance.radiusTheme')}</label>
        </div>
        <div className="row">
          <label htmlFor="prefs-font">{t('appearance.textSize', { size: `${Math.round(draft.fontScale * 100)}%` })}</label>
          <input id="prefs-font" type="range" min={state.schema.limits.fontScale[0]} max={state.schema.limits.fontScale[1]} step="0.05" value={draft.fontScale} onChange={(e) => edit((x) => { x.fontScale = Number(e.target.value); return x })} />
        </div>
      </fieldset>

      <fieldset style={{ ...box, minInlineSize: 0 }}>
        <legend style={{ padding: '0 6px' }}>{t('appearance.a11yTitle')}</legend>
        <div className="row">
          <label htmlFor="prefs-motion">{t('appearance.motion.label')}</label>
          <select id="prefs-motion" value={access.reduceMotion} onChange={(e) => editAccess({ reduceMotion: e.target.value })}>
            {state.schema.motion.map((m) => <option key={m} value={m}>{t(`appearance.motion.${m}`)}</option>)}
          </select>
        </div>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={access.largeText} onChange={(e) => editAccess({ largeText: e.target.checked })} /> {t('appearance.largeText')}
        </label>
        <p style={small}>{t('appearance.a11yHint')}</p>
      </fieldset>

      <ReorderList
        id="prefs-shelves" title={t('appearance.shelvesTitle')} hint={t('appearance.shelvesHint')} t={t}
        rows={shelfRows} announce={announce}
        onMove={(i, delta) => setShelves(moveEntry(shelves, i, delta), moved(shelfRows[i].label, i + delta + 1, shelves.length))}
        onDrop={(from, to) => setShelves(moveTo(shelves, from, to), moved(shelfRows[from].label, to + 1, shelves.length))}
        onToggle={(i) => setShelves(shelves.map((r, k) => (k === i ? { ...r, on: !r.on } : r)))}
      />

      <div role="radiogroup" aria-label={t('appearance.sidebarChoice')} style={{ display: 'flex', gap: 12, margin: '4px 0' }}>
        <label><input type="radio" name="prefs-sidebar-view" checked={view === 'app'} onChange={() => setView('app')} /> {t('appearance.sidebarApp')}</label>
        <label><input type="radio" name="prefs-sidebar-view" checked={view === 'site'} onChange={() => setView('site')} /> {t('appearance.sidebarSite')}</label>
      </div>
      <ReorderList
        id="prefs-nav" title={view === 'app' ? t('appearance.navTitleApp') : t('appearance.navTitleSite')} hint={t('appearance.navHint')} t={t}
        rows={navRows} announce={announce} onMove={moveNav} onDrop={dropNav} onToggle={toggleNav}
      />

      <fieldset style={{ ...box, minInlineSize: 0 }}>
        <legend style={{ padding: '0 6px' }}>{t('appearance.themeTitle')}</legend>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {themePacks.map((p) => (
            <button key={p.id} type="button" aria-pressed={!!(state.effective.theme.pack && state.effective.theme.pack.id === p.id) || (themePick && themePick.id === p.id)} title={p.description} onClick={() => pickTheme(p)}>{p.name}</button>
          ))}
        </div>
        {themePick && (
          <div style={{ marginTop: 10 }}>
            <div aria-hidden="true" style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
              {['--bg', '--panel', '--text', '--muted', '--accent-grad-1', '--gold'].map((k) => (
                <span key={k} style={{ width: 24, height: 24, borderRadius: 6, border: '1px solid #808080', background: swatch(themePick.vars[k]) }} />
              ))}
            </div>
            <p style={small}>{themePick.description}</p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="primary" disabled={busy} onClick={() => useTheme(false)}>{t('appearance.useTheme')}</button>
              {warnings.length > 0 && themeCheck.fixable && <button type="button" disabled={busy} onClick={() => useTheme(true)}>{t('appearance.useThemeFix')}</button>}
              <button type="button" disabled={busy} onClick={() => { setThemePick(null); load() }}>{t('common.cancel')}</button>
            </div>
          </div>
        )}
        <div role="status" aria-live="polite" style={{ marginTop: 10, fontSize: 13 }}>
          {themeCheck && !warnings.length && <span>{t('appearance.contrastOk', { count: themeCheck.checked })}</span>}
          {themeCheck && warnings.length > 0 && (
            <div>
              <strong>{t('appearance.contrastBad', { count: warnings.length })}</strong>
              <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
                {warnings.slice(0, 6).map((w) => <li key={w.fg + w.bg}>{t('appearance.contrastLine', { what: w.what, ratio: w.ratio, min: w.min })}</li>)}
                {warnings.length > 6 && <li>{t('appearance.andMore', { count: warnings.length - 6 })}</li>}
              </ul>
              {!themePick && themeCheck.fixable && <button type="button" disabled={busy} onClick={fixCurrentTheme}>{t('appearance.fixAuto')}</button>}
              {!themeCheck.fixable && <span style={small}>{t('appearance.cannotFix')}</span>}
            </div>
          )}
        </div>
      </fieldset>

      <fieldset style={{ ...box, minInlineSize: 0 }}>
        <legend style={{ padding: '0 6px' }}>{t('appearance.previewTitle')}</legend>
        <div className="prefs-preview" aria-hidden="true">
          <div className="prefs-preview-nav">{navRows.filter((r) => r.on).slice(0, 5).map((r) => <span key={r.id}>{r.label}</span>)}</div>
          <div className="prefs-preview-main">
            {shelfRows.filter((r) => r.on).slice(0, 3).map((r) => (
              <div key={r.id} className="prefs-preview-shelf">
                <div className="prefs-preview-title">{r.label}</div>
                <div className="prefs-preview-row">{[0, 1, 2, 3].map((n) => <div key={n} className="prefs-preview-tile"><div className="prefs-preview-poster" /><span>{t('appearance.previewTile')}</span></div>)}</div>
              </div>
            ))}
          </div>
        </div>
        <p style={small}>{t('appearance.previewHint')}</p>
      </fieldset>

      {imp && (
        <div style={{ ...box, borderColor: 'var(--accent, #4f9dff)' }} role="region" aria-label={t('appearance.importRegion')}>
          <strong>{imp.kind === 'profile' ? t('appearance.importHeadProfile', { file: imp.name }) : t('appearance.importHeadPack', { name: imp.pack ? imp.pack.name : '', file: imp.name })}</strong>
          <p style={small}>{imp.diff.length ? t('appearance.importChanges', { count: imp.diff.length }) : t('appearance.importNoChange')}</p>
          {imp.diff.length > 0 && <ul style={{ margin: '0 0 8px', paddingLeft: 18, fontSize: 12 }}>{imp.diff.slice(0, 8).map((d) => <li key={d.path}>{d.path}</li>)}{imp.diff.length > 8 && <li>{t('appearance.andMore', { count: imp.diff.length - 8 })}</li>}</ul>}
          {imp.check && imp.check.warnings.length > 0 && <p style={small}>{t('appearance.contrastBad', { count: imp.check.warnings.length })}{imp.check.fixable ? ' ' + t('appearance.canFix') : ''}</p>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="primary" disabled={busy} onClick={() => importApply(false)}>{t('appearance.apply')}</button>
            {imp.check && imp.check.warnings.length > 0 && imp.check.fixable && <button type="button" disabled={busy} onClick={() => importApply(true)}>{t('appearance.applyFix')}</button>}
            <button type="button" disabled={busy} onClick={() => setImp(null)}>{t('common.cancel')}</button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
        <button type="button" className="primary" disabled={busy} onClick={save}>{t('appearance.save')}</button>
        <button type="button" disabled={busy} onClick={revert}>{t('appearance.discard')}</button>
        <button type="button" disabled={busy} onClick={exportFile}>{t('appearance.export')}</button>
        <button type="button" disabled={busy} onClick={importPick}>{t('appearance.import')}</button>
        <button type="button" disabled={busy} onClick={reset}>{t('appearance.reset')}</button>
      </div>
      <div role="status" aria-live="polite" style={{ marginTop: 8, fontSize: 13, color: msg.bad ? '#ff9d9d' : 'var(--muted)' }}>{msg.text}</div>
    </div>
  )
}
