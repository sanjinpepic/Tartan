@file:OptIn(ExperimentalMaterial3ExpressiveApi::class)

package dev.freesuunto.app.shell

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.FlowRowScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.RowScope
import androidx.compose.material3.ButtonColors
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ButtonElevation
import androidx.compose.material3.ButtonShapes
import androidx.compose.material3.CheckboxColors
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.ChipShapes
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.IconButtonColors
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.IconButtonShapes
import androidx.compose.material3.RadioButtonColors
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.SelectableChipColors
import androidx.compose.material3.SelectableChipElevation
import androidx.compose.material3.SwitchColors
import androidx.compose.material3.SwitchDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.platform.LocalView
import androidx.compose.material3.Button as M3Button
import androidx.compose.material3.Checkbox as M3Checkbox
import androidx.compose.material3.FilledTonalButton as M3FilledTonalButton
import androidx.compose.material3.FilledTonalIconButton as M3FilledTonalIconButton
import androidx.compose.material3.FilterChip as M3FilterChip
import androidx.compose.material3.IconButton as M3IconButton
import androidx.compose.material3.RadioButton as M3RadioButton
import androidx.compose.material3.Switch as M3Switch
import androidx.compose.material3.TextButton as M3TextButton

/*
 * Material's buttons, switches, checkboxes, radio buttons and chips, each with the click you feel
 * (Feel.kt), as the app's own cards have: the native screens use these, not Material's directly, so
 * every control answers the finger the same way. Same parameters and defaults as Material 1.5.
 * A switch or checkbox turning on gets the fuller click, turning off the lighter one.
 */

@Composable
private fun felt(h: Haptic, f: () -> Unit): () -> Unit { val v = LocalView.current; return { v.feel(h); f() } }

@Composable
private fun feltToggle(f: ((Boolean) -> Unit)?): ((Boolean) -> Unit)? {
    val v = LocalView.current
    return f?.let { { on: Boolean -> v.feel(if (on) Haptic.Click else Haptic.Detent); it(on) } }
}

@Composable
fun Button(onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, shape: Shape = ButtonDefaults.shape, colors: ButtonColors = ButtonDefaults.buttonColors(), elevation: ButtonElevation? = ButtonDefaults.buttonElevation(), border: BorderStroke? = null, contentPadding: PaddingValues = ButtonDefaults.ContentPadding, interactionSource: MutableInteractionSource? = null, content: @Composable RowScope.() -> Unit) =
    M3Button(felt(Haptic.Click, onClick), modifier, enabled, shape, colors, elevation, border, contentPadding, interactionSource, content)

@Composable
fun Button(onClick: () -> Unit, shapes: ButtonShapes, modifier: Modifier = Modifier, enabled: Boolean = true, colors: ButtonColors = ButtonDefaults.buttonColors(), elevation: ButtonElevation? = ButtonDefaults.buttonElevation(), border: BorderStroke? = null, contentPadding: PaddingValues = ButtonDefaults.contentPaddingFor(ButtonDefaults.MinHeight), interactionSource: MutableInteractionSource? = null, content: @Composable RowScope.() -> Unit) =
    M3Button(felt(Haptic.Click, onClick), shapes, modifier, enabled, colors, elevation, border, contentPadding, interactionSource, content)

@Composable
fun FilledTonalButton(onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, shape: Shape = ButtonDefaults.filledTonalShape, colors: ButtonColors = ButtonDefaults.filledTonalButtonColors(), elevation: ButtonElevation? = ButtonDefaults.filledTonalButtonElevation(), border: BorderStroke? = null, contentPadding: PaddingValues = ButtonDefaults.ContentPadding, interactionSource: MutableInteractionSource? = null, content: @Composable RowScope.() -> Unit) =
    M3FilledTonalButton(felt(Haptic.Click, onClick), modifier, enabled, shape, colors, elevation, border, contentPadding, interactionSource, content)

