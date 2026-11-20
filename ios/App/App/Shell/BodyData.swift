import SwiftUI
import Observation

// Body: the muscles now, sleep and the watch's vitals (Android's BodyScreen.kt and BodyMap.kt).

/** The muscles in the app's order (src/strength/exercises.ts MUSCLES). */
let MUSCLES = ["traps", "delts", "chest", "biceps", "triceps", "forearms", "lats", "upper_back", "lower_back",
               "abs", "obliques", "hip_flexors", "glutes", "glute_med", "adductors", "quads", "hamstrings", "calves", "tibialis"]

let MUSCLE_NAME = ["traps": "Traps", "delts": "Shoulders", "chest": "Chest", "biceps": "Biceps", "triceps": "Triceps", "forearms": "Forearms",
                   "lats": "Lats", "upper_back": "Upper back", "lower_back": "Lower back", "abs": "Abs", "obliques": "Obliques",
                   "hip_flexors": "Hip flexors", "glutes": "Glutes", "glute_med": "Side glutes", "adductors": "Inner thighs", "quads": "Quads",
                   "hamstrings": "Hamstrings", "calves": "Calves", "tibialis": "Shins"]

func muscleName(_ m: String) -> String { MUSCLE_NAME[m] ?? m }

/// One muscle now (src/fatigue.ts MuscleState).
struct MuscleNow {
    struct Cause { let date: String; let what: String; let kind: String; let share: Double }
    let level: Int
    let state: String
    let freshInH: Double?
    let score: Double
    let lastWorked: String?
    let causes: [Cause]
    let sore: (area: String, level: Int, date: String)?
}

/// The watch's figures for Body (GET /api/health).
struct Health {
    let restHr: Int?
    let restDate: String?
    let baseline: Int?
    let sleep: String?
    let sleepNote: String?
    let oxygen: Double?
    let oxygenAt: String?
    let steps: Int
    let activeKcal: Double?
    let todayHr: [Double?]
    let latestAt: String?
}

func parseBody(_ json: String) -> [String: MuscleNow] {
    let ms = J(json: json)["muscles"]
    var out: [String: MuscleNow] = [:]
    for m in MUSCLES {
        let s = ms[m]
        let sore = s["sore"]
        out[m] = MuscleNow(level: s["level"].int ?? 0, state: s["state"].str ?? "fresh", freshInH: s["fresh_in_h"].num, score: s["score"].num ?? 0, lastWorked: s["last_worked"].str,
                           causes: s["causes"].array.map { MuscleNow.Cause(date: $0["date"].text, what: $0["what"].text, kind: $0["kind"].text, share: $0["share"].num ?? 0) },
                           sore: sore.object != nil ? (area: sore["area"].text, level: sore["level"].int ?? 0, date: sore["date"].text) : nil)
    }
    return out
}

func parseHealth(_ json: String, today: Date = Date()) -> Health {
    let h = J(json: json)
    let days = h["days"].array
    let iso = isoDay(today)
    let day = days.first { $0["date"].text == iso }
    let rest = days.first { $0["resting_hr"].num != nil }
    func hm(_ t: Double) -> String { Date(timeIntervalSince1970: t / 1000).formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)) }
    var sleep: String?, note: String?
    if let sl = day?["sleep"], sl.object != nil {
        let m = sl["minutes"]
        let stages = (m["deep"].num ?? 0) + (m["rem"].num ?? 0) > 0 ? " · deep \(duration(m["deep"].num ?? 0)) · REM \(duration(m["rem"].num ?? 0))" : ""
        sleep = duration(m["asleep"].num ?? 0)
        note = "\(hm(sl["start"].num ?? 0))–\(hm(sl["end"].num ?? 0))\(stages)\(day?["hrv_ms"].num.map { " · HRV \(Int($0)) ms" } ?? "")"
    } else if let n = day?["night"], n.object != nil {
        sleep = duration(n["minutes"].num ?? 0)
        note = "\(n["start"].text.dropFirst(11).prefix(5))–\(n["end"].text.dropFirst(11).prefix(5)) · about \(n["hr_avg"].int ?? 0) bpm · estimated"
    }
    let ox = days.flatMap { d in Array(d["spo2"].array.reversed()) }.first
    return Health(restHr: rest?["resting_hr"].int, restDate: rest?["date"].str, baseline: h["resting_baseline"].int, sleep: sleep, sleepNote: note,
                  oxygen: ox?["pct"].num, oxygenAt: ox?["at"].str, steps: day?["steps"].int ?? 0, activeKcal: day?["active_kcal"].num,
                  todayHr: (h["today_hr"].raw as? [Any])?.map { J($0).num } ?? [], latestAt: h["latest"]["at"].str)
}

