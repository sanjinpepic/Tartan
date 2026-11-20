import SwiftUI
import MapKit
import CoreLocation
import UniformTypeIdentifiers

extension LngLat {
    var coord: CLLocationCoordinate2D { CLLocationCoordinate2D(latitude: lat, longitude: lng) }
    init(_ c: CLLocationCoordinate2D) {
        self.init(lng: (c.longitude * 1e6).rounded() / 1e6, lat: (c.latitude * 1e6).rounded() / 1e6)
    }
}

/// A line fitted into its frame with a margin, north up, the shape kept true (the list's little maps).
struct RouteLine: View {
    let points: [LngLat]
    var width: CGFloat = 3
    var startDot = false

    var body: some View {
        Canvas { ctx, size in
            guard points.count > 1 else { return }
            let xs = points.map(\.lng), ys = points.map(\.lat)
            let minX = xs.min()!, maxX = xs.max()!, minY = ys.min()!, maxY = ys.max()!
            // Longitude shrinks with latitude.
            let k = cos(((minY + maxY) / 2) * .pi / 180)
            let w = max((maxX - minX) * k, 1e-6), h = max(maxY - minY, 1e-6)
            let pad: CGFloat = 8
            let s = min((size.width - 2 * pad) / w, (size.height - 2 * pad) / h)
            let ox = (size.width - w * s) / 2, oy = (size.height - h * s) / 2
            func pt(_ p: LngLat) -> CGPoint { CGPoint(x: ox + (p.lng - minX) * k * s, y: oy + (maxY - p.lat) * s) }
            var path = Path()
            path.move(to: pt(points[0]))
            for p in points.dropFirst() { path.addLine(to: pt(p)) }
            ctx.stroke(path, with: .color(Brand.tint), style: StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round))
            if startDot {
                let a = pt(points[0])
                ctx.fill(Path(ellipseIn: CGRect(x: a.x - width - 3, y: a.y - width - 3, width: 2 * width + 6, height: 2 * width + 6)), with: .color(Brand.card))
                ctx.fill(Path(ellipseIn: CGRect(x: a.x - width - 1, y: a.y - width - 1, width: 2 * width + 2, height: 2 * width + 2)), with: .color(Brand.tint))
            }
        }
    }
}

