sub init()
  baseInit()
  L = m.theme.layout
  m.brand = m.top.findNode("brand")
  m.title = m.top.findNode("title")
  m.step1 = m.top.findNode("step1")
  m.uri = m.top.findNode("uri")
  m.step2 = m.top.findNode("step2")
  m.code = m.top.findNode("code")
  m.status = m.top.findNode("status")
  m.spinner = m.top.findNode("spinner")
  m.buttons = m.top.findNode("buttons")
  m.pollTimer = m.top.findNode("pollTimer")
  m.tickTimer = m.top.findNode("tickTimer")
  themeLabel(m.brand, "heading", "accent")
  themeLabel(m.title, "title", "text")
  themeLabel(m.step1, "body", "textDim")
  themeLabel(m.uri, "display", "accent")
  themeLabel(m.step2, "body", "textDim")
  themeLabel(m.code, "code", "text")
  themeLabel(m.status, "body", "textDim")
  m.brand.text = "Beebo Entertainment"
  m.brand.translation = [L.marginX, L.marginY]
  m.title.text = "Sign in with your phone"
  m.title.translation = [L.marginX, 130]
  m.step1.text = "1.  On your phone or computer, open"
  m.step1.translation = [L.marginX, 250]
  m.uri.translation = [L.marginX, 290]
  m.step2.text = "2.  Sign in to Beebo there, then enter this code"
  m.step2.translation = [L.marginX, 400]
  m.code.translation = [L.marginX, 440]
  m.status.translation = [L.marginX, 620]
  m.status.width = 1300
  m.spinner.poster.uri = "pkg:/images/PLACEHOLDER_spinner.png"
  m.spinner.translation = [L.marginX + 1000, 470]
  m.buttons.translation = [L.marginX, 760]
  m.buttonKey = ""
  m.buttons.observeField("selected", "onButton")
  m.pollTimer.observeField("fire", "onPollTimer")
  m.tickTimer.observeField("fire", "onTick")
  m.st = pairNew()
end sub

sub onParams()
  beginPairing()
end sub

sub focusMe()
  m.buttons.callFunc("focusMe")
end sub

function nowSec() as integer
  dt = CreateObject("roDateTime")
  return dt.AsSeconds()
end function

' ---- machine plumbing ------------------------------------------------------------------
sub beginPairing()
  m.pollTimer.control = "stop"
  m.tickTimer.control = "stop"
  m.unavailable = false
  perform(pairHandle(m.st, { type: "begin" }))
  render()
end sub

sub feed(ev as object)
  perform(pairHandle(m.st, ev))
  if m.st.phase <> "waiting" then
    m.pollTimer.control = "stop"
    m.tickTimer.control = "stop"
  end if
  render()
end sub

' Only rebuild the buttons when their labels really change (render runs every second).
sub setButtons(list as object)
  key = ""
  for each b in list
    key = key + "|" + b
  end for
  if key = m.buttonKey then return
  m.buttonKey = key
  m.buttons.buttons = list
end sub

sub perform(a as object)
  if a.type = "request_start" then
    di = CreateObject("roDeviceInfo")
    body = pairStartBody(di.GetFriendlyName(), di.GetModelDisplayName())
    c = pairContract()
    apiPost(c.startPath, body, { url: c.baseUrl + c.startPath, auth: false, timeoutMs: 15000 }, onStartResponse)
  else if a.type = "poll" then
    m.pollTimer.duration = a.delaySec
    m.pollTimer.control = "start"
  else if a.type = "approved" then
    m.pollTimer.control = "stop"
    m.tickTimer.control = "stop"
    onApproved(a.token, a.name)
    a.token = "" ' this action object is done with the viewer token
  end if
end sub

sub onStartResponse(resp as object, ctx as dynamic)
  if resp.status = 404 then
    ' The Worker answers 404 while BEEBO_TVPAIR_ENABLED is off.
    m.unavailable = true
    m.st.phase = "error"
    m.st.error = "unavailable"
    render()
    return
  end if
  if resp.status = 429 then
    m.st.phase = "error"
    m.st.error = "rate_limited"
    render()
    return
  end if
  parsed = invalid
  if resp.ok then parsed = pairParseStart(resp.data)
  feed({ type: "start_result", ok: resp.ok, parsed: parsed, now: nowSec() })
  if m.st.phase = "waiting" then m.tickTimer.control = "start"
end sub

sub onPollTimer()
  if m.st.phase <> "waiting" then return
  c = pairContract()
  apiPost(c.pollPath, pairPollBody(m.st.deviceCode), { url: c.baseUrl + c.pollPath, auth: false, timeoutMs: 15000 }, onPollResponse)
end sub

sub onPollResponse(resp as object, ctx as dynamic)
  if m.st.phase <> "waiting" then return
  if resp.errorKind = "network" or resp.errorKind = "timeout" or resp.status >= 500 then
    feed({ type: "poll_failed", now: nowSec() })
    return
  end if
  if resp.status = 404 then
    feed({ type: "poll_failed", now: nowSec() })
    return
  end if
  feed({ type: "poll_result", parsed: pairParsePoll(resp.data, resp.status), now: nowSec() })
end sub

sub onTick()
  feed({ type: "tick", now: nowSec() })
end sub

