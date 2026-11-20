import Foundation
import Observation
import UIKit

/// A lane of the sync board: watch or strava; busy, fail, on or ok; "5m", "on", "···".
struct Lane: Equatable, Identifiable {
    let id: String
    let state: String
    let text: String
    let glyph: String
    let name: String
    let status: String
    let failed: Bool
}

/// A message from the page (state.ts notify), drawn natively over everything.
struct Snack: Equatable {
    let id: Int
    let text: String
    let error: Bool
    let action: String?
    let ms: Int?
}

/// One of the app's four tabs (Settings is the gear).
struct Tab: Identifiable, Equatable {
    let id: String
    let label: String
    let icon: String

    static let all = [
        Tab(id: "today", label: "Today", icon: "sun.max"),
        Tab(id: "coach", label: "Coach", icon: "figure.run"),
        Tab(id: "activities", label: "Activities", icon: "list.bullet"),
        Tab(id: "trends", label: "Progress", icon: "chart.line.uptrend.xyaxis"),
    ]

    /// The tab a view belongs to (as the web's own nav and Android's FloatingBar.kt count it).
    static func of(_ view: String) -> String? {
        switch view {
        case "chat": return "coach"
        case "route", "routes": return "activities"
        case "lift", "you": return "today"
        case "today", "coach", "activities", "trends": return view
        default: return nil
        }
    }
}

/// What the root view controller does when the native layer changes: show or hide the native
/// screen, and put it over or under the page.
@MainActor
protocol ShellHost: AnyObject {
    func layout(animated: Bool)
}

/// The native layer's state: where the web app is, which native screen shows, the bar, the
/// board and the page's messages. The plugin feeds it (on the main thread); the SwiftUI views and
/// the root view controller read it.
@MainActor
@Observable
final class ShellModel {
    static let shared = ShellModel()

    @ObservationIgnored weak var plugin: TartanShellPlugin?
    @ObservationIgnored weak var host: ShellHost?
    let engine: EngineBridge
    let today: TodayModel
    let coach: CoachModel
    let activities: ActivitiesModel
    let progress: ProgressModel
    let chat: ChatModel
    let settings: SettingsModel
    let body: BodyModel
    let record: RecordModel
    /** The strength session open (by the address: lift/<date>). */
    var lift: LiftModel?

    /** The web app's view ("today", "coach", "chat"...) and its address after the #. */
    var view = "today"
    var hash = ""
    /** Something of the page's is open over everything (a sheet, the intro, the keyboard). */
    var pageOpen = false
    var navOn = NativeParts.isOn("nav")
    var todayOn = NativeParts.isOn("today")
    var coachOn = NativeParts.isOn("coach")
    var activitiesOn = NativeParts.isOn("activities")
    var progressOn = NativeParts.isOn("progress")
    var chatOn = NativeParts.isOn("chat")
    var settingsOn = NativeParts.isOn("settings")
    var bodyOn = NativeParts.isOn("body")
    var recordOn = NativeParts.isOn("record")
    /** The Settings group showing (from the address: settings/coach). */
    var settingsGroup = "sources"
    /** The keyboard is up (over a native screen: the bar steps aside). */
    var keyboardUp = false
    /** The native screen showing; nil while the page shows its own. */
    var shown: String?
    /** The bar folded small while a screen scrolls down. */
    var navFolded = false
    var board: [Lane] = []
    var snack: Snack?
    /** The native sheet open over everything (a session's, a workout's), if any. */
    var sheet: ShellSheet?
    /** Bumped to scroll Today back to the top (its tab tapped again). */
    var toTop = 0

    /** Where the bar and the messages are drawn (window coordinates), for the overlay's hit test. */
    @ObservationIgnored var touchRects: [String: CGRect] = [:]
    @ObservationIgnored private var told = false
    @ObservationIgnored private var run: CGFloat = 0
    @ObservationIgnored private var snackTimer: Task<Void, Never>?

