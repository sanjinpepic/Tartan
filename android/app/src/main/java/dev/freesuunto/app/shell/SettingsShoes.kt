package dev.freesuunto.app.shell

import androidx.compose.ui.res.stringResource
import dev.freesuunto.app.R
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.os.Build
import android.provider.MediaStore
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.time.LocalDate

/** A pair of shoes with what's on them (src/shoes.ts ShoeTotal). */
data class Pair2(
    val id: String, val name: String, val since: String, val startKm: Double, val limitKm: Double, val kind: String?,
    val retired: String?, val stravaId: String?, val photo: String?, val km: Double, val runs: Int, val used: Double,
) {
    val type get() = kind ?: kindFromName(name)
}

private val RACING = Regex("\\b(vaporfly|alphafly|metaspeed|adios pro|adizero pro|endorphin (pro|elite)|rocket ?x|sc elite|fuelcell elite|deviate elite|cielo|takumi|racer|spikes?)\\b", RegexOption.IGNORE_CASE)
private val TRAIL = Regex("\\b(trail|speedgoat|peregrine|cascadia|xodus|mafate|torrent|sense ride|genesis|terrex|hierro|wildhorse|ultra glide|catamount|agility peak|lone peak)\\b", RegexOption.IGNORE_CASE)
/** A guess from the name alone (src/shoes.ts kindFromName). */
fun kindFromName(name: String) = if (RACING.containsMatchIn(name)) "racing" else if (TRAIL.containsMatchIn(name)) "trail" else "daily"
fun limitFor(kind: String) = if (kind == "racing") 400 else 700
private val KIND_NAME get() = linkedMapOf("daily" to str(R.string.settings_daily), "racing" to str(R.string.settings_racing), "trail" to str(R.string.settings_trail))
private fun runs(n: Int) = plural(R.plurals.common_runs, n, n)

private fun JSONObject.text(k: String): String? = if (!has(k) || isNull(k)) null else optString(k).ifEmpty { null }

/** Shoes in Settings → Training (web/views/shoes.ts shoesCard): read, add, edit, retire, remove, set on Strava. */
class ShoesModel(private val scope: CoroutineScope, private val api: SettingsApi) {
    var shoes by mutableStateOf<List<Pair2>?>(null)
    var stravaOn by mutableStateOf(false)
    var stravaWrite by mutableStateOf(false)
    var toStrava by mutableStateOf<Map<String, Int>>(emptyMap())
    var coachReady by mutableStateOf(false)
    var said by mutableStateOf<String?>(null)
    var busy by mutableStateOf(false)
    private val photos = HashMap<String, ImageBitmap?>()

    fun load() = scope.launch {
        api.get("/api/shoes")?.let { runCatching { read(it) } }
        api.get("/api/coach/status")?.let { coachReady = runCatching { JSONObject(it).optBoolean("ready") }.getOrDefault(false) }
    }

    private fun read(json: String) {
        val v = JSONObject(json)
        val a = v.optJSONArray("shoes")
        shoes = if (a == null) emptyList() else (0 until a.length()).mapNotNull { a.optJSONObject(it) }.map { s ->
            Pair2(s.optString("id"), s.optString("name"), s.optString("since"), s.optDouble("start_km", 0.0), s.optDouble("limit_km", 700.0), s.text("kind"), s.text("retired"), s.text("strava_id"), s.text("photo"), s.optDouble("km", 0.0), s.optInt("runs"), s.optDouble("used", 0.0))
        }
        v.optJSONObject("strava")?.let { stravaOn = it.optBoolean("connected"); stravaWrite = it.optBoolean("can_write") }
        toStrava = v.optJSONObject("to_strava")?.let { m -> m.keys().asSequence().associateWith { m.optInt(it) } } ?: emptyMap()
    }

    /** The pair's photo as a picture (decoded once). */
    fun photo(p: Pair2): ImageBitmap? = p.photo?.let { url -> photos.getOrPut(url) { runCatching { Base64.decode(url.substringAfter(","), Base64.DEFAULT).let { android.graphics.BitmapFactory.decodeByteArray(it, 0, it.size)?.asImageBitmap() } }.getOrNull() } }

