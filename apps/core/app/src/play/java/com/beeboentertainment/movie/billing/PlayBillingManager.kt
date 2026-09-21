package com.beeboentertainment.movie.billing

import android.app.Activity
import android.content.Context
import com.android.billingclient.api.AcknowledgePurchaseParams
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClient.BillingResponseCode
import com.android.billingclient.api.BillingClient.ProductType
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.PurchasesUpdatedListener
import com.android.billingclient.api.QueryProductDetailsParams
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/**
 * Google Play Billing Library wiring for the household plan + extra-seat add-on. Play-only
 * (`src/play`) — the `web` flavour never links `billing-ktx` at all (build.gradle.kts). See
 * docs/GOOGLE-PLAY-BILLING-AND-SEAT-ADDON.md section 6 for the design this implements, especially
 * why "subscription with add-ons" (base item + a separate add-on subscription product in the SAME
 * purchase flow) is the primitive used, not a quantity on one SKU.
 *
 * This class only talks to Play. It never decides the household's entitlement by itself — every
 * successful purchase is handed to the Worker (`POST /play/activate`) and the SERVER's answer is
 * what the UI trusts, exactly as [com.beeboentertainment.movie.core.DistributionPolicy]'s own
 * comments describe for `plan` on the desktop side. [PlayBillingManager] purely: connects, queries
 * products, launches the purchase sheet, and acknowledges what Play hands back.
 */
class PlayBillingManager(context: Context, private val onPurchases: (List<Purchase>) -> Unit) {

    /** What to do with an incoming [Purchase], decided purely from its own state — see [purchaseAction]. */
    enum class PurchaseAction { ACTIVATE_AND_ACKNOWLEDGE, ALREADY_ACKNOWLEDGED, PENDING, UNKNOWN }

    private val listener = PurchasesUpdatedListener { billingResult, purchases ->
        if (billingResult.responseCode == BillingResponseCode.OK && purchases != null) {
            onPurchases(purchases)
        }
        // USER_CANCELED and every other code: nothing purchased, nothing to activate. The caller's
        // own UI (HouseholdPlanScreen) reads billingResult separately if it wants to show a message;
        // Beebo's own copy for that never states a price or uses the guarded words (see build.gradle.kts
        // checkPlayDebugPolicy) - Play's own purchase sheet already told the person what happened.
    }

    private val client: BillingClient = BillingClient.newBuilder(context)
        .setListener(listener)
        .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
        .build()

    suspend fun connect(): Boolean = suspendCancellableCoroutine { cont ->
        client.startConnection(object : BillingClientStateListener {
            override fun onBillingSetupFinished(billingResult: BillingResult) {
                if (cont.isActive) cont.resume(billingResult.responseCode == BillingResponseCode.OK)
            }
            override fun onBillingServiceDisconnected() {
                // No auto-retry here: HouseholdPlanScreen re-connects on demand (opening the
                // screen again), rather than this class silently retrying in the background.
            }
        })
    }

    fun disconnect() {
        if (client.isReady) client.endConnection()
    }

    /** Queries both catalog products (docs section 1.2) in one call. Either list may come back empty. */
    suspend fun queryProducts(): Pair<List<ProductDetails>, List<ProductDetails>> {
        val household = queryOne(PlanCatalog.HOUSEHOLD_PRODUCT_ID)
        val seats = queryOne(PlanCatalog.SEATS_PRODUCT_ID)
        return household to seats
    }

    private suspend fun queryOne(productId: String): List<ProductDetails> = suspendCancellableCoroutine { cont ->
        val params = QueryProductDetailsParams.newBuilder()
            .setProductList(listOf(QueryProductDetailsParams.Product.newBuilder().setProductId(productId).setProductType(ProductType.SUBS).build()))
            .build()
        client.queryProductDetailsAsync(params) { billingResult, productDetailsList ->
            if (cont.isActive) {
                cont.resume(if (billingResult.responseCode == BillingResponseCode.OK) productDetailsList else emptyList())
            }
        }
    }

    /** The offer token for a given base plan id, or null if that base plan isn't (yet) offered. */
    private fun offerTokenFor(details: ProductDetails, basePlanId: String): String? =
        details.subscriptionOfferDetails?.firstOrNull { it.basePlanId == basePlanId }?.offerToken

