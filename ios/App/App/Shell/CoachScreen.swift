import SwiftUI

/// Coach, native on iPhone (Android's CoachScreen.kt): the plan first. This week or the whole
/// plan with Change plan beside it (ill, away, busy) and one line on the watch; the week's
/// sessions; the coach's suggestion (or what it last changed) and the week's review under the
/// week they change; the plan at a glance, the paces and zones, the pointers; the ask bar above
/// the tab bar. A session opens its sheet; the ask bar opens the chat (the page's for now).
/// Without a plan, making the first one (NoPlanView).
struct CoachScreen: View {
    let shell: ShellModel
    let coach: CoachModel
    @State private var lifeOpen = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    // No plan yet, or the last one has ended (and nothing new is waiting): making one.
                    if let c = coach.data, c.intake != nil, c.plan == nil || (c.ended && c.proposal == nil) {
                        NoPlanView(shell: shell, coach: c, maker: coach.maker)
                    } else if let c = coach.data, let p = c.plan {
                        Text("Plan updated \(ago(p.updated)) · \(c.weeks.count) week\(c.weeks.count == 1 ? "" : "s")")
                            .font(.subheadline.weight(.medium)).foregroundStyle(.secondary).padding(.horizontal, 4)
                        content(c, p)
                    } else if let c = coach.data, c.intake != nil {
                        NoPlanView(shell: shell, coach: c, maker: coach.maker)
                    } else if coach.failed {
                        ContentUnavailableView {
                            Label("Your plan couldn't be read", systemImage: "exclamationmark.triangle")
                        } actions: {
                            Button("Try again") { Task { await coach.fetch() } }.buttonStyle(.glass)
                        }
                    } else {
                        ProgressView().controlSize(.large).frame(maxWidth: .infinity, minHeight: 260)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 16)
            }
            .background(Brand.ground)
            .refreshable { coach.stale = true; await coach.fetch() }
            .onScrollGeometryChange(for: CGFloat.self) { g in g.contentOffset.y + g.contentInsets.top } action: { old, new in shell.scrolled(by: new - old, at: new) }
            .safeAreaInset(edge: .bottom, spacing: 0) { askBar }
            .navigationTitle("Coach")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { SyncChip(lanes: shell.board) { shell.openBoard() } }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { shell.go("settings") } label: { Image(systemName: "gearshape") }.accessibilityLabel("Settings")
                }
            }
            .sheet(isPresented: $lifeOpen) {
                if let c = coach.data { LifeSheet(today: c.today, ill: c.ill, coach: coach) }
            }
        }
    }

    /** Ask your coach (or, without a key, the offer of one: never a wall), floating above the tab bar. */
    @ViewBuilder private var askBar: some View {
        if let c = coach.data, c.plan != nil {
            Group {
                if c.ready {
                    Button { chat(c.plan?.conversation) } label: {
                        HStack {
                            Text("Ask your coach or change the plan").foregroundStyle(.secondary).lineLimit(1)
                            Spacer(minLength: 8)
                            Image(systemName: "arrow.up").font(.body.weight(.bold)).foregroundStyle(Brand.onTint)
                                .frame(width: 36, height: 36).background(Brand.tint, in: Circle())
                        }
                        .padding(.leading, 18).padding(.trailing, 6).padding(.vertical, 6)
                        .contentShape(Capsule())
                    }
                    .buttonStyle(Press())
                    .glassEffect(.regular.interactive(), in: Capsule())
                } else {
                    Button { shell.go("settings/coach") } label: {
                        Label("Want a coach to talk to?", systemImage: "bubble.left.and.text.bubble.right").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.glass)
                    .controlSize(.large)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, shell.navOn ? (shell.navFolded ? 56 : 72) : 8)
            .background {
                LinearGradient(stops: [.init(color: Brand.ground.opacity(0), location: 0), .init(color: Brand.ground.opacity(0.92), location: 0.3), .init(color: Brand.ground, location: 1)],
                               startPoint: .top, endPoint: .bottom)
                    .ignoresSafeArea(edges: .bottom)
                    .allowsHitTesting(false)
            }
            .animation(.spring(response: 0.38, dampingFraction: 0.82), value: shell.navFolded)
        } else {
            BarSpace(on: shell.navOn)
        }
    }

    private func chat(_ conversation: String?) {
        var extra: [String: Any] = [:]
        if let conversation { extra["conversation"] = conversation }
        shell.goAction("chat", extra: extra)
    }

    @ViewBuilder private func content(_ c: Coach, _ p: PlanInfo) -> some View {
        let current = c.weeks.first { $0.time == "current" }
        let later = c.weeks.filter { $0.time == "future" }
        HStack(spacing: 8) {
            Picker("Show", selection: Binding(get: { coach.whole }, set: { v in withAnimation(.smooth) { coach.whole = v } })) {
                Text("This week").tag(false)
                Text("Whole plan").tag(true)
            }
            .pickerStyle(.segmented)
            Button { lifeOpen = true } label: {
                Label(c.ill != nil ? "Feeling better?" : "Change plan", systemImage: c.ill != nil ? "heart" : "clock").font(.subheadline.weight(.semibold))
            }
            .buttonStyle(.glass)
            .fixedSize()
        }
        // The coming week on a Suunto, with a watch in use (src/in-use.ts).
        if shell.inUse.watch { WatchLine(coach: coach) }
        if coach.whole {
            WholePlan(c: c, shell: shell)
            changes(c)
        } else {
            if let w = current { CoachWeekCard(w: w, title: "This week", today: c.today, shell: shell) }
            else {
                Card {
                    Text("No sessions this week").font(.title3.weight(.bold))
                    Text("Ask your coach to carry the plan on from today.").font(.subheadline).foregroundStyle(.secondary)
                }
            }
            changes(c)
            if let next = later.first { CoachWeekCard(w: next, title: "Next week", today: c.today, shell: shell) }
            if later.count > 1 {
                Button { withAnimation(.smooth) { coach.whole = true } } label: {
                    Text("\(later.count - 1) more week\(later.count - 1 == 1 ? "" : "s") · see the whole plan").frame(maxWidth: .infinity)
                }
                .buttonStyle(.glass)
                .controlSize(.large)
            }
        }
        Overview(p: p, goal: c.goal, w: current)
        if !p.zones.isEmpty { ZonesCard2(zones: p.zones) }
        if !p.advice.isEmpty {
            Card {
                Text("Pointers from your coach").font(.title3.weight(.bold))
                ForEach(Array(p.advice.enumerated()), id: \.offset) { _, a in
                    HStack(alignment: .firstTextBaseline, spacing: 8) { Text("•").foregroundStyle(Brand.tint); Text(a) }
                }
            }
        }
    }

    /** What the coach suggests or last changed, and the week's review: under the week they change. */
    @ViewBuilder private func changes(_ c: Coach) -> some View {
        let weekly = c.weekly.flatMap { w -> Weekly? in
            guard w.week != coach.weeklySeen, let start = dateOf(w.week), let end = Calendar(identifier: .gregorian).date(byAdding: .day, value: 6, to: start) else { return nil }
            return isoDay(end) >= c.today ? w : nil
        }
        let fromReview = c.proposal?.from == FROM["weekly"]
        if let pr = c.proposal {
            ProposalCard(p: pr, busy: coach.busy, review: fromReview ? weekly?.text : nil,
                         accept: { Task { await coach.write("/api/plan/proposal", ["accept": true, "base": pr.base], doing: "Accepting", done: "Plan changed. Your watch gets it next time Tartan syncs with it.") } },
                         keep: { Task { await coach.write("/api/plan/proposal", ["accept": false], doing: "Keeping", done: "Kept your plan as it was.") } },
                         talk: pr.conversation.map { conv -> () -> Void in { chat(conv) } })
        } else if let l = c.lastChange {
            UndoCard(l: l) { Task { await coach.write("/api/plan/revert", nil, doing: "Undoing", done: "Your plan is back as it was.") } }
        }
        if let w = weekly, !fromReview || c.proposal == nil {
            WeeklyCard(w: w, close: { withAnimation(.smooth) { coach.dismissWeekly(w.week) } }, talk: { chat(w.conversation) })
        }
    }
}

