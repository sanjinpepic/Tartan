import SwiftUI
import UniformTypeIdentifiers

/// Settings, native on iPhone (Android's SettingsScreen.kt and its groups): Sources, Training,
/// Coach, Watch and More as an inset grouped list, a group in the address (settings/coach). The
/// page's own groups (settings/<group>/all) are no longer needed; the address still works.
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
                default: SourcesGroup(shell: shell)
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
    @State private var loaded = false
    @State private var calendars: [(id: String, title: String)] = []

    private let races: [(String, Double)] = [("None", 0), ("5 km", 5), ("10 km", 10), ("Half marathon", 21.0975), ("Marathon", 42.195)]
    private let presets = [("Before work", "06:30"), ("Lunch", "12:00"), ("After work", "18:00"), ("Evening", "20:00")]
    private let days = [("mon", "Monday"), ("tue", "Tuesday"), ("wed", "Wednesday"), ("thu", "Thursday"), ("fri", "Friday"), ("sat", "Saturday"), ("sun", "Sunday")]
    private let leads = [(15, "15 min"), (30, "30 min"), (60, "1 hour"), (120, "2 hours")]
    private let avoidKinds = [("ice", "Ice and snow"), ("rain", "Heavy rain"), ("wind", "Strong wind"), ("cold", "Cold"), ("heat", "Heat"), ("dark", "The dark")]
    private let badWeatherSaid = ["run": "Running in any weather.", "swim": "A swim on bad-weather days.", "ride": "A ride on bad-weather days.", "treadmill": "The treadmill on bad-weather days."]

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
                timeRow("Weekdays", t.weekday) { v in Task { await m.saveTimes(["weekday": v], ok: "Weekday sessions at \(v).") } }
                timeRow("Weekends", t.weekend) { v in Task { await m.saveTimes(["weekend": v], ok: "Weekend sessions at \(v).") } }
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
                    ForEach(Array(presets.enumerated()), id: \.offset) { _, pr in
                        let on = t.weekday == pr.1
                        Button { Task { await m.saveTimes(["weekday": pr.1], ok: "Weekday sessions at \(pr.1).") } } label: {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(pr.0).font(.subheadline.weight(.semibold))
                                Text(pr.1).font(.footnote)
                            }
                            .foregroundStyle(on ? Brand.onTint : Color.primary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 12).padding(.vertical, 8)
                            .background(on ? Brand.tint : Brand.well, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        }
                        .buttonStyle(Press())
                    }
                }
                DisclosureGroup(t.days.isEmpty ? "A different time on some days" : "Your own time on \(t.days.count) day\(t.days.count == 1 ? "" : "s")") {
                    ForEach(Array(days.enumerated()), id: \.offset) { _, d in
                        HStack {
                            timeRow(d.1, t.days[d.0] ?? (["sat", "sun"].contains(d.0) ? t.weekend : t.weekday)) { v in
                                var all = t.days
                                all[d.0] = v
                                Task { await m.saveTimes(["days": all], ok: "\(d.1)s at \(v).") }
                            }
                            if t.days[d.0] != nil {
                                Button("Same as usual") {
                                    var all = t.days
                                    all[d.0] = nil
                                    Task { await m.saveTimes(["days": all], ok: "\(d.1)s at the \(["sat", "sun"].contains(d.0) ? "weekend" : "weekday") time.") }
                                }
                                .buttonStyle(.borderless).font(.footnote)
                            }
                        }
                    }
                }
                Text(t.next ?? (m.planTitle != nil ? "No sessions ahead in your plan." : "Your coach's plan will use these times.")).font(.footnote).foregroundStyle(.secondary)
            } header: { Text("Training times") }
            Section {
                toggle("Remind me", "A notification before each session, with what's planned.", t.remind, ok: (on: "Reminders on.", off: "Reminders off.")) { on in ["remind": ["on": on, "before_min": t.before, "after": t.after]] }
                if t.remind {
                    Picker("Before", selection: Binding(get: { t.before }, set: { v in Task { await m.saveTimes(["remind": ["on": true, "before_min": v, "after": t.after]], ok: nil) } })) {
                        ForEach(Array(leads.enumerated()), id: \.offset) { _, l in Text(l.1).tag(l.0) }
                    }
                    .pickerStyle(.segmented)
                }
                toggle("After a session", "Half an hour after it should end, a tap brings the workout in from your watch. Not sent once it's in.", t.after, ok: (on: "Nudges after sessions on.", off: "Nudges after sessions off.")) { on in ["remind": ["on": t.remind, "before_min": t.before, "after": on]] }
                toggle("Each morning", "How you are and what's planned today, at \(t.morningAt), with any plan changes waiting for you.", t.morning, ok: (on: "A word each morning at \(t.morningAt).", off: "No morning notification.")) { on in ["notify": ["morning": on, "morning_at": t.morningAt, "review": t.review]] }
                if t.morning {
                    timeRow("Morning notification at", t.morningAt) { v in Task { await m.saveTimes(["notify": ["morning": true, "morning_at": v, "review": t.review]], ok: "A word each morning at \(v).") } }
                }
                toggle("Sunday evening review", "At 19:00 on Sundays, a nudge to open Tartan: the coach looks back at the week and sets up the next one.", t.review, ok: (on: "A nudge on Sunday evenings.", off: "No Sunday nudge.")) { on in ["notify": ["morning": t.morning, "morning_at": t.morningAt, "review": on]] }
                toggle("After a run", "A line or two from the coach when a new run comes in: how it went and what's next.", t.runNote, ok: (on: "A note after each run.", off: "No note after runs.")) { on in ["notify": ["run": on]] }
            } header: { Text("Reminders") }
            Section {
                Picker("I'd rather", selection: Binding(get: { t.badWeather }, set: { v in Task { await m.saveTimes(["bad_weather": v], ok: badWeatherSaid[v]) } })) {
                    Text("Run anyway").tag("run")
                    Text("Swim").tag("swim")
                    Text("Bike").tag("ride")
                    Text("Treadmill").tag("treadmill")
                }
                .pickerStyle(.segmented)
                ForEach(avoidKinds.indices, id: \.self) { i in
                    let k = avoidKinds[i]
                    Toggle(k.1, isOn: Binding(get: { t.avoid.contains(k.0) }, set: { on in
                        let next = avoidKinds.map { $0.0 }.filter { $0 == k.0 ? on : t.avoid.contains($0) }
                        Task { await m.saveTimes(["avoid": next], ok: next.isEmpty ? "Nothing puts you off: Today suggests only when you ask." : "Today will suggest a change on those days.") }
                    }))
                }
                if t.avoid.contains("cold") {
                    Picker("Cold is below", selection: Binding(get: { t.coldBelow }, set: { v in Task { await m.saveTimes(["cold_below": v], ok: nil) } })) {
                        ForEach([-10, -5, 0, 5], id: \.self) { Text("\($0) °C").tag($0) }
                    }
                }
            } header: { Text("On a bad-weather day") } footer: {
                Text("I'd rather… and what puts you off. On those days Today suggests a change inside the session; nothing ticked, only when you ask or your own habits clearly say so. A hard session is never swapped for a swim or a ride: it moves to a better day.")
            }
            Section {
                Toggle(isOn: Binding(get: { t.calendar }, set: { on in Task { await calendar(on, t) } })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Add to my calendar")
                        Text("Every session ahead as an event at your time. They move when the plan changes.").font(.footnote).foregroundStyle(.secondary)
                    }
                }
                if t.calendar && calendars.count > 1 {
                    Picker("Calendar", selection: Binding(get: { t.calendarId ?? "" }, set: { id in
                        let title = calendars.first { $0.id == id }?.title ?? ""
                        Task { await m.saveTimes(["calendar": ["on": true, "calendar_id": id, "calendar_name": title]], ok: "Your sessions are moving to \(title).") }
                    })) {
                        ForEach(Array(calendars.enumerated()), id: \.offset) { _, c in Text(c.title).tag(c.id) }
                    }
                }
                Button("Calendar file (.ics)") { Task { await m.saveFile("/api/plan/calendar.ics", name: "tartan-training-\(isoDay(Date())).ics", type: "text/calendar") } }
                    .disabled(!t.anySlots)
            } header: { Text("Calendar") } footer: { Text("The file opens in any calendar app, on this phone or another device. Importing it again updates the sessions instead of adding them twice.") }
            .task(id: t.calendar) { if t.calendar && calendars.isEmpty { calendars = await m.calendars() ?? [] } }
        }
        Section {
            Picker("Who shows them", selection: Binding(get: { m.demos }, set: { v in Task { await m.setDemos(v) } })) {
                Text("Like me").tag("me")
                Text("Man").tag("m")
                Text("Woman").tag("f")
                Text("Both").tag("mix")
            }
            .pickerStyle(.segmented)
        } header: { Text("Exercise demos") } footer: {
            Text(m.profile?.sex.map { $0 == "F" ? "Like me: a woman, from your profile above." : "Like me: a man, from your profile above." } ?? "Like me follows the sex in your profile above; until it's set, a man and a woman take turns.")
        }
        Section {
            if let title = m.planTitle {
                LabeledContent(title, value: "\(m.planWeeks) week\(m.planWeeks == 1 ? "" : "s")")
                if let u = m.planUpdated { Text("Updated \(ago(u))").font(.footnote).foregroundStyle(.secondary) }
                Button("Export as CSV") { Task { await m.saveFile("/api/plan/export.csv", name: "training-plan-\(isoDay(Date())).csv", type: "text/csv") } }
                TwoTap(label: "Reset plan", again: "Tap again to clear the plan", danger: true) { Task { await m.resetPlan() } }
            } else {
                Text("No plan yet. Your coach makes one on the Coach tab.").foregroundStyle(.secondary)
                Button("Go to Coach") { shell.go("coach") }
            }
        } header: { Text("Training plan") } footer: {
            if m.planTitle != nil { Text("The CSV has one row per session with its date, target and how it went. Resetting keeps the old plan in your data folder and the sessions you ticked off.") }
        }
        ShoesSection(shell: shell)
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

    private func toggle(_ label: String, _ sub: String, _ on: Bool, ok: (on: String, off: String), _ change: @escaping (Bool) -> [String: Any]) -> some View {
        Toggle(isOn: Binding(get: { on }, set: { v in
            Task {
                if v, !(await m.allowReminders()) { shell.say("Notifications are off for Tartan: turn them on in the iPhone's Settings."); return }
                await m.saveTimes(change(v), ok: v ? ok.on : ok.off)
            }
        })) {
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                Text(sub).font(.footnote).foregroundStyle(.secondary)
            }
        }
    }

    /** A time of day, picked on the wheel and saved as HH:mm. */
    private func timeRow(_ label: String, _ value: String, _ save: @escaping (String) -> Void) -> some View {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "HH:mm"
        let date = f.date(from: value) ?? f.date(from: "07:00")!
        return DatePicker(label, selection: Binding(get: { date }, set: { save(f.string(from: $0)) }), displayedComponents: .hourAndMinute)
    }

    /** Sessions into a calendar of the phone's (asking for access first), or out of it. */
    private func calendar(_ on: Bool, _ t: SettingsModel.Times) async {
        if !on { await m.saveTimes(["calendar": ["on": false]], ok: "Your plan's future sessions are leaving your calendar."); return }
        guard let list = await m.calendars() else { shell.say("Tartan can't reach your calendar. Allow it in the iPhone's Settings for Tartan."); return }
        guard let keep = list.first(where: { $0.id == t.calendarId }) ?? list.first else { shell.say("No calendar on this phone takes new events."); return }
        calendars = list
        await m.saveTimes(["calendar": ["on": true, "calendar_id": keep.id, "calendar_name": keep.title]], ok: "Your sessions are going into \(keep.title).")
    }
}


