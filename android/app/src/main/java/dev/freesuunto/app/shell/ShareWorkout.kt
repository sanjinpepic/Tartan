package dev.freesuunto.app.shell

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import dev.freesuunto.app.R
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.math.max

/** What's behind a workout's share card, as the preview's three choices. */
enum class ShareBg(val key: String) {
    COLOUR("colour"), MAP("map"), PHOTO("photo");

    companion object {
        private const val PREFS = "tartan.share"

        /** The last one chosen on this phone (the colour at first). */
        fun last(context: Context): ShareBg = runCatching {
            val k = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("background", null)
            entries.firstOrNull { it.key == k }
        }.getOrNull() ?: COLOUR

        fun keep(context: Context, bg: ShareBg) {
            runCatching { context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("background", bg.key).apply() }
        }
    }
}

/**
 * The share preview's state: the background chosen, the photo, whether the map hides the route's
 * ends (on by default: where a run starts and ends is often home), and the maps made so far (one
 * with the ends, one without).
 */
class ShareState(bg: ShareBg) {
    var bg by mutableStateOf(bg)
    var photo by mutableStateOf<Bitmap?>(null)
    var hideEnds by mutableStateOf(true)
    val maps = mutableStateMapOf<Boolean, ShareCard.Streets>()
    var loadingMap by mutableStateOf(false)
    var mapFailed by mutableStateOf(false)
    var cameraRefused by mutableStateOf(false)
}

/** The backgrounds this workout can have: a map only with a route; a photo always (with no route, no line). */
fun shareChoices(w: Workout): List<ShareBg> = if (w.route.size >= 2) ShareBg.entries else listOf(ShareBg.COLOUR, ShareBg.PHOTO)

/**
 * A workout's share card, previewed before it goes: the card as it will look, Colour / Map /
 * Photo, then Share. Photo opens the system's photo picker (or the camera). The choice is kept
 * on the phone. Nothing is uploaded by Tartan: the map's tiles come from the map's own server.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ShareWorkoutSheet(w: Workout, colour: Int, onClose: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val choices = remember(w) { shareChoices(w) }
    val s = remember(w) { ShareState(ShareBg.last(context).takeIf { it in choices } ?: ShareBg.COLOUR) }
    // Where to go back to when the photo picker is closed without a photo.
    var before by remember { mutableStateOf(ShareBg.COLOUR) }
    fun took(uri: Uri?) {
        if (uri == null) { if (s.photo == null) s.bg = before; return }
        scope.launch {
            val b = photoFrom(context, uri)
            if (b != null) { s.photo = b; s.bg = ShareBg.PHOTO } else if (s.photo == null) s.bg = before
        }
    }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { took(it) }
    val shot = remember { File(File(context.cacheDir, "camera").apply { mkdirs() }, "photo.jpg") }
    val shotUri = remember { runCatching { FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", shot) }.getOrNull() }
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok -> took(if (ok) shotUri else null) }
    fun openCamera() {
        val u = shotUri ?: return
        runCatching { camera.launch(u) }.onFailure { if (s.photo == null) s.bg = before }
    }
    // The app asks for the camera for the PC's QR code, so a camera app needs it granted too.
    val allow = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        s.cameraRefused = !ok
        if (ok) openCamera() else if (s.photo == null) s.bg = before
    }
    fun choosePhoto() {
        before = if (s.bg == ShareBg.PHOTO) before else s.bg
        runCatching { pick.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }
    }
    fun takePhoto() {
        before = if (s.bg == ShareBg.PHOTO) before else s.bg
        s.cameraRefused = false
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) openCamera()
        else allow.launch(Manifest.permission.CAMERA)
    }
    ModalBottomSheet(onDismissRequest = onClose, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = MaterialTheme.colorScheme.surface) {
        SharePreviewBody(
            w, colour, s,
            choose = { bg ->
                s.mapFailed = false
                if (bg == ShareBg.PHOTO && s.photo == null) { before = s.bg; s.bg = bg; choosePhoto() } else s.bg = bg
                ShareBg.keep(context, bg)
            },
            choosePhoto = { choosePhoto() },
            takePhoto = { takePhoto() },
            share = { card -> runCatching { ShareCard.share(context, card, str(R.string.workout_tartan, w.start.take(10))) } },
            modifier = Modifier.verticalScroll(rememberScrollState()).navigationBarsPadding(),
        )
    }
}

/** The preview's content (the sheet's, and the screenshots'). [maps] makes the street map (the real one: MapLibre). */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun SharePreviewBody(
    w: Workout, colour: Int, s: ShareState,
    choose: (ShareBg) -> Unit, choosePhoto: () -> Unit, takePhoto: () -> Unit, share: (Bitmap) -> Unit,
    modifier: Modifier = Modifier,
    maps: suspend (Context, List<Pair<Double, Double>>, Int) -> ShareCard.Streets? = ::cardStreets,
) {
    val cs = MaterialTheme.colorScheme
    val context = LocalContext.current
    val choices = remember(w) { shareChoices(w) }
    // The map, made when it's chosen (or the ends are shown or hidden); offline, the colour stays.
    LaunchedEffect(s.bg, s.hideEnds) {
        if (s.bg != ShareBg.MAP || s.maps[s.hideEnds] != null) return@LaunchedEffect
        val hide = s.hideEnds
        s.loadingMap = true
        val made = maps(context, if (hide) ShareCard.trimEnds(w.route) else w.route, colour)
        s.loadingMap = false
        if (made != null) s.maps[hide] = made
        else if (s.bg == ShareBg.MAP) { s.mapFailed = true; s.bg = ShareBg.COLOUR }
    }
    val map = if (s.bg == ShareBg.MAP) s.maps[s.hideEnds] else null
    val photo = if (s.bg == ShareBg.PHOTO) s.photo else null
    val ends = !(s.bg == ShareBg.MAP && s.hideEnds)
    val card = remember(w, colour, map, photo, ends) {
        ShareCard.workout(context, w, colour, map?.let { ShareCard.Backdrop.Map(it) } ?: photo?.let { ShareCard.Backdrop.Photo(it) } ?: ShareCard.Backdrop.Colour, ends)
    }
    val preview = stringResource(R.string.share_the_picture)
    Column(modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text(stringResource(R.string.workout_share_as_a_picture), style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(horizontal = 4.dp))
        // The card as it will look, as big as leaves room for the choices on the screen.
        BoxWithConstraints(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            val tallest = (LocalConfiguration.current.screenHeightDp * 0.56f).dp
            val wide = minOf(maxWidth, tallest * 0.8f)
            Box(Modifier.width(wide).aspectRatio(0.8f).clip(RoundedCornerShape(24.dp)).semantics { contentDescription = preview }, contentAlignment = Alignment.Center) {
                Image(card.asImageBitmap(), null, Modifier.fillMaxWidth().aspectRatio(0.8f), contentScale = ContentScale.Fit)
                if (s.loadingMap) LoadingIndicator(Modifier.size(56.dp), color = androidx.compose.ui.graphics.Color.White)
            }
        }
        val labels = choices.map {
            when (it) {
                ShareBg.COLOUR -> stringResource(R.string.share_colour)
                ShareBg.MAP -> stringResource(R.string.share_map)
                ShareBg.PHOTO -> stringResource(R.string.share_photo)
            }
        }
        Segmented(labels, choices.indexOf(s.bg).coerceAtLeast(0), { choose(choices[it]) }, Modifier.fillMaxWidth())
        if (s.mapFailed) Text(stringResource(R.string.share_map_didn_t_load), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant, modifier = Modifier.padding(horizontal = 4.dp))
        if (s.bg == ShareBg.MAP) Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(stringResource(R.string.share_hide_start_and_finish), style = MaterialTheme.typography.bodyLarge)
                Text(stringResource(R.string.share_hide_ends_note), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
            }
            Spacer(Modifier.width(12.dp))
            Switch(s.hideEnds, { s.hideEnds = it })
        }
        if (s.bg == ShareBg.PHOTO) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilledTonalButton(onClick = choosePhoto, modifier = Modifier.weight(1f)) {
                    Text(stringResource(if (s.photo == null) R.string.share_choose_a_photo else R.string.share_another_photo))
                }
                FilledTonalButton(onClick = takePhoto, modifier = Modifier.weight(1f)) {
                    Icon(Glyphs["camera"], null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.share_take_a_photo))
                }
            }
            if (s.cameraRefused) Text(stringResource(R.string.share_camera_not_allowed), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant, modifier = Modifier.padding(horizontal = 4.dp))
        }
        Button(onClick = { share(card) }, modifier = Modifier.fillMaxWidth(), enabled = !s.loadingMap) {
            Icon(Glyphs["share"], null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.share_share))
        }
    }
}

