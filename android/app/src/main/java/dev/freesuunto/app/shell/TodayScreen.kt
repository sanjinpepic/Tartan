package dev.freesuunto.app.shell

import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import dev.freesuunto.app.R
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.togetherWith
import androidx.compose.runtime.setValue

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularWavyProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.WavyProgressIndicatorDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.PullToRefreshDefaults
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale

/** What Today can ask of the web app: open a screen (a hash) or a workout's sheet. */
interface TodayActions {
    fun go(hash: String)
    fun openActivity(id: String)
    /** A run just in ("Just in"): its sheet at its moments on the map, when it has some. */
    fun openRun(id: String) = openActivity(id)
    /** A day's session in its own sheet (details, mark done, ask the coach). */
    fun openSession(date: String, kind: String)
    /** The sync board in words, with Sync now (the web's board sheet). */
    fun openBoard()
    fun refresh()
    /** Out of the demo: the sample deleted, back to your own data. */
    fun leaveDemo() {}
    /** The coach's chat (from Tartan's T in the header). */
    fun chat() {}
}

private val CARD = RoundedCornerShape(28.dp)

/**
 * Today, native: how you are right now. The same cards as the web Today (DESIGN.md) in the
 * same order when there's a plan (today's session, how you are, the week, the last workout, then
 * what's worth knowing), with the week as a wavy ring filling toward its target.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun TodayScreen(today: Today?, refreshing: Boolean, actions: TodayActions, date: LocalDate = LocalDate.now(), navSpace: Boolean = true, onFolded: (Boolean) -> Unit = {}, onPull: (Float) -> Unit = {}, more: TodayModel? = null) {
    val cs = MaterialTheme.colorScheme
    val top = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    val bottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    val pull = rememberPullToRefreshState()
    val scroll = rememberScrollState()
    // The board reads in full under Today's title; once the title has scrolled away it folds to its dots, as on the web.
    val folded by androidx.compose.runtime.remember { androidx.compose.runtime.derivedStateOf { scroll.value > 140 } }
    androidx.compose.runtime.LaunchedEffect(folded) { onFolded(folded) }
    // Pulling down to sync shows in the sync board itself (nothing drops from under the status
    // bar): how far, and a click when letting go will sync.
    val view = androidx.compose.ui.platform.LocalView.current
    androidx.compose.runtime.LaunchedEffect(pull) {
        var armed = false
        androidx.compose.runtime.snapshotFlow { pull.distanceFraction }.collect { f ->
            onPull(f)
            if (f >= 1f && !armed) { armed = true; view.feel(Haptic.Detent) } else if (f < 1f) armed = false
        }
    }
    var raceSheet by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(false) }
    // Different plan today? (from today's session).
    var choicesOpen by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(false) }
    // "More today": folded unless you opened it (kept while the app runs).
    var moreOpen by androidx.compose.runtime.saveable.rememberSaveable { androidx.compose.runtime.mutableStateOf(false) }
    Box(Modifier.fillMaxSize().background(cs.surface)) {
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = actions::refresh,
            state = pull,
            indicator = {},
        ) {
            Column(
                Modifier
                    .fillMaxSize()
                    .verticalScroll(scroll)
                    .padding(start = 16.dp, end = 16.dp, top = top + 60.dp, bottom = bottom + if (navSpace) 104.dp else 24.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Title(date, actions)
                if (today == null) {
                    Box(Modifier.fillMaxWidth().height(240.dp), contentAlignment = Alignment.Center) { LoadingIndicator(Modifier.size(64.dp)) }
                } else {
                    var i = 0
                    if (today.sample) SampleBanner(Modifier.reveal(i++)) { actions.leaveDemo() }
                    // One thing leads, by the moment: just back from a run, how it went; otherwise
                    // today's session and how you are (web/views/today.ts).
                    val rw = more?.raceWeek
                    val race = today.race
                    val sessions: @Composable () -> Unit = {
                        today.sessions.forEach { s ->
                            TodaySession(
                                s, Modifier.reveal(i++), { actions.openSession(s.date, s.kind) }, actions::openActivity,
                                if (s.activityId == null && !s.manual && s.kind != "strength" && s.status != "done" && more != null) ({ more.mark(s.date, s.kind) }) else null,
                                more, { choicesOpen = true },
                            )
                        }
                        // A rest day says what's next; no plan yet, one is a few taps away by Tartan's own rules (no key needed).
                        if (today.sessions.isEmpty() && today.planOn) RestDay(today.next, Modifier.reveal(i++), { actions.openSession(it.date, it.kind) }) { actions.go("coach") }
                        else if (!today.planOn) NoPlanCard(Modifier.reveal(i++), ended = today.planEnded) { actions.go("coach") }
                    }
                    val week: @Composable () -> Unit = { if (race != null && rw != null) RaceWeekCard(race, rw, Modifier.reveal(i++)) { raceSheet = true } }
                    val ready: @Composable () -> Unit = { ReadinessCard(today.readiness, Modifier.reveal(i++), more, actions, numbers = false) }
                    // Race week (7 days and less) has its own card; from twelve weeks out to then, the countdown.
                    val raceLater: @Composable () -> Unit = {
                        val c = race?.countdown
                        if (race != null && rw == null && c != null && c.daysToGo > RACE_WEEK_DAYS) RaceCountdownCard(race, c, Modifier.reveal(i++)) { actions.go("trends") }
                        else if (race != null && rw == null && (race.daysToGo ?: -1) >= 0) RaceCard(race, Modifier.reveal(i++)) { actions.go("trends") }
                    }
                    val last: @Composable () -> Unit = { LastCard(today.last, Modifier.reveal(i++), actions, more?.fresh) }
                    val justIn = today.last?.justIn == true
                    val worth = today.takeaways
                    // Put away here (and told to the engine, which keeps it): this one and its workout's others.
                    var away by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(setOf<String>()) }
                    val moment = today.milestones.firstOrNull { it.id !in away && (it.activity == null || it.activity !in away) }
                    // The top: what today is and how you are, your race, the week. A run just in leads.
                    if (justIn) last()
                    // A new milestone: one quiet card, the most notable first, for a couple of days.
                    // Put away, it collapses (the cards under it close the gap); the next one, if any, fades in in its place.
                    val held = remember { androidx.compose.runtime.mutableStateOf(moment) }
                    if (moment != null) held.value = moment
                    val spatial = MaterialTheme.motionScheme.defaultSpatialSpec<androidx.compose.ui.unit.IntSize>()
                    val fx = MaterialTheme.motionScheme.defaultEffectsSpec<Float>()
                    val fxFast = MaterialTheme.motionScheme.fastEffectsSpec<Float>()
                    androidx.compose.animation.AnimatedVisibility(
                        moment != null,
                        if (moment != null) Modifier.reveal(i++) else Modifier,
                        enter = androidx.compose.animation.fadeIn(MaterialTheme.motionScheme.defaultEffectsSpec()) + androidx.compose.animation.expandVertically(spatial),
                        exit = androidx.compose.animation.fadeOut(MaterialTheme.motionScheme.fastEffectsSpec()) + androidx.compose.animation.shrinkVertically(spatial),
                    ) {
                        androidx.compose.animation.AnimatedContent(
                            held.value, contentKey = { it?.id },
                            transitionSpec = {
                                androidx.compose.animation.fadeIn(fx) togetherWith
                                    androidx.compose.animation.fadeOut(fxFast) using
                                    androidx.compose.animation.SizeTransform(clip = true) { _, _ -> spatial }
                            },
                            label = "milestone",
                        ) { mo ->
                            if (mo != null) MilestoneCard(mo, Modifier, { actions.openActivity(it) }) { away = away + listOfNotNull(mo.id, mo.activity); more?.putAway(mo.id) }
                        }
                    }
                    sessions(); week(); ready(); raceLater()
                    WeekCard(today.week, date, Modifier.reveal(i++)) { actions.go("trends") }
                    // The rest, folded: the numbers behind the verdict, the last workout, what's worth
                    // knowing and the notes, with a line saying what's in there.
                    // Pairing with a PC is a tool beyond the coach: suggested to someone who uses others (src/in-use.ts).
                    val pairHint = more?.pairHint == true && LocalInUse.current.power
                    val notes = listOfNotNull(more?.shoes, pairHint.takeIf { it }).size
                    val inside = listOfNotNull(
                        stringResource(R.string.today_more_numbers),
                        if (!justIn && today.last != null) stringResource(R.string.today_more_last) else null,
                        if (worth.isNotEmpty()) pluralStringResource(R.plurals.today_more_takeaways, worth.size, worth.size) else null,
                        if (notes > 0) pluralStringResource(R.plurals.today_more_notes, notes, notes) else null,
                    )
                    MoreToday(moreOpen, inside.joinToString(stringResource(R.string.common_list_sep)), Modifier.reveal(i++)) { moreOpen = !moreOpen }
                    androidx.compose.animation.AnimatedVisibility(
                        moreOpen,
                        enter = androidx.compose.animation.expandVertically(MaterialTheme.motionScheme.defaultSpatialSpec()) + androidx.compose.animation.fadeIn(MaterialTheme.motionScheme.defaultEffectsSpec()),
                        exit = androidx.compose.animation.shrinkVertically(MaterialTheme.motionScheme.defaultSpatialSpec()) + androidx.compose.animation.fadeOut(MaterialTheme.motionScheme.fastEffectsSpec()),
                    ) {
                        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            NumbersCard(today.readiness, Modifier, more, actions)
                            if (!justIn) LastCard(today.last, Modifier, actions, more?.fresh)
                            if (worth.isNotEmpty()) Takeaways(worth, Modifier, actions)
                            more?.shoes?.let { n -> NoteCard("run", n.title, n.text, n.go, n.quiet, Modifier, { more.dismissShoes(); actions.go("settings/training") }, { more.dismissShoes() }) }
                            if (pairHint && more != null) NoteCard(
                                "pc", stringResource(R.string.today_tartan_on_your_pc_too),
                                stringResource(R.string.today_pair_them_the_same_plan_coach),
                                stringResource(R.string.today_scan_my_pc_s_code), stringResource(R.string.today_type_it_instead), Modifier, { more.scanPair() }, { actions.go("settings/more") }, { more.dismissPair() },
                            )
                        }
                    }
                }
            }
        }
        // Full screen: no band under the clock, just a soft fade (strongest behind the status icons)
        // that the cards scroll up into, so the page runs to the top edge.
        TopScrim(scroll.value > 0)
        more?.let { m ->
            Said(m.said ?: m.fresh?.said, { m.said = null; m.fresh?.said = null }, Modifier.align(Alignment.BottomCenter).padding(bottom = bottom + if (navSpace) 88.dp else 8.dp))
            val race = today?.race
            val rw = m.raceWeek
            if (raceSheet && race != null && rw != null) RaceWeekSheet(race, rw, m) { raceSheet = false }
            m.check?.choices?.takeIf { choicesOpen }?.let { c -> DayChoicesSheet(c, m) { choicesOpen = false; m.nudge = null } }
        }
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun Title(date: LocalDate, actions: TodayActions) {
    val view = LocalView.current
    PageHeader(stringResource(R.string.common_today), Modifier.padding(bottom = 4.dp), subtitle = date.format(DateTimeFormatter.ofPattern("EEEE d MMMM", Locale.getDefault()))) {
        FilledTonalButton(onClick = { actions.go("record") }, shapes = ButtonDefaults.shapes()) {
            Icon(Glyphs["record"], contentDescription = null, Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Text(stringResource(R.string.common_record))
        }
    }
}

@Composable
private fun Card(modifier: Modifier, onClick: (() -> Unit)?, content: @Composable () -> Unit) {
    val m = modifier.fillMaxWidth().let { if (onClick != null) it.press(onClick = onClick) else it }
    Box(m.clip(CARD).background(MaterialTheme.colorScheme.surfaceContainer).padding(20.dp)) { content() }
}

@Composable
private fun SessionCard(s: Session, modifier: Modifier, onClick: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    val done = s.status == "done"
    Card(modifier, onClick) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(44.dp).clip(RoundedCornerShape(14.dp)).background(if (done) LocalData.current.goodContainer else cs.primaryContainer), contentAlignment = Alignment.Center) {
                Icon(if (done) Glyphs["check"] else Glyphs[kindGlyph(s.kind)], null, tint = if (done) LocalData.current.good else cs.onPrimaryContainer)
            }
            Spacer(Modifier.width(16.dp))
            Column(Modifier.weight(1f)) {
                Text(s.title, style = MaterialTheme.typography.titleLarge)
                Text(listOf(if (done) stringResource(R.string.common_done_today) else stringResource(R.string.common_today), s.detail).filter { it.isNotEmpty() }.joinToString(" · "), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
            }
            Icon(Glyphs["chevron"], null, tint = cs.onSurfaceVariant)
        }
    }
}

@Composable
private fun ReadinessCard(r: Readiness, modifier: Modifier, more: TodayModel?, actions: TodayActions, numbers: Boolean = true) {
    val cs = MaterialTheme.colorScheme
    // In the order you'd answer it: the morning check first while it waits; then one verdict (the
    // check's, once it says go easy or rest), why, and only then the numbers behind it.
    val c = more?.check
    // Asking until every question is answered (legs alone isn't the whole check while sleep is asked).
    val asking = c != null && !c.complete
    val easy = c != null && c.complete && c.level != "ready"
    val title = if (easy) (if (c!!.level == "rest") stringResource(R.string.today_rest_or_go_very_easy) else stringResource(R.string.today_go_easy_today_2)) else r.title
    val advice = if (easy) c!!.why.ifEmpty { if (c.level == "rest") stringResource(R.string.today_your_morning_check_says_your_body) else stringResource(R.string.today_your_morning_check_says_to_hold) } else r.advice
    Column(modifier, verticalArrangement = Arrangement.spacedBy(12.dp)) {
    Card(Modifier.animateContentSize(), null) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            if (asking) {
                MorningCheck(more!!)
                Spacer(Modifier.height(10.dp))
                Text(stringResource(R.string.today_until_then, r.title.replaceFirstChar { it.lowercase() }), style = MaterialTheme.typography.titleSmall, color = cs.onSurfaceVariant)
            } else {
                Text(title, style = MaterialTheme.typography.headlineMedium, color = cs.primary)
                Text(advice, style = MaterialTheme.typography.bodyLarge)
                more?.let { MorningCheck(it) }
            }
            if (r.state != "new") ReadinessScale(r.state)
            if (r.why.isNotEmpty() && !easy) Text(r.why, style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
        }
    }
    if (numbers) NumbersCard(r, Modifier, more, actions)
    }
}

/** The fold under Today's top: "More today", what's in it, and a chevron that turns. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun MoreToday(open: Boolean, inside: String, modifier: Modifier, toggle: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    val turn by androidx.compose.animation.core.animateFloatAsState(if (open) 180f else 0f, MaterialTheme.motionScheme.defaultSpatialSpec(), label = "chevron")
    Row(
        modifier.fillMaxWidth().press(scale = 0.98f, label = stringResource(R.string.today_more_today), onClick = toggle).clip(RoundedCornerShape(24.dp)).background(cs.surfaceContainer).padding(horizontal = 20.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(if (open) stringResource(R.string.today_less_today) else stringResource(R.string.today_more_today), style = MaterialTheme.typography.titleSmall)
            if (!open && inside.isNotEmpty()) Text(inside.replaceFirstChar { it.uppercase() }, style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant, maxLines = 2)
        }
        Icon(Glyphs["chevron"], null, Modifier.size(18.dp).graphicsLayer { rotationZ = 90f + turn }, tint = cs.onSurfaceVariant)
    }
}

/** Behind the verdict: the numbers, the watch's vitals, what they mean, the way to Body. */
@Composable
private fun NumbersCard(r: Readiness, modifier: Modifier, more: TodayModel?, actions: TodayActions) {
    Card(modifier, null) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            if (r.state != "new") Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Stat(stringResource(R.string.common_fitness), r.fitness, Modifier.weight(1f), LocalData.current.pace)
                Stat(stringResource(R.string.today_fatigue), r.fatigue, Modifier.weight(1f), LocalData.current.effort)
                Stat(stringResource(R.string.today_form), r.form, Modifier.weight(1f), null)
            }
            more?.vitals?.takeIf { it.rest != null || it.sleepMin != null || it.oxygen != null }?.let { Spacer(Modifier.height(6.dp)); VitalsRow(it) { actions.go("you") } }
            if (r.state != "new") Explain(r)
            BodyLink { actions.go("you") }
        }
    }
}

