import Foundation
import Observation

/// The watch as the page holds it (web/watch.ts WatchState), pushed on every change (`watch`).
struct WatchNow: Equatable {
    struct Job: Equatable { let title: String; let text: String; let value: Double?; let max: Double? }
    let connected: Bool
    let connecting: Bool
    let name: String
    let facts: [[String]]
    let job: Job?
    let running: Bool
    let canBluetooth: Bool
}

func parseWatch(_ json: String) -> WatchNow? {
    let o = J(json: json)
    guard o.object != nil else { return nil }
    let j = o["job"]
    return WatchNow(connected: o["connected"].bool, connecting: o["connecting"].bool, name: o["name"].text,
                    facts: o["facts"].array.map(\.strings),
                    job: j.object == nil ? nil : WatchNow.Job(title: j["title"].text, text: j["text"].text, value: j["value"].num, max: j["max"].num),
                    running: o["running"].bool, canBluetooth: o.has("canBluetooth") ? o["canBluetooth"].bool : true)
}

/// Strava as it stands (GET /api/strava/status).
struct StravaNow {
    let connected: Bool
    let configured: Bool
    let clientId: String?
    let name: String
    let lastSync: String?
    let activities: Int
}

/// intervals.icu: connected as whom, how many workouts.
struct IcuNow {
    let connected: Bool
    let name: String?
    let workouts: Int
}

/**
 * Where workouts come from (Android's SourcesModel, web/views/sync.ts): Strava, the watch,
 * intervals.icu and your PC. Bluetooth and the sign-ins are the page's work, asked for over the
 * bridge (`rpc:…`); the watch's state comes with every change.
 */
@MainActor
@Observable
final class SourcesModel {
    @ObservationIgnored weak var shell: ShellModel?
    private let engine: EngineBridge
    var watch: WatchNow?
    var strava: StravaNow?
    var icu: IcuNow?
    /** Paired with a PC: its address and name. */
    var pc: (url: String, name: String?)?
    var pcRead = false
    var pcLine: String?
    var busy: String?
    var stravaUrl: String?
    @ObservationIgnored private var read = false

    init(engine: EngineBridge) { self.engine = engine }

    private func say(_ s: String) { shell?.say(s) }

    func forget() { read = false }

    func ensure() {
        guard !read else { return }
        read = true
        Task { await fetch() }
    }

    func fetch() async {
        async let s = engine.get("/api/strava/status")
        async let i = engine.get("/api/intervals/status")
        async let p = engine.rpc("pcState")
        if let j = await s {
            let o = J(json: j), a = o["athlete"]
            strava = StravaNow(connected: o["connected"].bool, configured: o["configured"].bool, clientId: o["clientId"].str.flatMap { $0.isEmpty ? nil : $0 },
                               name: [a["firstname"].str, a["lastname"].str].compactMap { $0 }.joined(separator: " "), lastSync: o["lastSync"].str, activities: o["activities"].int ?? 0)
        }
        if let j = await i {
            let o = J(json: j)
            icu = IcuNow(connected: o["connected"].bool, name: o["name"].str.flatMap { $0.isEmpty ? nil : $0 }, workouts: o["workouts"].int ?? 0)
        }
        if case .success(let j) = await p {
            let o = J(json: j)
            pc = o.object == nil ? nil : (url: o["url"].text, name: o["name"].str)
        }
        pcRead = true
    }

    /** Something the page does, under a label; what it says (or why it failed), and then read again. */
    private func run(_ label: String, _ name: String, _ args: [String: Any] = [:], ok: ((String) -> String?)? = nil) {
        busy = label
        Task {
            switch await engine.rpc(name, args) {
            case .success(let r): if let s = ok?(r) { say(s) }
            case .failure(let e): say(e.message)
            }
            busy = nil
            await fetch()
        }
    }

    func watchConnect() { run("watch", "watchConnect") }
    func watchBackup() {
        run("watch", "watchBackup", ["path": "/", "force": false]) { n in
            Int(n).map { $0 > 0 ? "Saved \($0) new \($0 == 1 ? "file" : "files") from the watch." : "Nothing new on the watch." }
        }
    }
    func watchCancel() { Task { _ = await engine.rpc("watchCancel") } }

    /** Strava's sign-in with your API app (or, with no ID, to add upload access): the page opens it. */
    func stravaConnect(id: String?, secret: String?) {
        busy = "strava"
        Task {
            var args: [String: Any] = [:]
            if let id { args["clientId"] = id; if let secret { args["clientSecret"] = secret } }
            switch await engine.rpc("stravaConnect", args) {
            case .success(let j): stravaUrl = J(json: j)["url"].str
            case .failure(let e): say(e.message)
            }
            busy = nil
        }
    }

    func open(_ url: String) { Task { _ = await engine.rpc("openUrl", ["url": url]) } }

    /** Connect intervals.icu with its key (and athlete ID, optional); then bring in what's there. */
    func icuConnect(key: String, athlete: String, done: @escaping () -> Void) {
        busy = "icu"
        Task {
            let r = await engine.call("/api/intervals/config", method: "PUT", body: jsonText(["key": key, "athlete": athlete]))
            let o = J(json: r.body)
            if (200..<300).contains(r.status) {
                done()
                say(o["name"].str.map { "Connected to intervals.icu as \($0). Your workouts are coming in." } ?? "Connected to intervals.icu. Your workouts are coming in.")
                _ = await engine.call("/api/intervals/sync", method: "POST", body: "{}")
                await fetch()
            } else {
                say(o["error"].str ?? "Couldn't connect (\(r.status)).")
            }
            busy = nil
        }
    }

    func pcPair(urls: String, code: String) {
        busy = "pc"
        Task {
            switch await engine.rpc("pcPair", ["urls": urls, "code": code]) {
            case .success(let j):
                let o = J(json: j)
                pc = (url: o["url"].text, name: o["name"].str)
                say("Paired. Bringing this phone and your PC up to date…")
                pcLine = "Comparing with your PC…"
                switch await engine.rpc("pcSync") {
                case .success(let line): pcLine = J(json: line).str ?? line
                case .failure(let e): pcLine = nil; say(e.message)
                }
            case .failure(let e):
                say(e.message)
            }
            busy = nil
        }
    }
}
