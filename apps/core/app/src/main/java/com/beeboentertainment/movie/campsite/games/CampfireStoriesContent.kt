package com.beeboentertainment.movie.campsite.games

import kotlin.random.Random

/** The three story tones. Spooky means shivers and surprises, never gore. */
internal enum class StoryMood(val wire: String, val label: String) {
    COZY("cozy", "Cozy"),
    FUNNY("funny", "Funny"),
    SPOOKY("spooky", "A little spooky"),
}

/**
 * Campfire story starters and spinner pieces, all written for Beebo. Family-friendly,
 * for a general audience of all ages. Fully offline: nothing here is generated or
 * fetched at runtime.
 */
internal object CampfireStoriesContent {

    val STARTERS: Map<StoryMood, List<String>> = mapOf(
        StoryMood.COZY to listOf(
            "The first snow of the year fell on the night the old lighthouse keeper finally had a visitor.",
            "Every morning, a fox left one perfect pine cone on the doorstep of the cabin by the lake.",
            "The bakery at the end of the lane only opened when it rained.",
            "Grandpa's tent had a patch on it for every trip, and tonight we found a patch nobody remembered sewing.",
            "The river carried a small wooden boat right up to our campfire, and it had a name painted on the side.",
            "In the town of Little Hollow, the stars came out an hour early on birthdays.",
            "The postcard arrived forty years late, and it was addressed to the tree in our garden.",
            "There was a bench on the hilltop where strangers left notes for each other.",
            "The night train stopped at a station that wasn't on any map, and a woman with a lantern stepped aboard.",
            "My neighbour kept bees, and one summer the bees started building a honeycomb shaped like a map.",
            "The owl who lived above the library could read, but only by moonlight.",
            "Every year on the longest night, the whole village carried candles up the mountain.",
            "A kettle whistled in the empty cottage, though no one had lived there for years - and the tea was still warm.",
            "The mapmaker's apprentice drew a path that wasn't there yet, and by morning it was.",
            "Two old friends met at the same campsite every summer, and this year one of them brought a secret.",
            "The quilt on the spare bed had a square stitched for every person who had ever slept under it.",
            "A small robot at the harbour spent its days waving at boats, hoping one would wave back.",
            "The lake froze so clear that you could see a lost ring glinting at the bottom.",
            "When the power went out, our street discovered it had a storyteller living at number twelve.",
            "The hot chocolate stand only appeared on the coldest night of the year.",
            "At the top of the tallest tree lived a squirrel who collected lost buttons.",
            "The cabin's guestbook had one blank page, and a note said, 'Save this for the right story.'",
            "Every lamp on Willow Street had a name, and tonight one of them went missing.",
            "A letter blew in through the tent flap, written in handwriting that looked exactly like mine.",
            "The garden gnome had been facing the same way for twenty years, until this morning.",
            "On the island, the ferry captain never charged a fare - you paid with a song.",
            "The wind chimes on the porch played a different tune whenever someone was about to come home.",
            "My aunt could find anything that was lost, except the one thing she'd been looking for all her life.",
            "The meadow was full of fireflies, but one of them was blinking in a pattern.",
            "The little bookshop had a cat who always sat on the book you needed most.",
            "Snow had buried the road, so the whole mountain village gathered in the one warm hall.",
            "Every stone in the riverbed had a wish painted underneath it.",
            "The tree house was built by three friends, and each one had carved a promise into its door.",
            "Once a year, the old carousel in the park turned on all by itself.",
            "The sailor retired inland, but every night she could still hear the sea.",
            "Our campfire crackled, and in the sparks we saw the outline of a house none of us had seen before.",
            "The bridge over the stream was so old that it remembered everyone who crossed it.",
            "A kite got caught in the clouds, and when it came down it was carrying a message.",
            "The baker's daughter made bread that tasted like whatever you missed most.",
            "In the valley, the fog rolled in each evening like a big, soft blanket.",
            "An old compass in the attic didn't point north - it pointed to wherever you felt at home.",
            "The last leaf on the maple tree refused to fall until someone said goodbye to it properly.",
            "The shepherd counted her sheep every night, and tonight there was one more than yesterday.",
            "A travelling musician arrived at the campsite with a fiddle that only played lullabies.",
            "Rain drummed on the tent, and each drop seemed to be tapping out a word.",
            "The stars above the farm spelled out a name once every hundred years.",
            "The old boat in the reeds had been waiting a very long time for someone to row it.",
            "A family of hedgehogs moved into the woodpile and started leaving thank-you notes.",
            "The radio in the kitchen picked up a station that played only happy news.",
            "On the night of the harvest moon, the orchard trees whispered to each other.",
        ),
        StoryMood.FUNNY to listOf(
            "The camp cook swore the soup was 'mostly vegetables', but something in the pot waved at us.",
            "My uncle claimed he could talk to ducks, and then a duck talked back.",
            "The weather forecast said 'cloudy with a chance of pancakes', and nobody believed it.",
            "Our tent was delivered with instructions written entirely in drawings of confused penguins.",
            "The town's most famous detective was a very serious goat.",
            "A marshmallow rolled out of the bag, looked around, and made a run for it.",
            "Grandma entered the pie contest with a pie that could sing.",
            "The talking GPS in our car got tired of giving directions and started telling jokes instead.",
            "The new neighbours seemed normal, except for the giraffe peering over their fence.",
            "A seagull stole my sandwich and came back an hour later with a receipt.",
            "The king declared that every Tuesday would now be backwards day.",
            "My socks went missing one at a time, and then they started sending postcards.",
            "The campsite had a strict rule: no bears after 10 p.m. Nobody told the bears.",
            "The robot vacuum decided it wanted to be a racing car.",
            "Our dog was elected mayor by accident.",
            "The magician's rabbit refused to come out of the hat until someone said please.",
            "A cloud followed our car all the way to the beach and rained only on Dad.",
            "The library book was so overdue that it came back by itself to complain.",
            "Every time the scarecrow sneezed, the crows applauded.",
            "The pirate captain was terrified of one thing: seagulls.",
            "The family barbecue was going perfectly until the sausages formed a band.",
            "An alien landed in the park and asked for directions to the nearest ice cream van.",
            "The world's slowest snail entered the world's fastest race.",
            "My alarm clock hid under the bed and refused to ring.",
            "The haunted house was haunted by a ghost who just wanted help with a crossword.",
            "A squirrel moved into the car's glovebox and started charging rent.",
            "The inventor built a machine to tie shoelaces, and it tied everything else instead.",
            "The cows on the farm went on strike until they got better music.",
            "The fishing trip was a success: we caught a boot, a teapot and a very grumpy crab.",
            "Our campfire song was so bad that the owls asked us to stop.",
            "The dragon was supposed to guard the treasure, but it kept losing the key.",
            "Dad's map was upside down, so we ended up at a llama farm.",
            "The office printer printed a note that said, 'I quit.'",
            "The penguin tried to book a holiday somewhere warm.",
            "The garden snails organised a parade and it took three weeks.",
            "Everyone in the village sneezed at exactly the same moment, and the church bells fell over.",
            "A moose wandered into the camping shop and asked to try on hats.",
            "The ghost in the attic was afraid of the dark.",
            "Our tent zip got stuck, and we had to be rescued by a very polite raccoon.",
            "The wizard's spell went wrong and turned all the forks into spoons.",
            "The frog prince didn't want to be kissed - he wanted a better lily pad.",
            "The substitute teacher turned out to be a very tall bird in a coat.",
            "A hat blew off in the wind and went on a trip around the world.",
            "The toaster only made toast in the shapes of famous buildings.",
            "The chicken crossed the road, then came back to explain why.",
            "Our canoe had a leak, so the fish came aboard to help bail.",
            "The bear at the campsite had very strong opinions about s'mores.",
            "The pizza delivery arrived by hot-air balloon.",
            "The knight's armour squeaked so loudly that the dragon laughed too hard to fight.",
            "When Mum said the car was 'making a funny noise', she meant it was telling knock-knock jokes.",
        ),
        StoryMood.SPOOKY to listOf(
            "The trail marker pointed one way in the afternoon, and the other way after dark.",
            "Someone had written our names in the frost on the car window, from the inside.",
            "The old camp radio crackled to life and said, 'Is anyone still out there?'",
            "Every night at midnight, the lake went perfectly still, and a single light rose from the water.",
            "The cabin had eleven rooms, but from outside you could count twelve windows.",
            "The scarecrow in the field was a different shape each morning.",
            "We heard footsteps circling the tent, but in the morning there were no prints in the mud.",
            "The music box in the attic played a tune nobody in the family had ever heard.",
            "The lighthouse beam swept across the sea and lit up a ship that had sunk a hundred years ago.",
            "A black cat followed us all the way along the trail, and it was always one step ahead.",
            "The echo in the canyon answered a question nobody had asked.",
            "Our torch batteries died at exactly the same moment, and then the forest went silent.",
            "The portrait in the hallway had its eyes closed when we arrived.",
            "An old bell rang in the woods, though there was no church for miles.",
            "The fog rolled in, and with it came the smell of a campfire that wasn't ours.",
            "The map showed a village in the valley, but when we got there it was only a ring of stones.",
            "Every photo we took at the campsite had the same figure standing far in the background.",
            "The swing in the empty playground was swinging, even though there was no wind.",
            "At the end of the pier, a lantern flickered, as if someone was waiting for a boat.",
            "The mirror in the cabin showed the room a little tidier than it really was.",
            "Late at night, the owls stopped hooting all at once.",
            "The stranger at the gas station knew exactly where we were going, though we'd told no one.",
            "A trail of pebbles led into the forest, and each night it grew a little longer.",
            "The old tree had a door in its trunk, and tonight the door was open.",
            "Our dog stood at the edge of the firelight and growled at something we couldn't see.",
            "The snowman in the yard kept turning to face the house.",
            "The ferryman took our coins, but his boat left no ripples on the water.",
            "An old diary in the cabin had an entry dated tomorrow.",
            "The wind carried a whisper that sounded exactly like someone calling my name.",
            "The castle tour ended, but the guide who showed us around didn't work there.",
            "In the morning, all our boots had been lined up neatly outside the tent.",
            "The phone rang in the abandoned phone box as we walked past.",
            "The moon was full, but its reflection in the lake was only a crescent.",
            "Every clock in the old house stopped at 3:17.",
            "The shadows around the campfire seemed to be leaning in to listen.",
            "A little light blinked in the attic of the house across the field, though the house was empty.",
            "The crows gathered on the fence and watched us all afternoon without making a sound.",
            "Something tapped three times on the car roof as we drove through the tunnel.",
            "The last page of the library book was missing, and someone had been reading it aloud upstairs.",
            "The wooden rocking chair on the porch rocked gently every evening at sunset.",
            "There was a knock on the cabin door, but when we opened it, the knocking came from behind us.",
            "The path through the woods was shorter going there than it was coming back.",
            "A lantern appeared on the far side of the lake and moved toward us across the water.",
            "The children's rhyme scratched into the old desk had a verse nobody had ever sung.",
            "We counted five people around the campfire, but only four of us had come.",
            "The dollhouse in the museum had tiny lights on, in the room that matched ours.",
            "When the thunder rolled, the old lighthouse answered with three long flashes.",
            "The mist spelled out letters as it drifted between the trees.",
            "The gate to the old garden had been locked for fifty years, but the roses inside were freshly cut.",
            "Just as the fire burned low, a voice from the dark said, 'May I sit with you?'",
        ),
    )

