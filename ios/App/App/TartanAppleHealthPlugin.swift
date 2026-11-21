import Foundation
import UIKit
import Capacitor
import HealthKit
import CoreLocation

/// Apple Health on iPhone, read only (web/lib/apple-health.ts drives it; src/apple-health.ts keeps
/// what comes in): other apps' workouts (the Apple Watch's own, and any watch app that shares with
/// Health: Garmin Connect, Suunto, Coros, Polar…) with their totals, heart rate, distance and
/// route. Tartan writes nothing there. Without HealthKit (an iPad, or a copy installed without the
/// Health permission) each call says so in words, and nothing else changes.
///
/// Apple Health never tells an app whether reading was allowed: a "no" looks like no workouts.
@objc(TartanAppleHealthPlugin)
public class TartanAppleHealthPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TartanAppleHealthPlugin"
    public let jsName = "TartanAppleHealth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestAccess", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "workouts", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openHealth", returnType: CAPPluginReturnPromise),
    ]

    private lazy var store = HKHealthStore()
    private let bpm = HKUnit.count().unitDivided(by: .minute())

    /// What Tartan reads: workouts and their routes, heart rate, distance, energy.
    private var readTypes: Set<HKObjectType> {
        var t: Set<HKObjectType> = [HKObjectType.workoutType(), HKSeriesType.workoutRoute()]
        for id in [HKQuantityTypeIdentifier.heartRate, .distanceWalkingRunning, .distanceCycling, .distanceSwimming, .activeEnergyBurned] {
            t.insert(HKQuantityType(id))
        }
        return t
    }

    /// "available" or "unavailable"; `asked`: Apple Health's sheet has been answered already.
    @objc func status(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else { return call.resolve(["status": "unavailable"]) }
        store.getRequestStatusForAuthorization(toShare: [], read: readTypes) { s, error in
            call.resolve(["status": "available", "asked": error == nil && s == .unnecessary])
        }
    }

    /// Apple Health's own sheet (once; after that, its Sharing settings).
    @objc func requestAccess(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else { return call.reject("Apple Health isn't on this device.") }
        store.requestAuthorization(toShare: nil, read: readTypes) { ok, error in
            if let error { return call.reject(Self.words(error)) }
            call.resolve(["asked": ok])
        }
    }

    /// Workouts from `start` to `end` (ms), newest first, leaving out the `known` ids, `limit` at a time.
    @objc func workouts(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else { return call.reject("Apple Health isn't on this device.") }
        let start = Date(timeIntervalSince1970: (call.getDouble("start") ?? 0) / 1000)
        let end = Date(timeIntervalSince1970: (call.getDouble("end") ?? Date().timeIntervalSince1970 * 1000) / 1000)
        let known = Set(call.getArray("known", String.self) ?? [])
        let limit = max(1, min(50, call.getInt("limit") ?? 10))
        Task {
            do {
                let found = try await self.find(start, end)
                let fresh = found.filter { !known.contains($0.uuid.uuidString) }
                var out: [[String: Any]] = []
                for w in fresh.prefix(limit) { out.append(await self.session(w)) }
                call.resolve(["sessions": out, "more": fresh.count > limit, "found": found.count])
            } catch {
                call.reject(Self.words(error))
            }
        }
    }

    /// The Health app, where what Tartan may read is changed (Sharing → Apps → Tartan).
    @objc func openHealth(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let url = URL(string: "x-apple-health://") { UIApplication.shared.open(url) }
            call.resolve()
        }
    }

    // MARK: - Reading

    private func find(_ start: Date, _ end: Date) async throws -> [HKWorkout] {
        try await withCheckedThrowingContinuation { (k: CheckedContinuation<[HKWorkout], Error>) in
            let pred = HKQuery.predicateForSamples(withStart: start, end: end, options: [])
            let sort = [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)]
            let q = HKSampleQuery(sampleType: HKObjectType.workoutType(), predicate: pred, limit: HKObjectQueryNoLimit, sortDescriptors: sort) { _, r, error in
                if let error { k.resume(throwing: error) } else { k.resume(returning: (r as? [HKWorkout]) ?? []) }
            }
            store.execute(q)
        }
    }

    private func quantities(_ type: HKQuantityType, _ pred: NSPredicate) async -> [HKQuantitySample] {
        await withCheckedContinuation { (k: CheckedContinuation<[HKQuantitySample], Never>) in
            let sort = [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)]
            let q = HKSampleQuery(sampleType: type, predicate: pred, limit: HKObjectQueryNoLimit, sortDescriptors: sort) { _, r, _ in
                k.resume(returning: (r as? [HKQuantitySample]) ?? [])
            }
            store.execute(q)
        }
    }

    private func routes(_ pred: NSPredicate) async -> [HKWorkoutRoute] {
        await withCheckedContinuation { (k: CheckedContinuation<[HKWorkoutRoute], Never>) in
            let q = HKSampleQuery(sampleType: HKSeriesType.workoutRoute(), predicate: pred, limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, r, _ in
                k.resume(returning: (r as? [HKWorkoutRoute]) ?? [])
            }
            store.execute(q)
        }
    }

    private func locations(_ route: HKWorkoutRoute) async -> [CLLocation] {
        await withCheckedContinuation { (k: CheckedContinuation<[CLLocation], Never>) in
            var all: [CLLocation] = []
            var over = false
            let q = HKWorkoutRouteQuery(route: route) { _, locs, done, error in
                if let locs { all.append(contentsOf: locs) }
                if (done || error != nil) && !over {
                    over = true
                    k.resume(returning: all)
                }
            }
            store.execute(q)
        }
    }

    /// One workout as src/apple-health.ts HkSession reads it.
    private func session(_ w: HKWorkout) async -> [String: Any] {
        let ms = { (d: Date) -> Double in (d.timeIntervalSince1970 * 1000).rounded() }
        let src = w.sourceRevision
        var s: [String: Any] = [
            "id": w.uuid.uuidString,
            "start": ms(w.startDate),
            "end": ms(w.endDate),
            "source": src.source.bundleIdentifier,
            "app": src.source.name,
            "sport": Self.sport(w),
        ]
        if let p = src.productType { s["product"] = p }
        if let t = w.metadata?[HKMetadataKeyWorkoutBrandName] as? String, !t.isEmpty { s["title"] = t }
        // The totals Apple Health keeps with it.
        if let st = w.statistics(for: HKQuantityType(.heartRate)) {
            if let a = st.averageQuantity() { s["avg_hr"] = a.doubleValue(for: bpm) }
            if let m = st.maximumQuantity() { s["max_hr"] = m.doubleValue(for: bpm) }
        }
        if let e = w.statistics(for: HKQuantityType(.activeEnergyBurned))?.sumQuantity() {
            s["calories"] = e.doubleValue(for: .kilocalorie())
        }
        if let d = w.totalDistance { s["distance_m"] = d.doubleValue(for: .meter()) }

        // Heart rate: the workout's own samples, else whatever was measured while it ran.
        let mine = HKQuery.predicateForObjects(from: w)
        var hr = await quantities(HKQuantityType(.heartRate), mine)
        if hr.isEmpty { hr = await quantities(HKQuantityType(.heartRate), HKQuery.predicateForSamples(withStart: w.startDate, end: w.endDate, options: [])) }
        if !hr.isEmpty { s["hr"] = hr.map { [ms($0.startDate), $0.quantity.doubleValue(for: bpm)] } }

        // Distance as it was recorded (the workout's own records only: the phone counts its own too).
        let kind: HKQuantityTypeIdentifier
        switch w.workoutActivityType {
        case .cycling, .handCycling: kind = .distanceCycling
        case .swimming: kind = .distanceSwimming
        default: kind = .distanceWalkingRunning
        }
        let dist = await quantities(HKQuantityType(kind), mine)
        if !dist.isEmpty { s["distance"] = dist.map { [ms($0.startDate), ms($0.endDate), $0.quantity.doubleValue(for: .meter())] } }

        // The route: 10,000 points at most.
        if let route = await routes(mine).first {
            let locs = await locations(route)
            let stride = max(1, Int((Double(locs.count) / 10_000).rounded(.up)))
            var pts: [[Any]] = []
            for (i, l) in locs.enumerated() where i % stride == 0 && l.horizontalAccuracy >= 0 {
                pts.append([ms(l.timestamp), l.coordinate.latitude, l.coordinate.longitude, l.verticalAccuracy >= 0 ? l.altitude as Any : NSNull()])
            }
            if pts.count > 1 { s["route"] = pts }
        }
        return s
    }

    /// HealthKit's activity type as Health Connect names it (src/health-connect.ts fitSport reads those).
    private static func sport(_ w: HKWorkout) -> String {
        let indoor = (w.metadata?[HKMetadataKeyIndoorWorkout] as? NSNumber)?.boolValue == true
        switch w.workoutActivityType {
        case .running: return indoor ? "running_treadmill" : "running"
        case .walking, .wheelchairWalkPace: return "walking"
        case .wheelchairRunPace: return "running"
        case .hiking: return "hiking"
        case .cycling, .handCycling: return indoor ? "biking_stationary" : "biking"
        case .swimming:
            let place = (w.metadata?[HKMetadataKeySwimmingLocationType] as? NSNumber)?.intValue
            return place == HKWorkoutSwimmingLocationType.openWater.rawValue ? "swimming_open_water" : "swimming_pool"
        case .traditionalStrengthTraining: return "weightlifting"
        case .functionalStrengthTraining, .coreTraining, .crossTraining: return "strength_training"
        case .highIntensityIntervalTraining: return "hiit"
        case .yoga: return "yoga"
        case .pilates: return "pilates"
        case .rowing: return indoor ? "rowing_machine" : "rowing"
        case .elliptical: return "elliptical"
        case .stairClimbing, .stairs: return "stair_climbing"
        case .downhillSkiing: return "skiing"
        case .crossCountrySkiing: return "cross_country_skiing"
        case .snowboarding: return "snowboarding"
        case .paddleSports: return "paddling"
        case .climbing: return "rock_climbing"
        case .soccer: return "soccer"
        case .tennis: return "tennis"
        case .golf: return "golf"
        case .surfingSports: return "surfing"
        default: return "other"
        }
    }

    /// HealthKit's errors in plain words.
    private static func words(_ e: Error) -> String {
        let m = e.localizedDescription
        if m.lowercased().contains("entitlement") {
            return "This copy of Tartan was installed without access to Apple Health. Install it again with SideStore or AltStore, then try again."
        }
        if let h = e as? HKError, h.code == .errorDatabaseInaccessible {
            return "Apple Health can't be read while the iPhone is locked. Open Tartan again once it's unlocked."
        }
        return m
    }
}
