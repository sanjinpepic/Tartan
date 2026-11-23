package dev.freesuunto.app.shell

import androidx.compose.ui.res.stringResource
import dev.freesuunto.app.R
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

/**
 * The sync board, tapped (web/views/board.ts): each source's lane in words (when it last came in,
 * or what went wrong and what to try), a button to sync it now, and when Tartan syncs by itself.
 */
@Composable
fun BoardSheet(lanes: List<Lane>, onSync: (String) -> Unit, onClose: () -> Unit) {
    Sheet(onClose) { close -> BoardBody(lanes, onSync, close) }
}

/** The board's content (tested on its own: Robolectric draws no dialog windows). */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun BoardBody(lanes: List<Lane>, onSync: (String) -> Unit, close: () -> Unit, modifier: Modifier = Modifier) {
    val cs = MaterialTheme.colorScheme
    val view = LocalView.current
    Column(modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 24.dp).navigationBarsPadding(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f)) {
                Text(stringResource(R.string.common_your_data), style = MaterialTheme.typography.headlineSmall, modifier = Modifier.semantics { heading() })
                Text(stringResource(R.string.board_where_your_workouts_come_in_from), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
            }
            FilledTonalIconButton(onClick = close) { Icon(Glyphs["close"], stringResource(R.string.common_close)) }
        }
        lanes.forEach { l ->
            val busy = l.state == "busy"
            val tone by animateColorAsState(if (l.failed) cs.errorContainer else if (busy) cs.secondaryContainer else cs.surfaceContainer, label = "lane")
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(24.dp)).background(tone).padding(16.dp).animateContentSize(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(44.dp).clip(RoundedCornerShape(if (busy) 22.dp else 14.dp)).background(if (l.failed) cs.error else cs.primaryContainer), contentAlignment = Alignment.Center) {
                        if (busy) LoadingIndicator(Modifier.size(28.dp), color = cs.onPrimaryContainer)
                        else Icon(Glyphs[if (l.failed) "warn" else l.id], null, Modifier.size(22.dp), tint = if (l.failed) cs.onError else cs.onPrimaryContainer)
                    }
                    Column(Modifier.weight(1f).padding(start = 14.dp)) {
                        Text(l.name.ifEmpty { l.id.replaceFirstChar { it.uppercase() } }, style = MaterialTheme.typography.titleMedium, color = if (l.failed) cs.onErrorContainer else cs.onSurface)
                        Text(l.status, style = MaterialTheme.typography.bodyMedium, color = if (l.failed) cs.onErrorContainer else cs.onSurfaceVariant)
                    }
                }
                val go = { view.feel(Haptic.Click); onSync(l.id) }
                if (l.failed) Button(onClick = go, enabled = !busy, modifier = Modifier.fillMaxWidth(), shapes = ButtonDefaults.shapes()) { Text(stringResource(R.string.common_try_again)) }
                else FilledTonalButton(onClick = go, enabled = !busy, modifier = Modifier.fillMaxWidth(), shapes = ButtonDefaults.shapes()) { Text(if (busy) stringResource(R.string.board_syncing) else stringResource(R.string.common_sync_now)) }
            }
        }
        Row(verticalAlignment = Alignment.Top) {
            Icon(Glyphs["clock"], null, Modifier.padding(top = 2.dp).size(16.dp), tint = cs.onSurfaceVariant)
            Spacer(Modifier.width(8.dp))
            Text(stringResource(R.string.board_tartan_syncs_by_itself_when_you), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
        }
    }
}
