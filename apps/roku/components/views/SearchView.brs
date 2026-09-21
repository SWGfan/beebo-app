sub init()
  baseInit()
  L = m.theme.layout
  m.title = m.top.findNode("title")
  m.hint = m.top.findNode("hint")
  m.keyboard = m.top.findNode("keyboard")
  m.results = m.top.findNode("results")
  m.debounce = m.top.findNode("debounce")
  themeLabel(m.title, "title", "text")
  themeLabel(m.hint, "label", "textFaint")
  m.title.text = "Search"
  m.title.translation = [L.marginX, L.marginY]
  m.keyboard.translation = [L.marginX, 190]
  ' Voice entry on remotes with a microphone (harmless where unsupported).
  m.keyboard.textEditBox.voiceEnabled = true
  m.hint.translation = [L.marginX, 560]
  m.hint.width = 680
  m.hint.text = "Type a title, or hold the microphone button on your remote and say it. Results appear as you type."
  m.results.translation = [L.marginX + 760, 170]
  m.results.title = "Results"
  m.results.emptyText = "Type at least two letters."
  m.results.observeField("selected", "onResultSelected")
  m.results.observeField("navigate", "onChildNavigate")
  m.keyboard.observeField("text", "onText")
  m.debounce.observeField("fire", "onDebounce")
  m.gen = 0
  m.movies = invalid
  m.shows = invalid
  m.pending = 0
  m.query = ""
end sub

sub onParams()
  m.results.callFunc("setItems", [])
  focusMe()
end sub

sub focusMe()
  m.keyboard.setFocus(true)
end sub

sub onText()
  m.debounce.control = "stop"
  m.debounce.control = "start"
end sub

sub onDebounce()
  q = m.keyboard.text.trim()
  if q = m.query then return
  m.query = q
  runSearch(q)
end sub

sub runSearch(q as string)
  apiCancelAll()
  m.gen = m.gen + 1
  if Len(q) < 2 then
    m.results.emptyText = "Type at least two letters."
    m.results.callFunc("setItems", [])
    return
  end if
  m.movies = invalid
  m.shows = invalid
  m.failed = invalid
  m.pending = 2
  m.results.title = "Results for " + Chr(34) + q + Chr(34)
  searchKind("movie", q, false)
  searchKind("tv", q, false)
end sub

sub searchKind(kind as string, q as string, legacy as boolean)
  ctx = { gen: m.gen, kind: kind, q: q }
  if legacy then
    if kind = "movie" then
      apiGet(urlWithQuery("/api/movies", { q: q }), { transform: "movies", timeoutMs: 45000 }, onSearchLegacy, ctx)
    else
      apiGet(urlWithQuery("/api/tvshows", { q: q }), { transform: "shows", timeoutMs: 45000 }, onSearchLegacy, ctx)
    end if
  else
    if kind = "movie" then
      apiGet(urlWithQuery("/api/v1/library/movies", { q: q, limit: 40 }), { transform: "v1movies", timeoutMs: 30000 }, onSearchDone, ctx)
    else
      apiGet(urlWithQuery("/api/v1/library/tvshows", { q: q, limit: 40 }), { transform: "v1shows", timeoutMs: 30000 }, onSearchDone, ctx)
    end if
  end if
end sub

sub onSearchDone(resp as object, ctx as dynamic)
  if ctx.gen <> m.gen then return
  if not resp.ok and (resp.status = 404 or resp.status = 403 or resp.status = 405) then
    searchKind(ctx.kind, ctx.q, true) ' older server: the unpaged route
    return
  end if
  collect(resp, ctx)
end sub

sub onSearchLegacy(resp as object, ctx as dynamic)
  if ctx.gen <> m.gen then return
  collect(resp, ctx)
end sub

sub collect(resp as object, ctx as dynamic)
  items = []
  if resp.ok then
    items = resp.data.items
  else
    m.failed = resp
  end if
  if ctx.kind = "movie" then m.movies = items else m.shows = items
  m.pending = m.pending - 1
  if m.pending > 0 then return
  all = []
  for each r in m.movies
    all.push(r)
  end for
  for each r in m.shows
    all.push(r)
  end for
  if all.count() = 0 and m.failed <> invalid then
    m.results.emptyText = "Search isn't working right now. " + playFriendlyError(m.failed.status, m.failed.code, m.failed.message)
  else
    m.results.emptyText = "Nothing matched " + Chr(34) + m.query + Chr(34) + "."
  end if
  m.results.callFunc("setItems", all)
end sub

sub onResultSelected()
  rec = m.results.selected
  navPush("DetailView", { kind: rec.kind, item: rec })
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
  else if key = "right" and m.keyboard.isInFocusChain() then
    m.results.callFunc("focusMe")
    return true
  else if key = "left" and m.results.isInFocusChain() then
    m.keyboard.setFocus(true)
    return true
  end if
  return false
end function
