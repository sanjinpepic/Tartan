import SwiftUI
import Observation

/// One workout in the list (GET /api/library/activities).
struct Act: Identifiable {
    let id: String
    let start: Date?
    let sport: String
    let name: String
    let km: Double?
    let minutes: Double?
    let pace: String?
    let hr: Int?
    let sources: [String]
    let device: String?
    /** The weather it was done in, when known (outdoors). */
    var weather: Wx? = nil

    /** Run, ride or other, as the web's filter has it. */
    var family: String {
        let s = sport.lowercased()
        if s.range(of: "run|jog|trail|treadmill", options: .regularExpression) != nil { return "run" }
        if s.range(of: "ride|cycl|bik", options: .regularExpression) != nil { return "ride" }
        return "other"
    }
    var big: String { km.map { String(format: "%.2f km", $0) } ?? minutes.map(duration) ?? "" }
    var small: String { [km != nil ? minutes.map(duration) : nil, pace.map { "\($0) /km" } ?? hr.map { "\($0) bpm" }].compactMap { $0 }.joined(separator: " · ") }
    var whenText: String {
        guard let d = start else { return "" }
        return d.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated)) + " · " + d.formatted(.dateTime.hour().minute())
    }
}

/// A week of workouts: its Monday and totals.
struct ActWeek: Identifiable {
    var id: String { monday.map(isoDay) ?? "undated" }
    let monday: Date?
    let acts: [Act]
    var km: Double { acts.reduce(0) { $0 + ($1.km ?? 0) } }
    var minutes: Double { acts.reduce(0) { $0 + ($1.minutes ?? 0) } }
}

func parseActivities(_ json: String) -> [Act] {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
    return J(json: json).array.map { o in
        let start = String((o["start_local"].str ?? o["start"].str ?? "").prefix(19))
        return Act(id: o["id"].text, start: f.date(from: start), sport: o["sport"].str ?? "Workout", name: o["name"].str ?? sportTitle(o["sport"].str ?? ""),
                   km: o["distance_km"].num, minutes: o["moving_min"].num, pace: o["avg_pace_min_km"].str, hr: o["avg_hr"].num.map { Int($0) },
                   sources: o["sources"].strings, device: o["device"].str, weather: parseWx(o["weather"]))
    }
}

/// The list as shown: the filter and the search, by week, the latest 400; and how many matched.
func actWeeks(_ all: [Act], filter: String, query: String) -> ([ActWeek], Int) {
    let q = query.trimmingCharacters(in: .whitespaces).lowercased()
    let rows = all.filter { (filter == "all" || $0.family == filter) && (q.isEmpty || "\($0.name) \($0.sport) \($0.device ?? "")".lowercased().contains(q)) }
    var cal = Calendar(identifier: .gregorian)
    cal.firstWeekday = 2
    var order: [String] = []
    var groups: [String: (Date?, [Act])] = [:]
    for a in rows.prefix(400) {
        let monday = a.start.flatMap { cal.dateInterval(of: .weekOfYear, for: $0)?.start }
        let key = monday.map(isoDay) ?? "undated"
        if groups[key] == nil { order.append(key); groups[key] = (monday, []) }
        groups[key]?.1.append(a)
    }
    return (order.compactMap { k in groups[k].map { ActWeek(monday: $0.0, acts: $0.1) } }, rows.count)
}

/// Activities' data: every workout, kept as a file so the next start draws at once.
@MainActor
@Observable
final class ActivitiesModel {
    private let engine: EngineBridge
    var all: [Act]?
    var failed = false
    var filter = "all"
    var query = ""
    @ObservationIgnored var stale = true
    @ObservationIgnored private var readOn: String?
    @ObservationIgnored private var fetching = false
    private static var file: URL { FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("activities.json") }

    init(engine: EngineBridge) {
        self.engine = engine
        if let d = try? Data(contentsOf: ActivitiesModel.file) { all = parseActivities(String(decoding: d, as: UTF8.self)) }
    }

    func freshen() {
        if stale || all == nil || readOn != isoDay(Date()) { Task { await fetch() } }
    }

    func fetch() async {
        guard !fetching else { return }
        fetching = true
        defer { fetching = false }
        stale = false
        guard let json = await engine.get("/api/library/activities?limit=3000") else { stale = true; failed = all == nil; return }
        failed = false
        all = parseActivities(json)
        readOn = isoDay(Date())
        if all?.isEmpty == false { Launch.ready("activities") }
        try? Data(json.utf8).write(to: ActivitiesModel.file)
    }
}

