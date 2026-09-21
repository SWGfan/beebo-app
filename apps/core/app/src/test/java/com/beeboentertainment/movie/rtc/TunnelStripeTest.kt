package com.beeboentertainment.movie.rtc

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import kotlin.concurrent.thread

class TunnelStripeTest {

    private val mb = 1024L * 1024
    private val oldV2 = TunnelProtocol.HostFeatures(2, setOf("headers", "body-chunks", "set-cookies", "resp-headers"), 8 * mb, 16384)
    private val newV2 = TunnelProtocol.HostFeatures(
        2, setOf("headers", "body-chunks", "set-cookies", "resp-headers", "big-frames", "stripe"), 8 * mb, 32768, frame = 65533, stripes = 4,
    )

    // ------------------------------------------------------------------ how many connections

    @Test fun `an old host, a legacy host or one without stripes never gets more than one connection`() {
        assertEquals(1, TunnelStripe.connectionsFor(oldV2, 500 * mb, resumable = true))
        assertEquals(1, TunnelStripe.connectionsFor(TunnelProtocol.HostFeatures.LEGACY, 500 * mb, resumable = true))
        // The feature name alone is not enough: it must also say how many.
        val nameOnly = newV2.copy(stripes = 0)
        assertFalse(nameOnly.stripe)
        assertEquals(1, TunnelStripe.connectionsFor(nameOnly, 500 * mb, resumable = true))
        // ...and the count alone is not enough: it must also name the feature.
        assertEquals(1, TunnelStripe.connectionsFor(newV2.copy(features = newV2.features - "stripe"), 500 * mb, resumable = true))
    }

    @Test fun `a new host gives a big resumable download several connections, capped`() {
        assertEquals(4, TunnelStripe.connectionsFor(newV2, 500 * mb, resumable = true))
        // The caller can ask for fewer, never more than the cap or than the host allows.
        assertEquals(2, TunnelStripe.connectionsFor(newV2, 500 * mb, resumable = true, requested = 2))
        assertEquals(1, TunnelStripe.connectionsFor(newV2, 500 * mb, resumable = true, requested = 0))
        assertEquals(4, TunnelStripe.connectionsFor(newV2, 500 * mb, resumable = true, requested = 50))
        assertEquals("1 + 2 extra", 3, TunnelStripe.connectionsFor(newV2.copy(stripes = 2), 500 * mb, resumable = true))
        assertEquals(2, TunnelStripe.connectionsFor(newV2.copy(stripes = 1), 500 * mb, resumable = true))
    }

    @Test fun `a small file or one that cannot be resumed is not striped`() {
        assertEquals(1, TunnelStripe.connectionsFor(newV2, TunnelStripe.MIN_BYTES - 1, resumable = true))
        assertEquals(4, TunnelStripe.connectionsFor(newV2, TunnelStripe.MIN_BYTES, resumable = true))
        assertEquals(1, TunnelStripe.connectionsFor(newV2, 500 * mb, resumable = false))
        assertEquals("unknown length", 1, TunnelStripe.connectionsFor(newV2, -1, resumable = true))
    }

    // ------------------------------------------------------------------ the plan

    @Test fun `segments cover the range exactly once, the last one short`() {
        val plan = TunnelStripe.Plan(0, 10 * mb + 12344, segmentBytes = 4 * mb)   // 10 MB + 12345 bytes
        assertEquals(3, plan.segments)
        assertEquals("bytes=0-${4 * mb - 1}", plan.range(0))
        assertEquals("bytes=${4 * mb}-${8 * mb - 1}", plan.range(1))
        assertEquals("bytes=${8 * mb}-${10 * mb + 12344}", plan.range(2))
        assertEquals(2 * mb + 12345, plan.segmentLength(2))
        var next = 0L
        for (i in 0 until plan.segments) { assertEquals(next, plan.segmentStart(i)); next = plan.segmentEnd(i) + 1 }
        assertEquals(plan.totalBytes, next)
    }

