package com.beeboentertainment.movie

import com.beeboentertainment.movie.tvpair.LinkError
import com.beeboentertainment.movie.tvpair.LinkResult
import com.beeboentertainment.movie.tvpair.PairFailure
import com.beeboentertainment.movie.tvpair.PairSession
import com.beeboentertainment.movie.tvpair.PollResult
import com.beeboentertainment.movie.tvpair.StartResult
import com.beeboentertainment.movie.tvpair.TvDecision
import com.beeboentertainment.movie.tvpair.TvLinkMessages
import com.beeboentertainment.movie.tvpair.TvLinkParsing
import com.beeboentertainment.movie.tvpair.TvLinkRequests
import com.beeboentertainment.movie.tvpair.TvPairCodes
import com.beeboentertainment.movie.tvpair.TvPairController
import com.beeboentertainment.movie.tvpair.TvPairMessages
import com.beeboentertainment.movie.tvpair.TvPairOutcome
import com.beeboentertainment.movie.tvpair.TvPairParsing
import com.beeboentertainment.movie.tvpair.TvPairService
import com.beeboentertainment.movie.tvpair.TvPairState
import com.beeboentertainment.movie.tvpair.TvPairing
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** TV pairing-code sign-in: code rules, response parsing, the TV's poll loop, the phone's messages. */
@OptIn(ExperimentalCoroutinesApi::class)
class TvPairingTest {

    /* ------------------------------ codes ------------------------------ */

    @Test
    fun `normalize ignores case hyphens and spaces`() {
        assertEquals("ABCDEFGH", TvPairCodes.normalize("abcd-efgh"))
        assertEquals("ABCDEFGH", TvPairCodes.normalize(" ABCD EFGH "))
        assertEquals("ABCDEFGH", TvPairCodes.normalize("AbCdEfGh"))
    }

    @Test
    fun `normalize refuses anything that is not a code`() {
        for (bad in listOf(null, "", "ABCD", "ABCDEFGHJ", "ABCD-EFG0", "ABCD-EFGO", "ABCD-EFG1", "ABCD-EFGI", "ABCD-EFG!")) {
            assertNull("'$bad'", TvPairCodes.normalize(bad))
        }
    }

    @Test
    fun `the alphabet has 32 symbols and no 0 O 1 or I`() {
        assertEquals(32, TvPairCodes.ALPHABET.length)
        assertEquals(32, TvPairCodes.ALPHABET.toSet().size)
        for (c in "01OI") assertFalse(c in TvPairCodes.ALPHABET)
    }

    @Test
    fun `format puts a hyphen in the middle and round-trips through normalize`() {
        assertEquals("ABCD-EFGH", TvPairCodes.format("ABCDEFGH"))
        assertEquals("ABCDEFGH", TvPairCodes.normalize(TvPairCodes.format("ABCDEFGH")))
        assertEquals("ABC", TvPairCodes.format("ABC"))
    }

    @Test
    fun `typing formats as it goes`() {
        assertEquals("", TvPairCodes.formatTyped(""))
        assertEquals("AB", TvPairCodes.formatTyped("ab"))
        assertEquals("ABCD", TvPairCodes.formatTyped("abcd"))
        assertEquals("ABCD-E", TvPairCodes.formatTyped("abcde"))
        assertEquals("ABCD-EFGH", TvPairCodes.formatTyped("abcd-efgh"))
        assertEquals("ABCD-EFGH", TvPairCodes.formatTyped("abcdefghjk"))
        assertEquals("ABCD-EFGH", TvPairCodes.formatTyped("abcd efgh"))
    }

    @Test
    fun `typing drops symbols a code never contains`() {
        assertEquals("ABCD", TvPairCodes.formatTyped("A0B1C-OID"))
    }

    @Test
    fun `a pasted link keeps just its code`() {
        assertEquals("ABCD-EFGH", TvPairCodes.formatTyped("https://beebo.tv/tv?code=ABCD-EFGH"))
        assertEquals("ABCDEFGH", TvPairCodes.fromLinkOrText("https://beebo.tv/tv?code=abcd-efgh&x=1"))
        assertEquals("ABCDEFGH", TvPairCodes.fromLinkOrText("beebo://tv-link?code=ABCD%2DEFGH"))
        assertEquals("ABCDEFGH", TvPairCodes.fromLinkOrText("https://beebo.tv/tv?code=ABCD-EFGH#top"))
        assertEquals("ABCDEFGH", TvPairCodes.fromLinkOrText("  abcd-efgh  "))
        assertNull(TvPairCodes.fromLinkOrText("https://beebo.tv/tv?code=short"))
        assertNull(TvPairCodes.fromLinkOrText("https://beebo.tv/tv"))
        assertNull(TvPairCodes.fromLinkOrText(null))
    }

