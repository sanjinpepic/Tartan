import SwiftUI
import Charts

/// Progress, native on iPhone (Android's ProgressScreen.kt): how your training is adding up.
/// A range (the Week, 12 weeks, 6 months, a year): the totals, what's changing, your race and
/// its shape, weekly distance, fitness, consistency, the intensity mix, easy-run efficiency, long
/// runs and personal bests; the Week day by day, step back and forth.
struct ProgressScreen: View {
    let shell: ShellModel
    let m: ProgressModel

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text("How your training is adding up").font(.subheadline.weight(.medium)).foregroundStyle(.secondary).padding(.horizontal, 4)
                    Picker("Range", selection: Binding(get: { m.range }, set: { v in withAnimation(.smooth) { m.range = v } })) {
                        ForEach(RANGES, id: \.self) { r in Text(RANGE_LABEL[r] ?? "").tag(r) }
                    }
                    .pickerStyle(.segmented)
                    if m.range == 7 {
                        if let w = m.weeks[m.weekOf ?? ""] { ProgressWeek(w: w, m: m, shell: shell) } else { loading }
                    } else if let d = m.dash[m.range] {
                        RangeView(d: d, shape: m.shape[m.range], dur: m.durability[m.range], shell: shell)
                    } else {
                        loading
                    }
                    Button { shell.go("you") } label: {
                        HStack(spacing: 14) {
                            Image(systemName: "figure.stand").font(.title3).foregroundStyle(Brand.onContainer).frame(width: 44, height: 44)
                                .background(Brand.container, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Your body").font(.headline)
                                Text("Which muscles your training loads, and when they're fresh").font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.leading)
                            }
                            Spacer(minLength: 0)
                            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                        }
                        .padding(18)
                        .background(Brand.card, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
                    }
                    .buttonStyle(Press())
                    .foregroundStyle(Color.primary)
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 16)
            }
            .background(Brand.ground)
            .refreshable { m.forget(); m.ensure() }
            .onScrollGeometryChange(for: CGFloat.self) { g in g.contentOffset.y + g.contentInsets.top } action: { old, new in shell.scrolled(by: new - old, at: new) }
            .safeAreaInset(edge: .bottom, spacing: 0) { BarSpace(on: shell.navOn) }
            .navigationTitle("Progress")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { SyncChip(lanes: shell.board) { shell.openBoard() } }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { shell.go("settings") } label: { Image(systemName: "gearshape") }.accessibilityLabel("Settings")
                }
            }
            .onChange(of: m.range) { m.ensure() }
            .onChange(of: m.weekOf) { m.ensure() }
            .onAppear { m.ensure() }
        }
    }

    private var loading: some View {
        ProgressView().controlSize(.large).frame(maxWidth: .infinity, minHeight: 240)
    }
}

/// A card with a title, a line under it, and what it says.
private struct PCard<Content: View>: View {
    let title: String
    var sub: String?
    var how: String?
    @ViewBuilder var content: Content
    @State private var showHow = false

    var body: some View {
        Card {
            HStack(alignment: .firstTextBaseline) {
                Text(title).font(.title3.weight(.bold)).accessibilityAddTraits(.isHeader)
                Spacer(minLength: 8)
                if how != nil {
                    Button { withAnimation(.smooth) { showHow.toggle() } } label: { Image(systemName: "info.circle") }
                        .accessibilityLabel(showHow ? "Hide how it's worked out" : "How it's worked out")
                }
            }
            if let sub, !sub.isEmpty { Text(sub).font(.subheadline).foregroundStyle(.secondary) }
            if showHow, let how { Text(how).font(.footnote).foregroundStyle(.secondary).transition(.opacity) }
            content
        }
    }
}

private func n1(_ x: Double) -> String { String(format: "%.1f", x) }
private func n0(_ x: Double) -> String { String(format: "%.0f", x) }

