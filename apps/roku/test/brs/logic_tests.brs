' ============================================================================
' Pure-logic tests for the Roku channel, run under the `brs` BrightScript
' interpreter by test/logic.test.mjs (npm test). They exercise the REAL lib
' files in components/lib (not copies). Output: one line per check,
' "PASS name" or "FAIL name | got | want", then "DONE passed=N failed=M".
' ============================================================================

sub main()
  m.passed = 0
  m.failed = 0
  testUrls()
  testFormat()
  testPaging()
  testLog()
  testPairingContract()
  testPairingMachine()
  testPlayback()
  testModels()
  testDiscovery()
  print "DONE passed="; m.passed; " failed="; m.failed
end sub

sub check(name as string, got as dynamic, want as dynamic)
  if got = want then
    m.passed = m.passed + 1
    print "PASS "; name
  else
    m.failed = m.failed + 1
    print "FAIL "; name; " | got="; got; " | want="; want
  end if
end sub

sub testUrls()
  check("local 192.168", urlIsLocalHost("192.168.1.50"), true)
  check("local 10.x", urlIsLocalHost("10.0.0.7"), true)
  check("local 172.16", urlIsLocalHost("172.16.4.4"), true)
  check("not local 172.32", urlIsLocalHost("172.32.0.1"), false)
  check("local cgnat", urlIsLocalHost("100.100.1.1"), true)
  check("local .local", urlIsLocalHost("beebo-pc.local"), true)
  check("local single label", urlIsLocalHost("beebo-pc"), true)
  check("public name", urlIsLocalHost("nick.home.beebo.tv"), false)
  check("public ip", urlIsLocalHost("8.8.8.8"), false)

  n = urlNormalizeServer("192.168.1.50")
  check("norm lan ok", n.ok, true)
  check("norm lan url", n.url, "http://192.168.1.50:47811")
  n = urlNormalizeServer("  http://192.168.1.50:8080/  ")
  check("norm lan explicit port", n.url, "http://192.168.1.50:8080")
  n = urlNormalizeServer("http://nick.example.com")
  check("http public upgraded", n.url, "https://nick.example.com")
  check("http public note", n.note <> "", true)
  n = urlNormalizeServer("nick.example.com")
  check("bare public host -> https + default port", n.url, "https://nick.example.com:47811")
  n = urlNormalizeServer("https://Nick.Example.com:443/some/path?x=1")
  check("https default port dropped, path stripped", n.url, "https://nick.example.com")
  n = urlNormalizeServer("")
  check("empty", n.error, "empty")
  n = urlNormalizeServer("http://user:pw@host.com")
  check("credentials refused", n.error, "bad_address")
  n = urlNormalizeServer("bad host!")
  check("bad chars refused", n.error, "bad_address")
  n = urlNormalizeServer("192.168.1.50:99999")
  check("bad port refused", n.error, "bad_address")

  b = urlServerFromBeeboName("Nick")
  check("name simple", b.url, "https://nick.home.beebo.tv:47811")
  b = urlServerFromBeeboName("nick.beebo.tv")
  check("name .beebo.tv", b.url, "https://nick.home.beebo.tv:47811")
  b = urlServerFromBeeboName("https://nick.home.beebo.tv:47811/")
  check("name full", b.url, "https://nick.home.beebo.tv:47811")
  b = urlServerFromBeeboName("a.b")
  check("name with dot refused", b.error, "bad_name")
  b = urlServerFromBeeboName("")
  check("name empty", b.error, "empty")

  check("allowed https", urlIsAllowed("https://example.com/x"), true)
  check("allowed http lan", urlIsAllowed("http://192.168.1.5:47811/api/ping"), true)
  check("refused http public", urlIsAllowed("http://example.com/x"), false)
  check("refused junk", urlIsAllowed("ftp://192.168.1.5"), false)

  check("abs relative", urlAbsolute("http://192.168.1.5:47811/", "/media/poster/1.jpg"), "http://192.168.1.5:47811/media/poster/1.jpg")
  check("abs tmdb https", urlAbsolute("http://192.168.1.5:47811", "https://image.tmdb.org/t/p/w780/x.jpg"), "https://image.tmdb.org/t/p/w780/x.jpg")
  check("abs public http refused", urlAbsolute("http://192.168.1.5:47811", "http://evil.example.com/x.jpg"), "")
  check("abs empty", urlAbsolute("http://192.168.1.5:47811", ""), "")
  check("abs invalid", urlAbsolute("http://192.168.1.5:47811", invalid), "")

  check("encode space", urlEncode("a b&c"), "a%20b%26c")
  check("encode unreserved", urlEncode("Ab-_.~9"), "Ab-_.~9")
  check("encode utf8 e-acute", urlEncode(Chr(233)), "%C3%A9")
  check("query sorted", urlQuery({ sort: "title", q: "a b", limit: 60, offset: 0 }), "limit=60&offset=0&q=a%20b&sort=title")
  check("query none", urlWithQuery("/api/x", {}), "/api/x")
  check("query some", urlWithQuery("/api/x", { a: 1 }), "/api/x?a=1")
