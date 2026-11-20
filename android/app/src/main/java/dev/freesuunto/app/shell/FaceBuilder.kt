package dev.freesuunto.app.shell

import androidx.compose.ui.res.stringResource
import dev.freesuunto.app.R
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

/** The builder's swatches (web/views/face.ts PALETTE). */
val FACE_PALETTE get() = listOf(
    str(R.string.face_colour_tartan) to "#e0452b", str(R.string.common_finish) to "#ff6a4d", str(R.string.face_colour_brick) to "#a8321f", str(R.string.face_colour_deep_tartan) to "#7d2615", str(R.string.face_colour_rust) to "#5a1f14", str(R.string.face_colour_ember) to "#3d120a",
    str(R.string.face_colour_cream) to "#fdf3ee", str(R.string.face_colour_white) to "#ffffff", str(R.string.face_colour_stone) to "#8f817d", str(R.string.face_colour_slate) to "#5a5250", str(R.string.face_colour_graphite) to "#3d3634", str(R.string.face_colour_ink) to "#201a19", str(R.string.face_black) to "#000000",
    str(R.string.face_colour_infield) to "#8fe3b4", str(R.string.face_colour_moss) to "#4f9a6f", str(R.string.face_colour_pine) to "#1f5c3a", str(R.string.face_colour_forest) to "#0f2a1c",
    str(R.string.face_colour_lane_blue) to "#a3c6ff", str(R.string.face_colour_steel) to "#6f8fbf", str(R.string.face_colour_navy) to "#2a5fa8", str(R.string.face_colour_midnight) to "#1d3557", str(R.string.face_colour_deep_sea) to "#13233a",
    str(R.string.face_colour_amber) to "#ffbe3d", str(R.string.face_colour_gold) to "#b8860b", str(R.string.face_colour_lilac) to "#c588ff", str(R.string.face_colour_rose) to "#ff467e",
)
private val ARTS get() = listOf("none" to str(R.string.common_none), "sunburst" to str(R.string.face_sunburst), "stripes" to str(R.string.face_racing_stripes), "split" to str(R.string.face_split), "rings" to str(R.string.face_rings), "zones" to str(R.string.face_heart_zones), "contours" to str(R.string.face_contours), "checker" to str(R.string.face_chequered), "lanes" to str(R.string.face_lanes), "halftone" to str(R.string.face_halftone), "watermark" to str(R.string.face_big_t))
private val PARTS get() = listOf("hands" to str(R.string.face_hands), "marks" to str(R.string.face_five_minute_marks), "minor" to str(R.string.face_minute_marks), "numerals" to str(R.string.face_numerals), "track" to str(R.string.face_track), "finish" to str(R.string.face_finish_line), "logo" to str(R.string.face_the_t), "text" to str(R.string.face_text), "caps" to str(R.string.face_centre_caps), "art" to str(R.string.face_pattern))

class FacePreset(val name: String, val design: JSONObject, val picture: ImageBitmap?)

/**
 * #face/<id>, new, copy, native (web/views/face.ts): a watch face for the Run 2. The design is the
 * page's FaceDesign as JSON; the page draws it (facePreview) and saves, packs and installs it.
 */
class FaceModel(private val scope: CoroutineScope, private val api: SettingsApi, val arg: String, private val onSaved: () -> Unit = {}) {
    var d by mutableStateOf<JSONObject?>(null)
    var saved by mutableStateOf(false)
    var savedId by mutableStateOf<String?>(null)
    var dirty by mutableStateOf(false)
    var presets by mutableStateOf<List<FacePreset>>(emptyList())
    var preview by mutableStateOf<ImageBitmap?>(null)
    var showData by mutableStateOf(true)
    var canBluetooth by mutableStateOf(false)
    var busy by mutableStateOf<String?>(null)
    var status by mutableStateOf<String?>(null)
    var said by mutableStateOf<String?>(null)
    /** Which part the palette colours: a key of colours, or s0…s6 for the seconds hand. */
    var part by mutableStateOf("hands")
    private var leaveArmed = false

