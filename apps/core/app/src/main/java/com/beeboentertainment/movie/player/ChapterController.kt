package com.beeboentertainment.movie.player

import android.app.AlertDialog
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.PlayerControlView
import androidx.media3.ui.PlayerView
import com.beeboentertainment.movie.R

/**
 * Chapters of the file on screen: tick marks on the time bar, a list to jump from, and the
 * next / previous chapter buttons and keys. Everything stays hidden until the computer has sent
 * two or more chapters, so a file without them (or an older server) looks exactly as before.
 */
@UnstableApi
class ChapterController(
    private val activity: AppCompatActivity,
    private val player: () -> Player?
) {
    var navigator = ChapterNavigator(emptyList())
        private set

    val hasChapters: Boolean get() = navigator.hasChapters

    private val previousButton: View? = activity.findViewById(R.id.chapterPrevButton)
    private val nextButton: View? = activity.findViewById(R.id.chapterNextButton)
    private val listButton: View? = activity.findViewById(R.id.chaptersButton)

    init {
        previousButton?.setOnClickListener { previous() }
        nextButton?.setOnClickListener { next() }
        listButton?.setOnClickListener { showList() }
        render()
    }

    fun set(chapters: List<Chapter>) {
        navigator = ChapterNavigator(chapters)
        render()
    }

    fun clear() = set(emptyList())

    /** Seeks to the next chapter. False when there is none, so the caller can use its own "next" (the next episode). */
    fun next(): Boolean {
        val p = player() ?: return false
        val target = navigator.nextStartMs(p.currentPosition) ?: return false
        p.seekTo(target)
        return true
    }

    /** Restarts the chapter if more than a few seconds into it, else the one before. False when neither applies. */
    fun previous(): Boolean {
        val p = player() ?: return false
        val target = navigator.previousStartMs(p.currentPosition) ?: return false
        p.seekTo(target)
        return true
    }

    fun showList() {
        val p = player() ?: return
        if (!hasChapters || activity.isFinishing || activity.isDestroyed) return
        val chapters = navigator.chapters
        val rows = chapters.map { ChapterNavigator.rowText(it) }.toTypedArray<CharSequence>()
        AlertDialog.Builder(activity)
            .setTitle("Chapters")
            .setSingleChoiceItems(rows, navigator.indexAt(p.currentPosition)) { dialog, which ->
                dialog.dismiss()
                chapters.getOrNull(which)?.let { player()?.seekTo(it.startMs) }
            }
            .setNegativeButton("Close", null)
            .show()
            .also { d -> d.listView?.let { lv -> lv.post { lv.setSelection(navigator.indexAt(p.currentPosition).coerceAtLeast(0)) } } }
    }

    private fun render() {
        val visibility = if (hasChapters) View.VISIBLE else View.GONE
        previousButton?.visibility = visibility
        nextButton?.visibility = visibility
        listButton?.visibility = visibility
        val controls = activity.findViewById<PlayerView>(R.id.playerView)
            ?.findViewById<PlayerControlView>(androidx.media3.ui.R.id.exo_controller) ?: return
        if (!hasChapters) {
            controls.setExtraAdGroupMarkers(null, null)
            return
        }
        // A tick at the very start says nothing; the rest mark where each chapter begins.
        val starts = navigator.chapters.map { it.startMs }.filter { it >= MIN_MARK_MS }.toLongArray()
        controls.setExtraAdGroupMarkers(starts, BooleanArray(starts.size))
    }

    private companion object {
        const val MIN_MARK_MS = 1_000L
    }
}
