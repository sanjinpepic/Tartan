import SwiftUI
import PhotosUI

/// Ask your coach, native on iPhone (Android's ChatScreen.kt): the conversation, the coach's
/// steps as chips while it looks things up, its answer as it streams in, route cards, the plan's
/// changes, a failed turn with Ask again, Copy and Report on a long press, a photo in the box
/// (and the keyboard's own dictation), your other conversations in a sheet. Without a coach set
/// up, the way to set one up. The box rides the keyboard.
struct ChatScreen: View {
    let shell: ShellModel
    let chat: ChatModel
    @State private var history = false
    @State private var reporting: ChatMsg?
    @State private var picking = false
    @State private var picked: PhotosPickerItem?
    @FocusState private var typing: Bool

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        if chat.status?.ready == true {
                            Text("Reads your workouts, sleep and plan").font(.subheadline.weight(.medium)).foregroundStyle(.secondary).padding(.horizontal, 4)
                        }
                        content
                        Color.clear.frame(height: 1).id("end")
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 8)
                }
                .defaultScrollAnchor(.bottom)
                .scrollDismissesKeyboard(.interactively)
                .background(Brand.ground)
                .onChange(of: chat.messages.count) { withAnimation(.smooth) { proxy.scrollTo("end", anchor: .bottom) } }
                .onChange(of: chat.messages.last?.text.count ?? 0) { proxy.scrollTo("end", anchor: .bottom) }
                .onChange(of: chat.messages.last?.steps.count ?? 0) { withAnimation(.smooth) { proxy.scrollTo("end", anchor: .bottom) } }
                .onChange(of: typing) { if typing { withAnimation(.smooth) { proxy.scrollTo("end", anchor: .bottom) } } }
                .safeAreaInset(edge: .bottom, spacing: 0) { composerArea }
            }
            .navigationTitle("Ask your coach")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { shell.go("coach") } label: { Image(systemName: "chevron.left") }.accessibilityLabel("Back to Coach")
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button { history = true; chat.readList() } label: { Image(systemName: "clock.arrow.circlepath") }.accessibilityLabel("Chats")
                    Button { chat.newChat() } label: { Image(systemName: "square.and.pencil") }.accessibilityLabel("New chat")
                }
            }
            .sheet(isPresented: $history) { ChatHistory(chat: chat) }
            .sheet(item: $reporting) { m in ReportSheet(chat: chat, m: m) }
            .photosPicker(isPresented: $picking, selection: $picked, matching: .images)
            .onChange(of: picked) {
                guard let item = picked else { return }
                Task {
                    if let data = try? await item.loadTransferable(type: Data.self), let img = UIImage(data: data) { chat.photo = ChatPhoto.make(img) }
                    picked = nil
                }
            }
            .onChange(of: chat.focusAsk) { typing = true }
        }
    }

    @ViewBuilder private var content: some View {
        if let s = chat.status, !s.ready {
            Card {
                Text("Your plan works without AI").font(.title3.weight(.bold))
                Text("Tartan's own rules write your plan from your targets and recent weeks, and you change it on the Coach tab. To ask the coach questions, add a free Gemini key (two minutes, no card) or a Claude key.")
                    .font(.subheadline).foregroundStyle(.secondary)
                Button("Set up the coach") { shell.go("settings/coach") }.buttonStyle(.glassProminent)
            }
        } else if chat.loading {
            ProgressView().controlSize(.large).frame(maxWidth: .infinity, minHeight: 200)
        } else if chat.messages.isEmpty {
            empty
        } else {
            ForEach(chat.messages) { m in
                Bubble(m: m, shell: shell, report: { reporting = m }, retry: { chat.retry(m) })
            }
        }
    }

    private var empty: some View {
        VStack(spacing: 10) {
            Image(systemName: "figure.run")
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(Brand.onContainer)
                .frame(width: 64, height: 64)
                .background(Brand.container, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            Text("What would you like to know?").font(.title3.weight(.bold))
            Text("The coach reads your workouts, load, zones and takeaways before it answers, and shows you what it checked.")
                .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Label("Training guidance, not medical advice. AI can be wrong: for pain, illness or anything that worries you, see a doctor.", systemImage: "info.circle")
                .font(.footnote).foregroundStyle(.secondary)
                .padding(12)
                .background(Brand.well, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            Flow(spacing: 8) {
                ForEach(suggestions, id: \.self) { s in
                    Button(s) { chat.send(s) }.buttonStyle(.glass).font(.subheadline)
                }
            }
            .padding(.top, 6)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 24)
    }

    /** What to ask first, from what you have: a plan or not, a race or not. */
    private var suggestions: [String] {
        let c = shell.coach.data
        return [
            "How is my training going?",
            c?.plan != nil ? "Should I change anything this week?" : "Make me a training plan",
            "Was my last run too hard?",
            c?.goal.map { "Am I on track for \($0.components(separatedBy: " on ").first ?? $0)?" } ?? "What race could I aim for?",
            "Why has my easy pace changed?",
        ]
    }

    /** The box, above the tab bar, or on the keyboard while typing. */
    @ViewBuilder private var composerArea: some View {
        if chat.status?.ready != false {
            VStack(alignment: .leading, spacing: 8) {
                if let p = chat.photo {
                    ZStack(alignment: .topTrailing) {
                        Image(uiImage: p.image).resizable().scaledToFill().frame(width: 84, height: 84).clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                            .accessibilityLabel("Photo to send")
                        Button { chat.photo = nil } label: { Image(systemName: "xmark").font(.caption.weight(.bold)).frame(width: 26, height: 26) }
                            .buttonStyle(.glass).buttonBorderShape(.circle).accessibilityLabel("Remove the photo").offset(x: 8, y: -8)
                    }
                }
                HStack(alignment: .bottom, spacing: 6) {
                    if chat.status?.photos != false {
                        Button { picking = true } label: { Image(systemName: "camera").font(.body.weight(.semibold)).frame(width: 40, height: 40) }
                            .buttonStyle(.plain).foregroundStyle(Color.secondary).accessibilityLabel("Add a photo")
                    }
                    TextField("Ask your coach", text: Binding(get: { chat.draft }, set: { chat.draft = $0 }), axis: .vertical)
                        .lineLimit(1...6)
                        .focused($typing)
                        .padding(.vertical, 10)
                    let can = (!chat.draft.trimmingCharacters(in: .whitespaces).isEmpty || chat.photo != nil) && !chat.busy
                    Button { chat.send(chat.draft) } label: {
                        Group {
                            if chat.busy { ProgressView().tint(Color.secondary) } else { Image(systemName: "arrow.up").font(.body.weight(.bold)) }
                        }
                        .frame(width: 36, height: 36)
                        .foregroundStyle(can ? Brand.onTint : Color.secondary)
                        .background(can ? Brand.tint : Brand.well, in: Circle())
                    }
                    .buttonStyle(.plain)
                    .disabled(!can)
                    .accessibilityLabel("Send")
                    .padding(.bottom, 2)
                }
                .padding(.leading, 8).padding(.trailing, 4).padding(.vertical, 2)
                .glassEffect(.regular.interactive(), in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            }
            .padding(.horizontal, 16)
            .padding(.top, 10)
            .padding(.bottom, shell.keyboardUp ? 8 : (shell.navOn ? (shell.navFolded ? 60 : 76) : 8))
            .background {
                LinearGradient(stops: [.init(color: Brand.ground.opacity(0), location: 0), .init(color: Brand.ground.opacity(0.92), location: 0.3), .init(color: Brand.ground, location: 1)],
                               startPoint: .top, endPoint: .bottom)
                    .ignoresSafeArea(edges: .bottom)
                    .allowsHitTesting(false)
            }
            .animation(.smooth(duration: 0.25), value: shell.keyboardUp)
        } else {
            BarSpace(on: shell.navOn)
        }
    }
}

/// A message: yours on the right in the track red; the coach's on the left, with its steps, its
/// words, who answered, what went wrong, routes and plan links. Hold it to copy or report.
private struct Bubble: View {
    let m: ChatMsg
    let shell: ShellModel
    let report: () -> Void
    let retry: () -> Void
    @Environment(\.accessibilityReduceMotion) private var still

    var body: some View {
        HStack {
            if m.user { Spacer(minLength: 48) }
            VStack(alignment: m.user ? .trailing : .leading, spacing: 8) {
                if let img = m.image {
                    Image(uiImage: img).resizable().scaledToFill().frame(width: 180, height: 180).clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                        .accessibilityLabel("Photo sent to the coach")
                }
                if !m.steps.isEmpty {
                    Flow(spacing: 6) {
                        ForEach(m.steps) { st in
                            HStack(spacing: 6) {
                                if st.done { Image(systemName: "checkmark").font(.caption2.weight(.bold)).foregroundStyle(Brand.good) } else { ProgressView().controlSize(.mini) }
                                Text(st.label).font(.caption.weight(.medium)).foregroundStyle(.secondary)
                            }
                            .padding(.horizontal, 10).padding(.vertical, 6)
                            .background(Brand.well, in: Capsule())
                        }
                    }
                }
                if m.user {
                    Text(m.text).foregroundStyle(Brand.onTint)
                } else if !m.text.isEmpty {
                    Markdown(text: m.text)
                }
                if m.streaming { Working(m: m) }
                if !m.user, let by = m.by, !m.text.isEmpty || !m.streaming {
                    Text(by).font(.caption2).foregroundStyle(.secondary).accessibilityLabel("Answered by \(by)")
                }
                if let r = m.reported { Text("Reported: \(r)").font(.caption2).foregroundStyle(.red) }
                if let e = m.error { Text(e).font(.subheadline).foregroundStyle(.red) }
                if m.error != nil && !m.user && !m.streaming {
                    Button(action: retry) { Label("Ask again", systemImage: "arrow.clockwise") }.buttonStyle(.glass)
                }
                ForEach(m.routes) { r in RouteCardInChat(r: r) { shell.go("route/\(r.id)") } }
                ForEach(Array(m.links.enumerated()), id: \.offset) { _, l in
                    Button { shell.go(l.hash) } label: { Label(l.label, systemImage: "sparkles").font(.subheadline.weight(.semibold)) }
                        .buttonStyle(.glassProminent)
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
            // What arrives after the words (a step, who answered, a route, a plan link) eases in; the
            // streamed words themselves just grow, the view following them.
            .animation(still ? nil : .smooth(duration: 0.3), value: m.steps.count)
            .animation(still ? nil : .smooth(duration: 0.3), value: m.streaming)
            .background(m.user ? Brand.tint : Brand.card, in: UnevenRoundedRectangle(topLeadingRadius: 22, bottomLeadingRadius: m.user ? 22 : 8, bottomTrailingRadius: m.user ? 8 : 22, topTrailingRadius: 22, style: .continuous))
            .contextMenu {
                if !m.text.isEmpty && !m.streaming {
                    Button { UIPasteboard.general.string = m.text } label: { Label("Copy message", systemImage: "doc.on.doc") }
                    if !m.user && m.reported == nil {
                        Button(action: report) { Label("Report reply", systemImage: "flag") }
                    }
                }
            }
            if !m.user { Spacer(minLength: 16) }
        }
        .frame(maxWidth: .infinity, alignment: m.user ? .trailing : .leading)
    }
}

/// While the coach answers: three dots, what it's doing, and after a while how long.
private struct Working: View {
    let m: ChatMsg

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.4)) { ctx in
            let seconds = Int(ctx.date.timeIntervalSince(m.started))
            let doing = m.steps.contains { !$0.done } ? "Looking it up…" : m.text.isEmpty ? "Thinking…" : "Writing…"
            let tick = Int(ctx.date.timeIntervalSinceReferenceDate / 0.4) % 3
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 5) {
                    ForEach(0..<3, id: \.self) { i in Circle().fill(Color.secondary).frame(width: 7, height: 7).opacity(i == tick ? 1 : 0.3) }
                    Text(seconds >= 10 ? "\(doing) \(seconds)s" : doing).font(.subheadline.weight(.medium)).foregroundStyle(.secondary)
                }
                if seconds >= 30 {
                    Text("Bigger questions can take a minute or two. You can leave the chat: the answer is kept and shows here when it's done.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .accessibilityElement(children: .combine)
        }
    }
}

/// A route in the chat: its line (north up, the start marked), name, distance, climb, scenery; a tap opens it.
private struct RouteCardInChat: View {
    let r: ChatRoute
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: 0) {
                ZStack(alignment: .topTrailing) {
                    Canvas { ctx, size in
                        guard r.preview.count > 1 else { return }
                        let xs = r.preview.map(\.0), ys = r.preview.map(\.1)
                        let minX = xs.min()!, maxX = xs.max()!, minY = ys.min()!, maxY = ys.max()!
                        // Longitude shrinks with latitude: keep the shape true.
                        let k = cos(((minY + maxY) / 2) * .pi / 180)
                        let w = max((maxX - minX) * k, 1e-6), h = max(maxY - minY, 1e-6)
                        let s = min((size.width - 24) / w, (size.height - 24) / h)
                        let ox = (size.width - w * s) / 2, oy = (size.height - h * s) / 2
                        func pt(_ p: (Double, Double)) -> CGPoint { CGPoint(x: ox + (p.0 - minX) * k * s, y: oy + (maxY - p.1) * s) }
                        var path = Path()
                        path.move(to: pt(r.preview[0]))
                        for p in r.preview.dropFirst() { path.addLine(to: pt(p)) }
                        ctx.stroke(path, with: .color(Brand.tint), style: StrokeStyle(lineWidth: 4, lineCap: .round, lineJoin: .round))
                        let start = pt(r.preview[0])
                        ctx.fill(Path(ellipseIn: CGRect(x: start.x - 6, y: start.y - 6, width: 12, height: 12)), with: .color(Brand.good))
                    }
                    .frame(height: 150)
                    .background(Brand.container.opacity(0.5))
                    .accessibilityLabel("Map of \(r.name)")
                    if r.onWatch {
                        Label("On your watch", systemImage: "watch.analog").font(.caption.weight(.semibold))
                            .padding(.horizontal, 10).padding(.vertical, 5).background(Brand.card, in: Capsule()).padding(10)
                    }
                }
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(r.name).font(.headline).lineLimit(2)
                        Text(["\(km1(r.km)) km", r.ascent.map { "\($0) m climb" }, r.loop ? "loop" : nil].compactMap { $0 }.joined(separator: " · ")).font(.subheadline).foregroundStyle(.secondary)
                        if let s = r.scenery { Text(s.prefix(1).uppercased() + s.dropFirst()).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                    }
                    Spacer(minLength: 4)
                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                }
                .padding(.horizontal, 14).padding(.vertical, 12)
            }
            .background(Brand.well)
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
        .buttonStyle(Press())
        .foregroundStyle(Color.primary)
        .accessibilityLabel("Open the route \(r.name)")
    }
}

