sub init()
  m.theme = Theme()
  C = m.theme.color
  m.scrim = m.top.findNode("scrim")
  m.panel = m.top.findNode("panel")
  m.title = m.top.findNode("title")
  m.list = m.top.findNode("list")
  m.scrim.color = C.scrim
  m.panel.color = C.surface
  themeLabel(m.title, "heading", "text")
  m.list.color = C.text
  m.list.focusedColor = C.accent
  m.list.focusBitmapUri = "pkg:/images/PLACEHOLDER_focus.9.png"
  m.list.observeField("itemSelected", "onSelected")
  refresh()
end sub

sub focusMe()
  m.list.setFocus(true)
end sub

sub refresh()
  if m.list = invalid then return
  opts = m.top.options
  if opts = invalid then return
  L = m.theme.layout
  rowH = 64
  visible = opts.count()
  if visible > 8 then visible = 8
  if visible < 1 then visible = 1
  panelW = 800
  panelH = 150 + visible * rowH + 40
  x = (L.screenWidth - panelW) / 2
  y = (L.screenHeight - panelH) / 2
  m.panel.width = panelW
  m.panel.height = panelH
  m.panel.translation = [x, y]
  m.title.translation = [x + 40, y + 30]
  m.title.width = panelW - 80
  m.title.text = m.top.title
  m.list.translation = [x + 40, y + 110]
  m.list.itemSize = [panelW - 80, rowH]
  m.list.numRows = visible
  content = CreateObject("roSGNode", "ContentNode")
  for each o in opts
    n = content.createChild("ContentNode")
    n.title = o
  end for
  m.list.content = content
  m.list.jumpToItem = m.top.selectedIndex
end sub

sub onSelected()
  m.top.chosen = m.list.itemSelected
end sub

function onKeyEvent(key as string, press as boolean) as boolean
  if press and key = "back" then
    m.top.chosen = -1
    return true
  end if
  return false
end function
