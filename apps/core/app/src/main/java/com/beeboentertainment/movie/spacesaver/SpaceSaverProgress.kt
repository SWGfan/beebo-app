package com.beeboentertainment.movie.spacesaver

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Process-wide, observable state for a Space Saver backup run.
 *
 * [SpaceSaverService] is the sole writer; the Compose screen is a reader. Because it lives on the
 * process (not on the Activity or on any coroutine scope), the UI shows live progress whether the
 * service is in the foreground with the screen up or grinding away in the background with the app
 * closed — and a freshly reopened screen immediately reflects whatever the running service is doing.
 *
 * Nothing here is persisted: the *durable* record of what has been backed up is [SpaceSaverStore]
 * (written file-by-file as each upload lands). This holder is only the live view of the current run.
 */
object SpaceSaverProgress {

    /**
     * @property running   true while the service is actively working (scan / check / upload).
     * @property done      files finished so far in the upload phase.
     * @property total     files to upload this run (0 until the check phase has narrowed the list).
     * @property currentName display name of the file being uploaded right now, if any.
     * @property lastError a user-safe error from the most recent run, or null. Sticky until the
     *                     next run starts, so the screen can show it after the service has gone.
     * @property lastMessage a user-safe summary from the most recent finished/cancelled run, or null.
     * @property paused    true while the run is alive but holding, waiting for an allowed network
     *                     (Wi-Fi) before it starts the next upload. [running] stays true meanwhile.
     * @property statusMessage the user-facing reason shown while [paused] (e.g. "Paused — waiting for Wi-Fi").
     */
    data class State(
        val running: Boolean = false,
        val done: Int = 0,
        val total: Int = 0,
        val currentName: String? = null,
        val lastError: String? = null,
        val lastMessage: String? = null,
        val paused: Boolean = false,
        val statusMessage: String? = null,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    val isRunning: Boolean get() = _state.value.running

    /** A fresh run begins: clear the previous outcome and mark us busy. */
    fun begin() {
        _state.value = State(running = true)
    }

    /** The upload count is known (after /check has removed files already on the server). */
    fun setTotal(total: Int) {
        _state.value = _state.value.copy(total = total)
    }

    /** Per-file progress tick. [done] is files completed; [currentName] the one in flight. */
    fun update(done: Int, total: Int, currentName: String?) {
        _state.value = _state.value.copy(
            done = done, total = total, currentName = currentName,
            paused = false, statusMessage = null,
        )
    }

    /**
     * The run is alive but holding for the network (e.g. Wi-Fi dropped to cell while "Wi-Fi only"
     * is on). Keeps [State.running] true so the screen still shows the run — with the paused message
     * and the "Use mobile data" escape hatch — instead of the normal per-file progress.
     */
    fun pauseForNetwork(message: String) {
        _state.value = _state.value.copy(
            paused = true,
            statusMessage = message,
            currentName = null,
        )
    }

    /** Leaving the paused state and going back to uploading. */
    fun resume() {
        _state.value = _state.value.copy(paused = false, statusMessage = null)
    }

    /** Run finished normally (or with per-file skips). [message] is the summary to surface. */
    fun finish(message: String?) {
        _state.value = _state.value.copy(
            running = false,
            paused = false,
            statusMessage = null,
            currentName = null,
            lastMessage = message,
            lastError = null,
        )
    }

    /** Run stopped by an error. [error] is user-safe; finished files stay marked in the store. */
    fun fail(error: String?) {
        _state.value = _state.value.copy(
            running = false,
            paused = false,
            statusMessage = null,
            currentName = null,
            lastError = error,
        )
    }

    /**
     * A non-fatal note about the current run (e.g. the foreground notification couldn't be shown).
     * Leaves [State.running] untouched so the run keeps going; only records a user-safe message.
     */
    fun note(message: String?) {
        _state.value = _state.value.copy(lastMessage = message)
    }

    /** Run cancelled by the user. Finished files stay marked. */
    fun cancelled(message: String?) {
        _state.value = _state.value.copy(
            running = false,
            paused = false,
            statusMessage = null,
            currentName = null,
            lastMessage = message,
        )
    }
}
