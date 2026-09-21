package com.beeboentertainment.movie.stories

import android.Manifest
import android.content.pm.PackageManager
import android.media.MediaPlayer
import android.net.Uri
import android.os.Build
import android.speech.tts.TextToSpeech
import android.speech.tts.Voice
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.UrlUtils
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.util.Locale

// COMPUTER_VOICES (the picker's computer voices) lives in StoryVoiceSample.kt beside the sampler.

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun StoryBookScreen() {
    val context=LocalContext.current
    val scope=rememberCoroutineScope()
    var library by remember { mutableStateOf<List<StoryInfo>>(emptyList()) }
    var slug by rememberSaveable { mutableStateOf<String?>(null) }
    var book by remember { mutableStateOf<StoryBook?>(null) }
    var names by rememberSaveable(slug) { mutableStateOf(mapOf<String,String>()) }
    var characterVoices by rememberSaveable(slug) { mutableStateOf(mapOf<String,String>()) }
    var narrator by rememberSaveable { mutableStateOf("af_heart") }
    var useComputer by rememberSaveable { mutableStateOf(StoryVoiceMemory.useComputer(context)) }
    var pageId by rememberSaveable(slug) { mutableStateOf<Int?>(null) }
    var trail by rememberSaveable(slug) { mutableStateOf(listOf<Int>()) }
    var note by remember { mutableStateOf<String?>(null) }
    // A voice sample that could not play says so here, right under the voice pickers.
    var sampleNote by remember { mutableStateOf<String?>(null) }
    var computerAudio by remember { mutableStateOf<Map<Int,String>>(emptyMap()) }
    // Every narration this book already holds, whatever cast made it. Without this the
    // screen could only ever ask about the ONE set the pickers currently describe.
    var madeNarrations by remember(slug) { mutableStateOf<List<StoryMadeNarration>>(emptyList()) }
    var checking by remember { mutableStateOf(false) }
    var refreshTick by remember { mutableStateOf(0) }
    var shelfTick by remember { mutableStateOf(0) }
    var autoPlay by remember { mutableStateOf(false) }
    var voices by remember { mutableStateOf<List<Voice>>(emptyList()) }
    var phoneVoice by rememberSaveable { mutableStateOf(StoryVoiceMemory.phoneVoice(context)) }
    var ready by remember { mutableStateOf(false) }
    // Nothing may be saved for this book until what was saved has been read back, or the
    // empty state this screen starts in would overwrite the reader's cast the moment the
    // book opens.
    var restored by remember(slug) { mutableStateOf(false) }

    // The narration run lives on the process, not on this screen, so walking away keeps it.
    val progress by StoryNarrationProgress.state.collectAsState()
    val cowriter by StoryCowriterProgress.state.collectAsState()
    val runningHere = progress.running && progress.slug != null && progress.slug == slug

    // Android 13+ needs runtime consent before any notification is shown. We ask at the moment
    // the user starts a preparation, and if consent is refused the work still runs - the screen
    // keeps showing live progress, and we say plainly that the "ready" alert will not arrive.
    var notifyAllowed by remember { mutableStateOf(
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    ) }
    val askNotify = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        notifyAllowed = granted
    }

    val media=remember { MediaPlayer() }
    // A voice sample gets its OWN player. Sharing [media] would hand the preview the narration's
    // error listener (which puts a message on screen - wrong for a preview) and every stop() of a
    // story would be the same reset the sample needs, so the two would fight over one object.
    val sampleMedia=remember { MediaPlayer() }
    // Only the newest tap may be heard. A sample the computer is still generating when the user
    // picks another voice is abandoned, never played late over the top of the newer choice.
    var sampleJob by remember { mutableStateOf<Job?>(null) }
    val tts=remember {
        val holder=arrayOfNulls<TextToSpeech>(1)
        TextToSpeech(context.applicationContext) { status ->
            scope.launch {
                val engine=holder[0]
                if(status==TextToSpeech.SUCCESS && engine!=null){
                    engine.language=Locale.US
                    voices=engine.voices.orEmpty().filter { !it.isNetworkConnectionRequired && it.locale.language=="en" }.sortedBy { it.name }
                    ready=voices.isNotEmpty()
                    if(phoneVoice.isBlank() && voices.isNotEmpty())phoneVoice=voices.first().name
                }
            }
        }.also { holder[0]=it }
    }
    fun stop() { tts.stop();runCatching { media.reset() };sampleJob?.cancel();runCatching { sampleMedia.reset() } }
    // Only local playback is torn down here. A narration run belongs to StoryNarrationService.
    DisposableEffect(Unit) { onDispose { sampleJob?.cancel();tts.stop();tts.shutdown();media.release();runCatching { sampleMedia.release() } } }

    // --- Hearing a voice before choosing it ---------------------------------------------
    // Tapping a voice plays that voice saying hello. The line is built from the display label the
    // menu is already showing ("Heart - American" -> "Hi, I'm Heart."), so there is no second list
    // of names to fall out of step with COMPUTER_VOICES when a voice is added.
    //
    // Picking a voice means the user has stopped listening to the story and started fiddling, so
    // every menu already calls stop() first: the narration ends and the sample has the room.
    fun sampleComputerVoice(id:String,label:String) {
        sampleJob?.cancel()
        runCatching { sampleMedia.reset() } // cut off a sample that is still sounding
        tts.stop()
        sampleNote=null
        if(id.isBlank()) return             // "Same as narrator" is a setting, not a voice
        sampleJob=scope.launch {
            // Usually one quick request for the clip baked into Beebo for Windows (then cached on
            // the phone); an older computer makes it on demand, which fetchVoiceSample waits out.
            val result=fetchVoiceSample(context.cacheDir,id,voiceSampleLine(computerVoiceName(label)))
            if(!isActive) return@launch
            if(result !is VoiceSampleResult.Ready){ sampleNote=voiceSampleProblem(result);return@launch }
            runCatching {
                sampleMedia.reset()
                sampleMedia.setOnPreparedListener { it.start() }
                sampleMedia.setOnErrorListener { _,_,_ -> sampleNote="That voice sample could not play.";true }
                sampleMedia.setDataSource(result.file.absolutePath)
                sampleMedia.prepareAsync()
            }.onFailure { sampleNote="That voice sample could not play." }
        }
    }

    // The phone's own voices need no computer and no download, so this one is instant.
    fun samplePhoneVoice(name:String,label:String) {
        sampleJob?.cancel()
        runCatching { sampleMedia.reset() }
        sampleNote=null
        val voice=voices.firstOrNull { it.name==name } ?: return
        if(!ready){ sampleNote="That phone voice is not ready.";return }
        runCatching {
            tts.stop()
            tts.voice=voice
            tts.speak(voiceSampleLine(phoneVoiceName(label)),TextToSpeech.QUEUE_FLUSH,null,"voice-sample")
        }.onFailure { sampleNote="That phone voice is not ready." }
    }

    // Two shelves shown as one. The APK's own books load first and always, so Story Mode is
    // unchanged with no computer and no network; then anything the computer holds that the APK
    // does not - a book written here - is added. Reruns when a new book has just been written.
    LaunchedEffect(shelfTick,cowriter.readySlug) {
        val phone=try { StoryShelf.bundled(context) }
            catch(e:CancellationException){throw e}
            catch(_:Exception){note="The story library could not be opened.";emptyList<StoryInfo>()}
        library=phone+StoryShelf.cached(context)
        val written=try { StoryShelf.refresh(context,phone.map { it.slug }.toSet()) }
            catch(e:CancellationException){throw e}
            // Offline, signed out, computer asleep: keep the cached shelf rather than emptying it.
            catch(_:Exception){null}
        if(written!=null)library=phone+written
    }

    // A "story voices ready" notification asks for one book by name. Open it, in computer mode,
    // at the setup screen where the ready-to-play section is waiting.
    val deepLink by StoryDeepLink.slug.collectAsState()
    LaunchedEffect(deepLink) {
        val requested=deepLink ?: return@LaunchedEffect
        StoryDeepLink.consume()
        slug=requested;pageId=null;trail=emptyList();useComputer=true
    }

    LaunchedEffect(slug) {
        book=null;note=null;stop();restored=false
        val selected=slug ?: return@LaunchedEffect
        // Bring back the cast this reader last chose for THIS book, before anything asks
        // the computer what it has. Restoring first is what makes narration that is
        // already finished show up as Play instead of being offered for making again.
        val saved=StoryVoiceMemory.load(context,selected)
        if(saved.names.isNotEmpty()) names=saved.names
        if(saved.characterVoices.isNotEmpty()) characterVoices=saved.characterVoices
        narrator=saved.narrator
        restored=true
        try { book=StoryShelf.book(context,selected) }
        catch(e:CancellationException){throw e}
        catch(t:Exception){note=t.message?.takeIf { it.isNotBlank() } ?: "This story could not be opened. Please choose another."}
    }

    // Remember the cast as it is chosen, so walking away and coming back lands on the
    // same narration set rather than the defaults.
    LaunchedEffect(slug,names,characterVoices,narrator,restored) {
        val selected=slug ?: return@LaunchedEffect
        if(!restored) return@LaunchedEffect
        StoryVoiceMemory.save(context,selected,
            StoryVoiceMemory.Choices(names,characterVoices,narrator))
    }
    LaunchedEffect(useComputer) { StoryVoiceMemory.setUseComputer(context,useComputer) }
    LaunchedEffect(phoneVoice) { StoryVoiceMemory.setPhoneVoice(context,phoneVoice) }

    // What has this book ALREADY been narrated with? Deliberately not keyed on the names or
    // the voices: this is the list a reader consults when the pickers are wrong, so it must
    // not move every time they touch one. It refreshes when the book opens, when a run
    // finishes, and when they ask the computer again.
    LaunchedEffect(slug,book,useComputer,refreshTick,progress.running) {
        madeNarrations=emptyList()
        val selected=slug ?: return@LaunchedEffect
        if(book==null||!useComputer) return@LaunchedEffect
        madeNarrations=try { StoryBookClient().narrationsMade(selected) }
        catch(e:CancellationException){throw e}
        catch(t:Exception){ emptyList() }
    }

    // Does the computer ALREADY hold narration for exactly these names and voices?
    //
    // Answered by /api/storybook-render with probe=true, which returns the same setHash a real
    // render would use but never starts a voice worker. It re-runs whenever the names, the voices
    // or the book change, and again when a background run finishes, so the ready-to-play section
    // appears on its own without the user pressing anything.
    LaunchedEffect(slug,book,useComputer,names,narrator,characterVoices,refreshTick,progress.running) {
        computerAudio=emptyMap()
        val selected=slug
        val loaded=book
        if(selected==null||loaded==null||!useComputer) return@LaunchedEffect
        delay(700) // let typing settle before asking the computer
        checking=true
        try {
            val client=StoryBookClient()
            val set=client.probe(selected,loaded.names(names),narrator,characterVoices.filterValues { it.isNotBlank() })
            if(set.status=="ready"){
                val audio=client.audio(selected,set.setHash)
                if(audio.status=="ready"&&audio.pages.isNotEmpty())computerAudio=audio.pages
            }
        }
        catch(e:CancellationException){throw e}
        // Offline, or no computer signed in: the phone voices and plain reading still work.
        catch(_:Exception){ }
        finally{ checking=false }
    }

    fun back() {
        stop()
        when {
            trail.isNotEmpty() -> { pageId=trail.last();trail=trail.dropLast(1) }
            pageId!=null -> { pageId=null }
            else -> slug=null
        }
    }
    BackHandler(enabled=slug!=null) { back() }

    fun speak(page:StoryPage,b:StoryBook) {
        stop();note=null
        if(useComputer){
            val relative=computerAudio[page.id]
            if(relative==null){note="Prepare the computer voices first, or choose a phone voice.";return}
            val session=BeeboApp.instance.session
            val url=UrlUtils.endpoint(session.baseUrl,relative)
            if(url==null||session.token.isNullOrBlank()){note="Reconnect to your Beebo computer to play these voices.";return}
            try {
                media.setOnPreparedListener { it.start() }
                media.setOnErrorListener { _,_,_ -> note="This voice could not play. Check your computer connection.";true }
                media.setDataSource(context,Uri.parse(url),mapOf("Authorization" to "Bearer ${session.token}"))
                media.prepareAsync()
            }catch(_:Exception){note="This voice could not play. Try a phone voice."}
        }else{
            val voice=voices.firstOrNull { it.name==phoneVoice }
            if(voice==null||!ready){note="Install an English offline voice in your phone's text-to-speech settings to listen. You can still read every story.";return}
            tts.voice=voice
            val chunks=b.personalize(page.text,names).chunked(TextToSpeech.getMaxSpeechInputLength().coerceAtMost(3500))
            chunks.forEachIndexed { index,text ->
                if(tts.speak(text,if(index==0)TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD,null,"story-${page.id}-$index")==TextToSpeech.ERROR)
                    note="That phone voice is not ready. Choose another voice or install its offline voice data."
            }
        }
    }

    // "Play from the start" jumps to page one and then speaks it, once the page is on screen.
    LaunchedEffect(autoPlay,pageId,computerAudio) {
        if(!autoPlay) return@LaunchedEffect
        val loaded=book
        val current=loaded?.pages?.firstOrNull { it.id==pageId }
        if(loaded!=null&&current!=null&&computerAudio.containsKey(current.id)){ speak(current,loaded);autoPlay=false }
    }

    fun prepareVoices(b:StoryBook) {
        val selected=slug ?: return
        if(Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !notifyAllowed)
            askNotify.launch(Manifest.permission.POST_NOTIFICATIONS)
        // The work starts either way: a refused notification must not silently do nothing.
        StoryNarrationService.start(context,selected,b.title,b.names(names),narrator,
            characterVoices.filterValues { it.isNotBlank() })
        note=null
    }

    val scroll=rememberScrollState()
    LaunchedEffect(pageId,slug) { scroll.scrollTo(0) }
    Column(Modifier.fillMaxSize().verticalScroll(scroll).padding(16.dp),verticalArrangement=Arrangement.spacedBy(14.dp)) {
        if(slug!=null)TextButton(onClick={back()}){Text(if(pageId==null)"← All stories" else "← Back")}
        Text("Story Mode · BeeboBook",style=MaterialTheme.typography.headlineSmall)

        val b=book

        // --- Ready to play -------------------------------------------------------------
        // Sits above everything else so an already-voiced story is one tap from playing,
        // with no re-generating and no hunting.
        if(b!=null&&useComputer&&computerAudio.isNotEmpty()){
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(8.dp)) {
                    Text("▶ Ready to play",style=MaterialTheme.typography.titleMedium)
                    Text("Your computer already has ${b.title} in these names and voices. Nothing to prepare.",
                        style=MaterialTheme.typography.bodyMedium)
                    FlowRow(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                        Button(onClick={ stop();trail=emptyList();pageId=b.startPage;autoPlay=true }){Text("Play from the start")}
                        val here=b.pages.firstOrNull { it.id==pageId }
                        if(here!=null&&computerAudio.containsKey(here.id))
                            OutlinedButton(onClick={ speak(here,b) }){Text("Play this page")}
                    }
                }
            }
        }

        // --- Preparing on the computer -------------------------------------------------
        if(b!=null&&useComputer&&runningHere){
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(8.dp)) {
                    Text("Preparing voices on your computer",style=MaterialTheme.typography.titleMedium)
                    Text(progress.message ?: "Asking your computer to prepare the voices...",
                        style=MaterialTheme.typography.bodyMedium)
                    Text(
                        if(notifyAllowed) "You can leave this screen or close Beebo. Your phone will tell you when it is ready."
                        else "You can leave this screen - it keeps going. Notifications are off for Beebo, so come back here to see when it is ready.",
                        style=MaterialTheme.typography.bodyMedium
                    )
                    if(progress.total>0)LinearProgressIndicator(
                        progress={ (progress.done.toFloat()/progress.total.toFloat()).coerceIn(0f,1f) },
                        modifier=Modifier.fillMaxWidth())
                    else LinearProgressIndicator(Modifier.fillMaxWidth())
                    TextButton(onClick={ StoryNarrationService.stop(context) }){Text("Stop waiting on this phone")}
                }
            }
        }else if(b!=null&&useComputer&&computerAudio.isEmpty()&&progress.slug==slug&&progress.error!=null){
            Text(progress.error!!,color=MaterialTheme.colorScheme.error)
        }

        note?.let { Text(it,color=MaterialTheme.colorScheme.onSurfaceVariant) }

        if(slug==null){
            Text("${library.count { !it.custom }} premade stories. Add your characters' names, choose a voice and decide what happens next.")
            Text("The premade books are stored on your phone. Reading and installed phone voices work offline.",style=MaterialTheme.typography.bodyMedium)
            StoryCowriterCard(
                notifyAllowed=notifyAllowed,
                onAskNotify={ if(Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)askNotify.launch(Manifest.permission.POST_NOTIFICATIONS) },
                onOpen={ written -> stop();slug=written;pageId=null;trail=emptyList() }
            )
            library.forEach { info -> Card(Modifier.fillMaxWidth().clickable { slug=info.slug }) {
                Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(6.dp)){
                    Text(info.title,style=MaterialTheme.typography.titleMedium);Text(info.blurb);Text(info.ageRange,style=MaterialTheme.typography.labelLarge)
                    if(info.custom)Text("Written on your computer",style=MaterialTheme.typography.labelLarge)
                }
            } }
            TextButton(onClick={ shelfTick++ }){Text("Check my computer for new stories")}
        }else if(b==null){ CircularProgressIndicator() }
        else if(pageId==null){
            Text(b.title,style=MaterialTheme.typography.titleLarge)
            b.characters.forEach { character ->
                OutlinedTextField(value=names[character.token]?:character.default,
                    onValueChange={names=names+(character.token to it.take(60));stop()},
                    label={Text(character.role)},singleLine=true,modifier=Modifier.fillMaxWidth())
            }
            FlowRow(horizontalArrangement=Arrangement.spacedBy(8.dp)){
                FilterChip(selected=!useComputer,onClick={useComputer=false;stop()},label={Text("Phone voices · offline")})
                FilterChip(selected=useComputer,onClick={useComputer=true;stop()},label={Text("Computer voices")})
            }
            if(useComputer){
                Text("Uses your existing Beebo computer voice engine. Keep the computer on and connected while preparing and playing these voices.")
                VoiceMenu("Narrator",narrator,COMPUTER_VOICES,onSample={ sampleComputerVoice(it,COMPUTER_VOICES[it].orEmpty()) },sampleName={ computerVoiceNameFor(it) }){narrator=it;stop();sampleComputerVoice(it,COMPUTER_VOICES[it].orEmpty())}
                b.characters.forEach { character -> VoiceMenu("Voice for ${names[character.token]?:character.default}",characterVoices[character.token].orEmpty(),linkedMapOf("" to "Same as narrator")+COMPUTER_VOICES,onSample={ sampleComputerVoice(it,COMPUTER_VOICES[it].orEmpty()) },sampleName={ computerVoiceNameFor(it) }){characterVoices=characterVoices+(character.token to it);stop();sampleComputerVoice(it,COMPUTER_VOICES[it].orEmpty())} }
                sampleNote?.let { Text(it,style=MaterialTheme.typography.bodyMedium,color=MaterialTheme.colorScheme.error) }
                if(madeNarrations.isNotEmpty()){
                    val voicesNow=characterVoices.filterValues { it.isNotBlank() && it!=narrator }
                    val namesNow=b.names(names)
                    Text("Narrations you have already made",style=MaterialTheme.typography.titleSmall)
                    Text("Each one was made with a particular cast. Pick a cast up again and it plays straight away \u2014 nothing is made twice.",
                        style=MaterialTheme.typography.bodyMedium)
                    madeNarrations.forEach { made ->
                        // "Chosen" is decided by comparing the cast, not by re-deriving the set id:
                        // the id is the computer's to calculate, and a phone that disagreed by one
                        // byte would quietly label the wrong row.
                        val chosen = made.names==namesNow && made.narrator==narrator && made.characterVoices==voicesNow
                        val cast = b.characters.joinToString("   \u00b7   ") { character ->
                            val who = made.names[character.token] ?: character.default
                            val voiceId = made.characterVoices[character.token] ?: made.narrator
                            val voice = (COMPUTER_VOICES[voiceId] ?: voiceId).substringBefore(" \u00b7")
                            "$who as $voice"
                        }
                        Card(Modifier.fillMaxWidth()) {
                            Column(Modifier.padding(14.dp),verticalArrangement=Arrangement.spacedBy(6.dp)) {
                                Text(cast.ifBlank { "The whole book in one voice" },
                                    style=MaterialTheme.typography.bodyLarge)
                                val told = (COMPUTER_VOICES[made.narrator] ?: made.narrator).substringBefore(" \u00b7")
                                val state = when(made.status) {
                                    "ready" -> "Ready to play"
                                    "pending" -> "Still being made"
                                    "error" -> "Did not finish"
                                    else -> "Unfinished \u2014 ${made.pages} of ${made.total} pages"
                                }
                                val made_on = if(made.madeAt>0)
                                    "  \u00b7  " + java.text.SimpleDateFormat("d MMM, h:mm a",java.util.Locale.getDefault())
                                        .format(java.util.Date(made.madeAt)) else ""
                                Text("Told by $told  \u00b7  $state$made_on",
                                    style=MaterialTheme.typography.bodyMedium,
                                    color=MaterialTheme.colorScheme.onSurfaceVariant)
                                when {
                                    chosen -> Text("This is the one you have chosen.",
                                        style=MaterialTheme.typography.bodyMedium)
                                    made.reusable -> Button(onClick={
                                        names=made.names
                                        narrator=made.narrator
                                        characterVoices=made.characterVoices
                                        stop()
                                    }){ Text(if(made.status=="ready") "Use this one" else "Pick this cast up again") }
                                    // No values.json beside the audio, so the names that made it are
                                    // gone. Offering a button would ask the computer for a DIFFERENT
                                    // set and quietly start narrating all over again.
                                    else -> Text("Made before Beebo kept track of the cast, so this one cannot be picked up again.",
                                        style=MaterialTheme.typography.bodyMedium,
                                        color=MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                        }
                    }
                }
                if(checking&&computerAudio.isEmpty())Text("Checking your computer for these voices…",style=MaterialTheme.typography.bodyMedium)
                if(!runningHere&&computerAudio.isEmpty()&&!checking){
                    Button(onClick={ prepareVoices(b) },modifier=Modifier.fillMaxWidth()){Text("Prepare computer voices")}
                    Text("This can take a few minutes the first time. You can leave this screen while it works.",
                        style=MaterialTheme.typography.bodyMedium)
                }
                TextButton(onClick={ refreshTick++ }){Text("Check my computer again")}
            }else{
                val phoneOptions=voices.mapIndexed { index,voice -> voice.name to "${voice.locale.displayName} · Voice ${index+1}" }.toMap()
                VoiceMenu("Reading voice",phoneVoice,phoneOptions,onSample={ samplePhoneVoice(it,phoneOptions[it].orEmpty()) },sampleName={ phoneOptions[it]?.let(::phoneVoiceName) }){phoneVoice=it;stop();samplePhoneVoice(it,phoneOptions[it].orEmpty())}
                sampleNote?.let { Text(it,style=MaterialTheme.typography.bodyMedium,color=MaterialTheme.colorScheme.error) }
                if(!ready)Text("No installed English phone voice was found. You can read now or add a voice in your phone settings.")
            }
            Button(onClick={pageId=b.startPage;trail=emptyList();stop()},modifier=Modifier.fillMaxWidth()){Text("Start story")}
        }else{
            val page=b.pages.firstOrNull { it.id==pageId }
            if(page==null){Text("That page is unavailable.");TextButton(onClick={pageId=null}){Text("Back to story setup")}}
            else{
                Text(b.title,style=MaterialTheme.typography.titleLarge)
                Text("Page ${page.id}${if(page.isEnding)" · The end" else ""}",style=MaterialTheme.typography.labelLarge)
                // The page's picture, when this book has art and the computer can be reached.
                // Renders nothing at all otherwise, so offline reading is unchanged.
                StoryScene(slug,b,page,names)
                if(useComputer&&computerAudio.isEmpty()&&!runningHere&&!checking){
                    Button(onClick={ prepareVoices(b) }){Text("Prepare computer voices")}
                }
                FlowRow(horizontalArrangement=Arrangement.spacedBy(8.dp)){
                    Button(enabled=if(useComputer)computerAudio.containsKey(page.id)else ready,onClick={speak(page,b)}){Text("Read aloud")}
                    OutlinedButton(onClick={stop()}){Text("Stop voice")}
                    TextButton(onClick={pageId=null;trail=emptyList();stop()}){Text("Names & voices")}
                }
                Text(b.personalize(page.text,names),style=MaterialTheme.typography.bodyLarge)
                if(page.isEnding){Text(page.endingTitle.ifBlank{"The end"},style=MaterialTheme.typography.titleLarge);Button(onClick={stop();pageId=b.startPage;trail=emptyList()}){Text("Try another path")}}
                else page.choices.forEach { choice -> OutlinedButton(onClick={stop();trail=trail+page.id;pageId=choice.target},modifier=Modifier.fillMaxWidth()){Text(b.personalize(choice.text,names))} }
            }
        }
    }
}

/**
 * A voice dropdown. Choosing a voice selects it (and the caller plays its sample); the play button
 * beside the menu replays the sample of the voice currently chosen without opening the list again.
 * Every row in the open list also has its own play button, so a voice can be heard before choosing.
 */
@Composable private fun VoiceMenu(label:String,selected:String,options:Map<String,String>,
                                  onSample:((String)->Unit)?=null,sampleName:(String)->String?={ null },
                                  onSelect:(String)->Unit){
    var expanded by remember { mutableStateOf(false) }
    Row(verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(4.dp)) {
        Box(Modifier.weight(1f)) {
            OutlinedButton(onClick={expanded=true},enabled=options.isNotEmpty(),modifier=Modifier.fillMaxWidth()) { Text("$label: ${options[selected]?:"Choose voice"}") }
            DropdownMenu(expanded=expanded,onDismissRequest={expanded=false}){options.forEach{(id,title)->
                val name=sampleName(id)
                DropdownMenuItem(text={Text(title)},onClick={expanded=false;onSelect(id)},
                    trailingIcon=if(onSample!=null&&name!=null){{ SampleButton(name){ onSample(id) } }}else null)
            }}
        }
        val chosenName=sampleName(selected)
        if(onSample!=null&&chosenName!=null) SampleButton(chosenName){ onSample(selected) }
    }
}

/** A play button for one voice's hello. TalkBack reads it as "Play a sample of Heart". */
@Composable private fun SampleButton(name:String,onClick:()->Unit){
    val description="Play a sample of $name"
    IconButton(onClick=onClick,modifier=Modifier.semantics { contentDescription=description }) {
        Text("\u25B6",style=MaterialTheme.typography.titleMedium,modifier=Modifier.clearAndSetSemantics { })
    }
}
