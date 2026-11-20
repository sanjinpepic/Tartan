import SwiftUI
import UIKit

/// Tartan's colours on iPhone (DESIGN.md): the track red as the tint, and the few roles the
/// screens need, each with its dark-mode value. Everything else is the system's own.
enum Brand {
    /** The tint: track red, a little lighter in the dark so it reads on black. */
    static let tint = adaptive(0xA8321F, 0xE25A43)
    /** On a red fill. */
    static let onTint = Color.white
    static let container = adaptive(0xFFDAD2, 0x5C1D12)
    static let onContainer = adaptive(0x3D0700, 0xFFDAD2)
    static let good = adaptive(0x1D6B45, 0x7FD6A1)
    static let goodContainer = adaptive(0xD3F0DD, 0x0F3D26)
    static let watch = adaptive(0x7A4F00, 0xF3BD5C)
    static let watchContainer = adaptive(0xFFE4B8, 0x4A3400)
    /** The series' keys (DESIGN.md s1, s2): fitness and fatigue. */
    static let fitness = adaptive(0x2A78D6, 0x3987E5)
    static let fatigue = adaptive(0xEB6834, 0xD95926)
    /** Heart-rate zones 1 to 5 (the web's --z1…--z5), light and dark. */
    static let zones: [Color] = [
        adaptive(0xF7BC95, 0x822E1B), adaptive(0xED8F60, 0xB14325), adaptive(0xD8653B, 0xD8653B),
        adaptive(0xB14325, 0xED8F60), adaptive(0x5E1D10, 0xF7BC95),
    ]

    static let card = Color(uiColor: .secondarySystemGroupedBackground)
    static let ground = Color(uiColor: .systemGroupedBackground)
    static let well = Color(uiColor: .tertiarySystemFill)

    static func adaptive(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? rgb(dark) : rgb(light) })
    }

    private static func rgb(_ hex: UInt32) -> UIColor {
        UIColor(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}

/// A card on Today: the grouped background's raised surface, continuous corners. A tap opens
/// what it's about (buttons inside it still take their own taps).
struct Card<Content: View>: View {
    var action: (() -> Void)?
    var label: String?
    var fill: Color = Brand.card
    @ViewBuilder var content: Content

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 26, style: .continuous)
        let inner = VStack(alignment: .leading, spacing: 10) { content }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(18)
            .background(fill, in: shape)
            .contentShape(shape)
        if let action {
            inner
                .onTapGesture(perform: action)
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isButton)
                .accessibilityAction(named: label ?? "Open", action)
        } else {
            inner
        }
    }
}

/// A big measured figure: rounded, with digits that don't jump as they change.
extension Font {
    static func figure(_ style: Font.TextStyle) -> Font { .system(style, design: .rounded).weight(.semibold).monospacedDigit() }
}

/// What a tap on a plain row feels like: it dips a little.
struct Press: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.snappy(duration: 0.2), value: configuration.isPressed)
    }
}

/// A row of things that wraps onto the next line when it's full (the pain areas, the bests).
struct Flow: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, widest: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > 0 && x + s.width > width { x = 0; y += line + spacing; line = 0 }
            x += s.width + spacing
            line = max(line, s.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: min(widest, width), height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, line: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > bounds.minX && x + s.width > bounds.maxX { x = bounds.minX; y += line + spacing; line = 0 }
            v.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(s))
            x += s.width + spacing
            line = max(line, s.height)
        }
    }
}

/// The room a native screen leaves for the floating tab bar: the page's own colour fading in
/// beneath it (through the home indicator), so nothing reads through between the bar's glass
/// shapes. Content scrolls under it and ends above it.
struct BarSpace: View {
    let on: Bool
    var extra: CGFloat = 0

    var body: some View {
        Color.clear
            .frame(height: (on ? 76 : 0) + extra)
            .background {
                if on {
                    LinearGradient(stops: [.init(color: Brand.ground.opacity(0), location: 0), .init(color: Brand.ground.opacity(0.92), location: 0.45), .init(color: Brand.ground, location: 1)],
                                   startPoint: .top, endPoint: .bottom)
                        .ignoresSafeArea(edges: .bottom)
                        .allowsHitTesting(false)
                }
            }
    }
}