// MARK: - Coach

/// Settings → Coach (Android's CoachGroup): the coach's AI, how plan changes are made, the weekly
/// review, and what the coach remembers.
private struct CoachGroup: View {
    let shell: ShellModel
    let m: SettingsModel

    private let kinds = ["athlete": "You", "health": "Health", "preference": "Likes", "goal": "Goal", "lesson": "Learned"]

    var body: some View {
        Section {
            CoachSetupCard(m: shell.coachSetup, shell: shell)
                .buttonStyle(.borderless)
                .padding(.vertical, 6)
        } header: { Text(shell.coachSetup.setup?.canAnswer == true ? "Coach settings" : "Set up your coach") }
        if m.planTitle != nil {
            Section {
                ForEach(Array([("ask", "Ask me every time", "Every change waits for your OK on the Coach tab."),
                               ("small", "Small changes go straight in", "A session moved within its week, up to a quarter shorter or longer, paces by up to 10 s/km. New or dropped sessions and bigger changes wait for your OK."),
                               ("auto", "My coach decides", "The coach changes the plan itself; you see what changed and why, and can undo it for a week.")].enumerated()), id: \.offset) { _, c in
                    Button { Task { await m.setApproval(c.0) } } label: {
                        HStack(alignment: .top, spacing: 12) {
                            Image(systemName: m.approval == c.0 ? "checkmark.circle.fill" : "circle").font(.title3)
                                .foregroundStyle(m.approval == c.0 ? Brand.tint : Color.secondary)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(c.1)
                                Text(c.2).font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                    }
                    .foregroundStyle(Color.primary)
                    .accessibilityAddTraits(m.approval == c.0 ? .isSelected : [])
                }
            } header: { Text("Plan changes") } footer: { Text("Days behind you are never changed, and the app lists every change itself, whatever the coach says about it.") }
        }
        Section {
            Toggle(isOn: Binding(get: { m.weekly }, set: { v in Task { await m.setWeekly(v) } })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Look back every Sunday")
                    Text("Sunday evening, your coach looks back at the week and suggests changes to the next one when it should. Plan changes, above, decides what waits for your OK.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
        } header: { Text("Weekly review") }
        Section {
            if m.notes.isEmpty && m.forgotten == nil {
                Text("Nothing yet. Tell the coach something worth keeping (an old injury, when you can train) and it takes a note.").font(.subheadline).foregroundStyle(.secondary)
            }
            if let f = m.forgotten {
                HStack {
                    Text("Forgotten: \(f.note.text)").lineLimit(1).font(.subheadline)
                    Spacer()
                    Button("Undo") { m.unforget() }.buttonStyle(.borderless)
                }
            }
            ForEach(m.notes) { n in
                HStack(alignment: .top, spacing: 10) {
                    Text(kinds[n.kind] ?? n.kind).font(.caption.weight(.semibold)).foregroundStyle(Brand.onContainer)
                        .padding(.horizontal, 8).padding(.vertical, 3).background(Brand.container, in: Capsule())
                    Text(n.text).font(.subheadline)
                    Spacer(minLength: 4)
                    Button { m.forgetNote(n) } label: { Image(systemName: "xmark").foregroundStyle(.secondary) }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Forget: \(n.text)")
                }
                .swipeActions { Button("Forget", role: .destructive) { m.forgetNote(n) } }
            }
        } header: { Text("What your coach remembers") }
    }
}