/// Activities → Routes, native (web/views/routes.ts renderRoutes, as Android's RoutesScreen): a
/// loop of a distance from where you are, your routes with their line, distance, climb and
/// whether they're on the watch, a new one, a GPX file to import.
struct RoutesScreen: View {
    let shell: ShellModel
    let m: RoutesModel
    @State private var importing = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Picker("Show", selection: Binding(get: { 1 }, set: { if $0 == 0 { shell.go("activities") } })) {
                        Text("Workouts").tag(0)
                        Text("Routes").tag(1)
                    }
                    .pickerStyle(.segmented)
                    Button { shell.go("route/new") } label: {
                        Label("New route", systemImage: "plus").font(.headline).frame(maxWidth: .infinity).padding(.vertical, 4)
                    }
                    .buttonStyle(.glassProminent)
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                .listRowSeparator(.hidden)
                Section { loopCard }
                if let list = m.routes {
                    if list.isEmpty {
                        Section {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("No routes yet").font(.title3.weight(.bold))
                                Text("Tap the map to place points; the line follows paths and streets and shows the distance and climb as you go. Then send it to your watch.")
                                    .font(.subheadline).foregroundStyle(.secondary)
                                Button("Draw a route") { shell.go("route/new") }.buttonStyle(.glass)
                            }
                            .padding(.vertical, 8)
                        }
                    } else {
                        Section {
                            ForEach(list) { r in
                                Button { shell.go("route/\(r.id)") } label: { RouteRow(r: r) }
                                    .foregroundStyle(Color.primary)
                            }
                        } header: {
                            Text("Your routes").font(.headline).foregroundStyle(Color.primary).textCase(nil)
                        }
                    }
                } else {
                    Section { ProgressView().controlSize(.large).frame(maxWidth: .infinity, minHeight: 160) }.listRowBackground(Color.clear)
                }
                Section {
                    Button { importing = true } label: { Label("Import a GPX file", systemImage: "doc") }
                }
                .listRowBackground(Color.clear)
            }
            .listStyle(.insetGrouped)
            .listSectionSpacing(12)
            .scrollContentBackground(.hidden)
            .background(Brand.ground)
            .refreshable { m.forget(); m.ensure() }
            .onScrollGeometryChange(for: CGFloat.self) { g in g.contentOffset.y + g.contentInsets.top } action: { old, new in shell.scrolled(by: new - old, at: new) }
            .safeAreaInset(edge: .bottom, spacing: 0) { BarSpace(on: shell.navOn) }
            .navigationTitle("Activities")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { SyncChip(lanes: shell.board) { shell.openBoard() } }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { shell.go("settings") } label: { Image(systemName: "gearshape") }.accessibilityLabel("Settings")
                }
            }
            .onAppear { m.ensure() }
            .fileImporter(isPresented: $importing, allowedContentTypes: [UTType(filenameExtension: "gpx") ?? .xml, .xml, .data]) { result in
                guard case .success(let url) = result else { return }
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                guard let data = try? Data(contentsOf: url) else { shell.say("Couldn't read that file."); return }
                let text = String(decoding: data, as: UTF8.self)
                Task {
                    switch await m.importGpx(name: url.lastPathComponent, text: text) {
                    case .success(let r):
                        shell.say(r.said)
                        shell.go("route/\(r.id)")
                    case .failure(let e):
                        shell.say(e.message)
                    }
                }
            }
        }
    }

    private var loopCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("A loop from here", systemImage: "arrow.clockwise")
                .font(.title3.weight(.bold))
                .labelStyle(TintedIcon())
            Text("Three loops along paths from where you are; pick one, then send it to your watch.")
                .font(.subheadline).foregroundStyle(.secondary)
            HStack(spacing: 6) {
                ForEach([5, 8, 10, 15, 21], id: \.self) { k in
                    Button { shell.go("route/new/loop-\(k)") } label: {
                        Text("\(k) km").font(.subheadline.weight(.semibold)).lineLimit(1).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.glass)
                    .accessibilityLabel("A \(k) km loop")
                }
            }
        }
        .padding(.vertical, 6)
    }
}

/// A label whose icon is in the tint.
private struct TintedIcon: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 10) {
            configuration.icon.foregroundStyle(Brand.tint)
            configuration.title
        }
    }
}

/// A route's row: its line, name, distance, climb, loop, and whether it's on the watch.
private struct RouteRow: View {
    let r: RouteItem

