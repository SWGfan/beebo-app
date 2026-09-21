package com.beeboentertainment.movie.campsite.hunt

/**
 * The five built-in card sets. Every item is original wording written for Beebo; nothing is copied
 * from another hunt, list or game. Items only ask a child to LOOK or LISTEN: never to touch, pick,
 * catch, collect, taste or take anything, never to go near water, roads, fire or wildlife, and never
 * to point at, or photograph, other people. [HuntContentRules] holds every item to that in a unit
 * test and again when the catalog loads, so a bad edit cannot reach a child.
 *
 * Bands: 4-6 are concrete and easy (a colour, a shape, something soft); 7-10 add patterns, counting
 * and sounds; 11 and up add noticing and small puzzles. A hunt for a band uses that band's items and
 * every easier band's items.
 */
internal object HuntCards {

    private fun l(id: String, text: String, hint: String = "") = HuntItem(id, text, HuntBand.LITTLE, hint)
    private fun m(id: String, text: String, hint: String = "") = HuntItem(id, text, HuntBand.MIDDLE, hint)
    private fun o(id: String, text: String, hint: String = "") = HuntItem(id, text, HuntBand.OLDER, hint)

    val CAMP_BASICS = HuntCard(
        id = "camp-basics",
        title = "Camp Basics",
        emoji = "🏕️",
        blurb = "Everyday things around your own campsite. A good first hunt.",
        layout = HuntLayout.LIST,
        where = "At your own campsite, close to your grown-up.",
        items = listOf(
            l("cb-red", "Find something red"),
            l("cb-blue", "Find something blue"),
            l("cb-round", "Find something round"),
            l("cb-soft", "Find something soft"),
            l("cb-sit", "Find something you can sit on"),
            l("cb-sleep", "Find something that helps you sleep"),
            l("cb-light", "Look for something that gives light at night"),
            l("cb-cup", "Find a cup or a bowl"),
            l("cb-zip", "Find something with a zipper"),
            l("cb-hat", "Find a hat"),
            l("cb-wheels", "Find something with wheels"),
            l("cb-big", "Find something bigger than you"),
            l("cb-shoes", "Find a pair of shoes"),
            m("cb-pattern", "Find something with stripes or checks"),
            m("cb-three", "Find three things that are the same color"),
            m("cb-fold", "Find something that folds up small"),
            m("cb-number", "Find something with a number on it"),
            m("cb-metal", "Find something made of metal"),
            m("cb-cloth", "Find something made of cloth"),
            m("cb-hang", "Find something that hangs up"),
            m("cb-open", "Find something that opens and closes"),
            m("cb-morning", "Find something your family uses every morning"),
            o("cb-twojobs", "Find something that does two jobs"),
            o("cb-pocket", "Find something with a hidden pocket"),
            o("cb-triangle", "Find a triangle shape at your campsite"),
            o("cb-older", "Find something that is older than you are"),
            o("cb-letterz", "Find the letter Z on something"),
            o("cb-buckle", "Find something with a clip or a buckle"),
        ),
    )

    val NATURE_COLORS = HuntCard(
        id = "nature-colors",
        title = "Nature Colors",
        emoji = "🌈",
        blurb = "Find colors outdoors. Look with your eyes only.",
        layout = HuntLayout.LIST,
        where = "Around your campsite or on a marked path, with your grown-up.",
        items = listOf(
            l("nc-green", "Spot something green", "Look with your eyes only"),
            l("nc-brown", "Spot something brown"),
            l("nc-yellow", "Spot something yellow"),
            l("nc-gray", "Spot something gray"),
            l("nc-white", "Spot something white"),
            l("nc-blue", "Spot something blue"),
            l("nc-red", "Spot something red"),
            l("nc-orange", "Spot something orange"),
            l("nc-purple", "Spot something purple"),
            l("nc-shiny", "Spot something shiny"),
            l("nc-bigleaf", "Spot a very big leaf", "Look with your eyes only"),
            l("nc-dark", "Spot something dark"),
            m("nc-shades", "Spot three different shades of green"),
            m("nc-two", "Spot something that is two colors"),
            m("nc-contrast", "Spot something dark next to something light"),
            m("nc-surprise", "Spot a color you did not expect to see outdoors"),
            m("nc-striped", "Spot something with stripes"),
            m("nc-spotted", "Spot something with spots"),
            m("nc-pink", "Spot something pink"),
            m("nc-shade", "Spot a color that looks different in the shade"),
            o("nc-match", "Spot a color like something you are wearing"),
            o("nc-underneath", "Spot something with a different color underneath"),
            o("nc-five", "Spot five different colors without moving your feet"),
            o("nc-name", "Spot a color that is hard to name, then invent a name for it"),
            o("nc-sky", "Spot something the same color as the sky"),
            o("nc-lightdark", "Spot the lightest thing and the darkest thing you can see"),
        ),
    )

