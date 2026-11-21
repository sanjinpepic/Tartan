import SwiftUI

/// Today, native on iPhone: how you are right now. The same cards as Android's native Today in
/// the same order (2.66, 2.67): a run just in or new bests first, then today's session, race week,
/// how you are with the morning check, your race, This week; the numbers, the last workout, what's
/// worth knowing and the notes folded under More today. Pull down to sync.
struct TodayScreen: View {
    let shell: ShellModel
    let today: TodayModel
    @State private var raceSheet = false
    /** Different plan today? (from today's session). */
    @State private var choicesSheet = false

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack(alignment: .center) {
                            Text(Date.now.formatted(.dateTime.weekday(.wide).day().month(.wide)))
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(.secondary)
                            Spacer(minLength: 8)
                            // Tartan's T, taking on the day; it opens the coach.
                            if let mark = today.data?.mark {
                                TodayMarkView(mark: mark) { shell.goAction("chat") }
                            }
                        }
                        .padding(.horizontal, 4)
                        .id("top")
                        content
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 16)
                }
                .background(Brand.ground)
                .refreshable { await today.refresh() }
                .onScrollGeometryChange(for: CGFloat.self) { g in
                    g.contentOffset.y + g.contentInsets.top
                } action: { old, new in
                    shell.scrolled(by: new - old, at: new)
                }
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    BarSpace(on: shell.navOn)
                }
                .onChange(of: shell.toTop) {
                    withAnimation(.smooth) { proxy.scrollTo("top", anchor: .top) }
                }
                .task {
                    // Screenshots (Launch): a sheet open, once Today has its data.
                    guard let open = Launch.open else { return }
                    for _ in 0..<120 where today.data == nil { try? await Task.sleep(for: .milliseconds(500)) }
                    try? await Task.sleep(for: .seconds(2))
                    guard let t = today.data else { return }
                    if open == "workout", let l = t.last { shell.openActivity(l.id) }
                    if open == "session", let s = t.sessions.first ?? t.next { shell.openSession(date: s.date, kind: s.kind) }
                }
                .task {
                    // Screenshots (Launch): More today open, scrolled to, once Today has its data.
                    guard Launch.more else { return }
                    for _ in 0..<120 where today.data == nil { try? await Task.sleep(for: .milliseconds(500)) }
                    today.moreOpen = true
                    try? await Task.sleep(for: .milliseconds(800))
                    proxy.scrollTo("more", anchor: .top)
                    try? await Task.sleep(for: .milliseconds(800))
                    Launch.ready("more")
                }
            }
            .navigationTitle("Today")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    SyncChip(lanes: shell.board) { shell.openBoard() }
                }
                if !shell.navOn {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { shell.go("record") } label: { Image(systemName: "record.circle") }.accessibilityLabel("Record")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { shell.go("settings") } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("Settings")
                }
            }
            .sheet(isPresented: $raceSheet) {
                if let race = today.data?.race, let week = today.raceWeek {
                    RaceWeekSheet(race: race, week: week, today: today)
                }
            }
            .sheet(isPresented: $choicesSheet) {
                if let c = today.check?.choices { DayChoicesSheet(c: c, today: today) }
            }
            .task {
                // Screenshots (Launch): Different plan today? open, once the choices are in.
                guard Launch.open == "choices" else { return }
                for _ in 0..<120 where today.check?.choices == nil { try? await Task.sleep(for: .milliseconds(500)) }
                try? await Task.sleep(for: .seconds(1.5))
                choicesSheet = today.check?.choices != nil
            }
        }
    }

    @ViewBuilder private var content: some View {
        if let t = today.data {
            TodayCards(t: t, shell: shell, today: today, openRaceWeek: { raceSheet = true }, openChoices: { choicesSheet = true })
        } else if today.failed {
            ContentUnavailableView {
                Label("Today couldn't be read", systemImage: "exclamationmark.triangle")
            } description: {
                Text("The app may still be starting. Pull down, or try again.")
            } actions: {
                Button("Try again") { Task { await today.fetch() } }
                    .buttonStyle(.glass)
            }
            .padding(.top, 40)
        } else {
            ProgressView()
                .controlSize(.large)
                .frame(maxWidth: .infinity, minHeight: 260)
                .accessibilityLabel("Loading Today")
        }
    }
}

/// Today's cards, in order.
struct TodayCards: View {
    let t: Today
    let shell: ShellModel
    let today: TodayModel
    let openRaceWeek: () -> Void
    var openChoices: () -> Void = {}