end sub

sub testFormat()
  check("dur 1h52", fmtDuration(6720), "1h 52m")
  check("dur 45m", fmtDuration(2700), "45m")
  check("dur 2h", fmtDuration(7200), "2h")
  check("dur 0", fmtDuration(0), "")
  check("dur tiny", fmtDuration(20), "1m")
  check("clock", fmtClock(3909), "1:05:09")
  check("clock short", fmtClock(65), "1:05")
  check("count", fmtCount(1234567), "1,234,567")
  check("count small", fmtCount(999), "999")
  check("rating", fmtRating(7.436), "7.4 / 10")
  check("rating none", fmtRating(invalid), "")
  check("season", fmtSeasonLabel(2), "Season 2")
  check("season 0", fmtSeasonLabel(0), "Specials")
  check("season invalid", fmtSeasonLabel(invalid), "Other episodes")
  check("percent clamp", fmtPercent(140), 100)
  check("join skips empty", fmtJoin(["a", "", "b"], "-"), "a-b")
  check("truncate", fmtTruncate("abcdefghij", 6), "abcde...")
  check("num from string", fmtNum("12", 0), 12)
  j = ParseJson("{" + Chr(34) + "i" + Chr(34) + ":6000," + Chr(34) + "f" + Chr(34) + ":1.5," + Chr(34) + "s" + Chr(34) + ":" + Chr(34) + "x" + Chr(34) + "," + Chr(34) + "b" + Chr(34) + ":true}")
  check("parsed int is number", fmtIsNumber(j.i), true)
  check("parsed float is number", fmtIsNumber(j.f), true)
  check("parsed string is not number", fmtIsNumber(j.s), false)
  check("parsed string is string", fmtIsString(j.s), true)
  check("parsed bool is true", fmtIsTrue(j.b), true)
  check("fmtNum on parsed int", fmtNum(j.i, 0), 6000)
  check("fmtInt on parsed float", fmtInt(j.f, 0), 1)
end sub

sub testPaging()
  p = pagerNew(50, 10)
  pagerReset(p, 120)
  r = pagerNextRange(p, 0)
  check("first page start", r.start, 0)
  check("first page count", r.count, 50)
  pagerMarkLoaded(p, 50)
  check("no fetch while far", pagerNextRange(p, 5), invalid)
  r = pagerNextRange(p, 41)
  check("fetch near end start", r.start, 50)
  pagerMarkLoaded(p, 50)
  r = pagerNextRange(p, 95)
  check("last page short count", r.count, 20)
  pagerMarkLoaded(p, 20)
  check("done", pagerNextRange(p, 119), invalid)
  check("empty list", pagerNextRange(pagerNew(50, 10), 0), invalid)
end sub

sub testLog()
  s = logRedact("Authorization: Bearer abc.def.ghi and more")
  check("bearer redacted", Instr(1, s, "abc.def") = 0, true)
  s = logRedact("GET http://h:47811/hls/TICKET123456789/index.m3u8?x=1")
  check("hls ticket redacted", Instr(1, s, "TICKET123456789") = 0, true)
  check("hls path kept", Instr(1, s, "/index.m3u8") > 0, true)
  s = logRedact("/file?id=abc&mt=SECRETMT&z=1")
  check("mt redacted", Instr(1, s, "SECRETMT") = 0, true)
  check("mt neighbours kept", Instr(1, s, "z=1") > 0, true)
  s = logRedact("device_code=DEVICESECRET&x=1")
  check("device_code redacted", Instr(1, s, "DEVICESECRET") = 0, true)
  s = logRedact(FormatJson({ token: "TOPSECRET" }))
  check("json token redacted", Instr(1, s, "TOPSECRET") = 0, true)
  check("plain text untouched", logRedact("hello world"), "hello world")
  check("invalid safe", logRedact(invalid), "")
