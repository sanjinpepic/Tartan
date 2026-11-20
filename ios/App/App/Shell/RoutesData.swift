import Foundation
import Observation

/// A point as the routes store it: longitude, latitude.
struct LngLat: Hashable {
    let lng: Double
    let lat: Double

    var json: [Double] { [lng, lat] }
}

/// One of your routes in the list (GET /api/routes).
struct RouteItem: Identifiable {
    let id: String
    let name: String
    let metres: Double
    let ascent: Int?
    let loop: Bool
    let onWatch: Bool
    let preview: [LngLat]
}

/// One leg between two points: along paths (as found) or straight. Its own identity, so an
/// answer from the path finder finds the leg it was asked for.
final class Seg: Identifiable {
    let id = UUID()
    let mode: String
    let coords: [LngLat]

    init(_ mode: String, _ coords: [LngLat]) {
        self.mode = mode
        self.coords = coords
    }
}

/// A loop offered from a start (rpc:routeLoops): its length, which way it heads, its points and legs.
struct Loop: Identifiable {
    let id = UUID()
    let km: Double
    let bearing: Double
    let waypoints: [LngLat]
    let legs: [[LngLat]]
}

/// A km of race pacing (rpc:racePacing).
struct PaceSplit: Identifiable {
    var id: Int { km }
    let km: Int
    let metres: Double
    let paceS: Double
    let cumulativeS: Double
    let climbM: Int
}

/** Metres between two points (src/routes.ts metres: haversine). */
func metres(_ a: LngLat, _ b: LngLat) -> Double {
    let r = 6371008.8
    let p1 = a.lat * .pi / 180, p2 = b.lat * .pi / 180
    let dp = p2 - p1, dl = (b.lng - a.lng) * .pi / 180
    let h = sin(dp / 2) * sin(dp / 2) + cos(p1) * cos(p2) * sin(dl / 2) * sin(dl / 2)
    return 2 * r * atan2(sqrt(h), sqrt(1 - h))
}

/** The whole line of legs, without the repeated joins (src/routes.ts lineOf). */
func lineOf(_ segs: [Seg]) -> [LngLat] {
    var out: [LngLat] = []
    for s in segs {
        for (i, p) in s.coords.enumerated() where i > 0 || out.isEmpty || out.last != p { out.append(p) }
    }
    return out
}

/** How far along the line each point is, in metres. */
func along(_ line: [LngLat]) -> [Double] {
    var d = [Double](repeating: 0, count: line.count)
    for i in line.indices.dropFirst() { d[i] = d[i - 1] + metres(line[i - 1], line[i]) }
    return d
}

/** Climb and descent from heights, ignoring wobbles under 3 m (src/routes.ts climb). */
func climb(_ h: [Double]) -> (up: Int, down: Int) {
    guard var ref = h.first else { return (0, 0) }
    var up = 0.0, down = 0.0
    for v in h.dropFirst() {
        let d = v - ref
        if d >= 3 { up += d; ref = v } else if d <= -3 { down -= d; ref = v }
    }
    return (Int(up.rounded()), Int(down.rounded()))
}

/** A route's length as the list writes it: two decimals under 10 km, then one. */
func routeKm(_ m: Double) -> String { String(format: m < 10_000 ? "%.2f" : "%.1f", m / 1000) }

func points(_ a: J) -> [LngLat] {
    a.array.compactMap { p in
        let xs = p.array
        guard xs.count >= 2, let x = xs[0].num, let y = xs[1].num else { return nil }
        return LngLat(lng: x, lat: y)
    }
}

func parseRoutes(_ json: String) -> (routes: [RouteItem], home: LngLat?) {
    let o = J(json: json)
    let list = o["routes"].array.map { r in
        RouteItem(id: r["id"].text, name: r["name"].text, metres: r["distance_m"].num ?? 0, ascent: r["ascent_m"].int, loop: r["loop"].bool,
                  onWatch: !r["watch"].isNull, preview: points(r["preview"]))
    }
    let h = o["home"].array
    let home = h.count >= 2 ? h[0].num.flatMap { x in h[1].num.map { LngLat(lng: x, lat: $0) } } : nil
    return (list, home)
}

/// Routes: the list (Activities → Routes) and importing a GPX file.
@MainActor
@Observable
final class RoutesModel {
    private let engine: EngineBridge
    var routes: [RouteItem]?
    var home: LngLat?
    @ObservationIgnored private var read = false

