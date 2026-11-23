package dev.freesuunto.app.shell

import androidx.compose.ui.res.stringResource
import dev.freesuunto.app.R
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.shape.CircleShape
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/** One AI the coach can run on (GET /api/coach/status providers). */
data class Provider(val id: String, val label: String, val keyName: String, val keyHelp: String, val keySource: String?, val model: String, val models: List<Triple<String, String, String?>>)

data class CoachSetup(
    val ready: Boolean, val provider: String, val providers: List<Provider>,
    val photos: Boolean, val voice: Boolean,
    /** Model Hub, the app holding the phone's models for every app; null where it can't be (off the phone). */
    val hub: HubInfo? = null,
    /** Who writes plans and runs weekly reviews: the choice ("auto", "google", "anthropic", "rules") and who that is now. */
    val planner: String = "auto", val plannerUses: String = "rules",
    /** The planner's model by name ("Gemini 3.8 Flash", "Claude Opus 5.5"); null: Tartan's rules. */
    val plannerModel: String? = null,
    /** A phone chat kept on the phone even with a cloud key; and who answers the chat, in words. */
    val phoneOnly: Boolean = false, val answers: String? = null,
) {
    /** The coach can answer now: the provider in use has its key, or Model Hub is ready. */
    val canAnswer get() = ready || providers.firstOrNull { it.id == provider }?.keySource != null
}

/** Model Hub as it stands for Tartan (TartanModelHubPlugin.state). */
data class HubInfo(
    val installed: Boolean, val allowed: Boolean, val model: String?, val context: Int, val vision: Boolean,
    val update: String?, val backend: String?, val firstMs: Long, val tokensPerSecond: Double, val error: String?,
    /** Model Hub waits for the owner to approve Tartan there (its notification), or denied it. */
    val notApproved: String? = null,
    /** Tartan's own model file from before 2.37 (name, bytes), still in its storage. */
    val oldFile: Pair<String, Long>? = null,
) {
    /** It can answer: installed, allowed (Android), approved (Model Hub), with a model downloaded. */
    val ready get() = installed && allowed && notApproved == null && model != null && error == null

    /** Where it stands, in words: what to do next, or what it runs and how fast. */
    fun line(): String {
        val loc = java.util.Locale.getDefault()
        return when {
            !installed -> str(R.string.settings_model_hub_isn_t_on_this)
            !allowed -> str(R.string.settings_model_hub_is_installed_allow_tartan)
            notApproved != null -> str(R.string.settings_approve_tartan_in_model_hub, notApproved)
            error != null -> error
            model == null -> str(R.string.settings_model_hub_has_no_model_yet)
            else -> buildString {
                append(str(R.string.settings_ready, model))
                if (context > 0) append(String.format(loc, str(R.string.settings_reading_up_to_d_tokens_at), context))
                append(".")
                backend?.let { append(str(R.string.settings_running_on_the, it)) }
                if (tokensPerSecond > 0) append(str(R.string.settings_last_answer_speed, String.format(loc, "%.1f", firstMs / 1000.0), String.format(loc, "%.0f", tokensPerSecond)))
            }
        }
    }
}

fun parseHub(o: JSONObject?): HubInfo? = o?.let {
    HubInfo(
        it.optBoolean("installed"), it.optBoolean("allowed"), it.text("model"), it.optInt("context"), it.optBoolean("vision"),
        it.text("update"), it.text("backend"), it.optLong("firstMs"), it.optDouble("tokensPerSecond", 0.0), it.text("error"),
        it.text("notApproved"),
        it.optJSONObject("oldFile")?.let { f -> f.optString("name") to f.optLong("size") },
    )
}

private fun JSONObject.text(k: String): String? = if (!has(k) || isNull(k)) null else optString(k).ifEmpty { null }
private fun models(a: JSONArray?) = if (a == null) emptyList() else (0 until a.length()).mapNotNull { a.optJSONObject(it) }.map { Triple(it.optString("id"), it.optString("label"), it.text("note")) }

