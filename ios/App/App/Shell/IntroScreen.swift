import SwiftUI
import Observation
import UniformTypeIdentifiers

/**
 * The first run, native (Android's IntroScreen.kt, web/views/onboard.ts). Five short steps, each
 * doing something real: hello (a timing board where your watch, Strava and your coach cross the
 * line), bringing workouts in, the coach, when you train, and where things live. Skippable at
 * every step; where you are is kept by the page, so the intro comes back to it.
 */
@MainActor
@Observable
final class IntroModel: Identifiable {
    let id = UUID()
    static let last = 4
    @ObservationIgnored weak var shell: ShellModel?
    var step: Int
    /** "steps", or the welcome's other ways in: "pc" (from your PC), "backup". */
    var page = "steps"
    var forward = true
    var leaving = false
    /** The first time (the intro from its start): Tartan's mark draws itself in before the first step. */
    var brand: Bool

    init(step: Int) {
        self.step = min(max(step, 0), IntroModel.last)
        brand = step == 0
    }

    private func tell(_ step: Int) {
        guard let engine = shell?.engine else { return }
        Task { _ = await engine.rpc("introStep", ["step": step]) }
    }

    func go(_ to: Int) {
        if to > IntroModel.last { return done(reload: false) }
        forward = to > step || page != "steps"
        withAnimation(.smooth(duration: 0.35)) {
            step = max(0, to)
            page = "steps"
        }
        tell(step)
    }

    func open(_ p: String) {
        forward = true
        withAnimation(.smooth(duration: 0.35)) { page = p }
        tell(0)
    }

    func back() {
        if page != "steps" {
            forward = false
            withAnimation(.smooth(duration: 0.35)) { page = "steps" }
        } else if step > 0 { go(step - 1) }
    }

    /** Tartan with sample data, on storage of its own (Today has the way back): the page starts again in it. */
    func demo() {
        guard let shell else { return }
        Task { _ = await shell.engine.rpc("demo", ["op": "start"]) }
        leaving = true
        shell.intro = nil
    }

    /** Shown once: Today (or the whole app again, after a copy from the PC). */
    func done(reload: Bool) {
        guard !leaving, let shell else { return }
        leaving = true
        Haptics.feel("confirm")
        Task { _ = await shell.engine.rpc("introDone", ["reload": reload]) }
        shell.intro = nil
    }
}

private let PRESETS = [("Before work", "06:30"), ("Lunch", "12:00"), ("After work", "18:00"), ("Evening", "20:00")]

struct IntroScreen: View {
    let m: IntroModel
    let shell: ShellModel
    @State private var flow: String?

    var body: some View {
        ZStack {
            if m.brand {
                BrandIntro { withAnimation(.smooth(duration: 0.45)) { m.brand = false } }
                    .transition(.opacity.combined(with: .scale(scale: 1.08)))
            } else {
                steps.transition(.opacity.combined(with: .scale(scale: 0.94)))
            }
        }
        .tint(Brand.tint)
        .onAppear { shell.sources.ensure(); shell.settings.ensure() }
        .fullScreenCover(isPresented: Binding(get: { flow == "strava" }, set: { if !$0 { flow = nil } })) {
            StravaFlow(s: shell.sources) { flow = nil }
        }
        .fullScreenCover(isPresented: Binding(get: { flow == "watch" }, set: { if !$0 { flow = nil } })) {
            WatchFlow(s: shell.sources) { flow = nil }
        }
        .sheet(isPresented: Binding(get: { flow == "icu" }, set: { if !$0 { flow = nil } })) {
            IcuFlow(s: shell.sources) { flow = nil }
        }
    }

