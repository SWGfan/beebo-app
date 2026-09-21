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
  testPairingExchange()
  testDeviceProfile()
  testNegotiate()
  testMovieNight()
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
  check("exchange is on", pairContract().tokenExchange, true)
  check("exchange route", pairContract().exchangePath, "/api/viewer-session")
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
  check("state never keeps the viewer token", st.token, "")
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

' ---- POST /api/viewer-session (same exchange as apps/smarttv and apps/apple) ------------------

sub testPairingExchange()
  q = Chr(34)
  check("house name simple", pairIsHouseName("nickhouse"), true)
  check("house name hyphen", pairIsHouseName("nick-house-2"), true)
  check("house name upper refused", pairIsHouseName("Nick"), false)
  check("house name dot refused", pairIsHouseName("a.b"), false)
  check("house name edge hyphen refused", pairIsHouseName("-nick"), false)
  check("house name empty refused", pairIsHouseName(""), false)
  check("house name not a string", pairIsHouseName(5), false)
  check("house name too long", pairIsHouseName(String(64, "a")), false)

  check("exchange over https", pairSafeExchangeUrl("https://nick.home.beebo.tv:47811"), true)
  check("exchange over LAN http", pairSafeExchangeUrl("http://192.168.1.20:47811"), true)
  check("exchange over public http refused", pairSafeExchangeUrl("http://nick.example.com:47811"), false)
  check("exchange over public ip http refused", pairSafeExchangeUrl("http://8.8.8.8:47811"), false)
  check("exchange empty url refused", pairSafeExchangeUrl(""), false)
  check("exchange junk url refused", pairSafeExchangeUrl("ftp://192.168.1.20"), false)
  check("exchange invalid url refused", pairSafeExchangeUrl(invalid), false)

  check("viewer token ok", pairIsViewerToken("eyJ0eXAi.eyJuYW1l.c2ln"), true)
  check("viewer token empty", pairIsViewerToken(""), false)
  check("viewer token space", pairIsViewerToken("a b"), false)
  check("viewer token newline", pairIsViewerToken("a" + Chr(10) + "b"), false)
  check("viewer token too long", pairIsViewerToken(String(4097, "a")), false)
  check("viewer token invalid", pairIsViewerToken(invalid), false)

  body = FormatJson(pairExchangeBody("Den Roku"))
  check("exchange body deviceName", Instr(1, body, q + "deviceName" + q + ":" + q + "Den Roku" + q) > 0, true)
  check("exchange body has no token", Instr(1, LCase(body), "token") = 0, true)
  check("exchange body empty", FormatJson(pairExchangeBody("")), "{}")
  check("exchange body cut to 40", Len(pairExchangeBody(String(80, "x")).deviceName), 40)

  good = { ok: true, token: "u1.1790000000000.sig", user: { id: "u1", name: "Robin", isAdmin: false }, expiresAt: 1790000000, server: { name: "nickhouse" } }
  r = pairClassifyExchange(200, good)
  check("exchange ok", r.status, "signed_in")
  check("exchange ok token", r.token, "u1.1790000000000.sig")
  check("exchange ok user", r.userName, "Robin")
  check("exchange ok server", r.serverName, "nickhouse")
  check("exchange 200 without token", pairClassifyExchange(200, { ok: true }).status, "bad_response")
  check("exchange 200 token with space", pairClassifyExchange(200, { ok: true, token: "a b" }).status, "bad_response")
  check("exchange 200 not json", pairClassifyExchange(200, invalid).status, "bad_response")
  check("exchange 404", pairClassifyExchange(404, { error: "not_found" }).status, "unsupported")
  check("exchange 401", pairClassifyExchange(401, { ok: false, error: "unauthorized" }).status, "rejected")
  r = pairClassifyExchange(403, { ok: false, error: "two_factor_sign_in" })
  check("exchange 403", r.status, "not_allowed")
  check("exchange 403 code", r.code, "two_factor_sign_in")
  check("exchange 402", pairClassifyExchange(402, { error: "remote_requires_plan" }).status, "plan_required")
  check("exchange 429", pairClassifyExchange(429, { error: "locked" }).status, "rate_limited")
  check("exchange no answer", pairClassifyExchange(0, invalid).status, "unreachable")
  check("exchange 500", pairClassifyExchange(500, invalid).status, "unreachable")
  check("exchange failure keeps no token", pairClassifyExchange(401, { token: "LEAK" }).token, "")

  ' every failure text points at the typed sign-in, and the specific ones say why
  check("text 404", Instr(1, pairExchangeText(pairClassifyExchange(404, invalid)), "older version") > 0, true)
  check("text 401", Instr(1, pairExchangeText(pairClassifyExchange(401, invalid)), "wouldn't accept") > 0, true)
  check("text 2fa", Instr(1, pairExchangeText(pairClassifyExchange(403, { error: "two_factor_sign_in" })), "two-factor") > 0, true)
  check("text private", Instr(1, pairExchangeText(pairClassifyExchange(403, { error: "private_profile_sign_in" })), "private profile") > 0, true)
  check("text admin", Instr(1, pairExchangeText(pairClassifyExchange(403, { error: "admin_requires_password" })), "administrator") > 0, true)
  check("text no remote", Instr(1, pairExchangeText(pairClassifyExchange(403, { error: "no_remote_access" })), "away-from-home") > 0, true)
  check("text disabled", Instr(1, pairExchangeText(pairClassifyExchange(403, { error: "viewer_exchange_disabled" })), "switched off") > 0, true)
  check("text unknown 403", Instr(1, pairExchangeText(pairClassifyExchange(403, { error: "zzz" })), "didn't allow") > 0, true)
  check("text plan", Instr(1, pairExchangeText(pairClassifyExchange(402, { error: "remote_requires_plan" })), "plan") > 0, true)
  check("text rate", Instr(1, pairExchangeText(pairClassifyExchange(429, invalid)), "Too many") > 0, true)
  check("text unreachable", Instr(1, pairExchangeText(pairClassifyExchange(0, invalid)), "Couldn't reach") > 0, true)
  check("text always offers typed sign-in", Instr(1, pairExchangeText(pairClassifyExchange(401, invalid)), "username and password") > 0, true)
