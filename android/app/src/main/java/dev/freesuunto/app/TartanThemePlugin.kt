package dev.freesuunto.app

import android.os.Build
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Material You: the colours Android made from your wallpaper, for web/lib/theme.ts. Android 14+
 * names every Material role (primary, the surface containers, outline…) for light and dark; on
 * Android 12 and 13 they come from the five tonal palettes at the tones Material uses. Before
 * Android 12 there are none, and Tartan keeps its own.
 */
@CapacitorPlugin(name = "TartanTheme")
class TartanThemePlugin : Plugin() {
    private fun hex(id: Int) = String.format("#%06x", context.getColor(id) and 0xffffff)

    @PluginMethod
    fun colors(call: PluginCall) {
        if (Build.VERSION.SDK_INT < 31) return call.resolve(JSObject().put("available", false))
        val out = JSObject().put("available", true)
        if (Build.VERSION.SDK_INT >= 34) {
            out.put("light", roles(true)).put("dark", roles(false))
        } else {
            out.put("light", palette(true)).put("dark", palette(false))
        }
        call.resolve(out)
    }

    /** Android 14+: the roles themselves. */
    private fun roles(light: Boolean): JSObject {
        val r = android.R.color::class.java
        val o = JSObject()
        for (name in ROLES) {
            val id = runCatching { r.getField("system_${name}_${if (light) "light" else "dark"}").getInt(null) }.getOrNull() ?: continue
            o.put(name, hex(id))
        }
        return o
    }

    /** Android 12–13: the tonal palettes at Material's tones (0 is white, 1000 black). */
    private fun palette(light: Boolean): JSObject {
        fun c(p: String, shade: Int) = runCatching { hex(android.R.color::class.java.getField("system_${p}_$shade").getInt(null)) }.getOrNull()
        val o = JSObject()
        fun put(name: String, l: Pair<String, Int>, d: Pair<String, Int>) {
            val (p, s) = if (light) l else d
            c(p, s)?.let { o.put(name, it) }
        }
        put("primary", "accent1" to 600, "accent1" to 200)
        put("on_primary", "accent1" to 0, "accent1" to 800)
        put("primary_container", "accent1" to 100, "accent1" to 700)
        put("on_primary_container", "accent1" to 900, "accent1" to 100)
        put("secondary_container", "accent2" to 100, "accent2" to 700)
        put("on_secondary_container", "accent2" to 900, "accent2" to 100)
        put("inverse_surface", "neutral1" to 800, "neutral1" to 100)
        put("inverse_on_surface", "neutral1" to 50, "neutral1" to 800)
        put("inverse_primary", "accent1" to 200, "accent1" to 600)
        put("surface", "neutral1" to 10, "neutral1" to 900)
        put("surface_container", "neutral1" to 50, "neutral1" to 800)
        put("surface_container_high", "neutral2" to 50, "neutral2" to 800)
        put("surface_container_highest", "neutral2" to 100, "neutral2" to 700)
        put("surface_dim", "neutral2" to 100, "neutral1" to 900)
        put("outline", "neutral2" to 500, "neutral2" to 400)
        put("outline_variant", "neutral2" to 200, "neutral2" to 700)
        put("on_surface", "neutral1" to 900, "neutral1" to 100)
        put("on_surface_variant", "neutral2" to 700, "neutral2" to 200)
        return o
    }

    companion object {
        private val ROLES = listOf(
            "primary", "on_primary", "primary_container", "on_primary_container",
            "secondary_container", "on_secondary_container",
            "inverse_surface", "inverse_on_surface", "inverse_primary",
            "surface", "surface_container_low", "surface_container", "surface_container_high", "surface_container_highest", "surface_dim",
            "outline", "outline_variant", "on_surface", "on_surface_variant",
        )
    }
}