    fun load() = scope.launch {
        val r = api.call("faceStart", JSONObject().put("arg", arg).put("size", 200)).getOrElse { said = it.message ?: str(R.string.face_couldn_t_open_the_face); return@launch }
        val o = JSONObject(r)
        saved = o.optBoolean("saved")
        canBluetooth = o.optBoolean("canBluetooth")
        dirty = !saved
        d = o.getJSONObject("design")
        val a = o.optJSONArray("presets") ?: JSONArray()
        presets = (0 until a.length()).mapNotNull { a.optJSONObject(it) }.map { p -> FacePreset(p.optString("name"), p.getJSONObject("design"), picture(if (p.isNull("picture")) null else p.optString("picture"))) }
    }

    /** A change: a copy of the design, so the screen and the preview follow. */
    fun edit(f: JSONObject.() -> Unit) {
        val cur = d ?: return
        d = JSONObject(cur.toString()).apply(f)
        dirty = true
    }
    fun colours(): JSONObject = d?.optJSONObject("colours") ?: JSONObject()
    fun seconds(): JSONArray = d?.optJSONArray("seconds") ?: JSONArray()
    fun bg(): JSONObject = d?.optJSONObject("background") ?: JSONObject().put("kind", "black")

    fun colourOf(p: String): String = if (p.startsWith("s")) seconds().optString(p.drop(1).toInt()) else colours().optString(p)
    fun setColour(c: String) {
        val p = part
        edit { if (p.startsWith("s")) getJSONArray("seconds").put(p.drop(1).toInt(), c) else getJSONObject("colours").put(p, c) }
    }

    /** Start again from a design (or a surprise), keeping the name and id. */
    fun replace(next: JSONObject) {
        val cur = d ?: return
        d = JSONObject(next.toString()).put("id", cur.optString("id")).put("name", cur.optString("name"))
        dirty = true
    }
    fun surprise() = scope.launch {
        val id = d?.optString("id") ?: return@launch
        api.call("faceSurprise", JSONObject().put("id", id)).onSuccess { replace(JSONObject(it)) }.onFailure { said = it.message }
    }

    suspend fun drawPreview() {
        val cur = d ?: return
        api.call("facePreview", JSONObject().put("design", cur).put("size", 600).put("data", showData)).onSuccess { r ->
            picture(runCatching { JSONArray("[$r]").optString(0) }.getOrNull())?.let { preview = it }
        }
    }

    /** Saved first (installing and packing work on the saved face). */
    private suspend fun persist(): String? {
        val cur = d ?: return null
        val r = api.call("faceSave", JSONObject().put("design", cur).put("saved", saved)).getOrElse { said = it.message; return null }
        val f = JSONObject(r)
        d = f; saved = true; dirty = false; savedId = f.optString("id")
        onSaved()
        return f.optString("id")
    }
    private fun run(label: String, f: suspend () -> Unit): kotlinx.coroutines.Job? {
        if (busy != null) return null
        busy = label
        return scope.launch { try { f() } finally { busy = null } }
    }
    fun save() = run("save") { persist()?.let { said = str(R.string.common_saved_name, d?.optString("name").toString()) } }
    fun install() = run("install") {
        val id = persist() ?: return@run
        status = str(R.string.face_sending_to_your_watch)
        api.call("faceInstall", JSONObject().put("id", id)).onSuccess { status = runCatching { JSONArray("[$it]").optString(0) }.getOrNull()?.ifEmpty { null } ?: str(R.string.face_on_your_watch) }.onFailure { status = null; said = it.message }
    }
    fun pack() = run("zip") { val id = persist() ?: return@run; api.call("facePackage", JSONObject().put("id", id)).onFailure { said = it.message } }
    fun removeFromWatch() = run("remove") {
        val cur = d ?: return@run
        api.call("faceRemove", JSONObject().put("id", cur.optString("id")).put("name", cur.optString("name"))).onSuccess {
            val gone = it == "true"
            status = if (gone) str(R.string.face_off_your_watch_now) else str(R.string.face_it_wasn_t_on_your_watch)
        }.onFailure { said = it.message }
    }
    fun delete(after: (String) -> Unit) = run("delete") {
        val cur = d ?: return@run
        val (st, _) = api.send("/api/faces/${cur.optString("id")}", "DELETE", null)
        if (st in 200..299) { onSaved(); dirty = false; after(str(R.string.face_deleted, cur.optString("name"))) } else said = str(R.string.face_couldn_t_delete_it, st)
    }

