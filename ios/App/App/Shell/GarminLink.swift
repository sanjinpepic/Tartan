import ConnectIQ
import Foundation
import UIKit

/// The Garmin watch as Tartan holds it: its name, whether Tartan's app is on it, the last plan sent.
struct GarminNow: Equatable {
    let name: String
    /** "ok", or "missing" (Garmin Connect isn't on this iPhone). */
    var gcm = "ok"
    /** Tartan's watch app on the watch: true, false, or nil (not known: the watch is away). */
    var app: Bool?
    var sentTitle: String?
    var sentDate: String?
    var error: String?
}

/// The watch's message from the engine's answer (rpc garminPlan): its key and the message, later days
/// dropped until it fits (today's always stays). Android's GarminMessage does the same.
enum GarminMessage {
    static let maxChars = 8000

    static func goesToGarmin(_ brand: String?) -> Bool { brand == "garmin" }

    static func fromEngine(_ answer: String) -> (key: String, message: [String: Any])? {
        guard let data = answer.data(using: .utf8),
              let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              var m = o["message"] as? [String: Any] else { return nil }
        var days = m["days"] as? [Any] ?? []
        func size() -> Int { (try? JSONSerialization.data(withJSONObject: m))?.count ?? 0 }
        m["days"] = days
        while days.count > 1 && size() > maxChars { days.removeLast(); m["days"] = days }
        return ((o["key"] as? String) ?? "", m)
    }

    static func firstTitle(_ m: [String: Any]) -> (String, String)? {
        guard let d = (m["days"] as? [[String: Any]])?.first, let t = d["title"] as? String else { return nil }
        return (t, d["date"] as? String ?? "")
    }

    // MARK: The watch's day (garmin/source/Body.mc), as Android's GarminMessage takes it

    /** Whether a message from the watch carries the day's body numbers ({ t: "day", days: [...] }). */
    static func isDay(_ msg: Any?) -> Bool { (msg as? [String: Any])?["t"] as? String == "day" }

    /** What the phone sends the watch to have the day's numbers now (Tartan opened). */
    static let askDay: [String: Any] = ["t": "ask", "v": 1]

    /**
     * What the watch may send, as the engine's SignalValues (src/signals.ts): each number's range.
     * Nothing else is taken: no sleep stages or HRV (Connect IQ doesn't give them; other sources do).
     */
    static let dayRanges: [String: ClosedRange<Double>] = [
        "energy": 0...100, "stress": 0...100, "sleep_score": 0...100, "recovery_h": 0...240,
        "breathing_rate": 3...60, "resting_hr": 20...200, "vo2max": 10...100, "night_hr_min": 20...200, "spo2_max": 50...100,
    ]
    /** The night's times, when the watch has real ones (local "YYYY-MM-DDTHH:MM"). */
    private static let dayTimes: Set<String> = ["sleep_start", "sleep_end"]

    private static func dayText(_ d: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        f.timeZone = .current
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: d)
    }
    private static func days(from d: Date, _ n: Int) -> String { dayText(Calendar.current.date(byAdding: .day, value: n, to: d) ?? d) }

    /** "2026-11-23" → "2026-11-22". */
    private static func dayBefore(_ date: String) -> String? {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        let p = date.split(separator: "-").compactMap { Int($0) }
        guard p.count == 3, let d = c.date(from: DateComponents(year: p[0], month: p[1], day: p[2])), let b = c.date(byAdding: .day, value: -1, to: d) else { return nil }
        let q = c.dateComponents([.year, .month, .day], from: b)
        return String(format: "%04d-%02d-%02d", q.year ?? 0, q.month ?? 0, q.day ?? 0)
    }

    /** The days a message may be for: today, the two before (a phone that was away), tomorrow (a watch a time zone ahead). */
    static func dayAllowed(_ date: String, today: Date) -> Bool {
        (-2...1).contains { days(from: today, $0) == date }
    }

    /**
     * The watch's message, checked, as the engine's signalsPut arguments ({ days: [...] } with
     * source "garmin"): each day's date within reach of today, each value a number in its range
     * (one decimal at most) or, for the night's times, a real time. What isn't is left out; nil
     * when nothing in the message holds.
     */
    static func signalDays(_ msg: Any?, today: Date) -> [String: Any]? {
        guard isDay(msg), let list = (msg as? [String: Any])?["days"] as? [Any] else { return nil }
        var out: [[String: Any]] = []
        for case let m as [String: Any] in list.prefix(7) {
            guard let date = m["date"] as? String, dayAllowed(date, today: today) else { continue }
            var day: [String: Any] = ["date": date, "source": "garmin"]
            for (k, v) in m {
                if let range = dayRanges[k] {
                    guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { continue }
                    let x = n.doubleValue
                    guard x.isFinite, range.contains(x) else { continue }
                    let r = (x * 10).rounded() / 10
                    day[k] = r == r.rounded() ? Int(r) as Any : r as Any
                } else if dayTimes.contains(k), let s = v as? String, s.range(of: #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$"#, options: .regularExpression) != nil {
                    let d = String(s.prefix(10))
                    if d == date || d == dayBefore(date) { day[k] = s }
                }
            }
            if day.count > 2 { out.append(day) }
        }
        return out.isEmpty ? nil : ["days": out]
    }

    /**
     * The engine's signalsPut arguments for a message from the watch, only while the watch is a
     * Garmin (the brand the engine keeps, the same switch as the plan): a Suunto never takes them.
     */
    static func signalsFor(_ brand: String?, _ msg: Any?, today: Date) -> [String: Any]? {
        goesToGarmin(brand) ? signalDays(msg, today: today) : nil
    }
}

