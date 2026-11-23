import SwiftUI
import Observation

/// A run being recorded, as the page's recorder holds it (web/recorder.ts), pushed on every change.
struct RecNow: Equatable {
    var status: String
    var start: Date?
    var end: Date?
    var pauses: [(from: Double, to: Double?)]
    var name: String?
    var distance: Double
    var movingS: Int?
    var elevation: Double?
    var avgHr: Int?
    var accuracy: Int?
    var gpsError: String?
    var hrName: String?
    var bpm: Int?
    var nowMps: Double
    var goalKm: Double?
    var planTitle: String?
    var guide: GuideNow?

    static func == (a: RecNow, b: RecNow) -> Bool {
        a.status == b.status && a.distance == b.distance && a.bpm == b.bpm && a.accuracy == b.accuracy && a.pauses.count == b.pauses.count && a.guide?.index == b.guide?.index && a.nowMps == b.nowMps
    }

    static let idle = RecNow(status: "idle", start: nil, end: nil, pauses: [], name: nil, distance: 0, movingS: nil, elevation: nil, avgHr: nil, accuracy: nil, gpsError: nil, hrName: nil, bpm: nil, nowMps: 0)

    /** Seconds moving at `now` (the clock moves without a GPS fix). */
    func moving(_ now: Date) -> Int {
        guard let s = start else { return 0 }
        let e = (end ?? now).timeIntervalSince1970 * 1000
        let paused = pauses.reduce(0.0) { $0 + (($1.to ?? e) - $1.from) }
        return max(0, Int((e - s.timeIntervalSince1970 * 1000 - paused) / 1000))
    }
}

/// A guided run's step (src/workout/guided.ts GuideView).
struct GuideNow {
    let name: String
    let index: Int
    let total: Int
    let label: String
    let detail: String
    let kind: String
    let leftS: Int?
    let leftM: Int?
    let share: Double
    let next: String?
    let done: Bool

    /** "4:10 left", "420 m left". */
    var left: String? {
        if done { return nil }
        if let s = leftS { return "\(s / 60):\(String(format: "%02d", s % 60)) left" }
        return leftM.map { "\($0) m left" }
    }
}

func parseRec(_ json: String) -> RecNow? {
    let o = J(json: json)
    guard o.object != nil else { return nil }
    let sum = o["summary"], hr = o["hr"], g = o["guide"]
    return RecNow(
        status: o["status"].str ?? "idle", start: o["start"].str.flatMap(isoInstant), end: o["end"].str.flatMap(isoInstant),
        pauses: o["pauses"].array.map { (from: $0["from"].num ?? 0, to: $0["to"].num) }, name: o["name"].str,
        distance: sum["distance_m"].num ?? 0, movingS: sum["moving_s"].int, elevation: sum["elevation_m"].num, avgHr: sum["avg_hr"].int.flatMap { $0 > 0 ? $0 : nil },
        accuracy: o["accuracy"].int, gpsError: o["gpsError"].str, hrName: hr["name"].str, bpm: hr["bpm"].int.flatMap { $0 > 0 ? $0 : nil }, nowMps: o["now"].num ?? 0,
        goalKm: o["goal_km"].num.flatMap { $0 > 0 ? $0 : nil }, planTitle: o["plan_title"].str,
        guide: g.object != nil ? GuideNow(name: g["name"].text, index: g["index"].int ?? 0, total: g["total"].int ?? 0, label: g["label"].text, detail: g["detail"].text, kind: g["kind"].text,
                                          leftS: g["left_s"].int, leftM: g["left_m"].int, share: g["share"].num ?? 0, next: g["next"].str.flatMap { $0.isEmpty ? nil : $0 }, done: g["done"].bool) : nil
    )
}

struct PastRun: Identifiable { let id: String; let name: String; let start: String; let km: Double; let movingS: Int; let strava: String? }

/// Record (web/views/record.ts): start, pause, finish a run with the phone's GPS (the page's
/// recorder does it, with the screen off too); keep it and send it to Strava.
@MainActor
@Observable
final class RecordModel {
    private let engine: EngineBridge
    @ObservationIgnored weak var shell: ShellModel?
    /** The run as the page has it; the lock screen and the Dynamic Island follow it (LiveRun). */
    var rec: RecNow = .idle
    var past: [PastRun]?
    var cues = false
    var busy: String?
    var guideOn = true
    var session: (name: String, steps: Int, first: String)?

