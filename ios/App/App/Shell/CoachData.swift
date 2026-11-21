import Foundation
import Observation

/// What native Coach shows, from the routes the web Coach tab reads: GET /api/plan (PlanView in
/// web/types.ts), /api/coach/status and /api/plan/weekly (Android's CoachData.kt).
struct Coach {
    let plan: PlanInfo?
    let weeks: [PWeek]
    let today: String
    let goal: String?
    let proposal: Proposal?
    let lastChange: LastChange?
    let weekly: Weekly?
    /** The coach can talk (a key, or a model ready): the ask bar; else its setup. */
    let ready: Bool
    /** Said you're ill (since this date): Better now leads the life changes. */
    let ill: String?
    /** No plan yet: what the first plan's questions ask, and what the coach already knows. */
    var intake: Intake? = nil
    /** The plan's last day has gone: Coach asks for the next one, as for the first. */
    var ended = false
}

/// The first plan's questions (web/views/plan.ts intakeCard): the answers so far, the last four weeks, the race.
struct Intake {
    let days: Int?
    let hours: Int?
    let longDay: String?
    let notes: String
    let runs: Int
    let kmWeek: Double
    let longest: Double
    let workouts: Int
    let hoursWeek: Double
    let raceName: String?
    let raceKm: Double?
    let raceDate: String?
}

struct PlanInfo { let title: String; let summary: String; let advice: [String]; let zones: [Zone]; let updated: String; let conversation: String? }
struct Zone { let name: String; let line: String; let use: String? }
struct Change { let type: String; let headline: String; let detail: String; let why: String? }
struct Proposal { let at: String; let base: String; let changes: [Change]; let note: String?; let from: String; let conversation: String? }
struct LastChange { let at: String; let changes: [Change]; let auto: Bool }
struct Weekly { let week: String; let at: String; let text: String; let changed: Bool; let proposed: Int; let conversation: String? }
struct PSession: Identifiable { var id: String { "\(date):\(kind)" }; let date: String; let kind: String; let title: String; let line: String; let status: String; let manual: Bool }
struct Extra: Identifiable { let id: String; let label: String }
struct PDay: Identifiable { var id: String { date }; let date: String; let sessions: [PSession]; let extras: [Extra] }

struct PWeek: Identifiable {
    var id: String { start }
    let start: String
    let focus: String
    let days: [PDay]
    let km: Double
    let minutes: Double
    let planned: Int
    let done: Int
    let doneKm: Double
    let doneMinutes: Double
    /** past, current or future. */
    let time: String
    var race: Bool { days.contains { $0.sessions.contains { $0.kind == "race" } } }
}

private let CHANGE_WORD = ["added": "New", "removed": "Out", "moved": "Moved", "changed": "Changed", "zones": "Zones", "length": "Length"]
let FROM = ["chat": "From your conversation", "update": "Your new plan", "weekly": "From the weekly review", "agent": "From an outside agent", "life": "From what you told Tartan", "weather": "For the weather ahead"]

private func change(_ c: J) -> Change {
    let type = c["type"].text
    let whenText = c["date"].str.map { "\(dayName($0)) \(dateShort($0))" }
    let title = c["title"].str.map { [whenText, $0].compactMap { $0 }.joined(separator: " · ") }
    return Change(type: type, headline: [CHANGE_WORD[type] ?? type, title].compactMap { $0 }.joined(separator: ": "), detail: c["detail"].text, why: c["why"].str)
}

private func psession(_ date: String, _ s: J) -> PSession {
    let a = s["activity"]
    let line: String
    if a.object != nil {
        let bits = [a["distance_km"].num.map { "\(km1($0)) km" }, a["moving_min"].num.map(duration)].compactMap { $0 }
        line = "Did " + (bits.isEmpty ? (a["name"].str ?? sportTitle(a["sport"].text)) : bits.joined(separator: " · "))
    } else {
        line = [kindWord(s["kind"].text, s["title"].text), s["duration_min"].num.map(duration), s["distance_km"].num.map { "\(kmText($0)) km" }].compactMap { $0 }.joined(separator: " · ")
    }
    return PSession(date: date, kind: s["kind"].text, title: s["title"].text, line: line, status: s["status"].text, manual: s["manual"].bool)
}

