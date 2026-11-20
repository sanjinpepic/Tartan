package dev.freesuunto.app

import android.content.Context
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/** The app hands the home-screen widget what to show (web/lib/widget.ts); the widget redraws. */
@CapacitorPlugin(name = "TartanWidget")
class TartanWidgetPlugin : Plugin() {
    @PluginMethod
    fun update(call: PluginCall) {
        context.getSharedPreferences(TodayWidget.PREFS, Context.MODE_PRIVATE).edit().putString("data", call.data.toString()).apply()
        TodayWidget.refresh(context)
        call.resolve()
    }
}
