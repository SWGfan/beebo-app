package com.beeboentertainment.movie.watchtogether

import com.beeboentertainment.movie.data.ApiClient
import com.beeboentertainment.movie.server.FakeServer
import com.beeboentertainment.movie.server.ServerException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private val J = ApiClient.JSON
private const val CODE = "0123456789ABCDEFGHJKMNPQRS" // 26 Crockford characters

private fun playing(pos: Double = 10.0, at: Double = 1_000.0, rate: Double = 1.0, seq: Long = 2) =
    WtTimeline("playing", pos, at, rate, seq)

private fun paused(pos: Double = 10.0, seq: Long = 1) = WtTimeline("paused", pos, 0.0, 1.0, seq)

class WtSyncTest {

    @Test fun `position runs from the anchor while playing and stays put while paused`() {
        val tl = playing(pos = 10.0, at = 1_000.0)
        assertEquals(10.0, WtSync.positionAt(tl, 500.0), 1e-9)          // before the start
        assertEquals(10.0, WtSync.positionAt(tl, 1_000.0), 1e-9)
        assertEquals(15.0, WtSync.positionAt(tl, 6_000.0), 1e-9)
        assertEquals(20.0, WtSync.positionAt(playing(10.0, 1_000.0, 2.0), 6_000.0), 1e-9)
        assertEquals(10.0, WtSync.positionAt(paused(10.0), 99_999.0), 1e-9)
        assertEquals(0.0, WtSync.positionAt(null, 1.0), 0.0)
        assertEquals(15.0, WtSync.positionAt(playing(10.0, 1_000.0, rate = 0.0), 6_000.0), 1e-9)
    }

    @Test fun `a start in the future is pending until its time`() {
        val tl = playing(at = 5_000.0)
        assertFalse(WtSync.isRunning(tl, 4_999.0))
        assertTrue(WtSync.isRunning(tl, 5_000.0))
        assertFalse(WtSync.isRunning(paused(), 9_999.0))
    }

    @Test fun `clock offset is the NTP formula`() {
        // The viewer's clock is 500 ms behind the server's; each leg takes 40 ms.
        val s = WtSync.offsetSample(t0 = 1_000.0, t1 = 1_540.0, t2 = 1_541.0, t3 = 1_081.0)
        assertEquals(500.0, s.offset, 1e-9)
        assertEquals(80.0, s.rtt, 1e-9)
    }

    @Test fun `the lowest round trip wins and junk is ignored`() {
        val best = WtSync.bestOffset(
            listOf(WtSync.Sample(900.0, 300.0), WtSync.Sample(500.0, 40.0), WtSync.Sample(Double.NaN, 5.0), WtSync.Sample(1.0, -3.0), WtSync.Sample(2.0, 9_000.0)),
            null
        )!!
        assertEquals(500.0, best.offset, 0.0); assertEquals(40.0, best.rtt, 0.0)
        assertNull(WtSync.bestOffset(emptyList(), null))
        assertNull(WtSync.bestOffset(listOf(WtSync.Sample(1.0, -1.0)), 0.0))
    }

    @Test fun `a small change is smoothed in and a big one taken at once`() {
        assertEquals(518.0, WtSync.bestOffset(listOf(WtSync.Sample(560.0, 10.0)), 500.0)!!.offset, 0.001)
        assertEquals(5_000.0, WtSync.bestOffset(listOf(WtSync.Sample(5_000.0, 10.0)), 500.0)!!.offset, 0.001)
    }

    @Test fun `drift under 0_08 s is left alone, a nudge is small and capped, 1_5 s or more seeks`() {
        assertEquals(WtSync.Drift.NONE, WtSync.driftPlan(0.05, 1.0, false).action)
        val n = WtSync.driftPlan(0.5, 1.0, false)          // 0.5 s ahead: slow down by err/2.5 = 20 %, capped at 5 %
        assertEquals(WtSync.Drift.NUDGE, n.action); assertEquals(0.95, n.rate, 1e-9); assertTrue(n.nudging)
        val behind = WtSync.driftPlan(-0.2, 1.0, false)     // behind: speed up 8 %, capped at 5 %
        assertEquals(1.05, behind.rate, 1e-9)
        val small = WtSync.driftPlan(0.1, 1.0, false)       // 0.1 / 2.5 = 4 %
        assertEquals(0.96, small.rate, 1e-9)
        assertEquals(WtSync.Drift.SEEK, WtSync.driftPlan(1.5, 1.0, false).action)
        assertEquals(WtSync.Drift.SEEK, WtSync.driftPlan(-3.0, 1.0, true).action)
        assertEquals(WtSync.Drift.NONE, WtSync.driftPlan(Double.NaN, 1.0, true).action)
    }

