package com.beeboentertainment.movie.campsite

import android.annotation.SuppressLint
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.campsite.games.CampsiteGame
import com.beeboentertainment.movie.campsite.games.CampsiteGameCatalog
import com.beeboentertainment.movie.campsite.games.CampsiteHistoryStore
import com.beeboentertainment.movie.campsite.games.GameCategory
import com.beeboentertainment.movie.campsite.games.SoloGame
import com.beeboentertainment.movie.campsite.solo.SoloGameScreen
import com.beeboentertainment.movie.core.TvFeatures
import com.beeboentertainment.movie.trip.TripStore
import com.beeboentertainment.movie.trip.TripStoreSink

/**
 * The host's Games section.
 *
 * Opening it starts nothing. With Campsite stopped, a game opens on this phone against the
 * computer through [CampsiteLocalGames] - no server, no hotspot, no permission prompt - and
 * leaving puts it all away. "Invite players" is the only way from here to a running guest
 * server, and it goes to the Campsite screen where the host picks how guests get on the Wi-Fi.
 * Once players are invited, games open in the room the guests share.
 */
@Composable
fun GuestGamesScreen(onOpenCampsite: () -> Unit) {
    val campsite by CampsiteHost.state.collectAsState()
    var localGame by rememberSaveable { mutableStateOf<String?>(null) }
    // Campfire activities (Sep 16): games with their own offline screen on this phone.
    var nativeGame by rememberSaveable { mutableStateOf<String?>(null) }
    // A solo puzzle (Five Letters, Sudoku...) open on this phone. Never touches the network.
    var soloGame by rememberSaveable { mutableStateOf<String?>(null) }
    var sharedRoom by rememberSaveable { mutableStateOf(false) }
    var asking by remember { mutableStateOf<CampsiteGame?>(null) }
    // Android TV: Campsite Mode (hotspots, the phone's own screen) stays phone-only, so the TV
    // shows its joining code here instead of opening that screen.
    val isTv = com.beeboentertainment.movie.ui.tv.LocalIsTv.current
    var tvCodes by rememberSaveable { mutableStateOf(false) }
    val showCodes: () -> Unit = if (isTv) ({ tvCodes = true }) else onOpenCampsite

    val invite = {
        asking = null
        if (isTv) {
            // The guest server on the Wi-Fi the TV is already on. Never a hotspot.
            CampsiteInvite.invitePlayersOnTv()
            tvCodes = true
        } else {
            CampsiteInvite.invitePlayers()
            onOpenCampsite()
        }
    }

    BackHandler(enabled = localGame != null || nativeGame != null || sharedRoom || soloGame != null || tvCodes) {
        localGame = null
        nativeGame = null
        soloGame = null
        sharedRoom = false
        tvCodes = false
    }

    val playing = localGame
    val native = nativeGame
    val solo = soloGame
    when {
        native != null -> com.beeboentertainment.movie.campsite.campfire.CampfireLocalScreen(native, onBack = { nativeGame = null })
        solo != null -> SoloGameScreen(gameId = solo, onBack = { soloGame = null })
        playing != null -> LocalGamesView(gameId = playing, onBack = { localGame = null })
        tvCodes && isTv -> TvInviteCodes(
            state = campsite,
            onOpenRoom = { tvCodes = false; sharedRoom = true },
            onStop = { CampsiteInvite.stop(); tvCodes = false },
            onBack = { tvCodes = false },
        )
        sharedRoom && campsite.running -> SharedGamesView(
            port = campsite.port,
            onShowCodes = showCodes,
            onBack = { sharedRoom = false },
        )
        else -> GamesList(
            running = campsite.running,
            guests = campsite.guests.size,
            onInvite = invite,
            onShowCodes = showCodes,
            onOpenShared = { sharedRoom = true },
            onPick = { asking = it },
            onPickSolo = { soloGame = it.id },
        )
    }

    asking?.let { game ->
        val choices = CampsiteGameGate.choicesFor(game.needsGuests, campsite.running)
        AlertDialog(
            onDismissRequest = { asking = null },
            title = { Text(game.title) },
            text = {
                Column {
                    Text(game.blurb)
                    if (game.needsGuests && !campsite.running) {
                        Spacer(Modifier.height(8.dp))
                        Text(
                            "This one needs other phones. Invite players and they join from their browser - no app needed.",
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            fontSize = 14.sp,
                        )
                    }
                }
            },
            confirmButton = {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    choices.forEach { choice ->
                        when (choice) {
                            GameChoice.PLAY_VS_COMPUTER -> Button(onClick = {
                                asking = null
                                if (game.localRoute != null) nativeGame = game.localRoute else localGame = game.id
                            }) { Text(if (game.localRoute != null || game.playsSolo) "Play on this phone" else "Play vs computer") }
                            GameChoice.INVITE_PLAYERS ->
                                if (choices.size == 1) Button(onClick = invite) { Text("Invite players") }
                                else OutlinedButton(onClick = invite) { Text("Invite players") }
                            GameChoice.PLAY_WITH_GUESTS -> Button(onClick = {
                                asking = null
                                sharedRoom = true
                            }) { Text("Open with guests") }
                        }
                    }
                }
            },
            dismissButton = { TextButton(onClick = { asking = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun GamesList(
    running: Boolean,
    guests: Int,
    onInvite: () -> Unit,
    onShowCodes: () -> Unit,
    onOpenShared: () -> Unit,
    onPick: (CampsiteGame) -> Unit,
    onPickSolo: (SoloGame) -> Unit,
) {
    var filter by rememberSaveable { mutableStateOf<String?>(null) }
    val only = filter?.let { name -> GameCategory.values().firstOrNull { it.name == name } }
    // Android TV: only games whose host side a remote can run - no touch screen, camera or
    // passing the device round (TvFeatures.gameListed). Games that need other phones are listed:
    // the TV invites them over its Wi-Fi. Phones list everything.
    val isTv = com.beeboentertainment.movie.ui.tv.LocalIsTv.current
    val games = remember(isTv) {
        CampsiteGameCatalog.ALL.filter { TvFeatures.gameListed(it.showOnTv, isTv) }
    }
    val solos = remember(isTv) {
        CampsiteGameCatalog.SOLO.filter { TvFeatures.gameListed(it.showOnTv, isTv) }
    }
    // Solo puzzles are merged into the same sections, alphabetically with everything else.
    val all = remember(isTv) {
        val used = CampsiteGameGate.sections(games).map { it.first }.toSet() +
            solos.map { it.category }
        GameCategory.values().filter { it in used }.map { it to Unit }
    }
    val sections = remember(only, isTv) {
        GameCategory.values().filter { only == null || it == only }.map { category ->
            val rows: List<Any> = games.filter { it.category == category } +
                solos.filter { it.category == category }
            category to rows.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) {
                if (it is SoloGame) it.title else (it as CampsiteGame).title
            })
        }.filter { it.second.isNotEmpty() }
    }
    val muted = MaterialTheme.colorScheme.onSurfaceVariant

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("Games", style = MaterialTheme.typography.headlineMedium)

        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                if (running) {
                    Text("Players are invited", fontWeight = FontWeight.SemiBold)
                    Text(
                        (if (guests == 1) "1 phone connected" else "$guests phones connected") +
                            ". Games open in the room your guests share.",
                        fontSize = 13.sp, color = muted,
                    )
                    Spacer(Modifier.height(10.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = onOpenShared) { Text("Open the game room") }
                        OutlinedButton(onClick = onShowCodes) { Text("Joining codes") }
                    }
                } else if (isTv) {
                    Text("Play on this TV", fontWeight = FontWeight.SemiBold)
                    Text(
                        "Play against the computer, or invite phones on this Wi-Fi: they scan a code and play in their browser.",
                        fontSize = 13.sp, color = muted,
                    )
                    Spacer(Modifier.height(10.dp))
                    OutlinedButton(onClick = onInvite) { Text("Invite players") }
                } else {
                    Text("Play on this phone", fontWeight = FontWeight.SemiBold)
                    Text(
                        "Everything here works offline against the computer. Nothing is shared and no Wi-Fi is switched on until you invite players.",
                        fontSize = 13.sp, color = muted,
                    )
                    Spacer(Modifier.height(10.dp))
                    OutlinedButton(onClick = onInvite) { Text("Invite players") }
                }
            }
        }

        // Filter chips. Focusable like every other control, so a TV remote can walk them.
        Row(
            Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            FilterChip(selected = only == null, onClick = { filter = null }, label = { Text("All") })
            all.forEach { (category, _) ->
                FilterChip(
                    selected = only == category,
                    onClick = { filter = if (only == category) null else category.name },
                    label = { Text(category.chip) },
                )
            }
        }

        sections.forEach { (category, games) ->
            Text(
                category.title,
                fontSize = 20.sp,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.padding(top = 10.dp),
            )
            games.forEach { game ->
                if (game is SoloGame) SoloRow(game, onPickSolo) else GameRow(game as CampsiteGame, running, onPick)
            }
        }
    }
}

