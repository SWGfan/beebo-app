package com.beeboentertainment.movie.campsite

/** Browser presentation only. Hosting, guest access and file streaming remain in CampsiteServer. */
internal object CampsiteWebPages {
    private fun escape(value: String): String = value.replace("&", "&amp;")
        .replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;").replace("'", "&#39;")
    private fun query(value: String): String = java.net.URLEncoder.encode(value, "UTF-8")
    private fun brand(): String = """<a class="beebo-brand" href="/library" aria-label="Beebo campsite library"><span class="beebo-mark" aria-hidden="true">b</span><span class="beebo-wordmark">beebo<small>ENTERTAINMENT</small></span></a>"""

    private fun navigation(active: String): String {
        val links = listOf(Triple("all", "/library", "All videos"), Triple("movie", "/library?kind=movie", "Movies"), Triple("tv", "/library?kind=tv", "TV episodes"), Triple("games", "/games", "Guest games"), Triple("music", "/music", "Music together"), Triple("slides", "/slides", "Shared photos & videos"), Triple("clock", "/clock", "Are we there yet?"), Triple("songbook", "/songbook", "Campfire songbook"), Triple("quiz", "/quiz", "Roadside quiz"), Triple("hunt", "/hunt", "Scavenger hunt"))
        return """<aside class="beebo-sidebar" id="beebo-navigation" aria-label="Campsite navigation">
          ${brand()}<button class="beebo-dismiss" type="button" aria-label="Close navigation">×</button>
          <div class="beebo-nav-label">CAMPSITE LIBRARY</div><nav aria-label="Videos">${links.joinToString("") { (key, href, label) ->
            """<a class="beebo-nav-link" href="$href" ${if (active == key) "aria-current=\"page\"" else ""}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="m10 8 5 4-5 4Z"/></svg><span>$label</span></a>"""
          }}</nav><div class="beebo-sidebar-foot"><strong>A little cinema. Anywhere.</strong>Stay connected to your host's Wi-Fi.</div></aside>"""
    }

