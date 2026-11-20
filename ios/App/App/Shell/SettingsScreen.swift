import SwiftUI
import UniformTypeIdentifiers

/// Settings, native on iPhone (Android's SettingsScreen.kt and its groups): Sources, Training,
/// Coach, Watch and More as an inset grouped list, a group in the address (settings/coach). What
/// isn't native yet opens the page's whole group (settings/<group>/all): Strava's setup, the
/// coach's key, watch faces, backups, pairing a PC by code, agents.
struct SettingsScreen: View {
    let shell: ShellModel
    let m: SettingsModel

    static let groups = [("sources", "Sources"), ("training", "Training"), ("coach", "Coach"), ("watch", "Watch"), ("more", "More")]

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Picker("Group", selection: Binding(get: { shell.settingsGroup }, set: { shell.go("settings/\($0)") })) {
                        ForEach(Array(SettingsScreen.groups.enumerated()), id: \.offset) { _, g in Text(g.1).tag(g.0) }
                    }
                    .pickerStyle(.segmented)
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                switch shell.settingsGroup {
                case "training": TrainingGroup(shell: shell, m: m)
                case "coach": CoachGroup(shell: shell, m: m)
                case "watch": WatchGroup(shell: shell, m: m)
                case "more": MoreGroup(shell: shell, m: m)
                default: SourcesGroup(shell: shell, m: m)
                }
                Section {
                    Button { shell.go("settings/\(shell.settingsGroup)/all") } label: {
                        Label(allLabel, systemImage: "ellipsis.circle")
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Brand.ground)
            .scrollDismissesKeyboard(.interactively)
            .onScrollGeometryChange(for: CGFloat.self) { g in g.contentOffset.y + g.contentInsets.top } action: { old, new in shell.scrolled(by: new - old, at: new) }
            .safeAreaInset(edge: .bottom, spacing: 0) { BarSpace(on: shell.navOn && !shell.keyboardUp) }
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { shell.go("today") } label: { Image(systemName: "chevron.left") }.accessibilityLabel("Back to Today")
                }
            }
            .onAppear { m.ensure() }
        }
    }

    private var allLabel: String {
        switch shell.settingsGroup {
        case "sources": return "Strava's setup, Health and more sources"
        case "coach": return "Your coach's AI and its key"
        case "watch": return "Guided workouts, faces and routes"
        case "more": return "Backups, your PC, agents and the log"
        default: return "Shoes, training times and more"
        }
    }
}

// MARK: - Sources

private struct SourcesGroup: View {
    let shell: ShellModel
    let m: SettingsModel
    @State private var importing = false

