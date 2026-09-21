package com.beeboentertainment.auto.family

import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.MimeTypes
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.session.MediaConstants
import androidx.media3.session.MediaSession
import java.io.IOException
import kotlin.random.Random

/**
 * Family Fun inside the car's media browser: the folder, the rows in it, and the spoken audio behind
 * them. It plugs into [com.beeboentertainment.auto.media.PlaybackService] at four points: browsing,
 * "get item", "add or set media items", and the data source that turns a row into audio.
 *
 * Everything the car sees is text in a list. There is no custom screen, no artwork, no animation and
 * no notification. The audio is the phone's own voice, prepared on the phone, played through the
 * same media session as a film or a song, so the car's Play/Pause/Next buttons and the Assistant's
 * "pause" and "next" work with no extra code.
 *
 * Off until a parent switches Family Fun on in the phone app ([FamilyPrefs.enabled]).
 */
internal class FamilyMedia(private val context: Context) {

    private val prefs = FamilyPrefs.get(context)
    private val renderer = TtsRenderer(context)

    val enabled: Boolean get() = prefs.enabled

    // ------------------------------------------------------------------ browsing

    fun rootItem(): MediaItem = toBrowseItem(FamilyMenu.rootEntry())

    /** The rows under [parentId], or null when [parentId] is not a Family Fun folder or the feature is off. */
    fun children(parentId: String): List<MediaItem>? {
        if (!enabled) return null
        return FamilyMenu.children(parentId, prefs.env())?.map(::toBrowseItem)
    }

    /** Where the Family Fun row belongs: at the root on a host that shows seven tabs, otherwise last in Movies. */
    fun decorate(parentId: String, items: List<MediaItem>, rootLimit: Int, isRoot: Boolean, moviesTabId: String): List<MediaItem> {
        if (!enabled) return items
        val atRoot = rootLimit >= FamilyIds.ROOT_TABS_WITH_FAMILY
        return when {
            isRoot && atRoot -> items + rootItem()
            !atRoot && parentId == moviesTabId -> items + rootItem()
            else -> items
        }
    }

    fun itemFor(mediaId: String): MediaItem? {
        if (!enabled) return null
        return FamilyMenu.entryFor(mediaId, prefs.env())?.let(::toBrowseItem)
    }

