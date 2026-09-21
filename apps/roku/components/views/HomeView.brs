sub init()
  baseInit()
  L = m.theme.layout
  m.brand = m.top.findNode("brand")
  m.user = m.top.findNode("user")
  m.tabs = m.top.findNode("tabs")
  m.rows = m.top.findNode("rows")
  m.movies = m.top.findNode("movies")
  m.shows = m.top.findNode("shows")
  m.status = m.top.findNode("status")
  m.tabTimer = m.top.findNode("tabTimer")

  themeLabel(m.brand, "heading", "accent")
  themeLabel(m.user, "caption", "textFaint")
  m.brand.text = "Beebo"
  m.brand.translation = [L.marginX, L.tabBarY + 14]
  m.user.width = 500
  m.user.horizAlign = "right"
  m.user.translation = [L.screenWidth - L.marginX - 500, L.tabBarY + 26]

  m.tabNames = ["Home", "Movies", "TV Shows", "Playlists", "Search", "Settings"]
  m.tabs.translation = [L.marginX + 190, L.tabBarY]
  m.tabs.buttons = m.tabNames
  m.tabs.observeField("moved", "onTabMoved")
  m.tabs.observeField("selected", "onTabSelected")
  m.tabTimer.observeField("fire", "onTabTimer")

  ' Home rows. NOTE: RowList geometry is set here and has not been checked on a device;
  ' if a row looks off, adjust these numbers (all sizes come from Theme.brs).
  m.rows.translation = [L.marginX, 150]
  m.rows.itemSize = [L.screenWidth - 2 * L.marginX, L.cellHeight + 48]
  m.rows.rowItemSize = [[L.cellWidth, L.cellHeight], [L.cellWidth, L.cellHeight]]
  m.rows.rowItemSpacing = [[L.gridSpacingX, 0], [L.gridSpacingX, 0]]
  m.rows.itemSpacing = [0, 0]
  m.rows.numRows = 2
  m.rows.showRowLabel = [true, true]
  m.rows.rowLabelOffset = [[0, 8], [0, 8]]
  m.rows.focusBitmapUri = themeFocusRing()
  m.rows.rowFocusAnimationStyle = "floatingFocus"
  m.rows.rowLabelColor = m.theme.color.text
  m.rows.observeField("rowItemSelected", "onRowSelected")

  m.movies.translation = [L.marginX, L.contentY]
  m.movies.title = "Movies"
  m.movies.hint = "Press * to sort"
  m.movies.emptyText = "No movies found in your library yet."
  m.movies.observeField("selected", "onMovieSelected")
  m.movies.observeField("exitUp", "onExitUp")
  m.movies.observeField("optionsKey", "onMoviesOptions")
  m.movies.observeField("navigate", "onChildNavigate")

  m.shows.translation = [L.marginX, L.contentY]
  m.shows.title = "TV Shows"
  m.shows.emptyText = "No TV shows found in your library yet."
  m.shows.observeField("selected", "onShowSelected")
  m.shows.observeField("exitUp", "onExitUp")
  m.shows.observeField("navigate", "onChildNavigate")

  m.status.translation = [L.marginX, L.contentY + 30]
  m.status.observeField("selected", "onStatusButton")

  m.tab = 0
  m.pendingTab = 0
  m.rowRecords = []
  m.loadedHome = false
  m.moviesLoaded = false
  m.showsLoaded = false
  m.homeReq = 0
  m.homeState = invalid
  m.showHomeStatus = false
  m.contentFocused = false
  m.statusKind = ""
end sub

sub onParams()
  m.user.text = ""
  if fmtStr(m.global.userName, "") <> "" then m.user.text = "Signed in as " + m.global.userName
  showTab(0)
  m.tabs.callFunc("focusMe")
end sub

' Called by the scene when this view becomes the top view again.
sub focusMe()
  if m.loadedHome and m.tab = 0 then loadHome() ' pick up progress made while watching
  focusContentOrTabs()
end sub

sub focusContentOrTabs()
  if m.contentFocused = true then
    focusContent()
  else
    m.tabs.callFunc("focusMe")
  end if
end sub

