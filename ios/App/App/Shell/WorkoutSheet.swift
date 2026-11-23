import SwiftUI
import MapKit
import Charts

/// A workout (Android's WorkoutSheet.kt; web/views/detail.ts): where it came from, its route,
/// the headline numbers, how it finished against the plan, your notes, the charts along the
/// way, heart-rate zones, its shoes, splits and its sources.
struct WorkoutSheetView: View {
    let m: WorkoutModel
    let shell: ShellModel
    @Environment(\.dismiss) private var dismiss
    /** The share preview (ShareWorkout.swift): the picture on its colour, a map or a photo. */
    @State private var sharing = false

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        if let e = m.failed {
                            ContentUnavailableView {
                                Label(e, systemImage: "exclamationmark.triangle")
                            } description: {
                                Text("It may still be syncing. Try again in a moment.")
                            }
                        } else if let w = m.workout {
                            WorkoutContent(m: m, w: w, shell: shell)
                        } else {
                            ProgressView().controlSize(.large).frame(maxWidth: .infinity, minHeight: 300)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 32)
                    // What it read arrives in place of the spinner with a crossfade, not a jump.
                    .animation(Motion.settle, value: m.workout != nil)
                }
                .task(id: m.workout?.id) {
                    // Opened from the note after the run (or "Just in"): the map and its moments in view.
                    guard m.atMoments, let w = m.workout, !w.moments.isEmpty else { return }
                    try? await Task.sleep(for: .milliseconds(350))
                    withAnimation(Motion.settle) { proxy.scrollTo("moments", anchor: .center) }
                    // Screenshots (Launch): one of them chosen.
                    guard Launch.open == "moments" else { return }
                    if let k = Launch.moment {
                        try? await Task.sleep(for: .seconds(1))
                        m.pick(k - 1)
                    }
                    try? await Task.sleep(for: .seconds(2))
                    Launch.ready("moments")
                }
            }
            .background(Brand.ground)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if m.workout != nil {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { sharing = true } label: { Image(systemName: "square.and.arrow.up") }.accessibilityLabel("Share as a picture")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }.accessibilityLabel("Close")
                }
            }
            .sheet(isPresented: $sharing) {
                if let w = m.workout { ShareWorkoutSheet(w: w) }
            }
        }
        .task {
            await m.load()
            // Screenshots (Launch): the share preview over the workout.
            if Launch.open == "workoutshare", m.workout != nil {
                try? await Task.sleep(for: .seconds(1))
                sharing = true
            }
        }
    }
}

private struct WorkoutContent: View {
    let m: WorkoutModel
    let w: Workout
    let shell: ShellModel

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: sportSymbol(w.sport))
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(Brand.onContainer)
                .frame(width: 48, height: 48)
                .background(Brand.container, in: Circle())
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(w.name ?? sportTitle(w.sport)).font(.title2.weight(.bold)).accessibilityAddTraits(.isHeader)
                Text(whenLine(w)).font(.subheadline).foregroundStyle(.secondary)
                if let wx = w.weather { WxSentence(w: wx).padding(.top, 2) }
            }
        }
        .padding(.top, 8)
        Flow(spacing: 6) {
            ForEach(sources, id: \.self) { s in
                Label(Words.source[s] ?? s, systemImage: s == "watch" ? "watch.analog" : s == "strava" ? "figure.run" : s == "phone" ? "iphone" : "folder")
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 10).padding(.vertical, 5)
                    .background(Brand.card, in: Capsule())
            }
            if w.copies.count > 1 {
                Label("Matched: one workout", systemImage: "checkmark")
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 10).padding(.vertical, 5)
                    .background(Brand.card, in: Capsule())
            }
        }
        // What it earned: a new best, the longest run, a race (src/milestones.ts).
        if !m.milestones.isEmpty { MilestoneLines(list: m.milestones) }
        if let d = w.description { Text(d).font(.body) }
        // The route, and under it what the run's moments say, each tied to its stretch on the map.
        if w.route.count >= 2 || !w.moments.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                if w.route.count >= 2 { RouteMap(route: w.route, label: "Route of \(w.name ?? sportTitle(w.sport))", moments: w.moments, chosen: m.moment, pick: { m.pick($0) }) }
                MomentRows(moments: w.moments, chosen: m.moment, pick: { m.pick($0) })
            }
            .id("moments")
        }
        StatsGrid(w: w)
        if w.isRun, let f = m.finish { FinishCard(f: f, m: m, shell: shell) }
        if let l = w.load, let rank = l.rank {
            Text("Effort scores how long and how hard (by heart rate) a workout was. This one: \(l.label.lowercased()), \(rank).")
                .font(.footnote).foregroundStyle(.secondary).padding(.horizontal, 4)
        }
        NotesCard(m: m, shell: shell)
        if let a = m.along, !a.km.isEmpty { AlongCard(a: a, run: w.isRun, moments: w.moments, chosen: m.moment) }
        if w.zones.contains(where: { $0.seconds > 0 }) { ZonesCard(zones: w.zones) }
        if w.shod && !m.shoes.isEmpty { ShoesRow(m: m, shell: shell) }
        if !w.splits.isEmpty { SplitsCard(w: w) }
        SourcesCard(w: w)
        if w.toldOnly { RemoveTold(m: m) }
    }

    private var sources: [String] {
        var seen: [String] = []
        for c in w.copies where !seen.contains(c.source) { seen.append(c.source) }
        return seen.sorted { (Words.order.firstIndex(of: $0) ?? 99) < (Words.order.firstIndex(of: $1) ?? 99) }
    }
}

