'use strict'
// ============================================================================
// speechPack/whisper.js - the only code that starts a child process for the Speech Pack.
// ----------------------------------------------------------------------------
//   * NO SHELL. Programs are started with spawn(exe, argsArray, { shell: false }); the argument
//     lists are built here from validated values only (absolute paths we made ourselves, a
//     language code that matched /^[a-z]{2,3}$/ or "auto", an integer thread count).
//   * A minimal environment is passed (not the app's whole one), the working directory is the
//     private per-job folder, and the program runs at LOW priority.
//   * Every run has a hard timeout, an output cap and an AbortSignal (used to stop the moment a
//     viewer starts watching, or when the owner cancels).
//   * Nothing here logs file names or transcript text; callers log through redactions.
//   * The whisper.cpp binary is only ever reached through addons.resolve(), which has already
//     re-verified its SHA-256 against the record made at install time.
// ============================================================================

const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const detect = require('../../introDetect')
const srt = require('./srt')

const OUTPUT_CAP = 64 * 1024

/** Environment handed to child programs: only what a Windows/Linux program needs to start. */
function childEnv(extra = {}) {
  const keep = ['PATH', 'Path', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL']
  const env = {}
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k]
  return { ...env, ...extra }
}

/**
 * runChild(exe, args, { timeoutMs, signal, priority, cwd, env, spawnFn })
 * -> { code, timedOut, cancelled, error, stdout, stderr }   (never rejects)
 * stdout/stderr are only the LAST OUTPUT_CAP characters.
 */
function runChild(exe, args, { timeoutMs = 600000, signal = null, priority = 'below', cwd, env, spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawnFn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false, cwd, env: env || childEnv() })
    } catch (e) {
      resolve({ code: -1, timedOut: false, cancelled: false, error: String((e && e.message) || e), stdout: '', stderr: '' })
      return
    }
    if (priority) {
      try { os.setPriority(child.pid, priority === 'low' ? os.constants.priority.PRIORITY_LOW : os.constants.priority.PRIORITY_BELOW_NORMAL) } catch {}
    }
    let stdout = ''
    let stderr = ''
    let done = false
    let timedOut = false
    let cancelled = false
    const kill = () => { try { child.kill('SIGKILL') } catch {} }
    const timer = setTimeout(() => { timedOut = true; kill() }, timeoutMs)
    if (timer.unref) timer.unref()
    const onAbort = () => { cancelled = true; kill() }
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }) }
    const finish = (code, error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve({ code, timedOut, cancelled, error: error || null, stdout: stdout.slice(-OUTPUT_CAP), stderr: stderr.slice(-OUTPUT_CAP) })
    }
    if (child.stdout) child.stdout.on('data', (d) => { stdout = (stdout + d.toString()).slice(-OUTPUT_CAP * 2) })
    if (child.stderr) child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-OUTPUT_CAP * 2) })
    child.on('error', (e) => finish(-1, String((e && e.message) || e)))
    child.on('close', (code) => finish(code))
  })
}

const isLang = (l) => l === 'auto' || /^[a-z]{2,3}$/.test(String(l || ''))

/** Arguments for one transcription run. Throws on anything that is not a plain, validated value. */
function buildWhisperArgs({ modelPath, wavPath, outPrefix, language = 'auto', translate = false, threads = 2 }) {
  if (!path.isAbsolute(modelPath) || !path.isAbsolute(wavPath) || !path.isAbsolute(outPrefix)) throw new Error('paths must be absolute')
  for (const p of [modelPath, wavPath, outPrefix]) if (String(p).includes('\0') || String(p).startsWith('-')) throw new Error('bad path')
  if (!isLang(language)) throw new Error('bad language')
  const t = Math.max(1, Math.min(16, Math.trunc(Number(threads)) || 1))
  const args = ['-m', modelPath, '-f', wavPath, '-l', language, '-oj', '-of', outPrefix, '-t', String(t), '-np']
  if (translate) args.push('-tr')
  return args
}