    @Test fun `a nudge that has started keeps going until the error is under 0_03 s`() {
        assertEquals(WtSync.Drift.NUDGE, WtSync.driftPlan(0.05, 1.0, nudging = true).action)   // under engage, but already nudging
        assertEquals(WtSync.Drift.NONE, WtSync.driftPlan(0.02, 1.0, nudging = true).action)
        assertEquals(WtSync.Drift.NONE, WtSync.driftPlan(0.05, 1.0, nudging = false).action)
    }

    @Test fun `nudging is relative to the room's speed`() {
        val p = WtSync.driftPlan(0.1, 2.0, false)
        assertEquals(1.92, p.rate, 1e-9)
    }

    private fun view(now: Double, cur: Double, paused: Boolean = false, rate: Double = 1.0, ready: Boolean = true, seeking: Boolean = false, nudging: Boolean = false) =
        WtSync.PlayerView(now, cur, paused, rate, ready, seeking, nudging)

    @Test fun `a paused room pauses the player and puts it on the anchor`() {
        val plan = WtSync.reconcile(paused(30.0), view(5_000.0, cur = 12.0, paused = false, rate = 1.5))
        assertEquals(WtSync.Phase.PAUSED, plan.phase)
        assertEquals(listOf(WtSync.Action.Pause, WtSync.Action.Seek(30.0), WtSync.Action.Rate(1.0)), plan.actions)
        assertTrue(WtSync.reconcile(paused(30.0), view(5_000.0, cur = 30.1, paused = true)).actions.isEmpty())
    }

    @Test fun `a scheduled start waits on the anchor, ready to go`() {
        val plan = WtSync.reconcile(playing(pos = 20.0, at = 10_000.0), view(9_500.0, cur = 20.0, paused = true))
        assertEquals(WtSync.Phase.PENDING, plan.phase)
        assertTrue(plan.actions.isEmpty())
        assertTrue(plan.inSync)
    }

    @Test fun `a running room starts a paused player, seeking first when far away`() {
        val tl = playing(pos = 100.0, at = 1_000.0)
        val plan = WtSync.reconcile(tl, view(11_000.0, cur = 0.0, paused = true))   // room is 10 s in: 110 s
        assertEquals(WtSync.Phase.PLAYING, plan.phase)
        assertEquals(WtSync.Action.Seek(110.25), plan.actions[0])
        assertEquals(WtSync.Action.Play, plan.actions[1])
        assertFalse(plan.inSync)
    }

    @Test fun `a player in step is left alone and a slightly ahead one is slowed`() {
        val tl = playing(pos = 100.0, at = 1_000.0)
        assertTrue(WtSync.reconcile(tl, view(11_000.0, cur = 110.02)).actions.isEmpty())
        val ahead = WtSync.reconcile(tl, view(11_000.0, cur = 110.4))
        assertTrue(ahead.nudging)
        assertEquals(0.95, (ahead.actions.single() as WtSync.Action.Rate).rate, 1e-9)
    }

    @Test fun `a player that is buffering is not corrected yet`() {
        val tl = playing(pos = 100.0, at = 1_000.0)
        val plan = WtSync.reconcile(tl, view(11_000.0, cur = 50.0, ready = false))
        assertTrue(plan.actions.isEmpty())
        assertEquals(WtSync.Phase.PLAYING, plan.phase)
    }

    @Test fun `an unknown room does nothing`() {
        assertTrue(WtSync.reconcile(null, view(0.0, 0.0)).actions.isEmpty())
    }
}

class WtProtocolTest {

