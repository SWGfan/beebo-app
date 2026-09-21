package com.beeboentertainment.movie.distribution

import com.beeboentertainment.movie.BuildConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Runs in every flavour. The Cast SDK and Play Billing need Google Play services, which Fire OS
 * does not have, so they must be linked into web and play and into nothing else. If a build's
 * classpath and its flags ever disagree, this says which side is wrong.
 */
class FlavorSplitTest {

    private fun onClasspath(name: String): Boolean = try {
        Class.forName(name, false, javaClass.classLoader)
        true
    } catch (_: ClassNotFoundException) {
        false
    } catch (_: LinkageError) {
        false
    }

    @Test fun `the Cast SDK is linked exactly when the build is not the amazon one`() {
        val expected = !BuildConfig.IS_AMAZON_BUILD
        assertEquals(expected, onClasspath("com.google.android.gms.cast.framework.CastContext"))
        assertEquals(expected, onClasspath("androidx.media3.cast.CastPlayer"))
        assertEquals(expected, onClasspath("com.google.android.gms.common.GoogleApiAvailability"))
    }

    @Test fun `Play Billing is linked exactly when the build sells in the app`() {
        assertEquals(BuildConfig.FEATURE_IN_APP_PURCHASES, onClasspath("com.android.billingclient.api.BillingClient"))
    }

    @Test fun `only one store flag combination per flavour`() {
        // web: neither store. play: Play. amazon: store rules (IS_PLAY_BUILD) plus the amazon flag.
        if (BuildConfig.IS_AMAZON_BUILD) assertTrue(BuildConfig.IS_PLAY_BUILD)
        if (!BuildConfig.IS_PLAY_BUILD) {
            assertFalse(BuildConfig.IS_AMAZON_BUILD)
            assertFalse(BuildConfig.FEATURE_IN_APP_PURCHASES)
            assertTrue(BuildConfig.FEATURE_BEEBOBOOK)
        } else {
            assertFalse(BuildConfig.FEATURE_BEEBOBOOK)
        }
    }
}
