// audioPlayer.js — what the mini-player knows, as pure functions plus a tiny shared store, so the
// Podcasts page, the Radio page and the player bar all talk about the same "now playing" without
// React or IPC (node --test checks it: test/audio-player.test.js).
//
//   playback state   { item, status, ... }   item = { kind: 'podcast' | 'radio', ... } or null
//   speed            0.5x to 3x in 0.05 steps (the audio element keeps the pitch: preservesPitch)
//   sleep timer      "in N minutes" or "at the end of this episode"
//   chapters         which one is playing, previous / next
//
// Nothing here touches the network: podcasts and radio are fetched through
// window.beeboentertainment.podcastsCall / radioCall by the components.

export const SPEED_MIN = 0.5
export const SPEED_MAX = 3
export const SPEED_PRESETS = Object.freeze([0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3])
export const SLEEP_PRESETS = Object.freeze([5, 10, 15, 30, 45, 60])

/** Clamp and snap to 0.05, whatever was passed (a slider's string, NaN, 9). */
export function clampSpeed(v, dflt = 1) {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.round(Math.min(SPEED_MAX, Math.max(SPEED_MIN, n)) * 20) / 20
}

/** One step faster (+1) or slower (-1) through the presets people actually use. */
export function stepSpeed(current, dir) {
  const cur = clampSpeed(current)
  const list = SPEED_PRESETS
  if (dir > 0) return list.find((s) => s > cur + 1e-9) || SPEED_MAX
  const slower = list.filter((s) => s < cur - 1e-9)
  return slower.length ? slower[slower.length - 1] : SPEED_MIN
}

export const formatSpeed = (s) => `${clampSpeed(s)}x`

/** 3723 -> "1:02:03", 65 -> "1:05". */
export function formatClock(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`
}

/** Time left in an episode at the chosen speed: at 2x an hour takes half an hour. */
export function timeLeft(position, duration, speed = 1) {
  const d = Number(duration) || 0
  if (!(d > 0)) return 0
  return Math.max(0, (d - (Number(position) || 0)) / clampSpeed(speed))
}

// ----- sleep timer ---------------------------------------------------------------------------
// A timer is null, { mode: 'minutes', endsAt: <ms> } or { mode: 'episode' }.

export function startSleepTimer(choice, now = Date.now()) {
  if (choice === 'episode') return { mode: 'episode' }
  const m = Number(choice)
  if (!(m > 0) || m > 12 * 60) return null
  return { mode: 'minutes', endsAt: now + Math.round(m * 60000) }
}

/** Seconds until a timed sleep timer fires (null for none or "end of episode"). */
export function sleepRemaining(timer, now = Date.now()) {
  if (!timer || timer.mode !== 'minutes') return null
  return Math.max(0, Math.ceil((timer.endsAt - now) / 1000))
}

/**
 * Should playback stop right now?  A timed timer stops when its time is up; "end of episode" stops when
 * the episode has ended (the caller passes ended: true from the audio element's 'ended' event).
 */
export function sleepShouldStop(timer, { now = Date.now(), ended = false } = {}) {
  if (!timer) return false
  if (timer.mode === 'minutes') return now >= timer.endsAt
  if (timer.mode === 'episode') return !!ended
  return false
}

export function sleepLabel(timer, now = Date.now()) {
  if (!timer) return 'Sleep timer'
  if (timer.mode === 'episode') return 'Stops after this episode'
  const s = sleepRemaining(timer, now)
  return `Stops in ${formatClock(s)}`
}

// ----- chapters ------------------------------------------------------------------------------
// chapters: [{ start, end?, title, img?, url?, hidden? }] sorted by start (as the server returns them).

export const visibleChapters = (chapters) => (Array.isArray(chapters) ? chapters.filter((c) => c && !c.hidden) : [])

/** Index of the chapter playing at time t (seconds), or -1 before the first / with none. */
export function chapterIndexAt(chapters, t) {
  const list = visibleChapters(chapters)
  let idx = -1
  for (let i = 0; i < list.length; i++) {
    if (list[i].start <= t + 0.25) idx = i
    else break
  }
  return idx
}

export function chapterAt(chapters, t) {
  const i = chapterIndexAt(chapters, t)
  return i < 0 ? null : visibleChapters(chapters)[i]
}

/** Where "next chapter" goes: the start of the next one, or null on the last. */
export function nextChapterStart(chapters, t) {
  const list = visibleChapters(chapters)
  const i = chapterIndexAt(chapters, t)
  return i + 1 < list.length ? list[i + 1].start : null
}

/** "Previous chapter": back to the start of this one, or to the one before when already near its start. */
export function prevChapterStart(chapters, t, restartWithin = 3) {
  const list = visibleChapters(chapters)
  const i = chapterIndexAt(chapters, t)
  if (i < 0) return 0
  if (t - list[i].start > restartWithin || i === 0) return list[i].start
  return list[i - 1].start
}

// ----- the shared store ----------------------------------------------------------------------

export const IDLE = Object.freeze({ item: null, playing: false, position: 0, duration: 0, speed: 1, skipSilence: false, sleep: null, note: '' })

let state = IDLE
const listeners = new Set()

export const getPlayback = () => state
export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
export function setPlayback(next) {
  state = typeof next === 'function' ? next(state) : next
  for (const fn of listeners) { try { fn(state) } catch { /* a bad listener must not stop the others */ } }
}
export function patchPlayback(patch) {
  setPlayback((s) => ({ ...s, ...patch }))
}

/**
 * Start something: { kind: 'podcast', key, title, subtitle, image, stream, progressSec, durationSec, feedId, hasSilenceVariant }
 *                or { kind: 'radio', sessionId, title (station), stream, image }.
 * Speed and skip-silence carry over; position starts from where the episode was left.
 */
export function play(item) {
  if (!item || !item.stream || (item.kind !== 'podcast' && item.kind !== 'radio')) return
  setPlayback((s) => ({ ...s, item, playing: true, position: item.progressSec || 0, duration: item.durationSec || 0, sleep: s.sleep && s.sleep.mode === 'episode' && item.kind === 'radio' ? null : s.sleep, note: '' }))
}
export function stop() {
  setPlayback((s) => ({ ...IDLE, speed: s.speed, skipSilence: s.skipSilence, sleep: null }))
}
