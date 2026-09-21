package com.beeboentertainment.movie.player

import android.net.Uri
import android.util.Log
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.AudioOption
import com.beeboentertainment.movie.core.AutoQuality
import com.beeboentertainment.movie.core.DownmixStyle
import com.beeboentertainment.movie.core.NetworkPathKind
import com.beeboentertainment.movie.core.PassthroughSetting
import com.beeboentertainment.movie.core.PlaybackSheetModel
import com.beeboentertainment.movie.core.QualityChoice
import com.beeboentertainment.movie.core.QualityLabel
import com.beeboentertainment.movie.core.SubtitleOption
import com.beeboentertainment.movie.core.SoundMode
import com.beeboentertainment.movie.core.SoundPrefs
import com.beeboentertainment.movie.core.SoundRules
import com.beeboentertainment.movie.core.SubtitlePolicy
import com.beeboentertainment.movie.core.TrackChoice
import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.data.AudioCapsRequest
import com.beeboentertainment.movie.data.PlaybackApi
import com.beeboentertainment.movie.data.PlaybackAudioPlan
import com.beeboentertainment.movie.data.PlaybackInfo
import com.beeboentertainment.movie.data.PlaybackPrefsUpdate
import com.beeboentertainment.movie.data.PlaybackRefusedException
import com.beeboentertainment.movie.data.PlaybackStartRequest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Plex-style "Quality & audio" for the phone and TV player.
 *
 * Owns, for the file on screen: which quality plays (the original file, or a live HLS conversion
 * on the computer), which audio track, and which subtitles. It swaps the stream under the same
 * MediaItem (same id, metadata and position), so the notification, resume marks and watch history
 * carry straight on. Everything goes through the app's OkHttp client and therefore also works over
 * the away-from-home tunnel and Beebo Relay.
 *
 * When the server is older (no /api/playback) or the file is a download, [active] stays false and
 * the player's older sidecar-only subtitle button is left in charge.
 */
