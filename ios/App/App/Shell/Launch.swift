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
    /** Dark, whatever the phone is set to. */
    static var dark: Bool { UserDefaults.standard.bool(forKey: "TartanDark") }
}