    init(engine: EngineBridge) { self.engine = engine }

    func forget() { read = false }

    func ensure() {
        guard !read else { return }
        read = true
        Task {
            guard let j = await engine.get("/api/routes") else { read = false; return }
            let r = parseRoutes(j)
            routes = r.routes
            home = r.home
            if !r.routes.isEmpty { Launch.ready("routes") }
        }
    }

    /** A GPX file picked on the phone: the new route's id (it opens in the editor), or what went wrong. */
    func importGpx(name: String, text: String) async -> Result<(id: String, said: String), ShellError> {
        var n = name
        for ext in [".gpx", ".GPX"] where n.hasSuffix(ext) { n = String(n.dropLast(ext.count)) }
        let q = n.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
        let r = await engine.call("/api/routes/import?name=\(q)", method: "POST", body: text)
        let o = J(json: r.body)
        guard (200..<300).contains(r.status), o.object != nil, o["error"].isNull else {
            return .failure(ShellError(message: o["error"].str ?? "Couldn't import it (\(r.status))."))
        }
        read = false
        return .success((o["id"].text, "Imported \(o["name"].text), \(routeKm(o["distance_m"].num ?? 0)) km."))
    }
}

/**
 * The route editor (web/views/routes.ts renderRouteEditor, as Android's RouteEditor): points
 * tapped on the map, each leg along paths (the page asks the path finder) or straight, undo,
 * back to start, out and back, reverse; heights and the profile once the line settles; loops
 * from here; save, send to the watch or share as GPX; race pacing for a target time.
 */
@MainActor
@Observable
final class RouteEditor {
    let engine: EngineBridge
    /** The route's id, or "new". */
    let id: String
    /** Loops of this many km asked for (route/new/loop-10), else 0. */
    let wantLoop: Int
    @ObservationIgnored weak var shell: ShellModel?

    var loaded: Bool
    var missing = false
    var savedId: String?
    var name = ""
    var wp: [LngLat] = []
    var segs: [Seg] = []
    var pending: Set<UUID> = []
    var elevation: [Double]?
    var mode = "paths"
    var dirty = false
    var loops: [Loop] = []
    var finding: Int?
    var busy: String?
    var status: String?
    /** What the map should show next (the route once loaded, the loops once found). */
    var fitTo: [LngLat]?
    var canUndo = false
    @ObservationIgnored private var undoStack: [([LngLat], [Seg])] = []
    @ObservationIgnored private var heightsTask: Task<Void, Never>?
    @ObservationIgnored private var leaveArmed = false

    // Race pacing.
    var splits: [PaceSplit]?
    var pacingLine: String?
    @ObservationIgnored private var pacing: [String: Any]?

    init(engine: EngineBridge, id: String, wantLoop: Int) {
        self.engine = engine
        self.id = id
        self.wantLoop = wantLoop
        loaded = id == "new"
    }

    var line: [LngLat] { lineOf(segs) }
    var total: Double { along(line).last ?? 0 }
    /** Heights that match the line as it is (else none yet). */
    var heights: [Double]? { elevation.flatMap { $0.count == line.count && $0.count >= 2 ? $0 : nil } }

    private func say(_ text: String) { shell?.say(text) }

    func load() async {
        guard id != "new", !loaded else { return }
        let path = "/api/routes/\(id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? id)"
        guard let j = await engine.get(path), J(json: j).object != nil else { missing = true; loaded = true; return }
        let r = J(json: j)
        savedId = r["id"].text
        name = r["name"].text
        wp = points(r["waypoints"])
        segs = r["segments"].array.map { Seg($0["mode"].str ?? "straight", points($0["coords"])) }
        let e = r["elevation"].array.compactMap(\.num)
        elevation = e.isEmpty ? nil : e
        fitTo = line
        loaded = true
        Launch.ready("route")
    }

    private func snapshot() {
        undoStack.append((wp, segs))
        if undoStack.count > 60 { undoStack.removeFirst() }
        canUndo = true
        dirty = true
    }

