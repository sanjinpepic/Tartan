import SwiftUI
import UIKit
import PhotosUI
import Observation

/// The builder's swatches (web/views/face.ts PALETTE).
private let FACE_PALETTE: [(String, String)] = [
    ("Tartan", "#e0452b"), ("Finish", "#ff6a4d"), ("Brick", "#a8321f"), ("Deep tartan", "#7d2615"), ("Rust", "#5a1f14"), ("Ember", "#3d120a"),
    ("Cream", "#fdf3ee"), ("White", "#ffffff"), ("Stone", "#8f817d"), ("Slate", "#5a5250"), ("Graphite", "#3d3634"), ("Ink", "#201a19"), ("Black", "#000000"),
    ("Infield", "#8fe3b4"), ("Moss", "#4f9a6f"), ("Pine", "#1f5c3a"), ("Forest", "#0f2a1c"),
    ("Lane blue", "#a3c6ff"), ("Steel", "#6f8fbf"), ("Navy", "#2a5fa8"), ("Midnight", "#1d3557"), ("Deep sea", "#13233a"),
    ("Amber", "#ffbe3d"), ("Gold", "#b8860b"), ("Lilac", "#c588ff"), ("Rose", "#ff467e"),
]
private let ARTS = [("none", "None"), ("sunburst", "Sunburst"), ("stripes", "Racing stripes"), ("split", "Split"), ("rings", "Rings"), ("zones", "Heart zones"), ("contours", "Contours"), ("checker", "Chequered"), ("lanes", "Lanes"), ("halftone", "Halftone"), ("watermark", "Big T")]
private let PARTS = [("hands", "Hands"), ("marks", "Five-minute marks"), ("minor", "Minute marks"), ("numerals", "Numerals"), ("track", "Track"), ("finish", "Finish line"), ("logo", "The T"), ("text", "Text"), ("caps", "Centre caps"), ("art", "Pattern")]

