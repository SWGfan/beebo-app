package com.beeboentertainment.movie.campsite

import com.beeboentertainment.movie.campsite.games.CampsiteMatchHistory
import com.beeboentertainment.movie.party.games.TriviaQuestion
import com.beeboentertainment.movie.trip.TripMomentSink
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import java.util.UUID

/**
 * The campsite games on the host's own phone, with nobody else invited.
 *
 * WHY NOT JUST START THE SERVER ON LOOPBACK: because then "open Games" would mean a socket,
 * a port and a thread pool for somebody playing Checkers against the computer in a tent.
 * This is the same [CampsiteGames] engine and the same guest page, with the page's calls to
 * `/api/games` handed straight to the engine through a WebView JavaScript bridge. There is
 * no server, no port, no foreground service and nothing any other device could reach. When
 * the host leaves, [close] puts the bots away and the whole thing is garbage.
 *
 * No Android types, so it is unit-tested directly.
 */
internal class CampsiteLocalGames(
    trivia: () -> List<TriviaQuestion> = { emptyList() },
    history: CampsiteMatchHistory = CampsiteMatchHistory.None,
    botClock: Boolean = true,
    private val hostName: String = "You",
    trip: TripMomentSink = TripMomentSink.None,
) {
    private val games = CampsiteGames(trivia, history = history, botClockEnabled = botClock, trip = trip)
    private var token: String? = null

    /** The host's play token, re-joining if the engine reaped an idle session (app in the background). */
    @Synchronized private fun token(): String =
        token?.takeIf { games.name(it) != null }
            ?: (games.join(hostName) ?: error("The local game room refused its only player")).also { token = it }

    /**
     * PASS-AND-PLAY. Extra people playing on this same phone, each an ordinary engine
     * session. The phone is the only device in the game, so it is trusted to speak for
     * whoever's turn it is: while a round is being played, a request goes out as the
     * local player the match is waiting for, and otherwise as the host (who leads the room).
     */
    private val passTokens = mutableListOf<String>()
    private var lastKeepAlive = 0L

    @Synchronized private fun speaker(): String {
        val host = token()
        passTokens.removeAll { games.name(it) == null }
        if (passTokens.isEmpty()) return host
        val now = System.currentTimeMillis()
        if (now - lastKeepAlive > 20_000) {
            // Nobody polls as the player who is waiting their turn, so keep them seated.
            lastKeepAlive = now
            passTokens.forEach { games.handle(it) }
        }
        val room = games.handle(host).body["room"] as? JsonObject ?: return host
        if ((room["phase"] as? JsonPrimitive)?.content != "playing") return host
        val turn = (room["turn"] as? JsonPrimitive)?.content.orEmpty()
        return passTokens.firstOrNull { t ->
            (games.handle(t).body["you"] as? JsonPrimitive)?.content == turn
        } ?: host
    }

    /** GET /api/games, as the page's poll sees it: `{"status":200,"body":"{...}"}`. */
    fun get(): String = wrap(games.handle(speaker()), local = true)

    /** POST /api/games with the page's JSON body. */
    fun post(body: String): String {
        val json = runCatching { Json.parseToJsonElement(body) as? JsonObject }.getOrNull()
            ?: return wrap(CampsiteGames.Reply(400, buildJsonObject { put("ok", false); put("error", "Invalid request") }))
        if ((json["action"] as? JsonPrimitive)?.content == "addlocal") return wrap(addLocalPlayer(), local = true)
        return wrap(games.handle(speaker(), json), local = true)
    }

    /**
     * Seat one more person on this phone, in the room the host is in. A computer player
     * gives up its seat when the game would otherwise have no room for the new person.
     */
    @Synchronized fun addLocalPlayer(): CampsiteGames.Reply {
        val snapshot = games.handle(token()).body
        val room = snapshot["room"] as? JsonObject
            ?: return CampsiteGames.Reply(409, buildJsonObject { put("ok", false); put("error", "Choose a game first.") })
        val gameId = (room["game"] as? JsonPrimitive)?.content.orEmpty()
        val max = com.beeboentertainment.movie.campsite.games.CampsiteGameCatalog[gameId]?.seats?.max ?: 2
        val members = (room["players"] as? kotlinx.serialization.json.JsonArray)?.size ?: 0
        if (members >= 12) return CampsiteGames.Reply(409, buildJsonObject { put("ok", false); put("error", "This game is full.") })
        val next = games.join("Player " + (passTokens.size + 2)) ?: return CampsiteGames.Reply(409, buildJsonObject { put("ok", false); put("error", "No room for another player.") })
        passTokens.add(next)
        actAs(next, "enter", mapOf("game" to JsonPrimitive(gameId)))
        val bots = (room["bots"] as? JsonPrimitive)?.intOrNull ?: 0
        if (bots > 0 && members + 1 > max) act("removebot", emptyMap())
        return games.handle(token())
    }

    /**
     * Go straight into [gameId]'s room, with one computer player seated when [withComputer],
     * so "Play vs computer" lands on a room where Start is the only thing left to tap.
     * Returns false if the game does not exist.
     */
    fun open(gameId: String, withComputer: Boolean): Boolean {
        val entered = act("enter", mapOf("game" to JsonPrimitive(gameId)))
        if (entered.status != 200) return false
        if (withComputer) {
            val room = entered.body["room"] as? JsonObject
            val bots = (room?.get("bots") as? JsonPrimitive)?.intOrNull ?: 0
            if (bots == 0) act("addbot", emptyMap())
        }
        return true
    }

    /** The snapshot the page would read right now. For tests and the host's own checks. */
    internal fun snapshot(): JsonObject = games.handle(token()).body

    /** Put the bots away. Nothing else is running to stop. */
    fun close() = games.shutdown()

    private fun act(action: String, fields: Map<String, JsonPrimitive>): CampsiteGames.Reply = actAs(token(), action, fields)

    private fun actAs(who: String, action: String, fields: Map<String, JsonPrimitive>): CampsiteGames.Reply {
        val round = ((games.handle(who).body["room"] as? JsonObject)?.get("round") as? JsonPrimitive)?.intOrNull ?: 0
        return games.handle(who, buildJsonObject {
            put("action", action)
            put("actionId", UUID.randomUUID().toString())
            put("round", round)
            fields.forEach { (k, v) -> put(k, v) }
        })
    }

    /** [local] marks the body so the page can offer "Add a player on this phone". */
    private fun wrap(reply: CampsiteGames.Reply, local: Boolean = false): String = buildJsonObject {
        put("status", reply.status)
        val body = if (local) kotlinx.serialization.json.JsonObject(reply.body + ("local" to JsonPrimitive(true))) else reply.body
        put("body", body.toString())
    }.toString()

    companion object {
        /** The name the page calls the bridge by. */
        const val BRIDGE = "BeeboLocalGames"

        /** A base that is never fetched: every request the page makes is answered by the bridge. */
        const val BASE_URL = "https://local-games.beebo.invalid/games"

        /**
         * The guest page, taught to talk to [BRIDGE] instead of the network.
         *
         * The shim goes in before the page's own script, so the page's `fetch('/api/games')`
         * never leaves the WebView. Anything else it fetches is refused rather than sent
         * anywhere. The "Videos" link and the connection line are hidden: there is no library
         * here and no host to be connected to.
         */
        fun page(html: String): String {
            val shim = "<style>header.top a,#connection{display:none!important}</style><script>(()=>{" +
                "const bridge=window.$BRIDGE;" +
                "window.fetch=function(input,init){" +
                "const url=typeof input==='string'?input:(input&&input.url)||'';" +
                "if(!url.endsWith('/api/games'))return Promise.reject(new TypeError('Offline'));" +
                "const post=!!(init&&String(init.method).toUpperCase()==='POST');" +
                "const r=JSON.parse(post?bridge.post(String(init.body)):bridge.get());" +
                "return Promise.resolve(new Response(r.body,{status:r.status,headers:{'Content-Type':'application/json'}}));" +
                "};})();</script>"
            val at = html.indexOf("</head>")
            return if (at >= 0) html.substring(0, at) + shim + html.substring(at) else shim + html
        }
    }
}
