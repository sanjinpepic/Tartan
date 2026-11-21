import SwiftUI

/// A planned session (Android's SessionSheet.kt; web/views/plan.ts openSession): what, how much,
/// the target, the blocks of a structured run, the coach's notes, a strength routine, how it went
/// against the plan once done, and Mark done, Log the sets, Ask your coach, a .fit file.
struct SessionSheetView: View {
    let m: SessionModel
    let shell: ShellModel
    @Environment(\.dismiss) private var dismiss
    @State private var exercise: Routine.Exercise?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if m.missing {
                        ContentUnavailableView("This session isn't on the plan any more.", systemImage: "calendar.badge.exclamationmark")
                    } else if let s = m.session {
                        content(s)
                    } else {
                        ProgressView().controlSize(.large).frame(maxWidth: .infinity, minHeight: 260)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 32)
            }
            .background(Brand.ground)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }.accessibilityLabel("Close")
                }
            }
            .sheet(item: $exercise) { e in ExerciseDetail(e: e, engine: shell.engine) }
        }
        .task { await m.load() }
        .onChange(of: m.done) {
            if let said = m.done {
                shell.say(said)
                shell.today.stale = true
                dismiss()
            }
        }
    }

    @ViewBuilder private func content(_ s: PlanSession) -> some View {
        HStack(spacing: 12) {
            Circle().fill(kindColour(s.kind)).frame(width: 14, height: 14).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(s.title).font(.title2.weight(.bold)).accessibilityAddTraits(.isHeader)
                Text([s.whenText, kindWord(s.kind, s.title)].compactMap { $0 }.joined(separator: " · ")).font(.subheadline).foregroundStyle(.secondary)
            }
        }
        .padding(.top, 8)
        let stats = [s.minutes.map { ("Time", duration($0)) }, s.km.map { ("Distance", "\(kmText($0)) km") }].compactMap { $0 }
        if !stats.isEmpty {
            HStack(spacing: 6) {
                ForEach(Array(stats.enumerated()), id: \.offset) { _, kv in Tile(label: kv.0, value: kv.1) }
            }
        }
        if let t = s.target {
            HStack(spacing: 12) {
                Text("Target").font(.subheadline.weight(.medium)).foregroundStyle(.secondary).frame(width: 60, alignment: .leading)
                Text(tidyTarget(t, kind: s.kind)).font(.headline)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16).padding(.vertical, 12)
            .background(kindColour(s.kind).opacity(0.14), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
        if let a = s.adjusted {
            HStack {
                Label("\(abs(a.shiftS)) s/km \(a.shiftS < 0 ? "faster" : "easier") than planned: \(a.reason.components(separatedBy: ":").first?.lowercased() ?? "").", systemImage: "sparkles")
                    .font(.subheadline)
                Spacer(minLength: 8)
                Button("Undo") { Task { if let e = await m.undoAdjust() { shell.say(e) } } }.font(.subheadline.weight(.semibold)).disabled(m.busy)
            }
        }
        if !s.steps.isEmpty {
            VStack(spacing: 0) {
                ForEach(Array(s.steps.enumerated()), id: \.offset) { i, step in
                    if i > 0 { Divider().padding(.leading, 44) }
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("\(i + 1)").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary).frame(width: 22)
                        if step.repeats > 1 { Text("\(step.repeats) ×").font(.headline).foregroundStyle(kindColour(s.kind)) }
                        Text(step.text).font(.body)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 14).padding(.vertical, 12)
                }
            }
            .background(Brand.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        }
        if let n = s.notes { Text(n).font(.body) }
        if s.strength { strength() }
        if let did = s.did, let id = s.activityId {
            Button {
                shell.openActivity(id)
            } label: {
                HStack {
                    Image(systemName: "checkmark").foregroundStyle(Brand.good)
                    Text(did).font(.headline)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                }
                .padding(.horizontal, 16).padding(.vertical, 14)
                .background(Brand.goodContainer, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            }
            .buttonStyle(Press())
            .foregroundStyle(Color.primary)
        }
        if s.manual {
            HStack {
                Label("Marked done by you", systemImage: "checkmark").font(.subheadline).foregroundStyle(Brand.good)
                Spacer(minLength: 8)
                Button("Undo") { Task { if let e = await m.mark(false) { shell.say(e) } } }.font(.subheadline.weight(.semibold)).disabled(m.busy)
            }
        }
        if let r = m.review { ReviewCard(r: r) }
        actions(s)
    }

    @ViewBuilder private func actions(_ s: PlanSession) -> some View {
        Flow(spacing: 8) {
            if s.liftable {
                Button {
                    dismiss()
                    shell.go("lift/\(s.date)")
                } label: {
                    Label(liftWord(s), systemImage: s.lift?.finished == true ? "checkmark" : "dumbbell.fill")
                }
                .buttonStyle(.glassProminent)
            }
            if s.canMark {
                if s.liftable {
                    Button("Mark done without logging") { Task { if let e = await m.mark(true) { shell.say(e) } } }.buttonStyle(.glass).disabled(m.busy)
                } else {
                    Button { Task { if let e = await m.mark(true) { shell.say(e) } } } label: { Label("Mark done", systemImage: "checkmark") }
                        .buttonStyle(.glassProminent).disabled(m.busy)
                }
            }
            Button {
                dismiss()
                var extra: [String: Any] = ["prefill": "About \(dayName(s.date)) \(dateShort(s.date)), \(s.title): "]
                if let c = s.conversation { extra["conversation"] = c }
                shell.goAction("chat", extra: extra)
            } label: { Label("Ask your coach", systemImage: "bubble.left.and.text.bubble.right") }
                .buttonStyle(.glass)
            if s.status != "done" && s.kind != "rest" && s.date >= s.today {
                Button { Task { shell.say(await m.saveFit()) } } label: { Label("Save as a .fit workout", systemImage: "square.and.arrow.up") }
                    .buttonStyle(.glass).disabled(m.busy)
            }
        }
        .padding(.top, 4)
    }

    private func liftWord(_ s: PlanSession) -> String {
        guard let l = s.lift else { return "Log the sets" }
        if !l.finished { return "Log the sets" }
        return l.records > 0 ? "Logged · \(l.records) record\(l.records == 1 ? "" : "s")" : "Logged"
    }

    @ViewBuilder private func strength() -> some View {
        Card {
            Text("What it works").font(.title3.weight(.bold))
            if let r = m.routine {
                let names = (r.primary + r.secondary).map { r.names[$0] ?? $0 }
                if !names.isEmpty {
                    Text(names.joined(separator: ", ")).font(.subheadline).foregroundStyle(.secondary)
                }
                Text("\(r.items.count) exercises").font(.headline).padding(.top, 4)
                VStack(spacing: 0) {
                    ForEach(Array(r.items.enumerated()), id: \.offset) { i, e in
                        if i > 0 { Divider() }
                        Button { exercise = e } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(e.name).font(.subheadline.weight(.semibold))
                                    Text(e.dose).font(.subheadline).foregroundStyle(.secondary)
                                }
                                Spacer(minLength: 0)
                                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                            }
                            .padding(.vertical, 10)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(Press())
                        .foregroundStyle(Color.primary)
                    }
                }
                if r.basic {
                    Text("A runner's basic routine for this length of session. Ask your coach to change it.").font(.footnote).foregroundStyle(.secondary)
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, minHeight: 80)
            }
        }
    }
}

