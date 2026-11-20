import Foundation

// What the session and workout sheets show (Android's SessionData.kt and WorkoutData.kt).

/// One planned session as its sheet shows it (web/types.ts PlanSession, from GET /api/plan).
struct PlanSession {
    let date: String
    let today: String
    let kind: String
    let title: String
    let status: String
    let minutes: Double?
    let km: Double?
    let target: String?
    let notes: String?
    /** The structured session, block by block: "3 ×" and "Run 1 km, then Recover 2 min". */
    let steps: [(repeats: Int, text: String)]
    /** Strength: the exercises as the plan has them, for the page's routine. */
    let exercises: [Any]
    let manual: Bool
    let activityId: String?
    let did: String?
    let adjusted: (shiftS: Int, reason: String)?
    /** Strength logged in the app: finished, records; nil when not started. */
    let lift: (finished: Bool, records: Int)?
    let conversation: String?

    var canMark: Bool { activityId == nil && !manual && (status == "missed" || status == "today") }
    var strength: Bool { kind == "strength" || !exercises.isEmpty }
    var liftable: Bool { kind == "strength" && date <= today }
    /** "Today", or "Thu 30 Oct". */
    var whenText: String { date == today ? "Today" : "\(dayName(date)) \(dateShort(date))" }
}

private let STEP = ["warmup": "Warm up", "run": "Run", "recover": "Recover", "cooldown": "Cool down"]

func findSession(_ planJson: String, date: String, kind: String?) -> PlanSession? {
    let v = J(json: planJson)
    guard let day = v["weeks"].array.flatMap({ $0["days"].array }).first(where: { $0["date"].text == date }) else { return nil }
    guard let s = day["sessions"].array.first(where: { $0["kind"].text != "rest" && (kind == nil || $0["kind"].text == kind) }) else { return nil }
    func len(_ x: J) -> String {
        if let m = x["distance_m"].num { return m >= 1000 ? "\(one(m / 1000)) km" : "\(Int(m)) m" }
        if let d = x["duration_s"].num { return duration(d / 60) }
        return ""
    }
    let steps = s["steps"].array.map { b -> (repeats: Int, text: String) in
        let text = b["steps"].array.map { x in [STEP[x["kind"].text] ?? x["kind"].text, len(x)].filter { !$0.isEmpty }.joined(separator: " ") }.joined(separator: ", then ")
        return (repeats: b["repeat"].int ?? 1, text: text)
    }
    let a = s["activity"]
    var did: String?
    if a.object != nil {
        let parts = [a["distance_km"].num.map { "\(one($0)) km" }, a["moving_min"].num.map(duration)].compactMap { $0 }
        did = "Did " + (parts.isEmpty ? (a["name"].str ?? a["sport"].text) : parts.joined(separator: " · "))
    }
    let lift = v["lifts"][date]
    let adj = s["adjusted"]
    return PlanSession(
        date: date, today: v["today"].text, kind: s["kind"].text, title: s["title"].text, status: s["status"].text,
        minutes: s["duration_min"].num, km: s["distance_km"].num, target: s["target"].str, notes: s["notes"].str.flatMap { $0.isEmpty ? nil : $0 },
        steps: steps, exercises: (s["exercises"].raw as? [Any]) ?? [], manual: s["manual"].bool,
        activityId: a["id"].str, did: did,
        adjusted: adj.object != nil ? (shiftS: adj["shift_s"].int ?? 0, reason: adj["reason"].text) : nil,
        lift: lift.object != nil ? (finished: lift["finished"].bool, records: lift["prs"].int ?? 0) : nil,
        conversation: v["plan"]["conversation"].str
    )
}

/// How a done session went against its plan (GET /api/plan/review).
struct Review {
    struct Step { let label: String; let sub: String; let actual: String; let verdict: String; let off: String }
    let summary: String
    let inRange: Double?
    let steps: [Step]
    let error: String?
}