end sub

function goodStart() as object
  return {
    device_code: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"
    user_code: "abcd-efgh"
    verification_uri: "https://beebo.tv/tv"
    verification_uri_complete: "https://beebo.tv/tv?code=ABCD-EFGH"
    expires_in: 600
    interval: 5
  }
end function

sub testPairingContract()
  check("device code length", Len(goodStart().device_code), 43)
  s = pairParseStart(goodStart())
  check("start ok", s.ok, true)
  check("start user code upper", s.userCode, "ABCD-EFGH")
  check("start uri display", s.verificationUri, "beebo.tv/tv")
  check("start expires", s.expiresIn, 600)
  check("start interval", s.interval, 5)
  bad = goodStart()
  bad.device_code = "short"
  check("start rejects bad device code", pairParseStart(bad).ok, false)
  check("start rejects invalid", pairParseStart(invalid).ok, false)
  slow = goodStart()
  slow.interval = 1
  check("interval clamped up", pairParseStart(slow).interval, 2)
  slow.interval = 900
  check("interval clamped down", pairParseStart(slow).interval, 30)

  j = FormatJson(pairStartBody("Living Room", "Roku Ultra"))
  check("start body keys", Instr(1, j, Chr(34) + "device_name" + Chr(34) + ":" + Chr(34) + "Living Room" + Chr(34)) > 0, true)
  check("start body model", Instr(1, j, Chr(34) + "device_model" + Chr(34)) > 0, true)
  check("start body optional", FormatJson(pairStartBody("", invalid)), "{}")
  check("poll body", Instr(1, FormatJson(pairPollBody("abc")), Chr(34) + "device_code" + Chr(34) + ":" + Chr(34) + "abc" + Chr(34)) > 0, true)

  ap = pairParsePoll({ status: "approved", token: "T", name: "Nick", iceServers: [], expiresAt: 5 }, 200)
  check("poll approved", ap.status, "approved")
  check("poll token", ap.token, "T")
  check("poll name lower", ap.name, "nick")
  check("poll approved w/o token is error", pairParsePoll({ status: "approved" }, 200).status, "error")
  check("poll pending", pairParsePoll({ status: "pending", interval: 5 }, 200).status, "pending")
  sd = pairParsePoll({ status: "slow_down", error: "slow_down", interval: 10 }, 429)
  check("poll 429 slow_down", sd.status, "slow_down")
  check("poll slow_down interval", sd.interval, 10)
  check("poll 429 without body", pairParsePoll(invalid, 429).status, "slow_down")
  d = pairParsePoll({ status: "denied", error: "no_home" }, 200)
  check("poll denied", d.status, "denied")
  check("poll denied reason", d.reason, "no_home")
  check("denied text", Instr(1, pairDeniedText("no_home"), "no Beebo home") > 0, true)
  check("poll expired", pairParsePoll({ status: "expired", error: "expired_token" }, 200).status, "expired")
  check("poll garbage", pairParsePoll("nope", 200).status, "error")
  check("poll null", pairParsePoll(invalid, 500).status, "error")
  check("no token exchange yet", pairContract().tokenExchange, false)
end sub

function startedMachine(now as integer) as object
  st = pairNew()
  pairHandle(st, { type: "begin" })
  pairHandle(st, { type: "start_result", ok: true, parsed: pairParseStart(goodStart()), now: now })
  return st
end function

