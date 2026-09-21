import React, { useCallback, useEffect, useRef, useState } from 'react'
import './MediaOrganizer.css'

const PAGE = 50
const BUSY = new Set(['scanning', 'planning', 'executing'])
const labels = { idle: 'Ready when you are', scanning: 'Finding your files', ready: 'Search complete', planning: 'Preparing your review', executing: 'Organizing your files', complete: 'Finished', cancelled: 'Stopped safely', failed: 'Needs attention' }
const bytes = value => {
  if (!Number.isFinite(value) || value < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']; let unit = 0; let amount = value
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++ }
  return `${amount.toLocaleString(undefined, { maximumFractionDigits: unit ? 1 : 0 })} ${units[unit]}`
}

export default function MediaOrganizer({ onChooseFolder }) {
  const api = window.beeboentertainment?.organizer
  const [expanded, setExpanded] = useState(false)
  const [searchChanged, setSearchChanged] = useState(false)
  const [roots, setRoots] = useState([])
  const [destination, setDestination] = useState('C:\\Beebo')
  const [kinds, setKinds] = useState({ video: true, photo: true })
  const [matchPosters, setMatchPosters] = useState(false)
  const [matchingAvailable, setMatchingAvailable] = useState(false)
  const [excludeManaged, setExcludeManaged] = useState(true)
  const [matchedOnly, setMatchedOnly] = useState(false)
  const [operation, setOperation] = useState('copy')
  const [status, setStatus] = useState({ state: 'idle', total: 0, items: [], details: [] })
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState(new Set())
  const [useSelection, setUseSelection] = useState(false)
  const [review, setReview] = useState(null)
  const [reviewPage, setReviewPage] = useState({ items: [], offset: 0 })
  const [confirmed, setConfirmed] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const pollOffset = useRef(0)
  const requestSequence = useRef(0)
  const busy = pending || BUSY.has(status.state)
  const invalidate = () => { setReview(null); setConfirmed(false); setError('') }
  const invalidateSearch = () => { invalidate(); setSearchChanged(true) }
  const fail = result => { if (!result || result.ok === false) throw new Error(result?.message || 'This could not finish. Please try again.') }
  const refresh = useCallback(async (start = pollOffset.current) => {
    if (!api) return
    const sequence = ++requestSequence.current
    const result = await api.status({ offset: start, limit: PAGE })
    fail(result)
    if (sequence === requestSequence.current) setStatus(result)
  }, [api])
  useEffect(() => {
    if (!api) return
    let active = true
    api.info().then(info => { if (active && info?.ok) { setDestination(info.destination); setMatchingAvailable(info.matchingAvailable) } }).catch(() => {})
    refresh().catch(() => {})
    return () => { active = false; requestSequence.current++ }
  }, [api, refresh])
  useEffect(() => {
    if (!api || !BUSY.has(status.state)) return
    let stopped = false
    let timer
    const tick = async () => {
      try { await refresh() } catch { if (!stopped) setError('Could not read progress. Reopen this section to reconnect.') }
      if (!stopped) timer = setTimeout(tick, 1000)
    }
    timer = setTimeout(tick, 600)
    return () => { stopped = true; clearTimeout(timer) }
  }, [api, status.state, refresh])
  const run = async callback => {
    setPending(true); setError('')
    try { await callback() } catch (e) { setError(e.message || 'Please try again.') }
    finally { setPending(false) }
  }
  const pick = destinationPicker => run(async () => {
    const result = await api.pickFolders({ destination: destinationPicker }); fail(result)
    if (result.cancelled || !result.roots?.length) return
    invalidate()
    if (destinationPicker) setDestination(result.roots[0])
    else { setSearchChanged(true); setRoots(previous => [...new Set([...previous, ...result.roots])]) }
  })
  const useComputer = () => run(async () => {
    const result = await api.drives(); fail(result)
    if (!result.roots?.length) throw new Error('No local drives were found. Choose folders to search instead.')
    invalidateSearch(); setRoots(result.roots)
  })
  const startScan = () => run(async () => {
    const chosenKinds = Object.keys(kinds).filter(key => kinds[key])
    if (!roots.length) throw new Error('Choose folders or select this computer first.')
    if (!chosenKinds.length) throw new Error('Choose videos, photos, or both.')
    invalidate(); setSelected(new Set()); setUseSelection(false); setOffset(0); pollOffset.current = 0
    const result = await api.scan({ roots, kinds: chosenKinds, matchPosters, destination, excludeManaged }); fail(result)
    setSearchChanged(false)
    await refresh(0)
  })
  const setPage = start => run(async () => { setOffset(start); pollOffset.current = start; await refresh(start) })
  const toggleSelected = id => {
    invalidate()
    setSelected(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next })
  }
  const makePlan = () => run(async () => {
    setReview(null); setConfirmed(false)
    if (useSelection && !selected.size) throw new Error('Select at least one file, or choose all discovered files.')
    const result = await api.plan({ destination, matchedOnly, operation, ...(useSelection ? { selectedIds: [...selected] } : {}) }); fail(result)
    const page = await api.preview({ planId: result.planId, offset: 0, limit: PAGE }); fail(page)
    setReview(result); setReviewPage(page); setConfirmed(false)
  })
  const setReviewOffset = start => run(async () => {
    const page = await api.preview({ planId: review.planId, offset: start, limit: PAGE }); fail(page); setReviewPage(page)
  })
  const startExecution = () => run(async () => {
    if (!confirmed || !review) throw new Error('Review the plan and tick the confirmation first.')
    const result = await api.execute(review.planId); fail(result)
    setReview(null); setConfirmed(false); await refresh()
  })
  const stop = () => run(async () => { const result = await api.cancel(); fail(result); await refresh() })
  const hasMatchedVideos = (status.matched || 0) > 0 || status.items.some(item => !!item.match)
  const canReview = !searchChanged && status.total > 0 && ['ready', 'cancelled', 'complete'].includes(status.state)
  const progress = status.totalFiles ? Math.round((status.processed || 0) / status.totalFiles * 100) : 0

  return <details className="media-organizer" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary><span className="organizer-symbol" aria-hidden="true">▦</span><span><strong>Find & organize your existing files</strong><small>Optional · bring scattered videos and photos into one place</small></span><span className="organizer-summary-action">{expanded ? 'Close' : 'Set up'}</span></summary>
    <div className="organizer-body">
      <p>Choose where to look, review what Beebo finds, then copy or move the files you want. Your current library folders stay connected.</p>
      {!api ? <p role="status">This tool is available in the Beebo desktop app.</p> : <>
        <fieldset disabled={busy} className="organizer-step">
          <legend><span>1</span> Choose where to look</legend>
          <div className="organizer-actions"><button type="button" onClick={() => pick(false)}>Choose folders…</button><button type="button" onClick={useComputer}>Use this computer’s drives</button></div>
          <p className="organizer-hint">A whole-computer search can take a while. System folders, linked folders and encrypted private folders are skipped.</p>
          {roots.length > 0 && <ul className="organizer-roots">{roots.map(root => <li key={root}><code>{root}</code><button type="button" aria-label={`Remove ${root} from search`} onClick={() => { invalidateSearch(); setRoots(roots.filter(item => item !== root)) }}>Remove</button></li>)}</ul>}
          <div className="organizer-options">
            <label><input type="checkbox" checked={kinds.video} onChange={e => { invalidateSearch(); setKinds({ ...kinds, video: e.target.checked }) }} />Videos</label>
            <label><input type="checkbox" checked={kinds.photo} onChange={e => { invalidateSearch(); setKinds({ ...kinds, photo: e.target.checked }) }} />Photos</label>
            <label><input type="checkbox" checked={excludeManaged} onChange={e => { invalidateSearch(); setExcludeManaged(e.target.checked) }} />Skip folders already in my Beebo library</label>
          </div>
          <label className="organizer-check"><input type="checkbox" checked={matchPosters} disabled={!matchingAvailable} onChange={e => { invalidateSearch(); setMatchPosters(e.target.checked); if (!e.target.checked) setMatchedOnly(false) }} /><span>Look up video names and posters online<small>{matchingAvailable ? 'This sends the title parsed from each video’s filename to TMDB. Video files and photos are not uploaded.' : 'Add your TMDB key in Settings to enable matching. Local discovery works without it.'}</small></span></label>
          <button type="button" className="organizer-primary" onClick={startScan} disabled={!roots.length || (!kinds.video && !kinds.photo)}>Find my files</button>
        </fieldset>

        {status.state !== 'idle' && <div className="organizer-status" role="status" aria-live="polite">
          <div className="organizer-status-line"><strong>{labels[status.state] || status.state}</strong><span>{status.state === 'executing' || status.state === 'complete' ? `${status.processed || 0} of ${status.totalFiles || 0} files · ${bytes(status.completedBytes || 0)}` : `${status.total || 0} files found · ${bytes(status.totalBytes || 0)}`}</span></div>
          {status.state === 'executing' && <progress value={progress} max="100" aria-label="Organizing progress" />}
          {status.currentFile && <p className="organizer-current">{status.currentFile}</p>}
          {status.state === 'scanning' && matchPosters && <small>{status.matched || 0} videos matched with posters. Matching can take longer than a local search.</small>}
          {BUSY.has(status.state) && <button type="button" disabled={pending} onClick={stop}>Stop safely</button>}
          {status.truncated && <p>The search reached its safety limit. Search a smaller folder to see the remaining files.</p>}
          {status.state === 'cancelled' && <p>Completed copies stay in their destination. Files that were not moved remain in their original folders.</p>}
        </div>}

        {searchChanged && status.total > 0 && <p className="organizer-hint">Your search choices changed. Choose Find my files again to update the results.</p>}
        {canReview && <>
          <fieldset disabled={busy} className="organizer-step">
            <legend><span>2</span> Choose your files & destination</legend>
            <div className="organizer-options"><label><input type="radio" name="organizer-selection" checked={!useSelection} onChange={() => { invalidate(); setUseSelection(false) }} />All discovered files</label><label><input type="radio" name="organizer-selection" checked={useSelection} onChange={() => { invalidate(); setUseSelection(true) }} />Only selected files ({selected.size})</label></div>
            <div className="organizer-table-wrap"><table><thead><tr>{useSelection && <th scope="col">Use</th>}<th scope="col">File</th><th scope="col">Match</th><th scope="col">Size</th></tr></thead><tbody>{status.items.map(item => <tr key={item.id}>{useSelection && <td><input type="checkbox" aria-label={`Organize ${item.fileName}`} checked={selected.has(item.id)} onChange={() => toggleSelected(item.id)} /></td>}<td><strong>{item.fileName}</strong><code>{item.path}</code></td><td>{item.kind === 'photo' ? 'Photo' : item.match ? <><span className="organizer-match">Poster matched</span><small>{item.match.title}{item.match.year ? ` (${item.match.year})` : ''}</small></> : 'No poster match'}</td><td>{bytes(item.bytes)}</td></tr>)}</tbody></table></div>
            <div className="organizer-pagination"><span>{offset + 1}–{Math.min(offset + PAGE, status.total)} of {status.total}</span><button type="button" disabled={offset === 0} onClick={() => setPage(Math.max(0, offset - PAGE))}>Previous</button><button type="button" disabled={offset + PAGE >= status.total} onClick={() => setPage(offset + PAGE)}>Next</button></div>
            <label className="organizer-check"><input type="checkbox" checked={matchedOnly} disabled={!hasMatchedVideos} onChange={e => { invalidate(); setMatchedOnly(e.target.checked) }} /><span>Only organize videos matched with a poster<small>{!hasMatchedVideos ? 'Run a search with poster lookup enabled to use this filter. ' : ''}Photos are still included. Unmatched videos stay where they are. A poor filename can prevent matching; rename it and search again later.</small></span></label>
            <label className="organizer-destination">Destination folder<div><input type="text" value={destination} spellCheck="false" onChange={e => { invalidate(); setDestination(e.target.value) }} /><button type="button" onClick={() => pick(true)}>Browse…</button></div></label>
            <p className="organizer-hint">Use any writable drive or folder. Beebo creates Movies, TV Shows and Photos subfolders as needed. Photo folders use the file’s modified date.</p>
            <div className="organizer-operation"><label><input type="radio" name="organizer-operation" checked={operation === 'copy'} onChange={() => { invalidate(); setOperation('copy') }} /><span><strong>Copy files</strong><small>Recommended · keep the originals</small></span></label><label><input type="radio" name="organizer-operation" checked={operation === 'move'} onChange={() => { invalidate(); setOperation('move') }} /><span><strong>Move files</strong><small>Remove each original after its copy is verified</small></span></label></div>
            <button type="button" className="organizer-primary" onClick={makePlan}>Review organization plan</button>
          </fieldset>
          {review && <section className="organizer-review" aria-labelledby="organizer-review-title">
            <h3 id="organizer-review-title">3. Review before {review.operation === 'move' ? 'moving' : 'copying'}</h3>
            <p><strong>{review.count} {review.count === 1 ? 'file' : 'files'} · {bytes(review.bytes)}</strong> to <code>{review.destination}</code></p>
            <div className="organizer-space"><span><strong>{bytes(review.requiredBytes)}</strong> estimated free space needed</span><span>Includes {bytes(review.temporaryBytes)} for staging and 16 MB working space</span><span><strong>{review.availableBytes == null ? 'Not available' : bytes(review.availableBytes)}</strong> free at this destination</span></div>
            <ul className="organizer-warnings">{review.warnings?.map(warning => <li key={warning}>{warning}</li>)}</ul>
            {review.unmatchedSkipped > 0 && <p>{review.unmatchedSkipped} unmatched videos will stay in their original folders.</p>}
            {review.destinationSkipped > 0 && <p>{review.destinationSkipped} files already in this destination will be skipped.</p>}
            <div className="organizer-table-wrap"><table><thead><tr><th scope="col">From</th><th scope="col">To</th></tr></thead><tbody>{reviewPage.items.map(item => <tr key={item.id}><td><code>{item.source}</code></td><td><code>{item.destination}</code></td></tr>)}</tbody></table></div>
            <div className="organizer-pagination"><span>{reviewPage.offset + 1}–{Math.min(reviewPage.offset + PAGE, review.count)} of {review.count}</span><button type="button" disabled={pending || reviewPage.offset === 0} onClick={() => setReviewOffset(Math.max(0, reviewPage.offset - PAGE))}>Previous</button><button type="button" disabled={pending || reviewPage.offset + PAGE >= review.count} onClick={() => setReviewOffset(reviewPage.offset + PAGE)}>Next</button></div>
            <p>Existing files are never overwritten. Files are verified before a move removes their original. Keep this computer on until the job finishes.</p>
            <label className="organizer-check organizer-confirm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)} /><span>{review.operation === 'move' ? 'I reviewed the destinations and want to move these files. Verified originals will be removed from their current folders.' : 'I reviewed the destinations and want to copy these files. My originals will stay where they are.'}</span></label>
            <button type="button" className="organizer-primary" disabled={busy || !confirmed} onClick={startExecution}>{review.operation === 'move' ? 'Move' : 'Copy'} {review.count} {review.count === 1 ? 'file' : 'files'}</button>
          </section>}
        </>}
        {status.state === 'complete' && <div className="organizer-complete"><strong>{status.copied || 0} verified {status.copied === 1 ? 'copy' : 'copies'}{status.operation === 'move' ? ` · ${status.moved || 0} originals moved` : ''}</strong><p>Your library locations have not changed. To show these files in Beebo, choose the new Movies, TV Shows or Photos subfolder in your library settings.</p><div className="organizer-actions"><button type="button" onClick={() => run(async () => fail(await api.openDestination()))}>Open destination</button>{onChooseFolder && <><button type="button" onClick={() => onChooseFolder('moviesDir')}>Choose Movies folder…</button><button type="button" onClick={() => onChooseFolder('tvShowsDir')}>Choose TV Shows folder…</button><button type="button" onClick={() => onChooseFolder('photosDirs')}>Choose Photos folder…</button></>}</div>{status.manifestPath && <small>Job record: <code>{status.manifestPath}</code></small>}</div>}
        {status.errors > 0 && <details className="organizer-errors"><summary>{status.errors} files or folders need attention</summary><p>Review these items before trying again. No existing destination file was overwritten.</p>{status.details?.map((item, i) => <p key={i}><code>{item.path}</code><br />{item.message}</p>)}{status.errors > status.details?.length && <p>Only the first {status.details.length} issues are shown. The job record contains execution errors.</p>}</details>}
        {error && <p className="organizer-error" role="alert">{error}</p>}
      </>}
    </div>
  </details>
}