func parseReview(_ json: String) -> Review? {
    let r = J(json: json)
    guard r.object != nil else { return nil }
    if let e = r["error"].str { return Review(summary: "", inRange: nil, steps: [], error: e) }
    func len(_ st: J) -> String {
        let m = st["metres"].num ?? 0, s = st["seconds"].num ?? 0
        return m >= 950 ? String(format: "%.2f km", m / 1000) : s > 0 ? duration(s / 60) : ""
    }
    return Review(
        summary: r["summary"].text, inRange: r["inRange"].num,
        steps: r["steps"].array.map { Review.Step(label: $0["label"].text, sub: [len($0), $0["target"].text].filter { !$0.isEmpty }.joined(separator: " · "), actual: $0["actual"].text, verdict: $0["verdict"].text, off: $0["off"].text) },
        error: nil
    )
}

/// A strength routine (rpc:routine): its exercises and what they work.
struct Routine {
    struct Exercise: Identifiable { let id: String; let name: String; let kind: String; let equipment: String?; let dose: String; let cues: [String]; let why: String }
    let basic: Bool
    let primary: [String]
    let secondary: [String]
    let names: [String: String]
    let items: [Exercise]
}

func parseRoutine(_ json: String) -> Routine? {
    let r = J(json: json)
    guard r.object != nil else { return nil }
    var names: [String: String] = [:]
    for (k, v) in r["names"].object ?? [:] { if let s = v as? String { names[k] = s } }
    return Routine(
        basic: r["basic"].bool, primary: r["primary"].strings, secondary: r["secondary"].strings, names: names,
        items: r["items"].array.map { Routine.Exercise(id: $0["id"].text, name: $0["name"].text, kind: $0["kind"].text, equipment: $0["equipment"].str, dose: $0["dose"].text, cues: $0["cues"].strings, why: $0["why"].text) }
    )
}

// MARK: - A workout

/// One source's copy of a workout: what that source measured.
struct Copy {
    let source: String
    let start: String?
    let distanceM: Double?
    let movingS: Double?
    let elapsedS: Double?
    let avgSpeed: Double?
    let avgHr: Double?
    let maxHr: Double?
    let elevationM: Double?
    let hasStreams: Bool
}

struct Split { let n: Int; let speed: Double?; let hr: Double?; let elev: Double? }
struct HrZone { let zone: Int; let name: String; let seconds: Double; let lo: Int; let hi: Int }
struct Effort { let load: Double; let estimated: Bool; let label: String; let rank: String? }

/// A workout as its sheet shows it (GET /api/activity/:id, web/types.ts ActivityView).
struct Workout {
    let id: String
    let start: String
    let startLocal: String?
    let sport: String
    let name: String?
    let device: String?
    let description: String?
    let distanceKm: Double?
    let movingMin: Double?
    let elevationM: Double?
    let avgHr: Int?
    let maxHr: Int?
    let pace: String?
    let speedKmh: Double?
    let calories: Double?
    let feeling: Int?
    let copies: [Copy]
    let provenance: [String: String]
    let splits: [Split]
    let route: [(lat: Double, lon: Double)]
    let distance: [Double?]
    let velocity: [Double?]
    let heartrate: [Double?]
    let altitude: [Double?]
    let streamsFrom: String?
    let zones: [HrZone]
    let load: Effort?

    var isRun: Bool { sport.range(of: "run|walk|hik|trail|treadmill", options: [.regularExpression, .caseInsensitive]) != nil }
    /** Counts to a pair of shoes. */
    var shod: Bool { sport.range(of: "run|jog|trail|treadmill", options: [.regularExpression, .caseInsensitive]) != nil }
}

private func numbers(_ j: J) -> [Double?] { (j.raw as? [Any])?.map { J($0).num } ?? [] }

