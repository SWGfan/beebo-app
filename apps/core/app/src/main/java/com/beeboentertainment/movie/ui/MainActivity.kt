package com.beeboentertainment.movie.ui

import android.Manifest
import androidx.compose.material3.TextButton
import androidx.compose.material3.AlertDialog
import androidx.compose.ui.Alignment
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.Spacer
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material.icons.filled.Shuffle
import androidx.compose.material.icons.filled.SportsEsports
import androidx.compose.material.icons.filled.Tv
import androidx.compose.material.icons.filled.VideoLibrary
import androidx.compose.material.icons.filled.Wifi
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import android.content.Intent
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.beeboentertainment.movie.hub.HubAuth
import com.beeboentertainment.movie.hub.HubException
import com.beeboentertainment.movie.sources.AddSourceScreen
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.core.content.ContextCompat
import androidx.navigation.NavDestination.Companion.hierarchy
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.MainNav
import com.beeboentertainment.movie.core.BrowseFilter
import com.beeboentertainment.movie.core.BrowseLogic
import com.beeboentertainment.movie.core.LibrarySection
import com.beeboentertainment.movie.core.NavTip
import com.beeboentertainment.movie.music.musicRoutes
import com.beeboentertainment.movie.ui.screens.BrowseScreen
import com.beeboentertainment.movie.ui.screens.ContinueMode
import com.beeboentertainment.movie.ui.screens.MoreScreen
import com.beeboentertainment.movie.ui.screens.PlayScreen
import com.beeboentertainment.movie.ui.screens.RewardsScreen
import com.beeboentertainment.movie.ui.screens.OfficialFreeTvScreen
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Card
import androidx.compose.runtime.saveable.rememberSaveable
import com.beeboentertainment.movie.ui.admin.AdminScreen
import com.beeboentertainment.movie.ui.screens.ActorScreen
import com.beeboentertainment.movie.ui.screens.CollectionScreen
import com.beeboentertainment.movie.ui.screens.ContinueScreen
import com.beeboentertainment.movie.ui.screens.DemoLibraryScreen
import com.beeboentertainment.movie.ui.screens.SetupScreen
import com.beeboentertainment.movie.ui.screens.SurfScreen
import com.beeboentertainment.movie.ui.screens.TvEpisodesScreen
import com.beeboentertainment.movie.ui.theme.BeeboEntertainmentTheme
import com.beeboentertainment.movie.ui.tv.DpadTextField
import com.beeboentertainment.movie.ui.tv.LocalIsTv
import com.beeboentertainment.movie.ui.tv.NotAvailableOnTv
import com.beeboentertainment.movie.core.TvFeatures
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester

/**
 * Single Compose host for everything except playback.
 *
 * AppCompatActivity (not plain ComponentActivity) so the window carries an AppCompat theme,
 * which androidx MediaRouteButton — the Cast button in the top bar — requires.
 */
class MainActivity : AppCompatActivity() {

    companion object {
        /** Set by the player's "📺 All episodes" action to jump straight into a show. */
        const val EXTRA_OPEN_SHOW_KEY = "open_show_key"

        /** Set by the Space Saver backup notification so a tap lands on the Space Saver screen. */
        const val EXTRA_OPEN_SPACE_SAVER = "open_space_saver"

        /**
         * Set by the BeeboBook "story voices ready" notification. Carries the book's slug so a
         * tap opens Story Mode on that exact book rather than merely reopening the app.
         */
        const val EXTRA_OPEN_STORY = "open_story_slug"
    }

    /** Observed by the nav host so an incoming intent can drive navigation. */
    private val pendingShowKey = androidx.compose.runtime.mutableStateOf<String?>(null)

