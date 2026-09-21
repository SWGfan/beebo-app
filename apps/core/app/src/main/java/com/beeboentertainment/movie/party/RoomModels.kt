package com.beeboentertainment.movie.party

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/*
 * Wire models for the hub "watch party" room protocol (JSON over a wss socket).
 *
 * Two-layer split: the @Serializable Msg types mirror the wire JSON one field at
 * a time, every field nullable or defaulted so the hub can grow its payloads
 * without breaking an installed app (the Json parser is configured with
 * ignoreUnknownKeys, exactly like ApiClient/HubClient). The small [RoomEvent]
 * sealed shape below is what the rest of the app consumes; [RoomClient] maps the
 * decoded messages onto it.
 */

// ------------------------------------------------------------------- room roles

/** Which side of the party this device is on. Sent as the `role` query param. */
enum class RoomRole(val wire: String) {
    HOST("host"),
    VIEWER("viewer");

    companion object {
        fun from(raw: String?): RoomRole =
            if (raw?.equals("host", ignoreCase = true) == true) HOST else VIEWER
    }
}

// ------------------------------------------------------------------- public API

/** One member of the room, as the hub reports it in roster/member events. */
@Serializable
data class RoomMember(
    val id: String,
    val name: String = "",
    val role: String = "viewer",
    val joinedAt: Long = 0L,
)

/**
 * Everything a caller reacts to, decoded from the hub's envelopes plus the
 * transport's own connection lifecycle. [RoomClient] emits these on a flow;
 * [PartyController] is the main consumer.
 */
sealed class RoomEvent {
    /** The socket opened and the hub sent the initial roster. [you] is our own id. */
    data class Roster(val you: String, val members: List<RoomMember>) : RoomEvent()

    data class MemberJoined(val member: RoomMember) : RoomEvent()

    data class MemberLeft(val id: String) : RoomEvent()

    /**
     * A playback command from ANOTHER device (the hub never echoes our own).
     * [from] is the sender's member id. [positionMs] is a media position;
     * [videoId] is set for `load` (and carried through for others when present).
     */
    data class Control(
        val from: String,
        val action: String,
        val positionMs: Long,
        val videoId: String?,
    ) : RoomEvent()

    /**
     * A drift-correction beat from the host. See [PartyController].
     *
     * [videoId] is what the host currently has loaded. It rides on every beat
     * (not just on `load`) so a viewer that joins AFTER the host started, or
     * that missed the one-shot `load`, still learns which film to open. Null
     * from an older host build that does not send it — treat that as "no
     * information", never as "the host has nothing loaded".
     */
    data class Sync(
        val from: String,
        val positionMs: Long,
        val playing: Boolean,
        val videoId: String? = null,
    ) : RoomEvent()

    /**
     * A generic application envelope from ANOTHER member: a party game move, or a
     * packing-checklist edit. [msgType] is the wire type (e.g. "checklist_item")
     * and [data] is the whole decoded object, so a feature can carry whatever
     * fields it likes without a new model here. [from] is the sender's member id,
     * stamped by the hub.
     */
    data class App(
        val from: String,
        val msgType: String,
        val data: JsonObject,
    ) : RoomEvent()
}

/**
 * Where the socket is. Independent of role — a host and a viewer both move
 * through the same connection lifecycle. [Reconnecting.attempt] counts from 1.
 */
sealed class RoomConnection {
    object Disconnected : RoomConnection()
    object Connecting : RoomConnection()
    object Connected : RoomConnection()
    data class Reconnecting(val attempt: Int) : RoomConnection()
}

// ------------------------------------------------------------------- wire (DTO)

@Serializable
internal data class RosterMsg(
    val you: String = "",
    val members: List<RoomMember> = emptyList(),
)

@Serializable
internal data class MemberJoinedMsg(val member: RoomMember? = null)

@Serializable
internal data class MemberLeftMsg(val id: String = "")

@Serializable
internal data class ControlMsg(
    val action: String = "",
    val positionMs: Long = 0L,
    val videoId: String? = null,
    val from: String = "",
)

@Serializable
internal data class SyncMsg(
    val positionMs: Long = 0L,
    val playing: Boolean = false,
    val videoId: String? = null,
    val from: String = "",
)

// ---- outgoing envelopes (the hub adds "from" on the way out; we never send it)

@Serializable
internal data class OutControl(
    val type: String = "control",
    val action: String,
    val positionMs: Long,
    val videoId: String? = null,
)

@Serializable
internal data class OutSync(
    val type: String = "sync",
    val positionMs: Long,
    val playing: Boolean,
    // Added after the first release. The hub relays a sync envelope verbatim
    // ({...message, from}), so this needed no hub change, and an older app
    // ignores the extra key (its Json is configured with ignoreUnknownKeys).
    val videoId: String? = null,
)

@Serializable
internal data class OutBye(val type: String = "bye")
