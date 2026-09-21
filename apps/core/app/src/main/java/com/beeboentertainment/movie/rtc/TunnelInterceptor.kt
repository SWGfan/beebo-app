package com.beeboentertainment.movie.rtc

import okhttp3.Interceptor
import okhttp3.Request
import okhttp3.Response
import java.io.IOException

/**
 * What the interceptor needs to know, provided by RemoteAccess in the app and by a fake in tests.
 */
interface TunnelRouter {
    /** Where a request for [url] goes now. [Route.Plain] for anything that isn't name.beebo.tv. */
    fun routeFor(url: String): Route
    /** The tunnel for [name]; null when not signed in to it. */
    fun client(name: String): TunnelClient?
    /** The direct address stopped answering mid-request: stop using it until re-checked. */
    fun directFailed(name: String)
}

/** The one switch the shared OkHttp client consults. Null means "no away-from-home at all". */
object TunnelRouting {
    @Volatile var router: TunnelRouter? = null
}

/**
 * Moves every request for `name.beebo.tv` onto the right path, for every part of the app at once.
 *
 * The app's server traffic all goes through the one OkHttpClient in ApiClient (and clients built
 * from it with newBuilder(), which keep its interceptors): the API, posters and images (Coil),
 * ExoPlayer (media3-datasource-okhttp), sidecar subtitles, and downloads. The saved server
 * address stays `https://name.beebo.tv`, so every URL the app builds says so, and this decides
 * per request:
 *  - [Route.Tunnel]: the request goes over the peer-to-peer tunnel ([TunnelClient]); Range and
 *    206 pass straight through, so seeking works.
 *  - [Route.Direct]: at home, it is rewritten to the computer's own address and sent normally.
 *  - [Route.Plain], or `/rtc/` signalling: untouched.
 *
 * An application interceptor rather than a Call.Factory (the old TunnelCallFactory) because Coil
 * and several other clients take an OkHttpClient, not a Call.Factory; an interceptor reaches them
 * all. Being an application interceptor, OkHttp's own redirect handling runs after it, so
 * redirects from the tunnel are followed here.
 *
 * Responses keep the ORIGINAL request (the beebo.tv URL), so anything keyed on the origin -
 * MediaTokenHeader's "this server reads the header" - stays keyed on the address the app uses.
 */
class TunnelInterceptor : Interceptor {

    override fun intercept(chain: Interceptor.Chain): Response {
        val router = TunnelRouting.router ?: run {
            if (chain.request().header("X-Beebo-Encrypted-Only") == "1" && chain.request().url.scheme != "https")
                throw IOException("Use your secure beebo.tv address before emailing a recovery key. Your saved key still works.")
            return chain.proceed(chain.request())
        }
        val original = chain.request()
        var request = original
        var redirects = 0
        while (true) {
            val url = request.url.toString()
            val route = router.routeFor(url)
            val encryptedOnly = request.header("X-Beebo-Encrypted-Only") == "1"
            if (encryptedOnly && route is Route.Plain && request.url.scheme != "https")
                throw IOException("Use your secure beebo.tv address before emailing a recovery key. Your saved key still works.")
            val response: Response = when {
                route is Route.Tunnel && RouteRule.isTunnelUrl(url, route.name) -> {
                    val client = router.client(route.name)
                        ?: throw IOException(RemoteMessages.SIGNED_OUT)
                    client.execute(request)
                }
                route is Route.Direct && RouteRule.isTunnelUrl(url, route.name) -> {
                    if (encryptedOnly && !route.directBaseUrl.startsWith("https://")) {
                        val client = router.client(route.name) ?: throw IOException("A secure connection is needed to email the recovery key.")
                        return client.execute(request)
                    }
                    val direct = request.newBuilder().url(RouteRule.rewriteToDirect(url, route.directBaseUrl)!!).build()
                    try {
                        chain.proceed(direct).newBuilder().request(request).build()
                    } catch (e: IOException) {
                        // Left home mid-way, most likely. Once more, over the tunnel.
                        router.directFailed(route.name)
                        val client = router.client(route.name) ?: throw e
                        client.execute(request)
                    }
                }
                request === original -> return chain.proceed(request)
                else -> chain.proceed(request)
            }

            val next = redirectFor(request, response) ?: return if (request === original) response
                else response.newBuilder().request(original).priorResponse(null).build()
            response.close()
            if (++redirects > 5) throw IOException("Too many redirects from your home computer.")
            request = next
        }
    }

    /** The request to follow a redirect with, or null when [response] isn't one to follow. */
    internal fun redirectFor(request: Request, response: Response): Request? {
        if (request.header("X-Beebo-Encrypted-Only") == "1") return null
        if (response.code !in setOf(301, 302, 303, 307, 308)) return null
        val location = response.header("Location")?.takeIf { it.isNotBlank() } ?: return null
        val target = request.url.resolve(location) ?: return null
        val b = request.newBuilder().url(target)
        val keepMethod = response.code == 307 || response.code == 308 ||
            request.method == "GET" || request.method == "HEAD"
        if (!keepMethod) b.method("GET", null).removeHeader("Content-Type").removeHeader("Content-Length")
        // Never hand a bearer token to a different host.
        if (target.host != request.url.host) b.removeHeader("Authorization").removeHeader("X-Beebo-Media-Token")
        return b.build()
    }
}