func whenLine(_ w: Workout) -> String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
    let d = w.startLocal.flatMap { f.date(from: String($0.prefix(19))) } ?? isoInstant(w.start)
    var bits: [String] = []
    if let d {
        bits.append(d.formatted(.dateTime.weekday(.wide).day().month(.wide).year()))
        bits.append(d.formatted(.dateTime.hour().minute()))
    }
    if let dev = w.device { bits.append(dev) }
    return bits.joined(separator: " · ")
}

/// A moment's colour: done well in the positive green, to work on in the accent.
func momentColour(_ good: Bool) -> Color { good ? Brand.good : Brand.tint }
/// The number's colour on it.
func momentInk(_ good: Bool) -> Color { good ? Brand.goodContainer : Color.white }

/// The route on the map, flat and still (a picture of where you went). With a run's moments:
/// each stretch glows in its colour under the line and a numbered pin sits at its middle; tapping
/// a pin chooses it, the others step back and the map eases in to frame it (at once with Reduce
/// Motion). The pins aren't read out on their own: the rows under the map say the same.
private struct RouteMap: View {
    let route: [(lat: Double, lon: Double)]
    let label: String
    var moments: [RunMoment] = []
    var chosen: Int = -1
    var pick: (Int) -> Void = { _ in }
    @Environment(\.accessibilityReduceMotion) private var still
    @State private var position: MapCameraPosition