' ---- tabs ----------------------------------------------------------------------------
sub onTabMoved()
  idx = m.tabs.moved
  if idx <= 2 then
    m.pendingTab = idx
    m.tabTimer.control = "stop"
    m.tabTimer.control = "start"
  end if
end sub

sub onTabTimer()
  showTab(m.pendingTab)
end sub

sub onTabSelected()
  idx = m.tabs.selected
  if idx <= 2 then
    m.tabTimer.control = "stop"
    showTab(idx)
    focusContent()
  else if idx = 3 then
    navPush("PlaylistsView", {})
  else if idx = 4 then
    navPush("SearchView", {})
  else if idx = 5 then
    navPush("SettingsView", {})
  end if
end sub

sub showTab(idx as integer)
  m.tab = idx
  m.tabs.current = idx
  m.rows.visible = idx = 0
  m.movies.visible = idx = 1
  m.shows.visible = idx = 2
  if idx = 0 then
    if not m.loadedHome then loadHome()
    m.status.visible = m.showHomeStatus = true
  else
    m.status.visible = false
  end if
  if idx = 1 and not m.moviesLoaded then
    m.moviesLoaded = true
    m.movies.callFunc("load")
  end if
  if idx = 2 and not m.showsLoaded then
    m.showsLoaded = true
    m.shows.callFunc("load")
  end if
end sub

sub focusContent()
  m.contentFocused = true
  if m.tab = 0 then
    if m.rows.visible and m.rowRecords.count() > 0 then
      m.rows.setFocus(true)
    else if m.status.visible then
      m.status.callFunc("focusMe")
    else
      m.contentFocused = false
    end if
  else if m.tab = 1 then
    m.movies.callFunc("focusMe")
  else if m.tab = 2 then
    m.shows.callFunc("focusMe")
  end if
end sub

' ---- Home tab: Continue Watching + Recently Added ---------------------------------------
sub loadHome()
  m.homeReq = m.homeReq + 1
  m.homeState = { req: m.homeReq, continue: invalid, recent: invalid, pending: 2, failed: invalid }
  if not m.loadedHome then showHomeBusy()
  apiGet("/api/continue", { transform: "continue" }, onHomePart, { req: m.homeReq, part: "continue" })
  apiGet("/api/recently-added", { transform: "recent" }, onHomePart, { req: m.homeReq, part: "recent" })
end sub

sub onHomePart(resp as object, ctx as dynamic)
  st = m.homeState
  if st = invalid then return
  if ctx.req <> st.req then return
  st.pending = st.pending - 1
  if resp.ok then
    st[ctx.part] = resp.data.items
  else if st.failed = invalid then
    st.failed = resp
  end if
  if st.pending > 0 then return
  renderHome(st)
end sub

sub renderHome(st as object)
  m.loadedHome = true
  cont = st.continue
  recent = st.recent
  if cont = invalid then cont = []
  if recent = invalid then recent = []
  ' Everything failed: say so, with a way out.
  if st.failed <> invalid and st.continue = invalid and st.recent = invalid then
    m.rows.visible = false
    m.rowRecords = []
    showHomeStatus("Can't reach your Beebo", playFriendlyError(st.failed.status, st.failed.code, st.failed.message), ["Try again", "Change server"], "error")
    return
  end if

  root = CreateObject("roSGNode", "ContentNode")
  records = []
  if cont.count() > 0 then
    row = root.createChild("ContentNode")
    row.title = "Continue Watching"
    for each rec in cont
      row.appendChild(nodesPoster(rec, m.global.server))
    end for
    records.push(cont)
  end if
  if recent.count() > 0 then
    row = root.createChild("ContentNode")
    row.title = "Recently Added"
    for each rec in recent
      row.appendChild(nodesPoster(rec, m.global.server))
    end for
    records.push(recent)
  end if
  m.rowRecords = records

  if records.count() = 0 then
    m.rows.visible = false
    showHomeStatus("Nothing to continue yet", "Pick something from Movies or TV Shows. What you start watching will show up here, ready to resume.", [], "empty")
    return
  end if
  m.showHomeStatus = false
  m.status.visible = false
  focusedRow = m.rows.rowItemFocused
  m.rows.content = root
  m.rows.visible = m.tab = 0
  if focusedRow <> invalid and focusedRow.count() = 2 then
    if focusedRow[0] < records.count() then
      if focusedRow[1] < records[focusedRow[0]].count() then m.rows.jumpToRowItem = focusedRow
    end if
  end if
  if m.contentFocused = true and m.tab = 0 then m.rows.setFocus(true)