/** "today", "yesterday", or the weekday. */
func whenDay(_ date: String, today: Date = Date()) -> String {
    let d = String(date.prefix(10))
    if d == isoDay(today) { return "today" }
    if let y = Calendar.current.date(byAdding: .day, value: -1, to: today), d == isoDay(y) { return "yesterday" }
    return dateOf(d)?.formatted(.dateTime.weekday(.wide)) ?? date
}

/** "today", "yesterday", "on Monday" this week, else "on 3 Oct". */
func onDay(_ date: String, today: Date = Date()) -> String {
    guard let d = dateOf(date) else { return date }
    let days = Calendar.current.dateComponents([.day], from: Calendar.current.startOfDay(for: d), to: Calendar.current.startOfDay(for: today)).day ?? 0
    let w = whenDay(date, today: today)
    return days <= 1 && days >= 0 ? w : days < 7 ? "on \(w)" : "on \(dateShort(date))"
}

/** "about 20 h", "about 2 days". */
func inHours(_ h: Double) -> String { h < 36 ? "about \(max(1, Int(h.rounded()))) h" : "about \(Int((h / 24).rounded())) days" }

private func names(_ ms: [String]) -> String {
    let n = ms.map { muscleName($0).lowercased() }
    if n.count < 2 { return n.first ?? "" }
    return n.dropLast().joined(separator: ", ") + " and " + n.last!
}

private func list3(_ ms: [String]) -> String { ms.count > 3 ? ms.prefix(3).map { muscleName($0).lowercased() }.joined(separator: ", ") + " and more" : names(ms) }

/** Muscles with anything in them (or sore), most tired first. */
func needing(_ b: [String: MuscleNow]) -> [String] {
    MUSCLES.filter { (b[$0]?.level ?? 0) > 0 || b[$0]?.sore != nil }.sorted { (b[$0]?.score ?? 0) > (b[$1]?.score ?? 0) }
}

/** One line on the body as a whole (web/views/you.ts summary). */
func bodySummary(_ b: [String: MuscleNow]) -> String {
    let tired = MUSCLES.filter { b[$0]?.state == "fatigued" }
    let rec = MUSCLES.filter { b[$0]?.state == "recovering" }
    func cap(_ s: String) -> String { s.prefix(1).uppercased() + s.dropFirst() }
    if tired.isEmpty && rec.isEmpty {
        let light = MUSCLES.filter { (b[$0]?.level ?? 0) > 0 }
        return light.isEmpty ? "Everything's fresh. Nothing from your last workouts is still in your muscles." : "Fresh. \(cap(list3(light))) carry a little from your last workouts, nothing that needs time."
    }
    let lead = tired.isEmpty ? rec : tired
    let top = lead.compactMap { b[$0]?.causes.first }.max { $0.share < $1.share }
    let what = top.map { c in ", mostly from \(c.what.lowercased().hasPrefix("the ") ? c.what : "your \(c.what)") \(onDay(c.date))" } ?? ""
    let verb = lead.count == 1 ? "is" : "are"
    return "\(cap(list3(lead))) \(verb) \(tired.isEmpty ? "still recovering" : "worked hard")\(what)."
}

/// The heat scale's five steps, from quiet to the tint.
enum Heat {
    static func shades(_ dark: Bool) -> [Color] {
        let base: (Double, Double, Double) = dark ? (0.27, 0.25, 0.24) : (0.86, 0.83, 0.82)
        let tint: (Double, Double, Double) = dark ? (0.886, 0.353, 0.263) : (0.659, 0.196, 0.122)
        return [0, 0.24, 0.46, 0.70, 1].map { k in
            Color(red: base.0 + (tint.0 - base.0) * k, green: base.1 + (tint.1 - base.1) * k, blue: base.2 + (tint.2 - base.2) * k)
        }
    }
}

/// The 2D muscle map's outlines: MuscleMap by Melih Colpan, MIT (vendor/MuscleMap-LICENSE), from
/// musclemap.json in the app (scripts/musclemap-asset.ts writes it for Android and iOS).
final class MuscleMap: @unchecked Sendable {
    struct Part { let name: String; let path: Path; let body: Bool; let other: Bool }
    struct View2 { let x: CGFloat; let y: CGFloat; let w: CGFloat; let h: CGFloat; let parts: [Part] }
    struct Figure { let front: View2; let back: View2 }