sub testPairingMachine()
  st = pairNew()
  a = pairHandle(st, { type: "begin" })
  check("begin requests start", a.type, "request_start")
  check("begin phase", st.phase, "starting")
  a = pairHandle(st, { type: "start_result", ok: true, parsed: pairParseStart(goodStart()), now: 1000 })
  check("start ok -> poll", a.type, "poll")
  check("first poll waits interval", a.delaySec, 5)
  check("waiting phase", st.phase, "waiting")
  check("user code kept", st.userCode, "ABCD-EFGH")
  check("expires at", st.expiresAt, 1600)
  check("seconds left", pairSecondsLeft(st, 1100), 500)

  st2 = pairNew()
  pairHandle(st2, { type: "begin" })
  a = pairHandle(st2, { type: "start_result", ok: false, parsed: invalid, now: 1 })
  check("start fail -> error", st2.phase, "error")
  check("start fail action", a.type, "none")

  st = startedMachine(1000)
  a = pairHandle(st, { type: "poll_result", parsed: pairParsePoll({ status: "pending", interval: 5 }, 200), now: 1005 })
  check("pending -> poll again", a.type, "poll")
  check("pending delay", a.delaySec, 5)

  a = pairHandle(st, { type: "poll_result", parsed: pairParsePoll({ status: "slow_down", interval: 10 }, 429), now: 1010 })
  check("slow_down uses server interval", st.interval, 10)
  check("slow_down delay", a.delaySec, 10)
  a = pairHandle(st, { type: "poll_result", parsed: pairParsePoll(invalid, 429), now: 1020 })
  check("slow_down without interval adds 5", st.interval, 15)
  for i = 1 to 6
    pairHandle(st, { type: "poll_result", parsed: pairParsePoll(invalid, 429), now: 1030 })
  end for
  check("interval capped at 30", st.interval, 30)

  a = pairHandle(st, { type: "poll_result", parsed: pairParsePoll({ status: "approved", token: "TT", name: "nick" }, 200), now: 1040 })
  check("approved action", a.type, "approved")
  check("approved token", a.token, "TT")
  check("approved name", a.name, "nick")
  check("approved phase", st.phase, "approved")
  a = pairHandle(st, { type: "poll_result", parsed: pairParsePoll({ status: "pending" }, 200), now: 1050 })
  check("no polling after approval", a.type, "none")

  st = startedMachine(1000)
  pairHandle(st, { type: "poll_result", parsed: pairParsePoll({ status: "denied", error: "no_home" }, 200), now: 1005 })
  check("denied phase", st.phase, "denied")
  check("denied reason kept", st.reason, "no_home")

  st = startedMachine(1000)
  pairHandle(st, { type: "poll_result", parsed: pairParsePoll({ status: "expired" }, 200), now: 1005 })
  check("server expired phase", st.phase, "expired")

  st = startedMachine(1000)
  pairHandle(st, { type: "tick", now: 1599 })
  check("tick before expiry", st.phase, "waiting")
  pairHandle(st, { type: "tick", now: 1600 })
  check("tick expires locally", st.phase, "expired")

  st = startedMachine(1000)
  a = pairHandle(st, { type: "poll_result", parsed: pairParsePoll({ status: "pending" }, 200), now: 1700 })
  check("pending after deadline expires", st.phase, "expired")

  st = startedMachine(1000)
  a = pairHandle(st, { type: "poll_failed", now: 1005 })
  check("network blip retries", a.type, "poll")
  check("network blip backs off", a.delaySec, 10)
  for i = 1 to 3
    pairHandle(st, { type: "poll_failed", now: 1010 })
  end for
  a = pairHandle(st, { type: "poll_failed", now: 1020 })
  check("5th failure gives up", st.phase, "error")
  check("error kind", st.error, "network")

  st = startedMachine(1000)
  pairHandle(st, { type: "poll_failed", now: 1005 })
  pairHandle(st, { type: "poll_result", parsed: pairParsePoll({ status: "pending" }, 200), now: 1010 })
  check("success resets failures", st.failures, 0)

  st = startedMachine(1000)
  a = pairHandle(st, { type: "poll_result", parsed: pairParsePoll("garbage", 200), now: 1005 })
  check("garbage answer counts as failure", st.failures, 1)
  check("garbage answer retries", a.type, "poll")
end sub

function sampleInfo() as object
  return {
    durationSec: 6000
    qualities: [
      { id: "1080p", height: 1080, upscale: false }
      { id: "720p", height: 720, upscale: false }
      { id: "480p", height: 480, upscale: false }
    ]
    audio: [
      { ordinal: 0, streamIndex: 1, label: "English 5.1", language: "eng" }
      { ordinal: 1, streamIndex: 2, label: "", language: "fra" }
    ]
    subtitles: [
      { key: "side:0", kind: "text", label: "English", language: "en", url: "/subtitles/file?kind=movie&id=x&i=0&mt=abc" }
      { key: "emb:3", kind: "image", label: "PGS", language: "en", url: "" }
      { key: "emb:4", kind: "text", label: "", language: "es", url: "/subtitles/embedded?kind=movie&id=x&s=4&mt=abc" }
    ]
  }
