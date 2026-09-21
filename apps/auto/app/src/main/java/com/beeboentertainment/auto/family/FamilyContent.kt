package com.beeboentertainment.auto.family

/**
 * The words the voice games use. All of it was written for Beebo: nothing is copied from a
 * game, a book, a quiz site or a word list. Answers are ordinary things (animals, foods, places,
 * weather), never brands, characters or people. Nothing is frightening.
 *
 * A [ClueItem] gives five clues from tricky to easy, so the last clue is nearly a giveaway and
 * even the youngest passenger gets to say the answer.
 */
internal data class ClueItem(
    /** "an animal", "a food": read after "I am thinking of". */
    val category: String,
    /** How it is said in the reveal: "a cat", "the moon". */
    val answer: String,
    /** 1 easy, 2 medium, 3 harder. */
    val level: Int,
    val clues: List<String>,
)

internal data class SoundRiddle(val sound: String, val answer: String, val level: Int)

internal object FamilyContent {

    val CLUE_ITEMS: List<ClueItem> = listOf(
        // ---- level 1
        ClueItem("an animal", "a cat", 1, listOf(
            "It has soft fur and long whiskers.",
            "It likes to sleep in a warm, sunny spot.",
            "It can purr when it is happy.",
            "Some of them love to chase a bouncing ball of yarn.",
            "It says meow.",
        )),
        ClueItem("an animal", "a dog", 1, listOf(
            "It is a pet that lives with many families.",
            "It has four legs and a tail that wags.",
            "It loves to fetch sticks and balls.",
            "It barks when someone knocks on the door.",
            "It says woof.",
        )),
        ClueItem("a food", "a banana", 1, listOf(
            "It is a fruit.",
            "It grows in bunches.",
            "It is bright yellow when it is ready to eat.",
            "You have to peel it first.",
            "Monkeys are famous for loving it.",
        )),
        ClueItem("something you see on the road", "a bicycle", 1, listOf(
            "It has two wheels.",
            "You make it go with your legs.",
            "It has a little bell you can ring.",
            "You wear a helmet when you ride it.",
            "It has pedals and handlebars.",
        )),
        ClueItem("something in the sky", "a rainbow", 1, listOf(
            "You can see it high up in the sky.",
            "It appears when sun and rain happen together.",
            "It has lots of colors.",
            "Red is on one edge and purple is on the other.",
            "It looks like a big, colorful arch.",
        )),
        ClueItem("an animal", "an elephant", 1, listOf(
            "It is the biggest animal that lives on land.",
            "It has thick gray skin.",
            "Its ears are as big as fans.",
            "It sprays water over its back to cool off.",
            "It has a very long trunk.",
        )),
        ClueItem("a food", "a pizza", 1, listOf(
            "It is round and it is often shared.",
            "It is baked in a very hot oven.",
            "It has a crust around the edge.",
            "Melted cheese goes on top.",
            "It is cut into triangle slices.",
        )),
        ClueItem("something at home", "a toothbrush", 1, listOf(
            "You use it in the morning and again at night.",
            "It lives in the bathroom.",
            "It has lots of tiny bristles.",
            "You put a little paste on it.",
            "It keeps your teeth clean.",
        )),
        ClueItem("something you see on the road", "a school bus", 1, listOf(
            "It is very long.",
            "It is usually bright yellow.",
            "Lots of children ride in it together.",
            "It has flashing lights and a stop sign that folds out.",
            "It takes children to school.",
        )),
        ClueItem("something you can build", "a snowman", 1, listOf(
            "You make it outside in winter.",
            "It is made of something cold and white.",
            "It has a round body made of balls stacked up.",
            "It might have a carrot for a nose.",
            "It might wear a hat and a scarf.",
        )),
        ClueItem("an animal", "a giraffe", 1, listOf(
            "It lives in warm, grassy places.",
            "It has spots all over.",
            "It has four very long legs.",
            "It reaches leaves at the tops of tall trees.",
            "It has the longest neck of any animal.",
        )),
        ClueItem("something you carry", "an umbrella", 1, listOf(
            "You carry it on rainy days.",
            "It folds up small.",
            "It opens up like a round little roof.",
            "It has a handle you hold.",
            "It keeps you dry in the rain.",
        )),
        // ---- level 2
        ClueItem("a place", "a lighthouse", 2, listOf(
            "It stands near the sea.",
            "It is tall and narrow.",
            "It has a very bright light at the top.",
            "The light turns slowly around and around.",
            "It helps ships find their way at night.",
        )),
        ClueItem("an animal", "an octopus", 2, listOf(
            "It lives in the ocean.",
            "Its body is soft and has no bones.",
            "It can squeeze through tiny gaps.",
            "It can change color to hide.",
            "It has eight arms.",
        )),
        ClueItem("something you can carry", "a compass", 2, listOf(
            "It fits in a pocket.",
            "Hikers and sailors use it.",
            "It has a little needle that swings.",
            "The needle points to the north.",
            "It helps you know which way you are facing.",
        )),
        ClueItem("a food", "a pancake", 2, listOf(
            "Many people eat it at breakfast.",
            "It is flat and round.",
            "It is cooked in a hot pan.",
            "You flip it over halfway through.",
            "You might pour syrup on top.",
        )),
        ClueItem("a place", "a library", 2, listOf(
            "It is full of quiet corners.",
            "You can visit with a card.",
            "It has shelves and shelves.",
            "You whisper when you are inside.",
            "You can borrow books there.",
        )),
        ClueItem("something for camping", "a tent", 2, listOf(
            "Families take it on trips.",
            "It is like a small house made of cloth.",
            "It is held up with poles and pegs.",
            "You zip the door closed at night.",
            "You sleep inside it when you go camping.",
        )),
        ClueItem("something in nature", "a volcano", 2, listOf(
            "It is a mountain, but a special kind.",
            "Deep inside it is very, very hot.",
            "Its top is shaped like a bowl.",
            "It can send out ash and hot, melted rock.",
            "It can rumble.",
        )),
        ClueItem("something that flies", "a helicopter", 2, listOf(
            "It flies through the sky.",
            "It does not have wings like an airplane.",
            "It has long blades that spin on top.",
            "It can hover in one spot.",
            "It goes whup, whup, whup.",
        )),
        ClueItem("an animal", "a penguin", 2, listOf(
            "It is a bird.",
            "It cannot fly in the air.",
            "It is a very good swimmer.",
            "It lives where it is icy and cold.",
            "It waddles, and it wears black and white feathers.",
        )),
        ClueItem("something in the sky", "the moon", 2, listOf(
            "You can see it in the sky, mostly at night.",
            "It changes shape through the month.",
            "It is a big round rock, not a star.",
            "It goes around the Earth.",
            "Sometimes it is a thin curve and sometimes a big bright circle.",
        )),
        ClueItem("something at home", "a clock", 2, listOf(
            "It has a face and some hands.",
            "It goes tick, tock.",
            "It hangs on a wall or sits on a table.",
            "The little hand shows the hour.",
            "It tells you the time.",
        )),
        // ---- level 3
        ClueItem("something you cross on the road", "a bridge", 3, listOf(
            "You might drive over it.",
            "It is often made of steel or stone.",
            "It stretches over something.",
            "It goes above a river or a valley.",
            "It joins one side to the other.",
        )),
        ClueItem("something in the countryside", "a windmill", 3, listOf(
            "You might see one in a big, open field.",
            "It is tall, with long arms.",
            "The arms spin when the air moves.",
            "Some turn moving air into electricity.",
            "Long ago, people used them to grind grain.",
        )),
        ClueItem("an insect", "a honeybee", 3, listOf(
            "It is small and it has wings.",
            "It has yellow and black stripes.",
            "It visits flowers.",
            "It makes something sweet that people put on toast.",
            "It lives in a hive with thousands of friends.",
        )),
        ClueItem("a toy", "a kaleidoscope", 3, listOf(
            "It is shaped like a tube.",
            "You hold it up to your eye.",
            "Inside are tiny bits of colored glass.",
            "Mirrors make the pattern.",
            "When you turn it, the pattern changes.",
        )),
        ClueItem("a plant", "a cactus", 3, listOf(
            "It grows in dry, sunny places.",
            "It stores water inside itself.",
            "It is green.",
            "It is covered in spikes, so look but do not touch.",
            "It can live in the desert.",
        )),
        ClueItem("a musical instrument", "a trumpet", 3, listOf(
            "It is made of shiny brass.",
            "You blow into it.",
            "It has three buttons called valves.",
            "It plays loud, bright notes.",
            "It is played in marching bands.",
        )),
        ClueItem("something that flies", "a hot air balloon", 3, listOf(
            "It floats high in the sky.",
            "It is very colorful.",
            "A basket hangs underneath.",
            "A flame heats the air inside.",
            "It rises because hot air goes up.",
        )),
    )

