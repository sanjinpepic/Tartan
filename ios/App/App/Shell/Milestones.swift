import SwiftUI
import UIKit
import Observation

/// Milestones (src/milestones.ts): earned moments, never gamified pressure. One quiet card on Today
/// for a new one, a line on the workout that earned it, a picture to share. And Your season
/// (src/season.ts), from Progress: this year or this plan, briefly, with a tall picture to share.
/// Android's Milestones.kt and ShareCard.kt are the reference.

struct Moment: Identifiable, Equatable {
    let id: String
    let kind: String
    let date: String
    let activity: String?
    let title: String
    let note: String
    let figure: String?
    let figureLabel: String?
}

func parseMoments(_ a: [J]) -> [Moment] {
    a.map { Moment(id: $0["id"].text, kind: $0["kind"].text, date: $0["date"].text, activity: $0["activity"].str, title: $0["title"].text, note: $0["note"].text, figure: $0["figure"].str, figureLabel: $0["figure_label"].str) }
}

func momentSymbol(_ kind: String) -> String {
    switch kind {
    case "best": return "sparkles"
    case "race": return "flag.checkered"
    case "longest", "first": return "point.topleft.down.to.point.bottomright.curvepath"
    case "week", "month": return "chart.bar.fill"
    case "steady": return "checkmark"
    case "swim": return "figure.pool.swim"
    case "ride": return "figure.outdoor.cycle"
    default: return "sparkles"
    }
}

/// The share pictures' colour: Tartan's red, deepening down the card (the same in light and dark).
let shareTop = Color(red: 0xA8 / 255, green: 0x32 / 255, blue: 0x1F / 255)
let shareBottom = Color(red: 0x5C / 255, green: 0x1B / 255, blue: 0x11 / 255)

private func longDay(_ iso: String) -> String {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd"
    f.timeZone = TimeZone(identifier: "UTC")
    guard let d = f.date(from: String(iso.prefix(10))) else { return iso }
    return d.formatted(.dateTime.day().month(.wide).year())
}

private func shortDay(_ iso: String) -> String {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd"
    f.timeZone = TimeZone(identifier: "UTC")
    guard let d = f.date(from: String(iso.prefix(10))) else { return iso }
    return d.formatted(.dateTime.day().month(.abbreviated))
}

/// A view drawn to a picture (3×: 360 points wide is 1080 pixels).
@MainActor
func renderPicture<V: View>(_ v: V) -> UIImage? {
    let r = ImageRenderer(content: v.environment(\.colorScheme, .light))
    r.scale = 3
    return r.uiImage
}

// MARK: - Milestone: Today's card, the workout's lines, the picture

/// A milestone as a picture: 1080 × 1350, its number big, the title, the coach's line, the day.
struct MomentPicture: View {
    let m: Moment

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                Image(systemName: "sparkle").font(.system(size: 30, weight: .bold))
                Text(longDay(m.date)).font(.system(size: 15, weight: .semibold, design: .rounded)).opacity(0.85)
            }
            .padding(.bottom, 30)
            if let f = m.figure {
                Text(f)
                    .font(.system(size: f.count > 6 ? 84 : 110, weight: .bold, design: .rounded).monospacedDigit())
                    .minimumScaleFactor(0.5)
                    .lineLimit(1)
                Text((m.figureLabel ?? "").uppercased())
                    .font(.system(size: 13, weight: .bold, design: .rounded)).tracking(1.2).opacity(0.85)
                    .padding(.bottom, 34)
            }
            Text(m.title).font(.system(size: 24, weight: .bold, design: .rounded)).lineLimit(3)
                .padding(.bottom, 10)
            Text(m.note).font(.system(size: 14.5, weight: .regular, design: .rounded)).lineLimit(4).opacity(0.92)
            Spacer(minLength: 0)
            Text("Tartan").font(.system(size: 14, weight: .bold, design: .rounded)).opacity(0.8)
        }
        .foregroundStyle(.white)
        .padding(EdgeInsets(top: 34, leading: 26, bottom: 24, trailing: 26))
        .frame(width: 360, height: 450, alignment: .topLeading)
        .background(LinearGradient(colors: [shareTop, shareBottom], startPoint: .top, endPoint: .bottom))
    }
}

/// Share a milestone: its picture, drawn when the button shows.
struct ShareMoment: View {
    let m: Moment
    var compact = false
    @State private var picture: UIImage?

