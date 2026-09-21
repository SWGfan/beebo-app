package com.beeboentertainment.movie

import androidx.media3.common.Player
import com.beeboentertainment.movie.core.PlayerChromePolicy
import com.beeboentertainment.movie.core.TransportPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Scrubbing.
 *
 * The reported bug was that the time bar drew but would not drag. PlayerControlView gates it on
 * exactly one command:
 *     timeBar.setEnabled(player.isCommandAvailable(COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM))
 * so these tests pin down that nothing in our transport layer may touch or answer for it.
 */
class SeekTest {

    @Test
    fun `our command ids match media3's, so the mirror can't drift`() {
        assertEquals(
            Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM,
            TransportPolicy.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM
        )
        assertEquals(Player.COMMAND_SEEK_TO_PREVIOUS, TransportPolicy.COMMAND_SEEK_TO_PREVIOUS)
        assertEquals(
            Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
            TransportPolicy.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM
        )
        assertEquals(Player.COMMAND_SEEK_TO_NEXT, TransportPolicy.COMMAND_SEEK_TO_NEXT)
        assertEquals(
            Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
            TransportPolicy.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM
        )
        // and the one that matters is 5, as read out of media3-common
        assertEquals(5, TransportPolicy.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM)
    }

    @Test
    fun `the forwarding player never adds or removes seek-in-current-item`() {
        // THE BUG: this command belongs to the real player — it only appears once there is a
        // seekable timeline. Anything we do to it disables the scrub bar.
        listOf(true, false).forEach { hasNext ->
            assertFalse(
                TransportPolicy.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM in TransportPolicy.addedCommands(hasNext)
            )
            assertFalse(
                TransportPolicy.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM in TransportPolicy.removedCommands(hasNext)
            )
        }
        assertTrue(
            TransportPolicy.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM in TransportPolicy.untouchableCommands
        )
    }

    @Test
    fun `only the next pair is ever removed, and only when there is no next item`() {
        assertEquals(emptyList<Int>(), TransportPolicy.removedCommands(hasNextItem = true))
        assertEquals(
            listOf(TransportPolicy.COMMAND_SEEK_TO_NEXT, TransportPolicy.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM),
            TransportPolicy.removedCommands(hasNextItem = false)
        )
    }

    @Test
    fun `previous is always added, next only when there is somewhere to go`() {
        val withNext = TransportPolicy.addedCommands(hasNextItem = true)
        assertTrue(TransportPolicy.COMMAND_SEEK_TO_PREVIOUS in withNext)
        assertTrue(TransportPolicy.COMMAND_SEEK_TO_NEXT in withNext)

        val withoutNext = TransportPolicy.addedCommands(hasNextItem = false)
        assertTrue(TransportPolicy.COMMAND_SEEK_TO_PREVIOUS in withoutNext)
        assertFalse(TransportPolicy.COMMAND_SEEK_TO_NEXT in withoutNext)
        assertFalse(TransportPolicy.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM in withoutNext)
    }

    @Test
    fun `added and removed never overlap, so the set can't fight itself`() {
        listOf(true, false).forEach { hasNext ->
            val added = TransportPolicy.addedCommands(hasNext).toSet()
            val removed = TransportPolicy.removedCommands(hasNext).toSet()
            assertTrue(added.intersect(removed).isEmpty())
        }
    }

    @Test
    fun `the chrome's touch hook never consumes an event`() {
        // Consuming would swallow a drag on the scrub bar while leaving taps working — exactly
        // the symptom that was reported.
        assertFalse(PlayerChromePolicy.shouldConsumeTouch())
    }

    @Test
    fun `a touch only re-arms the countdown when the controls are already up`() {
        assertTrue(PlayerChromePolicy.shouldRearmOnTouch(controllerAlreadyVisible = true))
        // when hidden, PlayerView's own tap-to-show handles it on ACTION_UP; doing it here too
        // would be immediately toggled back off
        assertFalse(PlayerChromePolicy.shouldRearmOnTouch(controllerAlreadyVisible = false))
    }
}
