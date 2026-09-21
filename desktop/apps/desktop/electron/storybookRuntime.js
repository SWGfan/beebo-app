const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const ENGLISH_VOICES = new Set(('af_heart af_alloy af_aoede af_bella af_jessica af_kore af_nicole af_nova af_river af_sarah af_sky am_adam am_echo am_eric am_fenrir am_liam am_michael am_onyx am_puck am_santa bf_alice bf_emma bf_isabella bf_lily bm_daniel bm_fable bm_george bm_lewis').split(' '))
const jobs = new Map()
const isDir = p => { try { return fs.statSync(p).isDirectory() } catch { return false } }
const isFile = p => { try { return fs.statSync(p).isFile() } catch { return false } }
const safeSegment = s => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(String(s || '')) ? String(s) : null

/** The installer holds only original templates. Personalized audio belongs in the user's data folder. */
function ensureLibrary({ store, userData, resourcesPath = process.resourcesPath, appDir = path.join(__dirname, '..') }) {
  const configured = store.get('storybooksPath')
  const root = configured && isDir(configured) && !configured.includes('app.asar')
    ? configured : path.join(userData, 'storybooks')
  const source = [resourcesPath && path.join(resourcesPath, 'storybooks'), path.join(appDir, 'storybooks')]
    .filter(Boolean).find(p => isFile(path.join(p, 'index.json')))
  if (!source) return null
  fs.mkdirSync(root, { recursive: true })
  const incoming = JSON.parse(fs.readFileSync(path.join(source, 'index.json'), 'utf8'))
  let existing = { books: [] }
  const indexFile = path.join(root, 'index.json')
  // Do not replace a damaged custom index or user-authored stories silently.
  if (isFile(indexFile)) existing = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
  if (!Array.isArray(existing.books) || !Array.isArray(incoming.books)) throw new Error('Story index is invalid')
  const books = [...existing.books]
  for (const book of incoming.books) {
    if (!safeSegment(book.slug)) continue
    const from = path.join(source, book.slug, 'template.json')
    if (!isFile(from)) continue
    const to = path.join(root, book.slug, 'template.json')
    fs.mkdirSync(path.dirname(to), { recursive: true })
    if (!isFile(to)) fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL)
    if (!books.some(b => b.slug === book.slug)) books.push(book)
  }
  if (!isFile(indexFile) || books.length !== existing.books.length) {
    fs.writeFileSync(indexFile + '.tmp', JSON.stringify({ ...existing, books }, null, 2))
    fs.renameSync(indexFile + '.tmp', indexFile)
  }
  if (root !== configured) store.set('storybooksPath', root)
  return root
}

function workerPath(name, resourcesPath = process.resourcesPath, electronDir = __dirname) {
  if (!['generate_storybook.py', 'say.py'].includes(name)) throw new Error('Unknown voice worker')
  const candidates = [resourcesPath && path.join(resourcesPath, 'beebobook', name), path.join(electronDir, 'beebobook', name)].filter(Boolean)
  const file = candidates.find(p => !/(?:^|[\\/])app\.asar(?:[\\/]|$)/.test(p) && isFile(p))
  if (!file) throw new Error('The voice files are missing. Install the latest Windows Beebo update.')
  return file
}

function pythonCommand(root) {
  const config = path.join(root, 'python-cmd.json')
  if (isFile(config)) {
    const value = JSON.parse(fs.readFileSync(config, 'utf8'))
    if (typeof value.cmd !== 'string' || !value.cmd || (value.args && (!Array.isArray(value.args) || value.args.some(x => typeof x !== 'string')))) throw new Error('Invalid voice Python configuration')
    return { cmd: value.cmd, args: value.args || [] }
  }
  return process.platform === 'win32' ? { cmd: 'py', args: ['-3'] } : { cmd: 'python3', args: [] }
}

function workerEnvironment(resourcesPath = process.resourcesPath, appDir = path.join(__dirname, '..')) {
  const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', HF_HUB_DISABLE_TELEMETRY: '1' }
  // Prefer the LGPL FFmpeg shipped with Beebo, without changing the machine PATH.
  const ffmpeg = [resourcesPath && path.join(resourcesPath, 'ffmpeg'), path.join(appDir, 'resources', 'ffmpeg')]
    .filter(Boolean).find(p => isFile(path.join(p, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')))
  if (ffmpeg) {
    const key = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH'
    env[key] = ffmpeg + path.delimiter + (env[key] || '')
  }
  return env
}

function active(marker) { return jobs.has(marker) }

/** Keep logs and clear failed markers, so a failed worker can be retried immediately. */
function launch({ root, name, args, marker, errorFile, readyFile, logFile }) {
  if (active(marker)) return
  if (jobs.size >= 2) throw new Error('Two voices are preparing already. Please try again shortly.')
  const py = pythonCommand(root), script = workerPath(name)
  fs.mkdirSync(path.dirname(marker), { recursive: true })
  fs.rmSync(errorFile, { force: true })
  const fd = fs.openSync(logFile, 'w')
  let child, timer
  try {
    fs.writeFileSync(marker, String(Date.now()))
    child = spawn(py.cmd, [...py.args, script, ...args], { windowsHide: true, stdio: ['ignore', fd, fd], env: workerEnvironment() })
  } finally { fs.closeSync(fd) }
  jobs.set(marker, child)
  let finished = false
  const finish = (message) => {
    if (finished) return
    finished = true; clearTimeout(timer); jobs.delete(marker)
    fs.rmSync(marker, { force: true })
    if (message) fs.writeFileSync(errorFile, message)
  }
  child.once('error', () => finish('The computer voice engine could not start. Check Python and the Beebo voice setup.'))
  child.once('exit', code => finish(code === 0 && isFile(readyFile) ? null : 'The computer voice engine could not finish. Check the local voice log or run the Beebo voice setup.'))
  timer = setTimeout(() => { child.kill(); finish('Voice preparation took too long. Please try again.'); }, 15 * 60 * 1000)
  timer.unref()
}

module.exports = { ensureLibrary, workerPath, pythonCommand, workerEnvironment, safeSegment, ENGLISH_VOICES, active, launch }
