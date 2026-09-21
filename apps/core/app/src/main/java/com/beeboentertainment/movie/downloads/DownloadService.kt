package com.beeboentertainment.movie.downloads

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.R
import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.core.formatBytes
import com.beeboentertainment.movie.ui.MainActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.File
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Foreground service that fetches stream URLs to app-private storage, one at a time.
 *
 * - Declares foregroundServiceType="dataSync" (required on Android 14 / targetSdk 34).
 * - Writes to <file>.part and renames on success, so a half file is never mistaken for a download.
 * - Resumes with an HTTP Range header (plus If-Range, so a file that changed on the server starts
 *   over rather than being spliced) when a .part file already exists.
 * - Checks the finished bytes against the size the server promised before it calls a file done.
 * - Retries a broken transfer on its own with a growing, jittered wait, keeping the .part.
 * - Takes work from the persisted queue in the repository, one row at a time, in queue order.
 * - Obeys "Download only on Wi-Fi": a transfer on a metered network is paused (its .part kept)
 *   and picked up again when an unmetered network returns. That applies whether the bytes come
 *   direct from home or through the away-from-home tunnel.
 * - Holds the CPU and the Wi-Fi radio awake while a transfer runs, so a screen-off download isn't
 *   throttled to a crawl.
 * - Stops itself (and drops the notification) when nothing queued may run.
 */
class DownloadService : Service() {