    val NIGHT_SKY_SOUNDS = HuntCard(
        id = "night-sky-sounds",
        title = "Night Sky & Sounds",
        emoji = "🌙",
        blurb = "Quiet looking and listening in the evening. Whisper when you find something.",
        layout = HuntLayout.LIST,
        where = "Right at your own campsite, sitting beside your grown-up. Do not walk off in the dark.",
        items = listOf(
            l("ns-moon", "Look for the moon", "If it is out tonight"),
            l("ns-star", "Look for a star"),
            l("ns-bright", "Look for the brightest star you can see"),
            l("ns-wind", "Listen for the wind"),
            l("ns-bird", "Listen for a bird"),
            l("ns-insect", "Listen for an insect sound"),
            l("ns-far", "Listen for a sound that is far away"),
            l("ns-high", "Listen for a high sound"),
            l("ns-low", "Listen for a low sound"),
            l("ns-cloud", "Look for a cloud"),
            l("ns-blink", "Look for a light in the sky that blinks"),
            l("ns-glow", "Find something that glows in the dark"),
            m("ns-shape", "Look for a group of stars that makes a shape"),
            m("ns-twinkle", "Look for a star that twinkles"),
            m("ns-steady", "Look for a bright dot that does not twinkle"),
            m("ns-three", "Listen for three different sounds in one minute"),
            m("ns-repeat", "Listen for a sound that repeats"),
            m("ns-moving", "Listen for something that is moving"),
            m("ns-quietest", "Listen for the quietest sound you can hear"),
            m("ns-slow", "Look for a light moving slowly across the sky"),
            o("ns-two", "Listen for two sounds at once and name both"),
            o("ns-treetops", "Notice the shape the tree tops make against the sky"),
            o("ns-darkest", "Find the darkest part of the sky"),
            o("ns-distance", "Listen for a sound and guess how far away it is"),
            o("ns-notstar", "Look for something in the sky that is not a star"),
            o("ns-minute", "Notice how many different sounds you hear in one quiet minute"),
            o("ns-lookaway", "Look for a star, look away, then find it again"),
        ),
    )

    val RAINY_DAY = HuntCard(
        id = "rainy-day",
        title = "Rainy Day",
        emoji = "🌧️",
        blurb = "A hunt for inside the tent, the camper or the parked car. Stay dry and stay put.",
        layout = HuntLayout.LIST,
        where = "Indoors: in the tent, the camper or a parked car, with your grown-up. Stay inside for this one.",
        items = listOf(
            l("rd-dry", "Find something dry"),
            l("rd-lean", "Find something soft to lean on"),
            l("rd-blanket", "Find a blanket or a towel"),
            l("rd-round", "Find something round"),
            l("rd-book", "Find your favorite toy or book"),
            l("rd-button", "Find something with a button"),
            l("rd-socks", "Find a pair of socks"),
            l("rd-picture", "Find something with a picture on it"),
            l("rd-read", "Find something you can read"),
            l("rd-rain", "Listen for raindrops on the roof"),
            l("rd-green", "Find something green"),
            l("rd-cozy", "Find the coziest spot"),
            m("rd-redblue", "Find something red and something blue"),
            m("rd-smile", "Find something that makes you smile"),
            m("rd-letterb", "Find something that starts with the letter B"),
            m("rd-container", "Find something that can hold small things"),
            m("rd-rectangle", "Find something shaped like a rectangle"),
            m("rd-heavylight", "Find something heavy and something light"),
            m("rd-rainsounds", "Listen for three different rain sounds"),
            m("rd-paper", "Find something made of paper"),
            m("rd-pillow", "Find something that could work as a pillow"),
            o("rd-name", "Find something that starts with each letter of your name"),
            o("rd-story", "Find something with a story, then ask a grown-up to tell it"),
            o("rd-drum", "Find something that could be a drum"),
            o("rd-smallest", "Find something with a label and read the smallest word on it"),
            o("rd-date", "Find something with a date on it"),
            o("rd-tower", "Find something you could build a tiny tower from"),
            o("rd-numbers", "Find something with numbers on it that change"),
        ),
    )