' ---- approval and the viewer-session exchange -----------------------------------------------
' `token` is the 12-hour Beebo *viewer* token for the house. It is traded ONCE for a normal API session
' (POST /api/viewer-session, see lib/PairingContract.brs and docs VIEWER-EXCHANGE.md), the same way
' apps/smarttv and apps/apple do. It lives only in m.approvedToken for as long as that takes, is
' never stored, logged or put in a URL, and is cleared as soon as the server has answered.
' Anything but a 200 falls back to typing a username and password.
sub onApproved(token as string, houseName as string)
  m.approvedToken = token
  m.exchangeTries = 0
  if m.global.server <> "" then
    startExchange(m.global.server)
    return
  end if
  if pairIsHouseName(houseName) then
    target = urlServerFromBeeboName(houseName)
    if target.ok then
      m.st.phase = "checking"
      m.status.text = "Approved. Checking your home at " + target.url + " ..."
      m.checkUrl = target.url
      apiGet("/api/ping", { url: target.url + "/api/ping", auth: false, timeoutMs: 9000 }, onHomeChecked)
      return
    end if
  end if
  dropToken()
  goSignIn("", "Your phone approved this Roku, but Beebo didn't say which home it belongs to. Enter your server address, then sign in with your username and password.")
end sub

sub onHomeChecked(resp as object, ctx as dynamic)
  reachable = false
  if resp.ok and resp.data <> invalid then reachable = LCase(fmtStr(resp.data.app, "")) = "beeboentertainment"
  if reachable then
    startExchange(m.checkUrl)
  else
    dropToken()
    m.st.phase = "unreachable"
    render()
  end if
end sub

sub dropToken()
  m.approvedToken = ""
end sub

' One POST to the home server. The token is only ever put in the Authorization header, and only for
' https or a private LAN address.
sub startExchange(serverUrl as string)
  if not pairSafeExchangeUrl(serverUrl) or not pairIsViewerToken(m.approvedToken) then
    dropToken()
    goSignIn(serverUrl, pairExchangeText({ status: "unreachable", code: "" }))
    return
  end if
  m.st.phase = "checking"
  m.status.text = "Approved. Signing in..."
  di = CreateObject("roDeviceInfo")
  name = fmtStr(di.GetFriendlyName(), "").trim()
  if name = "" then name = "Roku"
  c = pairContract()
  m.exchangeUrl = serverUrl
  apiPost(c.exchangePath, pairExchangeBody(name), { url: serverUrl + c.exchangePath, auth: false, bearer: m.approvedToken, timeoutMs: 20000 }, onExchange)
  render()
end sub

sub onExchange(resp as object, ctx as dynamic)
  ' No answer at all (network / timeout): ask again once. Any real answer is final: a 401 means pair again,
  ' and asking more only trips the address lockout.
  if (resp.errorKind = "network" or resp.errorKind = "timeout") and m.exchangeTries < 1 then
    m.exchangeTries = m.exchangeTries + 1
    startExchange(m.exchangeUrl)
    return
  end if
  dropToken()
  r = pairClassifyExchange(resp.status, resp.data)
  if r.status = "signed_in" then
    ' Home server address + the new API token, exactly as if /api/login had answered.
    m.top.navigate = { action: "paired", url: m.exchangeUrl, token: r.token, userName: r.userName }
    return
  end if
  goSignIn(m.exchangeUrl, pairExchangeText(r))
end sub

' The typed sign-in (always works): show why the phone code was not enough.
sub goSignIn(serverUrl as string, message as string)
  if serverUrl = "" then
    m.top.navigate = { action: "reset", view: "SetupView", params: {} }
  else
    m.top.navigate = { action: "server", url: serverUrl, params: { message: message } }
  end if
end sub

' ---- screen ---------------------------------------------------------------------------------
sub render()
  st = m.st
  showCode = st.phase = "waiting"
  m.step1.visible = showCode
  m.uri.visible = showCode
  m.step2.visible = showCode
  m.code.visible = showCode
  busy = st.phase = "starting" or st.phase = "checking"
  m.spinner.visible = busy
  if busy then m.spinner.control = "start" else m.spinner.control = "stop"
  if showCode then
    m.uri.text = st.verificationUri
    m.code.text = st.userCode
    left = pairSecondsLeft(st, nowSec())
    m.status.text = "Waiting for you to approve on your phone...   Code expires in " + fmtClock(left)
    m.status.color = m.theme.color.textDim
  else if st.phase = "starting" then
    m.status.text = "Getting a code..."
  else if st.phase = "expired" then
    m.status.text = "That code expired. Get a new one and try again."
  else if st.phase = "denied" then
    m.status.text = pairDeniedText(st.reason)
  else if st.phase = "unreachable" then
    m.status.text = "Your phone approved this Roku, but your home's direct address couldn't be reached from here. If you're at home, go back and choose the Beebo found on your network."
  else if st.phase = "checking" then
    ' status text is set by the step that entered this phase (checking the address, then signing in)
  else if st.phase = "error" then
    if st.error = "unavailable" then
      m.status.text = "Sign-in with a phone code isn't switched on yet. Go back and type your server address, or use a username and password."
    else if st.error = "rate_limited" then
      m.status.text = "Too many codes requested from this network. Wait a few minutes and try again."
    else if st.error = "network" then
      m.status.text = "Couldn't reach Beebo. Check this Roku's internet connection and try again."
    else
      m.status.text = "Couldn't get a code right now. Try again in a moment."
    end if
  end if
  if st.phase = "waiting" or st.phase = "starting" or st.phase = "checking" then
    setButtons(["Cancel"])
  else if m.unavailable = true then
    setButtons(["Back"])
  else
    setButtons(["Get a new code", "Cancel"])
  end if
  if not m.top.isInFocusChain() then m.buttons.callFunc("focusMe")
end sub

sub onButton()
  label = m.buttons.buttons[m.buttons.selected]
  if label = "Get a new code" then
    beginPairing()
  else
    stopAll()
    navPop()
  end if
end sub

sub stopAll()
  m.pollTimer.control = "stop"
  m.tickTimer.control = "stop"
  apiCancelAll()
end sub

function onKeyEvent(key as string, press as boolean) as boolean
  if press and key = "back" then
    stopAll()
    navPop()
    return true
  end if
  return false
end function