    private init() {
        let engine = EngineBridge()
        self.engine = engine
        self.today = TodayModel(engine: engine)
        self.coach = CoachModel(engine: engine)
        self.activities = ActivitiesModel(engine: engine)
        self.progress = ProgressModel(engine: engine)
        self.chat = ChatModel(engine: engine)
        self.settings = SettingsModel(engine: engine)
        self.body = BodyModel(engine: engine)
        self.record = RecordModel(engine: engine)
        today.shell = self
        coach.shell = self
        settings.shell = self
        record.shell = self
        NotificationCenter.default.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { ShellModel.shared.resumed() }
        }
        NotificationCenter.default.addObserver(forName: UIResponder.keyboardWillShowNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { ShellModel.shared.keyboardUp = true }
        }
        NotificationCenter.default.addObserver(forName: UIResponder.keyboardWillHideNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { ShellModel.shared.keyboardUp = false }
        }
    }

    func attach(_ plugin: TartanShellPlugin) {
        self.plugin = plugin
        engine.plugin = plugin
        showScreen()
    }

    /**
     * A page started (the app opening, or the page reloading after the demo, a restore…): it hears
     * again whether a native screen shows, reads still waiting for the old page go to the new one,
     * and native screens read again. Launched for screenshots (Launch), it starts the sample data
     * and opens the tab asked for.
     */
    func pageStarted() {
        told = false
        engine.pageStarted()
        today.stale = true
        coach.stale = true
        showScreen()
        if Launch.demo { Task { await demoForScreens() } }
        if let tab = Launch.tab {
            if tab == "lift" {
                // Screenshots: the plan's strength session nearest today.
                Task {
                    let days = J(json: await engine.get("/api/plan"))["weeks"].array.flatMap { $0["days"].array }
                    let strength = days.filter { d in d["sessions"].array.contains { $0["kind"].text == "strength" } }.map { $0["date"].text }
                    let today = isoDay(Date())
                    if let d = strength.first(where: { $0 >= today }) ?? strength.last { go("lift/\(d)", retain: true) }
                }
            } else {
                go(tab, retain: true)
            }
        }
    }

    @ObservationIgnored private var settingUp = false

    /**
     * Screenshots (Launch.demo): the sample data, as the intro's "Try it with sample data" (the page
     * reloads into it and writes ten weeks of workouts), then what a runner would add to see the
     * whole app: a half marathon nine weeks out and a plan by Tartan's own rules. Done once; each
     * later start finds the plan and leaves it.
     */
    private func demoForScreens() async {
        guard !settingUp else { return }
        settingUp = true
        defer { settingUp = false }
        let r = await engine.rpc("demo", ["op": "start"])
        guard case .success(let j) = r, J(json: j)["on"].bool else { return }
        // The sample written: Today has a last workout.
        var seeded = false
        for _ in 0..<90 {
            if let t = await engine.get("/api/today"), J(json: t)["last"].object != nil { seeded = true; break }
            try? await Task.sleep(for: .seconds(1))
        }
        guard seeded, let plan = await engine.get("/api/plan") else { return }
        if J(json: plan)["plan"].object == nil {
            let cal = Calendar(identifier: .gregorian)
            let race = isoDay(cal.date(byAdding: .day, value: 63, to: Date()) ?? Date())
            _ = await engine.send("/api/goals", method: "PUT", body: ["weekly_km": 40, "race": ["name": "Helsinki Half", "distance_km": 21.1, "date": race, "target_s": 6300] as [String: Any]])
            _ = await engine.send("/api/plan/availability", method: "PUT", body: ["days_per_week": 5, "hours_per_week": 6, "long_run_day": "Sun"])
            _ = await engine.send("/api/plan/basic", method: "POST", body: ["target": race])
            changed()
        }
        Launch.ready("plan")
    }

    /** The tab the bar lights: the view's. */
    var tab: String? { Tab.of(view) }

    /** Screens that take the whole screen: no bar over them (as on Android). */
    var barHidden: Bool { !navOn || pageOpen || (keyboardUp && shown != nil) || ["lift", "record", "face"].contains(view) }

    func route(view next: String, hash: String, pageOpen: Bool) {
        if next != view { navFolded = false }
        view = next
        self.hash = hash
        self.pageOpen = pageOpen
        showScreen()
    }

    /** Parts switched on or off (or Coach's plan made or gone): `tell` the page too, which draws the rest. */
    func partsChanged(tell: Bool = false) {
        navOn = NativeParts.isOn("nav")
        todayOn = NativeParts.isOn("today")
        coachOn = NativeParts.isOn("coach")
        activitiesOn = NativeParts.isOn("activities")
        progressOn = NativeParts.isOn("progress")
        chatOn = NativeParts.isOn("chat")
        settingsOn = NativeParts.isOn("settings")
        bodyOn = NativeParts.isOn("body")
        recordOn = NativeParts.isOn("record")
        if tell { plugin?.emit("parts", NativeParts.all()) }
        showScreen()
    }

    /** The run being recorded, as the page pushes it: Record shows it, the lock screen too. */
    func recorded(_ r: RecNow) {
        record.rec = r
        LiveRun.update(r)
    }

    /** A part switched on or off in native Settings: kept, and the page hears. */
    func setPart(_ name: String, _ on: Bool) {
        NativeParts.set(name, on)
        partsChanged(tell: true)
    }

    /** Which native screen this view gets, if any. */
    private func nativeFor(_ v: String) -> String? {
        if v == "today" && todayOn { return "today" }
        if v == "coach" && coachOn { return "coach" }
        if v == "activities" && activitiesOn { return "activities" }
        if v == "trends" && progressOn { return "trends" }
        if v == "chat" && chatOn { return "chat" }
        if v == "you" && bodyOn { return "you" }
        if v == "record" && recordOn { return "record" }
        if v == "lift" && recordOn {
            let date = hash.split(separator: "/").dropFirst().first.map(String.init) ?? isoDay(Date())
            if lift?.date != date {
                let l = LiftModel(engine: engine, date: date)
                l.shell = self
                lift = l
            }
            return "lift"
        }
        if v == "settings" && settingsOn {
            // settings/<group>/all: the page's whole group, for what isn't native yet.
            let parts = hash.split(separator: "/").map(String.init)
            if parts.count > 2 && parts[2] == "all" { return nil }
            if hash.hasPrefix("sync") { settingsGroup = "sources" }
            else if parts.count > 1, SettingsScreen.groups.contains(where: { $0.0 == parts[1] }) { settingsGroup = parts[1] }
            return "settings"
        }
        return nil
    }

    func showScreen() {
        let next = nativeFor(view)
        // The page goes see-through over a native screen (so its sheets open over it), and back
        // to itself over its own.
        if (next != nil) != (shown != nil) || !told, let plugin {
            told = true
            plugin.emit("screen", ["native": next != nil], retain: true)
        }
        shown = next
        host?.layout(animated: true)
        if next == "today" { today.freshen() }
        if next == "activities" { activities.freshen() }
        if next == "chat" { chat.ensure() }
        if next == "settings" { settings.ensure() }
        if next == "you" { body.ensure() }
        if next == "record" { record.ensure() }
        // Coach reads whenever it's asked for, so it knows whether there's a plan to draw.
        if view == "coach" && NativeParts.wanted("coach") { coach.freshen() }
    }

    /** A tab tapped (or slid to) in the native bar. */
    func select(_ id: String) {
        navFolded = false
        if view == id {
            if id == "today" { toTop += 1 }
            return
        }
        go(id)
    }

    /** Ask the web app to show a screen (an address, "settings/sources"...). */
    func go(_ hash: String, retain: Bool = false) {
        plugin?.emit("go", ["hash": hash], retain: retain)
    }

    /** Ask the web app for something: "sync", "board", or a workout's or a session's sheet. */
    func goAction(_ action: String, extra: [String: Any] = [:]) {
        var data: [String: Any] = ["hash": ""]
        if !action.isEmpty { data["action"] = action }
        for (k, v) in extra { data[k] = v }
        plugin?.emit("go", data)
    }

    /** A workout's sheet: native when that part is, else the page's. */
    func openActivity(_ id: String) {
        if NativeParts.isOn("workout") { sheet = .workout(WorkoutModel(engine: engine, id: id)) } else { goAction("", extra: ["activity": id]) }
    }

    /** A planned session's sheet, native (as Android's). */
    func openSession(date: String, kind: String?) {
        sheet = .session(SessionModel(engine: engine, date: date, kind: kind))
    }

    /** A word after something done in a native screen, as the page's messages show. */
    func say(_ text: String) {
        show(Snack(id: -1, text: text, error: false, action: nil, ms: 4000))
    }
    func openBoard() {
        if board.isEmpty { go("settings/sources") } else { goAction("board") }
    }

    func changed() {
        today.stale = true
        coach.stale = true
        activities.stale = true
        settings.forget()
        if shown == "settings" { settings.ensure() }
        body.forget()
        if shown == "you" { body.ensure() }
        progress.forget()
        if shown == "trends" { progress.ensure() }
        today.syncDone()
        if shown == "today" { today.freshen() }
        if view == "coach" && NativeParts.wanted("coach") { coach.freshen() }
        if shown == "activities" { activities.freshen() }
    }

    private func resumed() {
        if shown == "today" { today.freshen() }
        if shown == "coach" { coach.freshen() }
        if shown == "activities" { activities.freshen() }
    }

    func show(_ s: Snack) {
        snackTimer?.cancel()
        snack = s
        guard let ms = s.ms else { return }
        snackTimer = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(ms))
            guard !Task.isCancelled else { return }
            self?.dismissSnack(s.id)
        }
    }

    func dismissSnack(_ id: Int) {
        if snack?.id == id { snack = nil }
    }

    /** The snack's button: the page runs what it stands for. */
    func snackAction(_ s: Snack) {
        plugin?.emit("snack", ["id": s.id])
        dismissSnack(s.id)
    }

    /** A screen scrolled: a run of 24 points down folds the bar, back up (or at the top) unfolds it, so a nudge doesn't. */
    func scrolled(by dy: CGFloat, at y: CGFloat) {
        if y <= 8 {
            run = 0
            if navFolded { navFolded = false }
            return
        }
        if (dy < 0) != (run < 0) { run = 0 }
        run += dy
        if run > 24, !navFolded { navFolded = true } else if run < -24, navFolded { navFolded = false }
    }
}