    @Test
    fun `a deep link is queued once and consumed`() {
        TvLinkRequests.consume()
        assertFalse(TvLinkRequests.offer("https://example.com/x"))
        assertFalse(TvLinkRequests.offer(null))
        assertNull(TvLinkRequests.pending.value)
        assertTrue(TvLinkRequests.offer("beebo://tv-link?code=abcd-efgh"))
        assertEquals("ABCDEFGH", TvLinkRequests.pending.value)
        TvLinkRequests.consume()
        assertNull(TvLinkRequests.pending.value)
        // A link with no usable code still opens the screen, empty.
        assertTrue(TvLinkRequests.offer("beebo://tv-link"))
        assertEquals("", TvLinkRequests.pending.value)
        TvLinkRequests.consume()
    }

    /* ------------------------------ which device shows what ------------------------------ */

    @Test
    fun `only a TV offers the phone code and only a phone offers Link a TV`() {
        assertTrue(TvPairing.offersPhoneSignIn(isTv = true))
        assertFalse(TvPairing.offersPhoneSignIn(isTv = false))
        assertTrue(TvPairing.offersLinkATv(isTv = false))
        assertFalse(TvPairing.offersLinkATv(isTv = true))
    }

    @Test
    fun `device label prefers the name the person gave the TV`() {
        assertEquals("Living room", TvPairing.deviceLabel("  Living room ", "Google", "Chromecast"))
        assertEquals("Google Chromecast", TvPairing.deviceLabel(null, "Google", "Chromecast"))
        assertEquals("Chromecast", TvPairing.deviceLabel("", "", "Chromecast"))
        assertEquals("Sony BRAVIA 4K", TvPairing.deviceLabel(null, "Sony", "BRAVIA 4K"))
        assertEquals("TV", TvPairing.deviceLabel(null, null, null))
        assertEquals(40, TvPairing.deviceLabel("x".repeat(100), null, null).length)
    }

    @Test
    fun `device label does not repeat the make inside the model`() {
        assertEquals("Sony X90", TvPairing.deviceLabel(null, "Sony", "Sony X90"))
        assertEquals("Amazon AFTMM", TvPairing.deviceLabel(null, "Amazon", "AFTMM"))
    }

    /* ------------------------------ parsing: start ------------------------------ */

    private val startBody = """
        {"device_code":"${"a".repeat(43)}","user_code":"ABCD-EFGH","verification_uri":"https://beebo.tv/tv",
         "verification_uri_complete":"https://beebo.tv/tv?code=ABCD-EFGH","expires_in":600,"interval":5}
    """.trimIndent()

    @Test
    fun `start parses the protocol response`() {
        val s = (TvPairParsing.parseStart(200, startBody) as StartResult.Started).session
        assertEquals("a".repeat(43), s.deviceCode)
        assertEquals("ABCDEFGH", s.userCode)
        assertEquals("https://beebo.tv/tv", s.verificationUri)
        assertEquals("https://beebo.tv/tv?code=ABCD-EFGH", s.verificationUriComplete)
        assertEquals(600, s.expiresInS)
        assertEquals(5, s.intervalS)
    }

    @Test
    fun `start clamps an odd interval and lifetime`() {
        val body = startBody.replace("\"expires_in\":600", "\"expires_in\":99999").replace("\"interval\":5", "\"interval\":0")
        val s = (TvPairParsing.parseStart(200, body) as StartResult.Started).session
        assertEquals(600, s.expiresInS)
        assertEquals(TvPairController.MIN_INTERVAL_S, s.intervalS)
    }

    @Test
    fun `start refuses an answer that is not a code`() {
        for (body in listOf("", "not json", "{}", """{"device_code":"x","user_code":"bad"}""", """{"user_code":"ABCD-EFGH"}""")) {
            val r = TvPairParsing.parseStart(200, body)
            assertEquals(body, PairFailure.Kind.BAD_RESPONSE, (r as StartResult.Failed).failure.kind)
        }
    }

