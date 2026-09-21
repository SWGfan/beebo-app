package com.beeboentertainment.movie.campsite

import com.beeboentertainment.movie.campsite.games.CampsiteGameCatalog
import com.beeboentertainment.movie.campsite.games.GameCategory
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CampsiteEntryFlowTest {

    private class Recorder : CampsiteInviteFlow.Effects {
        val calls = mutableListOf<String>()
        override fun startGuestServer() { calls += "server+" }
        override fun stopGuestServer() { calls += "server-" }
        override fun startBeeboWifi() { calls += "wifi+" }
        override fun stopBeeboWifi() { calls += "wifi-" }
    }

    // ---- entry flow -----------------------------------------------------------------

    @Test fun `opening games starts nothing`() {
        val fx = Recorder()
        val flow = CampsiteInviteFlow(fx)
        flow.openGames()
        assertEquals(emptyList<String>(), fx.calls)
        assertFalse(flow.inviting)
        assertNull(flow.wifi)
    }

    @Test fun `invite starts the guest server once and no hotspot`() {
        val fx = Recorder()
        val flow = CampsiteInviteFlow(fx)
        flow.invitePlayers()
        flow.invitePlayers()
        assertEquals(listOf("server+"), fx.calls)
        assertTrue(flow.inviting)
        assertNull(flow.wifi)
    }

    @Test fun `a TV invite starts the guest server on the same Wi-Fi and never a hotspot`() {
        val fx = Recorder()
        val flow = CampsiteInviteFlow(fx)
        flow.invitePlayersOnTv()
        flow.invitePlayersOnTv()
        assertEquals(listOf("server+"), fx.calls)
        assertTrue(flow.inviting)
        assertEquals(WifiChoice.SAME_WIFI, flow.wifi)
        flow.stop()
        assertFalse("wifi+" in fx.calls)
        assertFalse(flow.inviting)
    }

    @Test fun `a TV is offered only the same Wi-Fi, a phone all its ways`() {
        assertEquals(listOf(WifiChoice.SAME_WIFI), CampsiteGameGate.wifiChoicesFor(isTv = true, beeboWifiSupported = true))
        assertEquals(listOf(WifiChoice.SAME_WIFI), CampsiteGameGate.wifiChoicesFor(isTv = true, beeboWifiSupported = false))
        assertEquals(
            listOf(WifiChoice.BEEBO_WIFI, WifiChoice.PHONE_HOTSPOT, WifiChoice.SAME_WIFI),
            CampsiteGameGate.wifiChoicesFor(isTv = false, beeboWifiSupported = true)
        )
        assertEquals(
            listOf(WifiChoice.PHONE_HOTSPOT, WifiChoice.SAME_WIFI),
            CampsiteGameGate.wifiChoicesFor(isTv = false, beeboWifiSupported = false)
        )
    }

    @Test fun `hotspot starts only when the host picks Beebo Wi-Fi`() {
        val fx = Recorder()
        val flow = CampsiteInviteFlow(fx)
        flow.invitePlayers()
        flow.chooseWifi(WifiChoice.PHONE_HOTSPOT)
        flow.chooseWifi(WifiChoice.SAME_WIFI)
        assertFalse("wifi+" in fx.calls)
        flow.chooseWifi(WifiChoice.BEEBO_WIFI)
        assertEquals(listOf("server+", "wifi+"), fx.calls)
    }

    @Test fun `picking a Wi-Fi without inviting first still starts the server before the hotspot`() {
        val fx = Recorder()
        CampsiteInviteFlow(fx).chooseWifi(WifiChoice.BEEBO_WIFI)
        assertEquals(listOf("server+", "wifi+"), fx.calls)
    }

    @Test fun `moving off Beebo Wi-Fi turns it off`() {
        val fx = Recorder()
        val flow = CampsiteInviteFlow(fx)
        flow.chooseWifi(WifiChoice.BEEBO_WIFI)
        flow.chooseWifi(WifiChoice.SAME_WIFI)
        assertEquals(listOf("server+", "wifi+", "wifi-"), fx.calls)
        flow.chooseWifi(WifiChoice.BEEBO_WIFI)
        flow.clearWifiChoice()
        assertEquals(listOf("server+", "wifi+", "wifi-", "wifi+", "wifi-"), fx.calls)
        assertNull(flow.wifi)
        assertTrue(flow.inviting)
    }

    @Test fun `stop releases both the hotspot and the server`() {
        val fx = Recorder()
        val flow = CampsiteInviteFlow(fx)
        flow.chooseWifi(WifiChoice.BEEBO_WIFI)
        fx.calls.clear()
        flow.stop()
        assertEquals(listOf("wifi-", "server-"), fx.calls)
        assertFalse(flow.inviting)
        assertNull(flow.wifi)
    }

    @Test fun `stopping when never invited does not touch the server`() {
        val fx = Recorder()
        CampsiteInviteFlow(fx).stop()
        assertEquals(listOf("wifi-"), fx.calls)
    }

    @Test fun `server stopping elsewhere clears the invite without effects`() {
        val fx = Recorder()
        val flow = CampsiteInviteFlow(fx)
        flow.chooseWifi(WifiChoice.SAME_WIFI)
        fx.calls.clear()
        flow.onServerStopped()
        assertEquals(emptyList<String>(), fx.calls)
        assertFalse(flow.inviting)
        assertNull(flow.wifi)
    }

    @Test fun `only free Wi-Fi choices are restored`() {
        assertEquals(WifiChoice.PHONE_HOTSPOT, WifiChoice.restore("manual"))
        assertEquals(WifiChoice.SAME_WIFI, WifiChoice.restore("same"))
        assertNull(WifiChoice.restore("auto"))
        assertNull(WifiChoice.restore(null))
    }

    // ---- idle stop ------------------------------------------------------------------

    @Test fun `idle stop waits the full grace with nobody there`() {
        val idle = CampsiteIdleStop(graceMs = 1_000)
        assertFalse(idle.shouldStop(0, 0, 0))
        assertFalse(idle.shouldStop(999, 0, 0))
        assertTrue(idle.shouldStop(1_000, 0, 0))
    }

    @Test fun `a guest or a watch session resets the idle clock`() {
        val idle = CampsiteIdleStop(graceMs = 1_000)
        idle.shouldStop(0, 0, 0)
        assertFalse(idle.shouldStop(900, 1, 0))
        assertFalse(idle.shouldStop(1_500, 0, 0))
        assertFalse(idle.shouldStop(2_000, 0, 1))
        assertFalse(idle.shouldStop(2_100, 0, 0))
        assertTrue(idle.shouldStop(3_100, 0, 0))
    }

    // ---- needsGuests gating -------------------------------------------------------

    @Test fun `needsGuests gating offers the right choices`() {
        assertEquals(listOf(GameChoice.PLAY_VS_COMPUTER, GameChoice.INVITE_PLAYERS),
            CampsiteGameGate.choicesFor(needsGuests = false, inviting = false))
        assertEquals(listOf(GameChoice.INVITE_PLAYERS),
            CampsiteGameGate.choicesFor(needsGuests = true, inviting = false))
        assertEquals(listOf(GameChoice.PLAY_WITH_GUESTS),
            CampsiteGameGate.choicesFor(needsGuests = true, inviting = true))
        assertEquals("Needs other phones", CampsiteGameGate.labelFor(true))
        assertEquals("Play vs computer", CampsiteGameGate.labelFor(false))
    }

    @Test fun `the original games have the agreed needsGuests values`() {
        val needs = CampsiteGameCatalog.ALL.filter { it.needsGuests }.map { it.id }.toSet()
        val original = setOf("thisorthat", "wouldyourather", "twentyquestions", "quiet", "picknext")
        // New games may add to this set; none of the original solo-playable games may join it.
        assertTrue(needs.containsAll(original))
        listOf("connect4", "ttt", "checkers", "reversi", "morris", "seabattle", "dominoes",
            "snakesladders", "ludo", "trivia", "rps", "ispy", "bingo", "gofish", "crazy8s",
            "oldmaid", "snap", "war", "pairs", "storybuilder", "categorychains",
        ).forEach { assertFalse(it, CampsiteGameCatalog[it]!!.needsGuests) }
    }

    @Test fun `every solo-playable game has a computer player, except checklists that play alone`() {
        CampsiteGameCatalog.ALL.filter { !it.needsGuests }.forEach { game ->
            val local = CampsiteLocalGames(botClock = false)
            try {
                assertTrue(game.id, local.open(game.id, withComputer = true))
                val room = local.snapshot().getValue("room").jsonObject
                // A game with playsSolo (Plate & Sign Hunt) has nobody to play against, so no computer is seated.
                assertEquals(game.id, if (game.playsSolo) 0 else 1, room.getValue("bots").jsonPrimitive.int)
            } finally { local.close() }
        }
    }

    // ---- categories ---------------------------------------------------------------

    @Test fun `sections follow the category order and sort games alphabetically`() {
        val sections = CampsiteGameGate.sections(CampsiteGameCatalog.ALL)
        val order = sections.map { it.first }
        assertEquals(order, GameCategory.values().filter { it in order })
        sections.forEach { (_, games) ->
            val titles = games.map { it.title }
            assertEquals(titles.sortedWith(String.CASE_INSENSITIVE_ORDER), titles)
        }
        assertEquals(CampsiteGameCatalog.ALL.size, sections.sumOf { it.second.size })
        val cards = CampsiteGameGate.sections(CampsiteGameCatalog.ALL, GameCategory.CARD)
        assertEquals(listOf(GameCategory.CARD), cards.map { it.first })
        assertTrue(cards.single().second.map { it.id }.containsAll(listOf("snap", "gofish", "oldmaid", "war", "crazy8s", "pairs")))
        assertEquals(GameCategory.OUTDOORS, CampsiteGameCatalog["ispy"]!!.category)
        assertEquals(GameCategory.WORD_AND_TALK, CampsiteGameCatalog["storybuilder"]!!.category)
    }

    // ---- the offline engine -------------------------------------------------------

    @Test fun `local games answer the page through the bridge shape`() {
        val local = CampsiteLocalGames(botClock = false)
        try {
            val reply = Json.parseToJsonElement(local.get()).jsonObject
            assertEquals(200, reply.getValue("status").jsonPrimitive.int)
            val body = Json.parseToJsonElement(reply.getValue("body").jsonPrimitive.content).jsonObject
            assertTrue(body.getValue("games").jsonArray.isNotEmpty())

            val bad = Json.parseToJsonElement(local.post("not json")).jsonObject
            assertEquals(400, bad.getValue("status").jsonPrimitive.int)

            val entered = Json.parseToJsonElement(
                local.post("""{"action":"enter","game":"connect4","actionId":"x1","round":0}"""),
            ).jsonObject
            assertEquals(200, entered.getValue("status").jsonPrimitive.int)
            val room = (Json.parseToJsonElement(entered.getValue("body").jsonPrimitive.content) as JsonObject)
                .getValue("room").jsonObject
            assertEquals("connect4", room.getValue("game").jsonPrimitive.content)
        } finally { local.close() }
    }

    @Test fun `the page shim is injected before the page's own script`() {
        val html = "<html><head><title>x</title></head><body><script>fetch('/api/games')</script></body></html>"
        val page = CampsiteLocalGames.page(html)
        val shim = page.indexOf(CampsiteLocalGames.BRIDGE)
        assertTrue(shim in 0 until page.indexOf("fetch('/api/games')"))
        assertTrue(page.indexOf("</head>") > shim)
    }
}
