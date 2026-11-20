import SwiftUI
import Observation

/// One set as logged.
struct LiftSet: Equatable { var done: Bool; var reps: Int?; var seconds: Int?; var kg: Double? }

/// What the next step is for an exercise (src/strength/log.ts Target).
struct LiftTarget { let name: String; let loaded: Bool; let rule: String; let why: String; let last: String?; let restS: Int }

/// One exercise in the log: its dose, its sets, and how many reps were left after the last.
struct LiftEx: Identifiable {
    let id: String
    var target: [String: Any]
    var sets: [LiftSet]
    var rir: Int?
    var timed: Bool { target["seconds"] != nil && target["reps"] == nil }
    var allDone: Bool { !sets.isEmpty && sets.allSatisfy(\.done) }
}

/// The finished session (src/strength/log.ts Summary).
struct LiftSummary { let minutes: Int; let sets: Int; let volume: Int; let prs: [(name: String, text: String, before: String)]; let next: [(name: String, last: String, next: String, why: String)] }

private let RULE = ["start": "First time", "add": "More weight", "more reps": "A rep more", "longer": "Longer", "hold": "Same again", "ease": "Lighter"]

private func kgText(_ x: Double) -> String { x == x.rounded() ? "\(Int(x)) kg" : String(format: "%.1f kg", x) }

/** "3 × 10 at 40 kg" for a target. */
func doseOf(_ t: [String: Any]) -> String {
    let j = J(t)
    var s = "\(j["sets"].int ?? 0) × " + (j.has("reps") ? "\(j["reps"].int ?? 0)" : "\(j["seconds"].int ?? 0) s")
    if j["each_side"].bool { s += " each side" }
    if let kg = j["kg"].num { s += " at \(kgText(kg))" }
    return s
}

/// #lift/<date> (web/views/lift.ts): a strength session as you lift it. Each exercise with its
/// sets filled in from last time and the next step with why; tick a set and the rest counts down
/// (a notification when it's over, the screen may be off); how many reps were left; Finish:
/// records, next time.
@MainActor
@Observable
final class LiftModel {
    let engine: EngineBridge
    let date: String
    @ObservationIgnored weak var shell: ShellModel?
    var title = ""
    var isToday = false
    var exercises: [LiftEx] = []
    var targets: [String: LiftTarget] = [:]
    var started: String?
    var finishedAt: String?
    var open: Int? = 0
    var loaded = false
    var summary: LiftSummary?
    var fromWatch: (line: String, sets: [(id: String, done: Int)])?
    var busy = false
    var catalog: [String: Routine.Exercise] = [:]
    var works: [String: ([String], [String])] = [:]
    var thumbs: [String: UIImage] = [:]
    // The rest between sets.
    var restEnd: Date?
    var restFor = 0
    var restNext = ""
    var restGo = false
    @ObservationIgnored private var saving: Task<Void, Never>?

    var doneCount: Int { exercises.filter(\.allDone).count }

    init(engine: EngineBridge, date: String) {
        self.engine = engine
        self.date = date
    }

