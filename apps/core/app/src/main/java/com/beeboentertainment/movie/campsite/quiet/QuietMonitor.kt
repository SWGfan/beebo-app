package com.beeboentertainment.movie.campsite.quiet

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.R
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * While Campsite is running, look at the clock every half minute: post the host a "quiet hours start
 * in 15 minutes" notification (once per window), count a night as kept, and forget the headphones
 * answer when the quiet period is over. All local; no network, no location.
 *
 * Started and stopped by [com.beeboentertainment.movie.campsite.CampsiteHost] with the guest server.
 * If notifications are switched off on the phone the heads-up is simply not shown (the Campsite
 * screen still says it), and nothing is asked of the host.
 */
internal object QuietMonitor {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var job: Job? = null

    @Synchronized
    fun start() {
        if (job?.isActive == true) return
        job = scope.launch {
            while (isActive) {
                runCatching {
                    val tick = QuietGate.runtime.tick(serverRunning = true)
                    tick.warnStartMs?.let { notifyWarning(it) }
                    QuietGate.runtime.view() // also clears a finished quiet period's headphones answer
                }
                delay(30_000)
            }
        }
    }

    @Synchronized
    fun stop() {
        job?.cancel()
        job = null
    }

    private fun notifyWarning(startMs: Long) {
        val context: Context = BeeboApp.instance
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        if (!manager.areNotificationsEnabled()) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager.getNotificationChannel(CHANNEL) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL, "Quiet hours", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "A heads-up before your Campsite quiet hours begin."
                },
            )
        }
        val settings = QuietGate.runtime.store.settings()
        val note = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Quiet hours start in 15 minutes")
            .setContentText("From ${QuietHours.clockText(settings.startMinute)}. Check your campground's posted quiet hours.")
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setTimeoutAfter(20 * 60_000L)
            .build()
        runCatching { manager.notify(NOTIF_ID, note) }
    }

    private const val CHANNEL = "campsite-quiet"
    private const val NOTIF_ID = 4713
}
