import Foundation
import Observation

/// Settings' data (Android's SettingsModel): what Training, Coach, Sources, Watch and More show,
/// read once and kept until a write; and saving, through the page so the cache, the calendar and
/// the reminders all hear of it.
@MainActor
@Observable
final class SettingsModel {
    @ObservationIgnored weak var shell: ShellModel?
    private let engine: EngineBridge

    struct Goals { var weeklyKm: Double?; var weeklyWorkouts: Int?; var longRunKm: Double?; var raceKm: Double?; var raceName: String?; var raceDate: String?; var raceTarget: Int? }
    struct Profile { let maxHr: Int; let restHr: Int; let maxSource: String; let sex: String?; let fromWatch: Bool; let canUseWatch: Bool }
    struct Times { let weekday: String; let weekend: String; let days: [String: String]; let remind: Bool; let before: Int; let after: Bool; let morning: Bool; let morningAt: String; let review: Bool; let runNote: Bool; let calendar: Bool; let calendarId: String?; let calendarName: String?; let next: String?; let anySlots: Bool }
    struct Note: Identifiable { let id: String; let text: String; let kind: String }
    struct CoachInfo { let provider: String; let model: String; let ready: Bool }

    var goals: Goals?
    var profile: Profile?
    var times: Times?
    var planTitle: String?
    var planWeeks = 0
    var planUpdated: String?
    var approval = "ask"
    var coach: CoachInfo?
    var notes: [Note] = []
    var weekly = true
    /** Who shows the strength exercises: "me", "m", "f" or "mix". */
    var demos = "me"
    /** A note just forgotten: gone at once, deleted after a few seconds unless undone. */
    var forgotten: (at: Int, note: Note)?
    @ObservationIgnored private var forgetting: Task<Void, Never>?
    var demo = false
    var version = ""
    var build = ""
    var strava: J?
    var pc: J?
    var watchWeek: J?
    var busy: String?
    var log: String?
    @ObservationIgnored private var read = false

    init(engine: EngineBridge) { self.engine = engine }

    func forget() { read = false }

    func ensure() {
        guard !read else { return }
        read = true
        Task {
            async let g = engine.get("/api/goals")
            async let p = engine.get("/api/profile")
            async let t = engine.get("/api/schedule")
            async let pl = engine.get("/api/plan")
            async let c = engine.get("/api/coach/status")
            async let m = engine.get("/api/coach/memory")
            async let st = engine.get("/api/strava/status")
            async let w = engine.rpc("prefs")
            async let d = engine.rpc("demo", ["op": "state"])
            async let pcs = engine.rpc("pcState")
            async let ww = engine.rpc("watchWeek", ["send": false])
            if let j = await g { goals = parseGoals(J(json: j)["goals"]) }
            if let j = await p { profile = parseProfile(J(json: j)) }
            if let j = await t { times = parseTimes(J(json: j)) }
            if let j = await pl {
                let v = J(json: j)
                planTitle = v["plan"].object != nil ? v["plan"]["title"].text : nil
                planWeeks = v["weeks"].array.count
                planUpdated = v["plan"]["updated"].str ?? v["plan"]["created"].str
                approval = v["approval"].str ?? "ask"
            }
            if let j = await c {
                let s = J(json: j)
                let pid = s["provider"].text, mid = s["model"].text
                coach = CoachInfo(provider: s["providers"].array.first { $0["id"].text == pid }?["label"].str ?? pid,
                                  model: s["models"].array.first { $0["id"].text == mid }?["label"].str ?? mid, ready: s["ready"].bool)
            }
            if let j = await m { notes = J(json: j)["notes"].array.filter { !$0["gone"].bool }.map { Note(id: $0["id"].text, text: $0["text"].text, kind: $0["kind"].text) } }
            if let j = await st { strava = J(json: j) }
            if case .success(let j) = await w {
                let o = J(json: j)
                weekly = o.has("weekly") ? o["weekly"].bool : true
                demos = o["demos"].str ?? "me"
                version = o["version"].text
                build = o["build"].text
            }
            if case .success(let j) = await d { demo = J(json: j)["on"].bool }
            if case .success(let j) = await pcs { pc = J(json: j).object != nil ? J(json: j) : nil }
            if case .success(let j) = await ww { watchWeek = J(json: j) }
            Launch.ready("settings")
        }
    }

    private func parseGoals(_ g: J) -> Goals {
        let r = g["race"]
        func pos(_ j: J) -> Double? { j.num.flatMap { $0 > 0 ? $0 : nil } }
        return Goals(weeklyKm: pos(g["weekly_km"]), weeklyWorkouts: pos(g["weekly_workouts"]).map { Int($0) }, longRunKm: pos(g["long_run_km"]),
                     raceKm: pos(r["distance_km"]), raceName: r["name"].str, raceDate: r["date"].str, raceTarget: pos(r["target_s"]).map { Int($0) })
    }

    private func parseProfile(_ p: J) -> Profile {
        let fromWatch = p["zones_source"].text == "your watch"
        return Profile(maxHr: p["max_hr"].int ?? 0, restHr: p["rest_hr"].int ?? 0, maxSource: p["max_hr_source"].text, sex: p["sex"].str,
                       fromWatch: fromWatch, canUseWatch: !p["watch_zones"].isNull && !fromWatch)
    }

