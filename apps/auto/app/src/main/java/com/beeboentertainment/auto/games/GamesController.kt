package com.beeboentertainment.auto.games

import com.beeboentertainment.auto.data.Prefs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/*
 * The brain behind [GamesScreen]: it owns the lobby, builds a game's seats, runs
 * the [GameEngine], and keeps everything a car full (or empty) of passengers
 * needs in sync — mapping all of it to one immutable [GamesUiState] the Compose
 * layer collects.
 *
 * The two ways to play, and how bots fill in
 * ------------------------------------------
 *  - SOLO (no hub, or you are alone in the room): the table is you + a real
 *    [BotPlayer] ("Cruisin' Carl"). Nothing touches the network; it works fully
 *    offline.
 *  - MULTIPLAYER (>=2 passengers in the room): every present passenger gets a
 *    seat, driven locally for your own seat and by the room socket for the rest.
 *    Whoever's turn it is sends their move; everyone applies it.
 *
 * Bot fallback + one authority
 * ----------------------------
 * If a passenger leaves mid-game their seat must still move. To keep two devices
 * from computing DIFFERENT bot moves, exactly one device is the authority — the
 * member with the lexicographically lowest id (a stable, everyone-agrees choice).
 * The authority computes the departed seat's move with Carl's brain, applies it
 * locally, and broadcasts it; every other device just receives it over the wire,
 * indistinguishable from a human's move. Seats never change type on the other
 * devices, so there is nothing to disagree about.
 */

/** The id used on the wire for this game. */
private const val GAME_ID = "roadside-rumble"

/** How long a bot "thinks" before playing, so moves don't snap down instantly. */
private const val BOT_THINK_MS = 650L

enum class GamePhase { MENU, LOBBY, PLAYING }

/** One tile as the UI should draw it. */
data class TileUi(
    val row: Int,
    val col: Int,
    val ownerColorIndex: Int?,   // null = unclaimed
    val locked: Boolean,         // locked by an adjacent claim this turn
    val claimable: Boolean,
)

/** One seat's line on the scoreboard. */
data class ScoreUi(
    val seatId: String,
    val name: String,
    val count: Int,
    val isYou: Boolean,
    val isBot: Boolean,
    val colorIndex: Int,
)

/** The end-of-game verdict. */
data class ResultUi(
    val tie: Boolean,
    val winnerName: String?,
    val youWon: Boolean,
)

/** Everything needed to draw the board mid- or end-game. */
data class BoardUi(
    val size: Int,
    val tiles: List<TileUi>,
    val scores: List<ScoreUi>,
    val currentSeatName: String,
    val yourTurn: Boolean,
    val turnsPlayed: Int,
    val totalTurns: Int,
    val result: ResultUi?,       // null while the game is in progress
)

/** The whole screen state, as one immutable value. */
data class GamesUiState(
    val phase: GamePhase = GamePhase.MENU,
    val youName: String = "",
    val youId: String = "",
    val difficulty: BotDifficulty = BotDifficulty.MEDIUM,
    val connected: Boolean = false,          // in a hub room
    val lobby: List<GameMember> = emptyList(),
    val board: BoardUi? = null,
)

/**
 * @param transport the room transport, or null when there is no hub session —
 *   then only solo-vs-Carl is available and nothing hits the network.
 */
