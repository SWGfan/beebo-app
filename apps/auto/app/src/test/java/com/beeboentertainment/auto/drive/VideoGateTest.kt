package com.beeboentertainment.auto.drive

import com.beeboentertainment.auto.drive.VideoGate.Block
import com.beeboentertainment.auto.drive.VideoGate.Signals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VideoGateTest {

    private val aaos = Signals(isAutomotive = true)
    private val phone = Signals(isAutomotive = false)

    @Test
    fun automotiveWithUnknownRestrictionsIsBlocked() {
        assertEquals(Block.CAR_STATE_UNKNOWN, VideoGate.decide(aaos))
        assertFalse(VideoGate.videoAllowed(aaos.copy(passengerConfirmed = true)))
    }

    @Test
    fun automotiveDrivingIsBlockedEvenForAConfirmedPassenger() {
        val s = aaos.copy(carRequiresDistractionOptimization = true, passengerConfirmed = true)
        assertEquals(Block.DRIVING, VideoGate.decide(s))
    }

    @Test
    fun automotiveParkedAllowsVideoWithoutAnyConfirmation() {
        val s = aaos.copy(carRequiresDistractionOptimization = false)
        assertEquals(Block.NONE, VideoGate.decide(s))
    }

    @Test
    fun automotiveIgnoresPhoneOnlySignals() {
        // A projection flag has no meaning on the car itself; its own restrictions rule.
        val s = aaos.copy(carRequiresDistractionOptimization = false, projectingToAndroidAuto = true)
        assertTrue(VideoGate.videoAllowed(s))
    }

    @Test
    fun phoneProjectingToAndroidAutoNeverShowsVideo() {
        val s = phone.copy(projectingToAndroidAuto = true, passengerConfirmed = true)
        assertEquals(Block.PROJECTING, VideoGate.decide(s))
    }

    @Test
    fun passengerPhoneNeedsConfirmationThenAllows() {
        assertEquals(Block.NEEDS_PASSENGER_CONFIRMATION, VideoGate.decide(phone))
        assertEquals(Block.NONE, VideoGate.decide(phone.copy(passengerConfirmed = true)))
    }

    @Test
    fun pipOnlyOnAPassengerPhoneThatSupportsItAndMayShowVideo() {
        val ok = phone.copy(passengerConfirmed = true)
        assertTrue(VideoGate.pipAllowed(ok, platformSupportsPip = true))
        assertFalse(VideoGate.pipAllowed(ok, platformSupportsPip = false))
        assertFalse(VideoGate.pipAllowed(phone, platformSupportsPip = true))
        assertFalse(VideoGate.pipAllowed(ok.copy(projectingToAndroidAuto = true), true))
        // Parked AAOS still gets no floating window.
        assertFalse(VideoGate.pipAllowed(aaos.copy(carRequiresDistractionOptimization = false), true))
    }

    @Test
    fun everyBlockHasAMessageAndNoneHasNone() {
        assertNull(VideoGate.message(Block.NONE))
        Block.values().filter { it != Block.NONE }.forEach { assertNotNull(it.name, VideoGate.message(it)) }
    }
}