end sub

' ---- device profile (docs/HOME-THEATER.md) --------------------------------------------------------

function fullCan() as object
  return { h264_40: true, h264_51: true, hevc_main: true, hevc_main10: true, vp9_p0: true, vp9_p2: true, av1_main: true, aac: true, ac3: true, eac3: true, flac: true, opus: true, mp3: true, dts_pass: false }
end function

sub testDeviceProfile()
  q = Chr(34)
  p = dpBuild({ model: "Roku Ultra", uhd: true, hdr10: true, can: fullCan() })
  j = dpToJson(p)
  check("profile client", p.client, "roku")
  check("profile version", p.v, 1)
  check("profile name", p.name, "Roku Ultra")
  check("profile json keys keep case", Instr(1, j, q + "maxLevel" + q) > 0 and Instr(1, j, q + "bitDepths" + q) > 0 and Instr(1, j, q + "maxChannels" + q) > 0, true)
  check("profile json round trip", ParseJson(j).client, "roku")
  check("profile h264", p.video.h264.maxLevel, 51)
  check("profile hevc main10", p.video.hevc.bitDepths.count(), 2)
  check("profile vp9 p2", p.video.vp9.profiles.count(), 2)
  check("profile av1", p.video.av1.profiles[0], "main")
  check("profile hdr10 only", p.hdr.count(), 1)
  check("profile hdr10", p.hdr[0], "hdr10")
  check("profile 4k", p.maxHeight, 2160)
  check("profile 4k width", p.maxWidth, 3840)
  check("profile aac 6ch", p.audio.aac.maxChannels, 6)
  check("profile ac3", p.audio.ac3.maxChannels, 6)
  check("profile eac3 no atmos", p.audio.eac3.DoesExist("atmos"), false)
  check("profile max channels", p.maxAudioChannels, 6)
  check("profile containers", p.containers.count(), 4)
  check("profile streaming", p.streaming.count(), 2)
  check("profile subtitles", p.subtitles[0], "vtt")
  check("profile no dolby vision", Instr(1, j, "dv:") = 0, true)
  check("profile no hdr10plus", Instr(1, j, "hdr10plus") = 0, true)
  for each k in ["truehd", "dtshd", "dtsx", "dts"]
    check("profile never lists " + k, p.audio.DoesExist(k), false)
  end for

  ' DTS core passthrough only when the Roku reported it
  c = fullCan()
  c.dts_pass = true
  p2 = dpBuild({ model: "Roku", uhd: false, hdr10: false, can: c })
  check("dts core only when detected", p2.audio.dts.passthrough, true)
  check("dts core is not decoded", p2.audio.dts.decode, false)
  check("dtshd still never", p2.audio.DoesExist("dtshd"), false)

  ' a plain HD Roku: no HEVC, no HDR, 1080p, stereo
  hd = dpBuild({ model: "Roku Express", uhd: false, hdr10: false, can: { h264_40: true, h264_51: false, aac: true } })
  check("hd no hevc", hd.video.DoesExist("hevc"), false)
  check("hd h264 level 40", hd.video.h264.maxLevel, 40)
  check("hd hdr empty", hd.hdr.count(), 0)
  check("hd 1080", hd.maxHeight, 1080)
  check("hd no width", hd.DoesExist("maxWidth"), false)
  check("hd stereo", hd.maxAudioChannels, 2)
  check("hd aac only", hd.audio.aac.maxChannels, 2)
  check("hd no ac3", hd.audio.DoesExist("ac3"), false)

  ' nothing probed -> the server keeps its own default
  bare = dpBuild(invalid)
  check("bare client", bare.client, "roku")
  check("bare has no video", bare.DoesExist("video"), false)
  check("bare json", FormatJson(bare), "{" + q + "client" + q + ":" + q + "roku" + q + "," + q + "v" + q + ":1}")
  check("no can -> bare", dpBuild({ model: "x" }).DoesExist("hdr"), false)
  check("flags read safely", dpFlag(invalid, "x"), false)
  check("flags missing", dpFlag({ a: true }, "b"), false)
  check("flags non boolean", dpFlag({ a: "yes" }, "a"), false)
