sub init()
  baseInit()
  L = m.theme.layout
  C = m.theme.color
  m.title = m.top.findNode("title")
  m.menu = m.top.findNode("menu")
  themeLabel(m.title, "title", "text")
  m.title.text = "Settings"
  m.title.translation = [L.marginX, L.marginY]
  m.menu.translation = [L.marginX, 190]
  m.menu.itemSize = [1400, 76]
  m.menu.numRows = 7
  m.menu.color = C.text
  m.menu.focusedColor = C.accent
  m.menu.focusBitmapUri = themeFocusRing()
  m.menu.observeField("itemSelected", "onSelected")
  m.qualityKeys = ["auto", "1080p", "720p", "480p"]
  m.qualityNames = ["Auto (best for each video)", "1080p", "720p", "480p"]
  m.kinds = []
end sub

sub onParams()
  rebuild()
  m.menu.setFocus(true)
end sub

sub focusMe()
  m.menu.setFocus(true)
end sub

function qualityName() as string
  for i = 0 to m.qualityKeys.count() - 1
    if m.qualityKeys[i] = m.global.quality then return m.qualityNames[i]
  end for
  return m.qualityNames[0]
end function

sub rebuild()
  labels = []
  kinds = []
  labels.push("Server:  " + m.global.server)
  kinds.push("server")
  who = fmtStr(m.global.userName, "")
  if who = "" then who = "signed in"
  labels.push("Account:  " + who + "  (sign out)")
  kinds.push("signout")
  labels.push("Video quality:  " + qualityName())
  kinds.push("quality")
  labels.push("About this channel")
  kinds.push("about")
  m.kinds = kinds
  keep = m.menu.itemFocused
  m.menu.content = nodesTitles(labels)
  if keep > 0 and keep < labels.count() then m.menu.jumpToItem = keep
end sub

sub onSelected()
  idx = m.menu.itemSelected
  if idx < 0 or idx >= m.kinds.count() then return
  kind = m.kinds[idx]
  if kind = "server" then
    navReplaceAll("SetupView", {})
  else if kind = "signout" then
    m.top.navigate = { action: "signout" }
  else if kind = "quality" then
    cur = 0
    for i = 0 to m.qualityKeys.count() - 1
      if m.qualityKeys[i] = m.global.quality then cur = i
    end for
    picker = CreateObject("roSGNode", "PickerDialog")
    picker.title = "Video quality"
    picker.options = m.qualityNames
    picker.selectedIndex = cur
    picker.observeField("chosen", "onQualityChosen")
    m.picker = picker
    m.top.appendChild(picker)
    picker.callFunc("focusMe")
  else if kind = "about" then
    info = CreateObject("roAppInfo")
    showMessage("Beebo Entertainment " + info.GetVersion(), "This channel plays the movies and shows on your own Beebo server. It contains no content of its own. Video is converted on your computer and streamed to this Roku.", "focusMe")
  end if
end sub

sub onQualityChosen(event as object)
  idx = event.getData()
  m.picker.unobserveField("chosen")
  m.top.removeChild(m.picker)
  m.picker = invalid
  if idx >= 0 and idx < m.qualityKeys.count() then
    regWrite("quality", m.qualityKeys[idx])
    m.global.quality = m.qualityKeys[idx]
    rebuild()
  end if
  m.menu.setFocus(true)
end sub

function onKeyEvent(key as string, press as boolean) as boolean
  if press and key = "back" then
    navPop()
    return true
  end if
  return false
end function
