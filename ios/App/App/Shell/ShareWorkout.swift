import SwiftUI
import UIKit
import MapKit
import PhotosUI

/// A workout's share picture (Android's ShareCard.workout and ShareWorkout.kt are the reference):
/// 1080 × 1350, the route big at the top, then the name and day, distance, time, pace (or speed)
/// and heart rate. Behind it the colour (as every share picture), a street map or a photo, chosen
/// in a preview before it goes. Nothing is uploaded by Tartan: the map comes from Apple's maps,
/// as the map under the workout's route does.

/// What's behind the picture.
enum ShareBackground: String, CaseIterable {
    case colour, map, photo

    var label: String {
        switch self {
        case .colour: return "Colour"
        case .map: return "Map"
        case .photo: return "Photo"
        }
    }

    /// A map only with a route; a photo always (with no route, no line).
    static func choices(_ w: Workout) -> [ShareBackground] { w.route.count >= 2 ? [.colour, .map, .photo] : [.colour, .photo] }
}

/// A street map the size of the picture, and the route's points on it (in the picture's points).
struct CardStreets {
    let image: UIImage
    let points: [CGPoint]
}

/// The picture's size in points (drawn at 3×), and where the route goes: the top, over the words.
private let cardSize = CGSize(width: 360, height: 450)
private let routeBox = CGRect(x: 32, y: 32, width: 296, height: 181)

/// The route without about its first and last `metres` (where a run starts and ends is often
/// home): what a map shows of it. A short one keeps its middle half.
func trimEnds(_ route: [(lat: Double, lon: Double)], metres: Double = 200) -> [(lat: Double, lon: Double)] {
    guard route.count >= 3 else { return route }
    var along = [0.0]
    for i in 1..<route.count {
        let a = CLLocation(latitude: route[i - 1].lat, longitude: route[i - 1].lon)
        let b = CLLocation(latitude: route[i].lat, longitude: route[i].lon)
        along.append(along[i - 1] + a.distance(from: b))
    }
    let total = along.last ?? 0
    let cut = total >= metres * 4 ? metres : total / 4
    let kept = route.indices.filter { along[$0] >= cut && along[$0] <= total - cut }.map { route[$0] }
    return kept.count >= 2 ? kept : Array(route[(route.count / 2 - 1)...(route.count / 2)])
}

/// At most `n` points, evenly picked (the first and last kept).
private func thin(_ r: [(lat: Double, lon: Double)], _ n: Int) -> [(lat: Double, lon: Double)] {
    guard r.count > n else { return r }
    return (0..<n).map { r[$0 * (r.count - 1) / (n - 1)] }
}

/// The route fitted into the route box: equirectangular, east–west squeezed by latitude.
private func fitted(_ route: [(lat: Double, lon: Double)]) -> [CGPoint] {
    guard route.count >= 2 else { return [] }
    let lats: [Double] = route.map { $0.lat }
    let mean: Double = lats.reduce(0.0, +) / Double(route.count)
    let k: Double = cos(mean * Double.pi / 180.0)
    let xs: [Double] = route.map { $0.lon * k }
    let ys: [Double] = route.map { -$0.lat }
    let x0: Double = xs.min()!, x1: Double = xs.max()!, y0: Double = ys.min()!, y1: Double = ys.max()!
    let bw = Double(routeBox.width), bh = Double(routeBox.height)
    let sx: Double = bw / max(1e-9, x1 - x0)
    let sy: Double = bh / max(1e-9, y1 - y0)
    let s: Double = min(sx, sy)
    let ox: Double = Double(routeBox.minX) + (bw - (x1 - x0) * s) / 2
    let oy: Double = Double(routeBox.minY) + (bh - (y1 - y0) * s) / 2
    return route.indices.map { i -> CGPoint in
        let x: Double = ox + (xs[i] - x0) * s
        let y: Double = oy + (ys[i] - y0) * s
        return CGPoint(x: x, y: y)
    }
}

