sub init()
  m.theme = Theme()
  m.items = []
  m.top.observeField("focusedChild", "onFocusChange")
  rebuild()
end sub

sub focusMe()
  m.top.setFocus(true)
  restyle()
end sub

sub rebuild()
  if m.items = invalid then return
  ' remove old children
  for each it in m.items
    m.top.removeChild(it.bg)
    m.top.removeChild(it.label)
    if it.underline <> invalid then m.top.removeChild(it.underline)
  end for
  m.items = []
  buttons = m.top.buttons
  if buttons = invalid then return
  if m.top.index >= buttons.count() then m.top.index = 0
  L = m.theme.layout
  isTab = m.top.style = "tab"
  padX = L.buttonPadX
  if isTab then padX = 12
  h = L.buttonHeight
  ' measure
  widths = []
  maxW = m.top.minWidth
  for each text in buttons
    probe = CreateObject("roSGNode", "Label")
    themeApplyFont(probe, "button")
    probe.text = text
    w = probe.boundingRect().width + padX * 2
    if w < m.top.minWidth then w = m.top.minWidth
    widths.push(w)
    if w > maxW then maxW = w
  end for
  offset = 0
  for i = 0 to buttons.count() - 1
    w = widths[i]
    if m.top.vertical then w = maxW
    bg = CreateObject("roSGNode", "Rectangle")
    bg.width = w
    bg.height = h
    label = CreateObject("roSGNode", "Label")
    themeApplyFont(label, "button")
    label.text = buttons[i]
    label.width = w
    label.height = h
    label.horizAlign = "center"
    label.vertAlign = "center"
    item = { bg: bg, label: label, underline: invalid, w: w }
    if isTab then
      bg.color = "0x00000000"
      ul = CreateObject("roSGNode", "Rectangle")
      ul.width = w - 24
      ul.height = 5
      item.underline = ul
    end if
    if m.top.vertical then
      bg.translation = [0, offset]
      label.translation = [0, offset]
      offset = offset + h + L.buttonGap
    else
      bg.translation = [offset, 0]
      label.translation = [offset, 0]
      offset = offset + w + L.buttonGap
    end if
    m.top.appendChild(bg)
    m.top.appendChild(label)
    if item.underline <> invalid then
      item.underline.translation = [bg.translation[0] + 12, bg.translation[1] + h - 6]
      m.top.appendChild(item.underline)
    end if
    m.items.push(item)
  end for
  restyle()
end sub

sub onFocusChange()
  restyle()
end sub

sub restyle()
  if m.items = invalid then return
  C = m.theme.color
  focused = m.top.isInFocusChain()
  isTab = m.top.style = "tab"
  for i = 0 to m.items.count() - 1
    it = m.items[i]
    isFocus = focused and i = m.top.index
    if isTab then
      isCur = i = m.top.current
      if isFocus then
        it.label.color = C.accent
      else if isCur then
        it.label.color = C.text
      else
        it.label.color = C.textDim
      end if
      if it.underline <> invalid then
        it.underline.visible = isCur or isFocus
        if isFocus then it.underline.color = C.accent else it.underline.color = C.text
      end if
    else
      if isFocus then
        it.bg.color = C.accent
        it.label.color = C.accentText
      else
        it.bg.color = C.surfaceRaised
        it.label.color = C.text
      end if
    end if
  end for
end sub

function onKeyEvent(key as string, press as boolean) as boolean
  if not press then return false
  count = m.items.count()
  if count = 0 then return false
  prevKey = "left"
  nextKey = "right"
  if m.top.vertical then
    prevKey = "up"
    nextKey = "down"
  end if
  if key = prevKey then
    if m.top.index > 0 then
      m.top.index = m.top.index - 1
      m.top.moved = m.top.index
      return true
    end if
    return false
  else if key = nextKey then
    if m.top.index < count - 1 then
      m.top.index = m.top.index + 1
      m.top.moved = m.top.index
      return true
    end if
    return false
  else if key = "OK" then
    m.top.selected = m.top.index
    return true
  end if
  return false
end function
