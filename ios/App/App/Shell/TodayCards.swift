import SwiftUI

// Today's cards (Android's TodayScreen.kt and TodayCards.kt, drawn the iOS way).

/// A title over a card's content.
private struct CardTitle: View {
    let text: String
    var body: some View {
        Text(text).font(.title3.weight(.bold)).accessibilityAddTraits(.isHeader)
    }
}

/// A rounded square with a symbol in it, in a session's or a workout's colours.
private struct Badge: View {
    let symbol: String
    var fill: Color = Brand.container
    var ink: Color = Brand.onContainer
    var size: CGFloat = 48

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: size * 0.42, weight: .semibold))
            .foregroundStyle(ink)
            .frame(width: size, height: size)
            .background(fill, in: RoundedRectangle(cornerRadius: size * 0.32, style: .continuous))
            .accessibilityHidden(true)
    }
}

private func chevron() -> some View {
    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary).accessibilityHidden(true)
}

/// The demo: this is sample data, nothing of yours, and the way back to your own.
struct SampleBanner: View {
    let leave: () -> Void
    var body: some View {
        Card(fill: Brand.watchContainer) {
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Sample data").font(.headline)
                    Text("Ten weeks of a made-up runner, to look around. Nothing of yours is here, and nothing syncs.").font(.subheadline)
                }
                Spacer(minLength: 0)
                Button("Leave", action: leave).buttonStyle(.glass)
            }
        }
    }
}

// MARK: - Today's session

struct SessionCard: View {
    let s: Session
    let open: () -> Void
    let openWorkout: (String) -> Void
    let mark: (() -> Void)?
    let busy: Bool
    /** Today's change (suggested here, or taken), and the way to the choices on a normal day. */
    var today: TodayModel? = nil
    var openChoices: (() -> Void)? = nil