fun parseCoachSetup(json: String): CoachSetup {
    val o = JSONObject(json)
    val a = o.optJSONArray("providers")
    val list = if (a == null) listOf(Provider("anthropic", str(R.string.settings_anthropic_claude), str(R.string.settings_anthropic_api_key), "console.anthropic.com → API keys", o.text("keySource"), o.optString("model"), models(o.optJSONArray("models"))))
    else (0 until a.length()).mapNotNull { a.optJSONObject(it) }.map { p -> Provider(p.optString("id"), p.optString("label"), p.optString("keyName"), p.optString("keyHelp"), p.text("keySource"), p.optString("model"), models(p.optJSONArray("models"))) }
    return CoachSetup(o.optBoolean("ready"), o.optString("provider", list.first().id), list, o.optBoolean("photos", true), o.optBoolean("voice", true), parseHub(o.optJSONObject("hub")),
        o.optJSONObject("planner")?.optString("choice", "auto") ?: "auto", o.optJSONObject("planner")?.optString("uses", "rules") ?: "rules", o.optJSONObject("planner")?.text("model"), o.optBoolean("phoneOnly"), o.text("answers"))
}

/** The coach's AI (web/views/coach.ts setupCard): provider, model, key, or the phone's own models. */
class CoachSetupModel(private val scope: CoroutineScope, private val api: SettingsApi) {
    var setup by mutableStateOf<CoachSetup?>(null)
    var said by mutableStateOf<String?>(null)
    var busy by mutableStateOf<String?>(null)
    /** Models a key listed (Load models), per provider, for this visit. */
    val loaded = androidx.compose.runtime.mutableStateMapOf<String, List<Triple<String, String, String?>>>()

    fun load() = scope.launch { api.get("/api/coach/status")?.let { runCatching { setup = parseCoachSetup(it) } } }

    private fun body(provider: String, model: String, key: String) = JSONObject().apply {
        put("provider", provider)
        when (provider) {
            "google" -> { put("googleModel", model); if (key.isNotEmpty()) put("googleKey", key) }
            "anthropic" -> { put("model", model); if (key.isNotEmpty()) put("apiKey", key) }
        }
    }

    /** Saved last on its own, as it changed: what it says under the setup ("The coach uses …"). */
    var saved by mutableStateOf<String?>(null)

    /** A key checked with its provider before it's saved: whether it works, in words (null: not checked). */
    var keyCheck by mutableStateOf<Pair<Boolean, String>?>(null)

    private suspend fun check(provider: String, key: String): Boolean {
        busy = "check"
        val (st, text) = api.send("/api/coach/check-key", "POST", JSONObject().put("provider", provider).put("key", key).toString())
        val o = runCatching { JSONObject(text) }.getOrNull()
        val ok = st in 200..299 && o?.optBoolean("ok") == true
        keyCheck = if (ok) true to str(R.string.settings_key_works, if (provider == "google") "Gemini" else "Claude", o!!.optInt("models")) else false to (o?.text("error") ?: str(R.string.settings_couldn_t_check_the_key_is))
        busy = null
        return ok
    }

    /** A cloud key: checked first, saved only when it works. */
    fun checkThenSave(provider: String, model: String, label: String, key: String, done: () -> Unit) {
        scope.launch { if (check(provider, key)) save(provider, model, label, key, done) }
    }

    /** A Gemini key for plans and reviews, while the chat stays on the phone: checked, then saved. */
    fun plannerKey(key: String, done: () -> Unit) {
        scope.launch {
            if (!check("google", key)) return@launch
            val (st, text) = api.send("/api/coach/settings", "PUT", JSONObject().put("googleKey", key).toString())
            if (st in 200..299) { saved = str(R.string.settings_gemini_writes_your_plans_now); done(); load() } else said = str(R.string.common_couldnt_save, runCatching { JSONObject(text).text("error") }.getOrNull() ?: st.toString())
        }
    }

    /** Who writes plans and runs weekly reviews: saved as it's picked. */
    fun planner(choice: String) {
        scope.launch {
            val (st, text) = api.send("/api/coach/settings", "PUT", JSONObject().put("planner", choice).toString())
            if (st !in 200..299) said = str(R.string.common_couldnt_save, runCatching { JSONObject(text).text("error") }.getOrNull() ?: st.toString())
            load()
        }
    }

