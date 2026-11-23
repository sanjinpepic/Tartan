package dev.freesuunto.app.shell

import androidx.compose.ui.res.stringResource
import dev.freesuunto.app.R
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

/**
 * A page's head, the same on every page: where back goes (a "‹ Coach" link, tall enough to tap),
 * the title, a line under it, and what sits at its right (Today's Record). Pages put their own
 * tabs, search and buttons after it.
 */
@Composable
fun PageHeader(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    back: Pair<String, () -> Unit>? = null,
    trailing: (@Composable RowScope.() -> Unit)? = null,
) {
    val cs = MaterialTheme.colorScheme
    Column(modifier.fillMaxWidth()) {
        back?.let { (label, go) ->
            Row(Modifier.heightIn(min = 48.dp).press(label = stringResource(R.string.page_back_to, label), onClick = go).padding(end = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Glyphs["chevron"], null, Modifier.size(18.dp).graphicsLayer { rotationZ = 180f }, tint = cs.primary)
                Text(label, style = MaterialTheme.typography.labelLarge, color = cs.primary)
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.headlineLarge, modifier = Modifier.semantics { heading() })
                subtitle?.let { Text(it, style = MaterialTheme.typography.bodyLarge, color = cs.onSurfaceVariant) }
            }
            trailing?.invoke(this)
        }
    }
}
