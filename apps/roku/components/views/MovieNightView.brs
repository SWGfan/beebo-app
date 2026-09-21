sub init()
  baseInit()
  L = m.theme.layout
  m.title = m.top.findNode("title")
  m.state = m.top.findNode("state")
  m.body = m.top.findNode("body")
  m.address = m.top.findNode("address")
  m.footnote = m.top.findNode("footnote")
  m.spinner = m.top.findNode("spinner")
  m.buttons = m.top.findNode("buttons")
  themeLabel(m.title, "title", "text")
  themeLabel(m.state, "body", "textDim")
  themeLabel(m.body, "body", "text")
  themeLabel(m.address, "display", "accent")
  themeLabel(m.footnote, "label", "textFaint")
  m.title.text = "Movie Night"
  m.title.translation = [L.marginX, L.marginY]
  m.state.translation = [L.marginX, 150]
  m.state.width = 1300
  m.body.translation = [L.marginX, 230]
  m.body.width = 1300
  m.address.translation = [L.marginX, 500]
  m.footnote.translation = [L.marginX, 590]
  m.footnote.width = 1300
  m.footnote.text = "Phones join by scanning the square on that page. Nothing needs the internet."
  m.spinner.poster.uri = "pkg:/images/PLACEHOLDER_spinner.png"
  m.spinner.translation = [L.marginX + 1100, 150]
  m.buttons.translation = [L.marginX, 700]
  m.buttons.buttons = ["Check again", "Back"]
  m.buttons.observeField("selected", "onButton")
  m.body.text = mnInstructions()
  m.runId = 0
end sub

sub onParams()
  m.address.text = mnTvAddress(m.global.server)
  check()
  focusMe()
end sub

sub focusMe()
  m.buttons.callFunc("focusMe")
end sub

sub check()
  m.runId = m.runId + 1
  m.state.text = "Checking Movie Night on your Beebo computer..."
  m.spinner.visible = true
  m.spinner.control = "start"
  apiGet("/api/movie-night/status", { timeoutMs: 12000 }, onStatus, { run: m.runId })
end sub

sub onStatus(resp as object, ctx as dynamic)
  if ctx.run <> m.runId then return
  m.spinner.control = "stop"
  m.spinner.visible = false
  if resp.status = 0 then
    m.state.text = playFriendlyError(0, "", "")
    return
  end if
  r = mnParseStatus(resp.status, resp.data)
  m.state.text = r.message
end sub

sub onButton()
  if m.buttons.selected = 0 then
    check()
  else
    apiCancelAll()
    navPop()
  end if
end sub

function onKeyEvent(key as string, press as boolean) as boolean
  if press and key = "back" then
    apiCancelAll()
    navPop()
    return true
  end if
  return false
end function