/// A colour as #rrggbb.
func hexColour(_ s: String) -> Color {
    var v: UInt64 = 0
    guard s.hasPrefix("#"), s.count == 7, Scanner(string: String(s.dropFirst())).scanHexInt64(&v) else { return .black }
    return Color(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
}

private func light(_ s: String) -> Bool {
    var v: UInt64 = 0
    guard s.count == 7, Scanner(string: String(s.dropFirst())).scanHexInt64(&v) else { return false }
    let r = Double((v >> 16) & 0xFF), g = Double((v >> 8) & 0xFF), b = Double(v & 0xFF)
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5
}

struct FacePreset: Identifiable {
    let id: Int
    let name: String
    let design: [String: Any]
    let picture: UIImage?
}

/**
 * #face/<id>, new, copy, native (Android's FaceModel, web/views/face.ts): a watch face for the Run 2.
 * The design is the page's FaceDesign as JSON; the page draws it (facePreview) and saves, packs and
 * installs it.
 */
@MainActor
@Observable
final class FaceModel {
    @ObservationIgnored weak var shell: ShellModel?
    private let engine: EngineBridge
    let arg: String
    var d: [String: Any]?
    var saved = false
    var savedId: String?
    var dirty = false
    var presets: [FacePreset] = []
    var preview: UIImage?
    var showData = true
    var canBluetooth = false
    var busy: String?
    var status: String?
    /** Which part the palette colours: a key of colours, or s0…s6 for the seconds hand. */
    var part = "hands"
    /** Bumped on every change, for the preview to follow. */
    var version = 0
    @ObservationIgnored private var leaveArmed = false

    init(engine: EngineBridge, arg: String) {
        self.engine = engine
        self.arg = arg
    }

    private func say(_ s: String) { shell?.say(s) }

    func load() async {
        switch await engine.rpc("faceStart", ["arg": arg, "size": 200]) {
        case .success(let j):
            let o = J(json: j)
            saved = o["saved"].bool
            canBluetooth = o["canBluetooth"].bool
            dirty = !saved
            d = o["design"].object
            presets = o["presets"].array.enumerated().compactMap { i, p in
                p["design"].object.map { FacePreset(id: i, name: p["name"].text, design: $0, picture: picture(p["picture"].str)) }
            }
            version += 1
        case .failure(let e):
            say(e.message.isEmpty ? "Couldn't open the face." : e.message)
        }
    }

    func str(_ k: String) -> String { d?[k] as? String ?? "" }
    func bool(_ k: String) -> Bool { (d?[k] as? NSNumber)?.boolValue ?? (d?[k] as? Bool) ?? false }
    var colours: [String: Any] { d?["colours"] as? [String: Any] ?? [:] }
    var seconds: [Any] { d?["seconds"] as? [Any] ?? [] }
    var bg: [String: Any] { d?["background"] as? [String: Any] ?? ["kind": "black"] }

    /** A change: the design and the preview follow. */
    func edit(_ f: (inout [String: Any]) -> Void) {
        guard var cur = d else { return }
        f(&cur)
        d = cur
        dirty = true
        version += 1
    }
    func set(_ k: String, _ v: Any) { edit { $0[k] = v } }
    func setBg(_ k: String, _ v: Any) { edit { var b = $0["background"] as? [String: Any] ?? [:]; b[k] = v; $0["background"] = b } }

    func colourOf(_ p: String) -> String {
        if p.hasPrefix("s"), let i = Int(p.dropFirst()), i < seconds.count { return seconds[i] as? String ?? "#000000" }
        return colours[p] as? String ?? "#000000"
    }

    func setColour(_ c: String) {
        let p = part
        edit { d in
            if p.hasPrefix("s"), let i = Int(p.dropFirst()) {
                var s = d["seconds"] as? [Any] ?? []
                while s.count <= i { s.append("#ffffff") }
                s[i] = c
                d["seconds"] = s
            } else {
                var c2 = d["colours"] as? [String: Any] ?? [:]
                c2[p] = c
                d["colours"] = c2
            }
        }
    }

    /** Start again from a design (or a surprise), keeping the name and id. */
    func replace(_ next: [String: Any]) {
        guard let cur = d else { return }
        var n = next
        n["id"] = cur["id"]
        n["name"] = cur["name"]
        d = n
        dirty = true
        version += 1
    }

    func surprise() {
        guard let id = d?["id"] else { return }
        Task {
            switch await engine.rpc("faceSurprise", ["id": "\(id)"]) {
            case .success(let j): if let n = J(json: j).object { replace(n) }
            case .failure(let e): say(e.message)
            }
        }
    }

    func drawPreview() async {
        guard let cur = d else { return }
        if case .success(let r) = await engine.rpc("facePreview", ["design": cur, "size": 600, "data": showData]), let img = picture(J(json: r).str) {
            preview = img
            Launch.ready("face")
        }
    }

    /** Saved first (installing and packing work on the saved face). */
    private func persist() async -> String? {
        guard let cur = d else { return nil }
        switch await engine.rpc("faceSave", ["design": cur, "saved": saved]) {
        case .success(let j):
            guard let f = J(json: j).object else { return nil }
            d = f; saved = true; dirty = false
            let id = J(f)["id"].text
            savedId = id
            shell?.watchSettings.forget()
            return id
        case .failure(let e):
            say(e.message)
            return nil
        }
    }

    private func run(_ label: String, _ f: @escaping () async -> Void) {
        guard busy == nil else { return }
        busy = label
        Task { await f(); busy = nil }
    }

    func save() { run("save") { if await self.persist() != nil { self.say("Saved \(self.str("name")).") } } }

    func install() {
        run("install") {
            guard let id = await self.persist() else { return }
            self.status = "Sending to your watch…"
            switch await self.engine.rpc("faceInstall", ["id": id]) {
            case .success(let r): self.status = J(json: r).str.flatMap { $0.isEmpty ? nil : $0 } ?? "On your watch."
            case .failure(let e): self.status = nil; self.say(e.message)
            }
        }
    }

    func pack() {
        run("zip") {
            guard let id = await self.persist() else { return }
            if case .failure(let e) = await self.engine.rpc("facePackage", ["id": id]) { self.say(e.message) }
        }
    }

    func removeFromWatch() {
        run("remove") {
            switch await self.engine.rpc("faceRemove", ["id": self.str("id"), "name": self.str("name")]) {
            case .success(let r): self.status = r == "true" ? "Off your watch now." : "It wasn't on your watch."
            case .failure(let e): self.say(e.message)
            }
        }
    }

    func delete(after: @escaping (String) -> Void) {
        run("delete") {
            let name = self.str("name")
            let r = await self.engine.call("/api/faces/\(self.str("id"))", method: "DELETE")
            if (200..<300).contains(r.status) {
                self.shell?.watchSettings.forget()
                self.dirty = false
                after("Deleted \(name) from Tartan. If it's on your watch, Watch → Check the watch takes it off.")
            } else {
                self.say("Couldn't delete it (\(r.status)).")
            }
        }
    }

    /** Photo: cropped square from the middle, 466 px, as JPEG (web/lib/faces.ts photoBackground). */
    func photo(_ image: UIImage) {
        let side = min(image.size.width, image.size.height)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let out = UIGraphicsImageRenderer(size: CGSize(width: 466, height: 466), format: format).image { _ in
            let k = 466 / side
            image.draw(in: CGRect(x: -(image.size.width - side) / 2 * k, y: -(image.size.height - side) / 2 * k, width: image.size.width * k, height: image.size.height * k))
        }
        guard let data = out.jpegData(compressionQuality: 0.85) else { say("Couldn't read that photo."); return }
        let dim = bg["kind"] as? String == "photo" ? (bg["dim"] as? NSNumber)?.doubleValue ?? 0.35 : 0.35
        set("background", ["kind": "photo", "image": "data:image/jpeg;base64," + data.base64EncodedString(), "dim": dim] as [String: Any])
    }

    /** Leaving with changes asks once. */
    func mayLeave() -> Bool {
        if !dirty || d == nil || leaveArmed { return true }
        leaveArmed = true
        say("This face has changes that aren't saved. Tap back again to leave it.")
        Task {
            try? await Task.sleep(for: .seconds(4))
            leaveArmed = false
        }
        return false
    }
}

/// The face builder (Android's FaceBuilderScreen): the watch stays in view while the controls
/// scroll under it: start from a design, the background, track and marks, numbers and text, the
/// hands, the colours part by part, the watch's data, and save and send.
struct FaceBuilderScreen: View {
    let shell: ShellModel
    let m: FaceModel
    @State private var minute = 0

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Button {
                    if m.mayLeave() { shell.back() }
                } label: { Image(systemName: "chevron.left").font(.headline).frame(width: 44, height: 44) }
                    .buttonStyle(.glass).buttonBorderShape(.circle)
                    .accessibilityLabel("Back")
                VStack(alignment: .leading, spacing: 2) {
                    Text("Face builder").font(.title2.weight(.bold)).accessibilityAddTraits(.isHeader)
                    Text("A watch face for your Suunto Run 2").font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            ZStack {
                Circle().fill(Color(red: 0.16, green: 0.14, blue: 0.14))
                Circle().fill(Color.black).padding(8)
                if let p = m.preview {
                    Image(uiImage: p).resizable().scaledToFit().clipShape(Circle()).padding(8)
                        .accessibilityLabel("The face as it stands")
                } else {
                    ProgressView().tint(.white)
                }
            }
            .frame(width: 184, height: 184)
            .padding(.vertical, 12)
            if m.d != nil {
                ScrollView {
                    VStack(spacing: 12) {
                        StartCard(m: m)
                        BackgroundCard(m: m)
                        FaceCard(title: "Track and marks", icon: "arrow.clockwise") {
                            Choices(label: "Track", options: [("lanes", "Lanes"), ("filled", "Filled"), ("single", "One ring"), ("dashed", "Dashes"), ("bezel", "Bezel with minutes"), ("none", "None")], now: m.str("track")) { m.set("track", $0) }
                            Toggle(isOn: Binding(get: { m.bool("finish") }, set: { m.set("finish", $0) })) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Finish line at 12")
                                    Text("Across the track, like the line on a real one.").font(.footnote).foregroundStyle(.secondary)
                                }
                            }
                            Choices(label: "Marks", options: [("all", "Every minute"), ("fives", "Every five"), ("quarters", "Quarters"), ("none", "None")], now: m.str("marks")) { m.set("marks", $0) }
                            Choices(label: "Mark shape", options: [("line", "Lines"), ("bar", "Bars"), ("dot", "Dots")], now: m.str("markShape")) { m.set("markShape", $0) }
                        }
                        FaceCard(title: "Numbers and text", icon: "clock", sub: "Numbers only fit at 12 and 9: the watch draws its own data everywhere else. A big 12 takes the place of the T or your text.") {
                            Choices(label: "Numerals", options: [("none", "None"), ("arabic", "12 and 9"), ("roman", "XII and IX"), ("big", "One big 12")], now: m.str("numerals")) { m.set("numerals", $0) }
                            Choices(label: "Above the centre", options: [("top", "The T"), ("text", "Your text"), ("none", "Nothing")], now: m.str("logo")) { m.set("logo", $0) }
                            if m.str("logo") == "text" {
                                field("Your text (up to 6 characters)", Binding(get: { m.str("text") }, set: { m.set("text", String($0.prefix(6))) }), prompt: "e.g. SUB3")
                            }
                        }
                        FaceCard(title: "Hands", icon: "watch.analog") {
                            Choices(label: "Hour and minute", options: [("classic", "Classic"), ("slim", "Slim"), ("baton", "Baton"), ("sword", "Sword"), ("arrow", "Arrow"), ("skeleton", "Skeleton"), ("dauphine", "Dauphine"), ("block", "Block"), ("pencil", "Pencil")], now: m.str("hands")) { m.set("hands", $0) }
                            Choices(label: "Seconds", options: [("needle", "Needle"), ("lollipop", "Lollipop"), ("arrow", "Arrow"), ("plain", "Plain")], now: m.str("secondsStyle")) { m.set("secondsStyle", $0) }
                            Choices(label: "Centre caps", options: [("dot", "Dot"), ("ring", "Ring"), ("none", "None")], now: m.str("caps")) { m.set("caps", $0) }
                        }
                        ColoursCard(m: m)
                        FaceCard(title: "Data", icon: "info.circle", sub: "The watch draws its own data over the face, in the face's accent colour (the first seconds colour): the compass, the battery, the day, and two spots you fill on the watch.") {
                            Toggle(isOn: Binding(get: { m.showData }, set: { m.showData = $0; m.version += 1 })) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Show the watch's data")
                                    Text("In the preview here.").font(.footnote).foregroundStyle(.secondary)
                                }
                            }
                        }
                        ActionsCard(shell: shell, m: m)
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 32)
                }
                .scrollDismissesKeyboard(.interactively)
            } else {
                Spacer()
            }
        }
        .background(Brand.ground)
        .task { if m.d == nil { await m.load() } }
        // The preview follows each change, and the clock.
        .task(id: "\(m.version)-\(minute)") {
            try? await Task.sleep(for: .milliseconds(120))
            guard !Task.isCancelled else { return }
            await m.drawPreview()
        }
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                minute = Int(Date().timeIntervalSince1970 / 60)
            }
        }
    }
}

