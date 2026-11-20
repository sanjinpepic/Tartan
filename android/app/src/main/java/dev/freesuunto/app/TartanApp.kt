package dev.freesuunto.app

import android.app.Application
import dev.freesuunto.app.shell.Txt

/** The application: gives code outside the screens (the widget, notifications, plugins) the app's strings. */
class TartanApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Txt.init(this)
    }
}
