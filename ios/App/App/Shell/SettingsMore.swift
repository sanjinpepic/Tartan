import SwiftUI
import UIKit
import Observation
import UniformTypeIdentifiers

/// Backups as they stand (rpc:backup).
struct BackupNow {
    let pass: Bool
    let weekly: Bool
    let last: Date?
    let docs: Bool
    let failed: String?
    let min: Int
}

/// Settings → More's own parts (Android's MoreModel, web/views/backup.ts): backups, the recorder and the log.
@MainActor
@Observable
final class MoreModel {
    @ObservationIgnored weak var shell: ShellModel?
    private let engine: EngineBridge
    var backup: BackupNow?
    /** Why the backups' state didn't come (shown with Try again instead of a spinner). */
    var backupError: String?
    var recorder: (armed: Bool, recording: Bool, last: String?)?
    var log: String?
    var version = ""
    var busy: String?

    init(engine: EngineBridge) { self.engine = engine }

    private func say(_ s: String) { shell?.say(s) }

    func ensure() {
        Task {
            await runBackup(["op": "state"])
            await readRecorder("state")
        }
    }

    /** The backups' state again (after it failed). */
    func retry() {
        backupError = nil
        Task { await runBackup(["op": "state"]) }
    }

    @discardableResult
    private func runBackup(_ args: [String: Any]) async -> Bool {
        let r = await engine.rpc("backup", args)
        defer { Launch.ready("backup") }
        switch r {
        case .success(let j):
            backupError = nil
            let o = J(json: j)
            let f = o["failed"]
            backup = BackupNow(pass: o["pass"].bool, weekly: o["weekly"].bool, last: o["last"].num.flatMap { $0 > 0 ? Date(timeIntervalSince1970: $0 / 1000) : nil },
                               docs: o["where"].str == "Documents/Tartan",
                               failed: f.object == nil ? nil : "The weekly backup didn't work \(ago(ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: (f["at"].num ?? 0) / 1000)))): \(f["text"].text). Back up now to try again.",
                               min: o["min"].int ?? 8)
            if let s = o["said"].str { say(s) }
            return true
        case .failure(let e):
            if backup == nil { backupError = e.message } else { say(e.message) }
            return false
        }
    }

    func backupDo(_ op: String, _ extra: [String: Any] = [:]) {
        busy = "backup"
        var a = extra
        a["op"] = op
        Task { await runBackup(a); busy = nil }
    }

    func restore(name: String, data: Data, pass: String) {
        busy = "restore"
        Task { await runBackup(["op": "restore", "name": name, "data": data.base64EncodedString(), "pass": pass]); busy = nil }
    }

    func readRecorder(_ op: String) async {
        switch await engine.rpc("recorder", ["op": op]) {
        case .success(let j):
            let o = J(json: j), l = o["last"]
            let size = l["bytes"].num ?? 0
            let bytes = size < 1024 ? "\(Int(size)) B" : size < 1024 * 1024 ? "\(Int((size / 1024).rounded())) KB" : String(format: "%.1f MB", size / 1024 / 1024)
            recorder = (armed: o["armed"].bool, recording: o["recording"].bool, last: l.object == nil ? nil : "Last recording: \(l["name"].text), \(ago(l["started"].text)), \(bytes).")
        case .failure(let e): say(e.message)
        }
    }

    func readLog() async {
        if case .success(let j) = await engine.rpc("log") {
            let o = J(json: j)
            log = o["text"].text
            version = "Version \(o["version"].text) · build \(o["build"].text)"
        }
    }

    func replayIntro() { Task { _ = await engine.rpc("replayIntro") } }
}