    private var steps: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                StepBar(steps: IntroModel.last + 1, step: m.page == "steps" ? m.step : 0)
                Button("Skip setup") { m.done(reload: false) }.font(.subheadline.weight(.semibold))
            }
            .padding(.leading, 20).padding(.trailing, 12).padding(.top, 8)
            ScrollView {
                VStack(alignment: .leading, spacing: 16) { page }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 16)
            }
            .scrollDismissesKeyboard(.interactively)
            .id("\(m.page)-\(m.step)")
            .transition(.asymmetric(insertion: .move(edge: m.forward ? .trailing : .leading).combined(with: .opacity), removal: .opacity))
            if m.page != "steps" || m.step > 0 {
                HStack(spacing: 12) {
                    Button { m.back() } label: { Image(systemName: "chevron.left").font(.title3.weight(.semibold)).frame(width: 52, height: 52) }
                        .buttonStyle(.glass).buttonBorderShape(.circle)
                        .accessibilityLabel("Back")
                    if m.page == "steps" {
                        let ready = shell.coachSetup.setup?.canAnswer == true
                        Primary(label: m.step == 2 ? (ready ? "Continue" : "Skip for now") : m.step == IntroModel.last ? "Start" : "Continue") { m.go(m.step + 1) }
                    } else {
                        Spacer()
                    }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
            }
        }
        .background(Brand.ground)
    }

    @ViewBuilder private var page: some View {
        if m.page == "pc" {
            FromPc(m: m, s: shell.sources)
        } else if m.page == "backup" {
            FromBackup(m: m, shell: shell)
        } else {
            switch m.step {
            case 0: Welcome(m: m)
            case 1:
                Title(title: "Bring in your workouts", lede: "Connect any of these. Strava brings your whole history; the watch gives the files it recorded; intervals.icu brings Garmin, Coros, Polar and more. A run that's in more than one shows up once.")
                sources
                Fine(text: "Files from other apps and more are in Settings → Sources, any time.")
            case 2:
                Title(title: "Add your coach", lede: "The coach reads your workouts, builds your plan, changes it when you ask and answers your questions. It runs on your own AI key from Google or Anthropic, or on Tartan's rules with no AI at all.")
                CoachSetupCard(m: shell.coachSetup, shell: shell)
            case 3: Times(settings: shell.settings)
            default: Places()
            }
        }
    }

    @ViewBuilder private var sources: some View {
        let s = shell.sources
        SourceRow(icon: .strava, title: "Strava", line: "Your whole history, every stream", done: s.strava?.connected == true,
                  doneLine: s.strava.flatMap { $0.name.isEmpty ? nil : "Connected as \($0.name)" } ?? "Connected") { flow = "strava" }
        SourceRow(icon: .symbol("watch.analog"), title: "Your watch", line: "Straight off your wrist, over Bluetooth", done: s.watch?.connected == true,
                  doneLine: s.watch.flatMap { $0.name.isEmpty ? nil : "Connected to \($0.name)" } ?? "Connected") { flow = "watch" }
        SourceRow(icon: .symbol("chart.bar.xaxis"), title: "intervals.icu", line: "Garmin, Coros, Polar, Wahoo, Zwift: a key, no app", done: s.icu?.connected == true,
                  doneLine: s.icu?.name.map { "Connected as \($0)" } ?? "Connected") { flow = "icu" }
    }
}

private struct Title: View {
    let title: String
    let lede: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.system(.largeTitle, design: .rounded).weight(.bold)).accessibilityAddTraits(.isHeader)
            Text(lede).font(.body).foregroundStyle(.secondary)
        }
    }
}

private struct Fine: View {
    let text: String
    var body: some View { Text(text).font(.footnote).foregroundStyle(.secondary) }
}

/// Tartan's mark, small: the T in the track's red.
struct TartanMark: View {
    var size: CGFloat = 28

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.32, style: .continuous).fill(Brand.tint)
            MarkShape().fill(Color(red: 0.99, green: 0.95, blue: 0.93)).padding(size * 0.16)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// The Tartan T (the launcher icon's): a crossbar, and two track lanes that bend down into the stem.
private let MARK = [
    "M167,150H720A70,70 0 0 1 790,220V298A70,70 0 0 1 720,368H615A197.7,197.7 0 0 0 425,225H92A75,75 0 0 1 167,150Z",
    "M92,247H425A167,167 0 0 1 592,414V665A77,80 0 0 1 515,745V428A145,145 0 0 0 370,283H92Z",
    "M92,303H370A119,119 0 0 1 489,422V745H373V425A53,55 0 0 0 320,370H165A73,67 0 0 1 92,303Z",
]

/// The mark (or one piece of it), fitted into its frame.
struct MarkShape: Shape {
    var piece: Int?