@Composable
fun FilledTonalButton(onClick: () -> Unit, shapes: ButtonShapes, modifier: Modifier = Modifier, enabled: Boolean = true, colors: ButtonColors = ButtonDefaults.filledTonalButtonColors(), elevation: ButtonElevation? = ButtonDefaults.filledTonalButtonElevation(), border: BorderStroke? = null, contentPadding: PaddingValues = ButtonDefaults.contentPaddingFor(ButtonDefaults.MinHeight), interactionSource: MutableInteractionSource? = null, content: @Composable RowScope.() -> Unit) =
    M3FilledTonalButton(felt(Haptic.Click, onClick), shapes, modifier, enabled, colors, elevation, border, contentPadding, interactionSource, content)

@Composable
fun TextButton(onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, shape: Shape = ButtonDefaults.textShape, colors: ButtonColors = ButtonDefaults.textButtonColors(), elevation: ButtonElevation? = null, border: BorderStroke? = null, contentPadding: PaddingValues = ButtonDefaults.TextButtonContentPadding, interactionSource: MutableInteractionSource? = null, content: @Composable RowScope.() -> Unit) =
    M3TextButton(felt(Haptic.Click, onClick), modifier, enabled, shape, colors, elevation, border, contentPadding, interactionSource, content)

@Composable
fun TextButton(onClick: () -> Unit, shapes: ButtonShapes, modifier: Modifier = Modifier, enabled: Boolean = true, colors: ButtonColors = ButtonDefaults.textButtonColors(), elevation: ButtonElevation? = null, border: BorderStroke? = null, contentPadding: PaddingValues = ButtonDefaults.contentPaddingFor(ButtonDefaults.MinHeight), interactionSource: MutableInteractionSource? = null, content: @Composable RowScope.() -> Unit) =
    M3TextButton(felt(Haptic.Click, onClick), shapes, modifier, enabled, colors, elevation, border, contentPadding, interactionSource, content)

@Composable
fun IconButton(onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, colors: IconButtonColors = IconButtonDefaults.iconButtonColors(), interactionSource: MutableInteractionSource? = null, shape: Shape = IconButtonDefaults.standardShape, content: @Composable () -> Unit) =
    M3IconButton(felt(Haptic.Click, onClick), modifier, enabled, colors, interactionSource, shape, content)

@Composable
fun IconButton(onClick: () -> Unit, shapes: IconButtonShapes, modifier: Modifier = Modifier, enabled: Boolean = true, colors: IconButtonColors = IconButtonDefaults.iconButtonColors(), interactionSource: MutableInteractionSource? = null, content: @Composable () -> Unit) =
    M3IconButton(felt(Haptic.Click, onClick), shapes, modifier, enabled, colors, interactionSource, content)

@Composable
fun FilledTonalIconButton(onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, shape: Shape = IconButtonDefaults.filledShape, colors: IconButtonColors = IconButtonDefaults.filledTonalIconButtonColors(), interactionSource: MutableInteractionSource? = null, content: @Composable () -> Unit) =
    M3FilledTonalIconButton(felt(Haptic.Click, onClick), modifier, enabled, shape, colors, interactionSource, content)

@Composable
fun FilledTonalIconButton(onClick: () -> Unit, shapes: IconButtonShapes, modifier: Modifier = Modifier, enabled: Boolean = true, colors: IconButtonColors = IconButtonDefaults.filledTonalIconButtonColors(), interactionSource: MutableInteractionSource? = null, content: @Composable () -> Unit) =
    M3FilledTonalIconButton(felt(Haptic.Click, onClick), shapes, modifier, enabled, colors, interactionSource, content)

@Composable
fun Switch(checked: Boolean, onCheckedChange: ((Boolean) -> Unit)?, modifier: Modifier = Modifier, thumbContent: (@Composable () -> Unit)? = null, enabled: Boolean = true, colors: SwitchColors = SwitchDefaults.colors(), interactionSource: MutableInteractionSource? = null) =
    M3Switch(checked, feltToggle(onCheckedChange), modifier, thumbContent, enabled, colors, interactionSource)

