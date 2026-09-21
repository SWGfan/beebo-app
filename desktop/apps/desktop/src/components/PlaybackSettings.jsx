import React, { useEffect, useState } from 'react'

// Settings > Quality & subtitles: live conversion (the phone/TV quality picker) and the owner's
// OpenSubtitles account for "Search online". Everything goes through window.beeboentertainment.playback.

const link = (url, text) => (
  <a href="#" onClick={(e) => { e.preventDefault(); window.beeboentertainment.openExternal(url) }} style={{ color: 'var(--link)' }}>{text}</a>
)

export default function PlaybackSettings() {
  const api = window.beeboentertainment && window.beeboentertainment.playback
  const [s, setS] = useState(null)
  const [password, setPassword] = useState('')
  const [saved, setSaved] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [encoder, setEncoder] = useState(null)
  const [sweeping, setSweeping] = useState(false)
  const [sweepStatus, setSweepStatus] = useState(null)
  const [rechecking, setRechecking] = useState(false)
  const [load, setLoad] = useState(null)

  useEffect(() => {
    if (!api) return
    api.getSettings().then(setS).catch(() => {})
    api.encoderStatus(false).then(setEncoder).catch(() => {})
    api.sweepStatus().then(setSweepStatus).catch(() => {})
  }, [])

  // "Right now": how many conversions are running / allowed / waiting, refreshed every few seconds.
  useEffect(() => {
    if (!api || !api.transcodeLoad) return
    let cancelled = false
    const tick = () => api.transcodeLoad().then((l) => { if (!cancelled) setLoad(l) }).catch(() => {})
    tick()
    const id = setInterval(tick, 4000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  // While a sweep is running, poll its progress every couple of seconds so "Sweep now" doesn't
  // look stuck on a big library - same live-view pattern as the Requests/Flags/Converted tabs.
  useEffect(() => {
    if (!api || !(sweeping || (sweepStatus && sweepStatus.running))) return
    let cancelled = false
    const id = setInterval(() => {
      api.sweepStatus().then((st) => {
        if (cancelled) return
        setSweepStatus(st)
        if (!st || !st.running) setSweeping(false)
      }).catch(() => {})
    }, 2000)
    return () => { cancelled = true; clearInterval(id) }
  }, [sweeping, sweepStatus && sweepStatus.running])

  if (!api || !s) return null

  const flash = (what) => { setSaved(what); setTimeout(() => setSaved(''), 1500) }

  const saveSubtitles = async () => {
    await api.saveSettings({ openSubtitlesApiKey: s.openSubtitlesApiKey, openSubtitlesUsername: s.openSubtitlesUsername, openSubtitlesPassword: password })
    setPassword('')
    setS(await api.getSettings())
    flash('subs')
  }

  const test = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      await api.saveSettings({ openSubtitlesApiKey: s.openSubtitlesApiKey, openSubtitlesUsername: s.openSubtitlesUsername, openSubtitlesPassword: password })
      setPassword('')
      setS(await api.getSettings())
      setTestResult(await api.testOpenSubtitles())
    } catch (e) {
      setTestResult({ ok: false, message: String(e && e.message || e) })
    }
    setTesting(false)
  }

  const saveTranscode = async (patch) => {
    const next = { ...s, ...patch }
    setS(next)
    await api.saveSettings(patch)
    // The owner's choice (and gentle mode) only re-orders what was already proved: no new test encodes.
    if ('transcodeEncoder' in patch || 'transcodeCpuMode' in patch || 'transcodeMaxConcurrent' in patch) {
      api.encoderStatus(false).then(setEncoder).catch(() => {})
      api.getSettings().then(setS).catch(() => {})
    }
    flash('transcode')
  }

  // Re-runs the one-second test encodes (after a driver update or a new graphics card).
  const recheck = async () => {
    setRechecking(true)
    try { setEncoder(await api.encoderStatus(true)) } catch { /* the panel keeps the old result */ }
    setRechecking(false)
  }

  const detected = (encoder && encoder.detected) || []
  const usable = detected.filter((d) => d.usedForHls && d.ok)

  const saveSweep = async (patch) => {
    const next = { ...s, ...patch }
    setS(next)
    await api.saveSettings(patch)
    flash('sweep')
  }

  const sweepNow = async () => {
    setSweeping(true)
    try {
      const out = await api.sweepNow({ language: s.subtitleSweepLanguage, batchSize: s.subtitleSweepBatchSize, minRemaining: s.subtitleSweepMinRemaining })
      if (out && out.result) setSweepStatus({ running: false, last: out.result })
      else setSweepStatus({ running: false, last: null, error: out && (out.message || out.error) })
    } catch (e) {
      setSweepStatus({ running: false, last: null, error: String(e && e.message || e) })
    }
    setSweeping(false)
    api.sweepStatus().then(setSweepStatus).catch(() => {})
  }

  const last = sweepStatus && sweepStatus.last
  const sweepBusy = sweeping || (sweepStatus && sweepStatus.running)

  return (
    <>
      <div style={{ marginBottom: 20 }}>
        <label>🎚️ Quality choices for phones, TVs and browsers</label>
        <div style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.5 }}>
          <p style={{ margin: '4px 0 8px' }}>
            When someone watches on a slow connection (away from home, or on mobile data) they can pick
            <strong> 1080p</strong>, <strong>720p</strong> or <strong>480p</strong> in the player, or leave it on <strong>Auto</strong>.
            This computer then converts the video <em>while it plays</em>. Your original files are never changed.
          </p>
          <p style={{ margin: '0 0 8px' }}>{encoder ? encoder.message : 'Checking this computer’s video encoder…'}</p>
        </div>
        <div className="row" style={{ gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
            <input type="checkbox" checked={s.transcodeEnabled} onChange={(e) => saveTranscode({ transcodeEnabled: e.target.checked })} />
            Allow converting while playing
          </label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
            At most
            <select value={s.transcodeMaxConcurrentAuto ? 'auto' : s.transcodeMaxConcurrent} onChange={(e) => saveTranscode({ transcodeMaxConcurrent: e.target.value === 'auto' ? 'auto' : Number(e.target.value) })}>
              <option value="auto">Automatic ({s.transcodeMaxConcurrent})</option>
              {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            at the same time
          </label>
          {saved === 'transcode' && <span style={{ color: 'var(--muted)' }}>Saved ✓</span>}
        </div>
        <p style={{ color: 'var(--muted)', fontSize: 12, margin: '6px 0 0' }}>
          When more people ask than that, they wait in line (first come, first served) with a friendly &ldquo;server busy&rdquo; message and
          start by themselves as soon as there is room. They can always pick Original quality to play straight away.
          {load ? <strong> Right now: {load.active} of {load.max} running{load.queued ? `, ${load.queued} waiting` : ''}.</strong> : null}
        </p>
        {!s.ffmpegInstalled && (
          <p style={{ color: 'var(--muted)', fontSize: 12 }}>The converter (ffmpeg) isn&rsquo;t installed, so everyone gets the original file.</p>
        )}
      </div>

      <div style={{ marginBottom: 20 }}>
        <label>⚡ Hardware acceleration</label>
        <div style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.5 }}>
          <p style={{ margin: '4px 0 8px' }}>
            Beebo tests every way this computer can encode video &mdash; graphics cards first, the processor last &mdash; by really
            encoding one second of picture with each. If a graphics encoder ever stops working while someone is watching, the same
            film carries on with the next one, so a player never goes dead.
          </p>
        </div>
        {!encoder && <p style={{ color: 'var(--muted)', fontSize: 12 }}>Checking&hellip;</p>}
        {detected.length > 0 && (
          <table style={{ borderCollapse: 'collapse', fontSize: 13, width: '100%', maxWidth: 720, marginBottom: 8 }}>
            <tbody>
              {detected.filter((d) => d.state !== 'skipped').map((d) => (
                <tr key={d.id} style={{ borderTop: '1px solid var(--border, #262b35)' }}>
                  <td style={{ padding: '4px 8px 4px 0' }}>{d.label}{!d.usedForHls ? ' — found, not used for live conversion yet' : ''}</td>
                  <td style={{ padding: '4px 8px', whiteSpace: 'nowrap', color: d.ok && !d.demoted ? 'var(--ok, #2e7d32)' : 'var(--muted)' }}>
                    {d.ok ? (d.demoted ? 'Working, but failed while playing' : 'Working ✓') : 'Not available'}
                  </td>
                  <td style={{ padding: '4px 0', color: 'var(--muted)', fontSize: 12 }}>
                    {d.ok ? (d.failedInUse ? d.failedReason : d.device) : d.reason}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="row" style={{ gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
            Use
            <select value={s.transcodeEncoder} onChange={(e) => saveTranscode({ transcodeEncoder: e.target.value })}>
              <option value="">Automatic (best available)</option>
              <option value="software">Processor only (no graphics card)</option>
              {usable.map((d) => <option key={d.id} value={d.id}>Prefer: {d.label}</option>)}
              {s.transcodeEncoder && s.transcodeEncoder !== 'software' && !usable.some((d) => d.id === s.transcodeEncoder) && (
                <option value={s.transcodeEncoder}>Prefer: {s.transcodeEncoder} (not working here)</option>
              )}
            </select>
          </label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
            Old or slow computer
            <select value={s.transcodeCpuMode} onChange={(e) => saveTranscode({ transcodeCpuMode: e.target.value })}>
              <option value="">Automatic{encoder && encoder.profile ? ` (${encoder.profile.tier === 'low' ? 'gentle' : 'normal'})` : ''}</option>
              <option value="gentle">Always gentle on this PC</option>
              <option value="normal">Normal</option>
            </select>
          </label>
          <button onClick={recheck} disabled={rechecking}>{rechecking ? 'Checking…' : 'Check again'}</button>
        </div>
        {encoder && encoder.hdr && <p style={{ color: 'var(--muted)', fontSize: 12, margin: '8px 0 0' }}>{encoder.hdr}</p>}
        {encoder && encoder.profile && (
          <p style={{ color: 'var(--muted)', fontSize: 12, margin: '4px 0 0' }}>
            This computer: {encoder.profile.cores} processor core{encoder.profile.cores === 1 ? '' : 's'} &mdash; {encoder.profile.tier === 'low' ? 'gentle mode (fewer threads, the fastest preset, one conversion at a time by default, lower priority so the PC stays usable)' : 'normal mode (conversions run at lower priority so the PC stays usable)'}.
          </p>
        )}
      </div>

      <div style={{ marginBottom: 20 }}>
        <label>💬 Subtitle search (OpenSubtitles) &mdash; optional, free</label>
        <div style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.5 }}>
          <p style={{ margin: '4px 0 8px' }}>
            With this set up, the <strong>Search online</strong> button in the phone, TV and web player finds subtitles for
            the video and saves them next to the file on this computer (your existing subtitle files are never replaced).
            It uses <strong>your own</strong> free OpenSubtitles account. How to set it up:
          </p>
          <ol style={{ margin: '0 0 8px 18px', padding: 0 }}>
            <li style={{ marginBottom: 4 }}>
              Make a free account at {link('https://www.opensubtitles.com/en/users/sign_up', 'opensubtitles.com')} and click the link in the
              email they send you.
            </li>
            <li style={{ marginBottom: 4 }}>
              Open the {link('https://www.opensubtitles.com/en/consumers', 'API consumers page')} (sign in if it asks), click
              <strong> New consumer</strong>, give it a name like <em>Beebo</em>, and save. Copy the <strong>API key</strong> it shows.
            </li>
            <li style={{ marginBottom: 4 }}>
              Paste the API key below, and type your OpenSubtitles <strong>username and password</strong> &mdash; OpenSubtitles only
              lets signed-in accounts download. The password is stored encrypted on this computer.
            </li>
            <li>
              Click <strong>Test</strong>. It checks everything works and shows how many subtitles your account can download each day
              (free accounts get a small daily allowance; OpenSubtitles decides the number and it resets every day).
            </li>
          </ol>
          <p style={{ margin: '0 0 8px' }}>
            Technical details are in the {link('https://opensubtitles.stoplight.io/', 'OpenSubtitles API documentation')}.
          </p>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 8, alignItems: 'center', maxWidth: 560 }}>
          <span>API key</span>
          <input type="password" placeholder="Paste your OpenSubtitles API key" value={s.openSubtitlesApiKey}
            onChange={(e) => setS((x) => ({ ...x, openSubtitlesApiKey: e.target.value }))} />
          <span>Username</span>
          <input placeholder="Your OpenSubtitles username" value={s.openSubtitlesUsername}
            onChange={(e) => setS((x) => ({ ...x, openSubtitlesUsername: e.target.value }))} />
          <span>Password</span>
          <input type="password" placeholder={s.openSubtitlesHasPassword ? 'Saved (type to change)' : 'Your OpenSubtitles password'} value={password}
            onChange={(e) => setPassword(e.target.value)} />
        </div>
        <div className="row" style={{ marginTop: 8, gap: 8, alignItems: 'center' }}>
          <button className="primary" onClick={saveSubtitles}>{saved === 'subs' ? 'Saved ✓' : 'Save'}</button>
          <button onClick={test} disabled={testing || !s.openSubtitlesApiKey}>{testing ? 'Testing…' : 'Test'}</button>
          {testResult && (
            <span style={{ color: testResult.ok ? 'var(--ok, #2e7d32)' : 'var(--danger, #c62828)', fontSize: 13 }}>
              {testResult.ok ? '✓ ' : '✗ '}{testResult.message}
            </span>
          )}
        </div>
      </div>

      <div style={{ marginBottom: 20 }}>
        <label>🧹 Fetch subtitles for the whole library</label>
        <div style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.5 }}>
          <p style={{ margin: '4px 0 8px' }}>
            Instead of clicking <strong>Search online</strong> one title at a time, this looks through the whole library for
            films and episodes with no subtitles yet and fetches them automatically, using the same OpenSubtitles account and
            the same daily allowance above. It only ever looks at a small batch at a time and stops the moment today&rsquo;s
            downloads run low, so it can&rsquo;t use up your whole day&rsquo;s allowance by itself.
          </p>
        </div>
        <div className="row" style={{ gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
            <input type="checkbox" checked={s.subtitleSweepEnabled} onChange={(e) => saveSweep({ subtitleSweepEnabled: e.target.checked })} />
            Run this automatically once a day
          </label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
            Language
            <select value={s.subtitleSweepLanguage} onChange={(e) => saveSweep({ subtitleSweepLanguage: e.target.value })}>
              <option value="any">Any (just needs some subtitles)</option>
              <option value="en">English</option>
              <option value="es">Spanish</option>
              <option value="fr">French</option>
              <option value="de">German</option>
              <option value="it">Italian</option>
              <option value="pt">Portuguese</option>
              <option value="ja">Japanese</option>
              <option value="ko">Korean</option>
              <option value="zh">Chinese</option>
            </select>
          </label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
            At most
            <select value={s.subtitleSweepBatchSize} onChange={(e) => saveSweep({ subtitleSweepBatchSize: Number(e.target.value) })}>
              {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            titles per run
          </label>
          {saved === 'sweep' && <span style={{ color: 'var(--muted)' }}>Saved ✓</span>}
        </div>
        <div className="row" style={{ marginTop: 8, gap: 8, alignItems: 'center' }}>
          <button onClick={sweepNow} disabled={sweepBusy || !s.openSubtitlesApiKey}>{sweepBusy ? 'Sweeping…' : 'Sweep now'}</button>
          {!s.openSubtitlesApiKey && <span style={{ color: 'var(--muted)', fontSize: 12 }}>Set up OpenSubtitles above first.</span>}
        </div>
        {last && (
          <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 8 }}>
            Last run: looked at {last.examined}, {last.missing} needed subtitles, downloaded {last.downloaded}, skipped {last.skipped}
            {last.errors && last.errors.length ? `, ${last.errors.length} error${last.errors.length === 1 ? '' : 's'}` : ''}
            {last.remainingDownloads != null ? ` — ${last.remainingDownloads} downloads left today` : ''}
            {last.stoppedEarly ? ` (stopped early: ${last.stoppedEarly.replace(/_/g, ' ')})` : ''}.
          </p>
        )}
        {sweepStatus && sweepStatus.error && <p style={{ color: 'var(--danger, #c62828)', fontSize: 12, marginTop: 8 }}>{sweepStatus.error}</p>}
      </div>

      <div style={{ marginBottom: 20 }}>
        <label>⏭ Skip intros and credits</label>
        <div style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.5 }}>
          <p style={{ margin: '4px 0 8px' }}>
            Beebo can find where each show&rsquo;s opening titles and end credits are by listening to the episodes of a season and
            comparing them, and by looking for the credits at the end of each file. It only works while nobody is watching, one file
            at a time at low priority, and everything stays on this computer. Anything a viewer marks by hand always wins over what
            Beebo finds, and you can re-scan or clear a show on the admin website&rsquo;s Markers tab.
          </p>
        </div>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
          <input type="checkbox" checked={s.autoMarkersEnabled !== false} onChange={(e) => saveSweep({ autoMarkersEnabled: e.target.checked })} />
          Detect intros and credits automatically
        </label>
      </div>

      <div style={{ marginBottom: 20 }}>
        <label>🖼 Seek previews</label>
        <div style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.5 }}>
          <p style={{ margin: '4px 0 8px' }}>
            Shows a small picture above the seek bar while you drag it, on the website and in the phone app. Beebo makes the pictures
            from key frames only, one at a time at low priority, and holds off while anyone is watching. They are kept in a cache on
            this computer; when it is full the ones you have used least recently are deleted.
          </p>
        </div>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
          <input type="checkbox" checked={s.trickplayEnabled !== false} onChange={(e) => saveSweep({ trickplayEnabled: e.target.checked })} />
          Generate seek previews
        </label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '8px 0 0' }}>
          Keep at most
          <select value={s.trickplayCacheMaxMB} disabled={s.trickplayEnabled === false} onChange={(e) => saveSweep({ trickplayCacheMaxMB: Number(e.target.value) })}>
            {[256, 512, 1024, 2048, 5120, 10240].map((n) => <option key={n} value={n}>{n >= 1024 ? `${n / 1024} GB` : `${n} MB`}</option>)}
          </select>
          of previews on disk
        </label>
      </div>
    </>
  )
}