    func load() async {
        guard let j = await engine.get("/api/lifts/session?date=\(date)") else { shell?.say("Couldn't open this session."); return }
        let s = J(json: j)
        title = s["title"].text
        isToday = s["date"].text == isoDay(Date())
        let ts = s["targets"].array
        for t in ts {
            let l = t["last"]
            targets[t["id"].text] = LiftTarget(name: t["name"].text, loaded: t["loaded"].bool, rule: t["rule"].text, why: t["why"].text,
                                               last: l.object != nil ? "\(l["text"].text) · \(dateShort(l["date"].text))" : nil, restS: t["rest_s"].int ?? 90)
        }
        let log = s["log"]
        if log.object != nil {
            started = log["started"].str
            finishedAt = log["finished"].str
            exercises = log["exercises"].array.map { e in
                LiftEx(id: e["id"].text, target: e["target"].object ?? [:],
                       sets: e["sets"].array.map { x in LiftSet(done: x["done"].bool, reps: x["reps"].int, seconds: x["seconds"].int, kg: x["kg"].num) }, rir: e["rir"].int)
            }
        } else {
            exercises = ts.map { t in
                var target: [String: Any] = ["sets": t["sets"].int ?? 0]
                if let r = t["reps"].int { target["reps"] = r }
                if let sec = t["seconds"].int { target["seconds"] = sec }
                if let kg = t["kg"].num { target["kg"] = kg }
                if t["each_side"].bool { target["each_side"] = true }
                let set = LiftSet(done: false, reps: t["reps"].int, seconds: t.has("reps") ? nil : t["seconds"].int, kg: t["kg"].num)
                return LiftEx(id: t["id"].text, target: target, sets: Array(repeating: set, count: t["sets"].int ?? 0), rir: nil)
            }
        }
        open = exercises.firstIndex { $0.sets.contains { !$0.done } } ?? 0
        loaded = true
        Launch.ready("lift")
        // Done on the watch as a guided workout: offered to tick in one go.
        if finishedAt == nil, !exercises.contains(where: { $0.sets.contains(where: \.done) }), let w = await engine.get("/api/lifts/from-watch?date=\(date)"), w != "null" {
            let o = J(json: w)
            let sets = o["sets"].array.map { (id: $0["id"].text, done: $0["done"].int ?? 0) }
            let total = sets.reduce(0) { n, x in n + min(x.done, exercises.first { $0.id == x.id }?.sets.count ?? 0) }
            if total > 0 {
                fromWatch = (line: "\(o["activity"]["name"].text), \(o["activity"]["minutes"].int ?? 0) min: its laps account for \(total) set\(total == 1 ? "" : "s").", sets: sets)
            }
        }
        if case .success(let e) = await engine.rpc("exercises") {
            for it in J(json: e)["items"].array {
                catalog[it["id"].text] = Routine.Exercise(id: it["id"].text, name: it["name"].text, kind: it["kind"].text, equipment: it["equipment"].str, dose: it["dose"].text, cues: it["cues"].strings, why: it["why"].text)
                works[it["id"].text] = (it["primary"].strings, it["secondary"].strings)
            }
        }
        for e in exercises {
            let w = works[e.id] ?? ([], [])
            if let f = await BodyFrames.get(engine, ["exercise": e.id, "primary": w.0, "secondary": w.1, "width": 144, "height": 120, "loop": 1]), let img = f.loop.first { thumbs[e.id] = img }
        }
    }

    private func logJson() -> [String: Any] {
        var o: [String: Any] = ["date": date, "title": title, "started": started ?? ""]
        if let f = finishedAt { o["finished"] = f }
        o["exercises"] = exercises.map { e -> [String: Any] in
            var x: [String: Any] = ["id": e.id, "target": e.target, "sets": e.sets.map { s -> [String: Any] in
                var d: [String: Any] = ["done": s.done]
                if let r = s.reps { d["reps"] = r }
                if let sec = s.seconds { d["seconds"] = sec }
                if let kg = s.kg { d["kg"] = kg }
                return d
            }]
            if let r = e.rir { x["rir"] = r }
            return x
        }
        return o
    }

    /** Saved as you go (after the first ticked set), so closing the app loses nothing. */
    func save() {
        guard started != nil else { return }
        saving?.cancel()
        let body = jsonText(logJson())
        saving = Task {
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled else { return }
            _ = await engine.call("/api/lifts", method: "PUT", body: body)
        }
    }

    func tick(_ i: Int, _ k: Int) {
        let was = exercises[i].sets[k].done
        exercises[i].sets[k].done.toggle()
        if !was {
            if started == nil { started = ISO8601DateFormatter().string(from: Date()) }
            // Rest before the next set (or the next exercise), not after the very last.
            let e = exercises[i]
            let label: String
            if let nextSet = e.sets.firstIndex(where: { !$0.done }) { label = "Then set \(nextSet + 1)" }
            else if let nx = exercises.indices.first(where: { $0 > i && exercises[$0].sets.contains { !$0.done } }) { label = "Then \((targets[exercises[nx].id]?.name ?? exercises[nx].id).lowercased())" }
            else { label = "" }
            if label.isEmpty { stopRest() } else { rest(targets[e.id]?.restS ?? 90, label) }
        }
        save()
    }

