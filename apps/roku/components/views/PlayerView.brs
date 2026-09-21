sub init()
  baseInit()
  L = m.theme.layout
  m.video = m.top.findNode("video")
  m.spinner = m.top.findNode("spinner")
  m.note = m.top.findNode("note")
  m.status = m.top.findNode("status")
  m.reportTimer = m.top.findNode("reportTimer")
  m.closeTimer = m.top.findNode("closeTimer")
  m.prepTimer = m.top.findNode("prepTimer")
  themeLabel(m.note, "body", "textDim")
  m.spinner.poster.uri = "pkg:/images/PLACEHOLDER_spinner.png"
  m.spinner.translation = [L.screenWidth / 2 - 48, 420]
  m.note.translation = [L.marginX, 560]
  m.note.width = L.screenWidth - 2 * L.marginX
  m.status.translation = [L.marginX, 300]
  m.status.observeField("selected", "onStatusButton")

  m.video.observeField("state", "onVideoState")
  m.video.observeField("position", "onPosition")
  m.reportTimer.observeField("fire", "onReportTimer")
  m.closeTimer.observeField("fire", "onCloseTimer")
  m.prepTimer.observeField("fire", "onPrepTimer")

  m.queue = []
  m.index = 0
  m.cur = invalid
  m.session = ""
  m.ticket = ""
  m.duration = 0
  m.position = 0
  m.lastReportAt = 0
  m.closing = false
  m.forceQuality = ""
  m.startedPlayback = false
  m.audio = invalid
  m.subtitle = invalid
  m.statusIsError = false
  m.runId = 0
  m.closed = false
  m.quality = ""
  m.useNegotiate = false
  m.forceLegacy = false
  m.negotiated = invalid
  m.prepTries = 0
  m.streamUrl = ""
  m.streamFormat = "hls"
end sub

sub onParams()
  p = m.top.params
  q = p.queue
  if q <> invalid and q.count() > 0 then
    m.queue = q
    m.index = fmtInt(p.index, 0)
  else
    m.queue = [{ kind: p.kind, id: p.id, title: p.title, resumeSeconds: fmtInt(p.resumeSeconds, 0) }]
    m.index = 0
  end if
  m.audio = p.audio
  m.subtitle = p.subtitle
  startCurrent()
end sub

sub focusMe()
  if m.video.visible then
    m.video.setFocus(true)
  else if m.status.visible then
    m.status.callFunc("focusMe")
  else
    m.top.setFocus(true)
  end if
end sub

function nowSeconds() as integer
  dt = CreateObject("roDateTime")
  return dt.AsSeconds()
end function

' ---- start-up: info -> start (+ watch session) -> play ------------------------------------
sub startCurrent()
  m.cur = m.queue[m.index]
  m.runId = m.runId + 1
  m.session = ""
  m.ticket = ""
  m.duration = 0
  m.position = 0
  m.startResp = invalid
  m.negotiated = invalid
  m.prepTries = 0
  m.streamUrl = ""
  m.streamFormat = "hls"
  m.prepTimer.control = "stop"
  m.sessionDone = false
  m.startedPlayback = false
  m.statusIsError = false
  m.status.visible = false
  m.video.visible = false
  m.video.control = "stop"
  showLoading("Getting " + fmtStr(m.cur.title, "your video") + " ready...")
  apiGet("/api/playback/info?kind=" + m.cur.kind + "&id=" + urlEncode(m.cur.id), { timeoutMs: 40000 }, onInfo, { run: m.runId })
end sub

sub showLoading(text as string)
  m.note.text = text
  m.note.visible = true
  m.spinner.visible = true
  m.spinner.control = "start"
end sub

sub hideLoading()
  m.note.visible = false
  m.spinner.control = "stop"
  m.spinner.visible = false
end sub

sub onInfo(resp as object, ctx as dynamic)
  if ctx.run <> m.runId then return
  if not resp.ok then
    showFailure(resp)
    return
  end if
  info = resp.data
  m.duration = fmtNum(info.durationSec, 0)
  quality = m.forceQuality
  if quality = "" then quality = playPickQuality(info.qualities, m.global.quality)
  m.quality = quality
  ' Feature test: only a newer server has the `homeTheater` block in /api/playback/info (and POST /api/playback/negotiate).
  ' A chosen audio track always goes through the conversion (a direct play cannot switch tracks on every model), and so does
  ' everything after a direct play / direct stream failed once on this Roku.
  m.useNegotiate = info.homeTheater <> invalid and m.audio = invalid and not m.forceLegacy and m.forceQuality = ""
  if m.useNegotiate then postNegotiate() else postStartLegacy()
  apiPost("/api/watch-session", playSessionBody(m.cur.kind, m.cur.id), { timeoutMs: 15000 }, onSession, { run: m.runId })