    var body: some View {
        let justIn = t.last?.justIn == true
        let fresh = t.takeaways.filter { k in
            guard k.best, !today.cheered.contains(k.id), let d = k.date else { return false }
            return (0...3).contains(daysSince(d))
        }
        let freshIds = Set(fresh.map(\.id))
        let worth = t.takeaways.filter { !freshIds.contains($0.id) }

        if t.sample { SampleBanner { Task { _ = await shell.engine.rpc("demo", ["op": "leave"]) } } }
        // One thing leads, by the moment: just back from a run, how it went.
        if justIn, let last = t.last { LastCard(last: last, shell: shell) }
        // New bests: a few days at the top, as a celebration, then back with what's worth knowing.
        if !fresh.isEmpty {
            Celebration(bests: fresh, open: { shell.openActivity($0) }, dismiss: { withAnimation(.smooth) { today.cheer(fresh.map(\.id)) } })
        }
        ForEach(t.sessions) { s in
            SessionCard(s: s, open: { shell.openSession(date: s.date, kind: s.kind) }, openWorkout: { shell.openActivity($0) },
                        mark: markFor(s), busy: today.busy, today: today, openChoices: openChoices)
        }
        if t.sessions.isEmpty && t.planOn {
            RestDayCard(next: t.next, open: { n in shell.openSession(date: n.date, kind: n.kind) }, toPlan: { shell.go("coach") })
        } else if !t.planOn {
            // No plan yet: one is a few taps away, by Tartan's own rules (no key needed).
            NoPlanCard(ended: t.planEnded) { shell.go("coach") }
        }
        if let race = t.race, let week = today.raceWeek {
            RaceWeekCard(race: race, week: week, open: openRaceWeek)
        }
        ReadinessCard(r: t.readiness, today: today)
        // Race week (7 days and less) has its own card; from twelve weeks out to then, the countdown.
        if let race = t.race, today.raceWeek == nil {
            if let c = race.countdown, c.daysToGo > 7 {
                RaceCountdownCard(race: race, c: c) { shell.go("trends") }
            } else if (race.daysToGo ?? -1) >= 0 {
                RaceCard(race: race) { shell.go("trends") }
            }
        }
        WeekCard(w: t.week) { shell.go("trends") }
        MoreToday(open: today.moreOpen, inside: inside(justIn: justIn, worth: worth.count)) {
            withAnimation(.smooth(duration: 0.35)) { today.moreOpen.toggle() }
        }
        .id("more")
        if today.moreOpen {
            VStack(alignment: .leading, spacing: 12) {
                NumbersCard(r: t.readiness, vitals: today.vitals, openBody: { shell.go("you") })
                if !justIn { if let last = t.last { LastCard(last: last, shell: shell) } else { NoWorkoutsCard { shell.go("settings/sources") } } }
                if !worth.isEmpty { Takeaways(list: worth) { shell.openActivity($0) } }
                if let n = today.shoes {
                    NoteCard(icon: "shoe", title: n.title, text: n.text, go: n.go, quiet: n.quiet,
                             onGo: { today.dismissShoes(); shell.go("settings/training") }, onQuiet: { today.dismissShoes() })
                }
                if today.pairHint {
                    NoteCard(icon: "laptopcomputer", title: "Tartan on your PC too?",
                             text: "Pair them: the same plan, coach, notes and lifts on both, end to end encrypted. On the PC: Settings → More → Phone app → Pair a phone, then scan its code here.",
                             go: "Scan my PC's code", quiet: "Type it instead",
                             onGo: { today.scanPair() }, onQuiet: { shell.go("settings/more") }, close: { today.dismissPair() })
                }
            }
            .transition(.opacity.combined(with: .move(edge: .top)))
        }
    }

    /** Mark done by hand, for a run the watch didn't bring in (not strength: that's logged in Lift). */
    private func markFor(_ s: Session) -> (() -> Void)? {
        guard s.activityId == nil, !s.manual, s.kind != "strength", s.status != "done" else { return nil }
        let today = self.today
        return { today.mark(date: s.date, kind: s.kind) }
    }

    /** What's under More today, in a line. */
    private func inside(justIn: Bool, worth: Int) -> String {
        var bits = ["fitness, form and vitals"]
        if !justIn && t.last != nil { bits.append("your last workout") }
        if worth > 0 { bits.append(worth == 1 ? "1 thing worth knowing" : "\(worth) things worth knowing") }
        let notes = (today.shoes != nil ? 1 : 0) + (today.pairHint ? 1 : 0)
        if notes > 0 { bits.append(notes == 1 ? "1 note" : "\(notes) notes") }
        let s = bits.joined(separator: ", ")
        return s.prefix(1).uppercased() + s.dropFirst()
    }
}

/// The floating Record button: a run on the phone.
struct RecordButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label("Record", systemImage: "record.circle")
                .font(.headline)
                .padding(.horizontal, 4)
                .padding(.vertical, 6)
        }
        .buttonStyle(.glassProminent)
        .buttonBorderShape(.capsule)
        .tint(Brand.tint)
        .accessibilityHint("Record a run with the phone")
    }
}