    var body: some View {
        let done = s.status == "done"
        Card(action: open, label: "Open \(s.title)") {
            HStack(spacing: 14) {
                Badge(symbol: done ? "checkmark" : kindSymbol(s.kind),
                      fill: done ? Brand.goodContainer : Brand.container, ink: done ? Brand.good : Brand.onContainer, size: 52)
                VStack(alignment: .leading, spacing: 2) {
                    Text(s.title).font(.title3.weight(.semibold))
                    Text(subtitle(done)).font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                chevron()
            }
            if !done, let shoe = s.shoe {
                Label {
                    Text("\(Text(shoe.name).fontWeight(.semibold)) · \(shoe.why)")
                } icon: {
                    Image(systemName: "shoe")
                }
                .font(.subheadline)
            }
            if let notes = s.notes { Text(notes).font(.subheadline) }
            if let id = s.activityId, let did = s.did {
                Button { openWorkout(id) } label: {
                    HStack {
                        Image(systemName: "checkmark").foregroundStyle(Brand.good)
                        Text(did).font(.subheadline.weight(.semibold))
                        Spacer(minLength: 0)
                        chevron()
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Brand.goodContainer, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
                .buttonStyle(Press())
            } else if s.manual {
                Label("Marked done by you", systemImage: "checkmark").font(.subheadline).foregroundStyle(Brand.good)
            } else if let mark {
                Button(action: mark) { Label("Mark done", systemImage: "checkmark") }
                    .buttonStyle(.glass)
                    .disabled(busy)
            }
            // Today's change: suggested here when there's a reason, or taken (with Undo); on a
            // normal day only a quiet way in.
            if !done, let today {
                if let w = today.check?.swap, w.taken {
                    TakenLine(w: w, today: today)
                } else if let w = today.check?.swap, w.date == s.date, w.kind == s.kind {
                    Suggested(w: w, today: today)
                } else if let openChoices, let c = today.check?.choices, c.date == s.date, c.kind == s.kind {
                    Button("Different plan today?", action: openChoices)
                        .font(.subheadline.weight(.medium))
                        .buttonStyle(.plain)
                        .foregroundStyle(Brand.tint)
                }
            }
        }
    }

    private func subtitle(_ done: Bool) -> String {
        let lead = done ? "Done today" : kindWord(s.kind, s.title).map { "Today · \($0)" } ?? "Today"
        return [lead, s.detail].filter { !$0.isEmpty }.joined(separator: " · ")
    }
}

/// A session kind's symbol: strength a dumbbell, a swim and a ride their own, the rest a run.
func kindSymbol(_ kind: String) -> String {
    switch kind {
    case "strength": return "dumbbell.fill"
    case "swim": return "figure.pool.swim"
    case "ride": return "figure.outdoor.cycle"
    default: return "figure.run"
    }
}

/// The weekday of a date, in full ("Thursday").
private func fullDay(_ iso: String) -> String {
    guard let d = dateOf(iso) else { return iso }
    return d.formatted(.dateTime.weekday(.wide))
}

/// A choice as a few words: Swim instead, Shorter, 25 min, Move to Thursday, Run anyway.
func choiceLabel(_ c: DayChoice) -> String {
    switch c.to {
    case "swim": return "Swim instead"
    case "ride": return "Ride instead"
    case "treadmill": return "Treadmill instead"
    case "short": return "Shorter, \(c.minutes ?? 20) min"
    case "move": return "Move to \(fullDay(c.day ?? ""))"
    case "nudge": return "Give me a nudge"
    default: return "Run anyway"
    }
}

/// The session card's own suggestion, warm and short: what the day is like then and why it
/// matters to you, then small choices in your order, the first a little stronger, Run anyway
/// always there.
private struct Suggested: View {
    let w: DaySwap
    let today: TodayModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("\(Text(w.why.map { "\($0). " } ?? "").fontWeight(.semibold))\(w.reason ?? "")")
                .font(.subheadline)
            FlowLayout(spacing: 8) {
                ForEach(Array(w.choices.enumerated()), id: \.offset) { i, c in
                    if i == 0 {
                        Button(choiceLabel(c)) { today.change(c, fromCard: true) }.buttonStyle(.glassProminent)
                    } else {
                        Button(choiceLabel(c)) { today.change(c, fromCard: true) }.buttonStyle(.glass)
                    }
                }
            }
            .font(.subheadline.weight(.semibold))
            .disabled(today.busy)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Brand.container.opacity(0.6), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

/// A change taken today, in a line, with Undo.
private struct TakenLine: View {
    let w: DaySwap
    let today: TodayModel

    var body: some View {
        HStack {
            Text(line).font(.subheadline).foregroundStyle(.secondary)
            Spacer(minLength: 8)
            Button("Undo") { today.undoChange() }.font(.subheadline.weight(.semibold)).disabled(today.busy)
        }
    }

    private var line: String {
        let c = w.choices.first
        switch c?.to {
        case "swim": return "A \(c?.minutes ?? 0) min swim instead of \(w.title) today."
        case "ride": return "A \(c?.minutes ?? 0) min ride instead of \(w.title) today."
        case "treadmill": return "\(w.title) on the treadmill today."
        case "short": return "\(w.title) cut to \(c?.minutes ?? 0) easy minutes today."
        default: return "\(w.title) moved to \(fullDay(c?.day ?? ""))."
        }
    }
}

/// Different plan today? (asked from the session): no guilt, a few ways to go in your order, the
/// stance's line when it leads with the run or eases off, what's learned in a line. A nudge shows
/// its words here; a change closes the sheet and shows in the session with Undo.
struct DayChoicesSheet: View {
    let c: DayChoices
    let today: TodayModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text(c.line ?? "No guilt either way. A few ways to go:").font(.subheadline).foregroundStyle(.secondary)
                    if let r = c.reason { Text(r).font(.footnote).foregroundStyle(.secondary) }
                    ForEach(c.choices) { ch in
                        Button {
                            if ch.to == "nudge" { today.askNudge() } else { today.change(ch, fromCard: false); dismiss() }
                        } label: {
                            HStack(alignment: .top, spacing: 12) {
                                Image(systemName: symbol(ch)).foregroundStyle(Brand.tint).frame(width: 24)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(title(ch)).font(.headline)
                                    Text(sub(ch)).font(.subheadline).foregroundStyle(ch.to == "nudge" && today.nudge != nil ? .primary : .secondary)
                                        .multilineTextAlignment(.leading)
                                }
                                Spacer(minLength: 0)
                            }
                            .padding(16)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Brand.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                        }
                        .buttonStyle(Press())
                    }
                }
                .padding(16)
            }
            .background(Brand.ground)
            .navigationTitle("Different plan today?")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button { dismiss() } label: { Image(systemName: "xmark") }.accessibilityLabel("Close") } }
        }
        .presentationDetents([.medium, .large])
        .onDisappear { today.nudge = nil }
    }

    private func symbol(_ ch: DayChoice) -> String {
        switch ch.to {
        case "nudge": return "sparkles"
        case "swim": return "figure.pool.swim"
        case "ride": return "figure.outdoor.cycle"
        case "move": return "calendar"
        default: return "figure.run"
        }
    }

    private func title(_ ch: DayChoice) -> String {
        switch ch.to {
        case "short": return "A shorter version"
        case "move": return "Move it"
        default: return choiceLabel(ch)
        }
    }

    private func sub(_ ch: DayChoice) -> String {
        switch ch.to {
        case "nudge": return today.nudge ?? (today.nudging ? "…" : "A few words from your own data.")
        case "swim", "ride": return "About \(ch.minutes ?? 0) min easy, the same aerobic work."
        case "treadmill": return "The same session, out of the weather."
        case "short": return "\(ch.minutes ?? 20) min easy. You can stop after 10."
        default: return "To \(fullDay(ch.day ?? "")), the next free day."
        }
    }
}

/// No session today: a rest day, and what's next.
struct RestDayCard: View {
    let next: Session?
    let open: (Session) -> Void
    let toPlan: () -> Void

    var body: some View {
        Card(action: next.map { n -> () -> Void in { open(n) } }, label: "Open the next session") {
            CardTitle(text: "Rest day")
            if let n = next {
                let detail = n.detail.components(separatedBy: " · ").prefix(2).joined(separator: " · ")
                Text("Next: \(dayName(n.date)), \(n.title)\(detail.isEmpty ? "" : " · \(detail)")").font(.subheadline).foregroundStyle(.secondary)
            }
            Button("See the plan", action: toPlan).font(.subheadline.weight(.semibold))
        }
    }
}

/// No plan yet: Tartan's own rules make one from the workouts it has, no key needed. Make my plan
/// opens Coach's few questions (each with Not sure), then the plan is there.
/// `ended`: there was a plan and its last day has gone: Make the next one.
struct NoPlanCard: View {
    var ended = false
    let make: () -> Void

    var body: some View {
        Card(action: make, label: ended ? "Make the next one" : "Make my plan") {
            CardTitle(text: ended ? "Your plan has ended" : "No plan yet")
            Text(ended ? "Tartan makes the next one from where you are now, by its own rules: a few quick questions, no key needed." : "Tartan makes one from the workouts it has, by its own rules: a few quick questions, no key needed.").font(.subheadline).foregroundStyle(.secondary)
            Button { make() } label: { Label(ended ? "Make the next one" : "Make my plan", systemImage: "sparkles").font(.subheadline.weight(.semibold)) }
                .buttonStyle(.glassProminent)
        }
    }
}

