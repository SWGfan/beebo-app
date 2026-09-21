package com.beeboentertainment.movie.tripshare

import android.content.Context
import android.net.Uri
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.trip.TripData
import com.beeboentertainment.movie.trip.TripMedia
import com.beeboentertainment.movie.trip.TripStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withContext
import java.io.IOException
import java.util.concurrent.TimeUnit

/** What the Share screen shows while a link is being made. Only in memory; the job itself is saved separately. */
sealed class ShareProgress {
    object Idle : ShareProgress()
    data class Working(val label: String, val fraction: Float) : ShareProgress()
    data class Done(val link: SavedLink, val skipped: List<SkippedFile>, val notes: List<String>) : ShareProgress()
    data class Failed(val message: String, val canRetry: Boolean) : ShareProgress()
}

object TripShareState {
    private val _state = MutableStateFlow<ShareProgress>(ShareProgress.Idle)
    val state: StateFlow<ShareProgress> = _state

    fun set(value: ShareProgress) { _state.value = value }
    fun reset() { _state.value = ShareProgress.Idle }
}

/**
 * Makes a private link for a finished trip in the background: gets the photos and clips ready, sends
 * them to the person's own computer (resuming after any interruption), then asks it for the link.
 *
 * No foreground service and no new permission: WorkManager runs it, in slices inside the system's
 * time limit, and a slice that cannot finish asks to be run again. Everything that has already reached
 * the computer is remembered by the computer (by hash), so a repeat run sends only what is missing.
 */
class TripShareWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val ctx = applicationContext
        val app = BeeboApp.instance
        val jobs = TripShareJobStore(app.session.plain)
        val job = jobs.current()
        if (job == null || job.id != inputData.getString(KEY_JOB)) return@withContext Result.success()

        fun fail(message: String, retry: Boolean = false): Result {
            TripShareState.set(ShareProgress.Failed(message, retry))
            if (!retry) { jobs.clear(job.id); TripShareMediaPrep.clean(ctx, job.id) }
            return if (retry) Result.retry() else Result.success()
        }

        if (!app.session.isLoggedIn) return@withContext fail("Sign in to Beebo to share this trip.")
        val trip = TripStore.forApp(app.session.plain).trip(job.tripId) ?: return@withContext fail("That trip is no longer saved.")
        val client = TripShareClient(app.session, app.api.okHttp)
        val started = System.currentTimeMillis()
        val shouldStop = { isStopped || System.currentTimeMillis() - started > RUN_BUDGET_MS }

        TripShareState.set(ShareProgress.Working("Checking your computer…", 0f))
        val status = try { client.status() } catch (e: IOException) {
            return@withContext fail("Your computer didn't answer. Check it is on and Beebo is running.", retry = true)
        }
        if (!status.ok) {
            return@withContext fail(TripShareLogic.describeCreateError(status.code, status.error))
        }
        val server = status.body!!
        if (!server.settings.enabled) return@withContext fail("Trip links are turned off on your computer.")

        // 1. Get every file ready: photos redrawn small, clips copied with location blanked, the song hashed.
        val dir = TripShareMediaPrep.workDir(ctx, job.id)
        val prepared = ArrayList<Pair<Int, PreparedFile>>() // index into job.media, file
        val notes = ArrayList<String>()
        val skipped = ArrayList<SkippedFile>()
        for ((i, m) in job.media.withIndex()) {
            if (shouldStop()) return@withContext fail("Paused. It will carry on shortly.", retry = true)
            TripShareState.set(ShareProgress.Working("Getting picture ${i + 1} of ${job.media.size} ready…", i / job.media.size.coerceAtLeast(1).toFloat() * 0.3f))
            val uri = Uri.parse(m.uri)
            val file = if (m.video) TripShareMediaPrep.prepareVideo(ctx, uri, java.io.File(dir, "v$i.mp4"), server.settings.maxVideoBytes)
            else TripShareMediaPrep.preparePhoto(ctx, uri, java.io.File(dir, "p$i.jpg"))
            if (file != null) prepared += i to file else skipped += SkippedFile("m$i", if (m.video) "clip ${i + 1}" else "photo ${i + 1}", "could not be read or was too large")
        }
        var song: PreparedFile? = null
        if (job.includeSong) {
            val songUri = job.songUri ?: return@withContext fail("Choose the song file first.")
            song = TripShareMediaPrep.prepareSong(ctx, Uri.parse(songUri), UploadPlan.SONG_ID)
                ?: return@withContext fail("The song file couldn't be read. Choose it again.")
        }

        // 2. Fit to the computer's limits and storage cap.
        val all = prepared.map { it.second } + listOfNotNull(song)
        val onPc = try { client.have(job.tripId, all.map { it.sha256 to it.sizeBytes }) } catch (e: IOException) { emptySet() }
        val plan = TripShareLogic.plan(
            all.map { ShareCandidate(it.id, it.kind, it.name, it.sizeBytes) },
            server.settings, server.usage,
            onPc = all.filter { it.sha256 in onPc }.map { it.id }.toSet(),
        )
        if (plan.songDropped) return@withContext fail("The song is bigger than your computer allows, or there is no room for it.")
        plan.message?.let { notes += it }
        skipped += plan.skipped
        val toSend = all.filter { f -> plan.accepted.any { it.id == f.id } }

        // 3. Send.
        val transfer = TripShareTransfer(
            client,
            shouldStop = shouldStop,
            onProgress = { index, total, sent, size ->
                val within = if (size > 0) sent.toFloat() / size else 1f
                TripShareState.set(ShareProgress.Working("Sending ${index + 1} of $total to your computer…", 0.3f + 0.65f * ((index + within) / total.coerceAtLeast(1))))
            },
        )
        val result = transfer.run(job.tripId, toSend)
        val onComputer: Set<String>
        when (result) {
            is TransferResult.Stopped -> return@withContext fail(result.message)
            is TransferResult.Interrupted -> return@withContext fail("Paused. It will carry on when the connection is back.", retry = true)
            is TransferResult.Finished -> { onComputer = result.onPc; skipped += result.skipped }
        }

        // 4. Ask for the link.
        TripShareState.set(ShareProgress.Working("Making your link…", 0.97f))
        val summary = TripData.summary(trip, app.session)
        val shownByPick = job.media.mapIndexedNotNull { i, m ->
            val file = prepared.firstOrNull { it.first == i }?.second ?: return@mapIndexedNotNull null
            if (file.sha256 !in onComputer) return@mapIndexedNotNull null
            SharedMedia(TripMedia(m.uri, m.video, m.takenAt), file.sha256, file.width, file.height)
        }
        val songRef = song?.takeIf { it.sha256 in onComputer }?.let { ShareSong(it.sha256, job.songTitle.ifBlank { it.name }) }
        if (job.includeSong && songRef == null) return@withContext fail("The song didn't reach your computer. Try again.")
        val manifest = TripShareManifestBuilder.build(summary, shownByPick, job.options, songRef)
        val reply = try {
            client.createShare(job.tripId, trip.name, manifest, job.options)
        } catch (e: IOException) {
            return@withContext fail("Your computer stopped answering. Try again.", retry = true)
        }
        val created = reply.body
        if (!reply.ok || created == null || !created.ok || created.token.isBlank() || created.url.isBlank()) {
            return@withContext fail(TripShareLogic.describeCreateError(reply.code, reply.error ?: created?.error))
        }
        val share = created.share
        val link = SavedLink(
            shareId = share?.id ?: created.token.take(8),
            tripId = job.tripId, title = trip.name, url = created.url,
            createdAt = System.currentTimeMillis(),
            expiresAt = share?.expiresAt ?: (System.currentTimeMillis() + job.expiryHours * 3_600_000L),
            includeLocation = job.includeLocation, includeSong = job.includeSong,
            reachableAnywhere = created.reachableAnywhere,
        )
        TripShareStore.forApp(app.session).add(link)
        jobs.clear(job.id)
        TripShareMediaPrep.clean(ctx, job.id)
        TripShareState.set(ShareProgress.Done(link, skipped, notes))
        Result.success()
    }

    companion object {
        const val KEY_JOB = "job"
        private const val TAG = "trip-share"
        /** Stay well inside WorkManager's 10-minute window; the rest resumes in a follow-up run. */
        const val RUN_BUDGET_MS = 8 * 60 * 1000L

        /** Save the job and start (or continue) making the link. */
        fun start(context: Context, job: ShareJob) {
            TripShareJobStore(BeeboApp.instance.session.plain).save(job)
            TripShareState.set(ShareProgress.Working("Starting…", 0f))
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(if (job.wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED)
                .build()
            val request = OneTimeWorkRequestBuilder<TripShareWorker>()
                .setConstraints(constraints)
                .setBackoffCriteria(BackoffPolicy.LINEAR, 30, TimeUnit.SECONDS)
                .setInputData(workDataOf(KEY_JOB to job.id))
                .addTag(TAG)
                .build()
            runCatching { WorkManager.getInstance(context).enqueueUniqueWork("$TAG-${job.tripId}", ExistingWorkPolicy.REPLACE, request) }
        }

        /** Stop making the link and forget what was prepared. Anything already on the computer stays until the trip is deleted there. */
        fun cancel(context: Context, tripId: String) {
            runCatching { WorkManager.getInstance(context).cancelUniqueWork("$TAG-$tripId") }
            val jobs = TripShareJobStore(BeeboApp.instance.session.plain)
            jobs.current()?.let { TripShareMediaPrep.clean(context, it.id); jobs.clear(it.id) }
            TripShareState.reset()
        }
    }
}
