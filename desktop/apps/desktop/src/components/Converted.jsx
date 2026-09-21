import React, { useEffect, useState } from 'react'
import { startPoll } from '../lib/poll.js'

// Files that couldn't play (or couldn't cast) on someone's device get flagged
// by the player page and automatically converted to a streaming-friendly MP4
// next to the original — see electron/convert.js. This tab is where the owner
// compares the two copies and decides which one to keep: watch both, then
// either delete the old original (frees the space) or delete the new copy (if
// the conversion looks worse — that also stops it being auto-converted again).

const fileName = (p) => (p ? String(p).split(/[\\/]/).pop() : '')

// One decimal in GB/MB, matching the sizes shown elsewhere in the app closely
// enough to read the same, but a touch more precise so a small saving is still
// visible ("1.4 GB" / "780.0 MB").
function fmtBytes(n) {
  if (!n || n < 0) return '—'
  const mb = n / (1024 * 1024)
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`
}

const STATUS_COLORS = {
  done: '#4caf50',
  error: '#ff9d9d',
  converting: 'var(--accent)',
  rejected: '#ffb37a',
  skipped: 'var(--muted)',
  queued: 'var(--muted)'
}

function statusLabel(c) {
  if (c.status === 'converting') return `converting ${c.progressPct || 0}%`
  if (c.status === 'skipped') return 'skipped (already compatible)'
  if (c.status === 'rejected') return 'rejected'
  if (c.status === 'not-needed') return 'plays as it is'
  if (c.status === 'dont-convert') return "won't convert"
  return c.status
}

const PARKED = ['not-needed', 'dont-convert']

export default function Converted() {
  const [allConversions, setConversions] = useState([])
  const conversions = allConversions.filter((c) => !PARKED.includes(c.status))
  const parked = allConversions.filter((c) => PARKED.includes(c.status))
  const [summary, setSummary] = useState(null)
  useEffect(() => {
    window.beeboentertainment.convertRulesSummary?.().then((s) => setSummary(s || null)).catch(() => {})
  }, [])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  // Polled every ~3s while the tab is mounted (same live-view pattern as the
  // conversions list that used to live in Settings) so a running conversion's
  // % ticks along without a manual refresh.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const list = await window.beeboentertainment.convertList()
        if (!cancelled && Array.isArray(list)) {
          setConversions(list)
          setLoading(false)
        }
      } catch {
        /* ignore */
      }
    }
    load()
    const stopPoll = startPoll(load, 3000)
    return () => {
      cancelled = true
      stopPoll()
    }
  }, [])

  const applyResult = (result) => {
    if (Array.isArray(result)) {
      setConversions(result)
      return true
    }
    if (Array.isArray(result?.conversions)) setConversions(result.conversions)
    return !!result?.ok
  }

  const play = async (filePath) => {
    setError('')
    const result = await window.beeboentertainment.convertPlayFile(filePath)
    if (result && result.ok === false) {
      setError(
        result.error === 'file_missing'
          ? `That file isn't there any more: ${fileName(filePath)}`
          : `Couldn't open ${fileName(filePath)}: ${result.error || 'unknown error'}`
      )
    }
  }

  const deleteOriginal = async (c) => {
    if (
      !window.confirm(
        `Delete the ORIGINAL file?\n\n${c.originalPath}\n\nThe converted copy "${fileName(c.outputPath)}" is kept and becomes the only copy. ` +
          `Make sure you've watched it and you're happy with the quality — this frees ${fmtBytes(c.originalBytes)} and can't be undone.`
      )
    ) {
      return
    }
    setBusy(c.id)
    setError('')
    const result = await window.beeboentertainment.convertDeleteOriginal(c.id)
    setBusy('')
    if (!applyResult(result)) setError(`Couldn't delete the original: ${result?.error || 'unknown error'}`)
  }

  const deleteConverted = async (c) => {
    if (
      !window.confirm(
        `Delete the CONVERTED copy?\n\n${c.outputPath}\n\nThe original "${fileName(c.originalPath)}" stays exactly where it is — only the new copy is removed. ` +
          `This file will NOT be converted again automatically (you can start it again from this tab whenever you want). This can't be undone.`
      )
    ) {
      return
    }
    setBusy(c.id)
    setError('')
    const result = await window.beeboentertainment.convertDeleteConverted(c.id)
    setBusy('')
    if (!applyResult(result)) setError(`Couldn't delete the converted copy: ${result?.error || 'unknown error'}`)
  }

  const retry = async (c) => {
    setError('')
    const result = await window.beeboentertainment.convertRetry(c.id)
    applyResult(result)
  }

  const dontConvert = async (c) => {
    setError('')
    applyResult(await window.beeboentertainment.convertDontConvert(c.id))
  }

  const convertAnyway = async (c) => {
    setError('')
    applyResult(await window.beeboentertainment.convertAnyway(c.id))
  }

  const dismissSummary = async () => {
    setSummary(null)
    try { await window.beeboentertainment.convertDismissRulesSummary() } catch { /* ignore */ }
  }

  const forget = async (c) => {
    if (
      !window.confirm(
        `Remove "${fileName(c.originalPath)}" from this list?\n\nThis only clears the row — no files are deleted. ` +
          `If the video still fails to play on someone's device it can get converted again.`
      )
    ) {
      return
    }
    setError('')
    const result = await window.beeboentertainment.convertForget(c.id)
    applyResult(result)
  }

  // Header totals. "Reclaimable" is only the 'done' rows whose original is
  // still on disk — the decisions actually waiting on the owner.
  const convertedTotal = conversions.reduce((sum, c) => sum + (c.status === 'done' ? c.convertedBytes || 0 : 0), 0)
  const originalsTotal = conversions.reduce((sum, c) => sum + (c.originalDeleted ? 0 : c.originalBytes || 0), 0)
  const reclaimable = conversions.reduce(
    (sum, c) => sum + (c.status === 'done' && !c.originalDeleted ? c.originalBytes || 0 : 0),
    0
  )

  const statBox = (label, value, color) => (
    <div style={{ background: 'var(--surface-raised)', border: '1px solid var(--border)', borderRadius: 6, padding: '10px 14px', minWidth: 130 }}>
      <div style={{ fontSize: 11, color: 'var(--muted)' }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 600, color: color || '#eee', marginTop: 2 }}>{value}</div>
    </div>
  )

  const playButton = (label, filePath, available, title) => (
    <button
      onClick={() => play(filePath)}
      disabled={!available}
      title={available ? title : 'That file is gone'}
      style={{
        background: 'var(--border)',
        color: available ? '#eee' : '#5a5f68',
        border: 'none',
        padding: '6px 12px',
        borderRadius: 6,
        cursor: available ? 'pointer' : 'default',
        fontSize: 12,
        opacity: available ? 1 : 0.5
      }}
    >
      ▶ Play {label}
    </button>
  )

  return (
    <div style={{ maxWidth: 860 }}>
      <h2>🎞️ Converted Videos</h2>
      <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: -8, marginBottom: 20 }}>
        Videos that couldn't play (or couldn't cast) on someone's device get converted to a streaming-friendly MP4
        next to the original — nothing is ever deleted on its own. Watch both copies here, then keep whichever one
        you want: delete the old original to get the space back, or delete the new copy if it looks worse.
      </p>

      {summary && !summary.dismissed && summary.removed > 0 && (
        <div style={{ padding: '12px 16px', marginBottom: 16, border: '1px solid #2b6b3a', borderRadius: 8, background: 'var(--surface-raised)' }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#eee' }}>
            Removed {summary.removed} file{summary.removed === 1 ? '' : 's'} that play fine as they are
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
            Beebo now looks inside each file instead of going by its extension.
            {summary.kept ? ` ${summary.kept} still need work.` : ' Nothing else needed converting.'} No file was touched.
          </div>
          <button onClick={dismissSummary} style={{ marginTop: 8, background: 'var(--border)', color: '#eee', border: 'none', padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>
            Got it
          </button>
        </div>
      )}

      {conversions.length > 0 && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 18 }}>
          {statBox('Conversions', String(conversions.length))}
          {statBox('Converted copies', fmtBytes(convertedTotal))}
          {statBox('Originals on disk', fmtBytes(originalsTotal))}
          {statBox('Could be freed', reclaimable ? fmtBytes(reclaimable) : '—', reclaimable ? '#4caf50' : 'var(--muted)')}
        </div>
      )}

      {error && <p style={{ color: '#ff9d9d', fontSize: 12, marginBottom: 10 }}>{error}</p>}

      {!loading && conversions.length === 0 && (
        <p className="empty-state">
          No conversions yet. Videos that can't play or can't cast on someone's device get converted here
          automatically.
        </p>
      )}

      {conversions.map((c) => {
        const isTv = c.kind === 'tv'
        const statusColor = STATUS_COLORS[c.status] || 'var(--muted)'
        const hasConverted = c.status === 'done'
        const originalBytes = c.originalBytes || 0
        const convertedBytes = c.convertedBytes || 0
        const diff = originalBytes && convertedBytes ? originalBytes - convertedBytes : 0
        const pctSmaller = diff > 0 && originalBytes ? Math.round((diff / originalBytes) * 100) : 0

        return (
          <div
            key={c.id}
            style={{
              padding: '12px 16px',
              marginBottom: 8,
              border: '1px solid var(--border)',
              background: 'var(--surface-raised)',
              borderRadius: 8
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: '#eee', wordBreak: 'break-all' }}>
                {fileName(c.originalPath)}
              </span>
              <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: 'var(--surface-raised)', color: 'var(--muted)' }}>
                {isTv ? '📺 TV' : '🎬 Movie'}
              </span>
              <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: 'var(--surface-raised)', color: statusColor, fontWeight: 600 }}>
                {statusLabel(c)}
              </span>
            </div>

            {/* Side-by-side old vs new, so the size difference is the first
                thing you see when deciding which copy to keep. */}
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 10 }}>
              <div style={{ flex: '1 1 240px', minWidth: 0 }}>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>Original</div>
                <div style={{ fontSize: 12, color: c.originalDeleted ? '#5a5f68' : '#eee', marginTop: 2, wordBreak: 'break-all' }}>
                  {fileName(c.originalPath)}
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                  {c.originalDeleted ? 'deleted' : fmtBytes(originalBytes)}
                </div>
                <div style={{ marginTop: 6 }}>
                  {playButton('original', c.originalPath, !c.originalDeleted, 'Open the old file in your video player')}
                </div>
              </div>
              <div style={{ flex: '1 1 240px', minWidth: 0 }}>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>Converted</div>
                <div style={{ fontSize: 12, color: hasConverted ? '#eee' : '#5a5f68', marginTop: 2, wordBreak: 'break-all' }}>
                  {fileName(c.outputPath) || '—'}
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                  {c.status === 'rejected'
                    ? 'deleted'
                    : hasConverted
                    ? fmtBytes(convertedBytes)
                    : c.status === 'converting'
                    ? `${c.progressPct || 0}% done`
                    : 'not made yet'}
                </div>
                <div style={{ marginTop: 6 }}>
                  {playButton('converted', c.outputPath, hasConverted, 'Open the new file in your video player')}
                </div>
              </div>
            </div>

            {hasConverted && convertedBytes > 0 && (
              <div style={{ fontSize: 12, marginTop: 10, color: diff > 0 ? '#4caf50' : '#ffb37a', fontWeight: 600 }}>
                {diff > 0
                  ? `Saves ${fmtBytes(diff)} (${pctSmaller}% smaller)`
                  : `New file is ${fmtBytes(Math.abs(diff))} LARGER`}
              </div>
            )}

            {c.status === 'rejected' && (
              <div style={{ fontSize: 12, marginTop: 10, color: '#ffb37a' }}>
                Converted copy deleted — original kept. It won't be converted again on its own.
              </div>
            )}

            {(c.deviceFailure || c.force || (c.plan?.reason && ['queued', 'converting'].includes(c.status))) && (
              <div style={{ fontSize: 12, marginTop: 10, color: 'var(--muted)' }}>
                {[
                  c.deviceFailure ? 'A device reported it could not play this file, so it goes first' : '',
                  c.force && !c.deviceFailure ? 'You chose "Convert anyway"' : '',
                  ['queued', 'converting'].includes(c.status) ? c.plan?.reason || '' : ''
                ].filter(Boolean).join('. ')}
              </div>
            )}

            {c.status === 'error' && c.error && (
              <div style={{ fontSize: 12, marginTop: 10, color: '#ff9d9d', wordBreak: 'break-word' }}>{c.error}</div>
            )}

            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
              <span style={{ fontSize: 11, color: 'var(--muted)', marginRight: 'auto' }}>
                {new Date(c.finishedAt || c.startedAt || c.queuedAt).toLocaleString()}
              </span>

              {c.status === 'done' && !c.originalDeleted && (
                <button
                  onClick={() => deleteOriginal(c)}
                  disabled={busy === c.id}
                  title="Delete the old file and keep the new converted copy"
                  style={{ background: '#3a1f22', color: '#ff9d9d', border: 'none', padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 12, opacity: busy === c.id ? 0.7 : 1 }}
                >
                  {busy === c.id ? 'Deleting…' : `🗑 Delete original (frees ${fmtBytes(originalBytes)})`}
                </button>
              )}
              {c.status === 'done' && (
                <button
                  onClick={() => deleteConverted(c)}
                  disabled={busy === c.id}
                  title="Delete the new copy and keep the original (it won't be converted again automatically)"
                  style={{ background: '#3a1f22', color: '#ff9d9d', border: 'none', padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 12, opacity: busy === c.id ? 0.7 : 1 }}
                >
                  🗑 Delete converted copy
                </button>
              )}
              {c.status === 'done' && c.originalDeleted && (
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>Original deleted — the converted copy is the only one left.</span>
              )}

              {(c.status === 'queued' || c.status === 'error' || c.status === 'skipped') && (
                <button
                  onClick={() => dontConvert(c)}
                  title="Leave this file as it is. Nothing automatic will queue it again."
                  style={{ background: 'var(--border)', color: '#eee', border: 'none', padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}
                >
                  Don't convert
                </button>
              )}
              {(c.status === 'error' || c.status === 'skipped' || c.status === 'rejected') && (
                <button
                  onClick={() => retry(c)}
                  style={{ background: 'var(--border)', color: '#eee', border: 'none', padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}
                >
                  {c.status === 'rejected' ? 'Convert again' : 'Retry'}
                </button>
              )}
              {(c.status === 'error' || c.status === 'skipped' || c.status === 'rejected') && (
                <button
                  onClick={() => forget(c)}
                  title="Clear this row — no files are deleted"
                  style={{ background: 'var(--border)', color: 'var(--muted)', border: 'none', padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}
                >
                  Remove from list
                </button>
              )}
            </div>
          </div>
        )
      })}

      {parked.length > 0 && (
        <details style={{ marginTop: 16, padding: '12px 16px', border: '1px solid var(--border)', borderRadius: 8 }}>
          <summary style={{ cursor: 'pointer', fontSize: 13, color: '#eee', fontWeight: 600 }}>
            Plays as it is, or you chose not to convert ({parked.length})
          </summary>
          {parked.slice(0, 300).map((c) => (
            <div key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ flex: '1 1 260px', minWidth: 0 }}>
                <div style={{ fontSize: 13, color: '#eee', wordBreak: 'break-all' }}>{fileName(c.originalPath)}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                  {c.status === 'dont-convert' ? 'You chose not to convert this' : c.notNeededReason || c.plan?.reason || 'Plays as it is'}
                </div>
              </div>
              <button
                onClick={() => convertAnyway(c)}
                title="Convert to the format every phone and TV plays, even though it looks fine"
                style={{ background: 'var(--border)', color: '#eee', border: 'none', padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}
              >
                Convert anyway
              </button>
            </div>
          ))}
        </details>
      )}
    </div>
  )
}