// MARK: - How you are

struct ReadinessCard: View {
    let r: Readiness
    let today: TodayModel

    var body: some View {
        let c = today.check
        // Asking until every question is answered (legs alone isn't the whole check while sleep is asked).
        let asking = c.map { !$0.complete } ?? false
        let easy = c.map { $0.complete && $0.level != "ready" } ?? false
        Card {
            if asking {
                MorningCheck(today: today)
                Text("Until then: \(lowerFirst(r.title))").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary).padding(.top, 6)
            } else {
                Text(title(c, easy))
                    .font(.title2.weight(.bold))
                    .foregroundStyle(Brand.tint)
                Text(advice(c, easy))
                    .font(.body)
                if c != nil { MorningCheck(today: today) }
            }
            if r.state != "new" { ReadinessScale(state: r.state) }
            if !r.why.isEmpty && !easy { Text(r.why).font(.subheadline).foregroundStyle(.secondary) }
        }
        .animation(.smooth(duration: 0.3), value: asking)
    }

    /** One verdict: the check's, once it says go easy or rest; else how you are. */
    private func title(_ c: Check?, _ easy: Bool) -> String {
        guard easy, let c else { return r.title }
        return c.level == "rest" ? "Rest or go very easy" : "Go easy today"
    }

    private func advice(_ c: Check?, _ easy: Bool) -> String {
        guard easy, let c else { return r.advice }
        if !c.why.isEmpty { return c.why }
        return c.level == "rest" ? "Your morning check says your body needs it." : "Your morning check says to hold back."
    }
}

func lowerFirst(_ s: String) -> String { s.prefix(1).lowercased() + s.dropFirst() }

/// Where you are from tired to rested: a quiet track with your step filled, its name under it.
struct ReadinessScale: View {
    let state: String
    private let keys = ["tired", "building", "steady", "fresh", "rested"]
    private let names = ["tired": "Tired", "building": "Building", "steady": "Balanced", "fresh": "Fresh", "rested": "Rested"]

    var body: some View {
        HStack(alignment: .top, spacing: 4) {
            ForEach(keys, id: \.self) { key in
                let on = key == state
                VStack(spacing: 6) {
                    Capsule().fill(on ? Brand.tint : Brand.well).frame(height: on ? 6 : 4)
                    Text(names[key] ?? key)
                        .font(on ? Font.caption.weight(.semibold) : Font.caption2)
                        .foregroundStyle(on ? Brand.tint : Color.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                }
                .frame(maxWidth: .infinity)
            }
        }
        .frame(height: 30, alignment: .top)
        .padding(.vertical, 4)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Readiness: \(names[state] ?? state)")
    }
}

/// A row of answer chips: the chosen one filled. Liquid Glass, as iOS 26 draws its controls.
private struct Answers: View {
    let label: String?
    let words: [String]
    let chosen: Int?
    let enabled: Bool
    let pick: (Int) -> Void