    @Test
    fun `start maps http failures`() {
        assertEquals(PairFailure.Kind.UNAVAILABLE, failureOf(404, """{"error":"not_found"}"""))
        assertEquals(PairFailure(PairFailure.Kind.RATE_LIMITED, 900), (TvPairParsing.parseStart(429, """{"error":"too_many_attempts","retry_after":900}""") as StartResult.Failed).failure)
        assertEquals(PairFailure.Kind.SERVER, failureOf(500, "{}"))
        assertEquals(PairFailure.Kind.SERVER, failureOf(503, "oops"))
        assertEquals(PairFailure.Kind.BAD_RESPONSE, failureOf(400, """{"error":"invalid_request"}"""))
    }

    private fun failureOf(code: Int, body: String) = (TvPairParsing.parseStart(code, body) as StartResult.Failed).failure.kind

    /* ------------------------------ parsing: poll ------------------------------ */

    @Test
    fun `poll parses every state`() {
        assertEquals(PollResult.Pending(5), TvPairParsing.parsePoll(200, """{"status":"pending","interval":5}"""))
        assertEquals(PollResult.SlowDown(10), TvPairParsing.parsePoll(429, """{"status":"slow_down","error":"slow_down","interval":10}"""))
        assertEquals(PollResult.Expired, TvPairParsing.parsePoll(200, """{"status":"expired","error":"expired_token"}"""))
        assertEquals(PollResult.Denied("access_denied"), TvPairParsing.parsePoll(200, """{"status":"denied","error":"access_denied"}"""))
        assertEquals(PollResult.Denied("no_home"), TvPairParsing.parsePoll(200, """{"status":"denied","error":"no_home"}"""))
        assertEquals(
            PollResult.Approved("nick", "tok.sig", 1234L),
            TvPairParsing.parsePoll(200, """{"status":"approved","name":"nick","token":"tok.sig","iceServers":[{"urls":"stun:x"}],"expiresAt":1234}"""),
        )
    }

    @Test
    fun `poll never treats an approval without a token as signed in`() {
        val r = TvPairParsing.parsePoll(200, """{"status":"approved","name":"nick"}""")
        assertEquals(PairFailure.Kind.BAD_RESPONSE, (r as PollResult.Failed).failure.kind)
        assertTrue(TvPairParsing.parsePoll(200, """{"status":"approved","token":"t"}""") is PollResult.Failed)
    }

    @Test
    fun `poll maps lockouts and outages`() {
        assertEquals(
            PollResult.Failed(PairFailure(PairFailure.Kind.RATE_LIMITED, 900)),
            TvPairParsing.parsePoll(429, """{"error":"too_many_attempts","retry_after":900}"""),
        )
        assertEquals(PollResult.Failed(PairFailure(PairFailure.Kind.UNAVAILABLE)), TvPairParsing.parsePoll(404, """{"error":"not_found"}"""))
        assertEquals(PollResult.Failed(PairFailure(PairFailure.Kind.SERVER)), TvPairParsing.parsePoll(502, "bad gateway"))
        assertEquals(PollResult.Failed(PairFailure(PairFailure.Kind.BAD_RESPONSE)), TvPairParsing.parsePoll(400, """{"error":"invalid_request"}"""))
    }

    /* ------------------------------ the TV's poll loop ------------------------------ */

    private fun session(code: String, expires: Int = 600, interval: Int = 5) =
        PairSession("device-$code", code, "https://beebo.tv/tv", "https://beebo.tv/tv?code=${TvPairCodes.format(code)}", expires, interval)

    /** Scripted answers; records when (virtual ms) each call happened and what the screen showed. */
    private class Script(
        private val scope: TestScope,
        starts: List<StartResult>,
        polls: List<PollResult>,
    ) : TvPairService {
        var controller: TvPairController? = null
        private val startQueue = ArrayDeque(starts)
        private val pollQueue = ArrayDeque(polls)
        val startTimes = mutableListOf<Long>()
        val pollTimes = mutableListOf<Long>()
        val pollDevices = mutableListOf<String>()
        val stateAtPoll = mutableListOf<TvPairState>()
        override suspend fun start(deviceName: String, deviceModel: String): StartResult {
            startTimes += scope.currentTime
            return startQueue.removeFirst()
        }
        override suspend fun poll(deviceCode: String): PollResult {
            pollTimes += scope.currentTime
            pollDevices += deviceCode
            controller?.let { stateAtPoll += it.state.value }
            return pollQueue.removeFirst()
        }
    }