    @Test fun `codes are normalized like the server does`() {
        assertEquals(CODE, WtProtocol.normalizeCode(CODE.lowercase()))
        assertEquals(CODE, WtProtocol.normalizeCode(" " + CODE.substring(0, 13) + "-" + CODE.substring(13) + " "))
        // Crockford look-alikes: O is 0, I and L are 1.
        assertEquals("00000000000000000000000000", WtProtocol.normalizeCode("OOOOOOOOOOOOOOOOOOOOOOOOOO"))
        assertEquals("11111111111111111111111111", WtProtocol.normalizeCode("IIIIIIIIIILLLLLLLLLLllllll"))
        assertNull(WtProtocol.normalizeCode("SHORT"))
        assertNull(WtProtocol.normalizeCode("U".repeat(26)))   // U is not in the alphabet
        assertNull(WtProtocol.normalizeCode(null))
        assertNull(WtProtocol.normalizeCode(CODE + "0".repeat(60)))
    }

    @Test fun `an invite can be a link, a player link, a link with the code after a hash, or the bare code`() {
        assertEquals(CODE, WtProtocol.codeFromInvite("https://home.beebo.tv/watch-together/join?code=$CODE"))
        assertEquals(CODE, WtProtocol.codeFromInvite("http://192.168.1.5:47811/watch?id=abc&wt=$CODE"))
        assertEquals(CODE, WtProtocol.codeFromInvite("https://x.example/join#code=$CODE"))
        assertEquals(CODE, WtProtocol.codeFromInvite("Join me: https://h.example/watch-together/join?code=${CODE.lowercase()}&x=1"))
        assertEquals(CODE, WtProtocol.codeFromInvite("  $CODE  "))
        assertNull(WtProtocol.codeFromInvite("https://h.example/watch-together/join?code=nope"))
        assertNull(WtProtocol.codeFromInvite("hello"))
        assertNull(WtProtocol.codeFromInvite(""))
        assertNull(WtProtocol.codeFromInvite("x".repeat(3000)))
    }

    @Test fun `the invite link the host shares is built from the app's own address`() {
        assertEquals("https://home.example/watch-together/join?code=$CODE", WtProtocol.inviteUrl("home.example/", CODE))
        assertNull(WtProtocol.inviteUrl("home.example", "bad"))
        assertNull(WtProtocol.inviteUrl(null, CODE))
    }

    @Test fun `the event stream is parsed line by line`() {
        val p = WtProtocol.SseParser()
        val out = mutableListOf<WtProtocol.SseEvent>()
        val raw = "retry: 3000\n\n: hb\n\nid: 7\nevent: chat\ndata: {\"a\":1}\n\nevent: state\ndata: line1\ndata: line2\n\n"
        raw.split("\n").dropLast(1).forEach { line -> p.feed(line)?.let { out += it } }
        assertEquals(2, out.size)
        assertEquals(WtProtocol.SseEvent("chat", "{\"a\":1}", "7"), out[0])
        assertEquals("line1\nline2", out[1].data)
        assertEquals("7", p.lastEventId)
    }

    @Test fun `bad ids and long event names are contained`() {
        val p = WtProtocol.SseParser()
        p.feed("id: abc"); p.feed("event: ${"x".repeat(80)}"); p.feed("data: {}")
        val e = p.feed("")!!
        assertNull(e.id)
        assertEquals(31, e.event.length)
        assertNull(p.lastEventId)
    }