    init(route: [(lat: Double, lon: Double)], label: String, moments: [RunMoment] = [], chosen: Int = -1, pick: @escaping (Int) -> Void = { _ in }) {
        self.route = route
        self.label = label
        self.moments = moments
        self.chosen = chosen
        self.pick = pick
        let coords = route.map { CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lon) }
        _position = State(initialValue: .rect(RouteMap.bounds(coords)))
    }

    var body: some View {
        let coords = route.map { CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lon) }
        Map(position: $position, interactionModes: []) {
            ForEach(moments) { mo in
                MapPolyline(coordinates: stretch(mo))
                    .stroke(glowColour(mo), style: glowStyle(mo))
            }
            MapPolyline(coordinates: coords).stroke(Brand.tint, style: StrokeStyle(lineWidth: 4, lineCap: .round, lineJoin: .round))
            if let first = coords.first { Annotation("", coordinate: first) { Circle().fill(Brand.good).frame(width: 12, height: 12).overlay(Circle().stroke(.white, lineWidth: 2)) } }
            if let last = coords.last { Annotation("", coordinate: last) { Circle().fill(Brand.tint).frame(width: 12, height: 12).overlay(Circle().stroke(.white, lineWidth: 2)) } }
            ForEach(moments.filter { $0.at != nil }) { mo in
                Annotation("", coordinate: CLLocationCoordinate2D(latitude: mo.at!.lat, longitude: mo.at!.lon)) {
                    MomentPin(n: mo.index + 1, good: mo.good, on: chosen == mo.index, back: chosen >= 0 && chosen != mo.index)
                        .onTapGesture { pick(mo.index) }
                        .accessibilityHidden(true)
                }
            }
        }
        .mapStyle(.standard(elevation: .flat, pointsOfInterest: .excludingAll))
        .frame(height: 220)
        .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
        .accessibilityLabel(label)
        .animation(still ? nil : .smooth(duration: 0.3), value: chosen)
        .onChange(of: chosen) {
            let target = frame(coords)
            withAnimation(still ? nil : .smooth(duration: 0.9)) { position = .rect(target) }
        }
    }

    private func stretch(_ mo: RunMoment) -> [CLLocationCoordinate2D] {
        mo.line.map { CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lon) }
    }

    /** How strongly a stretch glows: the chosen one most, the others stepping back while one is chosen. */
    private func glowColour(_ mo: RunMoment) -> Color {
        let on = chosen == mo.index
        let alpha: Double = on ? 0.55 : chosen >= 0 ? 0.14 : 0.32
        return momentColour(mo.good).opacity(alpha)
    }

    private func glowStyle(_ mo: RunMoment) -> StrokeStyle {
        let width: CGFloat = chosen == mo.index ? 16 : 12
        return StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round)
    }

    /** Where the map looks: the whole route, or the chosen moment with room round it (no closer than 2.4 times). */
    private func frame(_ coords: [CLLocationCoordinate2D]) -> MKMapRect {
        let whole = RouteMap.bounds(coords)
        guard let mo = moments.first(where: { $0.index == chosen }) else { return whole }
        var pts = mo.line.map { CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lon) }
        if let at = mo.at { pts.append(CLLocationCoordinate2D(latitude: at.lat, longitude: at.lon)) }
        guard !pts.isEmpty else { return whole }
        let r = RouteMap.bounds(pts)
        let w = max(r.size.width, whole.size.width / 2.4)
        let h = max(r.size.height, whole.size.height / 2.4)
        let x = r.midX - w / 2
        let y = r.midY - h / 2
        return MKMapRect(x: x, y: y, width: w, height: h)
    }

    static func bounds(_ c: [CLLocationCoordinate2D]) -> MKMapRect {
        let points = c.map { MKMapPoint($0) }
        let minX = points.map(\.x).min() ?? 0, maxX = points.map(\.x).max() ?? 0
        let minY = points.map(\.y).min() ?? 0, maxY = points.map(\.y).max() ?? 0
        let w = max(maxX - minX, 600), h = max(maxY - minY, 600)
        return MKMapRect(x: minX - w * 0.12, y: minY - h * 0.12, width: w * 1.24, height: h * 1.24)
    }
}

/// A moment's pin: its number in a small circle in its colour, ringed in white.
private struct MomentPin: View {
    let n: Int
    let good: Bool
    let on: Bool
    let back: Bool

    var body: some View {
        let size: CGFloat = on ? 24 : 20
        Text("\(n)")
            .font(.caption2.weight(.bold))
            .foregroundStyle(momentInk(good))
            .frame(width: size, height: size)
            .background(momentColour(good), in: Circle())
            .overlay(Circle().stroke(.white, lineWidth: 2))
            .opacity(back ? 0.55 : 1)
    }
}

/// Under the map, a compact row for each moment: its number in a small circle in its colour, then
/// the line. Tap one to choose it on the map and the charts; tap it again to let it go. Nothing at
/// all when there are none.
private struct MomentRows: View {
    let moments: [RunMoment]
    let chosen: Int
    let pick: (Int) -> Void
    @Environment(\.accessibilityReduceMotion) private var still

    var body: some View {
        if !moments.isEmpty {
            VStack(spacing: 2) {
                ForEach(moments) { mo in row(mo) }
            }
        }
    }

