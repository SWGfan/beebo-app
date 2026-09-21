package com.beeboentertainment.movie.player

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.TypedValue
import android.view.View
import android.widget.ImageView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.PlayerView
import androidx.media3.ui.TimeBar
import com.beeboentertainment.movie.R
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The picture, time and chapter name shown above the seek bar while the viewer scrubs it (finger
 * or D-pad: both reach the same [TimeBar.OnScrubListener]). It never touches the player, does no
 * work on the UI thread beyond setting a bitmap, and is a no-op when the computer offers no
 * previews and the file has no chapters.
 */
@UnstableApi
class ScrubPreviewController(
    private val activity: AppCompatActivity,
    private val api: PlaybackExtrasApi,
    private val isTv: Boolean,
    private val chapters: () -> ChapterNavigator,
    private val durationMs: () -> Long
) : TimeBar.OnScrubListener {

    private val panel: View? = activity.findViewById(R.id.scrubPreview)
    private val image: ImageView? = activity.findViewById(R.id.scrubThumb)
    private val timeText: TextView? = activity.findViewById(R.id.scrubTime)
    private val chapterText: TextView? = activity.findViewById(R.id.scrubChapter)
    private val timeBar: TimeBar? = activity.findViewById<PlayerView>(R.id.playerView)
        ?.findViewById<View>(androidx.media3.ui.R.id.exo_progress) as? TimeBar

    private var kind = ""
    private var id = ""
    private var info: TrickplayInfo? = null
    private var infoJob: Job? = null
    private var fetchJob: Job? = null
    private val cache = FrameCache<Bitmap>()
    private val refreshThrottle = Throttle(REFRESH_MIN_INTERVAL_MS)
    private var wantedIndex = -1
    private var shownIndex = -1
    private var scrubbing = false

    init {
        val widthDp = if (isTv) 240 else 176
        image?.layoutParams = image?.layoutParams?.apply { width = dp(widthDp) }
        timeBar?.addListener(this)
    }

    /** A new file: forget the old strip and ask the computer for this one's. */
    fun start(kind: String, id: String) {
        reset()
        this.kind = kind
        this.id = id
        infoJob = activity.lifecycleScope.launch { loadInfo() }
    }

    fun reset() {
        infoJob?.cancel()
        fetchJob?.cancel()
        info = null
        cache.clear()
        wantedIndex = -1
        shownIndex = -1
        hide()
    }

    private suspend fun loadInfo() {
        var attempt = 0
        while (true) {
            val i = api.trickplayInfo(kind, id)
            info = i
            if (i == null || !i.shouldPoll) return
            delay(TrickplayPoll.delayMs(attempt++) ?: return)
        }
    }

    override fun onScrubStart(timeBar: TimeBar, position: Long) {
        scrubbing = true
        show(position)
    }

    override fun onScrubMove(timeBar: TimeBar, position: Long) {
        if (scrubbing) show(position)
    }

    override fun onScrubStop(timeBar: TimeBar, position: Long, canceled: Boolean) {
        scrubbing = false
        fetchJob?.cancel()
        hide()
    }

    private fun hide() {
        panel?.visibility = View.GONE
    }

    private fun show(positionMs: Long) {
        val panel = panel ?: return
        val strip = info?.takeIf { it.usable }
        val nav = chapters()
        if (strip == null && !nav.hasChapters) return

        timeText?.text = ChapterNavigator.formatTime(positionMs / 1000.0)
        val chapter = nav.chapterAt(positionMs)
        chapterText?.apply {
            text = chapter?.label.orEmpty()
            visibility = if (chapter != null) View.VISIBLE else View.GONE
        }
        if (strip != null) {
            val index = strip.frameIndex(positionMs)
            wantedIndex = index
            if (index != shownIndex) {
                val cached = cache[index]
                if (cached != null) showBitmap(index, cached) else fetch(strip, index)
            }
        } else {
            image?.visibility = View.GONE
        }
        panel.visibility = View.VISIBLE
        place(panel, positionMs)
    }

    private fun showBitmap(index: Int, bitmap: Bitmap) {
        image?.setImageBitmap(bitmap)
        image?.visibility = View.VISIBLE
        shownIndex = index
    }

    private fun fetch(strip: TrickplayInfo, index: Int) {
        fetchJob?.cancel()
        fetchJob = activity.lifecycleScope.launch {
            try {
                delay(DEBOUNCE_MS)
                var result = strip.frameUrl(api.baseUrlNow(), index)?.let { api.frame(it) } ?: return@launch
                if (result is FrameResult.Expired && refreshThrottle.tryAcquire()) {
                    // The media token in the address ran out during a long sitting.
                    val fresh = api.trickplayInfo(kind, id)
                    if (fresh != null) {
                        info = fresh
                        result = fresh.frameUrl(api.baseUrlNow(), index)?.let { api.frame(it) } ?: return@launch
                    }
                }
                val bytes = (result as? FrameResult.Image)?.bytes ?: return@launch
                val bitmap = withContext(Dispatchers.Default) { BitmapFactory.decodeByteArray(bytes, 0, bytes.size) } ?: return@launch
                cache[index] = bitmap
                if (scrubbing && wantedIndex == index) showBitmap(index, bitmap)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // A picture that will not load simply is not shown.
            }
        }
    }

    /** Above the seek bar, centred on the scrub point and kept on screen. */
    private fun place(panel: View, positionMs: Long) {
        val bar = timeBar as? View ?: return
        val root = activity.findViewById<View>(R.id.root) ?: return
        val duration = durationMs().takeIf { it > 0 } ?: return
        panel.measure(
            View.MeasureSpec.makeMeasureSpec(root.width, View.MeasureSpec.AT_MOST),
            View.MeasureSpec.makeMeasureSpec(root.height, View.MeasureSpec.AT_MOST)
        )
        val barAt = IntArray(2).also { bar.getLocationInWindow(it) }
        val rootAt = IntArray(2).also { root.getLocationInWindow(it) }
        val fraction = (positionMs.toFloat() / duration).coerceIn(0f, 1f)
        val centre = barAt[0] - rootAt[0] + fraction * bar.width
        val margin = dp(8)
        val x = (centre - panel.measuredWidth / 2f).coerceIn(margin.toFloat(), (root.width - panel.measuredWidth - margin).coerceAtLeast(margin).toFloat())
        val y = (barAt[1] - rootAt[1] - panel.measuredHeight - margin).coerceAtLeast(margin)
        panel.translationX = x
        panel.translationY = y.toFloat()
    }

    private fun dp(v: Int): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), activity.resources.displayMetrics).toInt()

    private companion object {
        const val DEBOUNCE_MS = 60L
        const val REFRESH_MIN_INTERVAL_MS = 60_000L
    }
}
