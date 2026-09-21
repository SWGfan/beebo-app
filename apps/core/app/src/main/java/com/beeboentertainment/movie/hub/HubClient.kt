package com.beeboentertainment.movie.hub

import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.data.SessionStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.encodeToString
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Thin client for the coordination hub's /api/v1 surface.
 *
 * The hub does two jobs for the app: it authenticates the user's account, and it
 * tells the app the current, reachable address of that user's home server (the
 * one the rest of the app already knows how to talk to). Once [resolveAndApply]
 * has written that address into [SessionStore.baseUrl], every other screen keeps
 * working exactly as before.
 *
 * It deliberately reuses the core app's existing HTTP stack rather than standing
 * up its own: the shared OkHttp client from [ApiClient] (same pool, same
 * timeouts, same redirect behaviour) and a kotlinx-serialization Json configured
 * the same way ApiClient's is. No new dependencies.
 *
 * Unlike the reference app, the core [ApiClient] client keeps followSslRedirects
 * ON, so a plain http->https 308 is followed by OkHttp itself — there is no
 * hand-rolled upgrade loop here.
 */
class HubClient(
    private val session: SessionStore,
    private val http: OkHttpClient = BeeboApp.instance.api.okHttp,
) {

    // Configured like ApiClient's Json: unknown keys ignored so the hub can add
    // fields, null coercion so an explicit null falls back to a default,
    // explicitNulls off so we never send "x":null.
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
     * Ask the hub where the user's home server is. Requires a valid session
     * [token].
     *
     * An offline server is a normal answer (online = false, baseUrl = null), not
     * an error. A missing/expired token (401), a lapsed subscription (402) or an
     * account with no server paired (404) come back as a [HubException].
     */
    suspend fun findPc(token: String): PcInfo = withContext(Dispatchers.IO) {
        val req = Request.Builder()
            .url(HUB_BASE_URL + "/api/v1/pc")
            .get()
            .header("Authorization", "Bearer $token")
            .header("Accept", "application/json")
            .build()
        val dto = decode<HubPcResponse>(execute(req))
        PcInfo(
            online = dto.online,
            lastSeen = dto.lastSeen,
            baseUrl = dto.baseUrl,
            connectVia = dto.connectVia,
            subscriptionActive = dto.subscription.active,
            tier = dto.subscription.tier,
            baseUrls = dto.baseUrls,
        )
    }

    /**
     * Resolve the home server and, if one of its addresses actually answers,
     * point the app at it by writing that address into [SessionStore.baseUrl].
     *
     * @return a [ServerResolution] describing what happened. [SessionStore.baseUrl]
     *   is written ONLY for [ServerResolution.Applied]; every other outcome leaves
     *   the saved address untouched and carries it back as
     *   [ServerResolution.keptBaseUrl]. Throws [HubException] for
     *   auth/subscription/pairing failures — the caller decides whether to
     *   prompt a fresh sign-in.
     */
    suspend fun resolveAndApply(token: String): ServerResolution {
        // Read once, up front: every early return hands this back so the caller
        // can say, truthfully, which address the app is still using.
        val kept = session.baseUrl
        val pc = findPc(token)
        if (!pc.online) return ServerResolution.Offline(kept)
        if (pc.connectVia != "direct") return ServerResolution.RelayOnly(kept)

        // The hub names one preferred address, but it cannot know which of the
        // PC's addresses THIS phone can reach, and it will keep offering a stale
        // one for as long as the agent advertises it. Taking that first entry on
        // faith once turned a dead dynamic-DNS name into a dead end for the whole
        // sign-in, even though the same PC was advertising two working addresses.
        //
        // So probe them: hub's pick first, then the rest, and keep the first that
        // answers as a real Beebo server. They are probed together rather than in
        // turn — a LAN address from outside the house costs a full connect timeout
        // each, and three of those in series is a minute of staring at a spinner.
        val candidates = (listOfNotNull(pc.baseUrl) + pc.baseUrls)
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .distinct()
        if (candidates.isEmpty()) return ServerResolution.NoAddresses(kept)

        val api = BeeboApp.instance.api
        val reachable: List<Boolean> = coroutineScope {
            candidates
                .map { candidate ->
                    async(Dispatchers.IO) {
                        runCatching { api.ping(candidate).isBeeboServer }.getOrDefault(false)
                    }
                }
                .awaitAll()
        }

        // SessionStore.baseUrl runs the value through UrlUtils.normalizeBaseUrl,
        // so a stray address from the hub is normalised rather than stored raw.
        // (reachable is index-aligned with candidates, so the first true index IS
        // the winning candidate - no lookup back through the list needed.)
        val winner = reachable.indexOfFirst { it }
        if (winner >= 0) {
            val address = candidates[winner]
            session.baseUrl = address
            return ServerResolution.Applied(address)
        }

        // Nothing answered, so WRITE NOTHING. This is the bug that locked the
        // owner out of his own server three times in one night.
        //
        // What used to be here saved candidates.first() anyway, so that a later
        // screen could name the address it had failed on. But the hub's first
        // entry was a dynamic-DNS hostname that had since been deleted and no
        // longer resolves anywhere on the internet, and the other two were a
        // Tailscale address and a LAN address that no phone out on mobile data
        // can reach. So every hub sign-in replaced a saved, working address with
        // one that does not exist, leaving a Sign in screen for a server that
        // could not be found and no way back except typing a URL by hand.
        //
        // Two reasons this can never be right. An address that has just failed a
        // probe is the last value that should become the app's setting. And a
        // failed probe is not evidence against the address we already had: this
        // phone may simply be on the wrong network, or asleep on a bad wifi, and
        // the saved address may be working perfectly.
        //
        // The helpfulness the old line was reaching for survives: the addresses
        // we tried travel back inside the result, so the screen can still say
        // "couldn't reach <address>" - it just no longer pays for that sentence
        // with the user's only working setting.
        return ServerResolution.NoneReachable(candidates, kept)
    }

    /**
     * Start (or refresh) a car party for this account's room. Returns the short
     * code to read out to passengers, who redeem it with no account of their own
     * (via POST /api/v1/party/guest). Requires the user's hub [token].
     */
    suspend fun startParty(token: String, name: String? = null): PartyStart = withContext(Dispatchers.IO) {
        val payload = json.encodeToString(HubPartyStartRequest.serializer(), HubPartyStartRequest(name))
            .toRequestBody(jsonMediaType)
        val req = Request.Builder()
            .url(HUB_BASE_URL + "/api/v1/party/start")
            .post(payload)
            .header("Authorization", "Bearer $token")
            .header("Accept", "application/json")
            .build()
        val dto = decode<HubPartyStartResponse>(execute(req))
        PartyStart(
            code = dto.code ?: throw HubException(0, "The hub did not return a party code."),
            hostName = dto.hostName,
        )
    }

    // ---------------------------------------------------------------- plumbing

    private suspend fun authenticate(
        path: String,
        email: String,
        password: String,
    ): HubSession = withContext(Dispatchers.IO) {
        val payload = json.encodeToString(HubAuthRequest.serializer(), HubAuthRequest(email, password))
            .toRequestBody(jsonMediaType)
        val req = Request.Builder()
            .url(HUB_BASE_URL + path)
            .post(payload)
            .header("Accept", "application/json")
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

    /**
     * Runs the call and returns the body of any 2xx; every other status becomes
     * a typed [HubException] with a message worth showing. The shared client
     * follows the http->https 308 itself, so this is a single round-trip.
     */
    private fun execute(req: Request): String {
        http.newCall(req).execute().use { resp ->
            val body = resp.body?.string().orEmpty()
            if (resp.code in 200..299) return body
            val serverMessage = runCatching { decode<HubErrorResponse>(body).error }
                .getOrNull()
                ?.takeIf { it.isNotBlank() }
            throw HubException(resp.code, messageFor(resp.code, serverMessage))
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
         * Where the coordination hub lives. Overridable in this one place — point
         * it at a staging host or a local server for testing.
         */
        const val HUB_BASE_URL = "https://hub.beebotv.com"

        /**
         * Turns a hub status (and any {"error":...} message it carried) into a
         * sentence to show the user. Public and pure so it is unit-testable.
         */
        fun messageFor(
            code: Int,
            serverMessage: String?,
            isPlayBuild: Boolean = com.beeboentertainment.movie.core.DistributionPolicy.current,
        ): String = when (code) {
            401 -> "Wrong email or password, or your hub session has expired. Sign in again."
            // Google Play: the hub's own 402 wording could name a price or a page, so the Play
            // build always shows this fixed sentence instead.
            402 -> serverMessage?.takeIf { com.beeboentertainment.movie.core.DistributionPolicy.trustsHubPaymentMessage(isPlayBuild) }
                ?: "An active subscription is needed to reach your server."
            404 -> "No home server is paired with this hub account yet."
            409 -> "That email is already registered. Sign in instead."
            else -> serverMessage ?: "The hub returned an error (HTTP $code)."
        }
    }
}