/// A continuation resumed once: by the answer or by the time running out, whichever comes first.
private final class Once<T>: @unchecked Sendable {
    private var c: CheckedContinuation<T, Never>?
    private let lock = NSLock()
    init(_ c: CheckedContinuation<T, Never>) { self.c = c }
    func resume(_ v: T) {
        lock.lock()
        let k = c
        c = nil
        lock.unlock()
        k?.resume(returning: v)
    }
}

/**
 * Garmin's Connect IQ companion SDK for iOS (github.com/garmin/connectiq-companion-app-sdk-ios, by
 * Swift Package Manager): the watch chosen in Garmin Connect (its device selection hands back to
 * Tartan through the tartan-ciq: link), messages to and from Tartan's watch app (garmin/), whether
 * the app is on the watch. Started only when the watch is a Garmin or Find my watch asks Garmin
 * Connect; a Suunto never touches it.
 */
@MainActor
final class GarminLink: NSObject, IQUIOverrideDelegate, IQDeviceEventDelegate, IQAppMessageDelegate {
    static let shared = GarminLink()
    static let urlScheme = "tartan-ciq"
    /** Tartan's watch app (garmin/manifest.xml). */
    static let appId = UUID(uuidString: "7bc40c05-a772-4b51-a5ed-b3aeb2671553")!
    static let watchAppUrl = URL(string: "https://github.com/sanjinpepic/Tartan/releases/tag/garmin")!

    private var started = false
    private var choosing: (([IQDevice]) -> Void)?
    /** The watch app asked for the plan. */
    var onWant: (() -> Void)?
    /** The watch app sent the day's body numbers (the message as JSON; GarminMessage.signalsFor checks it). */
    var onDay: ((String) -> Void)?
    /** Garmin Connect isn't on this iPhone (the SDK said so when asked to hand over). */
    private(set) var gcmMissing = false
    private let defaults = UserDefaults.standard

    private func start() {
        guard !started else { return }
        started = true
        ConnectIQ.sharedInstance()?.initialize(withUrlScheme: Self.urlScheme, uiOverrideDelegate: self)
        if let d = device { listen(d) }
    }

    nonisolated func needsToInstallConnectMobile() {
        Task { @MainActor in
            self.gcmMissing = true
            self.choosing?([])
            self.choosing = nil
        }
    }

    /** Garmin Connect's device selection: it opens, the person picks the watch, and it hands back here. */
    func choose(_ done: @escaping ([IQDevice]) -> Void) {
        start()
        gcmMissing = false
        choosing = done
        ConnectIQ.sharedInstance()?.showDeviceSelection()
    }

    /** Garmin Connect handing back (SceneDelegate): the watches picked. */
    func handle(_ url: URL) -> Bool {
        guard url.scheme == Self.urlScheme else { return false }
        start()
        let list = (ConnectIQ.sharedInstance()?.parseDeviceSelectionResponse(from: url) as? [IQDevice]) ?? []
        choosing?(list)
        choosing = nil
        return true
    }

    /** The watch Tartan works with, kept between launches. */
    var device: IQDevice? {
        get {
            guard let data = defaults.data(forKey: "garmin.device") else { return nil }
            return try? NSKeyedUnarchiver.unarchivedObject(ofClass: IQDevice.self, from: data)
        }
        set {
            if let d = newValue, let data = try? NSKeyedArchiver.archivedData(withRootObject: d, requiringSecureCoding: true) { defaults.set(data, forKey: "garmin.device") }
            else { defaults.removeObject(forKey: "garmin.device") }
        }
    }

    private func app(_ d: IQDevice) -> IQApp? { IQApp(uuid: Self.appId, store: Self.appId, device: d) }

    private func listen(_ d: IQDevice) {
        ConnectIQ.sharedInstance()?.register(forDeviceEvents: d, delegate: self)
        if let a = app(d) { ConnectIQ.sharedInstance()?.register(forAppMessages: a, delegate: self) }
    }

    func use(_ d: IQDevice) {
        start()
        device = d
        for k in ["key", "title", "date", "error", "app", "askedAt"] { defaults.removeObject(forKey: "garmin.\(k)") }
        listen(d)
    }

