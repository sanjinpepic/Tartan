package dev.freesuunto.app.shell

import androidx.compose.ui.res.stringResource
import dev.freesuunto.app.R
import android.content.Intent
import android.graphics.ImageDecoder
import android.os.Build
import android.provider.MediaStore
import android.speech.RecognizerIntent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.combinedClickable
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.ButtonDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.launch
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

val SUGGESTIONS get() = listOf(
    str(R.string.common_how_is_my_training_going),
    str(R.string.common_make_me_a_training_plan),
    str(R.string.common_was_my_last_run_too_hard),
    str(R.string.chat_am_i_ready_for_a_10k),
    str(R.string.common_why_has_my_easy_pace_changed),
)

/**
 * Ask your coach, native (the web's #chat): the conversation, the coach's steps as chips while it
 * looks things up, its answer as it streams in, a photo and dictation in the box, your other
 * conversations in a sheet. Without a coach set up, the way to set one up.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class, ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun ChatScreen(chat: ChatModel, go: (String) -> Unit, navSpace: Boolean = true, suggestions: List<String> = SUGGESTIONS) {
    val cs = MaterialTheme.colorScheme
    val context = LocalContext.current
    val view = LocalView.current
    val top = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    val nav = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    val typing = WindowInsets.isImeVisible
    // With the keyboard up: just above it. Only the part of this screen the keyboard actually
    // covers counts (where the window already shrank for it, that's nothing), so the composer
    // never floats with a gap under it.
    val density = LocalDensity.current
    val window = LocalView.current.rootView
    var screenBottom by remember { mutableStateOf(0f) }
    val keyboardTop = window.height - WindowInsets.ime.getBottom(density)
    val covered = with(density) { (screenBottom - keyboardTop).coerceAtLeast(0f).toDp() }
    // Where it rests (above the floating bar); as the keyboard slides up it stays put until the
    // keyboard reaches it, then rides on it: one smooth movement, no drop first.
    val resting = nav + if (navSpace) 96.dp - navDrop() else 12.dp
    val composerBottom = maxOf(resting, covered + 8.dp)
    val list = rememberLazyListState()
    var history by remember { mutableStateOf(false) }
    val focus = remember { FocusRequester() }
    val status = chat.status
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboard.current
    val uri = LocalUriHandler.current
    var reporting by remember { mutableStateOf<Msg?>(null) }
    val copy: (Msg) -> Unit = { m ->
        scope.launch { clipboard.setClipEntry(ClipEntry(android.content.ClipData.newPlainText(if (m.user) str(R.string.chat_your_message) else str(R.string.common_coach), m.text))) }
        // Android 13 and newer show their own "Copied"; before that, say so.
        if (Build.VERSION.SDK_INT < 33) android.widget.Toast.makeText(context, str(R.string.common_copied), android.widget.Toast.LENGTH_SHORT).show()
    }

    val pick = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        runCatching {
            val bmp = if (Build.VERSION.SDK_INT >= 28) ImageDecoder.decodeBitmap(ImageDecoder.createSource(context.contentResolver, uri)) { d, _, _ -> d.allocator = ImageDecoder.ALLOCATOR_SOFTWARE }
            else @Suppress("DEPRECATION") MediaStore.Images.Media.getBitmap(context.contentResolver, uri)
            chat.photo = ChatModel.photo(bmp)
        }
    }
    val speak = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        val said = r.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull() ?: return@rememberLauncherForActivityResult
        chat.draft = listOf(chat.draft.trim(), said).filter { it.isNotEmpty() }.joinToString(" ")
    }

    // The end of the conversation in view as it grows (and as the answer streams).
    val last = chat.messages.lastOrNull()
    LaunchedEffect(chat.messages.size, last?.text?.length, last?.steps?.size, typing) {
        if (chat.messages.isNotEmpty()) list.animateScrollToItem(chat.messages.size)
    }
    LaunchedEffect(chat.focusAsk) { if (chat.focusAsk > 0) runCatching { focus.requestFocus() } }

    Box(Modifier.fillMaxSize().onGloballyPositioned { screenBottom = it.boundsInWindow().bottom }.background(cs.surface)) {
        LazyColumn(
            state = list,
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = top + 56.dp, bottom = composerBottom + 88.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    PageHeader(stringResource(R.string.common_ask_your_coach), subtitle = if (status?.ready == true) stringResource(R.string.chat_reads_your_workouts_sleep_and_plan) else null)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 4.dp)) {
                        FilledTonalButton(onClick = { history = true; chat.readList() }, shapes = ButtonDefaults.shapes()) { Icon(Glyphs["clock"], null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text(stringResource(R.string.chat_chats)) }
                        FilledTonalButton(onClick = { chat.newChat() }, shapes = ButtonDefaults.shapes()) { Icon(Glyphs["plus"], null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text(stringResource(R.string.common_new)) }
                    }
                }
            }
            when {
                status != null && !status.ready -> item { SetUp(go) }
                chat.loading -> item { Box(Modifier.fillMaxWidth().heightIn(min = 200.dp), contentAlignment = Alignment.Center) { LoadingIndicator(Modifier.size(56.dp)) } }
                chat.messages.isEmpty() -> item { Empty(suggestions) { chat.send(it) } }
                else -> itemsIndexed(chat.messages) { _, m -> Bubble(m, go, copy = { copy(m) }, report = { reporting = m }, retry = { chat.retry(m) }) }
            }
        }
        // The status bar's soft fade.
        TopScrim(list.canScrollBackward)
        if (status?.ready != false) {
            // Under the box, a fade so the conversation scrolls away beneath it.
            Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().heightIn(min = composerBottom + 90.dp, max = composerBottom + 90.dp).background(Brush.verticalGradient(0f to cs.surface.copy(alpha = 0f), 0.4f to cs.surface.copy(alpha = 0.92f), 1f to cs.surface)))
            Composer(
                chat, focus, Modifier.align(Alignment.BottomCenter).padding(start = 16.dp, end = 16.dp, bottom = composerBottom),
                photo = { pick.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
                voice = {
                    runCatching {
                        speak.launch(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM).putExtra(RecognizerIntent.EXTRA_PROMPT, str(R.string.common_ask_your_coach)))
                    }
                },
            )
        }
    }

    reporting?.let { m ->
        ReportDialog(onDismiss = { reporting = null }) { reason, note, send ->
            reporting = null
            chat.report(m, reason, note) { r -> if (send) runCatching { uri.openUri(Feedback.report(context, reason, note, r)) } }
        }
    }

    if (history) {
        ModalBottomSheet(onDismissRequest = { history = false }, modifier = Modifier.statusBarsPadding()) {
            Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(stringResource(R.string.chat_conversations), style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(bottom = 10.dp))
                if (chat.list.isEmpty()) Text(stringResource(R.string.chat_no_conversations_yet), color = cs.onSurfaceVariant)
                chat.list.forEachIndexed { i, c ->
                    val first = i == 0
                    val lastRow = i == chat.list.lastIndex
                    val shape = RoundedCornerShape(if (first) 24.dp else 6.dp, if (first) 24.dp else 6.dp, if (lastRow) 24.dp else 6.dp, if (lastRow) 24.dp else 6.dp)
                    Column(
                        Modifier.fillMaxWidth().press(scale = 0.98f, onClick = { history = false; view.feel(Haptic.Click); scope.launch { chat.load(c.id) } })
                            .clip(shape).background(if (c.id == chat.conversation) cs.secondaryContainer else cs.surfaceContainerHigh).padding(16.dp),
                    ) {
                        Text(c.title, style = MaterialTheme.typography.titleSmall, maxLines = 1)
                        Text(ago(c.updated), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
                    }
                }
            }
        }
    }
}

@Composable
private fun SetUp(go: (String) -> Unit) {
    val cs = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(28.dp)).background(cs.surfaceContainer).padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(stringResource(R.string.chat_your_plan_works_without_ai), style = MaterialTheme.typography.titleLarge)
        Text(stringResource(R.string.chat_tartan_s_own_rules_write_your), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
        FilledTonalButton(onClick = { go("settings/coach") }) { Text(stringResource(R.string.chat_set_up_the_coach)) }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Empty(suggestions: List<String>, ask: (String) -> Unit) {
    val cs = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth().padding(top = 24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(Modifier.size(64.dp).clip(RoundedCornerShape(22.dp)).background(cs.primaryContainer), contentAlignment = Alignment.Center) {
            Icon(Glyphs["coach"], null, Modifier.size(32.dp), tint = cs.onPrimaryContainer)
        }
        Text(stringResource(R.string.chat_what_would_you_like_to_know), style = MaterialTheme.typography.titleLarge)
        Text(stringResource(R.string.chat_the_coach_reads_your_workouts_load), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant, modifier = Modifier.widthIn(max = 420.dp))
        Disclaimer(Modifier.widthIn(max = 420.dp))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally), verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
            suggestions.forEach { s ->
                Text(s, style = MaterialTheme.typography.labelLarge, color = cs.onSecondaryContainer, modifier = Modifier.press(onClick = { ask(s) }).clip(CircleShape).background(cs.secondaryContainer).padding(horizontal = 14.dp, vertical = 10.dp))
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class, ExperimentalMaterial3ExpressiveApi::class, ExperimentalFoundationApi::class)
@Composable
private fun Bubble(m: Msg, go: (String) -> Unit, copy: () -> Unit = {}, report: () -> Unit = {}, retry: () -> Unit = {}) {
    val cs = MaterialTheme.colorScheme
    val data = LocalData.current
    val view = LocalView.current
    var menu by remember { mutableStateOf(false) }
    Box(Modifier.fillMaxWidth(), contentAlignment = if (m.user) Alignment.CenterEnd else Alignment.CenterStart) {
        // A new message rises in once; scrolled back to, or read back from an old chat, it's simply there.
        val still = LocalReducedMotion.current
        val arrive = remember(m) { androidx.compose.animation.core.MutableTransitionState(!m.fresh || still).apply { targetState = true } }
        LaunchedEffect(arrive.isIdle) { if (arrive.isIdle) m.fresh = false }
        AnimatedVisibility(arrive, enter = fadeIn(MaterialTheme.motionScheme.defaultEffectsSpec()) + slideInVertically(MaterialTheme.motionScheme.defaultSpatialSpec()) { it / 6 }) {
          // Hold a message: copy it; a coach's answer can also be reported.
          Box {
            Column(
                Modifier
                    // Yours hug their words; the coach's take the width they need to read well.
                    .let { if (m.user) it.widthIn(max = 320.dp) else it.widthIn(max = 520.dp).fillMaxWidth(0.94f) }
                    .clip(RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp, bottomStart = if (m.user) 24.dp else 8.dp, bottomEnd = if (m.user) 8.dp else 24.dp))
                    .combinedClickable(
                        enabled = m.text.isNotEmpty() && !m.streaming,
                        onClickLabel = null,
                        onLongClickLabel = stringResource(R.string.chat_copy_or_report),
                        onLongClick = { view.feel(Haptic.Confirm); menu = true },
                        onClick = {},
                    )
                    .background(if (m.user) cs.primary else cs.surfaceContainer)
                    .animateContentSize()
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                horizontalAlignment = if (m.user) Alignment.End else Alignment.Start,
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                m.image?.let { Image(it, stringResource(R.string.chat_photo_sent_to_the_coach), Modifier.size(180.dp).clip(RoundedCornerShape(16.dp)), contentScale = ContentScale.Crop) }
                if (m.steps.isNotEmpty()) {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        m.steps.forEach { st ->
                            Row(Modifier.clip(CircleShape).background(cs.surfaceContainerHigh).padding(horizontal = 10.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                                if (st.done) Icon(Glyphs["check"], null, Modifier.size(14.dp), tint = data.good)
                                else LoadingIndicator(Modifier.size(16.dp))
                                Spacer(Modifier.width(6.dp))
                                Text(st.label, style = MaterialTheme.typography.labelMedium, color = cs.onSurfaceVariant)
                            }
                        }
                    }
                }
                when {
                    m.user -> Text(m.text, color = cs.onPrimary, style = MaterialTheme.typography.bodyLarge)
                    m.text.isNotEmpty() -> Markdown(m.text)
                }
                if (m.streaming) Working(m)
                // Who answered: on the phone or in the cloud (plain words, small, after the answer).
                m.by?.takeIf { !m.user && (m.text.isNotEmpty() || !m.streaming) }?.let {
                    Text(it, style = MaterialTheme.typography.labelSmall, color = cs.onSurfaceVariant, modifier = Modifier.semantics { contentDescription = str(R.string.chat_answered_by, it) })
                }
                m.reported?.let { Text(stringResource(R.string.chat_reported, it), style = MaterialTheme.typography.labelSmall, color = cs.error) }
                m.error?.let { Text(it, color = cs.error, style = MaterialTheme.typography.bodyMedium) }
                if (m.error != null && !m.user && !m.streaming) FilledTonalButton(onClick = retry) { Icon(Glyphs["sync"], null, Modifier.size(16.dp)); Spacer(Modifier.width(6.dp)); Text(stringResource(R.string.chat_ask_again)) }
                m.routes.forEach { r -> RouteCardInChat(r) { go("route/${r.id}") } }
                m.links.forEach { (label, hash) ->
                    Row(Modifier.press(onClick = { go(hash) }).clip(CircleShape).background(cs.primaryContainer).padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Glyphs["spark"], null, Modifier.size(16.dp), tint = cs.onPrimaryContainer); Spacer(Modifier.width(6.dp))
                        Text(label, style = MaterialTheme.typography.labelLarge, color = cs.onPrimaryContainer)
                    }
                }
            }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                DropdownMenuItem(text = { Text(stringResource(R.string.chat_copy_message)) }, leadingIcon = { Icon(Glyphs["copy"], null, Modifier.size(20.dp)) }, onClick = { menu = false; copy() })
                if (!m.user && m.reported == null) DropdownMenuItem(text = { Text(stringResource(R.string.chat_report_reply)) }, leadingIcon = { Icon(Glyphs["flag"], null, Modifier.size(20.dp)) }, onClick = { menu = false; report() })
            }
          }
        }
    }
}

/** The coach is a coach, not a doctor: said where you meet it. */
@Composable
fun Disclaimer(modifier: Modifier = Modifier) {
    val cs = MaterialTheme.colorScheme
    Row(modifier.clip(RoundedCornerShape(16.dp)).background(cs.surfaceContainerHigh).padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(Glyphs["info"], null, Modifier.size(18.dp), tint = cs.onSurfaceVariant)
        Spacer(Modifier.width(10.dp))
        Text(stringResource(R.string.chat_disclaimer), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
    }
}


/**
 * Report a coach's reply: why (a few common reasons), a note, and whether to send it to Tartan's
 * developer as a GitHub issue you see before it's sent. Kept with the chat either way.
 */
@Composable
internal fun ReportDialog(onDismiss: () -> Unit, onReport: (reason: String, note: String, send: Boolean) -> Unit) {
    val form = remember { ReportState() }
    AlertDialog(
        onDismissRequest = onDismiss,
        icon = { Icon(Glyphs["flag"], null) },
        title = { Text(stringResource(R.string.chat_report_this_reply)) },
        text = { ReportForm(form) },
        confirmButton = { TextButton(onClick = { onReport(form.reason, form.note, form.send) }) { Text(stringResource(R.string.chat_report)) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.common_cancel)) } },
    )
}

