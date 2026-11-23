package dev.freesuunto.app

import dev.freesuunto.app.shell.str
import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.LocaleList
import android.speech.RecognitionListener
import android.speech.RecognitionService
import android.speech.RecognitionSupport
import android.speech.RecognitionSupportCallback
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

/**
 * Speech to text for notes (web/lib/speech.ts), with Android's own recognizers. Phones differ a
 * lot here: the phone's locale (say English with Swedish region, "en-SE") is often a tag no
 * recognizer knows, the default recognizer may be the maker's, and the on-device one may lack the
 * language. So it tries, until one listens:
 *  1. a recognizer that showed your words as you spoke (remembered), then any not yet tried
 *     with you, and only after those the ones that worked but gave the words only at the end;
 *  2. the on-device recognizer (Android 12+, offline, nothing leaves the phone), then the default
 *     one, then every other recognizer installed (Google's first);
 *  3. for each, the phone's languages as tags the recognizer knows: the ones it reports installed
 *     (Android 13+), the phone's exact tags, the usual region for that language (en-US, en-GB,
 *     sv-SE…), the bare language, and finally none at all;
 *  4. last, Android's own voice-typing popup.
 * A language or service error before you start speaking moves on to the next try; words arrive
 * as you speak ("partial" events); start() resolves with the final text.
 */
@CapacitorPlugin(name = "TartanSpeech", permissions = [Permission(strings = [Manifest.permission.RECORD_AUDIO], alias = "microphone")])
class TartanSpeechPlugin : Plugin() {
    private data class Attempt(val onDevice: Boolean, val component: ComponentName?, val lang: String?) {
        fun key() = "${if (onDevice) "device" else component?.flattenToString() ?: "default"}|${lang ?: ""}"
    }

    private var recognizer: SpeechRecognizer? = null
    private var session = 0
    /** Stop was tapped: no more tries, whatever the recognizer says next. */
    private var stopping = false

    @PluginMethod
    fun available(call: PluginCall) {
        val onDevice = Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(context)
        val any = onDevice || SpeechRecognizer.isRecognitionAvailable(context) || voiceIntent().resolveActivity(context.packageManager) != null
        call.resolve(JSObject().put("available", any).put("onDevice", onDevice))
    }

