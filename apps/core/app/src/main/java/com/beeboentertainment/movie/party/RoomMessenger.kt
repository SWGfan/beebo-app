package com.beeboentertainment.movie.party

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import com.beeboentertainment.movie.data.SessionStore
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
import kotlinx.serialization.json.JsonObject

/**
 * A thin, player-free front for a [RoomClient] used by the party mini-games and the
 * shared checklist.
 *
 * [PartyController] is the other consumer of a [RoomClient], but it exists to lock a
 * Media3 player to a host's timeline. Games and lists have no player — they only need
 * to fan a few JSON messages out to the room and hear the room's back — so this class
 * exposes exactly that: the live roster, our own id, a connected flag, and the stream
 * of [RoomEvent.App] envelopes, plus [send] to broadcast one.
 *
 * It owns its own [RoomClient] (one socket, one member) so opening a game screen never
 * disturbs a watch party running on a different controller. Threading mirrors
 * [PartyController]: [RoomClient] delivers on its own thread, and everything here is
 * re-emitted onto Main-confined flows the UI can collect directly.
 */
class RoomMessenger(
    private val room: RoomClient,
    private val scope: CoroutineScope =
        CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
) {
    private val _members = MutableStateFlow<List<RoomMember>>(emptyList())
    /** Everyone currently in the room, including us. */
    val members: StateFlow<List<RoomMember>> = _members.asStateFlow()

    private val _you = MutableStateFlow("")
    /** Our own member id, learned from the roster. Empty until connected. */
    val you: StateFlow<String> = _you.asStateFlow()

    private val _connected = MutableStateFlow(false)
    /** True once the socket is up and the roster has landed. */
    val connected: StateFlow<Boolean> = _connected.asStateFlow()

    // replay = 0: app messages are live commands; a late collector should not be
    // handed a stale prompt/answer. The buffer absorbs bursts off the socket thread.
    private val _app = MutableSharedFlow<RoomEvent.App>(replay = 0, extraBufferCapacity = 64)
    /** Application envelopes from OTHER members (the hub never echoes our own). */
    val app: SharedFlow<RoomEvent.App> = _app.asSharedFlow()

    private val _joins = MutableSharedFlow<RoomMember>(replay = 0, extraBufferCapacity = 16)
    /** Fires when a new member joins — a cue to re-broadcast state so they catch up. */
    val memberJoined: SharedFlow<RoomMember> = _joins.asSharedFlow()

    private var connJob: Job? = null
    private var eventsJob: Job? = null
    private var started = false

    /** Join the room as [deviceName] and start delivering to the flows. Idempotent. */
    fun start(deviceName: String) {
        if (started) return
        started = true

        connJob = scope.launch {
            room.connection.collect { _connected.value = it is RoomConnection.Connected }
        }
        eventsJob = scope.launch {
            room.events.collect { e ->
                when (e) {
                    is RoomEvent.Roster -> {
                        _you.value = e.you
                        _members.value = e.members
                    }
                    is RoomEvent.MemberJoined -> {
                        _members.value = _members.value.filterNot { it.id == e.member.id } + e.member
                        _joins.tryEmit(e.member)
                    }
                    is RoomEvent.MemberLeft ->
                        _members.value = _members.value.filterNot { it.id == e.id }
                    is RoomEvent.App -> _app.tryEmit(e)
                    else -> Unit // control / sync belong to a watch party, not here
                }
            }
        }

        // Role is irrelevant for app messages; join as a plain viewer so we never
        // present ourselves as the playback host of some unrelated watch party.
        room.connect(deviceName, RoomRole.VIEWER)
    }

    /** Broadcast an application envelope of [type] carrying [payload]. Safe any time. */
    fun send(type: String, payload: JsonObject): Boolean = room.sendApp(type, payload)

    /** Leave the room and stop delivering. Idempotent. */
    fun stop() {
        connJob?.cancel(); connJob = null
        eventsJob?.cancel(); eventsJob = null
        room.leave()
        _connected.value = false
        started = false
    }
}

/**
 * Builds and remembers a [RoomMessenger] for the current hub session, or null when the
 * device is not signed in to the Beebo Hub (no token, so no room to join). Mirrors
 * [rememberParty]: the messenger joins on first composition and leaves when it drops out.
 */
@Composable
fun rememberRoomMessenger(session: SessionStore, deviceName: String): RoomMessenger? {
    val hubToken = session.hubToken
    val messenger = remember(hubToken) {
        if (hubToken.isNullOrBlank()) null else RoomMessenger(RoomClient(hubToken))
    }
    LaunchedEffect(messenger, deviceName) { messenger?.start(deviceName) }
    DisposableEffect(messenger) { onDispose { messenger?.stop() } }
    return messenger
}
