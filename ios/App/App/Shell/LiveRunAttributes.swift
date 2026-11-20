import Foundation
import ActivityKit

/// A run in progress on the lock screen and in the Dynamic Island (iOS's counterpart to
/// Android's Live Updates). Shared by the app (which starts, updates and ends it: LiveRun) and
/// the widget extension (which draws it: TartanWidgets).
struct RunAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        /** "recording" or "paused". */
        var status: String
        /** While recording: when the moving clock would have started (now minus the moving time), so it ticks by itself. */
        var clockFrom: Date?
        /** The moving time, for a paused run. */
        var movingS: Int
        var distanceKm: Double
        /** Seconds per km now, when moving. */
        var paceS: Int?
        var bpm: Int?
        /** A guided run's step ("Run 3 min"), when there is one. */
        var step: String?
    }

    /** Today's planned run's name, else "Run". */
    var title: String
    var goalKm: Double?
}
