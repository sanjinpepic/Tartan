package dev.freesuunto.app.shell

import android.content.Context
import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialExpressiveTheme
import androidx.compose.material3.MotionScheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import dev.freesuunto.app.R

/**
 * Tartan's design system in Compose: the same tokens as web/styles.css (DESIGN.md), so a native
 * screen and a web one side by side read as one app. Material You from the wallpaper unless
 * Settings → More → Colours says Tartan; the data colours (Pace Blue, Effort Orange, the status
 * set) never follow the wallpaper.
 */

/** Tartan's own scheme: Material roles from the track-tartan seed (the web's :root). */
private val TartanLight = lightColorScheme(
    primary = Color(0xFFA8321F), onPrimary = Color.White,
    primaryContainer = Color(0xFFFFDAD2), onPrimaryContainer = Color(0xFF3D0700),
    secondaryContainer = Color(0xFFF7DDD6), onSecondaryContainer = Color(0xFF2C1511),
    inverseSurface = Color(0xFF362F2D), inverseOnSurface = Color(0xFFFBEEEB), inversePrimary = Color(0xFFFFB4A5),
    background = Color(0xFFFFF8F6), surface = Color(0xFFFFF8F6),
    surfaceContainerLowest = Color(0xFFFFFFFF), surfaceContainerLow = Color(0xFFFEF0EC),
    surfaceContainer = Color(0xFFFCEAE6), surfaceContainerHigh = Color(0xFFF1DFDB), surfaceContainerHighest = Color(0xFFE8D6D3),
    surfaceDim = Color(0xFFE8D6D3),
    onSurface = Color(0xFF201A19), onSurfaceVariant = Color(0xFF534341), outline = Color(0xFF7A6966), outlineVariant = Color(0xFFD8C2BE),
    error = Color(0xFFBA1A1A), errorContainer = Color(0xFFFFDAD6), onErrorContainer = Color(0xFF410002),
)

private val TartanDark = darkColorScheme(
    primary = Color(0xFFFFB4A5), onPrimary = Color(0xFF5F1200),
    primaryContainer = Color(0xFF872013), onPrimaryContainer = Color(0xFFFFDAD2),
    secondaryContainer = Color(0xFF3E302D), onSecondaryContainer = Color(0xFFFFCBBF),
    inverseSurface = Color(0xFFEDE0DD), inverseOnSurface = Color(0xFF362F2D), inversePrimary = Color(0xFFA8321F),
    background = Color(0xFF1A1110), surface = Color(0xFF1A1110),
    surfaceContainerLowest = Color(0xFF140C0B), surfaceContainerLow = Color(0xFF221918),
    surfaceContainer = Color(0xFF271D1C), surfaceContainerHigh = Color(0xFF322826), surfaceContainerHighest = Color(0xFF3D3230),
    surfaceDim = Color(0xFF1A1110),
    onSurface = Color(0xFFEDE0DD), onSurfaceVariant = Color(0xFFD8C2BE), outline = Color(0xFFA08C89), outlineVariant = Color(0xFF534341),
    error = Color(0xFFFFB4AB), errorContainer = Color(0xFF93000A), onErrorContainer = Color(0xFFFFDAD6),
)

/** The data and status colours: Tartan's whatever the wallpaper (The Series Owns Its Hue Rule). */
data class DataColours(val pace: Color, val effort: Color, val good: Color, val goodContainer: Color, val watch: Color, val watchContainer: Color)

private val DataLight = DataColours(Color(0xFF2A78D6), Color(0xFFEB6834), Color(0xFF1D6B45), Color(0xFFD3F0DD), Color(0xFF7A4F00), Color(0xFFFFE4B8))
private val DataDark = DataColours(Color(0xFF3987E5), Color(0xFFD95926), Color(0xFF7FD6A1), Color(0xFF0F3D26), Color(0xFFF3BD5C), Color(0xFF4A3400))

val LocalData = staticCompositionLocalOf { DataLight }

/** Google Sans Flex at a weight and roundness (ROND 0–100): a little round for text, fully for headings. */
@OptIn(ExperimentalTextApi::class)
private fun flex(weight: Int, round: Float) = Font(
    R.font.google_sans_flex,
    FontWeight(weight),
    variationSettings = FontVariation.Settings(FontVariation.weight(weight), FontVariation.Setting("ROND", round)),
)

