import SwiftUI
import GameController
#if canImport(WebKit)
import WebKit
#endif

// Optional UIKit import for iOS
#if canImport(UIKit)
import UIKit
#endif

// MARK: - SwiftUI View

struct ContentView: View {
    var body: some View {
        if let url = Bundle.module.url(forResource: "index", withExtension: "html", subdirectory: "lux") {
            WebViewWrapper(url: url)
                .edgesIgnoringSafeArea(.bottom)
        } else if let url = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "lux") {
            WebViewWrapper(url: url)
                .edgesIgnoringSafeArea(.bottom)
        } else {
            Text("Could not find lux/index.html")
        }
    }
}

// MARK: - macOS Implementation

#if os(macOS)
struct WebViewWrapper: NSViewControllerRepresentable {
    let url: URL
    func makeNSViewController(context: Context) -> WebViewController {
        return WebViewController(url: url)
    }
    func updateNSViewController(_ nsViewController: WebViewController, context: Context) {
    }
}

class WebViewController: NSViewController, WKScriptMessageHandler {
    var webView: WKWebView!
    var url: URL

    init(url: URL) {
        self.url = url
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func loadView() {
        let config = WKWebViewConfiguration()
        let prefs = WKWebpagePreferences()
        prefs.allowsContentJavaScript = true
        config.defaultWebpagePreferences = prefs
        
        let userContentController = WKUserContentController()
        userContentController.add(self, name: "pointerLock")
        config.userContentController = userContentController
        
        webView = WKWebView(frame: .zero, configuration: config)
        webView.configuration.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
        view = webView
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "pointerLock", let body = message.body as? String, body == "lock" {
            // macOS pointer lock is natively supported by WebKit usually, so this is just a placeholder.
        }
    }
}

// MARK: - iOS / iPadOS Implementation

#else
struct WebViewWrapper: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> WebViewController {
        return WebViewController(url: url)
    }
    func updateUIViewController(_ uiViewController: WebViewController, context: Context) {
    }
}

class TouchDownGestureRecognizer: UIGestureRecognizer {
    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesBegan(touches, with: event)
        if state == .possible {
            state = .recognized
        }
    }
}

class WebViewController: UIViewController, WKScriptMessageHandler, UIGestureRecognizerDelegate {
    static var globalIsPointerLocked = false
    static var hasSwizzled = false

    var webView: WKWebView!
    var url: URL
    
    var isPointerLocked = false {
        didSet {
            if isPointerLocked {
                lockedAt = Date()
            }
            WebViewController.globalIsPointerLocked = isPointerLocked
            updatePointerLockState()
        }
    }
    
    var lockedAt: Date?
    
    var isReadyForPointerLock = false
    
    var accumMoveX: CGFloat = 0
    var accumMoveY: CGFloat = 0
    var accumWheelX: CGFloat = 0
    var accumWheelY: CGFloat = 0
    
    var displayLink: CADisplayLink?
    
    init(url: URL) {
        self.url = url
        super.init(nibName: nil, bundle: nil)
    }
    
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
    