/// Activities, native (Android's ActivitiesScreen.kt): every workout once, by week with its
/// totals, searchable, filtered by sport; Workouts and Routes at the top (Routes is the page's).
/// A row opens the workout's sheet.
struct ActivitiesScreen: View {
    let shell: ShellModel
    let m: ActivitiesModel

    private let filters = ["all", "run", "ride", "other"]
    private let filterName = ["all": "All", "run": "Runs", "ride": "Rides", "other": "Other"]

    var body: some View {
        NavigationStack {
            let shown = m.all.map { actWeeks($0, filter: m.filter, query: m.query) } ?? ([], 0)
            let groups = shown.0
            let total = shown.1
            List {
                Section {
                    // Routes alongside once you have one (src/in-use.ts); until then under Settings → More → More tools.
                    if shell.inUse.routes {
                        Picker("Show", selection: Binding(get: { 0 }, set: { if $0 == 1 { shell.go("routes") } })) {
                            Text("Workouts").tag(0)
                            Text("Routes").tag(1)
                        }
                        .pickerStyle(.segmented)
                    }
                    Picker("Sport", selection: Binding(get: { m.filter }, set: { v in withAnimation(.smooth) { m.filter = v } })) {
                        ForEach(filters, id: \.self) { f in Text(filterName[f] ?? f).tag(f) }
                    }
                    .pickerStyle(.segmented)
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                .listRowSeparator(.hidden)
                if m.all == nil {
                    Section { ProgressView().controlSize(.large).frame(maxWidth: .infinity, minHeight: 200) }.listRowBackground(Color.clear)
                } else if groups.isEmpty {
                    Section { empty(m.all?.isEmpty == true) }
                } else {
                    ForEach(groups) { w in
                        Section {
                            ForEach(w.acts) { a in
                                Button { shell.openActivity(a.id) } label: { ActRow(a: a) }
                                    .foregroundStyle(Color.primary)
                            }
                        } header: {
                            HStack(alignment: .lastTextBaseline) {
                                Text(w.monday.map { "Week of \($0.formatted(.dateTime.day().month(.abbreviated)))" } ?? "Undated").font(.headline).foregroundStyle(Color.primary)
                                Spacer()
                                Text("\(km1(w.km)) km · \(duration(w.minutes))").font(.subheadline).foregroundStyle(.secondary)
                            }
                            .textCase(nil)
                        }
                    }
                    if total > 400 {
                        Section { Text("Showing the latest 400 of \(total). Search to find older ones.").font(.footnote).foregroundStyle(.secondary) }.listRowBackground(Color.clear)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .listSectionSpacing(12)
            .scrollContentBackground(.hidden)
            .background(Brand.ground)
            .searchable(text: Binding(get: { m.query }, set: { m.query = $0 }), placement: .navigationBarDrawer(displayMode: .always), prompt: "Search workouts")
            .refreshable { m.stale = true; await m.fetch() }
            .onScrollGeometryChange(for: CGFloat.self) { g in g.contentOffset.y + g.contentInsets.top } action: { old, new in shell.scrolled(by: new - old, at: new) }
            .safeAreaInset(edge: .bottom, spacing: 0) { BarSpace(on: shell.navOn) }
            .navigationTitle("Activities")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { SyncChip(lanes: shell.board) { shell.openBoard() } }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { shell.go("settings") } label: { Image(systemName: "gearshape") }.accessibilityLabel("Settings")
                }
            }
        }
    }

    @ViewBuilder private func empty(_ none: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(none ? "No workouts yet" : "Nothing matches").font(.title3.weight(.bold))
            Text(none ? "Connect Strava for your full history, or back up the watch. Each workout appears once even when it is in both." : "Try another search or sport.")
                .font(.subheadline).foregroundStyle(.secondary)
            if none { Button("Connect Strava or the watch") { shell.go("settings/sources") }.buttonStyle(.glass) }
        }
        .padding(.vertical, 8)
    }
}

/// A workout's row: its sport, name, when and where from; how far and how fast.
private struct ActRow: View {
    let a: Act

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: sportSymbol(a.sport))
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(Brand.onContainer)
                .frame(width: 40, height: 40)
                .background(Brand.container, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(a.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                // When, where from, and the weather it was in: one line while it fits, else the weather below.
                if let w = a.weather {
                    // A little tighter than the line without weather, so it fits beside the date more often.
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 4) {
                            whenAndSources
                            WxInline(w: w)
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) { whenAndSources }
                            WxInline(w: w)
                        }
                    }
                } else {
                    HStack(spacing: 6) { whenAndSources }
                }
            }
            // All the width the figures leave, so the weather sits on the date line whenever it fits.
            .frame(maxWidth: .infinity, alignment: .leading)
            VStack(alignment: .trailing, spacing: 2) {
                Text(a.big).font(.subheadline.weight(.bold).monospacedDigit())
                if !a.small.isEmpty { Text(a.small).font(.caption.monospacedDigit()).foregroundStyle(.secondary) }
            }
            .fixedSize()
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }

    @ViewBuilder private var whenAndSources: some View {
        Text(a.whenText).font(.caption).foregroundStyle(.secondary).lineLimit(1)
        HStack(spacing: 3) {
            ForEach(Array(Set(a.sources)).sorted(), id: \.self) { s in
                Image(systemName: s == "watch" ? "watch.analog" : s == "strava" ? "figure.run" : s == "phone" ? "iphone" : "folder")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(s == "strava" ? Brand.good : Color.secondary)
            }
        }
        .padding(.horizontal, 4).padding(.vertical, 2)
        .background(a.sources.count > 1 ? Brand.goodContainer : Brand.well, in: Capsule())
        .accessibilityLabel(a.sources.count > 1 ? "Merged from \(a.sources.count) sources" : "From \(a.sources.first ?? "")")
    }
}