/// The coming week on the watch: how many sessions are on it, and Send.
private struct WatchLine: View {
    let coach: CoachModel

    var body: some View {
        if let s = coach.watch, s["canBluetooth"].bool, let want = s["wanted"].int, want > 0 {
            let on = s["onWatch"].int ?? 0
            HStack(spacing: 8) {
                Image(systemName: on >= want ? "checkmark" : "watch.analog").foregroundStyle(on >= want ? Brand.good : Color.secondary)
                Text("On your watch: \(on) of \(want)").font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                Spacer(minLength: 8)
                if coach.busy == "watch" {
                    ProgressView()
                } else {
                    Button(on >= want ? "Send again" : "Send") { Task { await coach.sendWeek() } }.font(.subheadline.weight(.semibold))
                }
            }
            .padding(.horizontal, 4)
        }
    }
}

/// The coach's words, simply: paragraphs, "- " points and **bold**.
struct Markdown: View {
    let text: String
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(paragraphs.enumerated()), id: \.offset) { _, para in
                let lines = para.components(separatedBy: "\n")
                if lines.allSatisfy({ $0.trimmingCharacters(in: .whitespaces).hasPrefix("- ") || $0.trimmingCharacters(in: .whitespaces).hasPrefix("* ") }) {
                    ForEach(Array(lines.enumerated()), id: \.offset) { _, l in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text("•")
                            Text(inline(String(l.trimmingCharacters(in: .whitespaces).dropFirst(2))))
                        }
                    }
                } else if para.trimmingCharacters(in: .whitespaces).hasPrefix("#") {
                    Text(inline(para.trimmingCharacters(in: CharacterSet(charactersIn: "# ")).replacingOccurrences(of: "\n", with: " "))).font(.headline)
                } else {
                    Text(inline(para.replacingOccurrences(of: "\n", with: " ")))
                }
            }
        }
    }

    private var paragraphs: [String] {
        text.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n\n").map { $0.trimmingCharacters(in: .newlines) }.filter { !$0.isEmpty }
    }

    private func inline(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
    }
}

