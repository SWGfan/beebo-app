package com.beeboentertainment.movie.player

import android.app.AlertDialog
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import androidx.media3.ui.PlayerView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.beeboentertainment.movie.data.SessionStore
import com.beeboentertainment.movie.party.PartyScreen
import com.beeboentertainment.movie.party.rememberParty
import com.beeboentertainment.movie.watchtogether.WatchTogetherBanner
import com.beeboentertainment.movie.watchtogether.WatchTogetherPanel
import com.beeboentertainment.movie.watchtogether.WtClient
import com.beeboentertainment.movie.watchtogether.WtHandoff
import com.beeboentertainment.movie.watchtogether.WtProtocol
import com.beeboentertainment.movie.watchtogether.WtSession
import com.beeboentertainment.movie.watchtogether.WtStart
import com.beeboentertainment.movie.ui.theme.BeeboEntertainmentTheme
import com.beeboentertainment.movie.webrtc.WebRtcConnector
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.BackgroundPlaybackPolicy
import com.beeboentertainment.movie.core.ChromeVisibilityModel
import com.beeboentertainment.movie.core.PlayerChromePolicy
import com.beeboentertainment.movie.core.PlayerKeyAction
import com.beeboentertainment.movie.core.PlayerRemoteKeys
import com.beeboentertainment.movie.core.MediaMetadataBuilder
import com.beeboentertainment.movie.core.MarkerPolicy
import com.beeboentertainment.movie.core.MimeGuess
import com.beeboentertainment.movie.core.PipPolicy
import com.beeboentertainment.movie.core.ResumeReconciler
import com.beeboentertainment.movie.core.SurfNav
import com.beeboentertainment.movie.core.SubtitlePolicy
import com.beeboentertainment.movie.core.TimeRemainingLabel
import com.beeboentertainment.movie.core.TransportPolicy
import com.beeboentertainment.movie.core.UpNextResolver
import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.core.formatMs
import com.beeboentertainment.movie.data.ContinueItem
import com.beeboentertainment.movie.data.MissingRequest
import com.beeboentertainment.movie.data.SubtitleTrack
import com.beeboentertainment.movie.data.UpNextItem
import com.beeboentertainment.movie.R
import com.beeboentertainment.movie.databinding.ActivityPlayerBinding
import com.beeboentertainment.movie.ui.MainActivity
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.File

/**
 * The player UI.
 *
 * It deliberately owns no player of its own: PlaybackService (a Media3 MediaSessionService) holds
 * the ExoPlayer, and this Activity drives it through a MediaController. That is what lets the
 * video keep playing when the screen turns off — the Activity can be stopped or destroyed without
 * touching playback.
 *
 * Still handled here, because they are UI concerns:
 *   - the "keep playing with the screen off" toggle and the pause-on-background rule
 *   - the resume prompt
 *   - surf mode's Previous/Next stepping and the "N of M" counter
 *   - the Cast button and the casting overlay
 *   - flagging bad quality
 */
