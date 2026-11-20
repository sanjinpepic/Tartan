import SwiftUI
import UIKit
import Observation

/// A picture from the page (a data URL) as an image.
func picture(_ url: String?) -> UIImage? {
    guard let url, let comma = url.firstIndex(of: ",") else { return nil }
    return Data(base64Encoded: String(url[url.index(after: comma)...]), options: .ignoreUnknownCharacters).flatMap(UIImage.init(data:))
}

struct FaceItem: Identifiable {
    let id: String
    let name: String
    let builtin: Bool
    let onWatch: Bool
    let picture: UIImage?
}

struct Fuel {
    let drink: Bool
    let drinkMin: Int
    let gel: Bool
    let gelMin: Int
    let fromMin: Int
}

struct WeekFace {
    let picture: UIImage?
    let bases: [(id: String, name: String)]
    let base: String
    var keep: Bool
}

/// Settings → Watch (Android's WatchGroupModel, web/views/watch-settings.ts): guided workouts'
/// reminders, the week on a face, routes; and the face builder's list (under More → Advanced).
@MainActor
@Observable
final class WatchGroupModel {
    @ObservationIgnored weak var shell: ShellModel?
    private let engine: EngineBridge
    var faces: [FaceItem]?
    var canBluetooth = true
    var onWatch: (total: Int, mine: [(id: String, name: String)])?
    var fuel: Fuel?
    var runner: String?
    var week: WeekFace?
    var busy: String?
    var weekLine: String?
    @ObservationIgnored private var read = false

    init(engine: EngineBridge) { self.engine = engine }

    private func say(_ s: String) { shell?.say(s) }

    func forget() { read = false }

    func ensure() {
        guard !read else { return }
        read = true
        Task {
            if case .success(let j) = await engine.rpc("fuel") { readFuel(j) }
            await readRunner()
            await weekFace([:])
            if case .success(let j) = await engine.rpc("faces", ["size": 160]) {
                let o = J(json: j)
                canBluetooth = o.has("canBluetooth") ? o["canBluetooth"].bool : true
                faces = o["faces"].array.map { FaceItem(id: $0["id"].text, name: $0["name"].text, builtin: $0["builtin"].bool, onWatch: $0["onWatch"].bool, picture: picture($0["picture"].str)) }
            }
            Launch.ready("watchsettings")
        }
    }

    private func readFuel(_ j: String) {
        let o = J(json: j)
        fuel = Fuel(drink: o["drink"].bool, drinkMin: o["drinkMin"].int ?? 15, gel: o["gel"].bool, gelMin: o["gelMin"].int ?? 40, fromMin: o["fromMin"].int ?? 75)
    }

    func setFuel(_ change: [String: Any]) {
        Task { if case .success(let j) = await engine.rpc("fuel", ["set": change]) { readFuel(j) } }
    }

    /** The step runner (the owner's build only; nil in the public build). */
    func readRunner() async {
        if case .success(let j) = await engine.rpc("runner") {
            let o = J(json: j)
            runner = o["public"].bool ? nil : o["choice"].str
        }
    }

    func pickRunner(_ c: String) {
        runner = c
        Task { _ = await engine.rpc("runner", ["set": c]) }
    }

    private func weekFace(_ args: [String: Any]) async {
        var a = args
        a["size"] = 296
        switch await engine.rpc("weekFace", a) {
        case .success(let j):
            let o = J(json: j)
            guard o.object != nil else { week = nil; return }
            week = WeekFace(picture: picture(o["picture"].str), bases: o["bases"].array.map { (id: $0["id"].text, name: $0["name"].text) }, base: o["base"].text, keep: o["keep"].bool)
            if let s = o["said"].str { weekLine = s }
        case .failure(let e):
            say(e.message)
        }
    }

    func weekBase(_ id: String) { Task { await weekFace(["base": id]) } }
    func weekKeep(_ on: Bool) { week?.keep = on; Task { await weekFace(["keep": on]) } }
    func weekSend() {
        busy = "week"
        weekLine = "Drawing the face and sending it…"
        Task { await weekFace(["send": true]); busy = nil }
    }

