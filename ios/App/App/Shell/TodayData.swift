import Foundation

/// A JSON value as the engine sends it, read loosely: a missing key or a null is nil, never a crash.
struct J {
    let raw: Any?

    init(_ raw: Any?) { self.raw = raw }

    init(json: String?) {
        guard let json, let data = json.data(using: .utf8) else { raw = nil; return }
        raw = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    }

    subscript(_ key: String) -> J { J((raw as? [String: Any])?[key]) }

    var isNull: Bool { raw == nil || raw is NSNull }
    var object: [String: Any]? { raw as? [String: Any] }
    var str: String? { raw as? String }
    /** A string, or "" (Android's optString). */
    var text: String { str ?? "" }
    var num: Double? {
        guard let n = raw as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        let d = n.doubleValue
        return d.isNaN ? nil : d
    }
    var int: Int? { num.map { Int($0) } }
    var bool: Bool { (raw as? NSNumber).map { $0.boolValue } ?? false }
    var array: [J] { (raw as? [Any])?.map { J($0) } ?? [] }
    var strings: [String] { (raw as? [Any])?.compactMap { $0 as? String } ?? [] }
    func has(_ key: String) -> Bool { object?[key] != nil }
}

/// What native Today shows, read from the same two routes the web Today reads: GET /api/today
/// (TodayView in web/types.ts) and GET /api/plan (PlanView). Only the fields drawn here.
/// Android's TodayData.kt is the reference.
struct Today {
    var readiness: Readiness
    var last: Last?
    var week: Week
    var takeaways: [Takeaway]
    /** Every session today (usually one), and on a rest day the next one. */
    var sessions: [Session]
    var next: Session?
    var race: RaceGoal?
    /** The plan covers today or days ahead (else no session or rest card). */
    var planOn: Bool
    /** The demo's sample data: Today says so, with the way out. */
    var sample: Bool
}

struct Readiness {
    let state: String
    let title: String
    let advice: String
    let why: String
    let fitness: Double
    let fatigue: Double
    let form: Double
}

struct Last {
    let id: String
    let name: String
    let sport: String
    let start: String
    let km: Double?
    let minutes: Double?
    let pace: String?
    let hr: Int?
    let label: String
    let effort: Double
    let rank: String?
    let estimated: Bool
    let feeling: Int?
    /** Seconds in each heart-rate zone, Z1 to Z5, and the top of Z2 (easy). */
    let zones: [Double]
    let easyCap: Int?
    /** A real run in the last day and a half: it leads Today as "Just in". */
    let justIn: Bool

    /** A recording started by accident: no effort or heart rate to read into. */
    var trivial: Bool { (km ?? 0) < 0.5 && (minutes ?? 0) < 5 }
}

struct Day: Identifiable {
    var id: String { date }
    let date: String
    let km: Double
    let future: Bool
}

struct Week {
    let days: [Day]
    let km: Double
    /** What the week is measured against: the plan's distance, else your target, else your usual week. */
    let goalKm: Double
    let goalSays: String?
    let workouts: Int
    let planDone: Int
    let planSessions: Int
}

struct Session: Identifiable {
    var id: String { "\(date):\(kind)" }
    let date: String
    let kind: String
    let title: String
    let detail: String
    let status: String
    let activityId: String?
    let did: String?
    let manual: Bool
    let notes: String?
    /** Which shoes, when you have more than one pair in use: name and why. */
    let shoe: (name: String, why: String)?
}

struct Takeaway: Identifiable {
    let tone: String
    let title: String
    let detail: String
    let activity: String?
    let id: String
    let date: String?
    /** A new personal best (engine id "pb-…"). */
    var best: Bool { id.hasPrefix("pb-") }
}

/// Your race: when, the target, and how the prediction compares. `json`: as the page has it, for race week.
struct RaceGoal {
    let name: String
    let km: Double
    let date: String?
    let targetS: Int?
    let daysToGo: Int?
    let predictedS: Int?
    let onTrack: Bool?
    let json: [String: Any]
    let countdown: Countdown?

