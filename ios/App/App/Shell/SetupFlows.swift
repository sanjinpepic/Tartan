import SwiftUI
import UIKit

/// Strava's mark as Tartan draws it (Android's Glyphs "strava", a 24-point square).
struct StravaMark: Shape {
    func path(in rect: CGRect) -> Path {
        let p = SVGPath.parse("M5.22 13.38L10.73 2.5L16.29 13.38L13 13.38L10.73 9.03L8.47 13.38ZM10.62 13.38L13 13.38L14.7 16.67L16.29 13.38L18.78 13.38L14.7 21.5Z")
        let s = min(rect.width, rect.height) / 24
        return p.applying(CGAffineTransform(scaleX: s, y: s).translatedBy(x: rect.minX / s, y: rect.minY / s))
    }
}

/// Strava's orange.
let stravaOrange = Color(red: 0.99, green: 0.32, blue: 0.0)

/**
 * The setups that make Tartan work (Android's SetupFlows.kt), each its own full-screen moment: a
 * progress line, a big title, a picture, one thing to do at a time, the main action under the thumb.
 */
struct FlowFrame<Content: View, Action: View>: View {
    let steps: Int
    let step: Int
    let forward: Bool
    let close: () -> Void
    var back: (() -> Void)?
    @ViewBuilder var action: Action
    @ViewBuilder var content: Content

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Button(action: close) { Image(systemName: "xmark").font(.headline).frame(width: 40, height: 40) }
                    .buttonStyle(.glass).buttonBorderShape(.circle)
                    .accessibilityLabel("Close")
                StepBar(steps: steps, step: step)
                Color.clear.frame(width: 40, height: 1)
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            ScrollView {
                VStack(alignment: .leading, spacing: 18) { content }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 24)
                    .padding(.vertical, 20)
            }
            .id(step)
            .transition(.asymmetric(insertion: .move(edge: forward ? .trailing : .leading).combined(with: .opacity), removal: .opacity))
            HStack(spacing: 12) {
                if let back {
                    Button(action: back) { Image(systemName: "chevron.left").font(.title3.weight(.semibold)).frame(width: 52, height: 52) }
                        .buttonStyle(.glass).buttonBorderShape(.circle)
                        .accessibilityLabel("Back")
                }
                action.frame(maxWidth: .infinity)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
        }
        .background(Brand.ground)
        .animation(.smooth(duration: 0.35), value: step)
        .tint(Brand.tint)
    }
}

/// The steps so far: a short bar each, filled up to here.
struct StepBar: View {
    let steps: Int
    let step: Int

    var body: some View {
        HStack(spacing: 6) {
            ForEach(0..<steps, id: \.self) { i in
                Capsule().fill(Brand.well)
                    .overlay(alignment: .leading) {
                        GeometryReader { g in Capsule().fill(Brand.tint).frame(width: i <= step ? g.size.width : 0) }
                    }
                    .frame(height: 6)
            }
        }
        .animation(.spring(response: 0.45, dampingFraction: 0.8), value: step)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Step \(step + 1) of \(steps)")
    }
}

struct Headline: View {
    let title: String
    let lede: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.system(.largeTitle, design: .rounded).weight(.bold)).accessibilityAddTraits(.isHeader)
            Text(lede).font(.body).foregroundStyle(.secondary)
        }
    }
}

/// The main action: full width, tall, the label (and a spinner while it works).
struct Primary: View {
    let label: String
    var enabled = true
    var busy = false
    let action: () -> Void

    var body: some View {
        Button {
            Haptics.feel("click")
            action()
        } label: {
            HStack(spacing: 10) {
                if busy { ProgressView() }
                Text(label).font(.headline)
            }
            .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.glassProminent)
        .disabled(!enabled || busy)
    }
}

/// One thing to check, with its icon in a soft shape.
struct FlowPoint: View {
    let icon: String
    let title: String
    let line: String

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: icon).font(.system(size: 20, weight: .medium)).foregroundStyle(Brand.onContainer)
                .frame(width: 44, height: 44).background(Brand.container, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline)
                Text(line).font(.subheadline).foregroundStyle(.secondary)
            }
        }
    }
}

/// Done: a check that lands with a bounce in a ring that fills.
struct Success: View {
    @State private var ring: CGFloat = 0
    @State private var tick: CGFloat = 0