function buildDetectArgs({ modelPath, wavPath, threads = 2 }) {
  if (!path.isAbsolute(modelPath) || !path.isAbsolute(wavPath)) throw new Error('paths must be absolute')
  const t = Math.max(1, Math.min(16, Math.trunc(Number(threads)) || 1))
  return ['-m', modelPath, '-f', wavPath, '-dl', '-t', String(t)]
}

/** ffmpeg arguments that write a 16 kHz mono 16-bit WAV of [start, start+duration) of the first audio stream. */
function buildChunkArgs({ input, start, duration, out }) {
  if (!path.isAbsolute(out)) throw new Error('output must be absolute')
  return ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', Number(start).toFixed(3), '-t', Number(duration).toFixed(3),
    '-i', detect.inputArg(input), '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out]
}

const DETECT_RE = /auto-detected language:\s*([a-z]{2,3})\s*\(p\s*=\s*([0-9.]+)\)/i

/** "auto-detected language: es (p = 0.93)" -> { language: 'es', probability: 0.93 } */
function parseDetectedLanguage(text) {
  const m = DETECT_RE.exec(String(text || ''))
  return m ? { language: m[1].toLowerCase(), probability: Number(m[2]) } : null
}

function defaultThreads() {
  const n = (os.cpus() || []).length || 2
  return Math.max(1, Math.min(8, Math.floor(n / 2)))
}

function engineEnv(exe) {
  // Linux builds may need their own .so files found next to the program.
  return process.platform === 'win32' ? childEnv() : childEnv({ LD_LIBRARY_PATH: path.dirname(exe) })
}

async function extractChunk({ ffmpegPath, input, start, duration, out, signal, spawnFn, timeoutMs = 300000 }) {
  let args
  try { args = buildChunkArgs({ input, start, duration, out }) } catch (e) { return { ok: false, error: 'bad_path' } }
  const r = await runChild(ffmpegPath, args, { timeoutMs, signal, spawnFn, priority: 'below' })
  if (r.cancelled) return { ok: false, error: 'cancelled' }
  if (r.timedOut) return { ok: false, error: 'timeout' }
  if (r.code !== 0) return { ok: false, error: /matches no streams|does not contain any stream/i.test(r.stderr) ? 'no_audio' : 'ffmpeg_failed' }
  return { ok: true }
}

async function detectLanguage({ whisperExe, modelPath, wavPath, threads, signal, spawnFn, cwd, timeoutMs = 180000 }) {
  let args
  try { args = buildDetectArgs({ modelPath, wavPath, threads }) } catch { return null }
  const r = await runChild(whisperExe, args, { timeoutMs, signal, spawnFn, priority: 'low', cwd, env: engineEnv(whisperExe) })
  if (r.cancelled || r.timedOut) return null
  return parseDetectedLanguage(r.stderr + '\n' + r.stdout)
}

/**
 * One chunk through whisper. Resolves { ok: true, language, segments } (times relative to the chunk)
 * or { ok: false, error: 'cancelled' | 'timeout' | 'whisper_failed' | 'bad_output' }.
 */
async function transcribeChunk({ whisperExe, modelPath, wavPath, outPrefix, language, translate, threads, signal, spawnFn, cwd, readFile, timeoutMs = 900000 }) {
  let args
  try { args = buildWhisperArgs({ modelPath, wavPath, outPrefix, language, translate, threads }) } catch { return { ok: false, error: 'bad_arguments' } }
  const r = await runChild(whisperExe, args, { timeoutMs, signal, spawnFn, priority: 'low', cwd, env: engineEnv(whisperExe) })
  if (r.cancelled) return { ok: false, error: 'cancelled' }
  if (r.timedOut) return { ok: false, error: 'timeout' }
  if (r.code !== 0) return { ok: false, error: 'whisper_failed' }
  let text
  try { text = readFile(outPrefix + '.json') } catch { return { ok: false, error: 'bad_output' } }
  const parsed = srt.parseWhisperJson(text)
  if (!parsed) return { ok: false, error: 'bad_output' }
  return { ok: true, language: parsed.language, segments: parsed.segments }
}

module.exports = {
  runChild, childEnv, buildWhisperArgs, buildDetectArgs, buildChunkArgs, parseDetectedLanguage,
  defaultThreads, extractChunk, detectLanguage, transcribeChunk, probeDuration: detect.probeDuration
}
