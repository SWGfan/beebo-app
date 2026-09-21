package com.beeboentertainment.movie.campsite
import com.beeboentertainment.movie.party.games.*
import org.junit.Assert.*
import org.junit.Test
class CampsiteTriviaCacheTest {
    @Test fun `saved questions survive a fresh read only for the same signed in owner`() {
        val q=TriviaQuestion("A movie question",listOf(GameOption("a","One"),GameOption("b","Two"),GameOption("c","Three"),GameOption("d","Four")),"b")
        val disk=CampsiteTriviaCache.encode("computer/user1",listOf(q))
        assertEquals(listOf(q),CampsiteTriviaCache.decode("computer/user1",disk))
        assertTrue(CampsiteTriviaCache.decode("computer/user2",disk).isEmpty())
        assertTrue(CampsiteTriviaCache.decode("",disk).isEmpty())
    }
    @Test fun `damaged cache never starts a broken quiz`() {
        assertTrue(CampsiteTriviaCache.decode("owner","not json").isEmpty())
        val bad=TriviaQuestion("Broken",listOf(GameOption("a","One")),"missing")
        assertTrue(CampsiteTriviaCache.decode("owner",CampsiteTriviaCache.encode("owner",listOf(bad))).isEmpty())
    }
}