    @Test fun `server events decode and anything malformed or unknown is dropped`() {
        val room = """{"code":"$CODE","roomId":"3fa9c1d2","media":{"kind":"movie","id":"abc","title":"T","href":"/watch?id=abc"},"settings":{"control":"host","waitForBuffering":true,"chat":true},
            "timeline":{"state":"paused","anchorPos":0,"anchorAt":1790000000000.5,"rate":1,"seq":1},"hold":null,"hostPid":"h1","duration":0,
            "participants":[{"pid":"h1","name":"Sam","color":"#e57373","initial":"S","role":"host","ready":true,"buffering":false,"connected":true}],"serverNow":1790000000123.4,"eventSeq":3,"you":"h1"}"""
        val s = WtProtocol.decode(WtProtocol.SseEvent("state", room, "3")) as WtProtocol.Event.State
        assertEquals("Sam", s.room.participants.single().name)
        assertEquals("h1", s.room.you)
        assertEquals(1790000000000.5, s.room.timeline.anchorAt, 0.0)
        val c = WtProtocol.decode(WtProtocol.SseEvent("chat", """{"id":1,"pid":"h1","name":"Sam","color":"#fff","initial":"S","text":"hi","at":5,"eventId":4}""", "4")) as WtProtocol.Event.Chat
        assertEquals("hi", c.message.text)
        assertTrue(WtProtocol.decode(WtProtocol.SseEvent("reaction", """{"pid":"h1","name":"Sam","emoji":"🔥"}""", null)) is WtProtocol.Event.Reaction)
        assertTrue(WtProtocol.decode(WtProtocol.SseEvent("media", """{"media":{"kind":"tv","id":"e2","title":"Next","href":"/tvwatch?id=e2"},"by":"h1"}""", null)) is WtProtocol.Event.Media)
        assertEquals("closed_by_host", (WtProtocol.decode(WtProtocol.SseEvent("closed", """{"reason":"closed_by_host"}""", null)) as WtProtocol.Event.Closed).reason)
        assertTrue(WtProtocol.decode(WtProtocol.SseEvent("kicked", """{"reason":"removed_by_host"}""", null)) is WtProtocol.Event.Kicked)
        assertNull(WtProtocol.decode(WtProtocol.SseEvent("state", "{not json", null)))
        assertNull(WtProtocol.decode(WtProtocol.SseEvent("surprise", "{}", null)))
    }

    @Test fun `people are described with their role and readiness`() {
        val sam = WtParticipant("h1", "Sam", "#fff", "S", "host", ready = true)
        assertEquals("Sam (you) · host, ready", WtProtocol.participantLine(sam, true))
        assertEquals("Alex · buffering", WtProtocol.participantLine(WtParticipant("g", "Alex", role = "guest", buffering = true), false))
        assertEquals("Alex · away", WtProtocol.participantLine(WtParticipant("g", "Alex", connected = false), false))
        assertEquals("Guest", WtProtocol.participantLine(WtParticipant("g", " "), false))
        assertEquals("A B", WtProtocol.participantLine(WtParticipant("g", "A‮B"), false))
    }

    @Test fun `the hold line says who the room is waiting for`() {
        assertNull(WtProtocol.holdLine(null))
        assertEquals("Waiting for Sam to buffer…", WtProtocol.holdLine(WtHold("buffering", true, listOf("Sam"))))
        assertEquals("Waiting for Sam, Alex to catch up…", WtProtocol.holdLine(WtHold("seek", true, listOf("Sam", "Alex"))))
        assertEquals("Waiting for someone to buffer…", WtProtocol.holdLine(WtHold("buffering", true, emptyList())))
    }

    @Test fun `who may control the room`() {
        val room = WtRoom(hostPid = "h", settings = WtSettings(control = "host"))
        assertTrue(WtProtocol.canControl(room, "h"))
        assertFalse(WtProtocol.canControl(room, "g"))
        assertTrue(WtProtocol.canControl(room.copy(settings = WtSettings(control = "everyone")), "g"))
        assertFalse(WtProtocol.canControl(room, null))
        assertTrue(WtProtocol.isHost(room, "h")); assertFalse(WtProtocol.isHost(room, "g"))
    }

    @Test fun `outgoing chat is cleaned, capped and never empty`() {
        assertEquals("hello there", WtProtocol.cleanOutgoing("  hello‮ there "))
        assertNull(WtProtocol.cleanOutgoing("   "))
        assertNull(WtProtocol.cleanOutgoing(null))
        assertEquals(300, WtProtocol.cleanOutgoing("x".repeat(500))!!.length)
    }

    @Test fun `chat is de-duplicated by event id and kept to the newest`() {
        val a = WtChat(id = 1, pid = "p", eventId = 10, text = "a")
        var list = WtProtocol.addChat(emptyList(), a)
        list = WtProtocol.addChat(list, a)
        list = WtProtocol.addChat(list, WtChat(id = 1, pid = "p", eventId = 0, text = "again"))
        assertEquals(1, list.size)
        for (i in 2..150) list = WtProtocol.addChat(list, WtChat(id = i.toLong(), pid = "p", eventId = 10L + i, text = "m$i"))
        assertEquals(100, list.size)
        assertEquals("m150", list.last().text)
    }

