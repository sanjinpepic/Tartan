import SwiftUI

/// Body, native on iPhone (Android's BodyScreen.kt; web/views/you.ts): how your body is now. The
/// muscles on the heat scale from fresh to worked hard, running and lifting together; a tap on
/// one says how it is, when it'll be fresh, why, and what trains it (each exercise with the body
/// moving through it). Then sleep and the watch's vitals. Opened from Today and Progress.
struct BodyScreen: View {
    let shell: ShellModel
    let m: BodyModel
    @State private var open: String?
    @State private var every = false
    @State private var how = false
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Muscles, sleep and recovery").font(.subheadline.weight(.medium)).foregroundStyle(.secondary).padding(.horizontal, 4)
                    muscles
                    VitalsCard(m: m)
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 16)
            }
            .background(Brand.ground)
            .refreshable { m.forget(); m.ensure() }
            .onScrollGeometryChange(for: CGFloat.self) { g in g.contentOffset.y + g.contentInsets.top } action: { old, new in shell.scrolled(by: new - old, at: new) }
            .safeAreaInset(edge: .bottom, spacing: 0) { BarSpace(on: shell.navOn) }
            .navigationTitle("Body")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { shell.go("today") } label: { Image(systemName: "chevron.left") }.accessibilityLabel("Back to Today")
                }
            }
            .sheet(item: Binding(get: { open.map { OpenMuscle(id: $0) } }, set: { open = $0?.id })) { o in
                if let s = m.muscles?[o.id] { MuscleSheet(mu: o.id, s: s, m: m) }
            }
            .onAppear { m.ensure() }
        }
    }

    @ViewBuilder private var muscles: some View {
        Card {
            Text("Muscles").font(.title3.weight(.bold))
            if let b = m.muscles {
                let shades = Heat.shades(scheme == .dark)
                Text(bodySummary(b)).font(.body)
                MuscleMapView(levels: b.mapValues(\.level), figure: m.figure, selected: open) { open = $0 }
                    .padding(.horizontal, 8)
                HeatLegend(low: "Fresh", high: "Worked hard").frame(maxWidth: .infinity)
                let need = needing(b)
                if !need.isEmpty {
                    Flow(spacing: 6) {
                        ForEach(need.prefix(8), id: \.self) { mu in
                            let s = b[mu]!
                            Button { open = mu } label: {
                                HStack(spacing: 8) {
                                    RoundedRectangle(cornerRadius: 3).fill(shades[min(4, max(0, s.level))]).frame(width: 10, height: 10)
                                    VStack(alignment: .leading, spacing: 0) {
                                        Text(muscleName(mu)).font(.subheadline.weight(.semibold))
                                        Text(s.freshInH.map { "fresh in \(inHours($0).replacingOccurrences(of: "about ", with: "~"))" } ?? (s.sore != nil ? "sore" : "a little worked"))
                                            .font(.caption2).foregroundStyle(.secondary)
                                    }
                                    if s.sore != nil { Image(systemName: "exclamationmark.triangle.fill").font(.caption2).foregroundStyle(Brand.watch) }
                                }
                                .padding(.horizontal, 12).padding(.vertical, 8)
                                .background(Brand.well, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                            }
                            .buttonStyle(Press())
                            .foregroundStyle(Color.primary)
                        }
                    }
                }
                Text("Tap a muscle to see how it is and why.").font(.footnote).foregroundStyle(.secondary)
                let others = MUSCLES.filter { !need.contains($0) }
                if !others.isEmpty {
                    Button(every ? "Fewer" : "Every muscle") { withAnimation(.smooth) { every.toggle() } }.font(.subheadline.weight(.semibold))
                    if every {
                        Flow(spacing: 6) {
                            ForEach(others, id: \.self) { mu in
                                Button(muscleName(mu)) { open = mu }.buttonStyle(.glass).font(.subheadline)
                            }
                        }
                    }
                }
                Button(how ? "Hide how this is worked out" : "How is this worked out?") { withAnimation(.smooth) { how.toggle() } }.font(.subheadline.weight(.semibold))
                if how {
                    Text("From your workouts of the last five weeks, runs and strength together. A run loads the legs by how long and how hard it was (calves most, then quads, hamstrings, glutes and hip flexors; climbing adds calves and glutes); a strength session loads what its exercises work. Each muscle recovers over a day or a few, faster when it's used to the work.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, minHeight: 200)
            }
        }
    }
}

private struct OpenMuscle: Identifiable { let id: String }

/// The heat scale's key: words at each end of its five steps.
struct HeatLegend: View {
    let low: String
    let high: String
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: 4) {
            Text(low).font(.caption2).foregroundStyle(.secondary)
            ForEach(Array(Heat.shades(scheme == .dark).enumerated()), id: \.offset) { _, c in RoundedRectangle(cornerRadius: 3).fill(c).frame(width: 14, height: 10) }
            Text(high).font(.caption2).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("From \(low.lowercased()) to \(high.lowercased())")
    }
}

/// Front and back, each muscle shaded by its level (0–4); a tap on one opens it.
struct MuscleMapView: View {
    let levels: [String: Int]
    let figure: String
    var selected: String?
    var onMuscle: ((String) -> Void)?
    @Environment(\.colorScheme) private var scheme
    @State private var width: CGFloat = 0

    var body: some View {
        if let f = MuscleMap.figure(figure) {
            let ratio = (f.front.w + f.back.w) / max(f.front.h, f.back.h)
            let shades = Heat.shades(scheme == .dark)
            let quiet = Color(uiColor: .quaternarySystemFill)
            let drawn = shaded()
            let sel = selected.map { MuscleMap.shares[$0] ?? $0 }
            Canvas { ctx, size in
                let k = size.width / (f.front.w + f.back.w)
                for (v, x0) in [(f.front, CGFloat(0)), (f.back, f.front.w * k)] {
                    var c = ctx
                    c.translateBy(x: x0, y: 0)
                    c.scaleBy(x: k, y: k)
                    c.translateBy(x: -v.x, y: -v.y)
                    for p in v.parts {
                        let colour = p.body ? quiet : p.other ? shades[0] : shades[min(4, max(0, drawn[p.name] ?? 0))]
                        c.fill(p.path, with: .color(colour))
                        if p.name == sel { c.stroke(p.path, with: .color(.primary), lineWidth: 6) }
                    }
                }
            }
            .aspectRatio(ratio, contentMode: .fit)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
            .contentShape(Rectangle())
            .gesture(SpatialTapGesture().onEnded { e in tap(e.location, f) }, including: onMuscle == nil ? .none : .all)
            .accessibilityLabel("Your muscles, front and back")
            .sensoryFeedback(.selection, trigger: selected)
        } else {
            Color.clear.frame(height: 1)
        }
    }

    private func shaded() -> [String: Int] {
        var out: [String: Int] = [:]
        for (m, v) in levels { let at = MuscleMap.shares[m] ?? m; out[at] = max(out[at] ?? 0, v) }
        return out
    }

    /// The muscle under a tap, on whichever side it landed.
    private func tap(_ at: CGPoint, _ f: MuscleMap.Figure) {
        guard let onMuscle, width > 0 else { return }
        let k = width / (f.front.w + f.back.w)
        let (v, x0): (MuscleMap.View2, CGFloat) = at.x < f.front.w * k ? (f.front, 0) : (f.back, f.front.w * k)
        let p = CGPoint(x: (at.x - x0) / k + v.x, y: at.y / k + v.y)
        if let part = v.parts.first(where: { !$0.body && !$0.other && $0.path.contains(p) }) { onMuscle(part.name) }
    }
}

/// The 3D body moving through its loop; drag sideways to turn it (a tick every eighth of a turn).
struct BodyPictures: View {
    let frames: Frames?
    let label: String
    var waiting = true
    @State private var at = 0
    @State private var turning = false
    @State private var turnAt: Double = 0
    @State private var lastTick = 0
    @Environment(\.accessibilityReduceMotion) private var still

    var body: some View {
        ZStack {
            if let f = frames {
                let img: UIImage? = turning && !f.turn.isEmpty ? f.turn[((Int(turnAt.rounded()) % f.turn.count) + f.turn.count) % f.turn.count] : (f.loop.indices.contains(at) ? f.loop[at] : f.turn.first)
                if let img { Image(uiImage: img).resizable().scaledToFit() }
            } else if waiting {
                ProgressView()
            }
        }
        .contentShape(Rectangle())
        .gesture(DragGesture(minimumDistance: 4)
            .onChanged { g in
                guard let f = frames, f.turn.count > 1 else { return }
                turning = true
                turnAt = -g.translation.width / 300 * Double(f.turn.count)
                let k = Int(floor(turnAt / Double(max(1, f.turn.count / 8))))
                if k != lastTick { lastTick = k; UISelectionFeedbackGenerator().selectionChanged() }
            }
            .onEnded { _ in turning = false })
        .task(id: frames?.loop.count ?? 0) {
            guard let f = frames, !still, f.loop.count > 1, f.cycle > 0 else { return }
            let step = max(0.03, f.cycle / Double(f.loop.count))
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(step))
                if !turning { at = (at + 1) % f.loop.count }
            }
        }
        .accessibilityLabel(label)
    }
}

