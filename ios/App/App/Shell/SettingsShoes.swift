import SwiftUI
import UIKit
import PhotosUI
import Observation

/// A pair of shoes with what's on them (src/shoes.ts ShoeTotal).
struct ShoePair: Identifiable {
    let id: String
    let name: String
    let since: String
    let startKm: Double
    let limitKm: Double
    let kind: String?
    let retired: String?
    let stravaId: String?
    let photo: String?
    let km: Double
    let runs: Int
    let used: Double

    var type: String { kind ?? kindFromName(name) }
}

/** A guess from the name alone (src/shoes.ts kindFromName). */
func kindFromName(_ name: String) -> String {
    let racing = "\\b(vaporfly|alphafly|metaspeed|adios pro|adizero pro|endorphin (pro|elite)|rocket ?x|sc elite|fuelcell elite|deviate elite|cielo|takumi|racer|spikes?)\\b"
    let trail = "\\b(trail|speedgoat|peregrine|cascadia|xodus|mafate|torrent|sense ride|genesis|terrex|hierro|wildhorse|ultra glide|catamount|agility peak|lone peak)\\b"
    if name.range(of: racing, options: [.regularExpression, .caseInsensitive]) != nil { return "racing" }
    if name.range(of: trail, options: [.regularExpression, .caseInsensitive]) != nil { return "trail" }
    return "daily"
}
func limitFor(_ kind: String) -> Int { kind == "racing" ? 400 : 700 }
private let KINDS = [("daily", "Daily"), ("racing", "Racing"), ("trail", "Trail")]
private func runs(_ n: Int) -> String { "\(n) run\(n == 1 ? "" : "s")" }
private func shortDate(_ iso: String) -> String { dateOf(iso).map { $0.formatted(.dateTime.day().month(.abbreviated).year()) } ?? iso }

/// Shoes in Settings → Training (Android's ShoesModel, web/views/shoes.ts): read, add, edit,
/// retire, remove, set on Strava; the coach can read a pair's name off its photo.
@MainActor
@Observable
final class ShoesModel {
    @ObservationIgnored weak var shell: ShellModel?
    private let engine: EngineBridge
    var shoes: [ShoePair]?
    var stravaOn = false
    var stravaWrite = false
    var toStrava: [String: Int] = [:]
    var coachReady = false
    var busy = false

    init(engine: EngineBridge) { self.engine = engine }

    private func say(_ s: String) { shell?.say(s) }

    func load() async {
        if let j = await engine.get("/api/shoes") { read(j) }
        if let j = await engine.get("/api/coach/status") { coachReady = J(json: j)["ready"].bool }
    }

    private func read(_ json: String) {
        let v = J(json: json)
        guard v.object != nil else { return }
        shoes = v["shoes"].array.map { s in
            ShoePair(id: s["id"].text, name: s["name"].text, since: s["since"].text, startKm: s["start_km"].num ?? 0, limitKm: s["limit_km"].num ?? 700, kind: s["kind"].str,
                     retired: s["retired"].str.flatMap { $0.isEmpty ? nil : $0 }, stravaId: s["strava_id"].str, photo: s["photo"].str, km: s["km"].num ?? 0, runs: s["runs"].int ?? 0, used: s["used"].num ?? 0)
        }
        stravaOn = v["strava"]["connected"].bool
        stravaWrite = v["strava"]["can_write"].bool
        var t: [String: Int] = [:]
        for (k, n) in v["to_strava"].object ?? [:] { t[k] = (n as? NSNumber)?.intValue ?? 0 }
        toStrava = t
    }