private struct ChangeRows: View {
    let changes: [Change]
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(changes.enumerated()), id: \.offset) { _, c in
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: c.type == "added" ? "plus" : c.type == "removed" ? "minus" : c.type == "zones" ? "heart" : "sparkles")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(Brand.onContainer)
                        .frame(width: 28, height: 28)
                        .background(Brand.container, in: Circle())
                    VStack(alignment: .leading, spacing: 2) {
                        Text(c.headline).font(.subheadline.weight(.semibold))
                        Text(c.detail).font(.subheadline).foregroundStyle(.secondary)
                        if let w = c.why { Text(w).font(.caption).foregroundStyle(.secondary) }
                    }
                }
            }
        }
    }
}

private struct ProposalCard: View {
    let p: Proposal
    let busy: String?
    let review: String?
    let accept: () -> Void
    let keep: () -> Void
    let talk: (() -> Void)?

    var body: some View {
        let n = p.changes.count
        Card(fill: Brand.container) {
            VStack(alignment: .leading, spacing: 2) {
                Text(review != nil ? "Week review: \(n) change\(n == 1 ? "" : "s") suggested" : "Your coach suggests \(n) change\(n == 1 ? "" : "s")").font(.title3.weight(.bold))
                Text("\(p.from) · \(ago(p.at))").font(.subheadline).opacity(0.75)
            }
            if let r = review { Markdown(text: r) }
            if let note = p.note { Text(note) }
            ChangeRows(changes: p.changes)
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Brand.card.opacity(0.7), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            Text("Days already behind you stay as they were. You can undo it for a week.").font(.caption).opacity(0.8)
            Flow(spacing: 8) {
                Button(action: accept) { Label(busy == "Accepting" ? "Accepting…" : "Accept", systemImage: "checkmark") }
                    .buttonStyle(.glassProminent).disabled(busy != nil)
                Button("Keep my plan", action: keep).buttonStyle(.glass).disabled(busy != nil)
                if let talk { Button("Ask about it", action: talk).buttonStyle(.glass) }
            }
        }
        .foregroundStyle(Brand.onContainer)
    }
}

