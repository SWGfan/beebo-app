package com.beeboentertainment.movie.campsite.hunt

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

/** The five card sets: how many items, the age bands, the wording rules, and the item selection. */
class HuntCardsTest {

    @Test fun theCatalogHasNoContentProblemsAndAllFiveCards() {
        assertEquals("content problems: ${HuntCatalog.problems}", emptyList<String>(), HuntCatalog.problems)
        assertEquals(
            listOf("Camp Basics", "Nature Colors", "Night Sky & Sounds", "Rainy Day", "Hike Bingo"),
            HuntCatalog.cards.map { it.title },
        )
        assertEquals(HuntCards.ALL.size, HuntCatalog.cards.size)
    }

    @Test fun everyCardHasTwentyOrMoreItemsAndEveryBandHasEnoughToPlay() {
        HuntCards.ALL.forEach { card ->
            assertTrue("${card.id} has ${card.items.size} items", card.items.size >= 20)
            val little = card.items.count { it.band == HuntBand.LITTLE }
            val middle = card.items.count { it.band == HuntBand.MIDDLE }
            val older = card.items.count { it.band == HuntBand.OLDER }
            assertTrue("${card.id} little=$little", little >= 9)
            assertTrue("${card.id} middle=$middle", middle >= 6)
            assertTrue("${card.id} older=$older", older >= 5)
        }
    }

    @Test fun idsAndTextAreUniqueAcrossAllCards() {
        val ids = HuntCards.ALL.flatMap { c -> c.items.map { it.id } }
        assertEquals("duplicate ids", ids.size, ids.toSet().size)
        HuntCards.ALL.forEach { c ->
            val texts = c.items.map { it.text.lowercase() }
            assertEquals("${c.id} repeats a line", texts.size, texts.toSet().size)
        }
        assertEquals(HuntCards.ALL.size, HuntCards.ALL.map { it.id }.toSet().size)
    }

    @Test fun everyItemIsLookingOrListeningOnlyAndPassesTheDenyList() {
        HuntCards.ALL.forEach { card ->
            card.items.forEach { item ->
                assertEquals("${card.id}/${item.id}", emptyList<String>(), HuntContentRules.violations(item, card.layout))
                assertFalse(item.text.contains("<") || item.text.contains(">") || item.text.contains("&"))
            }
        }
    }

    @Test fun theRulesRejectTouchingTakingEatingFireWaterPeopleAndPredators() {
        val bad = listOf(
            "Find a berry and eat it", "Pick a wildflower", "Collect three pinecones", "Catch a butterfly", "Touch the bark",
            "Find something near the lake", "Spot a bear", "Spot a snake", "Find someone wearing red", "Spot a camper",
            "Find a mushroom", "Look for a nest", "Find the campfire", "Spot the sun setting", "Climb a big rock",
            "Spot a car on the road", "Find a knife", "Follow a squirrel", "Find a Disney toy", "Spot a Junior Ranger",
            "Spot something off the trail", "Look for a neighbor", "Take a leaf home", "Find your friend's <b>bold</b>",
            "", "Do a dance",
        )
        bad.forEach { text ->
            assertTrue("should refuse: $text", HuntContentRules.violations(text).isNotEmpty())
        }
        listOf("Find something red", "Spot a tall tree", "Listen for the wind", "Look for the moon", "Hear a bird sing", "Notice the shape of a cloud")
            .forEach { assertEquals(it, emptyList<String>(), HuntContentRules.violations(it)) }
    }

    @Test fun aBingoSquareIsShortEnoughForAPhoneGrid() {
        val bingo = HuntCards.HIKE_BINGO
        assertEquals(HuntLayout.BINGO, bingo.layout)
        bingo.items.forEach { assertTrue("${it.text} is ${it.text.length} long", it.text.length <= HuntCards.SQUARE_MAX) }
        assertTrue(HuntContentRules.violations("Spot a very long square that will not fit in a phone cell", HuntCards.SQUARE_MAX).isNotEmpty())
    }

    @Test fun everyNonBingoCardIsAListAndTheOnlyBingoCardIsHikeBingo() {
        assertEquals(listOf("hike-bingo"), HuntCards.ALL.filter { it.layout == HuntLayout.BINGO }.map { it.id })
    }

    @Test fun noProtectedNamesOrClaimsAppearAnywhereInTheCardText() {
        val everything = HuntCards.ALL.flatMap { c -> listOf(c.title, c.blurb, c.where) + c.items.flatMap { listOf(it.text, it.hint) } } + HuntPhotoPrompts.ALL
        val forbidden = listOf(
            "junior ranger", "smokey", "leave no trace", "national park", "nps", "kid-safe", "kid safe", "safe for kids",
            "coppa", "guaranteed", "emergency", "rescue", "first aid", "edible", "medical", "disney", "pokemon", "lego",
        )
        everything.forEach { s -> forbidden.forEach { assertFalse("\"$it\" in: $s", s.lowercase().contains(it)) } }
    }

    @Test fun thePlaceLineOfEveryCardKeepsChildrenWithAnAdultAndInsideTheRightArea() {
        HuntCards.ALL.forEach { c ->
            assertTrue("${c.id}: ${c.where}", c.where.lowercase().let { "grown-up" in it || "your own campsite" in it || "inside" in it })
        }
        assertTrue(HuntCards.NIGHT_SKY_SOUNDS.where.contains("Do not walk off in the dark"))
        assertTrue(HuntCards.RAINY_DAY.where.contains("Stay inside"))
        assertTrue(HuntCards.HIKE_BINGO.where.contains("marked path"))
    }

