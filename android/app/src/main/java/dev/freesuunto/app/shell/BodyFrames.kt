package dev.freesuunto.app.shell

import androidx.compose.ui.res.stringResource
import dev.freesuunto.app.R
import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.Image
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import androidx.compose.ui.text.withStyle
import org.json.JSONArray
import org.json.JSONObject

/**
 * The 3D body as pictures, drawn by the page's WebGL (lib/body3d.ts bodyFrames, asked as
 * `rpc:body`): the move as a loop, and the key pose all the way round. `cycle`: the loop's
 * seconds (0: a still).
 */
class Frames(val loop: List<ImageBitmap>, val turn: List<ImageBitmap>, val cycle: Double)

/** Pictures asked for this session, by what was asked (the page draws one request at a time). */
private val kept = object : LinkedHashMap<String, Frames>(16, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Frames>?) = size > 40
}

/** Ask the page for the body as pictures; null when it can't draw (no WebGL) or didn't answer. */
suspend fun bodyFrames(api: SettingsApi, args: JSONObject): Frames? {
    val key = args.toString()
    kept[key]?.let { return it }
    val json = api.rpc("body", args) ?: return null
    return withContext(Dispatchers.Default) {
        runCatching {
            val o = JSONObject(json)
            fun images(a: JSONArray?) = if (a == null) emptyList() else (0 until a.length()).mapNotNull { i ->
                val url = a.optString(i)
                val bytes = Base64.decode(url.substringAfter(","), Base64.DEFAULT)
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
            }
            Frames(images(o.optJSONArray("loop")), images(o.optJSONArray("turn")), o.optDouble("cycle", 0.0))
        }.getOrNull()
    }?.also { kept[key] = it }
}

/**
 * The body, moving through its loop; drag sideways to turn it (a low click every eighth of a
 * turn), and let go: it settles back and moves again. Still under reduced motion.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun BodyPictures(frames: Frames?, label: String, modifier: Modifier, waiting: Boolean = frames == null) {
    val view = LocalView.current
    var at by remember(frames) { mutableIntStateOf(0) }
    var turning by remember(frames) { mutableStateOf(false) }
    var turnAt by remember(frames) { mutableFloatStateOf(0f) }
    val still = LocalReducedMotion.current
    LaunchedEffect(frames, turning) {
        val f = frames ?: return@LaunchedEffect
        if (turning || still || f.loop.size < 2 || f.cycle <= 0) return@LaunchedEffect
        val step = (f.cycle * 1000 / f.loop.size).toLong().coerceAtLeast(30)
        while (isActive) { delay(step); at = (at + 1) % f.loop.size }
    }
    Box(modifier.semantics { contentDescription = label }, contentAlignment = Alignment.Center) {
        val f = frames
        if (f == null) {
            if (waiting) LoadingIndicator()
            return@Box
        }
        val turnFrames = f.turn
        val img = if (turning && turnFrames.isNotEmpty()) turnFrames[Math.floorMod(Math.round(turnAt), turnFrames.size)] else f.loop.getOrNull(at) ?: turnFrames.firstOrNull()
        img?.let { Image(it, null, Modifier.fillMaxSize(), contentScale = ContentScale.Fit) }
        if (turnFrames.size > 1) Box(
            Modifier.fillMaxSize().pointerInput(f) {
                var last = 0
                detectHorizontalDragGestures(
                    onDragStart = { turning = true; turnAt = 0f; last = 0 },
                    onDragEnd = { turning = false },
                    onDragCancel = { turning = false },
                ) { change, dx ->
                    change.consume()
                    // A full turn across about the width of the picture.
                    turnAt -= dx / size.width * turnFrames.size
                    val k = Math.floorDiv(Math.round(turnAt), maxOf(1, turnFrames.size / 8))
                    if (k != last) { last = k; view.feel(Haptic.Detent) }
                }
            },
        )
    }
}

/** Under reduced motion (the system's animator scale at 0): bodies hold still. */
val LocalReducedMotion = androidx.compose.runtime.staticCompositionLocalOf { false }

/** The muscles' names (src/strength/exercises.ts MUSCLE_NAME), as Words.MUSCLE. */
fun muscleNames(ids: List<String>) = ids.joinToString(", ") { Words.MUSCLE[it] ?: it }

@Composable
fun Works(primary: List<String>, secondary: List<String>) {
    val cs = MaterialTheme.colorScheme
    Text(
        androidx.compose.ui.text.buildAnnotatedString {
            withStyle(androidx.compose.ui.text.SpanStyle(fontWeight = androidx.compose.ui.text.font.FontWeight.Bold, color = cs.primary)) { append(stringResource(R.string.body_works)) }
            append(muscleNames(primary))
            if (secondary.isNotEmpty()) {
                withStyle(androidx.compose.ui.text.SpanStyle(fontWeight = androidx.compose.ui.text.font.FontWeight.Bold, color = cs.onSurfaceVariant)) { append(stringResource(R.string.body_helps)) }
                append(muscleNames(secondary))
            }
        },
        style = MaterialTheme.typography.bodyMedium,
    )
}
