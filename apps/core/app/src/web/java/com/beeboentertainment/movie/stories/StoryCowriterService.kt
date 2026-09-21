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
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import kotlin.coroutines.coroutineContext

/**
 * Foreground service that has the home computer write one new storybook.
 *
 * Built to the same plan as [StoryNarrationService], for the same reason: the work happens on the
 * PC, but the WAITING used to belong to whichever screen started it. A local language model
 * drafting a whole book is minutes of work, far longer than voicing one, and a parent will put the
 * phone in a pocket long before it finishes. Keeping the wait here means the story survives
 * leaving Story Mode, the ongoing notification says what is happening, and the finished book
 * announces itself with a notification that opens straight onto it.
 *
 * It is a separate service from narration rather than a second action on it because the two can
 * legitimately run at once, and one worker slot cannot hold both.
 */
class StoryCowriterService : Service() {

    companion object {
        const val ACTION_START = "com.beeboentertainment.movie.STORY_COWRITER_START"
        const val ACTION_CANCEL = "com.beeboentertainment.movie.STORY_COWRITER_CANCEL"

        const val EXTRA_TITLE = "cowriter_title"
        const val EXTRA_PROMPT = "cowriter_prompt"
        const val EXTRA_CHARACTERS = "cowriter_characters"

        const val CHANNEL_ID = "story_cowriter"
        private const val FOREGROUND_ID = 5230
        private const val DONE_ID = 5231

        /** Twenty-five minute ceiling on one book. */
        private const val MAX_WAIT_MS = 25 * 60 * 1000L

        /**
         * Gaps between status polls, in order; the last one repeats. The gap drops back to the
         * start whenever the computer reports a new stage, so a fresh stage is noticed quickly
         * while a long quiet stretch (a local model drafting) only costs one request per 30 s.
         * Battery: this is a foreground service, so no wake lock is needed for the wait - the
         * radio and CPU can idle between polls.
         */
        private val POLL_BACKOFF_MS = longArrayOf(5_000L, 5_000L, 5_000L, 10_000L, 15_000L, 30_000L)

        private fun encode(characters: List<Pair<String, String>>): String =
            JsonArray(characters.map { (name, what) ->
                JsonObject(mapOf("name" to JsonPrimitive(name), "what" to JsonPrimitive(what)))
            }).toString()

        private fun decode(raw: String?): List<Pair<String, String>> = runCatching {
            if (raw.isNullOrBlank()) emptyList()
            else (Json.parseToJsonElement(raw) as? JsonArray).orEmpty().mapNotNull { element ->
                val row = element as? JsonObject ?: return@mapNotNull null
                val name = row["name"]?.jsonPrimitive?.content.orEmpty()
                if (name.isBlank()) null else name to row["what"]?.jsonPrimitive?.content.orEmpty()
            }
        }.getOrDefault(emptyList())

        /** Begin writing. Safe to call again; a second run while one is in flight is ignored. */
        fun start(context: Context, title: String, prompt: String, characters: List<Pair<String, String>>) {
            val i = Intent(context, StoryCowriterService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_TITLE, title)
                putExtra(EXTRA_PROMPT, prompt)
                putExtra(EXTRA_CHARACTERS, encode(characters))
            }
            ContextCompat.startForegroundService(context, i)
        }