    /** How the prediction moved over four weeks (minus: quicker), against the target (minus: quicker), and the taper. */
    struct Countdown {
        let daysToGo: Int
        let changeS: Int?
        let gapS: Int?
        let taper: Bool
    }
}

func parseToday(_ todayJson: String, _ planJson: String?, today: Date = Date(), now: Date = Date()) -> Today? {
    let t = J(json: todayJson)
    guard t.object != nil, t["readiness"].object != nil else { return nil }
    let r = t["readiness"]
    let readiness = Readiness(state: r["state"].text, title: r["title"].text, advice: r["advice"].text, why: r["why"].text, fitness: r["fitness"].num ?? 0, fatigue: r["fatigue"].num ?? 0, form: r["form"].num ?? 0)

    var last: Last?
    if t["last"].object != nil {
        let l = t["last"]
        let a = l["activity"]
        let zones = l["zones"].array
        let started = isoInstant(a["start"].text)
        let km = a["distance_km"].num
        let minutes = a["moving_min"].num
        let fresh = a["sport"].text.range(of: "run", options: .caseInsensitive) != nil && started != nil &&
            now.timeIntervalSince(started!) < 36 * 3600 && ((km ?? 0) >= 0.5 || (minutes ?? 0) >= 5)
        let cap = zones.count > 1 ? zones[1]["bpm"].array.dropFirst().first?.int : nil
        last = Last(
            id: a["id"].text, name: a["name"].str ?? sportTitle(a["sport"].text), sport: a["sport"].text, start: a["start_local"].str ?? a["start"].text,
            km: km, minutes: minutes, pace: a["avg_pace_min_km"].str, hr: a["avg_hr"].int, label: l["label"].text,
            effort: l["effort"].num ?? 0, rank: l["rank"].str, estimated: l["estimated"].bool, feeling: a["feeling"].int,
            zones: zones.map { $0["seconds"].num ?? 0 }, easyCap: cap, justIn: fresh
        )
    }

    let plan = J(json: planJson)
    let planWeek = plan["weeks"].array.first { $0["when"].text == "current" }
    let w = t["week"]
    let km = w["km"].num ?? 0
    var planKm = 0.0
    if let pw = planWeek {
        if let p = pw["planned"]["km"].num, p > 0 { planKm = p } else { planKm = pw["target_km"].num ?? 0 }
    }
    let targetKm = t["targets"]["week"]["target_km"].num ?? 0
    let usual = w["usual_km"].num ?? 0
    let goal: Double
    let says: String?
    if planKm > 0 { goal = planKm; says = "plan \(one(planKm)) km" }
    else if targetKm > 0 { goal = targetKm; says = "target \(one(targetKm)) km" }
    else if usual > 0 { goal = usual; says = "usual week \(one(usual)) km" }
    else { goal = 0; says = nil }
    let week = Week(
        days: w["days"].array.map { Day(date: $0["date"].text, km: $0["km"].num ?? 0, future: $0["future"].bool) },
        km: km, goalKm: goal, goalSays: says, workouts: w["workouts"].int ?? 0,
        planDone: planWeek?["done"]["sessions"].int ?? 0, planSessions: planWeek?["planned"]["sessions"].int ?? 0
    )

    let iso = isoDay(today)
    let picks = plan["shoe_picks"]
    func session(_ date: String, _ s: J) -> Session {
        var bits: [String] = []
        if let d = s["duration_min"].num { bits.append(duration(d)) }
        if let d = s["distance_km"].num { bits.append("\(one(d)) km") }
        if let target = s["target"].str { bits.append(tidyTarget(target, kind: s["kind"].text)) }
        let a = s["activity"]
        var did: String?
        if a.object != nil {
            let parts = [a["distance_km"].num.map { "\(one($0)) km" }, a["moving_min"].num.map(duration)].compactMap { $0 }
            did = "Did " + (parts.isEmpty ? (a["name"].str ?? a["sport"].text) : parts.joined(separator: " · "))
        }
        let pick = picks["\(date):\(s["kind"].text)"]
        let shoe = pick.object != nil ? (name: pick["name"].text, why: pick["why"].text) : nil
        return Session(date: date, kind: s["kind"].text, title: s["title"].text, detail: bits.joined(separator: " · "), status: s["status"].text,
                       activityId: a["id"].str, did: did, manual: s["manual"].bool, notes: s["notes"].str, shoe: shoe)
    }
    let days = plan["weeks"].array.flatMap { $0["days"].array }
    let sessions = (days.first { $0["date"].text == iso }?["sessions"].array ?? []).filter { $0["kind"].text != "rest" }.map { session(iso, $0) }
    var next: Session?
    for d in days where d["date"].text > iso {
        if let s = d["sessions"].array.first(where: { $0["kind"].text != "rest" }) { next = session(d["date"].text, s); break }
    }
    let planOn = plan["plan"].object != nil && (planWeek != nil || next != nil)

    var race: RaceGoal?
    let rr = t["targets"]["race"]
    if let obj = rr.object {
        let c = rr["countdown"]
        let countdown = c.object != nil ? RaceGoal.Countdown(daysToGo: c["days_to_go"].int ?? 0, changeS: c["change_s"].int, gapS: c["gap_s"].int, taper: c.has("taper")) : nil
        let distance = rr["distance_km"].num ?? 0
        race = RaceGoal(
            name: rr["name"].str ?? "\(one(distance)) km race", km: distance, date: rr["date"].str, targetS: rr["target_s"].int,
            daysToGo: rr["days_to_go"].int, predictedS: rr["predicted_s"].int, onTrack: rr["on_track"].isNull ? nil : rr["on_track"].bool,
            json: obj, countdown: countdown
        )
    }
    let takeaways = t["takeaways"].array.map { Takeaway(tone: $0["tone"].text, title: $0["title"].text, detail: $0["detail"].text, activity: $0["activity"].str, id: $0["id"].text, date: $0["date"].str) }
    return Today(readiness: readiness, last: last, week: week, takeaways: takeaways, sessions: sessions, next: sessions.isEmpty ? next : nil, race: race, planOn: planOn, sample: t["sample"].bool)
}