/** Body text: ROND 20, as the web's body. */
val Flex = FontFamily(flex(400, 20f), flex(500, 20f), flex(600, 20f), flex(650, 20f), flex(700, 20f))
/** Headings and figures: fully round (ROND 100). */
val FlexRound = FontFamily(flex(600, 100f), flex(700, 100f), flex(800, 100f), flex(850, 100f))
/** Numbers in columns: the timing board's condensed face. */
val Condensed = FontFamily(Font(R.font.barlow_condensed_600, FontWeight.SemiBold))

/**
 * The timing board's numerals (DESIGN.md "figure"): every measured number, Barlow Condensed with
 * tabular figures, at four steps; units beside them stay in Flex.
 */
object Figure {
    private fun step(size: Int, line: Int) = androidx.compose.ui.text.TextStyle(fontFamily = Condensed, fontWeight = FontWeight.SemiBold, fontSize = size.sp, lineHeight = line.sp, fontFeatureSettings = "tnum")
    /** Record's clock and distance. */
    val XL = step(56, 56)
    /** The week ring. */
    val L = step(44, 44)
    /** Tiles: a workout's and a session's numbers, vitals. */
    val M = step(30, 32)
    /** Small cells and the numbers you type in Lift. */
    val S = step(24, 26)
}

private val Type = Typography().let { t ->
    fun TextStyle.flex() = copy(fontFamily = Flex)
    fun TextStyle.round(w: Int) = copy(fontFamily = FlexRound, fontWeight = FontWeight(w))
    Typography(
        displayLarge = t.displayLarge.round(800), displayMedium = t.displayMedium.round(800), displaySmall = t.displaySmall.round(800),
        headlineLarge = t.headlineLarge.round(800).copy(fontSize = 34.sp, lineHeight = 40.sp, letterSpacing = (-0.5).sp),
        headlineMedium = t.headlineMedium.round(750), headlineSmall = t.headlineSmall.round(700),
        titleLarge = t.titleLarge.round(700), titleMedium = t.titleMedium.flex().copy(fontWeight = FontWeight(650)), titleSmall = t.titleSmall.flex().copy(fontWeight = FontWeight(650)),
        bodyLarge = t.bodyLarge.flex(), bodyMedium = t.bodyMedium.flex(), bodySmall = t.bodySmall.flex(),
        labelLarge = t.labelLarge.flex().copy(fontWeight = FontWeight(650)), labelMedium = t.labelMedium.flex().copy(fontWeight = FontWeight(600)), labelSmall = t.labelSmall.flex(),
    )
}

/** Which colours: the wallpaper's (Android 12+) or Tartan's, as Settings → More → Colours says. */
fun scheme(context: Context, dark: Boolean, wallpaper: Boolean): ColorScheme =
    if (wallpaper && Build.VERSION.SDK_INT >= 31) {
        if (dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
    } else if (dark) TartanDark else TartanLight

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun TartanTheme(wallpaper: Boolean, reducedMotion: Boolean = false, dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val colours = scheme(LocalContext.current, dark, wallpaper)
    CompositionLocalProvider(LocalData provides if (dark) DataDark else DataLight, LocalReducedMotion provides reducedMotion) {
        MaterialExpressiveTheme(
            colorScheme = colours,
            // Springs that overshoot a little for movement and shape; with reduced motion, the plain ones.
            motionScheme = if (reducedMotion) MotionScheme.standard() else MotionScheme.expressive(),
            typography = Type,
        ) {
            // Text and icons not inside a Surface take the page's ink (else they'd be black in dark mode).
            CompositionLocalProvider(LocalContentColor provides colours.onSurface, content = content)
        }
    }
}

/**
 * A surface that sits up off the card it's on (a text field, the chat's composer): white in light,
 * the lightest container in dark (the "lowest" one there is near black).
 */
val androidx.compose.material3.ColorScheme.raised: Color
    get() = if (surface.luminance() > 0.5f) surfaceContainerLowest else surfaceContainerHighest
