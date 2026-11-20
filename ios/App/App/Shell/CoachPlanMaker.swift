import SwiftUI
import Observation

/**
 * The first plan (Android's PlanMaker, web/views/plan.ts make, makeBasic): the answers saved, then
 * the coach plans out loud (its steps, then a few sentences) and the plan appears; without an AI
 * key, a plan by Tartan's own rules (src/basic-plan.ts).
 */
@MainActor
@Observable
final class PlanMaker {
    @ObservationIgnored weak var coach: CoachModel?
    @ObservationIgnored weak var shell: ShellModel?
    private let engine: EngineBridge
    var running = false
    /** The coach's steps as they go: what, and whether it's done. */
    var steps: [(label: String, done: Bool)] = []
    var text = ""
    var conversation: String?
    /** How it ended: "saved", "proposed", "none"; nil while it hasn't. */
    var outcome: String?
    var error: String?

    init(engine: EngineBridge) { self.engine = engine }

    var shown: Bool { running || outcome != nil }

    /** Back to the questions (after it couldn't plan). */
    func reset() {
        guard !running else { return }
        outcome = nil; error = nil; text = ""; steps = []
    }

    func make(target: String?, availability: [String: Any], ai: Bool) {
        guard !running else { return }
        running = true; steps = []; text = ""; outcome = nil; error = nil; conversation = nil
        Task {
            defer { running = false }
            let r = await engine.call("/api/plan/availability", method: "PUT", body: jsonText(availability))
            guard (200..<300).contains(r.status) else { error = "Couldn't save your answers (\(r.status))."; outcome = "none"; return }
            var args: [String: Any] = [:]
            if let target { args["target"] = target }
            if !ai {
                let b = await engine.call("/api/plan/basic", method: "POST", body: jsonText(args))
                guard (200..<300).contains(b.status) else {
                    error = J(json: b.body)["error"].str.flatMap { $0.isEmpty ? nil : $0 } ?? "Couldn't make the plan (\(b.status))."
                    outcome = "none"
                    return
                }
                outcome = "saved"
                await made("Your plan is ready.")
                return
            }
            var saved = false
            var proposed = 0
            let status = await engine.call("/api/plan/update", method: "POST", body: jsonText(args)) { [weak self] line in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    let m = J(json: line)
                    switch m["type"].text {
                    case "conversation": self.conversation = m["id"].str
                    case "tool":
                        for i in self.steps.indices { self.steps[i].done = true }
                        self.steps.append((label: m["label"].text, done: false))
                    case "plan": if let n = m["proposed"].int, n > 0 { proposed = n } else { saved = true }
                    case "text": self.text += m["delta"].text
                    case "error": self.error = m["message"].str
                    default: break
                    }
                }
            }.status
            for i in steps.indices { steps[i].done = true }
            if !(200..<300).contains(status) && error == nil { error = "The coach couldn't plan just now (\(status))." }
            outcome = saved ? "saved" : proposed > 0 ? "proposed" : "none"
            if saved { await made("Your plan is ready.") }
            else if proposed > 0 { await made("Your coach suggests \(proposed) change\(proposed == 1 ? "" : "s"): accept them or not below.") }
        }
    }

    private func made(_ said: String) async {
        shell?.say(said)
        Haptics.feel("confirm")
        coach?.stale = true
        await coach?.fetch()
        Launch.ready("planmade")
    }
}

private let DAYS3 = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

/**
 * Coach with no plan yet (Android's NoPlan), in one order: what Tartan already knows, then one
 * question at a time, then Make my plan; while the coach plans, that takes the questions' place.
 * Without an AI key the plan comes from Tartan's own rules, and the AI's setup waits folded below.
 */
struct NoPlanView: View {
    let shell: ShellModel
    let coach: Coach
    let maker: PlanMaker
    @State private var aiOpen = false

