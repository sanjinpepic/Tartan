package dev.freesuunto.app.shell

import dev.freesuunto.app.R
import android.content.Context
import android.net.Uri

/**
 * Feedback for Tartan's developer: a GitHub issue, opened in the browser with its title and body
 * filled in, so you see (and can edit) everything before it's sent. Nothing leaves the phone
 * otherwise.
 */
object Feedback {
    const val ISSUES = "https://github.com/sanjinpepic/Tartan/issues/new"

    /** The app's version as installed ("0.3.0-tartan2.43"). */
    fun version(context: Context): String = runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull() ?: "?"

    /** A new issue, filled in; the body kept short enough for a link. */
    fun issue(title: String, body: String, label: String? = null): String =
        Uri.parse(ISSUES).buildUpon()
            .appendQueryParameter("title", title.take(120))
            .appendQueryParameter("body", body.take(5500))
            .apply { label?.let { appendQueryParameter("labels", it) } }
            .build().toString()

    /** A reported coach reply as an issue: why, what was asked, what came back, who wrote it. */
    fun report(context: Context, reason: String, note: String, r: Reported): String = issue(
        str(R.string.feedback_coach_reply_reported, reason),
        buildString {
            appendLine(str(R.string.feedback_why, reason))
            if (note.isNotBlank()) appendLine(str(R.string.feedback_note, note.trim()))
            appendLine(str(R.string.feedback_answered_by, r.by ?: "?"))
            appendLine(str(R.string.feedback_tartan_android, version(context), android.os.Build.VERSION.RELEASE))
            appendLine()
            appendLine(str(R.string.feedback_asked))
            appendLine(r.question.take(800).lines().joinToString("\n") { "> $it" })
            appendLine()
            appendLine(str(R.string.feedback_reply))
            appendLine(r.reply.take(3000).lines().joinToString("\n") { "> $it" })
        },
        label = "coach-report",
    )
}