    var body: some View {
        HStack(spacing: 6) {
            if let label {
                Text(label).font(.subheadline.weight(.medium)).foregroundStyle(.secondary).frame(width: 52, alignment: .leading)
            }
            ForEach(Array(words.enumerated()), id: \.offset) { i, w in
                Chip(text: w, on: chosen == i + 1, wide: true) { pick(i + 1) }
                    .disabled(!enabled)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(label ?? "")
    }
}

/// One answer: glass, filled with the tint when chosen.
private struct Chip: View {
    let text: String
    let on: Bool
    var wide = false
    let action: () -> Void

    var body: some View {
        let label = Text(text)
            .font(.subheadline.weight(.semibold))
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .frame(maxWidth: wide ? .infinity : nil)
        Group {
            if on {
                Button(action: action) { label }.buttonStyle(.glassProminent)
            } else {
                Button(action: action) { label }.buttonStyle(.glass)
            }
        }
        .buttonBorderShape(.capsule)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

/// The morning check: how your legs feel (and how you slept, when the watch didn't measure the
/// night), something that hurts, then the verdict; on a bad day with a hard session planned, the
/// offer to swap it for an easy run. It stays open until every question asked is answered, then
/// folds to what you said, with Change; changed, it folds again with Done or a few seconds after
/// the last answer (not while picking where it hurts).
struct MorningCheck: View {
    let today: TodayModel
    @State private var painOpen = false
    @State private var area: String?

    private let sleepWords = ["Badly", "OK", "Well"]
    private let legWords = ["Heavy", "Normal", "Fresh"]
    private let hurtWords = ["A niggle", "Sore", "Painful"]

    var body: some View {
        if let c = today.check {
            let open = !c.complete || today.checkEditing
            VStack(alignment: .leading, spacing: 10) {
                if !open {
                    HStack {
                        Text("Morning check: \(c.reasons.isEmpty ? "all good" : c.reasons.joined(separator: ", ")).").font(.subheadline)
                        Spacer(minLength: 8)
                        Button("Change") { today.checkTouched = 0; today.checkEditing = true }.font(.subheadline.weight(.semibold))
                    }
                } else {
                    questions(c)
                }
                swapRow(c)
            }
            .task(id: "\(today.checkTouched)|\(painOpen)|\(c.complete)|\(today.checkEditing)") {
                guard today.checkEditing, c.complete, !painOpen, today.checkTouched > 0 else { return }
                try? await Task.sleep(for: .seconds(3))
                if !Task.isCancelled { withAnimation(.smooth) { today.checkEditing = false } }
            }
        }
    }

    @ViewBuilder private func questions(_ c: Check) -> some View {
        Text(c.measured ? "How do your legs feel this morning?" : "How do you feel this morning?").font(.title3.weight(.bold))
        if !c.measured {
            Answers(label: "Sleep", words: sleepWords, chosen: c.sleep, enabled: !today.busy) { today.answer(sleep: $0) }
        }
        Answers(label: c.measured ? nil : "Legs", words: legWords, chosen: c.legs, enabled: !today.busy) { today.answer(legs: $0) }
        if painOpen {
            Text("Where does it hurt?").font(.subheadline.weight(.medium)).foregroundStyle(.secondary)
            Flow(spacing: 6) {
                ForEach(AREAS, id: \.self) { a in
                    Chip(text: areaName(a), on: (area ?? c.pain?.area) == a) { area = area == a ? nil : a }
                }
            }
            Text("How much?").font(.subheadline.weight(.medium)).foregroundStyle(.secondary)
            let where_ = area ?? c.pain?.area
            Answers(label: nil, words: hurtWords, chosen: c.pain.flatMap { $0.area == where_ ? $0.level : nil }, enabled: where_ != nil && !today.busy) { lv in
                painOpen = false
                if let w = where_ { today.answer(pain: (area: w, level: lv)) }
            }
            Button("Nothing hurts") { painOpen = false; area = nil; today.answer(clearPain: true) }.font(.subheadline.weight(.semibold))
        } else {
            Button {
                withAnimation(.smooth) { painOpen = true }
            } label: {
                Text(c.pain.map { "\(areaName($0.area)): \(hurtWords[safe: $0.level - 1]?.lowercased() ?? "") · Change" } ?? "Something hurts?")
            }
            .font(.subheadline.weight(.semibold))
        }
        if c.complete {
            Text("\(Text(c.verdict).fontWeight(.bold).foregroundStyle(verdictColour(c.level)))\(c.why.isEmpty ? "" : " \(c.why)")")
                .font(.subheadline)
        }
        if today.checkEditing && c.complete && !painOpen {
            Button("Done") { withAnimation(.smooth) { today.checkEditing = false } }.buttonStyle(.glass)
        }
    }

    @ViewBuilder private func swapRow(_ c: Check) -> some View {
        if let from = c.swappedFrom, !c.sessionDone {
            HStack {
                Text("\(from) is swapped for an easy run today.").font(.subheadline)
                Spacer(minLength: 8)
                Button("Undo the swap") { today.swap(undo: true) }.font(.subheadline.weight(.semibold)).disabled(today.busy)
            }
        } else if c.suggestSwap, let title = c.sessionTitle {
            Button("Swap \(title) for an easy run") { today.swap(undo: false) }.buttonStyle(.glass).disabled(today.busy)
        }
    }

    private func verdictColour(_ level: String) -> Color {
        switch level {
        case "ready": return Brand.good
        case "rest": return Color.red
        default: return Brand.watch
        }
    }
}

extension Array {
    subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}

// MARK: - Race

/// From twelve weeks out until race week: the days to go, the prediction and how it moved over
/// four weeks, the target and whether it's on track, and in the last two weeks the taper.
struct RaceCountdownCard: View {
    let race: RaceGoal
    let c: RaceGoal.Countdown
    let open: () -> Void

    var body: some View {
        Card(action: open, label: "Open Progress") {
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 2) {
                    CardTitle(text: race.name)
                    Text(race.date.map { "\(kmText(race.km)) km · \(dateShort($0))" } ?? "\(kmText(race.km)) km").font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 0) {
                    Text("\(c.daysToGo)").font(.figure(.largeTitle)).foregroundStyle(Brand.tint)
                    Text(c.daysToGo == 1 ? "day to go" : "days to go").font(.caption.weight(.medium)).foregroundStyle(.secondary)
                }
            }
            if let p = race.predictedS {
                HStack(spacing: 8) {
                    RaceTile(label: "Predicted", value: clock(p), sub: moved, subColour: (c.changeS ?? 0) <= -5 ? Brand.good : Color.secondary)
                    if let target = race.targetS {
                        RaceTile(label: "Target", value: clock(target), sub: c.gapS.map { $0 <= 0 ? "On track" : "\(clock($0)) to find" },
                                 subColour: (c.gapS ?? 1) <= 0 ? Brand.good : Color.secondary)
                    }
                }
            } else {
                Text("No prediction yet: it needs a run of at least an eighth of the distance.").font(.subheadline).foregroundStyle(.secondary)
            }
            if c.taper {
                VStack(alignment: .leading, spacing: 4) {
                    Text("The taper").font(.subheadline.weight(.semibold))
                    Text("Volume comes down, a little sharpness stays. The work is done: trust it.").font(.subheadline)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
                .background(Brand.container, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .foregroundStyle(Brand.onContainer)
            }
        }
    }

    private var moved: String? {
        guard let ch = c.changeS else { return nil }
        if abs(ch) < 5 { return "The same as a month ago" }
        return "\(clock(abs(ch))) \(ch < 0 ? "quicker" : "slower") than a month ago"
    }
}

private struct RaceTile: View {
    let label: String
    let value: String
    let sub: String?
    let subColour: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption.weight(.medium)).foregroundStyle(.secondary)
            Text(value).font(.figure(.title2))
            if let sub { Text(sub).font(.caption).foregroundStyle(subColour) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Brand.well, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

/// Your race (beyond twelve weeks, or without a countdown): when, the target, the prediction.
struct RaceCard: View {
    let race: RaceGoal
    let open: () -> Void

    var body: some View {
        Card(action: open, label: "Open Progress") {
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 2) {
                    CardTitle(text: race.name)
                    Text(details).font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 4) {
                    if let w = whenText { Text(w).font(.headline).foregroundStyle(Brand.tint) }
                    if let on = race.onTrack {
                        Text(on ? "On track" : race.predictedS.map { "Predicted \(clock($0))" } ?? "Behind target")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(on ? Brand.good : Color.secondary)
                            .padding(.horizontal, 10).padding(.vertical, 4)
                            .background(on ? Brand.goodContainer : Brand.well, in: Capsule())
                    }
                }
            }
        }
    }

    private var details: String {
        var bits = ["\(kmText(race.km)) km"]
        if let d = race.date { bits.append(dateShort(d)) }
        if let t = race.targetS { bits.append("target \(clock(t))") }
        return bits.joined(separator: " · ")
    }

    private var whenText: String? {
        guard let d = race.daysToGo else { return nil }
        return d > 1 ? "in \(d) days" : d == 1 ? "tomorrow" : d == 0 ? "today" : "done"
    }
}

/// In the last seven days: race week, the race and today's focus; pacing, fuel and the checklist in a sheet.
struct RaceWeekCard: View {
    let race: RaceGoal
    let week: RaceWeek
    let open: () -> Void

    var body: some View {
        Card(fill: Brand.container) {
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 2) {
                    CardTitle(text: race.name)
                    Text(week.pacing.map { "Race week · \(clock(Int($0.paceS.rounded()))) /km for \(clock($0.timeS))" } ?? "Race week").font(.subheadline)
                }
                Spacer(minLength: 8)
                Text(week.daysToGo > 1 ? "in \(week.daysToGo) days" : week.daysToGo == 1 ? "tomorrow" : "today").font(.title3.weight(.bold))
            }
            Text(week.focusTitle).font(.headline)
            Text(week.focusText).font(.subheadline)
            Button(week.pacing != nil ? "Pacing, fuel and checklist" : "Fuel and checklist", action: open).buttonStyle(.glass)
        }
        .foregroundStyle(Brand.onContainer)
    }
}

/// Race week in full: pacing (and its workout for the watch), fuel, and a checklist kept on the phone.
struct RaceWeekSheet: View {
    let race: RaceGoal
    let week: RaceWeek
    let today: TodayModel
    @State private var ticked: Set<String> = []
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if let p = week.pacing {
                    Section("Pacing") {
                        LabeledContent(p.fromTarget ? "Target" : "Predicted", value: clock(p.timeS))
                        LabeledContent("Pace", value: "\(clock(Int(p.paceS.rounded()))) /km")
                        ForEach(Array(p.checkpoints.enumerated()), id: \.offset) { _, cp in
                            LabeledContent("At \(cp.km.truncatingRemainder(dividingBy: 1) == 0 ? String(Int(cp.km)) : km1(cp.km)) km", value: clock(cp.timeS))
                        }
                        if !p.start.isEmpty { Text(p.start).font(.subheadline).foregroundStyle(.secondary) }
                        Button { today.pacingToWatch(race, week) } label: { Label("Pacing workout to the watch", systemImage: "applewatch.radiowaves.left.and.right") }
                            .disabled(today.busy)
                    }
                }
                Section("Fuel") {
                    ForEach(week.fuel, id: \.self) { Text($0) }
                }
                Section("Checklist") {
                    ForEach(week.checklist, id: \.self) { item in
                        let on = ticked.contains(item)
                        Button {
                            today.tick(race, item, !on)
                            ticked = today.ticked(race)
                        } label: {
                            Label(item, systemImage: on ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(on ? Brand.tint : Color.primary)
                        }
                        .accessibilityAddTraits(on ? .isSelected : [])
                    }
                }
            }
            .navigationTitle(race.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }.accessibilityLabel("Close")
                }
            }
            .onAppear { ticked = today.ticked(race) }
        }
        .presentationDetents([.medium, .large])
    }
}