internal class ReportState {
    var reason by mutableStateOf(REPORT_REASONS[0])
    var note by mutableStateOf("")
    var send by mutableStateOf(true)
}

internal val REPORT_REASONS get() = listOf(str(R.string.chat_wrong_or_unsafe_advice), str(R.string.chat_made_up_numbers), str(R.string.chat_offensive_or_harmful), str(R.string.chat_something_else))

@Composable
internal fun ReportForm(f: ReportState) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        REPORT_REASONS.forEach { r ->
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).clip(RoundedCornerShape(12.dp)).selectable(selected = r == f.reason, role = Role.RadioButton) { f.reason = r }, verticalAlignment = Alignment.CenterVertically) {
                RadioButton(selected = r == f.reason, onClick = null)
                Spacer(Modifier.width(12.dp))
                Text(r, style = MaterialTheme.typography.bodyLarge)
            }
        }
        OutlinedTextField(f.note, { f.note = it.take(1000) }, label = { Text(stringResource(R.string.chat_what_was_wrong_optional)) }, modifier = Modifier.fillMaxWidth().padding(top = 8.dp), minLines = 2)
        Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(top = 4.dp).clip(RoundedCornerShape(12.dp)).toggleable(f.send, role = Role.Checkbox) { f.send = it }, verticalAlignment = Alignment.CenterVertically) {
            Checkbox(f.send, null)
            Spacer(Modifier.width(12.dp))
            Text(stringResource(R.string.chat_also_send_it_to_tartan_s), style = MaterialTheme.typography.bodyMedium)
        }
    }
}

