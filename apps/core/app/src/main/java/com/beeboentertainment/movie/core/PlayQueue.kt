package com.beeboentertainment.movie.core

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * "What plays next": a playlist in order or shuffled, plus anything added with Play next or
 * Add to queue. Pure data and rules, so the unit tests cover all of it; [PlayQueueHolder] is the
 * one shared instance the screens, the player and PlaybackService read.
 *
 * The same model as the website's and the desktop app's queue:
 *   - [pos] is the index of the item playing now; -1 before the first one starts.
 *   - When something outside the queue is played, the queue waits and carries on after it.
 *   - When the next queued item starts (from the player's ⏭, the up-next card, a car, a Cast
 *     receiver's controls), [onItemStarted] moves onto it.
 */
data class QueueItem(
    val kind: String,
    val id: String,
    val title: String = "",
    val stream: String? = null,
    val poster: String? = null,
    val showKey: String? = null,
    val entryId: String? = null,
    val resumeSeconds: Double = 0.0
) {
    fun sameAs(kind: String?, id: String?): Boolean = id == this.id && normalKind(kind) == normalKind(this.kind)

    companion object {
        fun normalKind(kind: String?): String = if (kind == "tv" || kind == "episode") "tv" else "movie"
    }
}

data class PlayQueue(
    val items: List<QueueItem> = emptyList(),
    val pos: Int = -1,
    val playlistId: String? = null,
    val playlistName: String? = null,
    val shuffle: Boolean = false,
    val seed: Long = 0
) {
    val current: QueueItem? get() = items.getOrNull(pos)
    val next: QueueItem? get() = items.getOrNull(pos + 1)
    val previous: QueueItem? get() = if (pos > 0) items.getOrNull(pos - 1) else null
    val remaining: Int get() = (items.size - pos - 1).coerceAtLeast(0)
    val isEmpty: Boolean get() = items.isEmpty()

    /** Move forward one; past the end means the queue has finished. */
    fun advance(): PlayQueue = copy(pos = (pos + 1).coerceAtMost(items.size))

    fun back(): PlayQueue = if (pos <= 0) this else copy(pos = pos - 1)

    fun jump(index: Int): PlayQueue = if (index in items.indices) copy(pos = index) else this

    /** Straight after the item playing now, ahead of everything else. */
    fun playNext(add: List<QueueItem>): PlayQueue {
        if (add.isEmpty()) return this
        val at = (pos + 1).coerceIn(0, items.size)
        return copy(items = items.subList(0, at) + add + items.subList(at, items.size))
    }

    /** At the end. */
    fun addToQueue(add: List<QueueItem>): PlayQueue = if (add.isEmpty()) this else copy(items = items + add)

    fun removeAt(index: Int): PlayQueue {
        if (index !in items.indices) return this
        val newPos = if (index <= pos) pos - 1 else pos
        return copy(items = items.filterIndexed { i, _ -> i != index }, pos = newPos)
    }

    /**
     * Something started playing. If it is a queued item still ahead, the queue moves onto it;
     * if it is the current one nothing changes; anything else leaves the queue waiting.
     */
    fun onItemStarted(kind: String?, id: String?): PlayQueue {
        if (id.isNullOrBlank()) return this
        if (current?.sameAs(kind, id) == true) return this
        for (i in (pos + 1).coerceAtLeast(0) until items.size) {
            if (items[i].sameAs(kind, id)) return copy(pos = i)
        }
        return this
    }

    /**
     * The next item for the player's transport when [id] is playing, or null when the queue has
     * nothing to say (the server's own up next applies):
     *   - [id] is the current queued item: the queue's next;
     *   - nothing from the queue has started yet (titles lined up with Play next / Add to queue):
     *     the first of them, after whatever is playing;
     *   - otherwise (an old, abandoned queue while something unrelated plays): null, so a queue
     *     from yesterday never hijacks today's film.
     */
    fun nextAfter(kind: String?, id: String?): QueueItem? {
        if (id.isNullOrBlank() || isEmpty) return null
        return if (current?.sameAs(kind, id) == true || pos == -1) next else null
    }

    /** The queue's previous item, only while [id] is the current queued item. */
    fun previousBefore(kind: String?, id: String?): QueueItem? =
        if (current?.sameAs(kind, id) == true) previous else null

    companion object {
        /** A queue from a playlist's play order, ready to start at [startIndex]. */
        fun fromPlaylist(
            items: List<QueueItem>,
            startIndex: Int = 0,
            playlistId: String? = null,
            playlistName: String? = null,
            shuffle: Boolean = false,
            seed: Long = 0
        ): PlayQueue {
            if (items.isEmpty()) return PlayQueue(playlistId = playlistId, playlistName = playlistName)
            val start = startIndex.coerceIn(0, items.size - 1)
            return PlayQueue(items, start - 1, playlistId, playlistName, shuffle, seed)
        }
    }
}

/** The one queue for the whole app, for as long as the process lives. */
object PlayQueueHolder {
    private val _queue = MutableStateFlow(PlayQueue())
    val queue: StateFlow<PlayQueue> = _queue.asStateFlow()
    val current: PlayQueue get() = _queue.value

    fun set(q: PlayQueue) { _queue.value = q }
    fun clear() { _queue.value = PlayQueue() }
    fun update(fn: (PlayQueue) -> PlayQueue) { _queue.value = fn(_queue.value) }

    /**
     * Called by PlaybackService whenever an item starts. Returns true when the queue moved onto
     * it, so the caller can report playlist progress for exactly those starts.
     */
    fun onItemStarted(kind: String?, id: String?): Boolean {
        val before = _queue.value
        val after = before.onItemStarted(kind, id)
        _queue.value = after
        return after.pos != before.pos
    }
}
