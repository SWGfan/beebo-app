package com.beeboentertainment.movie.spacesaver

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.R
import com.beeboentertainment.movie.core.formatBytes
import com.beeboentertainment.movie.ui.MainActivity
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlin.coroutines.coroutineContext

/**
 * Foreground service that backs up the not-yet-copied Space Saver files to the home computer.
 *
 * Mirrors [com.beeboentertainment.movie.downloads.DownloadService]: it declares
 * foregroundServiceType="dataSync", promotes itself to the foreground immediately in
 * onStartCommand, runs its work on an IO scope, and stops itself (dropping the ongoing
 * notification) when the run ends. It is always started from a button tap
 * ([com.beeboentertainment.movie.spacesaver.SpaceSaverScreen]), which is the user-initiated origin
 * Android 14 (targetSdk 35) requires for a dataSync foreground service.
 *
 * The work itself reuses the existing pieces unchanged — [SpaceSaverScanner] to enumerate the
 * persisted trees, [SpaceSaverClient] for /check and the streaming /upload, [SpaceSaverStore] for
 * the durable "backed up" set. Each completed upload is written to the store immediately, so a
 * kill/restart never re-uploads what already landed. Live progress goes to [SpaceSaverProgress]
 * (observed by the screen) and to the ongoing notification.
 */
class SpaceSaverService : Service() {

    companion object {
        const val ACTION_START = "com.beeboentertainment.movie.SPACE_SAVER_START"
        const val ACTION_CANCEL = "com.beeboentertainment.movie.SPACE_SAVER_CANCEL"

        /** From the "Use mobile data" notification action / in-app button while paused for Wi-Fi. */
        const val ACTION_USE_MOBILE_DATA = "com.beeboentertainment.movie.SPACE_SAVER_USE_MOBILE_DATA"

        const val CHANNEL_ID = "space_saver"
        private const val FOREGROUND_ID = 5120
        private const val DONE_ID = 5121

        /** Shown when Android's daily background-transfer budget runs out mid-backup. */
        private const val TIMEOUT_ID = 5122

        /** Bounded retry for a transient network hiccup on a single file. */
        private const val MAX_ATTEMPTS = 2

        /** How often the paused loop re-checks the network / the Wi-Fi-only flag. */
        private const val PAUSE_POLL_MS = 1000L

        /** User-facing text for the paused-for-network state. */
        private const val PAUSED_TITLE = "Paused — waiting for Wi-Fi"
        private const val PAUSED_TEXT = "Backup will continue when Wi-Fi is back. Tap \"Use mobile data\" to keep going now."

        /** Start the backup. Uses startForegroundService so we can promote to foreground on Android O+. */
        fun start(context: Context) {
            val i = Intent(context, SpaceSaverService::class.java).apply { action = ACTION_START }
            ContextCompat.startForegroundService(context, i)
        }

        /** Ask a running backup to stop. */
        fun stop(context: Context) {
            val i = Intent(context, SpaceSaverService::class.java).apply { action = ACTION_CANCEL }
            // Same entry point; onStartCommand handles the cancel even before foreground promotion.
            ContextCompat.startForegroundService(context, i)
        }

        /**
         * Escape hatch while paused for Wi-Fi: proceed on mobile data. Flips the persisted
         * "Wi-Fi only" setting off (so the current run — and future runs — may use cell), and a
         * paused worker resumes on its own the moment it re-reads the flag.
         */
        fun useMobileData(context: Context) {
            val i = Intent(context, SpaceSaverService::class.java).apply { action = ACTION_USE_MOBILE_DATA }
            ContextCompat.startForegroundService(context, i)
        }
    }

    private val job = SupervisorJob()

    /**
     * Last-line defence: any throwable that escapes the worker coroutine's own try/catch (or is
     * thrown before it, e.g. while setting up) is swallowed here and turned into a user-safe
     * failure message instead of reaching the thread's default handler and crashing the process.
     */
    private val exceptionHandler = CoroutineExceptionHandler { _, t ->
        if (t !is CancellationException) {
            runCatching { SpaceSaverProgress.fail(t.message ?: "Backup failed.") }
        }
        runCatching { releaseWakeLock() }
        runCatching { worker = null }
        runCatching { stopForegroundCompat() }
        runCatching { stopSelf() }
    }