/**
 * While the coach answers: three dots breathing in turn, what it's doing (thinking, looking
 * something up, writing) and, once it takes a while, for how long and that leaving is fine.
 */
@Composable
private fun Working(m: Msg) {
    val cs = MaterialTheme.colorScheme
    val t = rememberInfiniteTransition(label = "typing")
    val seconds by androidx.compose.runtime.produceState(((System.currentTimeMillis() - m.started) / 1000).toInt(), m) {
        while (true) { kotlinx.coroutines.delay(1000); value = ((System.currentTimeMillis() - m.started) / 1000).toInt() }
    }
    // The step itself shows as a chip above, spinning; this says the phase.
    val doing = if (m.steps.any { !it.done }) stringResource(R.string.chat_looking_it_up) else if (m.text.isEmpty()) stringResource(R.string.chat_thinking) else stringResource(R.string.chat_writing)
    Column(Modifier.semantics(mergeDescendants = true) {}, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(Modifier.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
            repeat(3) { i ->
                val a by t.animateFloat(0.25f, 1f, infiniteRepeatable(tween(600, delayMillis = i * 160), RepeatMode.Reverse), label = "dot$i")
                Box(Modifier.size(8.dp).graphicsLayer { alpha = a }.clip(CircleShape).background(cs.onSurfaceVariant))
            }
            Spacer(Modifier.width(4.dp))
            Text(if (seconds >= 10) "$doing ${seconds}s" else doing, style = MaterialTheme.typography.labelLarge, color = cs.onSurfaceVariant)
        }
        if (seconds >= 30) Text(stringResource(R.string.chat_bigger_questions_can_take_a_minute), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun Composer(chat: ChatModel, focus: FocusRequester, modifier: Modifier, photo: () -> Unit, voice: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    val status = chat.status
    Column(modifier.fillMaxWidth().widthIn(max = 680.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        chat.photo?.let { p ->
            Box {
                Image(p.bitmap, stringResource(R.string.chat_photo_to_send), Modifier.size(84.dp).clip(RoundedCornerShape(16.dp)), contentScale = ContentScale.Crop)
                FilledTonalIconButton(onClick = { chat.photo = null }, modifier = Modifier.align(Alignment.TopEnd).size(28.dp)) {
                    Icon(Glyphs["plus"], stringResource(R.string.chat_remove_the_photo), Modifier.size(14.dp).graphicsLayer { rotationZ = 45f })
                }
            }
        }
        Row(
            // The white composer, raised (DESIGN.md), so it doesn't merge with the bar below it.
            Modifier.fillMaxWidth().shadow(6.dp, RoundedCornerShape(28.dp)).clip(RoundedCornerShape(28.dp)).background(cs.raised).padding(start = 6.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.Bottom,
        ) {
            if (status?.photos != false) {
                FilledTonalIconButton(onClick = photo, colors = IconButtonDefaults.filledTonalIconButtonColors(containerColor = cs.surfaceContainerHigh), shapes = IconButtonDefaults.shapes()) {
                    Icon(Glyphs["camera"], stringResource(R.string.common_add_a_photo), Modifier.size(22.dp))
                }
            }
            if (status?.voice != false) {
                FilledTonalIconButton(onClick = voice, colors = IconButtonDefaults.filledTonalIconButtonColors(containerColor = cs.surfaceContainerHigh), shapes = IconButtonDefaults.shapes()) {
                    Icon(Glyphs["mic"], stringResource(R.string.chat_speak_your_message), Modifier.size(22.dp))
                }
            }
            Box(Modifier.weight(1f).heightIn(min = 44.dp).padding(horizontal = 8.dp, vertical = 11.dp), contentAlignment = Alignment.CenterStart) {
                if (chat.draft.isEmpty()) Text(stringResource(R.string.common_ask_your_coach), color = cs.onSurfaceVariant, style = MaterialTheme.typography.bodyLarge)
                BasicTextField(
                    value = chat.draft,
                    onValueChange = { chat.draft = it },
                    modifier = Modifier.fillMaxWidth().focusRequester(focus),
                    textStyle = MaterialTheme.typography.bodyLarge.copy(color = cs.onSurface),
                    cursorBrush = SolidColor(cs.primary),
                    maxLines = 6,
                )
            }
            val can = (chat.draft.isNotBlank() || chat.photo != null) && !chat.busy
            Box(
                Modifier.size(44.dp).press(label = stringResource(R.string.common_send), onClick = { if (can) chat.send(chat.draft) }).clip(CircleShape).background(if (can) cs.primary else cs.surfaceContainerHighest),
                contentAlignment = Alignment.Center,
            ) {
                if (chat.busy) LoadingIndicator(Modifier.size(28.dp))
                else Icon(Glyphs["up"], stringResource(R.string.common_send), Modifier.size(20.dp).graphicsLayer { rotationZ = 90f }, tint = if (can) cs.onPrimary else cs.onSurfaceVariant)
            }
        }
    }
}

/**
 * A route in the chat: its line drawn big (north up, the start marked), name, distance, climb,
 * how green, whether it's on the watch; tap it to open it in Routes.
 */
@Composable
private fun RouteCardInChat(r: ChatRoute, open: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    val data = LocalData.current
    val km = String.format(java.util.Locale.getDefault(), "%.1f", r.km)
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(22.dp)).press(scale = 0.98f, label = stringResource(R.string.chat_open_the_route, r.name), onClick = open).background(cs.surfaceContainerHighest),
    ) {
        Box(Modifier.fillMaxWidth().heightIn(min = 150.dp, max = 150.dp).background(cs.primaryContainer.copy(alpha = 0.45f))) {
            RouteLine(r.preview, Modifier.fillMaxSize().padding(10.dp), stringResource(R.string.common_map_of, r.name), startDot = true, width = 4f)
            if (r.onWatch) Row(Modifier.align(Alignment.TopEnd).padding(10.dp).clip(CircleShape).background(cs.surface).padding(horizontal = 10.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Glyphs["watch"], null, Modifier.size(14.dp), tint = data.good)
                Spacer(Modifier.width(4.dp))
                Text(stringResource(R.string.common_on_your_watch_label), style = MaterialTheme.typography.labelMedium)
            }
        }
        Row(Modifier.padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(r.name, style = MaterialTheme.typography.titleMedium, maxLines = 2)
                Text(listOfNotNull(stringResource(R.string.common_n_km, km), r.ascent?.let { stringResource(R.string.common_m_climb, it) }, if (r.loop) "loop" else null).joinToString(" · "), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
                r.scenery?.let { Text(it.replaceFirstChar { c -> c.uppercase() }, style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant, maxLines = 2) }
            }
            Icon(Glyphs["chevron"], null, Modifier.size(20.dp), tint = cs.onSurfaceVariant)
        }
    }
}