// MARK: - This week

/// The week: a ring filling toward its target, how far to go, the plan's sessions, and the days.
struct WeekCard: View {
    let w: Week
    let open: () -> Void

    var body: some View {
        let share = w.goalKm > 0 ? min(1, max(0, w.km / w.goalKm)) : 0
        let reached = w.goalKm > 0 && w.km >= w.goalKm
        Card(action: open, label: "Open Progress") {
            CardTitle(text: "This week")
            HStack(spacing: 18) {
                WeekRing(share: share, km: w.km, reached: reached)
                    .accessibilityLabel("\(km1(w.km)) of \(km1(w.goalKm)) km")
                VStack(alignment: .leading, spacing: 4) {
                    if w.goalKm <= 0 {
                        Text("Set a weekly target in Settings").font(.subheadline).foregroundStyle(.secondary)
                    } else if reached {
                        Label("Reached", systemImage: "checkmark").font(.headline).foregroundStyle(Brand.good)
                    } else {
                        Text("\(km1(w.goalKm - w.km)) km to go").font(.headline)
                    }
                    if let says = w.goalSays { Text(says.prefix(1).uppercased() + says.dropFirst()).font(.subheadline).foregroundStyle(.secondary) }
                    if w.planSessions > 0 {
                        let extra = w.workouts - w.planDone
                        Text("\(w.planDone) of \(w.planSessions) planned sessions done\(extra > 0 ? " · \(extra) extra" : "")").font(.subheadline).foregroundStyle(.secondary)
                    } else {
                        Text(w.workouts == 1 ? "1 workout" : "\(w.workouts) workouts").font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
            }
            DayBars(days: w.days).padding(.top, 6)
        }
    }
}

private struct WeekRing: View {
    let share: Double
    let km: Double
    let reached: Bool
    @State private var shown: Double = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            Circle().stroke(Brand.well, lineWidth: 10)
            Circle()
                .trim(from: 0, to: shown)
                .stroke(reached ? Brand.good : Brand.tint, style: StrokeStyle(lineWidth: 10, lineCap: .round))
                .rotationEffect(.degrees(-90))
            VStack(spacing: 0) {
                Text(km1(km)).font(.figure(.title)).contentTransition(.numericText())
                Text("km").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            }
        }
        .frame(width: 124, height: 124)
        .onAppear { fill() }
        .onChange(of: share) { fill() }
    }