    var body: some View {
        HStack(spacing: 14) {
            RouteLine(points: r.preview, width: 2.5, startDot: true)
                .frame(width: 64, height: 64)
                .background(Brand.well, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .accessibilityLabel("Map of \(r.name)")
            VStack(alignment: .leading, spacing: 3) {
                Text(r.name).font(.subheadline.weight(.semibold)).lineLimit(2)
                Text(["\(routeKm(r.metres)) km", r.ascent.map { "↑ \($0) m" }, r.loop ? "Loop" : nil].compactMap { $0 }.joined(separator: " · "))
                    .font(.subheadline).foregroundStyle(.secondary)
                if r.onWatch {
                    Label("On your watch", systemImage: "watch.analog").font(.caption.weight(.semibold)).foregroundStyle(Brand.good)
                }
            }
            Spacer(minLength: 4)
            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }
}

/// Where you are while the editor is open (asking once; not for the screenshots, which have it).
@MainActor
@Observable
final class Here {
    var at: LngLat?
    @ObservationIgnored private let lm = CLLocationManager()
    @ObservationIgnored private var delegate: HereDelegate?

    func start() {
        if delegate == nil { delegate = HereDelegate { [weak self] p in self?.at = p } }
        lm.delegate = delegate
        lm.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
        if lm.authorizationStatus == .notDetermined && !Launch.demo { lm.requestWhenInUseAuthorization() }
        // A remembered fix only if it's recent: an older one may be another city.
        if let l = lm.location, -l.timestamp.timeIntervalSinceNow < 600 { at = LngLat(l.coordinate) }
        lm.startUpdatingLocation()
    }

    func stop() { lm.stopUpdatingLocation() }
}

private final class HereDelegate: NSObject, CLLocationManagerDelegate {
    let fix: @MainActor (LngLat) -> Void
    init(_ fix: @escaping @MainActor (LngLat) -> Void) { self.fix = fix }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let c = locations.last?.coordinate else { return }
        let p = LngLat(c)
        Task { @MainActor in self.fix(p) }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        if manager.authorizationStatus == .authorizedWhenInUse || manager.authorizationStatus == .authorizedAlways { manager.startUpdatingLocation() }
    }
}

/// A km mark along the line.
private struct KmMark: Identifiable {
    let id: Int
    let at: LngLat
}

private func kmMarks(_ line: [LngLat]) -> [KmMark] {
    var out: [KmMark] = []
    var run = 0.0, next = 1000.0
    for i in line.indices.dropFirst() {
        let d = metres(line[i - 1], line[i])
        while d > 0 && run + d >= next {
            let t = (next - run) / d
            out.append(KmMark(id: Int(next / 1000), at: LngLat(lng: line[i - 1].lng + (line[i].lng - line[i - 1].lng) * t, lat: line[i - 1].lat + (line[i].lat - line[i - 1].lat) * t)))
            next += 1000
        }
        run += d
    }
    return out
}

private let COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"]
private func heading(_ deg: Double) -> String {
    let i = Int((((deg.truncatingRemainder(dividingBy: 360)) + 360).truncatingRemainder(dividingBy: 360) / 45).rounded()) % 8
    return COMPASS[i]
}
private let LOOP_COLOURS = [Brand.tint, Brand.fitness, Brand.good]

/**
 * The route editor, native: the map full screen (MapKit), the name, where you are and how the
 * line goes across the top, and the distance, climb, profile, tools and Save / Send at the
 * bottom. Tap to add a point; tap the start to close the loop, another point to take it out;
 * drag a point to move it.
 */
struct RouteEditorScreen: View {
    let shell: ShellModel
    let e: RouteEditor
    @State private var here = Here()
    @State private var camera: MapCameraPosition = .userLocation(fallback: .automatic)
    @State private var centre: CLLocationCoordinate2D?
    @State private var size: CGSize = .zero
    @State private var topH: CGFloat = 140
    @State private var bottomH: CGFloat = 300
    @State private var drag: (Int, CGSize)?
    @State private var pacing = false
    @State private var placed = false
    @State private var looped = false
    @FocusState private var naming: Bool

    var body: some View {
        ZStack {
            map
            VStack(spacing: 0) {
                top.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { topH = $0 }
                Spacer(minLength: 0)
                bottom.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { bottomH = $0 }
            }
            if e.missing {
                Card {
                    Text("This route isn't here any more").font(.title3.weight(.bold))
                    Button("Back to routes") { shell.go("routes") }.buttonStyle(.glass)
                }
                .padding(24)
            }
        }
        .onGeometryChange(for: CGSize.self) { $0.size } action: { size = $0 }
        .background(Brand.ground)
        .task { await e.load() }
        .onAppear { here.start() }
        .onDisappear { here.stop() }
        .onChange(of: e.fitTo) { _, v in
            guard let v, v.count >= 2 else { return }
            fit(v)
            e.fitTo = nil
        }
        .onChange(of: here.at) { _, p in
            guard let p else { return }
            // A new route opens where you are, once; loops asked for start from there.
            if e.id == "new" && e.wp.isEmpty && !placed { placed = true; fit([p]) }
            if e.wantLoop > 0 && !looped { looped = true; e.findLoops(e.wantLoop, from: p) }
        }
        .task {
            // Nowhere yet: the last view's place (home); loops asked for start from the map's middle.
            if e.id == "new", here.at == nil, let h = shell.routes.home {
                placed = true
                fit([h])
            }
            guard e.wantLoop > 0 else { return }
            try? await Task.sleep(for: .seconds(6))
            if !looped, let c = centre { looped = true; e.findLoops(e.wantLoop, from: LngLat(c)) }
        }
        .sheet(isPresented: $pacing) { PacingSheet(e: e).tint(Brand.tint) }
    }

