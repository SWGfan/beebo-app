package com.beeboentertainment.auto.data

import com.beeboentertainment.movie.rtc.TunnelInterceptor
import okhttp3.Dispatcher
import okhttp3.Interceptor
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * The app's OkHttp clients. There is one root client for the API, and two
 * variants derived from it — they share its connection pool and TLS sessions,
 * so the three flavours cost one set of sockets between them.
 *
 * Two things matter on the root client and are easy to get wrong:
 *
 *  1. followSslRedirects MUST be off, and the http->https upgrade handled by
 *     hand in ApiClient. Beebo Entertainment serves HTTP and HTTPS on the SAME port, so
 *     when a certificate is live the plain side answers 308 to a URL that
 *     differs only in scheme. OkHttp treats same-host-same-port as a reusable
 *     connection and sends the redirected request back down the existing
 *     cleartext socket, which the server 308s again — reproduced end to end,
 *     it loops until "Too many follow-up requests: 21". curl follows the same
 *     redirect in one hop, so this is specific to OkHttp meeting a scheme-only
 *     redirect. With this off, the 308 comes back as an ordinary response and
 *     ApiClient upgrades the saved address once, permanently.
 *
 *  2. followRedirects stays ON and must preserve the method for same-scheme
 *     redirects: a hand-rolled redirect that re-issued a POST as GET would make
 *     every progress report silently do nothing.
 *
 *  3. The read timeout has to be generous. /api/tvshows can do up to 40
 *     first-time TMDB lookups with poster downloads on a cold cache.
 *
 * Certificates are checked the normal way: the platform trust store (system
 * CAs only, see network_security_config.xml) and OkHttp's hostname check.
 * There used to be an "Accept any certificate" switch that swapped both for
 * no-ops. It is gone on purpose: every server this app talks to either has a
 * public certificate (the PC's Let's Encrypt name, the hub behind Cloudflare)
 * or is reached over plain http on the LAN, where the PC does not redirect to
 * https. A trust-all client would let anyone on the car's Wi-Fi hotspot or a
 * hostile network read the sign-in token off every request. Do not add a
 * TrustManager or HostnameVerifier here; if a self-signed box ever needs
 * support, pin that one certificate in network_security_config.xml.
 */
object Http {

    /**
     * No tunnel on this one: every client handed out is built from it with the tunnel added
     * LAST ([withTunnel]). The tunnel answers `name.beebo.tv` requests itself instead of passing
     * them down the chain, so an interceptor added after it would never run for them - the
     * media-token swap and the login-page guard have to sit in front of it.
     */
    private val base: OkHttpClient by lazy { build() }

    private val root: OkHttpClient by lazy { withTunnel(base.newBuilder()) }

    /**
     * name.beebo.tv: every request (API, posters, the player, progress reports) goes over the
     * peer-to-peer tunnel away from home, or to the computer's own address at home. A no-op for
     * any other address (a direct address, the hub, a user's own sources). See
     * remote/AutoRemote and the shared rtc/TunnelInterceptor.
     */
    private fun withTunnel(b: OkHttpClient.Builder): OkHttpClient =
        b.addInterceptor(TunnelInterceptor()).build()

    fun client(): OkHttpClient = root

    /**
     * The client behind ExoPlayer's data source.
     *
     * A stale `mt` token does not 401 — the server 302s to the HTML login page,
     * OkHttp follows it, and the player then fails deep inside a format
     * extractor with a message nobody can act on. The guard turns that into a
     * plain sentence about signing in again.
     */
    fun streamClient(): OkHttpClient = stream

    private val stream: OkHttpClient by lazy {
        withTunnel(base.newBuilder().addInterceptor(MediaTokenToHeader).addInterceptor(LoginPageGuard))
    }

    /**
     * Stream and subtitle URLs carry the media token as `mt=`. When the server has said it
     * reads the token from a header, send it there and leave it out of the URL, which is the
     * part of a request that proxies and logs keep. Servers that have not said so get the URL
     * untouched. See MediaTokenHeader.
     */
    private val MediaTokenToHeader = Interceptor { chain ->
        val req = chain.request()
        val split = MediaTokenHeader.forPlayback(req.url.toString())
        val url = split?.url?.toHttpUrlOrNull()
        if (split == null || url == null) chain.proceed(req)
        else chain.proceed(req.newBuilder().url(url).header(MediaTokenHeader.HEADER, split.token).build())
    }

    /** Remembers which servers read the media token from a header. */
    private val CapabilityWatcher = Interceptor { chain ->
        chain.proceed(chain.request()).also { r ->
            MediaTokenHeader.noteResponse(r.request.url.toString(), r.header(MediaTokenHeader.CAPABILITY))
        }
    }

    /**
     * The client behind ArtworkProvider.
     *
     * openFile runs on a binder thread and there are only about fifteen of
     * those per process, shared with the browse callbacks. The car asks for
     * every visible poster at once, so an unbounded dispatcher and the API's
     * 60-second read timeout would let one slow server park the whole browse
     * UI. Posters are small: if one is not there in a few seconds it is not
     * worth a binder thread.
     */
    fun artworkClient(): OkHttpClient = artwork

    private val artwork: OkHttpClient by lazy {
        withTunnel(base.newBuilder()
            .callTimeout(6, TimeUnit.SECONDS)
            .connectTimeout(4, TimeUnit.SECONDS)
            .readTimeout(6, TimeUnit.SECONDS)
            .dispatcher(
                Dispatcher().apply {
                    maxRequests = 6
                    maxRequestsPerHost = 6
                }
            ))
    }

    private val LoginPageGuard = Interceptor { chain ->
        val resp = chain.proceed(chain.request())
        val type = resp.header("Content-Type").orEmpty()
        if (type.startsWith("text/html")) {
            resp.close()
            throw IOException(
                "Your sign-in has expired. Open Beebo Auto on your phone and sign in again."
            )
        }
        resp
    }

    private fun build(): OkHttpClient =
        OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .callTimeout(0, TimeUnit.MILLISECONDS)
            .followRedirects(true)
            .followSslRedirects(false)
            .retryOnConnectionFailure(true)
            .addInterceptor(CapabilityWatcher)
            .build()
}
