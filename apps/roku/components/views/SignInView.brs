sub init()
  baseInit()
  L = m.theme.layout
  m.brand = m.top.findNode("brand")
  m.title = m.top.findNode("title")
  m.server = m.top.findNode("server")
  m.message = m.top.findNode("message")
  m.error = m.top.findNode("error")
  m.buttons = m.top.findNode("buttons")
  m.spinner = m.top.findNode("spinner")
  themeLabel(m.brand, "heading", "accent")
  themeLabel(m.title, "title", "text")
  themeLabel(m.server, "label", "textFaint")
  themeLabel(m.message, "body", "textDim")
  themeLabel(m.error, "body", "danger")
  m.brand.text = "Beebo Entertainment"
  m.brand.translation = [L.marginX, L.marginY]
  m.title.text = "Sign in"
  m.title.translation = [L.marginX, 150]
  m.server.translation = [L.marginX, 235]
  m.server.width = 1400
  m.message.translation = [L.marginX, 280]
  m.message.width = 1300
  m.error.translation = [L.marginX, 350]
  m.error.width = 1300
  m.buttons.translation = [L.marginX, 450]
  m.spinner.poster.uri = "pkg:/images/PLACEHOLDER_spinner.png"
  m.spinner.translation = [L.marginX + 700, 450]
  m.buttons.observeField("selected", "onButton")
  m.username = ""
  m.password = ""
  m.busy = false
  m.kinds = []
end sub

sub onParams()
  p = m.top.params
  m.server.text = "Server: " + m.global.server
  m.message.text = "Use the username and password you use on your Beebo computer or in the Beebo app."
  if p <> invalid and fmtStr(p.message, "") <> "" then m.message.text = p.message
  refreshButtons()
  focusMe()
end sub

sub focusMe()
  if not m.busy then m.buttons.callFunc("focusMe")
end sub

sub refreshButtons()
  labels = []
  kinds = []
  uname = m.username
  if uname = "" then uname = "not set"
  labels.push("Username: " + uname)
  kinds.push("username")
  pw = "not set"
  if m.password <> "" then pw = String(Len(m.password), "*")
  labels.push("Password: " + pw)
  kinds.push("password")
  labels.push("Sign in")
  kinds.push("signin")
  labels.push("Change server")
  kinds.push("server")
  m.kinds = kinds
  m.buttons.buttons = labels
end sub

sub onButton()
  if m.busy then return
  idx = m.buttons.selected
  if idx < 0 or idx >= m.kinds.count() then return
  kind = m.kinds[idx]
  if kind = "username" then
    showKeyboard("Username", "Your Beebo username", m.username, false, onUsername)
  else if kind = "password" then
    showKeyboard("Password", "Your Beebo password", "", true, onPassword)
  else if kind = "signin" then
    doSignIn()
  else if kind = "server" then
    navReplaceAll("SetupView", {})
  end if
end sub

sub onUsername(text as string)
  m.username = text.trim()
  refreshButtons()
end sub

sub onPassword(text as string)
  m.password = text
  refreshButtons()
end sub

sub doSignIn()
  m.error.text = ""
  if m.username = "" or m.password = "" then
    m.error.text = "Enter your username and password first."
    return
  end if
  setBusy(true)
  body = CreateObject("roAssociativeArray")
  body.SetModeCaseSensitive()
  body["username"] = m.username
  body["password"] = m.password
  apiPost("/api/login", body, { auth: false, timeoutMs: 20000 }, onLoginResult)
  m.password = "" ' not kept once sent
end sub

sub setBusy(busy as boolean)
  m.busy = busy
  m.spinner.visible = busy
  if busy then m.spinner.control = "start" else m.spinner.control = "stop"
end sub

sub onLoginResult(resp as object, ctx as dynamic)
  setBusy(false)
  if resp.ok and resp.data <> invalid then
    token = fmtStr(resp.data.token, "")
    if token <> "" then
      name = ""
      if resp.data.user <> invalid then name = fmtStr(resp.data.user.name, "")
      m.top.navigate = { action: "signedin", token: token, userName: name }
      return
    end if
  end if
  refreshButtons()
  if resp.status = 401 then
    mins = 0
    locked = false
    if resp.data <> invalid then
      mins = fmtInt(resp.data.minutesRemaining, 0)
      locked = fmtIsTrue(resp.data.locked)
    end if
    if locked then
      m.error.text = "Too many attempts. Try again in " + Str(mins).trim() + " minutes."
    else
      m.error.text = "That username or password didn't match. Try again."
    end if
  else
    m.error.text = playFriendlyError(resp.status, resp.code, resp.message)
  end if
  focusMe()
end sub

function onKeyEvent(key as string, press as boolean) as boolean
  return false
end function