    @Test fun `titles are only sent when they look like the library's own ids`() {
        assertTrue(WtProtocol.isSafeMediaId("aGVsbG8tX3dvcmxk"))
        assertFalse(WtProtocol.isSafeMediaId("../etc/passwd"))
        assertFalse(WtProtocol.isSafeMediaId("a b"))
        assertFalse(WtProtocol.isSafeMediaId(""))
        assertFalse(WtProtocol.isSafeMediaId("a".repeat(701)))
        assertTrue(WtProtocol.isMediaKind("tv")); assertFalse(WtProtocol.isMediaKind("music"))
    }

    @Test fun `refusals are in plain words and server text is cleaned`() {
        assertEquals("That room has ended, or the link is not valid.", WtProtocol.message("not_found", null))
        assertEquals("Only the host can do that in this room.", WtProtocol.message("not_allowed", "x"))
        assertEquals("Custom", WtProtocol.message("mystery", "Cus‮tom".replace("‮", "")))
        assertEquals("That didn't work.", WtProtocol.message("mystery", null))
        assertEquals(8, WtProtocol.REACTIONS.size)
        assertTrue(1.5 in WtProtocol.RATES && 3.0 !in WtProtocol.RATES)
    }
}

private class FakePlayer : WtPlayerPort {
    var pos = 0.0; var paused = true; var speed = 1.0; var ready = true; var duration = 3600.0
    val log = mutableListOf<String>()
    override fun positionSec() = pos
    override fun isPaused() = paused
    override fun rate() = speed
    override fun isReady() = ready
    override fun durationSec() = duration
    override fun play() { paused = false; log += "play" }
    override fun pause() { paused = true; log += "pause" }
    override fun seekToSec(sec: Double) { pos = sec; log += "seek ${"%.2f".format(java.util.Locale.US, sec)}" }
    override fun setRate(rate: Double) { speed = rate; log += "rate ${"%.2f".format(java.util.Locale.US, rate)}" }
}

private class FakeSink : WtSink {
    val commands = mutableListOf<String>()
    val readies = mutableListOf<Triple<Boolean, Long, Double>>()
    override fun command(type: String, pos: Double?, rate: Double?) { commands += type + (pos?.let { " %.1f".format(java.util.Locale.US, it) } ?: "") + (rate?.let { " r$it" } ?: "") }
    override fun ready(ready: Boolean, appliedSeq: Long, durationSec: Double) { readies += Triple(ready, appliedSeq, durationSec) }
}

class WtEngineTest {
    private var now = 100_000.0
    private val player = FakePlayer()
    private val sink = FakeSink()
    private val engine = WtEngine(player, sink) { now }

    private fun start(tl: WtTimeline, offset: Double = 0.0, control: Boolean = false) {
        engine.setOffset(offset); engine.canControl = control; engine.onTimeline(tl)
    }

    @Test fun `nothing happens until the clock offset is known`() {
        engine.onTimeline(playing(0.0, 99_000.0))
        assertNull(engine.tick())
        assertTrue(player.log.isEmpty())
    }

    @Test fun `joining a running room catches up by seeking to where it is now and playing`() {
        // Room started at server time 90_000 from 0 s: at 100_000 it is 10 s in. The viewer's clock is 500 ms behind the server's.
        start(playing(pos = 0.0, at = 90_000.0, seq = 5), offset = 500.0)
        player.paused = true; player.pos = 0.0
        engine.tick()
        assertEquals(listOf("seek 10.75", "play"), player.log)
    }

    @Test fun `a paused room keeps the player paused on the anchor`() {
        start(paused(42.0))
        player.paused = false; player.pos = 40.0
        engine.tick()
        assertEquals(listOf("pause", "seek 42.00"), player.log)
    }

    @Test fun `small drift is corrected with speed, not a seek, and stops when close`() {
        start(playing(pos = 0.0, at = 90_000.0))   // expected 10.0 s
        player.paused = false; player.pos = 10.3
        engine.tick()
        assertEquals(listOf("rate 0.95"), player.log)
        player.log.clear(); player.pos = 10.01
        engine.tick()
        assertEquals(listOf("rate 1.00"), player.log)
    }