/**
 * Android TV's joining screen: the guest server is already running on the TV's own Wi-Fi, so
 * this is just the big code, who has joined, and the way into the room. No hotspot choices.
 */
@Composable
private fun TvInviteCodes(
    state: CampsiteHost.State,
    onOpenRoom: () -> Unit,
    onStop: () -> Unit,
    onBack: () -> Unit,
) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("Invite players", style = MaterialTheme.typography.headlineMedium)
        Text(
            "Everyone's already on the same Wi-Fi as this TV. Scan the code with a phone's camera, type a name, and play in the browser - no app needed.",
            fontSize = 14.sp, color = muted,
        )
        val url = state.url
        when {
            !state.running -> Text("Starting…", fontSize = 14.sp, color = muted)
            url == null -> Text(
                "This TV can't see a local network address yet. Check it's connected to Wi-Fi or Ethernet, and the code will appear.",
                fontSize = 14.sp, color = MaterialTheme.colorScheme.error,
            )
            else -> {
                val qr = remember(url) { qrBitmap(url, 720) }
                if (qr != null) {
                    androidx.compose.foundation.Image(
                        qr.asImageBitmap(), contentDescription = "Join code", modifier = Modifier.size(260.dp),
                    )
                }
                Text("Or open", fontSize = 13.sp, color = muted)
                Text(url, fontWeight = FontWeight.Bold, fontSize = 18.sp)
                Text(
                    "Some public and hotel Wi-Fi keeps devices from seeing each other. If the code won't open on a phone, play on a phone's own Beebo app instead.",
                    fontSize = 12.sp, color = muted,
                )
            }
        }
        Text(
            if (state.guests.isEmpty()) "No one has joined yet."
            else "Joined (${state.guests.size}): " + state.guests.joinToString(", "),
            fontSize = 14.sp,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = onOpenRoom, enabled = state.running) { Text("Open the game room") }
            OutlinedButton(onClick = onBack) { Text("← Games") }
            TextButton(onClick = onStop) { Text("Stop inviting") }
        }
    }
}

