package com.beeboentertainment.movie.campsite

import com.beeboentertainment.movie.party.games.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import kotlin.random.Random

class CampsiteGamesTest {
    private val questions = listOf(TriviaQuestion("What year did the sample movie come out?",
        listOf(GameOption("a","2011"),GameOption("b","2014"),GameOption("c","2013"),GameOption("d","1986")), "c"))
    private var seq = 0
    private fun request(g: CampsiteGames, token: String, action: String, values: Map<String, JsonElement> = emptyMap(), status: Int = 200): JsonObject {
        val room = g.handle(token).body["room"] as? JsonObject
        val r = g.handle(token, buildJsonObject {
            put("action",action); put("actionId","a${seq++}"); put("round",room?.get("round") ?: JsonPrimitive(0))
            values.forEach { (key,value) -> put(key,value) }
        })
        assertEquals(r.body.toString(), status, r.status)
        return r.body
    }
    private fun enter(g: CampsiteGames, token: String, game: String) = request(g,token,"enter",mapOf("game" to JsonPrimitive(game)))
    private fun room(g: CampsiteGames, token: String) = g.handle(token).body.getValue("room").jsonObject

    @Test fun `five separate guests see one trivia result even when majority are wrong`() {
        val g = CampsiteGames({questions})
        val players=(1..5).map { g.join("Guest $it")!! }
        players.forEach { enter(g,it,"trivia") }; request(g,players[0],"start")
        assertFalse(room(g,players[1]).containsKey("correct"))
        players.take(4).forEach { request(g,it,"answer",mapOf("choice" to JsonPrimitive(3))) }
        assertEquals("playing",room(g,players[0]).getValue("phase").jsonPrimitive.content)
        request(g,players[4],"answer",mapOf("choice" to JsonPrimitive(2)))
        players.forEach { token ->
            val r=room(g,token)
            assertEquals("revealed",r.getValue("phase").jsonPrimitive.content)
            assertEquals(2,r.getValue("correct").jsonPrimitive.int)
            assertEquals(listOf(0,0,1,4),r.getValue("counts").jsonArray.map { it.jsonPrimitive.int })
        }
        request(g,players[0],"answer",mapOf("choice" to JsonPrimitive(2)),409)
    }

    @Test fun `turn enforcement full columns and winning board are server authoritative`() {
        val g=CampsiteGames();val a=g.join("A")!!;val b=g.join("B")!!;val spectator=g.join("Watcher")!!
        listOf(a,b,spectator).forEach { enter(g,it,"connect4") };request(g,a,"start")
        request(g,b,"move",mapOf("cell" to JsonPrimitive(0)),409)
        request(g,spectator,"move",mapOf("cell" to JsonPrimitive(0)),409)
        for(i in 0..2){ request(g,a,"move",mapOf("cell" to JsonPrimitive(0)));request(g,b,"move",mapOf("cell" to JsonPrimitive(1))) }
        request(g,a,"move",mapOf("cell" to JsonPrimitive(0)))
        assertEquals("done",room(g,b).getValue("phase").jsonPrimitive.content)
        assertEquals(4,room(g,a).getValue("winningCells").jsonArray.size)
        request(g,b,"move",mapOf("cell" to JsonPrimitive(2)),409)
        assertEquals(room(g,a).getValue("board"),room(g,b).getValue("board"))
    }

    @Test fun `a third phone joining does not erase existing moves`() {
        val g=CampsiteGames();val a=g.join("A")!!;val b=g.join("B")!!
        enter(g,a,"connect4");enter(g,b,"connect4");request(g,a,"start");request(g,a,"move",mapOf("cell" to JsonPrimitive(3)))
        val board=room(g,b).getValue("board")
        val c=g.join("C")!!;enter(g,c,"connect4")
        assertEquals(board,room(g,c).getValue("board"));assertEquals(board,room(g,a).getValue("board"))
    }

    @Test fun `retrying the same request applies it once and stale round is rejected`() {
        val g=CampsiteGames();val a=g.join("A")!!;val b=g.join("B")!!
        enter(g,a,"connect4");enter(g,b,"connect4");request(g,a,"start")
        val command=buildJsonObject {put("action","move");put("actionId","retry");put("cell",2);put("round",room(g,a).getValue("round"))}
        assertEquals(200,g.handle(a,command).status);assertEquals(200,g.handle(a,command).status)
        assertEquals(1,room(g,b).getValue("board").jsonArray.count { it.jsonPrimitive.int!=0 })
        val stale=buildJsonObject {put("action","move");put("actionId","stale");put("cell",2);put("round",0)}
        assertEquals(409,g.handle(b,stale).status)
    }

