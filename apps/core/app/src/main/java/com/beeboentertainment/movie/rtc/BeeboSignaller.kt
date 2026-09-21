package com.beeboentertainment.movie.rtc

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.IceCandidate
import org.webrtc.PeerConnection
import java.io.IOException

/**
 * The handshake half of away-from-home.
 *
 * Everything here goes to the Cloudflare Worker's `/rtc/` endpoints on
 * `<name>.beebo.tv`, and everything here is tiny: a sign-in, an SDP offer, an
 * answer, and a trickle of ICE candidates. Once [BeeboTunnel] has a data
 * channel, not one further byte
 * of the user's library passes through this - the video goes straight from the
 * home PC to the phone. That split is the whole point, so keep it: never add a
 * route here that carries library content.
 *
 * The Worker accepts three ways to prove you belong to a house, and all three
 * come back with the same 12-hour viewer token:
 *
 *   owner      { email, password }
 *   member     { username, pass }        a named person in the household
 *   household  { householdPass }         the shared family pass
 *
 * Every call here blocks; callers are background threads (the tunnel's own, or Dispatchers.IO).
 */
class BeeboSignaller(
    private val http: OkHttpClient,
    /** The account name, i.e. the `nick` in `nick.beebo.tv`. */
    private val name: String,
    /** Overridable for tests; always https://<name>.beebo.tv in the app. */
    private val base: String = "https://$name.beebo.tv",
) {

    private val jsonType = "application/json; charset=utf-8".toMediaType()

    /** A viewer token plus the ICE servers the Worker wants us to use. */
    data class Credentials(
        val token: String,
        val iceServers: List<PeerConnection.IceServer>,
    )

    /** Thrown with the Worker's own error code, which the UI maps to a message (RemoteMessages). */
    class SignalException(val code: String, val status: Int, val retryAfterSeconds: Long = 0) : IOException(code)

    /** The answer from the house, and any relay it offered for a second attempt. */
    data class Answer(val sdp: String, val relayServers: List<PeerConnection.IceServer>)

    // ------------------------------------------------------------------ sign in

    fun loginAsOwner(email: String, password: String): Credentials =
        login(JSONObject().put("email", email).put("password", password))

    fun loginAsMember(username: String, pass: String): Credentials =
        login(JSONObject().put("username", username).put("pass", pass))

    fun loginWithHouseholdPass(pass: String): Credentials =
        login(JSONObject().put("householdPass", pass))

    /**
     * Home typed as the paying account's email: the Worker finds the house and signs in in one
     * step (POST /rtc/find-home on login.beebo.tv). A member passes [username] and their own
     * home-server password; the owner passes no username and the account password.
     * Returns the house's name with the credentials. Every wrong detail is the same 401.
     */
    fun findHome(email: String, username: String?, secret: String): Pair<String, Credentials> {
        val body = JSONObject().put("email", email)
        if (username.isNullOrBlank()) body.put("password", secret) else body.put("username", username).put("pass", secret)
        val req = Request.Builder()
            .url(FIND_HOME_URL)
            .post(body.toString().toRequestBody(jsonType))
            .header("Accept", "application/json")
            .build()
        val res = execute(req)
        val found = res.optString("name", "")
        val token = res.optString("token", "")
        if (found.isEmpty() || token.isEmpty()) throw SignalException("no_token", 200)
        return found to Credentials(token, parseIceServers(res.optJSONArray("iceServers"), stunOnly = true))
    }

    private fun login(body: JSONObject): Credentials {
        val res = post("/rtc/login", body)
        val token = res.optString("token", "")
        if (token.isEmpty()) throw SignalException("no_token", 200)
        return Credentials(token, parseIceServers(res.optJSONArray("iceServers"), stunOnly = true))
    }

    // ----------------------------------------------------------------- handshake

    /**
     * Offer a connection. Returns the viewer id the Worker assigned, which is
     * also the mailbox name to poll for the answer.
     *
     * A `host_offline` error here is a normal answer, not a fault: it means the
     * home PC has not checked in for two minutes, so it is switched off or has
     * no internet. Say that plainly rather than "connection failed".
     */
    fun offer(token: String, sdp: String): String {
        val res = post("/rtc/offer", JSONObject().put("token", token).put("sdp", sdp))
        val viewerId = res.optString("viewerId", "")
        if (viewerId.isEmpty()) throw SignalException("no_viewer_id", 200)
        return viewerId
    }

    /** The Worker only takes candidates for the house with the same viewer token as the offer. */
    fun sendCandidate(token: String, viewerId: String, candidate: IceCandidate) {
        val c = JSONObject()
            .put("candidate", candidate.sdp)
            .put("sdpMid", candidate.sdpMid)
            .put("sdpMLineIndex", candidate.sdpMLineIndex)
        post("/rtc/candidate", JSONObject().put("to", "host").put("viewerId", viewerId).put("token", token).put("candidate", c))
    }

    /** Drain this viewer's mailbox. The Worker removes what it hands back. */
    fun poll(viewerId: String): List<JSONObject> {
        val req = Request.Builder().url("$base/rtc/poll?box=$viewerId").get().build()
        val body = execute(req)
        val msgs = body.optJSONArray("msgs") ?: return emptyList()
        return (0 until msgs.length()).mapNotNull { msgs.optJSONObject(it) }
    }

    /**
     * The Beebo Relay balance banner, exactly what the viewer page shows: null when there is
     * nothing to say (the wallet is off - a 404 - or the balance is fine). The Worker leaves the
     * owner-only links out for a household or member sign-in.
     */
    fun walletBanner(token: String): WalletBanner? {
        val req = Request.Builder().url("$base/rtc/wallet/me")
            .header("Authorization", "Bearer $token").header("Accept", "application/json").get().build()
        http.newCall(req).execute().use { r ->
            if (r.code != 200) return null
            val j = runCatching { JSONObject(r.body?.string().orEmpty()) }.getOrNull() ?: return null
            val b = j.optJSONObject("banner") ?: return null
            val text = b.optString("text", "").trim()
            if (text.isEmpty()) return null
            val links = b.optJSONObject("links")
            fun link(k: String) = links?.optString(k, "")?.takeIf { it.startsWith("https://") }
            return WalletBanner(
                level = b.optString("level", ""),
                text = text,
                seq = j.optJSONObject("warning")?.optLong("seq", 0) ?: 0,
                topUp = link("topup"),
                payAsYouGo = link("payg"),
                cloudflareOnly = link("cloudflare_only"),
            )
        }
    }

    /**
     * Beebo Relay TURN credentials for this viewer token (POST /rtc/relay/credentials on this
     * house's own name.beebo.tv, never bare beebo.tv). Never throws: a refusal or no answer comes
     * back as a [RelayFetch] and the connection goes ahead with STUN only. See [BeeboRelayCredentials].
     */
    fun relayCredentials(token: String): RelayFetch {
        val req = Request.Builder()
            .url(base + BeeboRelay.PATH)
            .post("{}".toRequestBody(jsonType))
            .header("Authorization", "Bearer $token")
            .header("Accept", "application/json")
            .build()
        return try {
            // The connection only waits ~2 s for this; a late answer still fills the cache, but
            // don't let one hang about for the signalling client's full read timeout.
            val quick = http.newBuilder().callTimeout(10, java.util.concurrent.TimeUnit.SECONDS).build()
            quick.newCall(req).execute().use { r -> BeeboRelay.parseResponse(r.code, r.body?.string().orEmpty()) }
        } catch (e: IOException) {
            RelayFetch.Failed("network")
        }
    }

    // ------------------------------------------------------------------ plumbing

    private fun post(path: String, body: JSONObject): JSONObject {
        val req = Request.Builder()
            .url(base + path)
            .post(body.toString().toRequestBody(jsonType))
            .header("Accept", "application/json")
            .build()
        return execute(req)
    }

    private fun execute(req: Request): JSONObject {
        http.newCall(req).execute().use { r ->
            val text = r.body?.string().orEmpty()
            val json = try { JSONObject(text) } catch (e: Exception) { JSONObject() }
            if (!r.isSuccessful) {
                throw SignalException(json.optString("error", "http_${r.code}"), r.code, json.optLong("retry_after", 0))
            }
            return json
        }
    }

    companion object {
        /** A reserved beebo.tv name no customer can hold; the Worker answers find-home on any host. */
        const val FIND_HOME_URL = "https://login.beebo.tv/rtc/find-home"

        /**
         * The Worker hands back ICE servers in the browser's shape. Missing or
         * malformed entries fall back to a public STUN server rather than failing
         * the connection outright - without any ICE server at all a phone on
         * mobile data can never find a path to the house.
         *
         * [stunOnly] is the viewer page's rule for the sign-in answer: only STUN from there.
         * A relay arrives only in the house's own signed answer ([parseRelayServers]).
         */
        fun parseIceServers(arr: JSONArray?, stunOnly: Boolean = false): List<PeerConnection.IceServer> {
            val out = mutableListOf<PeerConnection.IceServer>()
            if (arr != null) {
                for (i in 0 until arr.length()) {
                    val e = arr.optJSONObject(i) ?: continue
                    val urls = urlsOf(e).filter { !stunOnly || it.startsWith("stun:", true) }
                    if (urls.isEmpty()) continue
                    val b = PeerConnection.IceServer.builder(urls)
                    e.optString("username").takeIf { it.isNotEmpty() }?.let { b.setUsername(it) }
                    e.optString("credential").takeIf { it.isNotEmpty() }?.let { b.setPassword(it) }
                    out.add(b.createIceServer())
                }
            }
            if (out.isEmpty()) {
                out.add(PeerConnection.IceServer.builder(BeeboRelay.STUN_URL).createIceServer())
            }
            return out
        }

        /**
         * TURN servers from the house's signed answer: the owner's own relay or Beebo Relay, with
         * short-lived credentials. Same filter as the viewer page's ownRelay(): turn:/turns: only,
         * string credentials, never port 53.
         */
        fun parseRelayServers(arr: JSONArray?): List<PeerConnection.IceServer> {
            val out = mutableListOf<PeerConnection.IceServer>()
            if (arr == null) return out
            for (i in 0 until minOf(arr.length(), 4)) {
                val e = arr.optJSONObject(i) ?: continue
                val user = e.opt("username") as? String ?: continue
                val cred = e.opt("credential") as? String ?: continue
                val urls = urlsOf(e).filter { RelayUrls.usable(it) }
                if (urls.isEmpty()) continue
                out.add(PeerConnection.IceServer.builder(urls).setUsername(user).setPassword(cred).createIceServer())
            }
            return out
        }

        private fun urlsOf(e: JSONObject): List<String> {
            val urls = mutableListOf<String>()
            when (val u = e.opt("urls")) {
                is String -> urls.add(u)
                is JSONArray -> for (j in 0 until u.length()) u.optString(j).takeIf { it.isNotEmpty() }?.let(urls::add)
            }
            return urls
        }
    }
}

/** The viewer page's relay banner, for this app. */
data class WalletBanner(
    val level: String,
    val text: String,
    val seq: Long,
    val topUp: String?,
    val payAsYouGo: String?,
    val cloudflareOnly: String?,
) {
    /** Dismissing it hides this warning, not the next one. */
    val key: String get() = "$level:$seq"
}