    private fun send(path: String, method: String, body: JSONObject?, ok: String) {
        busy = true
        scope.launch {
            val (st, text) = api.send(path, method, body?.toString())
            val err = runCatching { JSONObject(text).text("error") }.getOrNull()
            if (st in 200..299 && err == null) { runCatching { read(text) }; said = ok } else said = str(R.string.common_couldnt_save, err ?: str(R.string.common_didnt_go_through_status, st))
            busy = false
        }
    }

    fun save(id: String?, name: String, since: String, startKm: Double, limitKm: Double, kind: String, photo: String?) {
        val b = JSONObject().put("name", name).put("since", since).put("start_km", startKm).put("limit_km", limitKm).put("kind", kind)
        id?.let { b.put("id", it) }
        photo?.let { b.put("photo", it) }
        send("/api/shoes", "PUT", b, if (id != null) str(R.string.settings_saved_2, name.trim()) else str(R.string.settings_added_runs_from_count_to_them, name.trim(), dateShort(since)))
    }

    fun retire(p: Pair2) {
        val b = JSONObject().put("id", p.id).put("name", p.name).put("since", p.since).put("start_km", p.startKm).put("limit_km", p.limitKm).put("retired", if (p.retired != null) "" else LocalDate.now().toString())
        p.kind?.let { b.put("kind", it) }
        p.stravaId?.let { b.put("strava_id", it) }
        send("/api/shoes", "PUT", b, if (p.retired != null) str(R.string.settings_back_in_use, p.name) else str(R.string.settings_retired_at_km_new_runs_count, p.name, Math.round(p.km)))
    }

    fun remove(p: Pair2) = send("/api/shoes/${java.net.URLEncoder.encode(p.id, "UTF-8")}", "DELETE", null, str(R.string.settings_removed_its_runs_count_to_your, p.name))

    fun toStrava(p: Pair2) {
        busy = true
        scope.launch {
            val (st, text) = api.send("/api/shoes/strava", "POST", JSONObject().put("shoe", p.id).toString())
            val r = runCatching { JSONObject(text) }.getOrNull()
            said = if (st in 200..299 && r != null) str(R.string.shoes_set_on_strava, p.name, runs(r.optInt("done"))) + (if (r.optInt("left") > 0) " " + (r.text("stopped") ?: str(R.string.shoes_more_tap_again, r.optInt("left"))) else "") else str(R.string.settings_couldn_t_set_it_on_strava)
            api.get("/api/shoes")?.let { runCatching { read(it) } }
            busy = false
        }
    }

    /** The coach reads the shoe's name off its photo. */
    suspend fun recognise(photo: String): Triple<String, String, Int>? {
        val (st, text) = api.send("/api/shoes/recognise", "POST", JSONObject().put("photo", photo).toString())
        val r = runCatching { JSONObject(text) }.getOrNull() ?: return null
        if (st !in 200..299) { said = r.text("error") ?: str(R.string.settings_couldn_t_read_it); return null }
        val name = r.text("name") ?: run { said = str(R.string.settings_couldn_t_tell_which_shoe_that); return null }
        return Triple(name, r.optString("kind", "daily"), r.optInt("limit_km", 700))
    }
}

/** A photo of the pair, squared and small (384 px JPEG), as the web keeps it. */
private fun squarePhoto(b: Bitmap): String {
    val side = minOf(b.width, b.height)
    val sq = Bitmap.createBitmap(b, (b.width - side) / 2, (b.height - side) / 2, side, side)
    val small = Bitmap.createScaledBitmap(sq, 384, 384, true)
    val out = ByteArrayOutputStream()
    small.compress(Bitmap.CompressFormat.JPEG, 80, out)
    return "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
}

