package com.beeboentertainment.movie.campsite.platehunt

/**
 * The checklists behind Plate and Sign Hunt.
 *
 * WHAT IS IN HERE: names and postal abbreviations only. Those are facts (the same list
 * appears in every atlas), so there is nothing here anybody owns. What is deliberately NOT here
 * is anything that identifies a real plate: no plate images, no state seals, no slogans and no
 * brand names, because plate designs, seals and slogans carry their own rights. See
 * [PlateHuntStrings] for the strings a test checks against a deny list.
 *
 * "Jurisdictions", not "states": the District of Columbia issues its own plates but is not a
 * state, and Canada has ten provinces and three territories. The page says "jurisdictions".
 */
internal data class PlateItem(val name: String, val abbr: String)

internal enum class PlateRegionId(val wire: String, val label: String) {
    USA("usa", "USA (50 states + DC)"),
    CANADA("canada", "Canada (10 provinces + 3 territories)"),
    BOTH("both", "USA + Canada"),
    ALPHABET("alphabet", "Alphabet signs A to Z"),
    ;

    companion object {
        fun fromWire(text: String): PlateRegionId? = values().firstOrNull { it.wire == text }
    }
}

internal object PlateRegions {

    /** Fifty states and the District of Columbia, by USPS abbreviation. */
    val USA: List<PlateItem> = listOf(
        PlateItem("Alabama", "AL"), PlateItem("Alaska", "AK"), PlateItem("Arizona", "AZ"),
        PlateItem("Arkansas", "AR"), PlateItem("California", "CA"), PlateItem("Colorado", "CO"),
        PlateItem("Connecticut", "CT"), PlateItem("Delaware", "DE"), PlateItem("District of Columbia", "DC"),
        PlateItem("Florida", "FL"), PlateItem("Georgia", "GA"), PlateItem("Hawaii", "HI"),
        PlateItem("Idaho", "ID"), PlateItem("Illinois", "IL"), PlateItem("Indiana", "IN"),
        PlateItem("Iowa", "IA"), PlateItem("Kansas", "KS"), PlateItem("Kentucky", "KY"),
        PlateItem("Louisiana", "LA"), PlateItem("Maine", "ME"), PlateItem("Maryland", "MD"),
        PlateItem("Massachusetts", "MA"), PlateItem("Michigan", "MI"), PlateItem("Minnesota", "MN"),
        PlateItem("Mississippi", "MS"), PlateItem("Missouri", "MO"), PlateItem("Montana", "MT"),
        PlateItem("Nebraska", "NE"), PlateItem("Nevada", "NV"), PlateItem("New Hampshire", "NH"),
        PlateItem("New Jersey", "NJ"), PlateItem("New Mexico", "NM"), PlateItem("New York", "NY"),
        PlateItem("North Carolina", "NC"), PlateItem("North Dakota", "ND"), PlateItem("Ohio", "OH"),
        PlateItem("Oklahoma", "OK"), PlateItem("Oregon", "OR"), PlateItem("Pennsylvania", "PA"),
        PlateItem("Rhode Island", "RI"), PlateItem("South Carolina", "SC"), PlateItem("South Dakota", "SD"),
        PlateItem("Tennessee", "TN"), PlateItem("Texas", "TX"), PlateItem("Utah", "UT"),
        PlateItem("Vermont", "VT"), PlateItem("Virginia", "VA"), PlateItem("Washington", "WA"),
        PlateItem("West Virginia", "WV"), PlateItem("Wisconsin", "WI"), PlateItem("Wyoming", "WY"),
    )

    /** Ten provinces and three territories, by Canada Post abbreviation. */
    val CANADA: List<PlateItem> = listOf(
        PlateItem("Alberta", "AB"), PlateItem("British Columbia", "BC"), PlateItem("Manitoba", "MB"),
        PlateItem("New Brunswick", "NB"), PlateItem("Newfoundland and Labrador", "NL"),
        PlateItem("Nova Scotia", "NS"), PlateItem("Ontario", "ON"), PlateItem("Prince Edward Island", "PE"),
        PlateItem("Quebec", "QC"), PlateItem("Saskatchewan", "SK"),
        PlateItem("Northwest Territories", "NT"), PlateItem("Nunavut", "NU"), PlateItem("Yukon", "YT"),
    )

    /** A to Z, spotted in order on signs. */
    val ALPHABET: List<PlateItem> = ('A'..'Z').map { PlateItem(it.toString(), it.toString()) }

    fun items(region: PlateRegionId): List<PlateItem> = when (region) {
        PlateRegionId.USA -> USA
        PlateRegionId.CANADA -> CANADA
        PlateRegionId.BOTH -> USA + CANADA
        PlateRegionId.ALPHABET -> ALPHABET
    }

    /** The alphabet is found in order; a plate hunt is found in any order. */
    fun ordered(region: PlateRegionId): Boolean = region == PlateRegionId.ALPHABET

    /** What one entry is called in a sentence: "34 of 64 jurisdictions", "12 of 26 letters". */
    fun noun(region: PlateRegionId): String = if (region == PlateRegionId.ALPHABET) "letters" else "jurisdictions"
}
