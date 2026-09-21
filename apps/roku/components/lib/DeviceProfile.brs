' ============================================================================
' DeviceProfile.brs - PURE builder of the capability declaration this Roku sends with
' POST /api/playback/negotiate (docs/HOME-THEATER.md, format owned by
' desktop/apps/desktop/electron/deviceProfile.js). Unit-tested under brs.
'
' The server trusts this declaration, so every value must be TRUE. The caller
' (DeviceProbe.brs, Roku-only) asks roDeviceInfo and passes the answers in as `env`:
'
'   env = {
'     model: "Roku Ultra"                 (shown to the owner)
'     uhd: true | false                   panel / output is 2160p capable (false when unknown)
'     hdr10: true | false                 the display accepts HDR10 (false when unknown)
'     can: { h264_40, h264_51, hevc_main, hevc_main10, vp9_p0, vp9_p2, av1_main,
'            aac, ac3, eac3, flac, opus, mp3, dts_pass }     each true | false
'   }
'
' Honesty rules (same as apps/smarttv/app/js/util/deviceProfile.js):
'   * a codec is listed only when roDeviceInfo.CanDecodeVideo / CanDecodeAudio said yes;
'   * HDR is listed only when the display said so, otherwise "hdr: []" (SDR only: the server
'     tone-maps, which is always safe). Dolby Vision and HDR10+ are NEVER claimed;
'   * TrueHD / DTS-HD / DTS:X are NEVER listed; DTS core passthrough only when detected;
'   * Atmos is never claimed (no Roku API reports it);
'   * containers are the ones Roku documents (mp4 / mov / mkv / ts), streaming is HLS (ts + fmp4);
'   * maxHeight is 2160 only for a 4K-capable output, otherwise 1080.
' ============================================================================

function dpAA() as object
  o = CreateObject("roAssociativeArray")
  o.SetModeCaseSensitive()
  return o
end function

function dpFlag(can as dynamic, key as string) as boolean
  if can = invalid then return false
  if type(can) <> "roAssociativeArray" then return false
  if not can.DoesExist(key) then return false
  return fmtIsTrue(can[key])
end function

' -> the declaration as a case-sensitive AA (FormatJson it with dpToJson).
function dpBuild(env as dynamic) as object
  p = dpAA()
  p["v"] = 1
  p["client"] = "roku"
  can = invalid
  uhd = false
  hdr10 = false
  if env <> invalid and type(env) = "roAssociativeArray" then
    name = fmtStr(env.model, "").trim()
    if name <> "" then p["name"] = Left(name, 60)
    can = env.can
    uhd = fmtIsTrue(env.uhd)
    hdr10 = fmtIsTrue(env.hdr10)
  end if
  if can = invalid then return p ' nothing probed: the server keeps its own default for Roku

  video = dpAA()
  if dpFlag(can, "h264_51") then
    video["h264"] = dpH264(51)
  else if dpFlag(can, "h264_40") then
    video["h264"] = dpH264(40)
  end if
  if dpFlag(can, "hevc_main10") then
    e = dpAA()
    e["profiles"] = ["main", "main10"]
    e["maxLevel"] = 153
    e["bitDepths"] = [8, 10]
    video["hevc"] = e
  else if dpFlag(can, "hevc_main") then
    e = dpAA()
    e["profiles"] = ["main"]
    e["maxLevel"] = 153
    e["bitDepths"] = [8]
    video["hevc"] = e
  end if
  if dpFlag(can, "vp9_p0") then
    e = dpAA()
    if dpFlag(can, "vp9_p2") then
      e["profiles"] = ["profile0", "profile2"]
      e["bitDepths"] = [8, 10]
    else
      e["profiles"] = ["profile0"]
      e["bitDepths"] = [8]
    end if
    video["vp9"] = e
  end if
  if dpFlag(can, "av1_main") then
    e = dpAA()
    e["profiles"] = ["main"]
    e["bitDepths"] = [8, 10]
    video["av1"] = e
  end if
  if video.Count() > 0 then p["video"] = video

  ' HDR: only what the display reported. Never Dolby Vision, never HDR10+.
  hdr = []
  if hdr10 then hdr.push("hdr10")
  p["hdr"] = hdr
  if uhd then
    p["maxHeight"] = 2160
    p["maxWidth"] = 3840
  else
    p["maxHeight"] = 1080
  end if

  audio = dpAA()
  multi = dpFlag(can, "ac3") or dpFlag(can, "eac3")
  if dpFlag(can, "aac") or multi then
    e = dpAA()
    if multi then e["maxChannels"] = 6 else e["maxChannels"] = 2
    audio["aac"] = e
  end if
  if dpFlag(can, "ac3") then
    e = dpAA()
    e["maxChannels"] = 6
    audio["ac3"] = e
  end if
  if dpFlag(can, "eac3") then
    e = dpAA()
    e["maxChannels"] = 6
    audio["eac3"] = e
  end if
  if dpFlag(can, "flac") then
    e = dpAA()
    e["maxChannels"] = 2
    audio["flac"] = e
  end if
  if dpFlag(can, "opus") then
    e = dpAA()
    e["maxChannels"] = 2
    audio["opus"] = e
  end if
  if dpFlag(can, "mp3") then
    e = dpAA()
    e["maxChannels"] = 2
    audio["mp3"] = e
  end if
  ' DTS core: only when the Roku reports it can hand it to the receiver. Listed as pass-through only
  ' (it cannot be decoded here) and it only ever plays by DirectPlay of the original file.
  if dpFlag(can, "dts_pass") then
    e = dpAA()
    e["passthrough"] = true
    e["decode"] = false
    e["maxChannels"] = 6
    audio["dts"] = e
  end if
  if audio.Count() > 0 then
    p["audio"] = audio
    if multi then p["maxAudioChannels"] = 6 else p["maxAudioChannels"] = 2
  end if

  p["containers"] = ["mp4", "mov", "mkv", "ts"]
  p["streaming"] = ["hls-ts", "hls-fmp4"]
  ' The channel draws external WebVTT (and SRT the server converts); picture subtitles are never offered.
  p["subtitles"] = ["vtt"]
  return p