    /** Photo: cropped square from the middle, 466 px, as JPEG (web/lib/faces.ts photoBackground). */
    fun photo(context: android.content.Context, uri: Uri) = run("photo") {
        val url = withContext(Dispatchers.IO) {
            runCatching {
                val src = context.contentResolver.openInputStream(uri)!!.use { BitmapFactory.decodeStream(it) }
                val side = minOf(src.width, src.height)
                val sq = Bitmap.createBitmap(src, (src.width - side) / 2, (src.height - side) / 2, side, side)
                val out = Bitmap.createScaledBitmap(sq, 466, 466, true)
                val bytes = java.io.ByteArrayOutputStream().also { out.compress(Bitmap.CompressFormat.JPEG, 85, it) }.toByteArray()
                "data:image/jpeg;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
            }.getOrNull()
        } ?: run { said = str(R.string.face_couldn_t_read_that_photo); return@run }
        val dim = bg().takeIf { it.optString("kind") == "photo" }?.optDouble("dim", 0.35) ?: 0.35
        edit { put("background", JSONObject().put("kind", "photo").put("image", url).put("dim", dim)) }
    }

    /** Leaving with changes asks once. */
    fun mayLeave(): Boolean {
        if (!dirty || d == null || leaveArmed) return true
        leaveArmed = true
        said = str(R.string.face_this_face_has_changes_that_aren)
        scope.launch { delay(4000); leaveArmed = false }
        return false
    }
}

