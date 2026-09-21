package com.beeboentertainment.movie.stories

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Process-wide, observable state for one BeeboBook co-writer run.
 *
 * A deliberate sibling of [StoryNarrationProgress] rather than a second user of it. The two runs
 * are independent and can overlap - a parent can be voicing one book while the computer writes
 * another - and a single holder can only describe one of them at a time. The fields differ too: a
 * narration run is counted in pages of a book that already exists, while a writing run has no page
 * count and no slug at all until the moment it succeeds. Everything else follows the same rules:
 * the service is the sole writer, the screen is a reader, and it lives on the process so leaving
 * Story Mode (or the app) cannot lose the run.
 *
 * The DURABLE record of a written book is the computer's own shelf, read back over
 * /api/storybooks. This holder is only the live view of the current run.
 */
object StoryCowriterProgress {

    /**
     * @property running    true while the phone is waiting on the computer's story writer.
     * @property title      what to call this story on screen and in the notification.
     * @property message    user-safe status line, including how long it has been going.
     * @property error      user-safe failure from the last run, sticky until the next run starts.
     * @property readySlug  the finished book's slug, or null. Set once, and cleared by the screen
     *                      when the reader has been offered it, so one book is not offered twice.
     */
    data class State(
        val running: Boolean = false,
        val title: String = "",
        val message: String? = null,
        val error: String? = null,
        val readySlug: String? = null,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    val isRunning: Boolean get() = _state.value.running

    /** A fresh run begins. Clears the previous outcome so stale text cannot linger. */
    fun begin(title: String) {
        _state.value = State(running = true, title = title,
            message = "Asking your computer to start writing...")
    }

    /** Progress tick from a poll. */
    fun update(message: String?) {
        _state.value = _state.value.copy(message = message)
    }

    /** A non-fatal note, for example that the ongoing notification could not be shown. */
    fun note(message: String?) {
        _state.value = _state.value.copy(message = message)
    }

    /** The book is written and on the computer's shelf. */
    fun finish(slug: String, title: String, message: String?) {
        _state.value = _state.value.copy(running = false, title = title, message = message,
            error = null, readySlug = slug)
    }

    /** The run stopped without a book. [error] is user-safe. */
    fun fail(error: String?) {
        _state.value = _state.value.copy(running = false, message = null, error = error)
    }

    /** The user asked to stop waiting. The computer may still finish on its own. */
    fun cancelled(message: String?) {
        _state.value = _state.value.copy(running = false, message = message)
    }

    /** The reader has been shown the finished book, so stop offering it. */
    fun clearReady() {
        _state.value = _state.value.copy(readySlug = null)
    }
}
