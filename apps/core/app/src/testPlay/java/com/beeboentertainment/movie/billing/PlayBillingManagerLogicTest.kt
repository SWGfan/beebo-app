package com.beeboentertainment.movie.billing

import com.android.billingclient.api.Purchase
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * [PlayBillingManager.purchaseAction] is a pure function of a purchase's own state - no
 * BillingClient, no live Play connection, no Context - so it's exercised directly here even
 * though there is no real Play Console product to purchase against yet (docs
 * GOOGLE-PLAY-BILLING-AND-SEAT-ADDON.md section 6.5: "genuinely blocked" vs. "testable now").
 */
class PlayBillingManagerLogicTest {

    @Test
    fun `a purchased, not-yet-acknowledged subscription is activated and acknowledged`() {
        assertEquals(
            PlayBillingManager.PurchaseAction.ACTIVATE_AND_ACKNOWLEDGE,
            PlayBillingManager.purchaseAction(Purchase.PurchaseState.PURCHASED, isAcknowledged = false)
        )
    }

    @Test
    fun `a purchased, already-acknowledged subscription (say, re-delivered on reconnect) is not double-activated`() {
        assertEquals(
            PlayBillingManager.PurchaseAction.ALREADY_ACKNOWLEDGED,
            PlayBillingManager.purchaseAction(Purchase.PurchaseState.PURCHASED, isAcknowledged = true)
        )
    }

    @Test
    fun `a pending purchase (say, a delayed payment method) is neither activated nor acknowledged yet`() {
        assertEquals(
            PlayBillingManager.PurchaseAction.PENDING,
            PlayBillingManager.purchaseAction(Purchase.PurchaseState.PENDING, isAcknowledged = false)
        )
    }

    @Test
    fun `an unspecified state fails closed to UNKNOWN, never treated as a completed purchase`() {
        assertEquals(
            PlayBillingManager.PurchaseAction.UNKNOWN,
            PlayBillingManager.purchaseAction(Purchase.PurchaseState.UNSPECIFIED_STATE, isAcknowledged = false)
        )
    }
}