/// The tools an AI agent gets (Settings → More → More tools), each with what it gives.
private let TOOLS: [(String, String)] = [
    ("get_overview", "What data exists: activity counts, sources, last syncs."),
    ("get_takeaways", "The most useful things to know right now, with numbers."),
    ("list_activities", "Every workout once, filtered by date, sport or source."),
    ("get_activity", "One workout: laps, splits, best efforts, provenance."),
    ("get_activity_streams", "Heart rate, pace, cadence, power, altitude, GPS."),
    ("get_training_summary", "Totals per week, month or year."),
    ("get_training_load", "Fitness, fatigue and form from heart rate."),
    ("get_hr_zones", "Time in zones for a workout or a period."),
    ("get_efficiency_trend", "Easy-run metres per heartbeat, week by week."),
    ("get_durability", "How well the effort holds on long runs: heart-rate drift and where it starts."),
    ("get_weather", "The forecast at each planned session, with what heat costs."),
    ("get_best_efforts", "Personal bests per distance."),
    ("get_athlete_profile", "Profile, totals and heart-rate settings."),
    ("list_watch_files / read_watch_file", "Files copied off the watch."),
    ("get_week", "One week day by day against the week before."),
    ("get_training_plan", "The plan, each session done, missed or ahead."),
    ("save_training_plan", "Write or change the plan the app shows."),
    ("mark_plan_session", "Tick a session off by hand."),
    ("swap_plan_session", "Change a run on the day: a swim, a ride, the treadmill, shorter or another day."),
    ("get_habits", "What puts you off, and what you usually do on days like it."),
    ("log_workout / remove_logged_workout", "Log a workout nothing recorded, or take it back."),
    ("set_training_availability", "Days, hours and long-run day you have."),
    ("get_training_times / set_training_times", "When you usually train; reminders and calendar follow."),
    ("export_training_plan_csv / _ics / reset_training_plan", "Export the plan or its calendar, or clear it."),
    ("list_routes / get_route / save_route", "Your routes, as points or GPX; save a workout's track as a route."),
    ("list_watch_faces / save_watch_face", "Watch faces from the face builder; design one for the phone to install."),
    ("sync_strava / backup_watch", "Pull new data in."),
]

/// Settings → More (Android's MoreGroup): your PC when it's paired, backups, your data, feedback,
/// and More tools: whatever isn't in use yet (src/in-use.ts) and the advanced parts.
struct MoreGroup: View {
    let shell: ShellModel
    let m: SettingsModel

    private var more: MoreModel { shell.more }

    var body: some View {
        // Paired (or once was): at the top, as before. Not yet: under More tools.
        if shell.inUse.pc || shell.sources.pc != nil {
            PcSection(s: shell.sources)
                .onAppear { shell.watchSettings.ensure() }
        }
        BackupSection(more: more)
        Section {
            LabeledContent("Version", value: m.version.isEmpty ? "–" : "\(m.version) (\(m.build))")
            Button { more.replayIntro() } label: { Label("Replay the intro", systemImage: "play.circle") }
            if m.demo {
                Button(role: .destructive) { Task { await m.act("demo", ["op": "leave"], busy: "demo") } } label: { Label("Leave the sample data", systemImage: "xmark.circle") }
            } else {
                Button { Task { await m.act("demo", ["op": "start"], busy: "demo") } } label: { Label("Try it with sample data", systemImage: "sparkles") }
            }
        } header: { Text("Your data") } footer: {
            Text("Kept in this app's own storage on the phone." + (m.demo ? " The sample data is on storage of its own; leaving deletes it." : ""))
        }
        FeedbackSection(more: more)
        MoreTools(shell: shell, m: m, more: more)
            .onAppear { shell.watchSettings.ensure(); shell.sources.ensure() }
    }
}

/// Your PC: pair (type its address and code), sync now, unpair.
struct PcSection: View {
    let s: SourcesModel

    var body: some View {
        Section {
            PcRows(s: s)
        } header: { Text("Your PC") } footer: {
            Text(s.pc.map { "Paired with \($0.name ?? $0.url) · end to end encrypted" } ?? "End to end encrypted: your data, health and keys travel sealed with a key only your phone and your PC hold.")
        }
    }
}

/// Your PC's rows: paired (sync now, unpair) or the way to pair.
struct PcRows: View {
    let s: SourcesModel
    @State private var urls = ""
    @State private var code = ""