end function

sub testPlayback()
  q = sampleInfo().qualities
  check("auto picks 1080p", playPickQuality(q, "auto"), "1080p")
  check("pref 720p honoured", playPickQuality(q, "720p"), "720p")
  q2 = [{ id: "1080p", upscale: true }, { id: "720p", upscale: true }, { id: "480p", upscale: false }]
  check("auto skips upscale", playPickQuality(q2, "auto"), "480p")
  check("pref missing falls back", playPickQuality([{ id: "480p", upscale: false }], "1080p"), "480p")
  check("no info default", playPickQuality(invalid, "auto"), "1080p")
  check("no info pref", playPickQuality([], "720p"), "720p")

  check("resume from continue", playResumeSeconds({ currentTime: 600, duration: 6000, percent: 10 }, 0, 6000), 600)
  check("resume ignores first 30s", playResumeSeconds({ currentTime: 20, duration: 6000, percent: 0 }, 0, 6000), 0)
  check("resume ignores near end", playResumeSeconds({ currentTime: 5960, duration: 6000, percent: 99 }, 0, 6000), 0)
  check("resume from watched percent", playResumeSeconds(invalid, 50, 6000), 3000)
  check("watched 100 no resume", playResumeSeconds(invalid, 100, 6000), 0)
  check("no data no resume", playResumeSeconds(invalid, 0, 0), 0)
  check("last minute ignored", playResumeSeconds({ currentTime: 5945, duration: 6000, percent: 90 }, 0, 6000), 0)

  b = FormatJson(playProgressBody("s1", 61.7, 6000))
  check("progress keeps camelCase sessionId", Instr(1, b, Chr(34) + "sessionId" + Chr(34)) > 0, true)
  check("progress keeps camelCase currentTime", Instr(1, b, Chr(34) + "currentTime" + Chr(34) + ":61") > 0, true)
  check("progress clamps to duration", FormatJson(playProgressBody("s1", 7000, 6000)) <> "", true)
  check("progress needs session", playProgressBody("", 5, 6000), invalid)
  check("progress needs duration", playProgressBody("s", 5, 0), invalid)
  check("start body", Instr(1, FormatJson(playStartBody("movie", "id1", "720p", 2)), Chr(34) + "audio" + Chr(34) + ":2") > 0, true)
  check("start body without audio", Instr(1, FormatJson(playStartBody("tv", "id1", "720p", invalid)), "audio") = 0, true)
  check("report due", playShouldReport(0, 20, 15), true)
  check("report not due", playShouldReport(10, 20, 15), false)

  a = playAudioOptions(sampleInfo())
  check("audio count", a.count(), 2)
  check("audio label", a[0].title, "English 5.1")
  check("audio falls back to language", a[1].title, "fra")
  s = playSubtitleOptions(sampleInfo())
  check("subs text only", s.count(), 2)
  check("subs label fallback", s[1].title, "es")

  check("err offline", Left(playFriendlyError(0, "", invalid), 12), "Can't reach ")
  check("err busy", Instr(1, playFriendlyError(503, "busy", invalid), "converting") > 0, true)
  check("err plan", Instr(1, playFriendlyError(402, "remote_requires_plan", invalid), "plan") > 0, true)
  check("err 401", Instr(1, playFriendlyError(401, "", invalid), "signed out") > 0, true)
  check("err server message", playFriendlyError(400, "x", "Custom text"), "Custom text")
end sub