    /** Save the coach's AI as it changes: quietly ("Saved" under it), or a message if it fails. */
    fun save(provider: String, model: String, label: String, key: String, done: () -> Unit) {
        busy = "save"
        scope.launch {
            val (st, text) = api.send("/api/coach/settings", "PUT", body(provider, model, key).toString())
            if (st in 200..299) saved = str(R.string.settings_the_coach_uses_now, label) else said = str(R.string.common_couldnt_save, runCatching { JSONObject(text).text("error") }.getOrNull() ?: st.toString())
            busy = null
            if (st in 200..299) { done(); load() }
        }
    }

    fun loadModels(provider: String, model: String, key: String) {
        busy = "models"
        scope.launch {
            if (key.isNotEmpty()) api.send("/api/coach/settings", "PUT", body(provider, model, key).toString())
            val text = api.get("/api/coach/models?provider=$provider")
            val list = runCatching { models(JSONArray(text)) }.getOrNull()
            when {
                list == null -> said = runCatching { JSONObject(text ?: "{}").text("error") }.getOrNull() ?: str(R.string.settings_couldn_t_load_the_models)
                list.isEmpty() -> said = str(R.string.settings_this_key_lists_no_chat_models)
                else -> { loaded[provider] = list; said = str(R.string.settings_models_available, list.size, if (provider == "google") "Gemini" else "Claude") }
            }
            busy = null
        }
    }

    fun flag(name: String, on: Boolean) {
        setup = setup?.let { when (name) { "photos" -> it.copy(photos = on); "phoneOnly" -> it.copy(phoneOnly = on); else -> it.copy(voice = on) } }
        scope.launch {
            api.send("/api/coach/settings", "PUT", JSONObject().put(name, on).toString())
            said = when (name) {
                "photos" -> if (on) str(R.string.settings_photos_are_on_in_the_chat) else str(R.string.settings_photos_are_off_in_the_chat)
                "phoneOnly" -> if (on) str(R.string.settings_the_chat_stays_on_your_phone) else str(R.string.settings_your_cloud_coach_answers_when_you)
                else -> if (on) str(R.string.settings_speaking_is_on_in_the_chat) else str(R.string.settings_speaking_is_off_in_the_chat)
            }
            // Who answers now, in the words the chat shows.
            if (name == "phoneOnly") load()
        }
    }

    /**
     * Model Hub: Android's permission prompt ("allow"), opening it ("open") or its Updates
     * ("updates"); or removing Tartan's own model file from before 2.37 ("dropOld").
     */
    fun hub(op: String) {
        busy = "hub"
        scope.launch {
            api.call("modelHub", JSONObject().put("op", op)).fold({ r ->
                if (op == "dropOld") said = str(R.string.settings_tartan_s_old_model_file_is)
                if (op == "allow") said = if (runCatching { JSONObject(r).optBoolean("allowed") }.getOrDefault(false)) str(R.string.settings_tartan_can_use_model_hub_s) else str(R.string.settings_tartan_isn_t_allowed_to_use)
            }, { said = it.message })
            busy = null
            load()
        }
    }
}

/** One of a short set of plain choices (the coach's AI; where the plan goes). */
data class Choice(val id: String, val title: String, val sub: String)