    /** Bumped on every resume so the admin check re-runs — an admin flag can be revoked remotely. */
    private val resumeTick = androidx.compose.runtime.mutableStateOf(0)

    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* best effort */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        // Android 16 (targetSdk 36) removed the edge-to-edge opt-out, so the window
        // draws behind the status and navigation bars whether we ask for it or not.
        // Opting in here means every Android version lays out the same way, so what
        // we test on an older phone is what a Pixel on 16 will show.
        // Material3's Scaffold/TopAppBar/NavigationBar already inset themselves, and
        // the NavHost sits inside Scaffold's padding, so nothing else has to change.
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        askForNotificationPermission()
        pendingShowKey.value = intent?.getStringExtra(EXTRA_OPEN_SHOW_KEY)
        com.beeboentertainment.movie.tvpair.TvLinkRequests.offer(intent?.dataString)
        // beebo://pair from the QR code on the computer (cold start): the sign-in screen pre-fills from it.
        com.beeboentertainment.movie.core.PairRequests.offer(intent?.dataString)
        // Android TV / Google TV: bring the home screen's "Continue watching" row up to date.
        if (com.beeboentertainment.movie.voice.WatchNextSync.supported(this)) {
            lifecycleScope.launch {
                com.beeboentertainment.movie.voice.WatchNextSync.refresh(this@MainActivity, force = true)
            }
        }
        // A tap on the music notification asks for Now Playing (MusicNavEffects follows this).
        com.beeboentertainment.movie.music.MusicPlayer.noteIntent(intent)
        com.beeboentertainment.movie.distribution.DistributionFeatures.requestStory(intent?.getStringExtra(EXTRA_OPEN_STORY))
        setContent {
            BeeboEntertainmentTheme {
                Surface(color = MaterialTheme.colorScheme.background) {
                    BeeboAppRoot(pendingShowKey, resumeTick)
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        resumeTick.value = resumeTick.value + 1
    }

    /** The player finishes into this Activity with CLEAR_TOP, so the key arrives here. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        intent.getStringExtra(EXTRA_OPEN_SHOW_KEY)?.let { pendingShowKey.value = it }
        com.beeboentertainment.movie.tvpair.TvLinkRequests.offer(intent.dataString)
        com.beeboentertainment.movie.core.PairRequests.offer(intent.dataString)
        com.beeboentertainment.movie.music.MusicPlayer.noteIntent(intent)
        com.beeboentertainment.movie.distribution.DistributionFeatures.requestStory(intent.getStringExtra(EXTRA_OPEN_STORY))
    }

    /** Download progress notifications need runtime consent from Android 13. */
    private fun askForNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val granted = ContextCompat.checkSelfPermission(
                this, Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED
            if (!granted) notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }
}

/**
 * Shown in place of a library tab when someone is looking around without a
 * server. It says plainly why the tab is empty and what would fill it, rather
 * than letting the screen fail a network call and show a red error - an empty
 * shelf is a fact about their setup, not a fault.
 */
@Composable
private fun DemoNotice(what: String) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Text("\uD83D\uDCFA", fontSize = 44.sp)
        Spacer(Modifier.height(10.dp))
        Text("$what lives on your own computer", fontSize = 19.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(10.dp))
        Text(
            "You're looking around without a Beebo server, so there is nothing here yet \u2014 " +
                "Beebo only ever shows the video files that are already on your own PC. " +
                "Install Beebo on a Windows computer, point it at your movie folders, and your " +
                "library appears here.",
            fontSize = 14.sp,
            textAlign = TextAlign.Center,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Spacer(Modifier.height(18.dp))
        Text(
            "Everything else in the app works right now \u2014 try the road-trip games, " +
                "Campsite Mode, the Star Chart and the packing list.",
            fontSize = 13.sp,
            textAlign = TextAlign.Center,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}

private sealed class Tab(val route: String, val label: String, val icon: ImageVector) {
    /** Continue watching first, then Up next and the discovery shelves; "Surprise me" (Surf). */
    data object Home : Tab(MainNav.HOME, "Home", Icons.Filled.Home)
    /** Films and shows together: All / Films / Shows, genres, A-Z and one search. */
    data object Browse : Tab(MainNav.BROWSE, "Browse", Icons.Filled.Movie)
    /** Watchlist, Favourites, History and Downloads, with Clear…. */
    data object Library : Tab(MainNav.LIBRARY, "Library", Icons.Filled.VideoLibrary)
    /** Campsite games, Invite players, Outdoors (and Stories in the website build). */
    data object Play : Tab(MainNav.PLAY, "Play", Icons.Filled.SportsEsports)
    /** Settings, account, tools, the owner's area, Wi-Fi, help and the version. */
    data object More : Tab(MainNav.MORE, "More", Icons.Filled.MoreHoriz)
}

/** Route for "this actor's other titles"; the name is only carried through for the heading. */
private fun actorRoute(personId: Int, personName: String): String =
    "actor/$personId/" + java.net.URLEncoder.encode(personName.ifBlank { "Actor" }, "UTF-8")

/** Route for the 🔗 franchise badge on a movie poster. */
private fun collectionRoute(collectionId: Int, collectionName: String): String =
    "collection/$collectionId/" +
        java.net.URLEncoder.encode(collectionName.ifBlank { "Collection" }, "UTF-8")

/** Home · Browse · Library · Play · More, in [MainNav.BOTTOM_TABS] order (phone bar and TV rail). */
private val TABS = listOf(Tab.Home, Tab.Browse, Tab.Library, Tab.Play, Tab.More)
    .also { tabs -> check(tabs.map { it.route } == MainNav.BOTTOM_TABS) }

/** Route of a show's episode list. */
private fun showRoute(key: String): String = "show/" + java.net.URLEncoder.encode(key, "UTF-8")

/**
 * A route that needs a phone (hotspot, sensors, the camera roll). On a TV its screen is replaced
 * by a plain notice; the entry points are hidden too, so this only catches a stray deep link.
 */
@Composable
private fun PhoneOnly(route: String, content: @Composable () -> Unit) {
    val name = TvFeatures.phoneOnlyName(route)
    if (LocalIsTv.current && name != null) NotAvailableOnTv(name) else content()
}

/**
 * Top-level routing. Three gates in order:
 *   no server address -> setup, no token -> login, otherwise -> the tabbed browser.
 * A 401 from anywhere calls onUnauthorized, which clears the token and drops back to login.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BeeboAppRoot(
    pendingShowKey: androidx.compose.runtime.MutableState<String?> =
        androidx.compose.runtime.mutableStateOf(null),
    resumeTick: androidx.compose.runtime.State<Int> =
        androidx.compose.runtime.mutableStateOf(0)
) {
    val app = BeeboApp.instance

    // Auto-login on relaunch: if a token was persisted we go straight to the library.
    var stage by remember {
        mutableStateOf(
            when {
                // Demo mode deliberately outranks the server checks: someone who
                // chose "look around without a server" must not be thrown back to
                // the setup screen every time they reopen the app.
                app.session.demoMode && !app.session.isLoggedIn -> "main"
                !app.session.hasServer -> "setup"
                // name.beebo.tv with no way to sign in to it (a restart on a phone whose keystore
                // can't keep the password, or a sign-in that was forgotten): ask again first.
                com.beeboentertainment.movie.core.UrlUtils.beeboTvName(app.session.baseUrl)
                    ?.let { !com.beeboentertainment.movie.rtc.RemoteAccess.canConnect(it) } == true -> "setup"
                !app.session.isLoggedIn -> "login"
                else -> "main"
            }
        )
    }

    // Whether this launch went straight into the app, i.e. it was set up before this version.
    val startedSetUp = remember { stage == "main" }

    when (stage) {
        "setup" -> SetupScreen(
            onServerAccepted = {
                app.session.demoMode = false
                stage = if (app.session.isLoggedIn) "main" else "login"
            },
            onExploreWithoutServer = {
                app.session.demoMode = true
                stage = "main"
            }
        )

        // One sign-in screen for everything: signing in again after a sign-out or an expired
        // session uses the same Home / Username / Password screen as the first time.
        "login" -> SetupScreen(
            onServerAccepted = {
                app.session.demoMode = false
                stage = if (app.session.isLoggedIn) "main" else "login"
            },
            onExploreWithoutServer = {
                app.session.demoMode = true
                stage = "main"
            }
        )

        else -> {
            val navController = rememberNavController()
            val backStackEntry by navController.currentBackStackEntryAsState()
            val currentRoute = backStackEntry?.destination?.route
            // Android TV: tabs move to a left-hand rail, and phone-only actions are hidden.
            val isTv = LocalIsTv.current
            val railFocus = remember { FocusRequester() }
            if (isTv) {
                // Start with the remote on the rail so the first press does something; Home then
                // moves focus to the first Continue row once it has one.
                LaunchedEffect(Unit) { runCatching { railFocus.requestFocus() } }
            }

            // Browse's switch, a pending "focus the search box", and Library's section live here so
            // the top bar's search icon and old routes (Movies, TV, Downloads) can set them.
            var browseFilterName by rememberSaveable { mutableStateOf(BrowseFilter.ALL.name) }
            var focusBrowseSearch by rememberSaveable { mutableStateOf(false) }
            var librarySectionName by rememberSaveable { mutableStateOf(LibrarySection.WATCHLIST.name) }
            // Request a title, prefilled by a Browse search that found nothing.
            var requestPrefill by rememberSaveable { mutableStateOf("") }
            var requestPrefillKind by rememberSaveable { mutableStateOf(BrowseFilter.ALL.name) }

            // The one-time "new layout" tip: only for someone who used the old layout.
            val tipStore = remember { com.beeboentertainment.movie.data.SharedPrefsKeyValueStore(app.session.plain) }
            var showNavTip by remember { mutableStateOf(NavTip.shouldShow(tipStore, hadOldLayout = startedSetUp)) }

            fun goToTab(tab: Tab) {
                // Only carry tab state across when we're actually ON a tab.
                // Campsite Mode (and Star Chart, Nearby, an actor page...) get
                // pushed onto the current tab's stack. If we save/restore from
                // one of those, the tab's saved stack has that screen on top and
                // restoreState drops us straight back onto it - which looks
                // exactly like the tab button being dead.
                val here = backStackEntry?.destination?.route
                val onATab = TABS.any { it.route == here }
                navController.navigate(tab.route) {
                    popUpTo(navController.graph.findStartDestination().id) {
                        saveState = onATab
                    }
                    launchSingleTop = true
                    restoreState = onATab
                }
            }

            /**
             * An old layout's route came back (restored after the update, or a stale link): select
             * what it meant and replace the whole stack with its new home, so Back can never land
             * on the old route and bounce here again.
             */
            fun forwardLegacy(route: String) {
                val migration = MainNav.migrate(route, isTv) ?: return
                migration.browseFilter?.let { browseFilterName = it.name }
                migration.librarySection?.let { librarySectionName = it.name }
                navController.navigate(MainNav.HOME) {
                    popUpTo(navController.graph.id) { inclusive = true }
                }
                // Home sits underneath, as it does for any tab, so Back behaves normally.
                if (migration.route != MainNav.HOME) navController.navigate(migration.route) {
                    popUpTo(navController.graph.findStartDestination().id)
                    launchSingleTop = true
                }
            }

            var confirmSignOut by remember { mutableStateOf(false) }

            val onUnauthorized: () -> Unit = {
                app.session.logout()
                // Never let one account's cached catalog or Continue list show up under the
                // next sign-in on this device.
                com.beeboentertainment.movie.data.CatalogCache.clear()
                com.beeboentertainment.movie.data.ContinueCache.clear(app.session.plain)
                // The home shelves are personal too: "because you watched" is one account's
                // history, and it must not greet the next person to sign in on this phone.
                com.beeboentertainment.movie.data.ShelfCache.clear()
                stage = "login"
            }

            /*
             * Whether this account is an admin comes from the SERVER, re-checked on every resume.
             * It is deliberately not sticky: an admin flag removed on the PC makes the owner's
             * entry in More disappear the next time the app comes to the foreground, and the API
             * refuses the routes anyway. A failed check keeps the last known answer rather than
             * flickering the section away on a dropped connection.
             */
            var isAdmin by remember { mutableStateOf(app.session.isAdmin) }
            LaunchedEffect(resumeTick.value) {
                val fresh = runCatching { app.api.me() }.getOrNull()?.user?.isAdmin
                val resolved = com.beeboentertainment.movie.core.AdminGate.resolveIsAdmin(fresh, app.session.isAdmin)
                app.session.isAdmin = resolved
                isAdmin = resolved
            }

            // The "story voices ready" notification lands here: show Story Mode. The slug is
            // left in place for StoryBookScreen, which consumes it and opens that book.
            val pendingStorySlug by com.beeboentertainment.movie.distribution.DistributionFeatures.pendingStorySlug.collectAsState()
            LaunchedEffect(pendingStorySlug) {
                if (com.beeboentertainment.movie.BuildConfig.FEATURE_BEEBOBOOK && !pendingStorySlug.isNullOrBlank()) navController.navigate(MainNav.STORIES)
            }

            // beebo://tv-link?code=... (from the sign-in page's "Open in Beebo"): the screen picks the code up and consumes it.
            val pendingTvLink by com.beeboentertainment.movie.tvpair.TvLinkRequests.pending.collectAsState()
            LaunchedEffect(pendingTvLink) {
                if (pendingTvLink != null && !isTv) navController.navigate("link-tv") { launchSingleTop = true }
            }

            // "All episodes" from the player lands here: navigate once, then clear the request.
            LaunchedEffect(pendingShowKey.value) {
                val key = pendingShowKey.value
                if (!key.isNullOrBlank()) {
                    pendingShowKey.value = null
                    navController.navigate(showRoute(key))
                }
            }

            val openShow: (String) -> Unit = { key -> navController.navigate(showRoute(key)) }
            val openActor: (Int, String) -> Unit = { id, name -> navController.navigate(actorRoute(id, name)) }
            val openCollection: (Int, String) -> Unit = { id, name -> navController.navigate(collectionRoute(id, name)) }
            val demo = app.session.demoMode && !app.session.isLoggedIn
            // "Connect my own Beebo" on the sample library: back to the one sign-in screen.
            val leaveDemo: () -> Unit = {
                app.session.demoMode = false
                stage = "setup"
            }

            val campsiteState by com.beeboentertainment.movie.campsite.CampsiteHost.state.collectAsState()
            Scaffold(
                topBar = {
                    TopAppBar(
                        title = {
                            // A short wordmark that never truncates; a pushed screen says what it is.
                            val screenName = when (currentRoute) {
                                "stories" -> "Story Mode"
                                "readitome" -> "Read It To Me"
                                "photos-hub", "photos", "photo-backup", "spacesaver", "spacesaver-gallery" -> "Photos & backups"
                                "collections" -> "Collections"
                                "request-title" -> "Request a title"
                                "surf" -> "Surprise me"
                                "settings" -> "Settings"
                                "link-tv" -> "Link a TV"
                                "delete-account" -> "Delete my account"
                                "profiles" -> "Switch profile"
                                "shared" -> "Shared with you"
                                else -> com.beeboentertainment.movie.music.MusicRoutes.screenName(currentRoute)
                            }
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(
                                    "Beebo",
                                    fontWeight = FontWeight.ExtraBold,
                                    color = MaterialTheme.colorScheme.primary,
                                    maxLines = 1,
                                    softWrap = false
                                )
                                if (screenName != null) {
                                    Text(
                                        "  ·  $screenName",
                                        fontSize = 16.sp,
                                        maxLines = 1,
                                        overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis
                                    )
                                }
                            }
                        },
                        actions = {
                            // Search: Browse with its search box focused.
                            IconButton(onClick = {
                                focusBrowseSearch = true
                                goToTab(Tab.Browse)
                            }) {
                                Icon(Icons.Filled.Search, contentDescription = "Search films and shows")
                            }
                            if (!isTv) {
                                IconButton(onClick = { navController.navigate("campsite") { launchSingleTop = true } }) {
                                    androidx.compose.material3.BadgedBox(badge = {
                                        if (campsiteState.running) androidx.compose.material3.Badge()
                                    }) {
                                        Icon(
                                            painter = androidx.compose.ui.res.painterResource(com.beeboentertainment.movie.R.drawable.ic_campsite),
                                            contentDescription = if (campsiteState.running) "Campsite Mode is running. Open Campsite Mode" else "Open Campsite Mode",
                                            tint = MaterialTheme.colorScheme.primary
                                        )
                                    }
                                }
                            }
                            // A TV is a Cast receiver, not a sender.
                            if (!isTv) CastIconButton()
                            // Profile: More, where settings, the account and sign out live.
                            IconButton(onClick = { goToTab(Tab.More) }) {
                                Icon(Icons.Filled.AccountCircle, contentDescription = "Account and more")
                            }
                        }
                    )
                },
                bottomBar = {
                    if (!isTv) NavigationBar {
                        TABS.forEach { tab ->
                            // Old routes and Surf light up their new home.
                            val selected = backStackEntry?.destination?.hierarchy
                                ?.any { MainNav.tabFor(it.route) == tab.route } == true
                            NavigationBarItem(
                                selected = selected,
                                onClick = { goToTab(tab) },
                                icon = { Icon(tab.icon, contentDescription = tab.label) },
                                label = { Text(tab.label, maxLines = 1, softWrap = false, fontSize = 11.sp) }
                            )
                        }
                    }
                }
            ) { inner ->
              Row(Modifier.fillMaxSize().padding(inner)) {
                if (isTv) {
                    // Same five destinations as the phone's bottom bar, down the left edge where a
                    // remote's left press reaches them from any screen.
                    NavigationRail {
                        TABS.filter { it.route in MainNav.destinations(isTv = true) }.forEach { tab ->
                            val selected = backStackEntry?.destination?.hierarchy
                                ?.any { MainNav.tabFor(it.route) == tab.route } == true
                            NavigationRailItem(
                                selected = selected,
                                onClick = { goToTab(tab) },
                                icon = { Icon(tab.icon, contentDescription = tab.label) },
                                label = { Text(tab.label, maxLines = 1, softWrap = false) },
                                modifier = if (tab.route == MainNav.firstRailFocus()) Modifier.focusRequester(railFocus) else Modifier
                            )
                        }
                    }
                }
                Column(Modifier.weight(1f).fillMaxSize()) {
                if (showNavTip) {
                    Card(
                        Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 10.dp, vertical = 6.dp)
                    ) {
                        Row(Modifier.padding(start = 14.dp, end = 4.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(NavTip.TEXT, fontSize = 13.sp, modifier = Modifier.weight(1f))
                            TextButton(onClick = {
                                NavTip.dismiss(tipStore)
                                showNavTip = false
                            }) { Text("Got it") }
                        }
                    }
                }
                Box(Modifier.weight(1f).fillMaxWidth()) {
                    NavHost(navController = navController, startDestination = Tab.Home.route) {
                        composable(Tab.Home.route) {
                            if (demo) DemoLibraryScreen(onConnect = leaveDemo) else
                            ContinueScreen(
                                onUnauthorized = onUnauthorized,
                                onOpenShow = openShow,
                                mode = ContinueMode.HOME,
                                onSurpriseMe = { navController.navigate(MainNav.SURF) },
                                onOpenCollection = openCollection,
                                onOpenCollections = { navController.navigate("collections") }
                            )
                        }
                        composable(Tab.Browse.route) {
                            if (demo) DemoLibraryScreen(onConnect = leaveDemo) else
                            BrowseScreen(
                                filter = BrowseFilter.fromName(browseFilterName),
                                onFilterChange = { browseFilterName = it.name },
                                focusSearch = focusBrowseSearch,
                                onSearchFocused = { focusBrowseSearch = false },
                                onUnauthorized = onUnauthorized,
                                onOpenShow = openShow,
                                onOpenActor = openActor,
                                onOpenCollection = openCollection,
                                onOpenCollections = { navController.navigate("collections") },
                                onRequestTitle = { query, filter ->
                                    requestPrefill = query
                                    requestPrefillKind = filter.name
                                    navController.navigate("request-title")
                                },
                                onOpenMusic = { route -> navController.navigate(route) }
                            )
                        }
                        composable(Tab.Library.route) {
                            val section = LibrarySection.fromName(librarySectionName).onDevice(isTv)
                            if (demo && section != LibrarySection.DOWNLOADS) {
                                Column(Modifier.fillMaxSize()) {
                                    if (TvFeatures.downloadsAvailable(isTv)) TextButton(
                                        onClick = { librarySectionName = LibrarySection.DOWNLOADS.name },
                                        modifier = Modifier.padding(8.dp)
                                    ) { Text("⬇ Downloads") }
                                    Box(Modifier.weight(1f)) { DemoNotice("Your library") }
                                }
                            } else ContinueScreen(
                                onUnauthorized = onUnauthorized,
                                onOpenShow = openShow,
                                mode = ContinueMode.LIBRARY,
                                librarySection = section,
                                onSectionChange = { librarySectionName = it.name }
                            )
                        }
                        composable(Tab.Play.route) {
                            PlayScreen(onOpen = { navController.navigate(it) })
                        }
                        composable(Tab.More.route) {
                            MoreScreen(
                                showAdmin = com.beeboentertainment.movie.core.AdminGate.showAdminEntry(
                                    app.session.isLoggedIn, isAdmin
                                ),
                                onOpen = { navController.navigate(it) },
                                onSignOut = { confirmSignOut = true }
                            )
                        }

                        // Routes from older layouts: registered so a restored back stack never
                        // crashes, and forwarded straight to where they live now (MainNav.migrate).
                        MainNav.LEGACY_ROUTES.forEach { legacy ->
                            composable(legacy) {
                                LaunchedEffect(Unit) { forwardLegacy(legacy) }
                            }
                        }

                        composable("show/{key}") { entry ->
                            val raw = entry.arguments?.getString("key").orEmpty()
                            val key = runCatching { java.net.URLDecoder.decode(raw, "UTF-8") }.getOrDefault(raw)
                            TvEpisodesScreen(
                                showKey = key,
                                onUnauthorized = onUnauthorized,
                                onOpenActor = openActor
                            )
                        }
                        composable("actor/{id}/{name}") { entry ->
                            val id = entry.arguments?.getString("id")?.toIntOrNull() ?: 0
                            val rawName = entry.arguments?.getString("name").orEmpty()
                            val name = runCatching {
                                java.net.URLDecoder.decode(rawName, "UTF-8")
                            }.getOrDefault(rawName)
                            ActorScreen(
                                personId = id,
                                personName = name,
                                onOpenShow = openShow,
                                onUnauthorized = onUnauthorized
                            )
                        }
                        // Surf is no longer a tab: "Surprise me" on Home and More opens it.
                        composable(MainNav.SURF) {
                            if (demo) DemoNotice("Surprise me")
                            else SurfScreen(onUnauthorized)
                        }
                        composable("admin") {
                            AdminScreen(
                                onUnauthorized = onUnauthorized,
                                onLeave = { navController.popBackStack() }
                            )
                        }
                        composable("collections") {
                            if (demo) DemoNotice("Collections")
                            else com.beeboentertainment.movie.ui.screens.CollectionsScreen(
                                onOpenCollection = openCollection,
                                onRequestTitle = {
                                    requestPrefill = ""
                                    navController.navigate("request-title")
                                },
                                onUnauthorized = onUnauthorized
                            )
                        }
                        composable("request-title") {
                            if (demo) DemoNotice("Requests")
                            else if (!com.beeboentertainment.movie.core.ProfileLimits.of(com.beeboentertainment.movie.BeeboApp.instance.session.isAdmin, com.beeboentertainment.movie.BeeboApp.instance.session.isRestricted, com.beeboentertainment.movie.BeeboApp.instance.session.isGuest).showRequests) Text("Requests aren't available on this profile.", modifier = Modifier.padding(24.dp))
                            else com.beeboentertainment.movie.ui.screens.RequestTitleScreen(
                                onUnauthorized = onUnauthorized,
                                initialQuery = requestPrefill,
                                initialKind = BrowseLogic.requestKindFor(BrowseFilter.fromName(requestPrefillKind))
                            )
                        }
                        composable("collection/{id}/{name}") { entry ->
                            val id = entry.arguments?.getString("id")?.toIntOrNull() ?: 0
                            val rawName = entry.arguments?.getString("name").orEmpty()
                            val name = runCatching {
                                java.net.URLDecoder.decode(rawName, "UTF-8")
                            }.getOrDefault(rawName)
                            CollectionScreen(
                                collectionId = id,
                                collectionName = name,
                                onUnauthorized = onUnauthorized
                            )
                        }
                        composable("watch-together") {
                            com.beeboentertainment.movie.party.WatchTogetherScreen(
                                onMovies = {
                                    browseFilterName = BrowseFilter.FILMS.name
                                    goToTab(Tab.Browse)
                                },
                                onDownloads = {
                                    librarySectionName = LibrarySection.DOWNLOADS.name
                                    goToTab(Tab.Library)
                                },
                                onSettings = { navController.navigate("settings") })
                        }
                        composable("official-free-tv") { OfficialFreeTvScreen() }
                        composable("guest-games") { PhoneOnly("guest-games") {
                            com.beeboentertainment.movie.campsite.GuestGamesScreen(onOpenCampsite = { navController.navigate("campsite") })
                        } }
                        composable("campsite") { PhoneOnly("campsite") {
                            com.beeboentertainment.movie.campsite.CampsiteScreen(
                                onOpenOther = { goToTab(Tab.Play) },
                                onOpenGuestGames = { navController.navigate("guest-games") },
                                onOpenSlides = { navController.navigate("campsite-slides") },
                            )
                        } }
                        composable("campsite-slides") {
                            com.beeboentertainment.movie.campsite.CampsiteSlidesScreen(onOpenCampsite = { navController.navigate("campsite") })
                        }
                        composable("starchart") { PhoneOnly("starchart") { com.beeboentertainment.movie.campsite.StarChartScreen() } }
                        composable("nearby") { PhoneOnly("nearby") { com.beeboentertainment.movie.campsite.NearbyScreen() } }
                        composable("badges") { com.beeboentertainment.movie.badges.BadgesScreen() }
                        composable("recap") {
                            com.beeboentertainment.movie.recap.TripRecapScreen(
                                onOpenExport = { navController.navigate("trip-export/$it") },
                                onOpenShare = { navController.navigate("trip-share/$it") },
                            )
                        }
                        composable("trip-export/{id}") { entry ->
                            com.beeboentertainment.movie.trip.TripExportScreen(entry.arguments?.getString("id").orEmpty())
                        }
                        composable("trip-share/{id}") { entry ->
                            com.beeboentertainment.movie.tripshare.TripShareScreen(entry.arguments?.getString("id").orEmpty())
                        }
                        composable("packing") { com.beeboentertainment.movie.checklist.PackingChecklistScreen() }
                        composable("campfire") { com.beeboentertainment.movie.party.campfire.CampfireScreen() }
                        composable("scavengerhunt") { PhoneOnly("scavengerhunt") { com.beeboentertainment.movie.campsite.ScavengerHuntScreen() } }

                        // Room-synced party games. Each is a self-contained screen that
                        // finds its own RoomMessenger, so they need nothing passed in.
                        composable("thisorthat") { com.beeboentertainment.movie.party.games.ThisOrThatScreen() }
                        composable("trivia") { com.beeboentertainment.movie.party.games.MovieTriviaScreen() }
                        composable("wouldyourather") { com.beeboentertainment.movie.party.games.WouldYouRatherScreen() }
                        composable("twentyquestions") { com.beeboentertainment.movie.party.games.TwentyQuestionsScreen() }
                        composable("bingo") { com.beeboentertainment.movie.party.games.ScavengerBingoScreen() }
                        composable("storybuilder") { com.beeboentertainment.movie.party.games.StoryBuilderScreen() }
                        composable("categorychains") { com.beeboentertainment.movie.party.games.CategoryChainsScreen() }
                        composable("quiet") { com.beeboentertainment.movie.party.games.QuietGameScreen() }
                        composable("picknext") { com.beeboentertainment.movie.party.games.PickNextScreen() }

                        // BeeboBook is website-build only; the Play build has no "stories" route.
                        if (com.beeboentertainment.movie.BuildConfig.FEATURE_BEEBOBOOK) composable(MainNav.STORIES) {
                            PlayScreen(initialSection = "Stories", onOpen = { navController.navigate(it) })
                        }
                        composable("readitome") { com.beeboentertainment.movie.tts.ReadItToMeScreen() }
                        // Keep old routes working for saved shortcuts and backup notifications.
                        listOf("photos-hub" to "library", "photos" to "library", "photo-backup" to "camera",
                            "spacesaver" to "folders", "spacesaver-gallery" to "files").forEach { (route, section) ->
                            composable(route) {
                                com.beeboentertainment.movie.photos.PhotosHubScreen(section, onUnauthorized)
                            }
                        }
                        composable("link-tv") { com.beeboentertainment.movie.ui.screens.LinkTvScreen() }
                        composable("settings") {
                            if (com.beeboentertainment.movie.core.ProfileLimits.of(com.beeboentertainment.movie.BeeboApp.instance.session.isAdmin, com.beeboentertainment.movie.BeeboApp.instance.session.isRestricted, com.beeboentertainment.movie.BeeboApp.instance.session.isGuest).showSettings) SettingsScreen(onOpen = { navController.navigate(it) })
                            else Text("Settings aren't available on this profile.", modifier = Modifier.padding(24.dp))
                        }
                        composable("rewards") {
                            val limits = com.beeboentertainment.movie.core.ProfileLimits.of(
                                com.beeboentertainment.movie.BeeboApp.instance.session.isAdmin,
                                com.beeboentertainment.movie.BeeboApp.instance.session.isRestricted,
                                com.beeboentertainment.movie.BeeboApp.instance.session.isGuest
                            )
                            if (!com.beeboentertainment.movie.BeeboApp.instance.session.isRestricted && !com.beeboentertainment.movie.BeeboApp.instance.session.isGuest) RewardsScreen()
                            else Text("Beebo Points Rewards are not available on this profile.", modifier = Modifier.padding(24.dp))
                        }
                        // Google Play in-app purchases (household plan + extra seats). The same
                        // route/composable name exists in both flavours (like DistributionFeatures
                        // above): a real Play Billing screen in src/play, a no-op stub in src/web -
                        // see docs/GOOGLE-PLAY-BILLING-AND-SEAT-ADDON.md section 6.
                        composable("household-plan") {
                            com.beeboentertainment.movie.ui.screens.HouseholdPlanScreen()
                        }
                        // A different profile, or another household's shared library, is now signed in:
                        // nothing cached from the last one may show, and Home starts fresh.
                        val afterSwitch: () -> Unit = {
                            com.beeboentertainment.movie.data.CatalogCache.clear()
                            com.beeboentertainment.movie.data.ContinueCache.clear(app.session.plain)
                            com.beeboentertainment.movie.data.ShelfCache.clear()
                            isAdmin = app.session.isAdmin
                            if (!app.session.isLoggedIn) onUnauthorized()
                            else navController.navigate(Tab.Home.route) {
                                popUpTo(navController.graph.findStartDestination().id) { inclusive = true }
                            }
                        }
                        composable("profiles") {
                            com.beeboentertainment.movie.ui.sharing.ProfilesScreen(onSwitched = afterSwitch, onUnauthorized = onUnauthorized)
                        }
                        composable("shared") {
                            com.beeboentertainment.movie.ui.sharing.SharedWithYouScreen(onSwitched = afterSwitch)
                        }
                        // Music: album, artist and Now Playing (com.beeboentertainment.movie.music).
                        musicRoutes(navController, onUnauthorized)
                        composable("delete-account") {
                            Column(
                                Modifier
                                    .fillMaxSize()
                                    .verticalScroll(rememberScrollState())
                                    .padding(16.dp),
                                verticalArrangement = Arrangement.spacedBy(12.dp),
                            ) {
                                com.beeboentertainment.movie.account.DeleteAccountSection()
                            }
                        }
                    }
                    // Away from home: "Connecting to your home...", a lost connection, and the
                    // relay balance banner. Small, over the top of the content, never blocking it.
                    com.beeboentertainment.movie.ui.screens.RemoteBanners(
                        modifier = Modifier.align(Alignment.TopCenter),
                        onSignInAgain = { stage = "setup" }
                    )
                }
                // Music playing: a strip with the song, play/pause and skip, under whatever screen
                // is open and above the bottom bar. Tapping it opens Now Playing.
                com.beeboentertainment.movie.music.MusicMiniPlayer(currentRoute) {
                    navController.navigate(com.beeboentertainment.movie.music.MusicRoutes.NOW_PLAYING) { launchSingleTop = true }
                }
                com.beeboentertainment.movie.music.MusicNavEffects(navController)
                }
              }
            }

            if (confirmSignOut) {
                AlertDialog(
                    onDismissRequest = { confirmSignOut = false },
                    title = { Text("Sign out of Beebo?") },
                    text = {
                        Text(
                            "Signing back in needs to reach your Beebo server. If you're somewhere " +
                                "with no signal \u2014 camping, or off-grid \u2014 you won't be able to get " +
                                "back in until you're in range again, and your downloaded videos will " +
                                "be locked behind the sign-in screen.\n\n" +
                                "You do NOT need to sign out to go offline. Beebo keeps you signed in, " +
                                "and losing your connection never signs you out."
                        )
                    },
                    confirmButton = {
                        TextButton(onClick = { confirmSignOut = false; onUnauthorized() }) {
                            Text("Sign out anyway")
                        }
                    },
                    dismissButton = {
                        TextButton(onClick = { confirmSignOut = false }) { Text("Stay signed in") }
                    }
                )
            }
        }
    }
}