    var body: some View {
        if !s.pcRead {
            ProgressView().onAppear { s.ensure() }
        } else if let pc = s.pc {
            Button { s.pcSync() } label: { Label("Sync now", systemImage: "arrow.triangle.2.circlepath") }
                .disabled(s.busy == "pc")
            TwoTap(label: "Unpair", again: "Tap again: plans and lifts stop syncing", danger: true) { s.pcUnpair() }
            if s.busy == "pc" { ProgressView().frame(maxWidth: .infinity, alignment: .leading) }
            if let l = s.pcLine { Text(l).font(.subheadline) }
            Text("Both stay at the latest: the plan, lifts and morning checks on every sync, everything else (workouts, routes, backups, settings) every few hours and when you tap Sync now. Address \(pc.url).")
                .font(.footnote).foregroundStyle(.secondary)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                step(1, "On your PC, open Tartan:", "Settings → More → Phone app.")
                step(2, "Tap Pair a phone.", "It shows a code for 10 minutes. No code there? Tartan on the PC needs to be started for your home network (bun src/cli.ts serve --lan).")
                step(3, "Type its address and code here.", "Both are under the QR code on the PC.")
            }
            LabeledContent("PC address") {
                TextField("PC address", text: $urls, prompt: Text("192.168.1.20:5173"))
                    .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .multilineTextAlignment(.trailing)
            }
            LabeledContent("Code") {
                TextField("Code", text: Binding(get: { code }, set: { code = $0.uppercased() }), prompt: Text("K7QM3-XPA9R"))
                    .textInputAutocapitalization(.characters).autocorrectionDisabled().font(.body.monospaced())
                    .multilineTextAlignment(.trailing)
            }
            Button("Connect") { s.pcPair(urls: urls, code: code) }
                .disabled(urls.trimmingCharacters(in: .whitespaces).isEmpty || code.trimmingCharacters(in: .whitespaces).isEmpty || s.busy == "pc")
        }
    }

    private func step(_ n: Int, _ bold: String, _ rest: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text("\(n)").font(.caption.weight(.bold)).foregroundStyle(Brand.onContainer)
                .frame(width: 22, height: 22).background(Brand.container, in: Circle())
            (Text(bold + " ").fontWeight(.semibold) + Text(rest)).font(.subheadline)
        }
    }
}

/// Backups: a passphrase (twice, written down), Back up now, every week by itself, restore.
private struct BackupSection: View {
    let more: MoreModel
    @State private var a = ""
    @State private var again = ""
    @State private var restoring = false
    @State private var picking = false
    @State private var file: (name: String, data: Data)?
    @State private var pass = ""

    var body: some View {
        Section {
            if let b = more.backup {
                if !b.pass {
                    Text("Backups are encrypted with a passphrase you choose (at least \(b.min) characters). Write it down somewhere safe: without it a backup can't be opened, not even by Tartan.")
                        .font(.subheadline)
                    SecureField("Passphrase", text: $a)
                    SecureField("The same again", text: $again)
                    let bad: String? = !a.isEmpty && a.count < b.min ? "At least \(b.min) characters." : !again.isEmpty && a != again ? "The two don't match." : nil
                    if let bad { Text(bad).font(.footnote).foregroundStyle(.red) }
                    Button("Set passphrase") { more.backupDo("setPass", ["pass": a]); a = ""; again = "" }
                        .disabled(bad != nil || a.count < b.min || a != again)
                } else {
                    Button { more.backupDo("now") } label: { Label(more.busy == "backup" ? "Backing up…" : "Back up now", systemImage: "arrow.down.doc") }
                        .disabled(more.busy != nil)
                    Toggle(isOn: Binding(get: { b.weekly }, set: { more.backupDo("weekly", ["on": $0]) })) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Every week, by itself")
                            Text("Into Documents/Tartan on this phone (Files → On My iPhone → Tartan), the last four kept. Copy one off the phone now and then.").font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                    if let f = b.failed { Text(f).font(.footnote).foregroundStyle(Brand.watch) }
                    Button("Change passphrase") { more.backupDo("change") }
                }
                DisclosureGroup("Restore from a backup", isExpanded: $restoring) {
                    Button { picking = true } label: { Label(file?.name ?? "Pick the backup file", systemImage: "doc") }
                    SecureField("Its passphrase", text: $pass)
                    Text("What's in the backup replaces what's here now: workouts, plan, lifts, check-ins, coach notes and keys.").font(.footnote).foregroundStyle(.secondary)
                    Button { if let f = file { more.restore(name: f.name, data: f.data, pass: pass) } } label: {
                        Label(more.busy == "restore" ? "Restoring…" : "Restore", systemImage: "arrow.uturn.backward")
                    }
                    .disabled(file == nil || pass.isEmpty || more.busy != nil)
                }
            } else if let e = more.backupError {
                Label("Couldn't read the backups: \(e)", systemImage: "exclamationmark.triangle").font(.subheadline).foregroundStyle(Brand.watch)
                Button("Try again") { more.retry() }
            } else {
                ProgressView()
            }
        } header: { Text("Backups") } footer: {
            if let b = more.backup {
                Text(b.last.map { "Last backup \(ago(ISO8601DateFormatter().string(from: $0)))\(b.docs ? ", in Documents/Tartan" : "")." }
                     ?? "No backup yet. If this phone is lost or the app is removed, a backup is how your data comes back.")
            }
        }
        // Its own read, as it comes into view: the list builds rows lazily, so an onAppear on a
        // section further down may not run until it's scrolled to.
        .task { if more.backup == nil && more.backupError == nil { more.ensure() } }
        .fileImporter(isPresented: $picking, allowedContentTypes: [UTType(filenameExtension: "tartan") ?? .data, .data]) { r in
            guard case .success(let url) = r else { return }
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            if let d = try? Data(contentsOf: url) { file = (name: url.lastPathComponent, data: d) }
        }
    }
}

