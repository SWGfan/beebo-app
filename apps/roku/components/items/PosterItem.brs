sub init()
  m.theme = Theme()
  C = m.theme.color
  m.poster = m.top.findNode("poster")
  m.newBadge = m.top.findNode("newBadge")
  m.newText = m.top.findNode("newText")
  m.barTrack = m.top.findNode("barTrack")
  m.barFill = m.top.findNode("barFill")
  m.title = m.top.findNode("title")
  themeLabel(m.title, "label", "text")
  themeLabel(m.newText, "caption", "accentText")
  m.newBadge.color = C.accent
  m.barTrack.color = C.progressTrack
  m.barFill.color = C.accent
  m.poster.failedBitmapUri = themePosterMissing()
  m.poster.loadingBitmapUri = themePosterMissing()
  onSize()
  onContent()
end sub

sub onSize()
  if m.theme = invalid then return
  L = m.theme.layout
  w = m.top.width
  if w <= 0 then return
  ph = L.posterHeight
  pw = L.posterWidth
  ' the poster is centred in the cell; loadWidth/Height keep the decoded bitmap small
  x = (w - pw) / 2
  m.poster.translation = [x, 0]
  m.poster.width = pw
  m.poster.height = ph
  m.poster.loadWidth = pw
  m.poster.loadHeight = ph
  m.newBadge.translation = [x + 8, 8]
  m.newBadge.width = 64
  m.newBadge.height = 30
  m.newText.translation = [x + 8, 8]
  m.newText.width = 64
  m.newText.height = 30
  m.newText.horizAlign = "center"
  m.newText.vertAlign = "center"
  m.barTrack.translation = [x + 10, ph - 16]
  m.barTrack.width = pw - 20
  m.barTrack.height = 6
  m.barFill.translation = [x + 10, ph - 16]
  m.title.translation = [x, ph + 6]
  m.title.width = pw
  m.title.height = L.posterTitleHeight
  m.title.horizAlign = "center"
  m.title.vertAlign = "top"
end sub

sub onContent()
  if m.theme = invalid then return
  c = m.top.itemContent
  if c = invalid then return
  m.title.text = c.title
  uri = c.HDPosterUrl
  if uri = invalid or uri = "" then
    m.poster.uri = themePosterMissing()
  else
    m.poster.uri = uri
  end if
  flag = c.ShortDescriptionLine1
  showNew = flag <> invalid and flag = "NEW"
  m.newBadge.visible = showNew
  m.newText.visible = showNew
  if showNew then m.newText.text = "NEW"
  showBar = false
  if c.Length > 0 and c.PlayStart > 0 then
    frac = c.PlayStart / c.Length
    if frac > 1 then frac = 1
    m.barFill.width = (m.theme.layout.posterWidth - 20) * frac
    m.barFill.height = 6
    showBar = true
  end if
  m.barTrack.visible = showBar
  m.barFill.visible = showBar
end sub
