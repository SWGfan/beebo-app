package com.beeboentertainment.movie.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.text.input.PasswordVisualTransformation
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.campsite.CampsiteHost
import com.beeboentertainment.movie.core.TvFeatures
import com.beeboentertainment.movie.data.RewardsClient
import com.beeboentertainment.movie.data.UnauthorizedException
import kotlinx.coroutines.launch

/*
 * Play and More: the two tabs that replaced Other (Games / Stories / Outdoors / Tools).
 * Play holds everything to do together; More holds settings, the account, tools and help.
 */

private data class MenuItem(val route: String, val icon: String, val title: String, val detail: String)

private val outdoors = listOf(
    MenuItem("campsite", "🏕️", "Campsite Mode", "Invite nearby phones to watch your downloads and play. Games don't need it."),
    MenuItem("scavengerhunt", "🔎", "Scavenger Hunt", "Find things together on this phone. Syncing phones needs internet and hub sign-in."),
    MenuItem("starchart", "✨", "Star Chart", "Explore what's in the sky tonight."),
    MenuItem("nearby", "🧭", "Nearby", "Find trails, food and gas. Online maps need internet."),
    MenuItem("campsite-slides", "📸", "Shared photos & videos", "Take turns presenting photos and videos. Everyone follows the presenter over campsite Wi-Fi."),
    MenuItem("campfire", "🔥", "Campfire Mode", "Relaxing sounds for your campfire. Use Shared photos & videos to present to nearby guests."),
    MenuItem("badges", "🎖️", "Explorer Badges", "See what the family has earned."),
    MenuItem("recap", "📖", "Trip Recap", "Mark a trip, then look back on it, present it, or save it as a video to share."),
)

private val tools = listOf(
    MenuItem("watch-together", "👥", "Watch Together", "Find the video sync controls and host or join a viewing session."),
    MenuItem("official-free-tv", "📺", "Official Free TV", "Open free channels from their own broadcaster services. Beebo does not re-stream them."),
    MenuItem("photos-hub", "📷", "Photos & backups", "Your photos, videos, automatic camera backup and space-saving tools in one place."),
    MenuItem("packing", "🧳", "Packing List", "Tick items off offline. Changes sync when the hub connection returns."),
    MenuItem("readitome", "🗣️", "Read It To Me", "Have your phone read text aloud."),
)

/** Play's groups, in tab order. Stories exists only in the website build. */
fun playSections(hasStories: Boolean): List<String> =
    if (hasStories) listOf("Games", "Outdoors", "Stories") else listOf("Games", "Outdoors")

/**
 * Play: the Campsite games (grouped by category with filter chips inside), Invite players, the
 * Outdoors activities, and Story Mode in the website build. On a TV the phone-only entries are
 * hidden by [TvFeatures], as before.
 */
