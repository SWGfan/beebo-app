package com.beeboentertainment.movie.trip

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.Presentation
import androidx.media3.transformer.Composition
import androidx.media3.transformer.DefaultEncoderFactory
import androidx.media3.transformer.Effects
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.Transformer
import androidx.media3.transformer.VideoEncoderSettings
import com.beeboentertainment.movie.BeeboApp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Where an export is up to, as the export screen and the notification read it. */
internal sealed interface ExportState {
    data object Idle : ExportState

    /** Drawing the cards and fitting the photos, before any encoding starts. */
    data class Preparing(val done: Int, val total: Int) : ExportState

    data class Encoding(val percent: Int) : ExportState

    data class Done(
        val tripId: String,
        val path: String,
        val sizeBytes: Long,
        val durationMs: Long,
        val skippedMedia: Int,
        val ambience: Boolean,
        val locationAtomsBlanked: Int,
    ) : ExportState

    data class Failed(val message: String) : ExportState

    data object Cancelled : ExportState
}

/** The one export in flight, shared between the service that runs it and the screen that shows it. */
internal object TripExportState {
    private val _state = MutableStateFlow<ExportState>(ExportState.Idle)
    val state: StateFlow<ExportState> = _state.asStateFlow()

    fun set(next: ExportState) { _state.value = next }

    val busy: Boolean get() = _state.value.let { it is ExportState.Preparing || it is ExportState.Encoding }
}

/**
 * Renders a trip's slideshow to an MP4 on the phone, with Media3 Transformer. Nothing is uploaded and
 * no network is used: every input is a local file, the phone's own pictures, or drawn here.
 *
 *  - Cards are drawn to bitmaps ([TripFrames.card]) and become timed still images.
 *  - Photos are re-drawn into fresh JPEG frames ([TripFrames.photo]), which also drops their metadata.
 *  - Videos are trimmed to a few seconds and their own sound is left out.
 *  - Sound is off unless the person asked for the synthesized campfire ambience. Never the music library.
 *
 * Runs on the main thread except the preparation, because Transformer must be built, started and
 * polled on the thread that owns its looper.
 */
@androidx.annotation.OptIn(UnstableApi::class)
internal class TripExportEngine(private val context: Context) {

    private val main = Handler(Looper.getMainLooper())
    private val workDir = File(context.cacheDir, WORK_DIR)

    /** Where the finished file goes: inside the folder the FileProvider already shares. */
    fun outputFile(): File = File(workDir, "trip-video.mp4")

    suspend fun run(request: ExportRequest, report: (ExportState) -> Unit): ExportState {
        return try {
            val prepared = withContext(Dispatchers.Default) { prepare(request, report) }
            val result = encode(prepared, report)
            val blanked = withContext(Dispatchers.IO) { Mp4LocationStripper.strip(prepared.output) }
            prepared.frames.forEach { runCatching { it.delete() } }
            ExportState.Done(
                tripId = request.tripId,
                path = prepared.output.absolutePath,
                sizeBytes = prepared.output.length(),
                durationMs = result.durationMs,
                skippedMedia = prepared.plan.skippedMedia + prepared.unreadable,
                ambience = prepared.plan.ambience,
                locationAtomsBlanked = blanked,
            )
        } catch (e: CancellationException) {
            cleanUp()
            throw e
        } catch (e: ExportException) {
            cleanUp()
            ExportState.Failed(describe(e))
        } catch (e: Exception) {
            cleanUp()
            ExportState.Failed(e.message?.takeIf { it.isNotBlank() } ?: "The video could not be made.")
        }
    }

    fun cleanUp() {
        runCatching { workDir.deleteRecursively() }
    }

    private class Prepared(
        val plan: ExportPlan,
        val composition: Composition,
        val output: File,
        val frames: List<File>,
        val unreadable: Int,
    )

    private suspend fun prepare(request: ExportRequest, report: (ExportState) -> Unit): Prepared {
        val session = BeeboApp.instance.session
        val trip = TripStore.forApp(session.plain).trip(request.tripId) ?: error("That trip is no longer saved.")
        val settings = request.settings
        val now = System.currentTimeMillis()
        val summary = TripData.summary(trip, session, now)
        val pick = TripQueries.pickMedia(trip.media, TripQueries.window(trip, now), settings.includeOutsideMedia)
        val slides = TripSlides.build(summary, pick.shown, NameMask.only(settings.shownNames), now)

        val durations = HashMap<String, Long?>()
        pick.shown.filter { it.video }.forEach { durations[it.uri] = TripMediaReader.videoDurationMs(context, Uri.parse(it.uri)) }
        val plan = TripExportPlanner.plan(slides, settings) { durations[it.uri] }

        cleanUp()
        workDir.mkdirs()
        val frames = mutableListOf<File>()
        val items = mutableListOf<EditedMediaItem>()
        var unreadable = 0
        var addedMs = 0L
        plan.items.forEachIndexed { index, item ->
            currentCoroutineContext().ensureActive()
            report(ExportState.Preparing(index, plan.items.size))
            val edited = when (item) {
                is PlanItem.Card -> {
                    val file = File(workDir, "frame-%03d.png".format(index))
                    val bitmap = TripFrames.card(item.slide, plan.width, plan.height)
                    TripFrames.save(bitmap, file, png = true)
                    bitmap.recycle()
                    frames += file
                    still(file, item.durationMs, plan)
                }
                is PlanItem.Photo -> {
                    val bitmap = TripFrames.photo(context, Uri.parse(item.media.uri), plan.width, plan.height)
                    if (bitmap == null) {
                        unreadable++
                        null
                    } else {
                        val file = File(workDir, "frame-%03d.jpg".format(index))
                        TripFrames.save(bitmap, file, png = false)
                        bitmap.recycle()
                        frames += file
                        still(file, item.durationMs, plan)
                    }
                }
                is PlanItem.Video -> clip(item, plan)
            }
            if (edited != null) {
                items += edited
                addedMs += item.durationMs
            }
        }
        if (items.isEmpty()) error("There was nothing to put in the video.")

        val sequences = mutableListOf(EditedMediaItemSequence(items))
        if (plan.ambience) {
            // Exactly as long as the pictures, so the sound neither stops early nor runs on past them.
            val wav = File(workDir, "ambience.wav")
            AmbienceWav.write(wav, addedMs)
            frames += wav
            sequences += EditedMediaItemSequence(
                listOf(EditedMediaItem.Builder(MediaItem.fromUri(Uri.fromFile(wav))).setRemoveVideo(true).build()),
            )
        }
        return Prepared(plan, Composition.Builder(sequences).build(), outputFile().also { it.delete() }, frames, unreadable)
    }