    @Test fun photoPromptsAreThingsNotPeople() {
        assertEquals(12, HuntPhotoPrompts.ALL.size)
        HuntPhotoPrompts.ALL.forEach { assertEquals(it, emptyList<String>(), HuntContentRules.promptViolations(it)) }
        assertTrue(HuntContentRules.promptViolations("Photograph your friend's face").isNotEmpty())
        assertTrue(HuntContentRules.promptViolations("Photograph a person").isNotEmpty())
        assertTrue(HuntContentRules.promptViolations("Find something round").isNotEmpty())
        // Every phone sees the same prompt on the same day, and it changes day to day.
        assertEquals(HuntPhotoPrompts.forDay(20_000L), HuntPhotoPrompts.forDay(20_000L))
        assertEquals(12, (0L until 12L).map { HuntPhotoPrompts.forDay(it) }.toSet().size)
        assertTrue(HuntPhotoPrompts.forDay(-5L) in HuntPhotoPrompts.ALL)
    }

    // ---- selection -------------------------------------------------------------------------

    @Test fun aHuntUsesTheChosenBandAndEveryEasierOne() {
        val card = HuntCards.CAMP_BASICS
        val little = HuntSelector.select(card, HuntBand.LITTLE, 40, Random(1)).getOrThrow()
        assertTrue(little.items.all { it.band == HuntBand.LITTLE })
        val middle = HuntSelector.select(card, HuntBand.MIDDLE, 40, Random(1)).getOrThrow()
        assertTrue(middle.items.all { it.band != HuntBand.OLDER })
        assertTrue(middle.items.any { it.band == HuntBand.MIDDLE })
        val older = HuntSelector.select(card, HuntBand.OLDER, 40, Random(1)).getOrThrow()
        assertEquals(card.items.size, older.items.size)
    }

    @Test fun aListHuntKeepsTheRequestedNumberAndWarmsUpWithTheEasyOnes() {
        val pick = HuntSelector.select(HuntCards.NATURE_COLORS, HuntBand.OLDER, 16, Random(7)).getOrThrow()
        assertEquals(16, pick.items.size)
        assertEquals(0, pick.gridSize)
        assertEquals(pick.items.map { it.band.rank }, pick.items.map { it.band.rank }.sorted())
        assertEquals(16, pick.items.map { it.id }.toSet().size)
        // A request below the minimum is raised to it, and above the maximum is capped at what exists.
        assertEquals(HuntSettings.MIN_ITEMS, HuntSelector.select(HuntCards.NATURE_COLORS, HuntBand.OLDER, 1, Random(1)).getOrThrow().items.size)
        assertEquals(HuntCards.NATURE_COLORS.items.size, HuntSelector.select(HuntCards.NATURE_COLORS, HuntBand.OLDER, 40, Random(1)).getOrThrow().items.size)
    }

    @Test fun theBingoGridGrowsWithTheAgeBand() {
        val bingo = HuntCards.HIKE_BINGO
        assertEquals(3, HuntSelector.select(bingo, HuntBand.LITTLE, 16, Random(1)).getOrThrow().gridSize)
        assertEquals(9, HuntSelector.select(bingo, HuntBand.LITTLE, 16, Random(1)).getOrThrow().items.size)
        assertEquals(4, HuntSelector.select(bingo, HuntBand.MIDDLE, 16, Random(1)).getOrThrow().gridSize)
        assertEquals(16, HuntSelector.select(bingo, HuntBand.MIDDLE, 16, Random(1)).getOrThrow().items.size)
        assertEquals(5, HuntSelector.select(bingo, HuntBand.OLDER, 16, Random(1)).getOrThrow().gridSize)
        assertEquals(25, HuntSelector.select(bingo, HuntBand.OLDER, 16, Random(1)).getOrThrow().items.size)
        assertEquals(9, HuntSelector.available(bingo, HuntBand.LITTLE))
        assertEquals(25, HuntSelector.available(bingo, HuntBand.OLDER))
    }

    @Test fun aPoolThatIsTooSmallIsRefusedWithAMessage() {
        val tiny = HuntCard("t", "Tiny", "x", "b", HuntLayout.LIST, "w", HuntCards.CAMP_BASICS.items.take(5))
        val result = HuntSelector.select(tiny, HuntBand.OLDER, 10, Random(1))
        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull()!!.message!!.contains("Not enough"))
        val tinyBingo = tiny.copy(layout = HuntLayout.BINGO)
        assertTrue(HuntSelector.select(tinyBingo, HuntBand.OLDER, 10, Random(1)).isFailure)
        assertEquals(0, HuntSelector.available(tinyBingo, HuntBand.OLDER))
    }

    @Test fun settingsAreClampedToAllowedValues() {
        val s = HuntSettings(itemCount = 999, teams = 9, timerMinutes = 7, photos = false, photoOfDay = true).normalised()
        assertEquals(HuntSettings.MAX_ITEMS, s.itemCount)
        assertEquals(HuntSettings.MAX_TEAMS, s.teams)
        assertEquals(0, s.timerMinutes)
        assertFalse("photo of the day needs photos on", s.photoOfDay)
        assertTrue(HuntSettings(photos = true, photoOfDay = true).normalised().photoOfDay)
        assertEquals(0, HuntSettings(teams = -3).normalised().teams)
        assertFalse("everything optional starts off", HuntSettings().let { it.approval || it.photos || it.photoOfDay || it.timerMinutes > 0 })
    }
}
