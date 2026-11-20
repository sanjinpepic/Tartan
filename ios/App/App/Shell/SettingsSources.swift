import SwiftUI
import UniformTypeIdentifiers

/// An action that's costly or hard to undo: the first tap says what happens, the second does it (4 s).
struct TwoTap: View {
    let label: String
    let again: String
    var danger = false
    var enabled = true
    let run: () -> Void
    @State private var armed = false

    var body: some View {
        Button(role: danger || armed ? .destructive : nil) {
            if armed { armed = false; run() } else { armed = true; Haptics.feel("detent") }
        } label: { Text(armed ? again : label) }
        .disabled(!enabled)
        .task(id: armed) {
            guard armed else { return }
            try? await Task.sleep(for: .seconds(4))
            armed = false
        }
    }
}

/**
 * Settings → Sources, native (Android's SourcesGroup, web/views/sync.ts): Strava, the watch,
 * intervals.icu, workout files from other apps, sending watch workouts to Strava, and where the
 * plan goes for your watch. Bluetooth and the sign-ins are the page's work (`rpc:…`).
 */
struct SourcesGroup: View {
    let shell: ShellModel
    @State private var flow: String?
    @State private var importing = false

    private var s: SourcesModel { shell.sources }

    var body: some View {
        stravaSection
        watchSection
        icuSection
        Section {
            Button { importing = true } label: {
                Label(s.busy == "import" ? "Importing…" : "Import workout files", systemImage: "plus")
            }
            .disabled(s.busy == "import")
        } header: { Text("Workout files") } footer: { Text("Share a workout to Tartan, or import a .fit, .gpx or .tcx file (Garmin Connect: ⋯ → Export Original).") }
        .fileImporter(isPresented: $importing, allowedContentTypes: [UTType(filenameExtension: "fit") ?? .data, UTType(filenameExtension: "gpx") ?? .xml, UTType(filenameExtension: "tcx") ?? .xml, .data], allowsMultipleSelection: true) { r in
            if case .success(let urls) = r { s.importFiles(urls) }
        }
        if let w = s.sendWatch { sendWatchSection(w) }
        PlanWatchSection(shell: shell)
            .onAppear { s.ensure() }
            .fullScreenCover(isPresented: Binding(get: { flow == "strava" }, set: { if !$0 { flow = nil } })) { StravaFlow(s: s) { flow = nil } }
            .fullScreenCover(isPresented: Binding(get: { flow == "watch" }, set: { if !$0 { flow = nil } })) { WatchFlow(s: s) { flow = nil } }
            .sheet(isPresented: Binding(get: { flow == "icu" }, set: { if !$0 { flow = nil } })) { IcuFlow(s: s) { flow = nil } }
    }

    // MARK: Strava