func parseCoach(_ planJson: String, _ statusJson: String?, _ weeklyJson: String?) -> Coach? {
    let v = J(json: planJson)
    guard v.object != nil else { return nil }
    let p = v["plan"]
    let plan = p.object != nil ? PlanInfo(
        title: p["title"].text, summary: p["summary"].text, advice: p["advice"].strings,
        zones: p["zones"].array.map { z in Zone(name: z["name"].text, line: [z["pace"].str, z["heart_rate"].str].compactMap { $0 }.joined(separator: " · ").ifEmpty("–"), use: z["use"].str) },
        updated: p["updated"].text, conversation: p["conversation"].str
    ) : nil
    let weeks = v["weeks"].array.map { w -> PWeek in
        let planned = w["planned"], done = w["done"]
        let days = w["days"].array.map { d -> PDay in
            let date = d["date"].text
            return PDay(date: date, sessions: d["sessions"].array.map { psession(date, $0) }.filter { $0.kind != "rest" }, extras: d["extra"].array.map { a in
                let n = a["name"].str ?? sportTitle(a["sport"].text)
                return Extra(id: a["id"].text, label: a["distance_km"].num.map { "Extra: \(n) · \(km1($0)) km" } ?? "Extra: \(n)")
            })
        }
        let km: Double = { if let k = planned["km"].num, k > 0 { return k }; return w["target_km"].num ?? 0 }()
        let minutes: Double = { if let m = planned["minutes"].num, m > 0 { return m }; return (w["target_hours"].num ?? 0) * 60 }()
        return PWeek(start: w["start"].text, focus: w["focus"].text, days: days, km: km, minutes: minutes,
                     planned: planned["sessions"].int ?? 0, done: done["sessions"].int ?? 0, doneKm: done["km"].num ?? 0, doneMinutes: done["minutes"].num ?? 0, time: w["when"].text)
    }
    let race = v["goals"]["race"]
    let target = p["target_date"].str
    var goal: String?
    if let rd = race["date"].str, rd == target, let t = target {
        goal = "\(race["name"].str ?? "\(one(race["distance_km"].num ?? 0)) km race") on \(dateShort(t))"
    } else if let t = target {
        goal = "Building to \(dateShort(t))"
    }
    let pr = v["proposal"]
    let proposal = pr.object != nil ? Proposal(at: pr["at"].text, base: pr["base"].text, changes: pr["changes"].array.map(change), note: pr["note"].str, from: FROM[pr["source"].text] ?? "From your coach", conversation: pr["conversation"].str) : nil
    let lc = v["last_change"]
    let last = lc.object != nil ? LastChange(at: lc["at"].text, changes: lc["changes"].array.map(change), auto: lc["auto"].bool) : nil
    let wj = J(json: weeklyJson)
    let weekly = wj.object != nil && !wj["text"].text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        ? Weekly(week: wj["week"].text, at: wj["at"].text, text: wj["text"].text, changed: wj["changed"].bool, proposed: wj["proposed"].int ?? 0, conversation: wj["conversation"].str) : nil
    let st = J(json: statusJson)
    let ready = st.object == nil ? true : (st.has("ready") ? st["ready"].bool : true)
    var intake: Intake?
    let ended = plan != nil && !weeks.contains { $0.time == "current" || $0.time == "future" }
    if plan == nil || ended {
        let a = v["availability"], rc = v["recent"]
        let upcoming = race["date"].str.flatMap { $0 >= v["today"].text ? $0 : nil }
        intake = Intake(days: a["days_per_week"].int.flatMap { $0 > 0 ? $0 : nil }, hours: a["hours_per_week"].int.flatMap { $0 > 0 ? $0 : nil }, longDay: a["long_run_day"].str,
                        notes: a["notes"].str ?? "", runs: rc["runs"].int ?? 0, kmWeek: rc["run_km_per_week"].num ?? 0, longest: rc["longest_run_km"].num ?? 0,
                        workouts: rc["workouts"].int ?? 0, hoursWeek: rc["hours_per_week"].num ?? 0,
                        raceName: upcoming != nil ? race["name"].str : nil, raceKm: upcoming != nil ? race["distance_km"].num : nil, raceDate: upcoming)
    }
    return Coach(plan: plan, weeks: weeks, today: v["today"].text, goal: goal, proposal: proposal, lastChange: last, weekly: weekly, ready: ready, ill: v["life"]["ill"]["from"].str, intake: intake, ended: ended)
}

extension String {
    func ifEmpty(_ other: String) -> String { isEmpty ? other : self }
}

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago". */
func ago(_ iso: String, now: Date = Date()) -> String {
    guard let at = isoInstant(iso) else { return "" }
    let m = Int(now.timeIntervalSince(at) / 60)
    if m < 1 { return "just now" }
    if m < 60 { return m == 1 ? "1 minute ago" : "\(m) minutes ago" }
    if m < 60 * 24 { let h = m / 60; return h == 1 ? "1 hour ago" : "\(h) hours ago" }
    let d = m / 1440
    return d == 1 ? "1 day ago" : "\(d) days ago"
}

