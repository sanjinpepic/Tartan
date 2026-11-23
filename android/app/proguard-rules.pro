# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# Model Hub's API: its AIDL interfaces are looked up by name across processes.
-keep class dev.modelhub.api.** { *; }

# ---------------------------------------------------------------- Tartan (R8: the public build only)
# Kept so the stack traces in the activity log still say where.
-keepattributes SourceFile,LineNumberTable,*Annotation*,Signature,InnerClasses,EnclosingMethod

# The app's Capacitor plugins (dev.freesuunto.app and .shell): Capacitor finds them by class and
# their @PluginMethod / @PermissionCallback methods by name. Capacitor's own consumer rules keep
# every Plugin subclass; these say it for ours in case those ever change.
-keep @com.getcapacitor.annotation.CapacitorPlugin public class dev.freesuunto.app.** { *; }
-keep public class dev.freesuunto.app.** extends com.getcapacitor.Plugin { *; }
-keep class dev.freesuunto.app.MainActivity { *; }

# Capacitor's bridge and the plugins it lists in assets/capacitor.plugins.json, made by name.
-keep class com.getcapacitor.** { *; }
-keep class com.capacitorjs.plugins.** { *; }
-keep class * extends com.getcapacitor.Plugin { *; }
-keepclassmembers class * { @android.webkit.JavascriptInterface <methods>; }

# Health Connect: its record types are passed as classes (KClass) and read back by the platform.
-keep class androidx.health.connect.client.records.** { *; }

# MapLibre: its native code calls Java by name (its own rules cover most; native methods too).
-keepclasseswithmembernames class org.maplibre.** { native <methods>; }

# CameraX and ZXing: nothing by name, but quiet the warnings for optional parts.
-dontwarn com.google.zxing.**
-dontwarn javax.annotation.**
-dontwarn com.google.errorprone.annotations.**
-dontwarn org.checkerframework.**
-dontwarn com.google.j2objc.annotations.**


# Garmin's Connect IQ companion SDK: its AIDL service and the message serialiser (by name, and
# bound by Garmin Connect from outside).
-keep class com.garmin.android.connectiq.** { *; }
-keep class com.garmin.android.apps.connectmobile.connectiq.** { *; }
-keep class com.garmin.monkeybrains.serialization.** { *; }
-dontwarn com.garmin.**
