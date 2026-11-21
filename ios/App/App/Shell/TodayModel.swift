import Foundation
import Observation

/// Native Today's data and what you can do on it: the view (GET /api/today and /api/plan, kept
/// so the next start draws at once), and beyond it the morning check, the watch's vitals, race
/// week and the notes about shoes and your PC (Android's TodayModel in TodayMore.kt).
@MainActor
@Observable
final class TodayModel {
    @ObservationIgnored weak var shell: ShellModel?
    private let engine: EngineBridge
    private let keys = UserDefaults.standard

    var data: Today?
    /** Reading for the first time, with nothing kept to show meanwhile. */
    var loading = false
    /** The last read didn't come back, and there's nothing to show. */
    var failed = false
    var check: Check?
    var vitals: Vitals?
    var raceWeek: RaceWeek?
    var shoes: ShoesNote?
    var pairHint = false
    var busy = false
    /** Changing a finished morning check: open again until Done (or a moment after the last answer). */
    var checkEditing = false
    /** Counts answers, so the check can fold a moment after the last one. */
    var checkTouched = 0
    /** "More today" open (kept while the app runs). */
    var moreOpen = false
    /** New bests you've put away from the top. */
    var cheered: Set<String>

    /** Something wrote since the last read (a sync, a mark…). */
    @ObservationIgnored var stale = true
    @ObservationIgnored private var readOn: String?
    @ObservationIgnored private var fetching = false
    @ObservationIgnored private var raceFor: String?
    @ObservationIgnored private var shoesShown = false
    @ObservationIgnored private var synced: CheckedContinuation<Void, Never>?

    init(engine: EngineBridge) {
        self.engine = engine
        cheered = Set(UserDefaults.standard.stringArray(forKey: "tartan.today.cheered") ?? [])
        // Last time's Today, drawn at once while it's read again.
        if let t = keys.string(forKey: "tartan.today.json") {
            data = parseToday(t, keys.string(forKey: "tartan.today.plan"))
        }
    }

    /** Read again only when something changed since, or the day did. */
    func freshen() {
        if stale || data == nil || readOn != isoDay(Date()) {
            Task { await fetch() }
        }
    }

    func fetch() async {
        guard !fetching else { return }
        fetching = true
        defer { fetching = false }
        stale = false
        if data == nil { loading = true }
        async let t = engine.get("/api/today")
        async let p = engine.get("/api/plan")
        let todayJson = await t
        let planJson = await p
        loading = false
        guard let todayJson, let view = parseToday(todayJson, planJson) else {
            stale = true
            failed = data == nil
            return
        }
        failed = false
        data = view
        readOn = isoDay(Date())
        // Screenshots: Today with its data (before the first plan, with TartanNoPlan, once it's gone).
        if view.last != nil && (!Launch.noPlan || !view.planOn) { Launch.ready("today") }
        keys.set(todayJson, forKey: "tartan.today.json")
        keys.set(planJson, forKey: "tartan.today.plan")
        await loadMore(view)
    }

    /** What Today reads beyond its view, each when it comes. */
    private func loadMore(_ view: Today) async {
        async let r = engine.get("/api/readiness")
        async let h = engine.get("/api/health")
        async let sh = engine.get("/api/shoes")
        async let pr = engine.rpc("prefs")
        if let json = await r, let c = parseCheck(json) { check = c }
        if let json = await h { vitals = parseVitals(json) }
        if let race = view.race, let d = race.daysToGo, (0...7).contains(d) {
            let key = jsonText(race.json)
            if raceFor != key || raceWeek == nil, case .success(let json) = await engine.rpc("raceWeek", ["race": race.json]) {
                raceWeek = parseRaceWeek(json)
                raceFor = key
            }
        } else {
            raceWeek = nil
        }
        if let json = await sh { shoes = shoesNote(J(json: json)) }
        if case .success(let json) = await pr {
            pairHint = keys.string(forKey: "tartan.today.pairHint") == nil && !J(json: json)["paired"].bool
        }
    }

