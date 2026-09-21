sub init()
  baseInit()
  L = m.theme.layout
  C = m.theme.color
  m.backdrop = m.top.findNode("backdrop")
  m.veil = m.top.findNode("veil")
  m.poster = m.top.findNode("poster")
  m.title = m.top.findNode("title")
  m.meta = m.top.findNode("meta")
  m.overview = m.top.findNode("overview")
  m.buttons = m.top.findNode("buttons")
  m.seasonsHeader = m.top.findNode("seasonsHeader")
  m.seasons = m.top.findNode("seasons")
  m.episodes = m.top.findNode("episodes")
  m.status = m.top.findNode("status")
  m.busyNote = m.top.findNode("busyNote")

  m.backdrop.translation = [0, 0]
  m.backdrop.width = L.screenWidth
  m.backdrop.height = L.screenHeight
  m.backdrop.loadWidth = 960
  m.backdrop.loadHeight = 540
  m.backdrop.opacity = 0.55
  m.veil.translation = [0, 0]
  m.veil.width = L.screenWidth
  m.veil.height = L.screenHeight
  m.veil.color = "0x0B0F14C8"

  m.poster.translation = [L.marginX, 90]
  m.poster.width = 300
  m.poster.height = 450
  m.poster.loadWidth = 300
  m.poster.loadHeight = 450
  m.poster.failedBitmapUri = themePosterMissing()

  themeLabel(m.title, "title", "text")
  themeLabel(m.meta, "label", "accent")
  themeLabel(m.overview, "body", "textDim")
  themeLabel(m.seasonsHeader, "label", "textFaint")
  themeLabel(m.busyNote, "label", "textFaint")
  textX = L.marginX + 300 + 48
  textW = L.screenWidth - textX - L.marginX
  m.title.translation = [textX, 80]
  m.title.width = textW
  m.meta.translation = [textX, 200]
  m.meta.width = textW
  m.overview.translation = [textX, 250]
  m.overview.width = textW
  m.overview.height = 230
  m.buttons.translation = [textX, 500]
  m.busyNote.translation = [textX, 580]
  m.busyNote.width = textW

  m.seasonsHeader.translation = [L.marginX, 585]
  m.seasonsHeader.text = "SEASONS"
  m.seasons.translation = [L.marginX, 620]
  m.seasons.itemSize = [360, 60]
  m.seasons.numRows = 6
  m.seasons.color = C.textDim
  m.seasons.focusedColor = C.accent
  m.seasons.focusBitmapUri = themeFocusRing()
  m.episodes.translation = [L.marginX + 400, 620]
  m.episodes.itemSize = [L.screenWidth - 2 * L.marginX - 400, 60]
  m.episodes.numRows = 6
  m.episodes.color = C.text
  m.episodes.focusedColor = C.accent
  m.episodes.focusBitmapUri = themeFocusRing()
  m.status.translation = [L.marginX, 620]

  m.buttons.observeField("selected", "onButton")
  m.seasons.observeField("itemFocused", "onSeasonFocused")
  m.seasons.observeField("itemSelected", "onSeasonSelected")
  m.episodes.observeField("itemSelected", "onEpisodeSelected")
  m.status.observeField("selected", "onStatusButton")

  m.kind = "movie"
  m.item = {}
  m.info = invalid
  m.continueRec = invalid
  m.episodesData = invalid
  m.seasonIdx = 0
  m.audioIndex = invalid
  m.subtitle = invalid
  m.buttonKinds = []
  m.nextEp = invalid
  m.gen = 0
  m.loadedOnce = false
  m.buttonKey = ""
  m.statusIsError = false
  m.continueItems = []
  m.metaParts = []
  m.picker = invalid
  m.returning = false
end sub

sub onParams()
  p = m.top.params
  m.kind = fmtStr(p.kind, "movie")
  m.item = p.item
  if m.item = invalid then
    navPop()
    return
  end if
  showItem()
  loadAll()
end sub

' Returning from the player: pick up the new resume position.
sub focusMe()
  ' Coming back from the player: pick up the new resume position.
  if m.returning = true then
    m.returning = false
    refreshProgress()
  end if
  m.buttons.callFunc("focusMe")
end sub