    var body: some View {
        if let a = coach.intake {
            VStack(alignment: .leading, spacing: 6) {
                Text("Let's make your plan").font(.title2.weight(.bold))
                Text(knows(a)).font(.body)
            }
            .foregroundStyle(Brand.onContainer)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(20)
            .background(Brand.container, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
            if maker.shown {
                Live(shell: shell, m: maker)
                if !maker.running && maker.outcome == "none" {
                    Button { withAnimation(.smooth) { maker.reset() } } label: { Text("Back to the questions").frame(maxWidth: .infinity) }
                        .buttonStyle(.glass)
                }
            } else {
                Questions(a: a, ai: coach.ready, maker: maker)
            }
            if !coach.ready && !maker.running {
                Button { withAnimation(.smooth) { aiOpen.toggle() } } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "ellipsis.bubble").font(.title3).foregroundStyle(Brand.tint)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Want a coach to talk to?").font(.subheadline.weight(.semibold))
                            Text("Add your own AI key: it plans for you, explains, and changes the plan when you ask.").font(.footnote).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 4)
                        Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.secondary).rotationEffect(.degrees(aiOpen ? 90 : 0))
                    }
                    .padding(16)
                    .background(Brand.card, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
                    .contentShape(Rectangle())
                }
                .buttonStyle(Press())
                .foregroundStyle(Color.primary)
                if aiOpen {
                    CoachSetupCard(m: shell.coachSetup, shell: shell)
                        .padding(16)
                        .background(Brand.card, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
                        .onDisappear { Task { await shell.coach.fetch() } }
                }
            }
        }
    }

    private func knows(_ a: Intake) -> String {
        var parts: [String] = []
        if a.runs > 0 {
            parts.append("Over the last four weeks you ran \(km1(a.kmWeek)) km a week across \(a.runs) run\(a.runs == 1 ? "" : "s"), the longest \(km1(a.longest)) km.")
        } else if a.workouts > 0 {
            parts.append("You've trained about \(km1(a.hoursWeek)) hours a week lately, without runs.")
        } else {
            parts.append("No workouts from the last four weeks yet, so the plan starts gently.")
        }
        if let d = a.raceDate {
            parts.append("Your \(a.raceName ?? "\(one(a.raceKm ?? 0)) km race") is on \(dateShort(d)).")
        }
        return parts.joined(separator: " ")
    }
}

/// The coach planning: its steps as they go, what it says, the way into the conversation.
private struct Live: View {
    let shell: ShellModel
    let m: PlanMaker

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                if m.running { ProgressView() } else { Image(systemName: "ellipsis.bubble").font(.headline) }
                Text(m.running ? "Your coach is planning" : m.outcome == "none" ? "No plan yet" : "Your coach").font(.headline)
            }
            if !m.steps.isEmpty {
                Flow(spacing: 6) {
                    ForEach(Array(m.steps.enumerated()), id: \.offset) { _, s in
                        HStack(spacing: 6) {
                            if s.done { Image(systemName: "checkmark").font(.caption.weight(.bold)).foregroundStyle(Brand.tint) } else { ProgressView().controlSize(.mini) }
                            Text(s.label).font(.caption.weight(.medium))
                        }
                        .padding(.horizontal, 10).padding(.vertical, 6)
                        .background(Brand.card.opacity(0.7), in: Capsule())
                    }
                }
            }
            if !m.text.isEmpty {
                Text((try? AttributedString(markdown: m.text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(m.text))
            } else if m.outcome == "none" {
                Text(m.error ?? "No answer from the coach. Try again in a moment.")
            }
            if let c = m.conversation, !m.running {
                Button { shell.goAction("chat", extra: ["conversation": c]) } label: { Label("Talk it through with your coach", systemImage: "ellipsis.bubble") }
                    .buttonStyle(.glass)
            }
        }
        .foregroundStyle(Brand.onContainer)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
        .background(Brand.container, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
        .animation(.smooth, value: m.text)
    }
}