/// The API bridge to the engine: a call goes to the page as an "api" event and comes back as
/// `reply` (or `chunk` lines, then `reply`). Kept for the page if it isn't listening yet. A call
/// that isn't answered in time ends with 599, as on Android (GET 20 s, a stream 10 min, else 2 min).
@MainActor
final class EngineBridge {
    weak var plugin: TartanShellPlugin?
    private var pending: [String: CheckedContinuation<(Int, String), Never>] = [:]
    /** What each read asked, to ask a page that started since (the old one won't answer). */
    private var asked: [String: [String: Any]] = [:]
    private var timers: [String: Task<Void, Never>] = [:]
    private var streams: [String: (String) -> Void] = [:]

    func call(_ path: String, method: String = "GET", body: String? = nil, onLine: ((String) -> Void)? = nil) async -> (status: Int, body: String) {
        guard let plugin else { return (599, "") }
        let id = UUID().uuidString
        let seconds: Double = method == "GET" && onLine == nil ? 20 : onLine != nil ? 600 : 120
        if let onLine { streams[id] = onLine }
        var data: [String: Any] = ["id": id, "method": method, "path": path, "stream": onLine != nil]
        if let body { data["body"] = body }
        let answer: (Int, String) = await withCheckedContinuation { cont in
            pending[id] = cont
            timers[id] = Task { [weak self] in
                try? await Task.sleep(for: .seconds(seconds))
                guard !Task.isCancelled else { return }
                self?.finish(id, 599, "")
            }
            if method == "GET" && onLine == nil { asked[id] = data }
            plugin.emit("api", data, retain: true)
        }
        streams[id] = nil
        return (answer.0, answer.1)
    }