    @Test fun `big drift is a seek`() {
        start(playing(pos = 0.0, at = 90_000.0))
        player.paused = false; player.pos = 3.0
        engine.tick()
        assertEquals(1, player.log.size)
        assertTrue(player.log[0].startsWith("seek 10.25"))
    }

    @Test fun `readiness is reported once per change and carries the seq that was applied`() {
        start(paused(0.0, seq = 3))
        player.paused = true; player.pos = 0.0
        engine.tick(); engine.tick()
        assertEquals(listOf(Triple(true, 3L, 3600.0)), sink.readies)
        player.ready = false
        engine.tick()
        assertEquals(false, sink.readies.last().first)
        engine.onTimeline(paused(0.0, seq = 4))
        player.ready = true
        engine.tick()
        assertEquals(Triple(true, 4L, 3600.0), sink.readies.last())
    }

    @Test fun `an older state never replaces a newer one`() {
        engine.onTimeline(paused(5.0, seq = 9))
        engine.onTimeline(paused(1.0, seq = 8))
        assertEquals(9L, engine.timeline!!.seq)
        engine.onTimeline(paused(7.0, seq = 10))
        assertEquals(7.0, engine.timeline!!.anchorPos, 0.0)
    }

    @Test fun `the host's own pause and play become commands`() {
        start(playing(pos = 0.0, at = 90_000.0), control = true)
        assertTrue(engine.onLocalPlayWhenReady(false, 12.5))
        assertEquals(listOf("pause 12.5"), sink.commands)
        // While the room has not answered yet the person's press is not undone.
        player.paused = true; player.pos = 12.5
        assertNull(engine.tick())
        assertTrue(player.log.isEmpty())
        // The room's answer arrives: paused. The hold is released and it agrees.
        engine.onTimeline(paused(12.5, seq = 3))
        engine.tick()
        assertTrue(player.log.isEmpty())
    }

    @Test fun `pressing play when the room is already playing sends nothing`() {
        start(playing(pos = 0.0, at = 90_000.0), control = true)
        assertFalse(engine.onLocalPlayWhenReady(true, 10.0))
        assertTrue(sink.commands.isEmpty())
    }

    @Test fun `someone who may not control the room cannot change it, and the next beat undoes the press`() {
        start(playing(pos = 0.0, at = 90_000.0), control = false)
        assertFalse(engine.onLocalPlayWhenReady(false, 10.0))
        assertFalse(engine.onLocalSeek(500.0))
        assertFalse(engine.onLocalRate(1.5))
        assertTrue(sink.commands.isEmpty())
        player.paused = true; player.pos = 10.0
        engine.tick()
        assertTrue(player.log.contains("play"))
    }

    @Test fun `a real seek by a controller is sent, a wobble is not`() {
        start(playing(pos = 0.0, at = 90_000.0), control = true)   // expected 10 s
        assertFalse(engine.onLocalSeek(10.8))
        assertTrue(engine.onLocalSeek(300.0))
        assertEquals(listOf("seek 300.0"), sink.commands)
    }

    @Test fun `what the engine does itself is never sent back as a command`() {
        start(paused(30.0), control = true)
        player.paused = false; player.pos = 5.0
        engine.tick()                                   // pauses and seeks the player itself
        assertTrue(player.log.isNotEmpty())
        assertFalse(engine.onLocalPlayWhenReady(false, 30.0))
        assertFalse(engine.onLocalSeek(30.0))
        assertTrue(sink.commands.isEmpty())
        now += 2_000.0                                  // a moment later a genuine press counts again
        start(playing(pos = 30.0, at = now, seq = 8), control = true)
        assertTrue(engine.onLocalPlayWhenReady(false, 31.0))
    }

    @Test fun `changing a title is not a press`() {
        start(paused(0.0), control = true)
        engine.suppressLocal(3_000.0)
        assertFalse(engine.onLocalPlayWhenReady(true, 0.0))
    }

    @Test fun `speed is only sent for a rate the server accepts and one that differs`() {
        start(paused(0.0), control = true)
        assertTrue(engine.onLocalRate(1.5))
        assertFalse(engine.onLocalRate(3.0))
        assertFalse(engine.onLocalRate(1.0))
        assertEquals(listOf("rate r1.5"), sink.commands)
    }
}

