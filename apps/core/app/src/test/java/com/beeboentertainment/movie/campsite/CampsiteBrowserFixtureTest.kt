package com.beeboentertainment.movie.campsite

import com.beeboentertainment.movie.party.games.*
import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/** Opt-in real HTTP fixture for the separate-phone browser checks. No Android device or APK. */
class CampsiteBrowserFixtureTest {
    @Test fun browserFixture() {
        val folder = System.getenv("BEEBO_BROWSER_FIXTURE")?.let { File(it) } ?: return
        val server=CampsiteServer(0,{emptyList()},{null},
            gamesPage={File(folder,"campsite-games.html").readText()},
            triviaQuestions={listOf(TriviaQuestion("Which answer is correct?",listOf(GameOption("a","Alpha"),GameOption("b","Bravo"),GameOption("c","Charlie"),GameOption("d","Delta")),"c"))})
        try {
            server.start();File(folder,"fixture-port.txt").writeText(server.boundPort.toString())
            val until=System.currentTimeMillis()+240_000
            val done=File(folder,"fixture-done.txt")
            while(!done.exists()&&System.currentTimeMillis()<until)Thread.sleep(200)
            assertTrue("Browser checks did not complete",done.exists())
            assertTrue(done.readText(),done.readText()=="pass")
        } finally {server.stop()}
    }
}