    var body: some View {
        Group {
            if let p = picture {
                let image = Image(uiImage: p)
                ShareLink(item: image, preview: SharePreview(m.title, image: image)) {
                    if compact {
                        Image(systemName: "square.and.arrow.up").font(.subheadline.weight(.semibold))
                    } else {
                        Label("Share", systemImage: "square.and.arrow.up").font(.subheadline.weight(.semibold))
                    }
                }
                .accessibilityLabel("Share as a picture")
            } else {
                Color.clear.frame(width: 1, height: 1)
            }
        }
        .foregroundStyle(Brand.good)
        .task(id: m.id) { picture = renderPicture(MomentPicture(m: m)) }
    }
}

/// A new milestone on Today, quietly: the title, the coach's line, Share and put away. The spark
/// bounces in once (not with Reduce Motion); a tap opens the workout that earned it.
struct MilestoneCard: View {
    let m: Moment
    let open: (String) -> Void
    let dismiss: () -> Void
    @Environment(\.accessibilityReduceMotion) private var still
    @State private var pop = false

    var body: some View {
        Card(action: m.activity.map { id -> () -> Void in { open(id) } }, label: "Open the workout", fill: Brand.goodContainer) {
            HStack(alignment: .top, spacing: 14) {
                Image(systemName: momentSymbol(m.kind))
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(Brand.goodContainer)
                    .frame(width: 44, height: 44)
                    .background(Brand.good, in: Circle())
                    .symbolEffect(.bounce, value: pop)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(m.title).font(.title3.weight(.bold)).foregroundStyle(Brand.good)
                    Text(m.note).font(.subheadline)
                    ShareMoment(m: m).padding(.top, 6)
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
        .onAppear { if !still { pop = true } }
    }
}

/// On the workout that earned them: each milestone in a line, with a picture to share.
struct MilestoneLines: View {
    let list: [Moment]

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(list.enumerated()), id: \.element.id) { i, m in
                if i > 0 { Divider().padding(.leading, 50) }
                row(m)
            }
        }
        .padding(.vertical, 4)
        .background(Brand.goodContainer, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    private func row(_ m: Moment) -> some View {
        HStack(spacing: 12) {
            Image(systemName: momentSymbol(m.kind)).font(.body.weight(.semibold)).foregroundStyle(Brand.good).frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(m.title).font(.subheadline.weight(.semibold)).foregroundStyle(Brand.good)
                Text(m.note).font(.footnote)
            }
            Spacer(minLength: 0)
            ShareMoment(m: m, compact: true).frame(width: 36, height: 36)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
    }
}

// MARK: - Your season

struct SeasonBest: Identifiable { let id: String; let label: String; let timeS: Int; let date: String; let activity: String; let pb: Bool }
struct SeasonRace: Identifiable { let id: String; let date: String; let name: String; let km: Double; let timeS: Int }
struct SeasonWeek: Identifiable { let id: String; let km: Double; let met: Bool? }

/// GET /api/season (src/season.ts).
struct Season {
    let range: String
    let label: String
    let from: String
    let empty: Bool
    let km: Double
    let minutes: Double
    let runs: Int
    let climbM: Int
    let biggestWeek: (week: String, km: Double)?
    let longest: (id: String, date: String, km: Double)?
    let bests: [SeasonBest]
    let races: [SeasonRace]
    let weeks: [SeasonWeek]
    let weeksMet: Int
    let weeksWithTarget: Int
    let crossLine: String?
    let closing: String
    let hasPlan: Bool
}

func parseSeason(_ json: String) -> Season? {
    let o = J(json: json)
    guard o.object != nil else { return nil }
    let r = o["run"]
    let bw = o["biggest_week"]
    let lo = o["longest"]
    let bests = o["bests"].array.map { SeasonBest(id: $0["name"].text, label: $0["label"].text, timeS: $0["time_s"].int ?? 0, date: $0["date"].text, activity: $0["activity"].text, pb: $0["pb"].bool) }
    let races = o["races"].array.map { SeasonRace(id: $0["id"].text, date: $0["date"].text, name: $0["name"].text, km: $0["km"].num ?? 0, timeS: $0["time_s"].int ?? 0) }
    let week: (week: String, km: Double)? = bw.isNull ? nil : (week: bw["week"].text, km: bw["km"].num ?? 0)
    let long: (id: String, date: String, km: Double)? = lo.isNull ? nil : (id: lo["id"].text, date: lo["date"].text, km: lo["km"].num ?? 0)
    let weeks = o["weeks"].array.map { w in SeasonWeek(id: w["week"].text, km: w["km"].num ?? 0, met: w["met"].isNull ? nil : w["met"].bool) }
    return Season(
        range: o["range"].text, label: o["label"].text, from: o["from"].text, empty: o["empty"].bool,
        km: r["km"].num ?? 0, minutes: r["minutes"].num ?? 0, runs: r["runs"].int ?? 0, climbM: r["climb_m"].int ?? 0,
        biggestWeek: week,
        longest: long,
        bests: bests, races: races, weeks: weeks, weeksMet: o["weeks_met"].int ?? 0, weeksWithTarget: o["weeks_with_target"].int ?? 0,
        crossLine: o["cross"]["line"].str, closing: o["closing"].text, hasPlan: o["has_plan"].bool
    )
}

/// Your season's data, by range (year, plan), read once per range while the sheet is open.
@MainActor
@Observable
final class SeasonModel {
    private let engine: EngineBridge
    var seasons: [String: Season] = [:]
    var failed = false