    private func parseTimes(_ v: J) -> Times {
        let p = v["prefs"], r = p["remind"], n = p["notify"], c = p["calendar"]
        var next: String?
        if let slot = v["slots"].array.first {
            let start = slot["start"].text
            let day = dateOf(start).map { $0.formatted(.dateTime.weekday(.wide).day().month(.abbreviated)) } ?? String(start.prefix(10))
            next = "Next: \(slot["title"].text), \(day) at \(start.dropFirst(11).prefix(5))"
        }
        var days: [String: String] = [:]
        for (k, v) in p["days"].object ?? [:] { if let t = v as? String, !t.isEmpty { days[k] = t } }
        return Times(weekday: p["weekday"].text, weekend: p["weekend"].text, days: days, remind: r["on"].bool, before: r["before_min"].int ?? 30, after: r.has("after") ? r["after"].bool : true,
                     morning: n.has("morning") ? n["morning"].bool : true, morningAt: n["morning_at"].str ?? "07:30", review: n.has("review") ? n["review"].bool : true,
                     runNote: n.has("run") ? n["run"].bool : true, calendar: c["on"].bool, calendarId: c["calendar_id"].str, calendarName: c["calendar_name"].str, next: next,
                     anySlots: !v["slots"].array.isEmpty)
    }

    /** Save, then read again and say `ok` (nil: say nothing); on failure, say why. */
    func write(_ path: String, _ method: String, _ body: [String: Any]?, ok: String?) async {
        let r = await engine.call(path, method: method, body: body.map(jsonText))
        let err = J(json: r.body)["error"].str
        if (200..<300).contains(r.status), err == nil {
            if let ok { shell?.say(ok) }
            read = false
            ensure()
        } else {
            shell?.say("Couldn't save: \(err ?? "it didn't go through (\(r.status))")")
        }
    }

    func saveGoals(_ g: Goals) async {
        var b: [String: Any] = [:]
        if let v = g.weeklyKm { b["weekly_km"] = v }
        if let v = g.weeklyWorkouts { b["weekly_workouts"] = v }
        if let v = g.longRunKm { b["long_run_km"] = v }
        if let km = g.raceKm, km > 0 {
            var race: [String: Any] = ["distance_km": km]
            if let n = g.raceName, !n.isEmpty { race["name"] = n }
            if let d = g.raceDate { race["date"] = d }
            if let t = g.raceTarget { race["target_s"] = t }
            b["race"] = race
        }
        await write("/api/goals", "PUT", b, ok: "Targets saved. Today and Progress use them now.")
    }

    func saveProfile(max: Int?, rest: Int, sex: String?) async {
        await write("/api/profile", "PUT", ["max_hr": max.map { $0 as Any } ?? NSNull(), "rest_hr": rest, "sex": sex.map { $0 as Any } ?? NSNull()], ok: "Heart rate settings saved.")
    }

    func useWatchZones(rest: Int, sex: String?) async {
        await write("/api/profile", "PUT", ["rest_hr": rest, "sex": sex.map { $0 as Any } ?? NSNull()], ok: "Using your watch's heart-rate zones.")
    }

    func saveTimes(_ change: [String: Any], ok: String?) async { await write("/api/schedule", "PUT", change, ok: ok) }

    /** Notifications allowed (asked through the page's plugin). */
    func allowReminders() async -> Bool {
        if case .success(let r) = await engine.rpc("allowReminders"), r == "true" { return true }
        return false
    }

    func setApproval(_ mode: String) async {
        approval = mode
        await write("/api/plan/approval", "PUT", ["mode": mode], ok: nil)
    }

    func resetPlan() async { await write("/api/plan/reset", "POST", nil, ok: "Plan cleared. Your coach can make a new one.") }

    func setWeekly(_ on: Bool) async {
        weekly = on
        _ = await engine.rpc("weekly", ["on": on])
    }

    /** Forget a note: gone at once, deleted after a few seconds unless undone. */
    func forgetNote(_ n: Note) {
        if let f = forgotten { forgetting?.cancel(); Task { await delete(f.note) } }
        guard let at = notes.firstIndex(where: { $0.id == n.id }) else { return }
        notes.remove(at: at)
        forgotten = (at, n)
        forgetting = Task {
            try? await Task.sleep(for: .seconds(5))
            guard !Task.isCancelled else { return }
            forgotten = nil
            await delete(n)
        }
    }

    func unforget() {
        guard let f = forgotten else { return }
        forgetting?.cancel()
        notes.insert(f.note, at: min(f.at, notes.count))
        forgotten = nil
    }

    private func delete(_ n: Note) async {
        _ = await engine.call("/api/coach/memory/\(n.id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? n.id)", method: "DELETE")
    }

    /** Who shows the strength exercises. */
    func setDemos(_ choice: String) async {
        demos = choice
        _ = await engine.rpc("demos", ["choice": choice])
    }

    /** A file from the engine (the plan as CSV, its calendar) through the share sheet. */
    func saveFile(_ path: String, name: String, type: String) async {
        if case .failure = await engine.rpc("saveFile", ["path": path, "name": name, "type": type]) { shell?.say("Couldn't make the file.") }
    }

    /** The phone's calendars that take events (asking for access first); nil when not allowed. */
    func calendars() async -> [(id: String, title: String)]? {
        guard case .success(let j) = await engine.rpc("calendars") else { return nil }
        let a = J(json: j)
        guard a.raw is [Any] else { return nil }
        return a.array.map { (id: $0["id"].text, title: $0["title"].text) }
    }

    /** A call through the page (rpc), saying what came of it. */
    func act(_ name: String, _ args: [String: Any] = [:], busy what: String, done: ((J) -> String?)? = nil) async {
        busy = what
        defer { busy = nil }
        switch await engine.rpc(name, args) {
        case .success(let j): if let said = done?(J(json: j)) { shell?.say(said) }
        case .failure(let e): shell?.say(e.message)
        }
        read = false
        ensure()
    }

    func readLog() async {
        if case .success(let j) = await engine.rpc("log") { log = J(json: j)["text"].text }
    }
}
