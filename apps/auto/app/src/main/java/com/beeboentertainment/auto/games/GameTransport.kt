package com.beeboentertainment.auto.games

import com.beeboentertainment.auto.party.RoomClient
import com.beeboentertainment.auto.party.RoomEvent
import com.beeboentertainment.auto.party.RoomRole
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/*
 * The multiplayer transport for games.
 *
 * Turn-based sync is simple: whoever's turn it is sends their move, everyone else
 * applies it. We ride the EXISTING hub room socket for this rather than opening
 * anything new — [RoomClient] already gives every device in a car a shared room
 * (keyed by hub account), a roster, and join/leave events, exactly the primitives
 * a game lobby needs.
 *
 * [RoomClient]'s wire envelope is fixed and we do not edit existing files, so a
 * game move rides INSIDE a `control` message: `action = "game"` marks it and the
 * move's JSON travels in the otherwise-unused `videoId` field. The party feature
 * uses "play"/"pause"/… actions on the same socket, so the "game" action never
 * collides with it. This is the games equivalent of the brief's
 * `{"type":"control","game":…,"move":…}` shape, expressed within the envelope the
 * transport already has.
 */

/** A game move as it crosses the wire, tagged with the seat that made it. */
@Serializable
data class GameNetMove(
    val game: String,
    val seatId: String,
    val row: Int,
    val col: Int,
    val turn: Int,
)

/** One member of the game lobby (a projection of the room roster). */
data class GameMember(val id: String, val name: String)

/** Who is in the room and which member this device is. */
data class GameRoster(
    val youId: String = "",
    val members: List<GameMember> = emptyList(),
)

/**
 * The transport surface a [GamesController] needs. An interface so the controller
 * can be driven by a fake in isolation and by [RoomGameTransport] in the app.
 */
interface GameTransport {
    val incoming: SharedFlow<GameNetMove>
    val roster: StateFlow<GameRoster>

    /** Join the room as [displayName] and start delivering roster + moves. */
    fun start(displayName: String)

    /** Broadcast one of this device's moves to the room. */
    fun broadcast(move: GameNetMove)

    /** Leave the room. */
    fun stop()
}

/**
 * [GameTransport] over the hub room, wrapping a [RoomClient] the same way
 * [com.beeboentertainment.auto.party.PartyController] does.
 */
class RoomGameTransport(
    private val room: RoomClient,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
) : GameTransport {

    private val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        explicitNulls = false
    }

    private val _incoming = MutableSharedFlow<GameNetMove>(replay = 0, extraBufferCapacity = 64)
    override val incoming: SharedFlow<GameNetMove> = _incoming.asSharedFlow()

    private val _roster = MutableStateFlow(GameRoster())
    override val roster: StateFlow<GameRoster> = _roster.asStateFlow()

    private var eventsJob: Job? = null

    override fun start(displayName: String) {
        if (eventsJob != null) return
        eventsJob = scope.launch {
            room.events.collect { event -> handle(event) }
        }
        // Role is irrelevant to a game — we only want the shared roster + relay —
        // so we join as a viewer, the neutral role.
        room.connect(displayName, RoomRole.VIEWER)
    }

    private fun handle(event: RoomEvent) {
        when (event) {
            is RoomEvent.Roster -> _roster.value = GameRoster(
                youId = event.you,
                members = event.members.map { GameMember(it.id, it.name.ifBlank { "Passenger" }) },
            )
            is RoomEvent.MemberJoined -> {
                val kept = _roster.value.members.filterNot { it.id == event.member.id }
                _roster.value = _roster.value.copy(
                    members = kept + GameMember(event.member.id, event.member.name.ifBlank { "Passenger" }),
                )
            }
            is RoomEvent.MemberLeft -> _roster.value = _roster.value.copy(
                members = _roster.value.members.filterNot { it.id == event.id },
            )
            is RoomEvent.Control -> if (event.action == GAME_ACTION) {
                val payload = event.videoId ?: return
                val move = runCatching { json.decodeFromString<GameNetMove>(payload) }.getOrNull()
                if (move != null) _incoming.tryEmit(move)
            }
            is RoomEvent.Sync -> Unit // not used by games
        }
    }

    override fun broadcast(move: GameNetMove) {
        room.sendControl(
            action = GAME_ACTION,
            positionMs = move.turn.toLong(),
            videoId = json.encodeToString(move),
        )
    }

    override fun stop() {
        eventsJob?.cancel(); eventsJob = null
        room.leave()
        _roster.value = GameRoster()
    }

    private companion object {
        const val GAME_ACTION = "game"
    }
}