// MARK: - The morning check, vitals, race week, notes (Android's TodayMore.kt)

/// The morning check (GET/PUT /api/readiness): what you said, and the verdict.
struct Check {
    let date: String
    let sleep: Int?
    let legs: Int?
    let pain: (area: String, level: Int)?
    let answered: Bool
    /** The watch measured last night: sleep isn't asked. */
    let measured: Bool
    let level: String
    let reasons: [String]
    let sessionTitle: String?
    let sessionKind: String?
    let sessionDone: Bool
    let swappedFrom: String?
    let swapKind: String?
    let suggestSwap: Bool

    var verdict: String {
        switch level {
        case "ready": return "Ready for today."
        case "rest": return "Rest or go very easy today."
        default: return "Go easy today."
        }
    }

    var why: String {
        let s = reasons.joined(separator: ", ")
        guard let first = s.first else { return "" }
        return first.uppercased() + s.dropFirst() + "."
    }

    /** Every question asked is answered: legs, and sleep when the watch didn't measure the night. */
    var complete: Bool { legs != nil && (measured || sleep != nil) }
}

func parseCheck(_ json: String) -> Check? {
    let r = J(json: json)
    guard r.object != nil else { return nil }
    let c = r["checkin"]
    let v = r["readiness"]
    let s = r["session"]
    let pain = c["pain"].object != nil ? (area: c["pain"]["area"].text, level: c["pain"]["level"].int ?? 0) : nil
    return Check(
        date: r["date"].text, sleep: c["sleep"].int, legs: c["legs"].int, pain: pain, answered: c.object != nil,
        measured: !r["sleep_measured"].isNull, level: v["level"].str ?? "ready", reasons: v["reasons"].strings,
        sessionTitle: s["title"].str.flatMap { $0.isEmpty ? nil : $0 }, sessionKind: s["kind"].str.flatMap { $0.isEmpty ? nil : $0 }, sessionDone: s["done"].bool,
        swappedFrom: s["swapped_from"].str.flatMap { $0.isEmpty ? nil : $0 }, swapKind: s["swap_kind"].str.flatMap { $0.isEmpty ? nil : $0 }, suggestSwap: r["suggest_swap"].bool
    )
}

