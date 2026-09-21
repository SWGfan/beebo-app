package com.beeboentertainment.movie

import com.beeboentertainment.movie.core.ConnectionDoctor
import com.beeboentertainment.movie.core.ConnectionErrors
import com.beeboentertainment.movie.core.DoctorFacts
import com.beeboentertainment.movie.core.FailureClass
import com.beeboentertainment.movie.core.Level
import com.beeboentertainment.movie.core.PairLink
import com.beeboentertainment.movie.core.PhoneAddress
import com.beeboentertainment.movie.core.PingOutcome
import com.beeboentertainment.movie.core.ServerTrust
import com.beeboentertainment.movie.rtc.NetworkKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.io.InterruptedIOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLHandshakeException

/** The phone's "Can't connect?" logic: which kind of failure it was, and what to tell the person. */
class ConnectionDiagnosisTest {

    private val home = PairLink("192.168.1.20:47811", null, ServerTrust.HOME_NETWORK)
    private val tv = PairLink("smiths.beebo.tv", "smiths", ServerTrust.BEEBO_TV)
    private val other = PairLink("203.0.113.5:47811", null, ServerTrust.OTHER)
    private val phone = PhoneAddress("192.168.1.42", 24)

    private fun facts(
        network: NetworkKind = NetworkKind.LOCAL,
        target: PairLink? = home,
        ping: PingOutcome? = null,
        nameFound: Boolean? = null,
        phone: PhoneAddress? = this.phone,
        login: Int? = null,
    ) = DoctorFacts(network, phone, target, nameFound, ping, login)

    private fun ids(f: DoctorFacts) = ConnectionDoctor.diagnose(f).map { it.id + ":" + it.level.name }

    /* ------------------------------ error classes ------------------------------ */

    @Test
    fun `each kind of failure is told apart by type, through wrapped causes`() {
        assertEquals(FailureClass.DNS, ConnectionErrors.classify(UnknownHostException("x")))
        assertEquals(FailureClass.DNS, ConnectionErrors.classify(IOException("wrapper", IOException("more", UnknownHostException()))))
        assertEquals(FailureClass.TIMEOUT, ConnectionErrors.classify(SocketTimeoutException("connect timed out")))
        assertEquals(FailureClass.TIMEOUT, ConnectionErrors.classify(InterruptedIOException("timeout")))
        assertEquals(FailureClass.REFUSED, ConnectionErrors.classify(IOException("Failed to connect to /192.168.1.20:47811", ConnectException("failed to connect: ECONNREFUSED (Connection refused)"))))
        assertEquals("a connect failure with no better clue is a refusal", FailureClass.REFUSED, ConnectionErrors.classify(ConnectException("Failed to connect to /192.168.1.20:47811")))
        assertEquals(FailureClass.UNREACHABLE, ConnectionErrors.classify(NoRouteToHostException("No route to host")))
        assertEquals(FailureClass.UNREACHABLE, ConnectionErrors.classify(ConnectException("failed to connect: ENETUNREACH (Network is unreachable)")))
        assertEquals(FailureClass.CERTIFICATE, ConnectionErrors.classify(SSLHandshakeException("Trust anchor for certification path not found.")))
        assertEquals(FailureClass.CERTIFICATE, ConnectionErrors.classify(IOException("wrapper", java.security.cert.CertificateException("expired"))))
        assertEquals(FailureClass.CLEARTEXT_BLOCKED, ConnectionErrors.classify(IOException("CLEARTEXT communication to 192.168.1.20 not permitted by network security policy")))
        assertEquals(FailureClass.UNKNOWN, ConnectionErrors.classify(IOException("something odd")))
        assertEquals(FailureClass.UNKNOWN, ConnectionErrors.classify(null))
    }

    @Test
    fun `a cause chain that loops on itself cannot hang the classifier`() {
        val a = IOException("a")
        val b = IOException("b", a)
        a.initCause(b)
        assertEquals(FailureClass.UNKNOWN, ConnectionErrors.classify(a))
    }