/**
 * Lightweight settings section: sign in to the coordination hub (email/password via [HubAuth],
 * which persists the token into SessionStore.hubToken) and manage the user's own link sources
 * via the ported [AddSourceScreen]. Deliberately minimal — it adds one route and touches no
 * other navigation. The hub token it stores is what unlocks the watch party and "Stream from my
 * PC" in the player.
 */
@Composable
private fun SettingsScreen(onOpen: (String) -> Unit = {}) {
    val session = BeeboApp.instance.session
    val scope = rememberCoroutineScope()

    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var signedIn by remember { mutableStateOf(HubAuth.isSignedIn(session)) }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        com.beeboentertainment.movie.ui.sharing.ViewingPrivacySection()

        HorizontalDivider()

        Text("Hub account", style = MaterialTheme.typography.titleLarge)
        Text(
            "Sign in to the coordination hub to enable watch parties and streaming from your PC.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        if (signedIn) {
            Text("Signed in to the hub.", style = MaterialTheme.typography.bodyLarge)
            Button(
                enabled = !busy,
                onClick = {
                    session.logoutHub()
                    signedIn = false
                    message = "Signed out of the hub."
                },
            ) { Text("Sign out of hub") }
        } else {
            // DpadTextField: on a TV the keyboard opens on select, not on D-pad focus.
            DpadTextField { tv ->
                OutlinedTextField(
                    value = email,
                    onValueChange = { email = it; message = null },
                    label = { Text("Hub email") },
                    singleLine = true,
                    modifier = tv.fillMaxWidth(),
                )
            }
            DpadTextField { tv ->
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it; message = null },
                    label = { Text("Password") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = tv.fillMaxWidth(),
                )
            }
            Button(
                enabled = !busy && email.isNotBlank() && password.isNotBlank(),
                onClick = {
                    busy = true
                    message = null
                    scope.launch {
                        try {
                            HubAuth.signIn(session, email.trim(), password)
                            signedIn = true
                            password = ""
                            // Every outcome except ServerResolution.Applied left the saved
                            // address alone, so report what happened instead of implying the
                            // app moved somewhere. Applied's own message is "Connected to your
                            // home server.", so the sentence reads as it always did.
                            val outcome = runCatching { HubAuth.refreshServerAddress(session) }.getOrNull()
                            message = "Signed in. " + (outcome?.message
                                ?: "Couldn't check on your home server just now.")
                        } catch (e: HubException) {
                            message = e.message
                        } catch (e: Exception) {
                            message = e.message ?: "Couldn't sign in to the hub."
                        }
                        busy = false
                    }
                },
            ) { Text("Sign in to hub") }
        }

        message?.let {
            Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary)
        }

        HorizontalDivider()

        if (TvFeatures.downloadsAvailable(LocalIsTv.current)) {
            Text("Downloads", style = MaterialTheme.typography.titleLarge)
            com.beeboentertainment.movie.ui.screens.DownloadWifiOnlySetting()

            HorizontalDivider()
        }

        // A TV shows a code; this phone is where it is approved. There is nothing to link from a TV itself.
        if (com.beeboentertainment.movie.tvpair.TvPairing.offersLinkATv(LocalIsTv.current)) {
            Text("Link a TV", style = MaterialTheme.typography.titleLarge)
            Text(
                "Sign a TV in to your account by entering the code it shows, without typing on the remote.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Button(onClick = { onOpen("link-tv") }) { Text("Link a TV") }

            HorizontalDivider()
        }

        Text("Photos & backups", style = MaterialTheme.typography.titleLarge)
        Text(
            "View your photos, manage camera backup, or back up folders before freeing phone space.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Button(onClick = { onOpen("photos-hub") }) { Text("Open Photos & backups") }

        HorizontalDivider()

        // The ported "bring your own link" section, dropped in whole. Website build only: Google
        // Play gets no arbitrary-URL feature (see DistributionPolicy).
        if (com.beeboentertainment.movie.core.DistributionPolicy.offersAddSource(com.beeboentertainment.movie.core.DistributionPolicy.current)) {
            AddSourceScreen()
            HorizontalDivider()
        }

        // Google Play account deletion: every account this phone is signed in to.
        com.beeboentertainment.movie.account.DeleteAccountSection()
    }
}
