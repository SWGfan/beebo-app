package com.beeboentertainment.auto.ui

import android.Manifest
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import android.content.Intent
import android.net.Uri
import androidx.lifecycle.lifecycleScope
import com.beeboentertainment.auto.BuildConfig
import com.beeboentertainment.auto.data.ApiClient
import com.beeboentertainment.auto.data.Prefs
import kotlinx.coroutines.launch
import androidx.media3.common.Player
import com.beeboentertainment.auto.drive.DriveMonitor
import com.beeboentertainment.auto.remote.AutoRemote
import com.beeboentertainment.auto.drive.VideoGate
import com.beeboentertainment.auto.webrtc.WebRtcConnector

/**
 * The phone half of Beebo Entertainment Auto: enough UI to point the app at your server
 * and sign in, and nothing else. Everything the car shows is built by
 * PlaybackService, which reads what is saved here.
 */
class MainActivity : ComponentActivity() {

    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    // Whether the app is currently in system Picture-in-Picture. Compose reads
    // this to collapse to a video-only layout while floating. Updated only from
    // onPictureInPictureModeChanged, which the system calls on the main thread.
    private val inPipMode = mutableStateOf(false)

    // True while the passenger picture is playing AND picture-in-picture is
    // allowed (see VideoGate.pipAllowed). Gates auto-entering PIP so pressing
    // Home on the settings screen, or on a phone projecting to Android Auto,
    // never floats anything.
    @Volatile private var videoActive = false

    // Driving/parked signals for the parked-only video features.
    private val drive by lazy { DriveMonitor(this) }

    // Copies the signals into Family Fun's shared state while the screen is in front.
    private var familySignals: kotlinx.coroutines.Job? = null

    // The watch party's players: the media session (host) and a local video
    // player (viewer). The host controller connects asynchronously.
    private val players by lazy { PartyPlayers(this) }
    private val hostPlayer = mutableStateOf<Player?>(null)

    // The home PC link under test, if any.
    private val pcLink = mutableStateOf<WebRtcConnector?>(null)

    @Volatile private var pipAllowedNow = false

