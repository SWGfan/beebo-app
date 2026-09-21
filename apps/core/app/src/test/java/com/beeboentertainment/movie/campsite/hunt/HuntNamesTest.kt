package com.beeboentertainment.movie.campsite.hunt

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The one piece of free text a guest types: a nickname. XSS, the deny list, contact details and look-alikes. */
class HuntNamesTest {

    private fun clean(raw: String) = HuntNames.clean(raw, "Camper")

    @Test fun markupIsStrippedSoNoNameCanBecomeAnElement() {
        val hostile = listOf(
            "<img src=x onerror=alert(1)>", "<script>alert(1)</script>", "\"><svg/onload=alert(1)>", "Ann & Ben",
            "javascript:alert(1)", "&lt;b&gt;", "' onmouseover='x", "</title><script>",
        )
        hostile.forEach { raw ->
            val shown = clean(raw)
            assertFalse("markup left in: $shown", shown.contains('<') || shown.contains('>') || shown.contains('&') || shown.contains('"'))
        }
        assertEquals("Ann Ben", clean("Ann & Ben").replace("  ", " "))
    }

    @Test fun controlAndInvisibleCharactersAreRemovedAndLengthIsCapped() {
        assertEquals("Ann", clean("A\u0000n\u0007n"))
        assertEquals("Ann", clean("\u200BAnn\u200E"))
        assertEquals("Ann", clean("An\u202En"))               // right-to-left override
        assertEquals("Ann Lee", clean("  Ann \n\t Lee  "))
        assertEquals(24, clean("x".repeat(200)).length)
        assertEquals("Camper", clean("   "))
        assertEquals("Camper", clean(""))
        assertEquals("Camper", clean("\u200B\u200B"))
    }

    @Test fun rudeNamesAreReplacedIncludingLookAlikesAndSpacedOutSpellings() {
        listOf("shit", "S H I T", "5h1t", "f.u.c.k", "xXkillerXx", "b1tch", "H!tler", "N4zi", "porn", "Suicide", "$3x", "idiot").forEach {
            assertEquals("should replace: $it", "Camper", clean(it))
        }
    }

    @Test fun ordinaryNamesPass() {
        listOf("Ann", "Mia", "Ben", "Sam K", "Zoe-Lou", "Dumbo", "Sussex", "Skillet", "Grace", "O'Neil", "Élise", "Ana Maria", "Noah 7")
            .forEach { assertFalse("wrongly flagged: $it", HuntNames.flagged(it)) }
        assertEquals("Ann", clean("Ann"))
    }

    @Test fun contactDetailsAndLinksAreReplaced() {
        listOf("call 555 123 4567", "me@example.com", "http://x.y", "www.evil.com", "abc.com", "5551234567", "@ann_camp", "5.5.5.1.2.3.4").forEach {
            assertEquals("should replace: $it", "Camper", clean(it))
        }
        // A short number, like an age, is fine.
        assertEquals("Noah 7", clean("Noah 7"))
    }

    @Test fun duplicateNamesGetANumberSoTheLeaderboardIsNeverAmbiguous() {
        assertEquals("Ann", HuntNames.unique("Ann", emptyList()))
        assertEquals("Ann 2", HuntNames.unique("Ann", listOf("ann")))
        assertEquals("Ann 3", HuntNames.unique("Ann", listOf("Ann", "Ann 2")))
        assertTrue(HuntNames.unique("x".repeat(24), listOf("x".repeat(24))).length <= 24)
    }
}