end sub

sub testNegotiate()
  q = Chr(34)
  pj = dpToJson(dpBuild({ model: "R", uhd: false, hdr10: false, can: { h264_40: true, aac: true } }))
  body = playNegotiateBody("movie", "abc", "auto", invalid, pj)
  parsed = ParseJson(body)
  check("negotiate body parses", parsed <> invalid, true)
  check("negotiate kind", parsed.kind, "movie")
  check("negotiate id", parsed.id, "abc")
  check("negotiate client", parsed.client, "roku")
  check("negotiate auto = original", parsed.quality, "original")
  check("negotiate has profile", parsed.deviceProfile.client, "roku")
  check("negotiate profile keeps case", Instr(1, body, q + "maxLevel" + q) > 0, true)
  check("negotiate no audio by default", parsed.DoesExist("audio"), false)
  body = playNegotiateBody("tv", "ep1", "720p", 3, pj)
  parsed = ParseJson(body)
  check("negotiate tv kind", parsed.kind, "tv")
  check("negotiate quality kept", parsed.quality, "720p")
  check("negotiate audio", parsed.audio, 3)
  check("negotiate weird kind is movie", ParseJson(playNegotiateBody("x", "a", "auto", invalid, pj)).kind, "movie")
  check("negotiate without profile", ParseJson(playNegotiateBody("movie", "a", "auto", invalid, "")).DoesExist("deviceProfile"), false)
  check("negotiate rejects a profile that is not an object", ParseJson(playNegotiateBody("movie", "a", "auto", invalid, "[1]")).DoesExist("deviceProfile"), false)

  dp = playParseNegotiate({ ok: true, method: "DirectPlay", url: "/file?id=a&mt=T", container: "mkv", durationSec: 6300 })
  check("plan directplay ok", dp.ok, true)
  check("plan directplay mkv format", dp.format, "mkv")
  check("plan duration", dp.duration, 6300)
  check("plan mp4 format", playParseNegotiate({ ok: true, method: "DirectPlay", url: "/tvfile?id=a&mt=T", container: "mp4" }).format, "mp4")
  check("plan mov is mp4", playParseNegotiate({ ok: true, method: "DirectPlay", url: "/file?id=a", container: "mov" }).format, "mp4")
  check("plan ts format", playParseNegotiate({ ok: true, method: "DirectPlay", url: "/file?id=a", container: "ts" }).format, "ts")
  check("plan avi is not playable", playParseNegotiate({ ok: true, method: "DirectPlay", url: "/file?id=a", container: "avi" }).ok, false)
  ds = playParseNegotiate({ ok: true, method: "DirectStream", url: "/hls/T1/master.m3u8", ticket: "T1", container: "hls-fmp4" })
  check("plan directstream", ds.ok, true)
  check("plan directstream format", ds.format, "hls")
  check("plan directstream ticket", ds.ticket, "T1")
  tc = playParseNegotiate({ ok: true, method: "Transcode", url: "/hls/T2/index.m3u8", ticket: "T2" })
  check("plan transcode", tc.method, "Transcode")
  check("plan transcode format", tc.format, "hls")
  bad = [
    invalid, "x", { ok: false, method: "DirectPlay", url: "/file?id=a", container: "mp4" }
    { ok: true, method: "Teleport", url: "/file?id=a" }
    { ok: true, method: "DirectPlay", url: "http://evil.example/file?id=a", container: "mp4" }
    { ok: true, method: "DirectPlay", url: "//evil.example/file?id=a", container: "mp4" }
    { ok: true, method: "DirectPlay", url: "/api/admin/x", container: "mp4" }
    { ok: true, method: "DirectPlay", url: "/hls/T/index.m3u8", container: "mp4" }
    { ok: true, method: "DirectStream", url: "/file?id=a" }
    { ok: true, method: "DirectStream", url: "/hls/../x.m3u8" }
    { ok: true, method: "Transcode", url: "/x/index.m3u8" }
    { ok: true, method: "Transcode" }
  ]
  for i = 0 to bad.count() - 1
    check("plan refused #" + Str(i).trim(), playParseNegotiate(bad[i]).ok, false)
  end for

  check("prepare wait", playPrepareWaitSec(503, { error: "preparing", retryAfterSec: 3 }), 3)
  check("prepare wait capped", playPrepareWaitSec(503, { error: "preparing", retryAfterSec: 99 }), 10)
  check("prepare wait default", playPrepareWaitSec(503, { error: "preparing" }), 3)
  check("prepare other 503", playPrepareWaitSec(503, { error: "busy" }), 0)
  check("prepare not 503", playPrepareWaitSec(404, { error: "preparing" }), 0)
  check("prepare no body", playPrepareWaitSec(503, invalid), 0)