/// A card of the builder: its title with an icon, an optional line under it, then what it holds.
private struct FaceCard<Content: View>: View {
    let title: String
    let icon: String
    var sub: String?
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label(title, systemImage: icon).font(.headline)
            if let sub { Text(sub).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .background(Brand.card, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
    }
}

private func field(_ label: String, _ text: Binding<String>, prompt: String = "") -> some View {
    VStack(alignment: .leading, spacing: 4) {
        Text(label).font(.subheadline.weight(.medium)).foregroundStyle(.secondary)
        TextField(label, text: text, prompt: Text(prompt))
            .padding(.horizontal, 14).frame(height: 44)
            .background(Brand.well, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

/// A short set of choices as chips, the chosen one ticked.
private struct Choices: View {
    let label: String
    let options: [(String, String)]
    let now: String
    let pick: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.subheadline.weight(.medium)).foregroundStyle(.secondary)
            Flow(spacing: 6) {
                ForEach(Array(options.enumerated()), id: \.offset) { _, o in
                    let on = now == o.0
                    Button {
                        Haptics.feel("click")
                        pick(o.0)
                    } label: {
                        HStack(spacing: 4) {
                            if on { Image(systemName: "checkmark").font(.caption.weight(.bold)) }
                            Text(o.1).font(.subheadline)
                        }
                        .foregroundStyle(on ? Brand.onContainer : Color.primary)
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .background(on ? Brand.container : Brand.well, in: Capsule())
                    }
                    .buttonStyle(Press())
                    .accessibilityAddTraits(on ? .isSelected : [])
                }
            }
        }
    }
}

/// The swatches, and any colour as #rrggbb.
private struct Palette: View {
    let now: String
    let pick: (String) -> Void
    @State private var text = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Flow(spacing: 8) {
                ForEach(Array(FACE_PALETTE.enumerated()), id: \.offset) { _, c in
                    let on = now.lowercased() == c.1
                    Button {
                        Haptics.feel("click")
                        pick(c.1)
                    } label: {
                        Circle().fill(hexColour(c.1)).frame(width: 34, height: 34)
                            .overlay(Circle().stroke(on ? Brand.tint : Color.secondary.opacity(0.4), lineWidth: on ? 3 : 1))
                            .overlay { if on { Image(systemName: "checkmark").font(.caption.weight(.bold)).foregroundStyle(light(c.1) ? Color.black : Color.white) } }
                    }
                    .buttonStyle(Press())
                    .accessibilityLabel(c.0)
                    .accessibilityAddTraits(on ? .isSelected : [])
                }
            }
            field("Any colour", Binding(get: { text }, set: { t in
                text = t
                if t.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) != nil { pick(t.lowercased()) }
            }), prompt: "#e0452b")
        }
        .onAppear { text = now }
        .onChange(of: now) { _, v in text = v }
    }
}