    override func loadView() {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        let prefs = WKWebpagePreferences()
        prefs.allowsContentJavaScript = true
        config.defaultWebpagePreferences = prefs
        
        let userContentController = WKUserContentController()
        userContentController.add(self, name: "pointerLock")
        config.userContentController = userContentController
        
        webView = WKWebView(frame: .zero, configuration: config)
        webView.configuration.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
        webView.scrollView.isScrollEnabled = false
        if #available(iOS 11.0, *) {
            webView.scrollView.contentInsetAdjustmentBehavior = .never
        }
        view = webView
    }
    
    override func viewDidLoad() {
        super.viewDidLoad()
        
        if !WebViewController.hasSwizzled {
            WebViewController.hasSwizzled = true
            let original = #selector(getter: UIViewController.prefersPointerLocked)
            let swizzled = #selector(getter: UIViewController.lux_prefersPointerLocked)
            if let originalMethod = class_getInstanceMethod(UIViewController.self, original),
               let swizzledMethod = class_getInstanceMethod(UIViewController.self, swizzled) {
                method_exchangeImplementations(originalMethod, swizzledMethod)
            }
        }
        
        webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        
        // 1. Scroll tracking via explicit UIKit Pan (since GCMouse misses iPadOS trackpad scrolls)
        if #available(iOS 13.4, *) {
            let scrollGesture = UIPanGestureRecognizer(target: self, action: #selector(handleScroll(_:)))
            scrollGesture.allowedScrollTypesMask = .all
            scrollGesture.allowedTouchTypes = [] // Important: Only capture scrolls, not touches!
            scrollGesture.cancelsTouchesInView = false
            scrollGesture.delegate = self
            view.addGestureRecognizer(scrollGesture)
        }
        
        // 2. Sink gesture to absorb generic touches while locked (kills WebKit context menus)
        let sinkGesture = UILongPressGestureRecognizer(target: nil, action: nil)
        sinkGesture.minimumPressDuration = 0
        sinkGesture.cancelsTouchesInView = true
        sinkGesture.delegate = self
        view.addGestureRecognizer(sinkGesture)
        
        let relockGesture = TouchDownGestureRecognizer(target: self, action: #selector(handleRelockTap))
        relockGesture.cancelsTouchesInView = false
        relockGesture.delegate = self
        view.addGestureRecognizer(relockGesture)
        
        // 3. Pointer capture via GameController for raw trackpad accuracy
        if #available(iOS 14.0, *) {
            NotificationCenter.default.addObserver(self, selector: #selector(mouseDidConnect(_:)), name: .GCMouseDidConnect, object: nil)
            NotificationCenter.default.addObserver(self, selector: #selector(pointerLockStateDidChange(_:)), name: UIPointerLockState.didChangeNotification, object: nil)
            if let mouse = GCMouse.current {
                setupMouse(mouse)
            } else if let mouse = GCMouse.mice().first {
                setupMouse(mouse)
            }
        }
        
        displayLink = CADisplayLink(target: self, selector: #selector(displayLinkFired))
        displayLink?.add(to: .main, forMode: .common)
    }
    
    override var canBecomeFirstResponder: Bool {
        return true
    }

    override var keyCommands: [UIKeyCommand]? {
        return [
            UIKeyCommand(input: UIKeyCommand.inputEscape, modifierFlags: [], action: #selector(handleEscapeKey))
        ]
    }
    
    @objc func handleEscapeKey() {
        if isPointerLocked {
            isPointerLocked = false
            let js = "window.nativeIsPointerLocked = false; if (window.nativeSendEscape) { window.nativeSendEscape(); }"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        if gestureRecognizer is TouchDownGestureRecognizer {
            return true
        }
        return isPointerLocked
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        return true
    }
    
    @objc func handleRelockTap() {
        if isReadyForPointerLock && !isPointerLocked {
            self.becomeFirstResponder()
            isPointerLocked = true
        }
    }
    
    @objc func handleScroll(_ gesture: UIPanGestureRecognizer) {
        guard isPointerLocked else { return }
        if gesture.state == .changed || gesture.state == .ended {
            let translation = gesture.translation(in: view)
            gesture.setTranslation(.zero, in: view)
            
            accumWheelX += -translation.x
            accumWheelY += -translation.y
        }
    }
    
    @objc func displayLinkFired() {
        guard isPointerLocked else { return }
        
        let ix = trunc(accumMoveX)
        let iy = trunc(accumMoveY)
        
        let sx = trunc(accumWheelX)
        let sy = trunc(accumWheelY)
        
        var js = ""
        
        if ix != 0 || iy != 0 {
            accumMoveX -= ix
            accumMoveY -= iy
            js += "if (window.nativeMouseMove) { window.nativeMouseMove(\(ix), \(iy)); }"
        }
        
        if sx != 0 || sy != 0 {
            accumWheelX -= sx
            accumWheelY -= sy
            js += "if (window.nativeWheel) { window.nativeWheel(\(sx), \(sy)); }"
        }
        
        if !js.isEmpty {
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
        
        if #available(iOS 14.0, *) {
            var isAnySceneLocked = false
            for scene in UIApplication.shared.connectedScenes {
                if let windowScene = scene as? UIWindowScene, let state = windowScene.pointerLockState {
                    if state.isLocked {
                        isAnySceneLocked = true
                        break
                    }
                }
            }
            if !isAnySceneLocked && isPointerLocked {
                if let lockedAt = lockedAt, Date().timeIntervalSince(lockedAt) > 0.5 {
                    // The system forced an unlock, and we didn't catch it via notification
                    isPointerLocked = false
                    let fallbackJs = "window.nativeIsPointerLocked = false; if (window.nativeSendEscape) { window.nativeSendEscape(); }"
                    webView.evaluateJavaScript(fallbackJs, completionHandler: nil)
                }
            }
        }
    }
    
    @available(iOS 14.0, *)
    @objc func mouseDidConnect(_ notification: Notification) {
        guard let mouse = notification.object as? GCMouse else { return }
        setupMouse(mouse)
    }

    @available(iOS 14.0, *)
    @objc func pointerLockStateDidChange(_ notification: Notification) {
        let state: UIPointerLockState?
        if let scene = notification.object as? UIScene {
            state = scene.pointerLockState
        } else if let scene = view.window?.windowScene {
            state = scene.pointerLockState
        } else {
            return
        }
        
        if let state = state, !state.isLocked && isPointerLocked {
            // The system forced an unlock (e.g. user pressed ESC)
            isPointerLocked = false
            let js = "window.nativeIsPointerLocked = false; if (window.nativeSendEscape) { window.nativeSendEscape(); }"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    @available(iOS 14.0, *)
    func setupMouse(_ mouse: GCMouse) {
        guard let mouseInput = mouse.mouseInput else { return }
        
        mouseInput.mouseMovedHandler = { [weak self] (input: GCMouseInput, deltaX: Float, deltaY: Float) in
            guard let self = self, self.isPointerLocked else { return }
            
            // Float accumulation avoids fractional hardware trackpad movement wipeout.
            // GameController Y is mathematically inverted from web coordinates (Positive is Up natively vs Positive is Down in browser)
            self.accumMoveX += CGFloat(deltaX)
            self.accumMoveY += CGFloat(-deltaY)
        }
        
        mouseInput.leftButton.pressedChangedHandler = { [weak self] (button: GCControllerButtonInput, value: Float, pressed: Bool) in
            guard let self = self, self.isPointerLocked else { return }
            let js = "if (window.nativeMouseDown) { window.nativeMouse\(pressed ? "Down" : "Up")(0); }"
            self.webView.evaluateJavaScript(js, completionHandler: nil)
        }
        
        mouseInput.rightButton?.pressedChangedHandler = { [weak self] (button: GCControllerButtonInput, value: Float, pressed: Bool) in
            guard let self = self, self.isPointerLocked else { return }
            let js = "if (window.nativeMouseDown) { window.nativeMouse\(pressed ? "Down" : "Up")(2); }"
            self.webView.evaluateJavaScript(js, completionHandler: nil)
        }
        
        mouseInput.middleButton?.pressedChangedHandler = { [weak self] (button: GCControllerButtonInput, value: Float, pressed: Bool) in
            guard let self = self, self.isPointerLocked else { return }
            let js = "if (window.nativeMouseDown) { window.nativeMouse\(pressed ? "Down" : "Up")(1); }"
            self.webView.evaluateJavaScript(js, completionHandler: nil)
        }
    }
    
    @available(iOS 14.0, *)
    func clearMouse(_ mouse: GCMouse) {
        guard let mouseInput = mouse.mouseInput else { return }
        mouseInput.mouseMovedHandler = nil
        mouseInput.leftButton.pressedChangedHandler = nil
        mouseInput.rightButton?.pressedChangedHandler = nil
        mouseInput.middleButton?.pressedChangedHandler = nil
    }
    
    override var prefersPointerLocked: Bool {
        return isPointerLocked
    }

    func updatePointerLockState() {
        if #available(iOS 14.0, *) {
            self.setNeedsUpdateOfPrefersPointerLocked()
            
            let js = "window.nativeIsPointerLocked = \(isPointerLocked ? "true" : "false");"
            webView.evaluateJavaScript(js, completionHandler: nil)
            
            if isPointerLocked {
                if let mouse = GCMouse.current {
                    setupMouse(mouse)
                } else if let mouse = GCMouse.mice().first {
                    setupMouse(mouse)
                }
            } else {
                if let mouse = GCMouse.current {
                    clearMouse(mouse)
                } else if let mouse = GCMouse.mice().first {
                    clearMouse(mouse)
                }
            }
            
            for scene in UIApplication.shared.connectedScenes {
                if let windowScene = scene as? UIWindowScene, windowScene.activationState == .foregroundActive {
                    for window in windowScene.windows {
                        window.rootViewController?.setNeedsUpdateOfPrefersPointerLocked()
                    }
                }
            }
        }
    }
    
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "pointerLock", let body = message.body as? String {
            if body == "lock" {
                isPointerLocked = true
            } else if body == "unlock" {
                isPointerLocked = false
            } else if body == "ready" {
                isReadyForPointerLock = true
            }
        }
    }
}

extension UIViewController {
    @objc var lux_prefersPointerLocked: Bool {
        if WebViewController.globalIsPointerLocked {
            return true
        }
        return self.lux_prefersPointerLocked
    }
}
#endif