    init(engine: EngineBridge) { self.engine = engine }

    func ensure() {
        Task {
            if case .success(let j) = await engine.rpc("recCues") { cues = j == "true" }
            if case .success(let j) = await engine.rpc("recGuide") { readGuide(j) }
            await readPast()
            Launch.ready("record")
        }
    }

    private func readPast() async {
        guard let j = await engine.get("/api/recordings") else { return }
        past = J(json: j).array.filter { $0["end"].str != nil }.prefix(20).map {
            PastRun(id: $0["id"].text, name: $0["name"].str ?? "Run", start: $0["start"].text, km: ($0["distance_m"].num ?? 0) / 1000, movingS: $0["moving_s"].int ?? 0, strava: $0["strava"]["status"].str)
        }
    }

    private func readGuide(_ j: String) {
        let o = J(json: j)
        guideOn = o.has("on") ? o["on"].bool : true
        let s = o["session"]
        session = s.object != nil ? (name: s["name"].text, steps: s["steps"].int ?? 0, first: s["first"].text) : nil
    }

    private func run(_ label: String, _ name: String, _ args: [String: Any] = [:], after: ((String) async -> Void)? = nil) {
        busy = label
        Task {
            switch await engine.rpc(name, args) {
            case .success(let r): await after?(r)
            case .failure(let e): shell?.say(e.message)
            }
            busy = nil
        }
    }

    func start() { run("start", "recStart") }
    func pause() { run("pause", "recPause") }
    func resume() { run("resume", "recResume") }
    func finish() { run("finish", "recFinish") }
    func heart() { run("heart", "recHeart") }
    func lap() { run("lap", "recLap") }
    func guide(_ on: Bool) {
        guideOn = on
        Task { if case .success(let j) = await engine.rpc("recGuide", ["on": on]) { readGuide(j) } }
    }
    func voice(_ on: Bool) {
        cues = on
        Task { _ = await engine.rpc("recCues", ["on": on]) }
    }
    func keep(name: String, strava: Bool) {
        run("keep", "recKeep", ["name": name, "strava": strava]) { [weak self] r in
            if let said = J(json: r)["said"].str { self?.shell?.say(said) }
            await self?.readPast()
        }
    }
    func discard() { run("discard", "recDiscard") }
    func upload(_ id: String) {
        run(id, "recUpload", ["id": id]) { [weak self] r in
            if let said = J(json: r).str { self?.shell?.say(said) }
            await self?.readPast()
        }
    }
}

private func pace(_ mps: Double) -> String {
    guard mps > 0.3 else { return "–:––" }
    let s = Int((1000 / mps).rounded())
    return "\(s / 60):\(String(format: "%02d", s % 60))"
}