class WtClientTest {
    private fun clientFor(server: FakeServer) = WtClient(server.json(), server.client, { "https://home.example" }, { "tok" })

    private val joined = """{"ok":true,"pid":"p1","room":{"code":"$CODE","media":{"kind":"movie","id":"abc","title":"T","href":"/watch?id=abc"},"timeline":{"state":"paused","anchorPos":0,"anchorAt":1,"rate":1,"seq":1},"hostPid":"p1","participants":[]},"chat":[],"catchUp":{"position":12.5,"running":true}}"""

    @Test fun `ping is a post with the client's clock`() = runBlocking {
        val fake = FakeServer { 200 to """{"ok":true,"t0":5,"t1":6,"t2":7}""" }
        val r = clientFor(fake).ping(5.0)
        assertEquals(6.0, r.t1, 0.0)
        assertEquals("POST /api/watch-together/ping", fake.requests.single().method + " " + fake.requests.single().url.encodedPath)
        assertEquals("""{"t0":5.0}""", fake.bodies.single())
    }

    @Test fun `join and create use the documented routes and bodies`() = runBlocking {
        val fake = FakeServer { 200 to joined }
        val c = clientFor(fake)
        val r = c.join(CODE)
        assertEquals("p1", r.pid)
        assertTrue(r.catchUp!!.running)
        c.create("tv", "e1", "Show - Ep", control = "everyone")
        assertEquals(listOf("/api/watch-together/join", "/api/watch-together/create"), fake.requests.map { it.url.encodedPath })
        assertEquals("""{"code":"$CODE"}""", fake.bodies[0])
        assertEquals("""{"kind":"tv","id":"e1","title":"Show - Ep","settings":{"control":"everyone"}}""", fake.bodies[1])
    }

    @Test fun `the code goes in the query only for the preview, the poll and the stream`() = runBlocking {
        val fake = FakeServer { 200 to """{"ok":true,"media":{"kind":"movie","id":"a","title":"T","href":""},"hostName":"Sam","count":2,"room":{},"chat":[]}""" }
        val c = clientFor(fake)
        assertEquals("Sam", c.preview(CODE).hostName)
        c.poll(CODE, "12")
        assertEquals(CODE, fake.requests[0].url.queryParameter("code"))
        assertEquals("GET", fake.requests[0].method)
        assertEquals("12", fake.requests[1].url.queryParameter("since"))
    }

    @Test fun `commands carry a retry id, and ready reports the applied seq`() = runBlocking {
        val fake = FakeServer { 200 to """{"ok":true,"timeline":{"state":"playing","anchorPos":1,"anchorAt":2,"rate":1,"seq":4}}""" }
        val c = clientFor(fake)
        val ack = c.command(CODE, "seek", 12.5, null, "cid123")
        assertEquals(4L, ack.timeline!!.seq)
        c.ready(CODE, true, 4, 3600.0)
        c.chat(CODE, "hi"); c.react(CODE, "🔥")
        c.settings(CODE, control = "everyone", waitForBuffering = null)
        assertEquals("""{"code":"$CODE","type":"seek","cid":"cid123","pos":12.5}""", fake.bodies[0])
        assertEquals("""{"code":"$CODE","ready":true,"seq":4,"duration":3600.0}""", fake.bodies[1])
        assertEquals("""{"code":"$CODE","text":"hi"}""", fake.bodies[2])
        assertEquals("""{"code":"$CODE","emoji":"🔥"}""", fake.bodies[3])
        assertEquals("""{"code":"$CODE","settings":{"control":"everyone"}}""", fake.bodies[4])
    }

    @Test fun `host controls use transfer, kick and close`() = runBlocking {
        val fake = FakeServer { 200 to """{"ok":true}""" }
        val c = clientFor(fake)
        c.transfer(CODE, "p2"); c.kick(CODE, "p3"); c.close(CODE); c.leave(CODE)
        assertEquals(
            listOf("/api/watch-together/transfer", "/api/watch-together/kick", "/api/watch-together/close", "/api/watch-together/leave"),
            fake.requests.map { it.url.encodedPath }
        )
        assertEquals("""{"code":"$CODE","target":"p2"}""", fake.bodies[0])
    }