private struct Kpis: View {
    let items: [(String, String)]
    var body: some View {
        HStack(spacing: 8) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, kv in
                VStack(alignment: .leading, spacing: 2) {
                    Text(kv.0).font(.caption.weight(.medium)).foregroundStyle(.secondary).lineLimit(1)
                    Text(kv.1).font(.figure(.title3)).lineLimit(1).minimumScaleFactor(0.7)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12).padding(.vertical, 10)
                .background(Brand.well, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .accessibilityElement(children: .combine)
            }
        }
    }
}

private struct RangeView: View {
    let d: Dash
    let shape: [ShapeLine]?
    let dur: Durab?
    let shell: ShellModel

    var body: some View {
        HStack(spacing: 8) {
            ForEach(Array(d.totals.enumerated()), id: \.offset) { i, t in
                VStack(alignment: .leading, spacing: 2) {
                    Text(t.label).font(.caption.weight(.medium)).foregroundStyle(i == 0 ? Brand.onContainer : Color.secondary).lineLimit(1)
                    HStack(alignment: .firstTextBaseline, spacing: 2) {
                        Text(t.km < 100 ? n1(t.km) : n0(t.km)).font(.figure(.title2)).lineLimit(1).minimumScaleFactor(0.6)
                        Text("km").font(.caption.weight(.medium)).foregroundStyle(.secondary)
                    }
                    Text("\(t.workouts) workouts · \(n1(t.hours)) h").font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .background(i == 0 ? Brand.container : Brand.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                .accessibilityElement(children: .combine)
            }
        }
        if !d.changing.isEmpty {
            PCard(title: "What's changing") {
                ForEach(Array(d.changing.prefix(4).enumerated()), id: \.offset) { _, tk in
                    HStack(alignment: .top, spacing: 12) {
                        Image(systemName: tk.tone == "good" ? "checkmark" : tk.tone == "watch" ? "sparkles" : "arrow.up")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(tk.tone == "good" ? Brand.good : tk.tone == "watch" ? Brand.watch : Brand.onContainer)
                            .frame(width: 28, height: 28)
                            .background(tk.tone == "good" ? Brand.goodContainer : tk.tone == "watch" ? Brand.watchContainer : Brand.container, in: Circle())
                        VStack(alignment: .leading, spacing: 2) {
                            Text(tk.title).font(.subheadline.weight(.semibold))
                            Text(tk.detail).font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        if let r = d.race { RaceInfoCard(r: r) }
        if let s = shape, !s.isEmpty { RaceShape(lines: s, raceKm: d.race?.km) }
        if !d.weeks.isEmpty { weekly }
        fitness
        consistency
        intensity
        PCard(title: "Easy-run efficiency", how: "How far you go per heartbeat on easy runs. Up means the same effort carries you further.") {
            if d.efficiency.count >= 2 {
                Text("\(String(format: "%.2f", d.efficiency.last!.value)) m a beat lately").font(.headline)
                LineChartView(points: d.efficiency, colour: Brand.fitness, say: { String(format: "%.2f", $0) })
            } else {
                Text("Needs a few weeks of easy runs with heart rate.").font(.subheadline).foregroundStyle(.secondary)
            }
        }
        if let u = dur, !u.runs.isEmpty {
            PCard(title: "Long runs: does the effort hold?", how: "Heart rate against hill-adjusted pace, the second half against the first. Under 5% is a well-built aerobic base; heat and tired legs push it up.") {
                Text(u.summary).font(.body)
                ForEach(Array(u.runs.prefix(5).enumerated()), id: \.offset) { _, run in
                    HStack {
                        Text(dateShort(run.date)).font(.subheadline).foregroundStyle(.secondary).frame(width: 64, alignment: .leading)
                        Text(run.text).font(.subheadline)
                        Spacer()
                        Text("\(n1(run.drift))%").font(.subheadline.weight(.semibold).monospacedDigit())
                    }
                }
            }
        }
        PCard(title: "Personal bests", how: "From Strava best efforts on synced runs") {
            if d.bests.isEmpty {
                Text("Synced Strava runs with detail add their best efforts here.").font(.subheadline).foregroundStyle(.secondary)
            }
            VStack(spacing: 0) {
                ForEach(Array(d.bests.enumerated()), id: \.offset) { i, b in
                    if i > 0 { Divider() }
                    Button { shell.openActivity(b.activity) } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(b.name).font(.subheadline.weight(.semibold))
                                Text(dateShort(b.date)).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            VStack(alignment: .trailing, spacing: 1) {
                                Text(clock(b.seconds)).font(.figure(.title3))
                                if let p = b.pace { Text("\(p) /km").font(.caption).foregroundStyle(.secondary) }
                            }
                        }
                        .padding(.vertical, 8)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(Press())
                    .foregroundStyle(Color.primary)
                }
            }
        }
    }

    private var weekly: some View {
        let done = d.weeks.dropLast()
        let avg = done.isEmpty ? 0 : done.reduce(0) { $0 + $1.km } / Double(done.count)
        let sub = "Average \(n1(avg)) km a week" + (d.weekHit.map { "; target met in \($0.hit) of the last \($0.of) weeks" } ?? "; this week highlighted")
        return PCard(title: "Weekly distance", sub: sub) {
            Text("This week \(n1(d.weeks.last?.km ?? 0)) km").font(.headline)
            Chart {
                ForEach(Array(d.weeks.enumerated()), id: \.offset) { i, w in
                    BarMark(x: .value("Week", dateShort(w.week)), y: .value("km", w.km))
                        .foregroundStyle(i == d.weeks.count - 1 ? Brand.tint : Brand.tint.opacity(0.45))
                        .cornerRadius(4)
                }
                if let t = d.targetKm {
                    RuleMark(y: .value("Target", t))
                        .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 3]))
                        .foregroundStyle(Color.secondary)
                        .annotation(position: .top, alignment: .leading) { Text("target \(n0(t)) km").font(.caption2).foregroundStyle(.secondary) }
                }
            }
            .chartXAxis { AxisMarks(values: .automatic(desiredCount: 4)) { _ in AxisValueLabel() } }
            .frame(height: 180)
            .accessibilityLabel("Weekly distance")
        }
    }

    private var fitness: some View {
        let s = d.fitness
        var sub = ""
        if s.count >= 2 {
            let ch = s.last!.value - s.first!.value
            sub = abs(ch) < 1 ? "Holding at \(n0(s.last!.value)) since \(dateShort(s.first!.date))" : "\(ch > 0 ? "Up" : "Down") from \(n0(s.first!.value)) to \(n0(s.last!.value)) since \(dateShort(s.first!.date))"
        }
        return PCard(title: "Fitness", sub: sub) {
            if s.count > 1 {
                Text("Fitness \(n0(s.last!.value)) now").font(.headline)
                LineChartView(points: s, colour: Brand.fitness, say: { n0($0) }, area: true)
            } else {
                Text("Needs a few weeks of workouts.").font(.subheadline).foregroundStyle(.secondary)
            }
            Text("Your average daily training effort over 6 weeks, from how long and how hard you train. Steady growth means the training is adding up.").font(.footnote).foregroundStyle(.secondary)
            if d.estimatedShare > 0.3 {
                Text("\(Int((d.estimatedShare * 100).rounded()))% of workouts had no heart rate; their effort is estimated from duration.").font(.footnote).foregroundStyle(.secondary)
            }
        }
    }

    private var consistency: some View {
        let total = (d.days + 6) / 7
        var byWeek: [String: Int] = [:]
        for w in d.weeks { byWeek[String(w.week.prefix(10))] = w.workouts }
        var cal = Calendar(identifier: .gregorian)
        cal.firstWeekday = 2
        let monday = cal.dateInterval(of: .weekOfYear, for: Date())?.start ?? Date()
        let all = (0..<total).reversed().map { k in byWeek[isoDay(cal.date(byAdding: .weekOfYear, value: -k, to: monday) ?? monday)] ?? 0 }
        let done = all.dropLast()
        let active = done.filter { $0 > 0 }.count
        let avg = done.isEmpty ? 0 : Double(done.reduce(0, +)) / Double(done.count)
        var streak = 0
        for k in all.indices.reversed() {
            if all[k] > 0 { streak += 1 } else if k == all.count - 1 { continue } else { break }
        }
        return PCard(title: "Consistency") {
            Kpis(items: [("Per week", n1(avg)), ("Active weeks", "\(active) of \(done.count)"), ("In a row", "\(streak)")])
        }
    }

    private var intensity: some View {
        let total = d.zones.reduce(0) { $0 + $1.seconds }
        let easy = total > 0 ? Int(((d.zones.prefix(2).reduce(0) { $0 + $1.seconds }) / total * 100).rounded()) : 0
        return PCard(title: "Intensity mix", sub: total > 0 ? "\(easy)% easy (zones 1–2) across \(d.zoneWorkouts) workouts. Most plans aim for about 80% easy." : "Needs workouts with heart rate") {
            if total > 0 {
                ZoneBar(zones: d.zones)
                Flow(spacing: 10) {
                    ForEach(Array(d.zones.enumerated()), id: \.offset) { i, z in
                        HStack(spacing: 6) {
                            RoundedRectangle(cornerRadius: 3).fill(Brand.zones[min(i, 4)]).frame(width: 10, height: 10)
                            Text("Z\(z.zone) \(z.name) · \(z.seconds < 60 ? "<1 min" : duration(z.seconds / 60))").font(.caption)
                        }
                    }
                }
            } else {
                Text("No heart-rate time series in this range yet.").font(.subheadline).foregroundStyle(.secondary)
            }
        }
    }
}

private struct ZoneBar: View {
    let zones: [ZoneShare]
    var body: some View {
        let total = max(1, zones.reduce(0) { $0 + $1.seconds })
        GeometryReader { g in
            HStack(spacing: 2) {
                ForEach(Array(zones.enumerated()), id: \.offset) { i, z in
                    if z.seconds > 0 { Rectangle().fill(Brand.zones[min(i, 4)]).frame(width: max(2, (g.size.width - 8) * z.seconds / total)) }
                }
            }
            .clipShape(Capsule())
        }
        .frame(height: 12)
        .accessibilityHidden(true)
    }
}

/// A line over time; touch it to read a point.
private struct LineChartView: View {
    let points: [Point]
    let colour: Color
    let say: (Double) -> String
    var area = false
    var reversed = false
    @State private var at: Int?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let i = at, points.indices.contains(i) {
                Text("\(dateShort(points[i].date)) · \(say(points[i].value))").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            } else {
                Text(" ").font(.caption)
            }
            Chart {
                ForEach(Array(points.enumerated()), id: \.offset) { i, p in
                    LineMark(x: .value("i", i), y: .value("v", p.value)).foregroundStyle(colour).interpolationMethod(.catmullRom)
                    if area {
                        AreaMark(x: .value("i", i), y: .value("v", p.value))
                            .foregroundStyle(LinearGradient(colors: [colour.opacity(0.25), colour.opacity(0)], startPoint: .top, endPoint: .bottom))
                            .interpolationMethod(.catmullRom)
                    }
                }
                if let i = at { RuleMark(x: .value("i", i)).foregroundStyle(Color.secondary.opacity(0.5)) }
            }
            .chartXAxis(.hidden)
            .chartYScale(domain: .automatic(includesZero: false, reversed: reversed))
            .chartYAxis { AxisMarks(values: .automatic(desiredCount: 3)) { v in AxisGridLine(); AxisValueLabel { if let d = v.as(Double.self) { Text(say(d)).font(.caption2) } } } }
            .chartOverlay { proxy in
                GeometryReader { g in
                    Rectangle().fill(.clear).contentShape(Rectangle())
                        .gesture(DragGesture(minimumDistance: 0).onChanged { drag in
                            guard let plot = proxy.plotFrame else { return }
                            if let x: Double = proxy.value(atX: drag.location.x - g[plot].origin.x) { at = min(points.count - 1, max(0, Int(x.rounded()))) }
                        }.onEnded { _ in at = nil })
                }
            }
            .frame(height: 140)
        }
    }
}

private struct RaceInfoCard: View {
    let r: RaceInfo
    var body: some View {
        let gap = r.predicted.flatMap { p in r.target.map { p - $0 } }
        let sub = (["\(kmText(r.km)) km", r.date.map { dateShort($0) + (r.daysToGo.flatMap { $0 >= 0 ? ", \($0) days to go" : nil } ?? "") }].compactMap { $0 }).joined(separator: " · ")
        PCard(title: r.name, sub: sub) {
            Kpis(items: [("Predicted", r.predicted.map(clock) ?? "–"), ("Target", r.target.map(clock) ?? "–"), ("Target pace", r.targetPace.map { "\($0) /km" } ?? "–")])
            Text(note(gap)).font(.footnote).foregroundStyle(.secondary)
        }
    }

