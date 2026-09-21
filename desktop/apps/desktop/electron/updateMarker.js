// "An update is being installed right now" marker, shared with the watchdog.
//
// BeeboWatchdog (the owner's watchdog script) relaunches Beebo whenever it
// isn't running. During an install Beebo is deliberately NOT running, and
// starting the old exe then would either fight the installer for its files or
// run a half-replaced app. So both the app (just before it launches the
// installer) and the installer itself (installer.nsh, first thing) write this
// file, and the watchdog leaves Beebo alone while it exists and is fresh.
//
// Machine-wide location, because the watchdog, the app and the elevated
// installer may each see a different %APPDATA%:
//   %ProgramData%\Beebo Entertainment\update-in-progress.json
// A marker older than MAX_AGE_MS is ignored everywhere (a crashed installer
// must not switch the watchdog off forever).
const fs = require('fs')
const path = require('path')

const MAX_AGE_MS = 15 * 60 * 1000
const FILE_NAME = 'update-in-progress.json'

function markerPath(env = process.env) {
  const base = env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData'
  return path.join(base, 'Beebo Entertainment', FILE_NAME)
}

function writeMarker(info = {}, file = markerPath()) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ by: 'app', pid: process.pid, at: Date.now(), ...info }))
    return true
  } catch (e) {
    return false
  }
}

function readMarker(file = markerPath(), now = Date.now()) {
  try {
    const st = fs.statSync(file)
    const age = now - st.mtimeMs
    return { exists: true, fresh: age >= -60000 && age < MAX_AGE_MS, ageMs: age }
  } catch (e) {
    return { exists: false, fresh: false, ageMs: null }
  }
}

function clearMarker(file = markerPath()) {
  try { fs.unlinkSync(file); return true } catch (e) { return false }
}

module.exports = { markerPath, writeMarker, readMarker, clearMarker, MAX_AGE_MS }