/// The sync board as a chip: a dot, an icon and the time since each source last came in; amber
/// with a warning sign when a round failed, the dot pulsing while it syncs. A tap opens the board.
struct SyncChip: View {
    let lanes: [Lane]
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: 10) {
                if lanes.isEmpty {
                    Label("Connect", systemImage: "plus")
                        .font(.subheadline.weight(.semibold))
                } else {
                    ForEach(lanes) { lane in
                        HStack(spacing: 4) {
                            Image(systemName: "circle.fill")
                                .font(.system(size: 7))
                                .foregroundStyle(dot(lane))
                                .symbolEffect(.pulse, isActive: lane.state == "busy")
                            Image(systemName: icon(lane))
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(lane.failed ? Brand.watch : Color.primary)
                            Text(lane.text)
                                .font(.subheadline.weight(.semibold).monospacedDigit())
                                .foregroundStyle(lane.failed ? Brand.watch : Color.primary)
                        }
                    }
                }
            }
            .padding(.horizontal, 4)
        }
        .accessibilityLabel(lanes.isEmpty ? "Nothing connected yet. Connect Strava or your watch." : lanes.map { "\($0.name): \($0.status)" }.joined(separator: ". "))
        .accessibilityHint("Open sync details")
    }

    private func dot(_ l: Lane) -> Color {
        if l.failed { return Brand.watch }
        return l.id == "strava" ? Brand.good : Color.primary
    }

    private func icon(_ l: Lane) -> String {
        if l.failed { return "exclamationmark.triangle.fill" }
        return l.id == "watch" ? "watch.analog" : "figure.run"
    }
}

/**
 * Tartan's T on Today, taking on the day (src/today-mark.ts; Android's TodayMark.kt): a rest day
 * breathes, slow and calm; a session planned holds steady; a new best gets one shimmer and spark
 * as Today opens; a go-easy morning dims it; race week draws a fine outline round it once. The
 * coach's Blush tile (DESIGN.md). Reduced motion: still, every state. Tapping it opens the coach.
 */
struct TodayMarkView: View {
    let mark: DayMark
    var size: CGFloat = 40
    let open: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduced
    @State private var breathe = false
    @State private var shine: CGFloat = 0
    @State private var spark: CGFloat = 0
    @State private var ring: CGFloat = 1

    private var tired: Bool { mark.state == "tired" }
    private var inner: CGFloat { size - 6 }

    var body: some View {
        Button(action: open) { face }
            .buttonStyle(.plain)
            .accessibilityLabel(mark.label)
            .accessibilityHint("Opens your coach")
            .task(id: mark.state) { await play() }
    }

    private var face: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Brand.container.opacity(tired ? 0.55 : 1))
                .frame(width: inner, height: inner)
            if mark.state == "race" {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .trim(from: 0, to: ring)
                    .stroke(Brand.tint, style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
                    .frame(width: size - 1.5, height: size - 1.5)
            }
            letter
            if mark.state == "best" {
                Spark()
                    .fill(Brand.tint)
                    .frame(width: size * 0.24, height: size * 0.24)
                    .scaleEffect(spark)
                    .opacity(Double(spark))
                    .offset(x: size * 0.34, y: -size * 0.34)
            }
        }
        .frame(width: size, height: size)
        .contentShape(Rectangle())
    }

    /** The T, 60% of the tile, and on a best day the band of light that crosses it. */
    private var letter: some View {
        let w = inner * 0.6
        let h = w * 595 / 698
        return MarkShape()
            .fill(Brand.onContainer.opacity((tired ? 0.5 : 1) * (breathe ? 0.82 : 1)))
            .overlay {
                if mark.state == "best" {
                    LinearGradient(colors: [.clear, .white.opacity(0.9), .clear], startPoint: .leading, endPoint: .trailing)
                        .frame(width: w * 0.45)
                        .rotationEffect(.degrees(20))
                        .offset(x: (shine * 2 - 1) * w)
                        .mask(MarkShape().frame(width: w, height: h))
                }
            }
            .frame(width: w, height: h)
            .scaleEffect(breathe ? 0.95 : 1)
    }

    private func play() async {
        breathe = false
        shine = 0
        spark = 0
        ring = mark.state == "race" && !reduced ? 0 : 1
        guard !reduced else { return }
        switch mark.state {
        case "rest":
            withAnimation(.easeInOut(duration: 4.5).repeatForever(autoreverses: true)) { breathe = true }
        case "best":
            try? await Task.sleep(for: .milliseconds(400))
            withAnimation(.easeInOut(duration: 1.4)) { shine = 1 }
            try? await Task.sleep(for: .milliseconds(450))
            withAnimation(.easeOut(duration: 0.45)) { spark = 1 }
            try? await Task.sleep(for: .milliseconds(550))
            withAnimation(.easeIn(duration: 0.5)) { spark = 0 }
        case "race":
            try? await Task.sleep(for: .milliseconds(300))
            withAnimation(.easeOut(duration: 1.0)) { ring = 1 }
        default:
            break
        }
    }
}

/** A small four-point star: the spark on a best day. */
private struct Spark: Shape {
    func path(in r: CGRect) -> Path {
        var p = Path()
        let c = CGPoint(x: r.midX, y: r.midY)
        p.move(to: CGPoint(x: c.x, y: r.minY))
        p.addQuadCurve(to: CGPoint(x: r.maxX, y: c.y), control: c)
        p.addQuadCurve(to: CGPoint(x: c.x, y: r.maxY), control: c)
        p.addQuadCurve(to: CGPoint(x: r.minX, y: c.y), control: c)
        p.addQuadCurve(to: CGPoint(x: c.x, y: r.minY), control: c)
        p.closeSubpath()
        return p
    }
}