    /** A leg from a to b: straight at once, then along paths when the path finder answers. */
    private func segment(_ a: LngLat, _ b: LngLat) -> Seg {
        let s = Seg(mode, [a, b])
        guard mode == "paths" else { return s }
        pending.insert(s.id)
        Task {
            let r = await engine.rpc("routePath", ["a": a.json, "b": b.json])
            pending.remove(s.id)
            guard let i = segs.firstIndex(where: { $0.id == s.id }) else { settled(); return }
            var found: [LngLat]?
            var reason: String?
            if case .success(let j) = r {
                let p = points(J(json: j)["line"])
                if p.count >= 2 { found = p }
                reason = J(json: j)["reason"].str
            }
            segs[i] = found.map { Seg("paths", $0) } ?? Seg("straight", [a, b])
            if found == nil {
                say(reason == "no-path" ? "No path between those points, so that part is a straight line." : "Couldn't reach the path finder, so that part is a straight line.")
            }
            settled()
        }
        return s
    }

    func add(_ p: LngLat) {
        snapshot()
        if let last = wp.last { segs.append(segment(last, p)) }
        wp.append(p)
        settled()
    }

    func move(_ i: Int, _ p: LngLat) {
        guard wp.indices.contains(i) else { return }
        snapshot()
        wp[i] = p
        if i > 0 { segs[i - 1] = segment(wp[i - 1], p) }
        if i < wp.count - 1 { segs[i] = segment(p, wp[i + 1]) }
        settled()
    }

    func remove(_ i: Int) {
        guard wp.indices.contains(i) else { return }
        snapshot()
        if wp.count == 1 { wp = []; segs = [] }
        else if i == 0 { wp.removeFirst(); segs.removeFirst() }
        else if i == wp.count - 1 { wp.removeLast(); segs.removeLast() }
        else {
            segs.replaceSubrange((i - 1)...i, with: [segment(wp[i - 1], wp[i + 1])])
            wp.remove(at: i)
        }
        settled()
    }

    func toStart() { if wp.count >= 2, let first = wp.first { add(first) } }

    func outAndBack() {
        guard wp.count >= 2 else { return }
        snapshot()
        let back = segs.reversed().map { Seg($0.mode, $0.coords.reversed()) }
        wp += wp.dropLast().reversed()
        segs += back
        settled()
    }

    func reverse() {
        guard wp.count >= 2 else { return }
        snapshot()
        wp.reverse()
        segs = segs.reversed().map { Seg($0.mode, $0.coords.reversed()) }
        settled()
    }

    func undo() {
        guard let h = undoStack.popLast() else { return }
        wp = h.0
        segs = h.1
        canUndo = !undoStack.isEmpty
        settled()
    }

    /** Heights follow once the line has settled (half a second without a change). */
    private func settled() {
        heightsTask?.cancel()
        let l = line
        if l.count < 2 { elevation = nil; return }
        if !pending.isEmpty || elevation?.count == l.count { return }
        elevation = nil
        heightsTask = Task {
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled else { return }
            guard case .success(let j) = await engine.rpc("routeHeights", ["line": l.map(\.json)]) else { return }
            let h = J(json: j).array.compactMap(\.num)
            if line == l, h.count == l.count { elevation = h }
        }
    }

    func findLoops(_ km: Int, from start: LngLat) {
        finding = km
        status = "Finding \(km) km loops…"
        Task {
            switch await engine.rpc("routeLoops", ["start": start.json, "km": km]) {
            case .success(let j):
                loops = J(json: j).array.map { l in
                    Loop(km: l["km"].num ?? 0, bearing: l["bearing"].num ?? 0, waypoints: points(l["waypoints"]), legs: l["legs"].array.map(points))
                }
                if loops.isEmpty { say("No \(km) km loop along paths from here: try another distance, or move the map.") }
                else { fitTo = loops.flatMap { $0.legs.flatMap { $0 } } }
            case .failure(let e):
                say(e.message)
            }
            finding = nil
            status = nil
        }
    }

    func pick(_ l: Loop) {
        snapshot()
        wp = l.waypoints
        segs = l.legs.map { Seg("paths", $0) }
        if name.trimmingCharacters(in: .whitespaces).isEmpty { name = "\(String(format: "%.1f", l.km)) km loop" }
        loops = []
        settled()
    }

    private func defaultName() -> String {
        let l = line
        let loop = l.count > 2 && metres(l[0], l[l.count - 1]) < 60
        return "\(routeKm(total)) km \(loop ? "loop" : "route")"
    }

    private var title: String {
        let n = name.trimmingCharacters(in: .whitespaces)
        return n.isEmpty ? defaultName() : n
    }

