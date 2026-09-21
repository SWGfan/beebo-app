package com.beeboentertainment.movie.stories

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
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import kotlin.coroutines.coroutineContext

/**
 * Foreground service that prepares one BeeboBook's computer narration.
 *
 * Why a service at all: the voice worker runs on the home PC, so generation was never tied to the
 * phone screen. What WAS tied to the screen was the waiting - the poll loop lived in the story
 * screen's coroutine scope, so leaving Story Mode dropped the page URLs on the floor and the
 * finished narration stayed invisible. Moving the wait here keeps the result, drives an ongoing
 * notification, and posts a "ready" notification that opens straight back into the book.
 *
 * Mirrors [com.beeboentertainment.movie.spacesaver.SpaceSaverService]: dataSync foreground type,
 * promoted in onStartCommand, work on an IO scope, stops itself when the run ends. It is always
 * started from a button tap, the user-initiated origin Android 14 requires for dataSync.
 */
class StoryNarrationService : Service() {

    companion object {
        const val ACTION_START = "com.beeboentertainment.movie.STORY_NARRATION_START"
        const val ACTION_CANCEL = "com.beeboentertainment.movie.STORY_NARRATION_CANCEL"

        const val EXTRA_SLUG = "story_slug"
        const val EXTRA_TITLE = "story_title"
        const val EXTRA_NAMES = "story_names"
        const val EXTRA_NARRATOR = "story_narrator"
        const val EXTRA_CHARACTER_VOICES = "story_character_voices"

        const val CHANNEL_ID = "story_narration"
        private const val FOREGROUND_ID = 5220
        private const val DONE_ID = 5221

        /** A generous ten-minute ceiling on one book. */
        private const val MAX_WAIT_MS = 10 * 60 * 1000L

        /**
         * Gaps between status polls, in order; the last one repeats. The gap drops back to the
         * start whenever the page count moves, so steady progress is followed closely while a
         * stalled or slow stretch only costs one request per 30 s. Battery: this is a foreground
         * service, so no wake lock is needed for the wait - the radio and CPU can idle between polls.
         */
        private val POLL_BACKOFF_MS = longArrayOf(5_000L, 5_000L, 5_000L, 10_000L, 15_000L, 30_000L)

        private fun encode(map: Map<String, String>): String =
            JsonObject(map.mapValues { JsonPrimitive(it.value) }).toString()

        private fun decode(raw: String?): Map<String, String> = runCatching {
            if (raw.isNullOrBlank()) emptyMap()
            else Json.parseToJsonElement(raw).let { element ->
                (element as? JsonObject).orEmpty().mapValues { it.value.jsonPrimitive.content }
            }
        }.getOrDefault(emptyMap())

        /** Begin preparing this book's narration. Safe to call again; a second run is ignored. */
        fun start(
            context: Context, slug: String, title: String, names: Map<String, String>,
            narrator: String, characterVoices: Map<String, String>,
        ) {
            val i = Intent(context, StoryNarrationService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_SLUG, slug)
                putExtra(EXTRA_TITLE, title)
                putExtra(EXTRA_NAMES, encode(names))
                putExtra(EXTRA_NARRATOR, narrator)
                putExtra(EXTRA_CHARACTER_VOICES, encode(characterVoices))
            }
            ContextCompat.startForegroundService(context, i)
        }