/// Feedback for Tartan's developer: an issue on GitHub, filled in with the version and the phone
/// (seen and edited before sending), and the activity log to attach. Nothing leaves unless you send it.
private struct FeedbackSection: View {
    let more: MoreModel
    @Environment(\.openURL) private var openURL

    var body: some View {
        Section {
            Button { write() } label: { Label("Write to the developer", systemImage: "paperplane") }
            if let log = more.log {
                ShareLink(item: "Tartan \(more.version)\n\n\(log)") { Label("Share the log", systemImage: "square.and.arrow.up") }
            } else {
                Button { Task { await more.readLog() } } label: { Label("Share the log", systemImage: "square.and.arrow.up") }
            }
        } header: { Text("Send feedback") } footer: {
            Text("You see everything before it's sent. The log lists connections, syncs and errors. Have a look before you send it: you choose where it goes.")
        }
    }

    private func write() {
        let v = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "?"
        let about = "Tartan \(v), iOS \(UIDevice.current.systemVersion), \(UIDevice.current.model)"
        let body = "**What happened, or what would help:**\n\n\n**Steps, if it's a problem:**\n1. \n\n---\n\(about)\n(Attach the log from Settings → More → Send feedback → Share the log, if it's about a sync or the watch.)"
        var c = URLComponents(string: "https://github.com/sanjinpepic/Tartan/issues/new")!
        c.queryItems = [URLQueryItem(name: "title", value: ""), URLQueryItem(name: "body", value: body)]
        if let u = c.url { openURL(u) }
    }
}

/// More tools: what isn't in use yet (src/in-use.ts; each moves to where it belongs once it's
/// yours), then the advanced parts: AI agents (on the PC), the step runner, the watch recorder, the
/// activity log, and which screens are native.
private struct MoreTools: View {
    let shell: ShellModel
    let m: SettingsModel
    let more: MoreModel
    @State private var agents = false
    @State private var builder = false
    @State private var rec = false
    @State private var log = false
    @State private var runnerOpen = false
    @State private var pcOpen = false
    @State private var demosOpen = false
    @State private var screensOpen = false
    @State private var icu = false
    @State private var parts = NativeParts.all()
    @AppStorage("tartan.plan.dest") private var dest = "suunto"

    private let names: [(String, String)] = [("nav", "Tab bar"), ("today", "Today"), ("workout", "Workout sheet"), ("coach", "Coach"), ("chat", "Chat"), ("activities", "Activities"), ("progress", "Progress"), ("settings", "Settings"), ("body", "Body"), ("record", "Record and Lift"), ("routes", "Routes")]