    var body: some View {
        let strava = shell.board.first { $0.id == "strava" }
        let watch = shell.board.first { $0.id == "watch" }
        Section {
            if m.strava?["connected"].bool == true {
                LabeledContent("Strava", value: m.strava?["athlete"]["firstname"].str ?? "Connected")
                if let s = strava { Text(s.status).font(.footnote).foregroundStyle(s.failed ? Brand.watch : Color.secondary) }
                Button { shell.goAction("laneSync", extra: ["lane": "strava"]) } label: { Label("Sync Strava now", systemImage: "arrow.triangle.2.circlepath") }
            } else {
                Text("Strava brings in your whole history, from any watch.").font(.subheadline).foregroundStyle(.secondary)
                Button { shell.go("settings/sources/all") } label: { Label("Connect Strava", systemImage: "link") }
            }
        } header: { Text("Strava") }
        Section {
            if let w = watch {
                Text(w.status).font(.subheadline).foregroundStyle(w.failed ? Brand.watch : Color.secondary)
                Button { shell.goAction("laneSync", extra: ["lane": "watch"]) } label: { Label("Read the watch now", systemImage: "applewatch.radiowaves.left.and.right") }
            } else {
                Text("A Suunto watch, read over Bluetooth: no account, no cloud.").font(.subheadline).foregroundStyle(.secondary)
            }
            Button { shell.go("settings/sources/all") } label: { Label(watch == nil ? "Pair your watch" : "Manage the watch", systemImage: "watch.analog") }
        } header: { Text("Watch") }
        Section {
            Button { importing = true } label: { Label("Add a workout file (.fit)", systemImage: "doc.badge.plus") }
                .disabled(m.busy != nil)
        } header: { Text("Files") } footer: { Text("From another watch or app: it joins your workouts once, even when Strava has it too.") }
        Section {
            if let pc = m.pc {
                LabeledContent("Paired with", value: pc["name"].str ?? pc["url"].text)
                Button { Task { await m.act("pcSync", busy: "pc") { j in j.str ?? "Up to date with your PC." } } } label: { Label("Sync with my PC", systemImage: "laptopcomputer.and.arrow.down") }
                    .disabled(m.busy != nil)
                Button(role: .destructive) { Task { await m.act("pcUnpair", busy: "pc") { _ in "Unpaired from your PC." } } } label: { Label("Unpair", systemImage: "xmark.circle") }
            } else {
                Button { Task { await m.act("scanPair", busy: "pc") } } label: { Label("Pair with my PC: scan its code", systemImage: "qrcode.viewfinder") }
                    .disabled(m.busy != nil)
            }
        } header: { Text("Your PC") } footer: { Text("The same plan, coach, notes and lifts on both, end to end encrypted, over your home network.") }
        .fileImporter(isPresented: $importing, allowedContentTypes: [UTType(filenameExtension: "fit") ?? .data, .data], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            Task { await importFiles(urls) }
        }
    }