    // ---- the story spinner: character + place + problem + twist -----------------------

    val CHARACTERS = listOf(
        "a retired sea captain", "a very curious raccoon", "a young inventor", "a forgetful wizard",
        "a lighthouse keeper", "a talking fox", "a nervous knight", "a travelling baker",
        "a grumpy old bear", "a clever crow", "a mapmaker with no sense of direction", "a robot who loves gardening",
        "a park ranger", "a shy dragon", "a champion storyteller", "a detective who is scared of the dark",
        "a hedgehog with big dreams", "a pair of mischievous twins", "a lonely giant", "an astronaut on holiday",
    )

    val PLACES = listOf(
        "in a cabin deep in the pine forest", "on a tiny island in the middle of a lake", "at the top of a snowy mountain",
        "in a village where it always rains", "beside a river that ran uphill", "in a treehouse above the clouds",
        "at a campsite by the sea", "in an old castle full of echoes", "at the edge of a sleepy desert",
        "in a lighthouse on a rocky cliff", "in a town built inside a canyon", "on a boat drifting down a wide river",
        "in a meadow full of fireflies", "under a bridge in a busy city", "in a cave that glittered like the night sky",
        "on a farm at the end of a long dirt road", "in a library with no ceiling", "at a train station in the middle of nowhere",
        "in a garden where the flowers could talk", "on the far side of the Moon",
    )