    // MARK: the map

    private var map: some View {
        MapReader { proxy in
            Map(position: $camera, interactionModes: [.pan, .zoom]) {
                ForEach(Array(e.loops.enumerated()), id: \.offset) { k, l in
                    MapPolyline(coordinates: lineOf(l.legs.map { Seg("paths", $0) }).map(\.coord))
                        .stroke(LOOP_COLOURS[k % 3].opacity(0.85), style: StrokeStyle(lineWidth: 5, lineCap: .round, lineJoin: .round))
                }
                ForEach(e.segs) { s in
                    MapPolyline(coordinates: s.coords.map(\.coord))
                        .stroke(Color.white.opacity(0.9), style: StrokeStyle(lineWidth: 9, lineCap: .round, lineJoin: .round))
                }
                ForEach(e.segs) { s in
                    MapPolyline(coordinates: s.coords.map(\.coord))
                        .stroke(Brand.tint, style: StrokeStyle(lineWidth: 4.5, lineCap: .round, lineJoin: .round, dash: e.pending.contains(s.id) ? [2, 7] : []))
                }
                ForEach(kmMarks(e.line)) { k in
                    Annotation("", coordinate: k.at.coord, anchor: .center) {
                        Text("\(k.id)").font(.system(size: 10, weight: .bold).monospacedDigit())
                            .foregroundStyle(Brand.tint)
                            .frame(width: 18, height: 18)
                            .background(Brand.card, in: Circle())
                            .overlay(Circle().stroke(Brand.tint, lineWidth: 1.5))
                            .allowsHitTesting(false)
                    }
                }
                ForEach(Array(e.wp.enumerated()), id: \.offset) { i, p in
                    Annotation("", coordinate: p.coord, anchor: .center) {
                        dot(i, proxy: proxy)
                    }
                }
                UserAnnotation()
            }
            .mapStyle(.standard(elevation: .flat, pointsOfInterest: .excludingAll))
            .mapControls { MapScaleView() }
            .onMapCameraChange { ctx in centre = ctx.region.center }
            .onTapGesture(coordinateSpace: .local) { pt in tapped(pt, proxy: proxy) }
            .ignoresSafeArea()
        }
    }

    /** A point: the start ringed, the end filled; drag it to move it. */
    private func dot(_ i: Int, proxy: MapProxy) -> some View {
        let role = i == 0 ? "start" : i == e.wp.count - 1 ? "end" : "mid"
        let r: CGFloat = role == "mid" ? 7 : 9
        let off = drag?.0 == i ? drag?.1 ?? .zero : .zero
        return Circle()
            .fill(role == "end" ? Brand.tint : Brand.card)
            .overlay(Circle().stroke(Brand.tint, lineWidth: 2.5))
            .frame(width: 2 * r, height: 2 * r)
            .padding(10)
            .contentShape(Circle())
            .offset(off)
            .gesture(
                DragGesture(minimumDistance: 4, coordinateSpace: .global)
                    .onChanged { v in drag = (i, v.translation) }
                    .onEnded { v in
                        drag = nil
                        if let c = proxy.convert(v.location, from: .global) {
                            Haptics.feel("detent")
                            e.move(i, LngLat(c))
                        }
                    }
            )
            .accessibilityLabel(role == "start" ? "Start" : role == "end" ? "End" : "Point \(i + 1)")
    }

    /** A tap: on a point (the start closes the loop, any other comes out), else a new point. */
    private func tapped(_ pt: CGPoint, proxy: MapProxy) {
        naming = false
        let hit = e.wp.indices.min { a, b in dist(e.wp[a], pt, proxy) < dist(e.wp[b], pt, proxy) }.flatMap { dist(e.wp[$0], pt, proxy) < 26 ? $0 : nil }
        Haptics.feel("click")
        if let hit {
            if hit == 0 && e.wp.count > 1 { e.toStart() } else { e.remove(hit) }
        } else if let c = proxy.convert(pt, from: .local) {
            e.add(LngLat(c))
        }
    }