    private func importFiles(_ urls: [URL]) async {
        var added = 0, already = 0
        var failed: String?
        for url in urls {
            let ok = url.startAccessingSecurityScopedResource()
            defer { if ok { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else { failed = "Couldn't read \(url.lastPathComponent)."; continue }
            switch await shell.engine.rpc("importFit", ["name": url.lastPathComponent, "data": data.base64EncodedString()]) {
            case .success(let j): if J(json: j)["already"].bool { already += 1 } else { added += 1 }
            case .failure(let e): failed = e.message
            }
        }
        let words = [added > 0 ? "Added \(added) workout\(added == 1 ? "" : "s")." : nil, already > 0 ? "\(already) already here." : nil, failed].compactMap { $0 }.joined(separator: " ")
        if !words.isEmpty { shell.say(words) }
        if added > 0 { shell.changed() }
    }
}

// MARK: - Training

private struct TrainingGroup: View {
    let shell: ShellModel
    let m: SettingsModel
    @State private var km = ""
    @State private var workouts = ""
    @State private var long = ""
    @State private var race = 0
    @State private var raceName = ""
    @State private var raceDate = Date()
    @State private var hasDate = false
    @State private var target = ""
    @State private var maxHr = ""
    @State private var restHr = ""
    @State private var sex = ""
    @State private var resetting = false
    @State private var loaded = false

    private let races: [(String, Double)] = [("None", 0), ("5 km", 5), ("10 km", 10), ("Half marathon", 21.0975), ("Marathon", 42.195)]
    private let presets = [("Before work", "06:30"), ("Lunch", "12:00"), ("After work", "18:00"), ("Evening", "20:00")]

    var body: some View {
        Section {
            field("Weekly distance", $km, "km")
            field("Workouts a week", $workouts, "")
            field("Long run", $long, "km")
            Picker("Race", selection: $race) { ForEach(Array(races.enumerated()), id: \.offset) { i, r in Text(r.0).tag(i) } }
            if race > 0 {
                TextField("Race name (optional)", text: $raceName)
                Toggle("Race day", isOn: $hasDate)
                if hasDate { DatePicker("Date", selection: $raceDate, in: Date()..., displayedComponents: .date) }
                field("Target time", $target, "h:mm:ss", number: false)
            }
            Button("Save targets") { Task { await saveTargets() } }.disabled(parseTime(target) == nil && !target.isEmpty)
        } header: { Text("Targets") } footer: { Text("Today and Progress measure your weeks against them; the plan builds to your race.") }
        if let p = m.profile {
            Section {
                field("Max", $maxHr, "bpm")
                field("Resting", $restHr, "bpm")
                Picker("Sex", selection: $sex) { Text("Not set").tag(""); Text("Male").tag("M"); Text("Female").tag("F") }
                Button("Save heart rate") {
                    let own = p.maxSource == "set by you" || Int(maxHr) != p.maxHr
                    Task { await m.saveProfile(max: own ? Int(maxHr) : nil, rest: Int(restHr) ?? p.restHr, sex: sex.isEmpty ? nil : sex) }
                }
                if p.canUseWatch {
                    Button("Use my watch's zones") { Task { await m.useWatchZones(rest: Int(restHr) ?? p.restHr, sex: sex.isEmpty ? nil : sex) } }
                }
            } header: { Text("Heart rate") } footer: { Text(p.fromWatch ? "Zones come from your watch." : "Max: \(p.maxSource). Sex is for effort scores and the exercise figures.") }
        }
        if let t = m.times {
            Section {
                Menu {
                    ForEach(Array(presets.enumerated()), id: \.offset) { _, pr in
                        Button("\(pr.0) · \(pr.1)") { Task { await m.saveTimes(["weekday": pr.1], ok: "Weekday sessions at \(pr.1).") } }
                    }
                } label: { LabeledContent("Weekdays", value: t.weekday.ifEmpty("Not set")) }
                Menu {
                    ForEach(["07:00", "08:00", "09:00", "10:00", "16:00"], id: \.self) { time in
                        Button(time) { Task { await m.saveTimes(["weekend": time], ok: "Weekend sessions at \(time).") } }
                    }
                } label: { LabeledContent("Weekends", value: t.weekend.ifEmpty("Not set")) }
                if let n = t.next { Text(n).font(.footnote).foregroundStyle(.secondary) }
            } header: { Text("Training times") }
            Section {
                toggle("Before each session", t.remind) { on in ["remind": ["on": on, "before_min": t.before, "after": t.after]] }
                toggle("Each morning, at \(t.morningAt)", t.morning) { on in ["notify": ["morning": on, "morning_at": t.morningAt, "review": t.review]] }
                toggle("Sunday evening: the week's review", t.review) { on in ["notify": ["morning": t.morning, "morning_at": t.morningAt, "review": on]] }
                toggle("A note from the coach after a run", t.runNote) { on in ["notify": ["run": on]] }
            } header: { Text("Reminders") }
        }
        Section {
            if let title = m.planTitle {
                LabeledContent(title, value: "\(m.planWeeks) weeks")
            } else {
                Text("No plan yet: make one on the Coach tab.").foregroundStyle(.secondary)
            }
            Picker("Plan changes", selection: Binding(get: { m.approval }, set: { v in Task { await m.setApproval(v) } })) {
                Text("Ask me every time").tag("ask")
                Text("Small changes go straight in").tag("small")
                Text("My coach decides").tag("auto")
            }
            if m.planTitle != nil {
                Button("Clear the plan", role: .destructive) { resetting = true }
                    .confirmationDialog("Clear the plan?", isPresented: $resetting, titleVisibility: .visible) {
                        Button("Clear it", role: .destructive) { Task { await m.resetPlan() } }
                    } message: { Text("Your workouts stay. Your coach can make a new plan.") }
            }
        } header: { Text("Plan") } footer: { Text("Days behind you are never changed, and the app lists every change itself.") }
        .onAppear(perform: fill)
        .onChange(of: m.goals?.weeklyKm) { fill() }
    }

    private func fill() {
        guard !loaded, let g = m.goals else { return }
        loaded = true
        km = g.weeklyKm.map(one) ?? ""
        workouts = g.weeklyWorkouts.map(String.init) ?? ""
        long = g.longRunKm.map(one) ?? ""
        if let r = g.raceKm { race = races.firstIndex { abs($0.1 - r) < 0.3 } ?? 0 }
        raceName = g.raceName ?? ""
        if let d = g.raceDate.flatMap(dateOf) { raceDate = d; hasDate = true }
        target = g.raceTarget.map(clock) ?? ""
        if let p = m.profile { maxHr = "\(p.maxHr)"; restHr = "\(p.restHr)"; sex = p.sex ?? "" }
    }

    private func saveTargets() async {
        let g = SettingsModel.Goals(weeklyKm: Double(km.replacingOccurrences(of: ",", with: ".")), weeklyWorkouts: Int(workouts), longRunKm: Double(long.replacingOccurrences(of: ",", with: ".")),
                                    raceKm: race > 0 ? races[race].1 : nil, raceName: race > 0 && !raceName.isEmpty ? raceName : nil,
                                    raceDate: race > 0 && hasDate ? isoDay(raceDate) : nil, raceTarget: race > 0 ? parseTime(target) : nil)
        await m.saveGoals(g)
    }

    /** "1:45:00", "48:30" or "50" (minutes) as seconds. */
    private func parseTime(_ s: String) -> Int? {
        let parts = s.split(separator: ":").map { Int($0.trimmingCharacters(in: .whitespaces)) }
        guard !parts.isEmpty, parts.allSatisfy({ $0 != nil }) else { return nil }
        let n = parts.map { $0! }
        switch n.count {
        case 1: return n[0] * 60
        case 2: return n[0] * 60 + n[1]
        case 3: return n[0] * 3600 + n[1] * 60 + n[2]
        default: return nil
        }
    }

    private func field(_ label: String, _ text: Binding<String>, _ unit: String, number: Bool = true) -> some View {
        HStack {
            Text(label)
            Spacer()
            TextField("–", text: text)
                .multilineTextAlignment(.trailing)
                .keyboardType(number ? .decimalPad : .numbersAndPunctuation)
                .frame(maxWidth: 120)
            if !unit.isEmpty && number { Text(unit).foregroundStyle(.secondary) }
        }
    }

    private func toggle(_ label: String, _ on: Bool, _ change: @escaping (Bool) -> [String: Any]) -> some View {
        Toggle(label, isOn: Binding(get: { on }, set: { v in
            Task {
                if v, !(await m.allowReminders()) { shell.say("Notifications are off for Tartan: turn them on in the iPhone's Settings."); return }
                await m.saveTimes(change(v), ok: nil)
            }
        }))
    }
}

// MARK: - Coach

private struct CoachGroup: View {
    let shell: ShellModel
    let m: SettingsModel

    var body: some View {
        Section {
            if let c = m.coach {
                LabeledContent("Answers with", value: c.provider)
                if !c.model.isEmpty { LabeledContent("Model", value: c.model) }
                Label(c.ready ? "Ready to talk" : "Not set up yet: Tartan's rules write your plan", systemImage: c.ready ? "checkmark.circle" : "info.circle")
                    .foregroundStyle(c.ready ? Brand.good : Color.secondary)
            } else {
                ProgressView()
            }
            Button { shell.go("settings/coach/all") } label: { Label("Set up or change the AI", systemImage: "key") }
        } header: { Text("Your coach") } footer: { Text("Your own Gemini or Claude key, or Tartan's rules without AI. The key stays on this phone.") }
        Section {
            Toggle("A review of each week", isOn: Binding(get: { m.weekly }, set: { v in Task { await m.setWeekly(v) } }))
        } footer: { Text("On Sundays the coach looks back at the week and suggests changes for the next.") }
        Section {
            if m.notes.isEmpty {
                Text("Nothing yet. When you tell your coach something lasting (an injury, a day you can't train), it remembers it here.").font(.subheadline).foregroundStyle(.secondary)
            }
            ForEach(m.notes) { n in
                Text(n.text)
                    .swipeActions { Button("Forget", role: .destructive) { Task { await m.forgetNote(n) } } }
            }
        } header: { Text("What your coach remembers") } footer: { if !m.notes.isEmpty { Text("Swipe a note to forget it.") } }
    }
}

// MARK: - Watch

private struct WatchGroup: View {
    let shell: ShellModel
    let m: SettingsModel

    var body: some View {
        Section {
            if let w = m.watchWeek, w["wanted"].int ?? 0 > 0 {
                LabeledContent("On your watch", value: "\(w["onWatch"].int ?? 0) of \(w["wanted"].int ?? 0)")
                Button { Task { await m.act("watchWeek", ["send": true], busy: "week") { j in j["line"].str } } } label: {
                    Label(m.busy == "week" ? "Sending…" : "Send the coming week", systemImage: "applewatch.radiowaves.left.and.right")
                }
                .disabled(m.busy != nil || w["canBluetooth"].bool == false)
            } else {
                Text("With a plan, the coming 7 days go to your watch as guided workouts.").font(.subheadline).foregroundStyle(.secondary)
            }
        } header: { Text("Guided workouts") } footer: { Text("Start one from the sport mode's workout options on the watch.") }
    }
}

// MARK: - More

private struct MoreGroup: View {
    let shell: ShellModel
    let m: SettingsModel
    @State private var showLog = false
    @State private var parts = NativeParts.all()

    private let names: [(String, String)] = [("nav", "Tab bar"), ("today", "Today"), ("workout", "Workout sheet"), ("coach", "Coach"), ("chat", "Chat"), ("activities", "Activities"), ("progress", "Progress"), ("settings", "Settings")]

    var body: some View {
        Section {
            if m.demo {
                Button(role: .destructive) { Task { await m.act("demo", ["op": "leave"], busy: "demo") } } label: { Label("Leave the sample data", systemImage: "xmark.circle") }
            } else {
                Button { Task { await m.act("demo", ["op": "start"], busy: "demo") } } label: { Label("Try it with sample data", systemImage: "sparkles") }
            }
            Button { Task { await m.act("replayIntro", busy: "intro") } } label: { Label("Replay the intro", systemImage: "play.circle") }
        } header: { Text("Look around") } footer: { Text(m.demo ? "Ten weeks of a made-up runner, on storage of its own. Leaving deletes it." : "Ten weeks of a made-up runner, to look around. Your data isn't touched.") }
        Section {
            ForEach(Array(names.filter { NativeParts.built.contains($0.0) }.enumerated()), id: \.offset) { _, n in
                Toggle(n.1, isOn: Binding(get: { NativeParts.wanted(n.0) }, set: { on in shell.setPart(n.0, on); parts = NativeParts.all() }))
            }
        } header: { Text("Native screens") } footer: { Text("Drawn by iOS itself, with Liquid Glass. Turn one off to use the page's instead.") }
        Section {
            Button { showLog = true; Task { await m.readLog() } } label: { Label("Activity log", systemImage: "list.bullet.rectangle") }
            LabeledContent("Version", value: m.version.isEmpty ? "–" : "\(m.version) (\(m.build))")
        } header: { Text("About") }
        .sheet(isPresented: $showLog) {
            NavigationStack {
                ScrollView {
                    Text(m.log ?? "…").font(.system(.footnote, design: .monospaced)).frame(maxWidth: .infinity, alignment: .leading).padding().textSelection(.enabled)
                }
                .navigationTitle("Activity log")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) { ShareLink(item: m.log ?? "") }
                    ToolbarItem(placement: .topBarTrailing) { Button { showLog = false } label: { Image(systemName: "xmark") }.accessibilityLabel("Close") }
                }
            }
        }
    }
}