/**
 * The coach's AI, simply: what answers now in a sentence, then a short set of plain choices (a free
 * Gemini key, Model Hub on the phone, your own Claude key, or no AI), each with only what it needs.
 * The rest (the model and Other, who plans, keeping the chat on the phone) waits under More options,
 * closed until opened, and works as it always has. Saved as it changes, a key checked first.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun CoachSetupCard(m: CoachSetupModel, modifier: Modifier) {
    val cs = MaterialTheme.colorScheme
    LaunchedEffect(Unit) { m.load() }
    val s = m.setup ?: return
    val answers = s.canAnswer
    // What's chosen: the coach's provider once it can answer; before that, the free key leads.
    var choice by remember(s.provider, answers) { mutableStateOf(if (answers) s.provider else if (s.planner == "rules") "rules" else "google") }
    val picked = s.providers.any { it.id == choice }
    // The provider the key, model and autosave are about: the one chosen, else the one in use.
    val p = s.providers.firstOrNull { it.id == choice } ?: s.providers.firstOrNull { it.id == s.provider } ?: s.providers.first()
    var model by remember(p.id, s) { mutableStateOf(p.model) }
    var key by remember(p.id) { mutableStateOf("") }
    val onPhone = p.id in ON_PHONE
    // The saved model stays on the list even when the key's list doesn't have it (typed in, or retired).
    val list = (m.loaded[p.id] ?: p.models).let { l -> if (l.none { it.first == p.model }) listOf(Triple(p.model, p.model, null)) + l else l }
    val label = list.firstOrNull { it.first == model }?.second ?: model
    val who = mapOf("google" to "Gemini", "anthropic" to "Claude", "rules" to stringResource(R.string.settings_tartan_s_rules))
    SetCard(
        if (answers) stringResource(R.string.settings_coach_settings) else stringResource(R.string.settings_set_up_your_coach), "coach",
        null,
        modifier.animateContentSize(),
    ) {
        CoachNow(s, who)
        // The choices: Model Hub only on a phone (where Tartan can ask after it).
        val choices = buildList {
            add(Choice("google", stringResource(R.string.settings_free_a_gemini_key), stringResource(R.string.settings_from_google_with_no_card_answers)))
            if (s.hub != null || s.providers.any { it.id == "modelhub" }) add(Choice("modelhub", stringResource(R.string.settings_on_this_phone_model_hub), stringResource(R.string.settings_free_and_offline_nothing_leaves_the)))
            add(Choice("anthropic", stringResource(R.string.settings_my_own_claude_key), stringResource(R.string.settings_from_anthropic_paid_by_use_the)))
            add(Choice("rules", stringResource(R.string.settings_no_ai_tartan_s_rules), stringResource(R.string.settings_your_plan_from_your_targets_and)))
        }
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            choices.forEachIndexed { k, c -> ChoiceRow(c, c.id == choice, first = k == 0, last = k == choices.lastIndex) { choice = c.id } }
        }
        when (choice) {
            "google", "anthropic" -> if (picked) {
                // In the order you'd do it: where to get a key, the key, whether it works.
                if (p.keySource == null) KeySteps(p.id)
                Field(if (p.keySource != null) stringResource(R.string.settings_current, p.keyName, p.keySource) else p.keyName, key, { key = it.trim(); m.keyCheck = null }, placeholder = if (p.id == "google") stringResource(R.string.settings_aiza_or_aq) else "sk-ant-…")
                KeyCheck(m)
                Text(
                    stringResource(R.string.settings_key_stays, if (p.id == "google") "Google" else "Anthropic") +
                        if (p.id == "google") stringResource(R.string.settings_the_free_tier_has_daily_limits) else stringResource(R.string.settings_each_question_is_billed_to_your),
                    style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant,
                )
            }
            "modelhub" -> {
                Text(stringResource(R.string.settings_model_hub_keeps_the_phone_s), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
                val h = s.hub
                Note(h?.line() ?: stringResource(R.string.settings_model_hub_isn_t_on_this_2))
                if (h != null && h.installed) FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (!h.allowed) FilledTonalButton(onClick = { m.hub("allow") }, enabled = m.busy != "hub") { Text(stringResource(R.string.settings_allow_tartan_to_use_it)) }
                    // Waiting for approval: approving in Model Hub is the next step, so it leads.
                    if (h.allowed && h.notApproved != null) FilledTonalButton(onClick = { m.hub("open") }, enabled = m.busy != "hub") { Text(stringResource(R.string.settings_open_model_hub_to_approve)) }
                    else TextButton(onClick = { m.hub("open") }, enabled = m.busy != "hub") { Text(stringResource(R.string.settings_open_model_hub)) }
                    if (h.update != null) TextButton(onClick = { m.hub("updates") }, enabled = m.busy != "hub") { Text(stringResource(R.string.settings_see_the_update)) }
                }
                h?.update?.let { Text(stringResource(R.string.settings_model_hub_has_an_update, it), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant) }
                // Tartan's own model file from before 2.37: Model Hub holds the models now. Never removed by itself.
                h?.oldFile?.let { (name, size) ->
                    ModelFile(name, stringResource(R.string.settings_old_model_file, String.format(java.util.Locale.getDefault(), "%.1f", size / 1e9)), m.busy != "hub") { m.hub("dropOld") }
                }
            }
            "rules" -> {
                Text(
                    when {
                        !answers -> stringResource(R.string.settings_nothing_to_set_up_tartan_s)
                        s.planner == "rules" -> stringResource(R.string.settings_rules_chat_still, s.answers?.substringBefore(";") ?: who[s.provider] ?: stringResource(R.string.settings_your_ai))
                        else -> stringResource(R.string.settings_rules_can_write, s.answers?.substringBefore(";") ?: who[s.provider] ?: stringResource(R.string.settings_your_ai))
                    },
                    style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant,
                )
                if (answers && s.planner != "rules") FilledTonalButton(onClick = { m.planner("rules") }) { Text(stringResource(R.string.settings_plan_by_tartan_s_rules)) }
            }
        }
        // Saved as it changes: a provider when it can answer (a key, or Model Hub ready), so
        // looking through the choices doesn't leave the coach without one; a key or a model a
        // moment after the last keystroke.
        val ready = p.id == s.provider || p.keySource != null || key.isNotEmpty()
        val changed = p.id != s.provider || model != p.model || key.isNotEmpty()
        LaunchedEffect(p.id, model, key, ready) {
            if (!changed || !ready) return@LaunchedEffect
            kotlinx.coroutines.delay(if (key.isNotEmpty()) 1200 else 300)
            // A key: asked of its provider first, so a wrong one never replaces one that works.
            if (key.isNotEmpty() && !onPhone) m.checkThenSave(p.id, model, label, key) { key = "" }
            else m.save(p.id, model, label, key) { key = "" }
        }
        when {
            picked && p.id != s.provider && !ready -> Text(stringResource(R.string.settings_not_in_use_yet, s.providers.firstOrNull { it.id == s.provider }?.label ?: stringResource(R.string.settings_what_it_uses_now)), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
            m.saved != null && !changed -> Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Glyphs["check"], null, Modifier.size(14.dp), tint = LocalData.current.good)
                Text(stringResource(R.string.settings_saved, m.saved.toString()), style = MaterialTheme.typography.labelMedium, color = cs.onSurfaceVariant, modifier = Modifier.padding(start = 6.dp))
            }
        }

        // More options: closed until opened; everything in it works as it did.
        var more by remember { mutableStateOf(false) }
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).press(scale = 0.99f, label = stringResource(R.string.settings_more_options)) { more = !more }.padding(vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(stringResource(R.string.settings_more_options), style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
            Icon(Glyphs["chevron"], if (more) stringResource(R.string.common_close) else stringResource(R.string.settings_open), Modifier.size(18.dp).graphicsLayer { rotationZ = if (more) -90f else 90f }, tint = cs.onSurfaceVariant)
        }
        if (more) Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (!onPhone) {
                var models by remember(p.id) { mutableStateOf(false) }
                Row(Modifier.fillMaxWidth().press(scale = 0.99f, label = stringResource(R.string.settings_model)) { models = !models }.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(stringResource(R.string.settings_model_2, who[p.id] ?: p.label), style = MaterialTheme.typography.labelLarge, color = cs.onSurfaceVariant)
                        Text(label, style = MaterialTheme.typography.bodyLarge)
                    }
                    Text(if (models) stringResource(R.string.common_done) else stringResource(R.string.common_change), style = MaterialTheme.typography.labelLarge, color = cs.primary)
                }
                if (models) {
                    // Other: any model name, for one the list doesn't have yet (a preview, a new release).
                    var typing by remember(p.id) { mutableStateOf(list.none { it.first == model }) }
                    val prefix = if (p.id == "google") "gemini-" else "claude-"
                    Menu(list.map { it.first to (it.second + (it.third?.let { n -> " · $n" } ?: "")) } + (OTHER to stringResource(R.string.settings_other_type_a_model_name)), if (typing) OTHER else model) {
                        if (it == OTHER) typing = true else { typing = false; model = it }
                    }
                    if (typing) {
                        var typed by remember(p.id) { mutableStateOf(if (list.none { it.first == model }) model else "") }
                        Field(stringResource(R.string.settings_model_name), typed, { t ->
                            typed = t
                            // As the provider writes it: "models/Gemini-3.9-Pro " reads as gemini-3.9-pro.
                            val id = t.trim().lowercase().removePrefix("models/")
                            if (Regex("^$prefix[a-z0-9.-]{2,60}$").matches(id)) model = id
                        }, placeholder = if (p.id == "google") "gemini-3.8-flash" else "claude-sonnet-5-5")
                        val id = typed.trim().lowercase().removePrefix("models/")
                        if (id.isNotEmpty() && id != model) Text(stringResource(R.string.settings_model_names_start_with_and_use, prefix), style = MaterialTheme.typography.bodySmall, color = cs.error)
                        else Text(stringResource(R.string.settings_exactly_as_names, if (p.id == "google") "Google" else "Anthropic"), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
                    }
                    TextButton(onClick = { m.loadModels(p.id, model, key) }, enabled = m.busy != "models") { Icon(Glyphs["sync"], null, Modifier.size(16.dp)); Spacer(Modifier.width(6.dp)); Text(stringResource(R.string.settings_load_the_latest_models_needs_the)) }
                }
            }
            // Plans and weekly reviews: a cloud key writes them (they need weeks of history and the
            // whole plan in mind, more than a phone model holds); the chat stays where it is.
            Text(stringResource(R.string.settings_plans_and_weekly_reviews), style = MaterialTheme.typography.labelLarge, color = cs.onSurfaceVariant)
            Menu(
                listOf("auto" to stringResource(R.string.settings_automatic_now, s.plannerModel ?: who[s.plannerUses] ?: s.plannerUses), "google" to stringResource(R.string.settings_gemini_with_your_key), "anthropic" to stringResource(R.string.settings_claude_with_your_key), "rules" to stringResource(R.string.settings_tartan_s_rules)),
                s.planner,
            ) { m.planner(it) }
            Text(
                when {
                    s.planner != "rules" && s.plannerUses == "rules" -> stringResource(R.string.settings_no_key_yet_rules, if (s.planner == "auto") stringResource(R.string.settings_cloud) else who[s.planner].toString())
                    s.planner == "rules" -> stringResource(R.string.settings_tartan_s_rules_write_the_plan)
                    s.provider in ON_PHONE && !s.phoneOnly -> stringResource(R.string.settings_writes_your_plan_and_reviews_each, (s.plannerModel ?: who[s.plannerUses]).toString())
                    s.provider in ON_PHONE -> stringResource(R.string.settings_writes_your_plan_makes_a_new, (s.plannerModel ?: who[s.plannerUses]).toString())
                    else -> stringResource(R.string.settings_writes_your_plan_changes_it_when, (s.plannerModel ?: who[s.plannerUses]).toString())
                },
                style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant,
            )
            // No cloud key and the chat on the phone: a Gemini key for plans, here.
            if (s.plannerUses == "rules" && s.planner != "rules" && s.provider in ON_PHONE) {
                var gkey by remember { mutableStateOf("") }
                KeySteps("google")
                Field(stringResource(R.string.settings_gemini_api_key_for_plans), gkey, { gkey = it.trim(); m.keyCheck = null }, placeholder = stringResource(R.string.settings_aiza_or_aq))
                KeyCheck(m)
                LaunchedEffect(gkey) {
                    if (gkey.length < 20) return@LaunchedEffect
                    kotlinx.coroutines.delay(1200)
                    m.plannerKey(gkey) { gkey = "" }
                }
            }
            // The chat on the phone with a cloud key: the cloud model answers online (it reads what you
            // mean, a phone model too often doesn't), unless you keep it on the phone.
            val cloudKey = s.providers.firstOrNull { it.id in setOf("google", "anthropic") && it.keySource != null }
            if (s.provider in ON_PHONE && cloudKey != null) {
                SwitchRow(
                    stringResource(R.string.settings_keep_the_chat_on_the_phone),
                    if (s.phoneOnly) stringResource(R.string.settings_every_answer_comes_from_the_phone)
                    else stringResource(R.string.settings_off_answers_online, s.answers?.substringBefore(";") ?: cloudKey.label),
                    s.phoneOnly,
                ) { m.flag("phoneOnly", it) }
            }
        }
        // The chat's extras (kept the moment they change).
        SwitchRow(stringResource(R.string.settings_photos_in_the_chat), stringResource(R.string.settings_send_a_photo_with_a_question), s.photos) { m.flag("photos", it) }
        SwitchRow(stringResource(R.string.settings_speak_to_the_coach), stringResource(R.string.settings_say_your_message_instead_of_typing), s.voice) { m.flag("voice", it) }
        Disclaimer()
    }
}

/** What answers now, in a sentence, and who writes the plan. */
@Composable
private fun CoachNow(s: CoachSetup, who: Map<String, String>) {
    val cs = MaterialTheme.colorScheme
    val chat = s.answers?.substringBefore(";")?.trim() ?: s.providers.firstOrNull { it.id == s.provider }?.label
    val offline = s.answers?.substringAfter(";", "")?.trim()?.removePrefix("offline,")?.trim()?.ifEmpty { null }
    val plans = if (s.plannerUses == "rules") stringResource(R.string.settings_tartan_s_rules_write_your_plan) else stringResource(R.string.settings_writes_your_plan_and_reviews_each, (s.plannerModel ?: who[s.plannerUses]).toString())
    val (title, body) =
        if (s.canAnswer && chat != null) stringResource(R.string.settings_answers_you, chat) to listOfNotNull(offline?.let { stringResource(R.string.settings_offline, it) }, plans).joinToString(" ")
        else stringResource(R.string.settings_no_ai_yet) to stringResource(R.string.settings_tartan_s_rules_write_your_plan_2)
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(20.dp)).background(cs.secondaryContainer).padding(16.dp), verticalAlignment = Alignment.Top) {
        Icon(Glyphs[if (s.canAnswer) "check" else "info"], null, Modifier.padding(top = 2.dp).size(20.dp), tint = cs.onSecondaryContainer)
        Column(Modifier.padding(start = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium, color = cs.onSecondaryContainer)
            Text(body, style = MaterialTheme.typography.bodyMedium, color = cs.onSecondaryContainer)
        }
    }
}