    private func row(_ mo: RunMoment) -> some View {
        let on = chosen == mo.index
        return Button {
            withAnimation(still ? nil : .smooth(duration: 0.3)) { pick(mo.index) }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text("\(mo.index + 1)")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(momentInk(mo.good))
                    .frame(width: 22, height: 22)
                    .background(momentColour(mo.good), in: Circle())
                Text(mo.text)
                    .font(.subheadline)
                    .foregroundStyle(.primary)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 9)
            .background(on ? Brand.card : Color.clear, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(mo.spoken)
        .accessibilityAddTraits(on ? AccessibilityTraits([.isButton, .isSelected]) : AccessibilityTraits.isButton)
    }
}

/// The headline numbers, two to a row.
private struct StatsGrid: View {
    let w: Workout

    var body: some View {
        let stats = items
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 6), GridItem(.flexible(), spacing: 6)], spacing: 6) {
            ForEach(Array(stats.enumerated()), id: \.offset) { _, s in Tile(label: s.0, value: s.1, unit: s.2) }
        }
    }

    private var items: [(String, String, String)] {
        var out: [(String, String, String)] = []
        if let d = w.distanceKm { out.append(("Distance", String(format: "%.2f", d), "km")) }
        out.append(("Moving time", w.movingMin.map(duration) ?? "–", ""))
        if w.isRun, let p = w.pace { out.append(("Avg pace", p, "/km")) } else if let s = w.speedKmh { out.append(("Avg speed", String(format: "%.1f", s), "km/h")) }
        if let h = w.avgHr { out.append(("Avg heart rate", "\(h)", "bpm")) }
        if let h = w.maxHr { out.append(("Max heart rate", "\(h)", "bpm")) }
        if let e = w.elevationM { out.append(("Climb", "\(Int(e.rounded()))", "m")) }
        if let l = w.load { out.append((l.estimated ? "Effort (estimated)" : "Effort", "\(Int(l.load.rounded()))", l.label.lowercased())) }
        if let c = w.calories, c > 0 { out.append(("Energy", "\(Int(c.rounded()))", "kcal")) }
        return out
    }
}

/// A titled card in the sheet.
private struct Section2<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content
    var body: some View {
        Card {
            Text(title).font(.title3.weight(.bold)).accessibilityAddTraits(.isHeader)
            content
        }
    }
}

/// How the run finished (src/run-finish.ts): against the plan, records, against last time, and next time's change.
struct FinishCard: View {
    let f: Finish
    let m: WorkoutModel
    let shell: ShellModel

    var body: some View {
        Section2(title: "Against the plan") {
            if let p = f.plan {
                row("checkmark", p.title) {
                    Text(planLine(p)).font(.subheadline).foregroundStyle(.secondary)
                }
            }
            if !f.records.isEmpty {
                row("sparkles", f.records.contains { $0.rank == 1 } ? "Records" : "Among your best") {
                    Flow(spacing: 6) {
                        ForEach(Array(f.records.prefix(4).enumerated()), id: \.offset) { _, r in
                            Text("\(Text("\(Words.rank[safe: r.rank] ?? "") \(Words.distance[r.name] ?? r.name)").fontWeight(.semibold)) \(clock(r.timeS))")
                                .font(.caption)
                                .padding(.horizontal, 10).padding(.vertical, 5)
                                .background(r.rank == 1 ? Brand.goodContainer : Brand.well, in: Capsule())
                        }
                    }
                }
            }
            if let l = f.last {
                row(l.verdict == "fitter" ? "arrow.up.right" : l.verdict == "harder" ? "arrow.down.right" : "clock.arrow.circlepath", "Against last time") {
                    Text(l.text).font(.subheadline)
                    Text(compareLine(l)).font(.caption).foregroundStyle(.secondary)
                }
            }
            if let n = f.next {
                row("sparkles", "Next time: \(dayName(n.date)) \(dateShort(n.date)), \(n.title)") {
                    Text("\(Text(Words.rule[n.rule] ?? n.rule).fontWeight(.bold).foregroundStyle(ruleColour(n.rule))) \(n.why)").font(.subheadline)
                    if n.applied { Text("Changed on the plan.").font(.caption).foregroundStyle(.secondary) }
                    if let s = n.shiftS {
                        if n.applied {
                            Button("Undo") { Task { if let said = await m.adjust() { shell.say(said) } } }.font(.subheadline.weight(.semibold)).disabled(m.busy)
                        } else {
                            Button("Use it: \(abs(s)) s/km \(s < 0 ? "faster" : "easier")") { Task { if let said = await m.adjust() { shell.say(said) } } }
                                .buttonStyle(.glass).disabled(m.busy)
                        }
                    }
                }
            }
        }
    }