private struct UndoCard: View {
    let l: LastChange
    let undo: () -> Void
    @State private var open = false

    var body: some View {
        let n = l.changes.count
        Card {
            HStack {
                Button { withAnimation(.smooth) { open.toggle() } } label: {
                    Label(l.auto ? "Your coach made \(n) change\(n == 1 ? "" : "s") \(ago(l.at))" : "\(n) change\(n == 1 ? "" : "s") taken \(ago(l.at))", systemImage: "checkmark")
                        .font(.subheadline.weight(.semibold))
                }
                .foregroundStyle(Color.primary)
                Spacer(minLength: 8)
                Button("Undo", action: undo).font(.subheadline.weight(.semibold))
            }
            if open { ChangeRows(changes: l.changes).transition(.opacity) }
        }
    }
}

private struct WeeklyCard: View {
    let w: Weekly
    let close: () -> Void
    let talk: () -> Void

    var body: some View {
        Card {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(w.proposed > 0 ? "Changes suggested for next week" : w.changed ? "Next week, adjusted" : "Next week stays as planned").font(.title3.weight(.bold))
                    Text("Week review · \(dayName(w.at))").font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                Button(action: close) { Image(systemName: "xmark").font(.footnote.weight(.bold)) }
                    .buttonStyle(.glass).buttonBorderShape(.circle).accessibilityLabel("Put away")
            }
            Markdown(text: w.text)
            Button(action: talk) { Label("Talk it through", systemImage: "bubble.left.and.text.bubble.right") }.font(.subheadline.weight(.semibold))
        }
    }
}

/// The plan at a glance: its name, the goal, this week's progress, the summary.
private struct Overview: View {
    let p: PlanInfo
    let goal: String?
    let w: PWeek?
    @State private var more = false

    var body: some View {
        Card {
            Text(p.title).font(.title2.weight(.bold))
            if let g = goal { Label(g, systemImage: "flag.checkered").font(.subheadline.weight(.semibold)).foregroundStyle(Brand.tint) }
            if let w, w.planned > 0 {
                let share = min(1, Double(w.done) / Double(w.planned))
                HStack(alignment: .lastTextBaseline) {
                    Text("\(w.done) of \(w.planned) sessions").font(.headline)
                    Spacer()
                    Text(w.km > 0 ? "\(km1(w.doneKm)) of \(Int(w.km.rounded())) km this week" : duration(w.doneMinutes)).font(.subheadline).foregroundStyle(.secondary)
                }
                .padding(.top, 4)
                ProgressView(value: share).tint(share >= 1 ? Brand.good : Brand.tint)
            }
            Text(p.summary).font(.body).foregroundStyle(.secondary).lineLimit(more ? nil : 3)
            if p.summary.count > 160 {
                Button(more ? "Less" : "More") { withAnimation(.smooth) { more.toggle() } }.font(.subheadline.weight(.semibold))
            }
        }
    }
}

/// A week, day by day.
private struct CoachWeekCard: View {
    let w: PWeek
    let title: String
    let today: String
    let shell: ShellModel

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.title3.weight(.bold))
                Text([weekRange(w.start), w.km > 0 ? "\(Int(w.km.rounded())) km" : nil, w.minutes > 0 ? duration(w.minutes) : nil].compactMap { $0 }.joined(separator: " · "))
                    .font(.subheadline).foregroundStyle(.secondary)
            }
            if !w.focus.isEmpty { Text(w.focus).font(.subheadline) }
            Days(w: w, today: today, shell: shell).padding(.top, 4)
        }
    }
}

/// The date, then each session as a quiet row (its colour, its name, one line, where it stands).
private struct Days: View {
    let w: PWeek
    let today: String
    let shell: ShellModel

