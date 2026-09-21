package com.beeboentertainment.movie.campsite.games

/**
 * The places a round of Who's the Spy? can be set in, each with the parts people play
 * there. Written for this app; ordinary everyday places, suitable for any age.
 *
 * A role is a hint for the person holding it - something to answer questions "in
 * character" with - never a second secret. Six roles per place means a ten-player round
 * still repeats a few, which is fine: two cooks in one kitchen is a normal kitchen.
 */
internal data class SpyLocation(val name: String, val roles: List<String>)

internal object SpyLocations {
    val ALL: List<SpyLocation> = listOf(
        SpyLocation("Campsite", listOf("Tent pitcher", "Firewood collector", "Camp cook", "Stargazer", "Ranger", "Someone who forgot the tent poles")),
        SpyLocation("Lighthouse", listOf("Lighthouse keeper", "Visiting painter", "Boat captain", "Tour guide", "Seagull watcher", "Lamp mechanic")),
        SpyLocation("Bakery", listOf("Baker", "Cake decorator", "Early customer", "Delivery driver", "Cashier", "Bread taster")),
        SpyLocation("Space station", listOf("Commander", "Engineer", "Scientist", "Space tourist", "Mission doctor", "Robot arm operator")),
        SpyLocation("Public library", listOf("Librarian", "Student", "Story-time reader", "Author on a book tour", "Returns clerk", "Quiet reader")),
        SpyLocation("Beach", listOf("Lifeguard", "Surfer", "Ice cream seller", "Sandcastle builder", "Sunbather", "Shell collector")),
        SpyLocation("Airport", listOf("Pilot", "Flight attendant", "Security officer", "Traveller with a delayed flight", "Baggage handler", "Air traffic controller")),
        SpyLocation("Hospital", listOf("Nurse", "Surgeon", "Patient", "Visitor with flowers", "Receptionist", "Hospital porter")),
        SpyLocation("Movie theater", listOf("Ticket seller", "Popcorn maker", "Projectionist", "Film fan", "Usher", "Critic")),
        SpyLocation("Farm", listOf("Farmer", "Tractor driver", "Egg collector", "Sheepdog trainer", "Vet", "Visitor picking strawberries")),
        SpyLocation("Zoo", listOf("Zookeeper", "Tour guide", "Penguin feeder", "Photographer", "Gift shop worker", "Animal vet")),
        SpyLocation("Submarine", listOf("Captain", "Sonar operator", "Cook", "Navigator", "Engineer", "Diver")),
        SpyLocation("Ski resort", listOf("Ski instructor", "Snowboarder", "Lift operator", "Hot chocolate seller", "Ski patrol", "Beginner on the bunny slope")),
        SpyLocation("Pirate ship", listOf("Captain", "First mate", "Lookout in the crow's nest", "Cook", "Cabin crew", "Parrot keeper")),
        SpyLocation("Museum", listOf("Curator", "Security guard", "Tour guide", "Art student", "Restorer", "School group leader")),
        SpyLocation("Supermarket", listOf("Cashier", "Shelf stacker", "Shopper with a long list", "Butcher", "Store manager", "Trolley collector")),
        SpyLocation("Train station", listOf("Train driver", "Conductor", "Commuter", "Ticket inspector", "Coffee cart owner", "Lost-property clerk")),
        SpyLocation("Circus", listOf("Ringmaster", "Juggler", "Acrobat", "Clown", "Tightrope walker", "Popcorn seller")),
        SpyLocation("School classroom", listOf("Teacher", "Student", "Substitute teacher", "Class helper", "Visiting speaker", "Caretaker")),
        SpyLocation("Restaurant kitchen", listOf("Head chef", "Dishwasher", "Waiter", "Pastry chef", "Food critic", "Delivery driver")),
        SpyLocation("Police station", listOf("Detective", "Desk sergeant", "Officer on patrol", "Witness", "Lawyer", "Dog handler")),
        SpyLocation("Fire station", listOf("Firefighter", "Fire chief", "Engine driver", "Dispatcher", "Station dog walker", "Visiting school group")),
        SpyLocation("Rainforest expedition", listOf("Guide", "Botanist", "Photographer", "Bird watcher", "Camp cook", "Map reader")),
        SpyLocation("Castle", listOf("King or queen", "Knight", "Castle cook", "Guard", "Jester", "Tour guide")),
        SpyLocation("Cruise ship", listOf("Captain", "Entertainer", "Passenger", "Chef", "Deck cleaner", "Lifeboat officer")),
        SpyLocation("Hotel", listOf("Receptionist", "Bellhop", "Guest", "Housekeeper", "Hotel chef", "Manager")),
        SpyLocation("Bank", listOf("Bank teller", "Manager", "Customer", "Security guard", "Loan advisor", "Armored truck driver")),
        SpyLocation("Gym", listOf("Personal trainer", "Weightlifter", "Yoga teacher", "Receptionist", "Swimmer", "Someone on their first visit")),
        SpyLocation("Hair salon", listOf("Hairdresser", "Customer", "Receptionist", "Colorist", "Apprentice", "Customer reading a magazine")),
        SpyLocation("Recording studio", listOf("Singer", "Sound engineer", "Drummer", "Producer", "Backing singer", "Studio manager")),
        SpyLocation("Theme park", listOf("Ride operator", "Mascot performer", "Thrill seeker", "Candy floss seller", "Photographer", "Park cleaner")),
        SpyLocation("Aquarium", listOf("Diver", "Marine biologist", "Tour guide", "Visitor", "Shark feeder", "Ticket seller")),
        SpyLocation("Wedding", listOf("Bride or groom", "Best man", "Photographer", "Caterer", "Guest", "Band leader")),
        SpyLocation("Birthday party", listOf("Birthday person", "Party host", "Magician", "Guest", "Cake maker", "Neighbour")),
        SpyLocation("Football stadium", listOf("Player", "Referee", "Coach", "Fan", "Commentator", "Snack seller")),
        SpyLocation("Construction site", listOf("Crane operator", "Architect", "Bricklayer", "Site manager", "Electrician", "Safety inspector")),
        SpyLocation("Post office", listOf("Postal clerk", "Mail carrier", "Customer sending a parcel", "Sorter", "Stamp collector", "Van driver")),
        SpyLocation("Art studio", listOf("Painter", "Sculptor", "Model", "Art teacher", "Gallery owner", "Student")),
        SpyLocation("Science lab", listOf("Lead scientist", "Lab assistant", "Microscope operator", "Safety officer", "Visiting student", "Inventor")),
        SpyLocation("Volcano observatory", listOf("Volcanologist", "Helicopter pilot", "Photographer", "Geologist", "Park ranger", "Journalist")),
        SpyLocation("Arctic research base", listOf("Scientist", "Snowmobile driver", "Cook", "Weather watcher", "Doctor", "Radio operator")),
        SpyLocation("Desert oasis", listOf("Camel guide", "Traveller", "Date farmer", "Water keeper", "Photographer", "Merchant")),
        SpyLocation("Garden center", listOf("Gardener", "Customer", "Cashier", "Tree expert", "Delivery driver", "Seed seller")),
        SpyLocation("Car wash", listOf("Washer", "Car owner", "Manager", "Vacuum operator", "Waxer", "Cashier")),
        SpyLocation("Gas station", listOf("Cashier", "Driver", "Mechanic", "Truck driver", "Tourist asking for directions", "Delivery driver")),
        SpyLocation("Bowling alley", listOf("Bowler", "Shoe rental clerk", "Snack bar cook", "League champion", "Mechanic", "Birthday group")),
        SpyLocation("Ice rink", listOf("Figure skater", "Hockey player", "Ice resurfacer driver", "Skating coach", "Beginner", "Skate sharpener")),
        SpyLocation("Swimming pool", listOf("Lifeguard", "Swimming coach", "Diver", "Swimmer", "Pool cleaner", "Parent watching")),
        SpyLocation("Bus", listOf("Bus driver", "Commuter", "Tourist", "Student", "Ticket inspector", "Passenger with shopping bags")),
        SpyLocation("Hot air balloon festival", listOf("Balloon pilot", "Ground crew", "Photographer", "Passenger", "Food stall owner", "Weather forecaster")),
        SpyLocation("Mountain cabin", listOf("Hiker", "Cabin owner", "Firewood chopper", "Mountain guide", "Cook", "Visiting friend")),
        SpyLocation("Fishing boat", listOf("Captain", "Deckhand", "Net mender", "Cook", "Fish buyer", "Weather watcher")),
        SpyLocation("Television studio", listOf("News anchor", "Camera operator", "Weather presenter", "Makeup artist", "Director", "Studio audience member")),
        SpyLocation("Toy store", listOf("Shop assistant", "Toy tester", "Shopper", "Store manager", "Gift wrapper", "Puzzle expert")),
        SpyLocation("Vineyard", listOf("Grape picker", "Tour guide", "Owner", "Tractor driver", "Visitor", "Barrel maker")),
        SpyLocation("Farmers market", listOf("Fruit seller", "Cheese maker", "Shopper", "Musician busking", "Flower seller", "Market organizer")),
        SpyLocation("Laundromat", listOf("Owner", "Customer", "Repair technician", "Student with a big bag", "Folding attendant", "Someone waiting for a dryer")),
        SpyLocation("Observatory", listOf("Astronomer", "Telescope technician", "Tour guide", "Visitor", "Photographer", "Night guard")),
        SpyLocation("Jungle river cruise", listOf("Boat captain", "Guide", "Tourist", "Photographer", "Cook", "Bird expert")),
        SpyLocation("Dentist's office", listOf("Dentist", "Hygienist", "Patient", "Receptionist", "Nervous visitor", "Assistant")),
    )
}