private struct StartCard: View {
    let m: FaceModel

    var body: some View {
        FaceCard(title: "Your face", icon: "watch.analog") {
            field("Name", Binding(get: { m.str("name") }, set: { m.set("name", String($0.prefix(30))) }))
            HStack {
                Text("Start from a design").font(.subheadline.weight(.medium)).foregroundStyle(.secondary)
                Spacer()
                Button { m.surprise() } label: { Label("Surprise me", systemImage: "sparkles") }.buttonStyle(.glass)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(m.presets) { p in
                        Button { m.replace(p.design) } label: {
                            VStack(spacing: 4) {
                                Group { if let img = p.picture { Image(uiImage: img).resizable().scaledToFit() } else { Color.black } }
                                    .frame(width: 76, height: 76).clipShape(Circle())
                                Text(p.name).font(.caption.weight(.medium)).lineLimit(2).multilineTextAlignment(.center)
                            }
                            .frame(width: 84)
                        }
                        .buttonStyle(Press())
                        .foregroundStyle(Color.primary)
                        .accessibilityLabel("Start from \(p.name)")
                    }
                }
            }
        }
    }
}

private struct BackgroundCard: View {
    let m: FaceModel
    @State private var item: PhotosPickerItem?
    @State private var dim: Double = 0.35