    var body: some View {
        VStack(spacing: 6) {
            ForEach(w.days) { d in
                let isToday = d.date == today
                HStack(alignment: .top, spacing: 10) {
                    VStack(spacing: 2) {
                        Text(dayName(d.date)).font(.caption.weight(.medium)).foregroundStyle(isToday ? Brand.tint : Color.secondary)
                        Text(String(Int(d.date.suffix(2)) ?? 0))
                            .font(.figure(.title3))
                            .foregroundStyle(isToday ? Brand.onTint : d.date < today ? Color.secondary : Color.primary)
                            .frame(width: 36, height: 34)
                            .background(isToday ? Brand.tint : Color.clear, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                    }
                    .frame(width: 44)
                    VStack(alignment: .leading, spacing: 4) {
                        if d.sessions.isEmpty && d.extras.isEmpty {
                            Text("Rest").font(.subheadline).foregroundStyle(.secondary).padding(.leading, 12).padding(.top, 14)
                        }
                        ForEach(d.sessions) { s in SessionRow(s: s) { shell.openSession(date: s.date, kind: s.kind) } }
                        ForEach(d.extras) { x in
                            Button { shell.openActivity(x.id) } label: {
                                Label(x.label, systemImage: "checkmark").font(.caption.weight(.semibold))
                                    .padding(.horizontal, 12).padding(.vertical, 6)
                                    .background(Brand.container, in: Capsule())
                                    .foregroundStyle(Brand.onContainer)
                            }
                            .buttonStyle(Press())
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .accessibilityElement(children: .contain)
            }
        }
    }
}

private struct SessionRow: View {
    let s: PSession
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: 12) {
                Circle().fill(kindColour(s.kind)).frame(width: 10, height: 10)
                VStack(alignment: .leading, spacing: 1) {
                    Text(s.title).font(.subheadline.weight(.semibold)).lineLimit(1)
                    // What it is, and the weather expected then while it's in the forecast (as a workout's row shows its own).
                    HStack(spacing: 6) {
                        Text(s.line).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                        if let wx = s.weather { WxInline(w: wx, font: .subheadline) }
                    }
                }
                Spacer(minLength: 4)
                switch s.status {
                case "done":
                    Image(systemName: "checkmark").font(.caption.weight(.bold)).foregroundStyle(Brand.good)
                        .frame(width: 26, height: 26).background(Brand.goodContainer, in: Circle()).accessibilityLabel("Done")
                case "missed":
                    Text("Missed").font(.caption.weight(.semibold)).padding(.horizontal, 10).padding(.vertical, 4)
                        .background(Color.red.opacity(0.15), in: Capsule()).foregroundStyle(Color.red)
                case "today":
                    Text("Today").font(.caption.weight(.semibold)).padding(.horizontal, 10).padding(.vertical, 4)
                        .background(Brand.tint, in: Capsule()).foregroundStyle(Brand.onTint)
                default:
                    EmptyView()
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 11)
            .background(Brand.well, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(Press())
        .foregroundStyle(Color.primary)
    }
}

/// Every week at a glance: its number, focus, volume on one scale, a dot a day; tap for its days.
private struct WholePlan: View {
    let c: Coach
    let shell: ShellModel
    @State private var open: Int?

    var body: some View {
        let byKm = c.weeks.allSatisfy { $0.km > 0 }
        let most = max(1, c.weeks.map { byKm ? $0.km : $0.minutes }.max() ?? 1)
        Card {
            Text("The whole plan").font(.title3.weight(.bold))
            Text("\(c.weeks.count) weeks").font(.subheadline).foregroundStyle(.secondary)
            VStack(spacing: 4) {
                ForEach(Array(c.weeks.enumerated()), id: \.offset) { i, w in
                    VStack(alignment: .leading, spacing: 0) {
                        Button { withAnimation(.smooth) { open = open == i ? nil : i } } label: { row(i, w, byKm: byKm, most: most) }
                            .buttonStyle(Press())
                            .foregroundStyle(Color.primary)
                        if open == i { Days(w: w, today: c.today, shell: shell).padding(8).transition(.opacity) }
                    }
                    .background(w.time == "current" ? Brand.container.opacity(0.6) : Brand.well, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
            }
        }
        .onAppear { if open == nil { open = c.weeks.firstIndex { $0.time == "current" } } }
    }

    private func row(_ i: Int, _ w: PWeek, byKm: Bool, most: Double) -> some View {
        let vol = byKm ? w.km : w.minutes
        let state = w.time == "past" ? "\(w.done) of \(w.planned) done" : w.time == "current" ? "This week · \(w.done) of \(w.planned) done" : "\(w.planned) sessions"
        return HStack(spacing: 10) {
            Text("\(i + 1)").font(.figure(.title3)).frame(width: 28).foregroundStyle(w.time == "past" ? Color.secondary : Color.primary)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(w.focus).font(.subheadline.weight(.semibold)).lineLimit(1)
                    if w.race {
                        Text("Race week").font(.caption2.weight(.bold)).padding(.horizontal, 8).padding(.vertical, 2)
                            .background(Brand.tint, in: Capsule()).foregroundStyle(Brand.onTint)
                    }
                }
                Text([weekRange(w.start), byKm ? "\(Int(vol.rounded())) km" : duration(vol), state].joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                GeometryReader { g in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Brand.well)
                        Capsule().fill(w.time == "past" ? Color.secondary : Brand.tint).frame(width: g.size.width * min(1, max(0.04, vol / most)))
                    }
                }
                .frame(height: 6)
            }
            HStack(spacing: 3) {
                ForEach(w.days) { d in
                    let s = d.sessions.first
                    let k = s.map { kindColour($0.kind) } ?? Brand.well
                    Circle()
                        .fill(s == nil ? Brand.well : s!.status == "done" ? k : s!.status == "missed" ? k.opacity(0.3) : Color.clear)
                        .overlay(Circle().stroke(s != nil && s!.status != "done" && s!.status != "missed" ? k : Color.clear, lineWidth: 1.5))
                        .frame(width: 8, height: 8)
                }
            }
        }
        .padding(12)
        .contentShape(Rectangle())
    }
}

private struct ZonesCard2: View {
    let zones: [Zone]
    @State private var open = false

    var body: some View {
        Card {
            Button { withAnimation(.smooth) { open.toggle() } } label: {
                HStack {
                    Text("Your paces and zones").font(.title3.weight(.bold))
                    Spacer()
                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.secondary).rotationEffect(.degrees(open ? 90 : 0))
                }
                .contentShape(Rectangle())
            }
            .foregroundStyle(Color.primary)
            if open {
                ForEach(Array(zones.enumerated()), id: \.offset) { _, z in
                    HStack(alignment: .top, spacing: 12) {
                        Text(z.name).font(.subheadline.weight(.semibold)).frame(width: 110, alignment: .leading)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(z.line).font(.subheadline)
                            if let u = z.use { Text(u).font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                }
                .transition(.opacity)
            }
        }
    }
}

// MARK: - Change plan

/// The one-tap life changes (src/life.ts), by what each is called.
enum Life: String, CaseIterable, Identifiable {
    case ill, better, away, busy
    var id: String { rawValue }
    var icon: String { switch self { case .ill: return "heart"; case .better: return "checkmark"; case .away: return "airplane"; case .busy: return "clock" } }
}

/// Something came up: ill, better again, away, a busy week. Each changes the plan by Tartan's
/// rules (no chat, no AI), taken at once, with Undo on Coach.
private struct LifeSheet: View {
    let today: String
    let ill: String?
    let coach: CoachModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if let ill { Section { Text("Ill since \(dateShort(ill)).").foregroundStyle(.secondary) } }
                Section {
                    ForEach(ill != nil ? [Life.better, .away, .busy] : Life.allCases) { l in
                        NavigationLink(value: l) {
                            Label(label(l), systemImage: l.icon)
                        }
                    }
                }
            }
            .navigationTitle(ill != nil ? "Feeling better?" : "Something came up?")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: Life.self) { l in LifeChoice(l: l, today: today, ill: ill, coach: coach) { dismiss() } }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button { dismiss() } label: { Image(systemName: "xmark") }.accessibilityLabel("Close") }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func label(_ l: Life) -> String {
        switch l {
        case .ill: return "I'm ill"
        case .better: return ill == nil ? "I was ill" : "Better now"
        case .away: return "I'm away"
        case .busy: return "Busy week"
        }
    }
}

private struct LifeChoice: View {
    let l: Life
    let today: String
    let ill: String?
    let coach: CoachModel
    let done: () -> Void
    @State private var illFor = 0
    @State private var away = 0
    @State private var easy = false
    @State private var busy = false
    @State private var error: String?

