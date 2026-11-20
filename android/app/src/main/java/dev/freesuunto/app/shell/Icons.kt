package dev.freesuunto.app.shell

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/**
 * Tartan's icons, the same paths as web/lib/dom.ts: a 24 grid, 1.8 stroke, round caps and joins.
 * Drawn black and tinted by Icon(), so they take the colour of what they sit in.
 */
object Glyphs {
    private val cache = HashMap<String, ImageVector>()

    private val PATHS = mapOf(
        "today" to "M4 7.5h16M4 12h11M4 16.5h7M18.5 13v8",
        "list" to "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
        "trends" to "M4 19V9M10 19V5M16 19v-7M21 19H3",
        "coach" to "M4.5 5.5h15v10h-9l-4.5 4v-4h-1.5z M9 10.5h.01M12 10.5h.01M15 10.5h.01",
        "sync" to "M20 12a8 8 0 0 1-14.3 4.9M4 12A8 8 0 0 1 18.3 7.1M18.5 3v4.3h-4.3M5.5 21v-4.3h4.3",
        "settings" to "M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4",
        "run" to "M13 4.5a1.5 1.5 0 1 0 0-.01M9.5 21l2.5-5.5 2.5 2V21M7 12l2.5-3.5h4l2 3 2.5.5M11.5 8.5 10 13l-3 1",
        "ride" to "M6 18a3 3 0 1 0 0-.01M18 18a3 3 0 1 0 0-.01M6 18l4-7h5l3 7M10 11l-1.5-3H7M15 11l-1-3h2",
        "walk" to "M12.5 4.5a1.5 1.5 0 1 0 0-.01M10 21l2-6 2 2v4M9 11l2-2.5 2.5 1.5 1.5 3M11 8.5 9.5 15",
        "play" to "M8 5.5v13l10.5-6.5z",
        "chevron" to "M9 6l6 6-6 6",
        "clock" to "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7.5V12l3 2",
        "spark" to "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18",
        "bolt" to "M13 3 5 14h6l-1 7 8-11h-6z",
        "heart" to "M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z",
        "check" to "M5 12.5l4.5 4.5L19 7.5",
        "up" to "M12 19V5M6 11l6-6 6 6",
        "watch" to "M8 6h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zM9 6l1-3.5h4L15 6M9 18l1 3.5h4L15 18M12 9.5V12l1.6 1.2",
        "plus" to "M12 5v14M5 12h14",
        "close" to "M6 6l12 12M18 6 6 18",
        "down" to "M12 5v14M6 13l6 6 6-6",
        "history" to "M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4M12 8v4l3 2",
        "bookmark" to "M7 3.5h10a1 1 0 0 1 1 1V20.5l-6-4-6 4V4.5a1 1 0 0 1 1-1z",
        "search" to "M17.5 11a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0zM16 16l4 4",
        "route" to "M5 19c3-1 4-4 6-8s4-6 8-6M5 19h.01M19 5h.01",
        "swim" to "M3 17c2 0 2-1.5 4.5-1.5S10 17 12 17s2.5-1.5 4.5-1.5S19 17 21 17M7 13l4-4 3 2.5L17 9M16 6.5a1.5 1.5 0 1 0 0-.01",
        "other" to "M12 4l2.4 5 5.6.6-4.2 3.8 1.2 5.6L12 16.2 7 19l1.2-5.6L4 9.6l5.6-.6z",
        "folder" to "M3 6.5h6l2 2h10v10H3z",
        "phone" to "M8 3h8a1.5 1.5 0 0 1 1.5 1.5v15A1.5 1.5 0 0 1 16 21H8a1.5 1.5 0 0 1-1.5-1.5v-15A1.5 1.5 0 0 1 8 3zM11 18h2",
        "pc" to "M5.5 5h13A1.5 1.5 0 0 1 20 6.5V16H4V6.5A1.5 1.5 0 0 1 5.5 5zM2 19h20",
        "camera" to "M4 8.5h3.2L9 6h6l1.8 2.5H20V19H4zM12 16.2a3 3 0 1 0 0-6 3 3 0 0 0 0 6",
        "mic" to "M12 3.5a2.75 2.75 0 0 0-2.75 2.75v5.5a2.75 2.75 0 0 0 5.5 0v-5.5A2.75 2.75 0 0 0 12 3.5zM5.75 11.5a6.25 6.25 0 0 0 12.5 0M12 17.75V20.5",
        "warn" to "M12 4 3 20h18zM12 10v4M12 17h.01",
        "strava" to "M5.22 13.38L10.73 2.5L16.29 13.38L13 13.38L10.73 9.03L8.47 13.38ZM10.62 13.38L13 13.38L14.7 16.67L16.29 13.38L18.78 13.38L14.7 21.5Z",
        "plan" to "M5 5.5h14a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1zM4 10h16M8.5 3.5v4M15.5 3.5v4M9 15l2 2 4-4",
        "back" to "M15 5l-7 7 7 7",
        "send" to "M5 12h13M13 6l6 6-6 6",
        "pause" to "M8.5 5.5v13M15.5 5.5v13",
        "flag" to "M5.5 21V4M5.5 4.5h11l-2.5 4 2.5 4h-11",
        "copy" to "M9 9h10.5v11.5H9zM15 9V4.5H4.5V15H9",
        "share" to "M12 15V3.5M7.5 8 12 3.5 16.5 8M5.5 12v8.5h13V12",
        "stop" to "M6.5 6.5h11v11h-11z",
        "pin" to "M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
        "undo" to "M9 14 4.5 9.5 9 5M4.5 9.5H15a5 5 0 0 1 0 10h-3",
        "loop" to "M12 20a8 8 0 1 1 8-8M20 12l2.5-2.5M20 12l-2.5-2.5",
        "outback" to "M4 9h14l-3.5-3.5M20 15H6l3.5 3.5",
        "reverse" to "M8 4v16M4.5 7.5 8 4l3.5 3.5M16 20V4M12.5 16.5 16 20l3.5-3.5",
        "locate" to "M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM12 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z",
        "trash" to "M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5M10 11v5M14 11v5",
        "file" to "M7 3.5h7l4 4V20.5H7zM14 3.5V8h4",
        "body" to "M12 3.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM6 9.5l6 1.5 6-1.5M12 11v4.5M12 15.5 9 20.5M12 15.5l3 5",
        "sun" to "M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M6 18l1.4-1.4M16.6 7.4 18 6M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z",
        "moon" to "M19.5 14.5A7.5 7.5 0 1 1 9.5 4.5a6 6 0 0 0 10 10z",
        "drop" to "M12 3.5s-6 6.4-6 10.8a6 6 0 0 0 12 0C18 9.9 12 3.5 12 3.5z",
        "agent" to "M8 9h8v8H8zM12 5v4M9.5 12.5h.01M14.5 12.5h.01M5 13h3M16 13h3",
        "info" to "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01",
    )
    /** Drawn filled, not stroked (as FILLED in dom.ts). */
    private val FILLED = setOf("strava")

    operator fun get(name: String): ImageVector = cache.getOrPut(name) {
        ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f)
            .addPath(
                pathData = addPathNodes(PATHS[name] ?: PATHS.getValue("spark")),
                fill = if (name in FILLED) SolidColor(Color.Black) else null,
                stroke = if (name in FILLED) null else SolidColor(Color.Black),
                strokeLineWidth = 1.8f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            )
            .build()
    }

    /** The icon for a sport, as `sportIcon` on the web. */
    fun sport(sport: String): ImageVector {
        val s = sport.lowercase()
        return get(
            when {
                Regex("run|jog|trail|treadmill").containsMatchIn(s) -> "run"
                Regex("ride|cycl|bik").containsMatchIn(s) -> "ride"
                Regex("walk|hik").containsMatchIn(s) -> "walk"
                Regex("swim").containsMatchIn(s) -> "swim"
                else -> "other"
            },
        )
    }
}