    func install(_ f: FaceItem) {
        busy = f.id
        Task {
            switch await engine.rpc("faceInstall", ["id": f.id, "builtin": f.builtin]) {
            case .success: say("\(f.name) is on your watch.")
            case .failure(let e): say(e.message)
            }
            busy = nil
            read = false
            ensure()
        }
    }

    func check() {
        busy = "check"
        Task {
            switch await engine.rpc("facesOnWatch") {
            case .success(let j):
                let o = J(json: j)
                onWatch = (total: o["total"].int ?? 0, mine: o["mine"].array.map { (id: $0["id"].text, name: $0["name"].text) })
            case .failure(let e): say(e.message)
            }
            busy = nil
        }
    }

    func remove(_ id: String, _ name: String) {
        busy = id
        Task {
            switch await engine.rpc("faceRemove", ["id": id, "name": name]) {
            case .success(let r):
                say(r == "true" ? "\(name) is off your watch." : "\(name) wasn't on your watch.")
                if let w = onWatch { onWatch = (total: w.total - 1, mine: w.mine.filter { $0.id != id }) }
            case .failure(let e): say(e.message)
            }
            busy = nil
        }
    }
}

/// Settings → Watch: the coming week as guided workouts, their drink and gel reminders, the week on
/// a face, and routes.
struct WatchGroup: View {
    let shell: ShellModel
    let m: SettingsModel
    private var w: WatchGroupModel { shell.watchSettings }

    var body: some View {
        Section {
            if let ww = m.watchWeek, ww["wanted"].int ?? 0 > 0 {
                LabeledContent("On your watch", value: "\(ww["onWatch"].int ?? 0) of \(ww["wanted"].int ?? 0)")
                Button { Task { await m.act("watchWeek", ["send": true], busy: "week") { j in j["line"].str } } } label: {
                    Label(m.busy == "week" ? "Sending…" : "Send the coming week", systemImage: "watch.analog")
                }
                .disabled(m.busy != nil || ww["canBluetooth"].bool == false)
            } else {
                Text("With a plan, the coming 7 days go to your watch as guided workouts.").font(.subheadline).foregroundStyle(.secondary)
            }
            if let f = w.fuel {
                Toggle(isOn: Binding(get: { f.drink }, set: { w.setFuel(["drink": $0]) })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Drink reminders")
                        Text(f.drink ? "A few sips every \(f.drinkMin) minutes." : "Off: no drink reminders.").font(.footnote).foregroundStyle(.secondary)
                    }
                }
                if f.drink {
                    Picker("Every", selection: Binding(get: { f.drinkMin }, set: { w.setFuel(["drinkMin": $0]) })) {
                        ForEach([10, 15, 20], id: \.self) { Text("\($0) min").tag($0) }
                    }
                    .pickerStyle(.segmented)
                }
                Toggle(isOn: Binding(get: { f.gel }, set: { w.setFuel(["gel": $0]) })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Gel reminders")
                        Text(f.gel ? "A gel every \(f.gelMin) minutes." : "Off: no gel reminders.").font(.footnote).foregroundStyle(.secondary)
                    }
                }
                if f.gel {
                    Picker("Every", selection: Binding(get: { f.gelMin }, set: { w.setFuel(["gelMin": $0]) })) {
                        ForEach([30, 40, 45], id: \.self) { Text("\($0) min").tag($0) }
                    }
                    .pickerStyle(.segmented)
                }
            }
        } header: { Text("Guided workouts") } footer: {
            Text(w.fuel.map { "Drink and gel reminders on sessions over \($0.fromMin) minutes. Changes reach the watch the next time you send the week. Start a workout from the sport mode's workout options on the watch." }
                 ?? "Start one from the sport mode's workout options on the watch.")
        }
        if let wf = w.week {
            Section {
                HStack(spacing: 14) {
                    Group {
                        if let p = wf.picture { Image(uiImage: p).resizable().scaledToFit() } else { Color.black }
                    }
                    .frame(width: 132, height: 132)
                    .clipShape(Circle())
                    .accessibilityLabel("Your week on a watch face")
                    Text("Each day's mark from your plan: filled for hard or long, a ring for easy, a square for strength. With the week's focus and kilometres.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if wf.bases.count > 1 {
                    Picker("Drawn on", selection: Binding(get: { wf.base }, set: { w.weekBase($0) })) {
                        ForEach(Array(wf.bases.enumerated()), id: \.offset) { _, b in Text(b.name).tag(b.id) }
                    }
                }
                Button { w.weekSend() } label: { Label("Put it on the watch", systemImage: "watch.analog") }
                    .disabled(!w.canBluetooth || w.busy != nil)
                if w.busy == "week" { ProgressView().frame(maxWidth: .infinity, alignment: .leading) }
                if let l = w.weekLine { Text(l).font(.footnote) }
                Toggle(isOn: Binding(get: { wf.keep }, set: { w.weekKeep($0) })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Keep it up to date")
                        Text("When a new week starts or this week's plan changes, the next watch sync sends the new face.").font(.footnote).foregroundStyle(.secondary)
                    }
                }
            } header: { Text("Your week on a face") } footer: {
                Text("A face is a picture made once, and the watch can't switch faces by itself: after an update, pick Tartan Week again. That's why it changes once a week, not every day.")
            }
        }
        Section {
            Button { shell.go("routes") } label: { Label("Open Routes", systemImage: "point.topleft.down.to.point.bottomright.curvepath") }
        } header: { Text("Routes") } footer: { Text("Made under Activities → Routes, sent to the watch with a prompt at every turn.") }
            .onAppear { w.ensure() }
    }
}