/// One exercise: the body moving through it (drag to turn), the dose, three cues, why.
struct ExerciseDetail: View {
    let e: Routine.Exercise
    let engine: EngineBridge
    var primary: [String] = []
    var secondary: [String] = []
    @Environment(\.dismiss) private var dismiss
    @State private var frames: Frames?
    @State private var none = false

    var body: some View {
        NavigationStack {
            List {
                if !none {
                    Section {
                        VStack(spacing: 4) {
                            BodyPictures(frames: frames, label: "How to do \(e.name)").frame(height: 280)
                            if frames != nil { Text("Drag to turn").font(.caption).foregroundStyle(.secondary) }
                        }
                        .frame(maxWidth: .infinity)
                    }
                }
                Section {
                    Text(e.dose).font(.title3.weight(.semibold))
                    if let eq = e.equipment { LabeledContent("Equipment", value: eq) }
                }
                if !e.cues.isEmpty {
                    Section("How") {
                        ForEach(Array(e.cues.enumerated()), id: \.offset) { i, c in
                            Label { Text(c) } icon: { Text("\(i + 1)").font(.headline).foregroundStyle(Brand.tint) }
                        }
                    }
                }
                if !e.why.isEmpty { Section("Why") { Text(e.why) } }
            }
            .navigationTitle(e.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button { dismiss() } label: { Image(systemName: "xmark") }.accessibilityLabel("Close") }
            }
            .task {
                frames = await BodyFrames.get(engine, ["exercise": e.id, "primary": primary, "secondary": secondary, "width": 300, "height": 260, "loop": 20, "turn": 24])
                none = frames == nil
            }
        }
        .presentationDetents([.large])
    }
}