    /** Pull to refresh is Sync now: the sync writes, the page says changed, Today reads again. */
    func refresh() async {
        syncDone()
        shell?.goAction("sync")
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            synced = c
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(20))
                self?.syncDone()
            }
        }
        stale = true
        await fetch()
    }

    /** A word after something done here ("Marked done."), as the page's messages show. */
    func say(_ text: String) {
        shell?.say(text)
    }

    func syncDone() {
        synced?.resume()
        synced = nil
    }

    // MARK: - Notes

    private func shoesNote(_ v: J) -> ShoesNote? {
        let list = v["shoes"].array
        let strava = list.filter { $0["strava_id"].str != nil && !$0["retired"].bool }
        if !strava.isEmpty && (shoesShown || keys.string(forKey: "tartan.today.shoesFound") == nil) {
            keys.set("1", forKey: "tartan.today.shoesFound")
            shoesShown = true
            let n = strava.count
            let names = strava.map { "\($0["name"].text) (\(Int(($0["km"].num ?? 0).rounded())) km)" }.joined(separator: ", ")
            return ShoesNote(title: n == 1 ? "Found your pair from Strava" : "Found \(n) pairs from Strava",
                             text: "\(names). Runs count to them from now on, and Today says when one is close to done.",
                             go: "See them", quiet: "OK", key: "shoesFound")
        }
        let runs = v["runs"]
        if list.isEmpty, keys.string(forKey: "tartan.today.shoesNudgeOff") == nil, (runs["count"].int ?? 0) >= 3,
           let first = runs["first"].str.flatMap(isoInstant), Date().timeIntervalSince(first) > 7 * 86400 {
            return ShoesNote(title: "Which shoes do you run in?", text: "Add a pair and Tartan counts their kilometres from your runs, and says when they're close to done.",
                             go: "Add a pair", quiet: "Not now", key: "shoesNudgeOff")
        }
        return nil
    }

    func dismissShoes() {
        if let s = shoes { keys.set("1", forKey: "tartan.today.\(s.key)") }
        shoesShown = false
        shoes = nil
    }

    func dismissPair() {
        keys.set("1", forKey: "tartan.today.pairHint")
        pairHint = false
    }

    func scanPair() {
        Task {
            if case .success(let r) = await engine.rpc("scanPair"), r == "true" { dismissPair() }
        }
    }

    func cheer(_ ids: [String]) {
        cheered.formUnion(ids)
        keys.set(Array(cheered), forKey: "tartan.today.cheered")
    }

    // MARK: - The morning check

    /** An answer: sleep, legs, or where and how much it hurts (clearPain: nothing). */
    func answer(sleep: Int? = nil, legs: Int? = nil, pain: (area: String, level: Int)? = nil, clearPain: Bool = false) {
        guard let c = check else { return }
        var b: [String: Any] = [:]
        // Only what's been answered: a question left open stays open (it isn't taken as "OK").
        if !c.measured, let s = sleep ?? c.sleep { b["sleep"] = s }
        if let l = legs ?? c.legs { b["legs"] = l }
        checkTouched += 1
        let p = clearPain ? nil : (pain ?? c.pain)
        if let p { b["pain"] = ["area": p.area, "level": p.level] as [String: Any] } else { b["pain"] = NSNull() }
        send("/api/readiness", method: "PUT", body: b)
    }

    /** Swap today's hard session for an easy run, or undo it. */
    func swap(undo: Bool) {
        guard let c = check else { return }
        var b: [String: Any] = ["date": c.date]
        if undo {
            if let k = c.swapKind { b["kind"] = k }
            b["undo"] = true
        } else {
            if let k = c.sessionKind { b["kind"] = k }
            b["reason"] = c.reasons.isEmpty ? "a hard day" : c.reasons.joined(separator: ", ")
        }
        send("/api/plan/swap", method: "POST", body: b)
    }

    private func send(_ path: String, method: String, body: [String: Any]) {
        busy = true
        Task {
            switch await engine.send(path, method: method, body: body) {
            case .success(let text): if let c = parseCheck(text) { check = c }
            case .failure(let e): say("Couldn't save: \(e.message)")
            }
            busy = false
        }
    }

    /** Tick today's session off by hand (the watch stayed home). */
    func mark(date: String, kind: String) {
        busy = true
        Task {
            switch await engine.send("/api/plan/mark", method: "PUT", body: ["date": date, "kind": kind, "done": true]) {
            case .success:
                say("Marked done.")
                stale = true
                await fetch()
            case .failure(let e): say("Couldn't mark it: \(e.message)")
            }
            busy = false
        }
    }

    // MARK: - Race week

    func pacingToWatch(_ r: RaceGoal, _ w: RaceWeek) {
        guard let p = w.pacing else { return }
        busy = true
        Task {
            let ok = await engine.rpc("pacingToWatch", ["name": "\(r.name) \(clock(p.timeS))", "distance_km": r.km, "time_s": p.timeS])
            if case .success(let v) = ok, v == "true" { say("The pacing workout is on your watch: start it from the sport mode's workout options.") }
            else { say("Couldn't put it on the watch. Is it nearby, with Bluetooth on?") }
            busy = false
        }
    }

    func ticked(_ r: RaceGoal) -> Set<String> {
        Set(keys.stringArray(forKey: "tartan.today.raceweek.\(r.date ?? "")") ?? [])
    }

    func tick(_ r: RaceGoal, _ item: String, _ on: Bool) {
        var now = ticked(r)
        if on { now.insert(item) } else { now.remove(item) }
        keys.set(Array(now), forKey: "tartan.today.raceweek.\(r.date ?? "")")
    }
}
