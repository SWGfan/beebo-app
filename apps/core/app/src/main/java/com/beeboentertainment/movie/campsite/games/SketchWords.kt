package com.beeboentertainment.movie.campsite.games

/**
 * What the drawer in Sketch & Guess is asked to draw. Written for this app: ordinary
 * things, places, activities and sayings, suitable for any age, and no brand names.
 *
 * EASY is one object anybody can draw in ten seconds. MEDIUM needs a scene or a detail.
 * HARD is an idea, an activity or a saying - the fun is in how people get it across.
 * A word appears in exactly one list; the unit tests hold that line.
 */
internal object SketchWords {
    val EASY: List<String> = listOf(
        "cat", "dog", "sun", "tree", "house", "car", "fish", "apple", "star", "moon",
        "ball", "hat", "cup", "book", "bird", "flower", "boat", "cake", "key", "shoe",
        "bed", "chair", "door", "eye", "hand", "egg", "frog", "duck", "pig", "cow",
        "horse", "bee", "snake", "banana", "cloud", "rain", "snowman", "heart", "smile", "clock",
        "phone", "bus", "train", "kite", "drum", "bell", "candle", "pizza", "ice cream", "cookie",
        "carrot", "lemon", "grapes", "cherry", "mouse", "rabbit", "turtle", "whale", "spider", "ladder",
        "tent", "bridge", "mountain", "river", "island", "rainbow", "umbrella", "glasses", "sock", "shirt",
        "crown", "sword", "rocket", "robot", "ghost", "balloon", "present", "pencil", "scissors", "spoon",
        "fork", "hammer", "guitar", "lamp", "window", "leaf", "mushroom", "owl", "lion", "bear",
        "penguin", "octopus", "shark", "butterfly", "ant", "snail", "corn", "bread", "cheese", "watermelon",
    )

    val MEDIUM: List<String> = listOf(
        "campfire", "lighthouse", "castle", "volcano", "waterfall", "treehouse", "windmill", "igloo", "pyramid", "skyscraper",
        "tractor", "helicopter", "submarine", "parachute", "sailboat", "bicycle", "skateboard", "wheelbarrow", "fire truck", "ambulance",
        "dinosaur", "dragon", "unicorn", "mermaid", "pirate", "astronaut", "wizard", "knight", "scarecrow", "superhero",
        "kangaroo", "giraffe", "elephant", "zebra", "crocodile", "flamingo", "peacock", "jellyfish", "seahorse", "hedgehog",
        "hamburger", "sandwich", "pancakes", "popcorn", "birthday cake", "picnic basket", "lunchbox", "teapot", "toaster", "microwave",
        "backpack", "sleeping bag", "compass", "binoculars", "flashlight", "map", "treasure chest", "telescope", "magnet", "hourglass",
        "piano", "violin", "trumpet", "microphone", "headphones", "camera", "television", "computer", "keyboard", "remote control",
        "swing", "slide", "seesaw", "trampoline", "sandcastle", "snow globe", "fishing rod", "paddle", "kayak", "hammock",
        "cactus", "palm tree", "pumpkin", "sunflower", "beehive", "spider web", "bird nest", "acorn", "pinecone", "four-leaf clover",
        "toothbrush", "hairbrush", "bathtub", "mailbox", "doorbell", "fence", "chimney", "staircase", "traffic light", "roller coaster",
    )

    val HARD: List<String> = listOf(
        "homesick", "sleepwalking", "daydream", "brainstorm", "jet lag", "deja vu", "echo", "gravity", "shadow", "reflection",
        "camping trip", "road trip", "sunrise", "sunset", "thunderstorm", "earthquake", "avalanche", "heatwave", "fog", "tide",
        "hide and seek", "tug of war", "musical chairs", "sack race", "treasure hunt", "pillow fight", "snowball fight", "hopscotch", "leapfrog", "charades",
        "surprise party", "family reunion", "job interview", "first day of school", "graduation", "retirement", "wedding cake", "traffic jam", "lost luggage", "flat tire",
        "bedtime story", "time travel", "invisibility", "teleport", "hibernation", "migration", "photosynthesis", "evolution", "recycling", "static electricity",
        "friendship", "teamwork", "patience", "curiosity", "courage", "jealousy", "nostalgia", "boredom", "excitement", "stage fright",
        "piece of cake", "break the ice", "cold feet", "head in the clouds", "couch potato", "night owl", "early bird", "big fish in a small pond", "butterflies in your stomach", "raining cats and dogs",
        "spill the beans", "hit the road", "on thin ice", "under the weather", "cat nap", "lightbulb moment", "second wind", "tip of the iceberg", "sleep on it", "the elephant in the room",
        "constellation", "northern lights", "eclipse", "black hole", "shooting star", "meteor shower", "solar system", "orbit", "comet", "satellite",
        "marathon", "relay race", "high five", "standing ovation", "yawn", "hiccups", "sneeze", "shiver", "goosebumps", "tickle",
    )

    val LEVELS: Map<String, List<String>> = mapOf("easy" to EASY, "medium" to MEDIUM, "hard" to HARD)
}