    @Test fun `a room that has ended is a refusal with its own words`() = runBlocking {
        val fake = FakeServer { 404 to """{"ok":false,"error":"not_found","message":"That room has ended, or the link is not valid."}""" }
        try { clientFor(fake).join(CODE); org.junit.Assert.fail() } catch (e: ServerException) {
            assertEquals("not_found", e.code)
            assertEquals("That room has ended, or the link is not valid.", WtProtocol.message(e.code, e.message))
        }
    }

    @Test fun `too many wrong codes is a lock`() = runBlocking {
        val fake = FakeServer { 429 to """{"ok":false,"error":"locked","minutesRemaining":5,"message":"Too many wrong codes."}""" }
        try { clientFor(fake).preview(CODE); org.junit.Assert.fail() } catch (e: ServerException) {
            assertEquals(429, e.status)
            assertEquals("Too many wrong codes. Try again in a few minutes.", WtProtocol.message(e.code, e.message))
        }
    }

    @Test fun `the event stream sends the token as a header and replays from the last id`() = runBlocking {
        val body = "retry: 3000\n\nid: 1\nevent: state\ndata: {\"code\":\"x\"}\n\n: hb\n\nid: 2\nevent: chat\ndata: {\"id\":1,\"pid\":\"p\",\"name\":\"S\",\"text\":\"hi\",\"eventId\":2}\n\n"
        val fake = FakeServer { 200 to body }
        val events = mutableListOf<WtProtocol.SseEvent>()
        clientFor(fake).events(CODE, "1").collect { events += it }
        assertEquals(listOf("state", "chat"), events.map { it.event })
        assertEquals("Bearer tok", fake.requests.single().header("Authorization"))
        assertEquals("1", fake.requests.single().header("Last-Event-ID"))
        assertEquals("text/event-stream", fake.requests.single().header("Accept"))
        assertEquals("/api/watch-together/events", fake.requests.single().url.encodedPath)
        assertNotNull(events[1].id)
    }

    @Test fun `a stream refused because the person was removed ends with the server's reason`() = runBlocking {
        val fake = FakeServer { 404 to """{"ok":false,"error":"not_found"}""" }
        try { clientFor(fake).events(CODE, null).collect { }; org.junit.Assert.fail() } catch (e: ServerException) {
            assertEquals(404, e.status)
        }
    }
}

class WtModelsTest {
    @Test fun `a join answer with a catch-up position decodes`() {
        val r = J.decodeFromString(
            WtJoinResponse.serializer(),
            """{"ok":true,"pid":"p1","room":{"code":"$CODE","roomId":"r","media":{"kind":"tv","id":"e","title":"T","href":"/tvwatch?id=e"},"settings":{"control":"host","waitForBuffering":true,"chat":true},"timeline":{"state":"playing","anchorPos":10,"anchorAt":1790000000600,"rate":1,"seq":7},"hold":{"reason":"buffering","resume":true,"waitingFor":["Sam"]},"hostPid":"p1","duration":3600,"participants":[],"serverNow":1790000000000,"eventSeq":9},
               "chat":[{"id":1,"pid":"p1","name":"Sam","color":"#e57373","initial":"S","text":"hi","at":1,"eventId":8}],"catchUp":{"position":10.4,"running":false}}"""
        )
        assertEquals(7L, r.room.timeline.seq)
        assertEquals("Sam", r.room.hold!!.waitingFor.single())
        assertEquals(10.4, r.catchUp!!.position, 0.0)
        assertEquals(1, r.chat.size)
    }

    @Test fun `an old server's 404 body is not mistaken for a ping answer`() {
        val p = J.decodeFromString(WtPing.serializer(), """{"ok":false,"error":"not_found"}""")
        assertFalse(p.ok)
    }

    @Test fun `avatar colours are only accepted as six hex digits`() {
        // (checked through the same rule the panel uses)
        assertTrue(Regex("^#([0-9a-fA-F]{6})$").matches("#e57373"))
        assertFalse(Regex("^#([0-9a-fA-F]{6})$").matches("red; background:url(x)"))
    }
}