    private fun mobileChrome(active: String): String {
        val tabs = listOf(Triple("all", "/library", "Library"), Triple("movie", "/library?kind=movie", "Movies"), Triple("music", "/music", "Music"), Triple("games", "/games", "Games"))
        val heading = when(active) { "movie" -> "Movies"; "tv" -> "TV episodes"; "music" -> "Music together"; else -> "Campsite library" }
        fun icon(key: String): String = """<svg viewBox="0 0 24 24" aria-hidden="true">${when(key) {
            "movie" -> """<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4m-4 6h4m10-6h4m-4 6h4"/>"""
            "tv" -> """<rect x="2" y="6" width="20" height="14" rx="3"/><path d="m8 2 4 4 4-4"/>"""
            "music" -> """<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>"""
            else -> """<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>"""
        }}</svg>"""
        return """<header class="beebo-mobilebar"><a class="beebo-app-home" href="/library" aria-label="Beebo campsite library"><span class="beebo-mark" aria-hidden="true">b</span></a><div class="beebo-app-heading"><span>BEEBO · CAMPSITE</span><strong>$heading</strong></div><button class="beebo-search-button" type="button" aria-label="Search titles" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg></button></header>
          <nav class="beebo-bottomnav" aria-label="Main tabs">${tabs.joinToString("") { (key, href, label) -> """<a href="$href" ${if(active == key) "aria-current=\"page\"" else ""}><span class="beebo-tab-icon">${icon(key)}</span><span>$label</span></a>""" }}<button class="beebo-menu" type="button" aria-label="More navigation" aria-controls="beebo-navigation" aria-expanded="false"><span class="beebo-tab-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></span><span>More</span></button></nav><button class="beebo-scrim" type="button" tabindex="-1" aria-label="Close navigation"></button>"""
    }

    fun landing(): String = page("Welcome to camp", """
        <div class="wrap camp-welcome">
          <div class="camp-welcome-art" aria-hidden="true"><svg viewBox="0 0 240 120"><circle cx="180" cy="35" r="23"/><path d="m20 108 70-85 70 85Zm88 0 48-62 54 62"/><path d="m66 108 24-34 27 34"/></svg></div>
          <span class="camp-eyebrow">THE CAMPSITE CINEMA</span>
          <h1>Make yourself<br>comfortable.</h1>
          <p class="sub">Movies, shows and games with your guests.<br>Pick a name and join in.</p>
          <form action="/join" method="get" class="joinform">
            <label for="guest-name">Your name <span class="muted">(optional)</span></label>
            <input id="guest-name" name="name" placeholder="What should we call you?" maxlength="24" autocomplete="nickname">
            <button type="submit">Join Beebo <span aria-hidden="true">→</span></button>
          </form>
          <p class="camp-note">No account needed. Leave your name blank to join as a guest.</p>
          <p class="camp-note camp-divider">Keep your phone connected to the host's Wi-Fi while watching.</p>
        </div>""".trimIndent(), narrow = true)

    fun library(guest: String, allItems: List<CampsiteServer.Item>, selected: String): String {
        val kind = selected.takeIf { it == "movie" || it == "tv" } ?: "all"
        val items = allItems.filter { kind == "all" || if (kind == "tv") it.kind.equals("tv", true) else !it.kind.equals("tv", true) }
        val heading = when (kind) { "movie" -> "Movies"; "tv" -> "TV episodes"; else -> "Your campsite library" }
        val grid = if (items.isEmpty()) """<div class="empty"><h2>Nothing here just yet</h2><p>${if (allItems.isEmpty()) "Your host hasn't shared any downloaded videos yet." else "There are no shared titles in this category yet."}</p><a href="/library">Browse all videos</a></div>"""
        else items.sortedBy { it.title.lowercase() }.groupBy { it.title.trim().firstOrNull()?.uppercaseChar()?.takeIf { letter -> letter in 'A'..'Z' }?.toString() ?: "#" }.entries.joinToString("") { (letter, group) ->
          """<section id="letter-$letter"><h3>$letter</h3><div class="grid">${group.joinToString("") { item ->
            val title = escape(item.title)
            val tv = item.kind.equals("tv", true)
            val palette = Math.floorMod(item.id.hashCode(), 5)
            """<a class="card tile camp-palette-$palette" href="/watch?id=${query(item.id)}" data-name="${escape(item.title.lowercase())}">
              <div class="camp-poster"><span class="camp-format">${if (tv) "TV EPISODE" else "MOVIE"}</span>
                <svg class="camp-art" viewBox="0 0 240 320" aria-hidden="true"><circle cx="180" cy="90" r="70"/><circle cx="40" cy="270" r="115"/><path d="M-20 280 250 60M-30 310 260 90"/></svg>
                <span class="camp-cover-title">$title</span><span class="camp-play" aria-hidden="true">▶</span>
              </div><div class="meta"><div class="title">$title</div><div class="sub"><span class="camp-dot" aria-hidden="true"></span> Available on this hotspot</div></div>
            </a>"""
          }}</div></section>"""
        }
        val letters = items.map { it.title.trim().firstOrNull()?.uppercaseChar()?.takeIf { letter -> letter in 'A'..'Z' }?.toString() ?: "#" }.toSet()
        val alphabet = if(items.isEmpty()) "" else """<nav class="beebo-alphabet camp-alphabet" aria-label="Jump to title letter">${(listOf("#") + ('A'..'Z').map { it.toString() }).joinToString("") { letter -> if(letter in letters) """<a href="#letter-$letter">$letter</a>""" else """<span>$letter</span>""" }}</nav>"""
        return page(heading, """
          <header class="topbar"><h2>$heading</h2><span class="camp-user">${escape(guest)}</span></header>
          <section class="camp-live" id="camp-live" aria-label="Playing now" hidden><span class="camp-eyebrow">PLAYING NOW</span><h2>Someone has something on</h2><p class="muted">Tap a title to jump in - your phone picks the film up exactly where everyone else is.</p><div class="camp-live-list" id="camp-live-list"></div></section>
          <section class="camp-intro"><div><span class="camp-eyebrow">SHARED BY YOUR HOST</span><h1>Good company.<br>Great stories.</h1><p>Find something to watch. Every title here plays from your host's phone.</p></div><div class="camp-count"><strong>${allItems.size}</strong><span>${if (allItems.size == 1) "shared video" else "shared videos"}</span></div></section>
          <a class="camp-back" href="/games" style="display:block;padding:18px;margin:16px 0;background:#213351;border:1px solid #d4af37;border-radius:14px">🎮 Play games with your guests →<br><small>Each player uses their own phone. No app or account needed.</small></a>
          <div class="camp-library-heading"><h2>${if (kind == "all") "Browse the collection" else "Browse ${heading.lowercase()}"}</h2><span class="muted">${items.size} ${if (items.size == 1) "title" else "titles"}</span></div>
          <label class="camp-search-label" for="camp-search">Search this collection</label><input id="camp-search" type="search" placeholder="Search by title…" autocomplete="off">
          <p id="camp-results" role="status" aria-live="polite" class="beebo-search-status" hidden></p>
          $alphabet<div class="camp-collection">$grid</div>
          <p class="camp-note">Connected locally. Keep the host's Wi-Fi selected while you watch.</p>
        """.trimIndent(), active = kind, script = liveScript)
    }

    /**
     * The player page. The video element keeps working on its own if any of the
     * watch-together machinery is missing, so a guest whose browser cannot reach
     * the sync endpoint still gets their film rather than a spinner.
     */
    fun watch(item: CampsiteServer.Item): String = page(item.title, """
      <header class="topbar"><a class="camp-back" href="/library">← Back to library</a><span class="camp-user">Campsite cinema</span></header>
      <span class="camp-eyebrow">NOW PLAYING</span><h1 class="camp-watch-title">${escape(item.title)}</h1>
      <div class="camp-player">
        <video id="camp-video" controls autoplay playsinline preload="metadata" controlslist="nodownload noplaybackrate" disablepictureinpicture oncontextmenu="return false" src="/file?id=${query(item.id)}"></video>
        <div class="camp-gate" id="camp-gate" hidden>
          <strong>Watching together</strong>
          <p id="camp-gate-text">One tap and your phone drops in exactly where everyone else is.</p>
          <button type="button" id="camp-gate-go">Join the watch party</button>
        </div>
      </div>
      <p id="camp-player-error" class="error" role="alert" hidden>This video couldn't play. Check that you're still connected to your host's Wi-Fi, then try again or ask your host for help.</p>
      <div class="camp-sync" id="camp-sync" data-video="${escape(item.id)}" hidden>
        <span class="camp-dot" aria-hidden="true"></span>
        <b id="camp-sync-line" role="status">Looking for a watch party.</b>
        <span class="camp-sync-who" id="camp-sync-who"></span>
        <button type="button" class="btn-secondary" id="camp-sync-claim" hidden>Take over playback</button>
        <a id="camp-sync-join" href="/join?next=watch&amp;id=${query(item.id)}" hidden>Join the campsite to watch together →</a>
      </div>
      <div class="camp-player-footer"><span><span class="camp-dot" aria-hidden="true"></span> Playing from your host's phone</span><a href="/library">Find your next watch →</a></div>
    """.trimIndent(), active = if (item.kind.equals("tv", true)) "tv" else "movie", script = watchScript)

    internal fun page(title: String, body: String, active: String = "all", narrow: Boolean = false, script: String = ""): String = """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#101c32"><title>${escape(title)} · Beebo</title><style>$styles</style></head>
      <body class="${if (narrow) "beebo-auth" else "beebo-shell"}"><a class="beebo-skip" href="#beebo-content">Skip to content</a>
      ${if (narrow) "" else navigation(active) + mobileChrome(active)}
      <main class="beebo-main" id="beebo-content" tabindex="-1">${if (narrow) brand() else ""}$body</main><script>$scripts</script>${if (script.isBlank()) "" else "<script>" + script + "</script>"}</body></html>"""

    private val styles = """
/* Shared Beebo browser design: desktop layout, purple, marine blue and gold. */
:root{color-scheme:dark;--bg:#080b14;--panel:#101c32;--raised:#152540;--text:#f2f3ff;--muted:#acb6cf;--line:#2c3e5d;--purple:#7950cf;--gold:#d4af37;--link:#c5afff}
html{scroll-padding-top:24px}body{margin:0;background:radial-gradient(ellipse at 100% 0,#162d4d 0,transparent 50%),var(--bg);color:var(--text);font:14px/1.55 'Segoe UI',system-ui,sans-serif;min-height:100vh;padding:0}*{box-sizing:border-box}a{color:var(--link)}button,input,textarea,select{font:inherit}button,a,input,select,textarea{-webkit-tap-highlight-color:transparent}:where(button,a,input,select,textarea,[tabindex]):focus-visible{outline:3px solid var(--gold);outline-offset:4px}button:disabled{opacity:.5;cursor:not-allowed}[hidden]{display:none!important}
.beebo-main{min-width:0;max-width:1720px;margin:0 auto;padding:34px 38px 60px}.beebo-shell .beebo-main{margin-left:240px}.beebo-sidebar{position:fixed;inset:0 auto 0 0;width:240px;z-index:30;display:flex;flex-direction:column;gap:6px;padding:28px 16px 20px;background:linear-gradient(165deg,#14294a,#0c1428 48%,#090b14);border-right:1px solid var(--line);overflow-y:auto}.beebo-brand{display:flex;align-items:center;gap:12px;text-decoration:none;color:#fff;padding:0 10px 26px}.beebo-mark{width:38px;height:42px;display:grid;place-items:center;background:linear-gradient(145deg,#9567e8,#34568c);border:1px solid #b391eb;border-radius:13px 13px 13px 4px;font-size:27px;font-weight:800;box-shadow:0 6px 20px #0004}.beebo-wordmark{font-size:29px;font-weight:750;letter-spacing:-1.2px;line-height:1}.beebo-wordmark small{display:block;margin-top:7px;font-size:8px;font-weight:600;letter-spacing:2.8px;color:#b6c3df}.beebo-nav-label{padding:15px 12px 6px;color:#94a5c4;letter-spacing:1.8px;font-size:10px;font-weight:700}.beebo-nav-link{display:flex;align-items:center;gap:11px;min-height:45px;padding:11px 12px;border:1px solid transparent;border-radius:10px;color:#bfcee6;text-decoration:none;font-size:13px;font-weight:550}.beebo-nav-link svg{width:19px;height:19px;flex-shrink:0;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}.beebo-nav-link:hover{background:#1b2b47;border-color:#344568;color:#fff}.beebo-nav-link[aria-current=page]{background:linear-gradient(110deg,#6840b5,#304d8e);border-color:var(--gold);box-shadow:inset 3px 0 var(--gold),0 5px 18px #0003;color:#fff}.beebo-sidebar-foot{margin-top:auto;padding:26px 12px 0;color:#a0afc8;font-size:11px}.beebo-sidebar-foot strong{display:block;color:#d8e1f2;font-size:12px;font-weight:600;margin-bottom:3px}.beebo-mobilebar,.beebo-dismiss,.beebo-scrim{display:none}.beebo-skip{position:fixed;top:-80px;left:16px;z-index:100;background:var(--gold);color:#10121b;padding:12px 20px;border-radius:8px}.beebo-skip:focus{top:12px}
.topbar{display:flex;justify-content:space-between;align-items:center;gap:18px;margin-bottom:26px;padding-bottom:23px;border-bottom:1px solid var(--line)}.topbar h2{font-size:29px;letter-spacing:-.8px;line-height:1.2}.topbar a[href='/logout']{font-size:12px!important;color:#cad6eb!important;text-decoration:none;border:1px solid var(--line);border-radius:9px;padding:8px 14px}.topbar a[href='/logout']:hover{border-color:var(--gold)}h2,h1{letter-spacing:-.7px}h3{letter-spacing:-.3px}p{line-height:1.65}.muted,.sub{color:var(--muted)}.tabs{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:22px;padding-bottom:16px;border-bottom:1px solid var(--line)}.tab{padding:8px 14px;border:1px solid #344768;border-radius:9px;color:#b9c8e2;text-decoration:none;font-size:13px;font-weight:550;white-space:nowrap}.tab:hover{background:#1b2b47;color:#fff}.tab-active{background:#60409f;border-color:#a888dc;color:#fff}.beebo-main input,.beebo-main textarea,.beebo-main select{background:#0b1528;border:1px solid #405376;color:var(--text);border-radius:10px;padding:12px 15px;min-height:44px}.beebo-main input::placeholder,.beebo-main textarea::placeholder{color:#9aacc9;opacity:1}.beebo-main #q{margin-bottom:18px;background:#101c30;width:100%;max-width:620px;padding-left:17px}.beebo-main button:not(.icon-btn),.beebo-main .btn{min-height:42px;border:1px solid #9776cb;border-radius:9px;background:linear-gradient(115deg,#7144c3,#355997);color:#fff;font-weight:600}.beebo-main .btn-secondary{background:#182b49;border-color:#405376}.beebo-main .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(164px,1fr));gap:22px}.beebo-main .card{background:linear-gradient(155deg,#152540,#101827);border:1px solid #293a56;border-radius:13px;box-shadow:0 8px 24px #0003;transition:transform .18s,border-color .18s;overflow:hidden;min-width:0}.beebo-main .card:hover{border-color:#a182df;transform:translateY(-3px)}.beebo-main .card img{background:#080d18}.beebo-main .meta{padding:12px}.beebo-main .title{font-size:14px;line-height:1.45;font-weight:650;overflow-wrap:anywhere}.beebo-main .sub{font-size:12px;margin-top:5px}.beebo-main .noposter{color:#c1afec;background:radial-gradient(ellipse at 85% 0,#354b76,transparent 65%),linear-gradient(145deg,#302044,#10243f);padding:24px;font-size:17px;font-weight:600}.beebo-main .icon-btn{min-width:30px;min-height:30px;padding:6px!important;background:#090e1dcc;backdrop-filter:blur(8px);border-color:#7791b866}.beebo-main .info-overlay{background:#0b1327f5;padding:15px;font-size:13px}.beebo-main .empty{margin:28px 0;padding:48px 24px;color:#bac8df;border:1px dashed #425673;border-radius:15px;background:#101c3277}.beebo-main .error,.beebo-main .success{padding:14px 18px}.beebo-search-status{color:#bac8df;font-size:13px;margin:0 0 20px}.beebo-main table{max-width:100%;border-collapse:collapse}.beebo-main th,.beebo-main td{border-color:var(--line)}
.beebo-auth .beebo-main{max-width:490px;margin:6vh auto;padding:24px}.beebo-auth .wrap{max-width:none;margin:0;background:linear-gradient(155deg,#152540,#101827);border:1px solid var(--line);border-radius:20px;padding:30px;box-shadow:0 22px 70px #0005}.beebo-auth .beebo-brand{justify-content:center;padding:0 0 28px}.beebo-auth h2{font-size:23px}.beebo-auth input{width:100%;margin-bottom:14px}.beebo-auth form button{width:100%}.beebo-auth a[style]{color:var(--link)!important}
@media(min-width:1720px){.beebo-shell .beebo-main{margin-right:auto}}
@media(max-width:1100px){.beebo-main{padding:28px}.beebo-main .grid{gap:16px;grid-template-columns:repeat(auto-fill,minmax(145px,1fr))}}
@media(max-width:860px){.beebo-shell .beebo-main{margin-left:0;padding:23px 20px 40px}.beebo-mobilebar{display:flex;align-items:center;gap:14px;padding:14px 20px;background:#101c32;border-bottom:1px solid var(--line)}.beebo-mobilebar .beebo-brand{padding:0;gap:10px}.beebo-mobilebar .beebo-mark{width:28px;height:30px;font-size:22px;border-radius:9px 9px 9px 3px}.beebo-mobilebar .beebo-wordmark{font-size:25px}.beebo-mobilebar small{display:none}.beebo-menu,.beebo-dismiss{min-width:42px;min-height:42px;padding:8px;background:#192b48;border:1px solid #415476;border-radius:9px;color:#fff;font:inherit}.beebo-sidebar{width:268px;transform:translateX(-105%);transition:transform .18s;visibility:hidden}.beebo-dismiss{display:block;position:absolute;right:12px;top:18px;min-width:34px;min-height:34px}.beebo-sidebar .beebo-brand{padding-right:30px}.beebo-menu-open .beebo-sidebar{transform:translateX(0);visibility:visible}.beebo-menu-open .beebo-scrim{display:block;position:fixed;inset:0;background:#030713c9;z-index:29;border:0;border-radius:0}.beebo-menu-open{overflow:hidden}.topbar{margin-bottom:21px;padding-bottom:18px}.topbar h2{font-size:26px}.beebo-main .grid{grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:15px}.tabs{gap:7px}.tab{font-size:12px;padding:8px 10px}}
@media(max-width:420px){.beebo-shell .beebo-main{padding:20px 14px 32px}.beebo-main .grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.beebo-main .meta{padding:10px}.beebo-main .title{font-size:13px}.beebo-auth .beebo-main{padding:16px;margin:3vh auto}.beebo-auth .wrap{padding:24px 20px}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;transition:none!important}.beebo-main .card:hover{transform:none}}

/* Phone layout follows the Android app: app bar, search/chips, poster grid and bottom tabs. */
.beebo-bottomnav{display:none}.beebo-app-heading{min-width:0}.beebo-alphabet{scrollbar-width:thin;scrollbar-color:#66538d transparent}.beebo-alphabet a[aria-disabled=true]{opacity:.3;cursor:default}.beebo-alphabet a:focus-visible{outline-offset:-3px}
@media(max-width:860px){
  :root{--bg:#0f1420;--panel:#182033;--raised:#232c42;--text:#e9ecf3;--muted:#b9c1d4;--gold:#e5b94e;--line:#303b54}
  html{scroll-padding-top:92px;scroll-padding-bottom:104px}body.beebo-shell{background:#0f1420}
  .beebo-shell .beebo-main{padding:16px 14px calc(100px + env(safe-area-inset-bottom));margin:0}
  .beebo-mobilebar{position:sticky;top:0;z-index:20;min-height:calc(72px + env(safe-area-inset-top));gap:12px;padding:calc(12px + env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) 12px max(16px,env(safe-area-inset-left));background:linear-gradient(110deg,#211d36,#172943);border-bottom:1px solid #343651}
  .beebo-app-home{text-decoration:none;flex-shrink:0}.beebo-mobilebar .beebo-mark{height:36px;width:34px;font-size:26px}
  .beebo-app-heading{flex:1}.beebo-app-heading>span{display:block;color:#c7b173;font-size:9px;letter-spacing:1.8px;font-weight:650}.beebo-app-heading strong{display:block;font-size:20px;line-height:1.3;letter-spacing:-.3px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .beebo-search-button{display:grid;place-items:center;min-height:44px;min-width:44px;padding:10px;border:1px solid #4b4c67;background:#18253b;border-radius:50%;color:#e5b94e;cursor:pointer}
  .beebo-search-button svg,.beebo-bottomnav svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
  .beebo-mobile-logout{display:grid;place-items:center;width:44px;min-width:44px;height:44px;color:#b9c1d4!important;border:1px solid #454b64;border-radius:50%;text-decoration:none}.beebo-mobile-logout svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.beebo-mobile-logout span{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
  .beebo-shell .topbar:not(:has(a,button,.camp-user)){display:none}
  .beebo-bottomnav{display:flex;align-items:stretch;position:fixed;inset:auto 0 0;z-index:25;padding:8px max(6px,env(safe-area-inset-right)) calc(8px + env(safe-area-inset-bottom)) max(6px,env(safe-area-inset-left));background:#182033f7;border-top:1px solid #424258;box-shadow:0 -6px 24px #070b1433;backdrop-filter:blur(16px)}
  .beebo-bottomnav a,.beebo-bottomnav button{display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;gap:3px;min-width:0;min-height:56px;padding:0 2px;border:0;background:transparent;border-radius:10px;color:#b9c1d4;font-size:11px;line-height:1.4;font-weight:500;text-decoration:none;cursor:pointer}
  .beebo-tab-icon{display:grid;place-items:center;width:52px;height:29px;border-radius:20px;border:1px solid transparent}
  .beebo-bottomnav [aria-current=page],.beebo-bottomnav .beebo-tab-selected,.beebo-bottomnav [aria-expanded=true]{color:#f6d577;font-weight:650}
  .beebo-bottomnav [aria-current=page] .beebo-tab-icon,.beebo-bottomnav .beebo-tab-selected .beebo-tab-icon,.beebo-bottomnav [aria-expanded=true] .beebo-tab-icon{background:linear-gradient(105deg,#523975,#294572);border-color:#937b4c}
  .beebo-bottomnav a:hover,.beebo-bottomnav button:hover{background:#292b44}
  .beebo-shell .topbar{min-height:0;border:0;margin:0 0 12px;padding:0;justify-content:flex-end}.beebo-shell .topbar h2{display:none}.beebo-shell .topbar a[href='/logout']{min-height:36px;padding:6px 12px;font-size:11px!important}
  .beebo-main #q,.beebo-main #camp-search{max-width:none;min-height:50px;margin:0 0 14px;border-radius:12px;border-color:#596078;background:#182033;font-size:16px}
  .beebo-main .tabs{flex-wrap:nowrap;overflow-x:auto;gap:8px;padding:0 0 10px;margin-bottom:12px;border:0;scrollbar-width:thin;scrollbar-color:#66538d transparent}
  .beebo-main .tab{display:flex;align-items:center;justify-content:center;flex-shrink:0;min-height:40px;padding:8px 14px;border-radius:22px;background:#182033;border-color:#38445f;font-size:12px;color:#b9c1d4}.beebo-main .tab-active{background:#45365a;border-color:#c39c45;color:#f4d788}
  .beebo-main .beebo-genres{flex-wrap:nowrap!important;overflow-x:auto;padding-bottom:8px!important;scrollbar-width:thin}.beebo-genres a{flex-shrink:0;min-height:40px;display:flex;align-items:center;background:#182033!important;color:#b9c1d4!important;border-color:#38445f!important}.beebo-genres a.beebo-genre-active{background:#45365a!important;color:#f4d788!important;border-color:#c39c45!important}
  .beebo-main .beebo-alphabet{position:sticky!important;top:calc(72px + env(safe-area-inset-top))!important;flex-wrap:nowrap!important;gap:0!important;overflow-x:auto;padding:5px 0!important;background:#182033f5!important;border:1px solid #354057;border-radius:10px!important;box-shadow:none!important;margin-bottom:14px!important;backdrop-filter:blur(12px)}
  .beebo-main .beebo-alphabet a,.beebo-main .beebo-alphabet span{display:grid;place-items:center;flex:0 0 40px;height:38px;padding:0!important;font-size:12px!important}.beebo-main .beebo-alphabet a{color:var(--gold)!important}.beebo-main .beebo-alphabet span{color:#65718a!important}
  .beebo-main [id^=letter-]{scroll-margin-top:138px!important}.beebo-main [id^=letter-]>h3{font-size:17px;color:#e5b94e;margin:16px 0 10px!important}
  .beebo-main .grid{grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:16px 10px}.beebo-main .card{border:0;box-shadow:none;background:transparent;border-radius:9px;overflow:visible}.beebo-main .card:hover{transform:none}.beebo-main .card>img,.beebo-main .noposter{border-radius:9px}.beebo-main .meta{padding:8px 2px}.beebo-main .title{font-size:12px;line-height:1.4;font-weight:600;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.beebo-main .sub{font-size:11px;margin-top:3px}
  .beebo-sidebar{top:auto;bottom:0;left:0;width:100%;max-height:85dvh;transform:translateY(105%);border:1px solid #4c4862;border-bottom:0;border-radius:24px 24px 0 0;padding:22px 20px calc(26px + env(safe-area-inset-bottom));background:linear-gradient(150deg,#23233c,#15243b)}
  .beebo-menu-open .beebo-sidebar{transform:translateY(0)}.beebo-sidebar nav{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}.beebo-sidebar .beebo-nav-label{grid-column:1/-1}.beebo-sidebar .beebo-nav-link{min-height:48px;font-size:12px}.beebo-sidebar .beebo-brand{padding-bottom:12px}.beebo-sidebar-foot{padding-top:18px}.beebo-sidebar .beebo-dismiss{right:18px;top:18px;min-height:44px;min-width:44px}
  .beebo-auth .beebo-main{padding-bottom:calc(30px + env(safe-area-inset-bottom))}
}
@media(max-width:359px){.beebo-main .grid{grid-template-columns:repeat(2,minmax(0,1fr))}.beebo-bottomnav a,.beebo-bottomnav button{font-size:10px}.beebo-tab-icon{width:45px}.beebo-app-heading strong{font-size:18px}.beebo-sidebar nav{grid-template-columns:1fr}}

.camp-user{background:#192c49;border:1px solid #405376;border-radius:999px;padding:7px 15px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#d1dcf0;font-size:12px}
.camp-eyebrow{font-size:10px;font-weight:700;letter-spacing:2px;color:#d4bc7c}.camp-intro{display:flex;justify-content:space-between;gap:24px;align-items:center;background:radial-gradient(ellipse at 95% 10%,#39456f,transparent 55%),linear-gradient(115deg,#1f1835,#142944);border:1px solid #474260;border-radius:19px;padding:30px 34px;margin-bottom:33px}.camp-intro h1{font-size:38px;line-height:1.12;margin:12px 0 15px}.camp-intro p{margin:0;max-width:420px;color:#c0cce0}.camp-count{text-align:center;min-width:110px;padding:22px;border-left:1px solid #ffffff20}.camp-count strong{display:block;font-size:46px;font-weight:500;line-height:1.2}.camp-count span{color:#b9c6de;font-size:12px}.camp-library-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px}.camp-library-heading h2{margin:0;font-size:21px}.camp-search-label{display:block;color:#acb6cf;font-size:12px;margin-bottom:6px}#camp-search{width:100%;max-width:520px;margin-bottom:20px}.camp-poster{position:relative;aspect-ratio:2/3;background:linear-gradient(150deg,#453058,#142b46);overflow:hidden;display:flex;flex-direction:column;justify-content:space-between;padding:16px}.camp-art{position:absolute;inset:0;width:100%;height:100%;fill:none;stroke:#d8c599;stroke-width:1;opacity:.3}.camp-art circle:first-child{fill:#ba927c;stroke:none;opacity:.4}.camp-art circle:nth-child(2){stroke-width:45;opacity:.5}.camp-cover-title{position:relative;z-index:1;font-size:clamp(18px,2vw,28px);font-weight:600;line-height:1.15;letter-spacing:-.5px;text-wrap:balance;overflow-wrap:anywhere;text-shadow:0 2px 14px #0008;margin-bottom:28px}.camp-format{position:relative;z-index:1;font-size:8px;letter-spacing:2px;color:#e5d4b2}.camp-play{position:absolute;right:12px;bottom:13px;display:grid;place-items:center;width:32px;height:32px;border:1px solid #d4af3770;border-radius:50%;background:#070e1b88;color:#ebd395;font-size:12px}.camp-palette-1 .camp-poster{background:linear-gradient(145deg,#2c4c59,#1f183b)}.camp-palette-2 .camp-poster{background:linear-gradient(160deg,#4a365b,#15264b)}.camp-palette-3 .camp-poster{background:linear-gradient(145deg,#68503b,#232440)}.camp-palette-4 .camp-poster{background:linear-gradient(150deg,#1f3956,#49304d)}.tile{text-decoration:none;color:inherit}.camp-dot{display:inline-block;width:6px;height:6px;background:#8fcfb3;border-radius:50%;margin-right:5px}.camp-note{font-size:12px;color:#a4b4cd;margin-top:24px}.camp-back{text-decoration:none;font-size:13px}.camp-watch-title{font-size:30px;line-height:1.25;margin:10px 0 22px;overflow-wrap:anywhere}.camp-player{background:#000;border:1px solid #3e4b68;border-radius:17px;overflow:hidden}.camp-player video{display:block;width:100%;max-height:75vh;min-height:180px;aspect-ratio:16/9;background:#000}.camp-player-footer{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:14px;margin-top:18px;color:#acb6cf;font-size:12px}.camp-player-footer a{text-decoration:none}.camp-welcome h1{font-size:35px;line-height:1.12;margin:13px 0 18px}.camp-welcome .sub{font-size:14px;line-height:1.65}.camp-welcome-art{height:120px;background:linear-gradient(135deg,#393050,#142c4a);border-radius:12px;margin-bottom:25px;text-align:center}.camp-welcome-art svg{height:120px;max-width:100%;stroke:#dbc491;stroke-width:1.5;fill:none}.camp-welcome-art circle{fill:#d4af3730;stroke:none}.joinform{margin-top:23px}.joinform label{display:block;font-size:13px;text-align:left;margin-bottom:8px}.joinform button{padding:12px 18px;cursor:pointer}.joinform button span{float:right}.camp-divider{border-top:1px solid #344563;padding-top:18px}
@media(max-width:600px){.camp-intro{padding:23px;gap:12px;align-items:flex-start}.camp-intro h1{font-size:29px}.camp-count{min-width:60px;padding:14px 0 0 12px}.camp-count strong{font-size:32px}.camp-count span{font-size:10px}.camp-intro p{font-size:12px}.camp-cover-title{font-size:20px}.camp-poster{padding:13px}.camp-library-heading h2{font-size:18px}.camp-watch-title{font-size:25px}.camp-player{border-radius:11px}.camp-user{max-width:135px;padding:6px 10px}}
.camp-alphabet{display:flex;gap:2px;overflow-x:auto;padding:6px;background:#182033;border-radius:10px;margin-bottom:16px}.camp-alphabet a,.camp-alphabet span{flex:0 0 32px;display:grid;place-items:center;height:36px;text-decoration:none;font-size:12px;color:#596780}.camp-alphabet a{color:#e5b94e}.camp-collection section{scroll-margin-top:40px}.camp-collection section>h3{color:#d4bc7c;margin:24px 0 14px}
@media(max-width:860px){.camp-intro{padding:16px;gap:14px;margin:0 0 20px;border-radius:13px;align-items:center}.camp-intro h1{display:none}.camp-intro p{font-size:12px;margin-top:6px;line-height:1.5}.camp-intro .camp-count{padding:0 0 0 14px;min-width:68px}.camp-count strong{font-size:26px}.camp-count span{font-size:10px}.camp-library-heading{margin-bottom:14px}.camp-library-heading h2{font-size:18px}.camp-search-label{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}.camp-poster{border-radius:9px;padding:10px}.camp-cover-title{font-size:17px;margin-bottom:23px}.camp-format{font-size:7px;letter-spacing:1px}.camp-play{width:25px;height:25px;font-size:10px;right:9px;bottom:9px}.tile .sub{display:none}.camp-user{font-size:11px;padding:5px 10px}.camp-watch-title{font-size:24px}.camp-player video{max-height:65dvh}.camp-collection section>h3{margin-top:14px}}
/* Watch together: the "playing now" shelf on the library, plus the sync strip
   and the tap-gate on the player. Same marine blue, purple and gold as the rest. */
.camp-live{margin:0 0 22px;padding:16px 18px;background:radial-gradient(ellipse at 100% 0,#3a3160,transparent 60%),linear-gradient(115deg,#1d2b49,#172038);border:1px solid #d4af37;border-radius:15px}
.camp-live h2{margin:6px 0 4px;font-size:19px}.camp-live>p{margin:0;font-size:12px}
.camp-live-list{display:flex;flex-direction:column;gap:8px;margin-top:13px}
.camp-live-row{display:flex;align-items:center;gap:12px;padding:11px 13px;background:#0f1c31;border:1px solid #34496c;border-radius:11px;text-decoration:none;color:inherit}
.camp-live-row:hover{border-color:#d4af37}
.camp-live-body{flex:1;min-width:0}
.camp-live-body strong{display:block;font-size:14px;font-weight:650;overflow-wrap:anywhere}
.camp-live-body span{display:block;margin-top:3px;font-size:11px;color:#adbbd4}
.camp-live-join{flex-shrink:0;color:#f0dda6;font-size:12px;white-space:nowrap}
.camp-live-pulse{flex-shrink:0;width:9px;height:9px;border-radius:50%;background:#8fcfb3;animation:camp-pulse 2.2s infinite}
@keyframes camp-pulse{0%{box-shadow:0 0 0 0 #8fcfb37a}70%{box-shadow:0 0 0 9px #8fcfb300}100%{box-shadow:0 0 0 0 #8fcfb300}}
.camp-player{position:relative}
.camp-gate{position:absolute;inset:0;z-index:2;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:13px;padding:24px;text-align:center;background:#070c17e8}
.camp-gate strong{font-size:19px}.camp-gate p{margin:0;max-width:330px;font-size:13px;color:#b8c5dc}
.beebo-main .camp-gate button{min-height:48px;padding:12px 26px;font-size:15px;border-radius:999px}
.camp-sync{display:flex;flex-wrap:wrap;align-items:center;gap:9px 13px;margin-top:14px;padding:12px 14px;background:#152540;border:1px solid #3e4b68;border-radius:13px;font-size:12px;color:#c6d2e8}
.camp-sync b{font-weight:600;color:#e7ecf8}.camp-sync-who{display:flex;flex-wrap:wrap;gap:6px}
.camp-viewer{display:inline-block;max-width:150px;padding:4px 10px;background:#1d2f4d;border:1px solid #3b4d70;border-radius:999px;font-size:11px;color:#d4deef;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.camp-viewer-host{border-color:#d4af37;color:#f0dda6}.camp-viewer-away{opacity:.45}
.beebo-main .camp-sync button{min-height:36px;padding:7px 13px;font-size:12px}
@media(prefers-reduced-motion:reduce){.camp-live-pulse{animation:none}}
@media(max-width:600px){.camp-live{padding:14px;border-radius:12px}.camp-live h2{font-size:17px}.camp-live-join{font-size:11px}.camp-sync{font-size:11px;padding:10px 12px}}
""".trimIndent()
    private val scripts = """

(() => {
  const menu = document.querySelector('.beebo-menu'), nav = document.getElementById('beebo-navigation');
  if (!menu || !nav) return;
  const close = nav.querySelector('.beebo-dismiss'), scrim = document.querySelector('.beebo-scrim');
  const main = document.getElementById('beebo-content'), mobile = window.matchMedia('(max-width:860px)');
  const header = document.querySelector('.beebo-mobilebar'), tabs = document.querySelector('.beebo-bottomnav');
  function toggle(open, restore) {
    document.body.classList.toggle('beebo-menu-open', open);
    menu.setAttribute('aria-expanded', String(open));
    if (main) main.inert = open;
    if (header) header.inert = open;
    if (tabs) tabs.inert = open;
    if (open) { nav.setAttribute('role', 'dialog'); nav.setAttribute('aria-modal', 'true'); }
    else { nav.removeAttribute('role'); nav.removeAttribute('aria-modal'); }
    if (open) close.focus(); else if (restore) menu.focus();
  }
  menu.addEventListener('click', () => toggle(true));
  close.addEventListener('click', () => toggle(false, true));
  scrim.addEventListener('click', () => toggle(false, true));
  mobile.addEventListener('change', () => toggle(false));
  document.addEventListener('keydown', e => {
    if (!document.body.classList.contains('beebo-menu-open')) return;
    if (e.key === 'Escape') { e.preventDefault(); toggle(false, true); }
    if (e.key === 'Tab') {
      const entries = [...nav.querySelectorAll('a,button')].filter(el => el.offsetParent !== null);
      const first = entries[0], last = entries[entries.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  // Keep the phone search in the same position as the Android Movies/TV screens.
  const search = document.getElementById('q') || document.getElementById('camp-search');
  const searchButton = document.querySelector('.beebo-search-button');
  if (search && searchButton) {
    searchButton.hidden = false;
    searchButton.addEventListener('click', () => { search.scrollIntoView({block:'center'}); search.focus({preventScroll:true}); });
  }
  if (search && search.id === 'q' && main) {
    const position = document.createComment('Search position'); search.before(position);
    function positionSearch() {
      if (mobile.matches) { const top = main.querySelector('.topbar'); if (top) top.after(search); }
      else position.after(search);
    }
    positionSearch(); mobile.addEventListener('change', positionSearch);
  }
  // Android keeps sign-out in the app bar; keep the same real link on phones.
  const logout = main && main.querySelector('.topbar a[href="/logout"]');
  if (logout && header) {
    const original = document.createComment('Sign-out position'); logout.before(original);
    const originalClass = logout.className, originalHtml = logout.innerHTML;
    function positionLogout() {
      if (mobile.matches) {
        header.append(logout); logout.classList.add('beebo-mobile-logout');
        logout.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4H4v16h5m5-12 4 4-4 4m-6-4h10"/></svg><span>Log out</span>';
      } else { original.after(logout); logout.className = originalClass; logout.innerHTML = originalHtml; }
    }
    positionLogout(); mobile.addEventListener('change', positionLogout);
  }
  // Hide empty letter groups after searching, so the A–Z index never jumps to a blank row.
  if (search) search.addEventListener(search.id === 'camp-search' ? 'beebo:filtered' : 'input', () => {
    document.querySelectorAll('[id^="letter-"]').forEach(section => {
      const cards = [...section.querySelectorAll('.card[data-name]')];
      if (!cards.length) return;
      section.hidden = cards.every(card => card.hidden || card.style.display === 'none');
      document.querySelectorAll('.beebo-alphabet a').forEach(link => {
        if (link.getAttribute('href') === '#' + section.id) {
          if (section.hidden) { link.setAttribute('aria-disabled','true'); link.setAttribute('tabindex','-1'); }
          else { link.removeAttribute('aria-disabled'); link.removeAttribute('tabindex'); }
        }
      });
    });
  });
  document.querySelectorAll('.beebo-alphabet a').forEach(link => link.addEventListener('click', e => {
    if (link.getAttribute('aria-disabled') === 'true') e.preventDefault();
  }));
})();
(() => {
 const search = document.getElementById('camp-search');
 if(search) search.addEventListener('input', () => {
   const term = search.value.trim().toLowerCase(), cards = [...document.querySelectorAll('.tile[data-name]')];
   let count = 0;
   cards.forEach(card => { card.hidden = !card.dataset.name.includes(term); if(!card.hidden) count++; });
   const status = document.getElementById('camp-results'); status.hidden = !term;
   status.textContent = count ? count + ' matching ' + (count === 1 ? 'title' : 'titles') : 'No matching titles. Try another search.';
   search.dispatchEvent(new Event('beebo:filtered'));
 });
 const video = document.getElementById('camp-video');
 if(video) video.addEventListener('error', () => { document.getElementById('camp-player-error').hidden = false; });
})();
""".trimIndent()

    /**
     * The library's "playing now" shelf. nowPlaying comes from the same snapshot
     * the player uses, so the shelf is never a second source of truth.
     */
    private val liveScript = """
(() => {
  'use strict';
  const box = document.getElementById('camp-live');
  const list = document.getElementById('camp-live-list');
  if (!box || !list) return;
  let timer = 0, fails = 0;

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function clock(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60;
    return (h > 0 ? h + ':' + pad(m) : '' + m) + ':' + pad(s);
  }

  function draw(rows) {
    list.textContent = '';
    rows.forEach(function (r) {
      const row = document.createElement('a');
      row.className = 'camp-live-row';
      row.href = '/watch?id=' + encodeURIComponent(r.video || '');
      const dot = document.createElement('span');
      dot.className = 'camp-live-pulse';
      dot.setAttribute('aria-hidden', 'true');
      const body = document.createElement('span');
      body.className = 'camp-live-body';
      const title = document.createElement('strong');
      // Everything on this row is built as text, never as markup: the host name
      // in it was typed by a guest on their own phone.
      title.textContent = r.title || 'A video';
      const sub = document.createElement('span');
      const people = r.viewers === 1 ? '1 phone' : r.viewers + ' phones';
      const where = r.state === 'playing' ? ('playing · ' + clock(r.positionMs))
        : (r.state === 'ended' ? 'finished' : ('paused · ' + clock(r.positionMs)));
      sub.textContent = where + '  ·  ' + people + (r.hostName ? '  ·  ' + r.hostName + ' has playback' : '');
      body.appendChild(title);
      body.appendChild(sub);
      const go = document.createElement('span');
      go.className = 'camp-live-join';
      go.textContent = 'Tap to join →';
      row.appendChild(dot);
      row.appendChild(body);
      row.appendChild(go);
      list.appendChild(row);
    });
    box.hidden = rows.length === 0;
  }

  function pull() {
    // Quiet on purpose. No watch party, no server, or no guest cookie yet and the
    // shelf simply is not there - the library carries on being a library.
    fetch('/api/watch', { cache: 'no-store', headers: { 'X-Beebo-Watch': '1' } })
      .then(function (r) { return r.json(); })
      .then(function (d) { fails = 0; draw((d && d.ok && d.nowPlaying) ? d.nowPlaying : []); })
      .catch(function () { fails++; if (fails > 2) box.hidden = true; })
      .then(function () {
        clearTimeout(timer);
        timer = setTimeout(pull, document.hidden ? 30000 : 6000);
      });
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { clearTimeout(timer); pull(); }
  });
  pull();
})();
""".trimIndent()

    /**
     * Guest-side watch-together. Deliberately plain: no framework, no CDN, nothing
     * to fetch - this page is served over a hotspot with no way out to the internet.
     */
    private val watchScript = """
(() => {
  'use strict';
  const video = document.getElementById('camp-video');
  const panel = document.getElementById('camp-sync');
  const gateBox = document.getElementById('camp-gate');
  if (!video || !panel || !gateBox) return;
  const videoId = panel.getAttribute('data-video') || '';
  const line = document.getElementById('camp-sync-line');
  const who = document.getElementById('camp-sync-who');
  const claimBtn = document.getElementById('camp-sync-claim');
  const joinLink = document.getElementById('camp-sync-join');
  const gateGo = document.getElementById('camp-gate-go');
  const gateText = document.getElementById('camp-gate-text');

  // --- how hard we correct, and why ---------------------------------------
  // Under an eighth of a second, two phones held side by side are the same
  // phone - and it is inside the error of our own clock estimate anyway: half a
  // round trip over a hotspot is tens of milliseconds and one frame at 24fps is
  // 41. Correcting inside that noise only makes the picture worse.
  const DEADBAND_MS = 120;
  // Past two seconds a viewer can hear that the dialogue is wrong, and closing a
  // hole that big by speeding up would take longer than the re-buffer a seek
  // costs over local Wi-Fi. So two seconds is where nudging gives up and we jump.
  const HARD_MS = 2000;
  // A deliberate host command earns a jump, but not a pointless one: if the host
  // pressed play exactly where we already are, seeking buys a black frame and
  // nothing else.
  const SNAP_MS = 250;
  // Ten percent is about the most speed a browser can pitch-correct without
  // anyone hearing it. Nudging the rate rather than writing currentTime is the
  // whole point - every write to currentTime re-buffers and shows black, so
  // fixing half a second that way looks far worse than the half second did.
  const MAX_DEV = 0.10;
  const GAIN_MS = 8000;
  const POLL_MS = 2500;
  // Nine seconds keeps us inside the engine's twelve second "online" window
  // while a pocketed phone does nothing expensive.
  const POLL_IDLE_MS = 9000;
  const TICK_MS = 500;

  let snap = null, snapAt = 0;
  let clockOffset = 0, clockRtt = 1e9, clockAt = 0, clockKnown = false;
  let lastSeq = -1, lastNote = '';
  let joined = false, gated = true, isHost = false;
  let stopped = false, hardStop = false;
  let readySent = false, seeking = false, fails = 0, tapped = false, tapFails = 0;
  let pollTimer = 0, seekTimer = 0, calls = 0;
  const tag = Math.random().toString(36).slice(2, 10);

  // Every action carries its own id because the engine remembers the last 128 and
  // skips repeats - that is what makes a retry after a dropped reply harmless.
  function actionId() { calls++; return tag + '-' + calls; }

  function serverNow() { return Date.now() + clockOffset; }

  // Keep the sample that travelled fastest: its midpoint guess is the least
  // wrong. Let a slower one take over after half a minute so a phone that slept
  // is not stuck behind one lucky old reading.
  function noteClock(serverTime, sentAt, gotAt) {
    if (!serverTime) return;
    const rtt = gotAt - sentAt;
    if (rtt < 0 || rtt > 5000) return;
    if (!clockKnown || rtt <= clockRtt || gotAt - clockAt > 30000) {
      clockOffset = serverTime - (sentAt + rtt / 2);
      clockRtt = rtt;
      clockAt = gotAt;
      clockKnown = true;
    }
  }

  function ask(body) {
    const sentAt = Date.now();
    const init = { cache: 'no-store', headers: { 'X-Beebo-Watch': '1' } };
    if (body) {
      init.method = 'POST';
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return fetch('/api/watch', init).then(function (r) {
      return r.json().then(function (j) {
        noteClock(j && j.serverTime, sentAt, Date.now());
        return { status: r.status, data: j };
      });
    });
  }

  function here() { return video.currentTime * 1000; }
  function duration() { const d = video.duration; return (d > 0 && isFinite(d)) ? d * 1000 : 0; }
  function reportState() { return video.ended ? 'ended' : (video.paused ? 'paused' : 'playing'); }

  // The shared clock is an anchor, not a ticking timer: the snapshot says where
  // the film was at the server's own clock reading, and we run it forward from
  // there. That is why a phone joining an hour in needs no special case at all.
  function expected(s) {
    let p = s.positionMs;
    if (s.state === 'playing') {
      let gone = serverNow() - snapAt;
      if (gone < 0) gone = 0;
      p += gone * (s.rate || 1);
    }
    if (s.durationMs > 0 && p > s.durationMs) p = s.durationMs;
    return p > 0 ? p : 0;
  }

  function hardSeek(ms) {
    seeking = true;
    try { video.currentTime = ms / 1000; } catch (e) {}
    try { video.playbackRate = 1; } catch (e) {}
    setTimeout(function () { seeking = false; }, 500);
  }

  function say(text) {
    if (lastNote === text) return;
    lastNote = text;
    line.textContent = text;
  }

  function render(s) {
    panel.hidden = false;
    joinLink.hidden = true;
    const people = s.viewers || [];
    let live = 0;
    people.forEach(function (v) { if (v.online) live++; });
    let text;
    if (s.note) text = s.note;
    else if (s.isHost) text = 'You are looking after playback.';
    else if (s.hostName) text = s.hostName + ' is looking after playback.';
    else text = 'Watching together.';
    say(text + '  ' + live + (live === 1 ? ' phone' : ' phones') + ' here.');
    who.textContent = '';
    people.forEach(function (v) {
      const chip = document.createElement('span');
      chip.className = 'camp-viewer' + (v.host ? ' camp-viewer-host' : '') + (v.online ? '' : ' camp-viewer-away');
      // Guest names are typed by guests. textContent, never innerHTML.
      chip.textContent = v.name + (v.host ? ' ●' : '');
      chip.title = v.ready ? '' : 'Has not tapped to join yet';
      who.appendChild(chip);
    });
    claimBtn.hidden = !s.canClaim;
  }

  // seq and revision are deliberately different animals. revision ticks when
  // somebody joins, leaves or takes playback over - news for the roster, not for
  // the picture. seq ticks only when the host actually pressed something, and
  // that is the only thing worth yanking the video for. A routine beacon moves
  // neither, so a late arrival cannot shove anybody else's film about.
  function follow(s) {
    if (s.seq !== lastSeq) {
      lastSeq = s.seq;
      if (!isHost) {
        const want = expected(s);
        if (Math.abs(want - here()) > SNAP_MS) hardSeek(want);
      }
    }
    if (isHost) return;
    if (s.state === 'playing' && video.paused && !video.ended) {
      const p = video.play();
      if (p && p.catch) p.catch(function () { openGate('Tap to pick the film back up.'); });
    } else if (s.state !== 'playing' && !video.paused) {
      video.pause();
    }
  }

  function tick() {
    if (stopped || !joined || gated || isHost || seeking || !snap) return;
    if (snap.state !== 'playing' || video.paused || video.readyState < 2) return;
    const drift = here() - expected(snap);
    const away = drift < 0 ? -drift : drift;
    if (away > HARD_MS) { hardSeek(expected(snap)); return; }
    let dev = 0;
    if (away > DEADBAND_MS) {
      dev = drift / GAIN_MS;
      if (dev > MAX_DEV) dev = MAX_DEV;
      if (dev < -MAX_DEV) dev = -MAX_DEV;
    }
    // Ahead of the party means ease off, behind means hurry up.
    const want = (snap.rate || 1) * (1 - dev);
    if (Math.abs(video.playbackRate - want) > 0.005) {
      try { video.playbackRate = want; } catch (e) {}
    }
  }

  // The gate is here because a phone browser will not make sound until the person
  // has touched the page. Until that tap this viewer is not really with everybody
  // else, so the engine holds them behind gate=true and only a posted "ready"
  // lets them in - rather than the page pretending they are in while a silent
  // video sits at zero.
  function openGate(message) {
    gateText.textContent = message || 'One tap and your phone drops in exactly where everyone else is.';
    gateBox.hidden = false;
  }

  function enterGate(s) {
    if (!video.paused && !video.ended) {
      // Autoplay was allowed here, so we already have sound rights and no tap is
      // owed. Line up and tell the server we are in.
      tapped = true;
      hardSeek(expected(s));
      sendReady();
      return;
    }
    video.pause();
    openGate('');
  }

  function sendReady() {
    if (readySent) return;
    readySent = true;
    ask({ action: 'ready', actionId: actionId() }).then(function (res) {
      readySent = false;
      apply(res);
      if (isHost && !video.paused) command('play');
    }, function () { readySent = false; lost(); });
  }

  function command(action) {
    if (!isHost || !joined || stopped) return;
    ask({
      action: action,
      actionId: actionId(),
      positionMs: Math.round(here()),
      durationMs: Math.round(duration()),
    }).then(apply, lost);
  }

  function standalone(message, permanent) {
    stopped = true;
    if (permanent) hardStop = true;
    joined = false;
    gated = false;
    gateBox.hidden = true;
    try { video.playbackRate = 1; } catch (e) {}
    clearTimeout(pollTimer);
    panel.hidden = false;
    who.textContent = '';
    claimBtn.hidden = true;
    joinLink.hidden = !permanent;
    say(message || 'Watching on your own.');
    // We may have paused this video to hold the gate. Nobody is coming to start
    // it again, so hand it back - and if the browser refuses, the ordinary
    // controls are right there under the finger.
    if (video.paused && !video.ended) {
      const p = video.play();
      if (p && p.catch) p.catch(function () {});
    }
  }

  function resume() {
    if (hardStop) return;
    stopped = false;
    joined = false;
    fails = 0;
    lastSeq = -1;
    // The server forgets that we tapped when we re-open, so we have to as well,
    // or the gate would never come back on a phone that slept through an hour.
    tapped = false;
    gateBox.hidden = true;
    schedule(150);
  }

  function lost() {
    fails++;
    // Quiet failure: the picture keeps running on whatever is buffered. We only
    // say anything once it is clearly not a blip, and we never stop the video.
    if (fails === 3) say('Lost your host for a moment. Still trying.');
    if (fails > 20) standalone('Watching on your own.', false);
  }

  function apply(res) {
    const data = (res && res.data) || {};
    if (!data.ok) {
      // 401 means this browser never joined the campsite at all, so there is
      // nothing to retry - offer the way in and let the film play meanwhile.
      if (res && res.status === 401) { standalone('Watching on your own.', true); return; }
      joined = false;
      fails++;
      if (fails > 5) standalone(data.error || 'Watching on your own.', false);
      else say(data.error || 'Finding your watch party.');
      return;
    }
    fails = 0;
    snapAt = data.serverTime || serverNow();
    const s = data.session;
    if (!s) { joined = false; say('Starting a watch party.'); return; }
    snap = s;
    joined = true;
    isHost = !!s.isHost;
    gated = !!s.gate;
    render(s);
    if (gated) { if (gateBox.hidden) enterGate(s); return; }
    gateBox.hidden = true;
    follow(s);
  }

  function wait() {
    if (document.hidden) return POLL_IDLE_MS;
    if (!fails) return POLL_MS;
    const backoff = POLL_MS * fails;
    return backoff > 10000 ? 10000 : backoff;
  }

  function schedule(ms) { clearTimeout(pollTimer); pollTimer = setTimeout(poll, ms); }

  function poll() {
    if (stopped) return;
    // A beacon answers with a snapshot, so one request per cycle does both jobs.
    // Only the host's beacon moves the shared clock; ours just reports where we
    // are so the host can see who is lagging.
    const body = joined
      ? {
          action: 'beacon',
          actionId: actionId(),
          positionMs: Math.round(here()),
          durationMs: Math.round(duration()),
          state: reportState(),
        }
      : { action: 'open', video: videoId, actionId: actionId() };
    ask(body).then(apply, lost).then(function () { schedule(wait()); });
  }

  gateGo.addEventListener('click', function () {
    gateBox.hidden = true;
    tapped = true;
    if (snap) hardSeek(expected(snap));
    // play() has to be called inside the tap itself for the gesture to count.
    const p = video.play();
    if (p && p.then) {
      p.then(function () { tapFails = 0; gated = false; sendReady(); }, function () {
        tapFails++;
        // Never loop on a gate the browser will not open. After a second refusal
        // we get out of the way and leave the ordinary controls to it, rather
        // than showing the same overlay for ever.
        if (tapFails >= 2) standalone('Watching on your own - this browser would not start the sound.', false);
        else openGate('Tap again to start the sound.');
      });
    } else {
      gated = false;
      sendReady();
    }
  });

  claimBtn.addEventListener('click', function () {
    ask({ action: 'claim', actionId: actionId() }).then(apply, lost);
  });

  // The element keeps its autoplay attribute so that a browser with no working
  // sync still just plays the film. That means it can start itself while the gate
  // is still up, an hour adrift and out loud - so until this viewer has actually
  // tapped, put it back down.
  video.addEventListener('play', function () {
    if (!tapped && gated) { video.pause(); return; }
    if (isHost && !gated) command('play');
  });
  video.addEventListener('pause', function () { if (isHost && !gated && !video.ended) command('pause'); });
  video.addEventListener('ended', function () { if (isHost) command('end'); });
  video.addEventListener('seeked', function () {
    if (!isHost || gated || seeking) return;
    // Scrubbing fires a burst of these and every one would bump seq and yank
    // every other phone. Wait for the thumb to settle, then send one command.
    clearTimeout(seekTimer);
    seekTimer = setTimeout(function () { command('seek'); }, 400);
  });

  window.addEventListener('pagehide', function () {
    if (!joined) return;
    joined = false;
    // keepalive rather than sendBeacon: sendBeacon cannot set the header this
    // endpoint insists on. If it never lands, the engine's 90 second grace
    // tidies us away instead.
    try {
      fetch('/api/watch', {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', 'X-Beebo-Watch': '1' },
        body: JSON.stringify({ action: 'leave', actionId: actionId() }),
      }).catch(function () {});
    } catch (e) {}
  });

  window.addEventListener('pageshow', function (e) {
    // Restored from the back/forward cache: we told the server we had gone, so
    // ask for a seat again rather than sitting on a stale roster.
    if (e.persisted) resume();
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    if (stopped) resume();
    else { fails = 0; schedule(150); }
  });

  setInterval(tick, TICK_MS);
  panel.hidden = false;
  say('Looking for a watch party.');
  schedule(0);
})();
""".trimIndent()
}