    private func compareLine(_ l: Finish.Last) -> String {
        let nowHr = l.nowHr.map { "\($0)" } ?? "–"
        let thenHr = l.hr.map { "\($0)" } ?? "–"
        let name = l.name.map { " (\($0))" } ?? ""
        return "Now \(l.nowPace ?? "–") /km at \(nowHr) bpm; \(dayName(l.date)) \(dateShort(l.date))\(name): \(l.pace ?? "–") /km at \(thenHr) bpm"
    }

    private func planLine(_ p: Finish.PlanDone) -> String {
        if let t = p.total, t > 1 { return "\(p.onTarget ?? 0) of \(t) reps on target" }
        if let s = p.summary { return s.hasSuffix(".") ? String(s.dropLast()) : s }
        return "Done"
    }

    private func ruleColour(_ r: String) -> Color {
        switch r {
        case "faster": return Brand.good
        case "easier", "slow down": return Brand.watch
        default: return Brand.tint
        }
    }

    private func row<C: View>(_ icon: String, _ title: String, @ViewBuilder _ content: () -> C) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon).font(.subheadline.weight(.semibold)).foregroundStyle(Brand.tint).frame(width: 22).padding(.top, 2)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.subheadline.weight(.semibold))
                content()
            }
            Spacer(minLength: 0)
        }
    }
}

/// Your notes on the run, and a new one: a tag and a few words.
private struct NotesCard: View {
    let m: WorkoutModel
    let shell: ShellModel
    @State private var tag = "note"
    @State private var text = ""
    @State private var area: String?
    @State private var adding = false
    @FocusState private var typing: Bool

    private struct NoteTag: Identifiable { let id: String; let label: String; let icon: String; let hint: String }
    private let tags = [
        NoteTag(id: "win", label: "Win", icon: "sparkles", hint: "e.g. first sub-25 5k"),
        NoteTag(id: "niggle", label: "Niggle", icon: "exclamationmark.triangle", hint: "e.g. tight after the hills"),
        NoteTag(id: "note", label: "Note", icon: "bookmark", hint: "e.g. windy, started too fast"),
    ]