    var body: some View {
        ZStack {
            Circle().fill(Brand.goodContainer)
            Circle().trim(from: 0, to: ring).stroke(Brand.good, style: StrokeStyle(lineWidth: 6, lineCap: .round)).rotationEffect(.degrees(-90)).padding(3)
            Image(systemName: "checkmark").font(.system(size: 46, weight: .bold)).foregroundStyle(Brand.good).scaleEffect(tick).opacity(Double(tick))
        }
        .frame(width: 112, height: 112)
        .frame(maxWidth: .infinity)
        .accessibilityHidden(true)
        .task {
            withAnimation(.easeOut(duration: 0.52)) { ring = 1 }
            try? await Task.sleep(for: .milliseconds(520))
            withAnimation(.spring(response: 0.45, dampingFraction: 0.5)) { tick = 1 }
            Haptics.feel("confirm")
        }
    }
}

/// Waiting for the other side: three dots breathing in turn.
struct Waiting: View {
    var body: some View {
        TimelineView(.animation) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.5) / 0.5
            HStack(spacing: 14) {
                ForEach(0..<3, id: \.self) { i in
                    let k = min(1, max(0.25, 1 - abs((t - Double(i) + 3).truncatingRemainder(dividingBy: 3) - 0.5) * 1.2))
                    Circle().fill(Brand.tint).frame(width: 18, height: 18).scaleEffect(0.7 + 0.5 * k).opacity(k)
                }
            }
        }
        .frame(maxWidth: .infinity, minHeight: 140)
        .accessibilityLabel("Waiting")
    }
}

/// Your phone and your own Strava app, a line running between them.
struct Bridge: View {
    var body: some View {
        TimelineView(.animation) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.6) / 1.6
            Canvas { c, size in
                let y = size.height / 2, l = size.width * 0.22, r = size.width * 0.78
                var line = Path()
                line.move(to: CGPoint(x: l, y: y))
                line.addLine(to: CGPoint(x: r, y: y))
                c.stroke(line, with: .color(Brand.tint), style: StrokeStyle(lineWidth: 4, lineCap: .round, dash: [10, 10], dashPhase: -t * 20))
                c.fill(Path(ellipseIn: CGRect(x: l - 44, y: y - 44, width: 88, height: 88)), with: .color(Brand.container))
                c.fill(Path(ellipseIn: CGRect(x: r - 44, y: y - 44, width: 88, height: 88)), with: .color(stravaOrange.opacity(0.18)))
            }
            .overlay {
                GeometryReader { g in
                    Image(systemName: "iphone").font(.system(size: 34, weight: .medium)).foregroundStyle(Brand.onContainer)
                        .position(x: g.size.width * 0.22, y: g.size.height / 2)
                    StravaMark().fill(stravaOrange).frame(width: 40, height: 40)
                        .position(x: g.size.width * 0.78, y: g.size.height / 2)
                }
            }
        }
        .frame(height: 150)
        .accessibilityLabel("Strava and this phone, connected")
    }
}

/// A round watch with Tartan's track on its face; looking, rings go out from it.
struct WatchPicture: View {
    let looking: Bool

    var body: some View {
        TimelineView(.animation(paused: !looking)) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2.2) / 2.2
            Canvas { c, size in
                let ctr = CGPoint(x: size.width / 2, y: size.height / 2)
                let face = min(size.width, size.height) * 0.30
                func circle(_ r: CGFloat) -> Path { Path(ellipseIn: CGRect(x: ctr.x - r, y: ctr.y - r, width: 2 * r, height: 2 * r)) }
                if looking {
                    let reach = min(size.width, size.height) / 2 - 3 - face
                    for k in 0..<3 {
                        let p = (t + Double(k) / 3).truncatingRemainder(dividingBy: 1)
                        c.stroke(circle(face + p * reach), with: .color(Brand.tint.opacity((1 - p) * 0.35)), lineWidth: 3)
                    }
                }
                let strap = face * 0.62
                c.fill(Path(roundedRect: CGRect(x: ctr.x - strap / 2, y: ctr.y - face * 1.55, width: strap, height: face * 3.1), cornerRadius: strap / 3), with: .color(Color.secondary.opacity(0.35)))
                c.fill(circle(face + 8), with: .color(Color.primary.opacity(0.85)))
                c.fill(circle(face), with: .color(Color(red: 0.05, green: 0.04, blue: 0.04)))
                let red = Color(red: 0.88, green: 0.27, blue: 0.17)
                c.stroke(circle(face * 0.86), with: .color(red.opacity(0.55)), lineWidth: 2)
                c.stroke(circle(face * 0.74), with: .color(red.opacity(0.35)), lineWidth: 2)
                var finish = Path()
                finish.move(to: CGPoint(x: ctr.x, y: ctr.y - face * 0.92))
                finish.addLine(to: CGPoint(x: ctr.x, y: ctr.y - face * 0.68))
                c.stroke(finish, with: .color(Color(red: 1, green: 0.42, blue: 0.3)), style: StrokeStyle(lineWidth: 3, lineCap: .round))
                func hand(_ deg: Double, _ len: CGFloat, _ w: CGFloat) {
                    let a = (deg - 90) * .pi / 180
                    var h = Path()
                    h.move(to: ctr)
                    h.addLine(to: CGPoint(x: ctr.x + cos(a) * len, y: ctr.y + sin(a) * len))
                    c.stroke(h, with: .color(red), style: StrokeStyle(lineWidth: w, lineCap: .round))
                }
                hand(304.5, face * 0.42, 5)
                hand(54, face * 0.62, 3.5)
                c.fill(circle(5), with: .color(red))
            }
        }
        .accessibilityLabel(looking ? "Looking for your watch" : "Your watch")
    }
}

