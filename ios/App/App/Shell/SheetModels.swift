import Foundation
import Observation

/// A sheet over everything: a planned session's, or a workout's.
enum ShellSheet: Identifiable {
    case session(SessionModel)
    case workout(WorkoutModel)

    var id: String {
        switch self {
        case .session(let m): return "session:\(m.date):\(m.kind ?? "")"
        case .workout(let m): return "workout:\(m.id)"
        }
    }
}

/// A session's sheet (Android's SessionModel): the session from the plan, how it went (when a
/// workout did it), its strength routine, and marking it done.
@MainActor
@Observable
final class SessionModel {
    let date: String
    let kind: String?
    private let engine: EngineBridge
    var session: PlanSession?
    var missing = false
    var review: Review?
    var routine: Routine?
    var busy = false
    /** True once a write went through: the sheet closes, with this said. */
    var done: String?

    init(engine: EngineBridge, date: String, kind: String?) {
        self.engine = engine
        self.date = date
        self.kind = kind
    }

    func load() async {
        guard let json = await engine.get("/api/plan"), let s = findSession(json, date: date, kind: kind) else { missing = true; return }
        session = s
        Launch.ready("session")
        if s.activityId != nil && (!s.steps.isEmpty || s.target != nil) {
            let k = s.kind.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? s.kind
            if let r = await engine.get("/api/plan/review?date=\(s.date)&kind=\(k)") { review = parseReview(r) }
        }
        if s.strength {
            var args: [String: Any] = ["exercises": s.exercises]
            if let m = s.minutes { args["minutes"] = m }
            if case .success(let r) = await engine.rpc("routine", args) { routine = parseRoutine(r) }
        }
    }

    private func write(_ path: String, _ method: String, _ body: [String: Any], ok: String) async -> String? {
        busy = true
        defer { busy = false }
        switch await engine.send(path, method: method, body: body) {
        case .success:
            done = ok
            return nil
        case .failure(let e): return "Couldn't save: \(e.message)"
        }
    }

    func mark(_ on: Bool) async -> String? {
        guard let s = session else { return nil }
        return await write("/api/plan/mark", "PUT", ["date": s.date, "kind": s.kind, "done": on], ok: on ? "\(s.title) marked done." : "\(s.title) is no longer marked done.")
    }

    func undoAdjust() async -> String? {
        guard let s = session else { return nil }
        return await write("/api/plan/adjust", "PUT", ["date": s.date, "kind": s.kind, "undo": true], ok: "\(s.title) is back as planned.")
    }

    /** The session as a .fit workout file through the share sheet, for any watch's app. */
    func saveFit() async -> String {
        guard let s = session else { return "" }
        busy = true
        defer { busy = false }
        switch await engine.rpc("sessionFile", ["date": s.date, "kind": s.kind]) {
        case .success(let r): return "Saved \(J(json: r)["name"].str ?? "the workout"). Open it in your watch's app."
        case .failure(let e): return "Couldn't make the file: \(e.message)"
        }
    }
}

/// One workout's sheet (Android's WorkoutModel): the workout, then (each when it comes) how the
/// run finished, your notes and its shoes. Writes go through the page, so the coach hears of them.
@MainActor
@Observable
final class WorkoutModel {
    let id: String
    private let engine: EngineBridge
    var workout: Workout?
    var along: Along?
    var failed: String?
    var finish: Finish?
    var notes: [RunNote] = []
    var feeling: Int?
    var shoe: String?
    var shoes: [Shoe] = []
    var busy = false

    private var enc: String { id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? id }

    init(engine: EngineBridge, id: String) {
        self.engine = engine
        self.id = id
    }

    func load() async {
        async let w = engine.get("/api/activity/\(enc)")
        async let f = engine.get("/api/activity/\(enc)/finish")
        async let n = engine.get("/api/notes?run=\(enc)")
        async let sh = engine.get("/api/shoes/run?id=\(enc)")
        guard let json = await w else { failed = "Couldn't open this workout."; return }
        guard let parsed = parseWorkout(json) else { failed = "Couldn't read this workout."; return }
        workout = parsed
        along = alongTheWay(parsed)
        feeling = parsed.feeling
        if let j = await f { finish = parseFinish(j) }
        if let j = await n {
            let o = J(json: j)
            notes = parseNotes(o)
            if let felt = o["feeling"].num { feeling = Int(felt.rounded()) }
        }
        Launch.ready("workout")
        if let j = await sh {
            let o = J(json: j)
            shoes = o["shoes"].array.map { Shoe(id: $0["id"].text, name: $0["name"].text, retired: $0["retired"].bool) }
            shoe = o["shoe"].str
        }
    }

    private func write(_ path: String, _ method: String, _ body: [String: Any]?) async -> Result<J, ShellError> {
        let r = await engine.call(path, method: method, body: body.map(jsonText))
        let o = J(json: r.body)
        if (200..<300).contains(r.status), o["error"].str == nil { return .success(o) }
        return .failure(ShellError(message: "Couldn't save: \(o["error"].str ?? "it didn't go through (\(r.status))")"))
    }

    /** Next time's pace change, put on the session (or taken back): what to say. */
    func adjust() async -> String? {
        guard let n = finish?.next, let shift = n.shiftS else { return nil }
        busy = true
        defer { busy = false }
        switch await write("/api/plan/adjust", "PUT", ["date": n.date, "kind": n.kind, "shift_s": shift, "reason": n.why, "from": id, "undo": n.applied]) {
        case .success:
            if let j = await engine.get("/api/activity/\(enc)/finish") { finish = parseFinish(j) }
            if n.applied { return "\(n.title) is back as planned." }
            return "\(n.title) on \(dayName(n.date)) \(dateShort(n.date)): \(abs(shift)) s/km \(shift < 0 ? "faster" : "easier"). On your watch with the next sync."
        case .failure(let e): return e.message
        }
    }

    /** A win, a niggle (and where) or a note: what to say. */
    func addNote(tag: String, text: String, area: String?) async -> String {
        var body: [String: Any] = ["run": id, "tag": tag, "text": text]
        if let area { body["area"] = area }
        switch await write("/api/notes", "POST", body) {
        case .success(let o):
            if o["notes"].raw != nil { notes = parseNotes(o) }
            return tag == "niggle" ? "Noted. Readiness and your coach take it into account." : tag == "win" ? "Noted. Nice one." : "Noted. Your coach will see it."
        case .failure(let e): return e.message
        }
    }

    func removeNote(_ n: RunNote) async {
        notes.removeAll { $0.id == n.id }
        let nid = n.id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? n.id
        _ = await engine.call("/api/notes/\(nid)", method: "DELETE")
    }

    /** Which shoes this run counts to (nil: none), on Strava too where it can: what to say. */
    func pickShoe(_ to: String?) async -> String {
        let was = shoe
        shoe = to
        switch await write("/api/shoes/run", "PUT", ["run": id, "shoe": to.map { $0 as Any } ?? (NSNull() as Any)]) {
        case .success(let r):
            let name = shoes.first { $0.id == to }?.name ?? ""
            if to == nil { return "This run counts to no shoes." }
            switch r["strava"].str ?? "" {
            case "set": return "This run counts to \(name), on Strava too."
            case "not-linked": return "This run counts to \(name). \(name) isn't on Strava: add it there under My Gear and the next sync links it."
            case "not-allowed": return "This run counts to \(name). To change it on Strava too, reconnect Strava and approve uploads."
            case "failed": return "This run counts to \(name). Strava didn't take the change; try again later."
            default: return "This run counts to \(name)."
            }
        case .failure(let e):
            shoe = was
            return e.message
        }
    }
}
