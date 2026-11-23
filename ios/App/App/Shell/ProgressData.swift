import Foundation
import Observation

// What native Progress shows (Android's ProgressData.kt): GET /api/dashboard?days=, /api/race-shape,
// /api/durability for a range; /api/week with /api/plan for the Week.

struct Totals { let label: String; let km: Double; let workouts: Int; let hours: Double }
struct WeekBar: Identifiable { var id: String { week }; let week: String; let km: Double; let workouts: Int }
struct Point: Identifiable { var id: String { date }; let date: String; let value: Double }
struct ZoneShare { let zone: Int; let name: String; let seconds: Double }
struct Best: Identifiable { var id: String { name }; let name: String; let seconds: Int; let pace: String?; let date: String; let activity: String }
struct RaceInfo { let name: String; let km: Double; let date: String?; let daysToGo: Int?; let predicted: Int?; let target: Int?; let targetPace: String?; let fromText: String? }

struct Dash {
    let days: Int
    let totals: [Totals]
    let weeks: [WeekBar]
    let targetKm: Double?
    let weekHit: (hit: Int, of: Int)?
    let fitness: [Point]
    let estimatedShare: Double
    let zones: [ZoneShare]
    let zoneWorkouts: Int
    let efficiency: [Point]
    let bests: [Best]
    let changing: [Takeaway]
    let race: RaceInfo?
}

struct ShapeLine: Identifiable { var id: String { name }; let name: String; let metres: Double; let weeks: [(week: String, s: Double?)]; let from: String? }
struct LongRun { let date: String; let text: String; let drift: Double; let steady: Bool; let held: String }
struct Durab { let summary: String; let runs: [LongRun] }
struct WeekDay: Identifiable { var id: String { date }; let date: String; let km: Double; let minutes: Double; let workouts: Int; let future: Bool }

struct WeekV {
    let start: String
    let end: String
    let current: Bool
    let prev: String?
    let next: String?
    let km: Double
    let minutes: Double
    let workouts: Int
    let climb: Double
    let load: Double
    let before: (km: Double, minutes: Double)
    let usualLoad: Double
    let days: [WeekDay]
    let acts: [Act]
    let zones: [ZoneShare]
    let sports: [(sport: String, km: Double, minutes: Double)]
    /** The plan's week: done of planned, the focus, km. */
    let plan: String?
}

let RANGES = [7, 84, 182, 365]
let RANGE_LABEL = [7: "Week", 84: "12 weeks", 182: "6 months", 365: "1 year"]

func parseDash(_ json: String) -> Dash? {
    let d = J(json: json)
    guard d.object != nil else { return nil }
    let days = d["days"].int ?? 0
    let weeksJ = d["weeks"].array
    let weeks = weeksJ.map { WeekBar(week: $0["week"].text, km: $0["distance_km"].num ?? 0, workouts: $0["activities"].int ?? 0) }
    let t = d["totals"]
    func tot(_ label: String, _ o: J) -> Totals { Totals(label: label, km: o["distance_km"].num ?? 0, workouts: o["activities"].int ?? 0, hours: o["hours"].num ?? 0) }
    let inRange = Totals(label: RANGE_LABEL[days] ?? "\(days) days", km: weeks.reduce(0) { $0 + $1.km }, workouts: weeks.reduce(0) { $0 + $1.workouts },
                         hours: weeksJ.reduce(0) { $0 + ($1["moving_hours"].num ?? 0) })
    let targets = d["targets"]
    let r = targets["race"]
    var race: RaceInfo?
    if r.object != nil {
        let from = r["from"]
        race = RaceInfo(name: r["name"].str ?? "\(one(r["distance_km"].num ?? 0)) km race", km: r["distance_km"].num ?? 0, date: r["date"].str, daysToGo: r["days_to_go"].int,
                        predicted: r["predicted_s"].int, target: r["target_s"].int, targetPace: r["target_pace"].str,
                        fromText: from.object != nil ? "your \(from["name"].text) best this year (\(clock(from["time_s"].int ?? 0)), \(dateShort(from["date"].text)))" : nil)
    }
    let order = ["400m", "1/2 mile", "1k", "1 mile", "2 mile", "5k", "10k", "15k", "10 mile", "20k", "Half-Marathon", "30k", "Marathon"]
    let bests = d["bests"].array.map { Best(name: $0["name"].text, seconds: $0["time_s"].int ?? 0, pace: $0["pace_min_km"].str, date: $0["date"].text, activity: $0["activity"].text) }
        .sorted { (order.firstIndex(of: $0.name) ?? 99) < (order.firstIndex(of: $1.name) ?? 99) }
    let wk = targets["week"]
    return Dash(
        days: days,
        totals: [inRange, tot("This month", t["month"]), tot("This year", t["year"])],
        weeks: weeks.reversed(),
        targetKm: targets["goals"]["weekly_km"].num,
        weekHit: wk.object != nil ? (hit: wk["hit"].int ?? 0, of: wk["of_weeks"].int ?? 0) : nil,
        fitness: d["load"]["series"].array.map { Point(date: $0["date"].text, value: $0["fitness"].num ?? 0) },
        estimatedShare: d["load"]["estimated_share"].num ?? 0,
        zones: d["zones"]["zones"].array.map { ZoneShare(zone: $0["zone"].int ?? 0, name: $0["name"].text, seconds: $0["seconds"].num ?? 0) },
        zoneWorkouts: d["zones"]["activities"].int ?? 0,
        efficiency: d["efficiency"].array.map { Point(date: $0["week"].text, value: $0["m_per_beat"].num ?? 0) },
        bests: bests,
        changing: d["takeaways"].array.filter { $0["horizon"].text == "trend" }.map { Takeaway(tone: $0["tone"].text, title: $0["title"].text, detail: $0["detail"].text, activity: nil, id: $0["id"].text, date: nil) },
        race: race
    )
}

