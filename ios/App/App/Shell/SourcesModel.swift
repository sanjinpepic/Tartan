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
    var cwd = "/"
    var dirs: [String] = []
    var files: [String] = []
    /** A watch that hands over workouts from its logbook (no file access). */
    var logbook = false
    var noFileAccess = false
}

func parseWatch(_ json: String) -> WatchNow? {
    let o = J(json: json)
    guard o.object != nil else { return nil }
    let j = o["job"]
    let l = o["listing"]
    return WatchNow(connected: o["connected"].bool, connecting: o["connecting"].bool, name: o["name"].text,
                    facts: o["facts"].array.map(\.strings),
                    job: j.object == nil ? nil : WatchNow.Job(title: j["title"].text, text: j["text"].text, value: j["value"].num, max: j["max"].num),
                    running: o["running"].bool, canBluetooth: o.has("canBluetooth") ? o["canBluetooth"].bool : true,
                    cwd: o["cwd"].str ?? "/", dirs: l["dirs"].strings.sorted(), files: l["files"].strings.sorted(),
                    logbook: o["mode"].text == "logbook", noFileAccess: o["noFileAccess"].bool)
}

/// Strava as it stands (GET /api/strava/status).
struct StravaNow {
    let connected: Bool
    let configured: Bool
    let clientId: String?
    let name: String
    let lastSync: String?
    let activities: Int
    var detailed = 0
    var canUpload = false
    var rateLimited = false
}

/// Sending watch workouts to Strava (GET /api/strava/send-watch).
struct SendWatchNow {
    var enabled: Bool
    let since: String?
    let connected: Bool
    let canUpload: Bool
    let sent: Int
    let lastName: String?
    let error: String?
}