end sub

sub testMovieNight()
  check("tv address", mnTvAddress("http://192.168.1.20:47811"), "http://192.168.1.20:47811/tv")
  check("tv address trailing slash", mnTvAddress("https://nick.home.beebo.tv:47811/"), "https://nick.home.beebo.tv:47811/tv")
  check("tv address empty", mnTvAddress(""), "")
  check("tv address invalid", mnTvAddress(invalid), "")
  check("status available", mnParseStatus(200, { ok: true, available: true }).state, "available")
  off = mnParseStatus(200, { ok: true, available: false, message: "Turned off in Settings." })
  check("status off", off.state, "off")
  check("status off message", off.message, "Turned off in Settings.")
  check("status off default message", Instr(1, mnParseStatus(200, { available: false }).message, "switched off") > 0, true)
  check("status control chars cleaned", mnParseStatus(200, { available: false, message: "a" + Chr(10) + "b" }).message, "a b")
  check("status 404", mnParseStatus(404, invalid).state, "unsupported")
  check("status 401", mnParseStatus(401, invalid).state, "signed_out")
  check("status 403", mnParseStatus(403, invalid).state, "off")
  check("status 500", mnParseStatus(500, invalid).state, "error")
  check("status garbage", mnParseStatus(200, "nope").state, "error")
  check("instructions name the browser", Instr(1, mnInstructions(), "web browser") > 0, true)
end sub
