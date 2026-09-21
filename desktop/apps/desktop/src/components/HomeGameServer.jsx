import React, { useEffect, useMemo, useState } from 'react'

const DELETE_PHRASE = 'DELETE MINECRAFT SERVER'

function Card({ title, children, tone = '' }) {
  return <section className={`settings-panel ${tone}`} style={{ maxWidth: 1040 }}><h3>{title}</h3>{children}</section>
}

function JoinGameServer() {
  const [status, setStatus] = useState(null)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const refresh = async () => {
    try { const next = await window.beeboentertainment?.gameJoin?.status?.(); if (next) setStatus(next) } catch {}
  }
  useEffect(() => { refresh(); const timer = setInterval(refresh, 4000); return () => clearInterval(timer) }, [])

  const join = async () => {
    setBusy(true); setMessage('')
    try {
      const result = await window.beeboentertainment.gameJoin.join({ name, email, password })
      if (!result?.ok) throw new Error(result?.message || 'Could not join that game server.')
      setStatus(result)
    } catch (error) { setMessage(error?.message || 'Could not join that game server.') }
    finally { setBusy(false) }
  }
  const leave = async () => { setBusy(true); try { setStatus(await window.beeboentertainment.gameJoin.leave()) } finally { setBusy(false) } }

  if (!window.beeboentertainment?.gameJoin) return null
  return <Card title="Join a friend's Beebo game server">
    <p>Enter the Beebo name a friend or household member gave you (e.g. <code>samplehouse86</code>) and sign in — the same way you'd sign in to watch their Beebo away from home. Beebo tries a direct connection first and falls back to Beebo Relay automatically. No router or firewall changes on your end either.</p>
    {message && <p role="alert" className="error-text">{message}</p>}
    {status?.joined
      ? <>
          <p><strong style={{ color: status.ready ? '#52e394' : '#d5d9e2' }}>{status.ready ? 'Connected' : 'Connecting…'}</strong> to <code>{status.name}.beebo.tv</code>. Point your Minecraft client at <code>localhost</code>{status.localPort !== 25565 ? `:${status.localPort}` : ''} to play.</p>
          {status.error && <p className="error-text">{status.error}</p>}
          <button type="button" className="danger" onClick={leave} disabled={busy}>Disconnect</button>
        </>
      : <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, maxWidth: 760 }}>
          <label>Beebo name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="samplehouse86" /></label>
          <label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          <label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          <div style={{ display: 'flex', alignItems: 'flex-end' }}><button type="button" onClick={join} disabled={busy || !name}>Join</button></div>
        </div>}
  </Card>
}