/// How a done session went against its plan.
private struct ReviewCard: View {
    let r: Review
    var body: some View {
        Card {
            Text("Against the plan").font(.title3.weight(.bold))
            if let e = r.error {
                Text("Can't compare this one: \(e).").font(.subheadline).foregroundStyle(.secondary)
            } else {
                Text("\(r.summary)\(r.inRange.map { " \(Int(($0 * 100).rounded()))% of the time in range." } ?? "")").font(.body)
                ForEach(Array(r.steps.enumerated()), id: \.offset) { _, st in
                    HStack(alignment: .center, spacing: 8) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(st.label).font(.subheadline.weight(.semibold))
                            if !st.sub.isEmpty { Text(st.sub).font(.caption).foregroundStyle(.secondary) }
                        }
                        Spacer(minLength: 4)
                        Text(st.actual.isEmpty ? "–" : st.actual).font(.subheadline)
                        Text("\(Text(Words.verdict[st.verdict] ?? st.verdict).fontWeight(.semibold))\(st.off.isEmpty ? "" : " \(st.off)")")
                            .font(.caption)
                            .foregroundStyle(tone(st.verdict))
                            .padding(.horizontal, 10).padding(.vertical, 4)
                            .background(tone(st.verdict).opacity(0.12), in: Capsule())
                    }
                }
            }
        }
    }

    private func tone(_ v: String) -> Color {
        switch v {
        case "on target", "done": return Brand.good
        case "no data": return Color.secondary
        default: return Brand.watch
        }
    }
}

/// A figure in a tile: what it is, then the number.
struct Tile: View {
    let label: String
    let value: String
    var unit: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption.weight(.medium)).foregroundStyle(.secondary)
            HStack(alignment: .firstTextBaseline, spacing: 3) {
                Text(value).font(.figure(.title2)).lineLimit(1).minimumScaleFactor(0.7)
                if !unit.isEmpty { Text(unit).font(.caption.weight(.medium)).foregroundStyle(.secondary) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14).padding(.vertical, 12)
        .background(Brand.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

/// Each kind of session's colour (Android's kindColour): easy green, long blue, tempo and hills
/// clay, intervals and races the deepest, the rest quiet.
func kindColour(_ kind: String) -> Color {
    switch kind {
    case "easy", "recovery": return Brand.good
    case "long": return Brand.fitness
    case "tempo", "hills": return Brand.adaptive(0xD8653B, 0xD8653B)
    case "intervals", "race": return Brand.adaptive(0x5E1D10, 0xF7BC95)
    case "strength": return Brand.tint
    // Swims and rides support the running: quiet, like cross-training.
    case "swim", "ride", "cross": return Brand.adaptive(0x9A8B88, 0x8F8280)
    default: return Brand.adaptive(0x9A8B88, 0x8F8280)
    }
}