    static let bodyParts: Set<String> = ["head", "hair", "neck", "hands", "feet", "knees", "ankles"]
    static let otherParts: Set<String> = ["serratus"]
    /** The side glutes have no shape of their own: they shade the glutes. */
    static let shares = ["glute_med": "glutes"]

    nonisolated(unsafe) private static var figures: [String: Figure] = [:]
    private static let lock = NSLock()

    static func figure(_ which: String) -> Figure? {
        lock.lock()
        defer { lock.unlock() }
        if let f = figures[which] { return f }
        guard let url = Bundle.main.url(forResource: "musclemap", withExtension: "json"), let data = try? Data(contentsOf: url),
              let all = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let f = all[which] as? [String: Any] else { return nil }
        func view(_ o: [String: Any]?) -> View2? {
            guard let o, let vb = (o["vb"] as? String)?.split(separator: " ").compactMap({ Double($0) }), vb.count == 4, let ps = o["parts"] as? [String: Any] else { return nil }
            let parts = ps.keys.sorted().map { name -> Part in
                var path = Path()
                let p = ps[name] as? [String: Any] ?? [:]
                for side in ["l", "r", "c"] { for d in (p[side] as? [String] ?? []) { path.addPath(SVGPath.parse(d)) } }
                return Part(name: name, path: path, body: bodyParts.contains(name), other: otherParts.contains(name))
            }
            return View2(x: vb[0], y: vb[1], w: vb[2], h: vb[3], parts: parts)
        }
        guard let front = view(f["front"] as? [String: Any]), let back = view(f["back"] as? [String: Any]) else { return nil }
        let fig = Figure(front: front, back: back)
        figures[which] = fig
        return fig
    }
}

/// The 3D body as pictures, drawn by the page's WebGL (lib/body3d.ts bodyFrames, asked as
/// `rpc:body`): the move as a loop, and the key pose all the way round. `cycle`: the loop's seconds.
struct Frames {
    let loop: [UIImage]
    let turn: [UIImage]
    let cycle: Double
}

@MainActor
enum BodyFrames {
    private static var kept: [String: Frames] = [:]

    /** Ask the page for the body as pictures; nil when it can't draw (no WebGL) or didn't answer. */
    static func get(_ engine: EngineBridge, _ args: [String: Any]) async -> Frames? {
        let key = jsonText(args)
        if let f = kept[key] { return f }
        guard case .success(let j) = await engine.rpc("body", args) else { return nil }
        let o = J(json: j)
        guard o.object != nil else { return nil }
        func images(_ a: J) -> [UIImage] { a.strings.compactMap(ChatModel.decode) }
        let f = Frames(loop: images(o["loop"]), turn: images(o["turn"]), cycle: o["cycle"].num ?? 0)
        if kept.count > 40 { kept.removeAll() }
        kept[key] = f
        return f
    }
}

/// Body's data: the muscles now, sleep and vitals, and every exercise (to say what trains a muscle).
@MainActor
@Observable
final class BodyModel {
    let engine: EngineBridge
    var muscles: [String: MuscleNow]?
    var health: Health?
    var healthMissing = false
    var figure = "m"
    var exercises: [Routine.Exercise] = []
    /** Each exercise's muscles (primary, secondary), for "what trains it". */
    var works: [String: ([String], [String])] = [:]
    @ObservationIgnored private var read = false

    init(engine: EngineBridge) { self.engine = engine }

    func forget() { read = false }

    func ensure() {
        guard !read else { return }
        read = true
        Task {
            async let b = engine.get("/api/body")
            async let h = engine.get("/api/health")
            async let e = engine.rpc("exercises")
            if let j = await b { muscles = parseBody(j) }
            if let j = await h { health = parseHealth(j) } else { healthMissing = true }
            if case .success(let j) = await e {
                let o = J(json: j)
                figure = o["figure"].str ?? "m"
                exercises = o["items"].array.map { Routine.Exercise(id: $0["id"].text, name: $0["name"].text, kind: $0["kind"].text, equipment: $0["equipment"].str, dose: $0["dose"].text, cues: $0["cues"].strings, why: $0["why"].text) }
                for it in o["items"].array { works[it["id"].text] = (it["primary"].strings, it["secondary"].strings) }
            }
            if muscles != nil { Launch.ready("you") }
        }
    }
}