    func setValue(_ i: Int, _ k: Int, kg: Double? = nil, reps: Int? = nil, seconds: Int? = nil) {
        if let kg { exercises[i].sets[k].kg = kg }
        if let reps { exercises[i].sets[k].reps = reps }
        if let seconds { exercises[i].sets[k].seconds = seconds }
        save()
    }

    func addSet(_ i: Int) {
        let l = exercises[i].sets.last
        exercises[i].sets.append(LiftSet(done: false, reps: l?.reps, seconds: l?.seconds, kg: l?.kg))
    }

    func setRir(_ i: Int, _ v: Int) {
        exercises[i].rir = v
        save()
        if let n = exercises.firstIndex(where: { $0.sets.contains { !$0.done } }) { open = n }
    }

    func rest(_ seconds: Int, _ next: String) {
        restFor = seconds
        restEnd = Date().addingTimeInterval(Double(seconds))
        restNext = next
        restGo = false
        note()
    }

    func shiftRest(_ d: Int) {
        guard let e = restEnd else { return }
        restEnd = e.addingTimeInterval(Double(d))
        restFor = max(1, restFor + d)
        note()
    }

    func stopRest() {
        restEnd = nil
        restGo = false
        Task { _ = await engine.rpc("restNote") }
    }

    /** A notification when the rest is over (the screen may be off), through the page's plugin. */
    private func note() {
        guard let e = restEnd else { return }
        let at = Int(e.timeIntervalSince1970 * 1000), next = restNext
        Task { _ = await engine.rpc("restNote", ["at": at, "next": next]) }
    }

    func tickFromWatch() {
        guard let w = fromWatch else { return }
        for (id, n) in w.sets {
            guard let i = exercises.firstIndex(where: { $0.id == id }) else { continue }
            for k in 0..<min(n, exercises[i].sets.count) { exercises[i].sets[k].done = true }
        }
        if started == nil { started = ISO8601DateFormatter().string(from: Date()) }
        open = exercises.firstIndex { $0.sets.contains { !$0.done } } ?? 0
        fromWatch = nil
        save()
    }

    /** Finish: the plan's session ticks off; the summary with records and next time. */
    func finish() async -> Bool {
        stopRest()
        if finishedAt == nil { finishedAt = ISO8601DateFormatter().string(from: Date()) }
        busy = true
        saving?.cancel()
        let r = await engine.call("/api/lifts", method: "PUT", body: jsonText(logJson()))
        busy = false
        let o = J(json: r.body)
        let s = o["summary"]
        guard s.object != nil else { shell?.say("Not saved: \(o["error"].str ?? "\(r.status)")"); return false }
        summary = LiftSummary(minutes: s["minutes"].int ?? 0, sets: s["sets"].int ?? 0, volume: s["volume_kg"].int ?? 0,
                              prs: s["prs"].array.map { (name: $0["name"].text, text: $0["text"].text, before: $0["before"].text) },
                              next: s["next"].array.map { (name: $0["name"].text, last: $0["last"].text, next: $0["next"].text, why: $0["why"].text) })
        shell?.changed()
        return true
    }
}

