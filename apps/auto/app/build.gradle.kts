plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "com.beeboentertainment.auto"
    compileSdk = 36

    // CarUxRestrictionsManager for Android Automotive OS. The manifest marks the
    // library as not required, so phones still install the app; the classes are
    // only touched after a FEATURE_AUTOMOTIVE check (see drive/DriveMonitor.kt).
    useLibrary("android.car")

    defaultConfig {
        applicationId = "com.beeboentertainment.auto"
        minSdk = 24
        targetSdk = 36
        versionCode = 9
        versionName = "1.8"
        // Test APK: ship only the phone's own CPU (arm64) so the bundled WebRTC
        // native library doesn't quadruple the size. Remove to ship all ABIs.
        ndk {
            abiFilters += "arm64-v8a"
        }
    }

    // The repo-local debug.keystore is not committed (*.keystore is gitignored). When it
    // is missing (CI, a fresh clone) fall back to AGP's default ~/.android/debug.keystore
    // so unit tests and debug builds still work without it.
    val repoDebugKeystore = file("${rootDir}/debug.keystore")
    signingConfigs {
        getByName("debug") {
            if (repoDebugKeystore.exists()) {
                storeFile = repoDebugKeystore
                storePassword = "android"
                keyAlias = "androiddebugkey"
                keyPassword = "android"
            }
        }
    }

    buildTypes {
        getByName("debug") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
        getByName("release") {
            // Signed with the debug key on purpose: this is sideloaded onto the
            // owner's own phone, never published. R8 is on because the unminified
            // build is 22MB, most of it Compose and Guava that nothing calls.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    // The unit tests here are pure JVM (no Robolectric): they exercise
    // normalizeBaseUrl, the MediaIds string namespace, and kotlinx-serialization
    // decoding. Returning defaults instead of throwing keeps any incidental
    // android.jar stub call from blowing up the suite.
    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

// ---------------------------------------------------------------------------------------------
// Away from home, shared with the phone app (apps/core), not copied.
//
// apps/core and apps/auto are two separate Gradle builds, so there is no project to depend on.
// Instead the phone app's tunnel sources are synced into this build at build time and compiled
// here, unchanged, in their own package (com.beeboentertainment.movie.rtc). One copy of the
// protocol, reconnects, resuming and routing rules; a change in apps/core reaches the car app on
// its next build. Left out: RemoteAccess.kt and RemoteProfileSignIn.kt, which are glued to the phone app's own session store,
// API client and lifecycle - the car app's equivalent is remote/AutoRemote.kt.
// The phone app's JVM tests for the same sources are synced too and run in this build's unit tests.
// ---------------------------------------------------------------------------------------------
val coreJava = rootDir.resolve("../core/app/src/main/java")
val coreTests = rootDir.resolve("../core/app/src/test/java")

val syncSharedRtc = tasks.register<Sync>("syncSharedRtc") {
    from(coreJava) {
        include("com/beeboentertainment/movie/rtc/*.kt")
        exclude("com/beeboentertainment/movie/rtc/RemoteAccess.kt")
        // Same reason: it signs in through the phone app's own ApiClient/LoginResponse types.
        exclude("com/beeboentertainment/movie/rtc/RemoteProfileSignIn.kt")
        include("com/beeboentertainment/movie/core/UrlUtils.kt")
    }
    into(layout.buildDirectory.dir("generated/sharedRtc/main"))
}
val syncSharedRtcTests = tasks.register<Sync>("syncSharedRtcTests") {
    from(coreTests) {
        include("com/beeboentertainment/movie/rtc/BeeboRelayTest.kt")
        include("com/beeboentertainment/movie/rtc/RemoteRulesTest.kt")
        include("com/beeboentertainment/movie/rtc/TunnelClientTest.kt")
        include("com/beeboentertainment/movie/rtc/TunnelProtocolTest.kt")
    }
    into(layout.buildDirectory.dir("generated/sharedRtc/test"))
}
android.sourceSets.getByName("main").java.srcDir(syncSharedRtc.map { it.destinationDir })
android.sourceSets.getByName("test").java.srcDir(syncSharedRtcTests.map { it.destinationDir })
tasks.named("preBuild") { dependsOn(syncSharedRtc, syncSharedRtcTests) }

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        freeCompilerArgs.add("-opt-in=androidx.media3.common.util.UnstableApi")
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2026.06.01"))

    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.activity:activity-compose:1.11.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.4")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.ui:ui-tooling-preview")

    implementation("androidx.media3:media3-exoplayer:1.11.0")
    implementation("androidx.media3:media3-session:1.11.0")
    implementation("androidx.media3:media3-datasource-okhttp:1.11.0")

    implementation("com.squareup.okhttp3:okhttp:5.5.0")
    // The away-from-home sign-in (home, username, password) is kept encrypted so the tunnel can
    // sign in again by itself when its 12-hour viewer token runs out. Same as the phone app.
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    // CarConnection: tells a phone app it is projecting to Android Auto, which
    // keeps the watch party's video off on that phone. See drive/VideoGate.kt.
    implementation("androidx.car.app:app:1.7.0")
    // Stage 2 peer-to-peer link to the home PC. Maintained Google WebRTC build
    // (package org.webrtc), pulled from mavenCentral which settings.gradle.kts
    // already declares. See WEBRTC-STAGE2.md.
    implementation("io.github.webrtc-sdk:android:125.6422.07")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("com.google.guava:guava:33.4.8-android")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-guava:1.10.2")

    testImplementation("junit:junit:4.13.2")
}
