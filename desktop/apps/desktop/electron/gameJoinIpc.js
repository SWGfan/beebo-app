'use strict'

// Away Play — joining side. Runs beebo-game-client.js (resources/beebo-rtc-host/
// beebo-game-client.js) as a child process, the same way remoteHostAgent.js runs
// the host agent: fork() with ELECTRON_RUN_AS_NODE so the packaged Electron
// binary behaves as plain Node, config entirely through environment variables.
//
// This module owns none of the WebRTC logic — see beebo-game-client.js for the
// full explanation of how a joiner reuses Beebo's proven direct-then-Beebo-Relay
// video path for a Minecraft data channel. This is only the Electron plumbing:
// take a house name + sign-in from the renderer, spawn the client, report status.

const { fork } = require('node:child_process')
const path = require('node:path')

const NAME_RE = /^[a-z0-9-]{1,63}$/i
const READY_RE = /ready — point your Minecraft client/i
const FATAL_RE = /^\[beebo-join\] (.*failed.*|fatal:.*)$/i

function createGameJoin({ app, ipcMain, getMainWindow } = {}) {
  const base = app && app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'resources')
  const CLIENT_SCRIPT = path.join(base, 'beebo-rtc-host', 'beebo-game-client.js')

  let child = null
  let joinedName = ''
  let localPort = 25565
  let ready = false
  let lastError = ''
  const trusted = event => { const window = getMainWindow(); return !!window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame }

  function stopChild() {
    if (!child) return
    const c = child
    child = null
    try { c.kill() } catch (_) {}
  }

  async function join({ name, email, password, username, householdPass, localPort: port } = {}) {
    const cleanName = String(name || '').trim().toLowerCase()
    if (!NAME_RE.test(cleanName)) { const error = new Error('Enter the Beebo name of the house to join, e.g. "samplehouse86".'); error.code = 'bad_name'; throw error }
    const hasCreds = (username && password) || householdPass || (email && password)
    if (!hasCreds) { const error = new Error('Enter a sign-in: the household pass, a member username and password, or the owner email and password.'); error.code = 'missing_credentials'; throw error }
    stopChild()
    ready = false; lastError = ''; joinedName = cleanName
    localPort = Number.isInteger(Number(port)) && Number(port) > 0 && Number(port) < 65536 ? Number(port) : 25565

    const c = fork(CLIENT_SCRIPT, [], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        BEEBO_JOIN_NAME: cleanName,
        BEEBO_JOIN_EMAIL: email || '',
        BEEBO_JOIN_PASSWORD: password || '',
        BEEBO_JOIN_USERNAME: username || '',
        BEEBO_JOIN_HOUSEHOLD_PASS: householdPass || '',
        BEEBO_JOIN_LOCAL_PORT: String(localPort),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    child = c
    let buf = ''
    const onChunk = chunk => {
      if (child !== c) return
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        if (!line) continue
        if (READY_RE.test(line)) ready = true
        if (FATAL_RE.test(line)) lastError = line.replace(/^\[beebo-join\]\s*/, '')
      }
    }
    if (c.stdout) { c.stdout.setEncoding('utf8'); c.stdout.on('data', onChunk) }
    if (c.stderr) { c.stderr.setEncoding('utf8'); c.stderr.on('data', onChunk) }
    c.on('exit', () => { if (child === c) { child = null; ready = false } })
    return status()
  }

  async function leave() {
    stopChild()
    ready = false; joinedName = ''; lastError = ''
    return status()
  }

  function status() {
    return { ok: true, joined: !!child, ready, name: joinedName, localPort, error: lastError }
  }

  function handle(name, callback) {
    ipcMain.handle(`gameJoin:${name}`, async (event, args) => {
      if (!trusted(event)) return { ok: false, error: 'forbidden', message: 'Use the Beebo desktop window to join a game server.' }
      try { return await callback(args || {}) } catch (error) { return { ok: false, error: error.code || 'operation_failed', message: error.message || 'Could not join that game server.' } }
    })
  }
  handle('join', join); handle('leave', leave); handle('status', async () => status())
  return { join, leave, status, stop: leave }
}

module.exports = { createGameJoin }