    private func dist(_ p: LngLat, _ pt: CGPoint, _ proxy: MapProxy) -> CGFloat {
        guard let q = proxy.convert(p.coord, to: .local) else { return .infinity }
        return hypot(q.x - pt.x, q.y - pt.y)
    }

    /** These points in view, between the bars at the top and the panel at the bottom. */
    private func fit(_ pts: [LngLat]) {
        guard !pts.isEmpty, size.width > 0 else { return }
        let mp = pts.map { MKMapPoint($0.coord) }
        let minX = mp.map(\.x).min()!, maxX = mp.map(\.x).max()!
        let minY = mp.map(\.y).min()!, maxY = mp.map(\.y).max()!
        // At least about a km and a half across, so a single point opens on its streets.
        let least = MKMapPointsPerMeterAtLatitude(pts[0].lat) * 1500
        let w = max(maxX - minX, least), h = max(maxY - minY, least)
        let W = size.width, H = size.height
        let visW = W - 48, visH = max(H - topH - bottomH - 32, 120)
        let s = max(w / visW, h / visH)
        let cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
        let cyScreen = topH + 16 + visH / 2
        let rect = MKMapRect(x: cx - W / 2 * s, y: cy - cyScreen * s, width: W * s, height: H * s)
        withAnimation(.smooth) { camera = .rect(rect) }
    }

    // MARK: across the top