/// The watch face builder's list (Settings → More → Advanced): Tartan's faces and yours, a tap to
/// open one in the builder, the watch button to install it; Design a face; what's on the watch.
struct FaceList: View {
    let shell: ShellModel
    @State private var armed: String?
    private var m: WatchGroupModel { shell.watchSettings }

    var body: some View {
        Text("Design your own watch faces (colours, track, hands, a photo) and install them on your Suunto over Bluetooth.").font(.footnote).foregroundStyle(.secondary)
        if let list = m.faces {
            ForEach(list) { f in
                HStack(spacing: 12) {
                    Button { shell.go(f.builtin ? "face/copy" : "face/\(f.id)") } label: {
                        HStack(spacing: 12) {
                            Group { if let p = f.picture { Image(uiImage: p).resizable().scaledToFit() } else { Color.black } }
                                .frame(width: 56, height: 56).clipShape(Circle())
                            VStack(alignment: .leading, spacing: 2) {
                                Text(f.name).font(.subheadline.weight(.semibold))
                                Text(f.builtin ? "Tartan's own · tap to make it yours" : f.onWatch ? "On your watch" : "Not on your watch yet").font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                    }
                    .buttonStyle(.borderless)
                    .foregroundStyle(Color.primary)
                    Spacer()
                    Button { m.install(f) } label: {
                        if m.busy == f.id { ProgressView() } else { Image(systemName: "watch.analog") }
                    }
                    .buttonStyle(.glass)
                    .disabled(!m.canBluetooth || m.busy != nil)
                    .accessibilityLabel("Install \(f.name) on the watch")
                }
            }
            HStack {
                Button { shell.go("face/new") } label: { Label("Design a face", systemImage: "plus") }.buttonStyle(.glassProminent)
                Button { m.check() } label: { Label("Check the watch", systemImage: "watch.analog") }.buttonStyle(.glass)
                    .disabled(!m.canBluetooth || m.busy != nil)
            }
            if m.busy == "check" { ProgressView().frame(maxWidth: .infinity, alignment: .leading) }
            if let o = m.onWatch {
                Text("\(o.total) face\(o.total == 1 ? "" : "s") on the watch, \(o.mine.count) of them Tartan's. \(o.mine.isEmpty ? "" : "Remove takes one off, as Uninstall does in the Suunto app.") Suunto's own faces are managed in the Suunto app.")
                    .font(.footnote).foregroundStyle(.secondary)
                ForEach(Array(o.mine.enumerated()), id: \.offset) { _, f in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(f.name).font(.subheadline.weight(.semibold))
                            Text("On your watch · \(f.id)").font(.footnote).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button(armed == f.id ? "Tap again to remove" : "Remove", role: .destructive) {
                            if armed == f.id { m.remove(f.id, f.name); armed = nil } else { armed = f.id }
                        }
                        .disabled(m.busy != nil)
                        .buttonStyle(.borderless)
                    }
                }
            }
        } else {
            ProgressView().onAppear { m.ensure() }
        }
    }
}
