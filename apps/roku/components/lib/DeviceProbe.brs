' ============================================================================
' DeviceProbe.brs - Roku-only glue: asks roDeviceInfo what this Roku can decode and show, and
' hands the answers to the pure builder in DeviceProfile.brs. Not unit-tested (needs a device).
'
' UNVERIFIED on a real Roku (this was written from the roDeviceInfo documentation):
'   CanDecodeVideo({Codec, Profile, Level}) and CanDecodeAudio({Codec, ChCnt, Passthrough}) both answer
'   { result: true|false, ... }; GetVideoMode() / GetDisplayType() / GetDisplayProperties() tell the
'   output resolution and whether the display accepts HDR. Any call that is missing or answers
'   something unexpected counts as "no": the profile then claims less, never more.
' ============================================================================

function dpCanVideo(di as object, codec as string, profile as string, level as string) as boolean
  ok = false
  try
    r = di.CanDecodeVideo({ Codec: codec, Profile: profile, Level: level })
    if r <> invalid and type(r) = "roAssociativeArray" then ok = fmtIsTrue(r.result)
  catch e
    ok = false
  end try
  return ok
end function

function dpCanAudio(di as object, codec as string, channels as integer, passthrough as integer) as boolean
  ok = false
  try
    r = di.CanDecodeAudio({ Codec: codec, ChCnt: channels, Passthrough: passthrough })
    if r <> invalid and type(r) = "roAssociativeArray" then ok = fmtIsTrue(r.result)
  catch e
    ok = false
  end try
  return ok
end function

' -> the profile as an AA (see DeviceProfile.brs). Cheap enough to call once at start-up.
function dpProbe() as object
  di = CreateObject("roDeviceInfo")
  can = { }
  can["h264_40"] = dpCanVideo(di, "mpeg4 avc", "high", "4.0")
  can["h264_51"] = dpCanVideo(di, "mpeg4 avc", "high", "5.1")
  can["hevc_main"] = dpCanVideo(di, "hevc", "main", "5.1")
  can["hevc_main10"] = dpCanVideo(di, "hevc", "main 10", "5.1")
  can["vp9_p0"] = dpCanVideo(di, "vp9", "profile 0", "5.1")
  can["vp9_p2"] = dpCanVideo(di, "vp9", "profile 2", "5.1")
  can["av1_main"] = dpCanVideo(di, "av1", "main", "5.1")
  can["aac"] = dpCanAudio(di, "aac", 2, 0)
  can["ac3"] = dpCanAudio(di, "ac3", 6, 0)
  can["eac3"] = dpCanAudio(di, "eac3", 6, 0)
  can["flac"] = dpCanAudio(di, "flac", 2, 0)
  can["opus"] = dpCanAudio(di, "opus", 2, 0)
  can["mp3"] = dpCanAudio(di, "mp3", 2, 0)
  can["dts_pass"] = dpCanAudio(di, "dts", 6, 1)

  uhd = false
  hdr10 = false
  try
    mode = LCase(fmtStr(di.GetVideoMode(), ""))
    dtype = LCase(fmtStr(di.GetDisplayType(), ""))
    if Instr(1, mode, "2160") > 0 or Instr(1, dtype, "4k") > 0 then uhd = true
    if Instr(1, mode, "hdr") > 0 then hdr10 = true
  catch e
    uhd = false
  end try
  try
    props = di.GetDisplayProperties()
    if props <> invalid and type(props) = "roAssociativeArray" then
      for each key in ["Hdr10", "hdr10", "HDR10"]
        if props.DoesExist(key) and fmtIsTrue(props[key]) then hdr10 = true
      end for
    end if
  catch e
    hdr10 = hdr10
  end try

  model = ""
  try
    model = fmtStr(di.GetModelDisplayName(), "")
  catch e
    model = ""
  end try
  return { model: model, uhd: uhd, hdr10: hdr10, can: can }
end function

' The declaration as JSON, or "" when anything goes wrong (the server then uses its default for Roku).
function dpProbeJson() as string
  out = ""
  try
    out = dpToJson(dpBuild(dpProbe()))
  catch e
    out = ""
  end try
  return out
end function
