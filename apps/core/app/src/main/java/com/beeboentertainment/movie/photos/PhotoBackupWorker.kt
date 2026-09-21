package com.beeboentertainment.movie.photos

import android.content.Context
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.beeboentertainment.movie.BeeboApp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

/**
 * Runs photo backup in the background with WorkManager, so Android decides when (Wi-Fi, charging)
 * and the work survives the app being closed and the phone restarting. No foreground service: each
 * run works for a few minutes and, when more is waiting, queues the next run.
 *
 * Triggers: a periodic run every few hours, a run shortly after a new photo or video appears
 * (MediaStore content observer trigger), and "Back up now".
 */
class PhotoBackupWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val ctx = applicationContext
        val store = PhotoBackupStore.get(ctx)
        val settings = store.settings.value
        // A new-media trigger fires once; keep watching for the next photo.
        if (tags.contains(PhotoBackupScheduler.TAG_CONTENT)) PhotoBackupScheduler.watchForNewMedia(ctx, settings, fromWorker = true)
        if (!settings.active) return@withContext Result.success()

        val access = PhoneMedia.access(ctx, settings.includeVideos)
        if (access == PhotoBackupLogic.MediaAccess.NONE) {
            store.updateState { it.copy(running = false, stopMessage = "Beebo needs permission to see your photos. Open Photo backup to allow it.") }
            return@withContext Result.success()
        }
        val app = BeeboApp.instance
        if (!app.session.isLoggedIn) {
            store.updateState { it.copy(running = false, stopMessage = "Sign in to Beebo to back up your photos.") }
            return@withContext Result.success()
        }

        val all = PhoneMedia.scan(ctx, settings.includeVideos)
        store.forgetMissing(all.map { it.key }.toSet())
        val records = store.records()
        val queue = PhotoBackupLogic.pending(all, settings, records.done.keys, records.attempts)
        store.updateState { it.copy(running = true, done = 0, total = queue.size, pending = queue.size, stopMessage = null, waitingFor = null, lastRunAtMs = System.currentTimeMillis()) }

        val device = PhotoBackupLogic.deviceFolderName(Build.MANUFACTURER, Build.MODEL)
        val client = PhotoBackupClient(app.session, app.api.okHttp)
        val transport = object : PhotoUploader.Transport {
            override fun begin(device: String, name: String, size: Long, sha256: String, takenAt: Long) = client.begin(device, name, size, sha256, takenAt)
            override fun chunk(uploadId: String, offset: Long, bytes: ByteArray, length: Int, sha256: String) = client.chunk(uploadId, offset, bytes, length, sha256)
            override fun finish(uploadId: String) = client.finish(uploadId)
        }
        val started = System.currentTimeMillis()
        var sent = 0
        var more = false
        try {
            for ((i, item) in queue.withIndex()) {
                if (isStopped || !store.settings.value.active) { more = true; break }
                if (System.currentTimeMillis() - started > RUN_BUDGET_MS) { more = true; break }
                store.updateState { it.copy(done = i, currentName = item.name, currentProgress = 0f) }
                val uri = Uri.parse(item.uri)
                val sha = records.hashes[item.key] ?: runCatching {
                    ctx.contentResolver.openInputStream(uri)!!.use { PhotoUploader.sha256Hex(it) }
                }.getOrNull()?.also { store.rememberHash(item.key, it) }
                if (sha == null) { store.countFailure(item.key); continue }
                var lastReport = 0L
                val uploader = PhotoUploader(
                    transport,
                    sleep = { Thread.sleep(it) },
                    shouldStop = { isStopped || !store.settings.value.active },
                    onProgress = { at, size ->
                        val now = System.currentTimeMillis()
                        if (now - lastReport > 700) {
                            lastReport = now
                            store.updateState { it.copy(currentProgress = if (size > 0) at.toFloat() / size else 1f) }
                        }
                    },
                )
                val outcome = runCatching {
                    uploader.upload(PhotoUploader.Item(device, item.name, item.size, sha, item.takenAtMs)) {
                        ctx.contentResolver.openInputStream(uri) ?: throw java.io.IOException("unreadable")
                    }
                }.getOrElse { PhotoUploader.Outcome.Skipped(it.message ?: "unreadable") }
                when (outcome) {
                    is PhotoUploader.Outcome.Saved -> {
                        store.markDone(item.key, sha)
                        sent++
                        store.updateState { it.copy(lastBackupAtMs = System.currentTimeMillis(), backedUpCount = it.backedUpCount + 1, pending = (queue.size - i - 1).coerceAtLeast(0)) }
                    }
                    is PhotoUploader.Outcome.Skipped -> {
                        store.countFailure(item.key)
                        // The bytes changed since they were hashed: hash again next time.
                        if (outcome.reason == "checksum_mismatch") store.editRecords { r -> r.copy(hashes = r.hashes - item.key) }
                    }
                    is PhotoUploader.Outcome.Stopped -> {
                        store.updateState { it.copy(stopMessage = outcome.message) }
                        return@withContext Result.success()
                    }
                    PhotoUploader.Outcome.Interrupted -> { more = true; break }
                }
            }
        } finally {
            store.flush()
            store.updateState { it.copy(running = false, currentName = null, currentProgress = 0f) }
        }
        if (more) {
            PhotoBackupScheduler.runSoon(ctx, store.settings.value, delaySeconds = if (sent == 0) 15 * 60L else 5L, followUp = true)
        } else {
            val left = PhotoBackupLogic.pending(PhoneMedia.scan(ctx, settings.includeVideos), store.settings.value, store.records().done.keys, store.records().attempts).size
            store.updateState { it.copy(pending = left, done = 0, total = 0) }
        }
        Result.success()
    }

    companion object {
        /** Stay well inside WorkManager's 10-minute execution window. */
        const val RUN_BUDGET_MS = 8 * 60 * 1000L
    }
}