    /**
     * First purchase, or a plan/seat CHANGE with no existing purchase token to replace (should not
     * normally happen once someone has ever bought anything — see [changeSubscription] for that path).
     * `seats` of 0 buys the household plan alone.
     *
     * [obfuscatedAccountId] MUST be [HouseholdBillingClient.playAccountId] fetched fresh for the
     * signed-in account right before calling this — the Worker's `/play/activate` refuses any
     * purchase whose token doesn't carry a matching one (see that function's own comment for why).
     */
    fun launchPurchase(activity: Activity, obfuscatedAccountId: String, household: ProductDetails, householdBasePlanId: String, seatsProduct: ProductDetails?, seats: Int): BillingResult {
        val items = buildProductDetailsParams(household, householdBasePlanId, seatsProduct, seats)
        val params = BillingFlowParams.newBuilder().setProductDetailsParamsList(items).setObfuscatedAccountId(obfuscatedAccountId).build()
        return client.launchBillingFlow(activity, params)
    }

    /**
     * Changing tier and/or seat count on an EXISTING subscription — always carries the old
     * purchase token and the FULL desired item list (docs section 6.2's "specify all active items
     * plus new add-ons, excluding those to remove", from Play's own subscription-with-add-ons
     * modification rule). See [launchPurchase] for what [obfuscatedAccountId] must be.
     */
    fun changeSubscription(activity: Activity, obfuscatedAccountId: String, oldPurchaseToken: String, household: ProductDetails, householdBasePlanId: String, seatsProduct: ProductDetails?, seats: Int): BillingResult {
        val items = buildProductDetailsParams(household, householdBasePlanId, seatsProduct, seats)
        val update = BillingFlowParams.SubscriptionUpdateParams.newBuilder()
            .setOldPurchaseToken(oldPurchaseToken)
            .setSubscriptionReplacementMode(BillingFlowParams.SubscriptionUpdateParams.ReplacementMode.CHARGE_PRORATED_PRICE)
            .build()
        val params = BillingFlowParams.newBuilder().setProductDetailsParamsList(items).setObfuscatedAccountId(obfuscatedAccountId).setSubscriptionUpdateParams(update).build()
        return client.launchBillingFlow(activity, params)
    }

    private fun buildProductDetailsParams(household: ProductDetails, householdBasePlanId: String, seatsProduct: ProductDetails?, seats: Int): List<BillingFlowParams.ProductDetailsParams> {
        val out = mutableListOf<BillingFlowParams.ProductDetailsParams>()
        val householdToken = offerTokenFor(household, householdBasePlanId)
        checkNotNull(householdToken) { "no offer for base plan $householdBasePlanId" }
        // The base item is always first (docs section 1.1/6.2: "the first item in the list is the base item").
        out += BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(household).setOfferToken(householdToken).build()
        val seatBasePlanId = PlanCatalog.basePlanIdForSeats(seats)
        if (seatBasePlanId != null && seatsProduct != null) {
            val seatToken = offerTokenFor(seatsProduct, seatBasePlanId)
            if (seatToken != null) {
                out += BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(seatsProduct).setOfferToken(seatToken).build()
            }
        }
        return out
    }

    suspend fun acknowledge(purchase: Purchase): Boolean = suspendCancellableCoroutine { cont ->
        val params = AcknowledgePurchaseParams.newBuilder().setPurchaseToken(purchase.purchaseToken).build()
        client.acknowledgePurchase(params) { billingResult ->
            if (cont.isActive) cont.resume(billingResult.responseCode == BillingResponseCode.OK)
        }
    }

    companion object {
        /**
         * What to do with a purchase, decided purely from its own state — no BillingClient, no
         * Context, so this is unit-tested directly (PlayBillingManagerLogicTest, `src/testPlay`)
         * without any live Play connection. [purchaseState]/[isAcknowledged] are exactly
         * `Purchase.purchaseState`/`Purchase.isAcknowledged`; kept as plain parameters rather than
         * requiring a real `Purchase` object so the test doesn't need one either.
         */
        fun purchaseAction(purchaseState: Int, isAcknowledged: Boolean): PurchaseAction = when {
            purchaseState == Purchase.PurchaseState.PURCHASED && !isAcknowledged -> PurchaseAction.ACTIVATE_AND_ACKNOWLEDGE
            purchaseState == Purchase.PurchaseState.PURCHASED && isAcknowledged -> PurchaseAction.ALREADY_ACKNOWLEDGED
            purchaseState == Purchase.PurchaseState.PENDING -> PurchaseAction.PENDING
            else -> PurchaseAction.UNKNOWN
        }
    }
}