    /**
     * Arm or disarm picture-in-picture. On API 31+ this toggles the system's
     * auto-enter; below that onUserLeaveHint reads the flag.
     */
    fun setVideoActive(active: Boolean) {
        videoActive = active && pipAllowedNow
        if (PipController.isPipSupported(this)) {
            PipController.applyParams(this, autoEnter = videoActive)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 33) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        lifecycleScope.launch { hostPlayer.value = players.connectHost() }
        players.viewer.addListener(object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) = setVideoActive(isPlaying)
        })
        setContent { MaterialTheme(colorScheme = darkColorScheme()) { Screen() } }
    }

    override fun onStart() {
        super.onStart()
        drive.start(lifecycleScope)
        // Family Fun's media service judges requests from this screen with these live signals.
        familySignals = lifecycleScope.launch {
            drive.signals.collect { com.beeboentertainment.auto.family.FamilyRuntime.signals.value = it }
        }
        // The phone screen is open: keep the connection to the home computer ready.
        AutoRemote.hold("screen", true)
    }

    override fun onPause() {
        super.onPause()
        // Android Automotive OS pauses (at least) an activity it covers when
        // driving starts; playback must stop right here, not a beat later.
        if (drive.isAutomotive) players.viewer.pause()
    }

    override fun onStop() {
        super.onStop()
        // Nobody can see the picture any more (PIP keeps us started, not stopped).
        players.viewer.pause()
        drive.stop()
        // With the screen gone the phone is judged as if it were in the dashboard again.
        familySignals?.cancel()
        familySignals = null
        com.beeboentertainment.auto.family.FamilyRuntime.signals.value =
            com.beeboentertainment.auto.family.FamilyRuntime.WORST_CASE
        AutoRemote.hold("screen", false)
    }

    override fun onDestroy() {
        pcLink.value?.close()
        pcLink.value = null
        players.release()
        super.onDestroy()
    }

    /**
     * Pressing Home / recents pops the video out into PIP when a film is playing.
     * On API 31+ the system does this itself via setAutoEnterEnabled(true) (armed
     * in setVideoActive), so we only need the manual path below API 31.
     */
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S &&
            videoActive &&
            PipController.isPipSupported(this)
        ) {
            PipController.enter(this)
        }
    }

    /**
     * The system flips us in and out of PIP. Mirror it into Compose so the UI
     * can hide all app chrome (roster, sliders, buttons) and show only the video
     * surface while floating.
     */
    override fun onPictureInPictureModeChanged(
        isInPictureInPictureMode: Boolean,
        newConfig: android.content.res.Configuration,
    ) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        inPipMode.value = isInPictureInPictureMode
    }

    @Composable
    private fun Screen() {
        val prefs = remember { Prefs.get(this) }
        val api = remember { ApiClient(this) }

        var audioOnly by remember { mutableStateOf(prefs.audioOnly) }
        var signedIn by remember { mutableStateOf(prefs.isConfigured) }
        var update by remember { mutableStateOf<UpdateInfo?>(null) }
        var hubToken by remember { mutableStateOf(prefs.hubToken) }

        // ---- parked-only video gate ------------------------------------------
        val signals by drive.signals.collectAsState()
        val videoBlock = VideoGate.decide(signals)
        val pipAllowed = VideoGate.pipAllowed(signals, PipController.isPipSupported(this))
        val host by hostPlayer
        // Built above the PIP branch so floating the video doesn't dispose the party.
        val party = com.beeboentertainment.auto.party.rememberParty(
            prefs = prefs,
            hubToken = hubToken,
            hostPlayer = host,
            viewerPlayer = players.viewer,
            onLoadVideo = { id -> players.loadForViewer(id) },
        )
        val link by pcLink
        LaunchedEffect(party, videoBlock, pipAllowed) {
            party?.setVideoBlocked(videoBlock != VideoGate.Block.NONE)
            pipAllowedNow = pipAllowed
            setVideoActive(players.viewer.isPlaying)
            if (videoBlock != VideoGate.Block.NONE) {
                players.viewer.pause()
                pcLink.value?.let { it.close(); pcLink.value = null }
            }
        }

        // Asking on every launch is cheap — the endpoint needs no token and the
        // whole point is that nothing else in this setup ever tells you a newer
        // build exists.
        LaunchedEffect(prefs.baseUrl, signedIn) {
            update = null
            if (prefs.baseUrl.isBlank()) return@LaunchedEffect
            val r = runCatching { api.autoVersion() }.getOrNull() ?: return@LaunchedEffect
            if (r.ok && r.versionCode > BuildConfig.VERSION_CODE) {
                update = UpdateInfo(
                    label = r.versionName?.takeIf { it.isNotBlank() }
                        ?: "build ${r.versionCode}",
                    notes = r.notes?.takeIf { it.isNotBlank() },
                    url = api.absolute(r.downloadUrl ?: "/download/auto-app").orEmpty(),
                )
            }
        }

        // In system PIP the window is tiny and chrome-less: collapse to just the
        // video surface and skip the whole settings/party UI. Reading inPipMode
        // here (a snapshot state) recomposes automatically as the system flips
        // us in and out. The remembered state above is kept alive across the
        // toggle because the branch is inside the same composition.
        val inPip by inPipMode
        if (inPip) {
            Surface(Modifier.fillMaxSize(), color = androidx.compose.ui.graphics.Color.Black) {
                // Only the picture belongs in the floating window. The gate still
                // applies: if video becomes blocked the window shows why.
                PipStage(players.viewer, if (pipAllowed) videoBlock else VideoGate.Block.PROJECTING)
            }
            return
        }

        Surface(Modifier.fillMaxSize()) {
            Column(
                Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(24.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                Text("Beebo Entertainment Auto", style = MaterialTheme.typography.headlineMedium)
                Text(
                    "Puts your library in the car's own media screen. " +
                        "Android Auto plays audio only — for picture, mirror the " +
                        "phone instead.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                update?.let { u ->
                    Card(Modifier.fillMaxWidth()) {
                        Column(
                            Modifier.padding(16.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Text(
                                "Version ${u.label} is available",
                                fontWeight = FontWeight.Bold,
                            )
                            Text(
                                u.notes ?: "You're on ${BuildConfig.VERSION_NAME}. " +
                                    "Downloading opens your browser; tap the file " +
                                    "afterwards to install over the top.",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Button(
                                enabled = u.url.isNotBlank(),
                                onClick = {
                                    runCatching {
                                        startActivity(
                                            Intent(Intent.ACTION_VIEW, Uri.parse(u.url))
                                        )
                                    }
                                },
                            ) { Text("Download update") }
                        }
                    }
                }

                HorizontalDivider()

                HomeSignInSection(
                    prefs = prefs,
                    api = api,
                    scope = lifecycleScope,
                    openUrl = { url -> runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } },
                    onSignedInChanged = { signedIn = it },
                )

                HorizontalDivider()

                ToggleRow(
                    title = "Skip the video track",
                    subtitle = "Android Auto can't show video. Leaving this on " +
                        "saves data and battery.",
                    checked = audioOnly,
                    onChange = { audioOnly = it; prefs.audioOnly = it },
                )

                HorizontalDivider()

                Text("Passenger games", style = MaterialTheme.typography.titleMedium)
                Text(
                    "Keep the car entertained. Everyone in the same account plays " +
                        "together; ride solo and Beebo hops in to fill the seat.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                com.beeboentertainment.auto.games.GamesScreen(prefs = prefs)

                HorizontalDivider()

                // Family Fun: audio-only stories, voice games and the trip clock. Its buttons follow
                // the same parked/passenger rule as the video features (see family/FamilyGate.kt).
                com.beeboentertainment.auto.family.FamilyScreen(
                    signals = signals,
                    player = host,
                    onConfirmPassenger = { drive.confirmPassenger(true) },
                )

                HorizontalDivider()

                com.beeboentertainment.auto.sources.AddSourceScreen()

                HorizontalDivider()

                Text("Getting it to show up in the car", fontWeight = FontWeight.Bold)
                Text(
                    "This app is sideloaded, so Android Auto hides it until you " +
                        "allow unknown sources:\n\n" +
                        "1. Phone Settings › Apps › Android Auto › Additional " +
                        "settings in the app\n" +
                        "2. Scroll to About, tap the version line 10 times, tap OK\n" +
                        "3. Overflow menu (⋮) › Developer settings › turn on " +
                        "Unknown sources\n" +
                        "4. Force-stop Android Auto, then reconnect to the car",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                HorizontalDivider()

                HubAccountSection(hubToken = hubToken, onTokenChanged = { hubToken = it })

                HorizontalDivider()

                com.beeboentertainment.auto.party.PartyScreen(
                    prefs = prefs,
                    deviceName = prefs.userName.ifBlank { android.os.Build.MODEL },
                    controller = party,
                    videoBlock = videoBlock,
                    onConfirmPassenger = { drive.confirmPassenger(true) },
                    videoContent = { ViewerSurface(players.viewer) },
                    onPopOut = if (pipAllowed) {
                        { PipController.enter(this@MainActivity) }
                    } else null,
                )

                if (!hubToken.isNullOrBlank()) {
                    HorizontalDivider()
                    HomePcLinkSection(
                        connector = link,
                        videoBlock = videoBlock,
                        onConnect = {
                            pcLink.value?.close()
                            hubToken?.let { token ->
                                val c = WebRtcConnector(this@MainActivity, token)
                                pcLink.value = c
                                lifecycleScope.launch { c.connect() }
                            }
                        },
                        onClose = {
                            pcLink.value?.close()
                            pcLink.value = null
                        },
                    )
                }

                Spacer(Modifier.height(24.dp))
            }
        }
    }

    @Composable
    private fun ToggleRow(
        title: String,
        subtitle: String,
        checked: Boolean,
        onChange: (Boolean) -> Unit,
    ) {
        Row(
            Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Column(Modifier.weight(1f)) {
                Text(title)
                Text(
                    subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Switch(checked = checked, onCheckedChange = onChange)
        }
    }

    private data class UpdateInfo(val label: String, val notes: String?, val url: String)
}
