package dev.freesuunto.app.shell

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.freesuunto.app.R
import org.json.JSONObject

/**
 * The weather a workout was done in (src/workout-weather.ts), a quiet detail: the sky as a glyph
 * and the temperature on the cards ("☁ 4°", the wind when it was notable), a line in words on
 * its sheet ("Light rain, 4° (feels 0°), wind 18 km/h"). °C: the app has no unit setting.
 */
data class Weather(val tempC: Double, val feelsC: Double?, val condition: String, val sky: String, val windKmh: Int?, val day: Boolean?, val at: String? = null) {
    /** The glyph for the sky (a moon for a clear night). */
    val glyph get() = when (condition) {
        "clear" -> if (day == false) "moon" else "sun"
        "rain" -> "rain"
        "snow" -> "snow"
        "fog" -> "fog"
        "storm" -> "storm"
        else -> "cloud"
    }
    val temp get() = str(R.string.weather_temp, Math.round(tempC).toInt())
    /** Wind worth a word on a card: 25 km/h and more. */
    val notableWind get() = windKmh?.takeIf { it >= 25 }
    /** "4° · 32 km/h wind" (the glyph goes before it). */
    val compact get() = listOfNotNull(temp, notableWind?.let { str(R.string.weather_wind_short, it) }).joinToString(" · ")
    /** "Light rain, 4° (feels 0°), wind 18 km/h". */
    val line: String get() {
        val feels = feelsC?.let { Math.round(it).toInt() }?.takeIf { it != Math.round(tempC).toInt() }?.let { " " + str(R.string.weather_feels, str(R.string.weather_temp, it)) } ?: ""
        return listOfNotNull("$sky, $temp$feels", windKmh?.takeIf { it > 0 }?.let { str(R.string.weather_wind, it) }).joinToString(", ")
    }
    /** A planned session's: "Forecast at 17:00: light rain, 4° (feels 0°), wind 18 km/h". */
    val forecastLine: String get() = at?.let { str(R.string.weather_forecast_at, it, line.replaceFirstChar { c -> c.lowercase() }) } ?: line
}

/** A row's `weather` object, or null when it has none. */
fun parseWeather(o: JSONObject?): Weather? {
    if (o == null || !o.has("temp_c") || o.isNull("temp_c")) return null
    val t = o.optDouble("temp_c").takeUnless { it.isNaN() } ?: return null
    return Weather(
        t,
        if (o.has("feels_c") && !o.isNull("feels_c")) o.optDouble("feels_c").takeUnless { it.isNaN() } else null,
        o.optString("condition", "cloudy"),
        o.optString("sky").ifEmpty { "" },
        if (o.has("wind_kmh") && !o.isNull("wind_kmh")) o.optInt("wind_kmh") else null,
        if (o.has("day") && !o.isNull("day")) o.optBoolean("day") else null,
        o.optString("at").takeIf { it.isNotEmpty() && !o.isNull("at") },
    )
}

/** On a card: the sky's glyph and the temperature (and a strong wind), in the line's own muted style. */
@Composable
fun WeatherInline(w: Weather, style: TextStyle, color: Color, modifier: Modifier = Modifier, glyph: Dp = 14.dp) {
    val said = w.line
    Row(modifier.clearAndSetSemantics { contentDescription = said }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
        Icon(Glyphs[w.glyph], null, Modifier.size(glyph), tint = color)
        Text(w.compact, style = style, color = color, maxLines = 1)
    }
}

/** On the sheet: one line in words under the date (a planned session's says it's the forecast, and for when). */
@Composable
fun WeatherSentence(w: Weather, modifier: Modifier = Modifier) {
    val cs = MaterialTheme.colorScheme
    // The glyph beside the first line when the words wrap.
    Row(modifier, verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Icon(Glyphs[w.glyph], null, Modifier.padding(top = 2.dp).size(16.dp), tint = cs.onSurfaceVariant)
        Text(if (w.at != null) w.forecastLine else w.line, style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
    }
}
