package com.beeboentertainment.movie.billing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PlanCatalogTest {

    @Test
    fun `household base plan ids round-trip to and from the Worker's own plan strings`() {
        for (plan in listOf("beebo-standard", "beebo-standard-4k")) {
            assertEquals(plan, PlanCatalog.basePlanIdForPlan(plan))
            assertEquals(plan, PlanCatalog.planForBasePlanId(plan))
        }
    }

    @Test
    fun `unrecognized or malformed base plan ids fail closed to null, never a guessed plan`() {
        assertNull(PlanCatalog.basePlanIdForPlan("beebo-vpn"))
        assertNull(PlanCatalog.basePlanIdForPlan("some-future-plan"))
        assertNull(PlanCatalog.planForBasePlanId("beebo-standard-4K")) // case-sensitive
        assertNull(PlanCatalog.planForBasePlanId("beebo-standard-4k "))
        assertNull(PlanCatalog.planForBasePlanId(null))
        assertNull(PlanCatalog.planForBasePlanId(""))
    }

    @Test
    fun `every seat tier 1 through 6 round-trips`() {
        for (n in 1..6) {
            val basePlanId = PlanCatalog.basePlanIdForSeats(n)
            assertEquals("seats-$n", basePlanId)
            assertEquals(n, PlanCatalog.seatsForBasePlanId(basePlanId))
        }
    }

    @Test
    fun `seat counts outside 1 to MAX_EXTRA_SEATS fail closed`() {
        assertNull(PlanCatalog.basePlanIdForSeats(0))
        assertNull(PlanCatalog.basePlanIdForSeats(7))
        assertNull(PlanCatalog.basePlanIdForSeats(-1))
        assertEquals(0, PlanCatalog.seatsForBasePlanId("seats-0"))
        assertEquals(0, PlanCatalog.seatsForBasePlanId("seats-7"))
        assertEquals(0, PlanCatalog.seatsForBasePlanId("seats-"))
        assertEquals(0, PlanCatalog.seatsForBasePlanId("beebo-standard"))
        assertEquals(0, PlanCatalog.seatsForBasePlanId(null))
    }

    @Test
    fun `the max extra seats constant matches the documented household ceiling`() {
        assertEquals(6, PlanCatalog.MAX_EXTRA_SEATS)
    }
}