@androidx.annotation.OptIn(markerClass = [UnstableApi::class])
class PlayerActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "PlayerActivity"

        const val EXTRA_ITEM_ID = "item_id"
        const val EXTRA_KIND = "kind"                 // "movie" | "tv"
        const val EXTRA_TITLE = "title"
        const val EXTRA_STREAM_URL = "stream_url"     // absolute http URL (may be null when offline)
        const val EXTRA_LOCAL_PATH = "local_path"     // absolute file path of a completed download
        const val EXTRA_POSTER_URL = "poster_url"
        const val EXTRA_START_FRACTION = "start_fraction"
        /** >= 0 means "jump straight here, don't ask" — the app's twin of the website's ?t=. */
        const val EXTRA_RESUME_POSITION_MS = "resume_position_ms"
        /** Lets the player work out what episode comes next. Optional; looked up by title if absent. */
        const val EXTRA_SHOW_KEY = "show_key"

        /** Broadcast used by the PiP remote play/pause action. */
        private const val ACTION_PIP_CONTROL = "com.beeboentertainment.movie.PIP_CONTROL"
        private const val EXTRA_PIP_CONTROL = "control"
        private const val PIP_PLAY = 1
        private const val PIP_PAUSE = 2
        private const val PIP_PREVIOUS = 3
        private const val PIP_NEXT = 4

        // surf mode
        const val EXTRA_SURF = "surf"
        const val EXTRA_SURF_KIND = "surf_kind"
        const val EXTRA_SURF_GENRE = "surf_genre"
        const val EXTRA_SURF_GENRE_NAME = "surf_genre_name"
        const val EXTRA_SURF_YEAR = "surf_year"
        const val EXTRA_SURF_DECADE = "surf_decade"
        const val EXTRA_SURF_SEED = "surf_seed"
        const val EXTRA_SURF_INDEX = "surf_index"
        const val EXTRA_SURF_TOTAL = "surf_total"

        /** Play a single library item (or its downloaded copy). */
        fun intentFor(
            context: Context,
            itemId: String,
            kind: String,
            title: String,
            streamUrl: String?,
            localPath: String? = null,
            posterUrl: String? = null,
            resumePositionMs: Long = -1L,
            showKey: String? = null
        ) = Intent(context, PlayerActivity::class.java).apply {
            putExtra(EXTRA_ITEM_ID, itemId)
            putExtra(EXTRA_KIND, kind)
            putExtra(EXTRA_TITLE, title)
            putExtra(EXTRA_STREAM_URL, streamUrl)
            putExtra(EXTRA_LOCAL_PATH, localPath)
            putExtra(EXTRA_POSTER_URL, posterUrl)
            putExtra(EXTRA_RESUME_POSITION_MS, resumePositionMs)
            putExtra(EXTRA_SHOW_KEY, showKey)
        }

        /**
         * Enter surf mode at a given index of a seeded shuffle.
         * [kind] is movie|tv|both; [year] and [decade] are the optional time filter — the caller
         * (SurfFilters) guarantees at most one of them is non-null.
         */
        fun surfIntent(
            context: Context,
            kind: String,
            genre: String?,
            genreName: String?,
            year: Int?,
            decade: Int?,
            seed: Long,
            index: Int,
            total: Int
        ) = Intent(context, PlayerActivity::class.java).apply {
            putExtra(EXTRA_SURF, true)
            putExtra(EXTRA_SURF_KIND, kind)
            putExtra(EXTRA_SURF_GENRE, genre)
            putExtra(EXTRA_SURF_GENRE_NAME, genreName)
            year?.let { putExtra(EXTRA_SURF_YEAR, it) }
            decade?.let { putExtra(EXTRA_SURF_DECADE, it) }
            putExtra(EXTRA_SURF_SEED, seed)
            putExtra(EXTRA_SURF_INDEX, index)
            putExtra(EXTRA_SURF_TOTAL, total)
        }
    }

    private lateinit var b: ActivityPlayerBinding

    /** Handle on the player that actually lives in PlaybackService. */
    private var controller: MediaController? = null
    /** Set while "Lost the connection" is on screen; cleared (with the message) once playback is back. */
    private var connectionLost = false
    private var reconnectJob: Job? = null
    private var networkCallback: android.net.ConnectivityManager.NetworkCallback? = null
    /** Work queued up while the controller was still connecting. */
    private var pendingWhenReady: (() -> Unit)? = null

    private val app get() = BeeboApp.instance

    // what is playing right now
    private var itemId: String = ""
    private var kind: String = "movie"
    private var title: String = ""
    private var streamUrl: String? = null
    private var localPath: String? = null
    private var posterUrl: String? = null
    private var startFraction: Double = 0.0
    /** true until startFraction has been applied, which needs a known duration */
    private var awaitingFractionSeek = false

    // surf state
    private var surfMode = false
    private var surfKind = "movie"
    private var surfGenre: String? = null
    private var surfSeed: Long = 0
    private var surfIndex = 0
    private var surfTotal = 0
    private var surfFilters = com.beeboentertainment.movie.core.SurfFilters()

    /** Mirrors the Cast SDK's session state; drives the overlay and the background policy. */
    private var castSessionActive = false

    /** >= 0 when the caller (Continue Watching) already knows where to start. */
    private var forcedResumeMs: Long = -1L
    private var showKey: String? = null
    private var upNextJob: Job? = null
    /** Guards against posting the same missing-request twice in one sitting. */
    private val reportedMissing = mutableSetOf<String>()
    /** True once the up-next card has been dealt with for the current item. */
    private var upNextHandled = false

    /**
     * Decides whether the custom chrome (top bar, surf row) is on screen.
     * PlayerView owns the actual 3-second countdown; this owns the exemptions it can't know
     * about, chiefly the up-next card.
     */
    private val chrome = ChromeVisibilityModel()

    /** Whether this device can do PiP at all; decided once, in onCreate. */
    private var pipSupported = false
    private var inPip = false

    /* ---- watch party / remote stream (Compose overlays over the View player) ---- */

    /**
     * The live player handed to the party controller. It is the same MediaController that
     * drives the on-screen PlayerView (a MediaController IS an androidx.media3.common.Player),
     * so the host's real play/pause/seek is what viewers follow. Null until the controller
     * connects; a Compose state so the party sheet rebuilds its controller when it arrives.
     */
    private val partyPlayer = mutableStateOf<Player?>(null)

    /** The active remote-stream connector, or null. A Compose state so the overlay observes it. */
    private val webRtcConnector = mutableStateOf<WebRtcConnector?>(null)
    /** True while the remote-stream overlay is up; gates its composition. */
    private val webRtcActive = mutableStateOf(false)

    /** The in-flight "follow the host to another film" lookup, if any. */
    private var partyLoadJob: Job? = null
    /** The video id that lookup is for, so a repeated ask does not queue a second one. */
    private var partyLoadingVideoId: String? = null

    /** True when the viewer asked for a specific position (?t= or the Resume prompt). */
    private var viewerChosePosition = false
    /** Set by "✕ Cancel": suppresses BOTH the credits advance and the end-of-file one. */
    private var autoAdvanceCancelled = false
    /** Watches the position for the credits marker / end-of-file card. */
    /*
     * Sidecar subtitles. [subtitleTracks] is what GET /api/subtitles said about
     * [subtitleTracksItemId] - empty for all but a handful of files. [selectedSubtitle] indexes
     * it, with -1 meaning "off".
     */
    /** Quality / audio / subtitle sheet; when it is active it owns subtitles and the button below steps aside. */
    private val choices by lazy {
        PlaybackChoicesController(
            activity = this,
            player = { controller },
            isTv = isTv,
            onLabel = { label ->
                b.qualityButton.visibility = if (label == null) View.GONE else View.VISIBLE
                if (label != null) {
                    b.qualityButton.text = "⚙️ $label"
                    b.qualityButton.contentDescription = "Quality, audio and subtitles, currently $label"
                }
                renderSubtitlesButton()
            },
            toast = { toast(it) }
        )
    }

    private var subtitleTracks: List<SubtitleTrack> = emptyList()
    private var subtitleTracksItemId: String = ""
    private var subtitleJob: Job? = null
    private var selectedSubtitle: Int = -1

    private var markerJob: Job? = null
    private var introUndoJob: Job? = null
    /** Guards the one-shot intro skip per item. */
    private var introSkipApplied = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivityPlayerBinding.inflate(layoutInflater)
        setContentView(b.root)

        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        hideSystemBars()
        keepControlsClearOfSystemButtons()

        surfMode = intent.getBooleanExtra(EXTRA_SURF, false)
        if (surfMode) {
            surfKind = intent.getStringExtra(EXTRA_SURF_KIND) ?: "movie"
            surfGenre = intent.getStringExtra(EXTRA_SURF_GENRE)
            surfSeed = intent.getLongExtra(EXTRA_SURF_SEED, 0L)
            surfIndex = intent.getIntExtra(EXTRA_SURF_INDEX, 0)
            surfTotal = intent.getIntExtra(EXTRA_SURF_TOTAL, 0)
            surfFilters = com.beeboentertainment.movie.core.SurfFilters(
                kind = surfKind,
                genreId = surfGenre?.toIntOrNull(),
                genreName = intent.getStringExtra(EXTRA_SURF_GENRE_NAME),
                year = intent.getIntExtra(EXTRA_SURF_YEAR, 0).takeIf { it > 0 },
                decade = intent.getIntExtra(EXTRA_SURF_DECADE, 0).takeIf { it > 0 }
            )
            b.subtitleText.text = surfFilters.summary()
            b.subtitleText.visibility = View.VISIBLE
            // Surf keeps its own PREVIOUS / NEXT strip, meaning "another random pick", and has
            // no markers or auto-advance.
            b.transportBar.visibility = View.GONE
        } else {
            readItemFromIntent()
            choices.autoVersionEnabled = forcedResumeMs < 0L
            // Started HERE, before the MediaController has even connected, purely to win a race:
            // see loadSubtitleTracks. Nothing downstream waits on it.
            loadSubtitleTracks()
        }

        setupCastButton()
        setupCastSessionTracking()
        setupScreenOffToggle()
        setupButtons()
        setupChromeAutoHide()
        setupTimeRemainingToggle()
        setupTransportButtons()
        setupPip()
        setupPartyOverlay()
        setupWatchTogether()
        setupRemoteStreamOverlay()
        setupTvRemote()
    }

    private fun readItemFromIntent() {
        itemId = intent.getStringExtra(EXTRA_ITEM_ID).orEmpty()
        kind = intent.getStringExtra(EXTRA_KIND) ?: "movie"
        title = intent.getStringExtra(EXTRA_TITLE).orEmpty()
        streamUrl = intent.getStringExtra(EXTRA_STREAM_URL)
        forcedResumeMs = intent.getLongExtra(EXTRA_RESUME_POSITION_MS, -1L)
        showKey = intent.getStringExtra(EXTRA_SHOW_KEY)
        localPath = intent.getStringExtra(EXTRA_LOCAL_PATH)
        posterUrl = intent.getStringExtra(EXTRA_POSTER_URL)
        startFraction = intent.getDoubleExtra(EXTRA_START_FRACTION, 0.0)
    }

    /* ------------------------------ picture in picture ------------------------ */

    private fun setupPip() {
        pipSupported = PipPolicy.isSupported(
            sdkInt = Build.VERSION.SDK_INT,
            hasFeature = packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)
        )
        b.pipButton.setOnClickListener { enterPip() }
        registerPipReceiver()
        updatePipButton()
    }

    /** The button hides rather than sitting there dead. */
    private fun updatePipButton() {
        val offer = PipPolicy.canOfferPip(
            supported = pipSupported,
            isCasting = castSessionActive,
            isFinishing = isFinishing
        )
        b.pipButton.visibility = if (offer) View.VISIBLE else View.GONE
    }

    private fun enterPip() {
        if (!PipPolicy.canOfferPip(pipSupported, castSessionActive, isFinishing)) return
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        runCatching { enterPictureInPictureMode(buildPipParams()) }
            .onFailure { Log.w(TAG, "Could not enter PiP", it) }
    }

    @androidx.annotation.RequiresApi(Build.VERSION_CODES.O)
    private fun buildPipParams(): android.app.PictureInPictureParams {
        val size = controller?.videoSize
        val (w, h) = PipPolicy.aspectRatio(size?.width ?: 0, size?.height ?: 0)
        val builder = android.app.PictureInPictureParams.Builder()
            .setAspectRatio(android.util.Rational(w, h))
            .setActions(pipActions())
        // From Android 12 the system enters PiP itself on leave when auto-enter is on and
        // something is playing — smoother than the manual onUserLeaveHint path, and it only
        // arms while eligible. seamlessResize keeps the video surface from flashing on resize.
        // TODO(device): the ExoPlayer surface lives on the PlayerView, which is NOT recreated
        // across the transition (see the manifest configChanges), so the picture should carry
        // over untouched — confirm on a real device that the surface handoff is seamless.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setAutoEnterEnabled(
                PipPolicy.shouldAutoEnterOnLeave(
                    supported = pipSupported,
                    isPlaying = controller?.isPlaying == true,
                    isCasting = castSessionActive,
                    isFinishing = isFinishing,
                    alreadyInPip = inPip
                )
            )
            builder.setSeamlessResizeEnabled(true)
        }
        return builder.build()
    }

    /**
     * Keep the auto-enter flag current on API 31+: it must reflect "is something playing right
     * now", so it is re-pushed whenever play/pause or the media item changes (via
     * [refreshPipActions], which already fires on those events).
     */
    private fun refreshAutoEnter() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || !pipSupported) return
        if (inPip) return
        runCatching { setPictureInPictureParams(buildPipParams()) }
    }

    /**
     * ⏮ / play-pause / ⏭ in the PiP window, following exactly the same transport rules as the
     * on-screen buttons. Android caps the count (normally three); on a device that allows fewer,
     * play-pause is the one that survives.
     */
    @androidx.annotation.RequiresApi(Build.VERSION_CODES.O)
    private fun pipActions(): List<android.app.RemoteAction> {
        val max = runCatching { maxNumPictureInPictureActions }.getOrDefault(3)
        val hasNext = TransportCache.current.hasNext
        return PipPolicy.actionsFor(max).map { action ->
            when (action) {
                PipPolicy.PipAction.PREVIOUS ->
                    remoteAction(R.drawable.ic_pip_prev, "Previous", PIP_PREVIOUS, enabled = true)

                PipPolicy.PipAction.PLAY_PAUSE -> {
                    val playing = controller?.isPlaying == true
                    remoteAction(
                        if (playing) R.drawable.ic_pip_pause else R.drawable.ic_pip_play,
                        if (playing) "Pause" else "Play",
                        if (playing) PIP_PAUSE else PIP_PLAY,
                        enabled = true
                    )
                }

                // Greyed rather than absent at the end of a series, so the layout stays stable.
                PipPolicy.PipAction.NEXT ->
                    remoteAction(R.drawable.ic_pip_next, "Next", PIP_NEXT, enabled = hasNext)
            }
        }
    }

    @androidx.annotation.RequiresApi(Build.VERSION_CODES.O)
    private fun remoteAction(
        iconRes: Int,
        label: String,
        control: Int,
        enabled: Boolean
    ): android.app.RemoteAction {
        val icon = android.graphics.drawable.Icon.createWithResource(this, iconRes)
        val intent = Intent(ACTION_PIP_CONTROL)
            .setPackage(packageName)
            .putExtra(EXTRA_PIP_CONTROL, control)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val pending = PendingIntent.getBroadcast(this, control, intent, flags)
        return android.app.RemoteAction(icon, label, label, pending).apply { isEnabled = enabled }
    }

    /** Keep the PiP action in step with what the player is actually doing. */
    private fun refreshPipActions() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        // While NOT in PiP, still push params so the API 31+ auto-enter flag tracks play state.
        if (!inPip) {
            refreshAutoEnter()
            return
        }
        runCatching { setPictureInPictureParams(buildPipParams()) }
    }

    private val pipReceiver = object : android.content.BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != ACTION_PIP_CONTROL) return
            when (intent.getIntExtra(EXTRA_PIP_CONTROL, 0)) {
                PIP_PLAY -> controller?.play()
                PIP_PAUSE -> controller?.pause()
                // Same rules as the on-screen buttons.
                PIP_PREVIOUS -> transportPrevious()
                PIP_NEXT -> transportNext()
            }
        }
    }

    private fun registerPipReceiver() {
        if (!pipSupported) return
        val filter = android.content.IntentFilter(ACTION_PIP_CONTROL)
        runCatching {
            ContextCompat.registerReceiver(
                this, pipReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED
            )
        }
    }

    /**
     * Home pressed. Dropping into PiP is what people expect from a video app, and it composes
     * with the screen-off toggle rather than competing: PiP handles leaving the app, background
     * audio handles the screen going off. If the screen then locks while in PiP, onStop still
     * runs and the ordinary background-playback rules decide whether to pause.
     */
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        // On API 31+ the system enters PiP itself from the auto-enter flag (set in buildPipParams),
        // so a manual enter here would be redundant. Only pre-31 needs the explicit call.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return
        val shouldEnter = PipPolicy.shouldAutoEnterOnLeave(
            supported = pipSupported,
            isPlaying = controller?.isPlaying == true,
            isCasting = castSessionActive,
            isFinishing = isFinishing,
            alreadyInPip = inPip
        )
        if (shouldEnter) enterPip()
    }

    override fun onPictureInPictureModeChanged(
        isInPictureInPictureMode: Boolean,
        newConfig: android.content.res.Configuration
    ) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        inPip = isInPictureInPictureMode
        chrome.onPipChanged(isInPictureInPictureMode)

        // A PiP window is tiny — every overlay comes off, including the up-next card and the
        // watch-party sheet (its composition stays alive so the party keeps syncing).
        if (isInPictureInPictureMode) {
            b.upNextCard.visibility = View.GONE
            b.statusBox.visibility = View.GONE
            b.partyOverlay.visibility = View.GONE
            b.playerView.useController = false
        } else {
            b.playerView.useController = true
            // Restore whatever the state actually warrants.
            if (upNextJob?.isActive == true) b.upNextCard.visibility = View.VISIBLE
            b.playerView.showController()
        }
        applyChromeVisibility()
        updatePipButton()
    }

    /* --------------------------- watch party -------------------------------- */

    private fun partyDeviceName(): String {
        val model = "${Build.MANUFACTURER} ${Build.MODEL}".trim()
        return app.session.userName?.takeIf { it.isNotBlank() }?.let { "$it — $model" } ?: model
    }

    /**
     * The party sheet is a Compose overlay that stays composed (so a joined party keeps
     * syncing) but hidden until "Watch together" is tapped. It hands the party controller the
     * real MediaController, so the host's play/pause/seek is exactly what viewers follow. The
     * controller only CONNECTS when the user taps Host/Join inside the sheet — building it is
     * free, so nothing hits the network on an ordinary playback.
     */
    private fun setupPartyOverlay() {
        b.partyButton.setOnClickListener { togglePartySheet() }
        b.partyOverlay.setContent {
            BeeboEntertainmentTheme {
                PartySheet(
                    session = app.session,
                    player = partyPlayer.value,
                    deviceName = partyDeviceName(),
                    onPopOut = { enterPip() },
                    onLoadVideo = { videoId -> followHostToVideo(videoId) },
                    onClose = { b.partyOverlay.visibility = View.GONE },
                )
            }
        }
    }

    /**
     * A viewer's host switched films. Resolve the id it broadcast against THIS device's own
     * server and swap the player onto it, so nobody has to open the new film by hand.
     *
     * The id is the only thing that crosses the room socket, and it is treated as untrusted:
     * [PartyVideoResolver] refuses anything that is not a server item id and then asks this
     * account's authenticated API for the playable stream. A film this account cannot see never
     * resolves, so it never plays — the host can ask, it cannot tell.
     *
     * Position is NOT set here: the host's next sync beat places it, which is also why the swap
     * starts at 0 rather than guessing.
     */
    private fun followHostToVideo(videoId: String) {
        if (isFinishing || isDestroyed || surfMode) return
        val id = videoId.trim()
        if (!PartyVideoResolver.isSafeItemId(id)) {
            Log.w(TAG, "Party load ignored: the host sent something that is not an item id")
            return
        }
        if (id == itemId && controller?.currentMediaItem != null) return
        if (id == partyLoadingVideoId && partyLoadJob?.isActive == true) return

        partyLoadJob?.cancel()
        partyLoadingVideoId = id
        partyLoadJob = lifecycleScope.launch {
            val resolved = PartyVideoResolver.resolve(app.api, id)
            partyLoadingVideoId = null
            if (resolved == null) {
                toast("The host switched to something this account can't open here.")
                return@launch
            }
            playPartyItem(resolved)
        }
    }

    /**
     * Swap the player onto a party item. Mirrors [playTransportItem] — same MediaItemFactory,
     * same setMediaItem/prepare/play — and additionally refreshes the Activity's own idea of
     * "what is playing", because unlike ⏭ this switch did not come from our own catalogue state.
     */
    private fun playPartyItem(item: UpNextItem) {
        whenReady {
            val c = controller ?: return@whenReady
            val mediaItem = MediaItemFactory.forUpNextItem(app.session.baseUrl, item) ?: return@whenReady

            itemId = item.id
            kind = item.kind
            title = item.title
            showKey = item.showKey
            streamUrl = UrlUtils.join(app.session.baseUrl, item.stream)
            posterUrl = UrlUtils.join(app.session.baseUrl, item.poster)
            localPath = null
            forcedResumeMs = -1L
            startFraction = 0.0
            awaitingFractionSeek = false

            hideUpNext()
            hideStatus()
            autoAdvanceCancelled = false
            introSkipApplied = false
            upNextHandled = false
            // The host owns the timeline: its next beat decides where we sit, so the intro
            // auto-skip must not jump us somewhere of its own accord.
            viewerChosePosition = true

            // A title change is not the person pressing play: keep it out of the watch-together room.
            wt?.noteProgrammaticChange()
            c.setMediaItem(mediaItem, 0L)
            c.prepare()
            c.play()
            toast("Following the host to \u201C${item.title}\u201D")
        }
    }

    private fun togglePartySheet() {
        val show = b.partyOverlay.visibility != View.VISIBLE
        b.partyOverlay.visibility = if (show) View.VISIBLE else View.GONE
        if (show && app.session.hubToken.isNullOrBlank()) {
            toast("Sign in to the hub (Settings) to host or join a watch party.")
        }
    }

    /* ------------------- watch together (rooms on this Beebo) ------------------- */

    /** The room session, once there is one (joined from an invite, or started from the panel). */
    private var wt: WtSession? = null
    private val wtSession = mutableStateOf<WtSession?>(null)
    private val wtPanelOpen = mutableStateOf(false)
    private val wtStart = mutableStateOf<WtStart?>(null)

    private fun setupWatchTogether() {
        b.wtButton.setOnClickListener { openWtPanel(!wtPanelOpen.value) }
        b.wtBanner.setContent {
            BeeboEntertainmentTheme {
                val s = wtSession.value
                if (s != null) WatchTogetherBanner(s)
            }
        }
        b.wtOverlay.setContent {
            BeeboEntertainmentTheme {
                val s = wtSession.value
                if (s != null && wtPanelOpen.value) WatchTogetherPanel(s, wtStart.value) { openWtPanel(false) }
            }
        }
    }

    private fun openWtPanel(open: Boolean) {
        if (open) {
            ensureWtSession() ?: return
            wtStart.value = if (!surfMode && WtProtocol.isMediaKind(kind) && WtProtocol.isSafeMediaId(itemId) && localPath.isNullOrBlank()) WtStart(kind, itemId, title) else null
        }
        wtPanelOpen.value = open
        b.wtOverlay.visibility = if (open) View.VISIBLE else View.GONE
    }

    /** One session per player screen: attached to the same controller the picture is drawn from. */
    private fun ensureWtSession(): WtSession? {
        wt?.let { return it }
        val c = controller ?: return null
        val s = WtSession(WtClient.get())
        s.attach(c)
        // The host changed title: open it the same way a watch-party host change is followed.
        s.setOnMedia { media -> followHostToVideo(media.id) }
        wt = s
        wtSession.value = s
        return s
    }

    /**
     * Called once the controller is connected. A player opened from an invite joins straight away; any
     * other player only shows the Room button if this computer supports Watch together.
     */
    private fun onWatchTogetherPlayerReady() {
        if (surfMode) return
        val invite = WtHandoff.take()
        if (invite != null) {
            val s = ensureWtSession() ?: return
            b.wtButton.visibility = View.VISIBLE
            lifecycleScope.launch {
                try {
                    val joined = s.join(invite)
                    toast("Joined the room")
                    // The room may have moved to another title since the invite was looked up.
                    val roomId = joined.room.media.id
                    if (WtProtocol.isSafeMediaId(roomId) && roomId != itemId) followHostToVideo(roomId)
                } catch (e: com.beeboentertainment.movie.data.UnauthorizedException) {
                    toast("Your sign-in ended.")
                } catch (e: com.beeboentertainment.movie.server.ServerException) {
                    toast(WtProtocol.message(e.code, e.message))
                } catch (e: Exception) {
                    toast("Couldn't join the room.")
                }
            }
            return
        }
        if (!localPath.isNullOrBlank() || app.session.isGuest) return
        lifecycleScope.launch {
            val supported = runCatching { WtClient.get().ping(System.currentTimeMillis().toDouble()).ok }.getOrDefault(false)
            if (supported && !isFinishing) b.wtButton.visibility = View.VISIBLE
        }
    }

    /* ------------------------ remote stream (WebRTC) ------------------------ */

    /**
     * "Stream from my PC": brings up the WebRTC receiver full-screen. Starts the recv-only
     * session, observes its state, and renders the inbound PC video track into a
     * SurfaceViewRenderer once it arrives (see [RemoteStreamOverlay]).
     */
    private fun setupRemoteStreamOverlay() {
        b.remoteButton.setOnClickListener { startRemoteStream() }
        b.webrtcOverlay.setContent {
            BeeboEntertainmentTheme {
                if (webRtcActive.value) {
                    RemoteStreamOverlay(
                        connector = webRtcConnector.value,
                        onClose = { stopRemoteStream() },
                    )
                }
            }
        }
    }

    private fun startRemoteStream() {
        if (app.session.hubToken.isNullOrBlank()) {
            toast("Sign in to the hub (Settings) to stream from your PC.")
            return
        }
        if (webRtcActive.value) return
        webRtcActive.value = true
        b.webrtcOverlay.visibility = View.VISIBLE
        // Pause local playback so the two video sources don't fight for audio/attention.
        controller?.pause()
        lifecycleScope.launch {
            val connector = try {
                WebRtcConnector.startRemoteSession(this@PlayerActivity)
            } catch (t: Throwable) {
                Log.w(TAG, "Remote session failed to start", t)
                null
            }
            if (connector == null) {
                toast("Couldn't start a remote session. Check you're signed in to the hub.")
                stopRemoteStream()
                return@launch
            }
            webRtcConnector.value = connector
        }
    }

    private fun stopRemoteStream() {
        webRtcActive.value = false
        b.webrtcOverlay.visibility = View.GONE
        val c = webRtcConnector.value
        webRtcConnector.value = null
        runCatching { c?.close() }
    }

    /* ------------------------- chrome show / auto-hide ------------------------ */

    /**
     * Make the custom overlays behave like ordinary video controls.
     *
     * They follow PlayerView's own controller rather than running a second timer: PlayerView
     * already keeps controls up while paused, buffering, idle or ended and hides them only while
     * playing, so mirroring it gives correct behaviour for free and keeps the custom chrome in
     * step with the native transport controls instead of drifting out of sync with them.
     */
    private fun setupChromeAutoHide() {
        // PlayerView's own previous/next are driven by the player's playlist, which only ever
        // holds one item — the next control could never enable. Ours live in transportBar.
        b.playerView.setShowPreviousButton(false)
        b.playerView.setShowNextButton(false)
        b.playerView.controllerShowTimeoutMs = PlayerChromePolicy.HIDE_TIMEOUT_MS.toInt()
        b.playerView.controllerHideOnTouch = true
        b.playerView.controllerAutoShow = true

        // Explicit interface (not a bare lambda): setControllerVisibilityListener is overloaded
        // and a SAM-converted lambda would be ambiguous.
        b.playerView.setControllerVisibilityListener(
            PlayerView.ControllerVisibilityListener { visibility ->
                chrome.onControllerVisibilityChanged(visibility == View.VISIBLE)
                applyChromeVisibility()
            }
        )
        applyChromeVisibility()
    }

    /**
     * "Show time remaining": tapping Media3's own duration label (the one on the far side of
     * the seek bar from elapsed time) flips it between the file's total length and a negative
     * countdown, Plex/YouTube-style. The remembered choice is [SessionStore.showTimeRemaining];
     * the formatting is [TimeRemainingLabel].
     *
     * There is no supported way to change what PlayerControlView puts in that TextView, so this
     * takes over the one hook it does expose - [androidx.media3.ui.PlayerControlView.setProgressUpdateListener],
     * which it already calls once a second (about) while the controls are visible or playback is
     * live - and overwrites the label right after Media3's own update runs. Confirmed against the
     * media3-ui 1.4.1 bytecode: durationView.setText(...) always happens before
     * progressUpdateListener.onProgressUpdate(...) inside its updateProgress(), so this never
     * flashes the wrong text first.
     */
    private fun setupTimeRemainingToggle() {
        val controlView = b.playerView.findViewById<androidx.media3.ui.PlayerControlView>(
            androidx.media3.ui.R.id.exo_controller
        ) ?: return
        val durationView = controlView.findViewById<android.widget.TextView>(androidx.media3.ui.R.id.exo_duration) ?: return

        fun refreshDurationLabel(positionMs: Long) {
            val duration = controller?.duration?.takeIf { it != C.TIME_UNSET && it > 0 } ?: 0L
            durationView.text = TimeRemainingLabel.forDuration(duration, positionMs, app.session.showTimeRemaining)
        }

        controlView.setProgressUpdateListener { position, _ -> refreshDurationLabel(position) }
        durationView.setOnClickListener {
            app.session.showTimeRemaining = !app.session.showTimeRemaining
            refreshDurationLabel(controller?.currentPosition ?: 0L)
        }
    }

    /** Push the model's decision onto the actual views. */
    private fun applyChromeVisibility() {
        val visible = chrome.chromeVisible
        b.topChrome.visibility = if (visible) View.VISIBLE else View.GONE
        // The surf row only exists in surf mode; when it does, it hides with the rest.
        b.surfBar.visibility = if (surfMode && visible) View.VISIBLE else View.GONE
    }

    /** Bring everything back and restart the countdown. */
    private fun showChrome() {
        chrome.onTouch()
        b.playerView.showController()
        applyChromeVisibility()
    }

    /**
     * Any touch anywhere re-arms the countdown.
     *
     * Only when the controls are ALREADY up: taps on our own chrome buttons never reach
     * PlayerView, so without this they would not restart the timer. When the controls are hidden
     * we leave it alone and let PlayerView's own tap-to-show handle it — showing here as well
     * would then be undone by PlayerView toggling on ACTION_UP.
     */
    override fun dispatchTouchEvent(ev: MotionEvent?): Boolean {
        if (ev?.actionMasked == MotionEvent.ACTION_DOWN &&
            PlayerChromePolicy.shouldRearmOnTouch(b.playerView.isControllerFullyVisible)
        ) {
            showChrome()
        }
        // ALWAYS delegates: this hook observes, it never consumes. Swallowing an event here
        // would break dragging the scrub bar while leaving taps working.
        return super.dispatchTouchEvent(ev)
    }

    /* ------------------- Android TV remote (focus + key handling only) ------------------- */
    // Kept to key routing on purpose: nothing here touches how media is loaded or streamed.

    private val isTv by lazy { com.beeboentertainment.movie.ui.tv.TvDevice.isTv(this) }

    /** A key-down this section acted on; its matching key-up is swallowed too. */
    private var tvConsumedKeyCode = -1

    /** True while a Compose sheet (watch party, remote stream) is up and owns the keys. */
    private fun tvOverlayUp(): Boolean =
        b.partyOverlay.visibility == View.VISIBLE || b.webrtcOverlay.visibility == View.VISIBLE || b.wtOverlay.visibility == View.VISIBLE

    private fun setupTvRemote() {
        if (!isTv) return
        // Back hides the controls first (see PlayerRemoteKeys.backHidesControls).
        onBackPressedDispatcher.addCallback(this, object : androidx.activity.OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (!tvOverlayUp() &&
                    PlayerRemoteKeys.backHidesControls(isTv, b.playerView.isControllerFullyVisible)
                ) {
                    b.playerView.hideController()
                    return
                }
                isEnabled = false
                onBackPressedDispatcher.onBackPressed()
                isEnabled = true
            }
        })
    }

    /**
     * On a TV every key goes to PlayerView first, the way Media3's own TV sample does it: a D-pad
     * press while the controls are hidden brings them up (with play/pause focused), and the media
     * keys drive the player. Before that, [PlayerRemoteKeys] claims the keys PlayerView does not
     * do the TV way: left/right seek while the controls are hidden, and next/previous move through
     * this app's own episode / surf queue rather than the player's one-item playlist.
     * Phones are untouched.
     */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (handleChapterKey(event)) return true
        if (!isTv || tvOverlayUp()) return super.dispatchKeyEvent(event)
        if (event.action == KeyEvent.ACTION_UP && event.keyCode == tvConsumedKeyCode) {
            tvConsumedKeyCode = -1
            return true
        }
        if (event.action == KeyEvent.ACTION_DOWN && handleTvKey(event)) {
            tvConsumedKeyCode = event.keyCode
            return true
        }
        return b.playerView.dispatchKeyEvent(event) || super.dispatchKeyEvent(event)
    }

    /** A chapter key this Activity acted on; its repeats and key-up are swallowed too. */
    private var chapterConsumedKeyCode = -1

    /**
     * Media next / previous and Page Down / Up move between chapters once the file has some (phone
     * keyboards, headsets and TV remotes alike). At the last chapter, or the first one's opening
     * seconds, nothing is consumed, so the key still does what it always did (next / previous episode).
     */
    private fun handleChapterKey(event: KeyEvent): Boolean {
        val forward = when (event.keyCode) {
            KeyEvent.KEYCODE_MEDIA_NEXT, KeyEvent.KEYCODE_PAGE_DOWN -> true
            KeyEvent.KEYCODE_MEDIA_PREVIOUS, KeyEvent.KEYCODE_PAGE_UP -> false
            else -> return false
        }
        if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
            if (surfMode || tvOverlayUp() || !choices.chapters.hasChapters) return false
            val moved = if (forward) choices.chapters.next() else choices.chapters.previous()
            if (!moved) return false
            chapterConsumedKeyCode = event.keyCode
            showChrome()
            return true
        }
        if (event.keyCode != chapterConsumedKeyCode) return false
        if (event.action == KeyEvent.ACTION_UP) chapterConsumedKeyCode = -1
        return true
    }

    private fun handleTvKey(event: KeyEvent): Boolean {
        val action = PlayerRemoteKeys.actionFor(
            keyCode = event.keyCode,
            controlsVisible = b.playerView.isControllerFullyVisible,
            isTv = true,
            repeatCount = event.repeatCount
        )
        if (action == PlayerKeyAction.DEFAULT) return false
        val c = controller ?: return true
        when (action) {
            PlayerKeyAction.SEEK_BACK, PlayerKeyAction.SEEK_FORWARD -> {
                val step = if (action == PlayerKeyAction.SEEK_BACK) -PlayerRemoteKeys.SEEK_STEP_MS
                else PlayerRemoteKeys.SEEK_STEP_MS
                c.seekTo(PlayerRemoteKeys.seekTarget(c.currentPosition, c.duration, step))
            }
            PlayerKeyAction.TOGGLE_PLAY_PAUSE -> if (c.isPlaying) c.pause() else c.play()
            PlayerKeyAction.PLAY -> c.play()
            PlayerKeyAction.PAUSE -> c.pause()
            PlayerKeyAction.NEXT ->
                if (surfMode) loadSurf(SurfNav.next(surfIndex, surfTotal)) else transportNext()
            PlayerKeyAction.PREVIOUS ->
                if (surfMode) loadSurf(SurfNav.previous(surfIndex, surfTotal)) else transportPrevious()
            // The Menu / Info key only brings the controls up, which showChrome() below does.
            PlayerKeyAction.SHOW_CONTROLS, PlayerKeyAction.DEFAULT -> Unit
        }
        // Show where the key landed; this also restarts the auto-hide countdown.
        showChrome()
        return true
    }

    /* --------------------------- controller wiring --------------------------- */

    override fun onStart() {
        super.onStart()
        connectController()
        // Leaving the house (or the Wi-Fi) with the player open changes the answer.
        setupCastButton()
    }

    private fun connectController() {
        if (controller != null) return
        val token = SessionToken(this, ComponentName(this, PlaybackService::class.java))
        val future = MediaController.Builder(this, token).buildAsync()
        future.addListener({
            val c = try {
                future.get()
            } catch (t: Throwable) {
                Log.e(TAG, "Could not connect to PlaybackService", t)
                null
            }
            if (c == null) {
                showStatus(
                    "Couldn't start the playback service. Close and reopen the app.",
                    offerCast = false
                )
                return@addListener
            }
            controller = c
            c.addListener(playerListener)
            b.playerView.player = c
            updateKeepScreenOn()
            // Hand the live player to the party sheet (same instance the host drives).
            partyPlayer.value = c
            onWatchTogetherPlayerReady()
            onControllerReady()
        }, ContextCompat.getMainExecutor(this))
    }

    private fun onControllerReady() {
        val queued = pendingWhenReady
        pendingWhenReady = null
        if (queued != null) {
            queued()
            return
        }
        // First time in: kick off whatever this Activity was launched for.
        if (surfMode) loadSurf(surfIndex) else startPlaybackForCurrentItem(askResume = true)
    }

    /** Run [block] now if the controller is live, otherwise as soon as it connects. */
    private fun whenReady(block: () -> Unit) {
        if (controller != null) block() else pendingWhenReady = block
    }

    /* ------------------------- screen-off toggle ---------------------------- */

    /**
     * "Keep playing with the screen off." OFF by default and remembered from then on, matching
     * the website. The checkbox only records a preference — the actual effect happens in onStop().
     */
    private fun setupScreenOffToggle() {
        val enabled = app.session.keepPlayingInBackground
        b.screenOffToggle.isChecked = enabled
        renderScreenOffToggle(enabled)
        b.screenOffToggle.setOnCheckedChangeListener { _, isChecked ->
            app.session.keepPlayingInBackground = isChecked
            renderScreenOffToggle(isChecked)
            toast(
                if (isChecked) "Playback will keep going with the screen off."
                else "Playback will pause when the screen turns off."
            )
        }
    }

    private fun renderScreenOffToggle(enabled: Boolean) {
        b.screenOffToggle.text = com.beeboentertainment.movie.core.BackgroundPlaybackSetting.labelFor(enabled)
        b.screenOffToggle.contentDescription = "Keep playing with the screen off, currently " +
            if (enabled) "on" else "off"
    }

    /* ------------------------------- casting -------------------------------- */

    private object CastNotice { @Volatile var explained = false }

    /**
     * Whether a TV can be offered at all, and with what warning.
     *
     *  - at home, or on an ordinary server address: as it always was;
     *  - away from home on Wi-Fi: yes, because this phone passes the video to the TV itself
     *    (PhoneCastRelay). Said plainly the first time ever, then never again;
     *  - away from home on mobile data, or with no usable Wi-Fi address: no button, and the
     *    reason said out loud once per app run - on mobile data the reason is the phone bill,
     *    not a technical one.
     *
     * Called again from onStart because someone can walk out of the house, or off the Wi-Fi,
     * with the player still open.
     */
    private fun setupCastButton() {
        if (!CastHelper.isAvailable(this)) {
            b.castButton.visibility = View.GONE
            return
        }
        val decision = com.beeboentertainment.movie.rtc.RemoteAccess.castDecision()
        if (decision is com.beeboentertainment.movie.rtc.CastRule.Decision.Blocked) {
            b.castButton.visibility = View.GONE
            if (!CastNotice.explained) {
                CastNotice.explained = true
                toast(com.beeboentertainment.movie.rtc.CastRule.blockedExplanation(
                    com.beeboentertainment.movie.rtc.RemoteAccess.currentNetwork))
            }
            return
        }
        b.castButton.visibility = View.VISIBLE
        val ready = CastHelper.setUpMediaRouteButton(applicationContext, b.castButton)
        if (!ready) b.castButton.visibility = View.GONE
        // The one honest sentence about what casting away from home actually does.
        if (ready && decision is com.beeboentertainment.movie.rtc.CastRule.Decision.ViaPhone &&
            !app.session.castViaPhoneExplained
        ) {
            app.session.castViaPhoneExplained = true
            toast(com.beeboentertainment.movie.rtc.CastRule.VIA_PHONE_NOTE)
        }
    }

    /**
     * The actual local <-> cast player swap happens inside PlaybackService. The Activity only
     * tracks the session so it can show the overlay and so the background policy knows the TV
     * is playing.
     */
    private fun setupCastSessionTracking() {
        if (!CastHelper.isAvailable(this)) return
        castSessionActive = CastHelper.isSessionConnected(this)
        renderCastOverlay()
        castSessionWatch?.close()
        castSessionWatch = CastHelper.observeSession(this, ::setCasting)
        // Away from home the video reaches the TV through this phone. If the connection to the
        // home computer drops, or the phone leaves the Wi-Fi, the TV simply stops - so say what
        // happened instead of leaving a frozen picture and no explanation.
        lifecycleScope.launch {
            PhoneCastRelay.problem.collect { message ->
                if (message.isNullOrBlank()) return@collect
                PhoneCastRelay.clearProblem()
                showStatus(message, offerCast = false, actionLabel = "OK") { hideStatus() }
            }
        }
    }

    /** Stops listening for Cast sessions (null when Cast is unavailable, e.g. the Amazon build). */
    private var castSessionWatch: AutoCloseable? = null

    private fun setCasting(active: Boolean) {
        castSessionActive = active
        choices.onCastingChanged(active)
        renderCastOverlay()
        updateKeepScreenOn()
        if (active && streamUrl.isNullOrBlank()) {
            toast("This downloaded copy can't be cast — play it from the library to cast.")
        }
    }

    /**
     * Keep the screen awake only while video is actually playing on THIS phone. Paused, ended
     * and casting (the phone is just a remote then) all let the screen sleep normally.
     * Media3's PlayerView does not manage keepScreenOn; ExoPlayer's wake mode only covers
     * CPU / Wi-Fi.
     */
    private fun updateKeepScreenOn() {
        val playing = controller?.isPlaying == true
        b.root.keepScreenOn = playing && !castSessionActive
    }

    private fun renderCastOverlay() {
        updatePipButton()
        b.castOverlay.visibility = if (castSessionActive) View.VISIBLE else View.GONE
        b.castOverlayText.text = if (castSessionActive) "Casting \"$title\" to your TV" else ""
    }

    /* --------------------------- item playback ------------------------------ */

    private fun startPlaybackForCurrentItem(askResume: Boolean) {
        b.titleText.text = title
        updateAllEpisodesButton()
        updateMarkerButtons()
        // A downloaded copy makes the item playable with no network at all.
        if (localPath.isNullOrBlank()) {
            app.downloads.localPath(itemId)?.let { localPath = it }
        }

        // Already playing this very episode - on the TV, or in the background on this phone?
        // Then opening it again is a RETURN, not a restart. Reloading here is what threw a
        // "Resume from 1:24?" at someone thirty-six minutes into a cast: the phone had no
        // way back into its own stream except starting it over. Attach to what is running
        // and change nothing about it.
        val running = controller?.currentMediaItem
        val runningId = running?.mediaMetadata?.extras?.getString(PlaybackService.EXTRA_ITEM_ID)
            ?.takeIf { it.isNotBlank() } ?: running?.mediaId?.takeIf { it.isNotBlank() }
        if (running != null && itemId.isNotBlank() && runningId == itemId) {
            attachToRunningPlayback()
            return
        }

        // Continue Watching already decided where to start — that is the website's ?t= behaviour,
        // and it is the ONLY path that skips the prompt.
        if (forcedResumeMs >= 0L) {
            beginPlayback(forcedResumeMs)
            return
        }
        if (!askResume) {
            beginPlayback(0L)
            return
        }

        val localMs = app.resume.position(itemId)
        lifecycleScope.launch {
            // There are two records of "where was I": this phone, and the server's shared history.
            // Ask the server too, then let whoever got further along win.
            val serverRow = fetchServerResume(itemId)
            val point = ResumeReconciler.reconcile(
                localMs = localMs,
                serverSeconds = serverRow?.currentTime,
                serverDurationSeconds = serverRow?.duration
            )
            if (point.hasResume) promptResume(point) else beginPlayback(0L)
        }
    }

    /** null when the server has no row, or simply isn't reachable (downloads must still play). */
    private suspend fun fetchServerResume(id: String): ContinueItem? = try {
        if (id.isBlank()) null else app.api.continueWatching().items.firstOrNull { it.id == id }
    } catch (_: Exception) {
        null
    }

    /** The player NEVER auto-seeks without asking — same rule as the website. */
    private fun promptResume(point: ResumeReconciler.ResumePoint) {
        if (isFinishing || isDestroyed) return
        AlertDialog.Builder(this)
            .setTitle("Resume?")
            .setMessage(ResumeReconciler.promptFor(title, point))
            .setPositiveButton("Resume") { _, _ -> beginPlayback(point.positionMs) }
            .setNegativeButton("Start over") { _, _ ->
                app.resume.clear(itemId)
                beginPlayback(0L)
            }
            .setCancelable(false)
            .show()
    }

    private fun beginPlayback(positionMs: Long) {
        upNextHandled = false
        autoAdvanceCancelled = false
        introSkipApplied = false
        // An explicit resume position (Continue Watching's ?t=, or answering the Resume prompt)
        // means "put me exactly here" — the intro skip must not override that.
        viewerChosePosition = positionMs > 0L || forcedResumeMs >= 0L
        b.introUndoButton.visibility = View.GONE
        updateMarkerButtons()
        startMarkerWatcher()
        hideUpNext()
        awaitingFractionSeek = startFraction > 0.0 && positionMs == 0L
        val item = buildMediaItem() ?: return
        whenReady {
            val c = controller ?: return@whenReady
            hideStatus()
            c.setMediaItem(item, positionMs)
            c.prepare()
            c.play()
            // Pushed explicitly rather than left to onMediaItemTransition, which takes an early
            // return in surf mode and so would never apply the choice for a surf pick.
            applySubtitleSelection()
        }
    }

    /**
     * The service is already playing this item; wire the screen up to it without touching
     * playback. Everything beginPlayback sets up around a load, minus the load - and no prompt,
     * because there is no "where were you": it is right there, still going.
     */
    private fun attachToRunningPlayback() {
        choices.onItemTransition(controller?.currentMediaItem)
        upNextHandled = false
        autoAdvanceCancelled = false
        introSkipApplied = true          // the viewer is mid-stream; never yank them to the intro mark
        viewerChosePosition = true
        b.introUndoButton.visibility = View.GONE
        updateMarkerButtons()
        startMarkerWatcher()
        hideUpNext()
        hideStatus()
        renderCastOverlay()
        updateKeepScreenOn()
    }

    /**
     * Build the MediaItem, including the metadata the lock-screen / notification controls show
     * and the extras PlaybackService reads back to save resume marks and report watch history.
     */
    private fun buildMediaItem(): MediaItem? {
        val downloaded = !localPath.isNullOrBlank() && File(localPath!!).exists()
        // Casting needs the server URL; local playback prefers the downloaded file.
        val uriString = when {
            castSessionActive && !streamUrl.isNullOrBlank() -> streamUrl
            downloaded -> Uri.fromFile(File(localPath!!)).toString()
            else -> streamUrl
        }
        if (uriString.isNullOrBlank()) {
            showStatus("Nothing to play — no stream URL and no downloaded file.", offerCast = false)
            return null
        }

        // Chromecast can't sniff containers, so a correct content type is mandatory; Media3's
        // DefaultMediaItemConverter also requires MediaItem.mimeType to be non-null.
        val mime = MimeGuess.forStreamUrl(uriString, title)
        val spec = MediaMetadataBuilder.forItem(title, posterUrl, kind, offline = downloaded)

        val metadata = MediaMetadata.Builder()
            .setTitle(spec.title)
            .setDisplayTitle(spec.title)
            .setArtist(spec.subtitle)
            .setSubtitle(spec.subtitle)
            .apply { spec.artworkUri?.let { setArtworkUri(Uri.parse(it)) } }
            .setExtras(PlaybackService.Extras.bundle(itemId.ifBlank { uriString }, spec.kind))
            .build()

        return MediaItem.Builder()
            .setUri(uriString)
            .setMimeType(mime)
            .setMediaId(itemId.ifBlank { uriString })
            .setMediaMetadata(metadata)
            // Empty for all but a handful of files, and an empty list leaves this MediaItem
            // byte-for-byte what it was before subtitles existed - which is exactly what keeps a
            // video with no sidecar completely unaffected by any of this.
            .setSubtitleConfigurations(subtitleConfigurations())
            .build()
    }

    /* ------------------------------- surf ----------------------------------- */

    private fun loadSurf(index: Int) {
        b.loading.visibility = View.VISIBLE
        lifecycleScope.launch {
            try {
                val r = app.api.surf(
                    kind = surfKind,
                    genre = surfGenre,
                    seed = surfSeed.takeIf { it != 0L },
                    i = index,
                    year = surfFilters.requestYear,
                    decade = surfFilters.requestDecade
                )
                b.loading.visibility = View.GONE
                if (!r.ok || r.item == null || r.total == 0) {
                    showStatus(
                        "Nothing to surf in ${surfFilters.activeFilterSummary()}.\n" +
                            "Try a different category or year.",
                        offerCast = false,
                        actionLabel = "Back to categories",
                        action = { finish() }
                    )
                    b.surfCounter.text = SurfNav.label(0, 0)
                    return@launch
                }
                surfSeed = if (r.seed != 0L) r.seed else surfSeed
                surfTotal = r.total
                surfIndex = SurfNav.wrap(r.index, r.total)
                b.surfCounter.text = SurfNav.label(surfIndex, surfTotal)

                val item = r.item
                itemId = item.id
                // With kind=both the pool mixes movies and episodes, so the ITEM's own kind
                // decides which stream path/MIME/history kind applies — never the pool kind.
                kind = com.beeboentertainment.movie.core.SurfItemRouting.resolveKind(
                    itemKind = item.kind,
                    stream = item.stream,
                    poolKind = surfKind
                )
                title = item.title
                streamUrl = com.beeboentertainment.movie.core.UrlUtils.join(app.session.baseUrl, item.stream)
                posterUrl = com.beeboentertainment.movie.core.UrlUtils.join(app.session.baseUrl, item.poster)
                localPath = null
                startFraction = r.startFraction
                b.titleText.text = title
                renderCastOverlay()

                // Fired before beginPlayback, but it will lose the race against it here (the
                // pick only became known a moment ago) - so a surf pick with sidecars has them put
                // on afterwards by PlaybackService, and only if they are wanted.
                loadSubtitleTracks()

                // Surf deliberately ignores the saved resume point — the whole idea is
                // "drop me into the middle of something".
                beginPlayback(0L)
            } catch (e: com.beeboentertainment.movie.data.UnauthorizedException) {
                bounceToLogin()
            } catch (e: Exception) {
                b.loading.visibility = View.GONE
                showStatus(e.message ?: "Couldn't load the next pick.", offerCast = false)
            }
        }
    }

    private fun setupButtons() {
        b.surfPrev.setOnClickListener { loadSurf(SurfNav.previous(surfIndex, surfTotal)) }
        b.surfNext.setOnClickListener { loadSurf(SurfNav.next(surfIndex, surfTotal)) }
        b.surfFromStart.setOnClickListener {
            awaitingFractionSeek = false
            startFraction = 0.0
            controller?.seekTo(0L)
            controller?.play()
        }
        b.flagButton.setOnClickListener { flagQuality() }
        b.allEpisodesButton.setOnClickListener { openAllEpisodes() }
        b.subtitlesButton.setOnClickListener { openSubtitlePicker() }
        b.qualityButton.setOnClickListener { choices.openSheet() }
        b.statusAction.setOnClickListener {
            val custom = statusAction
            if (custom != null) {
                custom()
            } else if (b.castButton.visibility == View.VISIBLE) {
                b.castButton.performClick()
            } else {
                toast("No Chromecast found on this network.")
            }
        }
    }

    private fun flagQuality() {
        if (itemId.isBlank()) return
        lifecycleScope.launch {
            try {
                app.api.flagQuality(kind, itemId)
                toast("Thanks — flagged for a better copy.")
            } catch (e: com.beeboentertainment.movie.data.UnauthorizedException) {
                bounceToLogin()
            } catch (e: Exception) {
                toast("Couldn't flag it: ${e.message}")
            }
        }
    }

    /* ------------------------------ subtitles -------------------------------- */

    /**
     * Is there anything to offer for the file playing right now?
     *
     * Guards every other function here. A downloaded copy is excluded on purpose: it plays off
     * local storage with the server out of the picture, and the sidecar was never downloaded
     * alongside it, so pointing ExoPlayer at a remote subtitle URL would be asking a file that
     * works offline to depend on the network again.
     */
    private val subtitlesUsable: Boolean
        get() = subtitleTracks.isNotEmpty() &&
            subtitleTracksItemId == itemId &&
            !choices.active &&
            localPath.isNullOrBlank()

    /**
     * Ask the server which sidecars sit next to this file.
     *
     * Fire-and-forget on its own Job, and NOTHING waits on it. Two reasons it must stay that
     * way. First, the overwhelming majority of files have no sidecar at all, so making every
     * film wait on an answer that is almost always "none" would be a tax paid a thousand times
     * over for a feature used a handful of times. Second, away from home this goes over the same
     * link as the video itself, where it can be slow or simply fail - and a film that will not
     * start because its subtitle lookup timed out is a far worse bug than no subtitles.
     *
     * It is started as early as it possibly can be - from onCreate, before the MediaController
     * has connected - so that in practice the answer is already in hand by the time
     * beginPlayback builds the MediaItem, and the sidecars go on at the first prepare with no
     * second one needed. Losing that race is handled, not prevented, and not here: PlaybackService
     * puts them on any item that started without them, because it also has to for the episodes it
     * moves to itself with this screen closed. The lookup is shared with it (SidecarSubtitles), so
     * the two of them asking about the same file costs one request.
     */
    private fun loadSubtitleTracks() {
        subtitleJob?.cancel()
        clearSubtitleSelection()
        subtitleTracks = emptyList()
        subtitleTracksItemId = ""
        selectedSubtitle = -1
        renderSubtitlesButton()
        val id = itemId
        val itemKind = kind
        if (id.isBlank() || !localPath.isNullOrBlank()) return
        subtitleJob = lifecycleScope.launch {
            val found = try {
                SidecarSubtitles.tracks(app.api, itemKind, id)
            } catch (e: Exception) {
                // Deliberately swallows UnauthorizedException too, instead of calling
                // bounceToLogin() the way the other calls here do: throwing a viewer out of a
                // film that is playing perfectly well, over a side lookup they never asked for,
                // would be indefensible. Subtitles simply are not offered.
                Log.d(TAG, "No subtitle list for $id: ${e.message}")
                emptyList()
            }
            // They may have moved on to another episode while this was in flight.
            if (id != itemId) return@launch
            subtitleTracks = found
            subtitleTracksItemId = id
            selectedSubtitle = SubtitlePolicy.rememberedIndex(
                languages = found.map { it.lang },
                subtitlesOn = app.session.subtitlesOn,
                wantedLanguage = app.session.subtitleLanguage
            )
            renderSubtitlesButton()
            applySubtitleSelection()
        }
    }

    /**
     * The sidecars as MediaItem.SubtitleConfigurations, or an empty list when there are none.
     * Built by SidecarSubtitles, the same builder PlaybackService uses, so the stamped track ids
     * a selection looks for are the same whichever side attached them.
     */
    private fun subtitleConfigurations(): List<MediaItem.SubtitleConfiguration> {
        if (!subtitlesUsable) return emptyList()
        return SidecarSubtitles.configurations(app.session.baseUrl, subtitleTracks)
    }

    /**
     * Put the sidecars onto the item that is already playing, if they are not on it yet.
     *
     * Subtitle configurations can only be attached at MediaItem level, so this costs one
     * re-prepare at the current position - which is why it is called ONLY when the viewer turns
     * subtitles on from the picker. Everything automatic (the list losing its race with
     * beginPlayback, an episode the service moved to by itself) is PlaybackService's job.
     */
    private fun attachSubtitlesIfNeeded() {
        val c = controller ?: return
        if (!subtitlesUsable) return
        val current = c.currentMediaItem ?: return
        // The service can still be holding the PREVIOUS item when this lands - reopening the
        // player over a session that never stopped is the everyday way that happens. Attaching
        // this file's sidecars to that one would put the wrong subtitles on the wrong film.
        val loadedId = current.mediaMetadata.extras?.getString(MediaMetadataBuilder.EXTRA_ITEM_ID)
            ?: current.mediaId
        if (loadedId != itemId) return
        if (current.localConfiguration?.subtitleConfigurations?.isNotEmpty() == true) return
        val configurations = subtitleConfigurations()
        if (configurations.isEmpty()) return
        val positionMs = c.currentPosition
        val wasPlaying = c.playWhenReady
        c.setMediaItem(current.buildUpon().setSubtitleConfigurations(configurations).build(), positionMs)
        c.prepare()
        c.playWhenReady = wasPlaying
    }

    /**
     * Push the current choice at the player.
     *
     * Called after every setMediaItem and again from onTracksChanged, because before the player
     * has read the sidecar there is no track group to override at all.
     *
     * "Off" is expressed by clearing the override, NOT by disabling the text track type. Two
     * reasons, both about leaving things as they were. Text tracks inside the container are the
     * player's business rather than ours - some files carry a DEFAULT-flagged subtitle stream the
     * selector picks up by itself today, and this button is about the sidecars, not about taking
     * that away. And these parameters belong to the PLAYER, not to the item: a disabled text type
     * would follow the viewer into every video played afterwards. Clearing is enough on its own,
     * because subtitleConfigurations deliberately sets no selection flags, so an un-overridden
     * sidecar is never picked up.
     */
    private fun applySubtitleSelection() {
        val c = controller ?: return
        if (!subtitlesUsable) return
        if (!c.isCommandAvailable(Player.COMMAND_SET_TRACK_SELECTION_PARAMETERS)) return
        val wanted = selectedSubtitle.takeIf { it in subtitleTracks.indices } ?: -1
        val parameters = c.trackSelectionParameters.buildUpon()
            .clearOverridesOfType(C.TRACK_TYPE_TEXT)
            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
        if (wanted >= 0) {
            SidecarSubtitles.textGroup(c.currentTracks, wanted)
                ?.let { parameters.setOverrideForType(TrackSelectionOverride(it.mediaTrackGroup, 0)) }
        }
        runCatching { c.trackSelectionParameters = parameters.build() }
    }

    /**
     * Drop any text override before moving to another file.
     *
     * Necessary, not tidiness. An override is keyed by the track group it names, and the groups
     * built from two different files' sidecars compare EQUAL whenever the language and label
     * match - which for "the English subtitle" is most of the time. Left in place, the previous
     * film's choice would silently re-select itself on the next one, over the top of whatever the
     * remembered preference actually says.
     */
    private fun clearSubtitleSelection() {
        val c = controller ?: return
        if (!c.isCommandAvailable(Player.COMMAND_SET_TRACK_SELECTION_PARAMETERS)) return
        runCatching {
            c.trackSelectionParameters = c.trackSelectionParameters.buildUpon()
                .clearOverridesOfType(C.TRACK_TYPE_TEXT)
                .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                .build()
        }
    }

    /**
     * The button is GONE unless this file really has a sidecar, so a video without one looks
     * exactly as it always did - no control appearing, nothing disabled, nothing to explain.
     */
    private fun renderSubtitlesButton() {
        b.subtitlesButton.visibility = if (subtitlesUsable) View.VISIBLE else View.GONE
        if (!subtitlesUsable) return
        val chosen = subtitleTracks.getOrNull(selectedSubtitle)
        b.subtitlesButton.text =
            if (chosen == null) "💬 Subtitles: Off" else "💬 ${chosen.label}"
        b.subtitlesButton.contentDescription =
            if (chosen == null) "Subtitles, currently off" else "Subtitles, currently ${chosen.label}"
    }

    /**
     * Off / on / which one, in one list.
     *
     * An AlertDialog because that is this screen's existing idiom for asking a question - the
     * Resume prompt is one - and because there is no menu surface here to hang a submenu off:
     * PlayerView's own controls are used exactly as they ship, and inventing a bespoke overlay
     * for a control most files will never show would be a lot of surface for very little. A
     * single-choice list covers all three cases at once, and with the usual single sidecar it
     * reads as a plain on/off.
     */
    private fun openSubtitlePicker() {
        if (!subtitlesUsable || isFinishing || isDestroyed) return
        if (castSessionActive) {
            // Said out loud rather than offered and quietly ignored. Media3 hands a MediaItem to
            // the receiver through DefaultMediaItemConverter, which does not carry subtitle
            // configurations across at all, and CastPlayer does not advertise
            // COMMAND_SET_TRACK_SELECTION_PARAMETERS - so on the TV there is nothing to select
            // and nothing to select it with.
            toast("Subtitles aren't available while casting to the TV.")
            return
        }
        // Typed as CharSequence so it matches setSingleChoiceItems' parameter exactly. Row 0 is
        // "Off", so a row index is one ahead of its index in subtitleTracks throughout.
        val labels = Array<CharSequence>(subtitleTracks.size + 1) { row ->
            if (row == 0) "Off" else subtitleTracks[row - 1].label
        }
        AlertDialog.Builder(this)
            .setTitle("Subtitles")
            .setSingleChoiceItems(labels, selectedSubtitle + 1) { dialog, row ->
                dialog.dismiss()
                chooseSubtitle(row - 1)
            }
            .setNegativeButton("Cancel") { dialog, _ -> dialog.dismiss() }
            .show()
    }

    /** [index] is a position in [subtitleTracks]; -1 turns subtitles off. */
    private fun chooseSubtitle(index: Int) {
        selectedSubtitle = index.takeIf { it in subtitleTracks.indices } ?: -1
        val chosen = subtitleTracks.getOrNull(selectedSubtitle)
        // Remembered from here on, across videos and restarts - see SessionStore.subtitlesOn for
        // why that is the right default rather than starting fresh each time.
        app.session.subtitlesOn = chosen != null
        if (chosen != null && chosen.lang.isNotBlank()) app.session.subtitleLanguage = chosen.lang
        // Turning them ON is the one moment a re-prepare is unquestionably worth it: it is what
        // the viewer just asked for, and they are watching the picture when it happens.
        if (chosen != null) attachSubtitlesIfNeeded()
        applySubtitleSelection()
        renderSubtitlesButton()
    }

    /* ------------------------------ listener -------------------------------- */

    private val playerListener = object : Player.Listener {

        /**
         * The service owns ⏮ / ⏭, so it can move to another episode without the UI asking.
         * Re-read our local copy of "what is playing" from the item itself rather than letting
         * it go stale — flagging, resume marks and the up-next lookup all key off it.
         */
        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
            choices.onItemTransition(mediaItem)
            if (mediaItem == null || surfMode) return
            val previousItemId = itemId
            val extras = mediaItem.mediaMetadata.extras
            itemId = extras?.getString(MediaMetadataBuilder.EXTRA_ITEM_ID)
                ?: mediaItem.mediaId.takeIf { it.isNotBlank() } ?: itemId
            extras?.getString(MediaMetadataBuilder.EXTRA_KIND)?.let { kind = it }
            mediaItem.mediaMetadata.title?.toString()?.takeIf { it.isNotBlank() }?.let { title = it }
            b.titleText.text = title
            upNextHandled = false
            hideUpNext()
            hideStatus()
            renderCastOverlay()
            updateAllEpisodesButton()
            updateMarkerButtons()
            startMarkerWatcher()
            refreshPipActions()
            // Only a genuinely different file needs its own track list. The same file arriving
            // again is the item being re-set to carry its sidecars (by the picker or the service), and
            // re-fetching there would leave the two chasing each other forever.
            if (itemId != previousItemId) {
                loadSubtitleTracks()
            } else {
                renderSubtitlesButton()
                applySubtitleSelection()
            }
        }

        /**
         * A side-loaded sidecar only becomes a selectable track once the player has merged it in,
         * which is well after setMediaItem returned. This is where a remembered choice actually
         * lands on a real track group.
         */
        override fun onTracksChanged(tracks: Tracks) {
            choices.onTracksChanged(tracks)
            applySubtitleSelection()
        }

        /**
         * Re-arm the countdown at the moment playback actually begins.
         *
         * This is the equivalent of the trap the website hit: a hide timer armed once at load
         * expires during buffering, and nothing re-arms it when the video finally starts. Pausing
         * takes the opposite branch and brings the chrome back up for good.
         */
        override fun onIsPlayingChanged(isPlaying: Boolean) {
            chrome.onIsPlayingChanged(isPlaying)
            refreshPipActions()
            b.root.keepScreenOn = isPlaying && !castSessionActive
            if (isPlaying) {
                // showController() restarts PlayerView's own timeout from now.
                b.playerView.showController()
            }
            applyChromeVisibility()
        }

        override fun onPlaybackStateChanged(playbackState: Int) {
            if (playbackState == Player.STATE_READY && awaitingFractionSeek) {
                val c = controller ?: return
                val dur = c.duration
                if (dur > 0) {
                    awaitingFractionSeek = false
                    c.seekTo(SurfNav.startPositionMs(dur, startFraction))
                }
            }
            b.loading.visibility = if (playbackState == Player.STATE_BUFFERING) View.VISIBLE else View.GONE
            if (playbackState == Player.STATE_READY) connectionRestored()
            if (playbackState == Player.STATE_ENDED) onPlaybackEnded()
        }

        override fun onPlayerError(error: PlaybackException) {
            Log.w(TAG, "Playback error", error)
            // A failed conversion falls back to the original; an original this device can't decode
            // moves to a conversion. Either way the viewer never sees the error.
            if (choices.onPlayerError(error)) return
            val decoderProblem = error.errorCode in setOf(
                PlaybackException.ERROR_CODE_DECODER_INIT_FAILED,
                PlaybackException.ERROR_CODE_DECODING_FAILED,
                PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES,
                PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED
            )
            if (isConnectionError(error)) {
                onConnectionLost()
                return
            }
            showStatus(describeError(error), offerCast = decoderProblem)
        }
    }

    private fun isConnectionError(error: PlaybackException): Boolean = error.errorCode in setOf(
        PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,
        PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT
    )

    /*
     * Owner, 2026-09-17: the connection dropped mid-episode, came back, and "Lost the connection to
     * the server." stayed on screen - nothing ever retried. Now the player keeps trying on its own
     * (straight away when the phone's network comes back, and on a back-off timer), resumes from
     * the same spot, and the message goes away the moment the video is playing again.
     */
    private fun onConnectionLost() {
        connectionLost = true
        showStatus(
            "Lost the connection to the server. Reconnecting…",
            offerCast = false,
            actionLabel = "Try again now"
        ) { retryAfterConnectionLoss() }
        watchForNetwork()
        reconnectJob?.cancel()
        reconnectJob = lifecycleScope.launch {
            // About ten minutes of tries, then it waits for the network callback or a tap.
            for (waitSeconds in listOf(3, 5, 10, 15, 30, 30, 60, 60, 60, 120, 120, 120)) {
                delay(waitSeconds * 1000L)
                if (!connectionLost || !isActive) return@launch
                retryAfterConnectionLoss()
            }
            if (connectionLost) {
                showStatus(
                    "Still can't reach the server. Check your internet, then try again.",
                    offerCast = false,
                    actionLabel = "Try again"
                ) { retryAfterConnectionLoss() }
            }
        }
    }

    private fun retryAfterConnectionLoss() {
        val c = controller ?: return
        if (!connectionLost) return
        if (c.playerError == null && c.playbackState != Player.STATE_IDLE) return
        Log.i(TAG, "Reconnecting playback at ${c.currentPosition} ms")
        c.prepare() // keeps the position; playWhenReady is unchanged, so it resumes if it was playing
    }

    private fun connectionRestored() {
        if (!connectionLost) return
        connectionLost = false
        reconnectJob?.cancel()
        reconnectJob = null
        stopWatchingForNetwork()
        hideStatus()
    }

    private fun watchForNetwork() {
        if (networkCallback != null) return
        val cm = getSystemService(android.net.ConnectivityManager::class.java) ?: return
        val cb = object : android.net.ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: android.net.Network) {
                // Give the new network a moment to finish coming up before asking the server again.
                b.root.postDelayed({ retryAfterConnectionLoss() }, 1500)
            }
        }
        runCatching { cm.registerDefaultNetworkCallback(cb) }.onSuccess { networkCallback = cb }
    }

    private fun stopWatchingForNetwork() {
        val cb = networkCallback ?: return
        networkCallback = null
        runCatching { getSystemService(android.net.ConnectivityManager::class.java)?.unregisterNetworkCallback(cb) }
    }

    /*
     * Owner, 2026-09-17: in landscape the player's buttons sat under the phone's own navigation
     * buttons. The system bars are hidden but come back on a swipe, and some phones keep the
     * navigation bar (or have a camera cutout) on the side. Pad every control layer - never the
     * video itself - by the system bars and cutout, measured whether or not the bars are showing,
     * so the buttons always stay clear of them.
     */
    private fun keepControlsClearOfSystemButtons() {
        // Full-width bars take padding; the floating Up Next card moves by its margins instead.
        val bars = listOf(b.topChrome, b.surfBar)
        val barPadding = bars.associateWith { intArrayOf(it.paddingLeft, it.paddingTop, it.paddingRight, it.paddingBottom) }
        val cardLp = b.upNextCard.layoutParams as? android.view.ViewGroup.MarginLayoutParams
        val cardMargins = cardLp?.let { intArrayOf(it.leftMargin, it.rightMargin, it.bottomMargin) }
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(b.root) { _, insets ->
            val system = insets.getInsetsIgnoringVisibility(androidx.core.view.WindowInsetsCompat.Type.systemBars())
            val cutout = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.displayCutout())
            val left = maxOf(system.left, cutout.left)
            val right = maxOf(system.right, cutout.right)
            val bottom = maxOf(system.bottom, cutout.bottom)
            for (v in bars) {
                val p = barPadding.getValue(v)
                v.setPadding(p[0] + left, p[1], p[2] + right, p[3] + if (v === b.topChrome) 0 else bottom)
            }
            if (cardLp != null && cardMargins != null) {
                cardLp.leftMargin = cardMargins[0] + left
                cardLp.rightMargin = cardMargins[1] + right
                cardLp.bottomMargin = cardMargins[2] + bottom
                b.upNextCard.layoutParams = cardLp
            }
            // Media3's own control surface (play/pause, seek bar, time) inside the PlayerView.
            b.playerView.findViewById<View>(androidx.media3.ui.R.id.exo_controller)?.setPadding(left, 0, right, bottom)
            insets
        }
        androidx.core.view.ViewCompat.requestApplyInsets(b.root)
    }

    private fun describeError(error: PlaybackException): String =
        RemoteStreamCapacity.messageFor(error)
            ?: when (error.errorCode) {
        PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS ->
            "The media link expired. Go back and open the item again to refresh it."
        PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,
        PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT ->
            "Lost the connection to the server."
        PlaybackException.ERROR_CODE_DECODER_INIT_FAILED,
        PlaybackException.ERROR_CODE_DECODING_FAILED,
        PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES,
        PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED ->
            "This phone can't decode this file (codec unsupported). Try casting it to the TV instead."
        else -> "Playback failed: ${error.errorCodeName}"
    }

    /* ------------------------------- transport -------------------------------- */

    /**
     * Our own ⏮ / ⏭.
     *
     * They drive the MediaController with setMediaItem rather than seekToNext, so they cannot be
     * blocked by the command-availability plumbing that left the built-in next button dead. The
     * service's ForwardingPlayer still handles the lock screen, notification and headset.
     */
    private fun setupTransportButtons() {
        b.prevButton.setOnClickListener { transportPrevious() }
        b.nextButton.setOnClickListener { transportNext() }
        b.introMarkerButton.setOnClickListener { saveIntroMarker() }
        b.creditsMarkerButton.setOnClickListener { saveCreditsMarker() }
        b.introUndoButton.setOnClickListener { undoIntroSkip() }

        // Keep the buttons honest as the cached /api/upnext answer arrives.
        lifecycleScope.launch {
            TransportCache.state.collect { state ->
                if (surfMode) return@collect
                b.nextButton.isEnabled = state.hasNext
                b.nextButton.alpha = if (state.hasNext) 1f else 0.4f
                // ⏮ is always live: with nothing before this, it restarts the current item.
                b.prevButton.isEnabled = true
                maybeSkipIntro()
                refreshPipActions()
            }
        }
    }

    /** ⏮ — restart if we are more than five seconds in, otherwise the previous episode. */
    private fun transportPrevious() {
        if (surfMode) return
        val c = controller ?: return
        val state = TransportCache.current
        when (TransportPolicy.previousAction(c.currentPosition, state.hasPrevious)) {
            TransportPolicy.PreviousAction.RESTART -> {
                c.seekTo(0L)
                c.play()
            }
            TransportPolicy.PreviousAction.GO_PREVIOUS ->
                state.previous?.let { playTransportItem(it) } ?: c.seekTo(0L)
        }
    }

    /** ⏭ — the next episode / collection part. */
    private fun transportNext() {
        if (surfMode) return
        val next = TransportCache.current.next
        if (next == null) {
            toast(TransportPolicy.NO_NEXT_MESSAGE)
            return
        }
        playTransportItem(next)
    }

    private fun playTransportItem(item: com.beeboentertainment.movie.data.UpNextItem) {
        val c = controller ?: return
        val mediaItem = MediaItemFactory.forUpNextItem(app.session.baseUrl, item) ?: return
        hideUpNext()
        hideStatus()
        autoAdvanceCancelled = false
        introSkipApplied = false
        viewerChosePosition = false
        upNextHandled = false
        c.setMediaItem(mediaItem, 0L)
        c.prepare()
        c.play()
    }

    /* -------------------------------- markers --------------------------------- */

    private fun updateMarkerButtons() {
        val show = MarkerPolicy.markersEnabled(surfMode) && itemId.isNotBlank()
        b.introMarkerButton.visibility = if (show) View.VISIBLE else View.GONE
        b.creditsMarkerButton.visibility = if (show) View.VISIBLE else View.GONE
    }

    /** "⤴ Intro ends here" — pressing it again simply re-saves, which is how a mistake is fixed. */
    private fun saveIntroMarker() {
        val c = controller ?: return
        val seconds = c.currentPosition / 1000.0
        val durationSeconds = c.duration.takeIf { it > 0 }?.let { it / 1000.0 } ?: 0.0
        MarkerPolicy.introRejectionReason(seconds, durationSeconds)?.let {
            toast(it)
            return
        }
        lifecycleScope.launch {
            try {
                app.api.saveMarkers(
                    kind = kind,
                    id = itemId,
                    introEndSeconds = seconds,
                    durationSeconds = durationSeconds.takeIf { it > 0 }
                )
                TransportCache.updateIntro(itemId, seconds)
                toast("Intro end saved at ${formatMs(c.currentPosition)}.")
            } catch (e: com.beeboentertainment.movie.data.UnauthorizedException) {
                bounceToLogin()
            } catch (e: Exception) {
                toast("Couldn't save that: ${e.message}")
            }
        }
    }

    /** "⏭ Credits start here" — same deal, and it makes the next episode roll sooner. */
    private fun saveCreditsMarker() {
        val c = controller ?: return
        val seconds = c.currentPosition / 1000.0
        val durationSeconds = c.duration.takeIf { it > 0 }?.let { it / 1000.0 } ?: 0.0
        MarkerPolicy.creditsRejectionReason(seconds, durationSeconds)?.let {
            toast(it)
            return
        }
        lifecycleScope.launch {
            try {
                app.api.saveMarkers(
                    kind = kind,
                    id = itemId,
                    creditsStartSeconds = seconds,
                    durationSeconds = durationSeconds.takeIf { it > 0 }
                )
                TransportCache.updateCredits(itemId, seconds)
                toast(
                    if (kind == "tv") "Credits start saved — every episode of this show will roll on here."
                    else "Credits start saved at ${formatMs(c.currentPosition)}."
                )
            } catch (e: com.beeboentertainment.movie.data.UnauthorizedException) {
                bounceToLogin()
            } catch (e: Exception) {
                toast("Couldn't save that: ${e.message}")
            }
        }
    }

    /**
     * Jump past a known intro, once per item, and offer a way back.
     * Never when the viewer asked for a specific position — moving them somewhere they did not
     * choose would be worse than showing the intro.
     */
    private fun maybeSkipIntro() {
        if (surfMode || introSkipApplied) return
        val c = controller ?: return
        val state = TransportCache.current
        if (!state.markersLoaded || state.itemId != itemId) return
        val durationSeconds = c.duration.takeIf { it > 0 }?.let { it / 1000.0 } ?: return
        val shouldSkip = MarkerPolicy.shouldSkipIntro(
            introEndSeconds = state.introEndSeconds,
            durationSeconds = durationSeconds,
            startPositionMs = c.currentPosition,
            viewerChosePosition = viewerChosePosition
        )
        if (!shouldSkip) return
        introSkipApplied = true
        c.seekTo(MarkerPolicy.introEndMs(state.introEndSeconds))
        toast("Skipped intro")
        showIntroUndo()
    }

    private fun showIntroUndo() {
        introUndoJob?.cancel()
        b.introUndoButton.visibility = View.VISIBLE
        showChrome()
        introUndoJob = lifecycleScope.launch {
            delay(8_000)
            b.introUndoButton.visibility = View.GONE
        }
    }

    private fun undoIntroSkip() {
        introUndoJob?.cancel()
        b.introUndoButton.visibility = View.GONE
        controller?.seekTo(0L)
        controller?.play()
    }

    /**
     * Watches for the credits marker, or — with no marker — the last twenty seconds of the file,
     * and brings up the "up next" card so the next episode rolls without waiting for the credits.
     */
    private fun startMarkerWatcher() {
        markerJob?.cancel()
        if (!MarkerPolicy.markersEnabled(surfMode)) return
        markerJob = lifecycleScope.launch {
            while (isActive) {
                delay(1_000)
                if (upNextHandled || autoAdvanceCancelled) continue
                val c = controller ?: continue
                if (!c.isPlaying) continue
                val state = TransportCache.current
                if (state.itemId != itemId) continue
                maybeSkipIntro()
                val due = MarkerPolicy.shouldShowUpNextCard(
                    positionMs = c.currentPosition,
                    durationMs = c.duration,
                    creditsStartSeconds = state.creditsStartSeconds,
                    cancelled = autoAdvanceCancelled
                )
                if (!due) continue
                val next = state.next ?: continue
                upNextHandled = true
                val hasMarker =
                    MarkerPolicy.creditsTriggerMs(state.creditsStartSeconds, c.duration) != null
                showUpNextCard(next, hasCreditsMarker = hasMarker)
            }
        }
    }

    /* ---------------------------- all episodes -------------------------------- */

    /** Only offered for TV, and never in surf mode (surf is a pool, not a series). */
    private fun updateAllEpisodesButton() {
        val show = !surfMode && kind == "tv" && itemId.isNotBlank()
        b.allEpisodesButton.visibility = if (show) View.VISIBLE else View.GONE
    }

    /**
     * "📺 All episodes" — open the show this episode belongs to.
     *
     * The show key comes from /api/episode-context, with the showKey already attached to a
     * cached up-next item as a free shortcut when we happen to have one.
     */
    private fun openAllEpisodes() {
        if (itemId.isBlank()) return
        b.allEpisodesButton.isEnabled = false
        lifecycleScope.launch {
            val key = try {
                app.api.episodeContext(itemId).showKey
            } catch (e: com.beeboentertainment.movie.data.UnauthorizedException) {
                bounceToLogin()
                return@launch
            } catch (e: Exception) {
                null
            }
            b.allEpisodesButton.isEnabled = true
            if (key.isNullOrBlank()) {
                toast("Couldn't work out which show this is.")
                return@launch
            }
            startActivity(
                Intent(this@PlayerActivity, MainActivity::class.java).apply {
                    putExtra(MainActivity.EXTRA_OPEN_SHOW_KEY, key)
                    flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
                }
            )
            finish()
        }
    }

    /* ------------------------------- up next --------------------------------- */

    /**
     * Playback finished. Ask the server what comes next and offer it with a countdown.
     *
     * The client derives nothing: GET /api/upnext is the single definition of "next" shared with
     * the website and the desktop app, and it covers both kinds — the following episode (across
     * season boundaries) for TV, the next part of the collection for movies.
     *
     * Surf mode is deliberately excluded: it has its own Next button and its own pool order.
     */
    private fun onPlaybackEnded() {
        if (surfMode || upNextHandled) return
        upNextHandled = true
        if (itemId.isBlank()) return
        lifecycleScope.launch { resolveUpNext() }
    }

    private suspend fun resolveUpNext() {
        if (autoAdvanceCancelled) return
        // The service has usually already fetched this for the transport buttons.
        TransportCache.current.takeIf { it.itemId == itemId && it.transportLoaded }?.next?.let {
            showUpNextCard(it)
            return
        }
        val response = try {
            app.api.upNext(kind, itemId)
        } catch (_: Exception) {
            return   // offline or unreachable: just stop, never block on the credits roll
        }

        val next = response.next
        val missing = response.missing
        when {
            next != null -> showUpNextCard(next)

            missing != null -> {
                reportMissing(missing)
                showStatus(
                    UpNextResolver.missingMessage(missing.title),
                    offerCast = false,
                    actionLabel = "OK",
                    action = { hideStatus() }
                )
            }

            else -> Unit   // end of series / collection
        }
    }

    private fun showUpNextCard(item: UpNextItem, hasCreditsMarker: Boolean = false) {
        upNextJob?.cancel()
        b.upNextTitle.text = UpNextResolver.upNextLabel(item.title)
        b.upNextCard.visibility = View.VISIBLE
        chrome.onUpNextChanged(true)
        b.playerView.showController()
        applyChromeVisibility()
        b.upNextPlay.setOnClickListener {
            hideUpNext()
            playUpNext(item)
        }
        b.upNextCancel.setOnClickListener {
            // Cancel stops the advance for the WHOLE of this playback, end of file included.
            autoAdvanceCancelled = true
            hideUpNext()
        }
        // A marker is a fact, the natural end is a guess, so the marker gets the shorter grace.
        val grace = MarkerPolicy.graceSecondsFor(hasCreditsMarker)
        upNextJob = lifecycleScope.launch {
            for (remaining in grace downTo 1) {
                b.upNextCountdown.text = MarkerPolicy.countdownLabel(remaining, hasCreditsMarker)
                delay(1_000)
            }
            hideUpNext()
            if (MarkerPolicy.advanceAllowed(autoAdvanceCancelled)) playUpNext(item)
        }
    }

    private fun hideUpNext() {
        upNextJob?.cancel()
        upNextJob = null
        b.upNextCard.visibility = View.GONE
        chrome.onUpNextChanged(false)
        applyChromeVisibility()
    }

    /**
     * Switch the player over to whatever the server said was next.
     * The item carries its own kind, because a collection part is a movie and an episode is TV.
     */
    private fun playUpNext(item: UpNextItem) {
        autoAdvanceCancelled = false
        introSkipApplied = false
        viewerChosePosition = false
        itemId = item.id
        kind = item.kind
        title = item.title
        streamUrl = com.beeboentertainment.movie.core.UrlUtils.join(app.session.baseUrl, item.stream)
        com.beeboentertainment.movie.core.UrlUtils.join(app.session.baseUrl, item.poster)?.let { posterUrl = it }
        localPath = app.downloads.localPath(item.id)
        startFraction = 0.0
        b.titleText.text = title
        renderCastOverlay()
        hideStatus()
        beginPlayback(0L)
    }

    /**
     * Tell the admin about the gap.
     *
     * The `missing` object is posted back EXACTLY as the server sent it — same type, same fields,
     * nothing re-derived here (for TV its tmdbId is the show's id, which we simply pass through).
     * The server dedupes; the local set just stops one sitting posting twice.
     */
    private fun reportMissing(missing: MissingRequest) {
        val dedupeKey = listOf(
            missing.kind,
            missing.showName.orEmpty(),
            missing.season?.toString().orEmpty(),
            missing.episode?.toString().orEmpty(),
            missing.title.orEmpty()
        ).joinToString("|")
        if (!reportedMissing.add(dedupeKey)) return
        lifecycleScope.launch {
            runCatching { app.api.missingRequest(missing) }
        }
    }

    /* -------------------------------- misc ---------------------------------- */

    private var statusAction: (() -> Unit)? = null

    private fun showStatus(
        message: String,
        offerCast: Boolean,
        actionLabel: String? = null,
        action: (() -> Unit)? = null
    ) {
        b.statusText.text = message
        b.statusBox.visibility = View.VISIBLE
        statusAction = action
        if (action != null) {
            b.statusAction.text = actionLabel ?: "OK"
            b.statusAction.visibility = View.VISIBLE
        } else {
            b.statusAction.text = "Try casting instead"
            b.statusAction.visibility = if (offerCast) View.VISIBLE else View.GONE
        }
        b.loading.visibility = View.GONE
    }

    private fun hideStatus() {
        b.statusBox.visibility = View.GONE
        statusAction = null
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_LONG).show()

    private fun bounceToLogin() {
        app.session.logout()
        toast("Session expired — please sign in again.")
        finish()
    }

    private fun hideSystemBars() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.insetsController?.hide(android.view.WindowInsets.Type.systemBars())
            window.insetsController?.systemBarsBehavior =
                android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility =
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                    View.SYSTEM_UI_FLAG_FULLSCREEN or
                    View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        }
    }

    /**
     * The screen just turned off, or the user left the app.
     *
     * This is the single place the toggle takes effect: with it OFF we pause (normal phone
     * behaviour); with it ON we do nothing and PlaybackService keeps decoding. A live cast
     * session always wins — the TV keeps playing either way.
     */
    override fun onStop() {
        super.onStop()
        val c = controller
        if (c != null && BackgroundPlaybackPolicy.shouldPauseOnBackground(
                keepPlayingEnabled = app.session.keepPlayingInBackground,
                isCasting = castSessionActive,
                isPlaying = c.isPlaying
            )
        ) {
            c.pause()
        }
        // The service keeps its own resume mark up to date, but persist one now too so a
        // resume point is never lost if the process is killed while backgrounded.
        if (c != null && itemId.isNotBlank() && !surfMode) {
            app.resume.save(itemId, c.currentPosition, c.duration)
        }
    }

    override fun onDestroy() {
        reconnectJob?.cancel()
        stopWatchingForNetwork()
        upNextJob?.cancel()
        partyLoadJob?.cancel()
        markerJob?.cancel()
        introUndoJob?.cancel()
        subtitleJob?.cancel()
        // Tear down the remote-stream connector. The party controller is released by
        // rememberParty's DisposableEffect when the party ComposeView disposes with the window.
        runCatching { webRtcConnector.value?.close() }
        webRtcConnector.value = null
        partyPlayer.value = null
        // Leaves the watch-together room (if in one) and stops following it.
        runCatching { wt?.close() }
        wt = null
        wtSession.value = null
        runCatching { unregisterReceiver(pipReceiver) }
        runCatching { castSessionWatch?.close() }
        castSessionWatch = null
        val c = controller
        if (c != null && itemId.isNotBlank() && !surfMode) {
            app.resume.save(itemId, c.currentPosition, c.duration)
        }
        // Closing the player (back button / finish) tears the service down so its notification
        // goes away. Backgrounding does NOT reach here, which is exactly the distinction we want.
        val stopService = BackgroundPlaybackPolicy.shouldStopServiceOnClose(
            isFinishing = isFinishing,
            isCasting = castSessionActive
        )
        if (stopService) {
            runCatching { c?.stop() }
        }
        b.playerView.player = null
        c?.removeListener(playerListener)
        c?.release()
        controller = null
        if (stopService) {
            runCatching { stopService(Intent(this, PlaybackService::class.java)) }
        }
        super.onDestroy()
    }
}