    private fun TestScope.controllerFor(script: Script): TvPairController =
        TvPairController(script, "Den TV", "Bravia") { currentTime }.also { script.controller = it }

    private fun started(code: String, expires: Int = 600, interval: Int = 5) = StartResult.Started(session(code, expires, interval))

    @Test
    fun `polls at the server interval until the phone approves, then stops`() = runTest {
        val script = Script(this, listOf(started("ABCDEFGH")), listOf(
            PollResult.Pending(5), PollResult.Pending(5), PollResult.Approved("nick", "tok", 99L),
        ))
        val out = controllerFor(script).run()
        assertEquals(TvPairOutcome.Approved("nick", "tok", 99L), out)
        assertEquals(listOf(5_000L, 10_000L, 15_000L), script.pollTimes)
        assertEquals(1, script.startTimes.size)
        assertTrue(script.pollDevices.all { it == "device-ABCDEFGH" })
    }

    @Test
    fun `the code on screen is the formatted user code and the link`() = runTest {
        val script = Script(this, listOf(started("ABCDEFGH")), listOf(PollResult.Approved("n", "t", 1L)))
        controllerFor(script).run()
        val shown = script.stateAtPoll.single() as TvPairState.ShowCode
        assertEquals("ABCD-EFGH", shown.userCode)
        assertEquals("https://beebo.tv/tv", shown.verificationUri)
        assertEquals("https://beebo.tv/tv?code=ABCD-EFGH", shown.verificationUriWithCode)
        assertFalse(shown.offline)
    }

    @Test
    fun `slow down lengthens the wait and it never shrinks again`() = runTest {
        val script = Script(this, listOf(started("ABCDEFGH")), listOf(
            PollResult.SlowDown(10), PollResult.Pending(5), PollResult.Approved("n", "t", 1L),
        ))
        controllerFor(script).run()
        assertEquals(listOf(5_000L, 15_000L, 25_000L), script.pollTimes)
    }

    @Test
    fun `the interval is capped at 30 seconds`() = runTest {
        val script = Script(this, listOf(started("ABCDEFGH")), listOf(
            PollResult.SlowDown(100), PollResult.Approved("n", "t", 1L),
        ))
        controllerFor(script).run()
        assertEquals(listOf(5_000L, 35_000L), script.pollTimes)
    }

    @Test
    fun `an expired code is replaced by a fresh one without any button`() = runTest {
        val script = Script(this, listOf(started("AAAAAAAA"), started("BBBBBBBB")), listOf(
            PollResult.Pending(5), PollResult.Expired, PollResult.Approved("nick", "tok", 1L),
        ))
        val out = controllerFor(script).run()
        assertEquals(TvPairOutcome.Approved("nick", "tok", 1L), out)
        assertEquals(2, script.startTimes.size)
        assertEquals(listOf("device-AAAAAAAA", "device-AAAAAAAA", "device-BBBBBBBB"), script.pollDevices)
        assertEquals("BBBB-BBBB", (script.stateAtPoll.last() as TvPairState.ShowCode).userCode)
    }

    @Test
    fun `a session that runs out on the clock is restarted even if the server never says expired`() = runTest {
        val polls = List(8) { PollResult.Pending(5) } + PollResult.Approved("n", "t", 1L)
        val script = Script(this, listOf(started("AAAAAAAA", expires = 30), started("BBBBBBBB", expires = 30)), polls)
        controllerFor(script).run()
        assertEquals(2, script.startTimes.size)
        // Its life plus the short grace for an approval made at the last moment.
        assertTrue("restarted at ${script.startTimes[1]}", script.startTimes[1] in 30_000L..50_000L)
    }

    @Test
    fun `a denial ends the run and names the reason`() = runTest {
        val script = Script(this, listOf(started("ABCDEFGH")), listOf(PollResult.Pending(5), PollResult.Denied("access_denied")))
        assertEquals(TvPairOutcome.Denied("access_denied"), controllerFor(script).run())
        assertEquals(2, script.pollTimes.size)
    }