    private val scope = CoroutineScope(Dispatchers.IO + job + exceptionHandler)

    @Volatile
    private var worker: Job? = null

    private var wakeLock: PowerManager.WakeLock? = null

    private val store: SpaceSaverStore by lazy { SpaceSaverStore(BeeboApp.instance.session.plain) }
    private val client: SpaceSaverClient by lazy {
        SpaceSaverClient(BeeboApp.instance.session, BeeboApp.instance.api.okHttp)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // The whole body is guarded: no matter what throws in here, we tear down best-effort and
        // return START_NOT_STICKY rather than letting the throwable propagate and crash the app.
        return try {
            // Promote to foreground immediately — Android kills a service that dawdles here.
            val promoted = startForegroundCompat(
                buildProgressNotification("Preparing backup…", null, 0, indeterminate = true)
            )
            if (!promoted) {
                // Couldn't become a foreground service (e.g. notifications blocked or a platform
                // restriction). Drop any partial foreground state so the "didn't call
                // startForeground in time" rule can't kill us, and keep working while alive.
                runCatching { stopForegroundCompat() }
            }

            when (intent?.action) {
                ACTION_CANCEL -> {
                    // Cancelling the worker aborts the in-flight upload (the client honours cancellation).
                    worker?.cancel()
                    if (worker == null) {
                        // Nothing was running: just clear ourselves out.
                        stopForegroundCompat()
                        stopSelf()
                    }
                }
                ACTION_USE_MOBILE_DATA -> {
                    // Turn "Wi-Fi only" off. A worker paused for Wi-Fi polls this flag and resumes
                    // on its own within a second; no need to touch the worker directly.
                    runCatching { store.setWifiOnly(false) }
                    if (worker?.isActive != true) {
                        // No run in flight (action arrived after the run ended): don't linger foreground.
                        stopForegroundCompat()
                        stopSelf()
                    }
                }
                else -> runBackup(foregroundOk = promoted)
            }
            START_NOT_STICKY
        } catch (t: Throwable) {
            // Best-effort teardown; never rethrow.
            runCatching { SpaceSaverProgress.fail(t.message ?: "Couldn't start the backup.") }
            runCatching { stopForegroundCompat() }
            runCatching { stopSelf() }
            START_NOT_STICKY
        }
    }

