sub init()
  m.top.backgroundColor = Theme().color.background
  m.top.backgroundURI = ""

  ' Global state shared by every component. The token is only ever read to build an
  ' Authorization header (lib/Api.brs) and is never logged.
  m.global.addFields({ server: "", token: "", userName: "", quality: "auto", subtitles: "off", authFailures: 0 })
  s = regLoadSettings()
  m.global.server = s.server
  m.global.token = s.token
  m.global.userName = s.userName
  m.global.quality = s.quality
  m.global.subtitles = s.subtitles
  m.global.observeField("authFailures", "onAuthFailure")

  m.stack = []
  if s.server = "" then
    showRoot("SetupView", {})
  else if s.token = "" then
    showRoot("SignInView", {})
  else
    showRoot("HomeView", {})
  end if
  ' Roku certification: tell the OS the channel is interactive.
  m.top.signalBeacon("AppLaunchComplete")
end sub

' ---- view stack ---------------------------------------------------------------
function currentView() as dynamic
  if m.stack.count() = 0 then return invalid
  return m.stack[m.stack.count() - 1]
end function

sub pushView(name as string, params as object)
  prev = currentView()
  if prev <> invalid then prev.visible = false
  view = CreateObject("roSGNode", name)
  view.observeField("navigate", "onNavigate")
  m.top.appendChild(view)
  view.params = params
  m.stack.push(view)
  view.callFunc("focusMe")
end sub

sub popView()
  if m.stack.count() <= 1 then return
  gone = m.stack.pop()
  gone.unobserveField("navigate")
  m.top.removeChild(gone)
  prev = currentView()
  if prev <> invalid then
    prev.visible = true
    prev.callFunc("focusMe")
  end if
end sub

sub showRoot(name as string, params as object)
  while m.stack.count() > 0
    gone = m.stack.pop()
    gone.unobserveField("navigate")
    m.top.removeChild(gone)
  end while
  pushView(name, params)
end sub

sub onNavigate(event as object)
  nav = event.getData()
  if nav = invalid then return
  action = nav.action
  if action = "push" then
    pushView(nav.view, nav.params)
  else if action = "pop" then
    popView()
  else if action = "reset" then
    showRoot(nav.view, nav.params)
  else if action = "server" then
    ' A new server address: the old sign-in belonged to the old server.
    regSaveServer(nav.url)
    m.global.server = nav.url
    m.global.token = regRead("token", "")
    m.global.userName = regRead("userName", "")
    if m.global.token = "" then
      showRoot("SignInView", nav.params)
    else
      showRoot("HomeView", {})
    end if
  else if action = "signedin" then
    regSaveToken(nav.token, nav.userName)
    m.global.token = nav.token
    m.global.userName = nav.userName
    showRoot("HomeView", {})
  else if action = "signout" then
    signOut("")
  end if
end sub

sub signOut(message as string)
  regClearSignIn()
  m.global.token = ""
  m.global.userName = ""
  showRoot("SignInView", { message: message })
end sub

' Any authenticated request that comes back 401 lands here (see lib/Api.brs).
sub onAuthFailure()
  if m.global.token = "" then return ' already signed out (several requests can fail at once)
  logInfo("auth", "server rejected the sign-in")
  signOut("Your sign-in has ended. Please sign in again.")
end sub

function onKeyEvent(key as string, press as boolean) as boolean
  if press and key = "back" then
    if m.stack.count() > 1 then
      popView()
      return true
    end if
  end if
  return false
end function