    @Test
    fun `the app's own friendly messages classify the same way`() {
        assertEquals(FailureClass.REFUSED, ConnectionErrors.classifyMessage("Can't reach the server — is it running, and is the port right?"))
        assertEquals(FailureClass.TIMEOUT, ConnectionErrors.classifyMessage("Server did not respond in time"))
        assertEquals(FailureClass.DNS, ConnectionErrors.classifyMessage("That server address can't be found - the name doesn't exist any more"))
        assertEquals(FailureClass.CLEARTEXT_BLOCKED, ConnectionErrors.classifyMessage("Plain HTTP was blocked by Android (network config problem)"))
        assertEquals(FailureClass.UNKNOWN, ConnectionErrors.classifyMessage(null))
    }

    @Test
    fun `http answers map to a failure or to nothing`() {
        assertNull(ConnectionErrors.classifyHttp(200))
        assertNull(ConnectionErrors.classifyHttp(308))
        assertEquals(FailureClass.UNAUTHORIZED, ConnectionErrors.classifyHttp(401))
        assertEquals(FailureClass.UNAUTHORIZED, ConnectionErrors.classifyHttp(403))
        assertEquals(FailureClass.NOT_BEEBO, ConnectionErrors.classifyHttp(404))
        assertEquals(FailureClass.SERVER_ERROR, ConnectionErrors.classifyHttp(502))
    }

    /* ------------------------------ same network ------------------------------ */

    @Test
    fun `same subnet uses the phone's own prefix length`() {
        assertEquals(true, ConnectionDoctor.sameSubnet(PhoneAddress("192.168.1.42", 24), "192.168.1.20"))
        assertEquals(false, ConnectionDoctor.sameSubnet(PhoneAddress("192.168.1.42", 24), "192.168.2.20"))
        assertEquals(true, ConnectionDoctor.sameSubnet(PhoneAddress("192.168.1.42", 16), "192.168.2.20"))
        assertEquals(false, ConnectionDoctor.sameSubnet(PhoneAddress("10.0.0.5", 8), "192.168.1.20"))
        assertEquals(true, ConnectionDoctor.sameSubnet(PhoneAddress("10.0.0.5", 32), "10.0.0.5"))
        assertEquals(false, ConnectionDoctor.sameSubnet(PhoneAddress("10.0.0.5", 32), "10.0.0.6"))
        assertNull(ConnectionDoctor.sameSubnet(null, "192.168.1.20"))
        assertNull(ConnectionDoctor.sameSubnet(PhoneAddress("192.168.1.42", 0), "192.168.1.20"))
        assertNull(ConnectionDoctor.sameSubnet(PhoneAddress("192.168.1.42", 24), "pc.local"))
        assertNull(ConnectionDoctor.sameSubnet(PhoneAddress("bad", 24), "192.168.1.20"))
        assertNull(ConnectionDoctor.sameSubnet(PhoneAddress("192.168.1.42", 24), "999.1.1.1"))
    }

    /* ------------------------------ decisions ------------------------------ */

    @Test
    fun `offline stops everything else and says how to get online`() {
        val f = ConnectionDoctor.diagnose(facts(network = NetworkKind.NONE, ping = PingOutcome.Failed(FailureClass.TIMEOUT)))
        assertEquals(1, f.size)
        assertEquals(Level.PROBLEM, f[0].level)
        assertTrue(f[0].steps.any { it.contains("Wi-Fi") })
        assertTrue(ConnectionDoctor.headline(f).contains("not online"))
    }

    @Test
    fun `mobile data with a home address says to join the home Wi-Fi`() {
        val f = ConnectionDoctor.diagnose(facts(network = NetworkKind.OTHER, ping = PingOutcome.Failed(FailureClass.TIMEOUT)))
        val wifi = f.first { it.id == "wifi" }
        assertEquals(Level.PROBLEM, wifi.level)
        assertTrue(wifi.steps.any { it.contains("same Wi-Fi") })
        assertTrue(wifi.steps.any { it.contains("home’s name") })
        assertEquals("wifi", f.first { it.level == Level.PROBLEM }.id)
    }

