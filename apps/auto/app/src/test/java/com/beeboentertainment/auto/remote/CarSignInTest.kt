package com.beeboentertainment.auto.remote

import com.beeboentertainment.movie.rtc.HomeEntry
import com.beeboentertainment.movie.rtc.NetworkKind
import com.beeboentertainment.movie.rtc.RemoteMessages
import com.beeboentertainment.movie.rtc.RemoteSignIn
import com.beeboentertainment.movie.rtc.SignInPlan
import com.beeboentertainment.movie.rtc.TunnelConnection
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CarSignInTest {

    private fun attempt(p: CarSignIn.Plan): CarSignIn.Plan.Attempt =
        p as? CarSignIn.Plan.Attempt ?: throw AssertionError("expected an attempt, got $p")

    @Test fun `a home name with no direct address goes through beebo tv`() {
        val p = attempt(CarSignIn.plan("thesmiths", "kid", "pw", "", NetworkKind.LOCAL))
        assertEquals(HomeEntry.Name("thesmiths"), p.entry)
        assertEquals(RemoteSignIn(RemoteSignIn.Kind.MEMBER, "thesmiths", "kid", "pw"), p.signIn)
        assertNull(p.direct)
        assertEquals(listOf(SignInPlan.Step.Remote), p.steps)
    }

    @Test fun `the paying email works as Home too`() {
        val p = attempt(CarSignIn.plan(" Fay@Example.com ", " kid ", "pw", "", NetworkKind.OTHER))
        assertEquals(HomeEntry.Email("fay@example.com"), p.entry)
        assertEquals("kid", p.signIn!!.id)
        assertTrue(p.signIn!!.homeIsEmail)
        assertEquals(listOf(SignInPlan.Step.Remote), p.steps)
    }

    @Test fun `on Wi-Fi a known home address is tried first, then the tunnel`() {
        val p = attempt(CarSignIn.plan("nick.beebo.tv", "kid", "pw", "192.168.1.10", NetworkKind.LOCAL))
        assertEquals("http://192.168.1.10:47811", p.direct)
        assertEquals(listOf(SignInPlan.Step.Direct("http://192.168.1.10:47811"), SignInPlan.Step.Remote), p.steps)
        // Mobile data: straight to the tunnel, but the address is still remembered for home.
        val away = attempt(CarSignIn.plan("nick", "kid", "pw", "192.168.1.10", NetworkKind.OTHER))
        assertEquals(listOf(SignInPlan.Step.Remote), away.steps)
        assertEquals("http://192.168.1.10:47811", away.direct)
    }

    @Test fun `advanced only - an older setup signs in straight to its address`() {
        val p = attempt(CarSignIn.plan("", "kid", "pw", "https://pc.example.net:47811/", NetworkKind.OTHER))
        assertNull(p.signIn)
        assertEquals(listOf(SignInPlan.Step.Direct("https://pc.example.net:47811")), p.steps)
        // An address typed in Home is the same thing, with this app's own http + 47811 rule.
        val inHome = attempt(CarSignIn.plan("192.168.1.10", "kid", "pw", "", NetworkKind.LOCAL))
        assertNull(inHome.signIn)
        assertEquals(listOf(SignInPlan.Step.Direct("http://192.168.1.10:47811")), inHome.steps)
    }

    @Test fun `a beebo tv name typed under advanced is treated as Home`() {
        val p = attempt(CarSignIn.plan("", "kid", "pw", "nick.beebo.tv", NetworkKind.LOCAL))
        assertEquals(HomeEntry.Name("nick"), p.entry)
        assertEquals(listOf(SignInPlan.Step.Remote), p.steps)
        assertNull(p.direct)
    }

    @Test fun `what needs fixing, in plain words`() {
        assertEquals(CarSignIn.Plan.Invalid(CarSignIn.FILL_IN), CarSignIn.plan("nick", "", "pw", "", NetworkKind.LOCAL))
        assertEquals(CarSignIn.Plan.Invalid(CarSignIn.FILL_IN), CarSignIn.plan("nick", "kid", "", "", NetworkKind.LOCAL))
        assertEquals(CarSignIn.Plan.Invalid(CarSignIn.FILL_IN), CarSignIn.plan("", "kid", "pw", "", NetworkKind.LOCAL))
        assertEquals(CarSignIn.Plan.Invalid(CarSignIn.BAD_HOME), CarSignIn.plan("a@b", "kid", "pw", "", NetworkKind.LOCAL))
        val badDirect = CarSignIn.plan("nick", "kid", "pw", "ftp://pc", NetworkKind.LOCAL)
        assertTrue((badDirect as CarSignIn.Plan.Invalid).message.contains("http://"))
        assertTrue(CarSignIn.loginProblem("bad_credentials").contains("didn't match"))
        assertTrue(CarSignIn.loginProblem(null, locked = true, minutes = 3).contains("3 minutes"))
    }

    @Test fun `short words for the car's screen`() {
        assertEquals(CarNotice.DIRECT_UNREACHABLE, CarNotice.forBrowseError(false, null, "timeout"))
        assertEquals(
            CarNotice.HOME_OFFLINE,
            CarNotice.forBrowseError(true, TunnelConnection.Status.Retrying(RemoteMessages.hostOffline("nick"), "host_offline", 0), "x"),
        )
        assertEquals(
            CarNotice.SIGN_IN_AGAIN,
            CarNotice.forBrowseError(true, TunnelConnection.Status.Failed(RemoteMessages.SIGNED_OUT, "signed_out"), RemoteMessages.SIGNED_OUT),
        )
        assertEquals(CarNotice.SIGN_IN_AGAIN, CarNotice.forBrowseError(true, TunnelConnection.Status.Idle, RemoteMessages.SIGNED_OUT))
        assertEquals(CarNotice.UPDATE_HOST, CarNotice.forBrowseError(true, TunnelConnection.Status.Idle, RemoteMessages.UPDATE_HOST))
        assertEquals(CarNotice.CONNECTING, CarNotice.forBrowseError(true, TunnelConnection.Status.Connecting(1, false), null))
    }
}
