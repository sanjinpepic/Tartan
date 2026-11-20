import Foundation
import UIKit
import Capacitor

/// Which parts are drawn natively on iPhone. Only those built so far can be on (the bar and
/// Today); each can be turned off (Settings → More → Native screens) to compare with the page's.
/// Kept in UserDefaults, so the plugin can answer from the bridge's queue without the main thread.
enum NativeParts {
    static let names = ["nav", "today", "coach", "chat", "activities", "progress", "settings", "workout", "body", "routes", "record"]
    /** The parts iOS has natively so far. */
    static let built: Set<String> = ["nav", "today"]

    static func isOn(_ name: String) -> Bool {
        guard built.contains(name) else { return false }
        return UserDefaults.standard.object(forKey: "tartan.shell.\(name)") as? Bool ?? true
    }

    static func set(_ name: String, _ on: Bool) {
        guard built.contains(name) else { return }
        UserDefaults.standard.set(on, forKey: "tartan.shell.\(name)")
    }

    static func all() -> [String: Any] {
        var out: [String: Any] = [:]
        for n in names { out[n] = isOn(n) }
        return out
    }
}

/// The TartanShell plugin on iPhone (web/lib/shell.ts `ShellPlugin`): native SwiftUI screens over
/// the web app, one part at a time, as Android's TartanShellPlugin does them in Compose.
///
/// The page says where it is after each route (`route`) and answers the native screens' API
/// calls (the "api" event, answered with `reply`, or `chunk` lines then `reply` for a stream), so
/// they read exactly what the web screens read. Parts iOS doesn't have natively yet answer so the
/// page draws its own (`workout`, `intro`, `pair`, `scan`).
@objc(TartanShellPlugin)
public class TartanShellPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TartanShellPlugin"
    public let jsName = "TartanShell"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "parts", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "route", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reply", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "chunk", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "chat", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "workout", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "watch", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "recorder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "intro", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "snack", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pair", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scan", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "feel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "leave", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "changed", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "board", returnType: CAPPluginReturnPromise),
    ]

    override public func load() {
        let plugin = self
        onMain { ShellModel.shared.attach(plugin) }
    }

    /// An event to the page, on the bridge's own queue (where listeners are added), so an event
    /// kept for a listener that isn't there yet is never lost to a race. `retain`: kept until the
    /// page listens.
    func emit(_ event: String, _ data: [String: Any], retain: Bool = false) {
        let queue = (bridge as? CapacitorBridge)?.dispatchQueue ?? DispatchQueue.main
        queue.async { [weak self] in
            self?.notifyListeners(event, data: data, retainUntilConsumed: retain)
        }
    }

    // MARK: - What the page asks

    @objc func parts(_ call: CAPPluginCall) {
        var out = NativeParts.all()
        out["available"] = true
        call.resolve(out)
    }

    /// A part switched on or off from the page's Settings (only parts iOS has), and the colours.
    @objc func configure(_ call: CAPPluginCall) {
        for name in NativeParts.built {
            if let on = call.getBool(name) { NativeParts.set(name, on) }
        }
        onMain { ShellModel.shared.partsChanged() }
        call.resolve(NativeParts.all())
    }

    /// Where the web app is: the view, the address after the #, whether a sheet or the keyboard is open.
    @objc func route(_ call: CAPPluginCall) {
        let view = call.getString("view") ?? "today"
        let hash = call.getString("hash") ?? ""
        let hidden = call.getBool("hidden") ?? false
        onMain { ShellModel.shared.route(view: view, hash: hash, pageOpen: hidden) }
        call.resolve()
    }

    @objc func reply(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { return call.reject("no id") }
        let status = call.getInt("status") ?? 599
        let body = call.getString("body") ?? ""
        onMain { ShellModel.shared.engine.finish(id, status, body) }
        call.resolve()
    }

    /// One line of a streamed answer, as the page reads it.
    @objc func chunk(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let line = call.getString("line") else { return call.resolve() }
        onMain { ShellModel.shared.engine.line(id, line) }
        call.resolve()
    }

    /// The chat isn't native on iPhone yet: the page opens its own (it asks only when `chat` is on).
    @objc func chat(_ call: CAPPluginCall) {
        call.resolve()
    }

    /// A workout's sheet: the page's own on iPhone for now.
    @objc func workout(_ call: CAPPluginCall) {
        call.resolve(["native": false])
    }

    /// The watch's state, for a native Sources (not on iPhone yet).
    @objc func watch(_ call: CAPPluginCall) {
        call.resolve()
    }

    /// The run being recorded, for a native Record (not on iPhone yet).
    @objc func recorder(_ call: CAPPluginCall) {
        call.resolve()
    }

    /// The intro is the page's on iPhone: refusing tells it to open its own.
    @objc func intro(_ call: CAPPluginCall) {
        call.reject("The intro isn't native on iPhone yet")
    }

    /// The page's messages, native, over everything (their buttons take the touch).
    @objc func snack(_ call: CAPPluginCall) {
        let s = Snack(id: call.getInt("id") ?? 0, text: call.getString("text") ?? "", error: call.getBool("error") ?? false, action: call.getString("action"), ms: call.getInt("ms"))
        onMain { ShellModel.shared.show(s) }
        call.resolve()
    }

    /// Pairing with the PC: the page's own sheet on iPhone.
    @objc func pair(_ call: CAPPluginCall) {
        call.reject("Pairing isn't native on iPhone yet")
    }

    /// The QR scanner: the page's own on iPhone.
    @objc func scan(_ call: CAPPluginCall) {
        call.reject("The scanner isn't native on iPhone yet")
    }

    /// A click you feel, asked for by the page.
    @objc func feel(_ call: CAPPluginCall) {
        let kind = call.getString("kind") ?? "click"
        onMain { Haptics.feel(kind) }
        call.resolve()
    }

    /// Android's back on Today leaves the app; iPhone has no back button, so nothing to do.
    @objc func leave(_ call: CAPPluginCall) {
        call.resolve()
    }

    /// The page wrote something (a sync, a mark, a save): native screens read again.
    @objc func changed(_ call: CAPPluginCall) {
        onMain { ShellModel.shared.changed() }
        call.resolve()
    }

    /// The sync board's lanes, as the web chip shows them.
    @objc func board(_ call: CAPPluginCall) {
        let raw = call.getArray("lanes", JSObject.self) ?? []
        let lanes = raw.map { o in
            Lane(
                id: o["id"] as? String ?? "",
                state: o["state"] as? String ?? "",
                text: o["text"] as? String ?? "",
                glyph: o["glyph"] as? String ?? "",
                name: o["name"] as? String ?? "",
                status: o["status"] as? String ?? "",
                failed: o["failed"] as? Bool ?? false
            )
        }
        onMain { ShellModel.shared.board = lanes }
        call.resolve()
    }
}

/// Work for the native layer, on the main thread, in the order it was asked for (a route after
/// a route), unlike tasks.
func onMain(_ work: @escaping @MainActor () -> Void) {
    DispatchQueue.main.async { MainActor.assumeIsolated { work() } }
}

/// A click you feel: the same three kinds as Android's (Feel.kt).
@MainActor
enum Haptics {
    static func feel(_ kind: String) {
        switch kind {
        case "detent": UISelectionFeedbackGenerator().selectionChanged()
        case "confirm": UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        default: UIImpactFeedbackGenerator(style: .light).impactOccurred()
        }
    }
}
