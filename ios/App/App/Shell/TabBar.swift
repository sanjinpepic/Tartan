import SwiftUI

/// The tab bar, native on iPhone: Today, Coach, Activities and Progress in one floating Liquid
/// Glass capsule, as iOS 26's own tab bar looks. Tap a tab, or press and slide along the bar: the
/// light follows your finger with a tick at each tab, and letting go goes there. Scrolling down a
/// native screen folds it to its icons; scrolling back up brings the names back. On a screen
/// opened from a tab (the chat under Coach), its tab takes you back to the tab.
struct TabBar: View {
    let model: ShellModel
    @Namespace private var lens
    /** The tab under the finger while it's down, else nil. */
    @State private var hover: Int?
    @State private var width: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var current: Int? { Tab.all.firstIndex { $0.id == model.tab } }
    private var lit: Int? { hover ?? current }
    private var folded: Bool { model.navFolded && hover == nil }

    /** On Today: Record, a glass circle beside the bar (as iOS 26 puts Search), so it never covers the page. */
    private var record: Bool { model.shown == "today" }

    var body: some View {
        GlassEffectContainer(spacing: 10) {
            HStack(spacing: 10) {
                HStack(spacing: 0) {
                    ForEach(Array(Tab.all.enumerated()), id: \.element.id) { i, t in
                        item(t, on: lit == i)
                    }
                }
                .padding(4)
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
                .contentShape(Capsule())
                .gesture(slide)
                .glassEffect(.regular.interactive(), in: Capsule())
                if record {
                    Button { model.go("record") } label: {
                        Image(systemName: "record.circle")
                            .font(.system(size: folded ? 20 : 24, weight: .semibold))
                            .foregroundStyle(Brand.tint)
                            .frame(width: folded ? 48 : 62, height: folded ? 48 : 62)
                            .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .glassEffect(.regular.interactive(), in: Circle())
                    .accessibilityLabel("Record")
                    .accessibilityHint("Record a run with the phone")
                    .transition(.scale.combined(with: .opacity))
                }
            }
        }
        .padding(.horizontal, folded ? 40 : 16)
        .animation(reduceMotion ? nil : .spring(response: 0.38, dampingFraction: 0.82), value: record)
        .animation(reduceMotion ? nil : .spring(response: 0.38, dampingFraction: 0.82), value: folded)
        .animation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.8), value: lit)
        .sensoryFeedback(.selection, trigger: lit)
    }

    private func item(_ t: Tab, on: Bool) -> some View {
        VStack(spacing: 2) {
            Image(systemName: t.icon)
                .font(.system(size: folded ? 18 : 20, weight: .semibold))
                .symbolVariant(on ? .fill : .none)
                .frame(height: 24)
            if !folded {
                Text(t.label)
                    .font(.caption2.weight(.semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
        }
        .foregroundStyle(on ? Brand.tint : Color.primary)
        .frame(maxWidth: .infinity)
        .frame(height: folded ? 40 : 54)
        .background {
            if on {
                Capsule()
                    .fill(Brand.tint.opacity(0.14))
                    .matchedGeometryEffect(id: "lens", in: lens)
            }
        }
        .contentShape(Capsule())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(t.label)
        .accessibilityAddTraits(model.tab == t.id ? [.isButton, .isSelected] : .isButton)
        .accessibilityAction { model.select(t.id) }
    }

    /// The tab under a point of the bar (equal cells).
    private func index(at x: CGFloat) -> Int {
        guard width > 8 else { return 0 }
        let cell = (width - 8) / CGFloat(Tab.all.count)
        return min(Tab.all.count - 1, max(0, Int((x - 4) / cell)))
    }

    /// A tap or a slide: the light under the finger; letting go selects it, unless the finger
    /// left the bar upwards (then nothing changes).
    private var slide: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { g in
                hover = g.location.y < -24 ? nil : index(at: g.location.x)
            }
            .onEnded { g in
                let up = g.location.y < -24
                hover = nil
                if !up { model.select(Tab.all[index(at: g.location.x)].id) }
            }
    }
}

/// A message from the page: a glass capsule with its words, and its button when it has one.
/// Errors stay until tapped away; the rest go by themselves.
struct SnackView: View {
    let snack: Snack
    let model: ShellModel

    var body: some View {
        HStack(spacing: 12) {
            if snack.error {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Brand.watch)
            }
            Text(snack.text)
                .font(.subheadline)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
            if let action = snack.action {
                Button(action) { model.snackAction(snack) }
                    .font(.subheadline.weight(.semibold))
                    .buttonStyle(.glassProminent)
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .onTapGesture { model.dismissSnack(snack.id) }
        .accessibilityElement(children: .contain)
        .accessibilityAction(named: "Dismiss") { model.dismissSnack(snack.id) }
    }
}
