package com.beeboentertainment.movie.downloads

import android.app.NotificationManager
import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.beeboentertainment.movie.R
import com.beeboentertainment.movie.ui.MainActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch
import java.io.File

/**
 * Owns the offline library: the persisted index plus the files on disk.
 *
 * WHY NOT Media3's DownloadService/DownloadManager?
 * Media3's downloader is built around a Cache keyed by the download URL (or a custom cache key),
 * and playback then has to go through a CacheDataSource. Our stream URLs embed a media token
 * that rotates every 12 hours (`/file?id=...&mt=...`), so the cache key for "the same movie"
 * changes between sessions and the cache would either miss or accumulate duplicates. Media3's
 * downloader also assumes the content stays reachable for validation.
 * A plain OkHttp fetch into app-private storage gives us a real file we can hand to ExoPlayer as
 * a file:// URI with zero network involvement, report an exact byte size for, and delete with
 * File.delete(). It also resumes trivially with an HTTP Range header. For a progressive
 * single-file download that is both simpler and more reliable, so that is what this uses.
 *
 * THE QUEUE lives in the index itself: QUEUED rows ordered by [DownloadRecord.queueSeq]. The
 * service asks for the next runnable row each time it finishes one, so the queue survives app
 * restarts, and a row waiting for Wi-Fi simply isn't runnable until the network allows it.
 */
class DownloadRepository(private val appContext: Context, private val prefs: SharedPreferences) {

    companion object {
        private const val KEY_INDEX = "downloads_index_v1"
        const val DIR_NAME = "offline"

        /**
         * How often a byte-count-only progress tick is allowed to hit SharedPreferences. Every
         * [persist] serialises the WHOLE index and schedules a disk write, so doing that every
         * few hundred milliseconds for the length of a multi-GB download is pure waste — the
         * resume position comes from the .part file's length on disk, not from the index, so a
         * few seconds of unpersisted progress cost nothing if the process dies.
         */
        private const val PROGRESS_PERSIST_EVERY_MS = 5_000L

        private const val RESUME_JOB_ID = 47_110
        const val WAITING_NOTIFICATION_ID = 4713
    }

    private val _items = MutableStateFlow<List<DownloadRecord>>(emptyList())
    val items: StateFlow<List<DownloadRecord>> = _items.asStateFlow()

    /**
     * Ids the user has stopped.
     *
     * The service writes progress updates from a background coroutine, so a stop and an in-flight
     * update can race: without this the next progress tick would resurrect the row we just
     * deleted. Any update for an id in here is dropped. Re-enqueueing clears the flag.
     */
    private val stoppedIds = java.util.Collections.synchronizedSet(mutableSetOf<String>())

    /** When the index was last written to prefs — throttles [updateProgress] only. */
    @Volatile
    private var lastProgressPersistAt = 0L

    val settings: DownloadSettings

    init {
        val stored = DownloadIndex.decode(prefs.getString(KEY_INDEX, null))
        // Anything marked RUNNING belongs to a process that is gone; it goes back in the queue.
        persist(DownloadIndex.reconcileAfterRestart(stored))
        val upgraded = runCatching {
            val info = appContext.packageManager.getPackageInfo(appContext.packageName, 0)
            info.firstInstallTime != info.lastUpdateTime
        }.getOrDefault(false)
        settings = DownloadSettings(prefs, existingInstall = stored.isNotEmpty() || upgraded)
    }

    /* ------------------------------------------------------------------ network rule */

    fun decisionFor(record: DownloadRecord, state: NetState = NetworkMonitor.state.value): NetDecision =
        NetworkPolicy.decide(state, settings.wifiOnly.value, record)

    fun mayRunNow(record: DownloadRecord): Boolean = decisionFor(record) == NetDecision.ALLOW

    /** The next queued row the network lets run, in queue order. */
    fun nextRunnable(skip: Set<String> = emptySet()): DownloadRecord? =
        DownloadIndex.nextRunnable(_items.value) { it.id !in skip && !stoppedIds.contains(it.id) && mayRunNow(it) }