    @ViewBuilder private var stravaSection: some View {
        let st = s.strava
        Section {
            if let st {
                if st.connected {
                    Button { s.stravaSync(full: false) } label: { Label("Sync now", systemImage: "arrow.triangle.2.circlepath") }
                        .disabled(s.busy == "strava")
                    TwoTap(label: "Fetch full history again", again: "Tap again: it takes a few hours", enabled: s.busy != "strava") { s.stravaSync(full: true) }
                    if s.busy == "strava" { ProgressView().frame(maxWidth: .infinity, alignment: .leading) }
                    if !st.canUpload {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("To send runs you record on the phone to Strava, Tartan needs Strava's OK to upload.").font(.subheadline)
                            Button { s.stravaConnect(id: nil, secret: nil) } label: { Label("Allow uploads", systemImage: "arrow.up") }
                                .buttonStyle(.glass)
                                .disabled(s.busy == "strava")
                        }
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        Text("\(st.detailed) of \(st.activities) activities have full detail (laps, splits, time series).").font(.subheadline)
                        ProgressView(value: st.activities > 0 ? Double(st.detailed) / Double(st.activities) : 0)
                    }
                    if st.rateLimited {
                        Text("Paused at Strava's rate limit (about 100 requests per 15 minutes). Sync again later; it continues where it stopped.").font(.footnote).foregroundStyle(.secondary)
                    }
                    if !s.syncLines.isEmpty {
                        DisclosureGroup("What the last sync did") {
                            Text(s.syncLines.joined(separator: "\n")).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                        }
                    }
                } else {
                    Text("Your whole history, with laps and heart rate, straight to this phone. About 5 minutes, once.").font(.subheadline).foregroundStyle(.secondary)
                    Button { flow = "strava" } label: {
                        Label(st.configured ? "Finish connecting Strava" : "Connect Strava", systemImage: "link").font(.headline).frame(maxWidth: .infinity, minHeight: 36)
                    }
                    .buttonStyle(.glassProminent)
                }
            } else {
                ProgressView()
            }
        } header: {
            Label("Strava", systemImage: "figure.run").labelStyle(.titleOnly)
        } footer: {
            if let st, st.connected {
                let last = st.lastSync.map { ago($0) } ?? "never"
                Text(st.name.isEmpty ? "Connected · syncs by itself · last \(last)" : "Connected as \(st.name) · syncs by itself · last \(last)")
            }
        }
    }

    // MARK: The watch

    @ViewBuilder private var watchSection: some View {
        let w = s.watch
        Section {
            if let w, w.connected {
                ForEach(w.facts.filter { $0.count == 2 && ["Watch", "Battery", "Firmware"].contains($0[0]) }, id: \.self) { f in
                    LabeledContent(f[0], value: f[1])
                }
                Button { s.watchBackupFolder("/", force: false) } label: { Label("Back up now", systemImage: "arrow.triangle.2.circlepath") }
                    .disabled(w.running)
                TwoTap(label: "Disconnect", again: "Tap again to disconnect", danger: true) { s.watchDisconnect() }
            } else if w?.connecting == true {
                HStack(spacing: 10) { ProgressView(); Text("Connecting to the watch…") }
            } else {
                Text("Every workout file, straight off your wrist. Already paired with this phone? Then there's no code.").font(.subheadline).foregroundStyle(.secondary)
                Button { flow = "watch" } label: {
                    Label("Connect your watch", systemImage: "watch.analog").font(.headline).frame(maxWidth: .infinity, minHeight: 36)
                }
                .buttonStyle(.glassProminent)
                .disabled(s.busy == "watch")
            }
            if let w, w.logbook || (!w.connected && w.noFileAccess) {
                Text("This watch hands over workouts from its logbook, the way the Suunto app syncs them. Only workouts the Suunto app hasn't synced yet are there, so Tartan reads them first when it can; it never marks them as synced.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if let j = w?.job {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text(j.title).font(.subheadline.weight(.semibold))
                        Spacer()
                        if w?.running == true { Button("Stop") { s.watchCancel() }.font(.subheadline) }
                    }
                    if let v = j.value { ProgressView(value: min(1, max(0, v / (j.max ?? 1)))) } else { ProgressView().frame(maxWidth: .infinity, alignment: .leading) }
                    Text(j.text).font(.footnote).foregroundStyle(.secondary)
                }
            }
            if let w, w.connected {
                NavigationLink {
                    WatchFiles(s: s)
                } label: { Label("Browse the watch's files", systemImage: "folder") }
            }
        } header: { Text("Watch") } footer: {
            if let w, w.connected { Text("Connected to \(w.name)") }
        }
    }

    // MARK: intervals.icu

    @ViewBuilder private var icuSection: some View {
        let i = s.icu
        Section {
            if let i, i.connected {
                Button { s.icuSyncNow() } label: { Label("Sync now", systemImage: "arrow.triangle.2.circlepath") }
                    .disabled(s.busy == "icu")
                TwoTap(label: "Disconnect", again: "Tap again to disconnect", danger: true) { s.icuStop() }
                if s.busy == "icu" { ProgressView().frame(maxWidth: .infinity, alignment: .leading) }
                if let l = i.line { Text(l).font(.footnote).foregroundStyle(.secondary) }
            } else {
                Button { flow = "icu" } label: { Label("Connect intervals.icu", systemImage: "key") }
            }
        } header: { Text("intervals.icu") } footer: {
            if let i, i.connected {
                Text(i.name.map { "Connected as \($0) · \(i.workouts) workouts · syncs by itself" } ?? "Connected · \(i.workouts) workouts · syncs by itself")
            } else {
                Text("Not connected. Brings in Garmin, Coros, Polar and others.")
            }
        }
    }

    // MARK: Watch workouts to Strava

    private func sendWatchSection(_ w: SendWatchNow) -> some View {
        Section {
            Toggle(isOn: Binding(get: { w.enabled }, set: { s.setSendWatch($0) })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Send them")
                    Text("When a watch sync brings in a workout Strava doesn't have, Tartan uploads it. Only workouts from when you turn this on. Leave it off if the Suunto app already sends your workouts to Strava.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            if w.enabled {
                let since = w.since.flatMap(dateOf).map { $0.formatted(.dateTime.day().month(.abbreviated)) }
                Text(!w.connected ? "Connect Strava above first."
                     : !w.canUpload ? "Strava hasn't allowed uploads yet: tap Allow uploads on the Strava card."
                     : w.sent > 0 ? "\(w.sent) sent since \(since ?? "then")\(w.lastName.map { " · last: \($0)" } ?? "")."
                     : "On since \(since ?? "now"). Nothing needed sending yet.")
                    .font(.footnote).foregroundStyle(.secondary)
                if let e = w.error { Text(e).font(.footnote).foregroundStyle(.red) }
            }
        } header: { Text("Send watch workouts to Strava") }
    }
}