/* ============================ Compose overlays ============================= */

/**
 * The watch-party control sheet, hosted in a side panel over the player.
 *
 * It builds the [com.beeboentertainment.movie.party.PartyController] from the live player via
 * [rememberParty] (null player / no hub token -> null controller, so joining is disabled) and
 * drops in the ported [PartyScreen] whole: roster, Host/Join toggle, [AudioDelaySlider], and the
 * movable/resizable/hideable [com.beeboentertainment.movie.party.VideoWindow]. "Pop out" is wired to PiP.
 */
@Composable
private fun PartySheet(
    session: SessionStore,
    player: Player?,
    deviceName: String,
    onLoadVideo: (String) -> Unit,
    onPopOut: () -> Unit,
    onClose: () -> Unit,
) {
    val controller = rememberParty(session = session, player = player, onLoadVideo = onLoadVideo)
    Box(
        Modifier
            .fillMaxSize()
            .background(Color(0xCC000000)),
    ) {
        Column(
            Modifier
                .align(Alignment.CenterEnd)
                .fillMaxHeight()
                .width(380.dp)
                .background(MaterialTheme.colorScheme.surface)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "Watch together",
                    style = MaterialTheme.typography.titleLarge,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = onClose) { Text("Close") }
            }
            if (player == null) {
                Text(
                    "Connecting to the player…",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            PartyScreen(
                session = session,
                deviceName = deviceName,
                controller = controller,
                onPopOut = onPopOut,
            )
        }
    }
}

