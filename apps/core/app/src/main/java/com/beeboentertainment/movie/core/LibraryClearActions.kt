package com.beeboentertainment.movie.core

import com.beeboentertainment.movie.data.LibraryClearCounts
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** My Library's separate clear actions. Each only ever touches the signed-in person's own data. */
enum class LibraryClearKind(val wire: String, val label: String) {
    /** Sessions and resume points. Favourites, the watchlist and watched marks stay. */
    HISTORY("history", "Clear watch history"),
    FAVOURITES("favourites", "Clear favourites"),
    WATCHLIST("watchlist", "Clear watchlist"),
    /** Every watched tick. The watch history itself stays. */
    WATCHED("watched", "Clear watched marks");

    fun countIn(c: LibraryClearCounts): Int = when (this) {
        HISTORY -> c.history
        FAVOURITES -> c.favourites
        WATCHLIST -> c.watchlist
        WATCHED -> c.watched
    }
}

/**
 * The state behind the "Clear…" dialog, free of Android so it is tested on the JVM.
 *
 * Load counts -> pick an action -> a confirmation that says how much goes -> clear -> fresh
 * counts. A server from before these actions answers 404 to the counts: then only "Clear watch
 * history" is offered, through the old POST /api/history/clear, with no count to show.
 */
class LibraryClearModel(private val api: Api) {

    interface Api {
        /** Null when the server has no /api/library/clear (an older desktop). */
        suspend fun counts(): LibraryClearCounts?
        /** Returns how many went, and the counts afterwards (null if not sent). */
        suspend fun clear(kind: LibraryClearKind): Pair<Int, LibraryClearCounts?>
        /** The old whole-history route, for an older server. */
        suspend fun clearHistoryLegacy()
    }

    data class Action(val kind: LibraryClearKind, val label: String, val count: Int?, val enabled: Boolean)

    data class State(
        val loading: Boolean = false,
        val counts: LibraryClearCounts? = null,
        val legacyServer: Boolean = false,
        /** The action waiting for its confirmation. */
        val pending: LibraryClearKind? = null,
        val busy: Boolean = false,
        val message: String? = null
    ) {
        val actions: List<Action>
            get() = if (legacyServer) listOf(Action(LibraryClearKind.HISTORY, LibraryClearKind.HISTORY.label, null, !busy))
            else LibraryClearKind.values().map { kind ->
                val n = counts?.let { kind.countIn(it) }
                Action(kind, if (n == null) kind.label else "${kind.label} ($n)", n, !busy && n != null && n > 0)
            }

        val confirmMessage: String?
            get() = pending?.let { confirmationFor(it, if (legacyServer) null else counts?.let(it::countIn)) }
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    suspend fun load() {
        _state.value = _state.value.copy(loading = true, message = null)
        _state.value = try {
            val counts = api.counts()
            _state.value.copy(loading = false, counts = counts, legacyServer = counts == null)
        } catch (e: Exception) {
            _state.value.copy(loading = false, message = "Couldn't reach your server.")
        }
    }

    fun ask(kind: LibraryClearKind) {
        val s = _state.value
        if (s.busy) return
        if (s.legacyServer && kind != LibraryClearKind.HISTORY) return
        _state.value = s.copy(pending = kind, message = null)
    }

    fun cancel() {
        _state.value = _state.value.copy(pending = null)
    }

    /** Carry out the pending action. Returns what was cleared, or null when nothing happened. */
    suspend fun confirm(): LibraryClearKind? {
        val s = _state.value
        val kind = s.pending ?: return null
        _state.value = s.copy(pending = null, busy = true, message = null)
        return try {
            if (s.legacyServer) {
                api.clearHistoryLegacy()
                _state.value = _state.value.copy(busy = false, message = "Watch history cleared.")
            } else {
                val (removed, after) = api.clear(kind)
                _state.value = _state.value.copy(
                    busy = false,
                    counts = after ?: s.counts,
                    message = doneMessage(kind, removed)
                )
            }
            kind
        } catch (e: Exception) {
            _state.value = _state.value.copy(busy = false, message = "Couldn't reach your server, so nothing was cleared.")
            null
        }
    }

    companion object {
        private fun plural(n: Int, one: String, many: String) = if (n == 1) "1 $one" else "$n $many"

        /** The confirmation always says how much goes and what stays. */
        fun confirmationFor(kind: LibraryClearKind, count: Int?): String = when (kind) {
            LibraryClearKind.HISTORY ->
                (if (count == null) "Clear your whole watch history" else "Clear ${plural(count, "title", "titles")} from your watch history") +
                    ", with their resume points? Favourites, your watchlist and watched marks stay. This can't be undone."
            LibraryClearKind.FAVOURITES ->
                "Remove ${plural(count ?: 0, "favourite", "favourites")}? This can't be undone."
            LibraryClearKind.WATCHLIST ->
                "Remove ${plural(count ?: 0, "title", "titles")} from your watchlist? This can't be undone."
            LibraryClearKind.WATCHED ->
                "Clear ${plural(count ?: 0, "watched mark", "watched marks")}? Your watch history stays. This can't be undone."
        }

        fun doneMessage(kind: LibraryClearKind, removed: Int): String = when (kind) {
            LibraryClearKind.HISTORY -> "Cleared ${plural(removed, "title", "titles")} from your watch history."
            LibraryClearKind.FAVOURITES -> "Removed ${plural(removed, "favourite", "favourites")}."
            LibraryClearKind.WATCHLIST -> "Removed ${plural(removed, "title", "titles")} from your watchlist."
            LibraryClearKind.WATCHED -> "Cleared ${plural(removed, "watched mark", "watched marks")}."
        }
    }
}