    func path(in rect: CGRect) -> Path {
        let mx: CGFloat = 92, my: CGFloat = 150, mw: CGFloat = 698, mh: CGFloat = 595
        let k = min(rect.width / mw, rect.height / mh)
        let ox = rect.minX + (rect.width - mw * k) / 2, oy = rect.minY + (rect.height - mh * k) / 2
        var p = Path()
        for (i, d) in MARK.enumerated() where piece == nil || piece == i { p.addPath(SVGPath.parse(d)) }
        return p.applying(CGAffineTransform(translationX: ox, y: oy).scaledBy(x: k, y: k).translatedBy(x: -mx, y: -my))
    }
}

/**
 * The first time Tartan opens: on the track's red, lanes stream past, then the three pieces of the
 * T draw themselves in, fill, settle with a little spring, a finish line sweeps across and the name
 * lands under the mark. Then it opens out into the intro. With reduced motion, the mark, still.
 */
private struct BrandIntro: View {
    let done: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduced
    @State private var trace: [CGFloat] = [0, 0, 0]
    @State private var fill: Double = 0
    @State private var settle: CGFloat = 0.9
    @State private var finish: CGFloat = 0
    @State private var name: Double = 0
    @State private var start = Date()

    private let red = Color(red: 0.66, green: 0.20, blue: 0.12)
    private let cream = Color(red: 0.99, green: 0.95, blue: 0.93)