// MARK: Strava

/**
 * Connecting Strava: why your own app, making it (the form's values to copy), its two keys, the
 * sign-in in Strava's page (we wait here and notice when you're back), then your workouts arriving.
 * With the keys already saved it starts at the sign-in.
 */
struct StravaFlow: View {
    let s: SourcesModel
    let close: () -> Void
    @State private var step = 0
    @State private var forward = true
    @State private var id = ""
    @State private var secret = ""
    @State private var started = false

    private var idOk: Bool { id.range(of: "^\\d{3,10}$", options: .regularExpression) != nil }
    private var secretOk: Bool { secret.range(of: "^[0-9a-fA-F]{40}$", options: .regularExpression) != nil }
    private func go(_ to: Int) { forward = to > step; step = to }

    var body: some View {
        let st = s.strava
        FlowFrame(steps: 5, step: step, forward: forward, close: close, back: (1...3).contains(step) ? { go(step - 1) } : nil) {
            switch step {
            case 0: Primary(label: "Let's do it") { go(1) }
            case 1: Primary(label: "I've made it") { go(2) }
            case 2:
                Primary(label: "Connect to Strava", enabled: idOk && (secretOk || (st?.configured == true && secret.isEmpty)), busy: s.busy == "strava") {
                    s.stravaConnect(id: id, secret: secret.isEmpty ? nil : secret)
                    go(3)
                }
            case 3:
                Button { s.stravaConnect(id: st?.configured == true ? nil : id, secret: secret.isEmpty ? nil : secret) } label: {
                    Text("Open Strava again").font(.headline).frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.glass)
                .disabled(s.busy == "strava")
            default: Primary(label: "Done", action: close)
            }
        } content: {
            switch step {
            case 0:
                Bridge()
                Headline(title: "Bring in your Strava history", lede: "Every workout you've recorded, with its laps and heart rate, straight to this phone. Strava lets each person connect their own app, so Tartan uses one you make: about 5 minutes, once.")
                FlowPoint(icon: "folder", title: "Yours, on this phone", line: "Your workouts are stored here, not on a server of ours. There isn't one.")
                FlowPoint(icon: "arrow.triangle.2.circlepath", title: "Then it keeps up by itself", line: "New workouts arrive when you open Tartan, and every hour while it's open.")
                FlowPoint(icon: "sparkles", title: "Already on Strava from your watch", line: "If the Suunto app sends your runs to Strava, they're all already there.")
            case 1:
                Headline(title: "Make your Strava app", lede: "Strava's API page opens in a browser tab. Sign in, then fill in the form with these; the rest can be anything.")
                Primary(label: "Open Strava's API page") { s.open("https://www.strava.com/settings/api") }
                VStack(spacing: 0) {
                    ForEach(Array([["Application name", "Tartan"], ["Category", "Training"], ["Website", "http://localhost"], ["Authorization Callback Domain", "localhost"]].enumerated()), id: \.offset) { _, r in
                        CopyRow(label: r[0], value: r[1])
                    }
                }
                .background(Brand.card, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
                Text("Strava also asks for an icon: any picture will do.").font(.footnote).foregroundStyle(.secondary)
            case 2:
                Headline(title: "Paste its two keys", lede: "On the same page, Strava now shows your app's Client ID and Client Secret (tap Show to see the secret). They stay on this phone.")
                KeyField(label: "Client ID", value: $id, ok: idOk, hint: "A number, like 123456", keep: { $0.filter(\.isNumber) })
                KeyField(label: "Client Secret", value: $secret, ok: secretOk, hint: st?.configured == true ? "Saved already: paste a new one only to change it" : "40 letters and digits", keep: { t in t.filter { !$0.isWhitespace } })
            case 3:
                Waiting()
                Headline(title: "Approve on Strava", lede: "In Strava's page, tap Authorize. You come straight back here, and this moves on by itself.")
                Text("Tartan asks to read your activities (and, if you allow it, to upload runs you record on the phone). It never posts anything else.")
                    .font(.subheadline).foregroundStyle(.secondary)
                if let url = s.stravaUrl {
                    Button("Page didn't open? Copy the sign-in link") {
                        UIPasteboard.general.string = url
                        s.shell?.say("Sign-in link copied. Paste it into any browser on this phone.")
                    }
                }
            default:
                Success().padding(.top, 24)
                Headline(title: "Strava is connected", lede: (st?.name.isEmpty == false ? "Hello, \(st!.name). " : "") + "Your workouts are on their way: the newest first, then your whole history, a few hundred at a time (Strava limits how fast).")
                if let n = st?.activities, n > 0 { Text("\(n) workouts here so far.").font(.headline) }
            }
        }
        .onAppear {
            guard !started else { return }
            started = true
            id = st?.clientId ?? ""
            if st?.configured == true && st?.clientId != nil { step = 3 }
            if st?.connected == true { step = 4 }
        }
        // Waiting for Strava's page: read again every few seconds; connected moves on by itself.
        .task(id: step) {
            guard step == 3 else { return }
            for _ in 0..<120 {
                try? await Task.sleep(for: .seconds(2.5))
                guard !Task.isCancelled else { return }
                await s.fetch()
                if s.strava?.connected == true { forward = true; step = 4; return }
            }
        }
    }
}

/// A value from Strava's form, tap to copy; it says so with a tick.
private struct CopyRow: View {
    let label: String
    let value: String
    @State private var copied = false