    private func send(_ path: String, _ method: String, _ body: [String: Any]?, ok: String) {
        busy = true
        Task {
            let r = await engine.call(path, method: method, body: body.map(jsonText))
            let err = J(json: r.body)["error"].str
            if (200..<300).contains(r.status), err == nil { read(r.body); say(ok) } else { say("Couldn't save: \(err ?? "it didn't go through (\(r.status))")") }
            busy = false
        }
    }

    func save(id: String?, name: String, since: String, startKm: Double, limitKm: Double, kind: String, photo: String?) {
        var b: [String: Any] = ["name": name, "since": since, "start_km": startKm, "limit_km": limitKm, "kind": kind]
        if let id { b["id"] = id }
        if let photo { b["photo"] = photo }
        let n = name.trimmingCharacters(in: .whitespaces)
        send("/api/shoes", "PUT", b, ok: id != nil ? "\(n) saved." : "\(n) added. Runs from \(shortDate(since)) count to them.")
    }

    func retire(_ p: ShoePair) {
        var b: [String: Any] = ["id": p.id, "name": p.name, "since": p.since, "start_km": p.startKm, "limit_km": p.limitKm, "retired": p.retired != nil ? "" : isoDay(Date())]
        if let k = p.kind { b["kind"] = k }
        if let s = p.stravaId { b["strava_id"] = s }
        send("/api/shoes", "PUT", b, ok: p.retired != nil ? "\(p.name) back in use." : "\(p.name) retired at \(Int(p.km.rounded())) km. New runs count to your newest pair.")
    }

    func remove(_ p: ShoePair) {
        send("/api/shoes/\(p.id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? p.id)", "DELETE", nil, ok: "\(p.name) removed. Its runs count to your other pairs.")
    }

    func setOnStrava(_ p: ShoePair) {
        busy = true
        Task {
            let r = await engine.call("/api/shoes/strava", method: "POST", body: jsonText(["shoe": p.id]))
            let o = J(json: r.body)
            if (200..<300).contains(r.status), o.object != nil {
                let left = o["left"].int ?? 0
                say("\(p.name) set on \(runs(o["done"].int ?? 0)) on Strava." + (left > 0 ? " " + (o["stopped"].str ?? "\(left) more: tap again.") : ""))
            } else {
                say("Couldn't set it on Strava.")
            }
            if let j = await engine.get("/api/shoes") { read(j) }
            busy = false
        }
    }

    /** The coach reads the shoe's name off its photo: name, kind, km to retire at. */
    func recognise(_ photo: String) async -> (name: String, kind: String, limit: Int)? {
        let r = await engine.call("/api/shoes/recognise", method: "POST", body: jsonText(["photo": photo]))
        let o = J(json: r.body)
        guard (200..<300).contains(r.status) else { say(o["error"].str ?? "Couldn't read it."); return nil }
        guard let name = o["name"].str else { say("Couldn't tell which shoe that is. Type its name instead."); return nil }
        return (name: name, kind: o["kind"].str ?? "daily", limit: o["limit_km"].int ?? 700)
    }
}

/** A photo of the pair, squared and small (384 px JPEG), as the web keeps it. */
private func squarePhoto(_ image: UIImage) -> String? {
    let side = min(image.size.width, image.size.height)
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    let out = UIGraphicsImageRenderer(size: CGSize(width: 384, height: 384), format: format).image { _ in
        let k = 384 / side
        image.draw(in: CGRect(x: -(image.size.width - side) / 2 * k, y: -(image.size.height - side) / 2 * k, width: image.size.width * k, height: image.size.height * k))
    }
    return out.jpegData(compressionQuality: 0.8).map { "data:image/jpeg;base64," + $0.base64EncodedString() }
}

/// Shoes: each pair with its km against when to retire it, set on Strava, edit, retire; add a pair.
struct ShoesSection: View {
    let shell: ShellModel
    @State private var adding = false
    @State private var editing: String?

    private var m: ShoesModel { shell.shoes }

    var body: some View {
        Section {
            if let list = m.shoes {
                ForEach(list) { p in
                    let worn = p.used >= 0.9 && p.retired == nil
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 12) {
                            Group {
                                if let img = picture(p.photo) { Image(uiImage: img).resizable().scaledToFill() } else { Image(systemName: "camera").foregroundStyle(.secondary) }
                            }
                            .frame(width: 48, height: 48)
                            .background(Brand.well)
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                            VStack(alignment: .leading, spacing: 4) {
                                HStack {
                                    Text(p.name).font(.subheadline.weight(.semibold)).foregroundStyle(p.retired != nil ? Color.secondary : Color.primary)
                                    if p.stravaId != nil { StravaMark().fill(stravaOrange).frame(width: 12, height: 12).accessibilityLabel("On Strava") }
                                    Spacer()
                                    Text("\(Int(p.km.rounded())) km").font(.figure(.subheadline)).foregroundStyle(worn ? Brand.watch : Color.primary)
                                }
                                ProgressView(value: min(1, max(0, p.used))).tint(worn ? Brand.watch : Brand.tint)
                                Text([KINDS.first { $0.0 == p.type }?.1 ?? p.type,
                                      p.retired.map { "retired \(shortDate($0)) · \(runs(p.runs))" } ?? "\(runs(p.runs)) since \(shortDate(p.since)) · retire at \(Int(p.limitKm.rounded())) km"].joined(separator: " · "))
                                    .font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                        HStack(spacing: 14) {
                            Spacer()
                            let pending = m.toStrava[p.id] ?? 0
                            if p.stravaId != nil && pending > 0 && m.stravaWrite && p.retired == nil {
                                Button("Set on Strava · \(runs(pending))") { m.setOnStrava(p) }.disabled(m.busy)
                            }
                            Button("Edit") { withAnimation { editing = editing == p.id ? nil : p.id } }
                            Button(p.retired != nil ? "Back in use" : "Retire") { m.retire(p) }.disabled(m.busy)
                        }
                        .buttonStyle(.borderless)
                        .font(.subheadline)
                        if editing == p.id { PairForm(m: m, pair: p) { editing = nil } }
                    }
                    .padding(.vertical, 4)
                }
                let notOnStrava = m.stravaOn ? list.filter { $0.stravaId == nil && $0.retired == nil } : []
                if !notOnStrava.isEmpty {
                    Text(notOnStrava.count == 1
                         ? "\(notOnStrava[0].name) isn't on Strava. Apps can't add shoes there: add it once in Strava under My Gear, with the same name, and the next sync links it. Then moving a run here moves it on Strava too."
                         : "These aren't on Strava. Apps can't add shoes there: add them once in Strava under My Gear, with the same name, and the next sync links them. Then moving a run here moves it on Strava too.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if adding || list.isEmpty {
                    PairForm(m: m, pair: nil) { adding = false }
                } else {
                    Button { withAnimation { adding = true } } label: { Label("Add a pair", systemImage: "plus") }
                }
            } else {
                ProgressView()
            }
        } header: { Text("Shoes") } footer: {
            if m.shoes?.isEmpty == true {
                Text(m.stravaOn ? "Pairs you have on Strava come in with its sync. Most last 500 to 800 km." : "Most last 500 to 800 km.")
            }
        }
        .task { await m.load() }
    }
}

/// Add a pair, or edit one: a photo (the coach can read the name off it), name, type, first worn,
/// km already, retire at.
private struct PairForm: View {
    let m: ShoesModel
    let pair: ShoePair?
    let done: () -> Void
    @State private var name = ""
    @State private var kind = "daily"
    @State private var kindPicked = false
    @State private var since = Date()
    @State private var start = "0"
    @State private var limit = "700"
    @State private var photo: String?
    @State private var item: PhotosPickerItem?
    @State private var reading = false
    @State private var armed = false
    @State private var filled = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                Group {
                    if let img = picture(photo ?? pair?.photo) { Image(uiImage: img).resizable().scaledToFill() } else { Image(systemName: "camera").foregroundStyle(.secondary) }
                }
                .frame(width: 60, height: 60).background(Brand.well).clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                VStack(alignment: .leading, spacing: 6) {
                    PhotosPicker(selection: $item, matching: .images) { Text(photo ?? pair?.photo != nil ? "Another photo" : "Add a photo") }
                    if let photo, m.coachReady {
                        Button(reading ? "Reading…" : "Read the name off it") {
                            reading = true
                            Task {
                                if let r = await m.recognise(photo) {
                                    name = r.name; kind = r.kind; limit = "\(r.limit)"; kindPicked = true
                                    m.shell?.say("Looks like \(r.name): " + (r.kind == "racing" ? "a racing shoe, so around 400 km." : r.kind == "trail" ? "a trail shoe, around 700 km." : "a daily trainer, around 700 km.") + " Change anything that's off.")
                                }
                                reading = false
                            }
                        }
                        .disabled(reading)
                    }
                }
                .buttonStyle(.borderless)
            }
            TextField("Name", text: Binding(get: { name }, set: { v in
                name = String(v.prefix(40))
                if !kindPicked { kind = kindFromName(v); limit = "\(limitFor(kind))" }
            }), prompt: Text("e.g. Pegasus 41"))
            Picker("Type", selection: Binding(get: { kind }, set: { kind = $0; kindPicked = true; limit = "\(limitFor($0))" })) {
                ForEach(Array(KINDS.enumerated()), id: \.offset) { _, k in Text(k.1).tag(k.0) }
            }
            .pickerStyle(.segmented)
            DatePicker("First worn", selection: $since, in: ...Date(), displayedComponents: .date)
            HStack {
                Text("Km already")
                TextField("0", text: $start).keyboardType(.decimalPad).multilineTextAlignment(.trailing)
            }
            HStack {
                Text("Retire at")
                TextField("700", text: $limit).keyboardType(.decimalPad).multilineTextAlignment(.trailing)
                Text("km").foregroundStyle(.secondary)
            }
            HStack(spacing: 14) {
                Button(pair != nil ? "Save" : "Add the pair") {
                    m.save(id: pair?.id, name: name, since: isoDay(since), startKm: Double(start.replacingOccurrences(of: ",", with: ".")) ?? 0,
                           limitKm: Double(limit.replacingOccurrences(of: ",", with: ".")) ?? 700, kind: kind, photo: photo)
                    done()
                }
                .buttonStyle(.glassProminent)
                .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || m.busy)
                if let pair {
                    Button("Cancel", action: done).buttonStyle(.borderless)
                    Button(armed ? "Tap again to remove" : "Remove", role: .destructive) {
                        if armed { m.remove(pair); done() } else { armed = true }
                    }
                    .buttonStyle(.borderless)
                }
            }
        }
        .padding(.vertical, 6)
        .onAppear {
            guard !filled else { return }
            filled = true
            if let p = pair {
                name = p.name; kind = p.type; kindPicked = true
                since = dateOf(p.since) ?? Date()
                start = "\(Int(p.startKm.rounded()))"; limit = "\(Int(p.limitKm.rounded()))"
            }
        }
        .onChange(of: item) { _, it in
            guard let it else { return }
            Task {
                if let d = try? await it.loadTransferable(type: Data.self), let img = UIImage(data: d) { photo = squarePhoto(img) }
            }
        }
    }
}