/** A solo puzzle: opens straight away on this phone, whether or not players are invited. */
@Composable
private fun SoloRow(game: SoloGame, onPick: (SoloGame) -> Unit) {
    Card(
        Modifier
            .fillMaxWidth()
            .clickable { onPick(game) },
    ) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            GameArtwork(game.id, Modifier.width(88.dp).height(52.dp))
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(game.title, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                Text(game.blurb, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Spacer(Modifier.width(10.dp))
            Surface(shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.surfaceVariant) {
                Text("Solo", fontSize = 11.sp, modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp))
            }
        }
    }
}

@Composable
private fun GameRow(game: CampsiteGame, running: Boolean, onPick: (CampsiteGame) -> Unit) {
    Card(
        Modifier
            .fillMaxWidth()
            .clickable { onPick(game) },
    ) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            if (game.id != "seabattle") {
                GameArtwork(game.id, Modifier.width(88.dp).height(52.dp))
                Spacer(Modifier.width(12.dp))
            }
            Column(Modifier.weight(1f)) {
                Text(game.title, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                Text(game.blurb, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (!running) {
                Spacer(Modifier.width(10.dp))
                val needs = game.needsGuests
                Surface(
                    shape = MaterialTheme.shapes.small,
                    color = if (needs) MaterialTheme.colorScheme.secondaryContainer
                    else MaterialTheme.colorScheme.surfaceVariant,
                ) {
                    Text(
                        CampsiteGameGate.labelFor(needs, game.playsSolo),
                        fontSize = 11.sp,
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                    )
                }
            }
        }
    }
}

/** A campsite game on this phone only: the engine in-process, the page bridged to it. */
@SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
@Composable
private fun LocalGamesView(gameId: String, onBack: () -> Unit) {
    val context = LocalContext.current
    val engine = remember(gameId) {
        CampsiteLocalGames(
            trivia = { runCatching { CampsiteHost.triviaQuestions() }.getOrDefault(emptyList()) },
            // Same saved leaderboard as the guest room, so a win against the computer counts.
            history = CampsiteHistoryStore(BeeboApp.instance.session),
            trip = TripStoreSink(TripStore.forApp(BeeboApp.instance.session.plain)),
            plates = com.beeboentertainment.movie.campsite.platehunt.PlatePrefsBadgeSink(BeeboApp.instance.session.plain),
        ).also { it.open(gameId, withComputer = true) }
    }
    val web = remember(engine) {
        WebView(context).apply {
            settings.javaScriptEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.domStorageEnabled = false
            addJavascriptInterface(LocalBridge(engine), CampsiteLocalGames.BRIDGE)
            // Nothing on this page may go anywhere: the bridge is its whole world.
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean = true
            }
            val html = CampsitePagePacks.gamesPage(context.assets)
            loadDataWithBaseURL(CampsiteLocalGames.BASE_URL, CampsiteLocalGames.page(html), "text/html", "utf-8", null)
        }
    }
    DisposableEffect(web) {
        onDispose {
            web.stopLoading()
            web.removeJavascriptInterface(CampsiteLocalGames.BRIDGE)
            web.destroy()
            engine.close()
        }
    }
    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedButton(onClick = onBack) { Text("← Games") }
            Spacer(Modifier.width(12.dp))
            Text("On this phone · no Wi-Fi needed", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        AndroidView(factory = { web }, modifier = Modifier.fillMaxWidth().weight(1f))
    }
}