private val SCALE get() = listOf("tired" to str(R.string.today_tired), "building" to str(R.string.today_building), "steady" to str(R.string.today_balanced), "fresh" to str(R.string.common_fresh), "rested" to str(R.string.today_rested))

/** Where you are on the scale from tired to rested: the current step filled. */
@Composable
private fun ReadinessScale(state: String) {
    val cs = MaterialTheme.colorScheme
    // A scale you read, not buttons: a thin track with where you are filled, its name under it.
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        SCALE.forEach { (k, label) ->
            val on = k == state
            Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Box(Modifier.fillMaxWidth().height(if (on) 6.dp else 4.dp).clip(CircleShape).background(if (on) cs.primary else cs.surfaceContainerHighest))
                Text(
                    label, maxLines = 1,
                    style = if (on) MaterialTheme.typography.labelMedium.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold) else MaterialTheme.typography.labelSmall,
                    color = if (on) cs.primary else cs.onSurfaceVariant,
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                )
            }
        }
    }
}

/** A figure in the board's condensed face; the series keeps its hue on a small key, never on the text. */
@Composable
private fun Stat(label: String, value: Double, modifier: Modifier, key: Color?) {
    val cs = MaterialTheme.colorScheme
    Column(modifier.clip(RoundedCornerShape(20.dp)).background(cs.surfaceContainerHigh).padding(horizontal = 14.dp, vertical = 12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (key != null) Box(Modifier.size(8.dp).clip(CircleShape).background(key))
            if (key != null) Spacer(Modifier.width(6.dp))
            Text(label, style = MaterialTheme.typography.labelMedium, color = cs.onSurfaceVariant)
        }
        Text("${if (label == stringResource(R.string.today_form) && value > 0) "+" else ""}${Math.round(value)}", fontFamily = Condensed, fontWeight = FontWeight.SemiBold, fontSize = 30.sp, lineHeight = 34.sp)
    }
}

