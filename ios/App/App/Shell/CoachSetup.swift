import SwiftUI
import Observation

/// One AI the coach can run on (GET /api/coach/status providers).
struct Provider: Identifiable {
    let id: String
    let label: String
    let keyName: String
    let keySource: String?
    let model: String
    let models: [ModelChoice]
}

struct ModelChoice: Identifiable, Hashable {
    let id: String
    let label: String
    let note: String?
}

/// The coach's AI as it stands.
struct CoachSetup {
    let ready: Bool
    let provider: String
    let providers: [Provider]
    let photos: Bool
    let voice: Bool
    /** Who writes plans and runs weekly reviews: the choice ("auto", "google", "anthropic", "rules") and who that is now. */
    let planner: String
    let plannerUses: String
    let plannerModel: String?
    /** Who answers the chat, in words ("Gemini 3.8 Flash; offline, …"). */
    let answers: String?

    /** The coach can answer now: the provider in use has its key. */
    var canAnswer: Bool { ready || providers.first { $0.id == provider }?.keySource != nil }
}

private func models(_ a: J) -> [ModelChoice] { a.array.map { ModelChoice(id: $0["id"].text, label: $0["label"].text, note: $0["note"].str) } }

func parseCoachSetup(_ json: String) -> CoachSetup {
    let o = J(json: json)
    var list = o["providers"].array.map { p in
        Provider(id: p["id"].text, label: p["label"].text, keyName: p["keyName"].text, keySource: p["keySource"].str.flatMap { $0.isEmpty ? nil : $0 }, model: p["model"].text, models: models(p["models"]))
    }
    if list.isEmpty {
        list = [Provider(id: "anthropic", label: "Anthropic Claude", keyName: "Anthropic API key", keySource: o["keySource"].str, model: o["model"].text, models: models(o["models"]))]
    }
    let pl = o["planner"]
    return CoachSetup(ready: o["ready"].bool, provider: o["provider"].str ?? list[0].id, providers: list,
                      photos: o.has("photos") ? o["photos"].bool : true, voice: o.has("voice") ? o["voice"].bool : true,
                      planner: pl["choice"].str ?? "auto", plannerUses: pl["uses"].str ?? "rules", plannerModel: pl["model"].str, answers: o["answers"].str)
}

/// The coach's AI (Android's CoachSetupModel, web/views/coach.ts setupCard): provider, model, key.
@MainActor
@Observable
final class CoachSetupModel {
    @ObservationIgnored weak var shell: ShellModel?
    private let engine: EngineBridge
    var setup: CoachSetup?
    var busy: String?
    /** Saved last on its own, as it changed: what it says under the setup. */
    var saved: String?
    /** A key checked with its provider before it's saved: whether it works, in words. */
    var keyCheck: (ok: Bool, line: String)?
    /** Models a key listed (Load models), per provider, for this visit. */
    var loaded: [String: [ModelChoice]] = [:]

    init(engine: EngineBridge) { self.engine = engine }

    private func say(_ s: String) { shell?.say(s) }

    func load() async {
        if let j = await engine.get("/api/coach/status") { setup = parseCoachSetup(j) }
        if setup != nil { Launch.ready("coachsetup") }
    }

    private func body(_ provider: String, _ model: String, _ key: String) -> [String: Any] {
        var b: [String: Any] = ["provider": provider]
        if provider == "google" { b["googleModel"] = model; if !key.isEmpty { b["googleKey"] = key } }
        if provider == "anthropic" { b["model"] = model; if !key.isEmpty { b["apiKey"] = key } }
        return b
    }

    private func check(_ provider: String, _ key: String) async -> Bool {
        busy = "check"
        defer { busy = nil }
        let r = await engine.call("/api/coach/check-key", method: "POST", body: jsonText(["provider": provider, "key": key]))
        let o = J(json: r.body)
        let ok = (200..<300).contains(r.status) && o["ok"].bool
        keyCheck = ok ? (ok: true, line: "The key works: \(provider == "google" ? "Gemini" : "Claude") is ready (\(o["models"].int ?? 0) models it can use).")
            : (ok: false, line: o["error"].str ?? "Couldn't check the key: is the phone online?")
        return ok
    }

    /** Save the coach's AI as it changes: quietly ("Saved" under it), or a message if it fails. */
    func save(_ provider: String, _ model: String, _ label: String, _ key: String) async -> Bool {
        if !key.isEmpty, provider != "rules", !(await check(provider, key)) { return false }
        busy = "save"
        defer { busy = nil }
        let r = await engine.call("/api/coach/settings", method: "PUT", body: jsonText(body(provider, model, key)))
        if (200..<300).contains(r.status) {
            saved = "The coach uses \(label) now."
            await load()
            return true
        }
        say("Couldn't save: \(J(json: r.body)["error"].str ?? String(r.status))")
        return false
    }

