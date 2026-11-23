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
        for k in ["key", "title", "date", "error", "app"] { defaults.removeObject(forKey: "garmin.\(k)") }
        listen(d)
    }

    func forget() {
        if started { ConnectIQ.sharedInstance()?.unregister(forAllDeviceEvents: self); ConnectIQ.sharedInstance()?.unregister(forAllAppMessages: self) }
        device = nil
        for k in ["key", "title", "date", "error", "app"] { defaults.removeObject(forKey: "garmin.\(k)") }
    }

    nonisolated func receivedMessage(_ message: Any!, from app: IQApp!) {
        guard (message as? [String: Any])?["t"] as? String == "want" else { return }
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
        guard let answer = await plan(), let r = GarminMessage.fromEngine(answer) else { return now() }
        let key = r.key, msg = r.message
        if !force && key == defaults.string(forKey: "garmin.key") { return now() }
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
        return now()
    }

    func getWatchApp() { UIApplication.shared.open(Self.watchAppUrl) }
    func getGarminConnect() { ConnectIQ.sharedInstance()?.showAppStoreForConnectMobile() }
}