    func forget() {
        if started { ConnectIQ.sharedInstance()?.unregister(forAllDeviceEvents: self); ConnectIQ.sharedInstance()?.unregister(forAllAppMessages: self) }
        device = nil
        for k in ["key", "title", "date", "error", "app", "askedAt", "dayKept"] { defaults.removeObject(forKey: "garmin.\(k)") }
    }

    /**
     * A message from the watch app: it asks for the plan ({ t: "want" }), or sends its day
     * ({ t: "day" }, about every half hour and when it opens). The SDK hands them over only while
     * Tartan runs; one while it's closed is lost, so sync() asks the watch for its day again.
     */
    nonisolated func receivedMessage(_ message: Any!, from app: IQApp!) {
        let t = (message as? [String: Any])?["t"] as? String
        if t == "day", let m = message, JSONSerialization.isValidJSONObject(m), let data = try? JSONSerialization.data(withJSONObject: m) {
            let text = String(decoding: data, as: UTF8.self)
            Task { @MainActor in self.onDay?(text) }
            return
        }
        guard t == "want" else { return }
        Task { @MainActor in self.onWant?() }
    }

    nonisolated func deviceStatusChanged(_ device: IQDevice!, status: IQDeviceStatus) {}

    /** How the watch stands, from what was last sent and heard. */
    func now() -> GarminNow? {
        guard let d = device else { return nil }
        return GarminNow(name: d.friendlyName ?? d.modelName ?? "Garmin", gcm: gcmMissing ? "missing" : "ok",
                         app: defaults.object(forKey: "garmin.app") as? Bool,
                         sentTitle: defaults.string(forKey: "garmin.title"), sentDate: defaults.string(forKey: "garmin.date"),
                         error: defaults.string(forKey: "garmin.error"))
    }

    private func installed(_ a: IQApp) async -> Bool? {
        await withCheckedContinuation { (c: CheckedContinuation<Bool?, Never>) in
            let once = Once(c)
            ConnectIQ.sharedInstance()?.getAppStatus(a) { st in once.resume(st.map { $0.isInstalled }) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 8) { once.resume(nil) }
        }
    }

    /**
     * The plan to the watch when it changed since the last send (or `force`): `plan` is the engine's
     * answer to rpc garminPlan (null unless the watch is a Garmin).
     */
    func sync(force: Bool, plan: () async -> String?) async -> GarminNow? {
        guard let d = device else { return nil }
        start()
        listen(d)
        guard let a = app(d) else { return now() }
        if let got = await installed(a) {
            defaults.set(got, forKey: "garmin.app")
            if !got { return now() }
        }
        guard let answer = await plan(), let r = GarminMessage.fromEngine(answer) else { await askDay(a); return now() }
        let key = r.key, msg = r.message
        if !force && key == defaults.string(forKey: "garmin.key") { await askDay(a); return now() }
        let ok: Bool = await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
            let once = Once(c)
            ConnectIQ.sharedInstance()?.sendMessage(msg, to: a, progress: { _, _ in }, completion: { result in once.resume(result.rawValue == 0) })
            DispatchQueue.main.asyncAfter(deadline: .now() + 25) { once.resume(false) }
        }
        if ok {
            let first = GarminMessage.firstTitle(msg)
            defaults.set(key, forKey: "garmin.key")
            defaults.set(first?.0, forKey: "garmin.title")
            defaults.set(first?.1, forKey: "garmin.date")
            defaults.removeObject(forKey: "garmin.error")
        } else {
            defaults.set("not connected", forKey: "garmin.error")
        }
        await askDay(a)
        return now()
    }

    /**
     * Ask the watch app for the day's numbers (it answers with { t: "day" }, to onDay): on the
     * watches whose background takes phone messages it answers even when closed, on the others the
     * next time it opens (when it sends its day anyway). At most every ten minutes.
     */
    private func askDay(_ a: IQApp) async {
        let at = Date().timeIntervalSince1970
        if at - defaults.double(forKey: "garmin.askedAt") < 600 { return }
        defaults.set(at, forKey: "garmin.askedAt")
        let _: Bool = await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
            let once = Once(c)
            ConnectIQ.sharedInstance()?.sendMessage(GarminMessage.askDay, to: a, progress: { _, _ in }, completion: { result in once.resume(result.rawValue == 0) })
            DispatchQueue.main.asyncAfter(deadline: .now() + 20) { once.resume(false) }
        }
    }

    /** A day the engine couldn't take when it came (signalsPut's arguments as JSON): kept for the next sync. */
    func keepDay(_ args: String) { defaults.set(args, forKey: "garmin.dayKept") }
    /** The day kept, taken out (nil when none). */
    func takeKeptDay() -> String? {
        let s = defaults.string(forKey: "garmin.dayKept")
        defaults.removeObject(forKey: "garmin.dayKept")
        return s
    }

    func getWatchApp() { UIApplication.shared.open(Self.watchAppUrl) }
    func getGarminConnect() { ConnectIQ.sharedInstance()?.showAppStoreForConnectMobile() }
}