private fun hex(c: String): Color = runCatching { Color(android.graphics.Color.parseColor(c)) }.getOrDefault(Color.Black)

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun FaceBuilderScreen(m: FaceModel, back: () -> Unit, go: (String, String?) -> Unit, navSpace: Boolean = true) {
    val cs = MaterialTheme.colorScheme
    val top = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    val bottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    LaunchedEffect(m) { if (m.d == null) m.load() }
    // The preview follows each change, and the clock.
    var minute by remember { mutableStateOf(0L) }
    LaunchedEffect(Unit) { while (true) { minute = System.currentTimeMillis() / 60_000; delay(5_000) } }
    LaunchedEffect(m.d, m.showData, minute) { delay(120); m.drawPreview() }
    Box(Modifier.fillMaxSize().background(cs.surface)) {
        Column(Modifier.fillMaxSize().padding(top = top + 60.dp)) {
            // The watch stays in view while the controls scroll under it.
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                FilledTonalIconButton(onClick = back) { Icon(Glyphs["chevron"], stringResource(R.string.common_back), Modifier.size(20.dp).graphicsLayer { scaleX = -1f }) }
                Column(Modifier.weight(1f).padding(start = 12.dp)) {
                    Text(stringResource(R.string.face_face_builder), style = MaterialTheme.typography.headlineSmall, modifier = Modifier.semantics { heading() })
                    Text(stringResource(R.string.face_a_watch_face_for_your_suunto), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
                }
            }
            Box(Modifier.fillMaxWidth().padding(vertical = 12.dp), contentAlignment = Alignment.Center) {
                Box(Modifier.size(184.dp).clip(CircleShape).background(Color(0xFF2A2423)).padding(8.dp).clip(CircleShape).background(Color.Black), contentAlignment = Alignment.Center) {
                    val p = m.preview
                    if (p != null) Image(p, stringResource(R.string.face_the_face_as_it_stands), Modifier.fillMaxSize()) else LoadingIndicator()
                }
            }
            val d = m.d
            if (d == null) return@Column
            Column(
                Modifier.fillMaxWidth().weight(1f).imePadding().verticalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, bottom = bottom + if (navSpace) 104.dp else 24.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Start(m, d)
                Background(m, d)
                SetCard(stringResource(R.string.face_track_and_marks), "loop") {
                    Choices(stringResource(R.string.face_track), listOf("lanes" to stringResource(R.string.face_lanes), "filled" to stringResource(R.string.face_filled), "single" to stringResource(R.string.face_one_ring), "dashed" to stringResource(R.string.face_dashes), "bezel" to stringResource(R.string.face_bezel_with_minutes), "none" to stringResource(R.string.common_none)), d.optString("track")) { v -> m.edit { put("track", v) } }
                    SwitchRow(stringResource(R.string.face_finish_line_at_12), stringResource(R.string.face_across_the_track_like_the_line), d.optBoolean("finish")) { on -> m.edit { put("finish", on) } }
                    Choices(stringResource(R.string.face_marks), listOf("all" to stringResource(R.string.face_every_minute), "fives" to stringResource(R.string.face_every_five), "quarters" to stringResource(R.string.face_quarters), "none" to stringResource(R.string.common_none)), d.optString("marks")) { v -> m.edit { put("marks", v) } }
                    Choices(stringResource(R.string.face_mark_shape), listOf("line" to stringResource(R.string.face_lines), "bar" to stringResource(R.string.face_bars), "dot" to stringResource(R.string.face_dots)), d.optString("markShape")) { v -> m.edit { put("markShape", v) } }
                }
                SetCard(stringResource(R.string.face_numbers_and_text), "clock", sub = stringResource(R.string.face_numbers_only_fit_at_12_and)) {
                    Choices(stringResource(R.string.face_numerals), listOf("none" to stringResource(R.string.common_none), "arabic" to stringResource(R.string.face_12_and_9), "roman" to stringResource(R.string.face_xii_and_ix), "big" to stringResource(R.string.face_one_big_12)), d.optString("numerals")) { v -> m.edit { put("numerals", v) } }
                    Choices(stringResource(R.string.face_above_the_centre), listOf("top" to stringResource(R.string.face_the_t), "text" to stringResource(R.string.face_your_text), "none" to stringResource(R.string.face_nothing)), d.optString("logo")) { v -> m.edit { put("logo", v) } }
                    if (d.optString("logo") == "text") Field(stringResource(R.string.face_your_text_up_to_6_characters), d.optString("text"), { t -> m.edit { put("text", t.take(6)) } }, placeholder = "e.g. SUB3")
                }
                SetCard(stringResource(R.string.face_hands), "watch") {
                    Choices(stringResource(R.string.face_hour_and_minute), listOf("classic" to stringResource(R.string.face_classic), "slim" to stringResource(R.string.face_slim), "baton" to stringResource(R.string.face_baton), "sword" to stringResource(R.string.face_sword), "arrow" to stringResource(R.string.face_arrow), "skeleton" to stringResource(R.string.face_skeleton), "dauphine" to stringResource(R.string.face_dauphine), "block" to stringResource(R.string.face_block), "pencil" to stringResource(R.string.face_pencil)), d.optString("hands")) { v -> m.edit { put("hands", v) } }
                    Choices(stringResource(R.string.face_seconds), listOf("needle" to stringResource(R.string.face_needle), "lollipop" to stringResource(R.string.face_lollipop), "arrow" to stringResource(R.string.face_arrow), "plain" to stringResource(R.string.face_plain)), d.optString("secondsStyle")) { v -> m.edit { put("secondsStyle", v) } }
                    Choices(stringResource(R.string.face_centre_caps), listOf("dot" to stringResource(R.string.face_dot), "ring" to stringResource(R.string.face_ring), "none" to stringResource(R.string.common_none)), d.optString("caps")) { v -> m.edit { put("caps", v) } }
                }
                Colours(m)
                SetCard(stringResource(R.string.face_data), "info", sub = stringResource(R.string.face_the_watch_draws_its_own_data)) {
                    SwitchRow(stringResource(R.string.face_show_the_watch_s_data), stringResource(R.string.face_in_the_preview_here), m.showData) { m.showData = it }
                }
                Actions(m, go)
            }
        }
        Said(m.said, { m.said = null }, Modifier.align(Alignment.BottomCenter).padding(bottom = bottom + if (navSpace) 96.dp else 16.dp))
    }
}