    private func fill() {
        if reduceMotion { shown = share } else { withAnimation(.easeOut(duration: 1.1).delay(0.15)) { shown = share } }
    }
}

/// Distance a day, Monday to Sunday: today's bar in the tint, the days to come empty.
private struct DayBars: View {
    let days: [Day]
    @State private var up = false

    var body: some View {
        let most = max(1, days.map(\.km).max() ?? 0)
        let iso = isoDay(Date())
        HStack(alignment: .bottom, spacing: 8) {
            ForEach(Array(days.enumerated()), id: \.offset) { i, d in
                let share = d.km > 0 ? max(0.1, d.km / most) : 0
                VStack(spacing: 4) {
                    GeometryReader { g in
                        ZStack(alignment: .bottom) {
                            RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Brand.well)
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .fill(d.date == iso ? Brand.tint : d.future ? Color.clear : Brand.tint.opacity(0.55))
                                .frame(height: g.size.height * (up ? share : 0))
                        }
                    }
                    .animation(.spring(response: 0.5, dampingFraction: 0.75).delay(0.2 + Double(i) * 0.045), value: up)
                    Text(String(dayName(d.date).prefix(2)))
                        .font(.caption2.weight(d.date == iso ? .bold : .medium))
                        .foregroundStyle(d.date == iso ? Brand.tint : Color.secondary)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(dayName(d.date)): \(km1(d.km)) km")
            }
        }
        .frame(height: 84)
        .onAppear { up = true }
    }
}

// MARK: - More today

/// The fold under Today's top: More today, what's in it, and a chevron that turns.
struct MoreToday: View {
    let open: Bool
    let inside: String
    let toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(open ? "Less" : "More today").font(.headline)
                    if !open && !inside.isEmpty { Text(inside).font(.footnote).foregroundStyle(.secondary).lineLimit(2).multilineTextAlignment(.leading) }
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.down")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .rotationEffect(.degrees(open ? 180 : 0))
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 14)
            .background(Brand.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        }
        .buttonStyle(Press())
        .foregroundStyle(Color.primary)
        .accessibilityValue(open ? "Open" : "Folded")
    }
}

/// Behind the verdict: fitness, fatigue and form, the watch's vitals, what they mean, the way to Body.
struct NumbersCard: View {
    let r: Readiness
    let vitals: Vitals?
    let openBody: () -> Void
    @State private var explain = false

    var body: some View {
        Card {
            if r.state != "new" {
                HStack(spacing: 8) {
                    Stat(label: "Fitness", value: "\(Int(r.fitness.rounded()))", key: Brand.fitness)
                    Stat(label: "Fatigue", value: "\(Int(r.fatigue.rounded()))", key: Brand.fatigue)
                    Stat(label: "Form", value: "\(r.form.rounded() > 0 ? "+" : "")\(Int(r.form.rounded()))", key: nil)
                }
            }
            if let v = vitals, v.any { VitalsRow(v: v, open: openBody) }
            if r.state != "new" {
                Button(explain ? "Hide what the numbers mean" : "What do these numbers mean?") {
                    withAnimation(.smooth) { explain.toggle() }
                }
                .font(.subheadline.weight(.semibold))
                if explain {
                    VStack(alignment: .leading, spacing: 8) {
                        meaning("Fitness \(Int(r.fitness.rounded()))", "Your average daily training effort over the last 6 weeks (effort comes from how long and how hard, by heart rate). It grows slowly when you train consistently.")
                        meaning("Fatigue \(Int(r.fatigue.rounded()))", "The same average over just the last 7 days. It jumps after hard days and drops after a few easy ones.")
                        meaning("Form \(r.form.rounded() > 0 ? "+" : "")\(Int(r.form.rounded()))", "Fitness minus fatigue. Below −10 you're carrying tiredness from training, which is normal while building. Above +5 you're fresh. Below −30, rest.")
                    }
                    .transition(.opacity)
                }
            }
            Button(action: openBody) {
                HStack(spacing: 12) {
                    Badge(symbol: "figure.stand", size: 36)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Your body").font(.subheadline.weight(.semibold))
                        Text("Muscles, sleep and vitals").font(.footnote).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                    chevron()
                }
                .padding(12)
                .background(Brand.well, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .contentShape(Rectangle())
            }
            .buttonStyle(Press())
            .foregroundStyle(Color.primary)
        }
    }

    private func meaning(_ k: String, _ v: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(k).font(.subheadline.weight(.semibold))
            Text(v).font(.subheadline).foregroundStyle(.secondary)
        }
    }
}

/// A figure with what it is; the series keeps its hue on a small key, never on the number.
private struct Stat: View {
    let label: String
    let value: String
    let key: Color?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                if let key { Circle().fill(key).frame(width: 8, height: 8) }
                Text(label).font(.caption.weight(.medium)).foregroundStyle(.secondary)
            }
            Text(value).font(.figure(.title))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Brand.well, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

