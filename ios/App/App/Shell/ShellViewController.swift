import UIKit
import SwiftUI
import Capacitor

/// Capacitor's view controller (its view is the web view), with the TartanShell plugin (and
/// Apple Health's, TartanAppleHealthPlugin.swift) registered before the page loads, so
/// `Capacitor.isPluginAvailable("TartanShell")` is true.
/// The web view is see-through, so the page can open its sheets over a native screen.
class TartanBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(TartanShellPlugin())
        bridge?.registerPluginInstance(TartanAppleHealthPlugin())
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        webView?.isOpaque = false
        webView?.backgroundColor = .clear
        webView?.scrollView.backgroundColor = .clear
        webView?.underPageBackgroundColor = .clear
    }
}

/// The window's root: the web view (Capacitor's view controller, as a child), the native screen
/// and the native bar. The native screen sits over the page while one shows and nothing of the
/// page's is open; while the page opens a sheet (or its intro, or the keyboard) the page comes on
/// top, see-through, so the sheet shows over the native screen. The bar and the page's messages
/// are always on top, sized to what they show, so touches elsewhere reach what's under them.
class ShellViewController: UIViewController, ShellHost {
    private var bridgeController: TartanBridgeViewController?
    private var screenHost: UIHostingController<ShellScreens>?
    private var barHost: UIHostingController<ShellBar>?
    private var barLayer: UIView?
    private var model: ShellModel { ShellModel.shared }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemGroupedBackground
        if Launch.dark { overrideUserInterfaceStyle = .dark }

        let bridge = TartanBridgeViewController()
        bridgeController = bridge
        addChild(bridge)
        let web = bridge.view!
        web.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(web)
        pin(web)
        bridge.didMove(toParent: self)

        let screen = UIHostingController(rootView: ShellScreens(model: model))
        screen.view.backgroundColor = .clear
        screen.view.alpha = 0
        addChild(screen)
        screen.view.translatesAutoresizingMaskIntoConstraints = false
        view.insertSubview(screen.view, aboveSubview: web)
        pin(screen.view)
        screen.didMove(toParent: self)
        screenHost = screen

        // The bar and the page's messages: a full-screen layer that takes only touches on what it
        // draws (the frames ShellBar reports), so everything else reaches what's under it.
        let bar = UIHostingController(rootView: ShellBar(model: model))
        bar.view.backgroundColor = .clear
        let layer = PassthroughView()
        layer.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(layer)
        pin(layer)
        addChild(bar)
        bar.view.translatesAutoresizingMaskIntoConstraints = false
        layer.addSubview(bar.view)
        NSLayoutConstraint.activate([
            bar.view.leadingAnchor.constraint(equalTo: layer.leadingAnchor),
            bar.view.trailingAnchor.constraint(equalTo: layer.trailingAnchor),
            bar.view.topAnchor.constraint(equalTo: layer.topAnchor),
            bar.view.bottomAnchor.constraint(equalTo: layer.bottomAnchor),
        ])
        bar.didMove(toParent: self)
        barHost = bar
        barLayer = layer

