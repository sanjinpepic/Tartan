import SwiftUI

/// Today, native on iPhone: how you are right now. The same cards as Android's native Today in
/// the same order (2.66, 2.67): a run just in or new bests first, then today's session, race week,
/// how you are with the morning check, your race, This week; the numbers, the last workout, what's
/// worth knowing and the notes folded under More today. Pull down to sync.
struct TodayScreen: View {
    let shell: ShellModel
    let today: TodayModel
    @State private var raceSheet = false

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(Date.now.formatted(.dateTime.weekday(.wide).day().month(.wide)))
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(.secondary)
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
        }
    }

    @ViewBuilder private var content: some View {
        if let t = today.data {
            TodayCards(t: t, shell: shell, today: today, openRaceWeek: { raceSheet = true })
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
                        mark: markFor(s), busy: today.busy)
        }
        if t.sessions.isEmpty && t.planOn {
            RestDayCard(next: t.next, open: { n in shell.openSession(date: n.date, kind: n.kind) }, toPlan: { shell.go("coach") })
        } else if !t.planOn {
            // No plan yet: one is a few taps away, by Tartan's own rules (no key needed).
            NoPlanCard { shell.go("coach") }
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