sub showItem()
  it = m.item
  m.title.text = fmtStr(it.title, "")
  m.overview.text = fmtStr(it.overview, "")
  parts = []
  if fmtInt(it.year, 0) > 0 then parts.push(Str(it.year).trim())
  if m.kind = "tv" and fmtInt(it.episodeCount, 0) > 0 then parts.push(Str(it.episodeCount).trim() + " episodes")
  r = fmtRating(it.rating)
  if r <> "" then parts.push(r)
  if fmtStr(it.quality, "") <> "" then parts.push(it.quality)
  if fmtStr(it.collection, "") <> "" then parts.push(it.collection)
  m.metaParts = parts
  m.meta.text = fmtJoin(parts)
  m.poster.uri = imageUrl(it.poster)
  bd = imageUrl(it.backdrop)
  if bd = "" then bd = imageUrl(it.poster)
  m.backdrop.uri = bd
  refreshButtons()
end sub

' ---- loading --------------------------------------------------------------------------
sub loadAll()
  m.gen = m.gen + 1
  m.loadedOnce = true
  if m.kind = "movie" then
    apiGet("/api/playback/info?kind=movie&id=" + urlEncode(m.item.id), { timeoutMs: 40000 }, onInfo, { gen: m.gen })
    apiGet("/api/continue", { transform: "continue" }, onContinue, { gen: m.gen })
    if fmtStr(m.item.overview, "") = "" then
      apiGet(urlWithQuery("/api/v1/library/movies", { q: m.item.title, limit: 10 }), { transform: "v1movies" }, onEnrich, { gen: m.gen })
    end if
  else
    loadEpisodes()
    apiGet("/api/continue", { transform: "continue" }, onContinue, { gen: m.gen })
    apiGet(urlWithQuery("/api/v1/library/tvshows", { q: m.item.title, limit: 10 }), { transform: "v1shows" }, onEnrich, { gen: m.gen })
  end if
end sub

sub loadEpisodes()
  m.status.busy = true
  m.status.title = "Loading episodes..."
  m.status.message = ""
  m.status.buttons = []
  m.status.visible = true
  m.seasons.visible = false
  m.episodes.visible = false
  m.seasonsHeader.visible = false
  apiGet("/api/tvshows/" + urlEncode(m.item.id) + "/episodes", { transform: "episodes", timeoutMs: 60000 }, onEpisodes, { gen: m.gen })
end sub

sub refreshProgress()
  apiGet("/api/continue", { transform: "continue" }, onContinue, { gen: m.gen })
  if m.kind = "tv" then
    apiGet("/api/tvshows/" + urlEncode(m.item.id) + "/episodes", { transform: "episodes", timeoutMs: 60000 }, onEpisodes, { gen: m.gen, quiet: true })
  end if
end sub

sub onInfo(resp as object, ctx as dynamic)
  if ctx.gen <> m.gen then return
  if resp.ok then
    m.info = resp.data
    dur = fmtNum(m.info.durationSec, 0)
    parts = []
    rt = fmtDuration(dur)
    if rt <> "" then parts.push(rt)
    for each p in m.metaParts
      parts.push(p)
    end for
    m.meta.text = fmtJoin(parts)
  end if
  refreshButtons()
end sub

sub onContinue(resp as object, ctx as dynamic)
  if ctx.gen <> m.gen then return
  m.continueItems = []
  if resp.ok then m.continueItems = resp.data.items
  m.continueRec = invalid
  if m.kind = "movie" then
    for each r in m.continueItems
      if r.kind = "movie" and r.id = m.item.id then m.continueRec = r
    end for
  end if
  refreshButtons()
end sub

sub onEnrich(resp as object, ctx as dynamic)
  if ctx.gen <> m.gen then return
  if not resp.ok then return
  for each r in resp.data.items
    if r.id = m.item.id then
      if fmtStr(m.item.overview, "") = "" and fmtStr(r.overview, "") <> "" then m.item.overview = r.overview
      if fmtStr(m.item.backdrop, "") = "" then m.item.backdrop = r.backdrop
      if fmtInt(m.item.year, 0) = 0 then m.item.year = r.year
      if fmtNum(m.item.rating, 0) = 0 then m.item.rating = r.rating
      if fmtStr(m.item.quality, "") = "" then m.item.quality = r.quality
      showItem()
      return
    end if
  end for
end sub

