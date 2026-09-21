# kotlinx-serialization generates its serializers at compile time, but R8 still
# needs to keep the synthetic Companion.serializer() entry points and the
# @Serializable classes' field names, since the JSON field names come from them.
-keepattributes *Annotation*, InnerClasses, Signature, RuntimeVisibleAnnotations
-dontnote kotlinx.serialization.**

-keepclassmembers class kotlinx.serialization.json.** {
    *** Companion;
}
-keepclasseswithmembers class kotlinx.serialization.json.** {
    kotlinx.serialization.KSerializer serializer(...);
}

-keep,includedescriptorclasses class com.beeboentertainment.auto.**$$serializer { *; }
-keepclassmembers class com.beeboentertainment.auto.** {
    *** Companion;
}
-keepclasseswithmembers class com.beeboentertainment.auto.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-keepclassmembers @kotlinx.serialization.Serializable class com.beeboentertainment.auto.** {
    <fields>;
}

# Entry points the system instantiates by name from the manifest.
-keep class com.beeboentertainment.auto.App
-keep class com.beeboentertainment.auto.ui.MainActivity
-keep class com.beeboentertainment.auto.media.PlaybackService
-keep class com.beeboentertainment.auto.media.ArtworkProvider

# OkHttp pulls these in on the JVM only; they are absent on Android.
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# --- Test build: keep JNI/reflection-heavy libs so R8 doesn't break them ---
-keep class org.webrtc.** { *; }
-dontwarn org.webrtc.**