/// This morning's body as the watch measured it: resting heart rate against your usual, last night, oxygen.
struct Vitals {
    let rest: Int?
    let restDiff: Int?
    let sleepMin: Double?
    let oxygen: Double?
    var any: Bool { rest != nil || sleepMin != nil || oxygen != nil }
}

func parseVitals(_ json: String, today: Date = Date()) -> Vitals? {
    let h = J(json: json)
    let days = h["days"].array
    if days.isEmpty && h["latest"].isNull { return nil }
    let iso = isoDay(today)
    let day = days.first { $0["date"].text == iso }
    let rest = days.first { $0["resting_hr"].num != nil }?["resting_hr"].int
    let base = h["resting_baseline"].int
    let sleep = day?["sleep"]["minutes"]["asleep"].num ?? day?["night"]["minutes"].num
    let oxygen = days.flatMap { d -> [Double] in Array(d["spo2"].array.compactMap { $0["pct"].num }.reversed()) }.first
    return Vitals(rest: rest, restDiff: rest != nil && base != nil ? rest! - base! : nil, sleepMin: sleep, oxygen: oxygen)
}

/// Race week (src/race-week.ts, via the page): focus, pacing, fuel and the checklist.
struct RaceWeek {
    let daysToGo: Int
    let focusTitle: String
    let focusText: String
    let pacing: Pacing?
    let fuel: [String]
    let checklist: [String]

    struct Pacing {
        let timeS: Int
        let paceS: Double
        let fromTarget: Bool
        let checkpoints: [(km: Double, timeS: Int)]
        let start: String
    }
}

func parseRaceWeek(_ json: String) -> RaceWeek? {
    let w = J(json: json)
    guard w.object != nil else { return nil }
    let f = w["focus"]
    let p = w["pacing"]
    let pacing = p.object != nil ? RaceWeek.Pacing(
        timeS: p["time_s"].int ?? 0, paceS: p["pace_s"].num ?? 0, fromTarget: p["from"].text == "target",
        checkpoints: p["checkpoints"].array.map { (km: $0["at_km"].num ?? 0, timeS: $0["time_s"].int ?? 0) }, start: p["start"].text
    ) : nil
    return RaceWeek(daysToGo: w["days_to_go"].int ?? 0, focusTitle: f["title"].text, focusText: f["text"].text, pacing: pacing,
                    fuel: w["fuel"]["before"].strings + w["fuel"]["during"].strings, checklist: w["checklist"].strings)
}

/// A note on Today about shoes: found on Strava (once), or asking which you run in.
struct ShoesNote {
    let title: String
    let text: String
    let go: String
    let quiet: String
    let key: String
}

// MARK: - Words and numbers, as the web writes them

private let posix = Locale(identifier: "en_US_POSIX")

/** A day as the engine writes it: 2026-11-20, in the phone's time zone. */
func isoDay(_ d: Date) -> String {
    let f = DateFormatter()
    f.locale = posix
    f.calendar = Calendar(identifier: .gregorian)
    f.dateFormat = "yyyy-MM-dd"
    return f.string(from: d)
}

func dateOf(_ iso: String) -> Date? {
    let f = DateFormatter()
    f.locale = posix
    f.calendar = Calendar(identifier: .gregorian)
    f.dateFormat = "yyyy-MM-dd"
    return f.date(from: String(iso.prefix(10)))
}

/** An instant (2026-11-20T07:12:00Z, with or without fractions). */
func isoInstant(_ s: String) -> Date? {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f.date(from: s) { return d }
    f.formatOptions = [.withInternetDateTime]
    return f.date(from: s)
}

/** Whole days from a best's date to today; -1 if it can't be read. */
func daysSince(_ iso: String, _ today: Date = Date()) -> Int {
    let cal = Calendar.current
    guard let d = isoInstant(iso) ?? dateOf(iso) else { return -1 }
    return cal.dateComponents([.day], from: cal.startOfDay(for: d), to: cal.startOfDay(for: today)).day ?? -1
}