/** A choice as a row in a grouped list: a radio mark, its name and a line about it. */
@Composable
fun ChoiceRow(c: Choice, selected: Boolean, first: Boolean, last: Boolean, pick: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    val big = 20.dp; val small = 6.dp
    Row(
        Modifier.fillMaxWidth()
            .clip(RoundedCornerShape(if (first) big else small, if (first) big else small, if (last) big else small, if (last) big else small))
            .background(if (selected) cs.secondaryContainer else cs.surfaceContainerHigh)
            .press(scale = 0.98f, label = c.title, onClick = pick)
            .semantics { this.selected = selected; role = Role.RadioButton }
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(22.dp).clip(CircleShape).background(if (selected) cs.primary else androidx.compose.ui.graphics.Color.Transparent)
                .border(2.dp, if (selected) cs.primary else cs.outline, CircleShape),
            contentAlignment = Alignment.Center,
        ) { if (selected) Icon(Glyphs["check"], null, Modifier.size(14.dp), tint = cs.onPrimary) }
        Column(Modifier.weight(1f).padding(start = 14.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(c.title, style = MaterialTheme.typography.titleSmall, color = if (selected) cs.onSecondaryContainer else cs.onSurface)
            Text(c.sub, style = MaterialTheme.typography.bodySmall, color = if (selected) cs.onSecondaryContainer else cs.onSurfaceVariant)
        }
    }
}

