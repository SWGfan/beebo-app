'use strict'

// Home Game Server manages one local Minecraft (Paper) server, owner-operated
// only: only the owner can install, start, stop or delete it. It never opens
// a router port or changes firewall rules — "Away Play" (household members
// and invited friends joining from anywhere) is carried entirely by the
// existing, proven Beebo host agent (remoteHostAgent.js / beebo-rtc-host.js),
// which already gets Beebo video through NATs with a direct WebRTC connection
// first and Beebo Relay (the owner's own TURN server) as an automatic
// fallback. This module only tells that agent whether a local Minecraft
// server is running and on which port (see pushGameState below); it never
// talks WebRTC, TURN or the Worker itself.

const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { spawn, execFile } = require('node:child_process')

const ROOT_KEY = 'homeGameServer.minecraft'
const DEFAULT_MEMORY_MB = 2048
const MIN_MEMORY_MB = 1024
const MAX_MEMORY_MB = 8192
const DELETE_PHRASE = 'DELETE MINECRAFT SERVER'
const PAPER_API = 'https://api.papermc.io/v2/projects/paper'

function defaultRoot() {
  // Same root as storageDefaults.js (C:\Beebo), so Home Game Server doesn't
  // create a second, differently-named Beebo folder on a fresh install.
  return path.join(process.env.SystemDrive || 'C:', 'Beebo', 'GameServers', 'Minecraft')
}
function cleanName(value) {
  const text = String(value || '').trim().replace(/[^A-Za-z0-9._ -]/g, '')
  return text.slice(0, 80)
}
function normalizeConfig(value = {}) {
  const memory = Math.max(MIN_MEMORY_MB, Math.min(MAX_MEMORY_MB, Math.round(Number(value.memoryMb) || DEFAULT_MEMORY_MB)))
  const maxPlayers = Math.max(1, Math.min(50, Math.round(Number(value.maxPlayers) || 8)))
  const root = typeof value.root === 'string' && path.isAbsolute(value.root) ? path.resolve(value.root) : defaultRoot()
  return {
    root,
    installed: value.installed === true,
    version: typeof value.version === 'string' ? value.version.slice(0, 32) : '',
    build: Number.isInteger(value.build) ? value.build : 0,
    jarFile: typeof value.jarFile === 'string' && /^[A-Za-z0-9._-]+\.jar$/i.test(value.jarFile) ? value.jarFile : 'paper.jar',
    eulaAccepted: value.eulaAccepted === true,
    memoryMb: memory,
    maxPlayers,
    whitelist: value.whitelist !== false,
    onlineMode: value.onlineMode !== false,
    ownerApprovedPlugins: Array.isArray(value.ownerApprovedPlugins) ? value.ownerApprovedPlugins.filter(x => typeof x === 'string' && /^[A-Za-z0-9._ -]+\.jar$/i.test(x)).slice(0, 100) : []
  }
}
function isWithin(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate))
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))
}
function safePluginName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9._ -]+\.jar$/i.test(name) && !name.includes('..') ? name : ''
}
function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const input = fs.createReadStream(file)
    input.on('error', reject).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')))
  })
}
async function findJava() {
  const candidate = await new Promise(resolve => execFile(process.platform === 'win32' ? 'where.exe' : 'which', ['java'], { windowsHide: true, timeout: 5000, maxBuffer: 8192 }, (error, stdout) => {
    const found = String(stdout || '').split(/\r?\n/).map(x => x.trim()).find(Boolean)
    resolve(!error && found ? found : '')
  }))
  if (!candidate) return { path: '', compatible: false, version: '' }
  return new Promise(resolve => execFile(candidate, ['-version'], { windowsHide: true, timeout: 5000, maxBuffer: 8192 }, (error, stdout, stderr) => {
    const text = `${stdout || ''}\n${stderr || ''}`
    const match = text.match(/version\s+\"(?:1\.)?(\d+)/i)
    const major = match ? Number(match[1]) : 0
    resolve({ path: candidate, compatible: !error && major >= 21, version: match ? String(major) : '' })
  }))
}
function makeServerProperties(config) {
  return [
    'motd=Beebo Home Minecraft Server',
    `max-players=${config.maxPlayers}`,
    `white-list=${config.whitelist ? 'true' : 'false'}`,
    `online-mode=${config.onlineMode ? 'true' : 'false'}`,
    'enable-rcon=false',
    'enable-query=false',
    'server-port=25565',
    'server-ip=',
    'spawn-protection=16',
    'view-distance=10',
    'simulation-distance=10'
  ].join('\n') + '\n'
}

// The fixed Minecraft server-port from makeServerProperties(). The "mc" data
// channel in beebo-rtc-host.js bridges to 127.0.0.1 on exactly this port, so
// the two must never drift apart.
const GAME_PORT = 25565

// What to tell the running beebo-rtc-host.js agent: bridge its "mc" data
// channel only while a server is actually running here. Pure so it can be
// tested without spawning Java. The agent itself never opens a router port
// or changes firewall rules; this only toggles whether an ALREADY-established
// peer connection (the same one Beebo video already uses away from home) may
// also carry Minecraft bytes.
function gameStateFor(status) {
  return { enabled: status === 'running', port: GAME_PORT }
}

// The "Connection and backups" card's content, from the registered remote
// name (empty when signed out / not yet registered). Pure so the exact
// wording and the { available, host, port } shape are tested directly.
function awayPlayInfo(remoteName) {
  const name = String(remoteName || '').trim().toLowerCase()
  if (!name) return { available: false, label: 'Away Play needs sign-in', detail: 'Sign in to Beebo on this computer so household members and friends can join this server from anywhere, with no port forwarding.' }
  return {
    available: true, mode: 'beebo-p2p', label: 'Away Play is on',
    detail: `Household members and invited friends can join from anywhere at ${name}.beebo.tv, the same way Beebo video works: direct peer-to-peer first, falling back to Beebo Relay automatically. No router or firewall changes.`,
    host: `${name}.beebo.tv`, port: GAME_PORT,
  }
}

function createGameHost({ store, app, dialog, ipcMain, getMainWindow, fetchImpl = globalThis.fetch, getRemoteHost, getRemoteName } = {}) {
  let child = null
  let status = 'stopped'
  let lastError = ''
  let logs = []
  const log = line => { logs = [...logs, `[${new Date().toLocaleTimeString()}] ${String(line).trim()}`].filter(Boolean).slice(-120) }
  const get = () => normalizeConfig(store.get(ROOT_KEY) || {})
  const save = partial => { const next = normalizeConfig({ ...get(), ...partial }); store.set(ROOT_KEY, next); return next }
  const trusted = event => { const window = getMainWindow(); return !!window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame }
  // Tells the running beebo-rtc-host.js agent whether to bridge its "mc" data
  // channel to this Minecraft server right now. The agent itself never opens
  // a router port or changes firewall rules (that promise is unchanged); this
  // only lets an ALREADY-established, direct-or-Beebo-Relay peer connection
  // (the same one that already carries Beebo video, away from home) also
  // carry Minecraft bytes, and only while a server is actually running here.
  const pushGameState = () => {
    try {
      const host = typeof getRemoteHost === 'function' ? getRemoteHost() : null
      if (host && typeof host.setGame === 'function') host.setGame(gameStateFor(status))
    } catch (_) {}
  }
  const view = async () => {
    const config = get()
    const jarPath = path.join(config.root, config.jarFile)
    const java = await findJava()
    const pluginsDir = path.join(config.root, 'plugins')
    let plugins = []
    try {
      plugins = (await fsp.readdir(pluginsDir, { withFileTypes: true })).filter(x => x.isFile() && safePluginName(x.name)).map(x => ({ name: x.name, approved: config.ownerApprovedPlugins.includes(x.name) }))
    } catch (_) {}
    const remoteName = (() => { try { return (typeof getRemoteName === 'function' && getRemoteName()) || '' } catch (_) { return '' } })()
    const relay = awayPlayInfo(remoteName)
    return {
      ok: true, game: 'minecraft', status, error: lastError, logs, config: { ...config, jarPresent: fs.existsSync(jarPath), javaPresent: !!java.path, javaCompatible: java.compatible, javaVersion: java.version || null },
      plugins, relay,
      safeguards: ['Only the server owner can install, start, stop or delete this server.', 'Plugins are added from a file you choose and need owner approval.', 'The server never changes your router or firewall settings — Away Play reuses Beebo’s existing peer-to-peer video connection instead of opening one.', 'The server uses the selected memory limit and stays separate from Beebo video services.']
    }
  }
  const requireStopped = () => { if (status !== 'stopped') { const error = new Error('Save and stop the server before changing its files.'); error.code = 'server_running'; throw error } }
  async function install({ eulaAccepted, version = '' } = {}) {
    requireStopped()
    if (eulaAccepted !== true) { const error = new Error('Read and accept the Minecraft EULA before installing a server.'); error.code = 'eula_required'; throw error }
    if (!fetchImpl) { const error = new Error('The Paper download service is unavailable.'); error.code = 'download_unavailable'; throw error }
    status = 'installing'; lastError = ''; log('Preparing Minecraft server installation.')
    try {
      const versions = await fetchImpl(PAPER_API).then(r => r.ok ? r.json() : Promise.reject(new Error('Paper versions could not be checked.')))
      const chosenVersion = typeof version === 'string' && versions.versions.includes(version) ? version : versions.versions.at(-1)
      const builds = await fetchImpl(`${PAPER_API}/versions/${encodeURIComponent(chosenVersion)}/builds`).then(r => r.ok ? r.json() : Promise.reject(new Error('Paper builds could not be checked.')))
      const build = builds.builds.at(-1)
      const downloaded = build && build.downloads && build.downloads.application
      if (!downloaded || !/^[a-f0-9]{64}$/i.test(downloaded.sha256 || '')) throw new Error('Paper did not provide a verified server download.')
      const config = get()
      await fsp.mkdir(config.root, { recursive: true })
      await fsp.mkdir(path.join(config.root, 'plugins'), { recursive: true })
      const response = await fetchImpl(`${PAPER_API}/versions/${encodeURIComponent(chosenVersion)}/builds/${build.build}/downloads/${encodeURIComponent(downloaded.name)}`)
      if (!response.ok) throw new Error('The Paper server download could not finish.')
      const bytes = Buffer.from(await response.arrayBuffer())
      const actual = crypto.createHash('sha256').update(bytes).digest('hex')
      if (actual.toLowerCase() !== downloaded.sha256.toLowerCase()) throw new Error('The downloaded server file did not pass its security check.')
      const jarPath = path.join(config.root, 'paper.jar')
      await fsp.writeFile(jarPath, bytes, { mode: 0o600 })
      await fsp.writeFile(path.join(config.root, 'eula.txt'), 'eula=true\n', { mode: 0o600 })
      await fsp.writeFile(path.join(config.root, 'server.properties'), makeServerProperties(config), { mode: 0o600 })
      save({ installed: true, version: chosenVersion, build: build.build, jarFile: 'paper.jar', eulaAccepted: true })
      log(`Paper ${chosenVersion} build ${build.build} installed.`)
    } catch (error) { lastError = error.message || 'The server could not be installed.'; log(lastError); throw error }
    finally { status = 'stopped' }
    return view()
  }
  async function start() {
    if (status !== 'stopped') { const error = new Error('The server is already starting or running.'); error.code = 'server_busy'; throw error }
    const config = get(); const jarPath = path.join(config.root, config.jarFile)
    if (!config.installed || !config.eulaAccepted || !fs.existsSync(jarPath)) { const error = new Error('Install Minecraft and accept its EULA first.'); error.code = 'not_installed'; throw error }
    const java = await findJava()
    if (!java.compatible) { const error = new Error('Java 21 or newer is needed before Minecraft can start.'); error.code = 'java_required'; throw error }
    await fsp.writeFile(path.join(config.root, 'server.properties'), makeServerProperties(config), { mode: 0o600 })
    status = 'starting'; lastError = ''
    child = spawn(java.path, [`-Xms512M`, `-Xmx${config.memoryMb}M`, '-jar', config.jarFile, 'nogui'], { cwd: config.root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdout.on('data', data => log(data)); child.stderr.on('data', data => log(data))
    child.once('spawn', () => { status = 'running'; log('Minecraft server started.'); pushGameState() })
    child.once('error', error => { lastError = error.message || 'Minecraft could not start.'; log(lastError); status = 'stopped'; child = null; pushGameState() })
    child.once('exit', (code, signal) => { log(`Minecraft server stopped${signal ? ` (${signal})` : code === 0 ? '' : ` (exit ${code})`}.`); status = 'stopped'; child = null; pushGameState() })
    return view()
  }
  async function stop() {
    if (!child || status === 'stopped') return view()
    status = 'stopping'; log('Saving world and stopping Minecraft server.')
    // Stop bridging new Away Play connections the moment a stop is requested,
    // even though the process itself may take up to 30s to save and exit.
    pushGameState()
    try { child.stdin.write('save-all\n'); child.stdin.write('stop\n') } catch (_) {}
    const current = child
    setTimeout(() => { if (child === current && status === 'stopping') { log('Minecraft took too long to stop; ending its process.'); try { current.kill() } catch (_) {} } }, 30000).unref?.()
    return view()
  }
  async function updateSettings(input = {}) {
    const allowed = { memoryMb: input.memoryMb, maxPlayers: input.maxPlayers, whitelist: input.whitelist === true, onlineMode: input.onlineMode !== false }
    save(allowed); return view()
  }
  async function addPlugin() {
    requireStopped()
    const result = await dialog.showOpenDialog(getMainWindow(), { title: 'Choose a Minecraft plugin', properties: ['openFile'], filters: [{ name: 'Minecraft plugins', extensions: ['jar'] }] })
    if (result.canceled || !result.filePaths?.[0]) return { ok: true, cancelled: true }
    const source = result.filePaths[0]; const name = safePluginName(path.basename(source))
    if (!name) { const error = new Error('Choose a Minecraft plugin .jar file.'); error.code = 'invalid_plugin'; throw error }
    const config = get(); const pluginsDir = path.join(config.root, 'plugins'); const destination = path.join(pluginsDir, name)
    await fsp.mkdir(pluginsDir, { recursive: true }); await fsp.copyFile(source, destination)
    const digest = await sha256(destination)
    const approved = [...new Set([...config.ownerApprovedPlugins, name])]
    save({ ownerApprovedPlugins: approved }); log(`Owner approved plugin: ${name}`)
    return { ...(await view()), added: { name, sha256: digest } }
  }
  async function removePlugin({ name } = {}) {
    requireStopped(); const valid = safePluginName(name); const config = get()
    if (!valid) { const error = new Error('Choose a valid plugin.'); error.code = 'invalid_plugin'; throw error }
    const pluginsDir = path.join(config.root, 'plugins'); const target = path.join(pluginsDir, valid)
    if (!isWithin(pluginsDir, target)) { const error = new Error('That plugin is outside this Minecraft server.'); error.code = 'invalid_plugin'; throw error }
    await fsp.rm(target, { force: true }); save({ ownerApprovedPlugins: config.ownerApprovedPlugins.filter(x => x !== valid) }); log(`Removed plugin: ${valid}`); return view()
  }
  async function erase({ confirmation } = {}) {
    requireStopped()
    if (confirmation !== DELETE_PHRASE) { const error = new Error(`Type ${DELETE_PHRASE} to delete this Minecraft server.`); error.code = 'confirmation_required'; throw error }
    const config = get(); const root = config.root
    if (!isWithin(path.join(process.env.SystemDrive || 'C:', 'Beebo', 'GameServers'), root)) { const error = new Error('This server folder is not managed by Beebo.'); error.code = 'unsafe_root'; throw error }
    await fsp.rm(root, { recursive: true, force: true }); store.delete(ROOT_KEY); logs = []; lastError = ''; return view()
  }
  function handle(name, callback) { ipcMain.handle(`gameHost:${name}`, async (event, args) => { if (!trusted(event)) return { ok: false, error: 'forbidden', message: 'Use the Beebo desktop window to manage a game server.' }; try { return await callback(args || {}) } catch (error) { return { ok: false, error: error.code || 'operation_failed', message: error.message || 'This game-server action could not finish.' } } }) }
  handle('info', view); handle('install', install); handle('start', start); handle('stop', stop); handle('settings', updateSettings); handle('addPlugin', addPlugin); handle('removePlugin', removePlugin); handle('delete', erase)
  return { stop, info: view }
}

module.exports = { createGameHost, normalizeConfig, makeServerProperties, safePluginName, DELETE_PHRASE, MIN_MEMORY_MB, MAX_MEMORY_MB, GAME_PORT, gameStateFor, awayPlayInfo }