    @Test
    fun `mobile data is fine for a beebo dot tv name`() {
        val f = ConnectionDoctor.diagnose(facts(network = NetworkKind.OTHER, target = tv, phone = null, ping = PingOutcome.Answered(80, 200)))
        assertFalse(f.any { it.level == Level.PROBLEM })
        assertTrue(f.any { it.id == "server" && it.title.contains("Beebo’s service answered") })
    }

    @Test
    fun `a different subnet is named as a different network, a guest Wi-Fi in particular`() {
        val f = ConnectionDoctor.diagnose(facts(phone = PhoneAddress("192.168.50.9", 24), ping = PingOutcome.Failed(FailureClass.TIMEOUT)))
        val subnet = f.first { it.id == "subnet" }
        assertEquals(Level.PROBLEM, subnet.level)
        assertTrue(subnet.body.contains("192.168.50.9") && subnet.body.contains("192.168.1.20"))
        assertTrue(subnet.steps.any { it.contains("guest") })
    }

    @Test
    fun `same subnet is a pass, unknown subnet says nothing`() {
        assertTrue(ids(facts()).contains("subnet:OK"))
        assertFalse(ids(facts(phone = null)).any { it.startsWith("subnet") })
    }

    @Test
    fun `a name that cannot be found is reported once, not twice`() {
        val f = ConnectionDoctor.diagnose(facts(target = PairLink("pc.local", null, ServerTrust.HOME_NETWORK), nameFound = false, ping = PingOutcome.Failed(FailureClass.DNS)))
        assertEquals(1, f.count { it.id == "dns" })
        assertTrue(f.first { it.id == "dns" }.steps.any { it.contains(".local") })
    }

    @Test
    fun `timeout and refused on the home network mean different things`() {
        val refused = ConnectionDoctor.diagnose(facts(ping = PingOutcome.Failed(FailureClass.REFUSED))).first { it.level == Level.PROBLEM }
        assertTrue(refused.title.contains("not answering"))
        assertTrue(refused.steps.any { it.contains("Fix it for me") })
        val timeout = ConnectionDoctor.diagnose(facts(ping = PingOutcome.Failed(FailureClass.TIMEOUT))).first { it.level == Level.PROBLEM }
        assertTrue(timeout.body.contains("asleep") && timeout.body.contains("firewall"))
        assertTrue(timeout.steps.any { it.contains("Fix it for me") })
        assertTrue(refused.title != timeout.title)
    }

    @Test
    fun `timeout on a beebo dot tv name points at the computer at home`() {
        val t = ConnectionDoctor.diagnose(facts(network = NetworkKind.OTHER, target = tv, phone = null, ping = PingOutcome.Failed(FailureClass.TIMEOUT))).first { it.level == Level.PROBLEM }
        assertTrue(t.body.contains("at home"))
    }

    @Test
    fun `certificate, cleartext, not-beebo, server error and unreachable each get their own advice`() {
        fun title(k: FailureClass) = ConnectionDoctor.diagnose(facts(ping = PingOutcome.Failed(k))).first { it.level == Level.PROBLEM }
        assertTrue(title(FailureClass.CERTIFICATE).steps.any { it.contains("date and time") })
        assertTrue(title(FailureClass.CLEARTEXT_BLOCKED).title.contains("plain"))
        assertTrue(title(FailureClass.UNREACHABLE).steps.any { it.contains("guest") })
        assertTrue(title(FailureClass.SERVER_ERROR).steps.any { it.contains("Restart Beebo") })
        val notBeebo = ConnectionDoctor.diagnose(facts(ping = PingOutcome.Answered(20, 404))).first { it.level == Level.PROBLEM }
        assertTrue(notBeebo.title.contains("not Beebo") && notBeebo.title.contains("404"))
        val err = ConnectionDoctor.diagnose(facts(ping = PingOutcome.Answered(20, 503))).first { it.level == Level.PROBLEM }
        assertTrue(err.title.contains("503"))
    }

