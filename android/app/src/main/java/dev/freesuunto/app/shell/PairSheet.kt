package dev.freesuunto.app.shell

import androidx.compose.ui.res.stringResource
import dev.freesuunto.app.R
import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearWavyProgressIndicator
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.ContextCompat
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * Scan a QR code with the back camera (web/lib/qr-scan.ts, native): full screen with a frame, the
 * hint and Cancel. CameraX shows the camera; ZXing (Apache-2.0) reads the frames, on the phone.
 * Android asks for the camera the first time. `done` gets the text, or null when cancelled.
 */
@Composable
fun QrScanner(hint: String, done: (String?) -> Unit) {
    val context = LocalContext.current
    var allowed by remember { mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) }
    var denied by remember { mutableStateOf(false) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok -> allowed = ok; denied = !ok }
    LaunchedEffect(Unit) { if (!allowed) ask.launch(Manifest.permission.CAMERA) }
    Dialog(onDismissRequest = { done(null) }, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            if (allowed) Camera { done(it) }
            // The frame to aim with.
            Box(Modifier.align(Alignment.Center).size(260.dp).border(3.dp, Color.White.copy(alpha = 0.9f), RoundedCornerShape(28.dp)))
            Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().navigationBarsPadding().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Text(
                    if (denied) stringResource(R.string.pair_tartan_can_t_use_the_camera) else hint,
                    color = Color.White, style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.clip(RoundedCornerShape(16.dp)).background(Color.Black.copy(alpha = 0.55f)).padding(horizontal = 16.dp, vertical = 10.dp),
                )
                FilledTonalButton(onClick = { done(null) }) { Icon(Glyphs["close"], null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text(stringResource(R.string.common_cancel)) }
            }
        }
    }
}

@Composable
private fun Camera(found: (String) -> Unit) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val worker = remember { Executors.newSingleThreadExecutor() }
    var seen by remember { mutableStateOf(false) }
    val reader = remember { MultiFormatReader().apply { setHints(mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE), DecodeHintType.TRY_HARDER to true)) } }
    DisposableEffect(Unit) { onDispose { runCatching { ProcessCameraProvider.getInstance(context).get().unbindAll() }; worker.shutdown() } }
    AndroidView(factory = { ctx ->
        val view = PreviewView(ctx).apply { scaleType = PreviewView.ScaleType.FILL_CENTER }
        val future = ProcessCameraProvider.getInstance(ctx)
        future.addListener({
            val provider = future.get()
            val preview = Preview.Builder().build().also { it.surfaceProvider = view.surfaceProvider }
            val analysis = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
            analysis.setAnalyzer(worker) { image ->
                try {
                    if (seen) return@setAnalyzer
                    // The luminance plane is enough for a QR code.
                    val plane = image.planes[0]
                    val buf = plane.buffer
                    val bytes = ByteArray(buf.remaining()).also { buf.get(it) }
                    val source = PlanarYUVLuminanceSource(bytes, plane.rowStride, image.height, 0, 0, image.width, image.height, false)
                    val text = runCatching { reader.decodeWithState(BinaryBitmap(HybridBinarizer(source))).text }.getOrNull()
                    reader.reset()
                    if (text != null) { seen = true; ContextCompat.getMainExecutor(ctx).execute { found(text) } }
                } finally { image.close() }
            }
            runCatching { provider.unbindAll(); provider.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis) }
        }, ContextCompat.getMainExecutor(ctx))
        view
    }, modifier = Modifier.fillMaxSize())
}

/**
 * Pairing with the PC from its QR code (web/views/pc-link.ts openPairLink, native): only addresses
 * on the home network; a link that opened Tartan, or one that replaces the PC paired now, asks
 * first; then find the PC, pair (end to end encrypted), and bring both up to date.
 */
class PairModel(private val scope: CoroutineScope, private val api: SettingsApi, val urls: List<String>, val code: String, private val ask: Boolean) {
    /** check, notyours, ask, finding, syncing, done, failed */
    var phase by mutableStateOf("check")
    var where by mutableStateOf(urls.joinToString(" · ") { it.removePrefix("http://").removePrefix("https://") })
    var replacing by mutableStateOf<String?>(null)
    var name by mutableStateOf<String?>(null)
    var line by mutableStateOf("")
    var reopen by mutableStateOf(false)
    var error by mutableStateOf("")
    private var home: List<String> = emptyList()