func parseSendWatch(_ json: String) -> SendWatchNow? {
    let o = J(json: json)
    guard o.object != nil else { return nil }
    let e = o["errors"].array.first
    return SendWatchNow(enabled: o["enabled"].bool, since: o["since"].str, connected: o["connected"].bool, canUpload: o["can_upload"].bool, sent: o["sent"].int ?? 0,
                        lastName: o["last"]["name"].str, error: e.map { "\($0["name"].str ?? "A workout"): \($0["error"].str ?? "couldn't be sent"). Tried again after the next watch sync." })
}

/// intervals.icu: connected as whom, how many workouts.
struct IcuNow {
    let connected: Bool
    let name: String?
    let workouts: Int
    var line: String?
}

/// Apple Health (rpc:ah, web/lib/apple-health.ts): there or not, on, and how the last look went.
struct HealthNow {
    /** HealthKit is on this iPhone (and this build has its plugin). */
    let available: Bool
    let on: Bool
    /** Bringing workouts in right now. */
    let running: Bool
    /** Workouts read from it so far. */
    let workouts: Int
    /** Workouts it showed Tartan the last time it looked (0: none allowed, or none there). */
    let seen: Int?
    let lastAt: Double?
    let error: String?
}

func parseHealth(_ json: String) -> HealthNow? {
    let o = J(json: json)
    guard o.object != nil else { return nil }
    return HealthNow(available: o["status"].text == "available", on: o["on"].bool, running: o["running"].bool, workouts: o["workouts"].int ?? 0,
                     seen: o["seen"].int, lastAt: o["last"]["at"].num, error: o["last"]["error"].str)
}

/**
 * Where workouts come from (Android's SourcesModel, web/views/sync.ts): Apple Health, Strava, the watch,
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
    var health: HealthNow?
    /** Paired with a PC: its address and name. */
    var pc: (url: String, name: String?)?
    var pcRead = false
    var pcLine: String?
    var busy: String?
    var stravaUrl: String?
    var sendWatch: SendWatchNow?
    /** What the last Strava sync by hand did, line by line. */
    var syncLines: [String] = []
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
        async let w = engine.get("/api/strava/send-watch")
        async let h = engine.rpc("ah")
        if let j = await s {
            let o = J(json: j), a = o["athlete"]
            let acts = o["activities"].int ?? 0
            strava = StravaNow(connected: o["connected"].bool, configured: o["configured"].bool, clientId: o["clientId"].str.flatMap { $0.isEmpty ? nil : $0 },
                               name: [a["firstname"].str, a["lastname"].str].compactMap { $0 }.joined(separator: " "), lastSync: o["lastSync"].str, activities: acts,
                               detailed: acts - (o["pendingDetails"].int ?? 0), canUpload: o["can_upload"].bool, rateLimited: o["stoppedForRateLimit"].bool)
        }
        if let j = await i { icu = parseIcu(j) }
        if let j = await w { sendWatch = parseSendWatch(j) }
        if case .success(let j) = await h { health = parseHealth(j) }
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

    private func parseIcu(_ j: String) -> IcuNow {
        let o = J(json: j)
        var line: String?
        let l = o["last"]
        if l.object != nil {
            let at = ago(l["at"].text)
            if let e = l["error"].str { line = "Last try \(at): \(e)" } else {
                let pending = l["pending"].int ?? 0, fromStrava = l["strava"].int ?? 0
                line = "Last round \(at): \(l["added"].int ?? 0) new" + (pending > 0 ? ", \(pending) more next time" : "")
                    + (fromStrava > 0 ? ". \(fromStrava) came to intervals.icu from Strava, which doesn't let it pass them on: connect Strava here for those" : "") + "."
            }
        }
        return IcuNow(connected: o["connected"].bool, name: o["name"].str.flatMap { $0.isEmpty ? nil : $0 }, workouts: o["workouts"].int ?? 0, line: line)
    }

    /** Apple Health: "connect" (its sheet, then the workouts come in), "sync", "open" (the Health app), "stop". */
    func healthDo(_ op: String) {
        busy = "health"
        Task {
            switch await engine.rpc("ah", ["op": op]) {
            case .success(let j):
                health = parseHealth(j) ?? health
                if let note = J(json: j)["note"].str { say(note) }
            case .failure(let e): say(e.message)
            }
            busy = nil
        }
    }

    func watchConnect() { run("watch", "watchConnect") }
    func watchDisconnect() { run("watch", "watchDisconnect") }
    func watchBrowse(_ path: String) { Task { if case .failure(let e) = await engine.rpc("watchBrowse", ["path": path]) { say(e.message) } } }
    func watchSave(_ path: String) { run("file", "watchSaveOne", ["path": path]) }
    func watchBackupFolder(_ path: String, force: Bool) {
        run("watch", "watchBackup", ["path": path, "force": force]) { n in
            Int(n).map { $0 > 0 ? "Saved \($0) new \($0 == 1 ? "file" : "files") from the watch." : "Nothing new on the watch." }
        }
    }

    /** A Strava sync by hand (or the whole history again): what it did, line by line. */
    func stravaSync(full: Bool) {
        busy = "strava"
        syncLines = []
        Task {
            switch await engine.rpc("stravaSync", ["full": full]) {
            case .success(let j):
                let o = J(json: j)
                syncLines = o["lines"].strings
                if o["result"].object != nil {
                    let n = o["result"]["added"].int ?? 0
                    say(n > 0 ? "Strava: \(n) new workout\(n == 1 ? "" : "s")." : "Strava: nothing new.")
                }
            case .failure(let e): say(e.message)
            }
            busy = nil
            await fetch()
            shell?.changed()
        }
    }

    func setSendWatch(_ on: Bool) {
        sendWatch?.enabled = on
        Task {
            let r = await engine.call("/api/strava/send-watch", method: "PUT", body: jsonText(["enabled": on]))
            if (200..<300).contains(r.status) {
                sendWatch = parseSendWatch(r.body) ?? sendWatch
                say(on ? "On. New watch workouts go to Strava after each watch sync." : "Off. Watch workouts stay in Tartan.")
            } else {
                sendWatch?.enabled = !on
                say("Couldn't change it.")
            }
        }
    }

    func icuSyncNow() {
        busy = "icu"
        Task {
            let r = await engine.call("/api/intervals/sync", method: "POST", body: "{}")
            let o = J(json: r.body)
            if (200..<300).contains(r.status) {
                let pending = o["pending"].int ?? 0
                say("\(o["added"].int ?? 0) new from intervals.icu\(pending > 0 ? ", \(pending) more next time" : "").")
            } else {
                say(o["error"].str ?? "intervals.icu couldn't be reached.")
            }
            await fetch()
            busy = nil
        }
    }

    func icuStop() {
        Task {
            _ = await engine.call("/api/intervals/config", method: "DELETE")
            icu = IcuNow(connected: false, name: nil, workouts: 0)
            say("Disconnected from intervals.icu. The workouts it brought stay here.")
        }
    }

    func pcSync() {
        busy = "pc"
        pcLine = "Comparing with your PC…"
        Task {
            switch await engine.rpc("pcSync") {
            case .success(let line): pcLine = J(json: line).str ?? line
            case .failure(let e): pcLine = nil; say(e.message)
            }
            busy = nil
        }
    }

    func pcUnpair() {
        Task {
            _ = await engine.rpc("pcUnpair")
            pc = nil
            say("Unpaired. Your data stays on this phone; the PC can forget this phone in its Settings.")
        }
    }

    /** Workout files picked on the phone, each through the page into the library. */
    func importFiles(_ urls: [URL]) {
        busy = "import"
        Task {
            var added = 0, already = 0
            var failed: String?
            for url in urls {
                let ok = url.startAccessingSecurityScopedResource()
                defer { if ok { url.stopAccessingSecurityScopedResource() } }
                guard let data = try? Data(contentsOf: url) else { failed = "Couldn't read \(url.lastPathComponent)."; continue }
                switch await engine.rpc("importFit", ["name": url.lastPathComponent, "data": data.base64EncodedString()]) {
                case .success(let j): if J(json: j)["already"].bool { already += 1 } else { added += 1 }
                case .failure(let e): failed = e.message
                }
            }
            let words = [added > 0 ? "Imported \(added) workout\(added == 1 ? "" : "s")." : nil, already > 0 ? "\(already) \(already == 1 ? "was" : "were") already here." : nil, failed].compactMap { $0 }.joined(separator: " ")
            if !words.isEmpty { say(words) }
            if added > 0 { shell?.changed() }
            busy = nil
        }
    }
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