    private func body(watch: [String: Any]? = nil) -> [String: Any] {
        var b: [String: Any] = [
            "name": title,
            "waypoints": wp.map(\.json),
            "segments": segs.map { ["mode": $0.mode, "coords": $0.coords.map(\.json)] as [String: Any] },
        ]
        if let h = heights { b["elevation"] = h }
        if let watch { b["watch"] = watch }
        return b
    }

    /** Save: the saved route's id and name, or nil (and why, said). */
    func persist(watch: [String: Any]? = nil) async -> (id: String, name: String)? {
        if !pending.isEmpty { say("Still finding the way: try again in a moment."); return nil }
        switch await engine.send("/api/routes/\(savedId ?? "new")", method: "PUT", body: body(watch: watch)) {
        case .success(let j):
            let r = J(json: j)
            savedId = r["id"].text
            name = r["name"].text
            dirty = false
            shell?.routes.forget()
            return (r["id"].text, r["name"].text)
        case .failure(let e):
            say("Couldn't save: \(e.message)")
            return nil
        }
    }

    func save() {
        busy = "save"
        Task {
            if let r = await persist() { say("Saved \(r.name).") }
            busy = nil
        }
    }

    func send() {
        busy = "send"
        Task {
            defer { busy = nil }
            guard let r = await persist() else { return }
            status = "Sending to the watch…"
            var args: [String: Any] = ["name": r.name, "line": line.map(\.json), "waypoints": wp.map(\.json)]
            if let h = heights { args["elevation"] = h }
            switch await engine.rpc("routeToWatch", args) {
            case .success(let j):
                let o = J(json: j)
                let sent: [String: Any] = ["id": o["id"].int ?? o.int ?? 0, "sent": ISO8601DateFormatter().string(from: Date()), "name": r.name]
                _ = await persist(watch: sent)
                say("\(r.name) is on your watch. Find it under Navigation → Routes.")
            case .failure(let e):
                say("\(e.message) You can still put it on through the Suunto app: share it as GPX.")
            }
            status = nil
        }
    }

    func gpx() {
        busy = "gpx"
        Task {
            if let r = await persist(), case .failure(let e) = await engine.rpc("routeGpx", ["id": r.id]) { say(e.message) }
            busy = nil
        }
    }

    /** Leaving with unsaved points: one tap more. True when it may go. */
    func mayLeave() -> Bool {
        if !dirty || wp.count < 2 || leaveArmed { return true }
        leaveArmed = true
        say("This route isn't saved. Tap back again to leave it.")
        Task {
            try? await Task.sleep(for: .seconds(4))
            leaveArmed = false
        }
        return false
    }

    // ---- race pacing

    func pace(_ time: String) {
        busy = "pace"
        Task {
            var args: [String: Any] = ["time": time, "line": line.map(\.json)]
            if let h = heights { args["elevation"] = h }
            switch await engine.rpc("racePacing", args) {
            case .success(let j):
                let o = J(json: j)
                pacing = o.object
                splits = o["splits"].array.map {
                    PaceSplit(km: $0["km"].int ?? 0, metres: $0["distance_m"].num ?? 0, paceS: $0["pace_s"].num ?? 0, cumulativeS: $0["cumulative_s"].num ?? 0, climbM: $0["climb_m"].int ?? 0)
                }
                pacingLine = nil
            case .failure(let e):
                pacingLine = e.message
            }
            busy = nil
        }
    }

    func courseToWatch() {
        guard let p = pacing else { return }
        busy = "pace"
        pacingLine = "Sending the course…"
        Task {
            switch await engine.rpc("courseToWatch", ["name": title, "line": p["line"] ?? [], "marks": p["marks"] ?? []]) {
            case .success(let j):
                let o = J(json: j)
                pacingLine = "On your watch with a split every km (route \(o["id"].int ?? o.int ?? 0))."
            case .failure(let e):
                pacingLine = e.message
            }
            busy = nil
        }
    }

    func splitsToWatch() {
        guard let p = pacing else { return }
        busy = "pace"
        pacingLine = "Sending the pacing workout…"
        let target = (p["target"] as? NSNumber)?.intValue ?? 0
        Task {
            switch await engine.rpc("splitsToWatch", ["name": "\(title) \(clock(target))", "splits": p["splits"] ?? []]) {
            case .success:
                pacingLine = "The pacing workout is on your watch: start it from the sport mode's workout options."
            case .failure(let e):
                pacingLine = e.message
            }
            busy = nil
        }
    }
}