    /** Who writes plans and runs weekly reviews: saved as it's picked. */
    func planner(_ choice: String) async {
        let r = await engine.call("/api/coach/settings", method: "PUT", body: jsonText(["planner": choice]))
        if !(200..<300).contains(r.status) { say("Couldn't save: \(J(json: r.body)["error"].str ?? String(r.status))") }
        await load()
    }

    func loadModels(_ provider: String, _ model: String, _ key: String) async {
        busy = "models"
        defer { busy = nil }
        if !key.isEmpty { _ = await engine.call("/api/coach/settings", method: "PUT", body: jsonText(body(provider, model, key))) }
        let text = await engine.get("/api/coach/models?provider=\(provider)")
        let j = J(json: text)
        guard j.raw is [Any] else { say(j["error"].str ?? "Couldn't load the models."); return }
        let list = models(j)
        if list.isEmpty { say("This key lists no chat models."); return }
        loaded[provider] = list
        say("\(list.count) \(provider == "google" ? "Gemini" : "Claude") models available to your key.")
    }

    func flag(_ name: String, _ on: Bool) async {
        _ = await engine.call("/api/coach/settings", method: "PUT", body: jsonText([name: on]))
        say(name == "photos" ? (on ? "Photos are on in the chat." : "Photos are off in the chat.") : (on ? "Speaking is on in the chat." : "Speaking is off in the chat."))
        await load()
    }
}

private let WHO = ["google": "Gemini", "anthropic": "Claude", "rules": "Tartan's rules"]
private let OTHER = "\u{0}other"

/**
 * The coach's AI, simply (Android's CoachSetupCard): what answers now in a sentence, then a short
 * set of plain choices (a free Gemini key, your own Claude key, or no AI), each with only what it
 * needs. The rest (the model, who plans) waits under More options. Saved as it changes, a key
 * checked first.
 */
struct CoachSetupCard: View {
    let m: CoachSetupModel
    let shell: ShellModel
    @State private var choice: String?
    @State private var model = ""
    @State private var key = ""
    @State private var typed = ""
    @State private var typing = false
    @State private var more = false

    var body: some View {
        if let s = m.setup {
            content(s)
        } else {
            ProgressView().frame(maxWidth: .infinity, minHeight: 120)
                .task { await m.load() }
        }
    }