    private var top: some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                Button {
                    if e.mayLeave() { shell.go("routes") }
                } label: {
                    Image(systemName: "chevron.left").font(.headline).frame(width: 44, height: 44)
                }
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
                .accessibilityLabel("Back to routes")
                TextField("Name this route", text: Binding(get: { e.name }, set: { e.name = String($0.prefix(80)); e.dirty = true }))
                    .focused($naming)
                    .submitLabel(.done)
                    .font(.body.weight(.medium))
                    .padding(.horizontal, 16)
                    .frame(height: 48)
                    .glassEffect(.regular, in: Capsule())
                Button {
                    if let p = here.at ?? shell.routes.home { fit([p]) } else { shell.say("Couldn't find where you are. Allow location for Tartan, or move the map by hand.") }
                } label: {
                    Image(systemName: "scope").font(.headline).frame(width: 44, height: 44)
                }
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
                .accessibilityLabel("Where am I")
            }
            Picker("How the line goes", selection: Binding(get: { e.mode }, set: { e.mode = $0 })) {
                Text("Follow paths").tag("paths")
                Text("Straight").tag("straight")
            }
            .pickerStyle(.segmented)
            .frame(maxWidth: 280)
            .padding(4)
            .glassEffect(.regular, in: Capsule())
        }
        .padding(.horizontal, 12)
        .padding(.top, 4)
    }

    // MARK: at the bottom

    private var statusLine: String? {
        if let s = e.status { return s }
        if !e.loaded { return nil }
        if e.wp.isEmpty { return here.at != nil ? "Tap the map where you start, or near your blue dot" : "Tap the map where you start" }
        if e.wp.count == 1 { return "Tap where you're heading" }
        if !e.pending.isEmpty { return "Finding the way…" }
        return nil
    }

    private var bottom: some View {
        GlassEffectContainer(spacing: 10) {
            VStack(spacing: 10) {
                loopBar
                if let s = statusLine {
                    Text(s).font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 16).padding(.vertical, 9)
                        .glassEffect(.regular, in: Capsule())
                        .transition(.opacity)
                }
                panel
            }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        .animation(.smooth(duration: 0.25), value: statusLine)
    }

    private var panel: some View {
        let h = e.heights
        let c = h.map(climb)
        let can = e.wp.count >= 2
        return VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .lastTextBaseline, spacing: 4) {
                Text(routeKm(e.total)).font(.figure(.largeTitle)).contentTransition(.numericText())
                Text("km").font(.headline).foregroundStyle(.secondary)
                Spacer()
                Text("↑ \(c.map { "\($0.up) m" } ?? "–")   ↓ \(c.map { "\($0.down) m" } ?? "–")")
                    .font(.subheadline.weight(.semibold).monospacedDigit()).foregroundStyle(.secondary)
            }
            if let h { Profile(line: e.line, h: h).frame(height: 56) }
            HStack(spacing: 0) {
                tool("arrow.uturn.backward", "Undo", e.canUndo) { e.undo() }
                tool("arrow.clockwise", "To start", can) { e.toStart() }
                tool("arrow.left.arrow.right", "Out & back", can) { e.outAndBack() }
                tool("arrow.up.arrow.down", "Reverse", can) { e.reverse() }
                tool("clock", "Race pace", can) { pacing = true }
            }
            HStack(spacing: 8) {
                Button { e.save() } label: {
                    Text(e.busy == "save" ? "Saving…" : "Save").font(.headline).frame(maxWidth: .infinity).padding(.vertical, 4)
                }
                .buttonStyle(.glassProminent)
                .disabled(!can || e.busy != nil)
                Button { e.send() } label: {
                    Label(e.busy == "send" ? "Sending…" : "Send to watch", systemImage: "watch.analog").font(.headline).lineLimit(1).frame(maxWidth: .infinity).padding(.vertical, 4)
                }
                .buttonStyle(.glass)
                .disabled(!can || e.busy != nil)
                Button { e.gpx() } label: {
                    Image(systemName: "doc").font(.headline).padding(.vertical, 4)
                }
                .buttonStyle(.glass)
                .disabled(!can || e.busy != nil)
                .accessibilityLabel("Share as GPX")
            }
        }
        .padding(16)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
    }

    private func tool(_ icon: String, _ label: String, _ on: Bool, _ action: @escaping () -> Void) -> some View {
        Button {
            Haptics.feel("click")
            action()
        } label: {
            VStack(spacing: 4) {
                Image(systemName: icon).font(.system(size: 18, weight: .medium)).frame(height: 22)
                Text(label).font(.caption2.weight(.medium)).lineLimit(1).minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(Press())
        .foregroundStyle(on ? Color.primary : Color.secondary.opacity(0.5))
        .disabled(!on)
    }

    /** Loops: before any point, a distance to ask for; with options on the map, pick one (A, B, C). */
    @ViewBuilder private var loopBar: some View {
        if !e.loops.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Pick a loop").font(.headline)
                    Spacer()
                    Button("None") { e.loops = [] }.font(.subheadline.weight(.semibold))
                }
                ForEach(Array(e.loops.enumerated()), id: \.offset) { k, l in
                    Button { e.pick(l) } label: {
                        HStack(spacing: 10) {
                            Text(["A", "B", "C"].indices.contains(k) ? ["A", "B", "C"][k] : "\(k + 1)")
                                .font(.subheadline.weight(.bold)).foregroundStyle(.white)
                                .frame(width: 28, height: 28).background(LOOP_COLOURS[k % 3], in: Circle())
                            Text("\(String(format: "%.1f", l.km)) km \(heading(l.bearing))").font(.body)
                            Spacer()
                        }
                        .padding(8)
                        .background(Brand.well, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(Press())
                    .foregroundStyle(Color.primary)
                }
            }
            .padding(14)
            .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        } else if e.wp.isEmpty && e.loaded {
            VStack(alignment: .leading, spacing: 8) {
                Text("Or a loop from here").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                HStack(spacing: 6) {
                    ForEach(Array(Set([5, 10, 15, 21] + (e.wantLoop > 0 ? [e.wantLoop] : []))).sorted(), id: \.self) { k in
                        Button {
                            guard let start = here.at ?? centre.map({ LngLat($0) }) else { return }
                            e.findLoops(k, from: start)
                        } label: {
                            Text(e.finding == k ? "Finding…" : "\(k) km").font(.subheadline.weight(.semibold)).lineLimit(1).frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.glass)
                        .disabled(e.finding != nil)
                    }
                }
            }
            .padding(14)
            .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        }
    }
}