/// One muscle (you.ts openMuscle): how it is, when it'll be fresh, why, and what trains it.
private struct MuscleSheet: View {
    let mu: String
    let s: MuscleNow
    let m: BodyModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @State private var exercise: Routine.Exercise?

    var body: some View {
        let shades = Heat.shades(scheme == .dark)
        let verdict = s.state == "fresh" ? (s.lastWorked != nil ? "Fresh and ready to work." : "Fresh: nothing has loaded it lately.")
            : s.state == "fatigued" ? "Carrying more than it's used to. Fresh again in \(inHours(s.freshInH ?? 0))." : "Getting there. Fresh again in \(inHours(s.freshInH ?? 0))."
        let exs = Array((m.exercises.filter { m.works[$0.id]?.0.contains(mu) == true } + m.exercises.filter { m.works[$0.id]?.1.contains(mu) == true && m.works[$0.id]?.0.contains(mu) != true }).prefix(6))
        NavigationStack {
            List {
                Section {
                    HStack(alignment: .center) {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(spacing: 6) {
                                RoundedRectangle(cornerRadius: 3).fill(shades[min(4, max(0, s.level))]).frame(width: 10, height: 10)
                                Text(s.state == "fresh" ? "Fresh" : s.state == "fatigued" ? "Worked hard" : "Recovering").font(.subheadline).foregroundStyle(.secondary)
                            }
                            Text(verdict).font(.headline)
                        }
                        Spacer(minLength: 8)
                        MuscleMapView(levels: [mu: max(2, s.level)], figure: m.figure, selected: mu).frame(width: 130)
                    }
                    if let sore = s.sore {
                        Label {
                            Text("You said your \(sore.area == "other" ? "body" : areaName(sore.area).lowercased()) hurt \(["", "a little", "clearly", "a lot"][safe: sore.level] ?? "") \(onDay(sore.date)). " + (sore.level >= 2 ? "Let it settle before loading it hard; tell your coach if it lingers." : "Easy work is fine if it eases as you warm up."))
                        } icon: { Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Brand.watch) }
                            .font(.subheadline)
                    }
                }
                if !s.causes.isEmpty {
                    Section {
                        ForEach(Array(s.causes.enumerated()), id: \.offset) { _, c in
                            HStack(spacing: 12) {
                                Image(systemName: c.kind == "run" ? "figure.run" : c.kind == "strength" ? "dumbbell.fill" : "figure.mixed.cardio")
                                    .foregroundStyle(Brand.onContainer).frame(width: 32, height: 32).background(Brand.container, in: Circle())
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(c.what).font(.subheadline.weight(.semibold))
                                    Text(onDay(c.date).replacingOccurrences(of: "on ", with: "").capitalized).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                ProgressView(value: min(1, max(0, c.share))).frame(width: 60).tint(Brand.tint)
                                Text("\(Int((c.share * 100).rounded()))%").font(.subheadline.monospacedDigit()).frame(width: 44, alignment: .trailing)
                            }
                        }
                    } header: { Text("Why") } footer: {
                        Text(s.causes.reduce(0) { $0 + $1.share } < 0.95 ? "What's still in it, by share (the rest is older work)." : "What's still in it, by share.")
                    }
                }
                if let lw = s.lastWorked { Section { Text("Last worked \(onDay(lw)).").foregroundStyle(.secondary) } }
                if !exs.isEmpty {
                    Section(s.state == "fresh" ? "Exercises for it" : "Exercises for it, when it's fresh") {
                        ForEach(exs) { e in
                            Button { exercise = e } label: {
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(e.name).font(.subheadline.weight(.semibold))
                                    Text(m.works[e.id]?.0.contains(mu) == true ? "Works it" : "Helps it").font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            .foregroundStyle(Color.primary)
                        }
                    }
                }
            }
            .navigationTitle(muscleName(mu))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button { dismiss() } label: { Image(systemName: "xmark") }.accessibilityLabel("Close") }
            }
            .sheet(item: $exercise) { e in ExerciseDetail(e: e, engine: m.engine, primary: m.works[e.id]?.0 ?? [], secondary: m.works[e.id]?.1 ?? []) }
        }
        .presentationDetents([.medium, .large])
    }
}

