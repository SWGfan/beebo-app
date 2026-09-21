sub init()
  baseInit()
  L = m.theme.layout
  m.header = m.top.findNode("header")
  m.hintLabel = m.top.findNode("hint")
  m.grid = m.top.findNode("grid")
  m.status = m.top.findNode("status")
  themeLabel(m.header, "heading", "text")
  themeLabel(m.hintLabel, "caption", "textFaint")
  m.header.translation = [0, 0]
  m.header.width = 1200
  m.hintLabel.translation = [1200, 14]
  m.hintLabel.width = 528
  m.hintLabel.horizAlign = "right"
  m.grid.translation = [0, 70]
  m.grid.itemSize = [L.cellWidth, L.cellHeight]
  m.grid.itemSpacing = [L.gridSpacingX, L.gridSpacingY]
  m.grid.numRows = L.gridRows
  m.grid.focusBitmapUri = themeFocusRing()
  m.grid.observeField("itemFocused", "onFocused")
  m.grid.observeField("itemSelected", "onItemSelected")
  m.status.translation = [0, 120]
  m.status.visible = false
  m.status.observeField("selected", "onStatusButton")
  m.items = []
  m.gen = 0
  m.fetching = false
  m.source = "static"
  m.total = 0
  m.pager = pagerNew(L.pageSize, L.pageLookahead)
  m.content = invalid
  m.statusKind = ""
  applyColumns()
end sub

sub applyColumns()
  if m.grid = invalid then return
  L = m.theme.layout
  cols = m.top.columns
  if cols < 1 then cols = 1
  m.grid.numColumns = cols
  width = cols * (L.cellWidth + L.gridSpacingX)
  m.header.width = width - 328
  m.hintLabel.translation = [width - 328, 14]
end sub

sub refreshHeader()
  txt = m.top.title
  if m.total > 0 then txt = txt + "   " + fmtCount(m.total)
  m.header.text = txt
  m.hintLabel.text = m.top.hint
end sub

sub focusMe()
  if m.grid.visible and m.items.count() > 0 then
    m.grid.setFocus(true)
  else if m.status.visible then
    m.status.callFunc("focusMe")
  end if
end sub

' ---- loading -----------------------------------------------------------------------
sub load()
  L = m.theme.layout
  apiCancelAll()
  m.gen = m.gen + 1
  m.items = []
  m.total = 0
  m.fetching = false
  m.source = "v1"
  pagerReset(m.pager, 0)
  m.content = CreateObject("roSGNode", "ContentNode")
  m.grid.content = m.content
  m.grid.visible = false
  showBusy()
  refreshHeader()
  requestPage(0)
end sub

sub requestPage(offset as integer)
  L = m.theme.layout
  m.fetching = true
  ctx = { gen: m.gen, offset: offset }
  if m.source = "v1" then
    params = { limit: L.pageSize, offset: offset }
    path = "/api/v1/library/movies"
    tf = "v1movies"
    if m.top.mode = "tv" then
      path = "/api/v1/library/tvshows"
      tf = "v1shows"
    else if m.top.sort <> "title" then
      params.sort = m.top.sort
    end if
    if m.top.query <> "" then params.q = m.top.query
    apiGet(urlWithQuery(path, params), { transform: tf, timeoutMs: 45000 }, onPage, ctx)
  else
    ' Older server without /api/v1: one unpaged list, paged on this side.
    path = "/api/movies"
    tf = "movies"
    params = {}
    if m.top.mode = "tv" then
      path = "/api/tvshows"
      tf = "shows"
    else if m.top.sort <> "title" then
      params.sort = m.top.sort
    end if
    if m.top.query <> "" then params.q = m.top.query
    apiGet(urlWithQuery(path, params), { transform: tf, timeoutMs: 90000 }, onLegacy, ctx)
  end if
end sub