/// Lift, native on iPhone (Android's LiftScreen.kt): a strength session set by set, the rest
/// running down under the thumb, Finish with records and next time.
struct LiftScreen: View {
    let shell: ShellModel
    let m: LiftModel
    @State private var how: Routine.Exercise?
    @State private var armed = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    Text("\(m.isToday ? "Today" : dateShort(m.date)) · \(m.doneCount) of \(m.exercises.count) done")
                        .font(.subheadline.weight(.medium)).foregroundStyle(.secondary).padding(.horizontal, 4)
                    if !m.loaded {
                        ProgressView().controlSize(.large).frame(maxWidth: .infinity, minHeight: 240)
                    } else {
                        if let w = m.fromWatch {
                            Card(fill: Brand.container) {
                                Label("Done on your watch", systemImage: "watch.analog").font(.headline)
                                Text(w.line).font(.subheadline)
                                Text("The watch doesn't count reps, so they're the planned ones; change any you did differently. Read from the laps, which is new: check they look right.").font(.caption)
                                HStack {
                                    Button("Tick the sets") { m.tickFromWatch() }.buttonStyle(.glassProminent)
                                    Button("Not now") { m.fromWatch = nil }.buttonStyle(.glass)
                                }
                            }
                            .foregroundStyle(Brand.onContainer)
                        }
                        ForEach(Array(m.exercises.enumerated()), id: \.element.id) { i, e in
                            ExerciseCard(m: m, i: i, e: e) { how = $0 }
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 16)
            }
            .background(Brand.ground)
            .scrollDismissesKeyboard(.interactively)
            .safeAreaInset(edge: .bottom, spacing: 0) { bottom }
            .navigationTitle(m.title.isEmpty ? "Strength" : m.title)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { shell.go("today") } label: { Image(systemName: "chevron.left") }.accessibilityLabel("Back to Today")
                }
            }
            .sheet(item: $how) { e in ExerciseDetail(e: e, engine: m.engine, primary: m.works[e.id]?.0 ?? [], secondary: m.works[e.id]?.1 ?? []) }
            .sheet(isPresented: Binding(get: { m.summary != nil }, set: { if !$0 { m.summary = nil; shell.go("today") } })) {
                if let s = m.summary { LiftDone(s: s, title: m.title) }
            }
            .task { if !m.loaded { await m.load() } }
            .task(id: armed) {
                guard armed else { return }
                try? await Task.sleep(for: .seconds(6))
                armed = false
            }
        }
    }

    /** The rest, and Finish, under the thumb. */
    private var bottom: some View {
        VStack(spacing: 8) {
            RestBar(m: m)
            if armed {
                let left = m.exercises.count - m.doneCount
                Text(left == 1 ? "1 exercise isn't done. Tap again to finish anyway; it counts as skipped." : "\(left) exercises aren't done. Tap again to finish anyway; they count as skipped.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            Button {
                if !m.exercises.contains(where: { $0.sets.contains(where: \.done) }) { shell.go("today"); return }
                let left = m.exercises.count - m.doneCount
                if left > 0 && m.finishedAt == nil && !armed { armed = true; return }
                armed = false
                Task { _ = await m.finish() }
            } label: {
                Label(armed ? "Finish with \(m.exercises.count - m.doneCount) left" : m.finishedAt != nil ? "Save" : "Finish", systemImage: "checkmark")
                    .font(.headline).frame(maxWidth: .infinity, minHeight: 40)
            }
            .buttonStyle(.glassProminent)
            .disabled(!m.loaded || m.busy)
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 8)
        .background {
            LinearGradient(stops: [.init(color: Brand.ground.opacity(0), location: 0), .init(color: Brand.ground.opacity(0.95), location: 0.25), .init(color: Brand.ground, location: 1)], startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea(edges: .bottom).allowsHitTesting(false)
        }
    }
}

/// One exercise: its head (the body in its pose, name, dose, sets done); open, the next step, the
/// sets to tick, how many were left.
private struct ExerciseCard: View {
    let m: LiftModel
    let i: Int
    let e: LiftEx
    let how: (Routine.Exercise) -> Void

    var body: some View {
        let t = m.targets[e.id]
        let isOpen = m.open == i
        let loaded = t?.loaded ?? e.sets.contains { $0.kg != nil }
        VStack(alignment: .leading, spacing: 8) {
            Button { withAnimation(.smooth) { m.open = isOpen ? nil : i } } label: {
                HStack(spacing: 12) {
                    Group {
                        if let img = m.thumbs[e.id] { Image(uiImage: img).resizable().scaledToFit() } else { Image(systemName: "dumbbell.fill").foregroundStyle(.tertiary) }
                    }
                    .frame(width: 64, height: 54)
                    .background(Brand.well, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(t?.name ?? m.catalog[e.id]?.name ?? e.id).font(.headline)
                        Text(doseOf(e.target)).font(.subheadline).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 4)
                    if e.allDone {
                        Image(systemName: "checkmark").font(.footnote.weight(.bold)).foregroundStyle(.white).frame(width: 30, height: 30).background(Brand.good, in: Circle())
                    } else {
                        Text("\(e.sets.filter(\.done).count)/\(e.sets.count)").font(.subheadline.weight(.semibold).monospacedDigit()).foregroundStyle(.secondary)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(Press())
            .foregroundStyle(Color.primary)
            if isOpen {
                if let t, m.finishedAt == nil {
                    Text("\(Text(RULE[t.rule] ?? t.rule).fontWeight(.bold).foregroundStyle(Brand.tint)) \(t.why)").font(.subheadline)
                }
                if let last = t?.last { Text("Last time \(last)").font(.caption).foregroundStyle(.secondary) }
                ForEach(Array(e.sets.enumerated()), id: \.offset) { k, s in
                    HStack(spacing: 8) {
                        Text("\(k + 1)").font(.headline).foregroundStyle(.secondary).frame(width: 22)
                        if loaded {
                            NumField(value: s.kg.map { $0 == $0.rounded() ? "\(Int($0))" : "\($0)" } ?? "", unit: "kg") { v in
                                if let x = Double(v.replacingOccurrences(of: ",", with: ".")) { m.setValue(i, k, kg: x) }
                            }
                        }
                        NumField(value: (e.timed ? s.seconds : s.reps).map { "\($0)" } ?? "", unit: e.timed ? "s" : "reps", decimal: false) { v in
                            if let x = Int(v) { if e.timed { m.setValue(i, k, seconds: x) } else { m.setValue(i, k, reps: x) } }
                        }
                        Spacer(minLength: 0)
                        Button { m.tick(i, k) } label: {
                            Image(systemName: "checkmark").font(.title3.weight(.bold))
                                .foregroundStyle(s.done ? Color.white : Color.secondary)
                                .frame(width: 48, height: 48)
                                .background(s.done ? Brand.good : Brand.well, in: Circle())
                        }
                        .buttonStyle(Press())
                        .sensoryFeedback(s.done ? .success : .selection, trigger: s.done)
                        .accessibilityLabel("Set \(k + 1) done")
                        .accessibilityAddTraits(s.done ? .isSelected : [])
                    }
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .background(s.done ? Brand.goodContainer : Brand.well.opacity(0.6), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
                HStack {
                    Button { m.addSet(i) } label: { Label("Add a set", systemImage: "plus") }.font(.subheadline.weight(.semibold))
                    Spacer()
                    if let c = m.catalog[e.id] { Button("How to do it") { how(c) }.font(.subheadline.weight(.semibold)) }
                }
                if e.allDone {
                    Text(e.timed ? "How much longer could you have held it?" : "How many more reps could you have done?").font(.subheadline)
                    Picker("Left", selection: Binding(get: { e.rir ?? -1 }, set: { m.setRir(i, $0) })) {
                        Text("0").tag(0); Text("1").tag(1); Text("2").tag(2); Text("3+").tag(3)
                    }
                    .pickerStyle(.segmented)
                }
            }
        }
        .padding(12)
        .background(e.allDone && !isOpen ? Brand.goodContainer.opacity(0.5) : Brand.card, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
    }
}

/// A number in a set: kg, reps or seconds, typed in place.
private struct NumField: View {
    let value: String
    let unit: String
    var decimal = true
    let put: (String) -> Void
    @State private var text = ""

    var body: some View {
        HStack(spacing: 4) {
            TextField("–", text: $text)
                .keyboardType(decimal ? .decimalPad : .numberPad)
                .multilineTextAlignment(.trailing)
                .font(.figure(.title3))
                .frame(width: 58, height: 44)
                .padding(.horizontal, 6)
                .background(Brand.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .onChange(of: text) { put(text) }
            Text(unit).font(.caption).foregroundStyle(.secondary)
        }
        .onAppear { text = value }
        .onChange(of: value) { if Double(text.replacingOccurrences(of: ",", with: ".")) != Double(value) { text = value } }
    }
}

/// The rest: the time running down, −15/+15, Skip; then Go.
private struct RestBar: View {
    let m: LiftModel

    var body: some View {
        if let end = m.restEnd {
            TimelineView(.periodic(from: .now, by: 0.25)) { ctx in
                let left = max(0, Int(end.timeIntervalSince(ctx.date).rounded(.up)))
                let go = left == 0
                HStack(spacing: 12) {
                    Text(go ? "Go" : "\(left / 60):\(String(format: "%02d", left % 60))").font(.system(size: 36, weight: .semibold, design: .rounded).monospacedDigit())
                    VStack(alignment: .leading, spacing: 1) {
                        if !go { Text("Rest").font(.caption).opacity(0.7) }
                        Text(go ? String(m.restNext.replacingOccurrences(of: "Then ", with: "").prefix(1).uppercased() + m.restNext.replacingOccurrences(of: "Then ", with: "").dropFirst()) : m.restNext).font(.subheadline.weight(.semibold))
                    }
                    Spacer(minLength: 4)
                    if !go {
                        Button("−15") { m.shiftRest(-15) }.font(.subheadline.weight(.semibold))
                        Button("+15") { m.shiftRest(15) }.font(.subheadline.weight(.semibold))
                        Button("Skip") { m.stopRest() }.font(.subheadline.weight(.semibold))
                    }
                }
                .padding(14)
                .foregroundStyle(go ? Color.primary : Color.white)
                .background(go ? Brand.goodContainer : Color(white: 0.16), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                .sensoryFeedback(.success, trigger: go)
                .task(id: go) {
                    guard go else { return }
                    try? await Task.sleep(for: .seconds(4))
                    if m.restEnd == end { m.restEnd = nil }
                }
            }
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }
}

/// Finished: how much, the records, and next time for each exercise.
private struct LiftDone: View {
    let s: LiftSummary
    let title: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        Tile(label: "Time", value: "\(s.minutes) min")
                        Tile(label: "Sets", value: "\(s.sets)")
                        if s.volume > 0 { Tile(label: "Lifted", value: "\(s.volume) kg") }
                    }
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }
                if !s.prs.isEmpty {
                    Section("Records") {
                        ForEach(Array(s.prs.enumerated()), id: \.offset) { _, p in
                            Label { VStack(alignment: .leading) { Text(p.name).font(.headline); Text("\(p.text), was \(p.before)").font(.caption).foregroundStyle(.secondary) } } icon: {
                                Image(systemName: "sparkles").foregroundStyle(Brand.good)
                            }
                        }
                    }
                }
                if !s.next.isEmpty {
                    Section {
                        ForEach(Array(s.next.enumerated()), id: \.offset) { _, n in
                            VStack(alignment: .leading, spacing: 2) {
                                Text("\(Text(n.name).fontWeight(.semibold))  \(n.last) → \(Text(n.next).fontWeight(.bold).foregroundStyle(Brand.tint))")
                                Text(n.why).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    } header: { Text("Next time") } footer: { Text("Next time's weights are on your watch with the session, once the week is sent.") }
                }
            }
            .navigationTitle(s.prs.isEmpty ? "Session done" : s.prs.count == 1 ? "A record today" : "\(s.prs.count) records today")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        .presentationDetents([.large])
    }
}
