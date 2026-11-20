import WidgetKit
import SwiftUI
import ActivityKit

/// Tartan's widget extension: for now, the run in progress on the lock screen and in the
/// Dynamic Island (RunAttributes, started and updated by the app's LiveRun).
@main
struct TartanWidgets: WidgetBundle {
    var body: some Widget {
        RunLiveActivity()
    }
}

private let tint = Color(red: 0.886, green: 0.353, blue: 0.263)

struct RunLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RunAttributes.self) { ctx in
            LockScreenRun(title: ctx.attributes.title, goalKm: ctx.attributes.goalKm, s: ctx.state)
                .activityBackgroundTint(Color.black.opacity(0.55))
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { ctx in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Time").font(.caption2).foregroundStyle(.secondary)
                        RunClock(s: ctx.state).font(.title2.weight(.semibold).monospacedDigit())
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    VStack(alignment: .trailing, spacing: 2) {
                        Text("Distance").font(.caption2).foregroundStyle(.secondary)
                        Text(String(format: "%.2f km", ctx.state.distanceKm)).font(.title2.weight(.semibold).monospacedDigit())
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    HStack {
                        Label(ctx.state.status == "paused" ? "Paused" : ctx.attributes.title, systemImage: ctx.state.status == "paused" ? "pause.fill" : "figure.run")
                            .foregroundStyle(ctx.state.status == "paused" ? .orange : tint)
                        Spacer()
                        if let step = ctx.state.step { Text(step).lineLimit(1) }
                        else if let p = ctx.state.paceS { Text("\(p / 60):\(String(format: "%02d", p % 60)) /km").monospacedDigit() }
                        if let b = ctx.state.bpm { Label("\(b)", systemImage: "heart.fill").foregroundStyle(.red).monospacedDigit() }
                    }
                    .font(.subheadline.weight(.medium))
                }
            } compactLeading: {
                Image(systemName: ctx.state.status == "paused" ? "pause.fill" : "figure.run").foregroundStyle(tint)
            } compactTrailing: {
                Text(String(format: "%.1f", ctx.state.distanceKm)).monospacedDigit().foregroundStyle(tint)
            } minimal: {
                Image(systemName: "figure.run").foregroundStyle(tint)
            }
        }
    }
}

/// The moving time: ticking by itself while recording, still while paused.
struct RunClock: View {
    let s: RunAttributes.ContentState
    var body: some View {
        if let from = s.clockFrom, s.status == "recording" {
            Text(timerInterval: from...Date.distantFuture, countsDown: false)
        } else {
            Text(s.movingS >= 3600 ? String(format: "%d:%02d:%02d", s.movingS / 3600, s.movingS / 60 % 60, s.movingS % 60) : String(format: "%d:%02d", s.movingS / 60, s.movingS % 60))
        }
    }
}

struct LockScreenRun: View {
    let title: String
    let goalKm: Double?
    let s: RunAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label(s.status == "paused" ? "Paused" : title, systemImage: s.status == "paused" ? "pause.fill" : "figure.run")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(s.status == "paused" ? .orange : tint)
                Spacer()
                Text("Tartan").font(.caption.weight(.semibold)).foregroundStyle(.white.opacity(0.6))
            }
            HStack(alignment: .lastTextBaseline) {
                RunClock(s: s).font(.system(size: 34, weight: .semibold, design: .rounded).monospacedDigit())
                Spacer()
                Text(String(format: "%.2f", s.distanceKm)).font(.system(size: 34, weight: .semibold, design: .rounded).monospacedDigit())
                Text("km").font(.headline).foregroundStyle(.white.opacity(0.7))
            }
            HStack {
                if let step = s.step { Text(step).lineLimit(1) }
                else if let p = s.paceS { Text("\(p / 60):\(String(format: "%02d", p % 60)) /km").monospacedDigit() }
                Spacer()
                if let b = s.bpm { Label("\(b) bpm", systemImage: "heart.fill").foregroundStyle(.red) }
            }
            .font(.subheadline.weight(.medium))
            if let g = goalKm, g > 0 {
                ProgressView(value: min(1, s.distanceKm / g)).tint(tint)
            }
        }
        .foregroundStyle(.white)
        .padding(16)
    }
}
