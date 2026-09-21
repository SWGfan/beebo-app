package com.beeboentertainment.movie.billing

/**
 * The Google Play Billing product/plan catalog — pure mapping, no BillingClient dependency, so it
 * compiles and is unit-tested under BOTH the `web` and `play` flavours even though only `play`
 * ever calls into real Play Billing (mirrors how [com.beeboentertainment.movie.core.DistributionPolicy]
 * also lives in `main`).
 *
 * Kept in lockstep with the Worker's own copy of this table (worker/googlePlay.js's
 * `entitlementFromPlayPurchase`) and with worker/worker.js's existing `planFromStripeSubscription` -
 * the household plan ids here (`beebo-standard`, `beebo-standard-4k`) are the EXACT SAME strings the
 * Worker already uses for the Stripe side, never a parallel naming scheme. See
 * docs/GOOGLE-PLAY-BILLING-AND-SEAT-ADDON.md section 1 for why "subscription with add-ons" (a
 * separate add-on subscription product, not a quantity on one SKU) is the actual current Play
 * Billing Library primitive this is built on, and why extra seats are therefore modelled as a
 * small family of `seats-N` base plans rather than a quantity field.
 *
 * Fails closed throughout, exactly like `planFromStripeSubscription`: an unrecognized id
 * contributes nothing (`null` or `0`), never a guessed plan or seat count.
 */
object PlanCatalog {
    /** Play Console subscription product id for the household plan (two base plans inside it). */
    const val HOUSEHOLD_PRODUCT_ID = "beebo_household"

    /** Play Console subscription product id for the seat add-on (one base plan per seat count). */
    const val SEATS_PRODUCT_ID = "beebo_extra_seats"

    /** Extra seats beyond the base 6-person household are capped here on both stores. */
    const val MAX_EXTRA_SEATS = 6

    private val HOUSEHOLD_BASE_PLANS = setOf("beebo-standard", "beebo-standard-4k")
    private val SEATS_BASE_PLAN_RE = Regex("^seats-([1-6])$")

    /** Worker plan id -> the household product's base plan id (they're the same string, by design). */
    fun basePlanIdForPlan(plan: String): String? = if (plan in HOUSEHOLD_BASE_PLANS) plan else null

    /** Household base plan id -> Worker plan id. Unrecognized input fails closed to null. */
    fun planForBasePlanId(basePlanId: String?): String? =
        if (basePlanId != null && basePlanId in HOUSEHOLD_BASE_PLANS) basePlanId else null

    /** Desired extra-seat count -> the seat add-on's base plan id, or null outside 1..MAX_EXTRA_SEATS. */
    fun basePlanIdForSeats(seats: Int): String? =
        if (seats in 1..MAX_EXTRA_SEATS) "seats-$seats" else null

    /** Seat add-on base plan id -> the seat count it represents. Unrecognized input fails closed to 0. */
    fun seatsForBasePlanId(basePlanId: String?): Int =
        SEATS_BASE_PLAN_RE.find(basePlanId.orEmpty())?.groupValues?.get(1)?.toIntOrNull() ?: 0
}