end sub

sub showHomeBusy()
  m.status.busy = true
  m.status.title = "Loading..."
  m.status.message = ""
  m.status.buttons = []
  m.showHomeStatus = true
  m.status.visible = m.tab = 0
  m.statusKind = "busy"
end sub

sub showHomeStatus(title as string, message as string, buttons as object, kind as string)
  m.status.busy = false
  m.status.title = title
  m.status.message = message
  m.status.buttons = buttons
  m.showHomeStatus = true
  m.status.visible = m.tab = 0
  m.statusKind = kind
  if m.contentFocused = true and m.tab = 0 then m.status.callFunc("focusMe")
end sub

sub onStatusButton()
  if m.statusKind <> "error" then return
  if m.status.selected = 0 then
    m.loadedHome = false
    loadHome()
  else
    navReplaceAll("SetupView", {})
  end if
end sub

sub onRowSelected()
  sel = m.rows.rowItemSelected
  if sel = invalid then return
  r = sel[0]
  c = sel[1]
  if r >= m.rowRecords.count() then return
  if c >= m.rowRecords[r].count() then return
  rec = m.rowRecords[r][c]
  openRecord(rec)
end sub

' A Continue Watching item plays straight away (resuming); anything else opens its page.
sub openRecord(rec as object)
  if rec.currentTime <> invalid then
    navPush("PlayerView", { kind: rec.kind, id: rec.id, title: rec.title, resumeSeconds: playResumeSeconds(rec, 0, rec.duration) })
  else
    navPush("DetailView", { kind: rec.kind, item: rec })
  end if
end sub

' ---- grids ------------------------------------------------------------------------------
sub onMovieSelected()
  navPush("DetailView", { kind: "movie", item: m.movies.selected })
end sub

sub onShowSelected()
  navPush("DetailView", { kind: "tv", item: m.shows.selected })
end sub

sub onExitUp()
  m.contentFocused = false
  m.tabs.callFunc("focusMe")
end sub

sub onChildNavigate(event as object)
  m.top.navigate = event.getData()
end sub

sub onMoviesOptions()
  picker = CreateObject("roSGNode", "PickerDialog")
  picker.title = "Sort movies by"
  picker.options = ["A to Z", "Newest added", "Year (newest first)"]
  keys = ["title", "new", "year"]
  cur = 0
  for i = 0 to keys.count() - 1
    if keys[i] = m.movies.sort then cur = i
  end for
  picker.selectedIndex = cur
  picker.observeField("chosen", "onSortChosen")
  m.picker = picker
  m.top.appendChild(picker)
  picker.callFunc("focusMe")
end sub

sub onSortChosen(event as object)
  idx = event.getData()
  m.top.removeChild(m.picker)
  m.picker = invalid
  keys = ["title", "new", "year"]
  if idx >= 0 and idx < keys.count() then
    if keys[idx] <> m.movies.sort then
      m.movies.sort = keys[idx]
      m.movies.callFunc("load")
    end if
  end if
  m.movies.callFunc("focusMe")
end sub

function onKeyEvent(key as string, press as boolean) as boolean
  if not press then return false
  if key = "down" and m.tabs.isInFocusChain() then
    if m.tab <= 2 and m.tabs.index <= 2 then
      m.tabTimer.control = "stop"
      showTab(m.tabs.index)
      focusContent()
      return true
    end if
  else if key = "back" and m.contentFocused = true then
    m.contentFocused = false
    m.tabs.callFunc("focusMe")
    return true
  else if key = "up" and m.rows.isInFocusChain() then
    ' Up from the first row goes back to the tabs
    focused = m.rows.rowItemFocused
    if focused <> invalid and focused[0] = 0 then
      m.contentFocused = false
      m.tabs.callFunc("focusMe")
      return true
    end if
  end if
  return false
end function
