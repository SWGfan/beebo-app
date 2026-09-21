package com.beeboentertainment.movie.campsite

import com.beeboentertainment.movie.campsite.games.CampfireStoriesGame
import com.beeboentertainment.movie.campsite.games.CampsiteGame
import com.beeboentertainment.movie.campsite.games.CampsiteGameCatalog
import com.beeboentertainment.movie.campsite.games.CampsiteMatchHistory
import com.beeboentertainment.movie.campsite.games.CampsiteTournament
import com.beeboentertainment.movie.campsite.games.ChampionRecord
import com.beeboentertainment.movie.campsite.games.ClockedMatch
import com.beeboentertainment.movie.campsite.games.SeatKeeper
import com.beeboentertainment.movie.campsite.games.GameMatch
import com.beeboentertainment.movie.campsite.games.GameMove
import com.beeboentertainment.movie.campsite.games.MatchFields
import com.beeboentertainment.movie.campsite.games.MatchPlayer
import com.beeboentertainment.movie.campsite.games.MatchRecord
import com.beeboentertainment.movie.campsite.games.MatchResult
import com.beeboentertainment.movie.campsite.games.Outcome
import com.beeboentertainment.movie.campsite.games.SimpleMatchContext
import com.beeboentertainment.movie.campsite.games.Standing
import com.beeboentertainment.movie.campsite.games.TournamentHost
import com.beeboentertainment.movie.party.games.TriviaQuestion
import com.beeboentertainment.movie.trip.StoryCapture
import com.beeboentertainment.movie.trip.TripMomentSink
import kotlinx.serialization.json.*
import java.security.SecureRandom
import kotlin.random.Random

/**
 * One authoritative, in-memory games service per campsite. Guests never supply scores,
 * correct answers, board contents or another player's identity. No external services.
 *
 * This file used to hold every game as well. It no longer does: a game is a
 * [CampsiteGame] in its own file in the `games` package, and this class is only the
 * service around them - who is here, which room they are in, whose action is allowed,
 * and what each phone is told. That split is what lets a tournament run several matches
 * of the same game at once, which one room-with-one-board-field never could.
 *
 * A room has two ways to play, and they do not interfere:
 *  - free play, exactly as before: the leader starts a round, everyone in the room is in
 *    it (or the first two, for a two-seat game);
 *  - a tournament, where the room's players are drawn into simultaneous heats and the
 *    winners go through. See [CampsiteTournament].
 *
 * Two things sit alongside both of those.
 *
 * BOTS. A room can be given computer players, named Beebo, Appa and Jenkins and then
 * from a list of invented names. A bot is an ordinary player everywhere it matters - it
 * takes a seat, it is in the roster, it enters the bracket, its results are saved - and
 * it differs in exactly three places, each of them deliberate: it has no session token,
 * so no phone can ever be it; it is always "just seen", so it can never be the reason a
 * bracket times out; and nothing it played is rated, so the household leaderboard stays
 * a table of people. Its turns are taken by the service's own small clock rather than
 * by anybody's poll - see [startBotClock].
 *
 * WATCHING. Anybody in the room can watch a round they are not in, bots included, and a
 * watcher is genuinely not a player: they are out of the draw for the next round, no
 * match is ever waiting on them, and every action but leaving and un-watching is
 * refused. There is no spectator rendering path - a spectator is simply a null viewer
 * passed to the same [GameMatch.view] every player uses. See [viewFor].
 */
