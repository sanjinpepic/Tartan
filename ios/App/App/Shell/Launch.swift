import Foundation

/// Launch arguments for the simulator screenshots (.github/workflows/ios-screens.yml), e.g.
/// `-TartanDemo YES -TartanTab coach -TartanMore YES -TartanDark YES`. They live only for that
/// launch (UserDefaults' argument domain), so a normal start never has them.
enum Launch {
    /** Start the sample data (as the intro's "Try it with sample data"), skipping the intro. */
    static var demo: Bool { UserDefaults.standard.bool(forKey: "TartanDemo") }
    /** Open this tab (today, coach, activities, trends) once the page has started. */
    static var tab: String? { UserDefaults.standard.string(forKey: "TartanTab").flatMap { $0.isEmpty ? nil : $0 } }
    /** Today with More today open, scrolled to it. */
    static var more: Bool { UserDefaults.standard.bool(forKey: "TartanMore") }
    /** Open a sheet from Today once it has its data: "session" (today's or the next) or "workout" (the last). */
    static var open: String? { UserDefaults.standard.string(forKey: "TartanOpen").flatMap { $0.isEmpty ? nil : $0 } }
    /** The chat with a made-up conversation (no coach asked, nothing sent). */
    static var chatSample: Bool { UserDefaults.standard.bool(forKey: "TartanChatSample") }
    /** The intro at this step (0 the welcome … 4), over the app. */
    static var intro: Int? { UserDefaults.standard.string(forKey: "TartanIntro").flatMap { Int($0) } }
    /** Coach before the first plan: the plan cleared first (screenshots of making one). */
    static var noPlan: Bool { UserDefaults.standard.bool(forKey: "TartanNoPlan") }
    /** As noPlan, then a plan made by Tartan's rules, as Make my plan does. */
    static var makePlan: Bool { UserDefaults.standard.bool(forKey: "TartanMakePlan") }
    /** Dark, whatever the phone is set to. */
    static var dark: Bool { UserDefaults.standard.bool(forKey: "TartanDark") }

    /**
     * For the screenshot script: a mark that what was asked has its data ("today", "coach",
     * "workout", "plan"…), a file in the app's Documents it waits for. Only with -TartanDemo.
     */
    static func ready(_ what: String) {
        guard demo, let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
        try? Data(what.utf8).write(to: dir.appendingPathComponent("ready-\(what)"))
    }
}