    @PluginMethod
    fun start(call: PluginCall) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "micAnswered")
            return
        }
        begin(call)
    }

    @PermissionCallback
    private fun micAnswered(call: PluginCall) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) begin(call)
        else call.reject(str(R.string.speech_tartan_needs_the_microphone_to_hear))
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        stopping = true
        activity.runOnUiThread { recognizer?.stopListening() }
        call.resolve()
    }

    // ------------------------------------------------------------------ which recognizer, which language

    private val prefs get() = context.getSharedPreferences("tartan.speech", Context.MODE_PRIVATE)

    /** The phone's languages, most preferred first. */
    private fun phoneLocales(): List<java.util.Locale> {
        val list = LocaleList.getDefault()
        return (0 until list.size()).map { list[it] }
    }

    /** Tags to try for these locales: installed ones first, then exact, the usual region, the bare language. */
    private fun languages(installed: List<String>): List<String?> {
        val usual = mapOf("en" to listOf("en-US", "en-GB"), "sv" to listOf("sv-SE"), "nb" to listOf("nb-NO"), "no" to listOf("nb-NO"), "da" to listOf("da-DK"), "fi" to listOf("fi-FI"), "de" to listOf("de-DE"), "fr" to listOf("fr-FR"), "es" to listOf("es-ES"), "it" to listOf("it-IT"), "nl" to listOf("nl-NL"), "pt" to listOf("pt-BR", "pt-PT"), "pl" to listOf("pl-PL"))
        val out = LinkedHashSet<String?>()
        val locales = phoneLocales()
        for (l in locales) {
            installed.firstOrNull { it.equals(l.toLanguageTag(), true) }?.let { out.add(it) }
            installed.filter { it.substringBefore('-').equals(l.language, true) }.forEach { out.add(it) }
        }
        for (l in locales) {
            out.add(l.toLanguageTag())
            usual[l.language]?.forEach { out.add(it) }
            out.add(l.language)
        }
        out.add(null)
        return out.toList()
    }

    /** Every recognizer to try, best bet first. */
    private fun recognizers(): List<Pair<Boolean, ComponentName?>> {
        val out = mutableListOf<Pair<Boolean, ComponentName?>>()
        if (Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(context)) out.add(true to null)
        if (SpeechRecognizer.isRecognitionAvailable(context)) out.add(false to null)
        val services = context.packageManager.queryIntentServices(Intent(RecognitionService.SERVICE_INTERFACE), 0)
            .map { ComponentName(it.serviceInfo.packageName, it.serviceInfo.name) }
            .sortedBy { if (it.packageName.contains("google")) 0 else 1 }
        services.forEach { out.add(false to it) }
        return out
    }

    private fun begin(call: PluginCall) {
        activity.runOnUiThread {
            val mine = ++session
            stopping = false
            // Android 13+: ask the on-device recognizer which languages it has, to try those first.
            if (Build.VERSION.SDK_INT >= 33 && SpeechRecognizer.isOnDeviceRecognitionAvailable(context)) {
                val probe = SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
                var answered = false
                val go = { installed: List<String> ->
                    if (!answered) {
                        answered = true
                        probe.destroy()
                        if (mine == session) run(call, plan(installed), 0, null)
                    }
                }
                try {
                    probe.checkRecognitionSupport(listenIntent(null), context.mainExecutor, object : RecognitionSupportCallback {
                        override fun onSupportResult(support: RecognitionSupport) = go(support.installedOnDeviceLanguages + support.onlineLanguages)
                        override fun onError(error: Int) = go(emptyList())
                    })
                } catch (e: Exception) {
                    go(emptyList())
                }
                // Some recognizers never answer the question: don't wait for them.
                activity.window.decorView.postDelayed({ go(emptyList()) }, 700)
            } else run(call, plan(emptyList()), 0, null)
        }
    }

    /**
     * The order to try them in. Live words (partial results) are the point, so a recognizer that
     * gave them comes first; one that only gave the words at the end ("quiet") goes behind every
     * one not yet known, so a better one (say the on-device model, once Android has fetched the
     * language) gets its chance. One that failed slowly (network, service) waits a few hours.
     */
    private fun plan(installed: List<String>): List<Attempt> {
        val langs = languages(installed)
        val all = recognizers().flatMap { (onDevice, component) -> langs.map { Attempt(onDevice, component, it) } }.distinctBy { it.key() }
        val live = prefs.getString("live", null)
        val worked = prefs.getString("worked", null)
        val quiet = prefs.getStringSet("quiet", emptySet()) ?: emptySet()
        val now = System.currentTimeMillis()
        val rank = { a: Attempt ->
            val k = a.key()
            when {
                k == live -> 0
                now - prefs.getLong("bad:$k", 0) < 6 * 3600_000 -> 4
                k == worked && k !in quiet -> 1
                k !in quiet -> 2
                k == worked -> 3
                else -> 4
            }
        }
        val ordered = all.sortedBy(rank)
        // Unknown ones are capped (each fails in a moment, but not forever); the known good ones always stay.
        return ordered.filter { rank(it) <= 2 }.take(20) + ordered.filter { rank(it) == 3 } + ordered.filter { rank(it) == 4 }.take(4)
    }

    /** It listened: remember how well, to pick the order next time. */
    private fun remember(a: Attempt, live: Boolean, words: Int) {
        val k = a.key()
        val quiet = (prefs.getStringSet("quiet", emptySet()) ?: emptySet()).toMutableSet()
        val e = prefs.edit().putString("worked", k).remove("bad:$k")
        if (live) {
            quiet.remove(k)
            e.putString("live", k)
        } else if (words >= 3) {
            // A few words and not one shown while speaking: this one gives them only at the end.
            quiet.add(k)
            if (prefs.getString("live", null) == k) e.remove("live")
        }
        e.putStringSet("quiet", quiet).apply()
    }

    private fun listenIntent(lang: String?) = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
        if (lang != null) {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, lang)
        }
    }

    private fun voiceIntent() = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_PROMPT, str(R.string.speech_say_your_note))
    }

    // ------------------------------------------------------------------ listening

    private fun run(call: PluginCall, attempts: List<Attempt>, i: Int, lastError: Int?) {
        if (stopping) return finish().also { call.resolve(JSObject().put("text", "")) }
        if (i >= attempts.size) return popup(call, lastError)
        val a = attempts[i]
        val mine = session
        recognizer?.destroy()
        val r = try {
            when {
                a.onDevice && Build.VERSION.SDK_INT >= 31 -> SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
                a.component != null -> SpeechRecognizer.createSpeechRecognizer(context, a.component)
                else -> SpeechRecognizer.createSpeechRecognizer(context)
            }
        } catch (e: Exception) {
            return run(call, attempts, i + 1, lastError)
        }
        recognizer = r
        val intent = listenIntent(a.lang)
        var heard = false
        var live = false
        var settled = false
        r.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) = notifyListeners("state", JSObject().put("listening", true).put("onDevice", a.onDevice).put("lang", a.lang ?: ""))
            override fun onBeginningOfSpeech() {
                heard = true
            }
            override fun onRmsChanged(rmsdB: Float) = notifyListeners("level", JSObject().put("db", rmsdB.toDouble()))
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
            override fun onPartialResults(partial: Bundle?) {
                val text = partial?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: return
                heard = true
                if (text.isNotBlank()) live = true
                notifyListeners("partial", JSObject().put("text", text))
            }
            override fun onResults(results: Bundle?) {
                if (settled || mine != session) return
                settled = true
                val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: ""
                remember(a, live, text.trim().split(Regex("\\s+")).count { it.isNotEmpty() })
                finish()
                call.resolve(JSObject().put("text", text).put("onDevice", a.onDevice).put("live", live))
            }
            override fun onError(error: Int) {
                if (settled || mine != session) return
                settled = true
                val languageGone = error == SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED || error == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE
                val serviceGone = error in listOf(SpeechRecognizer.ERROR_CLIENT, SpeechRecognizer.ERROR_SERVER, SpeechRecognizer.ERROR_SERVER_DISCONNECTED, SpeechRecognizer.ERROR_TOO_MANY_REQUESTS, SpeechRecognizer.ERROR_CANNOT_CHECK_SUPPORT, SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT)
                // Nothing said yet and this one can't take it: the next try, without a word from us.
                if (!heard && !stopping && (languageGone || serviceGone)) {
                    if (serviceGone) prefs.edit().putLong("bad:${a.key()}", System.currentTimeMillis()).apply()
                    if (a.onDevice && error == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE && a.lang != null && Build.VERSION.SDK_INT >= 33) runCatching { r.triggerModelDownload(intent) }
                    activity.runOnUiThread { if (mine == session) run(call, attempts, i + 1, error) }
                    return
                }
                finish()
                if (stopping) return call.resolve(JSObject().put("text", ""))
                when (error) {
                    SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> {
                        remember(a, live, 0)
                        call.resolve(JSObject().put("text", ""))
                    }
                    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> call.reject(str(R.string.speech_tartan_needs_the_microphone_to_hear_2))
                    SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> call.reject(str(R.string.speech_the_microphone_is_busy_with_another))
                    SpeechRecognizer.ERROR_AUDIO -> call.reject(str(R.string.speech_the_microphone_couldn_t_record_try))
                    else -> call.reject(str(R.string.speech_couldn_t_hear_that_code_try, error))
                }
            }
        })
        try {
            r.startListening(intent)
        } catch (e: Exception) {
            settled = true
            run(call, attempts, i + 1, lastError)
        }
    }

    /** Nothing listened in the background: Android's own voice-typing popup, if there is one. */
    private fun popup(call: PluginCall, lastError: Int?) {
        finish()
        val intent = voiceIntent()
        if (intent.resolveActivity(context.packageManager) == null) {
            prefs.edit().remove("worked").apply()
            call.reject(
                if (lastError == SpeechRecognizer.ERROR_NETWORK || lastError == SpeechRecognizer.ERROR_NETWORK_TIMEOUT) str(R.string.speech_speech_needs_the_internet_on_this)
                else str(R.string.speech_no_speech_recognizer_on_this_phone),
            )
            return
        }
        startActivityForResult(call, intent, "voiceTyped")
    }

    @ActivityCallback
    private fun voiceTyped(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        val text = if (result.resultCode == Activity.RESULT_OK) result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull() ?: "" else ""
        call.resolve(JSObject().put("text", text).put("popup", true))
    }

    private fun finish() {
        notifyListeners("state", JSObject().put("listening", false))
        recognizer?.destroy()
        recognizer = null
    }

    override fun handleOnDestroy() {
        session++
        recognizer?.destroy()
        recognizer = null
    }
}