    @Test
    fun `network trouble keeps the code up and backs off 5 10 20 30 then recovers`() = runTest {
        val offline = PollResult.Failed(PairFailure(PairFailure.Kind.OFFLINE))
        val script = Script(this, listOf(started("ABCDEFGH")), listOf(
            PollResult.Pending(5), offline, offline, offline, offline, offline, PollResult.Pending(5), PollResult.Approved("n", "t", 1L),
        ))
        controllerFor(script).run()
        val gaps = script.pollTimes.zipWithNext { a, b -> (b - a) / 1000 }
        assertEquals(listOf(5L, 5L, 10L, 20L, 30L, 30L, 5L), gaps)
        assertEquals("one code the whole time", setOf("device-ABCDEFGH"), script.pollDevices.toSet())
        assertFalse((script.stateAtPoll[1] as TvPairState.ShowCode).offline)
        assertTrue((script.stateAtPoll[2] as TvPairState.ShowCode).offline)
        assertTrue((script.stateAtPoll[6] as TvPairState.ShowCode).offline)
        assertFalse((script.stateAtPoll[7] as TvPairState.ShowCode).offline)
    }

    @Test
    fun `a lockout on polling waits out the retry-after`() = runTest {
        val locked = PollResult.Failed(PairFailure(PairFailure.Kind.RATE_LIMITED, 60))
        val script = Script(this, listOf(started("ABCDEFGH")), listOf(locked, PollResult.Approved("n", "t", 1L)))
        controllerFor(script).run()
        assertEquals(listOf(5_000L, 65_000L), script.pollTimes)
    }

    @Test
    fun `no code yet shows the problem and retries with backoff`() = runTest {
        val offline = StartResult.Failed(PairFailure(PairFailure.Kind.OFFLINE))
        val script = Script(this, listOf(offline, offline, offline, started("ABCDEFGH")), listOf(PollResult.Approved("n", "t", 1L)))
        controllerFor(script).run()
        assertEquals(listOf(0L, 5_000L, 15_000L, 35_000L), script.startTimes)
    }

    @Test
    fun `a rate limited start uses the server retry-after`() = runTest {
        val limited = StartResult.Failed(PairFailure(PairFailure.Kind.RATE_LIMITED, 120))
        val script = Script(this, listOf(limited, started("ABCDEFGH")), listOf(PollResult.Approved("n", "t", 1L)))
        controllerFor(script).run()
        assertEquals(listOf(0L, 120_000L), script.startTimes)
    }

    @Test
    fun `a service that is switched off ends the run so typing can take over`() = runTest {
        val script = Script(this, listOf(StartResult.Failed(PairFailure(PairFailure.Kind.UNAVAILABLE))), emptyList())
        assertEquals(TvPairOutcome.Unavailable, controllerFor(script).run())
        assertTrue(script.pollTimes.isEmpty())

        val midway = Script(this, listOf(started("ABCDEFGH")), listOf(PollResult.Failed(PairFailure(PairFailure.Kind.UNAVAILABLE))))
        assertEquals(TvPairOutcome.Unavailable, controllerFor(midway).run())
    }

    @Test
    fun `backoff and retry delays`() {
        assertEquals(listOf(5, 10, 20, 30, 30), (1..5).map { TvPairController.backoffS(it) })
        assertEquals(30, TvPairController.retryDelayS(PairFailure(PairFailure.Kind.OFFLINE), 9))
        assertEquals(120, TvPairController.retryDelayS(PairFailure(PairFailure.Kind.RATE_LIMITED, 120), 1))
        assertEquals(900, TvPairController.retryDelayS(PairFailure(PairFailure.Kind.RATE_LIMITED, 99999), 1))
        assertEquals(5, TvPairController.retryDelayS(PairFailure(PairFailure.Kind.RATE_LIMITED, 0), 1))
        assertEquals(30, TvPairController.clampInterval(1000))
        assertEquals(2, TvPairController.clampInterval(-4))
    }

    /* ------------------------------ what the TV says ------------------------------ */