        model.host = self
        layout(animated: false)
    }

    private func pin(_ v: UIView) {
        NSLayoutConstraint.activate([
            v.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            v.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            v.topAnchor.constraint(equalTo: view.topAnchor),
            v.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
    }

    /// The native screen shown or not, and over or under the page. Faded out it takes no touches
    /// (and draws nothing: ShellScreens is empty while the page shows its own).
    func layout(animated: Bool) {
        guard let screen = screenHost?.view, let web = bridgeController?.view else { return }
        let native = model.shown != nil
        if model.pageOpen { view.insertSubview(web, aboveSubview: screen) } else { view.insertSubview(screen, aboveSubview: web) }
        if let bar = barLayer { view.bringSubviewToFront(bar) }
        let alpha: CGFloat = native ? 1 : 0
        guard screen.alpha != alpha else { return }
        if animated && !UIAccessibility.isReduceMotionEnabled {
            UIView.animate(withDuration: 0.22, delay: 0, options: [.beginFromCurrentState, .curveEaseOut]) { screen.alpha = alpha }
        } else {
            screen.alpha = alpha
        }
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .default }
    override var childForHomeIndicatorAutoHidden: UIViewController? { bridgeController }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { bridgeController?.supportedInterfaceOrientations ?? .allButUpsideDown }
}

/// The native screens (only Today so far), full screen while one shows.
struct ShellScreens: View {
    let model: ShellModel

    var body: some View {
        ZStack {
            if model.shown == "today" {
                TodayScreen(shell: model, today: model.today)
                    .transition(.opacity)
            } else if model.shown == "coach" {
                CoachScreen(shell: model, coach: model.coach)
                    .transition(.opacity)
            } else if model.shown == "activities" {
                ActivitiesScreen(shell: model, m: model.activities)
                    .transition(.opacity)
            } else if model.shown == "trends" {
                ProgressScreen(shell: model, m: model.progress)
                    .transition(.opacity)
            } else if model.shown == "chat" {
                ChatScreen(shell: model, chat: model.chat)
                    .transition(.opacity)
            } else if model.shown == "settings" {
                SettingsScreen(shell: model, m: model.settings)
                    .transition(.opacity)
            } else if model.shown == "you" {
                BodyScreen(shell: model, m: model.body)
                    .transition(.opacity)
            } else if model.shown == "record" {
                RecordScreen(shell: model, m: model.record)
                    .transition(.opacity)
            } else if model.shown == "routes" {
                RoutesScreen(shell: model, m: model.routes)
                    .transition(.opacity)
            } else if model.shown == "route", let e = model.routeEditor {
                RouteEditorScreen(shell: model, e: e)
                    .id(ObjectIdentifier(e))
                    .transition(.opacity)
            } else if model.shown == "face", let f = model.face {
                FaceBuilderScreen(shell: model, m: f)
                    .id(ObjectIdentifier(f))
                    .transition(.opacity)
            } else if model.shown == "lift", let l = model.lift {
                LiftScreen(shell: model, m: l)
                    .id(l.date)
                    .transition(.opacity)
            }
        }
        .animation(.smooth(duration: 0.25), value: model.shown)
        .tint(Brand.tint)
    }
}

/// A layer over everything that takes a touch only where the bar or a message is drawn (in the
/// window's coordinates, as SwiftUI's global frames are; the layer fills the window).
final class PassthroughView: UIView {
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let p = convert(point, to: nil)
        let rects = ShellModel.shared.touchRects.values
        guard rects.contains(where: { $0.contains(p) }) else { return nil }
        return super.hitTest(point, with: event)
    }
}

/// The bar and the page's messages, at the bottom, over everything. Each reports where it is,
/// so the layer takes touches there and nowhere else.
struct ShellBar: View {
    let model: ShellModel

    var body: some View {
        VStack(spacing: 10) {
            Spacer(minLength: 0)
            if let s = model.snack {
                SnackView(snack: s, model: model)
                    .padding(.horizontal, 16)
                    .touchArea("snack", model)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            if !model.barHidden {
                TabBar(model: model)
                    .touchArea("bar", model)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .padding(.bottom, 4)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .animation(.smooth(duration: 0.3), value: model.barHidden)
        .animation(.smooth(duration: 0.3), value: model.snack)
        .tint(Brand.tint)
        .fullScreenCover(item: Binding(get: { model.intro }, set: { model.intro = $0 })) { m in
            IntroScreen(m: m, shell: model)
        }
        .sheet(item: Binding(get: { model.sheet }, set: { model.sheet = $0 })) { sheet in
            Group {
                switch sheet {
                case .session(let m): SessionSheetView(m: m, shell: model)
                case .workout(let m): WorkoutSheetView(m: m, shell: model)
                }
            }
            .tint(Brand.tint)
        }
    }
}

extension View {
    /** Where this is drawn, for the layer's hit test; gone with it. */
    func touchArea(_ key: String, _ model: ShellModel) -> some View {
        onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { model.touchRects[key] = $0 }
            .onDisappear { model.touchRects[key] = nil }
    }
}