    private let illDays = [3, 7, 14]

    var body: some View {
        Form {
            if l == .better {
                Section("How long were you ill?") {
                    Picker("How long", selection: $illFor) {
                        Text("A few days").tag(0); Text("About a week").tag(1); Text("Longer").tag(2)
                    }
                    .pickerStyle(.segmented)
                }
            }
            if l == .away {
                Section("When?") {
                    Picker("When", selection: $away) {
                        Text("This week").tag(0); Text("Next week").tag(1); Text("Two weeks").tag(2)
                    }
                    .pickerStyle(.segmented)
                }
                Section("Training while away") {
                    Picker("Training", selection: $easy) {
                        Text("None").tag(false); Text("Easy runs").tag(true)
                    }
                    .pickerStyle(.segmented)
                }
            }
            Section {
                Text(words).foregroundStyle(.secondary)
                if let error { Text(error).foregroundStyle(.red) }
            }
            Section {
                Button {
                    busy = true
                    error = nil
                    Task {
                        error = await coach.life(lifeBody())
                        busy = false
                        if error == nil { done() }
                    }
                } label: {
                    HStack { Spacer(); if busy { ProgressView() } else { Text(action).fontWeight(.semibold) }; Spacer() }
                }
                .disabled(busy)
            }
        }
        .navigationTitle(title)
        .onAppear {
            // Ill since a date: that many days, to the nearest choice.
            if let ill, let a = dateOf(ill), let b = dateOf(today) {
                let d = Calendar(identifier: .gregorian).dateComponents([.day], from: a, to: b).day ?? 0
                illFor = illDays.firstIndex { d <= $0 } ?? 2
            }
        }
    }