    /** A new page: the reads the old one didn't answer, asked again (only reads: a write may have gone through). */
    func pageStarted() {
        for data in asked.values { plugin?.emit("api", data, retain: true) }
    }

    func finish(_ id: String, _ status: Int, _ body: String) {
        asked[id] = nil
        timers.removeValue(forKey: id)?.cancel()
        guard let cont = pending.removeValue(forKey: id) else { return }
        cont.resume(returning: (status, body))
    }

    func line(_ id: String, _ line: String) {
        streams[id]?(line)
    }

    /** A read: the body, or nil when it didn't come. */
    func get(_ path: String) async -> String? {
        let r = await call(path)
        return (200..<300).contains(r.status) ? r.body : nil
    }

    /** A write: the body, or what went wrong in words. */
    func send(_ path: String, method: String, body: [String: Any]) async -> Result<String, ShellError> {
        let r = await call(path, method: method, body: jsonText(body))
        return answer(r)
    }

    /** A typed engine call (web/lib/contract.ts EngineCalls). */
    func rpc(_ name: String, _ args: [String: Any] = [:]) async -> Result<String, ShellError> {
        let r = await call("rpc:\(name)", method: "POST", body: jsonText(args))
        return answer(r)
    }

    private func answer(_ r: (status: Int, body: String)) -> Result<String, ShellError> {
        let error = J(json: r.body)["error"].str
        if (200..<300).contains(r.status), error == nil { return .success(r.body) }
        if let error, !error.isEmpty { return .failure(ShellError(message: error)) }
        if r.status == 599 { return .failure(ShellError(message: "No answer. Is the app busy?")) }
        return .failure(ShellError(message: "It didn't go through (\(r.status))."))
    }
}

struct ShellError: Error {
    let message: String
}

func jsonText(_ value: Any) -> String {
    guard JSONSerialization.isValidJSONObject(value), let data = try? JSONSerialization.data(withJSONObject: value) else { return "{}" }
    return String(decoding: data, as: UTF8.self)
}