end sub

' The plain conversion: H.264 + AAC HLS at the picked quality (older servers, and the fallback).
sub postStartLegacy()
  body = playStartBody(m.cur.kind, m.cur.id, m.quality, m.audio)
  apiPost("/api/playback/start", body, { timeoutMs: 60000 }, onStart, { run: m.runId })
end sub

' Newer servers: send this Roku's device profile and let the server pick DirectPlay / DirectStream / Transcode.
sub postNegotiate()
  body = playNegotiateBody(m.cur.kind, m.cur.id, m.global.quality, m.audio, m.global.deviceProfile)
  apiPost("/api/playback/negotiate", body, { timeoutMs: 60000 }, onNegotiate, { run: m.runId })
end sub

sub onNegotiate(resp as object, ctx as dynamic)
  if ctx.run <> m.runId then return
  if resp.ok then
    plan = playParseNegotiate(resp.data)
    if plan.ok then
      m.negotiated = plan
      m.startResp = resp.data
      m.streamUrl = plan.url
      m.streamFormat = plan.format
      m.ticket = plan.ticket
      if plan.duration > 0 then m.duration = plan.duration
      logInfo("player", "plan " + plan.method)
      maybePlay()
      return
    end if
    ' An answer this channel cannot follow: the proven conversion still works.
    postStartLegacy()
    return
  end if
  ' A big film is being read once so it can be streamed without converting it: ask again in a few seconds.
  wait = playPrepareWaitSec(resp.status, resp.data)
  if wait > 0 and m.prepTries < 8 then
    m.prepTries = m.prepTries + 1
    showLoading("Getting this ready...")
    m.prepTimer.duration = wait
    m.prepTimer.control = "start"
    return
  end if
  showFailure(resp)
end sub

sub onPrepTimer()
  postNegotiate()
end sub

sub onStart(resp as object, ctx as dynamic)
  if ctx.run <> m.runId then return
  if not resp.ok then
    showFailure(resp)
    return
  end if
  m.startResp = resp.data
  m.streamUrl = fmtStr(resp.data.url, "")
  m.streamFormat = "hls"
  m.ticket = fmtStr(resp.data.ticket, "")
  if fmtNum(resp.data.durationSec, 0) > 0 then m.duration = fmtNum(resp.data.durationSec, 0)
  maybePlay()
end sub

sub onSession(resp as object, ctx as dynamic)
  if ctx.run <> m.runId then return
  m.sessionDone = true
  ' A missing session only means progress isn't saved; it never blocks playback.
  if resp.ok and resp.data <> invalid then m.session = fmtStr(resp.data.sessionId, "")
  maybePlay()
end sub

sub maybePlay()
  if m.startResp = invalid or not m.sessionDone then return
  if m.startedPlayback then return
  m.startedPlayback = true
  url = urlAbsolute(m.global.server, m.streamUrl)
  if url = "" then
    showFailure({ status: 0, code: "", message: "The server didn't return a video address.", errorKind: "http" })
    return
  end if
  c = CreateObject("roSGNode", "ContentNode")
  c.url = url
  c.streamFormat = m.streamFormat
  c.title = fmtStr(m.cur.title, "")
  if m.duration > 0 then c.Length = Int(m.duration)
  resume = fmtInt(m.cur.resumeSeconds, 0)
  if resume > 0 then c.PlayStart = resume
  if m.subtitle <> invalid then
    subUrl = urlAbsolute(m.global.server, fmtStr(m.subtitle.url, ""))
    if subUrl <> "" then
      ' UNVERIFIED on a device: external WebVTT via SubtitleConfig (see README, top risks).
      c.SubtitleConfig = { TrackName: subUrl, Language: fmtStr(m.subtitle.language, "eng") }
      m.video.globalCaptionMode = "On"
    end if
  end if
  m.video.content = c
  m.video.visible = true
  hideLoading()
  m.video.control = "play"
  m.video.setFocus(true)
  m.lastReportAt = nowSeconds()
  m.reportTimer.control = "start"
  logInfo("player", "playing " + m.cur.kind + " at " + m.quality)
end sub

' ---- video events -----------------------------------------------------------------------------
sub onVideoState()
  st = m.video.state
  if st = "playing" then
    hideLoading()
  else if st = "paused" then
    reportProgress(false)
  else if st = "finished" then
    m.position = m.duration
    finishItem(true)
  else if st = "error" then
    onVideoError()
  end if
