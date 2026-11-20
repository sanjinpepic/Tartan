package dev.freesuunto.app.shell

import androidx.compose.ui.res.stringResource
import dev.freesuunto.app.R
import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.PointF
import android.graphics.RectF
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.view.MotionEvent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import kotlinx.coroutines.launch
import org.maplibre.android.MapLibre
import org.maplibre.android.camera.CameraUpdateFactory
import org.maplibre.android.geometry.LatLng
import org.maplibre.android.geometry.LatLngBounds
import org.maplibre.android.maps.MapLibreMap
import org.maplibre.android.maps.MapView
import org.maplibre.android.maps.Style
import org.maplibre.android.style.expressions.Expression
import org.maplibre.android.style.layers.CircleLayer
import org.maplibre.android.style.layers.LineLayer
import org.maplibre.android.style.layers.Property
import org.maplibre.android.style.layers.PropertyFactory
import org.maplibre.android.style.layers.SymbolLayer
import org.maplibre.android.style.sources.GeoJsonSource
import org.maplibre.geojson.Feature
import org.maplibre.geojson.FeatureCollection
import org.maplibre.geojson.LineString
import org.maplibre.geojson.Point

private val CARD = RoundedCornerShape(28.dp)

/** What the routes screens ask of the app. */
interface RoutesActions {
    fun go(hash: String)
}