@UnstableApi
class PlaybackChoicesController(
    private val activity: AppCompatActivity,
    private val player: () -> Player?,
    private val isTv: Boolean,
    /** The gear button's text, or null to hide it. */
    private val onLabel: (String?) -> Unit,
    private val toast: (String) -> Unit
) {
    private val app = BeeboApp.instance
    val api = PlaybackApi(app.api.okHttp, { app.session.baseUrl }, { app.session.token })

    /** True once this server answered for the file on screen: the sheet replaces the old subtitle button. */
    var active = false
        private set

    private var itemId = ""
    private var kind = "movie"
    var info: PlaybackInfo? = null
        private set
    private var originalUri: String? = null
    private var originalMime: String? = null

    private var quality = QualityChoice.fromId(app.session.plain.getString(PREF_QUALITY, null))
    private var playing = QualityChoice.ORIGINAL
    private var audio: AudioOption? = null
    private var subtitle: SubtitleOption? = null
    private var ticket = ""
    private var burning: Int? = null
    private var casting = false
    private var fellBack = false
    private var measured: Pair<Long, Int>? = null
    private var loadJob: Job? = null
    private var switchJob: Job? = null
    private var attachedEmbeddedKey: String? = null
    private var resumedConversion = false

    /** The remembered sound choices (per account, on the computer) and this device's own passthrough switch. */
    private var sound = SoundPrefs()
    private var passthrough = PassthroughSetting.fromId(app.session.plain.getString(PassthroughSetting.PREF_KEY, null))
    private var lastPlan: PlaybackAudioPlan? = null

    /** False for a server that predates the sound options: nothing about sound is asked of it then. */
    private val soundSupported: Boolean get() = info?.soundOptions != null

    /* Chapters, seek previews, subtitle look and film versions: each is optional on the server and hides itself when absent. */
    private val extrasApi = PlaybackExtrasApi(app.api.okHttp, { app.session.baseUrl }, { app.session.token })
    val chapters = ChapterController(activity, player)
    private val scrub = ScrubPreviewController(
        activity, extrasApi, isTv, { chapters.navigator },
        { player()?.duration?.takeIf { it != C.TIME_UNSET } ?: 0L }
    )
    private val subtitleStore = SubtitleStyleStore(app.session.plain)
    private var subtitleStyle = subtitleStore.style
    private var versions: List<VideoVersion> = emptyList()
    private val versionChecked = mutableSetOf<String>()

    /** False when the viewer resumed a film they were already in: it is never swapped for another version behind them. */
    var autoVersionEnabled = true

    init {
        if (!subtitleStore.useSystem && subtitleStore.hasStyle) applySubtitleStyle()
    }

    /* ----------------------------------------------------------- lifecycle */

    /** Called for every MediaItem transition the player reports. */
    fun onItemTransition(item: MediaItem?) {
        item ?: return
        val extras = item.mediaMetadata.extras
        val id = extras?.getString(PlaybackService.EXTRA_ITEM_ID)?.takeIf { it.isNotBlank() } ?: item.mediaId
        // The same file again is our own stream swap, the service adding sidecars, or a cast
        // handing it back - nothing to decide.
        if (id == itemId) return
        stopTicket()
        itemId = id
        kind = extras?.getString(PlaybackService.EXTRA_KIND) ?: "movie"
        info = null
        active = false
        chapters.clear()
        versions = emptyList()
        scrub.reset()
        audio = null
        subtitle = null
        burning = null
        fellBack = false
        attachedEmbeddedKey = null
        playing = QualityChoice.ORIGINAL
        loadJob?.cancel()
        switchJob?.cancel()
        val uri = item.localConfiguration?.uri?.toString()
        if (id.isBlank() || uri == null || !SubtitlePolicy.isStream(uri)) {
            onLabel(null)
            return
        }
        // Coming back to a conversion that kept playing in the background: the item remembers
        // what it was converted from.
        val remembered = extras?.getString(EXTRA_ORIGINAL_URI)
        if (uri.contains("/hls/") && remembered != null) {
            originalUri = remembered
            originalMime = extras.getString(EXTRA_ORIGINAL_MIME)
            playing = QualityChoice.fromId(extras.getString(EXTRA_PLAYING)).takeIf { it.isTranscode } ?: QualityChoice.P720
            ticket = extras.getString(EXTRA_TICKET).orEmpty()
            resumedConversion = true
        } else if (uri.contains("/hls/")) {
            onLabel(null)
            return
        } else {
            originalUri = uri
            originalMime = item.localConfiguration?.mimeType
            resumedConversion = false
        }
        loadJob = activity.lifecycleScope.launch { load(id) }
        scrub.start(kind, id)
    }

    private suspend fun load(id: String) {
        val i = try {
            api.info(kind, id)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.d(TAG, "No playback choices for $id: ${e.message}")
            onLabel(null)
            return
        }
        if (id != itemId || !i.ok) return
        info = i
        active = true
        // The account/profile's saved quality on the computer wins over this device's copy.
        quality = QualityChoice.fromId(i.prefs.quality.ifBlank { app.session.plain.getString(PREF_QUALITY, null) })
        audio = TrackChoice.rememberedAudio(i.audioOptions, i.prefs.audioLanguage.ifBlank { app.session.plain.getString(PREF_AUDIO_LANG, null) })
        subtitle = TrackChoice.rememberedSubtitle(
            i.subtitleOptions,
            subtitlesOn = app.session.subtitlesOn || i.prefs.subtitlesOn,
            language = app.session.subtitleLanguage ?: i.prefs.subtitleLanguage
        )
        sound = SoundPrefs(
            mode = SoundMode.fromId(i.prefs.audioMode),
            downmix = DownmixStyle.fromId(i.prefs.downmix),
            night = i.prefs.night,
            normalize = i.prefs.normalize,
            delayMs = SoundPrefs.clampDelay(i.prefs.audioDelayMs)
        )
        lastPlan = null
        chapters.set(ChapterParser.parse(i.chapters))
        versions = VersionParser.parse(i.versions)
        i.prefs.subtitleStyle?.let {
            subtitleStyle = SubtitleStyle.parse(it)
            subtitleStore.style = subtitleStyle
            if (!subtitleStore.useSystem) applySubtitleStyle()
        }
        onLabel(QualityLabel.current(quality, playing))
        val checked = id in versionChecked
        versionChecked += id
        val preferred = VersionParser.autoSwitchTarget(id, VersionParser.preferredId(i.preferredVersionId), versions, checked || !autoVersionEnabled)
        if (preferred != null && switchToVersion(preferred)) return
        if (resumedConversion) {
            player()?.let { applySelections(it.currentTracks) }
            return
        }
        val target = resolve(quality)
        if (target != QualityChoice.ORIGINAL || needsReattach(subtitle)) applyStream(target)
        else player()?.let { applySelections(it.currentTracks) }
    }

    /** Casting started or stopped. A TV that can't play the original gets a conversion instead. */
    fun onCastingChanged(active: Boolean) {
        casting = active
        val i = info ?: return
        if (!active) return
        if (relayingThroughPhone()) {
            // Away from home the film goes to the TV through this phone exactly as it is, so
            // there is no converting it on the way. Say so if that means it can't be cast.
            if (playing == QualityChoice.ORIGINAL && !i.direct.castSafe) {
                toast(com.beeboentertainment.movie.rtc.CastRule.CANT_CONVERT_AWAY)
            }
            return
        }
        if (playing == QualityChoice.ORIGINAL && !i.direct.castSafe && i.transcode.available) {
            switchTo { applyStream(bestFor(i)) }
        }
    }

    /**
     * Casting away from home, where this phone is what carries the video to the TV
     * (PhoneCastRelay). Only whole files can be passed on that way.
     */
    private fun relayingThroughPhone(): Boolean = casting && runCatching {
        com.beeboentertainment.movie.rtc.RemoteAccess.castDecision()
    }.getOrNull() is com.beeboentertainment.movie.rtc.CastRule.Decision.ViaPhone

    /**
     * A playback error. Returns true when handled here: a conversion that failed falls back to the
     * original, and an original this device can't decode moves to a conversion.
     */
    fun onPlayerError(error: PlaybackException): Boolean {
        val i = info ?: return false
        if (!active || fellBack) return false
        if (playing.isTranscode) {
            fellBack = true
            toast("The converted stream stopped, so the original is playing instead.")
            switchTo { applyStream(QualityChoice.ORIGINAL) }
            return true
        }
        val decoder = error.errorCode in setOf(
            PlaybackException.ERROR_CODE_DECODER_INIT_FAILED,
            PlaybackException.ERROR_CODE_DECODING_FAILED,
            PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES,
            PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED,
            PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED
        )
        if (decoder && i.transcode.available) {
            fellBack = true
            toast("This device can't play the original file, so your computer is converting it.")
            switchTo { applyStream(bestFor(i)) }
            return true
        }
        return false
    }

    fun onTracksChanged(tracks: Tracks) {
        if (active) applySelections(tracks)
    }

    /** The screen is going away for good while nothing keeps playing: free the computer's conversion. */
    fun release(stillPlaying: Boolean) {
        loadJob?.cancel()
        if (!stillPlaying) stopTicket()
    }

    /* --------------------------------------------------------------- sheet */

    fun openSheet() {
        val i = info
        if (i == null) {
            toast("Quality choices aren't available for this video.")
            return
        }
        val offline = false
        val sections = PlaybackSheetModel.build(
            state = PlaybackSheetModel.State(quality, playing, audio?.streamIndex, subtitle?.key),
            originalLabel = i.original.label,
            offered = i.offered,
            transcodeAvailable = i.transcode.available,
            transcodeReason = i.transcode.reason,
            audio = i.audioOptions,
            subtitles = i.subtitleOptions,
            offline = offline,
            awayQualityCapHeight = activeAwayQualityCapHeight(i),
            sound = if (!soundSupported) null else SoundRules.section(
                prefs = sound,
                passthrough = passthrough,
                device = DeviceAudioProbe.read(activity),
                now = nowPlaying(i),
                conversionAvailable = i.transcode.available,
                anyWideTrack = i.audio.any { (it.channels ?: 0) > 2 },
                surroundAvailable = i.soundOptions?.surroundAvailable == true,
                offline = offline
            )
        )
        val extras = buildList {
            if (versions.size > 1) add(versionSection())
            add(SubtitleStyleSection(subtitleStore.useSystem, subtitleStyle, ::onSubtitleStyleChanged))
        }
        PlaybackSheet.show(activity, sections, isTv, extras) { row -> onRow(row) }
    }

    /* ------------------------------------------------- versions, subtitle look */

    private fun versionSection() = SheetExtra { sheet ->
        PlaybackSheet.addHeader(sheet, "Version")
        for (v in versions) {
            PlaybackSheet.addChoiceRow(sheet, v.title, v.detail, v.isCurrent) {
                sheet.dismiss()
                chooseVersion(v)
            }
        }
    }

    private fun chooseVersion(v: VideoVersion) {
        if (v.isCurrent) return
        val asked = itemId
        activity.lifecycleScope.launch { extrasApi.post(VersionWire.PATH, VersionWire.body(asked, v.id)) }
        if (!switchToVersion(v)) toast("Saved. This version plays the next time you open the film.")
    }

    /**
     * Plays [v] from the same position. Needs an address for it from the computer; without one the
     * choice is only remembered. The new file is a new item id, so its own tracks, chapters and
     * previews are asked for when the player reports the change.
     */
    private fun switchToVersion(v: VideoVersion): Boolean {
        val absolute = UrlUtils.join(app.session.baseUrl, v.stream) ?: return false
        val p = player() ?: return false
        val item = p.currentMediaItem ?: return false
        versionChecked += v.id
        stopTicket()
        val extras = android.os.Bundle(item.mediaMetadata.extras ?: android.os.Bundle()).apply {
            putString(PlaybackService.EXTRA_ITEM_ID, v.id)
            remove(EXTRA_ORIGINAL_URI)
            remove(EXTRA_ORIGINAL_MIME)
            remove(EXTRA_PLAYING)
            remove(EXTRA_TICKET)
        }
        val replacement = item.buildUpon()
            .setMediaId(v.id)
            .setUri(castable(absolute))
            .setMimeType(com.beeboentertainment.movie.core.MimeGuess.forStreamUrl(absolute, item.mediaMetadata.title?.toString()))
            .setSubtitleConfigurations(emptyList())
            .setMediaMetadata(item.mediaMetadata.buildUpon().setExtras(extras).build())
            .build()
        val positionMs = p.currentPosition
        val wasPlaying = p.playWhenReady
        p.setMediaItem(replacement, positionMs)
        p.prepare()
        p.playWhenReady = wasPlaying
        return true
    }

    private fun onSubtitleStyleChanged(useSystem: Boolean, new: SubtitleStyle, changed: SubtitleStyle?, leftSystemMode: Boolean) {
        val before = subtitleStyle
        subtitleStore.useSystem = useSystem
        subtitleStyle = new
        subtitleStore.style = new
        applySubtitleStyle()
        // Leaving system mode saves the whole look so the computer has it; a later tap saves only what changed.
        val patch = when {
            leftSystemMode -> new.toJson()
            changed != null -> new.patchFrom(before)
            else -> null
        }
        if (patch != null && patch.isNotEmpty()) {
            val body = PlaybackWire.subtitleStylePatch(patch)
            activity.lifecycleScope.launch { extrasApi.post(PlaybackWire.PREFS_PATH, body) }
        }
    }

    private fun applySubtitleStyle() {
        val view = activity.findViewById<androidx.media3.ui.PlayerView>(com.beeboentertainment.movie.R.id.playerView)?.subtitleView ?: return
        SubtitleStyleApplier.apply(view, subtitleStore.useSystem, subtitleStyle)
    }

    private fun onRow(row: PlaybackSheetModel.Row) {
        val i = info ?: return
        when (row.action) {
            PlaybackSheetModel.Action.QUALITY -> {
                quality = QualityChoice.fromId(row.key)
                fellBack = false
                app.session.plain.edit().putString(PREF_QUALITY, quality.id).apply()
                savePrefs(PlaybackPrefsUpdate(quality = quality.id))
                onLabel(QualityLabel.current(quality, playing))
                switchTo { applyStream(resolve(quality)) }
            }
            PlaybackSheetModel.Action.AUDIO -> {
                val chosen = i.audioOptions.firstOrNull { it.streamIndex.toString() == row.key } ?: return
                audio = if (chosen == TrackChoice.defaultAudio(i.audioOptions)) null else chosen
                if (chosen.language.isNotBlank()) {
                    app.session.plain.edit().putString(PREF_AUDIO_LANG, chosen.language).apply()
                    savePrefs(PlaybackPrefsUpdate(audioLanguage = chosen.language))
                }
                if (playing.isTranscode) switchTo { applyStream(playing) }
                else if (soundNeedsConversion(i)) switchTo { applyStream(resolve(quality)) }
                else player()?.let { applySelections(it.currentTracks) }
            }
            PlaybackSheetModel.Action.SOUND_MODE -> changeSound(PlaybackPrefsUpdate(audioMode = row.key)) { it.copy(mode = SoundMode.fromId(row.key)) }
            PlaybackSheetModel.Action.DOWNMIX -> changeSound(PlaybackPrefsUpdate(downmix = row.key)) { it.copy(downmix = DownmixStyle.fromId(row.key)) }
            PlaybackSheetModel.Action.NIGHT -> changeSound(PlaybackPrefsUpdate(night = !sound.night)) { it.copy(night = !it.night) }
            PlaybackSheetModel.Action.NORMALIZE -> changeSound(PlaybackPrefsUpdate(normalize = !sound.normalize)) { it.copy(normalize = !it.normalize) }
            PlaybackSheetModel.Action.DELAY -> {
                val ms = SoundPrefs.clampDelay(row.key.toIntOrNull() ?: 0)
                changeSound(PlaybackPrefsUpdate(audioDelayMs = ms)) { it.copy(delayMs = ms) }
            }
            PlaybackSheetModel.Action.PASSTHROUGH -> {
                passthrough = PassthroughSetting.fromId(row.key)
                app.session.plain.edit().putString(PassthroughSetting.PREF_KEY, passthrough.id).apply()
                // The sink decides what it accepts when the stream is prepared, so put it back on the player.
                switchTo { applyStream(if (playing == QualityChoice.AUTO) QualityChoice.ORIGINAL else playing) }
            }
            PlaybackSheetModel.Action.INFO -> Unit
            PlaybackSheetModel.Action.SUBTITLE_OFF -> chooseSubtitle(null)
            PlaybackSheetModel.Action.SUBTITLE -> chooseSubtitle(i.subtitleOptions.firstOrNull { it.key == row.key })
            PlaybackSheetModel.Action.SEARCH_ONLINE -> OnlineSubtitlesDialog.show(activity, this, kind, itemId, i.onlineSearch.configured, isTv)
        }
    }

    private fun chooseSubtitle(option: SubtitleOption?) {
        val i = info ?: return
        subtitle = option
        app.session.subtitlesOn = option != null
        if (option != null && option.language.isNotBlank()) app.session.subtitleLanguage = option.language
        savePrefs(PlaybackPrefsUpdate(subtitlesOn = option != null, subtitleLanguage = option?.language?.takeIf { it.isNotBlank() }))
        val p = player() ?: return
        when {
            option == null -> {
                if (burning != null) switchTo { applyStream(playing) } else applySelections(p.currentTracks)
            }
            option.isImage -> {
                if (playing == QualityChoice.ORIGINAL && containerTextIndex(p.currentTracks, option) >= 0) {
                    applySelections(p.currentTracks)
                } else if (i.transcode.available) {
                    if (playing == QualityChoice.ORIGINAL) toast("These are picture subtitles, so your computer is converting the video to show them.")
                    switchTo { applyStream(if (playing.isTranscode) playing else bestFor(i)) }
                } else {
                    toast("These picture subtitles can't be shown on this device.")
                }
            }
            needsReattach(option) -> switchTo { applyStream(playing) }
            burning != null -> switchTo { applyStream(playing) }
            else -> applySelections(p.currentTracks)
        }
    }

    /** After an online download: refresh the list and turn the new file on. */
    fun onSubtitleDownloaded(key: String) {
        val id = itemId
        activity.lifecycleScope.launch {
            val fresh = runCatching { api.info(kind, id) }.getOrNull() ?: return@launch
            if (id != itemId) return@launch
            info = fresh
            val option = fresh.subtitleOptions.firstOrNull { it.key == key } ?: return@launch
            chooseSubtitle(option)
            // A new sidecar has to be put on the item to become a track.
            switchTo { applyStream(playing) }
        }
    }

    /* ------------------------------------------------------------ switching */

    private fun switchTo(block: suspend () -> Unit) {
        switchJob?.cancel()
        switchJob = activity.lifecycleScope.launch {
            try {
                block()
            } catch (e: CancellationException) {
                throw e
            } catch (e: PlaybackRefusedException) {
                toast(e.message ?: "Couldn't change the quality.")
            } catch (e: Exception) {
                Log.w(TAG, "Quality switch failed", e)
                toast("Couldn't change the quality: ${e.message}")
            }
        }
    }

    private fun bestFor(i: PlaybackInfo): QualityChoice = i.offered.firstOrNull() ?: QualityChoice.P1080

    /**
     * The household plan's away-from-home cap height, but only when it actually bites right now:
     * this device is away from home (see [AutoQuality.isAway]), the file's real resolution is
     * above that cap, and there is a conversion to serve instead. Null otherwise - in particular
     * always null at home, whatever the plan, and null once the file already fits under the cap.
     */
    private fun activeAwayQualityCapHeight(i: PlaybackInfo): Int? {
        val capHeight = i.awayQualityCapHeight ?: return null
        if (!i.transcode.available) return null
        if (!AutoQuality.isAway(path())) return null
        if ((i.original.height ?: 0) <= capHeight) return null
        return capHeight
    }

    /**
     * Applies the household's away-from-home plan cap on top of whatever [resolved] came out of
     * either the manual "Original" choice or Auto: never touches home playback, and only ever
     * downgrades ORIGINAL itself, since the conversion tiers already top out at 1080p. This is the
     * one place both paths (manual pick and Auto) are guaranteed to respect the cap - AutoQuality.pick()
     * is left exactly as it was for its own, unrelated Beebo Relay bandwidth cap.
     */
    private fun capAwayQuality(i: PlaybackInfo, resolved: QualityChoice): QualityChoice {
        if (resolved != QualityChoice.ORIGINAL) return resolved
        val capHeight = activeAwayQualityCapHeight(i) ?: return resolved
        return AutoQuality.bestUnderCap(capHeight, i.offered) ?: resolved
    }

    /** The concrete quality a choice plays right now. */
    private suspend fun resolve(choice: QualityChoice): QualityChoice {
        val i = info ?: return QualityChoice.ORIGINAL
        val originalPlayable = if (casting) i.direct.castSafe else i.direct.android
        val resolved = when {
            choice == QualityChoice.ORIGINAL ->
                if (!originalPlayable && i.transcode.available) bestFor(i) else QualityChoice.ORIGINAL
            choice.isTranscode -> if (i.transcode.available) choice else QualityChoice.ORIGINAL
            else -> AutoQuality.pick(measure(), path(), i.bitrateKbps, originalPlayable, i.transcode.available, i.offered)
        }
        // Night mode, levelling, a delay and an explicit stereo mix-down are made by the computer.
        val converted = if (resolved == QualityChoice.ORIGINAL && soundNeedsConversion(i) && i.transcode.available) bestFor(i) else resolved
        return capAwayQuality(i, converted)
    }

    private fun soundNeedsConversion(i: PlaybackInfo): Boolean =
        soundSupported && SoundRules.needsConversion(sound, currentTrack(i)?.channels)

    private fun currentTrack(i: PlaybackInfo) =
        i.audio.firstOrNull { it.streamIndex == audio?.streamIndex } ?: i.audio.firstOrNull { it.isDefault } ?: i.audio.firstOrNull()

    /** Saves a sound choice on the computer, then plays again with it (a conversion is made fresh; the original is left alone unless it must convert). */
    private fun changeSound(update: PlaybackPrefsUpdate, apply: (SoundPrefs) -> SoundPrefs) {
        sound = apply(sound)
        savePrefs(update)
        switchTo {
            val target = resolve(quality)
            if (target == playing && !playing.isTranscode) return@switchTo
            applyStream(target)
        }
    }

    /** Plain words for what is playing: what the computer made, or what the file carries, and what reached the speakers. */
    private fun nowPlaying(i: PlaybackInfo): Pair<String, String> {
        val reached = AudioOutputState.words()
        if (playing.isTranscode) {
            val plan = lastPlan ?: return "Sound converted by your computer" to (reached ?: "")
            return plan.label to listOfNotNull(plan.detail.ifBlank { null }, reached).joinToString(". ")
        }
        val t = currentTrack(i) ?: return "No sound information" to ""
        val label = t.playsAs?.label?.ifBlank { null } ?: SoundRules.originalWords(SoundRules.codecWords(t.codec), t.channels)
        return label to (reached ?: "original audio, played as stored")
    }

    private suspend fun measure(): Int? {
        measured?.let { (at, kbps) -> if (System.currentTimeMillis() - at < MEASURE_TTL_MS) return kbps }
        val kbps = withTimeoutOrNull(MEASURE_TIMEOUT_MS) { runCatching { api.speedTestKbps(1024) }.getOrNull() }
        if (kbps != null && kbps > 0) measured = System.currentTimeMillis() to kbps
        return kbps?.takeIf { it > 0 }
    }

    private fun path(): NetworkPathKind = try {
        when (com.beeboentertainment.movie.rtc.RemoteAccess.currentRoute()) {
            is com.beeboentertainment.movie.rtc.Route.Tunnel -> {
                val s = com.beeboentertainment.movie.rtc.RemoteAccess.status.value
                if ((s as? com.beeboentertainment.movie.rtc.TunnelConnection.Status.Open)?.relayed == true) NetworkPathKind.RELAY else NetworkPathKind.TUNNEL
            }
            is com.beeboentertainment.movie.rtc.Route.Direct -> NetworkPathKind.LAN
            else -> hostPath()
        }
    } catch (_: Throwable) {
        hostPath()
    }

    private fun hostPath(): NetworkPathKind =
        if (AutoQuality.isPrivateHost(runCatching { Uri.parse(app.session.baseUrl).host }.getOrNull())) NetworkPathKind.LAN else NetworkPathKind.INTERNET

    /** Put [requested] on the player where it stands, with the chosen audio and subtitles. */
    private suspend fun applyStream(requested: QualityChoice) {
        // Away from home this phone carries the film to the TV byte for byte, and a converted
        // stream is a playlist of many small pieces rather than one file, so it can't travel that
        // way. The TV gets the film as it already is on the home computer.
        val target =
            if (requested.isTranscode && relayingThroughPhone()) QualityChoice.ORIGINAL else requested
        val i = info ?: return
        val id = itemId
        val p0 = player() ?: return
        val currentItem = p0.currentMediaItem ?: return
        val currentId = currentItem.mediaMetadata.extras?.getString(PlaybackService.EXTRA_ITEM_ID) ?: currentItem.mediaId
        if (currentId != id) return

        val uri: String
        val mime: String?
        var newTicket = ""
        var newBurn: Int? = null
        if (target == QualityChoice.ORIGINAL) {
            uri = originalUri ?: return
            mime = originalMime
            lastPlan = null
        } else {
            val burn = subtitle?.takeIf { it.isImage }?.streamIndex
            val ask = if (soundSupported) SoundRules.request(sound, passthrough, DeviceAudioProbe.read(activity)) else null
            val r = api.start(PlaybackStartRequest(
                kind, id, target.id, audio?.streamIndex, burn,
                audioMode = ask?.audioMode,
                downmix = ask?.downmix,
                night = ask?.night,
                normalize = ask?.normalize,
                audioDelayMs = ask?.delayMs,
                audioCaps = ask?.maxChannels?.let { AudioCapsRequest(it, ask.codecs.orEmpty()) }
            ))
            lastPlan = r.audioPlan
            uri = UrlUtils.join(app.session.baseUrl, r.url) ?: return
            mime = MimeTypes.APPLICATION_M3U8
            newTicket = r.ticket
            newBurn = burn
        }
        if (id != itemId) return
        val p = player() ?: return
        val item = p.currentMediaItem ?: return
        val positionMs = p.currentPosition
        val wasPlaying = p.playWhenReady
        val embedded = subtitle?.takeIf { it.source == "embedded" && !it.isImage }
        val configs = subtitleConfigurations(i, embedded)
        val extras = android.os.Bundle(item.mediaMetadata.extras ?: android.os.Bundle()).apply {
            putString(EXTRA_ORIGINAL_URI, originalUri)
            putString(EXTRA_ORIGINAL_MIME, originalMime)
            putString(EXTRA_PLAYING, target.id)
            putString(EXTRA_TICKET, newTicket)
        }
        val replacement = item.buildUpon()
            .setMediaMetadata(item.mediaMetadata.buildUpon().setExtras(extras).build())
            .setUri(castable(uri))
            .setMimeType(mime)
            .setSubtitleConfigurations(configs)
            .build()
        val oldTicket = ticket
        ticket = newTicket
        burning = newBurn
        playing = target
        attachedEmbeddedKey = embedded?.key
        p.setMediaItem(replacement, positionMs)
        p.prepare()
        p.playWhenReady = wasPlaying
        if (oldTicket.isNotBlank() && oldTicket != newTicket) activity.lifecycleScope.launch { api.stop(oldTicket) }
        onLabel(QualityLabel.current(quality, playing))
    }

    /**
     * A TV can't reach name.beebo.tv's tunnel. At home its URLs move to the computer's own
     * address; away from home, on Wi-Fi, they move to this phone, which passes the bytes on
     * (PhoneCastRelay).
     */
    private fun castable(url: String): String {
        if (!casting) return url
        return try {
            com.beeboentertainment.movie.rtc.CastRule.castUrl(
                url,
                com.beeboentertainment.movie.rtc.RemoteAccess.castDecision(),
            ) { PhoneCastRelay.localUrlFor(it) } ?: url
        } catch (_: Throwable) {
            url
        }
    }

    /** Sidecars (tagged exactly as SidecarSubtitles tags them) plus the one chosen embedded text track. */
    private fun subtitleConfigurations(i: PlaybackInfo, embedded: SubtitleOption?): List<MediaItem.SubtitleConfiguration> {
        val out = mutableListOf<MediaItem.SubtitleConfiguration>()
        i.subtitleOptions.filter { it.source == "sidecar" }.forEach { s ->
            val index = s.key.removePrefix("side:").toIntOrNull() ?: return@forEach
            val abs = UrlUtils.join(app.session.baseUrl, s.url) ?: return@forEach
            out += MediaItem.SubtitleConfiguration.Builder(Uri.parse(castable(abs)))
                .setId(SubtitlePolicy.tag(index))
                .setMimeType(MimeTypes.TEXT_VTT)
                .setLanguage(s.language.takeIf { it.isNotBlank() })
                .setLabel(s.label)
                .build()
        }
        if (embedded != null) {
            UrlUtils.join(app.session.baseUrl, embedded.url)?.let { abs ->
                out += MediaItem.SubtitleConfiguration.Builder(Uri.parse(castable(abs)))
                    .setId(embeddedTag(embedded))
                    .setMimeType(MimeTypes.TEXT_VTT)
                    .setLanguage(embedded.language.takeIf { it.isNotBlank() })
                    .setLabel(embedded.label)
                    .build()
            }
        }
        return out
    }

    /* ------------------------------------------------------ track selection */

    private fun applySelections(tracks: Tracks) {
        val p = player() ?: return
        val i = info ?: return
        if (!p.isCommandAvailable(Player.COMMAND_SET_TRACK_SELECTION_PARAMETERS)) return
        val params = p.trackSelectionParameters.buildUpon()

        // Audio: only the original file carries several tracks; a conversion has just the chosen one.
        val wantedAudio = audio
        if (playing == QualityChoice.ORIGINAL && wantedAudio != null) {
            val groups = tracks.groups.filter { it.type == C.TRACK_TYPE_AUDIO }
            val index = TrackChoice.audioGroupIndex(groups.map { it.mediaTrackGroup.getFormat(0).language }, i.audioOptions, wantedAudio)
            val group = groups.getOrNull(index)
            if (group != null && !group.isSelected) params.setOverrideForType(TrackSelectionOverride(group.mediaTrackGroup, 0))
        } else {
            params.clearOverridesOfType(C.TRACK_TYPE_AUDIO)
        }

        // Subtitles.
        params.clearOverridesOfType(C.TRACK_TYPE_TEXT).setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
        val s = subtitle
        val textGroups = tracks.groups.filter { it.type == C.TRACK_TYPE_TEXT && it.mediaTrackGroup.length > 0 }
        val group = when {
            s == null -> null
            s.isImage && burning != null -> null
            s.source == "sidecar" -> {
                val tag = s.key.removePrefix("side:").toIntOrNull()?.let { SubtitlePolicy.tag(it) }
                textGroups.firstOrNull { it.mediaTrackGroup.getFormat(0).id == tag }
            }
            s.isImage -> containerTextGroups(tracks).getOrNull(containerTextIndex(tracks, s))
            else -> textGroups.firstOrNull { it.mediaTrackGroup.getFormat(0).id == embeddedTag(s) }
        }
        if (group != null) params.setOverrideForType(TrackSelectionOverride(group.mediaTrackGroup, 0))
        else if (s == null || burning != null) {
            // Nothing wanted: keep any default-flagged track in the file from appearing by itself.
            if (textGroups.any { it.isSelected }) params.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
        }
        runCatching { p.trackSelectionParameters = params.build() }
    }

    /** Does [option] have to be put on the item (re-prepared) before it can be selected? */
    private fun needsReattach(option: SubtitleOption?): Boolean {
        if (option == null || option.isImage) return false
        if (option.source == "embedded") return attachedEmbeddedKey != option.key
        val index = option.key.removePrefix("side:").toIntOrNull() ?: return false
        val configs = player()?.currentMediaItem?.localConfiguration?.subtitleConfigurations.orEmpty()
        return configs.none { it.id == SubtitlePolicy.tag(index) }
    }

    private fun containerTextGroups(tracks: Tracks): List<Tracks.Group> =
        tracks.groups.filter {
            it.type == C.TRACK_TYPE_TEXT && it.mediaTrackGroup.length > 0 &&
                it.mediaTrackGroup.getFormat(0).id?.startsWith("beebo-") != true
        }

    private fun containerTextIndex(tracks: Tracks, option: SubtitleOption): Int {
        val i = info ?: return -1
        if (playing != QualityChoice.ORIGINAL) return -1
        return TrackChoice.embeddedTextGroupIndex(containerTextGroups(tracks).size, i.subtitleOptions, option)
    }

    /* ---------------------------------------------------------------- misc */

    private fun savePrefs(update: PlaybackPrefsUpdate) {
        activity.lifecycleScope.launch { runCatching { api.savePrefs(update) } }
    }

    private fun stopTicket() {
        val t = ticket
        ticket = ""
        if (t.isNotBlank()) activity.lifecycleScope.launch { api.stop(t) }
    }

    companion object {
        private const val TAG = "PlaybackChoices"
        const val PREF_QUALITY = "playback_quality"
        const val PREF_AUDIO_LANG = "playback_audio_language"
        private const val MEASURE_TTL_MS = 5 * 60_000L
        private const val MEASURE_TIMEOUT_MS = 8_000L
        private const val EXTRA_ORIGINAL_URI = "beebo.playback.originalUri"
        private const val EXTRA_ORIGINAL_MIME = "beebo.playback.originalMime"
        private const val EXTRA_PLAYING = "beebo.playback.playing"
        private const val EXTRA_TICKET = "beebo.playback.ticket"

        fun embeddedTag(option: SubtitleOption): String = "beebo-emb-${option.streamIndex}"
    }
}