    val SOUND_RIDDLES: List<SoundRiddle> = listOf(
        SoundRiddle("Tick, tock. Tick, tock.", "a clock", 1),
        SoundRiddle("Buzz, buzz, buzz.", "a bee", 1),
        SoundRiddle("Meow. Purr, purr.", "a cat", 1),
        SoundRiddle("Quack, quack.", "a duck", 1),
        SoundRiddle("Vroom. Beep, beep.", "a car", 1),
        SoundRiddle("Choo choo. Toot toot.", "a train", 1),
        SoundRiddle("Drip, drip, drip.", "a leaky tap", 1),
        SoundRiddle("Ring, ring. Ring, ring.", "a telephone", 1),
        SoundRiddle("Crunch, crunch, crunch.", "someone eating crunchy carrots", 1),
        SoundRiddle("Splash. Ribbit, ribbit.", "a frog jumping into a pond", 1),
        SoundRiddle("Whoosh, whoosh.", "the wind", 2),
        SoundRiddle("Creak, creeeak.", "a door that needs a little oil", 2),
        SoundRiddle("Pitter, patter, pitter, patter.", "rain on a roof", 2),
        SoundRiddle("Snip, snip, snip.", "scissors", 2),
        SoundRiddle("Sizzle, pop, sizzle.", "popcorn in a pan", 2),
        SoundRiddle("Clip clop, clip clop.", "a horse walking", 2),
        SoundRiddle("Ding, ding. Whirr, whirr.", "a bicycle", 2),
        SoundRiddle("Hoot, hoot.", "an owl", 2),
        SoundRiddle("Chirp, chirp, tweet, tweedle-dee.", "birds singing in the morning", 2),
        SoundRiddle("Rumble, rumble, boom.", "thunder far away", 3),
        SoundRiddle("Slurp, slurp, gurgle.", "the last bit of a drink through a straw", 3),
        SoundRiddle("Swish, swish, thump.", "a basketball going through the net", 3),
        SoundRiddle("Zzzip.", "a zipper", 3),
        SoundRiddle("Flap, flap, flap.", "a flag in the wind", 3),
    )