func parseWorkout(_ json: String) -> Workout? {
    let v = J(json: json)
    let a = v["detail"]
    guard a.object != nil else { return nil }
    let s = v["streams"]["streams"]
    let route: [(lat: Double, lon: Double)] = s["latlng"].array.compactMap { p in
        let xy = p.array
        guard xy.count == 2, let la = xy[0].num, let lo = xy[1].num else { return nil }
        return (lat: la, lon: lo)
    }
    var prov: [String: String] = [:]
    for (k, x) in a["provenance"].object ?? [:] { if let s = x as? String { prov[k] = s } }
    let load = v["load"]
    return Workout(
        id: a["id"].text, start: a["start"].text, startLocal: a["start_local"].str, sport: a["sport"].text, name: a["name"].str, device: a["device"].str, description: a["description"].str.flatMap { $0.isEmpty ? nil : $0 },
        distanceKm: a["distance_km"].num, movingMin: a["moving_min"].num, elevationM: a["elevation_m"].num,
        avgHr: a["avg_hr"].num.map { Int($0.rounded()) }, maxHr: a["max_hr"].num.map { Int($0.rounded()) },
        pace: a["avg_pace_min_km"].str, speedKmh: a["avg_speed_kmh"].num, calories: a["calories"].num, feeling: a["feeling"].num.map { Int($0.rounded()) },
        copies: a["copies"].array.map { c in
            Copy(source: c["source"].text, start: c["start"].str, distanceM: c["distance_m"].num, movingS: c["moving_s"].num, elapsedS: c["elapsed_s"].num,
                 avgSpeed: c["avg_speed"].num, avgHr: c["avg_hr"].num, maxHr: c["max_hr"].num, elevationM: c["elevation_m"].num, hasStreams: c["has_streams"].bool)
        },
        provenance: prov,
        splits: a["splits_metric"].array.map { Split(n: $0["split"].int ?? 0, speed: $0["average_speed"].num, hr: $0["average_heartrate"].num, elev: $0["elevation_difference"].num) },
        route: route, distance: numbers(s["distance"]), velocity: numbers(s["velocity"]), heartrate: numbers(s["heartrate"]), altitude: numbers(s["altitude"]),
        streamsFrom: v["streams"]["from"].str,
        zones: v["zones"].array.map { z in HrZone(zone: z["zone"].int ?? 0, name: z["name"].text, seconds: z["seconds"].num ?? 0, lo: z["bpm"].array.first?.int ?? 0, hi: z["bpm"].array.dropFirst().first?.int ?? 0) },
        load: load.object != nil ? Effort(load: load["load"].num ?? 0, estimated: load["estimated"].bool, label: load["label"].text, rank: load["rank"].str) : nil
    )
}

/// A run, finished (src/run-finish.ts RunFinish): against the plan, records, last time, next time.
struct Finish {
    struct PlanDone { let title: String; let summary: String?; let onTarget: Int?; let total: Int? }
    struct Record { let name: String; let timeS: Int; let rank: Int }
    struct Last { let date: String; let name: String?; let pace: String?; let hr: Int?; let nowPace: String?; let nowHr: Int?; let verdict: String; let text: String }
    struct Next { let date: String; let kind: String; let title: String; let rule: String; let why: String; let shiftS: Int?; let applied: Bool }
    let plan: PlanDone?
    let records: [Record]
    let last: Last?
    let next: Next?
    var empty: Bool { plan == nil && records.isEmpty && last == nil && next == nil }
}

func parseFinish(_ json: String) -> Finish? {
    let f = J(json: json)
    guard f.object != nil else { return nil }
    let p = f["plan"], l = f["last"], n = f["next"]
    let out = Finish(
        plan: p.object != nil ? Finish.PlanDone(title: p["title"].text, summary: p["summary"].str, onTarget: p["work"]["onTarget"].int, total: p["work"]["total"].int) : nil,
        records: f["records"].array.map { Finish.Record(name: $0["name"].text, timeS: $0["time_s"].int ?? 0, rank: $0["rank"].int ?? 0) },
        last: l.object != nil ? Finish.Last(date: l["date"].text, name: l["name"].str, pace: l["pace"].str, hr: l["hr"].num.map { Int($0.rounded()) },
                                            nowPace: l["now"]["pace"].str, nowHr: l["now"]["hr"].num.map { Int($0.rounded()) }, verdict: l["verdict"].text, text: l["text"].text) : nil,
        next: n.object != nil ? Finish.Next(date: n["date"].text, kind: n["kind"].text, title: n["title"].text, rule: n["rule"].text, why: n["why"].text, shiftS: n["shift_s"].num.map { Int($0.rounded()) }, applied: n["applied"].bool) : nil
    )
    return out.empty ? nil : out
}

