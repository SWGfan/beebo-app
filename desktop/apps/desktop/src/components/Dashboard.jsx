import React, { useCallback, useEffect, useState } from 'react'
import { startPoll } from '../lib/poll.js'
import { formatBytes, formatBitrate, formatDuration, formatClock, timeAgo, WHERE_ICON } from '../lib/dashboardFormat.js'

// The server dashboard: who is watching what right now, what the household
// watched lately, the library and its disks, and how this computer is doing.
// All of it comes from this PC (serverDashboard.js over IPC); nothing is sent
// anywhere. The live sections refresh every 3 seconds, the heavier ones every
// minute, and only while this tab is on screen.

const ACCENT = '#4f9dff'
const panel = { background: 'var(--panel)', border: '1px solid #262b35', borderRadius: 10, padding: 16, marginBottom: 16 }
const h2 = { margin: '0 0 12px', fontSize: 16 }
const muted = { color: 'var(--muted)', fontSize: 12 }
const tileGrid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 10 }

function Tile({ label, value, detail, warn }) {
  return (
    <div style={{ background: '#11141a', border: `1px solid ${warn ? '#8a5a1a' : '#262b35'}`, borderRadius: 8, padding: '10px 12px' }}>
      <div style={muted}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, margin: '2px 0', color: '#e8e8e8' }}>{warn ? '⚠️ ' : ''}{value}</div>
      {detail && <div style={muted}>{detail}</div>}
    </div>
  )
}

function introScanValue(s) {
  if (!s.enabled) return 'Off'
  if (s.paused === 'playback' || s.paused === 'battery' || s.paused === 'busy') return 'Waiting'
  if (s.paused === 'no_ffmpeg') return 'Unavailable'
  if (s.running) return `${s.itemsDone} of ${s.itemsTotal}`
  return s.itemsTotal && s.itemsDone >= s.itemsTotal ? 'Done' : `${s.itemsDone} of ${s.itemsTotal}`
}

function introScanDetail(s) {
  if (!s.enabled) return 'Automatic detection is switched off in Settings'
  if (s.paused === 'playback') return 'Paused while someone is watching'
  if (s.paused === 'battery') return 'Paused while the PC is on battery power'
  if (s.paused === 'busy') return 'Paused while the PC is busy with something else'
  if (s.paused === 'no_ffmpeg') return 'The converter (ffmpeg) is not installed'
  if (s.running && s.current) return `${s.phase === 'intro' ? 'Listening for intros' : 'Looking for credits'}: ${s.current}`
  return `Intros found in ${s.introFound}, credits in ${s.creditsFound}`
}