    /**
     * Watch the network, the Wi-Fi-only setting and the app coming to the foreground, and start
     * the downloader whenever something queued becomes runnable. Called once from the Application.
     */
    fun startAutoResume(scope: CoroutineScope) {
        NetworkMonitor.init(appContext)
        scope.launch(Dispatchers.Main) {
            combine(NetworkMonitor.state, settings.wifiOnly) { s, w -> s to w }
                .distinctUntilChanged()
                // The first value is just "how things are at launch"; the foreground observer
                // below (or the resume job) handles that, from a state Android lets us start in.
                .drop(1)
                .collect { kick(fromBackground = true) }
        }
        scope.launch(Dispatchers.Main) {
            runCatching {
                ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
                    override fun onStart(owner: LifecycleOwner) { kick(fromBackground = false) }
                })
            }
        }
    }

    /**
     * Start the service if anything queued may run now, otherwise make sure something will wake
     * us when the network changes. Returns true if the service was started.
     *
     * Android 12+ refuses to start a foreground service from the background. The app keeps
     * trying from the network callback and the resume job; if Android still says no, a
     * notification asks for one tap to carry on.
     */
    fun kick(fromBackground: Boolean): Boolean {
        val queued = DownloadIndex.queueOrder(_items.value)
        if (queued.isEmpty()) {
            cancelResumeJob()
            cancelWaitingNotice()
            return false
        }
        if (queued.none { mayRunNow(it) }) {
            scheduleResumeJob(queued)
            return false
        }
        cancelWaitingNotice()
        // Already running: just tell it to look at the queue again (no background-start rules).
        if (DownloadService.requestPump()) return true
        val started = runCatching { startService(null) }.isSuccess
        if (!started && fromBackground) postResumeNotice()
        if (!started) scheduleResumeJob(queued)
        return started
    }

    private fun scheduleResumeJob(queued: List<DownloadRecord>) {
        runCatching {
            val js = appContext.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler
            val needsWifi = queued.all { decisionFor(it) == NetDecision.WAIT_FOR_WIFI }
            val job = JobInfo.Builder(RESUME_JOB_ID, ComponentName(appContext, DownloadResumeJob::class.java))
                .setRequiredNetworkType(
                    if (needsWifi) JobInfo.NETWORK_TYPE_UNMETERED else JobInfo.NETWORK_TYPE_ANY
                )
                .build()
            js.schedule(job)
        }
    }

    private fun cancelResumeJob() {
        runCatching {
            (appContext.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler).cancel(RESUME_JOB_ID)
        }
    }

    /** Called by the service when it stops with rows still waiting for the network. */
    fun onServiceIdle() {
        val queued = DownloadIndex.queueOrder(_items.value)
        if (queued.isNotEmpty()) scheduleResumeJob(queued)
    }

    private fun postResumeNotice() {
        runCatching {
            val intent = Intent(appContext, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            }
            val pi = PendingIntent.getActivity(
                appContext, 0, intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            val n = NotificationCompat.Builder(appContext, DownloadService.CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_download)
                .setContentTitle("Ready to carry on downloading")
                .setContentText("Open Beebo to resume your downloads.")
                .setAutoCancel(true)
                .setContentIntent(pi)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build()
            DownloadService.ensureChannel(appContext)
            (appContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .notify(WAITING_NOTIFICATION_ID, n)
        }
    }

    private fun cancelWaitingNotice() {
        runCatching {
            (appContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .cancel(WAITING_NOTIFICATION_ID)
        }
    }

    /* ------------------------------------------------------------------ files */

    /** app-private, no permissions needed, wiped on uninstall. */
    fun downloadDir(): File = File(appContext.filesDir, DIR_NAME).apply { mkdirs() }

    fun fileFor(record: DownloadRecord): File = File(downloadDir(), record.fileName)

    /** Partially-downloaded data lives beside the final file with a .part suffix. */
    fun partFileFor(record: DownloadRecord): File = File(downloadDir(), record.fileName + ".part")

    private fun persist(list: List<DownloadRecord>) {
        _items.value = list
        lastProgressPersistAt = System.currentTimeMillis()
        prefs.edit().putString(KEY_INDEX, DownloadIndex.encode(list)).apply()
    }

    @Synchronized
    fun update(record: DownloadRecord) {
        // Dropped rather than applied: this row was stopped while the transfer was still writing.
        if (stoppedIds.contains(record.id)) return
        persist(DownloadIndex.upsert(_items.value, record.copy(updatedAt = System.currentTimeMillis())))
    }

    /**
     * A progress-only tick from the transfer loop. The in-memory list (and so every collector
     * of [items]) is updated straight away, but the prefs write is throttled to once per
     * [PROGRESS_PERSIST_EVERY_MS]. Every state change (queued, running, complete, failed,
     * stopped) still goes through [update]/[persist] and is written immediately.
     */
    @Synchronized
    fun updateProgress(record: DownloadRecord) {
        if (stoppedIds.contains(record.id)) return
        val list = DownloadIndex.upsert(_items.value, record.copy(updatedAt = System.currentTimeMillis()))
        val now = System.currentTimeMillis()
        if (now - lastProgressPersistAt >= PROGRESS_PERSIST_EVERY_MS) {
            persist(list)
        } else {
            _items.value = list
        }
    }

    /**
     * A transfer paused by the network rule: back in the queue, same position, .part kept.
     * Replaced in place so the row doesn't jump to the top of the list.
     */
    @Synchronized
    fun markWaiting(id: String, bytesDownloaded: Long? = null) {
        if (stoppedIds.contains(id)) return
        val list = _items.value.map {
            if (it.id == id) it.copy(
                status = DownloadStatus.QUEUED.name,
                error = null,
                bytesDownloaded = bytesDownloaded ?: it.bytesDownloaded,
                speedBps = 0L
            ) else it
        }
        persist(list)
    }

    /**
     * A transfer that broke but will be tried again on its own: back in the queue in the same place,
     * .part kept, with a note the row shows while it waits ("retrying in 8 s").
     */
    @Synchronized
    fun markRetrying(id: String, bytesDownloaded: Long, note: String) {
        if (stoppedIds.contains(id)) return
        persist(_items.value.map {
            if (it.id == id) it.copy(
                status = DownloadStatus.QUEUED.name,
                error = note,
                bytesDownloaded = bytesDownloaded,
                speedBps = 0L
            ) else it
        })
    }

    /**
     * Held by the user: the .part stays, nothing runs until they resume it. Resuming is the same as
     * retrying (enqueue), which carries on from the bytes already on disk.
     */
    @Synchronized
    fun markPaused(id: String, bytesDownloaded: Long) {
        if (stoppedIds.contains(id)) return
        persist(_items.value.map {
            if (it.id == id) it.copy(
                status = DownloadStatus.FAILED.name,
                error = DownloadIndex.PAUSED_NOTE,
                bytesDownloaded = bytesDownloaded,
                speedBps = 0L
            ) else it
        })
    }

    /** Pause one download without disturbing any other; a queued row is parked at once. */
    @Synchronized
    fun pause(id: String) {
        val r = get(id) ?: return
        if (!DownloadIndex.canStop(r)) return
        if (r.statusEnum == DownloadStatus.RUNNING && DownloadService.isRunning) sendPause(id)
        else markPaused(id, partFileFor(r).sizeOrZero())
    }

    private fun sendPause(id: String) {
        val intent = Intent(appContext, DownloadService::class.java).apply {
            action = DownloadService.ACTION_PAUSE
            putExtra(DownloadService.EXTRA_ID, id)
        }
        runCatching { appContext.startService(intent) }
    }

    /** True while a stop is being processed — the service uses it to bail out of its write loop. */
    fun isStopped(id: String): Boolean = stoppedIds.contains(id)

    fun get(id: String): DownloadRecord? = DownloadIndex.find(_items.value, id)

    fun isDownloaded(id: String): Boolean = get(id)?.let { it.isComplete && fileFor(it).exists() } == true

    /** Absolute local path if the item is playable offline, else null. */
    fun localPath(id: String): String? {
        val r = get(id) ?: return null
        if (!r.isComplete) return null
        val f = fileFor(r)
        return if (f.exists() && f.length() > 0) f.absolutePath else null
    }

    @Synchronized
    fun delete(id: String) {
        stoppedIds.add(id)   // stop any in-flight write for this id too
        val r = get(id)
        if (r != null) {
            runCatching { fileFor(r).delete() }
            runCatching { partFileFor(r).delete() }
        }
        persist(DownloadIndex.remove(_items.value, id))
    }

    /** Queue (or re-queue) an item and kick the foreground service. */
    @Synchronized
    fun enqueue(
        id: String,
        kind: String,
        title: String,
        streamUrl: String,
        posterUrl: String?,
        showKey: String? = null,
        showName: String? = null,
        season: Int? = null,
        episode: Int? = null
    ) {
        val existing = get(id)
        // A fresh start clears any previous stop, so a stopped item restarts cleanly.
        stoppedIds.remove(id)
        val record = (existing ?: DownloadRecord(
            id = id,
            kind = kind,
            title = title,
            posterUrl = posterUrl,
            streamUrl = streamUrl,
            fileName = DownloadIndex.fileNameFor(id, title)
        )).copy(
            // always refresh the stream URL: the old one's media token may have expired
            streamUrl = streamUrl,
            posterUrl = posterUrl ?: existing?.posterUrl,
            status = DownloadStatus.QUEUED.name,
            error = null,
            showKey = showKey ?: existing?.showKey,
            showName = showName ?: existing?.showName,
            season = season ?: existing?.season,
            episode = episode ?: existing?.episode,
            queueSeq = DownloadIndex.maxSeq(_items.value) + 1
        )
        update(record)
        kick(fromBackground = false)
    }

    /** Queue a batch built by [SeasonQueue.records], in its order, with one index write. */
    @Synchronized
    fun enqueueAll(records: List<DownloadRecord>) {
        if (records.isEmpty()) return
        var list = _items.value
        val now = System.currentTimeMillis()
        // Reverse so the first episode ends up nearest the top, matching single enqueues.
        for (r in records.asReversed()) {
            stoppedIds.remove(r.id)
            list = DownloadIndex.upsert(list, r.copy(updatedAt = now))
        }
        persist(list)
        kick(fromBackground = false)
    }

    /** Next free queue position, for building a batch. */
    fun lastQueueSeq(): Long = DownloadIndex.maxSeq(_items.value)

    /** "Download now using mobile data" for this one download. */
    @Synchronized
    fun allowMobileData(id: String) {
        val r = get(id) ?: return
        persist(_items.value.map { if (it.id == id) r.copy(allowMobileData = true) else it })
        kick(fromBackground = false)
    }

    /** The owner opened this download to play it — see DownloadRecord.lastPlayedAt and StorageReclaim. */
    @Synchronized
    fun markPlayed(id: String, atMs: Long = System.currentTimeMillis()) {
        val r = get(id) ?: return
        persist(_items.value.map { if (it.id == id) r.copy(lastPlayedAt = atMs) else it })
    }

    /** Deletes every download StorageReclaim.plan() chose, freeing its promised space. */
    @Synchronized
    fun deleteForReclaim(plan: StorageReclaim.Plan) {
        for (c in plan.candidates) delete(c.record.id)
    }

    private fun startService(id: String?) {
        val intent = Intent(appContext, DownloadService::class.java).apply {
            action = DownloadService.ACTION_START
            if (id != null) putExtra(DownloadService.EXTRA_ID, id)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            appContext.startForegroundService(intent)
        } else {
            appContext.startService(intent)
        }
    }

    /**
     * Stop a queued or in-flight download and leave nothing behind.
     *
     * Order matters: flag it first so no straggling progress update can revive it, then abort the
     * live HTTP call, then remove the row and both files. The UI updates immediately — the user
     * does not wait on the network to see their mis-click undone.
     *
     * Only touches this id; any other download keeps running.
     */
    @Synchronized
    fun stop(id: String) {
        if (id.isBlank()) return
        stoppedIds.add(id)
        sendCancel(id)
        val record = get(id)
        if (record != null) {
            // the partial must go, or a multi-GB .part sits there forever
            runCatching { partFileFor(record).delete() }
            runCatching { fileFor(record).delete() }
        }
        persist(DownloadIndex.stop(_items.value, id))
    }

    /** Tell a running service to abort the OkHttp call for this id (no-op if it isn't the live one). */
    private fun sendCancel(id: String) {
        if (!DownloadService.isRunning) return
        val intent = Intent(appContext, DownloadService::class.java).apply {
            action = DownloadService.ACTION_CANCEL
            putExtra(DownloadService.EXTRA_ID, id)
        }
        runCatching { appContext.startService(intent) }
    }

    /**
     * "Cancel season": stop every queued or running episode of one show's season in one go.
     * Finished episodes stay on the phone.
     */
    @Synchronized
    fun stopGroup(showKey: String, season: Int?) {
        val list = _items.value
        val ids = DownloadGroups.cancellableIds(list, showKey, season)
        for (id in ids) {
            stoppedIds.add(id)
            sendCancel(id)
            get(id)?.let { r ->
                runCatching { partFileFor(r).delete() }
                runCatching { fileFor(r).delete() }
            }
        }
        persist(DownloadGroups.cancelGroup(list, showKey, season))
    }

    /** Old name kept so nothing calling it silently changes behaviour. */
    fun cancel(id: String) = stop(id)

    /** Whether a row is in a state the user can stop (queued or transferring). */
    fun canStop(id: String): Boolean = DownloadIndex.canStop(get(id))

    /** Total bytes actually on disk. */
    fun totalBytesOnDisk(): Long = _items.value.filter { it.isComplete }.sumOf { r ->
        runCatching { fileFor(r).length() }.getOrDefault(0L)
    }

    /** Free space left on the storage that holds downloads (0 if it can't be read). */
    fun freeSpaceOnDisk(): Long = runCatching { downloadDir().usableSpace }.getOrDefault(0L)

    /**
     * Remove every download from the phone in one go: aborts anything still transferring,
     * deletes each item's file and .part, and clears the index. Mirrors [stop]/[delete] so no
     * straggling progress update can revive a row we just removed.
     */
    @Synchronized
    fun deleteAll() {
        for (r in _items.value) {
            stoppedIds.add(r.id)
            if (DownloadIndex.canStop(r)) sendCancel(r.id)
            runCatching { partFileFor(r).delete() }
            runCatching { fileFor(r).delete() }
        }
        persist(emptyList())
        cancelResumeJob()
    }
}