    /** Bingo card: short squares (at most [SQUARE_MAX] characters) so they fit a phone grid. */
    val HIKE_BINGO = HuntCard(
        id = "hike-bingo",
        title = "Hike Bingo",
        emoji = "🥾",
        blurb = "A bingo card for a walk. Tick a square as you spot it; a full row, column or diagonal is a bonus.",
        layout = HuntLayout.BINGO,
        where = "On a marked path with your grown-up, walking together. Nobody runs ahead.",
        items = listOf(
            l("hb-tree", "Spot a tall tree"),
            l("hb-rock", "Spot a big rock"),
            l("hb-birdsong", "Hear a bird sing"),
            l("hb-cloud", "Spot a cloud"),
            l("hb-green", "Spot something green"),
            l("hb-butterfly", "Spot a butterfly"),
            l("hb-leaf", "Spot a fallen leaf"),
            l("hb-puddle", "Spot a puddle"),
            l("hb-sign", "Spot a trail sign"),
            l("hb-bench", "Spot a bench"),
            l("hb-squirrel", "Spot a squirrel", "From far away"),
            l("hb-shadow", "Spot your own shadow"),
            m("hb-twobirds", "Hear two different birds"),
            m("hb-branches", "Spot a tree with many branches"),
            m("hb-round", "Spot something round"),
            m("hb-stripe", "Spot a rock with a stripe"),
            m("hb-web", "Spot a spider web", "Look with your eyes only"),
            m("hb-moss", "Spot some moss"),
            m("hb-broken", "Spot a broken branch"),
            m("hb-pattern", "Spot a leaf with a pattern"),
            m("hb-old", "Spot a very old-looking tree"),
            m("hb-wind", "Hear the wind in the trees"),
            o("hb-layers", "Spot a rock with layers"),
            o("hb-shades", "Spot three shades of green"),
            o("hb-symmetry", "Spot something symmetrical"),
            o("hb-older", "Spot a tree older than you"),
            o("hb-hill", "Spot a hill far away"),
            o("hb-highest", "Spot the highest thing you see"),
            o("hb-line", "Spot a straight line in nature"),
            o("hb-twice", "Spot the same shape twice"),
            o("hb-circle", "Spot a natural circle"),
            o("hb-shape", "Spot a cloud with a shape"),
        ),
    )

    const val SQUARE_MAX = 32

    val ALL: List<HuntCard> = listOf(CAMP_BASICS, NATURE_COLORS, NIGHT_SKY_SOUNDS, RAINY_DAY, HIKE_BINGO)

    fun byId(id: String?): HuntCard? = ALL.firstOrNull { it.id == id }
}

/**
 * The shared, people-free "photo of the day" prompts. The host can turn the option on; a prompt is
 * picked by the calendar day so every phone in the group sees the same one. A photo taken for it
 * stays on the guest's phone: the page never reads, resizes or sends it.
 */
internal object HuntPhotoPrompts {
    val ALL = listOf(
        "Photograph the biggest thing you can find.",
        "Photograph something with a pattern.",
        "Photograph your favorite color at camp.",
        "Photograph the coziest spot you can see.",
        "Photograph an interesting shadow.",
        "Photograph something tiny, from where you are standing.",
        "Photograph the sky, right now.",
        "Photograph something older than you.",
        "Photograph your own shoes somewhere fun.",
        "Photograph something that makes a straight line.",
        "Photograph the view you like best.",
        "Photograph something round.",
    )

    fun forDay(epochDay: Long): String = ALL[Math.floorMod(epochDay, ALL.size.toLong()).toInt()]
}

/**
 * The content rules. A test holds every built-in item and prompt to them, and [HuntCatalog] applies
 * them again at load time. They are deliberately stricter than a quiz: a child is going to walk
 * around and act on these words.
 */
internal object HuntContentRules {
    const val MAX_TEXT = 70
    const val MAX_HINT = 40

    /** Every item starts with one of these (lower case): looking and listening only. */
    val LEAD_WORDS = listOf("find", "spot", "look for", "listen for", "hear", "notice")
    val PROMPT_LEAD = "photograph"

    /** Verbs that ask a child to touch, take, harm, taste or wander. */
    private val TOUCH_OR_TAKE = listOf(
        "touch", "touching", "pick", "picking", "pluck", "catch", "catching", "chase", "collect", "collecting",
        "grab", "squeeze", "shake", "peel", "break", "cut", "dig", "climb", "jump", "swim", "wade", "feed",
        "pet", "hug", "eat", "taste", "lick", "drink", "smell", "sniff", "take", "bring", "steal", "kick",
        "throw", "hide", "sneak", "follow", "wander", "explore", "run",
    )

    /** Fire, water, roads, tools, weather, the sun: never part of a child's hunt. */
    private val HAZARDS = listOf(
        "fire", "campfire", "flame", "flames", "smoke", "stove", "knife", "axe", "hatchet", "saw", "lighter",
        "matches", "lake", "river", "creek", "pond", "stream", "waterfall", "cliff", "edge", "ledge", "ice",
        "road", "street", "traffic", "sun", "sunrise", "sunset", "eclipse", "storm", "lightning", "thunder",
    )

