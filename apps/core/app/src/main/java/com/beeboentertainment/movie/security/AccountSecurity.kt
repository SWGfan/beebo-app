package com.beeboentertainment.movie.security

import com.beeboentertainment.movie.server.SafeText
import com.beeboentertainment.movie.server.ServerJson
import kotlinx.serialization.Serializable

/*
 * The account security routes under /api/account/security (desktop/apps/desktop/electron/accountSecurityApi.js), bearer token.
 * A person's own settings only. Every field has a default so an older or newer server never
 * breaks decoding.
 */

@Serializable
data class TwoFactorStatus(
    val enabled: Boolean = false,
    val enabledAt: Long? = null,
    val recoveryRemaining: Int = 0,
)

@Serializable
data class SecurityPolicy(val requireForAdmins: Boolean = false)

@Serializable
data class DeviceSession(
    /** The 12-character handle to revoke it by. */
    val id: String = "",
    val device: String = "",
    /** "web" or "app". */
    val kind: String = "web",
    val method: String = "",
    /** The address with its last part masked by the server. */
    val ip: String = "",
    val createdAt: Long = 0,
    val lastSeenAt: Long = 0,
    val expiresAt: Long = 0,
    val current: Boolean = false,
)

@Serializable
data class SecurityEvent(
    val time: Long = 0,
    val label: String = "",
    val type: String = "",
    val ip: String = "",
)

@Serializable
data class SecurityOverview(
    val ok: Boolean = false,
    val twoFactor: TwoFactorStatus = TwoFactorStatus(),
    val policy: SecurityPolicy = SecurityPolicy(),
    val privateProfile: Boolean = false,
    val sessions: List<DeviceSession> = emptyList(),
    val events: List<SecurityEvent> = emptyList(),
)

@Serializable
data class SessionsAnswer(
    val ok: Boolean = false,
    val sessions: List<DeviceSession> = emptyList(),
    val ended: Int = 0,
    val signedOut: Boolean = false,
    /** Set when "sign out everywhere" kept this device: a fresh token replacing the one that just ended. */
    val token: String? = null,
)

/** The pure rules behind the Account security screen. */
object SecurityLogic {

    /** "This device" first, then the rest newest-seen first. Names are cleaned; nothing is trusted as markup. */
    fun devices(sessions: List<DeviceSession>): List<DeviceRow> =
        sessions
            .sortedWith(compareByDescending<DeviceSession> { it.current }.thenByDescending { it.lastSeenAt })
            .map { s ->
                DeviceRow(
                    id = s.id,
                    title = SafeText.clean(s.device, 60).ifBlank { "Unknown device" },
                    current = s.current,
                    detail = SafeText.clean(s.ip, 45),
                    lastSeenAt = s.lastSeenAt,
                    isApp = s.kind == "app",
                )
            }

    data class DeviceRow(val id: String, val title: String, val current: Boolean, val detail: String, val lastSeenAt: Long, val isApp: Boolean)

    /** Last-seen wording. [now] and the timestamp are epoch milliseconds. */
    fun lastSeen(nowMs: Long, thenMs: Long): String {
        if (thenMs <= 0) return "Never"
        val s = ((nowMs - thenMs) / 1000).coerceAtLeast(0)
        return when {
            s < 60 -> "Just now"
            s < 3600 -> plural(s / 60, "minute") + " ago"
            s < 86400 -> plural(s / 3600, "hour") + " ago"
            s < 86400 * 60 -> plural(s / 86400, "day") + " ago"
            else -> plural(s / (86400 * 30), "month") + " ago"
        }
    }

    private fun plural(n: Long, unit: String) = "$n $unit${if (n == 1L) "" else "s"}"

    /** One line about two-factor for the top of the screen. */
    fun twoFactorLine(t: TwoFactorStatus, policy: SecurityPolicy): String = when {
        t.enabled -> "Two-factor is on. " + when (t.recoveryRemaining) {
            0 -> "You have no recovery codes left: make new ones on the website."
            1 -> "1 recovery code left."
            else -> "${t.recoveryRemaining} recovery codes left."
        }
        policy.requireForAdmins -> "Two-factor is off. The owner requires it for admins: turn it on from the website (Account security)."
        else -> "Two-factor is off. You can turn it on from the website (Account security) to protect this account with a code from an authenticator app."
    }

    /** Which sign-out choices make sense. Ending only this device is the normal Sign out in More. */
    fun canRevoke(row: DeviceRow): Boolean = row.id.length == 12 && row.id.all { it in '0'..'9' || it in 'a'..'f' } && !row.current

    /** The new token, only if a "keep this device" sign-out handed one back. */
    fun replacementToken(answer: SessionsAnswer, keptThisDevice: Boolean): String? =
        if (keptThisDevice) answer.token?.takeIf { it.isNotBlank() } else null

    /**
     * "Sign out everywhere else" reports every record it removed, and this device's own old one
     * is among them (a fresh one replaced it), so it is not counted as "another device".
     */
    fun othersEnded(ended: Int, keptThisDevice: Boolean): Int =
        if (keptThisDevice) (ended - 1).coerceAtLeast(0) else ended

    /** Plain words for a refusal from these routes. */
    fun refusalMessage(code: String, serverMessage: String?): String = when (code) {
        "not_found" -> "That device is not signed in any more."
        "not_available_to_guests" -> "Account security is not available in a library shared with you."
        "locked" -> serverMessage ?: "Too many tries. Wait a little, then try again."
        else -> serverMessage ?: "That didn't work."
    }
}

/** The calls, over the shared bearer client. */
class AccountSecurityClient(private val json: ServerJson) {
    suspend fun overview(): SecurityOverview = json.get("/api/account/security/status", SecurityOverview.serializer())
    suspend fun revoke(id: String): SessionsAnswer =
        json.post("/api/account/security/sessions/revoke", ServerJson.obj("id" to ServerJson.str(id)), SessionsAnswer.serializer())

    /** [includeCurrent] false keeps this device (the server hands back a fresh token); true ends it too. */
    suspend fun revokeAll(includeCurrent: Boolean): SessionsAnswer =
        json.post("/api/account/security/sessions/revoke-all", ServerJson.obj("includeCurrent" to ServerJson.bool(includeCurrent)), SessionsAnswer.serializer())

    companion object {
        fun get() = AccountSecurityClient(ServerJson.get())
    }
}