@Composable
fun PlayScreen(initialSection: String = "Games", onOpen: (String) -> Unit) {
    val sections = playSections(com.beeboentertainment.movie.BuildConfig.FEATURE_BEEBOBOOK)
    var section by rememberSaveable { mutableStateOf(initialSection.takeIf { it in sections } ?: "Games") }
    val campsite by CampsiteHost.state.collectAsState()
    val isTv = com.beeboentertainment.movie.ui.tv.LocalIsTv.current
    Column(Modifier.fillMaxSize()) {
        if (campsite.running && !isTv) {
            Card(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)
                .clickable { onOpen("campsite") }) {
                Column(Modifier.padding(12.dp)) {
                    Text("Campsite is running", fontWeight = FontWeight.SemiBold)
                    Text("${campsite.guests.size} guests · Tap for joining codes",
                        style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        TabRow(selectedTabIndex = sections.indexOf(section).coerceAtLeast(0)) {
            sections.forEach { title ->
                Tab(selected = section == title, onClick = { section = title }, text = { Text(title) })
            }
        }
        Box(Modifier.weight(1f)) {
            when (section) {
                "Games" -> Column(Modifier.fillMaxSize()) {
                    // Opens the games list; inviting other phones (or, on a TV, other devices on
                    // the same Wi-Fi) is a step inside it.
                    MenuCard(
                        MenuItem("guest-games", "📨", "Invite players",
                            "Play the Campsite games together, each on their own phone."),
                        Modifier.padding(horizontal = 16.dp, vertical = 8.dp), onOpen
                    )
                    Box(Modifier.weight(1f)) { GamesScreen(onOpenPartyGame = onOpen) }
                }
                "Stories" -> com.beeboentertainment.movie.distribution.DistributionFeatures.StoriesSection()
                else -> Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    TvFeatures.visible(outdoors, isTv) { it.route }.forEach { item ->
                        MenuCard(item, Modifier, onOpen)
                    }
                }
            }
        }
    }
}

/**
 * More: Settings, the account (sign out, Delete my account), Surprise me, Campsite and Wi-Fi,
 * the owner's admin area, Tools, help and the app version. Everything that used to be an icon
 * in the top bar lives here.
 */
@Composable
fun MoreScreen(
    showAdmin: Boolean,
    onOpen: (String) -> Unit,
    onSignOut: () -> Unit
) {
    val app = BeeboApp.instance
    val isTv = com.beeboentertainment.movie.ui.tv.LocalIsTv.current
    var aboutOpen by remember { mutableStateOf(false) }
    var voiceOpen by remember { mutableStateOf(false) }
    // A profile with parental controls, or a guest in someone else's library: no settings (Beebo
    // Relay lives there), no owner tools, no backups to this home. The server refuses them too.
    val limits = com.beeboentertainment.movie.core.ProfileLimits.of(showAdmin, app.session.isRestricted, app.session.isGuest)
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        SectionHeading("Account")
        val who = app.session.userName?.takeIf { it.isNotBlank() }
        if (limits.showSettings) MenuCard(MenuItem("settings", "⚙️", "Settings",
            (if (who != null) "Signed in as $who. " else "") +
                (if (com.beeboentertainment.movie.core.DistributionPolicy.offersAddSource(com.beeboentertainment.movie.core.DistributionPolicy.current))
                    (if (TvFeatures.downloadsAvailable(isTv)) "Your connection, hub sign-in, downloads and your own links."
                    else "Your connection, hub sign-in and your own links.")
                else "Your hub sign-in${if (TvFeatures.downloadsAvailable(isTv)) " and downloads" else ""}.")), Modifier, onOpen)
        MenuCard(MenuItem("delete-account", "🗑️", "Delete my account",
            "Permanently delete an account you use in this app."), Modifier, onOpen)
        MenuCard(MenuItem("profiles", "👤", "Switch profile",
            if (app.session.isRestricted) "This profile has parental controls on. Switching away needs the owner PIN."
            else "Move to another person's profile on this phone."), Modifier, onOpen)
        MenuCard(MenuItem("shared", "🤝", "Shared with you",
            if (app.session.isGuest) "You're watching a library someone shared with you. Go back to your own home here."
            else "Libraries other households invited you to."), Modifier, onOpen)
        if (!app.session.isRestricted && !app.session.isGuest) {
            MenuCard(MenuItem("rewards", "⭐", "Beebo Points Rewards",
                "Optional rewards. Ads are off by default, and your points stay saved when you turn them off."), Modifier, onOpen)
        }
        // Google Play in-app purchases (household plan + extra seats) - see
        // docs/GOOGLE-PLAY-BILLING-AND-SEAT-ADDON.md. Play build and owner only:
        // the website build keeps managing the plan on the website, unchanged.
        if (com.beeboentertainment.movie.BuildConfig.IS_PLAY_BUILD && limits.showOwnerTools) {
            MenuCard(MenuItem("household-plan", "🧾", "Household plan",
                TvFeatures.purchaseNotice(isTv, com.beeboentertainment.movie.BuildConfig.FEATURE_IN_APP_PURCHASES)
                    ?: "See and change your household's plan and extra household spots."), Modifier, onOpen)
        }
        if (limits.showOwnerTools) {
            MenuCard(MenuItem("admin", "🛡️", "Owner tools",
                "Manage people, requests and your Beebo server."), Modifier, onOpen)
        }
        ActionCard("🚪", "Sign out", "You stay signed in when you go offline, so you rarely need this.", onSignOut)

        SectionHeading("Watch")
        MenuCard(MenuItem("surf", "🎲", "Surprise me", "Channel-surf your own library."), Modifier, onOpen)
        if (TvFeatures.isAvailable("campsite", isTv)) {
            MenuCard(MenuItem("campsite", "📶", "Campsite & Wi-Fi",
                "Share this phone's Wi-Fi hotspot so nearby phones can watch and play."), Modifier, onOpen)
        }

        SectionHeading("Tools")
        TvFeatures.visible(tools, isTv) { it.route }.filter { limits.showSpaceSaver || !it.route.startsWith("spacesaver") }.forEach { MenuCard(it, Modifier, onOpen) }

        SectionHeading("Help")
        ActionCard("❓", "Help & about", "How Beebo is laid out, and where things are.", onClick = { aboutOpen = true })
        ActionCard("🎙️", "Talk to Beebo", "What you can say to Google Assistant.", onClick = { voiceOpen = true })
        Text(
            "Beebo version ${com.beeboentertainment.movie.BuildConfig.VERSION_NAME} " +
                "(${com.beeboentertainment.movie.BuildConfig.VERSION_CODE})",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 4.dp, bottom = 12.dp)
        )
    }
    if (voiceOpen) {
        AlertDialog(
            onDismissRequest = { voiceOpen = false },
            title = { Text("Talk to Beebo") },
            text = { Column(Modifier.verticalScroll(rememberScrollState())) { Text(com.beeboentertainment.movie.core.VoiceHelp.text(isTv)) } },
            confirmButton = { TextButton(onClick = { voiceOpen = false }) { Text("OK") } }
        )
    }
    if (aboutOpen) {
        AlertDialog(
            onDismissRequest = { aboutOpen = false },
            title = { Text("About Beebo") },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState())) { Text(
                    "Beebo plays the films and shows from your own computer.\n\n" +
                        "Home: carry on watching and see what's new.\n" +
                        "Browse: every film and show, with one search.\n" +
                        (if (TvFeatures.downloadsAvailable(isTv)) "Library: your watchlist, favourites, history and downloads.\n"
                        else "Library: your watchlist, favourites and history.\n") +
                        "Play: games and outdoor activities.\n" +
                        "More: settings, your account and tools.\n\n" +
                        "Film and show details and posters come from your own computer, which looks " +
                        "them up on TMDB. This product uses the TMDB API but is not endorsed or " +
                        "certified by TMDB.\n\n" +
                        "Privacy policy: beeboentertainment.com/movie-privacy.html"
                ) }
            },
            confirmButton = { TextButton(onClick = { aboutOpen = false }) { Text("OK") } }
        )
    }
}