    val PROBLEMS = listOf(
        "the stars began to go out one by one", "every clock in town stopped at the same moment",
        "a mysterious map was found tucked inside a boot", "the campfire refused to light, no matter what they tried",
        "all the colours started draining out of the world", "a storm blew in and carried off the only key",
        "the river suddenly went silent", "someone kept leaving riddles on the doorstep",
        "the moon got stuck behind a mountain", "all the birds flew away at once",
        "a strange light appeared in the woods every night", "the bridge home vanished overnight",
        "the biggest pumpkin in the valley started rolling away", "every shadow in town went missing",
        "a lost letter arrived, addressed to someone who hadn't been born yet", "the fog grew so thick that nobody could find their way",
        "the wind stole everyone's hats", "a door appeared in a hillside where no door had been",
        "the old music box began playing by itself", "the town forgot how to laugh",
    )

    val TWISTS = listOf(
        "the answer had been hidden in a song all along", "the stranger who helped them turned out to be their oldest friend",
        "the map was actually a recipe", "a tiny mouse knew exactly what to do",
        "the whole thing had been a surprise party", "the shadows had simply gone on holiday",
        "the storm was just a lonely cloud looking for company", "the riddle's answer was their own name",
        "the lost key had been in their pocket the entire time", "the light in the woods was a lantern left for them to follow",
        "the giant was only trying to return something he'd borrowed", "the stars had been hiding to watch a firefly dance",
        "the problem fixed itself the moment they stopped arguing", "an old photograph showed the way",
        "the moon rolled back into the sky, laughing", "the door led straight back to their own kitchen",
        "the missing sound came back as a chorus of frogs", "everyone in town had been helping in secret",
        "the music box was playing a message in code", "a single kind word changed everything",
    )

