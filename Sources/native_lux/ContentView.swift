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
    var isClientSideMouse = false
    var storedMouseSensitivity: CGFloat = 1.5
    
    var cursorView: UIImageView?
    var virtualMouseX: CGFloat = 0
    var virtualMouseY: CGFloat = 0
    
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
        
        // Native cursor overlay — renders on top of WKWebView with zero IPC latency
        if let mouseURL = Bundle.module.url(forResource: "mouse", withExtension: "png", subdirectory: "lux"),
           let mouseData = try? Data(contentsOf: mouseURL),
           let mouseImage = UIImage(data: mouseData) {
            let scale: CGFloat = 40.0
            let cursorSize = CGSize(width: mouseImage.size.width / scale, height: mouseImage.size.height / scale)
            let imageView = UIImageView(image: mouseImage)
            imageView.frame = CGRect(origin: .zero, size: cursorSize)
            imageView.isHidden = true
            imageView.isUserInteractionEnabled = false
            imageView.layer.shadowColor = UIColor.black.cgColor
            imageView.layer.shadowOpacity = 0.3
            imageView.layer.shadowOffset = CGSize(width: 1.5, height: 1.5)
            imageView.layer.shadowRadius = 2.5
            view.addSubview(imageView)
            self.cursorView = imageView
        }
        
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
            isPointerLocked = true
        }
    }
    
    @objc func handleScroll(_ gesture: UIPanGestureRecognizer) {
        guard isPointerLocked else { return }
        if gesture.state == .changed || gesture.state == .ended {
            let translation = gesture.translation(in: view)
            gesture.setTranslation(.zero, in: view)
            
            let dx = -translation.x
            let dy = -translation.y
            if dx != 0 || dy != 0 {
                let js = "if (window.nativeWheel) { window.nativeWheel(\(dx), \(dy)); }"
                webView.evaluateJavaScript(js, completionHandler: nil)
            }
        }
    }
    
    @objc func displayLinkFired() {
        guard isPointerLocked else { return }
        
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
            
            // Update native cursor overlay immediately (zero latency)
            if self.isClientSideMouse, let cursorView = self.cursorView {
                let dx = CGFloat(deltaX) * self.storedMouseSensitivity
                let dy = CGFloat(-deltaY) * self.storedMouseSensitivity
                self.virtualMouseX = min(max(self.virtualMouseX + dx, 0), self.view.bounds.width - 1)
                self.virtualMouseY = min(max(self.virtualMouseY + dy, 0), self.view.bounds.height - 1)
                // Snap to pixel grid to avoid sub-pixel anti-aliasing shimmer
                let scale = self.view.window?.screen.scale ?? UIScreen.main.scale
                let snappedX = round(self.virtualMouseX * scale) / scale
                let snappedY = round(self.virtualMouseY * scale) / scale
                CATransaction.begin()
                CATransaction.setDisableActions(true)
                cursorView.layer.position = CGPoint(x: snappedX + cursorView.bounds.width / 2, y: snappedY + cursorView.bounds.height / 2)
                CATransaction.commit()
                CATransaction.flush()
            }
            
            // Sync to JS for server forwarding (latency here is fine — not on visual critical path)
            // GameController Y is mathematically inverted from web coordinates (Positive is Up natively vs Positive is Down in browser)
            if self.isClientSideMouse {
                let js = "if (window.nativeMouseMoveAbs) { window.nativeMouseMoveAbs(\(self.virtualMouseX), \(self.virtualMouseY)); }"
                self.webView.evaluateJavaScript(js, completionHandler: nil)
            } else {
                let js = "if (window.nativeMouseMove) { window.nativeMouseMove(\(deltaX), \(-deltaY)); }"
                self.webView.evaluateJavaScript(js, completionHandler: nil)
            }
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
                if isClientSideMouse {
                    virtualMouseX = view.bounds.width / 2
                    virtualMouseY = view.bounds.height / 2
                    cursorView?.frame.origin = CGPoint(x: virtualMouseX, y: virtualMouseY)
                    cursorView?.isHidden = false
                }
                if let mouse = GCMouse.current {
                    setupMouse(mouse)
                } else if let mouse = GCMouse.mice().first {
                    setupMouse(mouse)
                }
            } else {
                cursorView?.isHidden = true
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
            } else if body.hasPrefix("csm:") {
                // Client-side mouse config: "csm:<sensitivity>"
                isClientSideMouse = true
                let sensitivityStr = String(body.dropFirst("csm:".count))
                storedMouseSensitivity = CGFloat(Double(sensitivityStr) ?? 1.5)
                // Tell JS to skip canvas cursor drawing — native overlay handles it
                webView.evaluateJavaScript("window.nativeCursorOverlay = true;", completionHandler: nil)
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