    companion object {
        const val ACTION_START = "com.beeboentertainment.movie.DOWNLOAD_START"
        const val ACTION_CANCEL = "com.beeboentertainment.movie.DOWNLOAD_CANCEL"
        const val ACTION_PAUSE = "com.beeboentertainment.movie.DOWNLOAD_PAUSE"
        const val EXTRA_ID = "id"

        const val CHANNEL_ID = "downloads"
        private const val FOREGROUND_ID = 4711
        /** Minimum gap between progress emissions to the repository StateFlow (the grids). */
        private const val PROGRESS_FLOW_EVERY_MS = 2_000L

        /** Shown when Android's daily background-transfer budget runs out mid-download. */
        private const val TIMEOUT_ID = 4712

        /** A wake lock is always released by the queue going idle; this only bounds a stuck one. */
        private const val LOCK_MAX_MS = 6L * 60 * 60 * 1000

        @Volatile
        private var instance: DownloadService? = null

        val isRunning: Boolean get() = instance != null

        /** Ask a running service to look at the queue again. False if it isn't running. */
        fun requestPump(): Boolean = instance?.pump() == true

        fun ensureChannel(context: Context) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                    nm.createNotificationChannel(
                        NotificationChannel(CHANNEL_ID, "Downloads", NotificationManager.IMPORTANCE_LOW)
                            .apply { description = "Offline download progress" }
                    )
                }
            }
        }
    }

    /** Thrown inside the transfer loop when the network rule pauses the current download. */
    private class PausedForNetwork : java.io.IOException("Waiting for Wi-Fi")

    private val job = SupervisorJob()
    private val scope = CoroutineScope(Dispatchers.IO + job)
    private val queueLock = Mutex()
    private val cancelled = ConcurrentHashMap<String, Boolean>()
    /** Ids whose transfer was cut by the network rule: keep the .part and re-queue, don't fail. */
    private val paused = ConcurrentHashMap<String, Boolean>()
    /** Ids the user paused: keep the .part, park the row, don't retry. */
    private val userPaused = ConcurrentHashMap<String, Boolean>()
    /** Failed attempts in a row per id, and the .part size at the last failure (progress resets the count). */
    private val attempts = ConcurrentHashMap<String, Int>()
    private val lastFailBytes = ConcurrentHashMap<String, Long>()
    private var worker: Job? = null
    /** Set when a pump request arrives while the worker is busy, so it re-checks before stopping. */
    private val rerun = AtomicBoolean(false)
    @Volatile
    private var timedOut = false
    /** Guarded by `this`: the worker has decided to stop the service. */
    private var stopping = false
    private var lastStartId = 0
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    /**
     * The transfer currently in flight. Cancelling the OkHttp Call is what actually aborts the
     * socket — without it a stop would only take effect on the next buffer read, which can hang
     * for a long time on a stalled connection.
     */
    @Volatile
    private var currentCall: okhttp3.Call? = null
    @Volatile
    private var currentId: String? = null

    private val repo: DownloadRepository get() = BeeboApp.instance.downloads

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel(this)
        instance = this
        // Wi-Fi drops to mobile data (or the user turns Wi-Fi-only on) mid-transfer: pause it now,
        // rather than letting a multi-GB episode carry on over a metered connection.
        scope.launch {
            combine(NetworkMonitor.state, repo.settings.wifiOnly) { s, w -> s to w }.collect {
                val id = currentId ?: return@collect
                val r = repo.get(id) ?: return@collect
                if (repo.decisionFor(r) != NetDecision.ALLOW) {
                    paused[id] = true
                    runCatching { currentCall?.cancel() }
                }
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Promote to foreground immediately — Android kills services that don't do this fast.
        startForegroundCompat(buildNotification("Preparing download…", null, 0, true))

        synchronized(this) {
            lastStartId = startId
            stopping = false
        }
        when (intent?.action) {
            ACTION_CANCEL -> intent.getStringExtra(EXTRA_ID)?.let { id -> abort(id) }
            ACTION_PAUSE -> intent.getStringExtra(EXTRA_ID)?.let { id -> pauseOne(id) }
            else -> {
                timedOut = false
                intent?.getStringExtra(EXTRA_ID)?.let { cancelled.remove(it) }
            }
        }
        pump()
        return START_STICKY
    }

    /**
     * Stop one download without disturbing any other. The repository has already removed the row;
     * this only cancels the live HTTP call if it is the one in flight.
     */
    private fun abort(id: String) {
        cancelled[id] = true
        if (currentId == id) {
            runCatching { currentCall?.cancel() }
        }
        runCatching {
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(id.hashCode())
        }
    }

    /** Hold one download where it is: the live call is cut, the .part stays, the row is parked. */
    private fun pauseOne(id: String) {
        if (currentId == id) {
            userPaused[id] = true
            runCatching { currentCall?.cancel() }
        } else {
            repo.get(id)?.let { repo.markPaused(id, repo.partFileFor(it).sizeOrZero()) }
        }
    }

    /** False when this instance is already shutting down (the caller should start the service afresh). */
    fun pump(): Boolean {
        synchronized(this) {
            if (stopping) return false
            if (worker?.isActive == true) {
                rerun.set(true)
                return true
            }
            worker = scope.launch { runQueue() }
            return true
        }
    }

    private suspend fun runQueue() {
        queueLock.withLock {
            do {
                rerun.set(false)
                val tried = HashSet<String>()
                while (!timedOut) {
                    val next = repo.nextRunnable(skip = tried) ?: break
                    val id = next.id
                    tried += id
                    // A flag left by an earlier stop of this id must not swallow a fresh enqueue of it:
                    // a row that is queued and not stopped is wanted, whatever was flagged before.
                    cancelled.remove(id)
                    if (repo.isStopped(id)) continue
                    holdLocks()
                    runCatching { downloadOne(id) }
                        .onFailure { t -> handleFailure(id, t) }
                    // A row that went back to QUEUED (paused, token refresh, retry) may run again
                    // later in this pass if the network allows it.
                    // One read: the row can be deleted between two (a tap on Remove mid-pass).
                    if (repo.get(id)?.let { it.statusEnum == DownloadStatus.QUEUED && repo.mayRunNow(it) } == true) {
                        tried -= id
                    }
                }
            } while (rerun.get() && !timedOut)
        }
        synchronized(this) {
            // A pump that landed after the loop's last check starts a fresh pass instead.
            if (rerun.getAndSet(false) && !timedOut) {
                worker = scope.launch { runQueue() }
                return
            }
            worker = null
            stopping = true
            releaseLocks()
            repo.onServiceIdle()
            stopForegroundCompat()
            // Only stops if no newer start request has arrived; if one has, carry on with it.
            if (!stopSelfResult(lastStartId)) {
                stopping = false
                worker = scope.launch { runQueue() }
            }
        }
    }

    private suspend fun handleFailure(id: String, t: Throwable) {
        currentCall = null
        currentId = null
        when {
            // The user paused it: the .part stays, the row waits for them.
            userPaused.remove(id) == true -> {
                runCatching { (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(FOREGROUND_ID) }
                repo.get(id)?.let { repo.markPaused(id, repo.partFileFor(it).sizeOrZero()) }
            }
            // The network rule (or Android's time budget) cut it: keep the .part, back in the queue.
            paused.remove(id) == true || t is PausedForNetwork -> {
                runCatching { (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(FOREGROUND_ID) }
                repo.get(id)?.let { repo.markWaiting(id, repo.partFileFor(it).sizeOrZero()) }
            }
            // A stop is not a failure — the row and its .part are already gone, so say nothing
            // and move on to the next item in the queue.
            wasStopped(id, t) -> cleanUpAfterStop(id)
            else -> {
                // Wi-Fi dropping usually breaks the socket before the network callback lands.
                // Give it a moment; if the network no longer allows this row, it waits instead.
                if (t is IOException) delay(1_500)
                val r = repo.get(id) ?: return
                val partBytes = repo.partFileFor(r).sizeOrZero()
                if (repo.decisionFor(r) != NetDecision.ALLOW) {
                    repo.markWaiting(id, partBytes)
                    return
                }
                if (RetryPolicy.isRetryable(t)) {
                    val n = RetryPolicy.attemptsAfterFailure(attempts[id] ?: 0, lastFailBytes[id] ?: -1L, partBytes)
                    attempts[id] = n
                    lastFailBytes[id] = partBytes
                    if (RetryPolicy.shouldRetry(n)) {
                        val waitMs = Backoff.delayMs(n)
                        repo.markRetrying(
                            id, partBytes,
                            "Connection problem, trying again in ${(waitMs + 999) / 1000} s (attempt $n of ${RetryPolicy.MAX_ATTEMPTS})"
                        )
                        runCatching { (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(FOREGROUND_ID) }
                        delay(waitMs)
                        return
                    }
                }
                attempts.remove(id)
                lastFailBytes.remove(id)
                repo.update(r.copy(status = DownloadStatus.FAILED.name, error = friendly(t), speedBps = 0L))
            }
        }
    }

    private suspend fun downloadOne(id: String) {
        var refreshedLink = false
        var restarts = 0
        while (true) {
            val start = repo.get(id) ?: return
            paused.remove(id)
            if (repo.decisionFor(start) != NetDecision.ALLOW) throw PausedForNetwork()
            val part = repo.partFileFor(start)
            val target = repo.fileFor(start)
            target.parentFile?.mkdirs()

            var record = start.copy(status = DownloadStatus.RUNNING.name, error = null)
            repo.update(record)

            val meter = SpeedMeter()
            var lastUiUpdate = 0L
            var lastFlowUpdate = 0L
            val attempt = DownloadAttempt(
                // The shared client: direct at home, through the tunnel away from home.
                client = BeeboApp.instance.api.okHttp,
                freeSpace = { repo.freeSpaceOnDisk() },
                checkpoint = {
                    if (!scope.isActive) throw InterruptedException("Stopped")
                    // Two ways a stop reaches us: our own flag, or the repository having already
                    // removed the row when the user tapped Stop in the UI.
                    if (cancelled[id] == true || repo.isStopped(id)) throw InterruptedException("Stopped")
                    if (paused[id] == true) throw PausedForNetwork()
                },
                // Hold on to the Call so a stop can abort the socket immediately.
                onCall = { call ->
                    currentCall = call
                    currentId = id
                },
                formatBytes = ::formatBytes
            )
            val result = attempt.run(
                url = record.streamUrl,
                part = part,
                storedValidator = record.validator,
                storedTotal = record.totalBytes,
                totalHint = record.expectedBytes,
                started = { startOffset, total, validator ->
                    meter.sample(System.currentTimeMillis(), startOffset)
                    record = record.copy(bytesDownloaded = startOffset, totalBytes = total, validator = validator)
                    repo.update(record)
                },
                onProgress = { written, total ->
                    val now = System.currentTimeMillis()
                    if (now - lastUiUpdate > 700) {
                        lastUiUpdate = now
                        meter.sample(now, written)
                        record = record.copy(bytesDownloaded = written, speedBps = meter.bytesPerSecond)
                        notifyProgress(record, meter.etaSeconds(if (total > 0) total - written else 0L))
                        // The repository StateFlow recomposes every visible poster in the
                        // Movies/TV grids, so it gets progress at most every 2 s (and the
                        // repository itself only touches prefs every 5 s). The final byte
                        // count is written unconditionally by the COMPLETE update below.
                        if (now - lastFlowUpdate >= PROGRESS_FLOW_EVERY_MS) {
                            lastFlowUpdate = now
                            repo.updateProgress(record)
                        }
                    }
                }
            )

            currentCall = null
            currentId = null

            when (result) {
                is DownloadAttempt.Result.LinkExpired -> {
                    // A queued season can wait past the 12-hour media token. Fetch a fresh link
                    // once and carry on.
                    if (!refreshedLink && refreshStreamUrl(record)) {
                        refreshedLink = true
                        continue
                    }
                    throw DownloadFatalException("Media link expired — open the item again and retry")
                }
                is DownloadAttempt.Result.RestartFromZero -> {
                    if (++restarts > 2) throw DownloadFatalException("Your home computer wouldn't send this file. Try again later.")
                    repo.update(record.copy(validator = null, bytesDownloaded = 0L, totalBytes = 0L))
                    continue
                }
                is DownloadAttempt.Result.AlreadyComplete ->
                    if (record.totalBytes > 0 && part.sizeOrZero() != record.totalBytes) {
                        part.delete()
                        throw IOException("The partial file didn't match; starting again")
                    }
                is DownloadAttempt.Result.Finished -> Unit
            }

            if (cancelled.remove(record.id) == true || repo.isStopped(record.id)) {
                // Stopped right at the finish line: bin the partial, leave no row behind.
                cleanUpAfterStop(record.id)
                return
            }

            if (target.exists()) target.delete()
            if (!part.renameTo(target)) {
                // rename can fail on some filesystems; fall back to a copy
                part.copyTo(target, overwrite = true)
                part.delete()
            }
            attempts.remove(id)
            lastFailBytes.remove(id)
            record = record.copy(
                status = DownloadStatus.COMPLETE.name,
                bytesDownloaded = target.length(),
                totalBytes = target.length(),
                error = null,
                speedBps = 0L
            )
            repo.update(record)
            notifyComplete(record)
            return
        }
    }

    /** Re-read the title's listing for a fresh media token. True if the row now has a new link. */
    private suspend fun refreshStreamUrl(record: DownloadRecord): Boolean {
        return runCatching {
            val app = BeeboApp.instance
            val stream = if (record.showKey != null) {
                app.api.episodes(record.showKey).seasons.flatMap { it.episodes }.firstOrNull { it.id == record.id }?.stream
            } else {
                app.api.movies(q = record.title).items.firstOrNull { it.id == record.id }?.stream
            }
            val url = UrlUtils.join(app.session.baseUrl, stream) ?: return false
            repo.update(record.copy(streamUrl = url, status = DownloadStatus.QUEUED.name))
            true
        }.getOrDefault(false)
    }

    /**
     * Did this throw because the user stopped it? Either we flagged it, the repository already
     * removed it, or OkHttp threw "Socket closed"/"Canceled" because we cancelled the Call.
     */
    private fun wasStopped(id: String, t: Throwable): Boolean =
        cancelled[id] == true || repo.isStopped(id) || RetryPolicy.isCancellation(t)

    /** Belt and braces: make sure no partial file survives a stop. */
    private fun cleanUpAfterStop(id: String) {
        cancelled.remove(id)
        attempts.remove(id)
        lastFailBytes.remove(id)
        val record = repo.get(id)
        if (record != null) {
            runCatching { repo.partFileFor(record).delete() }
            runCatching { repo.fileFor(record).delete() }
        } else {
            // The row is already gone; remove any stray .part left under its file name.
            runCatching {
                repo.downloadDir().listFiles()
                    ?.filter { it.name.endsWith(".part") && it.name.contains(Integer.toHexString(id.hashCode())) }
                    ?.forEach { it.delete() }
            }
        }
        runCatching {
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(id.hashCode())
        }
    }

    private fun friendly(t: Throwable): String = when {
        t is InterruptedException -> "Cancelled"
        RetryPolicy.looksLikeOutOfSpace(t) -> "Not enough space on this phone"
        else -> t.message ?: t.javaClass.simpleName
    }

    /* ------------------------------ wake locks ------------------------------ */

    private fun holdLocks() {
        runCatching {
            if (wakeLock?.isHeld != true) {
                val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "beebo:downloads")
                    .apply { setReferenceCounted(false); acquire(LOCK_MAX_MS) }
            }
        }
        runCatching {
            if (wifiLock?.isHeld != true) {
                val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
                @Suppress("DEPRECATION")
                wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "beebo:downloads")
                    .apply { setReferenceCounted(false); acquire() }
            }
        }
    }

    private fun releaseLocks() {
        runCatching { wakeLock?.let { if (it.isHeld) it.release() } }
        runCatching { wifiLock?.let { if (it.isHeld) it.release() } }
        wakeLock = null
        wifiLock = null
    }

    /* ------------------------- notifications ------------------------- */

    private fun contentIntent(): PendingIntent {
        val i = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        else PendingIntent.FLAG_UPDATE_CURRENT
        return PendingIntent.getActivity(this, 0, i, flags)
    }

    /**
     * PendingIntent that stops one download. This is the affordance most people will reach for
     * first — they realise the mis-click while the progress bar is still in the shade.
     */
    private fun stopIntent(id: String): PendingIntent = actionIntent(ACTION_CANCEL, id, id.hashCode())

    /** PendingIntent that holds one download where it is; the row's Resume picks it up. */
    private fun pauseIntent(id: String): PendingIntent = actionIntent(ACTION_PAUSE, id, id.hashCode() xor 0x5041)

    private fun actionIntent(action: String, id: String, requestCode: Int): PendingIntent {
        val intent = Intent(this, DownloadService::class.java).apply {
            this.action = action
            putExtra(EXTRA_ID, id)
        }
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        else PendingIntent.FLAG_UPDATE_CURRENT
        // Per-id request code, so two downloads don't share one action.
        return PendingIntent.getService(this, requestCode, intent, flags)
    }

    private fun buildNotification(
        title: String,
        text: String?,
        progress: Int,
        indeterminate: Boolean,
        stopId: String? = null
    ): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_download)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(contentIntent())
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .apply {
                if (indeterminate) setProgress(0, 0, true)
                else if (progress >= 0) setProgress(100, progress, false)
                if (stopId != null) {
                    addAction(R.drawable.ic_stat_download, "Pause", pauseIntent(stopId))
                    addAction(R.drawable.ic_stat_stop, "Stop", stopIntent(stopId))
                }
            }
            .build()

    private fun notifyProgress(record: DownloadRecord, etaSeconds: Long?) {
        val pct = record.percent
        val soFar = if (record.totalBytes > 0)
            "${formatBytes(record.bytesDownloaded)} of ${formatBytes(record.totalBytes)}"
        else formatBytes(record.bytesDownloaded)
        val pace = if (record.speedBps > 0) " · ${SpeedMeter.formatSpeed(record.speedBps)}" else ""
        val left = if (etaSeconds != null && etaSeconds > 0) " · ${SpeedMeter.formatEta(etaSeconds)} left" else ""
        val queuedAfter = DownloadIndex.queueOrder(repo.items.value).size
        val more = if (queuedAfter > 0) " · $queuedAfter more queued" else ""
        val n = buildNotification("Downloading ${record.title}", soFar + pace + left + more, pct, pct < 0, stopId = record.id)
        runCatching {
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .notify(FOREGROUND_ID, n)
        }
    }

    private fun notifyComplete(record: DownloadRecord) {
        val n = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_download)
            .setContentTitle("Downloaded")
            .setContentText("${record.title} — ${formatBytes(record.totalBytes)}")
            .setAutoCancel(true)
            .setContentIntent(contentIntent())
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
        runCatching {
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .notify(record.id.hashCode(), n)
        }
    }


    /**
     * Android 15+ gives every app a shared 6-hour daily budget for `dataSync` foreground
     * services. When it runs out the system calls this, and if we are still foreground a
     * few seconds later it kills the process with
     * `RemoteServiceException: a foreground service of type dataSync did not stop within
     * its timeout`. So: stop now, tell the user plainly, and let them restart it.
     *
     * The budget resets once the app is brought to the foreground again, which is exactly
     * what the notification asks them to do. The queue itself is kept: the transfer in flight
     * goes back to QUEUED with its .part, and opening the app picks everything up again.
     */
    override fun onTimeout(startId: Int, fgsType: Int) {
        timedOut = true
        currentId?.let { paused[it] = true }
        runCatching { currentCall?.cancel() }
        stopForegroundCompat()
        runCatching {
            val n = NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_download)
                .setContentTitle("Downloads paused")
                .setContentText("Android limits background downloads to 6 hours a day. Open Beebo to carry on — nothing already downloaded is lost.")
                .setStyle(NotificationCompat.BigTextStyle().bigText(
                    "Android limits background downloads to 6 hours a day, and today's is used up. " +
                        "Open Beebo and your downloads carry on — each picks up exactly where it stopped."
                ))
                .setAutoCancel(true)
                .setOngoing(false)
                .setContentIntent(contentIntent())
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build()
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .notify(TIMEOUT_ID, n)
        }
        stopSelf()
    }

    private fun startForegroundCompat(notification: Notification) {
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(FOREGROUND_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            } else {
                startForeground(FOREGROUND_ID, notification)
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun stopForegroundCompat() {
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(Service.STOP_FOREGROUND_REMOVE)
            } else {
                stopForeground(true)
            }
        }
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        // A transfer still in flight when the service dies goes back in the queue, not to FAILED.
        currentId?.let { id -> paused[id] = true; repo.get(id)?.let { repo.markWaiting(id) } }
        releaseLocks()
        scope.cancel()
        super.onDestroy()
    }
}

/** Small helper so callers don't need java.io.File imported everywhere. */
fun File.sizeOrZero(): Long = runCatching { if (exists()) length() else 0L }.getOrDefault(0L)