class GamesController(
    private val prefs: Prefs,
    private val transport: GameTransport?,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
) {
    private val _ui = MutableStateFlow(
        GamesUiState(
            youName = prefs.lastPlayerName.ifBlank { prefs.userName.ifBlank { "You" } },
            difficulty = BotDifficulty.from(prefs.gameBotDifficulty),
        )
    )
    val ui: StateFlow<GamesUiState> = _ui.asStateFlow()

    private var rosterJob: Job? = null
    private var game: ActiveGame? = null
    private var lastMultiplayer: Boolean = false

    /** Live per-game wiring, thrown away and rebuilt each game. */
    private class ActiveGame(
        val engine: GameEngine<RoadsideState, RoadsideMove>,
        val order: List<PlayerSlot<RoadsideState, RoadsideMove>>,
        val colorIndexById: Map<String, Int>,
        val myLocalSeatId: String,
        val multiplayer: Boolean,
        val jobs: MutableList<Job> = mutableListOf(),
    )

    // ------------------------------------------------------------------- lobby

    /** Open the room (if any) and start mirroring its roster into the lobby. */
    fun connect() {
        val t = transport ?: return
        if (rosterJob != null) return
        rosterJob = scope.launch {
            t.roster.collect { r ->
                _ui.update { it.copy(connected = true, youId = r.youId, lobby = r.members) }
            }
        }
        t.start(_ui.value.youName)
    }

    fun openGame() = _ui.update { it.copy(phase = GamePhase.LOBBY) }
    fun backToMenu() {
        teardownGame()
        _ui.update { it.copy(phase = GamePhase.MENU, board = null) }
    }

    fun setPlayerName(name: String) {
        prefs.lastPlayerName = name
        _ui.update { it.copy(youName = name) }
    }

    fun setDifficulty(d: BotDifficulty) {
        prefs.gameBotDifficulty = d.name
        _ui.update { it.copy(difficulty = d) }
    }

    /** True when there are enough passengers in the room for a synced game. */
    fun canPlayMultiplayer(): Boolean =
        transport != null && _ui.value.lobby.size >= 2

    // -------------------------------------------------------------- start play

    /** Solo table: you + Cruisin' Carl. No network. */
    fun startSolo() {
        teardownGame()
        lastMultiplayer = false
        val difficulty = _ui.value.difficulty
        val you = HumanPlayer<RoadsideState, RoadsideMove>("you", _ui.value.youName.ifBlank { "You" })
        val carl = BotPlayer("beebo", "Beebo", CruisinCarl(difficulty), BOT_THINK_MS)
        val order = listOf<PlayerSlot<RoadsideState, RoadsideMove>>(you, carl)

        val engine = GameEngine(RoadsideRumbleRules, order)
        val g = ActiveGame(
            engine = engine,
            order = order,
            colorIndexById = order.mapIndexed { i, s -> s.id to i }.toMap(),
            myLocalSeatId = "you",
            multiplayer = false,
        )
        game = g
        launchState(g)
        // Solo owns no wire: run with no broadcast.
        g.jobs += scope.launch { engine.run() }
        _ui.update { it.copy(phase = GamePhase.PLAYING) }
    }

    /** Synced table with every present passenger; the authority fills any seat
     *  that loses its human. */
    fun startMultiplayer() {
        val t = transport ?: return startSolo()
        val members = _ui.value.lobby.sortedBy { it.id }
        val myId = _ui.value.youId
        if (members.size < 2 || members.none { it.id == myId }) return startSolo()

        teardownGame()
        lastMultiplayer = true
        val order = members.map { HumanPlayer<RoadsideState, RoadsideMove>(it.id, it.name) }
        val engine = GameEngine(RoadsideRumbleRules, order)
        val g = ActiveGame(
            engine = engine,
            order = order,
            colorIndexById = order.mapIndexed { i, s -> s.id to i }.toMap(),
            myLocalSeatId = myId,
            multiplayer = true,
        )
        game = g
        launchState(g)

        // Broadcast only the moves this device OWNS — its own seat. A move that
        // arrived over the wire is applied by submit() below, and re-broadcasting
        // it would echo, so onMove filters to our own seat id.
        g.jobs += scope.launch {
            engine.run { seatIndex, move ->
                val seatId = order[seatIndex].id
                if (seatId == myId) {
                    t.broadcast(GameNetMove(GAME_ID, seatId, move.row, move.col, moveTurn(engine)))
                }
            }
        }

        // Apply remote moves into the matching seat.
        g.jobs += scope.launch {
            t.incoming.collect { net ->
                if (net.game != GAME_ID || net.seatId == myId) return@collect
                order.firstOrNull { it.id == net.seatId }?.submit(RoadsideMove(net.row, net.col))
            }
        }

        // Authority (lowest member id) fills any seat whose passenger has left.
        val authorityId = members.first().id  // members is sorted by id
        if (myId == authorityId) g.jobs += scope.launch { superviseAbsentSeats(g, t) }

        _ui.update { it.copy(phase = GamePhase.PLAYING) }
    }

    fun rematch() {
        if (lastMultiplayer && canPlayMultiplayer()) startMultiplayer() else startSolo()
    }

    // ------------------------------------------------------------------ moves

    /** Called by the UI when the local player taps a tile. Ignored unless it is
     *  your turn and the tile is open. */
    fun claimTile(row: Int, col: Int) {
        val g = game ?: return
        val st = g.engine.state.value
        if (RoadsideRumbleRules.isOver(st)) return
        val idx = RoadsideRumbleRules.currentSeatIndex(st)
        val seat = g.order[idx]
        if (seat.id != g.myLocalSeatId) return
        if (!st.isClaimable(st.indexOf(row, col))) return
        @Suppress("UNCHECKED_CAST")
        (seat as? HumanPlayer<RoadsideState, RoadsideMove>)?.submit(RoadsideMove(row, col))
    }

    // --------------------------------------------------------------- internals

    /** The turn a just-applied move was made on (state has already advanced). */
    private fun moveTurn(engine: GameEngine<RoadsideState, RoadsideMove>): Int =
        (engine.state.value.turnsPlayed - 1).coerceAtLeast(0)

    private fun launchState(g: ActiveGame) {
        g.jobs += scope.launch {
            g.engine.state.collect { st -> _ui.update { it.copy(board = buildBoard(g, st)) } }
        }
    }

    /**
     * Authority-only: when the turn belongs to a seat whose passenger has left the
     * room, compute that seat's move with Carl's brain, apply it, and broadcast it.
     * Runs at most once per turn (guarded by the turn number).
     */
    private suspend fun superviseAbsentSeats(g: ActiveGame, t: GameTransport) {
        val carl = CruisinCarl(_ui.value.difficulty)
        var handledTurn = -1
        g.engine.state.collect { st ->
            if (RoadsideRumbleRules.isOver(st)) return@collect
            val idx = RoadsideRumbleRules.currentSeatIndex(st)
            val seat = g.order[idx]
            val present = _ui.value.lobby.any { it.id == seat.id }
            if (seat.id != g.myLocalSeatId && !present && handledTurn != st.turnsPlayed) {
                handledTurn = st.turnsPlayed
                delay(BOT_THINK_MS)
                // Re-check the game did not end or move on while we waited.
                val now = g.engine.state.value
                if (RoadsideRumbleRules.isOver(now) || now.turnsPlayed != st.turnsPlayed) return@collect
                val move = carl.chooseMove(now)
                @Suppress("UNCHECKED_CAST")
                (seat as? HumanPlayer<RoadsideState, RoadsideMove>)?.submit(move)
                t.broadcast(GameNetMove(GAME_ID, seat.id, move.row, move.col, now.turnsPlayed))
            }
        }
    }

    private fun buildBoard(g: ActiveGame, st: RoadsideState): BoardUi {
        val scoreMap = RoadsideRumbleRules.scores(st)
        val tiles = ArrayList<TileUi>(st.tileCount)
        for (i in 0 until st.tileCount) {
            tiles.add(
                TileUi(
                    row = st.rowOf(i),
                    col = st.colOf(i),
                    ownerColorIndex = st.owners[i]?.let { g.colorIndexById[it] },
                    locked = st.isLocked(i),
                    claimable = st.isClaimable(i),
                )
            )
        }
        val scores = g.order.map { seat ->
            ScoreUi(
                seatId = seat.id,
                name = seat.name,
                count = scoreMap[seat.id] ?: 0,
                isYou = seat.id == g.myLocalSeatId,
                isBot = seat.isBot,
                colorIndex = g.colorIndexById[seat.id] ?: 0,
            )
        }
        val idx = RoadsideRumbleRules.currentSeatIndex(st)
        val over = RoadsideRumbleRules.isOver(st)
        val result = if (!over) null else when (val r = RoadsideRumbleRules.result(st)) {
            is RoadsideResult.Win -> ResultUi(
                tie = false,
                winnerName = g.order.firstOrNull { it.id == r.seatId }?.name,
                youWon = r.seatId == g.myLocalSeatId,
            )
            is RoadsideResult.Tie -> ResultUi(tie = true, winnerName = null, youWon = false)
            RoadsideResult.InProgress -> null
        }
        return BoardUi(
            size = st.size,
            tiles = tiles,
            scores = scores,
            currentSeatName = g.order[idx].name,
            yourTurn = !over && g.order[idx].id == g.myLocalSeatId,
            turnsPlayed = st.turnsPlayed,
            totalTurns = st.totalTurns,
            result = result,
        )
    }

    private fun teardownGame() {
        game?.jobs?.forEach { it.cancel() }
        game = null
    }

    /** Release the room and all coroutines. Call from the composable's onDispose. */
    fun dispose() {
        teardownGame()
        rosterJob?.cancel()
        transport?.stop()
        scope.cancel()
    }
}