    var body: some View {
        GeometryReader { g in
            let w = g.size.width * 0.44
            ZStack {
                red.ignoresSafeArea()
                // The straight at speed: thin lane lines running past, stiller as the mark lands.
                TimelineView(.animation) { ctx in
                    let t = ctx.date.timeIntervalSince(start)
                    let speed = max(0, 1 - t / 2.2)
                    Canvas { c, size in
                        let lane: CGFloat = 26
                        for k in 0..<(Int(size.height / lane) + 2) {
                            let y = CGFloat(k) * lane
                            let dash = 120 + CGFloat(k % 3) * 40, gap = 90 + CGFloat(k % 4) * 30
                            let shift = CGFloat(t * 400 * (0.6 + Double(k % 5) * 0.15) * speed).truncatingRemainder(dividingBy: dash + gap)
                            var l = Path()
                            l.move(to: CGPoint(x: -dash, y: y))
                            l.addLine(to: CGPoint(x: size.width + dash, y: y))
                            c.stroke(l, with: .color(cream.opacity(0.10 * speed + 0.03)), style: StrokeStyle(lineWidth: 1, dash: [dash, gap], dashPhase: -shift))
                        }
                    }
                }
                .ignoresSafeArea()
                VStack(spacing: 28) {
                    ZStack {
                        ForEach(0..<3, id: \.self) { i in
                            MarkShape(piece: i).trim(from: 0, to: trace[i])
                                .stroke(cream.opacity(1 - fill), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
                        }
                        MarkShape().fill(cream.opacity(fill))
                    }
                    .frame(width: w, height: w * 595 / 698)
                    .scaleEffect(settle)
                    Text("Tartan").font(.system(size: 44, weight: .bold, design: .rounded)).foregroundStyle(cream)
                        .tracking(6 * (1 - name)).opacity(name).offset(y: 24 * (1 - name))
                }
                .offset(y: -40)
                if finish > 0.001 && finish < 0.999 {
                    Rectangle().fill(Color(red: 1, green: 0.42, blue: 0.3).opacity(Double(1 - finish))).frame(width: 4)
                        .position(x: g.size.width * finish, y: g.size.height / 2).frame(height: g.size.height).ignoresSafeArea()
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Tartan")
        .task {
            if reduced {
                trace = [1, 1, 1]; fill = 1; settle = 1; name = 1
                try? await Task.sleep(for: .milliseconds(900))
                done()
                return
            }
            start = Date()
            try? await Task.sleep(for: .milliseconds(250))
            for i in 0..<3 {
                withAnimation(.timingCurve(0.2, 0, 0, 1, duration: 0.82).delay(Double(i) * 0.17)) { trace[i] = 1 }
            }
            try? await Task.sleep(for: .milliseconds(1160))
            withAnimation(.easeOut(duration: 0.36)) { fill = 1 }
            withAnimation(.spring(response: 0.5, dampingFraction: 0.5)) { settle = 1 }
            try? await Task.sleep(for: .milliseconds(420))
            withAnimation(.timingCurve(0.2, 0, 0, 1, duration: 0.52)) { finish = 1 }
            try? await Task.sleep(for: .milliseconds(160))
            withAnimation(.spring(response: 0.5, dampingFraction: 0.6)) { name = 1 }
            try? await Task.sleep(for: .milliseconds(900))
            done()
        }
    }
}

private struct Welcome: View {
    let m: IntroModel
    @Environment(\.accessibilityReduceMotion) private var reduced
    @State private var hello: Double = 0

    var body: some View {
        HStack(spacing: 8) {
            TartanMark()
            Text("Tartan").font(.system(.title2, design: .rounded).weight(.bold))
        }
        Board()
        Text("Hello!").font(.system(size: 56, weight: .black, design: .rounded))
            .accessibilityAddTraits(.isHeader)
            .scaleEffect(0.6 + 0.4 * hello, anchor: .leading).opacity(hello)
            .task {
                if reduced { hello = 1; return }
                try? await Task.sleep(for: .milliseconds(900))
                withAnimation(.spring(response: 0.55, dampingFraction: 0.5)) { hello = 1 }
                Launch.ready("intro")
            }
        Text("Your training, yours to keep. Is Tartan new to you?").font(.title3.weight(.medium)).foregroundStyle(.secondary)
        WayIn(icon: "sparkles", title: "I'm new to Tartan", sub: "Set me up: workouts, coach, training times") { m.go(1) }
        WayIn(icon: "desktopcomputer", title: "I use Tartan on my PC", sub: "Bring it all over: plan, coach, notes, lifts, workouts") { m.open("pc") }
        WayIn(icon: "clock.arrow.circlepath", title: "I have a backup", sub: "Restore a Tartan backup file") { m.open("backup") }
        Button("Just looking? Try it with sample data") { m.demo() }.font(.subheadline.weight(.semibold))
        Fine(text: "Works with intervals.icu, Strava or files from any watch, or a Suunto watch read directly over Bluetooth (unofficial; not made by or affiliated with Suunto).")
    }
}

/// A way in: a big row with its icon in a shape that turns rounder as it's pressed.
private struct WayIn: View {
    let icon: String
    let title: String
    let sub: String
    let action: () -> Void

    var body: some View {
        Button {
            Haptics.feel("click")
            action()
        } label: {
            HStack(spacing: 14) {
                Image(systemName: icon).font(.system(size: 22, weight: .medium)).foregroundStyle(Brand.onContainer)
                    .frame(width: 48, height: 48).background(Brand.container, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.headline)
                    Text(sub).font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer(minLength: 4)
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
            }
            .padding(16)
            .background(Brand.card, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(Press())
        .foregroundStyle(Color.primary)
    }
}

/// The welcome's timing board: your watch, Strava and your coach, a lane each, run to the finish
/// line one after another; each lights the line as it crosses.
private struct Board: View {
    @Environment(\.accessibilityReduceMotion) private var reduced
    private let lanes: [(String, String, Color)] = [
        ("Watch", "Straight off your wrist, over Bluetooth", Brand.watch),
        ("Strava", "Your whole history, every stream", Brand.fatigue),
        ("Coach", "A plan built around your week", Brand.fitness),
    ]
    @State private var start = Date()

    var body: some View {
        TimelineView(.animation(paused: reduced)) { ctx in
            let t = reduced ? 10 : ctx.date.timeIntervalSince(start)
            VStack(spacing: 0) {
                ForEach(Array(lanes.enumerated()), id: \.offset) { i, l in
                    // Each lane starts a little after the last, and eases in like a spring.
                    let u = max(0, min(1, (t - 0.25 - Double(i) * 0.22) / 1.4))
                    let run = 1 - pow(1 - u, 3)
                    let flash = u >= 1 ? max(0, 1 - (t - 0.25 - Double(i) * 0.22 - 1.4) / 0.7) : 0
                    HStack(spacing: 10) {
                        Text("\(i + 1)").font(.subheadline.weight(.black)).foregroundStyle(.white)
                            .frame(width: 30, height: 30).background(l.2, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        VStack(alignment: .leading, spacing: 1) {
                            Text(l.0).font(.subheadline.weight(.semibold))
                            Text(l.1).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                        }
                        .frame(width: 132, alignment: .leading)
                        Canvas { c, size in
                            let y = size.height / 2, end = size.width - 6
                            var lane = Path()
                            lane.move(to: CGPoint(x: 0, y: y)); lane.addLine(to: CGPoint(x: end, y: y))
                            c.stroke(lane, with: .color(Color.secondary.opacity(0.4)), style: StrokeStyle(lineWidth: 2, lineCap: .round, dash: [6, 5]))
                            var line = Path()
                            line.move(to: CGPoint(x: end, y: 2)); line.addLine(to: CGPoint(x: end, y: size.height - 2))
                            c.stroke(line, with: .color(l.2.opacity(0.35 + 0.65 * flash)), style: StrokeStyle(lineWidth: 3 + 4 * flash, lineCap: .round))
                            let x = 7 + (end - 14) * run
                            var done = Path()
                            done.move(to: CGPoint(x: 0, y: y)); done.addLine(to: CGPoint(x: x, y: y))
                            c.stroke(done, with: .color(l.2), style: StrokeStyle(lineWidth: 3, lineCap: .round))
                            c.fill(Path(ellipseIn: CGRect(x: x - 7, y: y - 7, width: 14, height: 14)), with: .color(l.2))
                            if flash > 0 {
                                let r = 7 + 12 * (1 - flash)
                                c.fill(Path(ellipseIn: CGRect(x: end - r, y: y - r, width: 2 * r, height: 2 * r)), with: .color(l.2.opacity(0.3 * flash)))
                            }
                        }
                        .frame(height: 30)
                    }
                    .padding(.horizontal, 14).padding(.vertical, 8)
                }
            }
            .padding(.vertical, 6)
        }
        .background(Brand.card, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Your watch, Strava and your coach, side by side")
        .onAppear { start = Date() }
    }
}

enum SourceIcon {
    case strava
    case symbol(String)
}

/// Where workouts come from: a big choice that opens its guided setup, ticked once connected.
private struct SourceRow: View {
    let icon: SourceIcon
    let title: String
    let line: String
    let done: Bool
    let doneLine: String
    let action: () -> Void

    var body: some View {
        Button {
            Haptics.feel("click")
            action()
        } label: {
            HStack(spacing: 16) {
                Group {
                    if done {
                        Image(systemName: "checkmark").font(.system(size: 24, weight: .bold)).foregroundStyle(Brand.ground)
                    } else {
                        switch icon {
                        case .strava: StravaMark().fill(Brand.onContainer).frame(width: 30, height: 30)
                        case .symbol(let s): Image(systemName: s).font(.system(size: 24, weight: .medium)).foregroundStyle(Brand.onContainer)
                        }
                    }
                }
                .frame(width: 56, height: 56)
                .background(done ? Brand.good : Brand.container, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.title3.weight(.semibold))
                    Text(done ? doneLine : line).font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer(minLength: 4)
                Text(done ? "Change" : "Connect").font(.subheadline.weight(.semibold)).foregroundStyle(Brand.tint)
            }
            .padding(20)
            .background(done ? Brand.goodContainer : Brand.card, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
            .contentShape(Rectangle())
            .animation(.smooth, value: done)
        }
        .buttonStyle(Press())
        .foregroundStyle(Color.primary)
    }
}

/// When you train: the quick picks, your own times, reminders; and who you are, if nothing's said.
private struct Times: View {
    let settings: SettingsModel
    @State private var picked: String?

    var body: some View {
        Title(title: "When do you usually train?", lede: "Your plan's sessions go at these times, and Tartan can remind you before each one.")
        if let t = settings.times {
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                ForEach(Array(PRESETS.enumerated()), id: \.offset) { _, p in
                    let on = t.weekday == p.1
                    Button {
                        Haptics.feel("click")
                        Task { await settings.saveTimes(["weekday": p.1], ok: nil) }
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(p.0).font(.headline)
                            Text(p.1).font(.figure(.title2))
                        }
                        .foregroundStyle(on ? Brand.onTint : Color.primary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(18)
                        .background(on ? Brand.tint : Brand.card, in: RoundedRectangle(cornerRadius: on ? 30 : 18, style: .continuous))
                        .animation(.spring(response: 0.4, dampingFraction: 0.7), value: on)
                    }
                    .buttonStyle(Press())
                    .accessibilityAddTraits(on ? .isSelected : [])
                }
            }
            HStack(spacing: 10) {
                timeField("Weekdays", t.weekday) { v in Task { await settings.saveTimes(["weekday": v], ok: nil) } }
                timeField("Weekends", t.weekend) { v in Task { await settings.saveTimes(["weekend": v], ok: nil) } }
            }
            Toggle(isOn: Binding(get: { t.remind }, set: { on in
                Task {
                    if on, !(await settings.allowReminders()) {
                        settings.shell?.say("Notifications are off for Tartan. Allow them in the iPhone's Settings, then turn this on in Settings → Training.")
                        return
                    }
                    await settings.saveTimes(["remind": ["on": on, "before_min": t.before, "after": t.after] as [String: Any]], ok: nil)
                }
            })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Remind me").font(.headline)
                    Text("A notification \(t.before) minutes before each session, with what's planned.").font(.subheadline).foregroundStyle(.secondary)
                }
            }
            .padding(16)
            .background(Brand.card, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            Fine(text: "A day of its own, your calendar and more are in Settings → Training.")
        } else {
            ProgressView().frame(maxWidth: .infinity, minHeight: 160)
        }
        if let p = settings.profile, p.sex == nil {
            Text("You are…").font(.system(.title2, design: .rounded).weight(.bold)).padding(.top, 8)
            Fine(text: "For your effort scores, and who shows you the strength exercises.")
            HStack(spacing: 8) {
                ForEach(Array([("M", "A man"), ("F", "A woman"), ("", "Not saying")].enumerated()), id: \.offset) { _, v in
                    Button {
                        picked = v.0
                        Task { await settings.saveProfile(max: nil, rest: p.restHr, sex: v.0.isEmpty ? nil : v.0) }
                    } label: {
                        HStack(spacing: 6) {
                            if picked == v.0 { Image(systemName: "checkmark") }
                            Text(v.1)
                        }
                    }
                    .buttonStyle(.glass)
                    .tint(picked == v.0 ? Brand.tint : nil)
                }
            }
        }
    }

    private func timeField(_ label: String, _ value: String, _ save: @escaping (String) -> Void) -> some View {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        let date = f.date(from: value) ?? f.date(from: "07:00")!
        return VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.subheadline).foregroundStyle(.secondary)
            DatePicker(label, selection: Binding(get: { date }, set: { save(f.string(from: $0)) }), displayedComponents: .hourAndMinute)
                .labelsHidden()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Brand.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

/// Where things live: the four tabs, each its job.
private struct Places: View {
    var body: some View {
        Title(title: "Four places, one job each", lede: "Slide along the bar at the bottom to switch.")
        ForEach(Array([("sun.max", "Today", "How you are, what's on today, and your body"),
                       ("ellipsis.bubble", "Coach", "Your plan, and a coach to ask"),
                       ("list.bullet", "Activities", "Every workout once, and routes to draw for the watch"),
                       ("chart.bar.xaxis", "Progress", "How your training adds up, week by week")].enumerated()), id: \.offset) { _, r in
            HStack(spacing: 14) {
                Image(systemName: r.0).font(.system(size: 22, weight: .medium)).foregroundStyle(Brand.onContainer)
                    .frame(width: 48, height: 48).background(Brand.container, in: Circle())
                VStack(alignment: .leading, spacing: 2) {
                    Text(r.1).font(.headline)
                    Text(r.2).font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .padding(16)
            .background(Brand.card, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        }
        Fine(text: "Settings sit behind the gear at the top right.")
    }
}

/// Already on a PC: pair, copy everything over, and open the app with it all here.
private struct FromPc: View {
    let m: IntroModel
    let s: SourcesModel
    @State private var urls = ""
    @State private var code = ""

    var body: some View {
        Title(title: "Bring it over from your PC", lede: "Your phone pairs with Tartan on your PC and copies everything: workouts, plan, coach and its key, notes, lifts and morning checks. After that the two keep in step.")
        if let pc = s.pc {
            Label("Paired with \(pc.name ?? pc.url) · end to end encrypted", systemImage: "checkmark").font(.headline).foregroundStyle(Brand.good)
            if let l = s.pcLine { Text(l).font(.subheadline) }
            if s.busy == "pc" { ProgressView().frame(maxWidth: .infinity, alignment: .leading) }
            Fine(text: "Connect Strava on this phone in Settings → Sources: one tap, your app's details came over (each device signs in itself).")
            Primary(label: "Open Tartan", busy: s.busy == "pc") { m.done(reload: true) }
        } else {
            VStack(alignment: .leading, spacing: 12) {
                PcStep(n: 1, title: "On your PC, open Tartan:", line: "Settings → More → Phone app.")
                PcStep(n: 2, title: "Tap Pair a phone.", line: "It shows a code for 10 minutes. No code there? Tartan on the PC needs to be started for your home network (bun src/cli.ts serve --lan).")
                PcStep(n: 3, title: "Type its address and code here.", line: "Both are under the QR code on the PC.")
            }
            .padding(16)
            .background(Brand.card, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            TextField("PC address", text: $urls, prompt: Text("192.168.1.20:5173"))
                .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                .padding(.horizontal, 14).frame(height: 48)
                .background(Brand.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            TextField("Code", text: Binding(get: { code }, set: { code = $0.uppercased() }), prompt: Text("K7QM3-XPA9R"))
                .textInputAutocapitalization(.characters).autocorrectionDisabled()
                .font(.body.monospaced())
                .padding(.horizontal, 14).frame(height: 48)
                .background(Brand.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            Primary(label: "Connect", enabled: !urls.trimmingCharacters(in: .whitespaces).isEmpty && !code.trimmingCharacters(in: .whitespaces).isEmpty, busy: s.busy == "pc") {
                s.pcPair(urls: urls, code: code)
            }
            Fine(text: "End to end encrypted: your data, health and keys travel sealed with a key only your phone and your PC hold.")
        }
    }
}

private struct PcStep: View {
    let n: Int
    let title: String
    let line: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text("\(n)").font(.subheadline.weight(.bold)).foregroundStyle(Brand.onTint)
                .frame(width: 26, height: 26).background(Brand.tint, in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline)
                Text(line).font(.subheadline).foregroundStyle(.secondary)
            }
        }
    }
}

/// Had Tartan before: a backup file and its passphrase bring everything back.
private struct FromBackup: View {
    let m: IntroModel
    let shell: ShellModel
    @State private var picking = false
    @State private var file: (name: String, data: Data)?
    @State private var pass = ""
    @State private var busy = false

    var body: some View {
        Title(title: "Restore your backup", lede: "Pick the backup file (tartan-backup-….tartan, from iCloud Drive, Files or Documents/Tartan) and give the passphrase you chose. Everything comes back: workouts, plan, coach and its key, lifts and notes.")
        Button { picking = true } label: {
            Label(file?.name ?? "Pick the backup file", systemImage: "doc").font(.headline).frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.glass)
        SecureField("Its passphrase", text: $pass)
            .padding(.horizontal, 14).frame(height: 48)
            .background(Brand.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        Fine(text: "What's in the backup replaces what's here now: workouts, plan, lifts, check-ins, coach notes and keys.")
        Primary(label: busy ? "Restoring…" : "Restore", enabled: file != nil && !pass.isEmpty, busy: busy) {
            guard let f = file else { return }
            busy = true
            Task {
                switch await shell.engine.rpc("backup", ["op": "restore", "name": f.name, "data": f.data.base64EncodedString(), "pass": pass]) {
                case .success(let j):
                    let o = J(json: j)
                    if let said = o["said"].str { shell.say(said) }
                    // Restored: the page starts again with it, and the intro is over.
                    if o["restored"].bool {
                        try? await Task.sleep(for: .milliseconds(900))
                        m.done(reload: false)
                    }
                case .failure(let e):
                    shell.say(e.message)
                }
                busy = false
            }
        }
        .fileImporter(isPresented: $picking, allowedContentTypes: [UTType(filenameExtension: "tartan") ?? .data, .data]) { r in
            guard case .success(let url) = r else { return }
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            if let d = try? Data(contentsOf: url) { file = (url.lastPathComponent, d) } else { shell.say("Couldn't read that file.") }
        }
    }
}