@Composable
private fun Start(m: FaceModel, d: JSONObject) {
    val cs = MaterialTheme.colorScheme
    SetCard(stringResource(R.string.face_your_face), "watch") {
        Field(stringResource(R.string.common_name), d.optString("name"), { t -> m.edit { put("name", t.take(30)) } })
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.face_start_from_a_design), style = MaterialTheme.typography.labelLarge, color = cs.onSurfaceVariant, modifier = Modifier.weight(1f))
            FilledTonalButton(onClick = { m.surprise() }) { Icon(Glyphs["spark"], null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text(stringResource(R.string.face_surprise_me)) }
        }
        LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            itemsIndexed(m.presets) { _, p ->
                Column(Modifier.width(84.dp).press(scale = 0.95f, label = stringResource(R.string.face_start_from, p.name)) { m.replace(p.design) }, horizontalAlignment = Alignment.CenterHorizontally) {
                    Box(Modifier.size(76.dp).clip(CircleShape).background(Color.Black)) { p.picture?.let { Image(it, null, Modifier.fillMaxSize()) } }
                    Text(p.name, style = MaterialTheme.typography.labelMedium, maxLines = 2, textAlign = androidx.compose.ui.text.style.TextAlign.Center, modifier = Modifier.padding(top = 4.dp))
                }
            }
        }
    }
}

