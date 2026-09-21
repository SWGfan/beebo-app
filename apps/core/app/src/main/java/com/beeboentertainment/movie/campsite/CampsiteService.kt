package com.beeboentertainment.movie.campsite

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.beeboentertainment.movie.R

/**
 * Keeps the [CampsiteServer] alive while guests are watching, even with the
 * host's screen off, via an ongoing foreground notification. Serving files to
 * guests on the local network is a data-sync-style job, so it declares that FGS
 * type (Android 10+).
 */
class CampsiteService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                CampsiteHost.stopServer()
                stopForegroundCompat()
                stopSelf()
                return START_NOT_STICKY
            }
            else -> {
                ensureChannel()
                startForegroundCompat()
                CampsiteHost.startServer()
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        CampsiteHost.stopServer()
        super.onDestroy()
    }


    /**
     * The service is `connectedDevice` now (guests' phones on this phone's Wi-Fi), which has no
     * daily budget, so the system shouldn't call this. Kept as a safety net for any type that
     * does time out. The history: Android 15+ gives every app a shared 6-hour daily budget for `dataSync` foreground
     * services. When it runs out the system calls this, and if we are still foreground a
     * few seconds later it kills the process with
     * `RemoteServiceException: a foreground service of type dataSync did not stop within
     * its timeout`. So: stop now, tell the user plainly, and let them restart it.
     *
     * The budget resets once the app is brought to the foreground again, which is exactly
     * what the notification asks them to do.
     */
    override fun onTimeout(startId: Int, fgsType: Int) {
        // Guests lose the stream here, so say so rather than just vanishing. stopSelf() also
        // cancels the START_STICKY restart, which would otherwise be refused by the system
        // with ForegroundServiceStartNotAllowedException the moment it tried to come back.
        CampsiteHost.stopServer()
        stopForegroundCompat()
        runCatching {
            val n = NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("Campsite Mode stopped")
                .setContentText("Android limits this to 6 hours a day. Open Beebo to switch it back on.")
                .setStyle(NotificationCompat.BigTextStyle().bigText(
                    "Android limits this kind of background sharing to 6 hours a day, and today's is " +
                        "used up. Guests can't watch until you open Beebo and switch Campsite Mode on again."
                ))
                .setAutoCancel(true)
                .setOngoing(false)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build()
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .notify(TIMEOUT_ID, n)
        }
        stopSelf()
    }

    private fun startForegroundCompat() {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        } else {
            startForeground(NOTIF_ID, notification)
        }
    }

    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
    }

    private fun buildNotification(): Notification {
        val stopIntent = Intent(this, CampsiteService::class.java).setAction(ACTION_STOP)
        val stopPending = android.app.PendingIntent.getService(
            this, 1, stopIntent,
            android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Campsite Mode is on")
            .setContentText("Guests near your phone can scan the code and watch.")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .addAction(0, "Stop", stopPending)
            .build()
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (mgr.getNotificationChannel(CHANNEL_ID) == null) {
                val ch = NotificationChannel(CHANNEL_ID, "Campsite Mode", NotificationManager.IMPORTANCE_LOW)
                ch.description = "Shown while your phone is streaming to nearby guests."
                mgr.createNotificationChannel(ch)
            }
        }
    }

    companion object {
        const val ACTION_START = "com.beeboentertainment.movie.campsite.START"
        const val ACTION_STOP = "com.beeboentertainment.movie.campsite.STOP"
        private const val CHANNEL_ID = "campsite"
        private const val NOTIF_ID = 4711

        /** Shown when Android's daily foreground-service budget ends the session. */
        private const val TIMEOUT_ID = 4712
    }
}