/** A photo from the picker or the camera, upright and no bigger than the card needs. */
suspend fun photoFrom(context: Context, uri: Uri): Bitmap? = withContext(Dispatchers.IO) {
    runCatching {
        if (Build.VERSION.SDK_INT >= 28) {
            android.graphics.ImageDecoder.decodeBitmap(android.graphics.ImageDecoder.createSource(context.contentResolver, uri)) { d, info, _ ->
                val k = max(ShareCard.W.toFloat() / info.size.width, ShareCard.H.toFloat() / info.size.height).coerceAtMost(1f)
                d.setTargetSize(max(1, (info.size.width * k).toInt()), max(1, (info.size.height * k).toInt()))
                d.allocator = android.graphics.ImageDecoder.ALLOCATOR_SOFTWARE
            }
        } else {
            val r = context.contentResolver
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            r.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
            var sample = 1
            while (bounds.outWidth / (sample * 2) >= ShareCard.W && bounds.outHeight / (sample * 2) >= ShareCard.H) sample *= 2
            val b = r.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample }) } ?: return@runCatching null
            val turn = r.openInputStream(uri)?.use {
                when (android.media.ExifInterface(it).getAttributeInt(android.media.ExifInterface.TAG_ORIENTATION, 1)) {
                    android.media.ExifInterface.ORIENTATION_ROTATE_90 -> 90f
                    android.media.ExifInterface.ORIENTATION_ROTATE_180 -> 180f
                    android.media.ExifInterface.ORIENTATION_ROTATE_270 -> 270f
                    else -> 0f
                }
            } ?: 0f
            if (turn == 0f) b else Bitmap.createBitmap(b, 0, 0, b.width, b.height, Matrix().apply { postRotate(turn) }, true)
        }
    }.getOrNull()
}
