package com.beeboentertainment.movie

import com.beeboentertainment.movie.core.ResumeReconciler
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Local ResumeStore vs the server's /api/continue position — whoever got further wins. */
class ResumeReconcilerTest {

    @Test
    fun `nothing anywhere means no prompt`() {
        val p = ResumeReconciler.reconcile(localMs = 0L, serverSeconds = null)
        assertFalse(p.hasResume)
        assertEquals(ResumeReconciler.Source.NONE, p.source)
    }

    @Test
    fun `only the phone knows - a short session the server never recorded`() {
        // the server only writes history after 5+ minutes, so this is the normal case
        val p = ResumeReconciler.reconcile(localMs = 120_000L, serverSeconds = null)
        assertEquals(120_000L, p.positionMs)
        assertEquals(ResumeReconciler.Source.LOCAL, p.source)
    }

    @Test
    fun `only the server knows - watched on another device`() {
        val p = ResumeReconciler.reconcile(localMs = 0L, serverSeconds = 1234.5)
        assertEquals(1_234_500L, p.positionMs)
        assertEquals(ResumeReconciler.Source.SERVER, p.source)
    }

    @Test
    fun `the server being further along wins`() {
        val p = ResumeReconciler.reconcile(localMs = 600_000L, serverSeconds = 1800.0)
        assertEquals(1_800_000L, p.positionMs)
        assertEquals(ResumeReconciler.Source.SERVER, p.source)
    }

    @Test
    fun `the phone being further along wins`() {
        val p = ResumeReconciler.reconcile(localMs = 1_800_000L, serverSeconds = 600.0)
        assertEquals(1_800_000L, p.positionMs)
        assertEquals(ResumeReconciler.Source.LOCAL, p.source)
    }

    @Test
    fun `a tie goes to the server, the record the whole family shares`() {
        val p = ResumeReconciler.reconcile(localMs = 600_000L, serverSeconds = 600.0)
        assertEquals(600_000L, p.positionMs)
        assertEquals(ResumeReconciler.Source.SERVER, p.source)
    }

    @Test
    fun `positions under the minimum are ignored on both sides`() {
        assertFalse(ResumeReconciler.reconcile(localMs = 5_000L, serverSeconds = 4.0).hasResume)
        // and a trivial local one doesn't suppress a real server one
        val p = ResumeReconciler.reconcile(localMs = 5_000L, serverSeconds = 900.0)
        assertEquals(ResumeReconciler.Source.SERVER, p.source)
    }

    @Test
    fun `a position within the last ninety seconds counts as finished`() {
        val p = ResumeReconciler.reconcile(
            localMs = 7_150_000L,
            serverSeconds = null,
            durationMs = 7_200_000L
        )
        assertFalse(p.hasResume)
    }

    @Test
    fun `the server's own duration is used when the player doesn't know one yet`() {
        val p = ResumeReconciler.reconcile(
            localMs = 0L,
            serverSeconds = 7150.0,
            durationMs = 0L,
            serverDurationSeconds = 7200.0
        )
        assertFalse(p.hasResume)   // 50s from the end
    }

    @Test
    fun `unknown duration still allows a resume`() {
        val p = ResumeReconciler.reconcile(localMs = 600_000L, serverSeconds = null, durationMs = 0L)
        assertTrue(p.hasResume)
    }

    @Test
    fun `the prompt asks rather than auto-seeking`() {
        val p = ResumeReconciler.reconcile(localMs = 5_025_000L, serverSeconds = null)
        assertEquals("Continue \"Heat\" from 1:23:45?", ResumeReconciler.promptFor("Heat", p))
    }
}