    init(engine: EngineBridge) { self.engine = engine }

    func load(_ range: String) async {
        if seasons[range] != nil { return }
        failed = false
        if let j = await engine.get("/api/season?range=\(range)&coach=1"), let s = parseSeason(j) {
            seasons[range] = s
            Launch.ready("season")
        } else {
            failed = true
        }
    }
}

private func n1(_ x: Double) -> String { String(format: "%.1f", x) }
private func hoursText(_ min: Double) -> String { min >= 600 ? String(format: "%.0f", min / 60) : String(format: "%.1f", min / 60) }

/// From Progress: Your season, a row that opens it.
struct SeasonRow: View {
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: 14) {
                Image(systemName: "sparkles").font(.title3).foregroundStyle(Brand.onContainer).frame(width: 44, height: 44)
                    .background(Brand.container, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text("Your season").font(.headline)
                    Text("This year or this plan, briefly, with a picture to share").font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.leading)
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
}

/// Your season, in a sheet over Progress: This year or This plan.
struct SeasonSheet: View {
    let shell: ShellModel
    @State private var model: SeasonModel
    @State private var range = "year"
    @State private var picture: UIImage?
    /** Screenshots (Launch): the share picture shown over the sheet. */
    @State private var preview = false
    @Environment(\.dismiss) private var dismiss

    init(shell: ShellModel) {
        self.shell = shell
        _model = State(initialValue: SeasonModel(engine: shell.engine))
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    content
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 32)
                // This year or this plan: the numbers roll to the other's, the cards follow.
                .animation(Motion.settle, value: model.seasons[range]?.km)
            }
            .background(Brand.ground)
            .navigationTitle("Your season")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    if let p = picture, let s = model.seasons[range], !s.empty {
                        let image = Image(uiImage: p)
                        ShareLink(item: image, preview: SharePreview("Your season", image: image)) { Image(systemName: "square.and.arrow.up") }
                            .accessibilityLabel("Share your season as a picture")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }.accessibilityLabel("Close")
                }
            }
            .overlay {
                if preview, let p = picture {
                    ZStack {
                        Color.black.opacity(0.85).ignoresSafeArea()
                        Image(uiImage: p).resizable().scaledToFit().padding(24)
                    }
                    .onTapGesture { preview = false }
                }
            }
        }
        .task(id: range) {
            await model.load(range)
            if let s = model.seasons[range], !s.empty { picture = renderPicture(SeasonPicture(s: s)) } else { picture = nil }
            if Launch.open == "seasonshare", picture != nil {
                preview = true
                try? await Task.sleep(for: .milliseconds(600))
                Launch.ready("seasonshare")
            }
        }
    }

    @ViewBuilder private var content: some View {
        let s = model.seasons[range]
        if let s {
            Text(s.range == "plan" ? s.label : "Since \(shortDay(s.from))").font(.subheadline.weight(.medium)).foregroundStyle(.secondary).padding(.horizontal, 4)
        }
        if s?.hasPlan == true || range == "plan" {
            Picker("Season", selection: $range) {
                Text("This year").tag("year")
                Text("This plan").tag("plan")
            }
            .pickerStyle(.segmented)
        }
        if let s {
            if s.empty { emptyCard(s) } else { SeasonCards(s: s, open: { id in dismiss(); shell.openActivity(id) }) }
        } else if model.failed {
            ContentUnavailableView("Your season couldn't be read", systemImage: "exclamationmark.triangle", description: Text("Pull down on Progress, or try again in a moment."))
        } else {
            ProgressView().controlSize(.large).frame(maxWidth: .infinity, minHeight: 240)
        }
    }

    private func emptyCard(_ s: Season) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: "figure.run").font(.title2).foregroundStyle(Brand.tint)
            Text("Your season starts here").font(.title3.weight(.bold))
            Text(s.closing).font(.body).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(22)
        .background(Brand.card, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
    }
}