struct RunNote: Identifiable, Equatable { let id: String; let tag: String; let text: String; let area: String? }
struct Shoe: Identifiable { let id: String; let name: String; let retired: Bool }

func parseNotes(_ j: J) -> [RunNote] {
    j["notes"].array.map { RunNote(id: $0["id"].text, tag: $0["tag"].text, text: $0["text"].text, area: $0["area"].str) }
}

/// The words on the web (lib/dom.ts, src/run-notes.ts).
enum Words {
    static let rule = ["faster": "Faster", "easier": "Easier", "hold": "Same again", "on target": "Right on", "slow down": "Slow down"]
    static let rank = ["", "Best", "2nd best", "3rd best"]
    static let distance = ["400m": "400 m", "1k": "1 km", "1 mile": "Mile", "5k": "5 km", "10k": "10 km", "15k": "15 km", "Half-Marathon": "half marathon", "30k": "30 km", "Marathon": "Marathon"]
    static let source = ["watch": "Watch", "strava": "Strava", "phone": "Phone", "suunto-cloud": "Cloud"]
    static let sourceLong = ["watch": "Watch", "strava": "Strava", "phone": "Recorded on this phone", "suunto-cloud": "Suunto cloud export"]
    static let order = ["watch", "strava", "phone", "suunto-cloud"]
    static let verdict = ["on target": "On target", "fast": "Fast", "slow": "Slow", "high": "High", "low": "Low", "no data": "No data", "not done": "Not done", "done": "Done"]
}

/// The streams on even distance steps (the charts are drawn by index), smoothed.
struct Along {
    let km: [Double]
    let pace: [Double?]?
    let hr: [Double?]?
    let alt: [Double?]?
}

func alongTheWay(_ w: Workout, n: Int = 160) -> Along {
    guard !w.distance.isEmpty else { return Along(km: [], pace: nil, hr: nil, alt: nil) }
    var last = 0.0
    let x = w.distance.map { d -> Double in last = d ?? last; return last / 1000 }
    let total = x.last ?? 0
    guard total > 0 else { return Along(km: [], pace: nil, hr: nil, alt: nil) }
    let steps = (0..<n).map { Double($0) * total / Double(n - 1) }
    var idx = [Int](repeating: 0, count: n)
    var j = 0
    for (k, s) in steps.enumerated() {
        while j < x.count - 1 && x[j + 1] <= s { j += 1 }
        idx[k] = j
    }
    func smooth(_ v: [Double?], _ win: Int) -> [Double?] {
        v.indices.map { i in
            let ok = (max(0, i - win)...min(v.count - 1, i + win)).compactMap { v[$0] }.filter { $0.isFinite }
            return ok.isEmpty ? nil : ok.reduce(0, +) / Double(ok.count)
        }
    }
    func pick(_ v: [Double?]) -> [Double?] { idx.map { $0 < v.count ? v[$0] : nil } }
    let pace = w.velocity.contains { ($0 ?? 0) > 0 } ? pick(smooth(w.velocity.map { s in s.flatMap { $0 > 0.6 ? (w.isRun ? 1000 / $0 : $0 * 3.6) : nil } }, 4)) : nil
    let hr = w.heartrate.contains { ($0 ?? 0) > 0 } ? pick(smooth(w.heartrate, 2)) : nil
    let alt = w.altitude.contains { $0 != nil } ? pick(smooth(w.altitude, 2)) : nil
    return Along(km: steps, pace: pace, hr: hr, alt: alt)
}