    /** Kick off the backup worker, unless one is already running (never double-run). */
    private fun runBackup(foregroundOk: Boolean = true) {
        if (worker?.isActive == true) return
        worker = scope.launch {
            acquireWakeLock()
            SpaceSaverProgress.begin()
            if (!foregroundOk) {
                // Let the user know why the ongoing notification may be missing — the work still runs.
                SpaceSaverProgress.note("Backing up in the background — the progress notification couldn't be shown.")
            }
            var uploaded = 0
            var skipped = 0
            var failed = 0
            var total = 0
            try {
                val folders = store.folders()
                val pickedFiles = store.files()
                val scan = SpaceSaverScanner.scan(this@SpaceSaverService, folders, pickedFiles)
                if (scan.files.isEmpty()) {
                    val msg = "Everything is already backed up."
                    SpaceSaverProgress.finish(msg)
                    notifyDone(msg, 0L)
                    return@launch
                }

                // 1) The SERVER is the source of truth. Ask /check about EVERY scanned file (the
                //    client batches), never pre-filtering by the local "backed up" cache — a file the
                //    server no longer holds (deleted from the computer) must be re-uploaded even if the
                //    cache still says it's backed up. Reconcile the cache to match the server:
                //      have == true  -> ensure it's marked backed up (cache it), skip re-upload;
                //      have == false -> UNMARK the stale cache entry and queue it for upload.
                // Gate the very first network round-trip too: if "Wi-Fi only" is on and we're on
                // cell, this parks us straight in the paused "waiting for Wi-Fi" state (with the
                // "Use mobile data" escape) rather than reaching out over mobile data.
                awaitUploadAllowed()
                val have = client.check(scan.files.map { CheckItem(it.relPath, it.size) })
                    .filter { it.have }
                    .map { it.path }
                    .toSet()
                val remaining = ArrayList<ScanFile>()
                for (f in scan.files) {
                    coroutineContext.ensureActive()
                    if (f.relPath in have) {
                        store.markBackedUp(f.relPath, f.size)
                        skipped++
                    } else {
                        // Stale mark (if any) is cleared now; it is only re-marked on a successful upload.
                        store.unmarkBackedUp(f.relPath, f.size)
                        remaining += f
                    }
                }

                // "Everything is already backed up" now means the SERVER has them all (have==true),
                // not merely that the local cache said so.
                if (remaining.isEmpty()) {
                    val msg = "Everything is already backed up."
                    SpaceSaverProgress.finish(msg)
                    notifyDone(msg, 0L)
                    return@launch
                }

                // 2) Upload the rest, one streaming request each, persisting each success at once.
                total = remaining.size
                SpaceSaverProgress.setTotal(total)
                var uploadedBytes = 0L
                for ((i, f) in remaining.withIndex()) {
                    coroutineContext.ensureActive()
                    // Before STARTING each file, make sure we're allowed to upload right now. If
                    // Wi-Fi dropped to cell mid-run (and "Wi-Fi only" is on) this parks here until
                    // Wi-Fi returns or the user opts into mobile data — already-uploaded files stay
                    // marked, so we resume exactly where we left off.
                    awaitUploadAllowed()
                    SpaceSaverProgress.update(i, total, f.name)
                    notifyProgress(i, total, f.name)

                    val resp = uploadWithRetry(f)
                    if (resp == null) {
                        // Transient network failure that survived the retries: stop the whole run
                        // gracefully so the user can retry. Everything already done stays marked.
                        val msg = "Backup paused — couldn't reach your computer. $uploaded of $total done; tap Back up now to continue."
                        SpaceSaverProgress.fail(msg)
                        notifyDone(msg, uploadedBytes)
                        return@launch
                    }
                    if (resp.onServer) {
                        store.markBackedUp(f.relPath, f.size)
                        uploaded++
                        uploadedBytes += f.size
                    } else {
                        // A parse-able ok:false (e.g. size mismatch): a skip, not a crash.
                        failed++
                    }
                    SpaceSaverProgress.update(i + 1, total, f.name)
                }

                val summary = buildString {
                    append("Backup complete — $uploaded file${if (uploaded == 1) "" else "s"}")
                    if (skipped > 0) append(", $skipped already on your computer")
                    if (failed > 0) append(", $failed couldn't be copied")
                    if (uploadedBytes > 0) append(". Ready to free up ${formatBytes(uploadedBytes)}")
                    else append(".")
                }
                SpaceSaverProgress.finish(summary)
                notifyDone(summary, uploadedBytes)
            } catch (ce: CancellationException) {
                // User tapped Cancel / Stop. Finished files are already marked.
                SpaceSaverProgress.cancelled("Backup stopped. $uploaded of $total done — copied files are kept.")
                throw ce
            } catch (e: SpaceSaverException) {
                val msg = if (e.unauthorized) "Your session expired — sign in again." else (e.message ?: "Backup failed.")
                SpaceSaverProgress.fail(msg)
                notifyDone(msg, 0L)
            } catch (t: Throwable) {
                // Even an Error becomes a friendly on-screen failure, never a process crash.
                // (CancellationException is already handled and rethrown above.)
                SpaceSaverProgress.fail(t.message ?: "Backup failed.")
            } finally {
                releaseWakeLock()
                worker = null
                stopForegroundCompat()
                stopSelf()
            }
        }
    }

