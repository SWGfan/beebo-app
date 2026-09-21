package com.beeboentertainment.movie.stories

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Process-wide, observable state for one BeeboBook narration run.
 *
 * Mirrors [com.beeboentertainment.movie.spacesaver.SpaceSaverProgress]: the service is the sole
 * writer and the Compose screen is a reader. Because it lives on the process rather than on the
 * screen's coroutine scope, leaving Story Mode (or the app) does not lose the run, and reopening
 * the book immediately shows whatever the service is doing.
 *
 * The DURABLE record of "this book already has narration" is the home computer itself, asked over
 * /api/storybook-render with probe=true. This holder is only the live view of the current run.
 */
object StoryNarrationProgress {

    /**
     * @property running    true while the service is talking to the computer for this set.
     * @property slug       the book being prepared, or null when idle.
     * @property setHash    the computer's id for this name + voice combination, once known.
     * @property title      the book's display title, for the notification and the screen.
     * @property done       pages voiced so far.
     * @property total      pages in the book (0 until the computer reports it).
     * @property message    user-safe status line for the screen.
     * @property error      user-safe failure from the last run, sticky until the next run starts.
     * @property readySlug  book whose narration finished, or null.
     * @property readySet   setHash whose narration finished, or null.
     * @property pages      page id to relative media URL, for the finished set.
     */
    data class State(
        val running: Boolean = false,
        val slug: String? = null,
        val setHash: String? = null,
        val title: String = "",
        val done: Int = 0,
        val total: Int = 0,
        val message: String? = null,
        val error: String? = null,
        val readySlug: String? = null,
        val readySet: String? = null,
        val pages: Map<Int, String> = emptyMap(),
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    val isRunning: Boolean get() = _state.value.running

    /** Is a run in flight for exactly this book? Used to avoid starting a second one. */
    fun runningFor(slug: String?): Boolean {
        val s = _state.value
        return s.running && s.slug != null && s.slug == slug
    }

    /** A fresh run begins. Clears the previous outcome so stale text cannot linger. */
    fun begin(slug: String, title: String) {
        _state.value = State(running = true, slug = slug, title = title,
            message = "Asking your computer to prepare the voices...")
    }

    /** The computer answered with the id for this name + voice set. */
    fun setHash(hash: String) {
        _state.value = _state.value.copy(setHash = hash)
    }

    /** Progress tick from a poll. */
    fun update(done: Int, total: Int, message: String?) {
        _state.value = _state.value.copy(done = done, total = total, message = message)
    }

    /** A non-fatal note, for example that the ongoing notification could not be shown. */
    fun note(message: String?) {
        _state.value = _state.value.copy(message = message)
    }

    /** The narration is finished and playable. */
    fun finish(slug: String, hash: String, pages: Map<Int, String>, message: String?) {
        _state.value = _state.value.copy(running = false, setHash = hash, message = message,
            error = null, readySlug = slug, readySet = hash, pages = pages)
    }

    /** The run stopped without producing audio. [error] is user-safe. */
    fun fail(error: String?) {
        _state.value = _state.value.copy(running = false, message = null, error = error)
    }

    /** The user asked to stop waiting. The computer may still finish on its own. */
    fun cancelled(message: String?) {
        _state.value = _state.value.copy(running = false, message = message)
    }
}
