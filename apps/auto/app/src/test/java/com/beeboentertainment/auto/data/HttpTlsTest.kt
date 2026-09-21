package com.beeboentertainment.auto.data

import okhttp3.internal.tls.OkHostnameVerifier
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.security.cert.CertificateException
import java.security.cert.X509Certificate

/**
 * Every client the car app hands out must verify certificates the normal way.
 * These would pass for a stock OkHttpClient and fail for the old
 * "Accept any certificate" client, whose trust manager accepted anything and
 * whose hostname verifier always said yes.
 */
class HttpTlsTest {

    private val clients = listOf(
        "api" to Http.client(),
        "stream" to Http.streamClient(),
        "artwork" to Http.artworkClient(),
    )

    @Test
    fun everyClientUsesOkHttpsHostnameCheck() {
        for ((name, c) in clients) {
            assertSame("$name client hostname verifier", OkHostnameVerifier, c.hostnameVerifier)
        }
    }

    @Test
    fun everyClientTrustManagerRejectsAnUnverifiableChain() {
        for ((name, c) in clients) {
            val tm = c.x509TrustManager ?: error("$name client has no trust manager")
            assertTrue("$name trusts nobody's issuers", tm.acceptedIssuers.isNotEmpty())
            try {
                tm.checkServerTrusted(emptyArray<X509Certificate>(), "RSA")
                fail("$name client accepted an empty certificate chain")
            } catch (expected: IllegalArgumentException) {
            } catch (expected: CertificateException) {
            }
        }
    }

    @Test
    fun theVariantsShareOneConnectionPool() {
        val pool = Http.client().connectionPool
        assertSame(pool, Http.streamClient().connectionPool)
        assertSame(pool, Http.artworkClient().connectionPool)
    }
}