    /**
     * Upload one file with a small bounded retry for a transient hiccup.
     *
     * Returns the parsed [UploadResponse] on success (including a parse-able ok:false, which the
     * caller treats as a skip), or null when a network failure survived every attempt so the caller
     * can stop the run gracefully. An unauthorized error is rethrown — that needs a re-login, not a
     * retry. A CancellationException propagates untouched so Stop is instant.
     */
    private suspend fun uploadWithRetry(f: ScanFile): UploadResponse? {
        var attempt = 0
        while (true) {
            attempt++
            try {
                return client.upload(this, f.relPath, f.size, f.uri)
            } catch (ce: CancellationException) {
                throw ce
            } catch (e: SpaceSaverException) {
                if (e.unauthorized) throw e
                if (attempt >= MAX_ATTEMPTS) return null
                delay(1500)
            } catch (e: Exception) {
                if (attempt >= MAX_ATTEMPTS) return null
                delay(1500)
            }
        }
    }

    /* ------------------------------- network --------------------------------- */

    /**
     * Are we allowed to START an upload right now?
     *
     * When "Wi-Fi only" is off, any network is fine — return true and let the upload itself fail if
     * we happen to be offline (that path already stops the run gracefully). We never pause on cell.
     *
     * When "Wi-Fi only" is on, require the active network to be connected AND unmetered Wi-Fi
     * ([NetworkCapabilities.NET_CAPABILITY_NOT_METERED] and/or [NetworkCapabilities.TRANSPORT_WIFI]).
     *
     * Robustness (never crash, never hang forever): if there's no active network we return false and
     * wait (that's genuinely "no Wi-Fi yet"); but if we can't even reach ConnectivityManager or read
     * the network's capabilities, we can't determine metering — so we prefer allowing over parking
     * the run indefinitely, and let the upload proceed.
     */
    private fun isUploadAllowed(): Boolean {
        val wifiOnly = runCatching { store.wifiOnly() }.getOrDefault(true)
        if (!wifiOnly) return true

        val cm = runCatching { getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager }
            .getOrNull() ?: return true // can't determine metering -> don't hang, allow
        val network = runCatching { cm.activeNetwork }.getOrNull()
            ?: return false // no active network at all -> keep waiting for Wi-Fi
        val caps = runCatching { cm.getNetworkCapabilities(network) }.getOrNull()
            ?: return true // have a network but can't read caps -> can't tell metering, allow
        val unmetered = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
        val onWifi = caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
        return unmetered || onWifi
    }

    /**
     * If we're not currently allowed to upload, enter the PAUSED state and wait — staying in the
     * foreground and fully cancellable — until either the network becomes allowed again or the user
     * opts into mobile data (which flips "Wi-Fi only" off, read live below), then resume.
     *
     * We poll rather than register a NetworkCallback: [delay] is cancellable so Stop is instant, the
     * loop re-reads both the live network state and the Wi-Fi-only flag each tick (so "Use mobile
     * data" resumes within ~1s), and it stays trivially correct. The wake lock is released for the
     * duration of the wait and re-acquired before returning, so we don't pin the CPU while idle.
     */
    private suspend fun awaitUploadAllowed() {
        if (isUploadAllowed()) return

        releaseWakeLock()
        SpaceSaverProgress.pauseForNetwork(PAUSED_TITLE)
        notifyPaused()
        try {
            while (!isUploadAllowed()) {
                coroutineContext.ensureActive() // Stop cancels the delay instantly
                delay(PAUSE_POLL_MS)
            }
        } finally {
            // Re-arm the CPU wake lock for the upload work that follows (even on cancel, so teardown
            // in finally runs on a live CPU; it's released again there).
            acquireWakeLock()
        }
        SpaceSaverProgress.resume()
    }

    /* ------------------------------- wake lock ------------------------------- */

