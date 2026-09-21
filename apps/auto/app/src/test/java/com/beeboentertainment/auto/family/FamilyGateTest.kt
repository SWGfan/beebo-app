package com.beeboentertainment.auto.family

import com.beeboentertainment.auto.drive.VideoGate
import com.beeboentertainment.auto.drive.VideoGate.Signals
import com.beeboentertainment.auto.family.FamilyGate.Feature
import com.beeboentertainment.auto.family.FamilyGate.Inputs
import com.beeboentertainment.auto.family.FamilyGate.Reason
import com.beeboentertainment.auto.family.FamilyGate.Surface
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The parked-versus-driving rule and the quiet-hours rule for Family Fun. */
class FamilyGateTest {

    // ---- the situations a device can be in -------------------------------------------------------

    private val parkedCar = Signals(isAutomotive = true, carRequiresDistractionOptimization = false)
    private val drivingCar = Signals(isAutomotive = true, carRequiresDistractionOptimization = true)
    private val carUnknown = Signals(isAutomotive = true, carRequiresDistractionOptimization = null)
    private val projectingPhone = Signals(isAutomotive = false, projectingToAndroidAuto = true)
    private val projectingPhoneConfirmed = projectingPhone.copy(passengerConfirmed = true)
    private val passengerPhone = Signals(isAutomotive = false, projectingToAndroidAuto = false, passengerConfirmed = true)
    private val unconfirmedPhone = Signals(isAutomotive = false, projectingToAndroidAuto = false, passengerConfirmed = false)

    private fun screen(s: Signals, quiet: Boolean = false, handsFree: Boolean = false) =
        Inputs(Surface.THIS_APP_SCREEN, s, quiet, handsFree)

    private fun car(quiet: Boolean = false, handsFree: Boolean = false) =
        Inputs(Surface.CAR_MEDIA_BROWSER, FamilyRuntime.WORST_CASE, quiet, handsFree)

    // ---- taps ------------------------------------------------------------------------------------

    @Test
    fun `buttons on this app's screen only work in a parked car or on a confirmed passenger phone`() {
        assertTrue(FamilyGate.tapAllowed(Surface.THIS_APP_SCREEN, parkedCar))
        assertTrue(FamilyGate.tapAllowed(Surface.THIS_APP_SCREEN, passengerPhone))

        assertFalse("moving car", FamilyGate.tapAllowed(Surface.THIS_APP_SCREEN, drivingCar))
        assertFalse("car has not said it is parked", FamilyGate.tapAllowed(Surface.THIS_APP_SCREEN, carUnknown))
        assertFalse("phone running the car screen", FamilyGate.tapAllowed(Surface.THIS_APP_SCREEN, projectingPhone))
        assertFalse("projecting even after a tap on I am a passenger", FamilyGate.tapAllowed(Surface.THIS_APP_SCREEN, projectingPhoneConfirmed))
        assertFalse("nobody said they are a passenger", FamilyGate.tapAllowed(Surface.THIS_APP_SCREEN, unconfirmedPhone))
    }

    @Test
    fun `the car's own media list is never a control surface, even parked`() {
        listOf(parkedCar, drivingCar, carUnknown, projectingPhone, passengerPhone, unconfirmedPhone).forEach {
            assertFalse(FamilyGate.tapAllowed(Surface.CAR_MEDIA_BROWSER, it))
        }
    }

    @Test
    fun `the tap rule is exactly the video rule, so the app has one answer to parked or driving`() {
        listOf(parkedCar, drivingCar, carUnknown, projectingPhone, projectingPhoneConfirmed, passengerPhone, unconfirmedPhone).forEach {
            assertEquals(VideoGate.videoAllowed(it), FamilyGate.tapAllowed(Surface.THIS_APP_SCREEN, it))
        }
    }

