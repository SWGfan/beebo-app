# Talking to Beebo (Google Assistant)

Beebo works with **Google Assistant** on Android phones, Android TV / Google TV and
Android Auto. It finds titles in *your own* library on your Beebo computer, so the
app must be signed in to your Beebo server first.

**Alexa / Amazon Echo is not supported.** Amazon products are not on Beebo's allowed
list, so there is no Alexa skill and none is planned.

## What you can say

### Play something

| Say | What happens |
| --- | --- |
| "Hey Google, play **Heat** on Beebo" | Plays the film Heat |
| "Hey Google, play **the movie Up** on Beebo" | Only looks at films |
| "Hey Google, play **the show The Office** on Beebo" | Only looks at TV shows |
| "Hey Google, play **Friends season 2 episode 3** on Beebo" | That exact episode (also "S2E3", "season two, episode three", "episode 3 of season 2") |
| "Hey Google, play **Friends season 2** on Beebo" | The first episode of season 2 |
| "Hey Google, play **Friends** on Beebo" | Carries on where you left off in Friends (or starts at the first episode) |
| "Hey Google, play **Blade Runner 2049** on Beebo" | A number can be part of the title |
| "Hey Google, play **Heat 1995** on Beebo" | A year helps pick between two films with the same name |
| "Hey Google, play Beebo" | Your newest Continue watching item |

Small mishearings are fine ("freinds", "amelie" for Amélie, "fast and furious" for
Fast & Furious). If nothing in the library is close enough, Beebo says it couldn't
find the title rather than playing a guess.

### While something is playing

"Hey Google, pause", "resume", "stop", "next episode", "previous episode",
"skip forward 30 seconds", "rewind 1 minute". These go straight to Beebo's player
(phone, TV, lock screen, Bluetooth and the car all use the same media session).

### Find something

"Hey Google, search for **Friends** on Beebo" opens the show; for a film it starts playing.
"Hey Google, open **Continue watching** in Beebo" picks up your newest item.
(These two are Google App Actions, which only switch on for the app installed from
Google Play.)

### On Android TV / Google TV

- Press the microphone button on the remote and say a title: matching films and
  shows from your Beebo library appear in the TV's search results.
- Your **Continue watching** titles appear in the TV home screen's
  "Continue watching" row, and update when you pause or stop.

### In the car (Beebo Auto on Android Auto)

"Hey Google, play Heat on Beebo" and "play Friends season 2 episode 3 on Beebo"
work the same way (sound only while driving). Searching in the car's Beebo screen
also tolerates small mishearings.

## How it works (for developers)

| Piece | Where |
| --- | --- |
| Spoken words -> title, season, episode; fuzzy matching; episode choice | `apps/core/.../core/VoiceSearch.kt` (copy in `apps/auto/.../media/VoiceSearch.kt`, a test keeps them identical) |
| Assistant `MEDIA_PLAY_FROM_SEARCH`, App Actions `SEARCH` / `beebo://feature`, TV search results and Watch Next links | `apps/core/.../voice/VoiceSearchActivity.kt` |
| Voice requests while Beebo's session is up (`searchQuery` in `onAddMediaItems`) | `apps/core/.../player/PlaybackService.kt`, `apps/auto/.../media/PlaybackService.kt` |
| Library lookups for voice | `apps/core/.../voice/VoiceLibrary.kt`, `apps/auto/.../media/Catalog.kt` (`resolveVoice`) |
| Google TV global search | `apps/core/.../voice/TvSearchProvider.kt`, `res/xml/searchable.xml` |
| TV home screen Continue watching row | `apps/core/.../voice/WatchNextSync.kt` (platform `TvContract.WatchNextPrograms`), rules in `core/WatchNextPlanner.kt` |
| App Actions | `apps/core/app/src/main/res/xml/shortcuts.xml` (`actions.intent.GET_THING`, `actions.intent.OPEN_APP_FEATURE`) |
| In-app help | More > Help > Talk to Beebo (`core/VoiceHelp.kt`) |

Parental controls: `VoiceSearch.contentFilter` is the hook. When the household's
parental filter is in place it sets this, and a title the filter hides can never be
found or played by voice (a filter that throws hides everything).

Deep links: `beebo://play/movie/<id>`, `beebo://play/tv/<episodeId>`,
`beebo://open/show/<showKey>`, `beebo://feature?feature=<name>`. The activity is not
`BROWSABLE`, so a web page cannot start playback.