    @Test
    fun `the play build's steps point at the phone app, not a web page`() {
        val play = TvPairMessages.steps(hasWebsite = false, address = "beebo.tv/tv")
        assertFalse(play.contains("beebo.tv"))
        assertTrue(play.contains("Link a TV"))
        assertTrue(TvPairMessages.steps(hasWebsite = true, address = "beebo.tv/tv").contains("beebo.tv/tv"))
    }

    @Test
    fun `problems are described in plain words`() {
        assertTrue(TvPairMessages.problem(PairFailure(PairFailure.Kind.OFFLINE), 10).contains("internet"))
        assertTrue(TvPairMessages.problem(PairFailure(PairFailure.Kind.RATE_LIMITED, 900), 900).contains("15 minutes"))
        assertTrue(TvPairMessages.problem(PairFailure(PairFailure.Kind.RATE_LIMITED, 30), 30).contains("1 minute."))
        assertTrue(TvPairMessages.denied("no_home").contains("home"))
        assertTrue(TvPairMessages.denied("access_denied").contains("no"))
    }

    /* ------------------------------ the phone's side ------------------------------ */

    private val lookupBody = """{"ok":true,"device_name":"Den TV","device_model":"Bravia","requested_at":120,"requested_minutes_ago":3,"expires_in":420}"""

    @Test
    fun `lookup shows which TV asked`() {
        val tv = (TvLinkParsing.parseLookup(200, lookupBody) as LinkResult.Ok).value
        assertEquals("Den TV", tv.deviceName)
        assertEquals("Bravia", tv.deviceModel)
        assertEquals(3, tv.requestedMinutesAgo)
        assertEquals(420, tv.expiresInS)
    }

    @Test
    fun `decisions are only accepted when the worker says the same thing`() {
        val approved = lookupBody.replace("\"ok\":true", "\"ok\":true,\"status\":\"approved\"")
        assertTrue(TvLinkParsing.parseDecision(200, approved, TvDecision.APPROVE) is LinkResult.Ok)
        assertTrue("approved is not a denial", TvLinkParsing.parseDecision(200, approved, TvDecision.DENY) is LinkResult.Refused)
        val denied = lookupBody.replace("\"ok\":true", "\"ok\":true,\"status\":\"denied\"")
        assertTrue(TvLinkParsing.parseDecision(200, denied, TvDecision.DENY) is LinkResult.Ok)
        assertEquals("approve", TvDecision.APPROVE.wire)
        assertEquals("deny", TvDecision.DENY.wire)
    }

    @Test
    fun `link refusals map to errors`() {
        fun err(code: Int, body: String) = (TvLinkParsing.parseLookup(code, body) as LinkResult.Refused).error
        assertEquals(LinkError.INVALID_CODE, err(404, """{"error":"invalid_code"}"""))
        assertEquals(LinkError.UNAUTHORIZED, err(401, """{"error":"unauthorized"}"""))
        assertEquals(LinkError.NOT_ALLOWED, err(403, """{"error":"not_allowed"}"""))
        assertEquals(LinkError.NO_HOME, err(403, """{"error":"no_home"}"""))
        assertEquals(LinkError.PASSWORD_RESET, err(403, """{"error":"password_reset_required"}"""))
        assertEquals(LinkError.UNAVAILABLE, err(404, """{"error":"not_found"}"""))
        assertEquals(LinkError.SERVER, err(500, "boom"))
        val limited = TvLinkParsing.parseLookup(429, """{"error":"too_many_attempts","retry_after":600}""") as LinkResult.Refused
        assertEquals(LinkError.RATE_LIMITED, limited.error)
        assertEquals(600, limited.retryAfterS)
    }

    @Test
    fun `every link error has a message and lockouts say how long`() {
        for (e in LinkError.values()) assertTrue(e.name, TvLinkMessages.forError(e, 60).isNotBlank())
        assertTrue(TvLinkMessages.forError(LinkError.RATE_LIMITED, 900).contains("15 minutes"))
        assertTrue(TvLinkMessages.forError(LinkError.RATE_LIMITED, 1).contains("1 minute "))
    }

    @Test
    fun `request time is coarse`() {
        assertEquals("just now", TvLinkMessages.ago(0))
        assertEquals("1 minute ago", TvLinkMessages.ago(1))
        assertEquals("7 minutes ago", TvLinkMessages.ago(7))
    }
}