    var body: some View {
        let bg = m.bg
        let kind = bg["kind"] as? String ?? "black"
        FaceCard(title: "Background", icon: "sun.max", sub: "Black is kindest to the battery: an AMOLED screen doesn't light black pixels.") {
            Choices(label: "Background", options: [("black", "Black"), ("colour", "Colour"), ("gradient", "Gradient"), ("tartan", "Tartan plaid"), ("photo", "Photo")], now: kind) { v in
                let next: [String: Any]
                switch v {
                case "colour": next = ["kind": "colour", "colour": "#201a19"]
                case "gradient": next = ["kind": "gradient", "from": "#5a1f14", "to": "#000000"]
                case "tartan": next = ["kind": "tartan", "colour": "#7d2615", "dim": 0.45]
                case "photo": next = ["kind": "photo", "image": "", "dim": 0.35]
                default: next = ["kind": "black"]
                }
                m.set("background", next)
            }
            switch kind {
            case "colour": Palette(now: bg["colour"] as? String ?? "") { m.setBg("colour", $0) }
            case "gradient":
                Text("Centre").font(.subheadline.weight(.medium)).foregroundStyle(.secondary)
                Palette(now: bg["from"] as? String ?? "") { m.setBg("from", $0) }
                Text("Edge").font(.subheadline.weight(.medium)).foregroundStyle(.secondary)
                Palette(now: bg["to"] as? String ?? "") { m.setBg("to", $0) }
            case "tartan":
                Text("Plaid colour").font(.subheadline.weight(.medium)).foregroundStyle(.secondary)
                Palette(now: bg["colour"] as? String ?? "") { m.setBg("colour", $0) }
            case "photo":
                PhotosPicker(selection: $item, matching: .images) {
                    Label((bg["image"] as? String ?? "").isEmpty ? "Choose a photo" : "Another photo", systemImage: "camera")
                }
                .buttonStyle(.glass)
                .disabled(m.busy != nil)
            default: EmptyView()
            }
            if kind == "tartan" || kind == "photo" {
                Text("Darken it so the hands stand out").font(.subheadline.weight(.medium)).foregroundStyle(.secondary)
                Slider(value: $dim, in: 0...0.8, step: 0.05, onEditingChanged: { editing in if !editing { m.setBg("dim", dim) } })
            }
            Choices(label: "Pattern", options: ARTS, now: m.str("art")) { m.set("art", $0) }
            Text("The pattern takes its colour from Pattern under Colours. Heart zones has its own five.").font(.footnote).foregroundStyle(.secondary)
        }
        .onAppear { dim = (bg["dim"] as? NSNumber)?.doubleValue ?? 0.35 }
        .onChange(of: kind) { _, _ in dim = (m.bg["dim"] as? NSNumber)?.doubleValue ?? 0.35 }
        .onChange(of: item) { _, it in
            guard let it else { return }
            Task {
                if let data = try? await it.loadTransferable(type: Data.self), let img = UIImage(data: data) { m.photo(img) }
                else { m.shell?.say("Couldn't read that photo.") }
            }
        }
    }
}