    /** Read after "Name as many": each ends the sentence naturally. */
    val CATEGORY_PROMPTS: List<String> = listOf(
        "round things", "animals with four legs", "things you find in a kitchen", "yellow things",
        "things with wheels", "things that make a noise", "cold foods", "things you wear",
        "animals that live in the water", "things you can see in the sky", "soft things",
        "things you find in a park", "red things", "things that fly", "things you can read",
        "sweet foods", "green things", "things you find in a garden", "musical instruments",
        "things you find at the beach", "very tall things", "things that come in pairs",
        "things that are hot", "things you can hear from the car",
    )

    val LISTENING_ROUNDS: List<String> = listOf(
        "Listening round. Everyone except the driver can close their eyes. For fifteen seconds, listen " +
            "and count the different sounds you can hear. Ready? Shh.",
        "Quiet listening. Passengers, get comfy and listen very carefully. How many different sounds " +
            "are in the car right now? Count them on your fingers. Start listening.",
        "Sound safari. Everyone but the driver can close their eyes. What is the quietest sound you " +
            "can find? What is the loudest? Listen for fifteen seconds.",
    )

    /** Two easy examples for every letter, all ordinary words a child could see or think of. */
    val LETTER_HINTS: Map<Char, List<String>> = mapOf(
        'A' to listOf("apple, or ant", "airplane, or arrow"),
        'B' to listOf("ball, or bird", "bridge, or bus"),
        'C' to listOf("cat, or cloud", "car, or cow"),
        'D' to listOf("dog, or door", "duck, or drum"),
        'E' to listOf("egg, or elephant", "ear, or engine"),
        'F' to listOf("fish, or flag", "field, or fence"),
        'G' to listOf("grass, or goat", "gate, or garden"),
        'H' to listOf("hat, or hill", "house, or horse"),
        'I' to listOf("ice, or igloo", "insect, or ink"),
        'J' to listOf("jam, or jacket", "jump, or jelly"),
        'K' to listOf("kite, or key", "kitten, or kettle"),
        'L' to listOf("leaf, or lamp", "lake, or ladder"),
        'M' to listOf("moon, or mountain", "mud, or mailbox"),
        'N' to listOf("nest, or nose", "night, or net"),
        'O' to listOf("owl, or orange", "ocean, or oven"),
        'P' to listOf("pig, or park", "pond, or puddle"),
        'Q' to listOf("quilt, or queen", "quiet, or quack"),
        'R' to listOf("road, or rain", "river, or rock"),
        'S' to listOf("sun, or sign", "sheep, or star"),
        'T' to listOf("tree, or truck", "tent, or train"),
        'U' to listOf("umbrella, or unicorn", "under, or up"),
        'V' to listOf("van, or violin", "valley, or vine"),
        'W' to listOf("water, or wheel", "wind, or window"),
        'X' to listOf("x-ray, or xylophone", "the letter X on a sign"),
        'Y' to listOf("yellow, or yak", "yard, or yo-yo"),
        'Z' to listOf("zebra, or zoo", "zipper, or zigzag"),
    )
}