/// The watch's files, for the curious: folders to open, a file to save, a folder to back up.
private struct WatchFiles: View {
    let s: SourcesModel
    @State private var force = false

    var body: some View {
        let w = s.watch
        List {
            if let w {
                Section {
                    ForEach(w.dirs, id: \.self) { d in
                        Button { s.watchBrowse(w.cwd.hasSuffix("/") ? w.cwd + d : w.cwd + "/" + d) } label: {
                            Label("\(d)/", systemImage: "folder").font(.body.monospaced())
                        }
                    }
                    ForEach(w.files, id: \.self) { f in
                        HStack {
                            Text(f).font(.footnote.monospaced())
                            Spacer()
                            Button("Save") { s.watchSave(w.cwd.hasSuffix("/") ? w.cwd + f : w.cwd + "/" + f) }.buttonStyle(.borderless)
                        }
                    }
                    if w.dirs.isEmpty && w.files.isEmpty { Text("This folder is empty.").foregroundStyle(.secondary) }
                } header: { Text("watch\(w.cwd == "/" ? "" : w.cwd)").textCase(nil) }
                Section {
                    Toggle(isOn: $force) {
                        VStack(alignment: .leading) { Text("Download files again"); Text("Even if I have them").font(.footnote).foregroundStyle(.secondary) }
                    }
                    Button("Back up this folder") { s.watchBackupFolder(w.cwd, force: force) }.disabled(w.running)
                    if w.cwd != "/" {
                        Button { s.watchBrowse("/") } label: { Label("Back to the top", systemImage: "arrow.up") }
                    }
                }
            }
        }
        .navigationTitle("The watch's files")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { s.watchBrowse(w?.cwd ?? "/") }
    }
}

/// Where the plan goes for your watch (Android's PlanWatchCard): Suunto over Bluetooth, Garmin and
/// others through intervals.icu, or the week as .fit files for any watch.
struct PlanWatchSection: View {
    let shell: ShellModel
    @AppStorage("tartan.plan.dest") private var dest = "suunto"
    @State private var out: J?
    @State private var busy: String?
    @State private var line: String?

    var body: some View {
        let icu = out?["intervals"]
        Section {
            ForEach(Array([("suunto", "Suunto", "Over Bluetooth, as guided workouts."),
                           ("intervals", "Garmin and others", "Through intervals.icu, which passes it to your watch's account."),
                           ("files", "Any watch", "The week as .fit files, to open in your watch's app.")].enumerated()), id: \.offset) { _, c in
                Button {
                    dest = c.0
                    line = nil
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: dest == c.0 ? "checkmark.circle.fill" : "circle").foregroundStyle(dest == c.0 ? Brand.tint : Color.secondary).font(.title3)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(c.1)
                            Text(c.2).font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                }
                .foregroundStyle(Color.primary)
            }
            switch dest {
            case "intervals":
                if icu?["connected"].bool != true {
                    Text("Connect intervals.icu above first.").font(.footnote).foregroundStyle(.secondary)
                } else {
                    if icu?["on"].bool == true { Text("Kept up to date on intervals.icu.").font(.footnote).foregroundStyle(.secondary) }
                    act("Send", "intervals")
                    if icu?["on"].bool == true { act("Stop", "intervalsOff") }
                }
            case "files": act("Save", "files")
            default:
                Text("The Coach tab sends the coming week; Settings → Watch has the reminders on it.").font(.footnote).foregroundStyle(.secondary)
            }
            if dest != "intervals" && icu?["on"].bool == true {
                HStack {
                    Text("Also kept up to date on intervals.icu.").font(.footnote).foregroundStyle(.secondary)
                    Spacer()
                    act("Stop", "intervalsOff")
                }
            }
            if let line { Text(line).font(.footnote).foregroundStyle(.secondary) }
        } header: { Text("Plan on your watch") }
        .task { await read() }
    }

    private func read() async {
        if case .success(let j) = await shell.engine.rpc("planOut", ["op": "state"]) { out = J(json: j) }
    }

    private func act(_ label: String, _ op: String) -> some View {
        Button {
            busy = op
            Task {
                switch await shell.engine.rpc("planOut", ["op": op]) {
                case .success(let j):
                    let o = J(json: j)
                    line = o["error"].str ?? o["line"].str ?? "It didn't go through. Try again."
                    if o["error"].isNull { out = o }
                case .failure(let e): line = e.message
                }
                busy = nil
            }
        } label: {
            HStack(spacing: 8) {
                if busy == op { ProgressView() }
                Text(label)
            }
        }
        .disabled(busy != nil)
    }
}