@Composable
fun Checkbox(checked: Boolean, onCheckedChange: ((Boolean) -> Unit)?, modifier: Modifier = Modifier, enabled: Boolean = true, colors: CheckboxColors = CheckboxDefaults.colors(), interactionSource: MutableInteractionSource? = null) =
    M3Checkbox(checked, feltToggle(onCheckedChange), modifier, enabled, colors, interactionSource)

@Composable
fun RadioButton(selected: Boolean, onClick: (() -> Unit)?, modifier: Modifier = Modifier, enabled: Boolean = true, colors: RadioButtonColors = RadioButtonDefaults.colors(), interactionSource: MutableInteractionSource? = null) {
    val v = LocalView.current
    M3RadioButton(selected, onClick?.let { { v.feel(Haptic.Click); it() } }, modifier, enabled, colors, interactionSource)
}

@Composable
fun FilterChip(selected: Boolean, onClick: () -> Unit, label: @Composable () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, leadingIcon: @Composable (() -> Unit)? = null, trailingIcon: @Composable (() -> Unit)? = null, shape: Shape = FilterChipDefaults.shape, colors: SelectableChipColors = FilterChipDefaults.filterChipColors(), elevation: SelectableChipElevation? = FilterChipDefaults.filterChipElevation(), border: BorderStroke? = FilterChipDefaults.filterChipBorder(enabled, selected), horizontalArrangement: Arrangement.Horizontal = FilterChipDefaults.horizontalArrangement(), contentPadding: PaddingValues = FilterChipDefaults.ContentPadding, interactionSource: MutableInteractionSource? = null) =
    M3FilterChip(selected, felt(if (selected) Haptic.Detent else Haptic.Click, onClick), label, modifier, enabled, leadingIcon, trailingIcon, shape, colors, elevation, border, horizontalArrangement, contentPadding, interactionSource)

@Composable
fun FilterChip(selected: Boolean, onClick: () -> Unit, label: @Composable () -> Unit, shapes: ChipShapes, modifier: Modifier = Modifier, enabled: Boolean = true, leadingIcon: @Composable (() -> Unit)? = null, trailingIcon: @Composable (() -> Unit)? = null, colors: SelectableChipColors = FilterChipDefaults.tonalFilterChipColors(), elevation: SelectableChipElevation? = FilterChipDefaults.filterChipElevation(), border: BorderStroke? = FilterChipDefaults.filterChipBorder(enabled, selected), horizontalArrangement: Arrangement.Horizontal = FilterChipDefaults.horizontalArrangement(leadingIcon != null, trailingIcon != null), contentPadding: PaddingValues = FilterChipDefaults.ContentPadding, interactionSource: MutableInteractionSource? = null) =
    M3FilterChip(selected, felt(if (selected) Haptic.Detent else Haptic.Click, onClick), label, shapes, modifier, enabled, leadingIcon, trailingIcon, colors, elevation, border, horizontalArrangement, contentPadding, interactionSource)

/**
 * Buttons side by side that wrap: when a narrow card or large text leaves no room, the next button
 * drops to the line below instead of squeezing the one before it to a letter or two a line.
 */
@Composable
fun ButtonFlow(modifier: Modifier = Modifier, gap: Dp = 8.dp, content: @Composable FlowRowScope.() -> Unit) {
    FlowRow(modifier, horizontalArrangement = Arrangement.spacedBy(gap), verticalArrangement = Arrangement.spacedBy(4.dp), itemVerticalAlignment = Alignment.CenterVertically, content = content)
}

/** A button's words on one line (in a ButtonFlow it moves down a line instead). */
@Composable
fun ButtonText(text: String, color: Color = Color.Unspecified) {
    androidx.compose.material3.Text(text, color = color, maxLines = 1, overflow = TextOverflow.Ellipsis)
}