@Composable
fun ShoesCard(m: ShoesModel, modifier: Modifier) {
    val cs = MaterialTheme.colorScheme
    LaunchedEffect(Unit) { m.load() }
    val list = m.shoes ?: return
    var adding by remember { mutableStateOf(list.isEmpty()) }
    var editing by remember { mutableStateOf<String?>(null) }
    SetCard(
        stringResource(R.string.common_shoes), "run",
        if (list.isNotEmpty()) null
        else if (m.stravaOn) stringResource(R.string.settings_pairs_you_have_on_strava_come)
        else stringResource(R.string.settings_most_last_500_to_800_km),
        modifier,
    ) {
        list.forEach { p ->
            val worn = p.used >= 0.9 && p.retired == null
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(20.dp)).background(cs.surfaceContainerHigh).padding(12.dp).animateContentSize(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(52.dp).clip(RoundedCornerShape(14.dp)).background(cs.surfaceContainerHighest).press(scale = 0.94f, label = stringResource(R.string.settings_edit, p.name), onClick = { editing = if (editing == p.id) null else p.id }), contentAlignment = Alignment.Center) {
                        m.photo(p)?.let { Image(it, null, Modifier.size(52.dp), contentScale = ContentScale.Crop) } ?: Icon(Glyphs["camera"], null, Modifier.size(20.dp), tint = cs.onSurfaceVariant)
                    }
                    Column(Modifier.weight(1f).padding(start = 12.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(p.name, style = MaterialTheme.typography.titleSmall, color = if (p.retired != null) cs.onSurfaceVariant else cs.onSurface, modifier = Modifier.weight(1f, fill = false))
                            if (p.stravaId != null) Icon(Glyphs["strava"], stringResource(R.string.common_on_strava), Modifier.padding(start = 6.dp).size(14.dp), tint = LocalData.current.effort)
                            Spacer(Modifier.weight(1f))
                            Text(stringResource(R.string.common_n_km, Math.round(p.km)), style = MaterialTheme.typography.titleSmall.copy(fontFamily = FlexRound), color = if (worn) LocalData.current.watch else cs.onSurface)
                        }
                        LinearProgressIndicator(progress = { p.used.toFloat().coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp), color = if (worn) LocalData.current.watch else cs.primary)
                        Text(
                            listOf(KIND_NAME[p.type] ?: p.type, if (p.retired != null) stringResource(R.string.settings_retired, dateShort(p.retired), runs(p.runs)) else stringResource(R.string.settings_since_retire_at_km, runs(p.runs), dateShort(p.since), Math.round(p.limitKm))).joinToString(" · "),
                            style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant,
                        )
                    }
                }
                // Strava's button first; Edit and Retire to the end, dropping a line when there's no room.
                androidx.compose.foundation.layout.FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End), verticalArrangement = Arrangement.spacedBy(4.dp), itemVerticalAlignment = Alignment.CenterVertically) {
                    val pending = m.toStrava[p.id] ?: 0
                    if (p.stravaId != null && pending > 0 && m.stravaWrite && p.retired == null) FilledTonalButton(onClick = { m.toStrava(p) }, enabled = !m.busy) { ButtonText(stringResource(R.string.settings_set_on_strava, runs(pending))) }
                    TextButton(onClick = { editing = if (editing == p.id) null else p.id }) { ButtonText(stringResource(R.string.settings_edit_2)) }
                    TextButton(onClick = { m.retire(p) }, enabled = !m.busy) { ButtonText(if (p.retired != null) stringResource(R.string.settings_back_in_use_2) else stringResource(R.string.settings_retire)) }
                }
                AnimatedVisibility(editing == p.id) { PairForm(m, p) { editing = null } }
            }
        }
        val notOnStrava = if (m.stravaOn) list.filter { it.stravaId == null && it.retired == null } else emptyList()
        if (notOnStrava.isNotEmpty()) Text(
            if (notOnStrava.size == 1) stringResource(R.string.shoes_not_on_strava_one, notOnStrava[0].name) else stringResource(R.string.shoes_not_on_strava_many),
            style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant,
        )
        if (list.isNotEmpty() && !adding) TextButton(onClick = { adding = true }) { Icon(Glyphs["plus"], null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text(stringResource(R.string.common_add_a_pair)) }
        AnimatedVisibility(adding) { PairForm(m, null) { adding = false } }
    }
}