sub testModels()
  legacy = {
    genres: [{ id: 28, name: "Action", count: 3 }]
    items: [
      { id: "m1", title: "Alien", year: 1979, poster: "/media/poster/1.jpg", backdrop: "https://image.tmdb.org/x.jpg", voteAverage: 8.1, quality: "1080p", overview: "In space", isNew: true, collectionName: invalid }
      { title: "no id skipped" }
    ]
  }
  r = modelTransform("movies", legacy)
  check("movies count", r.items.count(), 1)
  check("movie title", r.items[0].title, "Alien")
  check("movie isNew", r.items[0].isNew, true)
  check("movie genres", r.genres[0].name, "Action")

  v1 = { ok: true, total: 500, limit: 60, offset: 60, items: [{ id: "m9", title: "Heat", year: 1995, poster: "/p.jpg", backdrop: invalid, voteAverage: 8, quality: "720p", overview: "x", isNew: false, collection: { id: 1, name: "Cops" } }] }
  r = modelTransform("v1movies", v1)
  check("v1 total", r.total, 500)
  check("v1 offset", r.offset, 60)
  check("v1 collection", r.items[0].collection, "Cops")
  check("v1 kind", r.items[0].kind, "movie")
  r = modelTransform("v1shows", { ok: true, total: 1, offset: 0, items: [{ id: "sev", title: "Severance", episodeCount: 9, poster: invalid }] })
  check("v1 show id", r.items[0].id, "sev")
  check("v1 show kind", r.items[0].kind, "tv")
  check("v1 show poster empty", r.items[0].poster, "")

  r = modelTransform("shows", { items: [{ key: "k", name: "Show", episodeCount: 3 }] })
  check("show mapped", r.items[0].title, "Show")

  r = modelTransform("continue", { items: [{ id: "e1", kind: "tv", title: "Show - S1E2", currentTime: 300, duration: 2400, percent: 12, upNext: true }] })
  check("continue kind", r.items[0].kind, "tv")
  check("continue percent", r.items[0].percent, 12)
  check("continue upNext", r.items[0].upNext, true)

  r = modelTransform("playlist", { playlist: { name: "Fun" }, items: [
    { kind: "movie", id: "a", title: "A", available: true, percent: 0, resumeSeconds: 0 }
    { kind: "track", id: "t", title: "Song", available: true }
    { kind: "movie", id: "gone", title: "Gone", available: false }
    { kind: "tv", id: "e", title: "S1E1", showName: "Show", available: true }
  ] })
  check("playlist skips tracks and unavailable", r.items.count(), 2)
  check("playlist tv title", r.items[1].title, "Show  -  S1E1")

  r = modelTransform("episodes", { show: { key: "k", name: "Show", overview: "o" }, seasons: [
    { season: 1, episodes: [{ id: "e1", season: 1, episode: 1, title: "S1E1", watched: true, watchedPercent: 100 }] }
    { season: invalid, episodes: [{ id: "x", season: invalid, episode: invalid, title: "Loose" }] }
  ] })
  check("episodes seasons", r.seasons.count(), 2)
  check("episodes watched", r.seasons[0].episodes[0].watched, true)
  check("episodes no-season", r.seasons[1].season, invalid)
  check("unknown transform passthrough", modelTransform("nope", { a: 1 }).a, 1)
end sub

sub testDiscovery()
  hosts = discoveryHostList("192.168.1.20")
  check("host count", hosts.count(), 253)
  check("host first", hosts[0], "192.168.1.1")
  check("host skips self", discoveryHostList("192.168.1.1")[0], "192.168.1.2")
  check("public ip not scanned", discoveryHostList("8.8.8.8").count(), 0)
  check("garbage ip", discoveryHostList("nope").count(), 0)
  check("ping ok", discoveryIsBeeboPing("{" + Chr(34) + "ok" + Chr(34) + ":true," + Chr(34) + "app" + Chr(34) + ":" + Chr(34) + "beeboentertainment" + Chr(34) + "}"), true)
  check("ping other app", discoveryIsBeeboPing("{" + Chr(34) + "ok" + Chr(34) + ":true," + Chr(34) + "app" + Chr(34) + ":" + Chr(34) + "plex" + Chr(34) + "}"), false)
  check("ping html", discoveryIsBeeboPing("<html></html>"), false)
  check("ping invalid", discoveryIsBeeboPing(invalid), false)
  check("server url", discoveryServerUrl("192.168.1.9"), "http://192.168.1.9:47811")
  check("own ip pick", discoveryPickOwnIp({ eth1: "10.0.0.5", lo: "127.0.0.1" }), "10.0.0.5")
  check("own ip none", discoveryPickOwnIp({ eth1: "8.8.8.8" }), "")
  check("own ip prefers LAN over link-local", discoveryPickOwnIp({ a: "169.254.83.107", b: "10.0.0.59", c: "192.168.56.1" }), "10.0.0.59")
  check("own ip prefers LAN over vpn", discoveryPickOwnIp({ a: "100.64.1.2", b: "192.168.1.9" }), "192.168.1.9")
  check("own ip vpn only", discoveryPickOwnIp({ a: "100.64.1.2" }), "100.64.1.2")
  check("own ip link-local only", discoveryPickOwnIp({ a: "169.254.1.1" }), "")
end sub