@Composable
private fun Background(m: FaceModel, d: JSONObject) {
    val context = LocalContext.current
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri -> if (uri != null) m.photo(context, uri) }
    val bg = m.bg()
    val kind = bg.optString("kind", "black")
    SetCard(stringResource(R.string.face_background), "sun", sub = stringResource(R.string.face_black_is_kindest_to_the_battery)) {
        Choices(stringResource(R.string.face_background), listOf("black" to stringResource(R.string.face_black), "colour" to stringResource(R.string.face_colour), "gradient" to stringResource(R.string.face_gradient), "tartan" to stringResource(R.string.face_tartan_plaid), "photo" to stringResource(R.string.face_photo)), kind) { v ->
            m.edit {
                put("background", when (v) {
                    "colour" -> JSONObject().put("kind", "colour").put("colour", "#201a19")
                    "gradient" -> JSONObject().put("kind", "gradient").put("from", "#5a1f14").put("to", "#000000")
                    "tartan" -> JSONObject().put("kind", "tartan").put("colour", "#7d2615").put("dim", 0.45)
                    "photo" -> JSONObject().put("kind", "photo").put("image", "").put("dim", 0.35)
                    else -> JSONObject().put("kind", "black")
                })
            }
        }
        fun set(k: String, v: Any) = m.edit { getJSONObject("background").put(k, v) }
        when (kind) {
            "colour" -> Palette(bg.optString("colour")) { set("colour", it) }
            "gradient" -> { Label(str(R.string.face_centre)); Palette(bg.optString("from")) { set("from", it) }; Label(str(R.string.face_edge)); Palette(bg.optString("to")) { set("to", it) } }
            "tartan" -> { Label(str(R.string.face_plaid_colour)); Palette(bg.optString("colour")) { set("colour", it) } }
            "photo" -> FilledTonalButton(onClick = { pick.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }, enabled = m.busy == null) {
                Icon(Glyphs["camera"], null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text(if (bg.optString("image").isNotEmpty()) str(R.string.common_another_photo) else str(R.string.face_choose_a_photo))
            }
        }
        if (kind == "tartan" || kind == "photo") {
            Label(str(R.string.face_darken_it_so_the_hands_stand))
            var dim by remember(kind, bg.optDouble("dim")) { mutableStateOf(bg.optDouble("dim", 0.35).toFloat()) }
            Slider(dim, { dim = it }, valueRange = 0f..0.8f, steps = 15, onValueChangeFinished = { set("dim", dim.toDouble()) })
        }
        Choices(str(R.string.face_pattern), ARTS, d.optString("art")) { v -> m.edit { put("art", v) } }
        Text(str(R.string.face_the_pattern_takes_its_colour_from), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun Colours(m: FaceModel) {
    SetCard(stringResource(R.string.common_colours), "drop", sub = stringResource(R.string.face_pick_a_part_then_its_colour)) {
        PartChips(m, PARTS)
        Label(stringResource(R.string.face_seconds_hand_the_watch_lets_you))
        PartChips(m, (0 until 7).map { "s$it" to if (it == 0) stringResource(R.string.face_1_default) else "${it + 1}" })
        Palette(m.colourOf(m.part)) { m.setColour(it) }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PartChips(m: FaceModel, parts: List<Pair<String, String>>) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        parts.forEach { (k, label) ->
            FilterChip(m.part == k, { m.part = k }, label = { Text(label) }, leadingIcon = {
                Box(Modifier.size(14.dp).clip(CircleShape).background(hex(m.colourOf(k))).border(1.dp, MaterialTheme.colorScheme.outlineVariant, CircleShape))
            })
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Choices(label: String, options: List<Pair<String, String>>, now: String, onPick: (String) -> Unit) {
    val view = LocalView.current
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Label(label)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            options.forEach { (v, text) ->
                FilterChip(now == v, { onPick(v) }, label = { Text(text) }, leadingIcon = if (now == v) { { Icon(Glyphs["check"], null, Modifier.size(16.dp)) } } else null)
            }
        }
    }
}

@Composable
private fun Label(text: String) = Text(text, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)

/** The swatches, and any colour as #rrggbb. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Palette(now: String, onPick: (String) -> Unit) {
    val cs = MaterialTheme.colorScheme
    val view = LocalView.current
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            FACE_PALETTE.forEach { (name, c) ->
                val on = now.equals(c, ignoreCase = true)
                Box(
                    Modifier.size(36.dp).semantics { contentDescription = name; selected = on }
                        .press(scale = 0.9f, label = name) { view.feel(Haptic.Click); onPick(c) }
                        .clip(CircleShape).background(hex(c)).border(if (on) 3.dp else 1.dp, if (on) cs.primary else cs.outlineVariant, CircleShape),
                    contentAlignment = Alignment.Center,
                ) { if (on) Icon(Glyphs["check"], null, Modifier.size(16.dp), tint = if (android.graphics.Color.luminance(android.graphics.Color.parseColor(c)) > 0.5f) Color.Black else Color.White) }
            }
        }
        var text by remember(now) { mutableStateOf(now) }
        Field(stringResource(R.string.face_any_colour), text, { t -> text = t; if (Regex("^#[0-9a-fA-F]{6}$").matches(t)) onPick(t.lowercase()) }, placeholder = "#e0452b")
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun Actions(m: FaceModel, go: (String, String?) -> Unit) {
    val cs = MaterialTheme.colorScheme
    val view = LocalView.current
    SetCard(stringResource(R.string.face_save_and_send), "send") {
        Button(onClick = { view.feel(Haptic.Confirm); m.save() }, enabled = m.busy == null, modifier = Modifier.fillMaxWidth().height(52.dp), shapes = ButtonDefaults.shapes()) {
            if (m.busy == "save") LoadingIndicator(Modifier.size(22.dp), color = cs.onPrimary) else Text(if (m.saved && !m.dirty) stringResource(R.string.common_saved) else stringResource(R.string.common_save))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilledTonalButton(onClick = { m.install() }, enabled = m.busy == null && m.canBluetooth, modifier = Modifier.weight(1f)) { Icon(Glyphs["watch"], null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text(stringResource(R.string.face_install_on_watch)) }
            TextButton(onClick = { m.pack() }, enabled = m.busy == null) { Icon(Glyphs["down"], null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text(".zip") }
        }
        if (!m.canBluetooth) Text(stringResource(R.string.face_installing_needs_bluetooth_connect_the_watch), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
        m.status?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
        if (m.saved) {
            var offArmed by remember { mutableStateOf(false) }
            var delArmed by remember { mutableStateOf(false) }
            LaunchedEffect(offArmed, delArmed) { if (offArmed || delArmed) { delay(4000); offArmed = false; delArmed = false } }
            ButtonFlow(gap = 4.dp) {
                TextButton(onClick = { if (offArmed) { offArmed = false; m.removeFromWatch() } else offArmed = true }, enabled = m.busy == null && m.canBluetooth) { ButtonText(if (offArmed) stringResource(R.string.common_tap_again_to_remove) else stringResource(R.string.face_remove_from_watch), color = cs.error) }
                TextButton(onClick = { if (delArmed) { delArmed = false; m.delete { word -> go("settings/watch", word) } } else delArmed = true }, enabled = m.busy == null) { ButtonText(if (delArmed) stringResource(R.string.face_tap_again_to_delete) else stringResource(R.string.face_delete_face), color = cs.error) }
            }
        }
    }
}
