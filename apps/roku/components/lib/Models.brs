' ============================================================================
' Models.brs - PURE trimming of server JSON into small records.
'
' Libraries can be big (1300+ shows, 2000+ films). The HTTP task runs these
' transforms on the task thread so only the few fields the UI needs ever cross
' to the render thread, and long overviews are cut. See README ("Paging").
' All server-relative poster paths are kept as-is; the view prefixes the
' server origin (urlAbsolute) when it builds a node.
' ============================================================================

function modelTransform(name as string, json as dynamic) as dynamic
  if json = invalid then return invalid
  if name = "v1movies" then return modelV1List(json, "movie")
  if name = "v1shows" then return modelV1List(json, "tv")
  if name = "movies" then return modelMovieList(json)
  if name = "shows" then return modelShowList(json)
  if name = "continue" then return modelContinue(json)
  if name = "recent" then return modelRecent(json)
  if name = "playlists" then return modelPlaylists(json)
  if name = "playlist" then return modelPlaylist(json)
  if name = "episodes" then return modelEpisodes(json)
  return json
end function

' True only for a record that is an AA and has a non-null `key`.
function modelHas(r as dynamic, key as string) as boolean
  if r = invalid then return false
  if type(r) <> "roAssociativeArray" then return false
  return r[key] <> invalid
end function

' /api/v1/library/movies and /tvshows (paged, see docs/PUBLIC-API.md). Same trimmed
' record shape as the legacy lists so the views do not care which one answered.
' total is the number of matches before paging.
function modelV1List(json as object, kind as string) as object
  items = []
  for each r in modelArr(json.items)
    if modelHas(r, "id") then
      rec = {
        kind: kind
        id: fmtStr(r.id, "")
        title: fmtStr(r.title, "Untitled")
        year: fmtInt(r.year, 0)
        poster: fmtStr(r.poster, "")
        backdrop: fmtStr(r.backdrop, "")
        rating: fmtNum(r.voteAverage, 0)
        quality: fmtStr(r.quality, "")
        overview: fmtTruncate(r.overview, 700)
        isNew: fmtIsTrue(r.isNew)
        episodeCount: fmtInt(r.episodeCount, 0)
        collection: ""
      }
      if modelHas(r, "collection") then rec.collection = fmtStr(r.collection.name, "")
      items.push(rec)
    end if
  end for
  return { ok: true, total: fmtInt(json.total, items.count()), offset: fmtInt(json.offset, 0), items: items }
end function

function modelArr(v as dynamic) as object
  if v <> invalid and type(v) = "roArray" then return v
  return []
end function

function modelGenres(json as object) as object
  out = []
  for each g in modelArr(json.genres)
    if modelHas(g, "id") then out.push({ id: fmtInt(g.id, 0), name: fmtStr(g.name, "?"), count: fmtInt(g.count, 0) })
  end for
  return out
end function

function modelMovieList(json as object) as object
  items = []
  for each r in modelArr(json.items)
    if modelHas(r, "id") then
      items.push({
        kind: "movie"
        id: fmtStr(r.id, "")
        title: fmtStr(r.title, "Untitled")
        year: fmtInt(r.year, 0)
        poster: fmtStr(r.poster, "")
        backdrop: fmtStr(r.backdrop, "")
        rating: fmtNum(r.voteAverage, 0)
        quality: fmtStr(r.quality, "")
        overview: fmtTruncate(r.overview, 700)
        isNew: fmtIsTrue(r.isNew)
        collection: fmtStr(r.collectionName, "")
      })
    end if
  end for
  return { ok: true, genres: modelGenres(json), items: items }
end function

function modelShowList(json as object) as object
  items = []
  for each r in modelArr(json.items)
    if modelHas(r, "key") then
      items.push({
        kind: "tv"
        id: fmtStr(r.key, "")
        title: fmtStr(r.name, "Untitled")
        year: fmtInt(r.year, 0)
        poster: fmtStr(r.poster, "")
        backdrop: fmtStr(r.backdrop, "")
        rating: fmtNum(r.voteAverage, 0)
        quality: fmtStr(r.quality, "")
        episodeCount: fmtInt(r.episodeCount, 0)
        isNew: fmtIsTrue(r.isNew)
        overview: ""
      })
    end if
  end for
  return { ok: true, genres: modelGenres(json), items: items }