private fun km1(x: Double) = String.format(Locale.getDefault(), "%.1f", x)

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun WeekCard(w: Week, date: LocalDate, modifier: Modifier, onClick: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    val density = LocalDensity.current
    val share = if (w.goalKm > 0) (w.km / w.goalKm).coerceIn(0.0, 1.0).toFloat() else 0f
    // The ring fills and the number counts up together, once, as the card first arrives (back on
    // Today it's already full; a new distance fills from where it was). Still with animations off.
    val still = LocalReducedMotion.current
    val first = remember(share) { Seen.first("week:${w.km}:${w.goalKm}") && !still }
    val fill = remember { Animatable(if (first) 0f else share) }
    LaunchedEffect(share) { if (first) fill.animateTo(share, tween(1100, delayMillis = 150, easing = FastOutSlowInEasing)) else fill.snapTo(share) }
    val reached = w.goalKm > 0 && w.km >= w.goalKm
    Card(modifier, onClick) {
        Column {
            val context = androidx.compose.ui.platform.LocalContext.current
            val colour = shareColour()
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.common_this_week), style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                IconButton(onClick = { runCatching { ShareCard.share(context, ShareCard.week(context, w, colour, date), str(R.string.today_tartan_week, date)) } }) { Icon(Glyphs["share"], stringResource(R.string.today_share_the_week_as_a_picture), Modifier.size(20.dp), tint = cs.onSurfaceVariant) }
            }
            Spacer(Modifier.height(4.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(148.dp).semantics { contentDescription = str(R.string.today_of_km, km1(w.km), km1(w.goalKm)) }, contentAlignment = Alignment.Center) {
                    val stroke = with(density) { Stroke(width = 9.dp.toPx(), cap = StrokeCap.Round) }
                    CircularWavyProgressIndicator(
                        progress = { fill.value },
                        modifier = Modifier.fillMaxSize(),
                        color = if (reached) LocalData.current.good else cs.primary,
                        trackColor = cs.surfaceContainerHighest,
                        stroke = stroke,
                        trackStroke = stroke,
                        wavelength = 44.dp,
                        // A gentle wave while it fills; flat when empty or done.
                        amplitude = { p -> if (p <= 0.02f || p >= 0.999f) 0f else 1f },
                    )
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(km1(if (share > 0 && fill.value < share) w.km * fill.value / share else w.km), fontFamily = Condensed, fontWeight = FontWeight.SemiBold, fontSize = 44.sp, lineHeight = 44.sp)
                        Text("km", style = MaterialTheme.typography.labelLarge, color = cs.onSurfaceVariant)
                    }
                }
                Spacer(Modifier.width(18.dp))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    when {
                        w.goalKm <= 0 -> Text(stringResource(R.string.today_set_a_weekly_target_in_settings), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
                        reached -> Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Glyphs["check"], null, Modifier.size(18.dp), tint = LocalData.current.good)
                            Spacer(Modifier.width(4.dp))
                            Text(stringResource(R.string.today_reached), style = MaterialTheme.typography.titleMedium, color = LocalData.current.good)
                        }
                        else -> Text(stringResource(R.string.today_km_to_go, km1(w.goalKm - w.km)), style = MaterialTheme.typography.titleMedium)
                    }
                    w.goalSays?.let { Text(it.replaceFirstChar { c -> c.uppercase() }, style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant) }
                    if (w.planSessions > 0) Text(stringResource(R.string.today_planned_done, w.planDone, w.planSessions, (w.workouts - w.planDone).takeIf { it > 0 }?.let { stringResource(R.string.today_extra, it) } ?: ""), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
                    else Text(pluralStringResource(R.plurals.common_workouts, w.workouts, w.workouts), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
                }
            }
            Spacer(Modifier.height(16.dp))
            DayBars(w.days, date, grow = first)
        }
    }
}