func parseShape(_ json: String) -> [ShapeLine] {
    J(json: json)["distances"].array.map { d in
        ShapeLine(name: d["name"].text, metres: d["metres"].num ?? 0, weeks: d["weeks"].array.map { (week: $0["week"].text, s: $0["s"].num) }, from: d["weeks"].array.compactMap { $0["from"].str }.last)
    }.filter { l in l.weeks.filter { $0.s != nil }.count >= 2 }
}

func parseDurability(_ json: String) -> Durab {
    let d = J(json: json)
    return Durab(summary: d["summary"].text, runs: d["runs"].array.map { r in
        let mins = r["minutes"].int ?? 0
        let base = r["km"].num.map { "\(mins) min, \(km1($0)) km" } ?? "\(mins) min"
        return LongRun(date: r["date"].text, text: base + (r["steady"].bool ? "" : " (not steady)"), drift: r["drift_pct"].num ?? 0, steady: r["steady"].bool,
                       held: r["holds_until_min"].isNull ? "held to the end" : "slipped from \(r["holds_until_min"].int ?? 0) min")
    })
}

func parseWeek(_ json: String, _ planJson: String?) -> WeekV? {
    let w = J(json: json)
    guard w.object != nil else { return nil }
    let t = w["totals"], p = w["previous"]
    let start = w["start"].text
    let acts = w["days"].array.flatMap { d in d["activities"].raw.map { parseActivities(jsonText($0)) } ?? [] }
    var plan: String?
    if let pw = J(json: planJson)["weeks"].array.first(where: { $0["start"].text == start }) {
        let pkm = pw["planned"]["km"].num ?? 0
        let second = [pw["focus"].str, pkm > 0 ? "\(km1(pw["done"]["km"].num ?? 0)) of \(Int(pkm.rounded())) km" : nil].compactMap { $0 }.joined(separator: " · ")
        plan = "Plan: \(pw["done"]["sessions"].int ?? 0) of \(pw["planned"]["sessions"].int ?? 0) sessions done" + (second.isEmpty ? "" : "\n" + second)
    }
    return WeekV(
        start: start, end: w["end"].text, current: w["current"].bool, prev: w["prev"].str, next: w["next"].str,
        km: t["km"].num ?? 0, minutes: t["minutes"].num ?? 0, workouts: t["workouts"].int ?? 0, climb: t["climb"].num ?? 0, load: t["load"].num ?? 0,
        before: (km: p["km"].num ?? 0, minutes: p["minutes"].num ?? 0), usualLoad: w["usual"]["load"].num ?? 0,
        days: w["days"].array.map { WeekDay(date: $0["date"].text, km: $0["km"].num ?? 0, minutes: $0["minutes"].num ?? 0, workouts: $0["workouts"].int ?? 0, future: $0["future"].bool) },
        acts: acts,
        zones: w["zones"].array.map { ZoneShare(zone: $0["zone"].int ?? 0, name: $0["name"].text, seconds: $0["seconds"].num ?? 0) },
        sports: w["sports"].array.map { (sport: $0["sport"].text, km: $0["km"].num ?? 0, minutes: $0["minutes"].num ?? 0) },
        plan: plan
    )
}

/// What Progress has read, by range; the Week by its start. Read again only after a write (or a new day).
@MainActor
@Observable
final class ProgressModel {
    private let engine: EngineBridge
    var range = 84
    /** The week the Week range shows: nil, this week. */
    var weekOf: String?
    var dash: [Int: Dash] = [:]
    var shape: [Int: [ShapeLine]] = [:]
    var durability: [Int: Durab] = [:]
    var weeks: [String: WeekV] = [:]
    @ObservationIgnored private var readOn: String?
    @ObservationIgnored private var asked: Set<String> = []

    init(engine: EngineBridge) { self.engine = engine }

    func forget() {
        dash = [:]; shape = [:]; durability = [:]; weeks = [:]; asked = []
    }

    /** What the range (or the week) shows, read if it isn't yet. */
    func ensure() {
        let today = isoDay(Date())
        if readOn != today { forget(); readOn = today }
        if range == 7 {
            let key = weekOf ?? ""
            guard weeks[key] == nil, !asked.contains("w" + key) else { return }
            asked.insert("w" + key)
            Task {
                async let w = engine.get("/api/week\(weekOf.map { "?start=\($0)" } ?? "")")
                async let p = engine.get("/api/plan")
                if let wj = await w, let v = parseWeek(wj, await p) { weeks[key] = v } else { asked.remove("w" + key) }
            }
            return
        }
        let r = range
        guard dash[r] == nil, !asked.contains("r\(r)") else { return }
        asked.insert("r\(r)")
        Task {
            async let d = engine.get("/api/dashboard?days=\(r)")
            async let s = engine.get("/api/race-shape?weeks=\(min(52, max(8, r / 7)))")
            async let u = engine.get("/api/durability?weeks=\(max(8, r / 7))")
            if let j = await d, let v = parseDash(j) { dash[r] = v; if !v.weeks.isEmpty { Launch.ready("trends") } } else { asked.remove("r\(r)") }
            if let j = await s { shape[r] = parseShape(j) }
            if let j = await u { durability[r] = parseDurability(j) }
        }
    }
}