end function

' /api/continue and /api/history rows. For tv, id is the EPISODE id.
function modelContinue(json as object) as object
  items = []
  for each r in modelArr(json.items)
    if modelHas(r, "id") then
      kind = "movie"
      if fmtStr(r.kind, "") = "tv" then kind = "tv"
      items.push({
        kind: kind
        id: fmtStr(r.id, "")
        title: fmtStr(r.title, "Untitled")
        poster: fmtStr(r.poster, "")
        currentTime: fmtNum(r.currentTime, 0)
        duration: fmtNum(r.duration, 0)
        percent: fmtPercent(r.percent)
        upNext: fmtIsTrue(r.upNext)
        watched: fmtIsTrue(r.watched)
      })
    end if
  end for
  return { ok: true, items: items }
end function

' /api/recently-added: tv rows point at a whole show (showKey), not an episode.
function modelRecent(json as object) as object
  items = []
  for each r in modelArr(json.items)
    if modelHas(r, "id") then
      kind = "movie"
      if fmtStr(r.kind, "") = "tv" then kind = "tv"
      items.push({
        kind: kind
        id: fmtStr(r.id, "")
        title: fmtStr(r.title, "Untitled")
        poster: fmtStr(r.poster, "")
        backdrop: ""
        overview: ""
        year: 0
        rating: 0
        episodeCount: 0
      })
    end if
  end for
  return { ok: true, items: items }
end function

function modelPlaylists(json as object) as object
  items = []
  for each p in modelArr(json.playlists)
    if modelHas(p, "id") then
      items.push({ id: fmtStr(p.id, ""), name: fmtStr(p.name, "Playlist"), count: fmtInt(p.itemCount, -1), smart: fmtIsTrue(p.smart) })
    end if
  end for
  return { ok: true, playlists: items }
end function

' One playlist. Music tracks (kind "track") are dropped: this channel plays
' video only. Entries no longer in the library (available=false) are dropped.
function modelPlaylist(json as object) as object
  items = []
  for each r in modelArr(json.items)
    if modelHas(r, "id") and not fmtIsFalse(r.available) then
      k = fmtStr(r.kind, "")
      if k = "movie" or k = "tv" then
        title = fmtStr(r.title, "Untitled")
        if k = "tv" and fmtStr(r.showName, "") <> "" then title = fmtStr(r.showName, "") + "  -  " + title
        items.push({
          kind: k
          id: fmtStr(r.id, "")
          title: title
          poster: fmtStr(r.poster, "")
          percent: fmtPercent(r.percent)
          resumeSeconds: fmtNum(r.resumeSeconds, 0)
          watched: fmtIsTrue(r.watched)
        })
      end if
    end if
  end for
  name = "Playlist"
  if json.playlist <> invalid then name = fmtStr(json.playlist.name, "Playlist")
  return { ok: true, name: name, items: items }
end function

' /api/tvshows/<key>/episodes
function modelEpisodes(json as object) as object
  show = { key: "", name: "", poster: "", overview: "" }
  if json.show <> invalid then
    show.key = fmtStr(json.show.key, "")
    show.name = fmtStr(json.show.name, "")
    show.poster = fmtStr(json.show.poster, "")
    show.overview = fmtTruncate(json.show.overview, 900)
  end if
  seasons = []
  for each s in modelArr(json.seasons)
    if s <> invalid then
      eps = []
      for each e in modelArr(s.episodes)
        if modelHas(e, "id") then
          eps.push({
            id: fmtStr(e.id, "")
            season: fmtNum(e.season, invalid)
            episode: fmtNum(e.episode, invalid)
            title: fmtStr(e.title, "Episode")
            episodeName: fmtStr(e.episodeName, "")
            watched: fmtIsTrue(e.watched)
            percent: fmtPercent(e.watchedPercent)
          })
        end if
      end for
      seasons.push({ season: fmtNum(s.season, invalid), episodes: eps })
    end if
  end for
  return { ok: true, show: show, seasons: seasons }
end function