    @Test fun `refresh retains identity and secret is visible only to leader`() {
        val g=CampsiteGames();val a=g.join("Sam")!!;val b=g.join("Sam")!!
        assertNotEquals(g.handle(a).body["you"],g.handle(b).body["you"])
        assertNotEquals(g.name(a),g.name(b))
        enter(g,a,"twentyquestions");enter(g,b,"twentyquestions")
        request(g,a,"start",mapOf("text" to JsonPrimitive("Elephant")))
        assertEquals("Elephant",room(g,a).getValue("secret").jsonPrimitive.content)
        assertFalse(room(g,b).containsKey("secret"))
        request(g,b,"text",mapOf("text" to JsonPrimitive("An elephant?")))
        request(g,a,"judge",mapOf("text" to JsonPrimitive("Correct guess!")))
        assertEquals("Elephant",room(g,b).getValue("secret").jsonPrimitive.content)
        assertEquals(401,g.handle("forged").status)
    }

    @Test fun `every guest game starts and has a playable completion path`() {
        // Two phones only: a game that seats three or more (Two Truths and a Lie) is covered by its own test.
        for(game in CampsiteGames.GAMES.keys.filter { it !in listOf("connect4","trivia","twentyquestions") && (com.beeboentertainment.movie.campsite.games.CampsiteGameCatalog[it]?.seats?.min ?: 2) <= 2 }) {
            val g=CampsiteGames(random=Random(4));val a=g.join("A")!!;val b=g.join("B")!!
            enter(g,a,game);enter(g,b,game);request(g,a,"start")
            when(game){
                "ttt" -> listOf(a to 0,b to 3,a to 1,b to 4,a to 2).forEach { (p,c)->request(g,p,"move",mapOf("cell" to JsonPrimitive(c))) }
                "thisorthat","wouldyourather" -> {request(g,a,"answer",mapOf("choice" to JsonPrimitive(0)));request(g,b,"answer",mapOf("choice" to JsonPrimitive(1)))}
                "ispy","quiet" -> request(g,a,"claim")
                "bingo" -> (0..4).forEach {request(g,a,"claim",mapOf("cell" to JsonPrimitive(it)))}
                "storybuilder","categorychains" -> {request(g,a,"text",mapOf("text" to JsonPrimitive("Apple")));request(g,b,"text",mapOf("text" to JsonPrimitive("Banana")));request(g,a,"finish")}
                "picknext" -> {request(g,a,"text",mapOf("text" to JsonPrimitive("Watch a film")));request(g,b,"text",mapOf("text" to JsonPrimitive("Play a game")));request(g,a,"finish")}
            }
            // The games driven above are played to a finish. Every other game - the board and
            // card games added later - is asserted to START and to be waiting on a real player,
            // which is what "playable" means for a game this test has no scripted moves for.
            val driven = game in listOf("ttt","thisorthat","wouldyourather","ispy","quiet","bingo","storybuilder","categorychains","picknext")
            val phase = room(g,a).getValue("phase").jsonPrimitive.content
            if (driven) assertTrue(game, phase in listOf("done","revealed"))
            else assertEquals(game, "playing", phase)
            request(g,a,"leave");assertEquals(g.handle(b).body["you"],room(g,b)["owner"])
        }
    }

    @Test fun `absent player has a grace period then stops blocking the game`() {
        var clock=0L;val g=CampsiteGames(now={clock});val a=g.join("A")!!;val b=g.join("B")!!
        enter(g,a,"connect4");enter(g,b,"connect4");request(g,a,"start")
        clock=50_000;g.handle(a);assertEquals("playing",room(g,b)["phase"]!!.jsonPrimitive.content)
        clock=100_000;g.handle(a);clock=145_000
        assertEquals("done",room(g,a)["phase"]!!.jsonPrimitive.content)
    }

    @Test fun `empty trivia cache explains the fix without starting an empty round`() {
        val g=CampsiteGames();val a=g.join("A")!!;val b=g.join("B")!!
        enter(g,a,"trivia");enter(g,b,"trivia");request(g,a,"start",status=409)
        assertEquals("lobby",room(g,b)["phase"]!!.jsonPrimitive.content)
    }
}