/// The map behind the picture: the whole card, dark and muted (tinted in the picture's colour
/// when drawn), with the route framed in the route box. Nil offline.
@MainActor
func cardStreets(_ route: [(lat: Double, lon: Double)]) async -> CardStreets? {
    let line = thin(route, 600)
    guard line.count >= 2 else { return nil }
    let coords = line.map { CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lon) }
    let pts = coords.map { MKMapPoint($0) }
    let xs: [Double] = pts.map { $0.x }, ys: [Double] = pts.map { $0.y }
    let minX: Double = xs.min()!, maxX: Double = xs.max()!
    let minY: Double = ys.min()!, maxY: Double = ys.max()!
    // Points per map point, so the route fills the box (no closer than a few streets).
    let kx: Double = Double(routeBox.width) / max(maxX - minX, 400.0)
    let ky: Double = Double(routeBox.height) / max(maxY - minY, 400.0)
    let k: Double = min(kx, ky)
    let cx: Double = (minX + maxX) / 2, cy: Double = (minY + maxY) / 2
    let rx: Double = cx - Double(routeBox.midX) / k
    let ry: Double = cy - Double(routeBox.midY) / k
    let rect = MKMapRect(x: rx, y: ry, width: Double(cardSize.width) / k, height: Double(cardSize.height) / k)
    let o = MKMapSnapshotter.Options()
    o.mapRect = rect
    o.size = cardSize
    o.traitCollection = UITraitCollection { t in t.displayScale = 3; t.userInterfaceStyle = .dark }
    let config = MKStandardMapConfiguration(elevationStyle: .flat, emphasisStyle: .muted)
    config.pointOfInterestFilter = .excludingAll
    o.preferredConfiguration = config
    do {
        let snap = try await MKMapSnapshotter(options: o).start()
        return CardStreets(image: snap.image, points: coords.map { snap.point(for: $0) })
    } catch {
        return nil
    }
}

/// The picture itself (rendered with renderPicture: 360 points wide is 1080 pixels).
struct WorkoutPicture: View {
    let w: Workout
    var streets: CardStreets? = nil
    var photo: UIImage? = nil
    /// The route's start as a dot (not when its ends are hidden).
    var ends = true

    private var points: [CGPoint] { streets?.points ?? (w.route.count >= 2 ? fitted(thin(w.route, 600)) : []) }
    private var onPicture: Bool { streets != nil || photo != nil }

    var body: some View {
        ZStack(alignment: .topLeading) {
            backdrop
            if onPicture { scrim }
            route
            words
        }
        .frame(width: cardSize.width, height: cardSize.height)
        .clipped()
    }

    @ViewBuilder private var backdrop: some View {
        if let s = streets {
            ZStack {
                Image(uiImage: s.image).resizable().frame(width: cardSize.width, height: cardSize.height)
                // The picture's colour over the streets, as Android's map in the card's own colour.
                LinearGradient(colors: [shareTop, shareBottom], startPoint: .top, endPoint: .bottom).opacity(0.5)
            }
        } else if let p = photo {
            Image(uiImage: p).resizable().scaledToFill().frame(width: cardSize.width, height: cardSize.height).clipped()
        } else {
            LinearGradient(colors: [shareTop, shareBottom], startPoint: .top, endPoint: .bottom)
        }
    }

    /// The lower part darkened (and a little at the top for a photo's route), so white reads on any picture.
    private var scrim: some View {
        ZStack(alignment: .top) {
            LinearGradient(stops: [.init(color: .black.opacity(0), location: 0.42), .init(color: .black.opacity(0.5), location: 0.56), .init(color: .black.opacity(0.72), location: 0.78), .init(color: .black.opacity(0.8), location: 1)], startPoint: .top, endPoint: .bottom)
            if photo != nil && w.route.count >= 2 {
                LinearGradient(colors: [.black.opacity(0.3), .black.opacity(0)], startPoint: .top, endPoint: .bottom).frame(height: 240)
            }
        }
        .frame(width: cardSize.width, height: cardSize.height)
    }

    @ViewBuilder private var route: some View {
        let pts = points
        if pts.count >= 2 {
            Canvas { ctx, _ in
                var path = Path()
                path.addLines(pts)
                ctx.stroke(path, with: .color(.black.opacity(onPicture ? 0.35 : 0.2)), style: StrokeStyle(lineWidth: 10, lineCap: .round, lineJoin: .round))
                ctx.stroke(path, with: .color(.white), style: StrokeStyle(lineWidth: 4.7, lineCap: .round, lineJoin: .round))
                if ends { ctx.fill(Path(ellipseIn: CGRect(x: pts[0].x - 5.3, y: pts[0].y - 5.3, width: 10.6, height: 10.6)), with: .color(.white)) }
            }
            .frame(width: cardSize.width, height: cardSize.height)
        } else if !onPicture {
            // No route (a treadmill, the gym): the sport's name big instead.
            Text(sportTitle(w.sport)).font(.system(size: 50, weight: .bold, design: .rounded)).foregroundStyle(.white.opacity(0.25))
                .lineLimit(1).minimumScaleFactor(0.5)
                .padding(.leading, 32).padding(.top, 125)
        }
    }