/// Sleep and vitals: four tiles, today's heart rate, where they come from.
private struct VitalsCard: View {
    let m: BodyModel
    @State private var where_ = false

    var body: some View {
        Card {
            Text("Sleep and vitals").font(.title3.weight(.bold))
            if let h = m.health {
                Text(h.latestAt.map { a in "From your watch · \(String(a.prefix(10)) == isoDay(Date()) ? String(a.dropFirst(11).prefix(5)) : whenDay(a))" } ?? "From your watch")
                    .font(.subheadline).foregroundStyle(.secondary)
                let diff = h.restHr.flatMap { r in h.baseline.map { r - $0 } }
                let today = isoDay(Date())
                let restNote: String = {
                    guard h.restHr != nil else { return "Wear the watch to bed" }
                    guard let d = diff else { return h.restDate == today ? "Lowest still half hour today" : "Lowest still half hour \(whenDay(h.restDate ?? ""))" }
                    if abs(d) < 3 { return "Your usual (\(h.baseline ?? 0))" }
                    let sd = "\(d > 0 ? "+" : "−")\(abs(d))"
                    return h.restDate == today ? "\(sd) on your usual \(h.baseline ?? 0)" : "\(sd) on your usual \(h.baseline ?? 0), \(whenDay(h.restDate ?? ""))"
                }()
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 6), GridItem(.flexible(), spacing: 6)], spacing: 6) {
                    tile("heart", "Resting heart rate", h.restHr.map { "\($0)" } ?? "–", h.restHr != nil ? " bpm" : "", restNote, (diff ?? 0) >= 7 ? Brand.watch : (diff ?? 0) <= -3 && diff != nil ? Brand.good : nil)
                    tile("moon", "Last night", h.sleep ?? "–", "", h.sleepNote ?? "Wear the watch to bed", nil)
                    tile("drop", "Blood oxygen", h.oxygen.map { "\(Int($0.rounded()))" } ?? "–", h.oxygen != nil ? "%" : "",
                         h.oxygenAt.map { a in String(a.prefix(10)) == today ? "At \(a.dropFirst(11).prefix(5))" : "\(whenDay(a).capitalized) at \(a.dropFirst(11).prefix(5))" } ?? "No reading yet",
                         (h.oxygen ?? 100) < 92 ? Brand.watch : nil)
                    tile("figure.walk", "Steps today", h.steps.formatted(), "", h.activeKcal.flatMap { $0 > 0 ? "\(Int($0.rounded())) kcal active" : nil } ?? "So far", nil)
                }
                let got = h.todayHr.compactMap { $0 }
                if got.count >= 2 {
                    HStack {
                        Text("Heart rate today").font(.subheadline.weight(.semibold))
                        Spacer()
                        Text("\(Int(got.min()!))–\(Int(got.max()!)) bpm").font(.subheadline).foregroundStyle(.secondary)
                    }
                    Sparkline(hr: h.todayHr).frame(height: 56)
                        .accessibilityLabel("Heart rate today, \(Int(got.min()!)) to \(Int(got.max()!)) bpm")
                    HStack { Text("00"); Spacer(); Text("12"); Spacer(); Text("24") }.font(.caption2).foregroundStyle(.secondary)
                }
                Button(where_ ? "Hide where these come from" : "Where do these come from?") { withAnimation(.smooth) { where_.toggle() } }.font(.subheadline.weight(.semibold))
                if where_ {
                    Text("Tartan reads the watch's 10-minute log each time it connects. The watch keeps about a day of it, so open Tartan daily for a full history. Resting heart rate is your lowest half hour sitting or lying still.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            } else if m.healthMissing {
                Text("Nothing from the watch yet.").foregroundStyle(.secondary)
            } else {
                ProgressView().frame(maxWidth: .infinity, minHeight: 120)
            }
        }
    }

    private func tile(_ icon: String, _ label: String, _ value: String, _ unit: String, _ note: String, _ tone: Color?) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Label(label, systemImage: icon).font(.caption.weight(.medium)).foregroundStyle(tone ?? Color.secondary)
            HStack(alignment: .firstTextBaseline, spacing: 1) {
                Text(value).font(.figure(.title2)).foregroundStyle(tone ?? Color.primary)
                if !unit.isEmpty { Text(unit).font(.caption.weight(.medium)).foregroundStyle(.secondary) }
            }
            Text(note).font(.caption2).foregroundStyle(.secondary).lineLimit(3)
        }
        .frame(maxWidth: .infinity, minHeight: 104, alignment: .topLeading)
        .padding(12)
        .background(Brand.well, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

/// Today's heart rate every 10 minutes as a line, with gaps where the watch wasn't worn; noon marked.
private struct Sparkline: View {
    let hr: [Double?]
    var body: some View {
        Canvas { ctx, size in
            let got = hr.compactMap { $0 }
            guard let lo = got.min(), let hi = got.max() else { return }
            func x(_ i: Int) -> CGFloat { CGFloat(i) / 143 * size.width }
            func y(_ v: Double) -> CGFloat { size.height - 4 - CGFloat((v - lo) / max(1, hi - lo)) * (size.height - 8) }
            var noon = Path()
            noon.move(to: CGPoint(x: size.width / 2, y: 0)); noon.addLine(to: CGPoint(x: size.width / 2, y: size.height))
            ctx.stroke(noon, with: .color(.secondary.opacity(0.4)), lineWidth: 1)
            var p = Path()
            for (i, v) in hr.enumerated() {
                guard let v else { continue }
                if i > 0, hr[i - 1] != nil { p.addLine(to: CGPoint(x: x(i), y: y(v))) } else { p.move(to: CGPoint(x: x(i), y: y(v))) }
            }
            ctx.stroke(p, with: .color(.red), style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
        }
    }
}