/// One question at a time: days, hours, the long run's day, then a date and Make my plan.
private struct Questions: View {
    let a: Intake
    let ai: Bool
    let maker: PlanMaker
    @State private var step = 0
    @State private var forward = true
    @State private var days = ""
    @State private var hours = ""
    @State private var long = ""
    @State private var target = ""
    @State private var notes = ""
    @State private var filled = false
    private let last = 3

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 10) {
                Text("\(step + 1) of \(last + 1)").font(.subheadline.weight(.medium)).foregroundStyle(.secondary).frame(width: 52, alignment: .leading)
                HStack(spacing: 4) {
                    ForEach(0...last, id: \.self) { i in Capsule().fill(i <= step ? Brand.tint : Brand.well).frame(height: 4) }
                }
            }
            Group {
                switch step {
                case 0: ask("How many days a week can you train?", [("", "Not sure")] + (2...7).map { ("\($0)", "\($0)") }, days) { days = $0 }
                case 1: ask("About how many hours a week?", [("", "Not sure")] + [2, 3, 4, 5, 6, 8, 10].map { ("\($0)", "\($0) h") }, hours) { hours = $0 }
                case 2: ask("Which day suits the long run?", [("", "Any day")] + DAYS3.map { ($0, $0) }, long) { long = $0 }
                default: last3
                }
            }
            .id(step)
            .transition(.asymmetric(insertion: .move(edge: forward ? .trailing : .leading).combined(with: .opacity), removal: .opacity))
            if step > 0 {
                Button { go(step - 1) } label: { Label("Back", systemImage: "chevron.left") }.font(.subheadline.weight(.semibold))
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Brand.card, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
        .clipped()
        .onAppear {
            guard !filled else { return }
            filled = true
            days = a.days.map(String.init) ?? ""
            hours = a.hours.map(String.init) ?? ""
            long = a.longDay ?? ""
            target = a.raceDate.map(dateShort) ?? ""
            notes = a.notes
            if Launch.makePlan { go(last) }
        }
    }

    private func go(_ to: Int) {
        forward = to > step
        withAnimation(.smooth(duration: 0.3)) { step = min(max(to, 0), last) }
    }

    /** A tap answers and moves on, after a beat to see it chosen. */
    private func ask(_ title: String, _ options: [(String, String)], _ now: String, _ pick: @escaping (String) -> Void) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title).font(.title3.weight(.semibold))
            Flow(spacing: 8) {
                ForEach(Array(options.enumerated()), id: \.offset) { _, o in
                    let on = now == o.0
                    Button {
                        Haptics.feel("click")
                        pick(o.0)
                        Task {
                            try? await Task.sleep(for: .milliseconds(220))
                            go(step + 1)
                        }
                    } label: {
                        HStack(spacing: 6) {
                            if on { Image(systemName: "checkmark").font(.footnote.weight(.bold)) }
                            Text(o.1).font(.headline)
                        }
                        .foregroundStyle(on ? Brand.onContainer : Color.primary)
                        .padding(.horizontal, 16).padding(.vertical, 12)
                        .background(on ? Brand.container : Brand.well, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    }
                    .buttonStyle(Press())
                    .accessibilityAddTraits(on ? .isSelected : [])
                }
            }
        }
    }

    private var last3: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Building to a date?").font(.title3.weight(.semibold))
            VStack(alignment: .leading, spacing: 4) {
                Text(a.raceDate != nil ? "Your race day (clear it for 8 weeks)" : "Optional: leave it empty for 8 weeks").font(.footnote).foregroundStyle(.secondary)
                TextField("e.g. 14 March, end of June", text: Binding(get: { target }, set: { target = String($0.prefix(80)) }))
                    .padding(.horizontal, 14).frame(height: 46)
                    .background(Brand.well, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            if ai {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Anything else your coach should know?").font(.footnote).foregroundStyle(.secondary)
                    TextField("Injuries, no running on Thursdays…", text: Binding(get: { notes }, set: { notes = String($0.prefix(300)) }), axis: .vertical)
                        .lineLimit(1...4)
                        .padding(.horizontal, 14).padding(.vertical, 12)
                        .background(Brand.well, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
            }
            Text(ai ? "Your coach plans around these, and you can change anything later by asking."
                 : "Tartan plans by its own rules: about 10% more a week, every fourth week easier, mostly easy running, a taper before a race.")
                .font(.footnote).foregroundStyle(.secondary)
            Primary(label: "Make my plan") { make() }
                .overlay(alignment: .leading) { Image(systemName: "sparkles").foregroundStyle(Brand.onTint).padding(.leading, 18).allowsHitTesting(false) }
        }
    }

    private func make() {
        Haptics.feel("confirm")
        var avail: [String: Any] = [:]
        if let d = Int(days) { avail["days_per_week"] = d }
        if let h = Int(hours) { avail["hours_per_week"] = h }
        if !long.isEmpty { avail["long_run_day"] = long }
        let n = notes.trimmingCharacters(in: .whitespacesAndNewlines)
        if ai && !n.isEmpty { avail["notes"] = n }
        // The race's own date when it's the one shown, as the page sends it.
        let t = target.trimmingCharacters(in: .whitespaces)
        let sent: String? = t.isEmpty ? nil : (a.raceDate.map { t == dateShort($0) ? $0 : t } ?? t)
        maker.make(target: sent, availability: avail, ai: ai)
    }
}