/**
 * Full-screen WebRTC receiver.
 *
 * Observes the connector's [WebRtcConnector.state] for the Connecting / PeerOffline / Failed
 * banners, and when a [org.webrtc.VideoTrack] arrives hosts a SurfaceViewRenderer built by
 * [WebRtcConnector.createRenderer]. The [DisposableEffect] attaches the track's sink on
 * composition and releases the renderer (and detaches the sink) on dispose.
 */
@Composable
private fun RemoteStreamOverlay(
    connector: WebRtcConnector?,
    onClose: () -> Unit,
) {
    Box(
        Modifier
            .fillMaxSize()
            .background(Color.Black),
    ) {
        if (connector == null) {
            Text(
                "Starting remote session…",
                color = Color.White,
                modifier = Modifier.align(Alignment.Center),
            )
        } else {
            val state by connector.state.collectAsState()
            val track by connector.remoteVideo.collectAsState()
            val context = LocalContext.current
            val currentTrack = track
            if (currentTrack != null) {
                // createRenderer inits the renderer on the (UI) thread this composition runs on.
                val renderer = remember(currentTrack) { connector.createRenderer(context) }
                if (renderer != null) {
                    AndroidView(factory = { renderer }, modifier = Modifier.fillMaxSize())
                    DisposableEffect(currentTrack, renderer) {
                        currentTrack.addSink(renderer)
                        onDispose { connector.releaseRenderer(renderer, currentTrack) }
                    }
                }
            }
            // TODO(device): confirm the SurfaceViewRenderer actually shows the PC picture.
            val status: String? = when (val s = state) {
                is WebRtcConnector.State.Idle -> "Starting…"
                is WebRtcConnector.State.Connecting -> "Connecting to your PC…"
                is WebRtcConnector.State.Connected ->
                    if (currentTrack == null) "Connected — waiting for video…" else null
                is WebRtcConnector.State.PeerOffline -> "Your PC isn't online right now."
                is WebRtcConnector.State.Failed -> s.reason
            }
            status?.let {
                Text(
                    it,
                    color = Color.White,
                    modifier = Modifier
                        .align(Alignment.Center)
                        .padding(24.dp),
                )
            }
        }
        IconButton(
            onClick = onClose,
            modifier = Modifier
                .align(Alignment.TopEnd)
                .padding(8.dp),
        ) {
            Icon(Icons.Filled.Close, contentDescription = "Close remote stream", tint = Color.White)
        }
    }
}