    fun start() = scope.launch {
        val r = api.call("pairCheck", JSONObject().put("urls", JSONArray(urls))).getOrElse { error = it.message ?: ""; phase = "failed"; return@launch }
        val o = JSONObject(r)
        val h = o.optJSONArray("home") ?: JSONArray()
        home = (0 until h.length()).map { h.optString(it) }
        if (home.isEmpty()) { phase = "notyours"; return@launch }
        val rep = o.optBoolean("replacing")
        replacing = if (rep) o.optString("current").ifEmpty { str(R.string.pair_your_pc) } else null
        if (ask || rep) phase = "ask" else connect()
    }

    fun connect() {
        phase = "finding"
        scope.launch {
            val r = api.call("pairConnect", JSONObject().put("urls", JSONArray(home)).put("code", code)).getOrElse { error = it.message ?: ""; phase = "failed"; return@launch }
            val o = JSONObject(r)
            where = o.optString("url").removePrefix("http://")
            name = o.optString("name").ifEmpty { null }
            phase = "syncing"
            val s = api.call("pairSync").getOrElse { line = str(R.string.pair_stopped_sync_now_in_settings_sources, it.message); phase = "done"; return@launch }
            val d = JSONObject(s)
            line = d.optString("line")
            reopen = d.optInt("pulled") > 0 || d.optBoolean("changed")
            phase = "done"
        }
    }

    fun finish(close: () -> Unit) { if (reopen) scope.launch { api.call("reopen") } ; close() }
}

@Composable
fun PairSheet(m: PairModel, onClose: () -> Unit) {
    LaunchedEffect(m) { if (m.phase == "check") m.start() }
    Sheet(onClose) { close -> PairBody(m, close) }
}

/** The pairing sheet's content (tested on its own). */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun PairBody(m: PairModel, close: () -> Unit, modifier: Modifier = Modifier) {
    val cs = MaterialTheme.colorScheme
    Column(modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, bottom = 28.dp).navigationBarsPadding(), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Row(verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f)) {
                Text(
                    when (m.phase) { "notyours" -> stringResource(R.string.pair_not_your_pc); "ask" -> if (m.replacing != null) stringResource(R.string.pair_pair_with_a_different_pc) else stringResource(R.string.pair_pair_with_this_pc); "failed" -> stringResource(R.string.pair_couldn_t_pair); "syncing", "done" -> stringResource(R.string.pair_paired_with, m.name ?: stringResource(R.string.pair_your_pc)); else -> stringResource(R.string.pair_pairing_with_your_pc) },
                    style = MaterialTheme.typography.headlineSmall, modifier = Modifier.semantics { heading() },
                )
                Text(m.where, style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
            }
            FilledTonalIconButton(onClick = close) { Icon(Glyphs["close"], stringResource(R.string.common_close)) }
        }
        when (m.phase) {
            "notyours" -> {
                Text(stringResource(R.string.pair_this_pairing_link_points_outside_your), style = MaterialTheme.typography.bodyLarge)
                Text(stringResource(R.string.pair_pair_only_with_the_code_your), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
            }
            "ask" -> {
                Text(stringResource(R.string.pair_pair_only_if_you_just_scanned), style = MaterialTheme.typography.bodyLarge)
                m.replacing?.let { Text(stringResource(R.string.pair_this_replaces_the_pairing_with, it), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant) }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { m.connect() }, shapes = ButtonDefaults.shapes()) { Icon(Glyphs["phone"], null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text(stringResource(R.string.pair_pair)) }
                    TextButton(onClick = close) { Text(stringResource(R.string.common_cancel)) }
                }
            }
            "check", "finding" -> Row(verticalAlignment = Alignment.CenterVertically) {
                LoadingIndicator(Modifier.size(36.dp)); Spacer(Modifier.width(12.dp))
                Text(if (m.phase == "check") stringResource(R.string.pair_reading_the_code) else stringResource(R.string.pair_looking_for_your_pc_on_this), style = MaterialTheme.typography.bodyLarge)
            }
            "syncing" -> {
                Text(stringResource(R.string.pair_bringing_this_phone_and_your_pc), style = MaterialTheme.typography.bodyLarge)
                LinearWavyProgressIndicator(Modifier.fillMaxWidth().height(10.dp))
            }
            "done" -> {
                Text(m.line, style = MaterialTheme.typography.bodyLarge)
                Button(onClick = { m.finish(close) }, modifier = Modifier.fillMaxWidth().height(52.dp), shapes = ButtonDefaults.shapes()) { Text(if (m.reopen) stringResource(R.string.common_open_tartan) else stringResource(R.string.common_done)) }
            }
            "failed" -> {
                Text(m.error, style = MaterialTheme.typography.bodyLarge)
                Text(stringResource(R.string.pair_fix_that_show_a_new_code), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
            }
        }
    }
}