    val OPENINGS = listOf("Once upon a time", "Long ago", "Not so very long ago", "One quiet evening", "Once, on a night much like this one")
    val ENDINGS = listOf(
        "And from that night on, they told the story around every campfire.",
        "And that is why, if you listen closely, you can still hear it today.",
        "And they all went home a little wiser, and a lot happier.",
        "And nobody ever looked at the night sky the same way again.",
        "The end - or maybe just the beginning.",
    )

    /** One spun story: the four pieces and the sentences they make. */
    data class Spun(
        val seed: Long,
        val character: String,
        val place: String,
        val problem: String,
        val twist: String,
        val lines: List<String>,
    )

    /**
     * Build a story from template pieces. The same [seed] always gives the same story,
     * so a group can say "spin 1234" and get the one they liked back.
     */
    fun spin(seed: Long): Spun {
        val r = Random(seed)
        val character = CHARACTERS.random(r)
        val place = PLACES.random(r)
        val problem = PROBLEMS.random(r)
        val twist = TWISTS.random(r)
        val opening = OPENINGS.random(r)
        val ending = ENDINGS.random(r)
        val lines = listOf(
            "$opening, there lived ${character} $place.",
            "Everything was peaceful, until one day $problem.",
            "Nobody knew what to do, so ${character.removePrefixArticle()} decided to find out.",
            "After a long and puzzling search, it turned out that $twist.",
            ending,
        )
        return Spun(seed, character, place, problem, twist, lines)
    }

    private fun String.removePrefixArticle(): String = "the " + removePrefix("a pair of ").removePrefix("an ").removePrefix("a ")
}