/** Add a pair, or edit one: a photo (the coach can read the name off it), name, type, first worn, km already, retire at. */
@Composable
private fun PairForm(m: ShoesModel, pair: Pair2?, done: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    val context = LocalContext.current
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    var name by remember { mutableStateOf(pair?.name ?: "") }
    var kind by remember { mutableStateOf(pair?.type ?: "daily") }
    var kindPicked by remember { mutableStateOf(pair != null) }
    var since by remember { mutableStateOf(pair?.since ?: LocalDate.now().toString()) }
    var start by remember { mutableStateOf(pair?.startKm?.let { Math.round(it).toString() } ?: "0") }
    var limit by remember { mutableStateOf(pair?.limitKm?.let { Math.round(it).toString() } ?: "700") }
    var photo by remember { mutableStateOf<String?>(null) }
    var preview by remember { mutableStateOf<ImageBitmap?>(pair?.let { m.photo(it) }) }
    var armed by remember { mutableStateOf(false) }
    var picking by remember { mutableStateOf(false) }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            val url = withContext(Dispatchers.Default) {
                runCatching {
                    val bmp = if (Build.VERSION.SDK_INT >= 28) ImageDecoder.decodeBitmap(ImageDecoder.createSource(context.contentResolver, uri)) { d, _, _ -> d.allocator = ImageDecoder.ALLOCATOR_SOFTWARE }
                    else @Suppress("DEPRECATION") MediaStore.Images.Media.getBitmap(context.contentResolver, uri)
                    squarePhoto(bmp)
                }.getOrNull()
            }
            if (url != null) {
                photo = url
                preview = Base64.decode(url.substringAfter(","), Base64.DEFAULT).let { android.graphics.BitmapFactory.decodeByteArray(it, 0, it.size)?.asImageBitmap() }
            }
        }
    }
    Column(Modifier.fillMaxWidth().padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(64.dp).clip(RoundedCornerShape(16.dp)).background(cs.surfaceContainerHighest), contentAlignment = Alignment.Center) {
                preview?.let { Image(it, null, Modifier.size(64.dp), contentScale = ContentScale.Crop) } ?: Icon(Glyphs["camera"], null, tint = cs.onSurfaceVariant)
            }
            Column(Modifier.padding(start = 12.dp)) {
                TextButton(onClick = { pick.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }) { Text(if (preview != null) stringResource(R.string.common_another_photo) else stringResource(R.string.common_add_a_photo)) }
                if (photo != null && m.coachReady) FilledTonalButton(onClick = {
                    picking = true
                    scope.launch {
                        m.recognise(photo!!)?.let { (n, k, l) -> name = n; kind = k; limit = "$l"; kindPicked = true; m.said = str(if (k == "racing") R.string.shoes_looks_like_racing else if (k == "trail") R.string.shoes_looks_like_trail else R.string.shoes_looks_like_daily, n) }
                        picking = false
                    }
                }, enabled = !picking) { Text(if (picking) stringResource(R.string.common_reading) else stringResource(R.string.settings_read_the_name_off_it)) }
            }
        }
        Field(stringResource(R.string.common_name), name, { name = it.take(40); if (!kindPicked) { kind = kindFromName(it); limit = "${limitFor(kind)}" } }, placeholder = "e.g. Pegasus 41")
        Text(stringResource(R.string.settings_type), style = MaterialTheme.typography.labelLarge, color = cs.onSurfaceVariant)
        Segmented(KIND_NAME.values.toList(), KIND_NAME.keys.indexOf(kind), { kind = KIND_NAME.keys.elementAt(it); kindPicked = true; limit = "${limitFor(kind)}" })
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Field(stringResource(R.string.settings_first_worn), since, { since = it }, Modifier.weight(1.2f), placeholder = "2026-10-01")
            Field(stringResource(R.string.settings_km_already), start, { start = it }, Modifier.weight(1f), number = true)
            Field(stringResource(R.string.settings_retire_at), limit, { limit = it }, Modifier.weight(1f), number = true)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Button(onClick = { m.save(pair?.id, name, since, start.toDoubleOrNull() ?: 0.0, limit.toDoubleOrNull() ?: 700.0, kind, photo); done() }, enabled = name.isNotBlank() && !m.busy) {
                if (pair == null) { Icon(Glyphs["plus"], null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)) }
                Text(if (pair != null) stringResource(R.string.common_save) else stringResource(R.string.settings_add_the_pair))
            }
            if (pair != null) {
                TextButton(onClick = done) { Text(stringResource(R.string.common_cancel)) }
                TextButton(onClick = { if (armed) { m.remove(pair); done() } else armed = true }) { Text(if (armed) stringResource(R.string.common_tap_again_to_remove) else stringResource(R.string.common_remove), color = cs.error) }
            }
        }
    }
}