    var body: some View {
        Button {
            UIPasteboard.general.string = value
            Haptics.feel("click")
            copied = true
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(label).font(.subheadline).foregroundStyle(.secondary)
                    Text(value).font(.body.monospaced())
                }
                Spacer()
                Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(copied ? Brand.good : Brand.tint)
            }
            .padding(.horizontal, 18).padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(Press())
        .foregroundStyle(Color.primary)
        .accessibilityLabel("Copy \(label)")
        .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(for: .seconds(1.8))
            copied = false
        }
    }
}

/// A key to paste: the field, Paste, and a tick once it looks right.
private struct KeyField: View {
    let label: String
    @Binding var value: String
    let ok: Bool
    let hint: String
    let keep: (String) -> String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                TextField(label, text: Binding(get: { value }, set: { value = keep($0) }))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(.body.monospaced())
                    .padding(.horizontal, 14).frame(height: 48)
                    .background(Brand.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                Button("Paste") { if let t = UIPasteboard.general.string { value = keep(t.trimmingCharacters(in: .whitespacesAndNewlines)) } }
                    .buttonStyle(.glass)
            }
            HStack(spacing: 6) {
                if ok { Image(systemName: "checkmark").foregroundStyle(Brand.good) }
                Text(ok ? "Looks right" : value.isEmpty ? hint : "Not quite: \(hint)")
                    .foregroundStyle(ok ? Brand.good : value.isEmpty ? Color.secondary : Color.red)
            }
            .font(.footnote)
        }
    }
}

// MARK: The watch

/**
 * Connecting the watch: get it ready (close, awake, the Suunto app out of the way), find it (a
 * radar while it looks), then connected: what it is, and the first backup with its progress.
 */
struct WatchFlow: View {
    let s: SourcesModel
    let close: () -> Void
    @State private var step = 0
    @State private var forward = true
    @State private var tried = false
    @State private var started = false

    private func go(_ to: Int) { forward = to > step; step = to }

