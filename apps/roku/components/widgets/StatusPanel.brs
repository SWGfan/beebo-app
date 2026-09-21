sub init()
  m.theme = Theme()
  m.spinner = m.top.findNode("spinner")
  m.title = m.top.findNode("title")
  m.message = m.top.findNode("message")
  m.buttons = m.top.findNode("buttons")
  themeLabel(m.title, "heading", "text")
  themeLabel(m.message, "body", "textDim")
  m.spinner.poster.uri = "pkg:/images/PLACEHOLDER_spinner.png"
  m.buttons.observeField("selected", "onButton")
  refresh()
end sub

sub refresh()
  if m.buttons = invalid then return
  busy = m.top.busy
  m.spinner.visible = busy
  m.spinner.control = "stop"
  if busy then m.spinner.control = "start"
  y = 0
  if busy then
    m.spinner.translation = [0, 0]
    y = 120
  end if
  m.title.text = m.top.title
  m.title.translation = [0, y]
  y = y + 70
  m.message.text = m.top.message
  m.message.translation = [0, y]
  ' one line of body text is ~40px; leave room for up to 3 lines
  lines = Int(Len(m.top.message) / 70) + 1
  if lines > 4 then lines = 4
  y = y + lines * 44 + 30
  b = m.top.buttons
  if b <> invalid and b.count() > 0 and not busy then
    m.buttons.buttons = b
    m.buttons.translation = [0, y]
    m.buttons.visible = true
  else
    m.buttons.buttons = []
    m.buttons.visible = false
  end if
end sub

sub focusMe()
  if m.buttons.visible then m.buttons.callFunc("focusMe")
end sub

sub onButton()
  m.top.selected = m.buttons.selected
end sub
