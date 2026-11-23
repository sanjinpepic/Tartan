package dev.freesuunto.app.shell

import android.content.Context
import android.content.res.Resources
import androidx.annotation.PluralsRes
import androidx.annotation.StringRes

/**
 * The app's words live in res/values/strings.xml (and a translation's values-xx/strings.xml), so
 * they can be translated. Compose screens read them with stringResource / pluralStringResource;
 * code that isn't a composable (models, notifications, the widget, the plugins) with str() and
 * plural() here, from the application's resources (set by TartanApp, and by the tests).
 * Words that come from the engine (TypeScript in src/ and web/) are still English, kept there.
 */
object Txt {
    @Volatile private var app: Context? = null

    fun init(c: Context) { app = c.applicationContext ?: c }

    val res: Resources get() = checkNotNull(app) { "Txt.init wasn't called" }.resources
}

/** One of the app's strings, with its arguments (%1$s…) filled in. */
fun str(@StringRes id: Int, vararg args: Any?): String = if (args.isEmpty()) Txt.res.getString(id) else Txt.res.getString(id, *args)

/** A string that depends on a count ("1 week", "3 weeks"), with its arguments filled in. */
fun plural(@PluralsRes id: Int, n: Int, vararg args: Any?): String = Txt.res.getQuantityString(id, n, *args)