    @ViewBuilder private func content(_ s: CoachSetup) -> some View {
        let chosen = choice ?? (s.canAnswer ? s.provider : s.planner == "rules" ? "rules" : "google")
        let picked = s.providers.contains { $0.id == chosen }
        let p = s.providers.first { $0.id == chosen } ?? s.providers.first { $0.id == s.provider } ?? s.providers[0]
        let base = m.loaded[p.id] ?? p.models
        let list = base.contains { $0.id == p.model } ? base : [ModelChoice(id: p.model, label: p.model, note: nil)] + base
        let current = model.isEmpty ? p.model : model
        let label = list.first { $0.id == current }?.label ?? current
        VStack(alignment: .leading, spacing: 14) {
            CoachNow(s: s)
            VStack(spacing: 4) {
                choiceRow("google", "Free: a Gemini key", "From Google, with no card. Answers your questions and writes your plan.", chosen)
                choiceRow("anthropic", "My own Claude key", "From Anthropic, paid by use. The deepest answers.", chosen)
                choiceRow("rules", "No AI: Tartan's rules", "Your plan from your targets and recent weeks. No chat.", chosen)
            }
            if (chosen == "google" || chosen == "anthropic") && picked {
                if p.keySource == nil { KeySteps(google: p.id == "google", open: { shell.sources.open($0) }) }
                SecureField(p.keySource != nil ? "\(p.keyName) (current: \(p.keySource!))" : p.keyName, text: Binding(get: { key }, set: { key = $0.trimmingCharacters(in: .whitespacesAndNewlines); m.keyCheck = nil }),
                            prompt: Text(p.id == "google" ? "AIza… or AQ.…" : "sk-ant-…"))
                    .padding(.horizontal, 14).frame(height: 48)
                    .background(Brand.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                keyCheck
                Text("The key stays in this app on your phone and goes only to \(p.id == "google" ? "Google" : "Anthropic"). " + (p.id == "google" ? "The free tier has daily limits (each question takes a few), and on it Google may use what you send to improve its products. With billing on, questions are billed to you." : "Each question is billed to your account."))
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if chosen == "rules" {
                let chat = s.answers?.components(separatedBy: ";").first ?? WHO[s.provider] ?? "your AI"
                Text(!s.canAnswer ? "Nothing to set up: Tartan's rules write your plan from your targets and recent weeks. To talk with the coach, choose an AI above."
                     : s.planner == "rules" ? "Tartan's rules write your plan. The chat still answers with \(chat)." : "Tartan's rules can write your plan instead of an AI. The chat stays with \(chat).")
                    .font(.subheadline).foregroundStyle(.secondary)
                if s.canAnswer && s.planner != "rules" {
                    Button("Plan by Tartan's rules") { Task { await m.planner("rules") } }.buttonStyle(.glass)
                }
            }
            let ready = p.id == s.provider || p.keySource != nil || !key.isEmpty
            let changed = p.id != s.provider || current != p.model || !key.isEmpty
            if picked && p.id != s.provider && !ready {
                Text("Not in use yet: the coach stays on \(s.providers.first { $0.id == s.provider }?.label ?? "what it uses now") until this one can answer.")
                    .font(.footnote).foregroundStyle(.secondary)
            } else if let saved = m.saved, !changed {
                Label("Saved. \(saved)", systemImage: "checkmark").font(.footnote).foregroundStyle(.secondary)
            }
            DisclosureGroup("More options", isExpanded: $more) {
                VStack(alignment: .leading, spacing: 12) {
                    if p.id == "google" || p.id == "anthropic" {
                        Picker("\(WHO[p.id] ?? p.label) model", selection: Binding(get: { typing ? OTHER : current }, set: { v in
                            if v == OTHER { typing = true } else { typing = false; model = v }
                        })) {
                            ForEach(list) { c in Text(c.label + (c.note.map { " · \($0)" } ?? "")).tag(c.id) }
                            Text("Other: type a model name").tag(OTHER)
                        }
                        if typing {
                            let prefix = p.id == "google" ? "gemini-" : "claude-"
                            TextField("Model name", text: Binding(get: { typed }, set: { t in
                                typed = t
                                // As the provider writes it: "models/Gemini-3.9-Pro " reads as gemini-3.9-pro.
                                var id = t.trimmingCharacters(in: .whitespaces).lowercased()
                                if id.hasPrefix("models/") { id = String(id.dropFirst(7)) }
                                if id.range(of: "^\(prefix)[a-z0-9.-]{2,60}$", options: .regularExpression) != nil { model = id }
                            }), prompt: Text(p.id == "google" ? "gemini-3.8-flash" : "claude-sonnet-5-5"))
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            Text("Model names start with \(prefix) and use letters, numbers, dots and dashes.").font(.footnote).foregroundStyle(.secondary)
                        }
                        Button { Task { await m.loadModels(p.id, current, key) } } label: {
                            Label("Load the latest models (needs the key)", systemImage: "arrow.triangle.2.circlepath")
                        }
                        .disabled(m.busy == "models")
                    }
                    Picker("Plans and weekly reviews", selection: Binding(get: { s.planner }, set: { v in Task { await m.planner(v) } })) {
                        Text("Automatic (now: \(s.plannerModel ?? WHO[s.plannerUses] ?? s.plannerUses))").tag("auto")
                        Text("Gemini, with your key").tag("google")
                        Text("Claude, with your key").tag("anthropic")
                        Text("Tartan's rules").tag("rules")
                    }
                    Text(s.planner != "rules" && s.plannerUses == "rules"
                         ? "No \(s.planner == "auto" ? "cloud" : WHO[s.planner] ?? s.planner) key yet, so Tartan's rules write the plan and the coach explains it. Add a Gemini key (its free tier is plenty for a few plans a week) to have it written for you."
                         : s.planner == "rules" ? "Tartan's rules write the plan from your targets and recent weeks, and the coach explains it."
                         : "\(s.plannerModel ?? WHO[s.plannerUses] ?? s.plannerUses) writes your plan, changes it when you ask, and reviews each week. Everyday questions stay with the coach.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                .padding(.top, 8)
            }
            .font(.subheadline.weight(.semibold))
            Toggle(isOn: Binding(get: { s.photos }, set: { v in Task { await m.flag("photos", v) } })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Photos in the chat")
                    Text("Send a photo with a question.").font(.footnote).foregroundStyle(.secondary)
                }
            }
            Toggle(isOn: Binding(get: { s.voice }, set: { v in Task { await m.flag("voice", v) } })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Speak to the coach")
                    Text("Say your message instead of typing it.").font(.footnote).foregroundStyle(.secondary)
                }
            }
            Text("Training guidance, not medical advice. AI can be wrong: for pain, illness or anything that worries you, see a doctor.")
                .font(.caption).foregroundStyle(.secondary)
        }
        // Saved as it changes: a provider when it can answer (a key, or one already saved), so
        // looking through the choices doesn't leave the coach without one; a key or a model a
        // moment after the last keystroke.
        .task(id: "\(p.id)|\(current)|\(key)") {
            let ready = p.id == s.provider || p.keySource != nil || !key.isEmpty
            let changed = p.id != s.provider || current != p.model || !key.isEmpty
            guard picked, changed, ready else { return }
            try? await Task.sleep(for: .milliseconds(key.isEmpty ? 300 : 1200))
            guard !Task.isCancelled else { return }
            if await m.save(p.id, current, label, key) { key = ""; model = "" }
        }
        .onChange(of: chosen) { _, _ in model = ""; key = ""; typing = false; typed = "" }
    }

    private func choiceRow(_ id: String, _ title: String, _ sub: String, _ chosen: String) -> some View {
        let on = id == chosen
        return Button {
            Haptics.feel("detent")
            withAnimation(.smooth) { choice = id }
        } label: {
            HStack(spacing: 14) {
                Image(systemName: on ? "checkmark.circle.fill" : "circle").font(.title3).foregroundStyle(on ? Brand.tint : Color.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.subheadline.weight(.semibold))
                    Text(sub).font(.footnote).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14).padding(.vertical, 12)
            .background(on ? Brand.container : Brand.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(Press())
        .foregroundStyle(Color.primary)
        .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
    }

    @ViewBuilder private var keyCheck: some View {
        if m.busy == "check" {
            HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Checking the key…") }.font(.footnote).foregroundStyle(.secondary)
        }
        if let k = m.keyCheck {
            Label(k.line, systemImage: k.ok ? "checkmark" : "exclamationmark.triangle")
                .font(.footnote).foregroundStyle(k.ok ? Brand.good : Color.red)
        }
    }
}

/// What answers now, in a sentence, and who writes the plan.
private struct CoachNow: View {
    let s: CoachSetup

    var body: some View {
        let parts = s.answers?.components(separatedBy: ";") ?? []
        let chat = parts.first?.trimmingCharacters(in: .whitespaces) ?? s.providers.first { $0.id == s.provider }?.label
        var offline = parts.count > 1 ? parts[1].trimmingCharacters(in: .whitespaces) : ""
        if offline.hasPrefix("offline,") { offline = String(offline.dropFirst(8)).trimmingCharacters(in: .whitespaces) }
        let plans = s.plannerUses == "rules" ? "Tartan's rules write your plan." : "\(s.plannerModel ?? WHO[s.plannerUses] ?? s.plannerUses) writes your plan and reviews each week."
        let answers = s.canAnswer && chat != nil
        return HStack(alignment: .top, spacing: 12) {
            Image(systemName: answers ? "checkmark" : "info.circle").font(.headline).foregroundStyle(Brand.onContainer)
            VStack(alignment: .leading, spacing: 4) {
                Text(answers ? "\(chat!) answers you" : "No AI set up yet").font(.headline)
                Text(answers ? ([offline.isEmpty ? nil : "Offline: \(offline).", plans].compactMap { $0 }.joined(separator: " ")) : "Tartan's rules write your plan. Choose an AI below to talk with the coach.")
                    .font(.subheadline)
            }
            .foregroundStyle(Brand.onContainer)
            Spacer(minLength: 0)
        }
        .padding(16)
        .background(Brand.container, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
}

/// Getting a key, step by step: where, what to tap, and that Tartan checks it as soon as it's in.
private struct KeySteps: View {
    let google: Bool
    let open: (String) -> Void

    var body: some View {
        let steps = google
            ? ["Open Google AI Studio and sign in with your Google account. It's free, with no card.", "Tap Create API key (any project will do), then copy the key.", "Paste it below. Tartan checks it with Google straight away."]
            : ["Open the Anthropic Console and sign in (Claude is paid by use: add a little credit under Billing).", "Under API keys, tap Create Key, then copy it.", "Paste it below. Tartan checks it with Anthropic straight away."]
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(steps.enumerated()), id: \.offset) { i, t in
                HStack(alignment: .top, spacing: 10) {
                    Text("\(i + 1)").font(.caption.weight(.bold)).foregroundStyle(Brand.container)
                        .frame(width: 24, height: 24).background(Brand.onContainer, in: Circle())
                    Text(t).font(.subheadline)
                }
            }
            Button(google ? "Open Google AI Studio" : "Open the Anthropic Console") {
                open(google ? "https://aistudio.google.com/apikey" : "https://console.anthropic.com/settings/keys")
            }
            .buttonStyle(.glass)
        }
        .foregroundStyle(Brand.onContainer)
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Brand.container, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
}
