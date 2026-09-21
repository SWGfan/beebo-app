package com.beeboentertainment.auto.hub

import android.content.Context
import com.beeboentertainment.auto.data.ApiClient
import com.beeboentertainment.auto.data.Http
import com.beeboentertainment.auto.data.Prefs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Thin client for the coordination hub's `/api/v1/…` surface.
 *
 * The hub does two jobs for the car app: it authenticates the user's account,
 * and it tells the app the current, reachable address of that user's home PC
 * (the streamServer the rest of the app already knows how to talk to). Once
 * [resolveAndApply] has written that address into [Prefs.baseUrl], every other
 * screen keeps working exactly as before.
 *
 * It deliberately reuses the app's existing HTTP stack rather than standing up
 * its own: the shared OkHttp client from [Http] (same pool, same timeouts, same
 * followSslRedirects-off behaviour) and the same kotlinx-serialization Json
 * config ApiClient uses. No new dependencies.
 */
class HubClient(context: Context) {

    private val app = context.applicationContext
    private val prefs = Prefs.get(app)

    // Configured identically to ApiClient's Json: unknown keys ignored so the
    // hub can add fields, null coercion so an explicit null falls back to a
    // default, explicitNulls off so we never send `"x":null`.
    private val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        explicitNulls = false
    }

    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    // ------------------------------------------------------------------ public

    /** Create a new hub account. 409 (email taken) surfaces as a [HubException]. */
    suspend fun signup(email: String, password: String): HubSession =
        authenticate("/api/v1/signup", email, password)

    /** Sign in to an existing hub account. 401 (bad creds) surfaces as a [HubException]. */
    suspend fun login(email: String, password: String): HubSession =
        authenticate("/api/v1/login", email, password)

    /**
     * Ask the hub where the user's home PC is. Requires a valid session [token].
     *
     * An offline PC is a normal answer (`online = false`, `baseUrl = null`), not
     * an error. A missing/expired token (401), a lapsed subscription (402) or an
     * account with no PC paired (404) come back as a [HubException].
     */
    suspend fun findPc(token: String): PcInfo = withContext(Dispatchers.IO) {
        val req = Request.Builder()
            .url(HUB_BASE_URL + "/api/v1/pc")
            .get()
            .header("Authorization", "Bearer $token")
            .build()
        val dto = decode<HubPcResponse>(execute(req))
        PcInfo(
            online = dto.online,
            lastSeen = dto.lastSeen,
            baseUrl = dto.baseUrl,
            connectVia = dto.connectVia,
            subscriptionActive = dto.subscription.active,
            tier = dto.subscription.tier,
        )
    }

    /**
     * Resolve the home PC and, if it can be reached directly, point the app at
     * it by writing its address into [Prefs.baseUrl].
     *
     * @return true when [Prefs.baseUrl] was updated to a directly reachable PC;
     *   false when the PC is offline or only reachable via the (unimplemented)
     *   signalling relay. Throws [HubException] for auth/subscription/pairing
     *   failures — the caller decides whether to prompt a fresh sign-in.
     */
    suspend fun resolveAndApply(token: String): Boolean {
        val pc = findPc(token)

        // Stage 2: a PC that is online but sits behind a NAT the app cannot
        // punch reports connectVia == "signal" and a baseUrl that is not
        // directly usable. There is no address to write into Prefs.baseUrl in
        // that case, so this still returns false ("not resolved by direct
        // address") on purpose — the caller must NOT treat false as failure.
        //
        // Instead, when this returns false and pc.connectVia == "signal", the
        // app brings the PC online over a peer-to-peer WebRTC link by calling
        // HubAuth.startRemoteSession(context) and rendering the stream the PC
        // pushes. See com.beeboentertainment.auto.webrtc.WebRtcConnector and
        // WEBRTC-STAGE2.md. This method is left additive: it only ever handles
        // the direct case.

        if (pc.online && pc.connectVia == "direct" && !pc.baseUrl.isNullOrBlank()) {
            // Prefs.baseUrl runs the value through normalizeBaseUrl, so a bad
            // address from the hub throws InvalidServerAddressException rather
            // than being stored as a permanently broken config.
            prefs.baseUrl = pc.baseUrl
            return true
        }
        return false
    }

    // ---------------------------------------------------------------- plumbing

    private suspend fun authenticate(
        path: String,
        email: String,
        password: String,
    ): HubSession = withContext(Dispatchers.IO) {
        val payload = json.encodeToString(HubAuthRequest(email, password))
            .toRequestBody(jsonMediaType)
        val req = Request.Builder()
            .url(HUB_BASE_URL + path)
            .post(payload)
            .build()
        val dto = decode<HubAuthResponse>(execute(req))
        val token = dto.token
            ?: throw HubException(0, "The hub did not return a session token.")
        HubSession(
            token = token,
            accountId = dto.account?.id.orEmpty(),
            email = dto.account?.email ?: email,
            tier = dto.account?.tier.orEmpty(),
        )
    }

    private class Raw(val code: Int, val body: String)

    /**
     * Runs the call and returns the body of any 2xx; every other status becomes
     * a typed [HubException] with a message worth showing.
     */
    private fun execute(req: Request): String {
        val raw = perform(req)
        if (raw.code in 200..299) return raw.body
        val serverMessage = runCatching { decode<HubErrorResponse>(raw.body).error }
            .getOrNull()
            ?.takeIf { it.isNotBlank() }
        throw HubException(raw.code, messageFor(raw.code, serverMessage))
    }

    /**
     * Executes the request, handling an http->https upgrade exactly the way
     * ApiClient does — for the one case that needs it.
     *
     * HUB_BASE_URL is https in production, so this loop runs once and returns.
     * But the constant is meant to be overridable, and a developer pointing it
     * at a plain-http origin for local testing would otherwise hang: the shared
     * OkHttp client has followSslRedirects off (see Http.kt) precisely because
     * Beebo Entertainment-style servers 308 http->https on the same port, and OkHttp loops
     * on that. So the upgrade is followed here instead.
     *
     * Unlike ApiClient.perform this NEVER persists the upgraded address:
     * [Prefs.baseUrl] is the home PC's address, not the hub's, and clobbering it
     * here would be a bug.
     */
    private fun perform(request: Request): Raw {
        var req = request
        var upgraded = false
        while (true) {
            val resp = Http.client().newCall(req).execute()
            val target = if (upgraded) null else {
                ApiClient.httpsUpgradeTarget(req.url, resp.code, resp.header("Location"))
            }
            if (target == null) {
                resp.use { return Raw(it.code, it.body?.string().orEmpty()) }
            }
            resp.close()
            req = req.newBuilder().url(target).build()
            upgraded = true
        }
    }

    private inline fun <reified T> decode(body: String): T =
        try {
            json.decodeFromString<T>(body)
        } catch (e: Exception) {
            throw HubException(0, "The hub sent a response this app could not read.")
        }

    companion object {
        /**
         * Where the coordination hub lives. Overridable in this one place —
         * point it at a staging host or a local server for testing.
         */
        // NOTE: this MUST match the core phone app (movie/hub/HubClient.kt).
        // It previously read hub.beeboentertainment.com, which has no DNS record —
        // so every hub call from the car app failed to connect. Verified live:
        // hub.beebotv.com/api/v1/health returns 200; the other name does not resolve.
        const val HUB_BASE_URL = "https://hub.beebotv.com"

        /**
         * Turns a hub status (and any `{"error":…}` message it carried) into a
         * sentence to show the user. The four documented failure statuses get
         * curated wording; anything else falls back to the server's own message,
         * then to a generic line. Public and pure so it is unit-testable.
         */
        fun messageFor(code: Int, serverMessage: String?): String = when (code) {
            401 -> "Wrong email or password, or your hub session has expired. Sign in again."
            402 -> serverMessage ?: "An active subscription is needed to reach your PC."
            404 -> "No home PC is paired with this hub account yet."
            409 -> "That email is already registered. Sign in instead."
            else -> serverMessage ?: "The hub returned an error (HTTP $code)."
        }
    }
}