    var body: some View {
        Section2(title: "Your notes") {
            if let f = m.feeling {
                HStack(spacing: 10) {
                    HStack(spacing: 4) { ForEach(1...5, id: \.self) { k in Circle().fill(k <= f ? Brand.good : Brand.well).frame(width: 10, height: 10) } }
                    Text("Felt \((FEELING[f] ?? "").lowercased())").font(.subheadline.weight(.semibold))
                    Text("on your watch").font(.footnote).foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
            }
            ForEach(m.notes) { n in
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: tags.first { $0.id == n.tag }?.icon ?? "bookmark").foregroundStyle(n.tag == "niggle" ? Brand.watch : n.tag == "win" ? Brand.good : Color.secondary)
                    VStack(alignment: .leading, spacing: 2) {
                        Text([tags.first { $0.id == n.tag }?.label ?? "Note", n.area.map(areaName)].compactMap { $0 }.joined(separator: " · ")).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                        if !n.text.isEmpty { Text(n.text).font(.subheadline) }
                    }
                    Spacer(minLength: 0)
                    Button { Task { await m.removeNote(n) } } label: { Image(systemName: "xmark").font(.caption.weight(.bold)).foregroundStyle(.secondary) }
                        .accessibilityLabel("Remove this note")
                }
            }
            if adding {
                Picker("Kind", selection: $tag) {
                    ForEach(tags) { t in Text(t.label).tag(t.id) }
                }
                .pickerStyle(.segmented)
                if tag == "niggle" {
                    Text("Where?").font(.subheadline.weight(.medium)).foregroundStyle(.secondary)
                    Flow(spacing: 6) {
                        ForEach(AREAS, id: \.self) { a in
                            Button(areaName(a)) { area = area == a ? nil : a }
                                .buttonStyle(.bordered)
                                .tint(area == a ? Brand.tint : Color.secondary)
                        }
                    }
                }
                TextField(tags.first { $0.id == tag }?.hint ?? "", text: $text, axis: .vertical)
                    .lineLimit(1...4)
                    .textFieldStyle(.roundedBorder)
                    .focused($typing)
                    .submitLabel(.done)
                    .onSubmit { keep() }
                HStack {
                    Button("Keep it") { keep() }.buttonStyle(.glassProminent).disabled(text.trimmingCharacters(in: .whitespaces).isEmpty && !(tag == "niggle" && area != nil))
                    Button("Cancel") { adding = false; text = ""; area = nil }.buttonStyle(.glass)
                }
            } else {
                Button { adding = true; typing = true } label: { Label("Add a note", systemImage: "plus") }.font(.subheadline.weight(.semibold))
            }
        }
    }

    private func keep() {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty || (tag == "niggle" && area != nil) else { return }
        let a = tag == "niggle" ? area : nil
        let k = tag
        Task {
            shell.say(await m.addNote(tag: k, text: t, area: a))
            text = ""; area = nil; tag = "note"; adding = false
        }
    }
}

/// Pace (or speed), heart rate and elevation along the distance; touch one to read it.
private struct AlongCard: View {
    let a: Along
    let run: Bool
    /** The run's moments, their stretches shaded; the chosen one stands out. */
    var moments: [RunMoment] = []
    var chosen: Int = -1
    @Environment(\.accessibilityReduceMotion) private var still
    @State private var at: Int?

    var body: some View {
        Section2(title: "Along the way") {
            if let p = a.pace { chart(p, colour: Brand.fitness, title: run ? "Pace" : "Speed", say: { run ? "\(clock(Int($0))) /km" : String(format: "%.1f km/h", $0) }, flip: run) }
            if let h = a.hr { chart(h, colour: Brand.fatigue, title: "Heart rate", say: { "\(Int($0)) bpm" }, flip: false) }
            if let e = a.alt { chart(e, colour: Color.secondary, title: "Elevation", say: { "\(Int($0)) m" }, flip: false) }
        }
    }

    @ViewBuilder private func chart(_ v: [Double?], colour: Color, title: String, say: @escaping (Double) -> String, flip: Bool) -> some View {
        let points = v.enumerated().compactMap { i, y in y.map { (i: i, y: $0) } }
        if points.count > 2 {
            let shown = at.flatMap { i in v.indices.contains(i) ? v[i] : nil }
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(title).font(.subheadline.weight(.semibold))
                    Spacer()
                    if let y = shown, let i = at { Text("\(say(y)) at \(kmText(a.km[i])) km").font(.caption.monospacedDigit()).foregroundStyle(.secondary) }
                }
                Chart {
                    ForEach(moments) { mo in
                        RectangleMark(xStart: .value("km", mo.fromKm), xEnd: .value("km", max(mo.toKm, mo.fromKm + 0.02)))
                            .foregroundStyle(band(mo))
                    }
                    ForEach(points, id: \.i) { p in
                        LineMark(x: .value("km", a.km[p.i]), y: .value(title, p.y)).foregroundStyle(colour).interpolationMethod(.catmullRom)
                    }
                    if let i = at, a.km.indices.contains(i) {
                        RuleMark(x: .value("km", a.km[i])).foregroundStyle(Color.secondary.opacity(0.5))
                    }
                }
                .chartYScale(domain: .automatic(includesZero: false, reversed: flip))
                .chartXAxis { AxisMarks(values: .automatic(desiredCount: 4)) { _ in AxisValueLabel() } }
                .chartYAxis { AxisMarks(values: .automatic(desiredCount: 3)) { v in AxisGridLine(); AxisValueLabel { if let d = v.as(Double.self) { Text(say(d)).font(.caption2) } } } }
                .chartOverlay { proxy in
                    GeometryReader { g in
                        Rectangle().fill(.clear).contentShape(Rectangle())
                            .gesture(DragGesture(minimumDistance: 0).onChanged { d in
                                guard let plot = proxy.plotFrame else { return }
                                let x = d.location.x - g[plot].origin.x
                                if let km: Double = proxy.value(atX: x) { at = nearest(km) }
                            }.onEnded { _ in at = nil })
                    }
                }
                .frame(height: 120)
                .animation(still ? nil : .smooth(duration: 0.3), value: chosen)
                .accessibilityLabel(title)
            }
        }
    }

    /**
     * A moment's shade on the charts: quiet, stronger when chosen, fainter while another is. Done
     * well in Good's tonal container (green over the card goes grey), to work on in a wash of the accent.
     */
    private func band(_ mo: RunMoment) -> Color {
        let on = chosen == mo.index
        let back = chosen >= 0 && !on
        if mo.good { return Brand.goodContainer.opacity(on ? 1 : back ? 0.25 : 0.55) }
        return Brand.tint.opacity(on ? 0.16 : back ? 0.04 : 0.07)
    }

    private func nearest(_ km: Double) -> Int {
        guard let last = a.km.last, last > 0 else { return 0 }
        return min(a.km.count - 1, max(0, Int((km / last * Double(a.km.count - 1)).rounded())))
    }
}