    @Test
    fun `every blocked state has a plain sentence and an allowed one has none`() {
        assertNull(FamilyGate.tapMessage(parkedCar))
        assertNull(FamilyGate.tapMessage(passengerPhone))
        listOf(drivingCar, carUnknown, projectingPhone, unconfirmedPhone).forEach {
            val m = FamilyGate.tapMessage(it)
            assertNotNull(m)
            assertTrue("short enough to read once parked: $m", m!!.length in 20..200)
        }
    }

    // ---- what plays ------------------------------------------------------------------------------

    @Test
    fun `the trip clock and stories are audio the car may play like any audiobook`() {
        listOf(car(), screen(drivingCar), screen(projectingPhone), screen(unconfirmedPhone)).forEach { i ->
            assertTrue(FamilyGate.decide(Feature.TRIP_CLOCK, i).listen)
            assertTrue(FamilyGate.decide(Feature.STORIES, i).listen)
        }
    }

    @Test
    fun `a voice game does not start from the car unless a parent switched hands-free on`() {
        val off = FamilyGate.decide(Feature.VOICE_GAMES, car(handsFree = false))
        assertFalse(off.listen)
        assertFalse(off.tap)
        assertEquals(Reason.GAMES_NEED_PARENT_OK, off.reason)
        assertEquals(FamilyGate.NEEDS_PARENT_MESSAGE, off.message)

        val on = FamilyGate.decide(Feature.VOICE_GAMES, car(handsFree = true))
        assertTrue(on.listen)
        assertFalse("hands-free means no taps, ever", on.tap)
    }

    @Test
    fun `a moving car or a phone in the dashboard needs the parent's ok for games, and still gets no taps`() {
        listOf(drivingCar, carUnknown, projectingPhone, projectingPhoneConfirmed).forEach { s ->
            val blocked = FamilyGate.decide(Feature.VOICE_GAMES, screen(s))
            assertFalse("$s", blocked.listen)
            val allowed = FamilyGate.decide(Feature.VOICE_GAMES, screen(s, handsFree = true))
            assertTrue("$s", allowed.listen)
            assertFalse("$s", allowed.tap)
        }
    }

    @Test
    fun `a parked car or a confirmed passenger phone can play games with taps, no parent switch needed`() {
        listOf(parkedCar, passengerPhone).forEach { s ->
            val d = FamilyGate.decide(Feature.VOICE_GAMES, screen(s))
            assertTrue(d.listen)
            assertTrue(d.tap)
            assertEquals(Reason.NONE, d.reason)
            assertNull(d.message)
        }
    }

    @Test
    fun `a phone nobody has confirmed as a passenger's does not start games by itself`() {
        assertFalse(FamilyGate.decide(Feature.VOICE_GAMES, screen(unconfirmedPhone)).listen)
    }

    // ---- quiet hours -----------------------------------------------------------------------------

    @Test
    fun `quiet hours rest every voice game, whatever else is switched on`() {
        listOf(car(quiet = true, handsFree = true), screen(parkedCar, quiet = true), screen(passengerPhone, quiet = true, handsFree = true)).forEach { i ->
            val d = FamilyGate.decide(Feature.VOICE_GAMES, i)
            assertFalse(d.listen)
            assertFalse(d.tap)
            assertEquals(Reason.QUIET_HOURS, d.reason)
            assertEquals(FamilyGate.QUIET_MESSAGE, d.message)
        }
    }

    @Test
    fun `quiet hours keep stories and the trip clock, and turn the stories calm`() {
        val story = FamilyGate.decide(Feature.STORIES, car(quiet = true))
        assertTrue(story.listen)
        assertTrue(story.calm)
        assertFalse(FamilyGate.decide(Feature.STORIES, car(quiet = false)).calm)
        assertTrue(FamilyGate.decide(Feature.TRIP_CLOCK, car(quiet = true)).listen)
    }

    @Test
    fun `the default is the strictest case`() {
        // What the media service assumes when the phone screen is not open.
        assertTrue(FamilyRuntime.WORST_CASE.projectingToAndroidAuto)
        assertFalse(VideoGate.videoAllowed(FamilyRuntime.WORST_CASE))
    }
}