    private var title: String {
        switch l { case .ill: return "Ill"; case .better: return "Back after being ill"; case .away: return "Away"; case .busy: return "A busy week" }
    }

    private var action: String {
        switch l { case .ill: return "Rest until I'm better"; case .better: return "Ease me back in"; case .away: return "Change my plan"; case .busy: return "Make this week shorter" }
    }

    private var words: String {
        switch l {
        case .ill: return "Rest for today and the next two days. When you feel better, tap Better now and the plan eases you back in."
        case .better:
            switch illFor {
            case 0: return "Three days of easy running, a little shorter, the long run an hour at most. Then the plan as it was."
            case 1: return "A week of easy running: half length for three days (no gym), then three quarters. Then the plan as it was."
            default: return "Two weeks of easy running: the first at half length (no gym), the second at three quarters. Then the plan as it was."
            }
        case .away: return easy ? "Easy runs only while you're away: hard sessions become easy runs, the long run 75 minutes at most, no gym." : "No training while you're away. After a week or more, two easy days when you're back."
        case .busy: return "The rest of this week shorter: easy runs at about 60%, the long run at 75%, hard sessions kept. With more than three runs left, the shortest easy one goes."
        }
    }

    /** What the life change sends (POST /api/plan/life), as Android's lifeBody. */
    private func lifeBody() -> [String: Any] {
        switch l {
        case .ill: return ["type": "ill"]
        case .better: return ["type": "better", "days": illDays[illFor]]
        case .busy: return ["type": "busy"]
        case .away:
            let cal = Calendar(identifier: .gregorian)
            let t = dateOf(today) ?? Date()
            // Sunday is weekday 1: the days to this week's Sunday (today, when it is one).
            let toSunday = (8 - cal.component(.weekday, from: t)) % 7
            let sunday = cal.date(byAdding: .day, value: toSunday, to: t) ?? t
            let add = { (d: Date, n: Int) in cal.date(byAdding: .day, value: n, to: d) ?? d }
            let (from, to): (Date, Date) = away == 0 ? (t, sunday) : away == 1 ? (add(sunday, 1), add(sunday, 7)) : (t, add(t, 13))
            return ["type": "away", "from": isoDay(from), "to": isoDay(to), "train": easy ? "easy" : "none"]
        }
    }
}
