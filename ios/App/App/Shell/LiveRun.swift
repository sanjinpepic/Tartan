import Foundation
import ActivityKit

/// The run on the lock screen and in the Dynamic Island while it's recorded: started when a run
/// starts, updated as it goes (the page pushes every change), ended when it's finished.
@MainActor
enum LiveRun {
    private static var activity: Activity<RunAttributes>?
    private static var last: RunAttributes.ContentState?

    static func update(_ r: RecNow) {
        guard r.status == "recording" || r.status == "paused" else { end(); return }
        let moving = r.moving(Date())
        let state = RunAttributes.ContentState(
            status: r.status,
            clockFrom: r.status == "recording" ? Date().addingTimeInterval(-Double(moving)) : nil,
            movingS: moving,
            distanceKm: (r.distance / 10).rounded() / 100,
            paceS: r.status == "recording" && r.nowMps > 0.3 ? Int((1000 / r.nowMps / 5).rounded()) * 5 : nil,
            bpm: r.bpm,
            step: r.guide.flatMap { $0.done ? nil : [$0.label, $0.left].compactMap { $0 }.joined(separator: " · ") }
        )
        // Only what shows changes it (the clock ticks by itself): not every GPS fix.
        if let l = last, l.status == state.status, l.distanceKm == state.distanceKm, l.bpm == state.bpm, l.step == state.step, l.paceS == state.paceS { return }
        last = state
        let content = ActivityContent(state: state, staleDate: nil)
        if let a = activity {
            Task { await a.update(content) }
        } else if ActivityAuthorizationInfo().areActivitiesEnabled {
            activity = try? Activity.request(attributes: RunAttributes(title: r.planTitle ?? "Run", goalKm: r.goalKm), content: content)
        }
    }

    static func end() {
        guard let a = activity else { return }
        activity = nil
        last = nil
        let final = a.content
        Task { await a.end(final, dismissalPolicy: .immediate) }
    }
}