    private func note(_ gap: Int?) -> String {
        guard let from = r.fromText else { return "A prediction needs a best effort from this year: a synced Strava run of at least a mile." }
        var s = "Predicted from \(from), scaled to the race distance the way race times usually slow over longer distances."
        if let g = gap { s += g <= 0 ? " That's \(clock(-g)) inside your target." : " \(clock(g)) to find before race day." }
        return s
    }
}

/// What your runs say you could race, week by week: a line that falls is getting faster.
private struct RaceShape: View {
    let lines: [ShapeLine]
    let raceKm: Double?
    @State private var pick: Int?

    var body: some View {
        let start = lines.firstIndex { l in raceKm.map { abs(l.metres - $0 * 1000) < 300 } ?? false } ?? lines.firstIndex { $0.name == "10k" } ?? 0
        let l = lines[min(lines.count - 1, pick ?? start)]
        let pts = l.weeks.compactMap { w in w.s.map { Point(date: w.week, value: $0) } }
        let first = Int(pts.first?.value ?? 0), last = Int(pts.last?.value ?? 0)
        let diff = last - first
        PCard(title: "Race shape", sub: "What your runs say you could race, week by week") {
            Picker("Distance", selection: Binding(get: { pick ?? start }, set: { pick = $0 })) {
                ForEach(Array(lines.enumerated()), id: \.offset) { i, x in Text(x.name).tag(i) }
            }
            .pickerStyle(.segmented)
            Text("\(l.name): \(clock(first)) → \(clock(last)) \(abs(diff) < 5 ? "about the same" : "\(clock(abs(diff))) \(diff < 0 ? "faster" : "slower")")\(pts.first.map { " since \(dateShort($0.date))" } ?? "")")
                .font(.subheadline.weight(.semibold))
            LineChartView(points: pts, colour: Brand.fitness, say: { clock(Int($0)) }, reversed: true)
            Text("This week's is from your \(l.from ?? "best") stretch. Easy weeks read slower: it only knows what you've run fast lately.").font(.footnote).foregroundStyle(.secondary)
        }
    }
}

/// The Week: one week day by day; the arrows step back and forth.
private struct ProgressWeek: View {
    let w: WeekV
    let m: ProgressModel
    let shell: ShellModel

