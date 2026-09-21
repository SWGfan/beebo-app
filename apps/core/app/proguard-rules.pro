# --- kotlinx.serialization (the app's models rely on generated serializers) ---
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keepclassmembers class kotlinx.serialization.json.** { *** Companion; }
-keepclasseswithmembers class kotlinx.serialization.json.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class com.beeboentertainment.movie.**$$serializer { *; }
-keepclassmembers class com.beeboentertainment.movie.** { *** Companion; }
-keepclasseswithmembers class com.beeboentertainment.movie.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-keepclassmembers @kotlinx.serialization.Serializable class com.beeboentertainment.movie.** {
    <fields>;
}

# --- entry points the framework instantiates by name (manifest/services/cast) ---
-keep class com.beeboentertainment.movie.** extends android.app.Application { *; }
-keep class com.beeboentertainment.movie.** extends android.app.Activity
-keep class com.beeboentertainment.movie.** extends android.app.Service
-keep class com.beeboentertainment.movie.** extends android.content.ContentProvider
# Cast + Media3 provider/session classes are reached reflectively — keep the whole player package.
-keep class com.beeboentertainment.movie.player.** { *; }

# --- WebRTC (JNI/reflection heavy) ---
-keep class org.webrtc.** { *; }
-dontwarn org.webrtc.**

# --- silence stragglers from libs that ship their own rules ---
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