        /** Stop waiting on this phone. The computer finishes and keeps the book either way. */
        fun stop(context: Context) {
            val i = Intent(context, StoryCowriterService::class.java).apply { action = ACTION_CANCEL }
            ContextCompat.startForegroundService(context, i)
        }
    }

    private val job = SupervisorJob()

    private val exceptionHandler = CoroutineExceptionHandler { _, t ->
        if (t !is CancellationException) {
            runCatching { StoryCowriterProgress.fail(t.message ?: "Your computer could not write the story.") }
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
            val title = intent?.getStringExtra(EXTRA_TITLE).orEmpty().trim()
            val label = title.ifBlank { "your new story" }
            val promoted = startForegroundCompat(
                buildProgressNotification("Writing $label", null, indeterminate = true, slug = null)
            )
            if (!promoted) runCatching { stopForegroundCompat() }

            if (intent?.action == ACTION_CANCEL) {
                worker?.cancel()
                if (worker == null) {
                    stopForegroundCompat()
                    stopSelf()
                }
            } else {
                val prompt = intent?.getStringExtra(EXTRA_PROMPT).orEmpty().trim()
                val characters = decode(intent?.getStringExtra(EXTRA_CHARACTERS))
                // The computer refuses both of these anyway; saying so here costs no round trip.
                if (prompt.isBlank() || characters.isEmpty()) {
                    StoryCowriterProgress.fail("Tell the story writer what the story is about, and name at least one character.")
                    stopForegroundCompat()
                    stopSelf()
                } else {
                    runWriting(label, title, prompt, characters, promoted)
                }
            }
            START_NOT_STICKY
        } catch (t: Throwable) {
            runCatching { StoryCowriterProgress.fail(t.message ?: "The story writer could not be started.") }
            runCatching { stopForegroundCompat() }
            runCatching { stopSelf() }
            START_NOT_STICKY
        }
    }

    private fun runWriting(
        label: String, title: String, prompt: String,
        characters: List<Pair<String, String>>, foregroundOk: Boolean,
    ) {
        if (worker?.isActive == true) return
        worker = scope.launch {
            StoryCowriterProgress.begin(label)
            if (!foregroundOk) {
                StoryCowriterProgress.note(
                    "Writing in the background. Turn on notifications for Beebo to be told when it is ready."
                )
            }
            fun stopWith(message: String) {
                StoryCowriterProgress.fail(message)
                notifyOutcome("The story writer stopped", message, null)
            }
            val startedAt = System.currentTimeMillis()
            try {
                val client = StoryBookClient()
                val jobId = client.cowriteStart(title, prompt, characters)
                var step = 0
                var lastProgress: String? = null
                while (System.currentTimeMillis() - startedAt < MAX_WAIT_MS) {
                    coroutineContext.ensureActive()
                    // Ask after the wait, never before it: the computer has only just been handed
                    // the job and the first answer would say nothing the screen does not already say.
                    delay(POLL_BACKOFF_MS[minOf(step, POLL_BACKOFF_MS.size - 1)])
                    step++
                    val state = client.cowriteStatus(jobId)
                    if (state.progress != lastProgress) {
                        lastProgress = state.progress
                        step = 0
                    }
                    when (state.status) {
                        "done" -> {
                            val slug = state.slug
                            if (slug.isNullOrBlank()) {
                                stopWith("Your computer wrote a story but could not save it. Please try again.")
                                return@launch
                            }
                            // Fetch it now, while the computer is still to hand, so the notification
                            // opens a book that is already on the phone and reads offline later.
                            val saved = runCatching { StoryShelf.cacheBook(applicationContext, slug) }.isSuccess
                            val message = if (saved) "$label is written and ready to read."
                                else "$label is written. Open it while your computer is connected."
                            StoryCowriterProgress.finish(slug, label, message)
                            notifyOutcome("Your story is ready", message, slug)
                            return@launch
                        }
                        "unavailable" -> {
                            stopWith("Your computer's story writer is not set up yet. Install Ollama on the computer, download a model, then try again.")
                            return@launch
                        }
                        "error" -> {
                            stopWith(state.error ?: "The story writer had trouble. Please try again.")
                            return@launch
                        }
                    }
                    val minutes = ((System.currentTimeMillis() - startedAt) / 60000L).toInt()
                    val note = state.progress ?: "Your computer is writing the story."
                    // Elapsed minutes are the only honest progress there is: the computer reports
                    // three coarse stages and a local model gives no percentage of a book.
                    val line = if (minutes >= 1) "$note ($minutes min so far)" else note
                    StoryCowriterProgress.update(line)
                    notifyProgress(label, line)
                }
                stopWith("Your computer is taking a very long time over $label. It may still finish - look on the story shelf shortly.")
            } catch (ce: CancellationException) {
                StoryCowriterProgress.cancelled("Stopped waiting on this phone. Your computer keeps writing and saves the story when it is done.")
                throw ce
            } catch (t: Throwable) {
                stopWith(t.message ?: "Your computer could not write the story.")
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
                    NotificationChannel(CHANNEL_ID, "New stories", NotificationManager.IMPORTANCE_DEFAULT)
                        .apply { description = "Writing a new storybook on your computer" }
                )
            }
        }
    }

    /** Tapping the notification opens Story Mode, on the finished book when there is one. */
    private fun contentIntent(slug: String?): PendingIntent {
        val i = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            if (!slug.isNullOrBlank()) putExtra(MainActivity.EXTRA_OPEN_STORY, slug)
        }
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        else PendingIntent.FLAG_UPDATE_CURRENT
        return PendingIntent.getActivity(this, 44 + (slug?.hashCode() ?: 0).and(0xffff), i, flags)
    }

    private fun cancelIntent(): PendingIntent {
        val intent = Intent(this, StoryCowriterService::class.java).apply { action = ACTION_CANCEL }
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        else PendingIntent.FLAG_UPDATE_CURRENT
        return PendingIntent.getService(this, 43, intent, flags)
    }

    private fun buildProgressNotification(
        title: String, text: String?, indeterminate: Boolean, slug: String?,
    ): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_download)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(contentIntent(slug))
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setProgress(0, 0, indeterminate)
            .addAction(R.drawable.ic_stat_stop, "Stop waiting", cancelIntent())
            .build()

    private fun notifyProgress(title: String, line: String) {
        val n = buildProgressNotification("Writing $title", line, indeterminate = true, slug = null)
        runCatching {
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(FOREGROUND_ID, n)
        }
    }

    private fun notifyOutcome(heading: String, text: String, slug: String?) {
        val n = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_download)
            .setContentTitle(heading)
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
     * The computer keeps writing and keeps the book, so the shelf picks it up later.
     */
    override fun onTimeout(startId: Int, fgsType: Int) {
        runCatching { worker?.cancel() }
        runCatching { worker = null }
        runCatching {
            StoryCowriterProgress.cancelled("Paused by Android. Your computer keeps writing - open the story shelf later to find the book.")
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