    private fun acquireWakeLock() {
        runCatching {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            val wl = pm.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "beebo:space_saver_backup"
            ).apply { setReferenceCounted(false) }
            // 30 minutes is a generous ceiling so a stuck run can never hold the CPU forever;
            // a normal run releases it in finally long before this fires.
            wl.acquire(30 * 60 * 1000L)
            wakeLock = wl
        }
    }

    private fun releaseWakeLock() {
        runCatching { wakeLock?.let { if (it.isHeld) it.release() } }
        wakeLock = null
    }

    /* ------------------------------ notifications ---------------------------- */

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, "Space Saver backup", NotificationManager.IMPORTANCE_LOW)
                        .apply { description = "Backing up folders to your computer" }
                )
            }
        }
    }

    /** Tapping the notification opens the app on the Space Saver screen. */
    private fun contentIntent(): PendingIntent {
        val i = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra(MainActivity.EXTRA_OPEN_SPACE_SAVER, true)
        }
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        else PendingIntent.FLAG_UPDATE_CURRENT
        return PendingIntent.getActivity(this, 1, i, flags)
    }

    /** PendingIntent that stops the run — the Cancel action on the ongoing notification. */
    private fun cancelIntent(): PendingIntent {
        val intent = Intent(this, SpaceSaverService::class.java).apply { action = ACTION_CANCEL }
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        else PendingIntent.FLAG_UPDATE_CURRENT
        return PendingIntent.getService(this, 2, intent, flags)
    }

    /** PendingIntent behind the "Use mobile data" action — flips Wi-Fi-only off and resumes. */
    private fun useMobileDataIntent(): PendingIntent {
        val intent = Intent(this, SpaceSaverService::class.java).apply { action = ACTION_USE_MOBILE_DATA }
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        else PendingIntent.FLAG_UPDATE_CURRENT
        return PendingIntent.getService(this, 3, intent, flags)
    }

    /** Ongoing notification shown while the run is parked waiting for Wi-Fi. */
    private fun notifyPaused() {
        val n = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_download)
            .setContentTitle(PAUSED_TITLE)
            .setContentText(PAUSED_TEXT)
            .setStyle(NotificationCompat.BigTextStyle().bigText(PAUSED_TEXT))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(contentIntent())
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setProgress(0, 0, true)
            .addAction(R.drawable.ic_stat_download, "Use mobile data", useMobileDataIntent())
            .addAction(R.drawable.ic_stat_stop, "Cancel", cancelIntent())
            .build()
        runCatching {
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .notify(FOREGROUND_ID, n)
        }
    }

    private fun buildProgressNotification(
        title: String,
        text: String?,
        progress: Int,
        indeterminate: Boolean,
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
                else setProgress(100, progress.coerceIn(0, 100), false)
            }
            .addAction(R.drawable.ic_stat_stop, "Cancel", cancelIntent())
            .build()

    private fun notifyProgress(done: Int, total: Int, name: String?) {
        val pct = if (total > 0) (done * 100 / total) else 0
        val title = "Backing up ${done + 1} of $total · $pct%"
        val n = buildProgressNotification(title, name, pct, indeterminate = total <= 0)
        runCatching {
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .notify(FOREGROUND_ID, n)
        }
    }

    private fun notifyDone(text: String, freedBytes: Long) {
        val n = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_download)
            .setContentTitle("Space Saver")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .setOngoing(false)
            .setContentIntent(contentIntent())
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
        runCatching {
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .notify(DONE_ID, n)
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
     * what the notification asks them to do.
     */
    override fun onTimeout(startId: Int, fgsType: Int) {
        // Stop the worker before anything else: it is what holds the wake lock and the upload.
        runCatching { worker?.cancel() }
        runCatching { worker = null }
        runCatching { releaseWakeLock() }
        runCatching {
            SpaceSaverProgress.cancelled(
                "Paused \u2014 Android limits background backups to 6 hours a day. Open Beebo to carry on."
            )
        }
        stopForegroundCompat()
        runCatching {
            val n = NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_download)
                .setContentTitle("Backup paused")
                .setContentText("Android limits background backups to 6 hours a day. Open Beebo to carry on.")
                .setStyle(NotificationCompat.BigTextStyle().bigText(
                    "Android limits background backups to 6 hours a day, and today's is used up. " +
                        "Open Beebo and start Space Saver again \u2014 already-copied files are skipped, " +
                        "and nothing is deleted from your phone until the PC confirms it has a copy."
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

    /** Promote to foreground. Returns true on success, false if [startForeground] threw. */
    private fun startForegroundCompat(notification: Notification): Boolean =
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(FOREGROUND_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            } else {
                startForeground(FOREGROUND_ID, notification)
            }
            true
        } catch (t: Throwable) {
            false
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
        releaseWakeLock()
        scope.cancel()
        super.onDestroy()
    }
}