@Composable
private fun Note(text: String) {
    val cs = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(cs.secondaryContainer).padding(12.dp)) {
        Icon(Glyphs["info"], null, Modifier.size(16.dp), tint = cs.onSecondaryContainer)
        Text(text, style = MaterialTheme.typography.bodySmall, color = cs.onSecondaryContainer, modifier = Modifier.padding(start = 8.dp))
    }
}

/** A choice from a short list, as a tonal pill that opens a menu. */
/** A model file: its name in full, what it is, and an × that removes it (tap twice). */
@Composable
private fun ModelFile(name: String, details: String, enabled: Boolean, remove: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    var armed by remember { mutableStateOf(false) }
    LaunchedEffect(armed) { if (armed) { kotlinx.coroutines.delay(4000); armed = false } }
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(cs.secondaryContainer).padding(start = 14.dp, top = 12.dp, bottom = 12.dp, end = 4.dp), verticalAlignment = Alignment.Top) {
        Column(Modifier.weight(1f).padding(top = 2.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(name, style = MaterialTheme.typography.titleSmall, color = cs.onSecondaryContainer)
            if (details.isNotEmpty()) Text(details, style = MaterialTheme.typography.bodySmall, color = cs.onSecondaryContainer)
            if (armed) Text(stringResource(R.string.settings_tap_again_to_remove_it_from), style = MaterialTheme.typography.labelMedium, color = cs.error)
        }
        IconButton(onClick = { if (armed) { armed = false; remove() } else armed = true }, enabled = enabled) {
            Icon(Glyphs["plus"], stringResource(R.string.settings_remove_the_model_file), Modifier.size(20.dp).graphicsLayer { rotationZ = 45f }, tint = if (armed) cs.error else cs.onSecondaryContainer)
        }
    }
}