/// Heart-rate zones: a bar of the shares and the table.
private struct ZonesCard: View {
    let zones: [HrZone]

    var body: some View {
        let total = max(1, zones.map(\.seconds).reduce(0, +))
        Section2(title: "Heart-rate zones") {
            GeometryReader { g in
                HStack(spacing: 2) {
                    ForEach(Array(zones.enumerated()), id: \.offset) { i, z in
                        if z.seconds > 0 { Rectangle().fill(Brand.zones[min(i, 4)]).frame(width: max(2, (g.size.width - 8) * z.seconds / total)) }
                    }
                }
                .clipShape(Capsule())
            }
            .frame(height: 12)
            ForEach(Array(zones.enumerated()), id: \.offset) { i, z in
                HStack(spacing: 10) {
                    RoundedRectangle(cornerRadius: 3).fill(Brand.zones[min(i, 4)]).frame(width: 12, height: 12)
                    Text("Z\(z.zone) \(z.name)").font(.subheadline)
                    Spacer()
                    Text("\(z.lo)–\(z.hi) bpm").font(.caption).foregroundStyle(.secondary)
                    Text(z.seconds < 60 && z.seconds > 0 ? "<1 min" : duration(z.seconds / 60)).font(.subheadline.monospacedDigit()).frame(width: 64, alignment: .trailing)
                }
            }
        }
    }
}

/// Which shoes the run counts to.
private struct ShoesRow: View {
    let m: WorkoutModel
    let shell: ShellModel

    var body: some View {
        Card {
            HStack {
                Label("Shoes", systemImage: "shoe").font(.headline)
                Spacer()
                Menu {
                    Button { Task { shell.say(await m.pickShoe(nil)) } } label: {
                        if m.shoe == nil { Label("No shoes counted", systemImage: "checkmark") } else { Text("No shoes counted") }
                    }
                    ForEach(m.shoes.filter { !$0.retired || $0.id == m.shoe }) { s in
                        Button { Task { shell.say(await m.pickShoe(s.id)) } } label: {
                            if m.shoe == s.id { Label(s.name, systemImage: "checkmark") } else { Text(s.name) }
                        }
                    }
                } label: {
                    Text(m.shoes.first { $0.id == m.shoe }?.name ?? "No shoes counted").font(.subheadline.weight(.semibold))
                }
                .buttonStyle(.glass)
            }
        }
    }
}

private struct SplitsCard: View {
    let w: Workout