    var body: some View {
        let weeksAgo = dateOf(w.start).map { Int(Date().timeIntervalSince($0) / (7 * 86400)) } ?? 0
        HStack {
            Button { if let p = w.prev { withAnimation(.smooth) { m.weekOf = p } } } label: { Image(systemName: "chevron.left").frame(width: 36, height: 36) }
                .buttonStyle(.glass).buttonBorderShape(.circle).disabled(w.prev == nil).accessibilityLabel("Previous week")
            Spacer()
            VStack(spacing: 1) {
                Text(w.current ? "This week" : weeksAgo <= 1 ? "Last week" : "\(weeksAgo) weeks ago").font(.headline)
                Text("\(dateShort(w.start)) – \(dateShort(w.end))").font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Button { if let n = w.next { withAnimation(.smooth) { m.weekOf = n } } } label: { Image(systemName: "chevron.right").frame(width: 36, height: 36) }
                .buttonStyle(.glass).buttonBorderShape(.circle).disabled(w.next == nil).accessibilityLabel("Next week")
        }
        .padding(6)
        .background(Brand.card, in: Capsule())
        HStack(spacing: 8) {
            Tile(label: "Distance", value: n1(w.km), unit: "km")
            Tile(label: "Time", value: duration(w.minutes))
            if w.usualLoad > 0 { Tile(label: "Effort", value: n0(w.load / w.usualLoad * 100), unit: "% usual") } else { Tile(label: "Effort", value: n0(w.load)) }
        }
        if let p = w.plan {
            Button { shell.go("coach") } label: {
                HStack(spacing: 12) {
                    Image(systemName: "figure.run").foregroundStyle(Brand.onContainer).frame(width: 40, height: 40).background(Brand.container, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    VStack(alignment: .leading, spacing: 1) {
                        ForEach(Array(p.components(separatedBy: "\n").enumerated()), id: \.offset) { i, line in
                            Text(line).font(i == 0 ? Font.subheadline.weight(.semibold) : Font.caption).foregroundStyle(i == 0 ? Color.primary : Color.secondary)
                        }
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                }
                .padding(16)
                .background(Brand.card, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
            }
            .buttonStyle(Press())
            .foregroundStyle(Color.primary)
        }
        let byKm = w.km > 0
        let rest = w.days.filter { $0.workouts == 0 && !$0.future }.count
        PCard(title: "Day by day", sub: [w.workouts == 1 ? "1 workout" : "\(w.workouts) workouts", rest == 1 ? "1 rest day" : "\(rest) rest days"].joined(separator: " · ")) {
            Text(byKm ? "\(n1(w.km)) km this week" : duration(w.minutes)).font(.headline)
            Chart {
                ForEach(w.days) { d in
                    BarMark(x: .value("Day", dayName(d.date)), y: .value(byKm ? "km" : "min", byKm ? d.km : d.minutes))
                        .foregroundStyle(d.date == isoDay(Date()) ? Brand.tint : Brand.tint.opacity(0.5))
                        .cornerRadius(4)
                }
            }
            .frame(height: 150)
        }
        PCard(title: "Workouts") {
            if w.acts.isEmpty {
                Text(w.current ? "Nothing yet this week." : "No workouts this week.").font(.subheadline).foregroundStyle(.secondary)
            }
            ForEach(w.acts) { a in
                Button { shell.openActivity(a.id) } label: {
                    HStack(spacing: 12) {
                        Image(systemName: sportSymbol(a.sport)).foregroundStyle(Brand.onContainer).frame(width: 40, height: 40)
                            .background(Brand.container, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        VStack(alignment: .leading, spacing: 1) {
                            Text(a.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                            Text(a.whenText).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 4)
                        VStack(alignment: .trailing, spacing: 1) {
                            Text(a.big).font(.subheadline.weight(.bold).monospacedDigit())
                            if !a.small.isEmpty { Text(a.small).font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(Press())
                .foregroundStyle(Color.primary)
            }
        }
        let total = w.zones.reduce(0) { $0 + $1.seconds }
        PCard(title: "Intensity and sports", sub: total > 0 ? "\(Int(((w.zones.prefix(2).reduce(0) { $0 + $1.seconds }) / total * 100).rounded()))% easy (zones 1–2)" : "No heart rate this week") {
            if total > 0 { ZoneBar(zones: w.zones) }
            if !w.sports.isEmpty {
                Kpis(items: w.sports.prefix(3).map { s in (sportName(s.sport), s.km > 0 ? "\(n1(s.km)) km" : duration(s.minutes)) })
            }
        }
    }

    private func sportName(_ s: String) -> String {
        ["run": "Running", "ride": "Cycling", "swim": "Swimming", "walk": "Walking", "ski": "Skiing", "paddle": "Paddling"][s] ?? s.capitalized
    }
}
