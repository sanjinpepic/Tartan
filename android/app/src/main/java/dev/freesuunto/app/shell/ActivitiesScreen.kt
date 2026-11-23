package dev.freesuunto.app.shell

import androidx.compose.ui.res.stringResource
import dev.freesuunto.app.R
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import java.time.format.DateTimeFormatter
import java.util.Locale

private val FILTERS get() = listOf("all" to str(R.string.activities_all), "run" to str(R.string.activities_runs), "ride" to str(R.string.activities_rides), "other" to str(R.string.common_other))

/** What Activities asks of the app: a workout's sheet, another screen. */
interface ActivitiesActions {
    fun openActivity(id: String)
    fun go(hash: String)
}

/**
 * Activities, native (the web's renderActivities): every workout once, by week with its totals,
 * searchable, filtered by sport; Workouts and Routes as a switch at the top (Routes, with its map,
 * is still the web's). A row opens the workout's sheet. Weeks fade and move as the filter changes.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun ActivitiesScreen(all: List<Act>?, actions: ActivitiesActions, navSpace: Boolean = true) {
    val cs = MaterialTheme.colorScheme
    val top = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    val bottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    var filter by rememberSaveable { mutableStateOf(0) }
    var query by rememberSaveable { mutableStateOf("") }
    val list = rememberLazyListState()

    Box(Modifier.fillMaxSize().background(cs.surface)) {
        val (groups, total) = remember(filter, query, all) { if (all == null) emptyList<ActWeek>() to 0 else weeks(all, FILTERS[filter].first, query) }
        LazyColumn(
            state = list,
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = top + 60.dp, bottom = bottom + if (navSpace) 104.dp else 24.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            item(key = "head") {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.padding(bottom = 4.dp)) {
                    // Routes alongside once you have one (src/in-use.ts); until then under Settings → More → More tools.
                    val routes = LocalInUse.current.routes
                    PageHeader(stringResource(R.string.common_activities), subtitle = stringResource(if (routes) R.string.common_every_workout_once_and_your_routes else R.string.activities_every_workout_once))
                    if (routes) Segmented(listOf(stringResource(R.string.common_workouts_title), stringResource(R.string.common_routes)), 0, { if (it == 1) actions.go("routes") })
                    Search(query) { query = it }
                    Segmented(FILTERS.map { it.second }, filter, { filter = it })
                }
            }
            when {
                all == null -> item { Box(Modifier.fillMaxWidth().heightIn(min = 240.dp), contentAlignment = Alignment.Center) { LoadingIndicator(Modifier.size(64.dp)) } }
                groups.isEmpty() -> item(key = "empty") { Empty(all.isEmpty(), actions, Modifier.animateItem()) }
                else -> {
                    // Weeks fade and move into place as the filter or the search changes them.
                    groups.forEachIndexed { i, w ->
                        item(key = "w${w.monday}") { Week(w, actions, Modifier.animateItem().reveal(i)) }
                    }
                    if (total > 400) item(key = "more") { Text(stringResource(R.string.activities_showing_the_latest_400_of_search, total), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp)) }
                }
            }
        }
        TopScrim(list.firstVisibleItemIndex > 0 || list.firstVisibleItemScrollOffset > 0)
    }
}

@Composable
private fun Search(query: String, onChange: (String) -> Unit) {
    val cs = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth().height(48.dp).clip(CircleShape).background(cs.surfaceContainerHigh).padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(Glyphs["search"], null, Modifier.size(20.dp), tint = cs.onSurfaceVariant)
        Spacer(Modifier.width(12.dp))
        Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
            if (query.isEmpty()) Text(stringResource(R.string.activities_search_workouts), color = cs.onSurfaceVariant, style = MaterialTheme.typography.bodyLarge)
            BasicTextField(
                query, onChange, Modifier.fillMaxWidth(), singleLine = true,
                textStyle = MaterialTheme.typography.bodyLarge.copy(color = cs.onSurface), cursorBrush = SolidColor(cs.primary),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            )
        }
        if (query.isNotEmpty()) {
            Box(Modifier.size(32.dp).press(label = stringResource(R.string.activities_clear_the_search), onClick = { onChange("") }), contentAlignment = Alignment.Center) {
                Icon(Glyphs["plus"], null, Modifier.size(18.dp).graphicsLayer { rotationZ = 45f }, tint = cs.onSurfaceVariant)
            }
        }
    }
}

private val WEEK_OF = DateTimeFormatter.ofPattern("d MMM", Locale.getDefault())

/** A week: its head (when, how far, how long), then its workouts as tiles (24dp at the ends, 6dp between). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Week(w: ActWeek, actions: ActivitiesActions, modifier: Modifier) {
    val cs = MaterialTheme.colorScheme
    Column(modifier.padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 4.dp, bottom = 8.dp), verticalAlignment = Alignment.Bottom) {
            Text(if (w.monday == java.time.LocalDate.MIN) stringResource(R.string.activities_undated) else stringResource(R.string.activities_week_of, w.monday.format(WEEK_OF)), style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
            Text(stringResource(R.string.activities_km_2, km(w.km, 1), duration(w.minutes)), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
        }
        w.acts.forEachIndexed { i, a ->
            val first = i == 0
            val last = i == w.acts.lastIndex
            Row(
                Modifier
                    .fillMaxWidth()
                    .press(scale = 0.98f, label = a.name, onClick = { actions.openActivity(a.id) })
                    .clip(RoundedCornerShape(if (first) 24.dp else 6.dp, if (first) 24.dp else 6.dp, if (last) 24.dp else 6.dp, if (last) 24.dp else 6.dp))
                    .background(cs.surfaceContainer)
                    .padding(horizontal = 14.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.size(44.dp).clip(RoundedCornerShape(14.dp)).background(cs.primaryContainer), contentAlignment = Alignment.Center) {
                    Icon(Glyphs.sport(a.sport), null, Modifier.size(22.dp), tint = cs.onPrimaryContainer)
                }
                Spacer(Modifier.width(14.dp))
                Column(Modifier.weight(1f)) {
                    Text(a.name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    // When, where from, and the weather it was in: on the one line while it fits, else the weather below.
                    FlowRow(verticalArrangement = Arrangement.spacedBy(2.dp), itemVerticalAlignment = Alignment.CenterVertically) {
                        Text(a.whenText, style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
                        Spacer(Modifier.width(6.dp))
                        Sources(a.sources)
                        a.weather?.let { w ->
                            Spacer(Modifier.width(8.dp))
                            WeatherInline(w, MaterialTheme.typography.bodySmall, cs.onSurfaceVariant)
                        }
                    }
                }
                Spacer(Modifier.width(8.dp))
                Column(horizontalAlignment = Alignment.End) {
                    Text(a.big, style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight(750)))
                    if (a.small.isNotEmpty()) Text(a.small, style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
                }
            }
        }
    }
}

/** Where a workout came from: one small badge per source (two or more: one merged workout). */
@Composable
private fun Sources(sources: List<String>) {
    val cs = MaterialTheme.colorScheme
    val data = LocalData.current
    Row(Modifier.clip(CircleShape).background(if (sources.size > 1) data.goodContainer else cs.surfaceContainerHigh).padding(horizontal = 5.dp, vertical = 2.dp), horizontalArrangement = Arrangement.spacedBy(3.dp)) {
        sources.distinct().forEach { s ->
            Icon(Glyphs[when (s) { "strava" -> "strava"; "watch" -> "watch"; "phone" -> "phone"; else -> "folder" }], s, Modifier.size(12.dp), tint = if (s == "strava") data.good else cs.onSurfaceVariant)
        }
    }
}

@Composable
private fun Empty(none: Boolean, actions: ActivitiesActions, modifier: Modifier) {
    val cs = MaterialTheme.colorScheme
    Column(modifier.fillMaxWidth().clip(RoundedCornerShape(28.dp)).background(cs.surfaceContainer).padding(24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(if (none) stringResource(R.string.activities_no_workouts_yet) else stringResource(R.string.activities_nothing_matches), style = MaterialTheme.typography.titleLarge)
        Text(if (none) stringResource(R.string.activities_connect_strava_for_your_full_history) else stringResource(R.string.activities_try_another_search_or_sport), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
        if (none) FilledTonalButton(onClick = { actions.go("settings") }) { Text(stringResource(R.string.activities_connect_strava_or_the_watch)) }
    }
}