export default function HomeGameServer({ active }) {
  const [info, setInfo] = useState(null)
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [eula, setEula] = useState(false)
  const [deleteText, setDeleteText] = useState('')
  const [settings, setSettings] = useState(null)

  const refresh = async () => {
    try {
      const next = await window.beeboentertainment?.gameHost?.info?.()
      if (next?.ok) { setInfo(next); setSettings((current) => current || next.config) }
      else if (next?.message) setMessage(next.message)
    } catch { setMessage('The Home Game Server status could not be checked.') }
  }
  useEffect(() => { refresh() }, [])
  useEffect(() => {
    if (!active) return undefined
    const timer = setInterval(refresh, 5000)
    return () => clearInterval(timer)
  }, [active])
  const run = async (name, job) => {
    setBusy(name); setMessage('')
    try {
      const result = await job()
      if (!result?.ok) throw new Error(result?.message || 'That action could not finish.')
      setInfo(result); if (result.config) setSettings(result.config)
      if (result.added) setMessage(`${result.added.name} was added and approved. Restart Minecraft before using it.`)
    } catch (error) { setMessage(error?.message || 'That action could not finish.') }
    finally { setBusy(''); refresh() }
  }
  const config = settings || info?.config
  const canStart = !!(config?.installed && config?.jarPresent && config?.javaCompatible && info?.status === 'stopped')
  const statusLabel = useMemo(() => ({ stopped: 'Stopped', installing: 'Installing', starting: 'Starting', running: 'Running', stopping: 'Saving and stopping' }[info?.status] || 'Checking'), [info?.status])

  if (!window.beeboentertainment?.gameHost) return <div><h2>Home Game Server</h2><p className="empty-state">Restart Beebo Entertainment to use the Home Game Server controls.</p></div>
  return <div>
    <p style={{ color: '#b691ff', fontSize: 11, letterSpacing: 2, fontWeight: 700, marginBottom: 7 }}>BEEBO HOST · HOME GAME SERVER</p>
    <h2 style={{ marginBottom: 8 }}>Minecraft on this computer</h2>
    <p style={{ maxWidth: 820, lineHeight: 1.6 }}>Set up a private Minecraft server your family controls. Beebo keeps the game separate from your library, video connections and VPN. Only the owner can make changes here.</p>
    {message && <p role="alert" style={{ border: '1px solid #855f25', background: '#261d0e', color: '#f6cf73', borderRadius: 10, padding: '10px 12px', maxWidth: 1040 }}>{message}</p>}

    <Card title="Server status">
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong style={{ color: info?.status === 'running' ? '#52e394' : '#d5d9e2' }}>{statusLabel}</strong>
        <span style={{ color: 'var(--muted)' }}>{config?.installed ? `Paper ${config.version || 'Minecraft'}${config.build ? ` · build ${config.build}` : ''}` : 'Minecraft is not installed yet.'}</span>
        <button type="button" onClick={refresh} disabled={!!busy}>Refresh</button>
      </div>
      {info?.error && <p role="alert" className="error-text">{info.error}</p>}
      {config?.installed && !config.javaCompatible && <p className="error-text">Java 21 or newer is required before this Minecraft server can start.</p>}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 16 }}>
        {!config?.installed && <button type="button" onClick={() => run('install', () => window.beeboentertainment.gameHost.install({ eulaAccepted: eula }))} disabled={!eula || !!busy}>Install Minecraft server</button>}
        {canStart && <button type="button" onClick={() => run('start', () => window.beeboentertainment.gameHost.start())} disabled={!!busy}>Start server</button>}
        {info?.status === 'running' && <button type="button" className="danger" onClick={() => run('stop', () => window.beeboentertainment.gameHost.stop())} disabled={!!busy}>Save and stop server</button>}
        {(info?.status === 'starting' || info?.status === 'stopping' || info?.status === 'installing') && <span style={{ color: 'var(--muted)' }}>Please wait for this action to finish.</span>}
      </div>
      {!config?.installed && <label style={{ marginTop: 16, alignItems: 'flex-start' }}><input type="checkbox" checked={eula} onChange={(event) => setEula(event.target.checked)} /><span>I have read and accept the Minecraft EULA for this server. Beebo will download Paper, a Minecraft server implementation, only after I approve.</span></label>}
    </Card>

    <Card title="Parent controls">
      <p>These controls are stored on this computer. They do not open router ports or alter Windows Firewall. Use a parent Windows account and a separate standard Windows account for children: Beebo can control the game, while Windows protects the server files themselves.</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 14, maxWidth: 720 }}>
        <label style={{ display: 'block' }}>Memory limit (MB)<input type="number" min="1024" max="8192" step="256" value={config?.memoryMb || 2048} disabled={info?.status !== 'stopped'} onChange={(event) => setSettings({ ...config, memoryMb: event.target.value })} /></label>
        <label style={{ display: 'block' }}>Maximum players<input type="number" min="1" max="50" value={config?.maxPlayers || 8} disabled={info?.status !== 'stopped'} onChange={(event) => setSettings({ ...config, maxPlayers: event.target.value })} /></label>
      </div>
      <label><input type="checkbox" checked={config?.whitelist !== false} disabled={info?.status !== 'stopped'} onChange={(event) => setSettings({ ...config, whitelist: event.target.checked })} /> Require the owner to approve each player</label>
      <label><input type="checkbox" checked={config?.onlineMode !== false} disabled={info?.status !== 'stopped'} onChange={(event) => setSettings({ ...config, onlineMode: event.target.checked })} /> Require players to sign in with a valid Minecraft account</label>
      <button type="button" onClick={() => run('settings', () => window.beeboentertainment.gameHost.saveSettings(settings))} disabled={!!busy || info?.status !== 'stopped'}>Save parent controls</button>
    </Card>

    <Card title="Plugins — owner approval required">
      <p>Add a plugin file you already chose and reviewed. Beebo records that you approved it, shows it here, and never downloads plugins automatically.</p>
      <button type="button" onClick={() => run('plugin', () => window.beeboentertainment.gameHost.addPlugin())} disabled={!!busy || info?.status !== 'stopped'}>Add plugin file</button>
      {!info?.plugins?.length ? <p className="empty-state">No approved plugins yet.</p> : <ul style={{ paddingLeft: 20 }}>{info.plugins.map((plugin) => <li key={plugin.name} style={{ margin: '9px 0' }}><strong>{plugin.name}</strong> <span style={{ color: '#52e394' }}>Owner approved</span> <button type="button" className="danger" style={{ marginLeft: 12 }} onClick={() => run('remove-plugin', () => window.beeboentertainment.gameHost.removePlugin(plugin.name))} disabled={!!busy || info?.status !== 'stopped'}>Remove</button></li>)}</ul>}
      <p style={{ color: 'var(--muted)', fontSize: 13 }}>Plugins can change how a game server behaves. Install only files from sources you trust and restart the server after any change.</p>
    </Card>

    <Card title="Away Play — join from anywhere, no port forwarding">
      <p><strong>{info?.relay?.label || 'Away Play needs sign-in'}</strong><br />{info?.relay?.detail || 'Sign in to Beebo on this computer to let household members and friends join this server from anywhere.'}</p>
      {info?.relay?.available && <p style={{ color: 'var(--muted)' }}>Have a household member or friend open Beebo, choose <strong>Join a game</strong>, and enter <code>{info.relay.host}</code> — Beebo tries a direct connection first and falls back to Beebo Relay automatically, exactly like watching video away from home.</p>}
      <p>Your world folder is kept inside <code>{config?.root || 'the Beebo game-server folder'}</code>; copy it to a backup location whenever you want an extra saved copy.</p>
    </Card>

    <Card title="Delete this Minecraft server" tone="danger">
      <p>Deleting removes this Minecraft server, its world, settings and plugin files from this computer. It does not affect your Beebo movies, photos, VPN or other services.</p>
      <label style={{ display: 'block', maxWidth: 420 }}>Type <strong>{DELETE_PHRASE}</strong> to continue<input value={deleteText} onChange={(event) => setDeleteText(event.target.value)} disabled={info?.status !== 'stopped'} /></label>
      <button type="button" className="danger" onClick={() => run('delete', () => window.beeboentertainment.gameHost.deleteServer(deleteText))} disabled={deleteText !== DELETE_PHRASE || !!busy || info?.status !== 'stopped'}>Delete Minecraft server</button>
    </Card>

    {info?.logs?.length > 0 && <Card title="Recent server activity"><pre style={{ whiteSpace: 'pre-wrap', margin: 0, maxHeight: 260, overflow: 'auto', color: '#b7c4d8', fontSize: 12 }}>{info.logs.join('\n')}</pre></Card>}

    <JoinGameServer />
  </div>
}
