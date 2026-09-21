'use strict'
// Pre-baked "Hi, I'm <Name>." clips for the storybook computer voices.
//
// tools/make-voice-samples.py writes one small MP3 per Kokoro voice into
// resources/voice-samples (committed, shipped via package.json extraResources).
// This module finds that folder in dev and in the installed app, and answers
// "which file is the sample for voice X?" ONLY for ids in the storybook allowlist,
// so no request can ever name a path of its own.
const fs = require('fs')
const path = require('path')
const { ENGLISH_VOICES } = require('./storybookRuntime')

// Same names and order as the phone's picker (StoryBookScreen.kt COMPUTER_VOICES).
const VOICE_NAMES = {
  af_heart: 'Heart', af_alloy: 'Alloy', af_aoede: 'Aoede', af_bella: 'Bella', af_jessica: 'Jessica',
  af_kore: 'Kore', af_nicole: 'Nicole', af_nova: 'Nova', af_river: 'River', af_sarah: 'Sarah', af_sky: 'Sky',
  am_adam: 'Adam', am_echo: 'Echo', am_eric: 'Eric', am_fenrir: 'Fenrir', am_liam: 'Liam',
  am_michael: 'Michael', am_onyx: 'Onyx', am_puck: 'Puck', am_santa: 'Santa',
  bf_alice: 'Alice', bf_emma: 'Emma', bf_isabella: 'Isabella', bf_lily: 'Lily',
  bm_daniel: 'Daniel', bm_fable: 'Fable', bm_george: 'George', bm_lewis: 'Lewis',
}

function voiceInfo (id) {
  if (!isVoiceId(id)) return null
  return { id, name: VOICE_NAMES[id] || id, accent: id.startsWith('b') ? 'British' : 'American' }
}

function isVoiceId (id) {
  return typeof id === 'string' && ENGLISH_VOICES.has(id)
}

function samplesDir (resourcesPath = process.resourcesPath, appDir = path.join(__dirname, '..')) {
  const candidates = [
    resourcesPath && path.join(resourcesPath, 'voice-samples'),
    path.join(appDir, 'resources', 'voice-samples'),
  ].filter(Boolean)
  return candidates.find((d) => { try { return fs.statSync(path.join(d, 'manifest.json')).isFile() } catch { return false } }) || null
}

// Absolute path of a voice's clip, or null (unknown id, or the file isn't there).
function sampleFile (id, dir = samplesDir()) {
  if (!dir || !isVoiceId(id)) return null
  const fp = path.join(dir, id + '.mp3')
  try { return fs.statSync(fp).isFile() ? fp : null } catch { return null }
}

// The voices in picker order, each with whether a clip is available.
function listVoices (dir = samplesDir()) {
  return Object.keys(VOICE_NAMES).filter(isVoiceId).map((id) => ({ ...voiceInfo(id), hasSample: !!sampleFile(id, dir) }))
}

// Parse "/api/storybook-voice-sample/<id>" (optionally "<id>.mp3"); null for anything else.
function voiceIdFromPath (p) {
  const m = /^\/api\/storybook-voice-sample\/([a-z]{2}_[a-z]+)(?:\.mp3)?$/.exec(String(p || ''))
  return m && isVoiceId(m[1]) ? m[1] : null
}

module.exports = { VOICE_NAMES, voiceInfo, isVoiceId, samplesDir, sampleFile, listVoices, voiceIdFromPath }
