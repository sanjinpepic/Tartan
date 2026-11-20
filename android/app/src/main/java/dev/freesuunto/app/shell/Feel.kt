package dev.freesuunto.app.shell

import android.content.Context
import android.os.Build
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.view.HapticFeedbackConstants
import android.view.View
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

/**
 * How Tartan 2 feels: what you feel under your finger and how things move.
 *
 * Haptics are short and low, a mechanical click rather than a buzz: Android's low tick primitive
 * (a deep, very short pulse the Pixel's actuator plays crisply), lighter for each tab you slide
 * past and fuller for the one you land on. They play as touch feedback, so the phone's own
 * vibration setting turns them down or off. Phones without primitives get the nearest view
 * haptic. Every control has one: the cards through [press], Material's buttons, switches,
 * checkboxes, radio buttons and chips through Buttons.kt.
 */
enum class Haptic { Detent, Click, Confirm }

private fun vibrator(c: Context): Vibrator? =
    if (Build.VERSION.SDK_INT >= 31) c.getSystemService(VibratorManager::class.java)?.defaultVibrator
    else @Suppress("DEPRECATION") c.getSystemService(Vibrator::class.java)

fun View.feel(h: Haptic) {
    val (primitive, scale) = when (h) {
        Haptic.Detent -> VibrationEffect.Composition.PRIMITIVE_LOW_TICK to 0.6f
        Haptic.Click -> VibrationEffect.Composition.PRIMITIVE_LOW_TICK to 1f
        Haptic.Confirm -> VibrationEffect.Composition.PRIMITIVE_CLICK to 0.6f
    }
    val v = runCatching { vibrator(context) }.getOrNull()
    if (Build.VERSION.SDK_INT >= 31 && v != null && v.hasVibrator() && v.areAllPrimitivesSupported(primitive)) {
        val effect = VibrationEffect.startComposition().addPrimitive(primitive, scale).compose()
        runCatching {
            if (Build.VERSION.SDK_INT >= 33) v.vibrate(effect, VibrationAttributes.createForUsage(VibrationAttributes.USAGE_TOUCH))
            else v.vibrate(effect)
        }
        return
    }
    performHapticFeedback(
        when (h) {
            Haptic.Detent -> if (Build.VERSION.SDK_INT >= 34) HapticFeedbackConstants.SEGMENT_FREQUENT_TICK else HapticFeedbackConstants.CLOCK_TICK
            Haptic.Click -> if (Build.VERSION.SDK_INT >= 34) HapticFeedbackConstants.SEGMENT_TICK else HapticFeedbackConstants.VIRTUAL_KEY
            Haptic.Confirm -> if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY
        },
    )
}

/**
 * A tap the expressive way: the thing itself squashes a little while pressed and springs back
 * (no ripple), with a click you feel. Every card and button on the native screens goes through here.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun Modifier.press(scale: Float = 0.96f, role: Role = Role.Button, label: String? = null, onClick: () -> Unit): Modifier {
    val src = remember { MutableInteractionSource() }
    val pressed by src.collectIsPressedAsState()
    val view = LocalView.current
    val k by animateFloatAsState(if (pressed) scale else 1f, MaterialTheme.motionScheme.fastSpatialSpec(), label = "press")
    return graphicsLayer { scaleX = k; scaleY = k }
        .clickable(src, indication = null, role = role, onClickLabel = label) { view.feel(Haptic.Click); onClick() }
}

/**
 * Cards arrive one after another: each rises 24dp and fades in on the slow spring, 50ms after
 * the one before (the first eight; later ones are already below the fold). Once per visit.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun Modifier.reveal(index: Int): Modifier {
    var done by rememberSaveable { mutableStateOf(false) }
    val p = remember { Animatable(if (done) 1f else 0f) }
    val spec = MaterialTheme.motionScheme.slowSpatialSpec<Float>()
    LaunchedEffect(Unit) {
        if (done) return@LaunchedEffect
        delay(index.coerceIn(0, 8) * 50L)
        p.animateTo(1f, spec)
        done = true
    }
    return graphicsLayer {
        alpha = p.value.coerceIn(0f, 1f)
        translationY = (1f - p.value) * 24.dp.toPx()
    }
}

/**
 * Under the floating sync chip and gear: the page's surface, solid behind them (they sit from 8 to
 * 52dp below the status bar) and fading out just below, so what scrolls up passes under them
 * cleanly instead of running into them.
 */
@Composable
fun TopScrim(scrolled: Boolean, modifier: Modifier = Modifier) {
    val cs = MaterialTheme.colorScheme
    // Only once the page has moved: at rest the title sits where the fade would be.
    val shown by animateFloatAsState(if (scrolled) 1f else 0f, label = "scrim")
    val top = androidx.compose.foundation.layout.WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    val end = top + 68.dp
    androidx.compose.foundation.layout.Box(
        modifier.fillMaxWidth().height(end).graphicsLayer { alpha = shown }.background(
            androidx.compose.ui.graphics.Brush.verticalGradient(
                0f to cs.surface.copy(alpha = 0.96f),
                ((top + 44.dp) / end) to cs.surface.copy(alpha = 0.92f),
                1f to cs.surface.copy(alpha = 0f),
            ),
        ),
    )
}