    var body: some View {
        let w = s.watch
        let looking = w?.connecting == true || s.busy == "watch"
        FlowFrame(steps: 3, step: step, forward: forward, close: close, back: step == 1 && !looking ? { go(0) } : nil) {
            switch step {
            case 0: Primary(label: "Find my watch", enabled: w?.canBluetooth != false) { tried = true; s.watchConnect(); go(1) }
            case 1:
                if looking { Primary(label: "Looking…", busy: true) {} } else { Primary(label: "Look again") { s.watchConnect() } }
            default:
                if w?.running == true {
                    Button { s.watchCancel() } label: { Text("Stop the backup").font(.headline).frame(maxWidth: .infinity, minHeight: 44) }.buttonStyle(.glass)
                } else if w?.job == nil && !tried {
                    Primary(label: "Back up my watch") { tried = true; s.watchBackup() }
                } else {
                    Primary(label: "Done", action: close)
                }
            }
        } content: {
            switch step {
            case 0:
                WatchPicture(looking: false).frame(height: 190)
                Headline(title: "Connect your watch", lede: "Tartan reads it over Bluetooth, the same way the Suunto app does, and keeps every workout file on this phone.")
                FlowPoint(icon: "watch.analog", title: "Close and awake", line: "Keep the watch next to the phone, with its screen on.")
                FlowPoint(icon: "xmark", title: "The Suunto app out of the way", line: "Close it if it's open: it holds the watch's Bluetooth while it runs.")
                FlowPoint(icon: "sparkles", title: "Paired with this phone already?", line: "Then there's no code: Tartan uses that pairing. Never paired: on the watch, Settings → Connectivity → Pair, then type the code it shows.")
                if w?.canBluetooth == false {
                    Text("Bluetooth is off or not allowed for Tartan. Turn it on, or allow Bluetooth for Tartan in the iPhone's Settings.").font(.subheadline).foregroundStyle(.red)
                }
            case 1:
                WatchPicture(looking: looking).frame(height: 220)
                Headline(title: looking ? "Looking for your watch" : "No watch yet",
                         lede: looking ? "It shows up here when it answers. It can take a few seconds." : "It didn't answer. Check it's awake and close, and that the Suunto app is closed, then look again.")
            default:
                if w?.job == nil && w?.running != true { Success().padding(.top, 16) } else { WatchPicture(looking: true).frame(height: 170) }
                Headline(title: "Connected to \(w.flatMap { $0.name.isEmpty ? nil : $0.name } ?? "your watch")",
                         lede: w?.job == nil ? "Back it up now to bring in what's on it. After this it backs up by itself when you open Tartan." : "Bringing in what's on it. You can leave this screen: it carries on.")
                let facts = (w?.facts ?? []).filter { $0.count == 2 && ["Battery", "Firmware"].contains($0[0]) }
                if !facts.isEmpty {
                    HStack(spacing: 10) {
                        ForEach(facts, id: \.self) { f in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(f[0]).font(.subheadline).foregroundStyle(.secondary)
                                Text(f[1]).font(.figure(.title3))
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(14)
                            .background(Brand.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                        }
                    }
                }
                if let j = w?.job {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(j.title).font(.headline)
                        if let v = j.value { ProgressView(value: min(1, max(0, v / (j.max ?? 1)))) } else { ProgressView().frame(maxWidth: .infinity, alignment: .leading) }
                        Text(j.text).font(.subheadline).foregroundStyle(.secondary)
                    }
                    .padding(16)
                    .background(Brand.card, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
                }
            }
        }
        .onAppear {
            guard !started else { return }
            started = true
            if w?.connected == true { step = 2 }
        }
        .onChange(of: w?.connected) { _, c in if c == true && step < 2 { forward = true; step = 2 } }
    }
}

// MARK: intervals.icu

/// intervals.icu: its key (and athlete ID), where to find them, Connect.
struct IcuFlow: View {
    let s: SourcesModel
    let close: () -> Void
    @State private var key = ""
    @State private var athlete = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("In intervals.icu, open Settings → Developer Settings and copy the API key here. The athlete ID (i12345) is there too, if Tartan asks for it.")
                        .font(.subheadline).foregroundStyle(.secondary)
                    Button("Open intervals.icu settings") { s.open("https://intervals.icu/settings") }
                }
                Section {
                    SecureField("API key", text: Binding(get: { key }, set: { key = $0.trimmingCharacters(in: .whitespaces) }))
                    TextField("Athlete ID (optional)", text: Binding(get: { athlete }, set: { athlete = $0.trimmingCharacters(in: .whitespaces) }), prompt: Text("i12345"))
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                Section {
                    Button(s.busy == "icu" ? "Connecting…" : "Connect") { s.icuConnect(key: key, athlete: athlete) { key = ""; close() } }
                        .disabled(key.count < 8 || s.busy == "icu")
                }
            }
            .navigationTitle("intervals.icu")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button { close() } label: { Image(systemName: "xmark") }.accessibilityLabel("Close") }
            }
        }
        .presentationDetents([.medium, .large])
        .tint(Brand.tint)
    }
}