/** The providers that run on the phone, with no key. */
private val ON_PHONE = setOf("modelhub")

/** The model menu's last choice: type a name. */
private const val OTHER = "\u0000other"

@Composable
fun Menu(options: List<Pair<String, String>>, value: String, pick: (String) -> Unit) {
    val cs = MaterialTheme.colorScheme
    var open by remember { mutableStateOf(false) }
    Column {
        Row(
            Modifier.fillMaxWidth().press(scale = 0.98f, onClick = { open = true }).clip(RoundedCornerShape(16.dp)).background(cs.surfaceContainerHigh).padding(horizontal = 14.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(options.firstOrNull { it.first == value }?.second ?: value, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
            Icon(Glyphs["down"], null, Modifier.size(16.dp), tint = cs.onSurfaceVariant)
        }
        DropdownMenu(open, { open = false }) {
            options.forEach { (id, label) -> DropdownMenuItem({ Text(label) }, { open = false; pick(id) }, leadingIcon = { if (id == value) Icon(Glyphs["check"], null) }) }
        }
    }
}

/** Getting a key, step by step: where, what to tap, and that Tartan checks it as soon as it's in. */
@Composable
private fun KeySteps(provider: String) {
    val cs = MaterialTheme.colorScheme
    val uri = androidx.compose.ui.platform.LocalUriHandler.current
    val google = provider == "google"
    val steps = if (google) listOf(
        stringResource(R.string.settings_open_google_ai_studio_and_sign),
        stringResource(R.string.settings_tap_create_api_key_any_project),
        stringResource(R.string.settings_paste_it_below_tartan_checks_it),
    ) else listOf(
        stringResource(R.string.settings_open_the_anthropic_console_and_sign),
        stringResource(R.string.settings_under_api_keys_tap_create_key),
        stringResource(R.string.settings_paste_it_below_tartan_checks_it_2),
    )
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(20.dp)).background(cs.secondaryContainer).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        steps.forEachIndexed { i, t ->
            Row(verticalAlignment = Alignment.Top) {
                Box(Modifier.size(24.dp).clip(CircleShape).background(cs.onSecondaryContainer), contentAlignment = Alignment.Center) { Text("${i + 1}", style = MaterialTheme.typography.labelMedium, color = cs.secondaryContainer) }
                Text(t, style = MaterialTheme.typography.bodyMedium, color = cs.onSecondaryContainer, modifier = Modifier.padding(start = 10.dp))
            }
        }
        FilledTonalButton(onClick = { runCatching { uri.openUri(if (google) "https://aistudio.google.com/apikey" else "https://console.anthropic.com/settings/keys") } }) {
            Text(if (google) stringResource(R.string.settings_open_google_ai_studio) else stringResource(R.string.settings_open_the_anthropic_console))
        }
    }
}

/** What the provider said of the key just pasted: it works, or why not. */
@Composable
private fun KeyCheck(m: CoachSetupModel) {
    val data = LocalData.current
    val cs = MaterialTheme.colorScheme
    if (m.busy == "check") Row(verticalAlignment = Alignment.CenterVertically) {
        androidx.compose.material3.CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
        Text(stringResource(R.string.settings_checking_the_key), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant, modifier = Modifier.padding(start = 8.dp))
    }
    m.keyCheck?.let { (ok, line) ->
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Glyphs[if (ok) "check" else "warn"], null, Modifier.size(16.dp), tint = if (ok) data.good else cs.error)
            Text(line, style = MaterialTheme.typography.bodySmall, color = if (ok) cs.onSurface else cs.error, modifier = Modifier.padding(start = 6.dp))
        }
    }
}