end sub

sub onPosition()
  p = m.video.position
  if p <> invalid then m.position = p
  d = m.video.duration
  if d <> invalid and d > 0 then m.duration = d
end sub

sub onReportTimer()
  if m.video.state = "playing" then reportProgress(false)
end sub

' Send the current position. `final` skips the interval check and returns after the answer.
sub reportProgress(final as boolean)
  if m.session = "" then return
  body = playProgressBody(m.session, m.position, m.duration)
  if body = invalid then return
  m.lastReportAt = nowSeconds()
  apiPost("/api/progress", body, { timeoutMs: 8000 }, onReported, { final: final })
end sub

sub onReported(resp as object, ctx as dynamic)
  if ctx.final = true and m.closing then closeNow()
end sub

sub onVideoError()
  m.reportTimer.control = "stop"
  reportProgress(false)
  if m.negotiated <> invalid and m.negotiated.method <> "Transcode" and not m.forceLegacy then
    ' The server thought this Roku could play the original (or the repackaged stream); it could not. Convert instead, from here.
    m.forceLegacy = true
    m.video.control = "stop"
    stopTranscode()
    m.cur.resumeSeconds = Int(m.position)
    startCurrent()
    return
  end if
  msg = playVideoErrorText(m.video.errorCode, m.video.errorMsg)
  m.video.control = "stop"
  m.video.visible = false
  stopTranscode()
  m.status.busy = false
  m.status.title = "Couldn't play this"
  m.status.message = msg
  if m.quality <> "480p" then
    m.status.buttons = ["Try a lower quality", "Close"]
  else
    m.status.buttons = ["Try again", "Close"]
  end if
  m.status.visible = true
  m.statusIsError = true
  m.status.callFunc("focusMe")
end sub

sub showFailure(resp as object)
  hideLoading()
  m.video.visible = false
  m.status.busy = false
  m.status.title = "Can't play this right now"
  m.status.message = playFriendlyError(resp.status, resp.code, resp.message)
  m.status.buttons = ["Try again", "Close"]
  m.status.visible = true
  m.statusIsError = true
  m.status.callFunc("focusMe")
end sub

sub onStatusButton()
  if not m.statusIsError then return
  if m.status.selected = 0 then
    ' step down one quality after a playback error
    if m.quality = "1080p" then
      m.forceQuality = "720p"
    else if m.quality = "720p" then
      m.forceQuality = "480p"
    end if
    m.cur.resumeSeconds = Int(m.position)
    startCurrent()
  else
    closeNow()
  end if
end sub

' ---- leaving ------------------------------------------------------------------------------------
sub stopTranscode()
  if m.ticket <> "" then
    body = CreateObject("roAssociativeArray")
    body.SetModeCaseSensitive()
    body["ticket"] = m.ticket
    apiPost("/api/playback/stop", body, { timeoutMs: 8000 }, onStopped)
    m.ticket = ""
  end if
end sub

sub onStopped(resp as object, ctx as dynamic)
end sub

' The video finished (or nothing more to play): next queue item, or leave.
sub finishItem(finished as boolean)
  m.reportTimer.control = "stop"
  reportProgress(false)
  stopTranscode()
  if finished and m.index + 1 < m.queue.count() then
    m.index = m.index + 1
    m.forceQuality = ""
    m.forceLegacy = false ' a new file gets its own chance to be played as it is
    startCurrent()
    return
  end if
  leave()
end sub

' Save progress, stop the server-side conversion, then close. Waits (briefly) for the
' progress answer so the last position isn't lost when this view is removed.
sub leave()
  if m.closing then return
  m.closing = true
  m.reportTimer.control = "stop"
  m.video.control = "stop"
  stopTranscode()
  if m.session <> "" and m.duration > 0 then
    showLoading("Saving your place...")
    m.closeTimer.duration = 3
    reportProgress(true)
  else
    m.closeTimer.duration = 1
  end if
  m.closeTimer.control = "start"
end sub

sub onCloseTimer()
  closeNow()
end sub

sub closeNow()
  if m.closed = true then return
  m.closed = true
  m.closeTimer.control = "stop"
  m.reportTimer.control = "stop"
  stopTranscode()
  navPop()
end sub

function onKeyEvent(key as string, press as boolean) as boolean
  if not press then return false
  if key = "back" then
    if m.statusIsError then
      closeNow()
    else
      leave()
    end if
    return true
  end if
  return false
end function
