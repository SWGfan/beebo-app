'use strict'
// ============================================================================
// aiSubtitles.js - how an AI-generated subtitle file is NAMED and LABELLED.
// ----------------------------------------------------------------------------
// The Speech Pack (electron/addons/speechPack/) writes its results next to the video as
//
//     <video name>.<language>.ai.srt          e.g.  Big Fish (2003).en.ai.srt
//
// The `.ai` part is the marker. Every place that lists sidecar subtitles (mediaInfo.js for
// the desktop details page, streamServer.js resolveSubtitleTracks for the phone/TV/web player
// and the Android app, and through them the Jellyfin-compatible API) calls isAiQualifier() on
// the dot-separated words after the language code and appends AI_LABEL_SUFFIX, so a viewer
// always sees "English (AI-generated)" and never mistakes it for a human-made track.
//
// Kept tiny and dependency-free on purpose: it is required from hot, shared files.
// ============================================================================

const path = require('path')

const AI_MARKER = 'ai'
const AI_LABEL = 'AI-generated'
const AI_LABEL_SUFFIX = ' (AI-generated)'

/** Is this one of the dot-separated words after the language code ("ai" in "Name.en.ai.srt")? */
function isAiQualifier(word) {
  return String(word || '').toLowerCase() === AI_MARKER
}

/** Does a label that a listing built already carry the AI marker? */
function isAiLabel(label) {
  return String(label || '').includes(AI_LABEL)
}

/** Whisper language codes are ISO 639-1 (plus a few three-letter ones such as "haw"). */
function isSafeLanguageCode(code) {
  return /^[a-z]{2,3}$/.test(String(code || ''))
}

/**
 * The sidecar path for a video: same folder, same base name, `.<lang>.ai.srt`.
 * Throws on a language code that is not a plain 2-3 letter code, so a hostile value can never
 * shape a path.
 */
function aiSidecarPath(videoPath, language) {
  const lang = String(language || '').toLowerCase()
  if (!isSafeLanguageCode(lang)) throw new Error('bad_language')
  const dir = path.dirname(videoPath)
  const base = path.basename(videoPath, path.extname(videoPath))
  return path.join(dir, `${base}.${lang}.${AI_MARKER}.srt`)
}

module.exports = { AI_MARKER, AI_LABEL, AI_LABEL_SUFFIX, isAiQualifier, isAiLabel, isSafeLanguageCode, aiSidecarPath }