/// Your other conversations.
private struct ChatHistory: View {
    let chat: ChatModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if chat.list.isEmpty { Text("No conversations yet.").foregroundStyle(.secondary) }
                ForEach(chat.list) { c in
                    Button {
                        dismiss()
                        Task { await chat.load(c.id) }
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(c.title).font(.headline).lineLimit(1)
                            Text(ago(c.updated)).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .foregroundStyle(Color.primary)
                    .listRowBackground(c.id == chat.conversation ? Brand.container.opacity(0.5) : nil)
                }
            }
            .navigationTitle("Conversations")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button { dismiss() } label: { Image(systemName: "xmark") }.accessibilityLabel("Close") }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

/// Report a coach's reply: why, a note, and whether to send it to Tartan's developer as a GitHub
/// issue you see before it's sent. Kept with the chat either way.
private struct ReportSheet: View {
    let chat: ChatModel
    let m: ChatMsg
    @Environment(\.dismiss) private var dismiss
    @State private var reason = "Wrong or unsafe advice"
    @State private var note = ""
    @State private var send = true
    private let reasons = ["Wrong or unsafe advice", "Made-up numbers", "Offensive or harmful", "Something else"]

    var body: some View {
        NavigationStack {
            Form {
                Picker("Why", selection: $reason) { ForEach(reasons, id: \.self) { Text($0).tag($0) } }
                    .pickerStyle(.inline)
                Section { TextField("What was wrong? (optional)", text: $note, axis: .vertical).lineLimit(2...5) }
                Section {
                    Toggle("Also send it to Tartan's developer: opens a GitHub issue you can check first.", isOn: $send)
                }
            }
            .navigationTitle("Report this reply")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Report") {
                        let r = reason, n = note, s = send
                        chat.report(m, reason: r, note: n) { question, reply, by in
                            guard s, let url = issueURL(reason: r, note: n, question: question, reply: reply, by: by) else { return }
                            UIApplication.shared.open(url)
                        }
                        dismiss()
                    }
                }
            }
        }
        .presentationDetents([.large])
    }
}

/// A reported reply as a GitHub issue, filled in (Android's Feedback.report).
private func issueURL(reason: String, note: String, question: String, reply: String, by: String?) -> URL? {
    let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
    var body = "**Why:** \(reason)\n"
    if !note.trimmingCharacters(in: .whitespaces).isEmpty { body += "**Note:** \(note.trimmingCharacters(in: .whitespaces))\n" }
    body += "**Answered by:** \(by ?? "?")\n**Tartan:** \(version), iOS \(UIDevice.current.systemVersion)\n\n**Asked:**\n"
    body += String(question.prefix(800)).components(separatedBy: "\n").map { "> \($0)" }.joined(separator: "\n")
    body += "\n\n**Reply:**\n" + String(reply.prefix(3000)).components(separatedBy: "\n").map { "> \($0)" }.joined(separator: "\n")
    var c = URLComponents(string: "https://github.com/sanjinpepic/Tartan/issues/new")
    c?.queryItems = [URLQueryItem(name: "title", value: String("Coach reply reported: \(reason)".prefix(120))), URLQueryItem(name: "body", value: String(body.prefix(5500))), URLQueryItem(name: "labels", value: "coach-report")]
    return c?.url
}
