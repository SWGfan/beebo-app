package com.beeboentertainment.auto.party

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable

/*
 * Wire models for the hub "watch party" room protocol (JSON over a wss socket).
 *
 * Same two-layer split as HubModels.kt: the @Serializable *Msg types mirror the
 * wire JSON one field at a time, every field nullable or defaulted so the hub
 * can grow its payloads without breaking an installed app (the Json parser is
 * configured with ignoreUnknownKeys, exactly like ApiClient/HubClient). The
 * small [RoomEvent] sealed shape below is what the rest of the app consumes;
 * [RoomClient] maps the decoded messages onto it.
 *
 * The protocol itself lives in WATCH-PARTY.md.
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

    /** A drift-correction beat from the host. See [PartyController]. */
    data class Sync(
        val from: String,
        val positionMs: Long,
        val playing: Boolean,
        val videoId: String? = null,
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

    /**
     * The hub refused this client for a reason retrying won't fix (an expired
     * or wrong sign-in, a malformed request). Terminal: no reconnect is
     * scheduled. [reason] is a sentence worth showing.
     */
    data class Failed(val reason: String) : RoomConnection()
}

@Serializable
internal data class ErrorMsg(val error: String = "")

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
    // What the host is playing. Lets a viewer that joined after the host's
    // `load` catch up within one beat. Older hosts don't send it.
    val videoId: String? = null,
    val from: String = "",
)

// ---- outgoing envelopes (the hub adds "from" on the way out; we never send it)
//
// `type` MUST carry @EncodeDefault. RoomClient's Json does not encode default
// values, so without it every envelope went out with no "type" at all and the
// hub, which switches on type, silently dropped every control, sync and bye.

@Serializable
internal data class OutControl(
    @OptIn(ExperimentalSerializationApi::class) @EncodeDefault val type: String = "control",
    val action: String,
    val positionMs: Long,
    val videoId: String? = null,
)

@Serializable
internal data class OutSync(
    @OptIn(ExperimentalSerializationApi::class) @EncodeDefault val type: String = "sync",
    val positionMs: Long,
    val playing: Boolean,
    val videoId: String? = null,
)

@Serializable
internal data class OutBye(@OptIn(ExperimentalSerializationApi::class) @EncodeDefault val type: String = "bye")