sub onEpisodes(resp as object, ctx as dynamic)
  if ctx.gen <> m.gen then return
  if not resp.ok then
    m.status.busy = false
    m.status.title = "Couldn't load the episodes"
    m.status.message = playFriendlyError(resp.status, resp.code, resp.message)
    m.status.buttons = ["Try again"]
    m.status.visible = true
    m.statusIsError = true
    return
  end if
  m.statusIsError = false
  m.episodesData = resp.data
  if fmtStr(m.episodesData.show.overview, "") <> "" and fmtStr(m.item.overview, "") = "" then
    m.item.overview = m.episodesData.show.overview
    m.overview.text = m.item.overview
  end if
  m.status.visible = false
  m.seasonsHeader.visible = true
  m.seasons.visible = true
  m.episodes.visible = true
  titles = []
  for each s in m.episodesData.seasons
    titles.push(fmtSeasonLabel(s.season))
  end for
  ' Keep the viewer's place when this is a refresh.
  keep = m.seasonIdx
  m.seasons.content = nodesTitles(titles)
  if keep >= titles.count() then keep = 0
  if not fmtIsTrue(ctx.quiet) then keep = pickInitialSeason()
  m.seasonIdx = keep
  m.seasons.jumpToItem = keep
  fillEpisodes(keep)
  refreshButtons()
end sub

' The season holding the episode the viewer should watch next.
function pickInitialSeason() as integer
  nx = findNextEpisode()
  if nx <> invalid then return nx.seasonIdx
  return 0
end function

' The episode to offer: one in progress, else the first unwatched, else the first.
function findNextEpisode() as dynamic
  if m.episodesData = invalid then return invalid
  firstUnwatched = invalid
  first = invalid
  si = 0
  for each s in m.episodesData.seasons
    ei = 0
    for each e in s.episodes
      hit = { seasonIdx: si, epIdx: ei, ep: e, resume: false }
      if first = invalid then first = hit
      if not e.watched and e.percent >= 2 and e.percent < 95 then
        hit.resume = true
        return hit
      end if
      if not e.watched and firstUnwatched = invalid then firstUnwatched = hit
      ei = ei + 1
    end for
    si = si + 1
  end for
  if firstUnwatched <> invalid then return firstUnwatched
  return first
end function

sub fillEpisodes(seasonIdx as integer)
  if m.episodesData = invalid then return
  if seasonIdx < 0 or seasonIdx >= m.episodesData.seasons.count() then return
  titles = []
  for each e in m.episodesData.seasons[seasonIdx].episodes
    t = e.title
    if e.watched then
      t = t + "     watched"
    else if e.percent >= 2 and e.percent < 95 then
      t = t + "     " + Str(e.percent).trim() + "%"
    end if
    titles.push(t)
  end for
  m.episodes.content = nodesTitles(titles)
end sub

sub onSeasonFocused()
  idx = m.seasons.itemFocused
  if idx < 0 or idx = m.seasonIdx and m.episodes.content <> invalid then return
  m.seasonIdx = idx
  fillEpisodes(idx)
end sub

sub onSeasonSelected()
  m.episodes.setFocus(true)
end sub

sub onEpisodeSelected()
  if m.episodesData = invalid then return
  eps = m.episodesData.seasons[m.seasonIdx].episodes
  idx = m.episodes.itemSelected
  if idx < 0 or idx >= eps.count() then return
  playEpisode(eps[idx], false)
end sub

sub onStatusButton()
  if m.statusIsError = true then loadEpisodes()
end sub

' ---- buttons ----------------------------------------------------------------------------
sub refreshButtons()
  labels = []
  kinds = []
  if m.kind = "movie" then
    resume = currentResume()
    if resume > 0 then
      labels.push("Resume  " + fmtClock(resume))
      kinds.push("resume")
      labels.push("Start over")
      kinds.push("start")
    else
      labels.push("Play")
      kinds.push("start")
    end if
    if m.info <> invalid then
      labels.push("Audio and subtitles")
      kinds.push("options")
    end if
  else
    nx = findNextEpisode()
    m.nextEp = nx
    if nx <> invalid then
      tag = episodeTag(nx.ep)
      if nx.resume then
        labels.push("Resume  " + tag)
      else
        labels.push("Play  " + tag)
      end if
      kinds.push("next")
    end if
  end if
  m.buttonKinds = kinds
  key = ""
  for each l in labels
    key = key + "|" + l
  end for
  if key <> m.buttonKey then
    m.buttonKey = key
    m.buttons.buttons = labels
  end if
end sub

' "S1E3" from a trimmed episode record (falls back to its title).
function episodeTag(ep as object) as string
  if fmtIsNumber(ep.season) and fmtIsNumber(ep.episode) then return "S" + Str(ep.season).trim() + "E" + Str(ep.episode).trim()
  return "episode"
end function

function currentResume() as integer
  dur = 0
  if m.info <> invalid then dur = fmtNum(m.info.durationSec, 0)
  return playResumeSeconds(m.continueRec, 0, dur)
end function