    @Test fun `a range that starts in the middle, and one segment exactly the size of the range`() {
        val plan = TunnelStripe.Plan(1000, 1999, segmentBytes = 500)
        assertEquals(2, plan.segments)
        assertEquals("bytes=1000-1499", plan.range(0))
        assertEquals("bytes=1500-1999", plan.range(1))
        val one = TunnelStripe.Plan(7, 7)
        assertEquals(1, one.segments)
        assertEquals("bytes=7-7", one.range(0))
        try { one.range(1); fail() } catch (_: IllegalStateException) {}
        try { TunnelStripe.Plan(5, 4); fail() } catch (_: IllegalArgumentException) {}
        try { TunnelStripe.Plan(-1, 4); fail() } catch (_: IllegalArgumentException) {}
        try { TunnelStripe.Plan(0, 4, 0); fail() } catch (_: IllegalArgumentException) {}
    }

    @Test fun `the plan comes from Content-Range for a 206 and Content-Length for a 200`() {
        val p206 = TunnelStripe.Plan.of("bytes 1000-1999/50000", 1000)!!
        assertEquals(1000L, p206.start)
        assertEquals(1999L, p206.endInclusive)
        val p200 = TunnelStripe.Plan.of(null, 123456)!!
        assertEquals(0L, p200.start)
        assertEquals(123455L, p200.endInclusive)
        assertEquals(TunnelStripe.Plan.of("bytes 0-9/*", 10)!!.endInclusive, 9L)
        assertNull("no length, no plan", TunnelStripe.Plan.of(null, -1))
        assertNull(TunnelStripe.Plan.of(null, 0))
        assertNull("nonsense", TunnelStripe.Plan.of("bytes 9-0/100", 10))
    }

    // ------------------------------------------------------------------ handing out segments

    @Test fun `each segment goes to one worker, in order, and a failed one comes back first`() {
        val a = TunnelStripe.Assigner(4)
        assertEquals(0, a.next()); assertEquals(1, a.next())
        a.complete(0)
        a.requeue(1)              // its connection died
        assertEquals("the failed one is taken again before the untouched ones", 1, a.next())
        assertEquals(2, a.next()); assertEquals(3, a.next())
        assertNull(a.next())
        assertFalse(a.finished())
        assertEquals(3, a.remaining())
        a.complete(1); a.complete(2); a.complete(3)
        assertTrue(a.finished())
        // A segment that is already done is never handed out again, and completing twice is harmless.
        a.requeue(2); a.complete(2)
        assertNull(a.next())
        assertEquals(0, a.remaining())
    }

    @Test fun `a segment is not queued twice`() {
        val a = TunnelStripe.Assigner(2)
        val first = a.next()!!
        a.requeue(first); a.requeue(first)
        assertEquals(first, a.next())
        assertEquals(1, a.next())
        assertNull(a.next())
    }

    @Test fun `several workers at once fetch every segment exactly once`() {
        val plan = TunnelStripe.Plan(0, 250 * mb - 1)     // 63 segments of 4 MB
        val a = TunnelStripe.Assigner(plan.segments)
        val fetched = ConcurrentHashMap<Int, Int>()
        val start = CountDownLatch(1)
        val workers = (1..4).map { w ->
            thread {
                start.await()
                var failedOnce = false
                while (true) {
                    val i = a.next() ?: break
                    // Worker 2's connection dies once, on its third segment; the segment goes back.
                    if (w == 2 && !failedOnce && fetched.size > 20 && i % 3 == 0) { failedOnce = true; a.requeue(i); continue }
                    fetched.merge(i, 1) { x, y -> x + y }
                    a.complete(i)
                }
            }
        }
        start.countDown()
        workers.forEach { it.join(10_000) }
        assertTrue(a.finished())
        assertEquals(plan.segments, fetched.size)
        assertTrue("no segment fetched twice: $fetched", fetched.values.all { it == 1 })
        assertNotNull(fetched[plan.segments - 1])
    }
}
