package com.beeboentertainment.movie.data

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import com.beeboentertainment.movie.core.CleartextPolicy
import com.beeboentertainment.movie.core.ConnectionErrors
import com.beeboentertainment.movie.core.DoctorFacts
import com.beeboentertainment.movie.core.FailureClass
import com.beeboentertainment.movie.core.PairLink
import com.beeboentertainment.movie.core.PhoneAddress
import com.beeboentertainment.movie.core.PingOutcome
import com.beeboentertainment.movie.core.ServerTrust
import com.beeboentertainment.movie.rtc.NetworkKind
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.net.Inet4Address
import java.net.InetAddress
import java.util.concurrent.TimeUnit

/**
 * Gathers the facts "Can't connect?" needs, on the phone. Only what a phone can check: its own
 * network, whether the address can be looked up, and one plain request. The request carries no
 * sign-in, and does not follow redirects: an answer of any kind means the computer is there. What
 * the facts mean is decided in core/ConnectionDiagnosis.kt.
 */
object ConnectionProbe {
    private val IPV4 = Regex("""^\d{1,3}(\.\d{1,3}){3}$""")

    fun phoneNetwork(context: Context): Pair<NetworkKind, PhoneAddress?> {
        return try {
            val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return NetworkKind.NONE to null
            val net = cm.activeNetwork ?: return NetworkKind.NONE to null
            val caps = cm.getNetworkCapabilities(net) ?: return NetworkKind.NONE to null
            val kind = when {
                caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> NetworkKind.LOCAL
                else -> NetworkKind.OTHER
            }
            val v4 = cm.getLinkProperties(net)?.linkAddresses?.firstOrNull { it.address is Inet4Address }
            kind to v4?.let { PhoneAddress(it.address.hostAddress.orEmpty(), it.prefixLength) }
        } catch (e: Exception) {
            NetworkKind.OTHER to null
        }
    }

    private fun client(): OkHttpClient = CleartextPolicy.install(
        OkHttpClient.Builder()
            .connectTimeout(5, TimeUnit.SECONDS)
            .readTimeout(5, TimeUnit.SECONDS)
            .callTimeout(8, TimeUnit.SECONDS)
            .followRedirects(false)
            .followSslRedirects(false)
            .retryOnConnectionFailure(false)
    ).build()

    suspend fun run(context: Context, target: PairLink?, lastLoginHttp: Int?): DoctorFacts = withContext(Dispatchers.IO) {
        val (network, phone) = phoneNetwork(context)
        if (target == null || network == NetworkKind.NONE) return@withContext DoctorFacts(network, phone, target, null, null, lastLoginHttp)

        val host = if (target.server.startsWith("[")) target.server.substringAfter('[').substringBefore(']') else target.server.substringBeforeLast(':', target.server)
        val isLiteral = IPV4.matches(host) || target.server.startsWith("[")
        val nameFound: Boolean? = if (isLiteral) null else withTimeoutOrNull(4_000) {
            try { InetAddress.getAllByName(host).isNotEmpty() } catch (e: Exception) { false }
        }

        val url = when (target.trust) {
            ServerTrust.BEEBO_TV -> "https://$host/"
            else -> "http://${target.server}/api/ping"
        }
        val ping: PingOutcome = try {
            val started = System.nanoTime()
            client().newCall(Request.Builder().url(url).build()).execute().use { r ->
                PingOutcome.Answered((System.nanoTime() - started) / 1_000_000, r.code)
            }
        } catch (e: Exception) {
            PingOutcome.Failed(if (nameFound == false) FailureClass.DNS else ConnectionErrors.classify(e))
        }
        DoctorFacts(network, phone, target, nameFound, ping, lastLoginHttp)
    }
}