/// Record, native on iPhone (Android's RecordScreen.kt): a run with the phone's GPS. The page
/// records it (with the screen off too); this draws it, big enough to read on the move, and the
/// lock screen and the Dynamic Island show it while it runs (LiveRun).
struct RecordScreen: View {
    let shell: ShellModel
    let m: RecordModel
    @State private var finishArmed = false
    @State private var name = ""
    @State private var strava = true
    @State private var discarding = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text("A run with your phone's GPS").font(.subheadline.weight(.medium)).foregroundStyle(.secondary).padding(.horizontal, 4)
                    Card {
                        if m.rec.status == "finished" { finished } else { live }
                    }
                    pastCard
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
            }
            .background(Brand.ground)
            .navigationTitle("Record")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { shell.go("today") } label: { Image(systemName: "chevron.left") }.accessibilityLabel("Back to Today")
                }
            }
            .onAppear { m.ensure() }
            .task(id: finishArmed) {
                guard finishArmed else { return }
                try? await Task.sleep(for: .seconds(4))
                finishArmed = false
            }
        }
    }

    @ViewBuilder private var live: some View {
        let r = m.rec
        HStack(spacing: 8) {
            switch r.status {
            case "recording":
                Image(systemName: "circle.fill").font(.caption).foregroundStyle(.red).symbolEffect(.pulse)
                Text("Recording").font(.headline).foregroundStyle(.red)
            case "paused":
                Image(systemName: "pause.fill").foregroundStyle(Brand.watch)
                Text("Paused").font(.headline).foregroundStyle(Brand.watch)
            default:
                Text("Ready to record").font(.headline).foregroundStyle(.secondary)
            }
        }
        if let g = r.guide, r.status != "idle" { GuideCard(g: g, live: r.status == "recording", busy: m.busy == "lap") { m.lap() } }
        TimelineView(.periodic(from: .now, by: 1)) { ctx in
            let moving = r.moving(ctx.date)
            VStack(spacing: 10) {
                HStack(alignment: .top, spacing: 12) {
                    big("Time", clock(moving), "")
                    big("Distance", String(format: "%.2f", r.distance / 1000), "km")
                }
                HStack(spacing: 8) {
                    small("Avg pace", pace(moving > 0 ? r.distance / Double(moving) : 0), "/km")
                    small("Pace now", r.status == "recording" ? pace(r.nowMps) : "–:––", "/km")
                    small("Heart rate", r.bpm.map { "\($0)" } ?? "–", r.bpm != nil ? "bpm" : "")
                }
            }
        }
        Group {
            if let e = r.gpsError {
                Label(e, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red)
            } else if let a = r.accuracy {
                Label(a <= 15 ? "GPS good (±\(a) m)" : a <= 35 ? "GPS fair (±\(a) m)" : "Weak GPS (±\(a) m): distance waits for a better fix", systemImage: "location.fill")
                    .foregroundStyle(a <= 15 ? Brand.good : a <= 35 ? Color.secondary : Brand.watch)
            } else if r.status == "idle" {
                Label("The GPS starts with the run and says when its fix is good; wait for that before you head off.", systemImage: "location")
                    .foregroundStyle(.secondary)
            } else {
                HStack(spacing: 8) { ProgressView(); Text("Finding GPS…").foregroundStyle(.secondary) }
            }
        }
        .font(.subheadline)
        HStack(spacing: 10) {
            if r.status == "idle" {
                Button { m.start() } label: { Label("Start run", systemImage: "play.fill").frame(maxWidth: .infinity, minHeight: 44) }
                    .buttonStyle(.glassProminent).disabled(m.busy != nil)
            } else {
                if r.status == "recording" {
                    Button { m.pause() } label: { Label("Pause", systemImage: "pause.fill").frame(maxWidth: .infinity, minHeight: 44) }.buttonStyle(.glassProminent)
                } else {
                    Button { m.resume() } label: { Label("Resume", systemImage: "play.fill").frame(maxWidth: .infinity, minHeight: 44) }.buttonStyle(.glassProminent)
                }
                // Finishing can't be undone: the first tap asks, the second finishes.
                Button {
                    if finishArmed { finishArmed = false; m.finish() } else { finishArmed = true }
                } label: { Label(finishArmed ? "Tap to finish" : "Finish", systemImage: "stop.fill").frame(maxWidth: .infinity, minHeight: 44) }
                    .buttonStyle(.glass).disabled(m.busy != nil)
            }
        }
        .font(.title3.weight(.semibold))
        .sensoryFeedback(.impact, trigger: r.status)
        Button { m.heart() } label: { Label(r.hrName ?? "Connect heart rate", systemImage: "heart") }
            .buttonStyle(.glass).disabled(m.busy == "heart")
        if r.status == "idle", let s = m.session {
            Toggle(isOn: Binding(get: { m.guideOn }, set: { m.guide($0) })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Guide me through \(s.name.replacingOccurrences(of: #"^\w{3} "#, with: "", options: .regularExpression))").font(.subheadline.weight(.semibold))
                    Text(s.steps > 1 ? "Today's session, step by step: \(s.first), then \(s.steps - 1) more." : "Today's session, step by step: \(s.first).").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        Toggle("Voice cues", isOn: Binding(get: { m.cues }, set: { m.voice($0) })).font(.subheadline.weight(.semibold))
        if r.status == "idle" {
            Text("Keeps recording with the screen off; the lock screen and the Dynamic Island show the run while it does. Heart rate comes from any Bluetooth heart-rate sensor: a chest strap, or a watch that broadcasts it.")
                .font(.footnote).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private var finished: some View {
        let r = m.rec
        let moving = r.movingS ?? r.moving(Date())
        Label("Finished", systemImage: "checkmark").font(.headline).foregroundStyle(Brand.good)
        HStack(alignment: .top, spacing: 12) {
            big("Time", clock(moving), "")
            big("Distance", String(format: "%.2f", r.distance / 1000), "km")
        }
        HStack(spacing: 8) {
            small("Avg pace", pace(moving > 0 ? r.distance / Double(moving) : 0), "/km")
            small("Climb", r.elevation.map { "\(Int($0.rounded()))" } ?? "–", "m")
            small("Avg heart rate", r.avgHr.map { "\($0)" } ?? "–", r.avgHr != nil ? "bpm" : "")
        }
        TextField("Name", text: $name).textFieldStyle(.roundedBorder).onAppear { if name.isEmpty { name = r.name ?? "" } }
        Toggle(isOn: $strava) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Send to Strava").font(.subheadline.weight(.semibold))
                Text("Once it's saved; it joins your library with the next sync, as one workout.").font(.caption).foregroundStyle(.secondary)
            }
        }
        HStack {
            Button { m.keep(name: String(name.prefix(80)), strava: strava) } label: { Label("Save", systemImage: "checkmark") }
                .buttonStyle(.glassProminent).disabled(m.busy != nil)
            Button("Discard", role: .destructive) { discarding = true }
                .confirmationDialog("Discard this run?", isPresented: $discarding, titleVisibility: .visible) {
                    Button("Discard", role: .destructive) { m.discard() }
                    Button("Keep it", role: .cancel) {}
                } message: { Text("It won't be saved anywhere.") }
        }
    }

    private var pastCard: some View {
        Card {
            Text("Recorded on this phone").font(.title3.weight(.bold))
            if let list = m.past {
                if list.isEmpty {
                    Text("Runs you record here appear in Activities too, and on Strava once sent.").font(.subheadline).foregroundStyle(.secondary)
                }
                ForEach(list) { p in
                    HStack {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(p.name).font(.subheadline.weight(.semibold))
                            Text("\(dateShort(p.start)) · \(String(format: "%.2f", p.km)) km · \(clock(p.movingS))").font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if p.strava == "done" {
                            Text("On Strava").font(.caption.weight(.semibold)).foregroundStyle(Brand.good).padding(.horizontal, 10).padding(.vertical, 4).background(Brand.goodContainer, in: Capsule())
                        } else {
                            Button(p.strava == "error" ? "Try again" : "Send to Strava") { m.upload(p.id) }.buttonStyle(.glass).font(.caption.weight(.semibold)).disabled(m.busy != nil)
                        }
                    }
                }
            }
        }
    }

    private func big(_ label: String, _ value: String, _ unit: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(label).font(.subheadline.weight(.medium)).foregroundStyle(.secondary)
            HStack(alignment: .lastTextBaseline, spacing: 4) {
                Text(value).font(.system(size: 52, weight: .semibold, design: .rounded).monospacedDigit()).lineLimit(1).minimumScaleFactor(0.6)
                if !unit.isEmpty { Text(unit).font(.headline).foregroundStyle(.secondary) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private func small(_ label: String, _ value: String, _ unit: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption.weight(.medium)).foregroundStyle(.secondary).lineLimit(1)
            HStack(alignment: .lastTextBaseline, spacing: 2) {
                Text(value).font(.figure(.title2)).lineLimit(1).minimumScaleFactor(0.7)
                if !unit.isEmpty { Text(unit).font(.caption2).foregroundStyle(.secondary) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Brand.well, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

/// A guided run's step: what it is, what's left, what comes next, and Next step.
private struct GuideCard: View {
    let g: GuideNow
    let live: Bool
    let busy: Bool
    let next: () -> Void

    var body: some View {
        let tint = kindColour(g.kind == "run" ? "intervals" : g.kind == "recover" ? "easy" : "long")
        VStack(alignment: .leading, spacing: 6) {
            Text(g.done ? g.name : "\(g.name) · step \(g.index + 1) of \(g.total)").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            HStack(alignment: .lastTextBaseline) {
                Text(g.label).font(.title.weight(.bold))
                Spacer()
                if let l = g.left { Text(l).font(.headline).foregroundStyle(tint) }
            }
            Text(g.detail).font(.body)
            ProgressView(value: min(1, max(0, g.share))).tint(tint)
            HStack {
                Text(g.next.map { "Then: \($0)" } ?? (g.done ? "" : "The last step")).font(.caption).foregroundStyle(.secondary)
                Spacer()
                if !g.done && live { Button("Next step", action: next).buttonStyle(.glass).disabled(busy) }
            }
        }
        .padding(16)
        .background(Brand.well, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }
}
