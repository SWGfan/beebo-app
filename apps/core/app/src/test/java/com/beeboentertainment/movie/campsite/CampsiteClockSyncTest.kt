package com.beeboentertainment.movie.campsite

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

/**
 * Checks the Kotlin clock maths against src/test/resources/campsite-clock-vectors.json, the same
 * file the JavaScript in the guest's browser is tested against (tools/campsite-music). Both
 * implementations must reproduce the same numbers, which keeps the mirror honest.
 */
class CampsiteClockSyncTest {
    private val root: JsonObject = Json.parseToJsonElement(
        javaClass.classLoader!!.getResourceAsStream("campsite-clock-vectors.json")!!.bufferedReader().readText()).jsonObject

    private fun samples(rows: JsonArray) = rows.map { r -> r.jsonArray.map { it.jsonPrimitive.double }.let { ClockSample(it[0], it[1], it[2], it[3]) } }

    @Test fun matchesTheSharedVectorsAndStaysWithinRttOverTwoOfTheTruth() {
        for (v in root["vectors"]!!.jsonArray.map { it.jsonObject }) {
            val name = v["name"]!!.jsonPrimitive.content
            val est = ClockSync.estimate(samples(v["samples"]!!.jsonArray))
            val expect = v["expect"]!!
            if (expect is JsonNull) { assertNull(name, est); continue }
            val e = expect.jsonObject
            assertNotNull(name, est)
            assertEquals("$name offset", e["offsetMs"]!!.jsonPrimitive.double, est!!.offsetMs, 1e-6)
            assertEquals("$name rtt", e["rttMs"]!!.jsonPrimitive.double, est.rttMs, 1e-6)
            assertEquals("$name error", e["errorMs"]!!.jsonPrimitive.double, est.errorMs, 1e-6)
            assertEquals("$name used", e["used"]!!.jsonPrimitive.int, est.used)
            assertEquals("$name total", e["total"]!!.jsonPrimitive.int, est.total)
            val truth = v["trueOffset"]!!.jsonPrimitive.double
            assertTrue("$name: off by ${est.offsetMs - truth}", abs(est.offsetMs - truth) <= est.rttMs / 2 + 0.5)
        }
    }

    @Test fun filterMatchesTheSharedVectors() {
        val f = ClockFilter()
        for (step in root["filter"]!!.jsonArray.map { it.jsonObject }) {
            val i = step["in"]!!.jsonObject
            f.update(ClockEstimate(i["offsetMs"]!!.jsonPrimitive.double, i["rttMs"]!!.jsonPrimitive.double, i["errorMs"]!!.jsonPrimitive.double, 10, 20))
            assertEquals(step["offsetMs"]!!.jsonPrimitive.double, f.offsetMs, 1e-9)
            assertEquals(step["errorMs"]!!.jsonPrimitive.double, f.errorMs, 1e-9)
        }
        assertTrue(f.offsetMs > 599)
    }

    @Test fun oneExchangeGivesTheClassicNtpNumbers() {
        // client sends at 100 (its clock); host, 50 ms ahead, hears it at 151, replies at 152; client hears it at 103.
        val s = ClockSample(100.0, 151.0, 152.0, 103.0)
        assertEquals(2.0, s.rtt, 1e-9)            // 3 ms elapsed on the client minus 1 ms of host time
        assertEquals(50.0, s.offset, 1e-9)        // host - client
    }

    @Test fun tooFewOrOnlyJunkSamplesGiveNoEstimate() {
        assertNull(ClockSync.estimate(emptyList()))
        val junk = List(10) { ClockSample(0.0, 1.0, 1.0, Double.NaN) } + List(10) { ClockSample(0.0, 0.0, 0.0, 5000.0) }
        assertNull(ClockSync.estimate(junk))
    }

    @Test fun lowRttSamplesWinOverSpikes() {
        val clean = List(20) { i -> ClockSample(i * 100.0, i * 100.0 + 1001.0, i * 100.0 + 1001.05, i * 100.0 + 2.05) }
        val spiked = List(10) { i -> ClockSample(i * 100.0, i * 100.0 + 1051.0, i * 100.0 + 1051.05, i * 100.0 + 52.05) }
        val est = ClockSync.estimate(clean + spiked)!!
        assertEquals(1000.0, est.offsetMs, 0.6)
    }

    @Test fun medianOfEvenAndOddLists() {
        assertEquals(2.0, ClockSync.median(listOf(3.0, 1.0, 2.0)), 0.0)
        assertEquals(2.5, ClockSync.median(listOf(4.0, 1.0, 3.0, 2.0)), 0.0)
    }
}
