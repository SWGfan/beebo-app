package com.beeboentertainment.movie.trip

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.beeboentertainment.movie.R
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Runs a trip-video export in the foreground so it survives the screen turning off or the person
 * switching apps. An encode takes about as long as the video it makes, so it needs a foreground
 * service; the notification shows progress and has a Cancel button. Declared as `dataSync` in the
 * manifest, the same type the app's other long file jobs use (Google's list for it includes local
 * file processing and import/export), which needs no permission beyond the one already declared.
 *
 * Nothing here talks to a network.
 */
class TripExportService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var job: Job? = null
    private var engine: TripExportEngine? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_CANCEL -> {
                cancelExport()
                return START_NOT_STICKY
            }
            else -> {
                ensureChannel()
                // Must go foreground straight away: the system gives a few seconds after startForegroundService.
                startForegroundCompat(progressNotification("Getting your trip video ready", 0, indeterminate = true))
                val request = requestFrom(intent)
                if (request == null || job?.isActive == true) {
                    if (job?.isActive != true) stopSelf()
                    return START_NOT_STICKY
                }
                begin(request)
            }
        }
        return START_NOT_STICKY
    }

    private fun begin(request: ExportRequest) {
        val exporter = TripExportEngine(applicationContext).also { engine = it }
        TripExportState.set(ExportState.Preparing(0, 0))
        job = scope.launch {
            val outcome = try {
                exporter.run(request) { state ->
                    TripExportState.set(state)
                    notifyProgress(state)
                }
            } catch (e: CancellationException) {
                TripExportState.set(ExportState.Cancelled)
                finish("Trip video cancelled")
                throw e
            }
            TripExportState.set(outcome)
            finish(
                when (outcome) {
                    is ExportState.Done -> "Your trip video is ready. Open Beebo to share it."
                    is ExportState.Failed -> outcome.message
                    else -> "Trip video stopped"
                },
            )
        }
    }

    private fun cancelExport() {
        val running = job
        if (running?.isActive == true) running.cancel()
        else {
            TripExportState.set(ExportState.Cancelled)
            stopForegroundCompat()
            stopSelf()
        }
    }

    private fun notifyProgress(state: ExportState) {
        val n = when (state) {
            is ExportState.Preparing ->
                progressNotification("Preparing your trip video", state.done * 100 / state.total.coerceAtLeast(1), indeterminate = state.total == 0)
            is ExportState.Encoding -> progressNotification("Making your trip video", state.percent, indeterminate = false)
            else -> return
        }
        runCatching { (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIF_ID, n) }
    }

    /** Swap the ongoing notification for a plain one saying how it ended, then stop. */
    private fun finish(message: String) {
        stopForegroundCompat()
        runCatching {
            val n = NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("Trip video")
                .setContentText(message)
                .setContentIntent(openApp())
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build()
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(DONE_ID, n)
        }
        stopSelf()
    }

    /**
     * Android 15 caps `dataSync` foreground services and calls this when the time is up; if the
     * service is still running a few seconds later the whole app is killed. An export that long is
     * far beyond the length cap, so this is only a safety net.
     */
    override fun onTimeout(startId: Int, fgsType: Int) {
        cancelExport()
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun progressNotification(text: String, percent: Int, indeterminate: Boolean): Notification {
        val cancel = PendingIntent.getService(
            this, 1, Intent(this, TripExportService::class.java).setAction(ACTION_CANCEL),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Trip video")
            .setContentText(text)
            .setProgress(100, percent.coerceIn(0, 100), indeterminate)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openApp())
            .addAction(0, "Cancel", cancel)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun openApp(): PendingIntent? =
        packageManager.getLaunchIntentForPackage(packageName)?.let {
            PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Trip videos", NotificationManager.IMPORTANCE_LOW))
        }
    }

    private fun startForegroundCompat(notification: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIF_ID, notification)
        }
    }

    @Suppress("DEPRECATION")
    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE) else stopForeground(true)
    }

    companion object {
        private const val CHANNEL_ID = "trip_video"
        private const val NOTIF_ID = 4711
        private const val DONE_ID = 4712
        private const val ACTION_CANCEL = "com.beeboentertainment.movie.trip.CANCEL_EXPORT"
        private const val X_TRIP = "trip"
        private const val X_QUALITY = "quality"
        private const val X_AMBIENCE = "ambience"
        private const val X_NAMES = "names"
        private const val X_OUTSIDE = "outside"

        internal fun start(context: Context, request: ExportRequest) {
            val s = request.settings
            val intent = Intent(context, TripExportService::class.java)
                .putExtra(X_TRIP, request.tripId)
                .putExtra(X_QUALITY, s.quality.name)
                .putExtra(X_AMBIENCE, s.ambience)
                .putStringArrayListExtra(X_NAMES, ArrayList(s.shownNames))
                .putExtra(X_OUTSIDE, s.includeOutsideMedia)
            ContextCompat.startForegroundService(context, intent)
        }

        fun cancel(context: Context) {
            context.startService(Intent(context, TripExportService::class.java).setAction(ACTION_CANCEL))
        }

        private fun requestFrom(intent: Intent?): ExportRequest? {
            val trip = intent?.getStringExtra(X_TRIP)?.takeIf { it.isNotBlank() } ?: return null
            val quality = runCatching { ExportQuality.valueOf(intent.getStringExtra(X_QUALITY).orEmpty()) }
                .getOrDefault(ExportQuality.P1080)
            return ExportRequest(
                trip,
                ExportSettings(
                    quality = quality,
                    ambience = intent.getBooleanExtra(X_AMBIENCE, false),
                    shownNames = intent.getStringArrayListExtra(X_NAMES).orEmpty().toSet(),
                    includeOutsideMedia = intent.getBooleanExtra(X_OUTSIDE, false),
                ),
            )
        }
    }
}