private struct SeasonCards: View {
    let s: Season
    let open: (String) -> Void

    var body: some View {
        hero
        HStack(spacing: 12) {
            if let w = s.biggestWeek { tile("Biggest week", n1(w.km), "Week of \(shortDay(w.week))", nil) }
            if let l = s.longest { tile("Longest run", n1(l.km), shortDay(l.date), l.id) }
        }
        .fixedSize(horizontal: false, vertical: true)
        if !s.bests.isEmpty || !s.races.isEmpty { bestsCard }
        weeksCard
        coach
    }

    private var hero: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .lastTextBaseline, spacing: 6) {
                Text(String(format: "%.0f", s.km)).font(.system(size: 64, weight: .bold, design: .rounded).monospacedDigit())
                    .contentTransition(.numericText(value: s.km))
                Text("km of running").font(.headline).opacity(0.8)
            }
            HStack(spacing: 22) {
                small("\(s.runs)", s.runs == 1 ? "run" : "runs")
                small(hoursText(s.minutes), "hours")
                if s.climbM > 0 { small(s.climbM.formatted(), "metres up") }
            }
        }
        .foregroundStyle(Brand.onContainer)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
        .background(Brand.container, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
    }

    private func small(_ value: String, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(value).font(.figure(.title2)).contentTransition(.numericText())
            Text(label).font(.caption.weight(.medium)).opacity(0.8)
        }
    }

    @ViewBuilder private func tile(_ label: String, _ value: String, _ sub: String, _ id: String?) -> some View {
        let inner = VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.subheadline.weight(.medium)).foregroundStyle(.secondary)
            HStack(alignment: .lastTextBaseline, spacing: 3) {
                Text(value).font(.figure(.title)).contentTransition(.numericText())
                Text("km").font(.subheadline).foregroundStyle(.secondary)
            }
            Text(sub).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(16)
        .background(Brand.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        if let id {
            Button { open(id) } label: { inner }.buttonStyle(Press()).foregroundStyle(Color.primary)
        } else {
            inner
        }
    }

    private var shownBests: [SeasonBest] {
        let pbs = s.bests.filter(\.pb)
        return pbs.isEmpty ? s.bests : pbs
    }

    private var bestsCard: some View {
        VStack(spacing: 0) {
            ForEach(s.races) { r in
                line("flag.checkered", r.name, clock(r.timeS), "\(n1(r.km)) km, \(shortDay(r.date))", true, r.id)
            }
            ForEach(shownBests) { b in
                line("sparkles", b.label, clock(b.timeS), b.pb ? "New best, \(shortDay(b.date))" : "Season's best, \(shortDay(b.date))", b.pb, b.activity)
            }
        }
        .padding(.vertical, 6)
        .background(Brand.card, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
    }

    private func line(_ symbol: String, _ head: String, _ value: String, _ sub: String, _ good: Bool, _ id: String) -> some View {
        Button { open(id) } label: {
            HStack(spacing: 12) {
                Image(systemName: symbol).font(.body.weight(.semibold)).foregroundStyle(good ? Brand.good : Color.secondary).frame(width: 24)
                VStack(alignment: .leading, spacing: 1) {
                    Text(head).font(.subheadline.weight(.semibold))
                    Text(sub).font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Text(value).font(.figure(.title3))
            }
            .padding(.horizontal, 18).padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(Press())
        .foregroundStyle(Color.primary)
    }

    /** The weeks in a row, filled where the target was met. Never a streak; a miss is just a week. */
    private var weeksCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(s.weeksWithTarget > 0 ? "Target met in \(s.weeksMet) of \(s.weeksWithTarget) weeks" : "Week by week").font(.headline)
            WeekBars(weeks: s.weeks, height: 64)
                .accessibilityLabel("\(s.weeks.count) weeks of running, \(s.weeksMet) on target")
            if let c = s.crossLine { Text(c).font(.subheadline).foregroundStyle(.secondary) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
        .background(Brand.card, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
    }

    private var coach: some View {
        HStack(alignment: .top, spacing: 14) {
            Capsule().fill(Brand.tint).frame(width: 3, height: 44)
            VStack(alignment: .leading, spacing: 3) {
                Text("Coach").font(.subheadline.weight(.semibold)).foregroundStyle(Brand.tint)
                Text(s.closing).font(.body)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
        .background(Brand.well, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
    }
}

/// A bar a week, as tall as its running, filled where the target was met.
struct WeekBars: View {
    let weeks: [SeasonWeek]
    let height: CGFloat
    var onPicture = false

    var body: some View {
        let most = max(1, weeks.map(\.km).max() ?? 1)
        HStack(alignment: .bottom, spacing: weeks.count > 30 ? 2 : 4) {
            ForEach(weeks) { w in
                RoundedRectangle(cornerRadius: 3, style: .continuous)
                    .fill(colour(w))
                    .frame(height: barHeight(w.km, most))
            }
        }
        .frame(height: height, alignment: .bottom)
    }

    private func barHeight(_ km: Double, _ most: Double) -> CGFloat {
        let f = km > 0 ? min(1, max(0.12, km / most)) : 0.06
        return height * CGFloat(f)
    }

    private func colour(_ w: SeasonWeek) -> Color {
        if onPicture { return w.met == true ? Color.white : (w.km > 0 ? Color.white.opacity(0.5) : Color.white.opacity(0.2)) }
        if w.met == true { return Brand.good }
        return w.km > 0 ? Brand.tint.opacity(0.4) : Brand.well
    }
}

/// Your season as a tall picture: 1080 × 1920.
struct SeasonPicture: View {
    let s: Season

    private var rows: [(String, String)] {
        var out: [(String, String)] = []
        if let w = s.biggestWeek { out.append(("Biggest week", "\(n1(w.km)) km")) }
        if let l = s.longest { out.append(("Longest run", "\(n1(l.km)) km")) }
        for r in s.races.prefix(2) { out.append((String(r.name.prefix(26)), clock(r.timeS))) }
        for b in s.bests where b.pb { out.append(("New \(b.label) best", clock(b.timeS))) }
        return Array(out.prefix(5))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("YOUR SEASON").font(.system(size: 13, weight: .bold, design: .rounded)).tracking(1.5).opacity(0.85)
            Text(s.label).font(.system(size: 22, weight: .bold, design: .rounded)).lineLimit(1).padding(.bottom, 18)
            Text(String(format: "%.0f", s.km)).font(.system(size: 104, weight: .bold, design: .rounded).monospacedDigit()).lineLimit(1).minimumScaleFactor(0.5)
            Text("KM OF RUNNING").font(.system(size: 13, weight: .bold, design: .rounded)).tracking(1.2).opacity(0.85).padding(.bottom, 18)
            HStack(alignment: .top, spacing: 0) {
                stat("\(s.runs)", s.runs == 1 ? "RUN" : "RUNS")
                stat(hoursText(s.minutes), "HOURS")
                if s.climbM > 0 { stat(s.climbM.formatted(), "METRES UP") }
            }
            .padding(.bottom, 22)
            ForEach(Array(rows.enumerated()), id: \.offset) { _, r in
                HStack {
                    Text(r.0).font(.system(size: 13.5, design: .rounded)).opacity(0.85)
                    Spacer()
                    Text(r.1).font(.system(size: 15, weight: .bold, design: .rounded).monospacedDigit())
                }
                .padding(.bottom, 9)
            }
            WeekBars(weeks: s.weeks, height: 48, onPicture: true).padding(.top, 14).padding(.bottom, 8)
            Text(s.weeksWithTarget > 0 ? "Target met in \(s.weeksMet) of \(s.weeksWithTarget) weeks" : "\(s.weeks.count) weeks")
                .font(.system(size: 12.5, design: .rounded)).opacity(0.85).padding(.bottom, 12)
            if let c = s.crossLine { Text(c).font(.system(size: 12.5, design: .rounded)).opacity(0.85).lineLimit(2).padding(.bottom, 14) }
            HStack(alignment: .top, spacing: 10) {
                Rectangle().fill(Color.white.opacity(0.8)).frame(width: 2.5)
                Text(s.closing).font(.system(size: 15, weight: .medium, design: .rounded)).lineLimit(3)
            }
            .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 18)
            Text("Tartan").font(.system(size: 14, weight: .bold, design: .rounded)).opacity(0.8)
        }
        .foregroundStyle(.white)
        .padding(EdgeInsets(top: 36, leading: 24, bottom: 24, trailing: 24))
        .frame(width: 360, height: 640, alignment: .topLeading)
        .background(LinearGradient(colors: [shareTop, shareBottom], startPoint: .top, endPoint: .bottom))
    }

    private func stat(_ value: String, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(value).font(.system(size: 34, weight: .bold, design: .rounded).monospacedDigit())
            Text(label).font(.system(size: 11, weight: .bold, design: .rounded)).tracking(0.8).opacity(0.8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