    var body: some View {
        Section2(title: "Splits") {
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 8) {
                GridRow {
                    Text("km"); Text(w.isRun ? "Pace" : "Speed"); Text("HR"); Text("Elev")
                }
                .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                ForEach(Array(w.splits.enumerated()), id: \.offset) { _, s in
                    GridRow {
                        Text("\(s.n)").foregroundStyle(.secondary)
                        Text(s.speed.flatMap { $0 > 0 ? (w.isRun ? "\(clock(Int((1000 / $0).rounded()))) /km" : String(format: "%.1f km/h", $0 * 3.6)) : nil } ?? "–")
                        Text(s.hr.map { "\(Int($0.rounded()))" } ?? "–")
                        Text(s.elev.map { "\($0 > 0 ? "+" : "")\(Int($0.rounded())) m" } ?? "–")
                    }
                    .font(.subheadline.monospacedDigit())
                }
            }
        }
    }
}

/// A workout only told to the coach: a quiet way to take it back, asked once. Recorded ones never show it.
private struct RemoveTold: View {
    let m: WorkoutModel
    @Environment(\.dismiss) private var dismiss
    @State private var asking = false
    @State private var said: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button("Remove", role: .destructive) { asking = true }
                .font(.subheadline.weight(.semibold))
                .disabled(m.busy)
            if let said { Text(said).font(.footnote).foregroundStyle(.secondary) }
        }
        .padding(.horizontal, 4)
        .padding(.top, 4)
        .confirmationDialog("Remove this workout?", isPresented: $asking, titleVisibility: .visible) {
            Button("Remove", role: .destructive) {
                Task {
                    said = await m.removeTold()
                    if said == nil { dismiss() }
                }
            }
        } message: {
            Text("It was told to the coach, with no recording. It goes from your activities and your training load.")
        }
    }
}

/// Where it came from: one line, or each source's numbers side by side.
private struct SourcesCard: View {
    let w: Workout

    var body: some View {
        let copies = w.copies.sorted { (Words.order.firstIndex(of: $0.source) ?? 99) < (Words.order.firstIndex(of: $1.source) ?? 99) }
        Section2(title: copies.count > 1 ? "Sources" : "Source") {
            if copies.count > 1 {
                Text("Matched as one workout. It counts once in your totals.").font(.subheadline)
                Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 6) {
                    GridRow {
                        Text("")
                        ForEach(Array(copies.enumerated()), id: \.offset) { _, c in Text(Words.source[c.source] ?? c.source).font(.caption.weight(.semibold)) }
                    }
                    row("Distance", "distance_m", copies) { c in c.distanceM.flatMap { $0 > 0 ? String(format: "%.2f km", $0 / 1000) : nil } }
                    row("Moving time", "moving_s", copies) { c in c.movingS.flatMap { $0 > 0 ? clock(Int($0)) : nil } }
                    row("Avg heart rate", "avg_hr", copies) { c in c.avgHr.flatMap { $0 > 0 ? "\(Int($0.rounded())) bpm" : nil } }
                    row("Climb", "elevation_m", copies) { c in c.elevationM.flatMap { $0 > 0 ? "\(Int($0.rounded())) m" : nil } }
                }
                Text("Bold: the value Tartan shows. Each number comes from the source that measures it best.").font(.caption).foregroundStyle(.secondary)
            } else {
                let s = copies.first?.source ?? ""
                Text(s == "watch" ? "Read straight from the watch." : "Only on \(Words.sourceLong[s] ?? s) so far.").font(.subheadline)
            }
        }
    }

    @ViewBuilder private func row(_ label: String, _ field: String, _ copies: [Copy], _ fmt: @escaping (Copy) -> String?) -> some View {
        let cells = copies.map(fmt)
        if cells.contains(where: { $0 != nil }) {
            GridRow {
                Text(label).font(.caption).foregroundStyle(.secondary)
                ForEach(Array(copies.enumerated()), id: \.offset) { i, c in
                    Text(cells[i] ?? "–")
                        .font(.caption.monospacedDigit())
                        .fontWeight(w.provenance[field] == c.source ? .bold : .regular)
                        .foregroundStyle(cells[i] == nil ? Color.secondary : Color.primary)
                }
            }
        }
    }
}