/// This morning's body from the watch: resting heart rate against your usual, last night, oxygen. A tap opens Body.
private struct VitalsRow: View {
    let v: Vitals
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: 8) {
                if let rest = v.rest {
                    let d = v.restDiff
                    item("heart", "\(rest)", d.map { abs($0) >= 3 ? "\($0 > 0 ? "+" : "−")\(abs($0)) resting" : "resting" } ?? "resting", warn: (d ?? 0) >= 7)
                }
                if let s = v.sleepMin { item("moon", duration(s), "last night") }
                if let o = v.oxygen { item("drop", "\(Int(o.rounded()))%", "oxygen") }
                chevron()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(Brand.well, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(Press())
        .foregroundStyle(Color.primary)
        .accessibilityLabel("Your body")
    }

    private func item(_ symbol: String, _ value: String, _ label: String, warn: Bool = false) -> some View {
        HStack(spacing: 6) {
            Image(systemName: symbol).font(.footnote).foregroundStyle(warn ? Brand.watch : Color.secondary)
            VStack(alignment: .leading, spacing: 0) {
                Text(value).font(.figure(.headline)).foregroundStyle(warn ? Brand.watch : Color.primary)
                Text(label).font(.caption2).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - The last workout

struct LastCard: View {
    let last: Last
    let shell: ShellModel

    var body: some View {
        Card(action: { shell.openActivity(last.id) }, label: "Open \(last.name)") {
            HStack {
                CardTitle(text: last.justIn ? "Just in" : "Last workout")
                Spacer(minLength: 8)
                Button("All activities") { shell.go("activities") }.font(.subheadline.weight(.semibold))
            }
            HStack(spacing: 14) {
                Badge(symbol: sportSymbol(last.sport), size: 44)
                VStack(alignment: .leading, spacing: 2) {
                    Text(last.name).font(.headline).lineLimit(1)
                    Text(whenText(last.start)).font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                if !last.label.isEmpty {
                    Text("\(last.label) effort")
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(Brand.container, in: Capsule())
                        .foregroundStyle(Brand.onContainer)
                }
            }
            HStack(spacing: 8) {
                if let km = last.km { Figure(value: km1(km), unit: "km") }
                if let m = last.minutes { Figure(value: clockMin(m), unit: "time") }
                if let p = last.pace { Figure(value: p, unit: "/km") }
                if let hr = last.hr { Figure(value: "\(hr)", unit: "bpm") }
            }
            if !last.trivial {
                let rank = [last.rank.map { $0.prefix(1).uppercased() + $0.dropFirst() }, last.estimated ? "estimated without heart rate" : nil].compactMap { $0 }.joined(separator: " · ")
                if last.effort > 0 && !rank.isEmpty { Text(rank).font(.subheadline).foregroundStyle(.secondary) }
                if let f = last.feeling { Feeling(f: f) }
                EasyBar(zones: last.zones, cap: last.easyCap)
            }
        }
    }
}

/// No workouts yet: where they come from.
struct NoWorkoutsCard: View {
    let open: () -> Void
    var body: some View {
        Card(action: open, label: "Open Sources") {
            CardTitle(text: "Last workout")
            Text("No workouts yet. Connect Strava or your watch in Settings.").font(.subheadline).foregroundStyle(.secondary)
        }
    }
}

func sportSymbol(_ sport: String) -> String {
    let s = sport.lowercased()
    if s.contains("run") { return "figure.run" }
    if s.contains("ride") || s.contains("cycl") || s.contains("bike") { return "figure.outdoor.cycle" }
    if s.contains("swim") { return "figure.pool.swim" }
    if s.contains("walk") || s.contains("hike") { return "figure.walk" }
    if s.contains("weight") || s.contains("strength") || s.contains("gym") { return "dumbbell.fill" }
    if s.contains("ski") { return "figure.skiing.crosscountry" }
    return "figure.mixed.cardio"
}

private struct Figure: View {
    let value: String
    let unit: String
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(value).font(.figure(.title2)).lineLimit(1).minimumScaleFactor(0.7)
            Text(unit).font(.caption.weight(.medium)).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// "Felt good" with five pips, from the watch.
private struct Feeling: View {
    let f: Int
    var body: some View {
        HStack(spacing: 10) {
            HStack(spacing: 4) {
                ForEach(1...5, id: \.self) { k in Circle().fill(k <= f ? Brand.good : Brand.well).frame(width: 10, height: 10) }
            }
            Text("Felt \((FEELING[f] ?? "").lowercased())").font(.subheadline.weight(.semibold))
            Text("on your watch").font(.footnote).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}

/// The workout's heart-rate zones as one bar, with how much was easy.
private struct EasyBar: View {
    let zones: [Double]
    let cap: Int?

    var body: some View {
        let total = zones.reduce(0, +)
        if total > 0 && zones.count >= 2 {
            let easy = Int(((zones[0] + zones[1]) / total * 100).rounded())
            Text(cap.map { "Heart rate: \(easy)% easy (below \($0) bpm), \(100 - easy)% above" } ?? "Heart rate: \(easy)% easy (zones 1–2), \(100 - easy)% above")
                .font(.subheadline).foregroundStyle(.secondary)
            GeometryReader { g in
                HStack(spacing: 2) {
                    ForEach(Array(zones.enumerated()), id: \.offset) { i, s in
                        if s > 0 {
                            Rectangle().fill(Brand.zones[min(i, 4)]).frame(width: max(2, (g.size.width - 8) * s / total))
                        }
                    }
                }
                .clipShape(Capsule())
            }
            .frame(height: 10)
            .accessibilityHidden(true)
        }
    }
}

// MARK: - Worth knowing, bests, notes

/// What's worth knowing: up to four, one grouped card with a line between.
struct Takeaways: View {
    let list: [Takeaway]
    let open: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            CardTitle(text: "Worth knowing").padding(.leading, 4).padding(.top, 8)
            VStack(spacing: 0) {
                ForEach(Array(list.prefix(4).enumerated()), id: \.offset) { i, t in
                    if i > 0 { Divider().padding(.leading, 64) }
                    row(t)
                }
            }
            .background(Brand.card, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
        }
    }

    @ViewBuilder private func row(_ t: Takeaway) -> some View {
        let content = HStack(alignment: .top, spacing: 14) {
            Image(systemName: symbol(t.tone))
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(ink(t.tone))
                .frame(width: 34, height: 34)
                .background(fill(t.tone), in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text(t.title).font(.subheadline.weight(.semibold))
                Text(t.detail).font(.subheadline).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            if t.activity != nil { chevron().padding(.top, 8) }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        if let id = t.activity {
            Button { open(id) } label: { content }.buttonStyle(Press()).foregroundStyle(Color.primary)
        } else {
            content.accessibilityElement(children: .combine)
        }
    }

    private func symbol(_ tone: String) -> String { tone == "good" ? "checkmark" : tone == "watch" ? "sparkles" : "arrow.up" }
    private func ink(_ tone: String) -> Color { tone == "good" ? Brand.good : tone == "watch" ? Brand.watch : Brand.onContainer }
    private func fill(_ tone: String) -> Color { tone == "good" ? Brand.goodContainer : tone == "watch" ? Brand.watchContainer : Brand.container }
}

/// New personal bests, at the top of Today for a few days: the best of them big, the others as
/// chips, a tap opens the run, ✕ puts them away (they stay under what's worth knowing).
struct Celebration: View {
    let bests: [Takeaway]
    let open: (String) -> Void
    let dismiss: () -> Void
    @State private var pop = false

    var body: some View {
        let lead = bests[0]
        Card(action: lead.activity.map { id -> () -> Void in { open(id) } }, label: "Open the run", fill: Brand.goodContainer) {
            HStack(alignment: .top, spacing: 14) {
                Image(systemName: "sparkles")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(Brand.goodContainer)
                    .frame(width: 44, height: 44)
                    .background(Brand.good, in: Circle())
                    .symbolEffect(.bounce, value: pop)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(lead.title).font(.title3.weight(.bold)).foregroundStyle(Brand.good)
                    Text(lead.detail).font(.subheadline)
                    if bests.count > 1 {
                        Flow(spacing: 6) {
                            ForEach(bests.dropFirst()) { b in
                                Text(chip(b))
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(Brand.good)
                                    .padding(.horizontal, 10).padding(.vertical, 6)
                                    .background(Brand.card.opacity(0.7), in: Capsule())
                            }
                        }
                        .padding(.top, 4)
                    }
                }
                Spacer(minLength: 0)
                Button(action: dismiss) {
                    Image(systemName: "xmark").font(.footnote.weight(.bold)).foregroundStyle(.secondary).frame(width: 30, height: 30)
                }
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
                .accessibilityLabel("Dismiss")
            }
        }
        .onAppear { pop = true }
        .sensoryFeedback(.success, trigger: pop)
    }

    /** "New best 5 km: 24:10" → "5 km 24:10". */
    private func chip(_ b: Takeaway) -> String {
        guard let colon = b.title.range(of: ": ") else { return b.title }
        let head = b.title[..<colon.lowerBound].replacingOccurrences(of: "New best ", with: "").trimmingCharacters(in: .whitespaces)
        return "\(head) \(b.title[colon.upperBound...])"
    }
}

/// A note on Today that goes once dismissed (shoes found on Strava, which shoes, pairing a PC).
struct NoteCard: View {
    let icon: String
    let title: String
    let text: String
    let go: String
    let quiet: String
    let onGo: () -> Void
    let onQuiet: () -> Void
    var close: (() -> Void)?

    var body: some View {
        Card {
            HStack(alignment: .top, spacing: 14) {
                Image(systemName: icon)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Brand.onContainer)
                    .frame(width: 40, height: 40)
                    .background(Brand.container, in: Circle())
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 6) {
                    Text(title).font(.headline)
                    Text(text).font(.subheadline).foregroundStyle(.secondary)
                    HStack(spacing: 8) {
                        Button(go, action: onGo).buttonStyle(.glassProminent)
                        Button(quiet, action: onQuiet).buttonStyle(.glass)
                    }
                    .font(.subheadline.weight(.semibold))
                    .padding(.top, 4)
                }
                Spacer(minLength: 0)
                if let close {
                    Button(action: close) { Image(systemName: "xmark").font(.footnote.weight(.bold)).foregroundStyle(.secondary) }
                        .accessibilityLabel("Dismiss")
                }
            }
        }
    }
}

/// Small buttons in a row that wrap to the next line when they don't fit (the session's choices).
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(proposal.width ?? .infinity, subviews)
        let width = rows.map { r in r.map(\.width).reduce(0, +) + spacing * CGFloat(max(0, r.count - 1)) }.max() ?? 0
        let height = rows.map { r in r.map(\.height).max() ?? 0 }.reduce(0, +) + spacing * CGFloat(max(0, rows.count - 1))
        return CGSize(width: min(width, proposal.width ?? width), height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        var i = 0
        for row in arrange(bounds.width, subviews) {
            var x = bounds.minX
            let h = row.map(\.height).max() ?? 0
            for size in row {
                subviews[i].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + spacing
                i += 1
            }
            y += h + spacing
        }
    }

    private func arrange(_ width: CGFloat, _ subviews: Subviews) -> [[CGSize]] {
        var rows: [[CGSize]] = [[]]
        var x: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > 0 && x + s.width > width {
                rows.append([])
                x = 0
            }
            rows[rows.count - 1].append(s)
            x += s.width + spacing
        }
        return rows
    }
}