/** What the page's `fetch('/api/games')` calls instead of the network. Runs on a WebView thread. */
private class LocalBridge(private val engine: CampsiteLocalGames) {
    @JavascriptInterface fun get(): String = engine.get()
    @JavascriptInterface fun post(body: String): String = engine.post(body)
}

/** The room the invited guests share, served by the running Campsite server. */
@SuppressLint("SetJavaScriptEnabled", "JavascriptInterface") // CampsiteNarrator's methods are annotated; lint only sees the inferred generic type
@Composable
private fun SharedGamesView(port: Int, onShowCodes: () -> Unit, onBack: () -> Unit) {
    val context = LocalContext.current
    val base = "http://127.0.0.1:$port"
    // The host phone narrates the party games (Campfire Werewolf) and can open the invite
    // screen from a "Needs other phones" lobby. Guests' browsers have no such bridge.
    val codes by rememberUpdatedState(onShowCodes)
    val narrator = remember { CampsiteNarrator(context) { codes() } }
    DisposableEffect(narrator) { onDispose { narrator.release() } }
    val web = remember(base) { WebView(context).apply {
        addJavascriptInterface(narrator, "BeeboHost")
        settings.javaScriptEnabled = true
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.domStorageEnabled = false
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean =
                request?.url?.let { it.scheme != "http" || it.host != "127.0.0.1" || it.port != port } ?: true
        }
        loadUrl("$base/join?name=Host&next=games")
    } }
    DisposableEffect(web) { onDispose { web.stopLoading(); web.destroy() } }
    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedButton(onClick = onBack) { Text("← Games") }
            Spacer(Modifier.width(8.dp))
            TextButton(onClick = onShowCodes) { Text("Show guest joining QR codes") }
        }
        AndroidView(factory = { web }, modifier = Modifier.fillMaxWidth().weight(1f))
    }
}