sub onButton()
  idx = m.buttons.selected
  if idx < 0 or idx >= m.buttonKinds.count() then return
  kind = m.buttonKinds[idx]
  if kind = "resume" then
    startMovie(currentResume())
  else if kind = "start" then
    startMovie(0)
  else if kind = "options" then
    chooseAudio()
  else if kind = "next" then
    if m.nextEp <> invalid then playEpisode(m.nextEp.ep, m.nextEp.resume)
  end if
end sub

sub startMovie(resumeSeconds as integer)
  launch("movie", m.item.id, m.item.title, resumeSeconds)
end sub

sub playEpisode(ep as object, resume as boolean)
  seconds = 0
  ' Continue Watching knows the exact second for the episode it lists.
  if m.continueItems <> invalid then
    for each r in m.continueItems
      if r.kind = "tv" and r.id = ep.id then seconds = playResumeSeconds(r, ep.percent, r.duration)
    end for
  end if
  title = m.item.title + "  " + episodeTag(ep)
  launch("tv", ep.id, title, seconds)
end sub

sub launch(kind as string, id as string, title as string, resumeSeconds as integer)
  p = { kind: kind, id: id, title: title, resumeSeconds: resumeSeconds }
  if m.audioIndex <> invalid then p.audio = m.audioIndex
  if m.subtitle <> invalid then p.subtitle = m.subtitle
  m.returning = true
  navPush("PlayerView", p)
end sub

' ---- audio and subtitle choice (movies) -----------------------------------------------------
sub chooseAudio()
  audio = playAudioOptions(m.info)
  if audio.count() < 2 then
    chooseSubtitle()
    return
  end if
  titles = []
  cur = 0
  for i = 0 to audio.count() - 1
    titles.push(audio[i].title)
    if m.audioIndex <> invalid and audio[i].streamIndex = m.audioIndex then cur = i
  end for
  m.audioChoices = audio
  openPicker("Audio", titles, cur, "onAudioChosen")
end sub

sub onAudioChosen(event as object)
  idx = closePicker(event)
  if idx >= 0 and idx < m.audioChoices.count() then m.audioIndex = m.audioChoices[idx].streamIndex
  chooseSubtitle()
end sub

sub chooseSubtitle()
  subs = playSubtitleOptions(m.info)
  if subs.count() = 0 then
    showMessage("Subtitles", "This video has no text subtitles that can be shown on Roku.", "focusMe")
    return
  end if
  titles = ["Off"]
  cur = 0
  for i = 0 to subs.count() - 1
    titles.push(subs[i].title)
    if m.subtitle <> invalid and subs[i].url = m.subtitle.url then cur = i + 1
  end for
  m.subChoices = subs
  openPicker("Subtitles", titles, cur, "onSubtitleChosen")
end sub

sub onSubtitleChosen(event as object)
  idx = closePicker(event)
  if idx = 0 then
    m.subtitle = invalid
  else if idx > 0 and idx <= m.subChoices.count() then
    m.subtitle = m.subChoices[idx - 1]
  end if
  m.buttons.callFunc("focusMe")
end sub

sub openPicker(title as string, options as object, selected as integer, handler as string)
  picker = CreateObject("roSGNode", "PickerDialog")
  picker.title = title
  picker.options = options
  picker.selectedIndex = selected
  picker.observeField("chosen", handler)
  m.picker = picker
  m.top.appendChild(picker)
  picker.callFunc("focusMe")
end sub

function closePicker(event as object) as integer
  idx = event.getData()
  if m.picker <> invalid then
    m.picker.unobserveField("chosen")
    m.top.removeChild(m.picker)
    m.picker = invalid
  end if
  return idx
end function

function onKeyEvent(key as string, press as boolean) as boolean
  if not press then return false
  if key = "back" then
    if m.episodes.hasFocus() then
      m.seasons.setFocus(true)
      return true
    else if m.seasons.hasFocus() then
      m.buttons.callFunc("focusMe")
      return true
    end if
    apiCancelAll()
    navPop()
    return true
  else if key = "down" and m.buttons.isInFocusChain() then
    if m.kind = "tv" and m.seasons.visible then
      m.seasons.setFocus(true)
      return true
    end if
  else if key = "up" and (m.seasons.hasFocus() or m.episodes.hasFocus()) then
    m.buttons.callFunc("focusMe")
    return true
  else if key = "right" and m.seasons.hasFocus() then
    m.episodes.setFocus(true)
    return true
  else if key = "left" and m.episodes.hasFocus() then
    m.seasons.setFocus(true)
    return true
  end if
  return false
end function