/// The weather a workout was done in (src/workout-weather.ts), a quiet detail: the sky as a
/// symbol and the temperature on the cards (the wind when notable), a line in words on its sheet
/// ("Light rain, 4° (feels 0°), wind 18 km/h"). °C: the app has no unit setting.
struct Wx {
    let tempC: Double
    let feelsC: Double?
    let condition: String
    let sky: String
    let windKmh: Int?
    let day: Bool?
    /** A planned session's forecast: the hour it's for ("17:00"); nil for a workout done. */
    var at: String? = nil

    var symbol: String {
        switch condition {
        case "clear": return day == false ? "moon.stars" : "sun.max"
        case "rain": return "cloud.rain"
        case "snow": return "cloud.snow"
        case "fog": return "cloud.fog"
        case "storm": return "cloud.bolt.rain"
        default: return "cloud"
        }
    }
    var degrees: Int { Int(tempC.rounded()) }
    var temp: String { "\(degrees)°" }
    /** Wind worth a word on a card: 25 km/h and more. */
    var notableWind: Int? {
        guard let k = windKmh, k >= 25 else { return nil }
        return k
    }
    /** "4° · 32 km/h wind" (the symbol goes before it). */
    var compact: String {
        guard let k = notableWind else { return temp }
        return "\(temp) · \(k)\u{00A0}km/h wind"
    }
    /** "Light rain, 4° (feels 0°), wind 18 km/h". */
    var line: String {
        var s = "\(sky), \(temp)"
        if let f = feelsC, Int(f.rounded()) != degrees { s += " (feels \(Int(f.rounded()))°)" }
        if let k = windKmh, k > 0 { s += ", wind \(k)\u{00A0}km/h" }
        return s
    }
    /** A planned session's: "Forecast at 17:00: light rain, 4° (feels 0°), wind 18 km/h". */
    var forecastLine: String {
        guard let at else { return line }
        return "Forecast at \(at): \(line.prefix(1).lowercased() + line.dropFirst())"
    }
}

/// A row's `weather` object, or nil when it has none.
func parseWx(_ o: J) -> Wx? {
    guard o.object != nil, let t = o["temp_c"].num else { return nil }
    let wind: Int? = o["wind_kmh"].num.map { Int($0.rounded()) }
    let day: Bool? = (o["day"].raw as? NSNumber)?.boolValue
    return Wx(tempC: t, feelsC: o["feels_c"].num, condition: o["condition"].str ?? "cloudy", sky: o["sky"].str ?? "", windKmh: wind, day: day, at: o["at"].str)
}

/// On a card: the sky's symbol and the temperature, in the line's own muted style.
struct WxInline: View {
    let w: Wx
    var font: Font = .caption

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: w.symbol).imageScale(.small)
            Text(w.compact).monospacedDigit().lineLimit(1)
        }
        .font(font)
        .foregroundStyle(.secondary)
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(w.line)
    }
}

/// On a workout's sheet: one line in words under the date.
struct WxSentence: View {
    let w: Wx

    var body: some View {
        Label { Text(w.at != nil ? w.forecastLine : w.line) } icon: { Image(systemName: w.symbol) }
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .labelStyle(.titleAndIcon)
    }
}
