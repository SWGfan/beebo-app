import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

// Release signing (upload key) is read from keystore.properties when present, so
// passwords stay out of git. Without that file, release falls back to debug
// signing (the website / sideload build).
val keystorePropsFile = rootProject.file("keystore.properties")
val keystoreProps = Properties().apply {
    if (keystorePropsFile.exists()) keystorePropsFile.inputStream().use { load(it) }
}

android {
    namespace = "com.beeboentertainment.movie"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.beeboentertainment.movie"
        minSdk = 24
        targetSdk = 36
        versionCode = 40
        versionName = "1.39"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        // 64-bit and 32-bit ARM. Many Android TV boxes (Chromecast with Google TV included)
        // run a 32-bit userland, so arm64 alone hid the app from them. x86 is left out to
        // keep the website APK smaller; Play's AAB splits by ABI so each device only
        // downloads its own native library.
        ndk {
            abiFilters += listOf("arm64-v8a", "armeabi-v7a")
        }
    }

    // Three builds from one codebase, one flavour dimension:
    //  web    - the sideload APK on beeboentertainment.com. Everything, including BeeboBook.
    //  play   - Google Play (target audience 18+). BeeboBook's code, assets, services and
    //           nav entry live only in src/web, so none of it is compiled or packaged here.
    //  amazon - Amazon Appstore / Fire TV / Fire tablets (docs/FIRE-TV.md). Fire OS has no
    //           Google Play services, so this build links no com.google.android.gms library
    //           at all: no Cast SDK (src/amazon has a no-op Cast, see CastSupport.kt), no Play
    //           Billing. It follows the same store rules as play (consumption-only, no
    //           BeeboBook), which is why IS_PLAY_BUILD is true there too - read that flag as
    //           "store build". IS_AMAZON_BUILD says which store.
    // Same applicationId on purpose: one app identity, so a user can move between builds.
    // Android still refuses to update across different signing keys, though (and Amazon
    // re-signs what it distributes).
    flavorDimensions += "distribution"
    productFlavors {
        create("web") {
            dimension = "distribution"
            buildConfigField("boolean", "IS_PLAY_BUILD", "false")
            buildConfigField("boolean", "IS_AMAZON_BUILD", "false")
            buildConfigField("boolean", "FEATURE_BEEBOBOOK", "true")
            buildConfigField("boolean", "FEATURE_IN_APP_PURCHASES", "false")
        }
        create("play") {
            dimension = "distribution"
            buildConfigField("boolean", "IS_PLAY_BUILD", "true")
            buildConfigField("boolean", "IS_AMAZON_BUILD", "false")
            buildConfigField("boolean", "FEATURE_BEEBOBOOK", "false")
            buildConfigField("boolean", "FEATURE_IN_APP_PURCHASES", "true")
        }
        create("amazon") {
            dimension = "distribution"
            buildConfigField("boolean", "IS_PLAY_BUILD", "true")
            buildConfigField("boolean", "IS_AMAZON_BUILD", "true")
            buildConfigField("boolean", "FEATURE_BEEBOBOOK", "false")
            // Purchases stay on the website; the app only says so (TvFeatures.purchaseNotice).
            buildConfigField("boolean", "FEATURE_IN_APP_PURCHASES", "false")
        }
    }

    // src/cast holds the real Google Cast code (CastOptionsProvider, GmsCastSupport, the
    // media3 converter). Only web and play compile it; amazon gets NoCastSupport from
    // src/amazon instead, so no Cast or Play services class is in the Fire OS build.
    sourceSets {
        listOf("web", "play").forEach { flavor ->
            getByName(flavor).java.srcDir("src/cast/java")
        }
    }

    signingConfigs {
        create("release") {
            if (keystorePropsFile.exists()) {
                storeFile = file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
            // Explicit: the debug build type is signed with the standard AGP debug keystore,
            // which is enough for sideloading onto a phone.
            signingConfig = signingConfigs.getByName("debug")
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Play build uses the upload key (keystore.properties present); the
            // website / sideload build falls back to the debug key.
            signingConfig = if (keystorePropsFile.exists()) signingConfigs.getByName("release")
            else signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        viewBinding = true
        buildConfig = true
    }
    packaging {
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}")
    }
    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    val media3 = "1.4.1"

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.6")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.6")
    implementation("androidx.lifecycle:lifecycle-process:2.8.6")

    implementation(platform("androidx.compose:compose-bom:2024.09.02"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    debugImplementation("androidx.compose.ui:ui-tooling")

    implementation("androidx.navigation:navigation-compose:2.8.2")

    // Space Saver picks folders through the Storage Access Framework, so it never needs a
    // storage permission - but SAF hands back tree URIs, and DocumentFile is what turns
    // those into something you can list, read and check the size of.
    implementation("androidx.documentfile:documentfile:1.1.0")

    // Photo backup runs in the background with WorkManager: periodic runs, a run when a new photo
    // appears (content URI trigger), Wi-Fi / charging constraints, and it survives restarts.
    implementation("androidx.work:work-runtime-ktx:2.9.1")

    // Images
    implementation("io.coil-kt:coil-compose:2.7.0")

    // QR codes — the host shows a scannable code so a passenger with no app can
    // join the car party straight from their phone browser.
    implementation("com.google.zxing:core:3.5.3")

    implementation("com.google.crypto.tink:tink-android:1.23.0")

    // Networking + JSON
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    // Player
    implementation("androidx.media3:media3-exoplayer:$media3")
    implementation("androidx.media3:media3-ui:$media3")
    implementation("androidx.media3:media3-common:$media3")
    implementation("androidx.media3:media3-datasource-okhttp:$media3")
    // Live quality choices: the computer converts to HLS while the video plays.
    implementation("androidx.media3:media3-exoplayer-hls:$media3")
    // Background playback: MediaSessionService keeps the player alive with the screen off,
    // and gives us the lock-screen / notification transport controls for free.
    implementation("androidx.media3:media3-session:$media3")
    // ListenableFuture, used by the MediaController connection handshake and MediaSession.Callback.
    implementation("com.google.guava:guava:33.3.1-android")

    // Trip Journal MP4 export: renders the slideshow to a file on the phone (Transformer), with
    // no upload. Must stay on the same version as the other media3 modules above.
    implementation("androidx.media3:media3-transformer:$media3")
    implementation("androidx.media3:media3-effect:$media3")

    // Casting. The Cast SDK needs Google Play services, so it is web + play only; amazon has
    // none (Fire OS). androidx.mediarouter is plain AndroidX (no Google Play services) and
    // stays everywhere because the player layout and the app bar use its MediaRouteButton
    // class; the amazon build simply never shows the button (NoCastSupport).
    listOf("web", "play").forEach { flavor ->
        add("${flavor}Implementation", "androidx.media3:media3-cast:$media3")
        add("${flavor}Implementation", "com.google.android.gms:play-services-cast-framework:21.5.0")
    }
    implementation("androidx.mediarouter:mediarouter:1.7.0")

    // Encrypted token storage
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    // WebRTC receiver (peer-to-peer link to the home PC). Maintained webrtc-sdk
    // build of Google's libwebrtc; package org.webrtc, pulled from mavenCentral
    // which settings.gradle.kts already declares.
    implementation("io.github.webrtc-sdk:android:125.6422.07")

    // Google Play Billing (household plan + extra-seat add-on in-app purchases).
    // Flavor-scoped: only the play variant links it at all, so the web/sideload
    // build never pulls it in. See docs/GOOGLE-PLAY-BILLING-AND-SEAT-ADDON.md.
    "playImplementation"("com.android.billingclient:billing-ktx:7.1.1")

    // "Scan QR code" on the sign-in screen (scan/QrScan.kt). Each build takes the lightest option that
    // fits it, so neither carries what it does not use:
    //  play - Google's code scanner: a thin client (well under 1 MB) that runs the scanner inside Google
    //         Play services, so the app needs NO camera permission. Needs Google Play services on the phone;
    //         the screen falls back to the camera app and paste without them. Google APIs terms, not open source.
    //  web  - CameraX (Apache 2.0, about 1.5 MB with its Camera2 backend) reading frames for the ZXing decoder
    //         already above (Apache 2.0). Works with no Google services, declares CAMERA in src/web only.
    "playImplementation"("com.google.android.gms:play-services-code-scanner:16.1.0")
    "webImplementation"("androidx.camera:camera-camera2:1.3.4")
    "webImplementation"("androidx.camera:camera-lifecycle:1.3.4")
    "webImplementation"("androidx.camera:camera-view:1.3.4")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
}

// ---------------------------------------------------------------------------------------
// Store policy guard. Scans what the play and amazon variants actually merge (manifest,
// resources, assets) for things that must never reach a store: BeeboBook components or
// assets, "Subscribe", prices, and child-directed wording. testPlayDebugUnitTest and
// testAmazonDebugUnitTest depend on it, so CI running those unit tests runs this too.
// Run alone: gradlew checkPlayDebugPolicy / checkAmazonDebugPolicy.
//
// The amazon variant adds the Fire OS rules (no Google Play services): no com.google.android.gms
// (or Play Billing / Firebase) library on its runtime classpath or in its merged manifest, and
// no hardware feature it would require, since Fire TV has no camera, no touch screen, no
// telephony. An implied feature counts too: a CAMERA permission without a matching
// <uses-feature android:required="false"> makes Amazon's device filter drop every Fire TV.
// ---------------------------------------------------------------------------------------
val playForbiddenComponents = listOf(
    "com.beeboentertainment.movie.stories", ".stories.", "StoryNarrationService",
    "StoryCowriterService", "StoryBook", "BeeboBook", "beebobook",
)
val playForbiddenWording = listOf(
    Regex("""\bsubscribe\b""", RegexOption.IGNORE_CASE),
    Regex("""\$\s?\d+\.\d{2}\b"""),
    Regex("""\b\d+\.\d{2}\s?(USD|/\s?mo(nth)?)\b""", RegexOption.IGNORE_CASE),
    Regex("""\bfor kids\b""", RegexOption.IGNORE_CASE),
    // Not a DOM property such as `rail.children` in the bundled game page's script.
    Regex("""(?<![.\w])children\b""", RegexOption.IGNORE_CASE),
    // Payments policy, the same rules as PaymentsGuardTest (which checks every Kotlin string
    // literal and string resource in every flavour). Here they also cover the play build's
    // merged assets - the games page, word lists and content files - and all app resources.
    Regex("""(?:[$€£]\s?\d)|(?:\d\s?(?:USD|EUR|GBP)\b)"""),
    Regex("""\d+(?:[.,]\d+)?\s*(?:/|per|a)\s*(?:month|mo|year|yr|week|day)\b""", RegexOption.IGNORE_CASE),
    Regex("""subscription\s+(?:price|cost|fee)""", RegexOption.IGNORE_CASE),
    Regex("""\b(?:buy now|buy beebo|purchase|top up|pay as you go|upgrade to|go premium|start your subscription|pricing|checkout)\b""", RegexOption.IGNORE_CASE),
    Regex("""(?:stripe\.com|/checkout|/subscribe|/buy\b|buy\.html|pricing\.html|#pricing|/billing|/wallet/topup|/relay/buy)""", RegexOption.IGNORE_CASE),
)

// Libraries that need Google Play services (or are Google's own store SDKs): none may reach amazon.
val amazonForbiddenGroups = listOf("com.google.android.gms", "com.android.billingclient", "com.google.firebase")
// Manifest strings that only make sense with Google Play services / the Play store.
val amazonForbiddenManifestText = listOf(
    "com.google.android.gms", "com.android.vending", "com.google.android.c2dm", "com.google.firebase",
)
// permission -> the <uses-feature> it implies. Each must be declared required="false" in amazon.
val impliedFeatures = mapOf(
    "android.permission.CAMERA" to listOf("android.hardware.camera", "android.hardware.camera.autofocus"),
    "android.permission.RECORD_AUDIO" to listOf("android.hardware.microphone"),
    "android.permission.BLUETOOTH" to listOf("android.hardware.bluetooth"),
    "android.permission.BLUETOOTH_CONNECT" to listOf("android.hardware.bluetooth"),
    "android.permission.BLUETOOTH_SCAN" to listOf("android.hardware.bluetooth"),
    "android.permission.CALL_PHONE" to listOf("android.hardware.telephony"),
    "android.permission.SEND_SMS" to listOf("android.hardware.telephony"),
)

listOf("play", "amazon").flatMap { f -> listOf("Debug", "Release").map { f to it } }.forEach { (flavor, buildType) ->
    val variant = "$flavor$buildType"
    val flavorTitle = flavor.replaceFirstChar { it.uppercase() }
    val check = tasks.register("check${flavorTitle}${buildType}Policy") {
        group = "verification"
        description = "Fails if the $variant manifest, app resources or assets contain website-only or policy-risky content" +
            (if (flavor == "amazon") ", or anything that needs Google Play services." else ".")
        dependsOn("process${variant.replaceFirstChar { it.uppercase() }}MainManifest",
            "merge${variant.replaceFirstChar { it.uppercase() }}Resources",
            "merge${variant.replaceFirstChar { it.uppercase() }}Assets")
        val buildDir = layout.buildDirectory
        val appRes = listOf(file("src/main/res"), file("src/$flavor/res"), file("src/${buildType.lowercase()}/res"))
        doLast {
            val problems = mutableListOf<String>()
            fun scanText(label: String, text: String, wording: Boolean) {
                playForbiddenComponents.filter { text.contains(it) }.forEach { problems += "$label: contains \"$it\"" }
                if (wording) playForbiddenWording.forEach { re ->
                    re.find(text)?.let { problems += "$label: matches /${re.pattern}/ (\"${it.value}\")" }
                }
            }
            // 1. Merged manifest: components only (library manifests carry no user-facing text).
            val manifestDir = buildDir.dir("intermediates/merged_manifest/$variant").get().asFile
            val manifests = manifestDir.walkTopDown().filter { it.name == "AndroidManifest.xml" }.toList()
            if (manifests.isEmpty()) throw GradleException("No merged manifest under $manifestDir; AGP layout changed?")
            manifests.forEach { scanText("manifest ${it.name}", it.readText(), wording = false) }
            if (flavor == "amazon") {
                manifests.forEach { m ->
                    val text = m.readText()
                    amazonForbiddenManifestText.filter { text.contains(it) }
                        .forEach { problems += "manifest ${m.name}: contains \"$it\" (needs Google Play services)" }
                    // Hardware features must all be optional: Fire TV lacks touch, camera, telephony...
                    val features = Regex("""<uses-feature\b[^>]*>""").findAll(text).map { it.value }.toList()
                    val declared = mutableMapOf<String, Boolean>() // name -> required
                    features.forEach { tag ->
                        val name = Regex("""android:name="([^"]+)"""").find(tag)?.groupValues?.get(1) ?: return@forEach
                        val required = Regex("""android:required="([^"]+)"""").find(tag)?.groupValues?.get(1) != "false"
                        declared[name] = required
                        if (required && (name.startsWith("android.hardware.") || name.startsWith("android.software.")))
                            problems += "manifest ${m.name}: <uses-feature $name> is required, which hides the app from Fire devices without it"
                    }
                    impliedFeatures.forEach { (permission, needed) ->
                        if (text.contains("\"$permission\"")) needed.filter { declared[it] != false }.forEach {
                            problems += "manifest ${m.name}: $permission implies feature $it; declare <uses-feature android:name=\"$it\" android:required=\"false\"/> (src/amazon/AndroidManifest.xml)"
                        }
                    }
                }
                // No Google Play services library anywhere on the runtime classpath.
                val runtime = configurations.getByName("${variant}RuntimeClasspath")
                runtime.resolvedConfiguration.resolvedArtifacts.map { it.moduleVersion.id }
                    .filter { id -> amazonForbiddenGroups.any { id.group == it || id.group.startsWith("$it.") } }
                    .forEach { problems += "dependency ${it.group}:${it.name}:${it.version} needs Google Play services; keep it in webImplementation/playImplementation, not in a shared or amazon configuration" }
            }
            // 2. Merged resources: component names anywhere, wording in this app's own
            //    resources (library values such as Material/Cast strings are not ours).
            val mergedRes = buildDir.dir("intermediates/incremental/$variant/merge${variant.replaceFirstChar { it.uppercase() }}Resources/merged.dir").get().asFile
            if (!mergedRes.isDirectory) throw GradleException("No merged resources at $mergedRes; AGP layout changed?")
            mergedRes.walkTopDown().filter { it.isFile && it.extension == "xml" }
                .forEach { scanText("merged res ${it.relativeTo(mergedRes)}", it.readText(), wording = false) }
            appRes.filter { it.isDirectory }.flatMap { d -> d.walkTopDown().filter { it.isFile && it.extension == "xml" }.toList() }
                .forEach { scanText("app res ${it.relativeTo(projectDir)}", it.readText(), wording = true) }
            // 3. Merged assets: no BeeboBook files at all, and no risky wording in text assets.
            val assetsDir = buildDir.dir("intermediates/assets/$variant/merge${variant.replaceFirstChar { it.uppercase() }}Assets").get().asFile
            if (assetsDir.isDirectory) assetsDir.walkTopDown().filter { it.isFile }.forEach { f ->
                val rel = f.relativeTo(assetsDir).invariantSeparatorsPath
                // A bare "story" substring also matched the unrelated Story Builder party-game
                // artwork (game-art/storybuilder.png, shared by both flavors). BeeboBook's own
                // assets live under assets/beebobook/ and its own source set (src/web), which is
                // what this guard needs to catch if it ever leaked into a shared source set.
                if (rel.contains("beebobook", ignoreCase = true))
                    problems += "asset $rel: BeeboBook asset in the play build"
                if (f.extension in setOf("html", "json", "txt", "js", "css")) scanText("asset $rel", f.readText(), wording = true)
            }
            if (problems.isNotEmpty()) throw GradleException(
                "$flavorTitle policy guard failed for $variant:\n  " + problems.distinct().joinToString("\n  "))
            logger.lifecycle("$flavorTitle policy guard: $variant clean (${manifests.size} manifest(s), resources, assets scanned).")
        }
    }
    tasks.matching { it.name == "test${variant.replaceFirstChar { it.uppercase() }}UnitTest" }
        .configureEach { dependsOn(check) }
}
// A Play bundle signed with the debug key is refused by Play Console. Building one is still useful
// for testing (and CI has no keystore), so warn loudly rather than fail.
gradle.taskGraph.whenReady {
    val playRelease = allTasks.any { it.project == project && it.name in setOf("bundlePlayRelease", "assemblePlayRelease") }
    if (playRelease && !keystorePropsFile.exists()) {
        logger.warn(
            "\nWARNING: keystore.properties is missing, so the playRelease output is signed with the DEBUG key." +
                "\n         Play Console will refuse it. Build the upload copy on the PC that has apps/core/keystore.properties.\n"
        )
    }
}

tasks.register("checkPlayPolicy") {
    group = "verification"
    description = "Runs the Play policy guard for playDebug and playRelease."
    dependsOn("checkPlayDebugPolicy", "checkPlayReleasePolicy")
}

tasks.register("checkAmazonPolicy") {
    group = "verification"
    description = "Runs the Amazon Appstore / Fire OS policy guard for amazonDebug and amazonRelease."
    dependsOn("checkAmazonDebugPolicy", "checkAmazonReleasePolicy")
}
