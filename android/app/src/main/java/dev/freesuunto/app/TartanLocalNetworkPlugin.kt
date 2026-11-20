package dev.freesuunto.app

import android.Manifest
import android.os.Build
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

/**
 * Android 17 (API 37) asks before an app reaches devices on the home network: the PC link
 * (web/lib/local-network.ts) needs ACCESS_LOCAL_NETWORK, in the same "Nearby devices" group as
 * Bluetooth, so a phone that allowed the watch may not be asked again. Before Android 17 the
 * internet permission covers it and both calls say granted.
 */
@CapacitorPlugin(name = "TartanLocalNetwork", permissions = [Permission(strings = [Manifest.permission.ACCESS_LOCAL_NETWORK], alias = "localNetwork")])
class TartanLocalNetworkPlugin : Plugin() {
    private val needed get() = Build.VERSION.SDK_INT >= 37
    private fun granted() = !needed || getPermissionState("localNetwork") == PermissionState.GRANTED
    private fun answer(call: PluginCall) = call.resolve(JSObject().put("granted", granted()))

    @PluginMethod
    fun check(call: PluginCall) = answer(call)

    @PluginMethod
    fun request(call: PluginCall) {
        if (granted()) return answer(call)
        requestPermissionForAlias("localNetwork", call, "answered")
    }

    @PermissionCallback
    private fun answered(call: PluginCall) = answer(call)
}
