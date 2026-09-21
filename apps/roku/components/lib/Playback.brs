' ============================================================================
' Playback.brs - PURE playback decisions (unit-tested under brs).
'
' Server contract (desktop/apps/desktop/electron/playbackApi.js):
'   GET  /api/playback/info?kind=&id=   -> qualities, audio[], subtitles[], durationSec, ...
'   POST /api/playback/start {kind,id,quality,audio?} -> { url:"/hls/<ticket>/index.m3u8", ticket, ... }
'        quality is one of "1080p" | "720p" | "480p" (the server has no "auto" here;
'        "auto" is decided by the CLIENT, see playPickQuality)
'   POST /api/playback/stop  {ticket}
'   POST /api/watch-session  {kind,id}  -> { sessionId }
'   POST /api/progress       {sessionId,currentTime,duration}
' The stream is H.264 + AAC, MPEG-TS-segmented VOD HLS: what Roku plays natively.
' ============================================================================

function playQualityOrder() as object
  return ["1080p", "720p", "480p"]
end function

' pref: "auto" | "1080p" | "720p" | "480p". info.qualities is the server's list
' [{id, height, upscale, ...}]. Auto = the best quality that is not an upscale
' of the source. Roku is capped at 1080p (the server's own ceiling too).
function playPickQuality(qualities as dynamic, pref as string) as string
  order = playQualityOrder()
  available = []
  if qualities <> invalid and type(qualities) = "roArray" then
    for each q in qualities
      if q <> invalid then available.push(q)
    end for
  end if
  if available.count() = 0 then
    if pref = "720p" or pref = "480p" then return pref
    return "1080p"
  end if
  if pref <> "auto" then
    for each q in available
      if q.id = pref then return pref
    end for
  end if
  ' auto: walk best -> worst, first that is not an upscale
  for each id in order
    for each q in available
      if q.id = id and not fmtIsTrue(q.upscale) then return id
    end for
  end for
  return available[available.count() - 1].id
end function

' How far in should playback start? Seconds (integer), 0 = from the beginning.
'   continueItem  {currentTime, duration, percent} from /api/continue or invalid
'   watchedPercent  0-100 from the episode list, or 0
'   durationSec     real duration (from /api/playback/info) or 0
' Rules: ignore the first 30 seconds (accidental start) and the last 60 seconds
' or 95% (effectively finished).
function playResumeSeconds(continueItem as dynamic, watchedPercent as dynamic, durationSec as dynamic) as integer
  dur = fmtNum(durationSec, 0)
  posSec = 0
  if continueItem <> invalid then
    pct = fmtNum(continueItem.percent, 0)
    ct = fmtNum(continueItem.currentTime, 0)
    cd = fmtNum(continueItem.duration, 0)
    if dur <= 0 then dur = cd
    if pct < 95 then posSec = ct
  end if
  if posSec <= 0 then
    wp = fmtNum(watchedPercent, 0)
    if wp >= 2 and wp < 95 and dur > 0 then posSec = dur * wp / 100
  end if
  if posSec < 30 then return 0
  if dur > 0 and dur - posSec < 60 then return 0
  return Int(posSec)
end function

function playStartBody(kind as string, id as string, quality as string, audioStreamIndex as dynamic) as object
  body = CreateObject("roAssociativeArray")
  body.SetModeCaseSensitive()
  body["kind"] = kind
  body["id"] = id
  body["quality"] = quality
  if audioStreamIndex <> invalid then body["audio"] = audioStreamIndex
  return body
end function

function playSessionBody(kind as string, id as string) as object
  body = CreateObject("roAssociativeArray")
  body.SetModeCaseSensitive()
  body["kind"] = kind
  body["id"] = id
  return body
end function

' Body for POST /api/progress. Camel-case keys are REQUIRED by the server, so the
' AA is case-sensitive (a plain literal could be lower-cased by FormatJson).
function playProgressBody(sessionId as string, positionSec as dynamic, durationSec as dynamic) as dynamic
  dur = fmtNum(durationSec, 0)
  posSec = fmtNum(positionSec, 0)
  if sessionId = "" or dur <= 0 or posSec < 0 then return invalid
  if posSec > dur then posSec = dur
  body = CreateObject("roAssociativeArray")
  body.SetModeCaseSensitive()
  body["sessionId"] = sessionId
  body["currentTime"] = Int(posSec)
  body["duration"] = Int(dur)
  return body
end function

' Should a periodic progress report be sent now?
function playShouldReport(lastReportedAtSec as integer, atSec as integer, intervalSec as integer) as boolean
  return atSec - lastReportedAtSec >= intervalSec
end function

' Audio choices from /api/playback/info: [{title, streamIndex}]
function playAudioOptions(info as dynamic) as object
  out = []
  if info = invalid then return out
  if info.audio = invalid then return out
  for each a in info.audio
    if modelHas(a, "streamIndex") then
      label = fmtStr(a.label, "")
      if label = "" then label = fmtStr(a.language, "Audio")
      out.push({ title: label, streamIndex: fmtInt(a.streamIndex, 0) })
    end if
  end for
  return out
end function

' Text subtitle choices (URLs are server-relative and carry a media token):
' [{title, language, url}]. Picture (bitmap) subtitles are skipped: the server
' only burns those in on request and this v1 does not ask for that.
function playSubtitleOptions(info as dynamic) as object
  out = []
  if info = invalid then return out
  if info.subtitles = invalid then return out
  for each s in info.subtitles
    if s <> invalid then
      url = fmtStr(s.url, "")
      if url <> "" and fmtStr(s.kind, "") = "text" then
        label = fmtStr(s.label, "")
        if label = "" then label = fmtStr(s.language, "Subtitles")
        out.push({ title: label, language: fmtStr(s.language, ""), url: url })
      end if
    end if
  end for
  return out
end function

' Friendly text for whatever went wrong. status = HTTP status (0 = no answer),
' code = the server's "error" string ("" if none), fallback = server message.
function playFriendlyError(status as integer, code as string, serverMessage as dynamic) as string
  if status = 0 then return "Can't reach your Beebo server. Check that the computer is on and that this Roku is on the same network."
  if status = 401 then return "You have been signed out. Please sign in again."
  if status = 402 or code = "remote_requires_plan" then return "Watching away from home needs an active Beebo plan on the server."
  if code = "busy" then return "Your computer is already converting videos for other people. Try again in a little while."
  if code = "transcode_off" then return "Live conversion is switched off on your computer, so this video can't be played on Roku."
  if code = "no_encoder" then return "Your computer can't convert video right now (no encoder found)."
  if code = "unreadable" then return "This video file couldn't be read."
  if status = 404 or code = "not_found" then return "That video isn't in your library any more."
  if status = 429 then return "Too many attempts. Wait a few minutes and try again."
  if status >= 500 then return "Your Beebo server had a problem. Try again in a moment."
  msgText = fmtStr(serverMessage, "")
  if msgText <> "" then return msgText
  return "Something went wrong. Try again."
end function

' Text for a Roku Video-node error. The numeric codes are not mapped on purpose:
' their meanings are not verified on a device yet, so show the node's own message
' and a hint that covers the two likely causes.
function playVideoErrorText(errorCode as dynamic, errorMsg as dynamic) as string
  hint = "Check your Wi-Fi and that your computer is still on, then try again."
  msgText = fmtStr(errorMsg, "")
  if msgText <> "" then return "Playback stopped (" + fmtTruncate(msgText, 80) + "). " + hint
  return "Playback stopped unexpectedly. " + hint
end function