    private fun effects(plan: ExportPlan) = Effects(
        emptyList(),
        listOf(Presentation.createForWidthAndHeight(plan.width, plan.height, Presentation.LAYOUT_SCALE_TO_FIT)),
    )

    private fun still(file: File, durationMs: Long, plan: ExportPlan): EditedMediaItem =
        EditedMediaItem.Builder(MediaItem.fromUri(Uri.fromFile(file)))
            .setDurationUs(durationMs * 1000L)
            .setFrameRate(FRAME_RATE)
            .setRemoveAudio(true)
            .setEffects(effects(plan))
            .build()

    private fun clip(item: PlanItem.Video, plan: ExportPlan): EditedMediaItem {
        val media = MediaItem.Builder()
            .setUri(Uri.parse(item.media.uri))
            .setClippingConfiguration(
                MediaItem.ClippingConfiguration.Builder()
                    .setStartPositionMs(item.startMs)
                    .setEndPositionMs(item.startMs + item.durationMs)
                    .build(),
            )
            .build()
        return EditedMediaItem.Builder(media).setRemoveAudio(true).setEffects(effects(plan)).build()
    }

    private suspend fun encode(prepared: Prepared, report: (ExportState) -> Unit): ExportResult = withContext(Dispatchers.Main.immediate) {
        coroutineScope {
            val bitrate = if (prepared.plan.height >= 1080) BITRATE_1080 else BITRATE_720
            var transformer: Transformer? = null
            val poll = launch {
                val holder = ProgressHolder()
                while (isActive) {
                    delay(POLL_MS)
                    val t = transformer ?: continue
                    if (t.getProgress(holder) == Transformer.PROGRESS_STATE_AVAILABLE) {
                        report(ExportState.Encoding(holder.progress.coerceIn(0, 100)))
                    }
                }
            }
            report(ExportState.Encoding(0))
            try {
                suspendCancellableCoroutine<ExportResult> { cont ->
                    val built = Transformer.Builder(context)
                        .setVideoMimeType(MimeTypes.VIDEO_H264)
                        .setAudioMimeType(MimeTypes.AUDIO_AAC)
                        .setEncoderFactory(
                            DefaultEncoderFactory.Builder(context)
                                .setRequestedVideoEncoderSettings(VideoEncoderSettings.Builder().setBitrate(bitrate).build())
                                .setEnableFallback(true)
                                .build(),
                        )
                        .addListener(object : Transformer.Listener {
                            override fun onCompleted(composition: Composition, exportResult: ExportResult) {
                                if (cont.isActive) cont.resume(exportResult)
                            }

                            override fun onError(composition: Composition, exportResult: ExportResult, exportException: ExportException) {
                                if (cont.isActive) cont.resumeWithException(exportException)
                            }
                        })
                        .build()
                    transformer = built
                    cont.invokeOnCancellation { main.post { runCatching { built.cancel() } } }
                    built.start(prepared.composition, prepared.output.absolutePath)
                }
            } finally {
                poll.cancel()
            }
        }
    }

    private fun describe(e: ExportException): String = when (e.errorCode) {
        ExportException.ERROR_CODE_ENCODER_INIT_FAILED,
        ExportException.ERROR_CODE_ENCODING_FORMAT_UNSUPPORTED ->
            "This phone could not encode the video at this size. Try 720p."
        ExportException.ERROR_CODE_IO_FILE_NOT_FOUND,
        ExportException.ERROR_CODE_IO_NO_PERMISSION ->
            "One of the photos or videos could not be opened. Choose them again and retry."
        else -> "The video could not be made (" + ExportException.getErrorCodeName(e.errorCode) + ")."
    }

    companion object {
        /** Under the cache folder the FileProvider already exposes for sharing (res/xml/file_paths.xml). */
        const val WORK_DIR = "trip-export"
        private const val FRAME_RATE = 30
        private const val POLL_MS = 500L
        private const val BITRATE_1080 = 8_000_000
        private const val BITRATE_720 = 4_000_000
    }
}

/** What to make: the trip and the person's choices. */
internal data class ExportRequest(val tripId: String, val settings: ExportSettings)
