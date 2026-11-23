import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        // The shell: the web app with Tartan's native screens and bar over it (Shell/). The
        // storyboard makes the same one; a window without it gets one here.
        if !(window?.rootViewController is ShellViewController) {
            window = UIWindow(windowScene: windowScene)
            window?.rootViewController = ShellViewController()
        }
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        // Garmin Connect handing back the watch picked in its device selection (GarminLink).
        let rest = URLContexts.filter { !GarminLink.shared.handle($0.url) }
        if !rest.isEmpty { SceneDelegateProxy.shared.scene(scene, openURLContexts: rest) }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