    private var words: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(String((w.name ?? sportTitle(w.sport)).prefix(28))).font(.system(size: 21, weight: .bold, design: .rounded)).lineLimit(1)
            Text(day).font(.system(size: 12.7, design: .rounded)).opacity(0.8).padding(.top, 2)
            Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 12) {
                ForEach(Array(stride(from: 0, to: stats.count, by: 2)), id: \.self) { i in
                    GridRow {
                        stat(stats[i])
                        if i + 1 < stats.count { stat(stats[i + 1]) } else { Color.clear.frame(width: 1, height: 1) }
                    }
                }
            }
            .padding(.top, 10)
            Spacer(minLength: 0)
            // On the map, Apple's logo (its credit, in the snapshot) has the bottom left: the mark goes right.
            HStack(alignment: .firstTextBaseline) {
                if streets != nil { Spacer() }
                Text("Tartan").font(.system(size: 13.3, weight: .bold, design: .rounded)).opacity(0.8)
                if streets == nil { Spacer() }
            }
        }
        .foregroundStyle(.white)
        .padding(EdgeInsets(top: 230, leading: 24, bottom: 18, trailing: 24))
        .frame(width: cardSize.width, height: cardSize.height, alignment: .topLeading)
    }

    private func stat(_ s: (String, String)) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(s.0).font(.system(size: 36, weight: .bold, design: .rounded).monospacedDigit()).lineLimit(1).minimumScaleFactor(0.6)
            Text(s.1.uppercased()).font(.system(size: 10.7, weight: .bold, design: .rounded)).tracking(0.9).opacity(0.7)
        }
        .frame(width: 160, alignment: .leading)
    }

    private var stats: [(String, String)] {
        var out: [(String, String)] = []
        if let d = w.distanceKm, d > 0 { out.append((String(format: "%.2f", d), "km")) }
        if let m = w.movingMin, m > 0 { out.append((clock(Int((m * 60).rounded())), "time")) }
        if w.isRun, let p = w.pace { out.append((p, "per km")) } else if let s = w.speedKmh { out.append((String(format: "%.1f", s), "km/h")) }
        if let h = w.avgHr { out.append(("\(h)", "avg bpm")) }
        return Array(out.prefix(4))
    }

    private var day: String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = TimeZone(identifier: "UTC")
        guard let d = f.date(from: String((w.startLocal ?? w.start).prefix(10))) else { return String(w.start.prefix(10)) }
        return d.formatted(Date.FormatStyle(timeZone: TimeZone(identifier: "UTC")!).weekday(.wide).day().month(.wide))
    }
}

/// The preview before a workout goes: the picture as it will look, Colour / Map / Photo, then
/// Share. Photo opens the photo picker (or the camera). The choice is kept on this phone; the map
/// hides the route's start and finish unless you show them.
struct ShareWorkoutSheet: View {
    let w: Workout
    @AppStorage("tartan.shareBackground") private var stored = ShareBackground.colour.rawValue
    @State private var bg: ShareBackground = .colour
    @State private var before: ShareBackground = .colour
    @State private var started = false
    @State private var photo: UIImage?
    @State private var photoN = 0
    @State private var item: PhotosPickerItem?
    @State private var picking = false
    @State private var shooting = false
    @State private var hideEnds = true
    @State private var maps: [Bool: CardStreets] = [:]
    @State private var loading = false
    @State private var mapFailed = false
    @State private var picture: UIImage?
    @Environment(\.dismiss) private var dismiss