/** Distance a day, Monday to Sunday: each bar springs up in turn; today's is primary. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun DayBars(days: List<Day>, date: LocalDate, grow: Boolean) {
    val cs = MaterialTheme.colorScheme
    val max = (days.maxOfOrNull { it.km } ?: 0.0).coerceAtLeast(1.0)
    val iso = date.toString()
    Row(Modifier.fillMaxWidth().height(84.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        days.forEachIndexed { i, d ->
            val target = if (d.km > 0) (d.km / max).toFloat().coerceAtLeast(0.1f) else 0f
            // Up in turn with the ring the first time; after that a day's bar just moves to its new height.
            val h = remember { Animatable(if (grow) 0f else target) }
            val spec = MaterialTheme.motionScheme.slowSpatialSpec<Float>()
            LaunchedEffect(target) {
                if (grow && h.value == 0f) kotlinx.coroutines.delay(200L + i * 40L)
                h.animateTo(target, spec)
            }
            Column(Modifier.weight(1f).fillMaxHeight(), horizontalAlignment = Alignment.CenterHorizontally) {
                Box(Modifier.weight(1f).fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(cs.surfaceContainerHigh), contentAlignment = Alignment.BottomCenter) {
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .fillMaxHeight(h.value.coerceIn(0f, 1.1f).coerceAtMost(1f))
                            .clip(RoundedCornerShape(10.dp))
                            .background(if (d.date == iso) cs.primary else if (d.future) cs.surfaceContainerHighest else cs.primary.copy(alpha = 0.55f)),
                    )
                }
                val day = runCatching { LocalDate.parse(d.date).dayOfWeek.getDisplayName(java.time.format.TextStyle.SHORT, Locale.getDefault()).take(2) }.getOrDefault("")
                Text(day, style = MaterialTheme.typography.labelMedium, color = if (d.date == iso) cs.primary else cs.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
            }
        }
    }
}

@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun LastCard(l: Last?, modifier: Modifier, actions: TodayActions, fresh: WorkoutModel? = null) {
    val cs = MaterialTheme.colorScheme
    Card(modifier, l?.let { { if (it.justIn) actions.openRun(it.id) else actions.openActivity(it.id) } }) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(if (l?.justIn == true) stringResource(R.string.today_just_in) else stringResource(R.string.today_last_workout), style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                TextButton(onClick = { actions.go("activities") }) { Text(stringResource(R.string.today_all_activities)) }
            }
            if (l == null) {
                Text(stringResource(R.string.today_no_workouts_yet_connect_strava_or), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
                return@Column
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(44.dp).clip(RoundedCornerShape(14.dp)).background(cs.primaryContainer), contentAlignment = Alignment.Center) {
                    Icon(Glyphs.sport(l.sport), null, Modifier.size(22.dp), tint = cs.onPrimaryContainer)
                }
                Spacer(Modifier.width(14.dp))
                Column(Modifier.weight(1f)) {
                    Text(l.name, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    // When, and the weather it was in: on the one line while it fits.
                    androidx.compose.foundation.layout.FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), itemVerticalAlignment = Alignment.CenterVertically) {
                        Text(whenText(l.start), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
                        l.weather?.let { WeatherInline(it, MaterialTheme.typography.bodyMedium, cs.onSurfaceVariant, glyph = 15.dp) }
                    }
                }
                if (l.label.isNotEmpty()) {
                    Text(stringResource(R.string.today_effort, l.label), style = MaterialTheme.typography.labelLarge, color = cs.onSecondaryContainer, modifier = Modifier.clip(CircleShape).background(cs.secondaryContainer).padding(horizontal = 12.dp, vertical = 6.dp))
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                l.km?.let { Figure(km1(it), "km", Modifier.weight(1f)) }
                l.minutes?.let { Figure(clock(it), "time", Modifier.weight(1f)) }
                l.pace?.let { Figure(it, "/km", Modifier.weight(1f)) }
                l.hr?.let { Figure("$it", "bpm", Modifier.weight(1f)) }
            }
            if (!l.trivial) {
                val rank = listOfNotNull(l.rank?.replaceFirstChar { it.uppercase() }, if (l.estimated) stringResource(R.string.today_estimated_without_heart_rate) else null).joinToString(" · ")
                if (l.effort > 0 && rank.isNotEmpty()) Text(rank, style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
                l.feeling?.let { Feeling(it) }
                EasyBar(l.zones, l.easyCap)
            }
            if (l.justIn) fresh?.finish?.let { FinishCard(it, fresh, Modifier, title = stringResource(R.string.common_against_the_plan), bare = true) }
        }
    }
}

@Composable
private fun Figure(value: String, unit: String, modifier: Modifier) {
    Column(modifier) {
        Text(value, fontFamily = Condensed, fontWeight = FontWeight.SemiBold, fontSize = 26.sp, lineHeight = 28.sp)
        Text(unit, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

private fun clock(min: Double): String {
    val s = Math.round(min * 60)
    val h = s / 3600
    val m = (s % 3600) / 60
    return if (h > 0) "$h:${m.toString().padStart(2, '0')}" else "$m:${(s % 60).toString().padStart(2, '0')}"
}

private fun whenText(start: String): String = runCatching {
    val t = LocalDateTime.parse(start.take(19))
    t.format(DateTimeFormatter.ofPattern("EEE d MMM · HH:mm", Locale.getDefault()))
}.getOrDefault(start)

/** What's worth knowing: tiles, 2dp apart, 24dp corners at the group's ends and 6dp between. */
@Composable
private fun Takeaways(list: List<Takeaway>, modifier: Modifier, actions: TodayActions) {
    val cs = MaterialTheme.colorScheme
    val data = LocalData.current
    Column(modifier, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(stringResource(R.string.today_worth_knowing), style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(start = 4.dp, top = 8.dp, bottom = 8.dp))
        list.take(4).forEachIndexed { i, t ->
            val first = i == 0
            val last = i == minOf(list.size, 4) - 1
            val shape = RoundedCornerShape(if (first) 24.dp else 6.dp, if (first) 24.dp else 6.dp, if (last) 24.dp else 6.dp, if (last) 24.dp else 6.dp)
            val (ink, fill, glyph) = when (t.tone) {
                "good" -> Triple(data.good, data.goodContainer, "check")
                "watch" -> Triple(data.watch, data.watchContainer, "spark")
                else -> Triple(cs.onSecondaryContainer, cs.secondaryContainer, "up")
            }
            Row(Modifier.fillMaxWidth().let { m -> t.activity?.let { id -> m.press(scale = 0.98f, onClick = { actions.openActivity(id) }) } ?: m }.clip(shape).background(cs.surfaceContainer).padding(16.dp), verticalAlignment = Alignment.Top) {
                Box(Modifier.size(36.dp).clip(CircleShape).background(fill), contentAlignment = Alignment.Center) { Icon(Glyphs[glyph], null, Modifier.size(20.dp), tint = ink) }
                Spacer(Modifier.width(14.dp))
                Column(Modifier.weight(1f).widthIn(min = 0.dp)) {
                    Text(t.title, style = MaterialTheme.typography.titleSmall)
                    Text(t.detail, style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
                }
            }
        }
    }
}

/** The demo: this is sample data, nothing of yours, and the way back to your own. */
@Composable
private fun SampleBanner(modifier: Modifier, leave: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Row(modifier.fillMaxWidth().clip(CARD).background(cs.tertiaryContainer).padding(start = 20.dp, end = 12.dp, top = 14.dp, bottom = 14.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(stringResource(R.string.today_sample_data), style = MaterialTheme.typography.titleMedium, color = cs.onTertiaryContainer)
            Text(stringResource(R.string.today_ten_weeks_of_a_made_up), style = MaterialTheme.typography.bodyMedium, color = cs.onTertiaryContainer)
        }
        FilledTonalButton(onClick = leave) { Text(stringResource(R.string.today_leave)) }
    }
}