private struct ColoursCard: View {
    let m: FaceModel

    var body: some View {
        FaceCard(title: "Colours", icon: "drop", sub: "Pick a part, then its colour.") {
            parts(PARTS)
            Text("Seconds hand: the watch lets you choose one of these seven").font(.subheadline.weight(.medium)).foregroundStyle(.secondary)
            parts((0..<7).map { ("s\($0)", $0 == 0 ? "1 · default" : "\($0 + 1)") })
            Palette(now: m.colourOf(m.part)) { m.setColour($0) }
        }
    }

    private func parts(_ list: [(String, String)]) -> some View {
        Flow(spacing: 6) {
            ForEach(Array(list.enumerated()), id: \.offset) { _, p in
                let on = m.part == p.0
                Button { m.part = p.0 } label: {
                    HStack(spacing: 6) {
                        Circle().fill(hexColour(m.colourOf(p.0))).frame(width: 14, height: 14).overlay(Circle().stroke(Color.secondary.opacity(0.4), lineWidth: 1))
                        Text(p.1).font(.subheadline)
                    }
                    .foregroundStyle(on ? Brand.onContainer : Color.primary)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(on ? Brand.container : Brand.well, in: Capsule())
                }
                .buttonStyle(Press())
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
    }
}

private struct ActionsCard: View {
    let shell: ShellModel
    let m: FaceModel

    var body: some View {
        FaceCard(title: "Save and send", icon: "paperplane") {
            Button {
                Haptics.feel("confirm")
                m.save()
            } label: {
                HStack {
                    if m.busy == "save" { ProgressView() }
                    Text(m.saved && !m.dirty ? "Saved" : "Save").font(.headline)
                }
                .frame(maxWidth: .infinity, minHeight: 40)
            }
            .buttonStyle(.glassProminent)
            .disabled(m.busy != nil)
            HStack(spacing: 8) {
                Button { m.install() } label: {
                    Label("Install on watch", systemImage: "watch.analog").frame(maxWidth: .infinity, minHeight: 32)
                }
                .buttonStyle(.glass)
                .disabled(m.busy != nil || !m.canBluetooth)
                Button { m.pack() } label: { Label(".zip", systemImage: "arrow.down").frame(minHeight: 32) }
                    .buttonStyle(.glass)
                    .disabled(m.busy != nil)
            }
            if !m.canBluetooth {
                Text("Installing needs Bluetooth: connect the watch under Sources.").font(.footnote).foregroundStyle(.secondary)
            }
            if let s = m.status { Text(s).font(.subheadline) }
            if m.saved {
                HStack(spacing: 16) {
                    TwoTap(label: "Remove from watch", again: "Tap again to remove", danger: true, enabled: m.busy == nil && m.canBluetooth) { m.removeFromWatch() }
                    TwoTap(label: "Delete face", again: "Tap again to delete", danger: true, enabled: m.busy == nil) {
                        m.delete { word in
                            shell.go("settings/watch")
                            shell.say(word)
                        }
                    }
                }
                .font(.subheadline)
                .buttonStyle(.borderless)
            }
        }
    }
}
