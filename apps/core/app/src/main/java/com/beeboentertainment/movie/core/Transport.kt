package com.beeboentertainment.movie.core

/**
 * What the ⏮ / ⏭ transport buttons do.
 *
 * The rule is the one the website implements, so the two behave identically:
 *   ⏭  play `next`.
 *   ⏮  more than five seconds in? restart the current item. Otherwise go to `previous` —
 *      and when there is no `previous`, restart anyway, so the button is never dead.
 *
 * `next` and `previous` both come from one /api/upnext traversal, so they can never disagree
 * about what sits either side of the current item. Nothing here re-derives them.
 */
object TransportPolicy {

    /** Past this point ⏮ means "start this one again" rather than "go back one". */
    const val RESTART_THRESHOLD_MS = 5_000L

    enum class PreviousAction {
        /** Seek the current item to zero. */
        RESTART,
        /** Load the previous episode / collection part. */
        GO_PREVIOUS
    }

    /**
     * @param positionMs   where playback currently is
     * @param hasPrevious  whether /api/upnext gave us a `previous` item
     */
    fun previousAction(positionMs: Long, hasPrevious: Boolean): PreviousAction = when {
        positionMs > RESTART_THRESHOLD_MS -> PreviousAction.RESTART
        hasPrevious -> PreviousAction.GO_PREVIOUS
        // At the start of the first episode: restarting is still better than doing nothing.
        else -> PreviousAction.RESTART
    }

    /*
     * Command availability for the ForwardingPlayer that sits between the session and the real
     * player. THIS is what the ⏭ bug was: availability was previously a fixed set, and
     * hasNextMediaItem() fell through to a player whose playlist holds exactly one item and so
     * always answered false — leaving the next control permanently disabled, while previous
     * worked because seeking to previous is always allowed (at worst it restarts).
     */

    /*
     * Media3 Player command ids, read out of media3-common 1.4.1 rather than remembered.
     * PlayerControlView gates the scrub bar on exactly one of them:
     *     timeBar.setEnabled(player.isCommandAvailable(COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM))
     * so anything that removes or stales that command leaves a time bar that draws but will not
     * drag. It belongs to the real player - it only appears once there is a seekable timeline -
     * and nothing here may ever touch it.
     */
    const val COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM = 5
    const val COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM = 6
    const val COMMAND_SEEK_TO_PREVIOUS = 7
    const val COMMAND_SEEK_TO_NEXT_MEDIA_ITEM = 8
    const val COMMAND_SEEK_TO_NEXT = 9

    /** Commands the forwarding player adds on top of whatever the real player already offers. */
    fun addedCommands(hasNextItem: Boolean): List<Int> = buildList {
        add(COMMAND_SEEK_TO_PREVIOUS)
        add(COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
        if (nextAvailable(hasNextItem)) {
            add(COMMAND_SEEK_TO_NEXT)
            add(COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
        }
    }

    /** Commands it removes. Only ever the next pair, and only when there is nothing to go to. */
    fun removedCommands(hasNextItem: Boolean): List<Int> =
        if (nextAvailable(hasNextItem)) emptyList()
        else listOf(COMMAND_SEEK_TO_NEXT, COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)

    /**
     * Commands this class must never add, remove or answer for — they belong to the real player.
     * Scrubbing lives here.
     */
    val untouchableCommands: List<Int> = listOf(COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM)

    /** ⏮ is always available: with nothing before this item it restarts the current one. */
    fun previousAvailable(): Boolean = true

    /** ⏭ is available exactly when /api/upnext gave us something to go to. */
    fun nextAvailable(hasNextItem: Boolean): Boolean = hasNextItem

    /** ⏭ only has somewhere to go when the server gave us a next item. */
    fun canGoNext(hasNext: Boolean): Boolean = hasNext

    /** Message when ⏭ is pressed at the end of a series / collection. */
    const val NO_NEXT_MESSAGE = "That's the last one."

    /**
     * Transport belongs to ordinary playback only. Surf mode keeps its own ⏮ Back / ⏭ Next,
     * which mean "another random pick" — a different thing entirely.
     */
    fun transportEnabled(surfMode: Boolean): Boolean = !surfMode
}
