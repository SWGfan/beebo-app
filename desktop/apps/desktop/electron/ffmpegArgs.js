'use strict'
// One place that turns a library file path into ffmpeg / ffprobe input arguments (security review F9).
//
// A path is data, never a command. ffmpeg would otherwise read a bare "concat:...", "http://...",
// "subfile,,start,0,end,0,,:..." or "-something" as a protocol or an option, and a media file that
// is really a playlist (HLS, concat) may point ffmpeg at other URLs. So every library input goes
// through here:
//   - `file:` prefix  -> the name can only ever be a file path (a leading '-' is no longer an option);
//   - `-protocol_whitelist file,crypto,pipe` before `-i`  -> even a playlist inside the file cannot
//     open network protocols (http, tcp, udp, rtmp, ...), only local files.
// Both work with the bundled Windows and Linux builds (tested in test/ffmpeg-args.test.js).

const PROTOCOL_WHITELIST = 'file,crypto,pipe'

/** 'C:\\media\\a.mkv' -> 'file:C:\\media\\a.mkv'. Throws on an empty path or one holding NUL/line breaks. */
function safeInput(filePath) {
  const p = String(filePath == null ? '' : filePath)
  if (!p || /[\0\r\n]/.test(p)) throw new Error('invalid input path')
  return 'file:' + p
}

/** The arguments that introduce one input: ['-protocol_whitelist', 'file,crypto,pipe', '-i', 'file:<path>']. */
function inputArgs(filePath) {
  return ['-protocol_whitelist', PROTOCOL_WHITELIST, '-i', safeInput(filePath)]
}

module.exports = { PROTOCOL_WHITELIST, safeInput, inputArgs }