sub onPage(resp as object, ctx as dynamic)
  if ctx.gen <> m.gen then return
  m.fetching = false
  if not resp.ok then
    ' 404/403 on /api/v1 = an older server (or one that limits this account): use the app route.
    if ctx.offset = 0 and (resp.status = 404 or resp.status = 403 or resp.status = 405) then
      m.source = "legacy"
      requestPage(0)
      return
    end if
    showError(resp)
    return
  end if
  d = resp.data
  for each rec in d.items
    m.items.push(rec)
  end for
  m.total = d.total
  if m.total < m.items.count() then m.total = m.items.count()
  afterItemsChanged()
end sub

sub onLegacy(resp as object, ctx as dynamic)
  if ctx.gen <> m.gen then return
  m.fetching = false
  if not resp.ok then
    showError(resp)
    return
  end if
  m.items = resp.data.items
  m.total = m.items.count()
  afterItemsChanged()
end sub

' Static mode: the owner hands us records.
sub setItems(records as object)
  apiCancelAll()
  m.gen = m.gen + 1
  m.source = "static"
  m.items = records
  m.total = records.count()
  m.fetching = false
  pagerReset(m.pager, 0)
  m.content = CreateObject("roSGNode", "ContentNode")
  m.grid.content = m.content
  afterItemsChanged()
end sub

sub afterItemsChanged()
  ' Keep the pager's idea of "how many exist" in step with what has arrived.
  m.pager.total = m.items.count()
  refreshHeader()
  if m.items.count() = 0 then
    m.grid.visible = false
    m.status.title = m.top.emptyText
    m.status.message = ""
    m.status.busy = false
    m.status.buttons = []
    m.status.visible = true
    m.statusKind = "empty"
    return
  end if
  m.status.visible = false
  m.statusKind = ""
  hadFocus = m.top.isInFocusChain()
  wasHidden = not m.grid.visible
  m.grid.visible = true
  buildMore(m.grid.itemFocused)
  if wasHidden and hadFocus then m.grid.setFocus(true)
end sub

' Build the next page of nodes when the viewer is near the end of what exists.
sub buildMore(focusIdx as integer)
  r = pagerNextRange(m.pager, focusIdx)
  if r <> invalid then
    nodes = []
    for i = r.start to r.start + r.count - 1
      nodes.push(nodesPoster(m.items[i], m.global.server))
    end for
    m.content.appendChildren(nodes)
    pagerMarkLoaded(m.pager, r.count)
  end if
  ' Server-side paging: ask for the next 56 when we are near the end of what has arrived.
  if m.source = "v1" and not m.fetching and m.items.count() < m.total then
    if focusIdx >= m.items.count() - m.theme.layout.pageLookahead then requestPage(m.items.count())
  end if
end sub

sub onFocused()
  idx = m.grid.itemFocused
  if idx < 0 then return
  buildMore(idx)
end sub

sub onItemSelected()
  idx = m.grid.itemSelected
  if idx >= 0 and idx < m.items.count() then m.top.selected = m.items[idx]
end sub

' ---- status states ---------------------------------------------------------------------
sub showBusy()
  m.status.title = "Loading..."
  m.status.message = ""
  m.status.busy = true
  m.status.buttons = []
  m.status.visible = true
  m.statusKind = "busy"
end sub

sub showError(resp as object)
  m.grid.visible = false
  m.status.busy = false
  m.status.title = "Couldn't load this list"
  m.status.message = playFriendlyError(resp.status, resp.code, resp.message)
  m.status.buttons = ["Try again", "Change server"]
  m.status.visible = true
  m.statusKind = "error"
  if m.top.isInFocusChain() then m.status.callFunc("focusMe")
end sub

sub onStatusButton()
  if m.statusKind <> "error" then return
  if m.status.selected = 0 then
    load()
  else
    navReplaceAll("SetupView", {})
  end if
end sub

function onKeyEvent(key as string, press as boolean) as boolean
  if not press then return false
  if key = "up" and m.grid.hasFocus() and m.grid.itemFocused < m.top.columns then
    m.top.exitUp = true
    return true
  else if key = "options" then
    m.top.optionsKey = true
    return true
  end if
  return false
end function