/** Optional rewards are intentionally separate from streaming, games and family profiles. */
@Composable
fun RewardsScreen() {
    val app = BeeboApp.instance
    val scope = rememberCoroutineScope()
    val client = remember { RewardsClient() }
    var token by remember { mutableStateOf(app.session.rewardsToken.orEmpty()) }
    var email by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    var state by remember { mutableStateOf<RewardsClient.StateResponse?>(null) }
    var consent by rememberSaveable { mutableStateOf(false) }
    var personalized by rememberSaveable { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }

    fun load() {
        if (token.isBlank()) return
        scope.launch {
            busy = true; error = ""
            try { state = client.state(token) }
            catch (_: UnauthorizedException) { app.session.clearRewardsSession(); token = ""; state = null; error = "Rewards sign-in expired. Sign in again to manage it." }
            catch (t: Throwable) { error = t.message ?: "Rewards could not be checked." }
            finally { busy = false }
        }
    }
    LaunchedEffect(token) { if (token.isNotBlank()) load() }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Beebo Points Rewards", style = MaterialTheme.typography.headlineSmall)
        Text("Rewards are optional. Beebo does not show or request ads unless you choose to turn Rewards on.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (error.isNotBlank()) Text(error, color = MaterialTheme.colorScheme.error)

        if (token.isBlank()) {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("Sign in to Rewards", style = MaterialTheme.typography.titleMedium)
                    Text("Rewards uses a limited sign-in that cannot open your library or control your home server.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    OutlinedTextField(email, { email = it }, label = { Text("Beebo account email") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(password, { password = it }, label = { Text("Password") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
                    Button(enabled = !busy && email.isNotBlank() && password.isNotBlank(), onClick = {
                        scope.launch {
                            busy = true; error = ""
                            try {
                                val signedIn = client.login(email, password)
                                app.session.rewardsToken = signedIn.token
                                app.session.rewardsExpiresAt = signedIn.expiresAt
                                password = ""; token = signedIn.token
                            } catch (t: Throwable) { error = t.message ?: "Rewards sign-in could not finish." }
                            finally { busy = false }
                        }
                    }) { Text(if (busy) "Signing in…" else "Sign in") }
                }
            }
        } else {
            val response = state
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("Your points", style = MaterialTheme.typography.titleMedium)
                    Text("${response?.rewards?.points ?: 0}", style = MaterialTheme.typography.displaySmall, fontWeight = FontWeight.Bold)
                    Text(response?.rewards?.pointsPolicy ?: "Your points stay with your Beebo account.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    TextButton(onClick = { app.session.clearRewardsSession(); token = ""; state = null }) { Text("Sign out of Rewards") }
                }
            }
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("Ads and privacy", style = MaterialTheme.typography.titleMedium)
                    Text(response?.policy?.disclosure ?: "Loading the Rewards disclosure…", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (response != null && response.advertisingAvailable) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(checked = consent, onCheckedChange = { consent = it })
                            Text("I understand this optional advertising disclosure.")
                        }
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Switch(checked = response.rewards.adsEnabled, enabled = !busy && (response.rewards.adsEnabled || consent), onCheckedChange = { enabled ->
                                scope.launch {
                                    busy = true; error = ""
                                    try { state = client.preferences(token, enabled, personalized) }
                                    catch (_: UnauthorizedException) { app.session.clearRewardsSession(); token = ""; state = null; error = "Rewards sign-in expired. Sign in again to manage it." }
                                    catch (t: Throwable) { error = t.message ?: "Your Rewards choice could not be saved." }
                                    finally { busy = false }
                                }
                            })
                            Spacer(Modifier.width(12.dp)); Text(if (response.rewards.adsEnabled) "Rewards are on" else "Rewards are off")
                        }
                        if (response.rewards.adsEnabled) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Checkbox(checked = personalized, onCheckedChange = { personalized = it })
                                Text("Allow personalised ads when the provider offers them")
                            }
                        }
                    } else Text("Rewards are being prepared. Ads remain off and no advertising request is made from this screen.", color = MaterialTheme.colorScheme.primary)
                }
            }
            if (response?.rewards?.offers?.isNotEmpty() == true) {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text("Available offers", style = MaterialTheme.typography.titleMedium)
                        response.rewards.offers.forEach { offer ->
                            Text("${offer.title} · ${offer.points} points · about ${offer.estimatedSeconds} seconds", fontWeight = FontWeight.SemiBold)
                            Text(offer.description, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        Text("Offers will become available only after Beebo has completed its provider and consent setup.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
}

@Composable
private fun SectionHeading(text: String) {
    Text(text, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(top = 4.dp))
}

/** One menu entry. `clickable` makes the card focusable, so a D-pad can reach and open it. */
@Composable
private fun MenuCard(item: MenuItem, modifier: Modifier, onOpen: (String) -> Unit) {
    ActionCard(item.icon, item.title, item.detail, { onOpen(item.route) }, modifier)
}

@Composable
private fun ActionCard(icon: String, title: String, detail: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Card(modifier.fillMaxWidth().clickable(onClick = onClick)) {
        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(icon, fontSize = 26.sp)
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleMedium)
                Text(detail, style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}