end function

function dpH264(level as integer) as object
  e = dpAA()
  e["profiles"] = ["baseline", "main", "high"]
  e["maxLevel"] = level
  e["bitDepths"] = [8]
  return e
end function

function dpToJson(profile as object) as string
  return FormatJson(profile)
end function

' ---- POST /api/playback/negotiate -------------------------------------------------------

' The body as a JSON STRING (the profile is already JSON): kind, id, client, deviceProfile, quality, audio?.
' quality "auto" (the channel's setting) means "the best way to play the file as it is": "original".
function playNegotiateBody(kind as string, id as string, qualityPref as string, audioStreamIndex as dynamic, profileJson as string) as string
  quality = "original"
  if qualityPref = "1080p" or qualityPref = "720p" or qualityPref = "480p" then quality = qualityPref
  body = dpAA()
  body["kind"] = kind
  if kind <> "tv" then body["kind"] = "movie"
  body["id"] = id
  body["client"] = "roku"
  body["quality"] = quality
  if audioStreamIndex <> invalid then body["audio"] = audioStreamIndex
  s = FormatJson(body)
  pj = profileJson.trim()
  if pj = "" or Left(pj, 1) <> "{" then return s
  ' splice the profile in before the closing brace
  return Left(s, Len(s) - 1) + "," + Chr(34) + "deviceProfile" + Chr(34) + ":" + pj + "}"
end function

' streamFormat of the Video node for a negotiated answer. "" = cannot play it (fall back to the conversion).
function playNegotiateFormat(method as string, container as string, url as string) as string
  if method = "Transcode" or method = "DirectStream" then return "hls"
  if method <> "DirectPlay" then return ""
  c = LCase(container)
  if c = "mp4" or c = "m4v" or c = "mov" then return "mp4"
  if c = "mkv" or c = "matroska" then return "mkv"
  if c = "ts" or c = "m2ts" then return "ts"
  return ""
end function

' The answer -> { ok, method, url, ticket, format, duration, reasons }. ok=false when it is not
' one of the three plans on one of their own routes (the caller then uses /api/playback/start).
function playParseNegotiate(json as dynamic) as object
  out = { ok: false, method: "", url: "", ticket: "", format: "", duration: 0 }
  if json = invalid then return out
  if type(json) <> "roAssociativeArray" then return out
  if json.ok <> invalid and fmtIsFalse(json.ok) then return out
  method = fmtStr(json.method, "")
  url = fmtStr(json.url, "")
  if method = "DirectPlay" then
    if Left(url, 6) <> "/file?" and Left(url, 8) <> "/tvfile?" then return out
  else if method = "DirectStream" or method = "Transcode" then
    if Left(url, 5) <> "/hls/" or Instr(1, url, ".m3u8") = 0 then return out
  else
    return out
  end if
  if Instr(1, url, "..") > 0 or Instr(1, url, "//") > 0 or Instr(1, url, "\") > 0 then return out
  fmt = playNegotiateFormat(method, fmtStr(json.container, ""), url)
  if fmt = "" then return out
  out.ok = true
  out.method = method
  out.url = url
  out.ticket = fmtStr(json.ticket, "")
  out.format = fmt
  out.duration = fmtNum(json.durationSec, 0)
  return out
end function

' 503 { error: "preparing", retryAfterSec } -> seconds to wait (1..10), else 0.
function playPrepareWaitSec(status as integer, json as dynamic) as integer
  if status <> 503 then return 0
  if json = invalid then return 0
  if type(json) <> "roAssociativeArray" then return 0
  if fmtStr(json.error, "") <> "preparing" then return 0
  n = fmtInt(json.retryAfterSec, 3)
  if n < 1 then n = 3
  if n > 10 then n = 10
  return n
end function