/** A line fitted into the canvas with a margin, north up (Web Mercator), as on the web's route thumbnails. */
@Composable
fun RouteLine(points: List<LngLat>, modifier: Modifier, label: String, startDot: Boolean = false, width: Float = 2.5f) {
    val cs = MaterialTheme.colorScheme
    Canvas(modifier.semantics { contentDescription = label }) {
        if (points.size < 2) return@Canvas
        val xs = points.map { Math.toRadians(it.first) }
        val ys = points.map { kotlin.math.ln(kotlin.math.tan(Math.PI / 4 + Math.toRadians(it.second) / 2)) }
        val pad = 8.dp.toPx()
        val k = minOf((size.width - 2 * pad) / (xs.max() - xs.min()).coerceAtLeast(1e-9), (size.height - 2 * pad) / (ys.max() - ys.min()).coerceAtLeast(1e-9))
        val ox = (size.width - (xs.max() - xs.min()) * k) / 2
        val oy = (size.height - (ys.max() - ys.min()) * k) / 2
        val path = Path()
        points.indices.forEach { i ->
            val x = (ox + (xs[i] - xs.min()) * k).toFloat(); val y = (oy + (ys.max() - ys[i]) * k).toFloat()
            if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
        }
        drawPath(path, cs.primary, style = Stroke(width.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
        // Where it starts: a dot in the line's colour, ringed in the surface's.
        if (startDot) {
            val sx = (ox + (xs[0] - xs.min()) * k).toFloat(); val sy = (oy + (ys.max() - ys[0]) * k).toFloat()
            drawCircle(cs.surface, radius = (width + 4).dp.toPx(), center = androidx.compose.ui.geometry.Offset(sx, sy))
            drawCircle(cs.primary, radius = (width + 1.5f).dp.toPx(), center = androidx.compose.ui.geometry.Offset(sx, sy))
        }
    }
}

/**
 * Activities → Routes, native (web/views/routes.ts renderRoutes): a loop of a distance from
 * where you are, your routes with their line, distance, climb and whether they're on the watch,
 * a new one, a GPX file to import.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class, ExperimentalLayoutApi::class)
@Composable
fun RoutesScreen(m: RoutesModel, actions: RoutesActions, navSpace: Boolean = true) {
    val cs = MaterialTheme.colorScheme
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val top = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    val bottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    LaunchedEffect(Unit) { m.ensure() }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { u ->
        if (u == null) return@rememberLauncherForActivityResult
        scope.launch {
            val name = context.contentResolver.query(u, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst()) c.getString(0) else null } ?: "route.gpx"
            val text = runCatching { context.contentResolver.openInputStream(u)?.use { it.bufferedReader().readText() } }.getOrNull() ?: return@launch
            m.import(name, text)?.let { actions.go("route/$it") }
        }
    }
    Box(Modifier.fillMaxSize().background(cs.surface)) {
        Column(
            Modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, top = top + 60.dp, bottom = bottom + if (navSpace) 104.dp else 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            PageHeader(stringResource(R.string.common_activities), subtitle = stringResource(R.string.common_every_workout_once_and_your_routes))
            Segmented(listOf(stringResource(R.string.common_workouts_title), stringResource(R.string.common_routes)), 1, { if (it == 0) actions.go("activities") })
            Button(onClick = { actions.go("route/new") }, shapes = ButtonDefaults.shapes()) { Icon(Glyphs["plus"], null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.routes_new_route)) }
            var i = 0
            Column(Modifier.fillMaxWidth().reveal(i++).clip(CARD).background(cs.surfaceContainer).padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Glyphs["loop"], null, Modifier.size(22.dp), tint = cs.primary)
                    Text(stringResource(R.string.routes_a_loop_from_here), style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(start = 10.dp))
                }
                Text(stringResource(R.string.routes_three_loops_along_paths_from_where), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
                // One row, each the same width: five short distances, none left alone on a line.
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf(5, 8, 10, 15, 21).forEach { k ->
                        Text(stringResource(R.string.common_n_km, k), style = MaterialTheme.typography.labelLarge, maxLines = 1, textAlign = androidx.compose.ui.text.style.TextAlign.Center, modifier = Modifier.weight(1f).press(scale = 0.94f, label = stringResource(R.string.routes_a_km_loop, k), onClick = { actions.go("route/new/loop-$k") }).clip(RoundedCornerShape(14.dp)).background(cs.secondaryContainer).padding(vertical = 10.dp))
                    }
                }
            }
            val list = m.routes
            when {
                list == null -> Box(Modifier.fillMaxWidth().height(160.dp), contentAlignment = Alignment.Center) { LoadingIndicator() }
                list.isEmpty() -> Column(Modifier.fillMaxWidth().reveal(i++).clip(CARD).background(cs.surfaceContainer).padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(stringResource(R.string.routes_no_routes_yet), style = MaterialTheme.typography.titleLarge)
                    Text(stringResource(R.string.routes_tap_the_map_to_place_points), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
                    FilledTonalButton(onClick = { actions.go("route/new") }) { Text(stringResource(R.string.routes_draw_a_route)) }
                }
                else -> {
                    Text(stringResource(R.string.routes_your_routes), style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(start = 4.dp, top = 4.dp))
                    list.forEachIndexed { k, r ->
                        val first = k == 0; val last = k == list.lastIndex
                        Row(
                            Modifier.fillMaxWidth().reveal(i++).press(scale = 0.98f, label = r.name, onClick = { actions.go("route/${r.id}") })
                                .clip(RoundedCornerShape(if (first) 24.dp else 6.dp, if (first) 24.dp else 6.dp, if (last) 24.dp else 6.dp, if (last) 24.dp else 6.dp))
                                .background(cs.surfaceContainer).padding(12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Box(Modifier.size(72.dp).clip(RoundedCornerShape(16.dp)).background(cs.surfaceContainerHigh)) { RouteLine(r.preview, Modifier.fillMaxSize(), stringResource(R.string.common_map_of, r.name)) }
                            Column(Modifier.weight(1f).padding(start = 14.dp)) {
                                Text(r.name, style = MaterialTheme.typography.titleSmall)
                                Text(listOfNotNull(stringResource(R.string.common_n_km, kmText(r.km)), r.ascent?.let { "↑ $it m" }, if (r.loop) stringResource(R.string.routes_loop) else null).joinToString(" · "), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
                                if (r.onWatch) Row(verticalAlignment = Alignment.CenterVertically) { Icon(Glyphs["watch"], null, Modifier.size(14.dp), tint = LocalData.current.good); Text(stringResource(R.string.common_on_your_watch_label), style = MaterialTheme.typography.labelMedium, color = LocalData.current.good, modifier = Modifier.padding(start = 4.dp)) }
                            }
                            Icon(Glyphs["chevron"], null, tint = cs.onSurfaceVariant)
                        }
                    }
                }
            }
            TextButton(onClick = { pick.launch(arrayOf("*/*")) }) { Icon(Glyphs["file"], null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text(stringResource(R.string.routes_import_a_gpx_file)) }
        }
    }
}