func one(_ x: Double) -> String {
    x == x.rounded() ? String(Int(x)) : String(format: "%.1f", x)
}

func km1(_ x: Double) -> String { String(format: "%.1f", x) }

func kmText(_ x: Double) -> String { String(format: x < 10 ? "%.1f" : "%.0f", x) }

/** Minutes as the web writes them: "45 min", "1 h 05". */
func duration(_ min: Double) -> String {
    let m = Int(min.rounded())
    return m < 60 ? "\(m) min" : "\(m / 60) h \(String(format: "%02d", m % 60))"
}

/** Minutes as a clock: "45:10", "1:05". */
func clockMin(_ min: Double) -> String {
    let s = Int((min * 60).rounded())
    let h = s / 3600
    let m = (s % 3600) / 60
    return h > 0 ? "\(h):\(String(format: "%02d", m))" : "\(m):\(String(format: "%02d", s % 60))"
}

/** Seconds as a race clock: "25:30", "1:52:10". */
func clock(_ s: Int) -> String {
    let h = s / 3600
    let m = (s % 3600) / 60
    let sec = s % 60
    return h > 0 ? "\(h):\(String(format: "%02d", m)):\(String(format: "%02d", sec))" : "\(m):\(String(format: "%02d", sec))"
}

let KIND_LABEL = ["easy": "Easy", "long": "Long", "tempo": "Tempo", "intervals": "Intervals", "hills": "Hills", "recovery": "Recovery", "race": "Race", "strength": "Strength", "cross": "Cross-training", "rest": "Rest"]

/** The session's kind as a word, unless its name already says it. */
func kindWord(_ kind: String, _ title: String) -> String? {
    guard let w = KIND_LABEL[kind] ?? (kind.isEmpty ? nil : kind) else { return nil }
    return title.range(of: w, options: .caseInsensitive) != nil ? nil : w
}

/** A target as read: ranges with a proper dash, without a leading kind word the line already says. */
func tidyTarget(_ target: String, kind: String?) -> String {
    let ranged = target.replacingOccurrences(of: #"(\d)\s?-\s?(\d)"#, with: "$1–$2", options: .regularExpression)
    if let kind, let word = KIND_LABEL[kind], ranged.lowercased().hasPrefix(word.lowercased() + ", ") {
        return String(ranged.dropFirst(word.count + 2))
    }
    return ranged
}

func dateShort(_ iso: String) -> String {
    guard let d = dateOf(iso) else { return iso }
    return d.formatted(.dateTime.day().month(.abbreviated))
}

func dayName(_ iso: String) -> String {
    guard let d = dateOf(iso) else { return "" }
    return d.formatted(.dateTime.weekday(.abbreviated))
}

/** "Fri 20 Nov · 07:12" from the workout's local start. */
func whenText(_ start: String) -> String {
    let f = DateFormatter()
    f.locale = posix
    f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
    guard let d = f.date(from: String(start.prefix(19))) else { return start }
    return d.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated)) + " · " + d.formatted(.dateTime.hour().minute())
}

/** Where it niggles, head to toe (lib/areas.ts). */
let AREAS = ["back", "hip", "hamstring", "quad", "knee", "shin", "calf", "achilles", "ankle", "foot", "other"]
private let AREA_NAME = ["foot": "Foot", "ankle": "Ankle", "achilles": "Achilles", "calf": "Calf", "shin": "Shin", "knee": "Knee", "hamstring": "Hamstring", "quad": "Thigh", "hip": "Hip", "back": "Back", "other": "Elsewhere"]
func areaName(_ a: String) -> String { AREA_NAME[a] ?? a.capitalized }

/** A workout without a name: its sport, as a title ("running" → "Running"). */
func sportTitle(_ sport: String) -> String {
    guard let f = sport.first else { return "Workout" }
    return f.uppercased() + sport.dropFirst().replacingOccurrences(of: "_", with: " ")
}

let FEELING = [1: "Poor", 2: "Average", 3: "Good", 4: "Very good", 5: "Excellent"]