internal class CampsiteGames(
    private val trivia: () -> List<TriviaQuestion> = { emptyList() },
    private val now: () -> Long = System::currentTimeMillis,
    private val random: Random = Random.Default,
    /**
     * Where finished matches are saved. Defaults to nowhere so the engine can be built
     * and tested with no Android context; the host wires the real store in.
     */
    private val history: CampsiteMatchHistory = CampsiteMatchHistory.None,
    /**
     * Whether the service may run its own little clock for the bots. On by default;
     * tests turn it off and drive [pulse] themselves so a bot's turn happens at a
     * moment the test chose. The thread is never started until the first bot is added,
     * so a room with no bots in it behaves exactly as it always has.
     */
    private val botClockEnabled: Boolean = true,
    /**
     * Where a finished Campfire Stories round is kept if a trip is running. Nowhere by
     * default, like [history], so the engine stays testable with no Android context.
     */
    private val trip: TripMomentSink = TripMomentSink.None,
    /** Where a finished Plate & Sign Hunt round's badge counters go. Nowhere by default, like [trip]. */
    private val plates: com.beeboentertainment.movie.campsite.platehunt.PlateBadgeSink =
        com.beeboentertainment.movie.campsite.platehunt.PlateBadgeSink.None,
) {
    data class Reply(val status: Int, val body: JsonObject)

    private data class Player(val token: String, val id: String, val name: String, var seen: Long,
        var game: String? = null, val actions: LinkedHashSet<String> = linkedSetOf(),
        /**
         * This guest has asked to WATCH rather than play. It is a seat given up, never
         * one taken: it keeps them out of the draw for the next round and out of
         * [recentPlayers], and it puts them in nobody's match.
         */
        var spectating: Boolean = false,
        /** Which tournament heat they picked to watch, by bout id. Empty means none. */
        var watchBout: String = "")

    /**
     * A computer player.
     *
     * It is deliberately NOT a [Player]: it has no token, so there is no value a phone
     * could ever put in a cookie that would make [handle] treat it as this bot. That is
     * the whole security story for bots - an id minted here, held here, and belonging
     * to no session. Everything else about it (a seat, a roster row, a bracket slot, a
     * saved result) is ordinary player machinery it goes through unchanged.
     */
    private data class Bot(val id: String, val name: String, val room: String)

    private class Room(val key: String, val game: CampsiteGame) {
        var owner = ""
        val members = mutableListOf<String>()
        var round = 0
        var revision = 0

        /** The free-play match, if one has been started. */
        var match: GameMatch? = null

        /** The bracket, if one has been run. Kept after it ends so the result can be read. */
        var tournament: CampsiteTournament? = null

        /** The match already written to history, so a finished round is saved exactly once. */
        var recorded: GameMatch? = null
        var startedAt = 0L

        /** Only a running tournament blocks free play or claims the room's actions. */
        fun live(): CampsiteTournament? = tournament?.takeIf { it.state == "running" }
    }

    private val sessions = linkedMapOf<String, Player>()
    private val rooms = linkedMapOf<String, Room>()

    /** Every bot in the campsite, by id. A bot is only ever in the room that made it. */
    private val bots = linkedMapOf<String, Bot>()

    /**
     * A bot's pending turn: what it was looking at, and the host clock reading at which
     * it will act. See [thinkTime] for why a bot is not allowed to answer instantly.
     */
    private class BotTurn(val matchTag: Int, val dueAt: Long)

    private val botTurns = linkedMapOf<String, BotTurn>()
    private var botThread: Thread? = null
    private val secure = SecureRandom()
    private fun id(): String = ByteArray(24).also { secure.nextBytes(it) }
        .joinToString("") { (it.toInt() and 255).toString(16).padStart(2, '0') }

    @Synchronized fun join(name: String): String? {
        cleanup()
        if (sessions.size >= 48) return null
        val base = name.filter { !it.isISOControl() }.trim().take(24).ifBlank { "Guest" }
        var display = base; var n = 2
        while (sessions.values.any { it.name == display }) { display = "$base $n"; n++ }
        val token = id()
        sessions[token] = Player(token, id(), display, now())
        return token
    }

    @Synchronized fun name(token: String?): String? = sessions[token]?.name
    private fun playerName(id: String): String =
        sessions.values.firstOrNull { it.id == id }?.name ?: bots[id]?.name ?: "Player"

    private fun sessionOf(id: String): Player? = sessions.values.firstOrNull { it.id == id }

    /** Recent finished matches, newest first, for the host phone's own screen. */
    @Synchronized fun recentMatches(limit: Int = 20): List<MatchRecord> = history.recent(limit)

    /** Standings across every game, or for one game id. */
    @Synchronized fun standings(gameId: String? = null): List<Standing> = history.leaderboard(gameId)

    /**
     * A read-only look at a room, for the HOST PHONE'S own screen.
     *
     * The host is in the room in every sense that matters and should be able to watch a
     * round - including a bot-versus-bot round nobody else is at - without joining it.
     * It goes through exactly the same seam a guest spectator does: the match is
     * rendered with [GameMatch.view] and a null viewer. Running the server is not a
     * reason to be shown a guest's bingo card or the answer they have picked but not
     * revealed, and this method could not show them if it wanted to.
     *
     * [matchId] picks one heat of a running tournament; free play ignores it.
     */
    @Synchronized fun spectate(gameId: String, matchId: String = ""): JsonObject {
        val room = rooms[gameId]
            ?: return buildJsonObject { put("ok", false); put("error", "Nobody is in that game.") }
        val bracket = room.live()
        val match = if (bracket != null) bracket.boutById(matchId)?.match else room.match
        return buildJsonObject {
            put("ok", true)
            put("game", room.key); put("title", room.game.title); put("kind", room.game.kind)
            put("phase", match?.phase ?: if (bracket != null) "waiting" else "lobby")
            put("line", match?.line().orEmpty())
            put("players", buildJsonArray { room.members.forEach { id -> add(buildJsonObject {
                put("id", id); put("name", playerName(id)); put("bot", id in bots)
                put("active", match?.players?.contains(id) == true)
                put("score", match?.scoreOf(id) ?: 0)
            }) } })
            put("seats", JsonArray(match?.players.orEmpty().map { JsonPrimitive(it) }))
            put("waitingOn", JsonArray(match?.waitingOn().orEmpty().map { JsonPrimitive(playerName(it)) }))
            (match?.view(null) ?: MatchFields.defaults(0)).forEach { (key, value) -> put(key, value) }
            bracket?.let { put("tournament", it.snapshot(null)) }
        }
    }

    @Synchronized fun handle(token: String?, request: JsonObject? = null): Reply {
        cleanup()
        val player = sessions[token] ?: return error(401, "Join the campsite again to play.")
        player.seen = now()
        // Every request is also a heartbeat for the brackets. Doing it here means a
        // tournament keeps moving as long as anybody at all is looking at their phone,
        // and never waits on a player who has stopped looking at theirs.
        rooms.values.toList().forEach { it.live()?.tick() }
        rooms.values.toList().forEach { tickClock(it) }
        if (request == null) return Reply(200, snapshot(player))
        val actionId = request.text("actionId")
        if (actionId.length !in 1..100) return error(400, "Please retry that action.")
        if (actionId in player.actions) return Reply(200, snapshot(player))
        val action = request.text("action")
        try {
            when (action) {
                "enter" -> enter(player, request.text("game"))
                "leave" -> leave(player)
                else -> {
                    val room = rooms[player.game] ?: throw IllegalArgumentException("Choose a game first.")
                    require(request.number("round") == roundOf(room, player.id)) { "The round changed. Please try again." }
                    when (action) {
                        "start" -> start(room, player, request.text("text"))
                        "tournament" -> startTournament(room, player)
                        "cancel" -> cancelTournament(room, player)
                        "addbot" -> addBot(room, player)
                        "removebot" -> removeBot(room, player, request.text("bot"))
                        // Watching is handled here rather than by the match, because a
                        // spectator has no match to send anything to - that is the point
                        // of them. It also cannot reach the match branch below, so a
                        // spectator can never turn a watch into a move.
                        "watch" -> watch(room, player, request.text("match"))
                        "unwatch" -> unwatch(room, player)
                        else -> {
                            val match = liveMatchFor(room, player.id)
                                ?: throw IllegalArgumentException("You can watch this round and join the next one.")
                            match.apply(GameMove(player.id, action, request))
                        }
                    }
                    settle(room)
                    room.revision++
                }
            }
        } catch (e: IllegalArgumentException) { return error(409, e.message ?: "Please refresh the game.") }
        player.actions.add(actionId)
        if (player.actions.size > 128) player.actions.remove(player.actions.first())
        return Reply(200, snapshot(player))
    }

    // ---- rooms ---------------------------------------------------------------

    private fun enter(player: Player, key: String) {
        val game = CampsiteGameCatalog[key] ?: throw IllegalArgumentException("Choose a game from the menu.")
        val room = rooms.getOrPut(key) { Room(key, game) }
        require(room.members.size < ROOM_CAP || player.id in room.members) { "This game is full. Try another game." }
        if (player.game != key) {
            leave(player)
            room.members.add(player.id)
            room.revision++
        }
        // Opening a game from the menu is a request to PLAY it. Anyone who was watching
        // and has come back to the menu starts again as a player.
        player.spectating = false
        player.watchBout = ""
        if (room.owner.isBlank()) room.owner = player.id
        player.game = key
        // Came back before their heat was decided: no penalty. This is a campsite.
        room.live()?.rejoin(player.id)
        // A party game kept their seat while they were gone; give it back.
        (room.match as? SeatKeeper)?.let { match ->
            if (player.id in room.match!!.players) { match.playerReturned(player.id); room.revision++ }
        }
    }

    /**
     * Run a party game's own countdown. Called on every request and from the bot clock,
     * so a round ends on time as long as any phone at all is looking. See [ClockedMatch].
     */
    private fun tickClock(room: Room) {
        val match = room.match as? ClockedMatch ?: return
        if (room.live() != null || (match as GameMatch).phase == "done") return
        if (match.tick()) {
            settle(room)
            room.revision++
        }
    }

    /**
     * A seat has emptied in the middle of a free-play round. Party games can carry on
     * without one player (see [SeatKeeper]); every other game ends with no result, as
     * it always has.
     */
    private fun seatEmptied(room: Room, playerId: String) {
        val match = room.match ?: return
        if (playerId !in match.players || match.phase == "done") return
        if (match is SeatKeeper && match.playerLeft(playerId)) {
            settle(room)
            return
        }
        if (match.phase != "playing") return
        match.close(
            MatchResult(Outcome.VOID, "", emptyMap()),
            "A player left. Start a new round when everyone is ready.",
        )
        room.recorded = match
    }

    private fun leave(p: Player) {
        val r = rooms[p.game]
        p.game = null
        p.spectating = false
        p.watchBout = ""
        if (r == null) return
        r.members.remove(p.id); r.revision++
        // The leadership of a room is never handed to a bot: the leader is who starts
        // rounds and answers 20 Questions, and a bot that owned a room could sit on it
        // forever because a bot never times out.
        if (r.owner == p.id) r.owner = r.members.firstOrNull { it !in bots }.orEmpty()
        val bracket = r.live()
        if (bracket != null) {
            // A whole tournament must not fall over because one guest wandered off:
            // they forfeit their own heat and the rest carries on.
            bracket.withdraw(p.id)
            bracket.tick()
            settle(r)
        } else {
            seatEmptied(r, p.id)
        }
        // The last GUEST has gone. Bots are not company, so they are put away with the
        // room rather than being left playing to an empty field forever.
        if (r.members.none { it !in bots }) {
            r.members.toList().forEach { bots.remove(it); botTurns.remove(it) }
            r.members.clear()
        }
        if (r.members.isEmpty()) rooms.remove(r.key)
    }

    private fun cleanup() {
        sessions.values.toList().filter { now() - it.seen > 90_000 && it.game != null }.forEach { leave(it) }
        sessions.entries.removeAll { now() - it.value.seen > 86_400_000 }
    }

    // ---- starting rounds -----------------------------------------------------

    /**
     * Who is available to be seated in the next round.
     *
     * A bot is always here - it has no phone to go flat and no toilet block to wander
     * to - and anybody who has asked to watch is deliberately not here, which is what
     * lets the leader start a bot-versus-bot round and simply look at it.
     */
    private fun recentPlayers(room: Room): List<String> =
        room.members.filter { id ->
            if (sessionOf(id)?.spectating == true) false
            else id in bots || sessions.values.any { it.id == id && now() - it.seen < 90_000 }
        }

    private fun start(room: Room, player: Player, setup: String) {
        require(room.owner == player.id) { "The game leader starts the round." }
        require(phaseOf(room, player) != "playing") { "Finish this round first." }
        require(room.live() == null) { "Finish or cancel the tournament first." }
        // 20 Questions and anything else with a typed secret: the person who sets it is
        // the person who answers for it, so they cannot set one and then sit out. Left
        // as a rule rather than a special case because the leak it prevents is real -
        // the leader seat below falls to the first player when the room's leader is not
        // in the match, and that seat can read the secret.
        require(!(room.game.needsSetup && player.spectating)) { "You have to play this one to set it up." }
        val recent = recentPlayers(room)
        require(room.game.seats.fits(recent.size)) { "Waiting for another player. Ask a guest to open this game." }
        room.game.validateSetup(setup)
        // Built before anything is committed: a game that cannot start (no cached
        // questions) throws here and the room keeps the round it was already showing.
        val seats = recent.take(room.game.seats.max)
        val match = room.game.create(seats, setup, contextFor(room, seats))
        room.round++
        room.match = match
        room.recorded = null
        room.startedAt = now()
    }

    private fun startTournament(room: Room, player: Player) {
        require(room.owner == player.id) { "The game leader starts the tournament." }
        require(room.live() == null) { "A tournament is already running." }
        require(room.game.tournamentReady) { "That game is for playing together, not for a bracket." }
        val recent = recentPlayers(room)
        require(recent.size >= 2) { "A tournament needs at least two players here." }
        val bracket = CampsiteTournament("t" + id().take(8), room.game, recent, Bridge())
        room.match = null
        room.recorded = null
        room.tournament = bracket
        room.round++
    }

    private fun cancelTournament(room: Room, player: Player) {
        require(room.owner == player.id) { "The game leader looks after the tournament." }
        val bracket = room.live() ?: throw IllegalArgumentException("No tournament is running.")
        bracket.cancel("The leader ended the tournament.")
        room.round++
    }

    // ---- bots ---------------------------------------------------------------

    /**
     * Add one bot to this room.
     *
     * A bot costs a place in the room exactly like a guest does, because it costs a
     * SEAT exactly like a guest does - a four-in-a-row heat has two seats whoever is
     * sitting in them. That is also why there is no special cap on bots: the room cap
     * is the cap, and if the leader wants eleven bots and one human, that is a
     * tournament.
     */
    private fun addBot(room: Room, player: Player) {
        require(room.owner == player.id) { "The game leader adds the bots." }
        require(room.live() == null) { "Finish or cancel the tournament first." }
        require(room.members.size < ROOM_CAP) { "This game is full. Remove somebody first." }
        val bot = Bot(id(), nextBotName(room), room.key)
        bots[bot.id] = bot
        room.members.add(bot.id)
        room.revision++
        startBotClock()
    }

    /**
     * Remove a bot. The phone may name WHICH bot, and that is the only thing it gets to
     * say about bots: the id is checked against this room's own bot list before it is
     * used, so it selects rather than identifies. An unrecognised id simply removes the
     * one added last, which is what the button means.
     */
    private fun removeBot(room: Room, player: Player, wanted: String) {
        require(room.owner == player.id) { "The game leader looks after the bots." }
        val target = wanted.takeIf { bots[it]?.room == room.key && it in room.members }
            ?: room.members.lastOrNull { it in bots }
            ?: throw IllegalArgumentException("There is no bot to remove.")
        bots.remove(target)
        botTurns.remove(target)
        room.members.remove(target)
        room.revision++
        val bracket = room.live()
        if (bracket != null) {
            // Same treatment a guest who taps leave gets: forfeit that heat, and the
            // rest of the bracket carries on without a pause.
            bracket.withdraw(target)
            bracket.tick()
        } else {
            seatEmptied(room, target)
        }
    }

    /**
     * The house bots, in the order the owner asked for them, then friendly invented
     * names. Room-scoped: the first bot in ANY room is Beebo, because "add a bot" in
     * the corner of a field should produce Beebo, not Beebo 4.
     */
    private fun nextBotName(room: Room): String {
        val taken = room.members.map { playerName(it) }.toSet()
        BOT_NAMES.firstOrNull { it !in taken }?.let { return it }
        EXTRA_BOT_NAMES.shuffled(random).firstOrNull { it !in taken }?.let { return it }
        var n = 2
        while (("Bot " + n) in taken) n++
        return "Bot " + n
    }

    // ---- watching -----------------------------------------------------------

    /**
     * Stop queueing for a seat and watch instead.
     *
     * WATCHING IS A SEAT GIVEN UP, NEVER ONE TAKEN. It sets a flag on the guest and,
     * optionally, remembers which tournament heat they picked off the bracket. It does
     * not touch [Room.members], any match's player list, or any bracket, so there is no
     * path from here to being in a game. Refused while you are in a live round, because
     * walking out of a match half way through is what `leave` is for, and that has
     * consequences this must not quietly acquire.
     */
    private fun watch(room: Room, player: Player, boutId: String) {
        val current = viewFor(room, player)
        require(!current.asPlayer || current.match?.phase == "done") { "You're in this round. Finish it first." }
        player.spectating = true
        // Only ever used to look a heat up by id; narrowed anyway so nothing typed can
        // travel further than a failed map lookup.
        player.watchBout = boutId.filter { it.isLetterOrDigit() }.take(16)
        room.revision++
    }

    private fun unwatch(room: Room, player: Player) {
        player.spectating = false
        player.watchBout = ""
        room.revision++
    }

    /**
     * The services a free-play match is given.
     *
     * [seats] is who is about to be sitting in the round, passed in rather than read
     * back off the room, because the match does not exist yet while this is being built
     * and a game is entitled to ask who the leader is in its own constructor.
     */
    private fun contextFor(room: Room, seats: List<String> = emptyList()) = SimpleMatchContext(
        random = random,
        clock = { now() },
        names = { playerName(it) },
        // Normally the room's leader, who until spectating existed was always in the
        // match. Now they can start a round and watch it - two bots playing each other,
        // say - and a round whose leader is not at it can never be revealed, advanced or
        // finished by anybody. So the leader falls to the first seat: the same rule, and
        // the same reason, as a tournament heat being run by its own seat 0 rather than
        // by a room leader who may not be in it. With nobody spectating this is exactly
        // what it always was, because the room's leader is always seat 0.
        leaderOf = { if (seats.isEmpty() || room.owner in seats) room.owner else seats.first() },
        bump = { room.round++ },
        triviaSource = { count -> trivia().take(count) },
    )

    /** What the host tells a bracket. Everything comes from the host's own tables. */
    private inner class Bridge : TournamentHost {
        override val random: Random get() = this@CampsiteGames.random
        override fun now(): Long = this@CampsiteGames.now()
        override fun nameOf(playerId: String): String = playerName(playerId)
        /**
         * A bot is always "just seen". It has no phone to go flat and no hotspot to
         * wander out of, so it can never be walked over for being absent and can never
         * be the seat a bracket is waiting on when it times a heat out.
         */
        override fun lastSeen(playerId: String): Long =
            if (playerId in bots) this@CampsiteGames.now()
            else sessions.values.firstOrNull { it.id == playerId }?.seen ?: 0L
        override fun trivia(count: Int): List<TriviaQuestion> = this@CampsiteGames.trivia().take(count)

        override fun onMatchEnded(
            game: CampsiteGame,
            players: List<String>,
            result: MatchResult,
            startedAt: Long,
            endedAt: Long,
            tournamentId: String,
            roundName: String,
        ) = save(game, players, result, startedAt, endedAt, tournamentId, roundName)

        override fun onChampion(game: CampsiteGame, championId: String, entrants: Int) {
            // A bracket a bot won is still a bracket that happened - the heats are in
            // history - but it is not a household championship and no trophy is filed
            // for it. See [save] for the matching rule on rated matches.
            if (championId in bots) return
            history.recordChampion(
                ChampionRecord(
                    game = game.id,
                    title = game.title,
                    champion = playerName(championId),
                    players = entrants,
                    endedAt = now(),
                ),
            )
            historyRev++
        }
    }

    // ---- results -------------------------------------------------------------

    /** Move the bracket on, and write a finished free-play round to history exactly once. */
    private fun settle(room: Room) {
        // A move that ended a heat should advance the bracket in the same request, not
        // on somebody else's next poll.
        room.live()?.tick()
        val match = room.match ?: return
        if (match.phase != "done" || room.recorded === match) return
        room.recorded = match
        val result = match.result() ?: return
        save(room.game, match.players, result, room.startedAt, now(), "", "")
        if (room.game.id == CampfireStoriesGame.id && result.note == CampfireStoriesGame.FINISHED_NOTE) keepStory(match)
        if (result.outcome != Outcome.VOID) (match as? com.beeboentertainment.movie.campsite.platehunt.PlateHuntReporting)?.let { keepPlates(it, match) }
    }

    /** A finished plate or sign hunt: one tally on the running trip (if any) and the badge counters. Never fails the round. */
    private fun keepPlates(round: com.beeboentertainment.movie.campsite.platehunt.PlateHuntReporting, match: GameMatch) {
        runCatching {
            val summary = round.plateSummary()
            val humans = match.players.filter { it !in bots }.map { playerName(it) }
            com.beeboentertainment.movie.campsite.platehunt.PlateHuntRecords.tally(id().take(12), summary, humans)?.let { trip.tally(it) }
            plates.finished(summary)
        }
    }

    /** A story the leader finished goes to the running trip (a story that just stalled does not). */
    private fun keepStory(match: GameMatch) {
        val view = match.view(null)
        fun text(key: String) = (view[key] as? JsonPrimitive)?.content.orEmpty()
        val log = (view["log"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.content }
        val humans = match.players.filter { it !in bots }.map { playerName(it) }
        StoryCapture.fromRound(id().take(12), text("mood"), text("prompt"), log, humans)?.let { trip.story(it) }
    }

    private fun save(
        game: CampsiteGame,
        players: List<String>,
        result: MatchResult,
        startedAt: Long,
        endedAt: Long,
        tournamentId: String,
        roundName: String,
    ) {
        // Nothing happened, so nothing is remembered.
        if (result.outcome == Outcome.VOID) return
        history.record(
            MatchRecord(
                id = id().take(12),
                game = game.id,
                title = game.title,
                players = players.map { player ->
                    MatchPlayer(
                        name = playerName(player),
                        score = result.scores[player] ?: 0,
                        won = (result.winnerId.isNotBlank() && player == result.winnerId) || player in result.winners,
                        bot = player in bots,
                    )
                },
                winner = when {
                    result.winnerId.isNotBlank() -> playerName(result.winnerId)
                    // A team game: name the side as its members, in seat order.
                    result.winners.isNotEmpty() -> players.filter { it in result.winners }.joinToString(", ") { playerName(it) }
                    else -> ""
                },
                outcome = result.outcome.wire,
                endedAt = endedAt,
                durationMs = (endedAt - startedAt).coerceAtLeast(0L),
                tournament = tournamentId,
                round = roundName,
                // A walkover says nothing about who is better, and a raffle or a story
                // has no winner worth ranking. Kept in history, kept out of the table.
                //
                // AND NOTHING WITH A BOT IN IT IS RATED. The standings exist to answer
                // "who is best in this family", and a family member is somebody who can
                // decline to play. A bot cannot: it is available every evening, it never
                // gets bored and it never goes to bed, so beating Beebo forty times would
                // crown whoever had the most spare time rather than whoever was best.
                // The other direction is just as bad - a real guest should not carry a
                // loss to a computer around all weekend. The match is still SAVED, so
                // the history screen shows it happened and the round is not pretended
                // away; it simply never reaches the table.
                rated = game.ranked && result.outcome != Outcome.WALKOVER &&
                    players.none { it in bots },
            ),
        )
        historyRev++
    }

    // ---- the bot clock --------------------------------------------------------

    /**
     * HOW A BOT'S TURN ACTUALLY GETS TAKEN.
     *
     * Everything else in this service is driven by [handle], which only runs when a
     * phone asks it something. That is fine for a bracket - a tournament only has to
     * keep moving while somebody cares - but it is not fine for a bot. The owner asked
     * to be able to WATCH two bots play, and a bot that only moved when a human polled
     * would freeze the moment the last phone locked itself; worse, a bot-versus-bot
     * heat with nobody watching would sit there until the bracket's stall timer called
     * it six minutes later and the tournament would look broken.
     *
     * So the service runs one small daemon thread of its own. It is started by the
     * first [addBot] and it exits by itself the moment the last bot is gone, which is
     * why a campsite that never adds a bot never starts a thread and behaves exactly as
     * it did before any of this existed. It ticks four times a second, which is far
     * more often than a bot ever moves; the pace of a bot is [thinkTime], not this.
     *
     * It takes the same lock every guest request takes, so a bot's move and a guest's
     * move can never interleave inside a match.
     */
    private fun startBotClock() {
        if (!botClockEnabled || botThread != null) return
        botThread = Thread({
            while (true) {
                try {
                    Thread.sleep(BOT_TICK_MS)
                } catch (stopped: InterruptedException) {
                    return@Thread
                }
                if (!tickBots()) return@Thread
            }
        }, "campsite-bots").also { it.isDaemon = true; it.start() }
    }

    /** One turn of the clock. Returns false when there is no longer anything to do. */
    @Synchronized private fun tickBots(): Boolean {
        // Reap idle guests from here as well as from [handle]. Bots are only put away when
        // the last guest LEAVES, and a guest who simply closed the browser only ever
        // leaves through cleanup() - which, before this, ran solely on an incoming
        // request. With no phone asking anything the bots would tick four times a second
        // to an empty field until Campsite Mode was switched off. Once the room empties
        // the bots go with it, this returns false and the thread exits; the next addBot
        // starts a fresh clock.
        cleanup()
        if (bots.isEmpty()) {
            botThread = null
            botTurns.clear()
            return false
        }
        pulse()
        return true
    }

    /**
     * Move every bot that is ready to move. Public so a test can drive the bots itself
     * with [botClockEnabled] off, instead of sleeping and hoping.
     *
     * ONLY ROOMS THAT CONTAIN A BOT ARE TOUCHED. A room of humans is never ticked from
     * here, so nothing about a game played without bots changes in the slightest.
     */
    @Synchronized fun pulse() {
        if (bots.isEmpty()) return
        rooms.values.toList().forEach { room ->
            if (room.members.none { it in bots }) return@forEach
            // The heartbeat a room of bots would otherwise never get: without this a
            // bracket of bots would never notice a heat had finished.
            room.live()?.tick()
            tickClock(room)
            settle(room)
            room.members.filter { it in bots }.forEach { stepBot(room, it) }
        }
    }

    /**
     * One bot, one look at the position.
     *
     * Whatever the game hands back goes through [GameMatch.apply] and every `require`
     * in it, exactly as a guest's tap does. There is no privileged path: a bot's move
     * is checked by the same rules, in the same method, as a move from a phone.
     */
    private fun stepBot(room: Room, botId: String) {
        val match = liveMatchFor(room, botId)
        if (match == null || match.phase == "done") {
            botTurns.remove(botId)
            return
        }
        // Deliberately NOT filtered by waitingOn() here. A game's own botMove already
        // refuses to act out of turn, and GameMatch.apply is the real authority either
        // way - it rejects an illegal move from a bot exactly as it does from a phone.
        // Filtering here instead would lock a bot out of the moves that are not a turn
        // at all: revealing a quiz it is running, finishing a round it is leading. Those
        // are the moves that stop a bot-only round dead if nobody can make them.
        val tag = tagOf(match)
        val pending = botTurns[botId]
        if (pending == null || pending.matchTag != tag) {
            // The position changed (or this is the first look at it), so the bot starts
            // thinking about THIS position rather than cashing in a timer it earned
            // while looking at a different one.
            botTurns[botId] = BotTurn(tag, now() + thinkTime(room.game))
            return
        }
        if (now() < pending.dueAt) return
        val move = room.game.botMove(match, botId, random)
        if (move == null) {
            // "Not yet" rather than "never" - the quiet game staying quiet, I Spy not
            // having spotted it. Have another think instead of asking again in 250ms.
            botTurns[botId] = BotTurn(tag, now() + thinkTime(room.game))
            return
        }
        botTurns.remove(botId)
        // A bot must never be able to take the room down. If a game hands back a move
        // its own match rejects, that is a bug in that game: the move is dropped, the
        // bot has another think, and the humans in the room never see it.
        runCatching { match.apply(move) }
        settle(room)
        room.revision++
    }

    /**
     * A cheap fingerprint of "the position the bot is thinking about".
     *
     * [GameMatch.lastMoveAt] moves on every accepted move, and the identity of the
     * match object changes when a new round or a new heat begins, so between them they
     * catch every reason a pending think-time should be thrown away and re-rolled. It
     * is the reason a bot does not answer instantly at the start of the round after a
     * long one.
     */
    private fun tagOf(match: GameMatch): Int =
        System.identityHashCode(match) * 31 + match.lastMoveAt.toInt()

    /**
     * HOW LONG A BOT THINKS, AND WHY IT IS NOT ZERO.
     *
     * A bot that answers in no time at all is not an opponent, it is a machine, and
     * playing four in a row against something that replies before your finger has left
     * the screen is unpleasant in a way that has nothing to do with how strong it is.
     * So every bot pauses, and the pause is varied rather than fixed, because a bot
     * that always takes exactly 1.2 seconds reads as a metronome.
     *
     * The band depends on what the game asks a person to do, which is the honest
     * measure of how long it should take:
     *
     *  - A CLAIM game is 2.5-9s, and this is the band that matters most. I Spy, the
     *    Quiet Game and Snap are pure reaction: the bot's only skill is how fast it
     *    taps, so a quick bot would simply win every round and there would be no game
     *    left. The long, wide band is what makes it beatable by somebody who is
     *    actually looking out of the window.
     *  - A GRID game is 1.5-5s. A bingo square or a card from a hand is a decision
     *    somebody looks at their own card to make - slower than a board, nothing like
     *    as slow as a race to shout first.
     *  - A TYPED turn is 1.8-4.8s, because the bot is notionally typing it.
     *  - A POLL answer is 1.4-3.6s: about how long it takes to read a question and four
     *    options. It also matters that this is longer than a person CAN answer in, so
     *    the humans are never all sitting waiting on Beebo.
     *  - A BOARD move is 0.7-2.3s. Long enough to feel considered, short enough that a
     *    seven-column game does not drag.
     *
     * The band is chosen from [CampsiteGame.kind] on purpose, so a game added later
     * gets a sensible pace with no edit here; anything unrecognised falls to the board
     * band, which is the one nobody notices.
     */
    private fun thinkTime(game: CampsiteGame): Long = when (game.kind) {
        "claim" -> 2_500L + random.nextInt(6_500)
        "grid" -> 1_500L + random.nextInt(3_500)
        "text" -> 1_800L + random.nextInt(3_000)
        "poll" -> 1_400L + random.nextInt(2_200)
        else -> 700L + random.nextInt(1_600)
    }

    /** Put the bots away. Called when the server stops, so no thread outlives it. */
    @Synchronized fun shutdown() {
        // Taken out of the rooms first, while they can still be recognised as bots: an
        // id left in a roster with nothing behind it would be a seat nobody can fill.
        rooms.values.forEach { room -> room.members.removeAll { it in bots } }
        bots.clear()
        botTurns.clear()
        botThread?.interrupt()
        botThread = null
    }

    // ---- what a phone is allowed to act on and to see -------------------------

    /** The match this player may send actions to right now, if any. */
    private fun liveMatchFor(room: Room, playerId: String): GameMatch? {
        room.live()?.let { return it.matchFor(playerId) }
        val match = room.match ?: return null
        return if (playerId in match.players) match else null
    }

    /**
     * What this phone is looking at, and whether it is looking at it as a PLAYER or as
     * a SPECTATOR.
     *
     * The distinction is the whole of spectating. There is no second rendering path and
     * no spectator snapshot: everybody goes through [GameMatch.view], and the only
     * difference is the viewer handed to it. A player passes their own id and gets
     * their own cards; anybody else passes null, which the interface has always defined
     * as "no viewer, show nothing private". A game therefore cannot leak a hand to a
     * spectator without also leaking it to the bracket screen, which is a bug it would
     * have had before bots and spectating existed.
     */
    private class Viewing(val match: GameMatch?, val asPlayer: Boolean)

    private fun viewFor(room: Room, player: Player): Viewing {
        val bracket = room.live()
        if (bracket != null) {
            bracket.matchFor(player.id)?.let { return Viewing(it, true) }
            // Not in a live heat: knocked out, sitting a round out, watching on purpose,
            // or never entered. They may follow any heat they picked off the bracket.
            return Viewing(bracket.boutById(player.watchBout)?.match, false)
        }
        val match = room.match ?: return Viewing(null, false)
        return Viewing(match, player.id in match.players)
    }

    private fun phaseOf(room: Room, player: Player): String {
        val view = viewFor(room, player).match
        return when {
            view != null -> view.phase
            room.live() != null -> "waiting"
            else -> "lobby"
        }
    }

    /**
     * The replay counter this phone must echo back. Free play uses the room's; a heat
     * uses its own, so a new question in one heat cannot reject a tap in another.
     */
    private fun roundOf(room: Room, playerId: String): Int =
        room.live()?.roundCounterFor(playerId) ?: room.round

    // ---- what every poll would otherwise rebuild ------------------------------
    //
    // Every guest phone asks for a snapshot about once a second, and the host serves
    // them all on battery. The catalogue never changes and the saved history changes
    // only when a round ends, so neither is rebuilt per poll: the catalogue's fixed
    // fields are made once, and the menu's tables are kept until [historyRev] moves.
    // All of it is read and written under this object's lock - [snapshot] only runs
    // from [handle], and the two writers to [history] run from [handle] or [pulse] -
    // so plain fields are enough and nothing here needs a lock of its own.

    /**
     * Moves every time something is written to [history]: a match in [save], a trophy
     * in [Bridge.onChampion]. It is the only thing that invalidates the tables below.
     */
    private var historyRev = 0

    /** The [historyRev] the menu tables were built at; -1 until the first menu poll. */
    private var menuRev = -1
    private var menuLeaderboard: JsonArray = JsonArray(emptyList())
    private var menuHistory: JsonArray = JsonArray(emptyList())
    private var menuChampions: JsonArray = JsonArray(emptyList())

    /** The in-room table, per game id, built at [roomStandingsRev]. */
    private var roomStandingsRev = -1
    private val roomTables = hashMapOf<String, JsonArray>()

    private fun menuTables() {
        if (menuRev == historyRev) return
        menuLeaderboard = standingsJson(history.leaderboard(null), 10)
        menuHistory = historyJson(history.recent(12))
        menuChampions = championsJson(history.champions(6))
        menuRev = historyRev
    }

    private fun roomStandings(gameId: String): JsonArray {
        if (roomStandingsRev != historyRev) { roomTables.clear(); roomStandingsRev = historyRev }
        return roomTables.getOrPut(gameId) { standingsJson(history.leaderboard(gameId), 5) }
    }

    /**
     * One menu card's fixed fields, split around the two live ones so the wire shape
     * is exactly what it was: id, title, players, blurb, kind, seatsMin, seatsMax,
     * bracket, running. Only `players` and `running` are looked up per poll.
     */
    private class CatalogueCard(val id: String, val lead: JsonObject, val rest: JsonObject)

    private fun snapshot(p: Player): JsonObject = buildJsonObject {
        put("ok", true); put("you", p.id); put("name", p.name)
        put("games", JsonArray(CATALOGUE.map { card ->
            val room = rooms[card.id]
            JsonObject(buildMap<String, JsonElement>(9) {
                putAll(card.lead)
                put("players", JsonPrimitive(room?.members?.size ?: 0))
                putAll(card.rest)
                put("running", JsonPrimitive(room?.live() != null))
            })
        }))
        val r = rooms[p.game]
        if (r == null) {
            // The menu is where a leaderboard belongs, and keeping it off the in-game
            // poll keeps that poll small.
            menuTables()
            put("leaderboard", menuLeaderboard)
            put("history", menuHistory)
            put("champions", menuChampions)
            return@buildJsonObject
        }
        val viewing = viewFor(r, p)
        val view = viewing.match
        val seats = view?.players.orEmpty()
        put("room", buildJsonObject {
            put("game", r.key); put("title", r.game.title)
            put("blurb", r.game.blurb); put("kind", r.game.kind)
            put("owner", r.owner)
            put("round", roundOf(r, p.id)); put("revision", r.revision)
            put("phase", phaseOf(r, p))
            // What the page needs to draw the watching state, and nothing more: whether
            // this phone is a spectator right now, whether it asked to be, and how many
            // of the seats in the room are computer players.
            put("watching", view != null && !viewing.asPlayer)
            put("spectating", p.spectating)
            put("watchMatch", p.watchBout)
            put("bots", r.members.count { it in bots })
            put("bracket", r.game.tournamentReady)
            put("players", buildJsonArray { r.members.forEach { id -> add(buildJsonObject {
                put("id", id); put("name", playerName(id)); put("active", id in seats)
                put("score", view?.scoreOf(id) ?: 0); put("answered", view?.hasAnswered(id) ?: false)
                // A bot is never "reconnecting", because it never went anywhere.
                put("online", id in bots || sessions.values.any { it.id == id && now() - it.seen < 12_000 })
                put("bot", id in bots)
                put("watching", sessionOf(id)?.spectating == true)
            }) } })
            put("seats", JsonArray(seats.map { JsonPrimitive(it) }))
            // Everything below here is the game's own, rendered for THIS player only:
            // another player's cards, card marks or secret are never in it.
            //
            // A SPECTATOR IS HANDED null, not their own id. That is the difference
            // between watching and playing, and it is one argument rather than a second
            // code path precisely so it cannot drift apart from the rule it enforces.
            (view?.view(if (viewing.asPlayer) p.id else null) ?: MatchFields.defaults(0))
                .forEach { (key, value) -> put(key, value) }
            put("standings", roomStandings(r.key))
        })
        r.tournament?.let { put("tournament", it.snapshot(p.id)) }
    }

    private fun standingsJson(rows: List<Standing>, limit: Int): JsonArray = JsonArray(
        rows.take(limit).map { row ->
            buildJsonObject {
                put("name", row.name)
                put("played", row.played)
                put("wins", row.wins)
                put("draws", row.draws)
                put("losses", row.losses)
                put("championships", row.championships)
                put("winRate", (row.winRate * 100).toInt())
                put("rating", (row.rating * 100).toInt())
                put("provisional", row.provisional)
            }
        },
    )

    private fun historyJson(rows: List<MatchRecord>): JsonArray = JsonArray(
        rows.map { row ->
            buildJsonObject {
                put("game", row.game); put("title", row.title)
                put("winner", row.winner); put("outcome", row.outcome)
                put("endedAt", row.endedAt); put("round", row.round)
                put("tournament", row.tournament)
                put("players", JsonArray(row.players.map { player ->
                    buildJsonObject {
                        put("name", player.name); put("score", player.score); put("won", player.won)
                    }
                }))
            }
        },
    )

    private fun championsJson(rows: List<ChampionRecord>): JsonArray = JsonArray(
        rows.map { row ->
            buildJsonObject {
                put("game", row.game); put("title", row.title)
                put("champion", row.champion); put("players", row.players); put("endedAt", row.endedAt)
            }
        },
    )

    private fun error(code: Int, text: String) = Reply(code, buildJsonObject { put("ok", false); put("error", text) })
    private fun JsonObject.text(key: String) = (this[key] as? JsonPrimitive)?.content.orEmpty()
    private fun JsonObject.number(key: String) = (this[key] as? JsonPrimitive)?.intOrNull ?: -1

    companion object {
        /** id to title, in menu order. The catalogue owns the list; this is the old shape. */
        val GAMES: LinkedHashMap<String, String> = CampsiteGameCatalog.titles()

        /** The menu cards' fixed fields, built once: [CampsiteGameCatalog.ALL] never changes. */
        private val CATALOGUE: List<CatalogueCard> = CampsiteGameCatalog.ALL.map { game ->
            CatalogueCard(
                id = game.id,
                lead = buildJsonObject { put("id", game.id); put("title", game.title) },
                // Served from the game itself so a new game needs no edit to the guest page.
                rest = buildJsonObject {
                    put("blurb", game.blurb); put("kind", game.kind)
                    put("seatsMin", game.seats.min); put("seatsMax", game.seats.max)
                    put("bracket", game.tournamentReady)
                    put("needsGuests", game.needsGuests)
                    put("category", game.category.name)
                    put("needsTouch", game.needsTouch)
                },
            )
        }

        /** Guests and bots share it, because they share the seats it is really about. */
        private const val ROOM_CAP = 12

        /** How often the bot clock looks. A bot's pace is [thinkTime], not this. */
        private const val BOT_TICK_MS = 250L

        /** The house bots, in the order the owner named them. */
        private val BOT_NAMES = listOf("Beebo", "Appa", "Jenkins")

        /**
         * Beyond the three, a friendly invented name picked at random. No real people
         * and no brands: these are shown to guests who did not choose them, so they are
         * all plainly made up.
         */
        private val EXTRA_BOT_NAMES = listOf(
            "Pip", "Marla", "Tumble", "Nook", "Bramble", "Cobble", "Doodle", "Fern",
            "Gilly", "Hopper", "Juniper", "Kettle", "Lumen", "Mossy", "Noodle", "Otto",
            "Pebble", "Quill", "Rusty", "Sprocket", "Tilly", "Waffle", "Yarrow", "Ziggy",
        )
    }
}
