sub init()
  baseInit()
  L = m.theme.layout
  C = m.theme.color
  m.title = m.top.findNode("title")
  m.lists = m.top.findNode("lists")
  m.items = m.top.findNode("items")
  m.status = m.top.findNode("status")
  themeLabel(m.title, "title", "text")
  m.title.text = "Playlists"
  m.title.translation = [L.marginX, L.marginY]
  m.lists.translation = [L.marginX, 190]
  m.lists.itemSize = [600, 64]
  m.lists.numRows = 10
  m.lists.color = C.textDim
  m.lists.focusedColor = C.accent
  m.lists.focusBitmapUri = themeFocusRing()
  m.lists.observeField("itemFocused", "onListFocused")
  m.lists.observeField("itemSelected", "onListSelected")
  m.items.translation = [L.marginX + 660, 170]
  m.items.observeField("selected", "onItemSelected")
  m.items.observeField("navigate", "onChildNavigate")
  m.status.translation = [L.marginX, 250]
  m.status.observeField("selected", "onStatusButton")
  m.playlists = []
  m.records = []
  m.gen = 0
  m.openIdx = -1
  m.statusKind = ""
end sub

sub onParams()
  loadLists()
end sub

sub focusMe()
  if m.lists.visible then
    m.lists.setFocus(true)
  else if m.status.visible then
    m.status.callFunc("focusMe")
  end if
end sub

sub loadLists()
  m.status.busy = true
  m.status.title = "Loading your playlists..."
  m.status.message = ""
  m.status.buttons = []
  m.status.visible = true
  m.lists.visible = false
  m.items.visible = false
  apiGet("/api/playlists", { transform: "playlists", timeoutMs: 30000 }, onLists)
end sub

sub onLists(resp as object, ctx as dynamic)
  if not resp.ok then
    m.status.busy = false
    m.status.title = "Couldn't load your playlists"
    m.status.message = playFriendlyError(resp.status, resp.code, resp.message)
    m.status.buttons = ["Try again", "Back"]
    m.statusKind = "error"
    m.status.callFunc("focusMe")
    return
  end if
  m.playlists = resp.data.playlists
  if m.playlists.count() = 0 then
    m.status.busy = false
    m.status.title = "No playlists yet"
    m.status.message = "Make a playlist in the Beebo app or on your computer and it will show up here."
    m.status.buttons = ["Back"]
    m.statusKind = "empty"
    m.status.callFunc("focusMe")
    return
  end if
  m.status.visible = false
  titles = []
  for each p in m.playlists
    label = p.name
    if p.count >= 0 then label = label + "   (" + Str(p.count).trim() + ")"
    titles.push(label)
  end for
  m.lists.content = nodesTitles(titles)
  m.lists.visible = true
  m.items.visible = true
  m.lists.setFocus(true)
  openList(0)
end sub

sub onListFocused()
  ' Load the highlighted playlist a moment after the viewer settles on it.
  m.wanted = m.lists.itemFocused
  openList(m.wanted)
end sub

sub onListSelected()
  m.items.callFunc("focusMe")
end sub

sub openList(idx as integer)
  if idx < 0 or idx >= m.playlists.count() then return
  if idx = m.openIdx then return
  m.openIdx = idx
  m.gen = m.gen + 1
  m.items.title = m.playlists[idx].name
  m.items.emptyText = "This playlist has no videos."
  apiGet("/api/playlists/" + urlEncode(m.playlists[idx].id), { transform: "playlist", timeoutMs: 45000 }, onItems, { gen: m.gen })
end sub

sub onItems(resp as object, ctx as dynamic)
  if ctx.gen <> m.gen then return
  if not resp.ok then
    m.records = []
    m.items.emptyText = "Couldn't load this playlist. " + playFriendlyError(resp.status, resp.code, resp.message)
    m.items.callFunc("setItems", [])
    return
  end if
  m.records = resp.data.items
  m.items.callFunc("setItems", m.records)
end sub

' Play the picked item and carry on down the playlist.
sub onItemSelected()
  rec = m.items.selected
  queue = []
  start = 0
  for i = 0 to m.records.count() - 1
    r = m.records[i]
    if r.id = rec.id and r.kind = rec.kind then start = i
    resume = playResumeSeconds({ currentTime: r.resumeSeconds, duration: 0, percent: r.percent }, 0, 0)
    queue.push({ kind: r.kind, id: r.id, title: r.title, resumeSeconds: resume })
  end for
  navPush("PlayerView", { kind: rec.kind, id: rec.id, title: rec.title, queue: queue, index: start })
end sub

sub onStatusButton()
  if m.statusKind = "error" and m.status.selected = 0 then
    loadLists()
  else
    navPop()
  end if
end sub

sub onChildNavigate(event as object)
  m.top.navigate = event.getData()
end sub

function onKeyEvent(key as string, press as boolean) as boolean
  if not press then return false
  if key = "back" then
    apiCancelAll()
    navPop()
    return true
  else if key = "right" and m.lists.hasFocus() then
    m.items.callFunc("focusMe")
    return true
  else if key = "left" and m.items.isInFocusChain() then
    m.lists.setFocus(true)
    return true
  end if
  return false
end function