    private var choices: [ShareBackground] { ShareBackground.choices(w) }
    private var camera: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    ZStack {
                        if let p = picture {
                            Image(uiImage: p).resizable().scaledToFit()
                        } else {
                            Color.clear.aspectRatio(0.8, contentMode: .fit)
                        }
                        if loading { ProgressView().controlSize(.large).tint(.white) }
                    }
                    .frame(maxWidth: 420)
                    .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
                    .frame(maxWidth: .infinity)
                    .accessibilityElement()
                    .accessibilityLabel("The picture to share")
                    Picker("Background", selection: Binding(get: { bg }, set: { choose($0) })) {
                        ForEach(choices, id: \.self) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    if mapFailed {
                        Text("The map didn't load. You may be offline.").font(.subheadline).foregroundStyle(.secondary).padding(.horizontal, 4)
                    }
                    if bg == .map {
                        Toggle(isOn: $hideEnds) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Hide start and finish")
                                Text("About 200 m at each end stays off the map.").font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                        .padding(.horizontal, 4)
                    }
                    if bg == .photo {
                        HStack(spacing: 8) {
                            Button { picking = true } label: {
                                Label(photo == nil ? "Choose a photo" : "Another photo", systemImage: "photo").frame(maxWidth: .infinity)
                            }
                            if camera {
                                Button { shooting = true } label: {
                                    Label("Take a photo", systemImage: "camera").frame(maxWidth: .infinity)
                                }
                            }
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.large)
                    }
                    if let p = picture {
                        let image = Image(uiImage: p)
                        ShareLink(item: image, preview: SharePreview(w.name ?? sportTitle(w.sport), image: image)) {
                            Label("Share", systemImage: "square.and.arrow.up").font(.headline).frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .tint(Brand.tint)
                        .disabled(loading)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
            }
            .background(Brand.ground)
            .navigationTitle("Share as a picture")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }.accessibilityLabel("Close")
                }
            }
        }
        .photosPicker(isPresented: $picking, selection: $item, matching: .images)
        .fullScreenCover(isPresented: $shooting) {
            CameraPicker { took($0) }.ignoresSafeArea()
        }
        .onChange(of: item) {
            guard let item else { return }
            Task {
                let data = try? await item.loadTransferable(type: Data.self)
                took(data.flatMap { UIImage(data: $0) })
                self.item = nil
            }
        }
        .onChange(of: picking) {
            // Closed without a photo: back to what it was.
            if !picking && photo == nil && item == nil && !shooting { Task { try? await Task.sleep(for: .milliseconds(300)); if photo == nil && item == nil { bg = before } } }
        }
        .onAppear {
            guard !started else { return }
            started = true
            let first = ShareBackground(rawValue: Launch.share ?? stored) ?? .colour
            bg = choices.contains(first) ? first : .colour
        }
        // The map, made when it's chosen (or its ends shown or hidden); offline, the colour stays.
        .task(id: "\(bg.rawValue)-\(hideEnds)") {
            guard bg == .map, maps[hideEnds] == nil else { return }
            let hide = hideEnds
            loading = true
            let made = await cardStreets(hide ? trimEnds(w.route) : w.route)
            loading = false
            if let made { maps[hide] = made } else if bg == .map { mapFailed = true; bg = .colour }
        }
        .task(id: "\(bg.rawValue)-\(hideEnds)-\(maps[hideEnds] != nil)-\(photoN)") {
            let streets = bg == .map ? maps[hideEnds] : nil
            picture = renderPicture(WorkoutPicture(w: w, streets: streets, photo: bg == .photo ? photo : nil, ends: !(bg == .map && hideEnds)))
            // Screenshots (Launch): ready once the picture shows what was asked for.
            if Launch.open == "workoutshare", !loading, bg != .map || streets != nil || mapFailed {
                try? await Task.sleep(for: .milliseconds(600))
                Launch.ready("workoutshare")
            }
        }
    }

    private func choose(_ next: ShareBackground) {
        mapFailed = false
        stored = next.rawValue
        if next == .photo && photo == nil {
            before = bg
            bg = .photo
            picking = true
        } else {
            bg = next
        }
    }

    private func took(_ image: UIImage?) {
        guard let image else { if photo == nil { bg = before }; return }
        photo = image.scaledToFill(cardSize, scale: 3)
        photoN += 1
        bg = .photo
    }
}

private extension UIImage {
    /// No bigger than the picture needs (and upright, whatever the camera said).
    func scaledToFill(_ size: CGSize, scale: CGFloat) -> UIImage {
        let k = max(size.width * scale / self.size.width, size.height * scale / self.size.height)
        guard k < 1 else { return self }
        let target = CGSize(width: self.size.width * k, height: self.size.height * k)
        let f = UIGraphicsImageRendererFormat()
        f.scale = 1
        return UIGraphicsImageRenderer(size: target, format: f).image { _ in draw(in: CGRect(origin: .zero, size: target)) }
    }
}

/// The camera, for a photo to put behind the picture.
private struct CameraPicker: UIViewControllerRepresentable {
    let done: (UIImage?) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let c = UIImagePickerController()
        c.sourceType = .camera
        c.delegate = context.coordinator
        return c
    }

    func updateUIViewController(_ c: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(done: done) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let done: (UIImage?) -> Void
        init(done: @escaping (UIImage?) -> Void) { self.done = done }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            done(info[.originalImage] as? UIImage)
            picker.dismiss(animated: true)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            done(nil)
            picker.dismiss(animated: true)
        }
    }
}