    /** Wild food and medical or survival advice, predators and animal homes. */
    private val WILD_AND_ADVICE = listOf(
        "mushroom", "mushrooms", "berry", "berries", "edible", "inedible", "poison", "poisonous", "toxic",
        "forage", "foraging", "nest", "nests", "egg", "eggs", "bear", "bears", "snake", "snakes", "wolf",
        "wolves", "coyote", "cougar", "moose", "elk", "bison", "alligator", "cure", "medicine", "medical",
        "dangerous", "unsafe", "emergency", "rescue", "sos", "survival", "first", "aid",
    )

    /** Other people are not part of the hunt: nobody is pointed at or photographed. */
    private val PEOPLE = listOf(
        "someone", "somebody", "person", "people", "stranger", "strangers", "kid", "kids", "child", "children",
        "neighbor", "neighbors", "neighbour", "neighbours", "camper", "campers",
    )

    private val UNSUITABLE = listOf(
        "kill", "kills", "killed", "dead", "death", "die", "dies", "died", "blood", "gun", "guns", "weapon",
        "bomb", "war", "drug", "drugs", "alcohol", "beer", "wine", "sex", "naked", "hate", "stupid", "dumb", "idiot",
    )

    /** Phrases (lower case) that are protected names or advice, whatever words are around them. */
    private val PHRASES = listOf(
        "leave no trace", "junior ranger", "smokey bear", "national park service", "safe to eat", "safe to touch",
        "off the trail", "off trail", "off the path", "another campsite", "next campsite", "next door",
        "disney", "pokemon", "lego", "google", "nintendo", "minecraft", "roblox", "youtube", "tiktok", "instagram",
        "facebook", "wikipedia", "pinterest", "coca cola", "mcdonald",
    )

    private val words = Regex("[A-Za-z0-9']+")

    /** Everything wrong with [text]. Empty means fine. [lead] is the required first word or words. */
    fun violations(text: String, maxLength: Int = MAX_TEXT, leadWords: List<String>? = LEAD_WORDS): List<String> {
        val out = ArrayList<String>()
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return listOf("blank text")
        if (trimmed.length > maxLength) out += "longer than $maxLength characters"
        if (trimmed.any { it.code !in 32..126 }) out += "non-ASCII or control character"
        if (trimmed.any { it in "<>&{}[]\"`\\" }) out += "markup or quote characters"
        val lowered = trimmed.lowercase()
        if (leadWords != null && leadWords.none { lowered == it || lowered.startsWith("$it ") }) out += "does not start with a looking or listening word"
        val tokens = words.findAll(lowered).map { it.value }.toSet()
        (TOUCH_OR_TAKE + HAZARDS + WILD_AND_ADVICE + PEOPLE + UNSUITABLE).filter { it in tokens }.forEach { out += "banned word '$it'" }
        val spaced = " " + lowered.replace(Regex("[^a-z0-9]+"), " ") + " "
        PHRASES.filter { spaced.contains(" $it ") }.forEach { out += "banned phrase '$it'" }
        return out
    }

    fun violations(item: HuntItem, layout: HuntLayout): List<String> {
        val out = ArrayList<String>()
        out += violations(item.text, if (layout == HuntLayout.BINGO) HuntCards.SQUARE_MAX else MAX_TEXT)
        if (item.hint.isNotEmpty()) out += violations(item.hint, MAX_HINT, null).map { "hint: $it" }
        if (!Regex("[a-z0-9-]{3,24}").matches(item.id)) out += "bad id"
        return out
    }

    fun promptViolations(prompt: String): List<String> {
        val out = ArrayList<String>(violations(prompt, MAX_TEXT + 10, listOf(PROMPT_LEAD)))
        val lowered = prompt.lowercase()
        if (lowered.contains("face") || lowered.contains("selfie")) out += "a photo prompt must not ask for faces"
        return out
    }
}

/** The catalog the host chooses from, checked once. A card that breaks a rule is dropped, never shown. */
internal object HuntCatalog {
    /** Problems found, for a test to print. Empty in a good build. */
    val problems: List<String> by lazy {
        HuntCards.ALL.flatMap { card ->
            card.items.flatMap { item -> HuntContentRules.violations(item, card.layout).map { "${card.id}/${item.id}: $it" } } +
                (if (card.items.map { it.id }.toSet().size != card.items.size) listOf("${card.id}: duplicate item id") else emptyList())
        }
    }

    /** Only cards with no problem at all. */
    val cards: List<HuntCard> by lazy {
        val bad = problems.map { it.substringBefore('/') }.toSet()
        HuntCards.ALL.filter { it.id !in bad }
    }

    fun byId(id: String?): HuntCard? = cards.firstOrNull { it.id == id }
}