    private fun toBrowseItem(e: MenuEntry): MediaItem {
        val extras = Bundle().apply {
            putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_BROWSABLE, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM)
            putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_PLAYABLE, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM)
        }
        val meta = MediaMetadata.Builder().setTitle(e.title)
        if (e.playable) {
            // Not setDisplayTitle, and the subtitle goes in the artist field: the same reason the
            // library rows do it (the legacy bridge Android Auto uses ignores the artist otherwise).
            meta.setArtist(e.subtitle.ifBlank { null })
                .setIsBrowsable(false).setIsPlayable(true)
                .setMediaType(MediaMetadata.MEDIA_TYPE_AUDIO_BOOK_CHAPTER)
        } else {
            meta.setSubtitle(e.subtitle.ifBlank { null })
                .setIsBrowsable(e.id != FamilyIds.NOTE).setIsPlayable(false)
                .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
        }
        return MediaItem.Builder().setMediaId(e.id).setMediaMetadata(meta.setExtras(extras).build()).build()
    }

    // ------------------------------------------------------------------ playing

    fun isFamilyRequest(items: List<MediaItem>): Boolean = items.any { FamilyIds.isFamily(it.mediaId) }

    /** Whether a tap in the list would expand into a queue (a game or a whole story). */
    fun isQueueStart(mediaId: String): Boolean = when (FamilyIds.parse(mediaId)) {
        is FamilyIds.Parsed.GameStart, is FamilyIds.Parsed.Story -> true
        else -> false
    }

    /**
     * Turns Family Fun rows into playable items. A game becomes all its rounds, a story all its
     * parts. Throws [IOException] with a plain sentence when the rule says it may not play now, which
     * is how a refusal reaches the person.
     *
     * [fromThisApp] is true when the request came from this app's own phone screen, whose live
     * drive signals ([FamilyRuntime.signals]) apply. A request from the car, or from any other app,
     * is always judged as the strictest case: a car that cannot say it is parked.
     */
    fun resolve(items: List<MediaItem>, fromThisApp: Boolean): List<MediaItem> {
        val env = prefs.env()
        val surface = if (fromThisApp) FamilyGate.Surface.THIS_APP_SCREEN else FamilyGate.Surface.CAR_MEDIA_BROWSER
        val signals = if (fromThisApp) FamilyRuntime.signals.value else FamilyRuntime.WORST_CASE
        val out = ArrayList<MediaItem>()
        var story = false
        for (item in items) {
            if (!FamilyIds.isFamily(item.mediaId)) { out += item; continue }
            when (val p = FamilyIds.parse(item.mediaId)) {
                is FamilyIds.Parsed.GameStart -> {
                    val queue = FamilyScripts.gameQueue(p.kind, Random.nextInt(1, 1_000_000), env, surface, signals)
                    if (queue.isEmpty()) throw IOException(refusal(env, surface, signals))
                    out += queue.map(::playable)
                }
                is FamilyIds.Parsed.Story -> {
                    val queue = FamilyScripts.storyQueue(p.id)
                    if (queue.isEmpty()) throw IOException("That story is not on this phone.")
                    story = true
                    out += queue.map(::playable)
                }
                else -> {
                    val spoken = FamilyScripts.forMedia(item.mediaId, env, surface, signals)
                        ?: throw IOException(refusal(env, surface, signals))
                    if (FamilyIds.parse(item.mediaId) is FamilyIds.Parsed.StoryPart) story = true
                    out += playableFor(item.mediaId, spoken)
                }
            }
        }
        // Quiet hours: a story starts with a sleep timer already running, unless one is set.
        if (story && env.quiet && FamilyRuntime.sleep.value == null) {
            FamilyRuntime.sleep.value = SleepTimerLogic.start(SystemClock.elapsedRealtime(), SleepTimerLogic.QUIET_HOURS_DEFAULT_MINUTES)
        }
        return out
    }

    private fun refusal(env: FamilyEnv, surface: FamilyGate.Surface, signals: com.beeboentertainment.auto.drive.VideoGate.Signals): String =
        env.gate(FamilyGate.Feature.VOICE_GAMES, surface, signals).message ?: "That is not available right now."

    private fun playable(e: MenuEntry): MediaItem = playableItem(e.id, e.title, e.subtitle)

    private fun playableFor(id: String, spoken: SpokenItem): MediaItem = playableItem(id, spoken.title, spoken.subtitle)

    private fun playableItem(id: String, title: String, subtitle: String): MediaItem =
        MediaItem.Builder()
            .setMediaId(id)
            .setUri(FamilyIds.audioUri(id))
            .setMimeType(MimeTypes.AUDIO_WAV)
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle(title)
                    .setArtist(subtitle.ifBlank { null })
                    .setIsBrowsable(false)
                    .setIsPlayable(true)
                    .setMediaType(MediaMetadata.MEDIA_TYPE_AUDIO_BOOK_CHAPTER)
                    .build()
            )
            .build()

    /** True when the request comes from this app's own screen, not the car and not another app. */
    fun isOwnController(controller: MediaSession.ControllerInfo): Boolean = controller.packageName == context.packageName

    // ------------------------------------------------------------------ audio

    /**
     * Sits in front of the player's data source. A `beebo-tts` address is turned into a WAV file made
     * on the phone; everything else passes straight through to the network source underneath.
     * Runs on the player's loading thread, so waiting for the voice never blocks playback controls.
     */
    val resolver = ResolvingDataSource.Resolver { dataSpec: DataSpec ->
        val id = FamilyIds.mediaIdFromAudioUri(dataSpec.uri.toString())
        if (id == null) dataSpec
        else {
            val spoken = FamilyScripts.forPlayback(id, prefs.env())
                ?: throw IOException("Voice games are resting right now.")
            dataSpec.withUri(Uri.fromFile(renderer.render(spoken)))
        }
    }

    fun shutdown() = renderer.shutdown()
}
