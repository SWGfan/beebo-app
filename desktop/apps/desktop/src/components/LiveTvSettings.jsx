import React, { useCallback, useEffect, useState } from 'react'

// Settings > Live TV: find and add an HDHomeRun network tuner (your own tuner, your own antenna), pick
// channels, load a guide (XMLTV) and turn on recording. Server side: electron/liveTv/ (the /api/livetv/*
// contract, reached through window.beeboentertainment.livetvCall as the owner).

const api = () => (typeof window !== 'undefined' && window.beeboentertainment) || {}
const call = (...a) => (api().livetvCall ? api().livetvCall(...a) : Promise.resolve({ ok: false, message: 'Live TV is not available here.' }))
const note = { color: 'var(--muted)', fontSize: 12, lineHeight: 1.5, margin: '6px 0' }

export default function LiveTvSettings() {
  const [status, setStatus] = useState(null)
  const [dvr, setDvr] = useState(null)
  const [channels, setChannels] = useState([])
  const [found, setFound] = useState(null)
  const [ip, setIp] = useState('')
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState({ text: '', bad: false })
  const [guideUrl, setGuideUrl] = useState('')
  const [open, setOpen] = useState(false)
  const [rec, setRec] = useState({ dvrEnabled: false, recordingsDir: '', allowMemberRecording: false, padBeforeSec: 60, padAfterSec: 120, container: 'mkv' })
  const [play, setPlay] = useState({ quality: '720p', timeshiftMinutes: 90, timeshiftMaxMB: 8192 })
  const say = (text, bad = false) => setMsg({ text, bad })

  const load = useCallback(async () => {
    const s = await call('GET', 'status')
    if (!s || s.ok === false) { setStatus(null); return }
    setStatus(s)
    setPlay({ quality: s.quality, timeshiftMinutes: s.timeshiftMinutes, timeshiftMaxMB: play.timeshiftMaxMB })
    const d = await call('GET', 'dvr')
    if (d && d.ok) { setDvr(d); setRec((r) => ({ ...r, dvrEnabled: !!d.enabled, recordingsDir: d.recordingsDir || '', allowMemberRecording: !!(s.dvr && s.dvr.allowMemberRecording) })) }
    const c = await call('GET', 'channels', null, { all: '1' })
    if (c && c.ok) setChannels(c.channels)
  }, [])

  useEffect(() => { load() }, [load])

  const run = async (label, fn) => {
    setBusy(label)
    try { await fn() } finally { setBusy('') }
  }

  const discover = () => run('discover', async () => {
    setFound(null)
    const r = await call('POST', 'admin/discover', {})
    setFound(r && r.devices ? r.devices : [])
  })

  const add = (host, confirmNonLan = false) => run('add', async () => {
    const r = await call('POST', 'admin/device', { host, confirmNonLan })
    if (r && r.needsConfirm) {
      if (window.confirm(`${r.message}\n\nUse this address anyway?`)) return add(host, true)
      return undefined
    }
    if (!r || !r.ok) { say((r && r.message) || 'That tuner could not be added.', true); return undefined }
    say(`Added ${r.device.name}. ${r.lineup && r.lineup.found != null ? r.lineup.found + ' channels found.' : ''} ${r.lineup && r.lineup.drmNote ? r.lineup.drmNote : ''}`)
    setIp('')
    setFound(null)
    await load()
    return undefined
  })

  const refresh = (id) => run('lineup', async () => {
    const r = await call('POST', 'admin/lineup/refresh', { id })
    say(r && r.ok ? `${r.found} channels found. ${r.drmNote || ''}` : (r && r.message) || 'Could not read the channels.', !(r && r.ok))
    await load()
  })

  const scan = (id) => run('scan', async () => {
    if (!window.confirm('Ask the tuner to scan for channels? This takes a few minutes and needs the tuner free (stop any watching or recording first).')) return
    const r = await call('POST', 'admin/scan', { id, source: 'Antenna' })
    say(r && r.ok ? 'Scan started. When it is done (a few minutes), choose "Refresh channels".' : (r && r.message) || 'The tuner would not start a scan.', !(r && r.ok))
  })

  const remove = (id) => run('remove', async () => {
    if (!window.confirm('Remove this tuner from Beebo? (The tuner itself is not changed.)')) return
    await call('POST', 'admin/device/remove', { id })
    await load()
  })

  const setChannel = async (key, patch) => {
    await call('POST', 'admin/channel', { channel: key, ...patch })
    const c = await call('GET', 'channels', null, { all: '1' })
    if (c && c.ok) setChannels(c.channels)
  }

  const saveSettings = (patch, okText = 'Saved.') => run('save', async () => {
    const r = await call('POST', 'admin/settings', patch)
    say(r && r.ok ? okText : (r && r.message) || 'Could not save.', !(r && r.ok))
    await load()
  })

  const chooseFolder = async () => {
    const dir = api().livetvPickFolder ? await api().livetvPickFolder() : ''
    if (dir) setRec((r) => ({ ...r, recordingsDir: dir }))
  }

  const setGuide = (body) => run('guide', async () => {
    const send = async (b) => {
      const r = await call('POST', 'admin/guide/source', b)
      if (r && !r.ok && b.type === 'url' && !b.allowPrivate && /your own network/.test(r.message || '') && window.confirm(`${r.message}\n\nUse it anyway?`)) return send({ ...b, allowPrivate: true })
      return r
    }
    const r = await send(body)
    say(r && r.ok ? (body.type === 'none' ? 'Guide removed.' : 'Guide loaded.') : (r && r.message) || 'The guide could not be loaded.', !(r && r.ok))
    await load()
  })

  const pickGuide = async () => {
    const p = api().livetvPickGuideFile ? await api().livetvPickGuideFile() : ''
    if (p) setGuide({ type: 'file', path: p })
  }

  if (!status) {
    return <div style={{ marginBottom: 20 }}><label>Live TV (your own antenna and network tuner)</label><p style={note}>Live TV is not available right now (the Beebo server is not running yet).</p></div>
  }
  const devices = Array.isArray(status.devices) ? status.devices : []
  const guide = status.guide || {}

  return (
    <div style={{ marginBottom: 20 }}>
      <label>Live TV and recording (your own antenna and network tuner)</label>
      <p style={note}>
        Watch and record over-the-air TV from your own antenna through a SiliconDust HDHomeRun network tuner on your home network. Beebo does not supply
        channels or guide data, and nothing is sent outside your home network. Tuner, guide and recording settings are kept on this computer only.
      </p>
      <button type="button" onClick={() => setOpen(!open)}>{open ? 'Hide Live TV settings' : devices.length ? 'Live TV settings' : 'Set up Live TV'}</button>
      {msg.text && <div style={{ ...note, color: msg.bad ? '#ff8f8f' : 'var(--muted)' }}>{msg.text}</div>}
      {open && (
        <div style={{ marginTop: 10 }}>
          <h4 style={{ margin: '10px 0 4px' }}>Tuners</h4>
          {devices.map((d) => (
            <div key={d.id} style={{ border: '1px solid var(--border, #2a2f3a)', borderRadius: 8, padding: 8, marginBottom: 6, fontSize: 13 }}>
              <strong>{d.name}</strong> ({d.id}) &middot; {d.ip} &middot; {d.tunerCount} tuners &middot; {d.channels} channels{d.nonLan ? ' · not on your home network (you confirmed this)' : ''}
              <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button type="button" disabled={!!busy} onClick={() => refresh(d.id)}>Refresh channels</button>
                <button type="button" disabled={!!busy} onClick={() => scan(d.id)}>Scan for channels</button>
                <button type="button" disabled={!!busy} onClick={() => remove(d.id)}>Remove</button>
              </div>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <button type="button" disabled={!!busy} onClick={discover}>{busy === 'discover' ? 'Looking…' : 'Find tuners on my network'}</button>
          </div>
          {found && found.length === 0 && <p style={note}>No tuner answered. Check it is switched on and on the same network, or type its IP address below.</p>}
          {found && found.map((f) => (
            <div key={f.ip} style={{ fontSize: 13, margin: '4px 0' }}>
              {f.ip} ({f.deviceId}, {f.tunerCount || '?'} tuners) {f.added ? <em>already added</em> : <button type="button" disabled={!!busy} onClick={() => add(f.ip)}>Add</button>}
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="Tuner IP address, e.g. 192.168.1.50" style={{ margin: 0 }} />
            <button type="button" disabled={!!busy || !ip.trim()} onClick={() => add(ip.trim())}>Add tuner</button>
          </div>
          <p style={note}>Only an address on your home network is accepted (or one you explicitly confirm). Beebo asks the tuner for its details before adding it.</p>

          {devices.length > 0 && (
            <>
              <h4 style={{ margin: '14px 0 4px' }}>Channels</h4>
              {status.drmNote && <p style={{ ...note, background: 'var(--card, #171a21)', padding: 8, borderRadius: 6 }}>{status.drmNote} ({status.drmHidden} hidden)</p>}
              <div style={{ maxHeight: 260, overflow: 'auto', border: '1px solid var(--border, #2a2f3a)', borderRadius: 8 }}>
                {channels.length === 0 && <p style={{ ...note, padding: 8 }}>No channels yet. Choose "Refresh channels" (or scan first if the tuner is new).</p>}
                {channels.map((c) => (
                  <div key={c.key} style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '4px 8px', fontSize: 13, opacity: c.hidden ? 0.5 : 1 }}>
                    <input aria-label={`Number for ${c.name}`} defaultValue={c.number} onBlur={(e) => e.target.value !== c.number && setChannel(c.key, { number: e.target.value })} style={{ width: 64, margin: 0 }} />
                    <input aria-label={`Name for ${c.name}`} defaultValue={c.name} onBlur={(e) => e.target.value !== c.name && setChannel(c.key, { name: e.target.value })} style={{ flex: 1, margin: 0 }} />
                    <label style={{ display: 'flex', gap: 4, alignItems: 'center', fontWeight: 400, margin: 0 }}>
                      <input type="checkbox" checked={!c.hidden} onChange={(e) => setChannel(c.key, { hidden: !e.target.checked })} style={{ width: 'auto', margin: 0 }} /> Show
                    </label>
                  </div>
                ))}
              </div>
              <p style={note}>Everyone in the house can mark their own favourites in the Live TV guide.</p>

              <h4 style={{ margin: '14px 0 4px' }}>Watching</h4>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <label style={{ fontWeight: 400 }}>Quality{' '}
                  <select value={play.quality} onChange={(e) => setPlay({ ...play, quality: e.target.value })} style={{ width: 'auto' }}>
                    <option value="1080p">1080p</option><option value="720p">720p</option><option value="480p">480p</option>
                  </select>
                </label>
                <label style={{ fontWeight: 400 }}>Rewind buffer (minutes){' '}
                  <input type="number" min="5" max="240" value={play.timeshiftMinutes} onChange={(e) => setPlay({ ...play, timeshiftMinutes: Number(e.target.value) })} style={{ width: 80, margin: 0 }} />
                </label>
                <button type="button" disabled={!!busy} onClick={() => saveSettings({ quality: play.quality, timeshiftMinutes: play.timeshiftMinutes })}>Save</button>
              </div>
              <p style={note}>Live TV is converted by this computer as it plays, with the same hardware encoder as your films. The rewind buffer lets people pause and go back; it is kept on this computer's disk and cleared when nobody is watching.</p>

              <h4 style={{ margin: '14px 0 4px' }}>Programme guide</h4>
              <p style={note}>
                The tuner does not carry a programme guide. To see what is on, load an XMLTV guide file or web address from a guide tool or service you subscribe to
                (for example an XMLTV export of your Schedules Direct subscription). Beebo does not supply guide data. Without one, only channel names are shown.
              </p>
              <p style={note}>Now: {guide.hasGuide ? `${guide.programmes || ''} guide loaded${guide.lastRefreshAt ? ' (' + new Date(guide.lastRefreshAt).toLocaleString() + ')' : ''}` : 'no guide loaded'} {guide.lastError ? <span style={{ color: '#ff8f8f' }}> &mdash; {guide.lastError}</span> : null}</p>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button type="button" disabled={!!busy} onClick={pickGuide}>Choose a guide file&hellip;</button>
                <input value={guideUrl} onChange={(e) => setGuideUrl(e.target.value)} placeholder="or a web address: https://..." style={{ flex: 1, minWidth: 160, margin: 0 }} />
                <button type="button" disabled={!!busy || !guideUrl.trim()} onClick={() => setGuide({ type: 'url', url: guideUrl.trim() })}>Load</button>
                {guide.source && guide.source !== 'none' && <button type="button" disabled={!!busy} onClick={() => setGuide({ type: 'none' })}>Remove guide</button>}
              </div>

              <h4 style={{ margin: '14px 0 4px' }}>Recording</h4>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 400 }}>
                <input type="checkbox" checked={rec.dvrEnabled} onChange={(e) => setRec({ ...rec, dvrEnabled: e.target.checked })} style={{ width: 'auto' }} /> Allow recording (nothing is ever recorded unless someone schedules it)
              </label>
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <input value={rec.recordingsDir} onChange={(e) => setRec({ ...rec, recordingsDir: e.target.value })} placeholder="Recordings folder" style={{ margin: 0 }} />
                <button type="button" onClick={chooseFolder}>Choose&hellip;</button>
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 6, alignItems: 'center' }}>
                <label style={{ fontWeight: 400 }}>Start early (seconds) <input type="number" min="0" max="1800" value={rec.padBeforeSec} onChange={(e) => setRec({ ...rec, padBeforeSec: Number(e.target.value) })} style={{ width: 80, margin: 0 }} /></label>
                <label style={{ fontWeight: 400 }}>Stop late (seconds) <input type="number" min="0" max="3600" value={rec.padAfterSec} onChange={(e) => setRec({ ...rec, padAfterSec: Number(e.target.value) })} style={{ width: 80, margin: 0 }} /></label>
                <label style={{ fontWeight: 400 }}>File type{' '}
                  <select value={rec.container} onChange={(e) => setRec({ ...rec, container: e.target.value })} style={{ width: 'auto' }}>
                    <option value="mkv">.mkv (recommended)</option><option value="ts">.ts (as broadcast)</option>
                  </select>
                </label>
              </div>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 400, marginTop: 6 }}>
                <input type="checkbox" checked={rec.allowMemberRecording} onChange={(e) => setRec({ ...rec, allowMemberRecording: e.target.checked })} style={{ width: 'auto' }} /> Let everyone in the house schedule recordings (otherwise only you can)
              </label>
              <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                <button type="button" disabled={!!busy} onClick={() => saveSettings({ dvrEnabled: rec.dvrEnabled, recordingsDir: rec.recordingsDir, allowMemberRecording: rec.allowMemberRecording, padBeforeSec: rec.padBeforeSec, padAfterSec: rec.padAfterSec, container: rec.container })}>Save recording settings</button>
                <button type="button" disabled={!!busy || !rec.recordingsDir} onClick={async () => { const r = await call('POST', 'admin/recordings/add-to-library', {}); say(r && r.ok ? (r.added ? 'The Recordings folder is now part of your TV Shows library.' : 'The Recordings folder is already in your library.') : (r && r.message) || 'Could not add it.', !(r && r.ok)) }}>Add Recordings to my library</button>
              </div>
              <p style={note}>Recordings are saved as Show / Season / Episode files. Once added to your library they play like any other show. Choose a folder with plenty of free space. {dvr && dvr.recording && dvr.recording.length ? `${dvr.recording.length} recording(s) in progress.` : ''}</p>

              <h4 style={{ margin: '14px 0 4px' }}>Advanced</h4>
              <p style={note}>A generic "M3U + XMLTV" source is planned but is not available in this version. When it arrives it will be off unless you switch it on, and Beebo will not supply channels or lists: you may only use sources you are licensed to use.</p>
            </>
          )}
        </div>
      )}
    </div>
  )
}