/** "3 Nov – 9 Nov". */
func weekRange(_ start: String) -> String {
    guard let d = dateOf(start), let end = Calendar(identifier: .gregorian).date(byAdding: .day, value: 6, to: d) else { return start }
    return "\(dateShort(start)) – \(dateShort(isoDay(end)))"
}

/// Native Coach's data: the plan as the Coach tab reads it, kept so the next start draws at once,
/// and its writes (a suggestion taken or kept, the last change undone, a life change).
@MainActor
@Observable
final class CoachModel {
    @ObservationIgnored weak var shell: ShellModel?
    private let engine: EngineBridge
    private let keys = UserDefaults.standard
    var data: Coach?
    var failed = false
    /** Making the first plan. */
    let maker: PlanMaker
    /** The whole plan rather than this week. */
    var whole = false
    var busy: String?
    var weeklySeen: String?
    /** The coming week on the watch ({canBluetooth, wanted, onWatch}), when it's read. */
    var watch: J?
    @ObservationIgnored var stale = true
    @ObservationIgnored private var readOn: String?
    @ObservationIgnored private var fetching = false
    /** Asked again while a read was under way: read once more when it's done. */
    @ObservationIgnored private var again = false

    /** Whether there's a plan (kept for the plugin: the page hears when one is made or gone). */
    nonisolated static var hasPlan: Bool { UserDefaults.standard.bool(forKey: "tartan.coach.hasPlan") }

    init(engine: EngineBridge) {
        self.engine = engine
        maker = PlanMaker(engine: engine)
        weeklySeen = keys.string(forKey: "tartan.coach.weeklySeen")
        if let p = keys.string(forKey: "tartan.coach.plan") {
            data = parseCoach(p, keys.string(forKey: "tartan.coach.status"), keys.string(forKey: "tartan.coach.weekly"))
        }
    }

    func freshen() {
        if stale || data == nil || readOn != isoDay(Date()) { Task { await fetch() } }
    }

    func fetch() async {
        guard !fetching else { again = true; return }
        fetching = true
        await read()
        fetching = false
        if again {
            again = false
            await fetch()
        }
    }

    private func read() async {
        stale = false
        async let p = engine.get("/api/plan")
        async let s = engine.get("/api/coach/status")
        async let w = engine.get("/api/plan/weekly")
        let planJson = await p, statusJson = await s, weeklyJson = await w
        guard let planJson, let c = parseCoach(planJson, statusJson, weeklyJson) else {
            stale = true
            failed = data == nil
            return
        }
        failed = false
        data = c
        readOn = isoDay(Date())
        Launch.ready(c.plan != nil ? "coach" : "noplan")
        keys.set(planJson, forKey: "tartan.coach.plan")
        keys.set(statusJson, forKey: "tartan.coach.status")
        keys.set(weeklyJson, forKey: "tartan.coach.weekly")
        let had = CoachModel.hasPlan
        keys.set(c.plan != nil, forKey: "tartan.coach.hasPlan")
        // A plan made or gone: the page and the shell hear, so the right Coach draws.
        if had != (c.plan != nil) { shell?.partsChanged(tell: true) }
        await readWatch()
    }

    func readWatch() async {
        if case .success(let j) = await engine.rpc("watchWeek", ["send": false]) { watch = J(json: j) }
    }

    func sendWeek() async {
        busy = "watch"
        defer { busy = nil }
        let r = await engine.rpc("watchWeek", ["send": true])
        switch r {
        case .success(let j): shell?.say(J(json: j)["line"].str ?? "Sent.")
        case .failure: shell?.say("Couldn't reach the watch. Keep it close and try again.")
        }
        await readWatch()
    }

    func dismissWeekly(_ week: String) {
        weeklySeen = week
        keys.set(week, forKey: "tartan.coach.weeklySeen")
    }

    /** A write through the page; what to say after it. */
    func write(_ path: String, _ body: [String: Any]?, doing: String, done: String) async {
        busy = doing
        let r = await engine.call(path, method: "POST", body: body.map(jsonText))
        busy = nil
        let err = J(json: r.body)["error"].str
        if (200..<300).contains(r.status), err == nil {
            shell?.say(done)
            stale = true
            await fetch()
        } else {
            shell?.say("Couldn't: \(err ?? "it didn't go through (\(r.status))")")
        }
    }

    /** A life change (src/life.ts): nil when it went through (and what it said is said), else what went wrong. */
    func life(_ body: [String: Any]) async -> String? {
        let r = await engine.call("/api/plan/life", method: "POST", body: jsonText(body))
        let o = J(json: r.body)
        guard (200..<300).contains(r.status), !o.has("error") else { return o["error"].str ?? "It didn't go through. Try again." }
        shell?.say(o["said"].str.flatMap { $0.isEmpty ? nil : $0 } ?? "Plan changed.")
        stale = true
        await fetch()
        return nil
    }
}