    private func row(_ title: String, _ sub: String, _ icon: String, _ go: @escaping () -> Void) -> some View {
        Button(action: go) {
            HStack(spacing: 12) {
                Image(systemName: icon).foregroundStyle(Brand.tint).frame(width: 26)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                    Text(sub).font(.footnote).foregroundStyle(.secondary)
                }
                Spacer(minLength: 4)
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
            }
        }
        .foregroundStyle(Color.primary)
    }

    var body: some View {
        let u = shell.inUse
        let s = shell.sources
        Section {
            // What isn't in use yet: each shows where it belongs once it's yours. Until it's known
            // (the first start, before the engine answers), none: listed here, then moved, would flicker.
            if u.known && !u.watch {
                row("Your watch", "Guided workouts, drink and gel reminders, your week on a face", "watch.analog") { shell.go("settings/watch") }
            }
            if u.known && !u.routes {
                row("Routes", "Draw a route, or make one from a run, and send it to the watch", "point.topleft.down.to.point.bottomright.curvepath") { shell.go("routes") }
            }
            if u.known && !(u.icu || s.icu?.connected == true || dest == "intervals") {
                row("intervals.icu", "Workouts from Garmin, Coros, Polar and others, and your plan back to them", "key") { icu = true }
                    .sheet(isPresented: $icu) { IcuFlow(s: s) { icu = false } }
            }
            if u.known && !(u.pc || s.pc != nil) {
                DisclosureGroup("Your PC", isExpanded: $pcOpen) {
                    Text("Tartan on a PC: the same plan, coach, notes and lifts on both, end to end encrypted.").font(.subheadline)
                    PcRows(s: s)
                }
            }
            if u.known && !u.faces {
                DisclosureGroup("Watch face builder", isExpanded: $builder) {
                    FaceList(shell: shell)
                }
            }
            if u.known && !u.lift {
                DisclosureGroup("Exercise demos", isExpanded: $demosOpen) {
                    Text("Who shows the moves in a strength session.").font(.subheadline)
                    DemosPicker(m: m)
                    Text(DemosPicker.footer(m)).font(.footnote).foregroundStyle(.secondary)
                }
            }
            DisclosureGroup("AI agents (MCP)", isExpanded: $agents) {
                Text("Give Claude Code, Claude Desktop, Cursor or any MCP client the same workouts, sleep and plan the coach reads.").font(.subheadline)
                Text("Agents connect to Tartan on a computer, which has their setup under Settings → More → Advanced there. Link it under Your PC and this phone keeps it up to date.")
                    .font(.footnote).foregroundStyle(.secondary)
                ForEach(Array(TOOLS.enumerated()), id: \.offset) { _, t in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(t.0).font(.caption.monospaced().weight(.semibold))
                        Text(t.1).font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
            if let r = shell.watchSettings.runner {
                DisclosureGroup("Step runner", isExpanded: $runnerOpen) {
                    Text("Suunto's is proven on your watch; Tartan's own is the one the public build sends, to try.").font(.subheadline)
                    Picker("Step runner", selection: Binding(get: { r == "tartan" ? "tartan" : "suunto" }, set: { shell.watchSettings.pickRunner($0) })) {
                        Text("Suunto's").tag("suunto")
                        Text("Tartan's own").tag("tartan")
                    }
                    .pickerStyle(.segmented)
                }
            }
            DisclosureGroup("Watch recorder", isExpanded: Binding(get: { rec }, set: { rec = $0; if $0 { Task { await more.readRecorder("state") } } })) {
                Text("When something goes wrong with the watch, record one connection and send the recording along. It holds every byte between the phone and the watch, so the problem can be played back and fixed without your watch.")
                    .font(.subheadline)
                Text("It includes what the watch sends (workouts, heart rate, routes). Share it only with whoever is fixing Tartan.").font(.footnote).foregroundStyle(Brand.watch)
                if let r = more.recorder {
                    Text(r.recording ? "Recording this connection. It's saved when the watch disconnects." : r.armed ? "Waiting: the next connection to the watch is recorded, whether you start it or Tartan syncs by itself." : r.last ?? "Nothing recorded yet.")
                        .font(.footnote).foregroundStyle(.secondary)
                    Button(r.armed ? "Cancel" : "Record the next connection") { Task { await more.readRecorder(r.armed ? "cancel" : "arm") } }
                        .disabled(r.recording)
                    if r.last != nil && !r.recording {
                        Button("Share recording") { Task { await more.readRecorder("share") } }
                    }
                }
            }
            DisclosureGroup("Activity log", isExpanded: Binding(get: { log }, set: { log = $0; if $0 { Task { await more.readLog() } } })) {
                ScrollView([.vertical, .horizontal]) {
                    Text(more.log.flatMap { $0.isEmpty ? nil : $0 } ?? "Nothing logged in this session yet. Connections, syncs and errors appear here.")
                        .font(.system(size: 11, design: .monospaced))
                        .textSelection(.enabled)
                        .padding(10)
                }
                .frame(maxHeight: 320)
                .background(Brand.well, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                HStack {
                    Button("Copy log") {
                        UIPasteboard.general.string = "Tartan \(more.version)\n\(more.log ?? "")"
                        shell.say("Log copied. Paste it wherever you need it.")
                    }
                    Spacer()
                    Text(more.version).font(.footnote).foregroundStyle(.secondary)
                }
            }
            DisclosureGroup("Native screens", isExpanded: $screensOpen) {
                Text("Drawn by iOS itself, with Liquid Glass. Turn one off to use the page's instead.").font(.footnote).foregroundStyle(.secondary)
                ForEach(Array(names.filter { NativeParts.built.contains($0.0) }.enumerated()), id: \.offset) { _, n in
                    Toggle(n.1, isOn: Binding(get: { NativeParts.wanted(n.0) }, set: { on in shell.setPart(n.0, on); parts = NativeParts.all() }))
                }
            }
            // The screenshots scroll to here (Launch: -TartanOpen moretools).
            .id("moretools")
        } header: { Text("More tools") } footer: {
            Text("Anything here you start using moves to where it belongs.")
        }
    }
}