/** Where you are, from the phone's GPS while the editor is open (asking once). */
@Composable
private fun rememberHere(): LngLat? {
    val context = LocalContext.current
    var here by remember { mutableStateOf<LngLat?>(null) }
    var allowed by remember { mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { allowed = it }
    LaunchedEffect(Unit) { if (!allowed) runCatching { ask.launch(Manifest.permission.ACCESS_FINE_LOCATION) } }
    DisposableEffect(allowed) {
        val lm = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
        val l = LocationListener { loc: Location -> here = loc.longitude to loc.latitude }
        @SuppressLint("MissingPermission")
        fun start() {
            if (!allowed || lm == null) return
            for (p in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) runCatching {
                if (lm.isProviderEnabled(p)) {
                    // A remembered fix only if it's recent: an older one may be another city (you travelled).
                    lm.getLastKnownLocation(p)?.takeIf { System.currentTimeMillis() - it.time < 600_000 }?.let { if (here == null) here = it.longitude to it.latitude }
                    lm.requestLocationUpdates(p, 3000L, 5f, l)
                }
            }
        }
        start()
        onDispose { runCatching { lm?.removeUpdates(l) } }
    }
    return here
}

private fun pt(p: LngLat) = Point.fromLngLat(p.first, p.second)
private fun ll(p: LngLat) = LatLng(p.second, p.first)
private fun hex(c: Color) = String.format("#%06X", 0xFFFFFF and c.toArgb())

/** OpenMapTiles transportation classes you can't run along (web/lib/snap.ts). */
private val NOT_ON_FOOT = setOf("motorway", "raceway", "rail", "transit", "ferry", "aerialway", "bus_guideway", "busway")

/**
 * The route editor, native: the map full screen (MapLibre, OpenFreeMap in the app's colours),
 * the name, where you are and how the line goes across the top, and the distance, climb,
 * profile, tools and Save / Send at the bottom. Tap to add a point (near a path, onto it); tap
 * the start to close the loop, another point to take it out; drag a point to move it.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class, ExperimentalLayoutApi::class)
@Composable
fun RouteEditorScreen(e: RouteEditor, back: () -> Unit, navSpace: Boolean = true) {
    val cs = MaterialTheme.colorScheme
    val data = LocalData.current
    val context = LocalContext.current
    val view = LocalView.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val top = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    val bottomInset = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    val here = rememberHere()
    var map by remember { mutableStateOf<MapLibreMap?>(null) }
    var style by remember { mutableStateOf<Style?>(null) }
    var offline by remember { mutableStateOf(false) }
    var pacing by remember { mutableStateOf(false) }
    val home = remember { mutableStateOf<LngLat?>(null) }
    LaunchedEffect(Unit) { e.load(); e.api.get("/api/routes")?.let { runCatching { parseRoutes(it).second }.getOrNull() }?.let { home.value = it } }

    val mapView = remember {
        MapLibre.getInstance(context.applicationContext)
        MapView(context).also { it.onCreate(null) }
    }
    DisposableEffect(lifecycle) {
        val obs = LifecycleEventObserver { _, ev ->
            when (ev) {
                Lifecycle.Event.ON_START -> mapView.onStart()
                Lifecycle.Event.ON_RESUME -> mapView.onResume()
                Lifecycle.Event.ON_PAUSE -> mapView.onPause()
                Lifecycle.Event.ON_STOP -> mapView.onStop()
                else -> {}
            }
        }
        lifecycle.addObserver(obs)
        mapView.onStart(); mapView.onResume()
        onDispose { lifecycle.removeObserver(obs); mapView.onPause(); mapView.onStop(); mapView.onDestroy() }
    }
    // The style, then the route's own layers on it.
    LaunchedEffect(cs.surface) {
        val json = mapStyle(context, cs) ?: run { offline = true; return@LaunchedEffect }
        mapView.getMapAsync { mm ->
            map = mm
            mm.uiSettings.isRotateGesturesEnabled = false
            mm.uiSettings.isTiltGesturesEnabled = false
            mm.uiSettings.isAttributionEnabled = false
            mm.uiSettings.isLogoEnabled = false
            mm.setStyle(Style.Builder().fromJson(json)) { s ->
                val ink = hex(cs.primary); val paper = hex(cs.surfaceContainerLowest)
                s.addSource(GeoJsonSource("loops")); s.addSource(GeoJsonSource("route")); s.addSource(GeoJsonSource("km")); s.addSource(GeoJsonSource("wp")); s.addSource(GeoJsonSource("me"))
                s.addLayer(LineLayer("loop-options", "loops").withProperties(PropertyFactory.lineColor(Expression.get("colour")), PropertyFactory.lineWidth(4f), PropertyFactory.lineOpacity(0.8f), PropertyFactory.lineCap(Property.LINE_CAP_ROUND), PropertyFactory.lineJoin(Property.LINE_JOIN_ROUND)))
                s.addLayer(LineLayer("route-casing", "route").withProperties(PropertyFactory.lineColor(paper), PropertyFactory.lineWidth(9f), PropertyFactory.lineCap(Property.LINE_CAP_ROUND), PropertyFactory.lineJoin(Property.LINE_JOIN_ROUND)))
                s.addLayer(LineLayer("route-line", "route").withProperties(PropertyFactory.lineColor(ink), PropertyFactory.lineWidth(4.5f), PropertyFactory.lineCap(Property.LINE_CAP_ROUND), PropertyFactory.lineJoin(Property.LINE_JOIN_ROUND)).withFilter(Expression.not(Expression.get("pending"))))
                s.addLayer(LineLayer("route-pending", "route").withProperties(PropertyFactory.lineColor(ink), PropertyFactory.lineWidth(4.5f), PropertyFactory.lineDasharray(arrayOf(1f, 1.5f))).withFilter(Expression.get("pending")))
                s.addLayer(CircleLayer("km-dot", "km").withProperties(PropertyFactory.circleRadius(8f), PropertyFactory.circleColor(paper), PropertyFactory.circleStrokeColor(ink), PropertyFactory.circleStrokeWidth(1.5f)))
                if (runCatching { JSONGlyphs(json) }.getOrDefault(false)) s.addLayer(SymbolLayer("km-text", "km").withProperties(PropertyFactory.textField(Expression.get("label")), PropertyFactory.textSize(10f), PropertyFactory.textFont(arrayOf(str(R.string.routes_noto_sans_bold))), PropertyFactory.textAllowOverlap(true), PropertyFactory.textColor(ink)))
                s.addLayer(CircleLayer("me-dot", "me").withProperties(PropertyFactory.circleRadius(8f), PropertyFactory.circleColor("#2A78D6"), PropertyFactory.circleStrokeColor("#FFFFFF"), PropertyFactory.circleStrokeWidth(3f)))
                s.addLayer(CircleLayer("wp-dot", "wp").withProperties(
                    PropertyFactory.circleRadius(Expression.match(Expression.get("role"), Expression.literal(7f), Expression.stop("start", 9f), Expression.stop("end", 9f))),
                    PropertyFactory.circleColor(Expression.match(Expression.get("role"), Expression.literal(paper), Expression.stop("end", ink))),
                    PropertyFactory.circleStrokeColor(ink), PropertyFactory.circleStrokeWidth(2.5f),
                ))
                style = s
                // Where it opens: the route, else the last view's place (home), else here.
                val start = e.fitTo ?: emptyList()
                if (start.size >= 2) fit(mm, start, view)
                else (here ?: home.value)?.let { mm.moveCamera(CameraUpdateFactory.newLatLngZoom(ll(it), 14.5)) }
            }
        }
    }
    // Taps: on a point (tap the start to close the loop, any other to take it out), else a new point.
    LaunchedEffect(map, style) {
        val mm = map ?: return@LaunchedEffect
        if (style == null) return@LaunchedEffect
        mm.addOnMapClickListener { at ->
            val px = mm.projection.toScreenLocation(at)
            val hit = mm.queryRenderedFeatures(RectF(px.x - 30, px.y - 30, px.x + 30, px.y + 30), "wp-dot").firstOrNull()?.getNumberProperty("i")?.toInt()
            view.feel(Haptic.Click)
            when {
                hit == 0 && e.wp.size > 1 -> e.toStart()
                hit != null -> e.remove(hit)
                else -> e.add(placed(mm, px, e.mode))
            }
            true
        }
    }
    // Dragging a point: a press that starts on one moves it (the map stays still meanwhile).
    DisposableEffect(map, style) {
        val mm = map
        var dragging: Int? = null
        mapView.setOnTouchListener { _, ev ->
            if (mm == null || style == null) return@setOnTouchListener false
            val p = PointF(ev.x, ev.y)
            when (ev.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    dragging = mm.queryRenderedFeatures(RectF(p.x - 36, p.y - 36, p.x + 36, p.y + 36), "wp-dot").firstOrNull()?.getNumberProperty("i")?.toInt()
                    false
                }
                MotionEvent.ACTION_MOVE -> {
                    val i = dragging ?: return@setOnTouchListener false
                    val at = mm.projection.fromScreenLocation(p)
                    (style?.getSourceAs<GeoJsonSource>("wp"))?.setGeoJson(FeatureCollection.fromFeatures(e.wp.mapIndexed { k, q -> Feature.fromGeometry(if (k == i) Point.fromLngLat(at.longitude, at.latitude) else pt(q)).also { f -> f.addNumberProperty("i", k); f.addStringProperty("role", role(k, e.wp.size)) } }))
                    true
                }
                MotionEvent.ACTION_UP -> {
                    val i = dragging ?: return@setOnTouchListener false
                    dragging = null
                    val moved = ev.eventTime - ev.downTime > 180
                    if (moved) { view.feel(Haptic.Detent); e.move(i, placed(mm, p, e.mode)); true } else false
                }
                else -> { dragging = null; false }
            }
        }
        onDispose { mapView.setOnTouchListener(null) }
    }
    // The route, its km dots, its points, the loop options and you: redrawn as they change.
    val line = e.line
    LaunchedEffect(style, e.segs, e.pending, e.wp, e.loops, here) {
        val s = style ?: return@LaunchedEffect
        s.getSourceAs<GeoJsonSource>("route")?.setGeoJson(FeatureCollection.fromFeatures(e.segs.map { g -> Feature.fromGeometry(LineString.fromLngLats(g.coords.map(::pt))).also { it.addBooleanProperty("pending", g in e.pending) } }))
        val dots = ArrayList<Feature>()
        var run = 0.0; var next = 1000.0
        for (i in 1 until line.size) {
            val d = metres(line[i - 1], line[i])
            while (run + d >= next) {
                val t = (next - run) / d
                dots.add(Feature.fromGeometry(Point.fromLngLat(line[i - 1].first + (line[i].first - line[i - 1].first) * t, line[i - 1].second + (line[i].second - line[i - 1].second) * t)).also { it.addStringProperty("label", "${(next / 1000).toInt()}") })
                next += 1000
            }
            run += d
        }
        s.getSourceAs<GeoJsonSource>("km")?.setGeoJson(FeatureCollection.fromFeatures(dots))
        s.getSourceAs<GeoJsonSource>("wp")?.setGeoJson(FeatureCollection.fromFeatures(e.wp.mapIndexed { k, q -> Feature.fromGeometry(pt(q)).also { it.addNumberProperty("i", k); it.addStringProperty("role", role(k, e.wp.size)) } }))
        val colours = listOf(hex(cs.primary), hex(data.pace), hex(data.good))
        s.getSourceAs<GeoJsonSource>("loops")?.setGeoJson(FeatureCollection.fromFeatures(e.loops.mapIndexed { k, l -> Feature.fromGeometry(LineString.fromLngLats(lineOf(l.legs.map { Seg("paths", it) }).map(::pt))).also { it.addStringProperty("colour", colours[k % 3]) } }))
        s.getSourceAs<GeoJsonSource>("me")?.setGeoJson(FeatureCollection.fromFeatures(listOfNotNull(here?.let { Feature.fromGeometry(pt(it)) })))
    }
    // A new route opens where you are, once; loops asked for (#route/new/loop-10) start from there.
    var centred by remember { mutableStateOf(e.id != "new") }
    var looped by remember { mutableStateOf(e.wantLoop == 0) }
    LaunchedEffect(here, map) {
        val mm = map ?: return@LaunchedEffect
        if (here != null && !centred) { centred = true; mm.moveCamera(CameraUpdateFactory.newLatLngZoom(ll(here), maxOf(mm.cameraPosition.zoom, 14.5))) }
        if (!looped && here != null) { looped = true; e.findLoops(e.wantLoop, here) }
    }
    LaunchedEffect(map) {
        if (e.wantLoop == 0) return@LaunchedEffect
        kotlinx.coroutines.delay(6000)
        val mm = map ?: return@LaunchedEffect
        if (!looped) { looped = true; mm.cameraPosition.target?.let { e.findLoops(e.wantLoop, it.longitude to it.latitude) } }
    }
    LaunchedEffect(e.fitTo, map) { val mm = map ?: return@LaunchedEffect; e.fitTo?.takeIf { it.size >= 2 }?.let { fit(mm, it, view); e.fitTo = null } }

    Box(Modifier.fillMaxSize().background(cs.surface)) {
        if (offline) Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
            Text(stringResource(R.string.routes_the_map_needs_the_internet), style = MaterialTheme.typography.titleLarge)
            Text(stringResource(R.string.routes_connect_and_open_this_again_saved), color = cs.onSurfaceVariant)
        } else AndroidView({ mapView }, Modifier.fillMaxSize())
        // Across the top: back, the name, where am I, and how the line goes.
        Column(Modifier.fillMaxWidth().background(Brush.verticalGradient(listOf(cs.surface.copy(alpha = 0.95f), cs.surface.copy(alpha = 0f)))).padding(start = 12.dp, end = 12.dp, top = top + 8.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilledTonalIconButton(onClick = { if (e.mayLeave()) back() }) { Icon(Glyphs["chevron"], stringResource(R.string.routes_back_to_routes), Modifier.size(20.dp).graphicsLayer { scaleX = -1f }) }
                Box(Modifier.weight(1f).clip(RoundedCornerShape(20.dp)).background(cs.surfaceContainerHigh).padding(horizontal = 14.dp, vertical = 12.dp)) {
                    if (e.name.isEmpty()) Text(stringResource(R.string.routes_name_this_route), color = cs.onSurfaceVariant)
                    BasicTextField(e.name, { e.name = it.take(80); e.dirty = true }, Modifier.fillMaxWidth(), singleLine = true, textStyle = MaterialTheme.typography.bodyLarge.copy(color = cs.onSurface), cursorBrush = SolidColor(cs.primary))
                }
                FilledTonalIconButton(onClick = { (here ?: home.value)?.let { map?.animateCamera(CameraUpdateFactory.newLatLngZoom(ll(it), maxOf(map?.cameraPosition?.zoom ?: 14.5, 14.5))) } ?: run { e.said = str(R.string.routes_couldn_t_find_where_you_are) } }) { Icon(Glyphs["locate"], stringResource(R.string.routes_where_am_i)) }
            }
            Segmented(listOf(stringResource(R.string.routes_follow_paths), stringResource(R.string.routes_straight)), if (e.mode == "straight") 1 else 0, { e.mode = if (it == 1) "straight" else "paths" }, Modifier.align(Alignment.CenterHorizontally))
        }
        // At the bottom: loops, what's happening, the numbers, the profile, tools and actions.
        Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().padding(start = 12.dp, end = 12.dp, bottom = bottomInset + if (navSpace) 92.dp else 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            LoopBar(e, here, map)
            (e.status ?: when {
                e.wp.isEmpty() -> if (here != null) stringResource(R.string.routes_tap_the_map_where_you_start) else stringResource(R.string.routes_tap_the_map_where_you_start_2)
                e.wp.size == 1 -> stringResource(R.string.routes_tap_where_you_re_heading)
                e.pending.isNotEmpty() -> stringResource(R.string.routes_finding_the_way)
                else -> null
            })?.let { Text(it, style = MaterialTheme.typography.labelLarge, modifier = Modifier.clip(CircleShape).background(cs.inverseSurface.copy(alpha = 0.9f)).padding(horizontal = 14.dp, vertical = 8.dp), color = cs.inverseOnSurface) }
            Column(Modifier.fillMaxWidth().clip(CARD).background(cs.surfaceContainer).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(verticalAlignment = Alignment.Bottom) {
                    Text(kmText(e.total), style = MaterialTheme.typography.headlineMedium.copy(fontFamily = FlexRound))
                    Text(" km", style = MaterialTheme.typography.titleMedium, color = cs.onSurfaceVariant, modifier = Modifier.padding(bottom = 4.dp))
                    Spacer(Modifier.weight(1f))
                    val c = e.elevation?.takeIf { it.size == line.size }?.let { climb(it) }
                    Text("↑ ${c?.first?.let { "$it m" } ?: "–"}   ↓ ${c?.second?.let { "$it m" } ?: "–"}", style = MaterialTheme.typography.titleSmall, color = cs.onSurfaceVariant)
                }
                e.elevation?.takeIf { it.size == line.size }?.let { Profile(line, it) }
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    Tool("undo", stringResource(R.string.common_undo), e.canUndo) { e.undo() }
                    Tool("loop", stringResource(R.string.routes_to_start), e.wp.size >= 2) { e.toStart() }
                    Tool("outback", stringResource(R.string.routes_out_back), e.wp.size >= 2) { e.outAndBack() }
                    Tool("reverse", stringResource(R.string.routes_reverse), e.wp.size >= 2) { e.reverse() }
                    Tool("clock", stringResource(R.string.routes_race_pace), e.wp.size >= 2) { pacing = true }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { e.save() }, enabled = e.wp.size >= 2 && e.busy == null, shapes = ButtonDefaults.shapes()) { Text(if (e.busy == "save") stringResource(R.string.common_saving) else stringResource(R.string.common_save)) }
                    FilledTonalButton(onClick = { e.send() }, enabled = e.wp.size >= 2 && e.busy == null, shapes = ButtonDefaults.shapes()) { Icon(Glyphs["watch"], null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text(if (e.busy == "send") stringResource(R.string.routes_sending) else stringResource(R.string.routes_send_to_watch)) }
                    FilledTonalIconButton(onClick = { e.gpx() }, enabled = e.wp.size >= 2 && e.busy == null) { Icon(Glyphs["file"], stringResource(R.string.routes_share_as_gpx)) }
                }
            }
        }
        Said(e.said, { e.said = null }, Modifier.align(Alignment.Center))
    }
    if (pacing) PacingSheet(e) { pacing = false }
}

private fun role(k: Int, n: Int) = if (k == 0) "start" else if (k == n - 1) "end" else "mid"

/** Does the style have glyphs (for the km labels)? */
private fun JSONGlyphs(json: String) = org.json.JSONObject(json).has("glyphs")

/** The route (or loops) in view, above the bottom panel. */
private fun fit(map: MapLibreMap, pts: List<LngLat>, view: android.view.View) {
    val b = LatLngBounds.Builder().apply { pts.forEach { include(ll(it)) } }.build()
    val d = view.resources.displayMetrics.density
    runCatching { map.moveCamera(CameraUpdateFactory.newLatLngBounds(b, (40 * d).toInt(), (150 * d).toInt(), (40 * d).toInt(), (330 * d).toInt())) }
}

/** Where a tap lands: along paths, onto the nearest path within 28 dp (fingers are wider than paths). */
private fun placed(map: MapLibreMap, p: PointF, mode: String): LngLat {
    if (mode == "paths") {
        val r = 28f * android.content.res.Resources.getSystem().displayMetrics.density
        val layers = map.style?.layers?.filter { (it as? LineLayer)?.sourceLayer == "transportation" }?.map { it.id }?.toTypedArray() ?: emptyArray()
        if (layers.isNotEmpty()) {
            var best: PointF? = null
            var bestD = r * r
            for (f in map.queryRenderedFeatures(RectF(p.x - r, p.y - r, p.x + r, p.y + r), *layers)) {
                if (f.getStringProperty("class") in NOT_ON_FOOT) continue
                val g = f.geometry()
                val parts: List<List<Point>> = when (g) {
                    is LineString -> listOf(g.coordinates())
                    is org.maplibre.geojson.MultiLineString -> g.coordinates()
                    else -> emptyList()
                }
                for (part in parts) {
                    val px = part.map { map.projection.toScreenLocation(LatLng(it.latitude(), it.longitude())) }
                    for (i in 1 until px.size) {
                        val a = px[i - 1]; val b = px[i]
                        val dx = b.x - a.x; val dy = b.y - a.y
                        val len = dx * dx + dy * dy
                        val t = if (len > 0) (((p.x - a.x) * dx + (p.y - a.y) * dy) / len).coerceIn(0f, 1f) else 0f
                        val q = PointF(a.x + t * dx, a.y + t * dy)
                        val dd = (q.x - p.x) * (q.x - p.x) + (q.y - p.y) * (q.y - p.y)
                        if (dd <= bestD) { best = q; bestD = dd }
                    }
                }
            }
            best?.let { q -> map.projection.fromScreenLocation(q).let { return Math.round(it.longitude * 1e6) / 1e6 to Math.round(it.latitude * 1e6) / 1e6 } }
        }
    }
    val at = map.projection.fromScreenLocation(p)
    return Math.round(at.longitude * 1e6) / 1e6 to Math.round(at.latitude * 1e6) / 1e6
}

@Composable
private fun Tool(icon: String, label: String, enabled: Boolean, onClick: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Column(
        Modifier.clip(RoundedCornerShape(16.dp)).let { if (enabled) it.press(scale = 0.94f, label = label, onClick = onClick) else it }.padding(horizontal = 10.dp, vertical = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(Glyphs[icon], null, Modifier.size(22.dp), tint = if (enabled) cs.onSurface else cs.onSurface.copy(alpha = 0.35f))
        Text(label, style = MaterialTheme.typography.labelSmall, color = if (enabled) cs.onSurfaceVariant else cs.onSurfaceVariant.copy(alpha = 0.35f))
    }
}

/** The heights along the route, min and max. */
@Composable
private fun Profile(line: List<LngLat>, h: List<Double>) {
    val cs = MaterialTheme.colorScheme
    Box(Modifier.fillMaxWidth().height(56.dp)) {
        Canvas(Modifier.fillMaxSize()) {
            val d = DoubleArray(line.size).also { for (i in 1 until line.size) it[i] = it[i - 1] + metres(line[i - 1], line[i]) }
            val lo = h.min(); val hi = maxOf(h.max(), lo + 20)
            val x = { i: Int -> (d[i] / (d.last().takeIf { it > 0 } ?: 1.0) * size.width).toFloat() }
            val y = { v: Double -> (size.height - 4 - (v - lo) / (hi - lo) * (size.height - 12)).toFloat() }
            val step = maxOf(1, line.size / 300)
            val p = Path().apply { moveTo(0f, size.height); h.indices.filter { it % step == 0 || it == h.lastIndex }.forEach { lineTo(x(it), y(h[it])) }; lineTo(size.width, size.height); close() }
            drawPath(p, cs.primary.copy(alpha = 0.18f))
            val l = Path().apply { h.indices.filter { it % step == 0 || it == h.lastIndex }.forEachIndexed { k, i -> if (k == 0) moveTo(x(i), y(h[i])) else lineTo(x(i), y(h[i])) } }
            drawPath(l, cs.primary, style = Stroke(2.dp.toPx()))
        }
        Text("${Math.round(h.max())} m", style = MaterialTheme.typography.labelSmall, color = cs.onSurfaceVariant, modifier = Modifier.align(Alignment.TopStart))
        Text("${Math.round(h.min())} m", style = MaterialTheme.typography.labelSmall, color = cs.onSurfaceVariant, modifier = Modifier.align(Alignment.BottomStart))
    }
}

private val LETTERS = listOf("A", "B", "C")
private val COMPASS = listOf("north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west")
private fun heading(deg: Double) = COMPASS[Math.floorMod(Math.round(((deg % 360) + 360) % 360 / 45).toInt(), 8)]

/** Loops: before any point, a distance to ask for; with options on the map, pick one (A, B, C). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun LoopBar(e: RouteEditor, here: LngLat?, map: MapLibreMap?) {
    val cs = MaterialTheme.colorScheme
    val data = LocalData.current
    val colours = listOf(cs.primary, data.pace, data.good)
    if (e.wp.isNotEmpty() && e.loops.isEmpty()) return
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(22.dp)).background(cs.surfaceContainer).padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (e.loops.isNotEmpty()) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.routes_pick_a_loop), style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                TextButton(onClick = { e.loops = emptyList() }) { Text(stringResource(R.string.common_none)) }
            }
            e.loops.forEachIndexed { k, l ->
                Row(Modifier.fillMaxWidth().press(scale = 0.98f, onClick = { e.pickLoop(l) }).clip(RoundedCornerShape(14.dp)).background(cs.surfaceContainerHigh).padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(28.dp).clip(CircleShape).background(colours[k % 3]), contentAlignment = Alignment.Center) { Text(LETTERS.getOrElse(k) { "${k + 1}" }, color = Color.White, style = MaterialTheme.typography.labelLarge) }
                    Text(stringResource(R.string.routes_km_heading, String.format(java.util.Locale.getDefault(), "%.1f", l.km), heading(l.bearing)), style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(start = 10.dp))
                }
            }
        } else {
            Text(stringResource(R.string.routes_or_a_loop_from_here), style = MaterialTheme.typography.labelLarge, color = cs.onSurfaceVariant)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                (listOf(5, 10, 15, 21) + listOfNotNull(e.wantLoop.takeIf { it > 0 })).distinct().sorted().forEach { k ->
                    Text(
                        if (e.finding == k) stringResource(R.string.routes_finding) else stringResource(R.string.common_n_km, k), style = MaterialTheme.typography.labelLarge,
                        modifier = Modifier.press(scale = 0.94f, onClick = {
                            val start = here ?: map?.cameraPosition?.target?.let { it.longitude to it.latitude } ?: return@press
                            e.findLoops(k, start)
                        }).clip(RoundedCornerShape(14.dp)).background(cs.secondaryContainer).padding(horizontal = 14.dp, vertical = 8.dp),
                    )
                }
            }
        }
    }
}

/** Race pacing: even effort over this course's hills for a target time; to the watch as a course or a workout. */
@Composable
private fun PacingSheet(e: RouteEditor, onClose: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    var time by remember { mutableStateOf("") }
    Sheet(onClose) { close ->
        Column(Modifier.verticalScroll(rememberScrollState()).navigationBarsPadding().padding(start = 16.dp, end = 16.dp, bottom = 32.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(stringResource(R.string.routes_race_pacing), style = MaterialTheme.typography.headlineSmall)
                    Text(stringResource(R.string.routes_name_km, e.name.ifBlank { stringResource(R.string.routes_this_route) }, kmText(e.total)), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
                }
                FilledTonalIconButton(onClick = close) { Icon(Glyphs["close"], stringResource(R.string.common_close)) }
            }
            Field(stringResource(R.string.common_target_time), time, { time = it }, placeholder = "e.g. 1:45:00 or 48:30")
            Button(onClick = { e.pace(time) }, enabled = time.isNotBlank() && e.busy == null) { Text(stringResource(R.string.routes_work_it_out)) }
            e.splits?.let { sp ->
                Text(if (e.elevation?.size == e.line.size) stringResource(R.string.routes_even_effort_slower_up_the_climbs) else stringResource(R.string.routes_no_heights_for_this_course_yet), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
                sp.forEachIndexed { k, s ->
                    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(if (k % 2 == 0) cs.surfaceContainer else Color.Transparent).padding(horizontal = 10.dp, vertical = 8.dp)) {
                        Text(if (s.metres < 1000) "${s.km - 1}–${String.format(java.util.Locale.getDefault(), "%.1f", s.km - 1 + s.metres / 1000)}" else "${s.km}", modifier = Modifier.weight(0.7f))
                        Text(stringResource(R.string.common_per_km, clock(Math.round(s.paceS).toInt())), modifier = Modifier.weight(1.2f), textAlign = androidx.compose.ui.text.style.TextAlign.End)
                        Text(clock(Math.round(s.cumulativeS).toInt()), modifier = Modifier.weight(1f), textAlign = androidx.compose.ui.text.style.TextAlign.End)
                        Text(if (s.climbM > 0) "↑${s.climbM} m" else "", modifier = Modifier.weight(0.9f), textAlign = androidx.compose.ui.text.style.TextAlign.End, color = cs.onSurfaceVariant)
                    }
                }
                ButtonFlow {
                    FilledTonalButton(onClick = { e.courseToWatch() }, enabled = e.busy == null) { ButtonText(stringResource(R.string.routes_course_with_splits)) }
                    FilledTonalButton(onClick = { e.splitsToWatch() }, enabled = e.busy == null) { ButtonText(stringResource(R.string.routes_pacing_workout)) }
                }
                Text(stringResource(R.string.routes_the_course_goes_with_a_named), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
            }
            e.pacingLine?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
        }
    }
}