/** Every WorkManager request photo backup uses, in one place. */
object PhotoBackupScheduler {
    const val TAG = "photo-backup"
    const val TAG_CONTENT = "photo-backup-new-media"
    private const val PERIODIC = "photo-backup-periodic"
    private const val NOW = "photo-backup-now"
    private const val CONTENT = "photo-backup-content"

    fun constraints(settings: BackupSettings): Constraints = Constraints.Builder()
        .setRequiredNetworkType(if (settings.wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED)
        .setRequiresCharging(settings.chargingOnly)
        .setRequiresBatteryNotLow(true)
        .build()

    /** Make WorkManager match the settings: schedule everything when on, cancel it all when off or paused. */
    fun apply(context: Context, settings: BackupSettings = PhotoBackupStore.get(context).settings.value) {
        val wm = runCatching { WorkManager.getInstance(context) }.getOrNull() ?: return
        if (!settings.active) {
            wm.cancelUniqueWork(PERIODIC)
            wm.cancelUniqueWork(CONTENT)
            wm.cancelUniqueWork(NOW)
            return
        }
        val periodic = PeriodicWorkRequestBuilder<PhotoBackupWorker>(6, TimeUnit.HOURS)
            .setConstraints(constraints(settings))
            .addTag(TAG)
            .build()
        wm.enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.UPDATE, periodic)
        watchForNewMedia(context, settings)
    }

    /** One run shortly after something new lands in the phone's photos or videos. */
    fun watchForNewMedia(context: Context, settings: BackupSettings, fromWorker: Boolean = false) {
        if (!settings.active) return
        val c = Constraints.Builder()
            .setRequiredNetworkType(if (settings.wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED)
            .setRequiresCharging(settings.chargingOnly)
            .addContentUriTrigger(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, true)
            .apply { if (settings.includeVideos) addContentUriTrigger(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, true) }
            .setTriggerContentUpdateDelay(30, TimeUnit.SECONDS)
            .setTriggerContentMaxDelay(10, TimeUnit.MINUTES)
            .build()
        val req = OneTimeWorkRequestBuilder<PhotoBackupWorker>()
            .setConstraints(c)
            .addTag(TAG).addTag(TAG_CONTENT)
            .build()
        runCatching { WorkManager.getInstance(context).enqueueUniqueWork(CONTENT, if (fromWorker) ExistingWorkPolicy.APPEND_OR_REPLACE else ExistingWorkPolicy.KEEP, req) }
    }

    /** "Back up now", or the follow-up run when one run could not finish everything. */
    fun runSoon(context: Context, settings: BackupSettings = PhotoBackupStore.get(context).settings.value, delaySeconds: Long = 0, followUp: Boolean = false) {
        if (!settings.active) return
        val req = OneTimeWorkRequestBuilder<PhotoBackupWorker>()
            .setConstraints(constraints(settings))
            .setInitialDelay(delaySeconds, TimeUnit.SECONDS)
            .setInputData(workDataOf("reason" to if (followUp) "continue" else "now"))
            .addTag(TAG)
            .build()
        runCatching { WorkManager.getInstance(context).enqueueUniqueWork(NOW, if (followUp) ExistingWorkPolicy.APPEND_OR_REPLACE else ExistingWorkPolicy.KEEP, req) }
    }
}