/// The heights along the route, highest and lowest marked.
private struct Profile: View {
    let line: [LngLat]
    let h: [Double]

    var body: some View {
        ZStack(alignment: .topLeading) {
            Canvas { ctx, size in
                let d = along(line)
                let lo = h.min() ?? 0, hi = max(h.max() ?? 0, lo + 20)
                let total = max(d.last ?? 1, 1)
                let step = max(1, line.count / 300)
                let idx = h.indices.filter { $0 % step == 0 || $0 == h.count - 1 }
                func x(_ i: Int) -> CGFloat { d[i] / total * size.width }
                func y(_ v: Double) -> CGFloat { size.height - 4 - (v - lo) / (hi - lo) * (size.height - 12) }
                var area = Path()
                area.move(to: CGPoint(x: 0, y: size.height))
                for i in idx { area.addLine(to: CGPoint(x: x(i), y: y(h[i]))) }
                area.addLine(to: CGPoint(x: size.width, y: size.height))
                area.closeSubpath()
                ctx.fill(area, with: .color(Brand.tint.opacity(0.18)))
                var l = Path()
                for (k, i) in idx.enumerated() {
                    if k == 0 { l.move(to: CGPoint(x: x(i), y: y(h[i]))) } else { l.addLine(to: CGPoint(x: x(i), y: y(h[i]))) }
                }
                ctx.stroke(l, with: .color(Brand.tint), lineWidth: 2)
            }
            VStack(alignment: .leading) {
                Text("\(Int((h.max() ?? 0).rounded())) m")
                Spacer()
                Text("\(Int((h.min() ?? 0).rounded())) m")
            }
            .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Heights from \(Int((h.min() ?? 0).rounded())) to \(Int((h.max() ?? 0).rounded())) metres")
    }
}

/// Race pacing: even effort over this course's hills for a target time; to the watch as a course or a workout.
private struct PacingSheet: View {
    let e: RouteEditor
    @State private var time = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    TextField("Target time, e.g. 1:45:00 or 48:30", text: $time)
                        .keyboardType(.numbersAndPunctuation)
                        .submitLabel(.go)
                        .onSubmit { if !time.isEmpty { e.pace(time) } }
                    Button(e.busy == "pace" ? "Working it out…" : "Work it out") { e.pace(time) }
                        .disabled(time.trimmingCharacters(in: .whitespaces).isEmpty || e.busy != nil)
                } footer: {
                    Text("\(e.name.isEmpty ? "This route" : e.name) · \(routeKm(e.total)) km")
                }
                if let sp = e.splits {
                    Section {
                        ForEach(sp) { s in
                            HStack {
                                Text(s.metres < 1000 ? "\(s.km - 1)–\(String(format: "%.1f", Double(s.km - 1) + s.metres / 1000))" : "\(s.km)")
                                    .frame(width: 60, alignment: .leading)
                                Spacer()
                                Text("\(clock(Int(s.paceS.rounded()))) /km").frame(width: 84, alignment: .trailing)
                                Text(clock(Int(s.cumulativeS.rounded()))).frame(width: 72, alignment: .trailing)
                                Text(s.climbM > 0 ? "↑\(s.climbM) m" : "").foregroundStyle(.secondary).frame(width: 56, alignment: .trailing)
                            }
                            .font(.subheadline.monospacedDigit())
                        }
                    } header: {
                        Text(e.heights != nil ? "Even effort: slower up the climbs, quicker down them, so the hills cost what they should." : "No heights for this course yet, so an even pace.")
                            .textCase(nil)
                    }
                    Section {
                        Button("Course with splits") { e.courseToWatch() }.disabled(e.busy != nil)
                        Button("Pacing workout") { e.splitsToWatch() }.disabled(e.busy != nil)
                    } footer: {
                        Text("The course goes with a named point every km (\"5k 24:10\"); the workout guides each km at its pace, ±5 s.")
                    }
                }
                if let l = e.pacingLine {
                    Section { Text(l) }
                }
            }
            .navigationTitle("Race pacing")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }.accessibilityLabel("Close")
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