    @Test
    fun `an answered ping is good news, and a refused sign-in is a password problem, not a network one`() {
        val fine = ConnectionDoctor.diagnose(facts(ping = PingOutcome.Answered(35, 200)))
        assertFalse(fine.any { it.level == Level.PROBLEM })
        assertTrue(fine.first { it.id == "server" }.title.contains("35 ms"))
        assertEquals("Everything on this phone looks fine", ConnectionDoctor.headline(fine))
        val wrong = ConnectionDoctor.diagnose(facts(ping = PingOutcome.Answered(35, 200), login = 401))
        val p = wrong.first { it.level == Level.PROBLEM }
        assertEquals("login", p.id)
        assertTrue(p.steps.any { it.contains("Show password") })
        assertFalse(wrong.any { it.id == "server" && it.level == Level.PROBLEM })
    }

    @Test
    fun `the order is always network, wifi, subnet, name, then the computer`() {
        val f = ConnectionDoctor.diagnose(facts(ping = PingOutcome.Failed(FailureClass.TIMEOUT), nameFound = true, phone = PhoneAddress("10.9.9.9", 24)))
        assertEquals(listOf("online", "subnet", "dns", "server"), f.map { it.id })
    }

    @Test
    fun `the target comes from what is in the Home box, or from a scanned address on the home Wi-Fi`() {
        assertEquals("smiths.beebo.tv", ConnectionDoctor.targetFor("smiths", null, NetworkKind.OTHER)?.server)
        assertEquals(ServerTrust.BEEBO_TV, ConnectionDoctor.targetFor("smiths.beebo.tv", null, NetworkKind.LOCAL)?.trust)
        assertEquals("192.168.1.20:47811", ConnectionDoctor.targetFor("192.168.1.20:47811", null, NetworkKind.LOCAL)?.server)
        assertEquals("192.168.1.20:47811", ConnectionDoctor.targetFor("smiths", "192.168.1.20:47811", NetworkKind.LOCAL)?.server)
        assertEquals("smiths.beebo.tv", ConnectionDoctor.targetFor("smiths", "192.168.1.20:47811", NetworkKind.OTHER)?.server)
        assertNull(ConnectionDoctor.targetFor("sam@example.com", null, NetworkKind.LOCAL))
        assertNull(ConnectionDoctor.targetFor("", null, NetworkKind.LOCAL))
        assertNull(ConnectionDoctor.targetFor("not a home!", null, NetworkKind.LOCAL))
    }

    @Test
    fun `nothing typed yet gives only the phone's own state`() {
        assertEquals(listOf("online:OK"), ids(facts(target = null)))
        assertEquals("Nothing to check yet", ConnectionDoctor.headline(emptyList()))
    }

    /* ------------------------------ the copyable report ------------------------------ */

    @Test
    fun `the report says what was found and never contains a credential or a stranger's address`() {
        val f = facts(target = other, ping = PingOutcome.Failed(FailureClass.TIMEOUT), login = 401)
        val text = ConnectionDoctor.report(f, ConnectionDoctor.diagnose(f), "1.39", "Android 14")
        assertTrue(text.contains("App version: 1.39") && text.contains("Android: Android 14"))
        assertTrue(text.contains("Phone network: Wi-Fi or cable"))
        assertTrue(text.contains("another address (hidden)"))
        assertFalse(text.contains("203.0.113.5"))
        assertTrue(text.contains("TIMEOUT"))
        assertTrue(text.contains("Last sign-in answer: HTTP 401"))
        val homeText = ConnectionDoctor.report(facts(), ConnectionDoctor.diagnose(facts()), "1.39", "Android 14")
        assertTrue("a private address helps support and reveals nothing", homeText.contains("192.168.1.20:47811"))
        val tvText = ConnectionDoctor.report(facts(target = tv), emptyList(), "1", "A")
        assertFalse("the household name stays out", tvText.contains("smiths"))
    }

    @Test
    fun `every failure class has words and a next step`() {
        for (k in FailureClass.values()) {
            val f = ConnectionDoctor.diagnose(facts(ping = PingOutcome.Failed(k)))
            val problem = f.firstOrNull { it.level == Level.PROBLEM } ?: continue
            assertTrue("$k has a title", problem.title.isNotBlank())
            assertTrue("$k has steps", problem.steps.isNotEmpty())
        }
    }
}