// One series, one hue: bars for plays per day, with a hover tooltip per bar.
function DayBars({ daily }) {
  const [hover, setHover] = useState(null)
  const w = 640
  const h = 140
  const max = Math.max(1, ...daily.map((d) => d.plays))
  const slot = w / Math.max(1, daily.length)
  const barW = Math.max(3, Math.min(28, slot - 2))
  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${w} ${h + 18}`} style={{ width: '100%', maxWidth: 720, display: 'block' }} role="img" aria-label="Plays per day">
        <line x1="0" x2={w} y1={h} y2={h} stroke="#2a2f3a" strokeWidth="1" />
        {daily.map((d, i) => {
          const bh = d.plays ? Math.max(4, (d.plays / max) * (h - 16)) : 0
          const x = i * slot + (slot - barW) / 2
          return (
            <g key={d.day} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={i * slot} y="0" width={slot} height={h} fill="transparent" />
              {bh > 0 && <rect x={x} y={h - bh} width={barW} height={bh} rx="3" fill={ACCENT} opacity={hover === null || hover === i ? 1 : 0.55} />}
              {(daily.length <= 7 || i % 5 === daily.length % 5) && (
                <text x={i * slot + slot / 2} y={h + 13} textAnchor="middle" fontSize="10" fill="#8a8f98">{d.day.slice(5)}</text>
              )}
            </g>
          )
        })}
        <text x="2" y="10" fontSize="10" fill="#8a8f98">{max} plays</text>
      </svg>
      {hover !== null && daily[hover] && (
        <div style={{ position: 'absolute', top: 0, right: 0, background: '#0b0d11', border: '1px solid #2a2f3a', borderRadius: 6, padding: '6px 10px', fontSize: 12 }}>
          <b>{daily[hover].day}</b> · {daily[hover].plays} play{daily[hover].plays === 1 ? '' : 's'} · {formatDuration(daily[hover].seconds)} watched
        </div>
      )}
    </div>
  )
}

// Ranked list with a thin bar showing each row's share of the top value.
function RankBars({ rows, valueOf, labelOf, detailOf }) {
  if (!rows || !rows.length) return <div style={muted}>Nothing watched in this period yet.</div>
  const max = Math.max(1, ...rows.map(valueOf))
  return (
    <div>
      {rows.map((r, i) => (
        <div key={i} title={detailOf(r)} style={{ margin: '0 0 8px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, gap: 8 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{labelOf(r)}</span>
            <span style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>{detailOf(r)}</span>
          </div>
          <div style={{ height: 6, background: '#1f232c', borderRadius: 3, marginTop: 3 }}>
            <div style={{ width: `${Math.max(2, (valueOf(r) / max) * 100)}%`, height: 6, background: ACCENT, borderRadius: 3 }} />
          </div>
        </div>
      ))}
    </div>
  )
}

function NowPlaying({ rows, canStop, onStop, stopping }) {
  if (!rows) return null
  if (!rows.length) return <div style={muted}>Nobody is watching right now.</div>
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {rows.map((r) => (
        <div key={r.id} style={{ background: '#11141a', border: '1px solid #262b35', borderRadius: 8, padding: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>{r.title || 'Unknown title'}</div>
            <span style={{ ...muted, fontSize: 13 }}>{r.user} · {r.device}</span>
            {canStop && r.stoppable && (
              <button
                type="button"
                disabled={stopping === r.streamId}
                onClick={() => onStop(r)}
                style={{ marginLeft: 'auto', background: '#3a1f22', color: '#ff9d9d', border: '1px solid #6b2b2b', borderRadius: 6, padding: '5px 10px', cursor: 'pointer' }}
              >
                {stopping === r.streamId ? 'Stopping…' : '⏹ Stop this stream'}
              </button>
            )}
          </div>
          <div style={{ fontSize: 13, marginTop: 6, color: '#c9d1d9' }}>
            {WHERE_ICON[r.where] || ''} {r.whereLabel}
            {' · '}
            {r.playback === 'transcode' ? `🔄 ${r.playbackLabel}` : '✅ Direct play'}
            {' · '}
            {formatBitrate(r.currentBitsPerSec)} now
            {r.fileBitsPerSec ? ` (file ${formatBitrate(r.fileBitsPerSec)})` : ''}
            {r.paused ? ' · paused' : ''}
          </div>
          {r.durationSeconds > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ height: 6, background: '#1f232c', borderRadius: 3 }}>
                <div style={{ width: `${Math.round((r.progress || 0) * 100)}%`, height: 6, background: ACCENT, borderRadius: 3 }} />
              </div>
              <div style={{ ...muted, marginTop: 3 }}>{formatClock(r.positionSeconds)} of {formatClock(r.durationSeconds)}</div>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

export default function Dashboard({ active = true }) {
  const api = typeof window !== 'undefined' ? window.beeboentertainment : null
  const [live, setLive] = useState(null)
  const [slow, setSlow] = useState(null)
  const [days, setDays] = useState(7)
  const [error, setError] = useState('')
  const [stopping, setStopping] = useState(null)
  const [notice, setNotice] = useState('')

  const loadLive = useCallback(async () => {
    if (!api || !api.dashboard) return
    try {
      const r = await api.dashboard({ sections: ['now', 'bandwidth', 'health'] })
      if (r && r.ok) { setLive(r); setError('') } else setError('The dashboard is not ready yet.')
    } catch (e) {
      setError('Could not read the dashboard.')
    }
  }, [api])

  const loadSlow = useCallback(async () => {
    if (!api || !api.dashboard) return
    try {
      const r = await api.dashboard({ sections: ['activity', 'library'], days })
      if (r && r.ok) setSlow(r)
    } catch (e) { /* the live half still shows */ }
  }, [api, days])

  useEffect(() => {
    if (!active) return undefined
    loadLive()
    const stop = startPoll(loadLive, 3000)
    return () => stop()
  }, [active, loadLive])

  useEffect(() => {
    if (!active) return undefined
    loadSlow()
    const stop = startPoll(loadSlow, 60000)
    return () => stop()
  }, [active, loadSlow])

  const onStop = async (row) => {
    if (!window.confirm(`Stop ${row.user}'s stream of "${row.title}"? Their player stops and cannot restart it for a few minutes.`)) return
    setStopping(row.streamId)
    try {
      const r = await api.dashboardStopStream(row.streamId)
      setNotice(r && r.ok ? 'Stream stopped.' : 'That stream had already ended.')
      loadLive()
    } finally {
      setStopping(null)
    }
  }

  const health = live && live.health
  const bw = live && live.bandwidth
  const act = slow && slow.activity
  const lib = slow && slow.library

  return (
    <div style={{ maxWidth: 1100 }}>
      <h1 style={{ margin: '0 0 4px', fontSize: 22 }}>📈 Dashboard</h1>
      <p style={{ ...muted, fontSize: 13, margin: '0 0 16px' }}>
        Everything here is read from this computer and stays on it. Live figures refresh every few seconds while this page is open.
      </p>
      {error && <div style={{ ...panel, borderColor: '#6b2b2b', color: '#ff9d9d' }}>{error}</div>}
      {notice && <div style={{ ...panel, padding: 10 }} onClick={() => setNotice('')}>{notice}</div>}

      <div style={panel}>
        <h2 style={h2}>▶️ Now playing {live && live.nowPlaying ? `(${live.nowPlaying.length})` : ''}</h2>
        {live ? <NowPlaying rows={live.nowPlaying} canStop={!!live.canStopStreams} onStop={onStop} stopping={stopping} /> : <div style={muted}>Loading…</div>}
      </div>

      <div style={panel}>
        <h2 style={h2}>📶 Bandwidth</h2>
        {bw ? (
          <>
            <div style={tileGrid}>
              <Tile label="Sending right now" value={formatBitrate(bw.currentBitsPerSec)} detail={`${bw.streams.length} stream${bw.streams.length === 1 ? '' : 's'}`} />
              <Tile label="Peak today" value={formatBitrate(bw.peakTodayBytesPerSec * 8)} detail={bw.peakTodayAt ? new Date(bw.peakTodayAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'no streams yet today'} />
              <Tile label="Sent today" value={formatBytes(bw.sentTodayBytes)} detail="video only" />
            </div>
            {bw.streams.length > 0 && (
              <div style={{ marginTop: 12 }}>
                {bw.streams.map((s) => (
                  <div key={s.streamId} style={{ fontSize: 13, display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderTop: '1px solid #20242d' }}>
                    <span>{s.title}</span>
                    <span style={{ color: 'var(--muted)' }}>{formatBitrate(s.bytesPerSec * 8)} · {formatBytes(s.bytesSent)} sent</span>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : <div style={muted}>Loading…</div>}
      </div>

      <div style={panel}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <h2 style={{ ...h2, margin: 0 }}>📊 Activity</h2>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            {[7, 30].map((d) => (
              <button key={d} type="button" onClick={() => setDays(d)} style={{ background: days === d ? ACCENT : '#1f232c', color: '#fff', border: 0, borderRadius: 6, padding: '5px 10px', cursor: 'pointer' }}>
                Last {d} days
              </button>
            ))}
          </div>
        </div>
        {act ? (
          <>
            <div style={tileGrid}>
              <Tile label="Plays" value={act.totals.plays} detail={`in the last ${act.days} days`} />
              <Tile label="Watch time" value={formatDuration(act.totals.seconds)} detail="everyone together" />
              {act.weekly.slice(-2).map((w) => (
                <Tile key={w.from} label={`Week ${w.from.slice(5)} to ${w.to.slice(5)}`} value={`${w.plays} plays`} detail={formatDuration(w.seconds)} />
              ))}
            </div>
            <div style={{ marginTop: 14 }}><DayBars daily={act.daily} /></div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 20, marginTop: 14 }}>
              <div>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>Top titles</div>
                <RankBars rows={act.topTitles} valueOf={(r) => r.plays} labelOf={(r) => `${r.kind === 'tv' ? '📺' : '🎬'} ${r.title}`} detailOf={(r) => `${r.plays} play${r.plays === 1 ? '' : 's'} · ${formatDuration(r.seconds)}`} />
              </div>
              <div>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>Watch time per member</div>
                <RankBars rows={act.watchTimeByMember} valueOf={(r) => r.seconds} labelOf={(r) => r.name} detailOf={(r) => `${formatDuration(r.seconds)} · ${r.plays} play${r.plays === 1 ? '' : 's'}`} />
              </div>
            </div>
            {act.partial && <div style={{ ...muted, marginTop: 8 }}>Beebo keeps the newest 300 viewing sessions, so the start of this period may be missing.</div>}
          </>
        ) : <div style={muted}>Loading…</div>}
      </div>

      <div style={panel}>
        <h2 style={h2}>📚 Library</h2>
        {lib ? (
          <>
            <div style={tileGrid}>
              <Tile label="Movies" value={lib.counts.movies} />
              <Tile label="TV shows" value={lib.counts.shows} detail={`${lib.counts.episodes} episodes`} />
              {lib.counts.extra.map((x) => <Tile key={x.kind} label={x.label} value={x.count} />)}
              {lib.missingPosters && <Tile label="Missing posters" value={lib.missingPosters.movies + lib.missingPosters.shows} detail={(lib.missingPosters.examples || []).slice(0, 3).join(', ')} warn={lib.missingPosters.movies + lib.missingPosters.shows > 0} />}
              <Tile label="Converter" value={lib.converter.converting ? 'Converting' : lib.converter.queued ? `${lib.converter.queued} waiting` : 'Idle'} detail={lib.converter.current ? `${lib.converter.current.title}${lib.converter.current.progress != null ? ` · ${lib.converter.current.progress}%` : ''}` : `${lib.converter.done} done · ${lib.converter.failed} failed${lib.converter.paused ? ' · paused' : ''}`} warn={lib.converter.failed > 0} />
              {lib.introScan && <Tile label="Intros & credits" value={introScanValue(lib.introScan)} detail={introScanDetail(lib.introScan)} />}
              {lib.inbox && <Tile label="Beebo Inbox" value={`${lib.inbox.sortedToday} sorted today`} detail={lib.inbox.problem || (lib.inbox.needsLook ? `${lib.inbox.needsLook} need a look` : lib.inbox.waitingForCopy ? `${lib.inbox.waitingForCopy} still copying` : lib.inbox.paused ? 'paused' : 'watching for new files')} warn={!!lib.inbox.problem || lib.inbox.needsLook > 0} />}
            </div>
            <div style={{ marginTop: 14 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Storage</div>
              {lib.storage.folders.map((f) => (
                <div key={f.kind + f.dir} style={{ fontSize: 13, display: 'flex', justifyContent: 'space-between', gap: 8, padding: '4px 0', borderTop: '1px solid #20242d' }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.kind === 'tv' ? '📺' : '🎬'} {f.dir}</span>
                  <span style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>{formatBytes(f.usedBytes)} in {f.files} files</span>
                </div>
              ))}
              {lib.storage.disks.map((d) => {
                const pct = d.totalBytes ? Math.round((d.usedBytes / d.totalBytes) * 100) : 0
                const low = d.totalBytes && d.freeBytes / d.totalBytes < 0.1
                return (
                  <div key={d.disk} style={{ marginTop: 8 }}>
                    <div style={{ fontSize: 13 }}>{low ? '⚠️ ' : ''}Disk {d.disk}: {formatBytes(d.freeBytes)} free of {formatBytes(d.totalBytes)}</div>
                    <div style={{ height: 8, background: '#1f232c', borderRadius: 4, marginTop: 3 }}>
                      <div style={{ width: `${pct}%`, height: 8, background: low ? '#e2b33c' : ACCENT, borderRadius: 4 }} />
                    </div>
                  </div>
                )
              })}
            </div>
            {lib.recentlyAdded.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>Recently added</div>
                {lib.recentlyAdded.map((r, i) => (
                  <div key={i} style={{ fontSize: 13, display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
                    <span>{r.title}</span><span style={{ color: 'var(--muted)' }}>{timeAgo(r.addedAt)}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : <div style={muted}>Loading…</div>}
      </div>

      <div style={panel}>
        <h2 style={h2}>🩺 Server health</h2>
        {health ? (
          <>
            <div style={tileGrid}>
              <Tile label="Beebo CPU" value={health.cpuPercent == null ? '…' : `${health.cpuPercent}%`} warn={health.cpuPercent > 85} />
              {health.transcode && (
                <Tile
                  label="Transcode load"
                  value={`${health.transcode.active} of ${health.transcode.max}`}
                  detail={`${health.transcode.hardware ? 'Graphics card' : 'Processor'}${health.transcode.queued ? ` · ${health.transcode.queued} waiting` : ''}${health.transcode.fallbacks ? ` · ${health.transcode.fallbacks} switched encoder` : ''}`}
                  warn={health.transcode.queued > 0}
                />
              )}
              <Tile label="Beebo memory" value={formatBytes(health.memoryBytes)} detail={`${formatBytes(health.systemMemory.freeBytes)} free on this PC`} />
              <Tile label="Running for" value={formatDuration(health.uptimeSeconds)} />
              <Tile label="Version" value={health.versions.app || '—'} detail={health.update ? (health.update.available ? `Update available: ${health.update.latest}` : 'Up to date') : ''} warn={!!(health.update && health.update.available)} />
              <Tile label="Away from home" value={health.away.registered ? (health.away.online ? 'Online' : 'Offline') : 'Not set up'} detail={health.away.address || health.away.problem} warn={health.away.registered && !health.away.online} />
              <Tile label="Relay use this month" value={formatBytes(health.relay.totalBytes)} detail={`Beebo Relay ${formatBytes(health.relay.bytes.beebo)}`} />
              <Tile label="Last backup" value={timeAgo(health.lastBackupAt)} warn={!health.lastBackupAt || Date.now() - health.lastBackupAt > 30 * 86400000} detail="Settings → Backup" />
              <Tile label="Problems (24 h)" value={health.errors24h.count} warn={health.errors24h.count > 0} />
            </div>
            {health.errors24h.recent.length > 0 && (
              <details style={{ marginTop: 10 }}>
                <summary style={{ cursor: 'pointer', fontSize: 13 }}>Show recent problems</summary>
                {health.errors24h.recent.map((e, i) => (
                  <div key={i} style={{ fontSize: 12, fontFamily: 'monospace', padding: '3px 0', color: '#c9d1d9' }}>
                    {new Date(e.at).toLocaleTimeString()} {e.message}
                  </div>
                ))}
              </details>
            )}
            <div style={{ ...muted, marginTop: 8 }}>Electron {health.versions.electron} · Node {health.versions.node} · {health.versions.os}</div>
          </>
        ) : <div style={muted}>Loading…</div>}
      </div>
    </div>
  )
}