        /** Stop waiting on this phone. The computer finishes on its own and keeps the audio. */
        fun stop(context: Context) {
            val i = Intent(context, StoryNarrationService::class.java).apply { action = ACTION_CANCEL }
            ContextCompat.startForegroundService(context, i)
        }
    }

    private val job = SupervisorJob()

    private val exceptionHandler = CoroutineExceptionHandler { _, t ->
        if (t !is CancellationException) {
            runCatching { StoryNarrationProgress.fail(t.message ?: "The computer voices are unavailable.") }
        }
        runCatching { worker = null }
        runCatching { stopForegroundCompat() }
        runCatching { stopSelf() }
    }

    private val scope = CoroutineScope(Dispatchers.IO + job + exceptionHandler)

    @Volatile
    private var worker: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return try {
            val title = intent?.getStringExtra(EXTRA_TITLE).orEmpty().ifBlank { "your story" }
            val promoted = startForegroundCompat(
                buildProgressNotification("Preparing the voices for $title", null, 0, indeterminate = true, slug = intent?.getStringExtra(EXTRA_SLUG))
            )
            if (!promoted) runCatching { stopForegroundCompat() }

            if (intent?.action == ACTION_CANCEL) {
                worker?.cancel()
                if (worker == null) {
                    stopForegroundCompat()
                    stopSelf()
                }
            } else {
                val slug = intent?.getStringExtra(EXTRA_SLUG).orEmpty()
                if (slug.isBlank()) {
                    stopForegroundCompat()
                    stopSelf()
                } else {
                    runPreparation(
                        slug = slug,
                        title = title,
                        names = decode(intent?.getStringExtra(EXTRA_NAMES)),
                        narrator = intent?.getStringExtra(EXTRA_NARRATOR).orEmpty().ifBlank { "af_heart" },
                        characterVoices = decode(intent?.getStringExtra(EXTRA_CHARACTER_VOICES)),
                        foregroundOk = promoted,
                    )
                }
            }
            START_NOT_STICKY
        } catch (t: Throwable) {
            runCatching { StoryNarrationProgress.fail(t.message ?: "The story voices could not be started.") }
            runCatching { stopForegroundCompat() }
            runCatching { stopSelf() }
            START_NOT_STICKY
        }
    }

    private fun runPreparation(
        slug: String, title: String, names: Map<String, String>,
        narrator: String, characterVoices: Map<String, String>, foregroundOk: Boolean,
    ) {
        if (worker?.isActive == true) return
        worker = scope.launch {
            StoryNarrationProgress.begin(slug, title)
            if (!foregroundOk) {
                StoryNarrationProgress.note(
                    "Preparing in the background. Turn on notifications for Beebo to be told when it is ready."
                )
            }
            try {
                val client = StoryBookClient()
                val set = client.start(slug, names, narrator, characterVoices)
                StoryNarrationProgress.setHash(set.setHash)
                val startedAt = System.currentTimeMillis()
                var polls = 0
                var step = 0
                var lastProgress: Pair<Int, Int>? = null
                while (System.currentTimeMillis() - startedAt < MAX_WAIT_MS) {
                    coroutineContext.ensureActive()
                    val result = client.audio(slug, set.setHash)
                    val progress = result.done to result.total
                    if (progress != lastProgress) {
                        lastProgress = progress
                        step = 0
                    }
                    when (result.status) {
                        "ready" -> {
                            val message = "The voices for $title are ready to play."
                            StoryNarrationProgress.finish(slug, set.setHash, result.pages, message)
                            notifyDone(slug, title, message)
                            return@launch
                        }
                        "error", "unavailable" -> {
                            val message = "The computer voice is unavailable. Check the story voice setup on your PC, or choose a phone voice."
                            StoryNarrationProgress.fail(message)
                            notifyDone(slug, title, message)
                            return@launch
                        }
                        "missing" -> {
                            // The computer has not created the set yet. Ask once more, which also
                            // restarts a worker that died before it wrote its first page.
                            if (polls > 2) {
                                runCatching { client.start(slug, names, narrator, characterVoices) }
                            }
                        }
                    }
                    val total = if (result.total > 0) result.total.toString() else "?"
                    StoryNarrationProgress.update(result.done, result.total,
                        "Preparing voices on your computer: ${result.done} of $total pages.")
                    notifyProgress(slug, title, result.done, result.total)
                    polls++
                    delay(POLL_BACKOFF_MS[minOf(step, POLL_BACKOFF_MS.size - 1)])
                    step++
                }
                val message = "Your computer is still preparing $title. Open the story again shortly."
                StoryNarrationProgress.fail(message)
                notifyDone(slug, title, message)
            } catch (ce: CancellationException) {
                StoryNarrationProgress.cancelled("Stopped waiting on this phone. Your computer keeps going and saves the voices.")
                throw ce
            } catch (t: Throwable) {
                StoryNarrationProgress.fail(t.message ?: "The computer voices are unavailable.")
            } finally {
                worker = null
                stopForegroundCompat()
                stopSelf()
            }
        }
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, "Story voices", NotificationManager.IMPORTANCE_DEFAULT)
                        .apply { description = "Preparing storybook narration on your computer" }
                )
            }
        }
    }

    /** Tapping the notification opens Story Mode on this book. */
    private fun contentIntent(slug: String?): PendingIntent {
        val i = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            if (!slug.isNullOrBlank()) putExtra(MainActivity.EXTRA_OPEN_STORY, slug)
        }
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        else PendingIntent.FLAG_UPDATE_CURRENT
        // The slug is part of the request code so two books do not share one PendingIntent.
        return PendingIntent.getActivity(this, 41 + (slug?.hashCode() ?: 0).and(0xffff), i, flags)
    }

    private fun cancelIntent(): PendingIntent {
        val intent = Intent(this, StoryNarrationService::class.java).apply { action = ACTION_CANCEL }
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        else PendingIntent.FLAG_UPDATE_CURRENT
        return PendingIntent.getService(this, 42, intent, flags)
    }

    private fun buildProgressNotification(
        title: String, text: String?, progress: Int, indeterminate: Boolean, slug: String?,
    ): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_download)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(contentIntent(slug))
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .apply {
                if (indeterminate) setProgress(0, 0, true)
                else setProgress(100, progress.coerceIn(0, 100), false)
            }
            .addAction(R.drawable.ic_stat_stop, "Stop waiting", cancelIntent())
            .build()

    private fun notifyProgress(slug: String, title: String, done: Int, total: Int) {
        val pct = if (total > 0) (done * 100 / total) else 0
        val heading = if (total > 0) "Preparing $title - $done of $total pages" else "Preparing $title"
        val n = buildProgressNotification(heading, "Keep your computer on until this finishes.", pct,
            indeterminate = total <= 0, slug = slug)
        runCatching {
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(FOREGROUND_ID, n)
        }
    }

    /** The one the owner asked for: a tap opens the app straight on this book. */
    private fun notifyDone(slug: String, title: String, text: String) {
        val n = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_download)
            .setContentTitle("Story voices ready")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .setOngoing(false)
            .setContentIntent(contentIntent(slug))
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()
        runCatching {
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(DONE_ID, n)
        }
    }

    /**
     * Android 15+ budgets dataSync foreground services. Stop cleanly rather than being killed.
     * The computer keeps the audio it has made, so reopening the book picks it up.
     */
    override fun onTimeout(startId: Int, fgsType: Int) {
        runCatching { worker?.cancel() }
        runCatching { worker = null }
        runCatching {
            StoryNarrationProgress.cancelled("Paused by Android. Open Beebo and the story again to pick up the voices.")
        }
        stopForegroundCompat()
        stopSelf()
    }

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
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(Service.STOP_FOREGROUND_REMOVE)
            else stopForeground(true)
        }
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }
}
