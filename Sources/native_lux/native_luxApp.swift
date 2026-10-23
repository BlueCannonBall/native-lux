import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)

        if let url = Bundle.module.url(forResource: "index", withExtension: "html"),
            let script = Bundle.module.url(forResource: "NativeAdapter", withExtension: "js"),
            let adapter = try? String(contentsOf: script, encoding: .utf8)
        {
            window.rootViewController = WebViewController(url: url, adapter: adapter)
        } else {
            window.rootViewController = MissingResourceViewController()
        }

        self.window = window
        window.makeKeyAndVisible()
    }

    func sceneDidDisconnect(_ scene: UIScene) {
        (window?.rootViewController as? WebViewController)?.cleanup()
        window = nil
    }

    func sceneWillResignActive(_ scene: UIScene) {
        (window?.rootViewController as? WebViewController)?.sceneActivityChanged(active: false)
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        (window?.rootViewController as? WebViewController)?.sceneActivityChanged(active: true)
    }
}

final class MissingResourceViewController: UIViewController {
    override func loadView() {
        let label = UILabel()
        label.text = "Could not find the bundled Lux client. Run git submodule update --init --recursive, then rebuild."
        label.textAlignment = .center
        label.numberOfLines = 0
        view = label
    }
}
