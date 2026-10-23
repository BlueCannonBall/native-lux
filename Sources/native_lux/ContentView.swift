import UIKit
@preconcurrency import GameController
@preconcurrency import WebKit

/// Only native responsibilities: WebKit hosting, UIKit capture, raw input, and
/// the cursor's latency-sensitive rendering. Lux owns credentials and networking.
@MainActor
final class WebViewController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate,
    UIGestureRecognizerDelegate
{
    private let url: URL
    private let adapter: String
    private var webView: WKWebView!
    private var cursor: UIImageView!
    private var position: CGPoint?
    private var viewportSize = CGSize.zero
    private var mouse: GCMouse?
    private var ready = false
    private var requested = false
    private var capturing = false
    private var clientSideMouse = false
    private var sensitivity: CGFloat = 1.5
    private var interrupted = false
    private var documentID: String?
    private var documentArgument = "null"
    private var sequence = 0
    private var lastState: [Bool] = []
    private var lockMonitor: Timer?
    private var alertCompletion: CheckedContinuation<Void, Never>?
    private weak var javaScriptAlert: UIAlertController?

    init(url: URL, adapter: String) {
        self.url = url
        self.adapter = adapter
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override var prefersStatusBarHidden: Bool { false }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var prefersPointerLocked: Bool { requested && ready && mouse != nil }

    override var keyCommands: [UIKeyCommand]? {
        guard requested else { return nil }
        let command = UIKeyCommand(input: UIKeyCommand.inputEscape, modifierFlags: [], action: #selector(escape))
        command.wantsPriorityOverSystemBehavior = true
        return [command]
    }

    override func loadView() {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.userContentController.add(WeakScriptMessageHandler(self), name: "nativeLux")
        configuration.userContentController.addUserScript(WKUserScript(
            source: adapter, injectionTime: .atDocumentStart, forMainFrameOnly: true
        ))
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        #if DEBUG
        webView.isInspectable = true
        #endif
        view = webView
        cursor = UIImageView(image: Bundle.module.url(forResource: "mouse", withExtension: "png")
            .flatMap { UIImage(contentsOfFile: $0.path) })
        cursor.bounds.size = CGSize(width: (cursor.image?.size.width ?? 0) / 40, height: (cursor.image?.size.height ?? 0) / 40)
        cursor.isUserInteractionEnabled = false
        cursor.isHidden = true
        cursor.layer.shadowColor = UIColor.black.cgColor
        cursor.layer.shadowOpacity = 0.3
        cursor.layer.shadowOffset = CGSize(width: 1.5, height: 1.5)
        cursor.layer.shadowRadius = 2.5
        view.addSubview(cursor)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        let scroll = UIPanGestureRecognizer(target: self, action: #selector(scroll(_:)))
        scroll.allowedScrollTypesMask = .all
        scroll.allowedTouchTypes = []
        scroll.cancelsTouchesInView = false
        scroll.delegate = self
        view.addGestureRecognizer(scroll)
        let clicks = UILongPressGestureRecognizer(target: nil, action: nil)
        clicks.minimumPressDuration = 0
        clicks.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.indirectPointer.rawValue)]
        clicks.delaysTouchesBegan = true
        clicks.delegate = self
        view.addGestureRecognizer(clicks)
        for name in [Notification.Name.GCMouseDidConnect, .GCMouseDidDisconnect, .GCMouseDidBecomeCurrent] {
            NotificationCenter.default.addObserver(self, selector: #selector(mouseChanged(_:)), name: name, object: nil)
        }
        NotificationCenter.default.addObserver(self, selector: #selector(lockChanged),
            name: UIPointerLockState.didChangeNotification, object: nil)
        selectMouse(GCMouse.current ?? GCMouse.mice().first)
        webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        synchronize()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        guard viewportSize != view.bounds.size else { return }
        viewportSize = view.bounds.size
        input("layout", "0,0")
        if capturing && clientSideMouse { updateCursor() }
    }

    func sceneActivityChanged(active: Bool) {
        interrupted = !active
        synchronize()
        if !active { input("reset", "0,0") }
    }

    @objc private func escape() { release(escape: true) }
    @objc private func lockChanged() { synchronize() }

    private func release(escape: Bool = false) {
        let sendEscape = escape && requested
        requested = false
        setNeedsUpdateOfPrefersPointerLocked()
        synchronize(force: true, escape: sendEscape)
    }

    private func synchronize(force: Bool = false, escape: Bool = false) {
        let scene = viewIfLoaded?.window?.windowScene
        let lock = scene?.pointerLockState
        let active = !interrupted && scene?.activationState == .foregroundActive && presentedViewController == nil
        let state = [requested, lock?.isLocked == true, active, mouse != nil, lock != nil]
        let wasCapturing = capturing
        capturing = ready && state.allSatisfy { $0 }
        cursor?.isHidden = !(capturing && clientSideMouse)
        if force || state != lastState {
            lastState = state
            send("state(\(documentArgument),{requested:\(requested),locked:\(state[1]),active:\(active),mouse:\(state[3]),supported:\(state[4]),sequence:\(sequence),escape:\(escape)})")
            if capturing && !wasCapturing {
                webView.becomeFirstResponder()
                if clientSideMouse { updateCursor() }
            }
        }
        // This timer only checks capture state if a UIKit notification is missed.
        // It never schedules, batches, or forwards mouse movement.
        if requested && lockMonitor == nil {
            let timer = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.synchronize() }
            }
            RunLoop.main.add(timer, forMode: .common)
            lockMonitor = timer
        } else if !requested {
            lockMonitor?.invalidate()
            lockMonitor = nil
        }
    }

    private func send(_ call: String) {
        guard documentID != nil else { return }
        // April's immediate submission path: no frame tick, application queue,
        // per-event JSON encoder, or completion-handler serialization.
        webView.evaluateJavaScript("window.nativeLux?.\(call);", completionHandler: nil)
    }

    private func input(_ type: String, _ arguments: String) {
        send("input(\(documentArgument),'\(type)',\(arguments))")
    }

    @objc private func mouseChanged(_ notification: Notification) {
        let removed = notification.name == .GCMouseDidDisconnect ? notification.object as? GCMouse : nil
        let mice = GCMouse.mice().filter { $0 !== removed }
        let current = GCMouse.current.flatMap { current in mice.first { $0 === current } }
        selectMouse(current ?? mice.first)
    }

    private func selectMouse(_ next: GCMouse?) {
        guard mouse !== next else { return }
        if let old = mouse?.mouseInput {
            old.mouseMovedHandler = nil
            ([old.leftButton] + [old.rightButton, old.middleButton].compactMap { $0 } + (old.auxiliaryButtons ?? []))
                .forEach { $0.pressedChangedHandler = nil }
        }
        input("reset", "0,0")
        mouse = next?.mouseInput == nil ? nil : next
        if let next = mouse, let profile = next.mouseInput {
            next.handlerQueue = .main
            profile.mouseMovedHandler = { [weak self, weak next] _, x, y in
                MainActor.assumeIsolated {
                    guard let self, let next, self.mouse === next, self.capturing, x.isFinite, y.isFinite else { return }
                    if self.clientSideMouse {
                        var point = self.position ?? CGPoint(x: self.view.bounds.midX, y: self.view.bounds.midY)
                        point.x += CGFloat(x) * self.sensitivity
                        point.y -= CGFloat(y) * self.sensitivity
                        self.position = point
                        self.updateCursor()
                    } else { self.input("relative", "\(x),\(-y)") }
                }
            }
            var buttons = [(profile.leftButton, 0)]
            if let button = profile.rightButton { buttons.append((button, 2)) }
            if let button = profile.middleButton { buttons.append((button, 1)) }
            for (index, button) in (profile.auxiliaryButtons ?? []).prefix(2).enumerated() { buttons.append((button, index + 3)) }
            for (button, number) in buttons {
                button.pressedChangedHandler = { [weak self, weak next] _, _, pressed in
                    MainActor.assumeIsolated {
                        guard let self, let next, self.mouse === next else { return }
                        // Identify the activation click from GameController, not
                        // WebKit's potentially touch-labeled compatibility event.
                        if !self.requested && self.ready && pressed && number == 0,
                            self.view.window?.windowScene?.pointerLockState != nil
                        {
                            self.requested = true
                            self.setNeedsUpdateOfPrefersPointerLocked()
                            self.synchronize(force: true)
                            return
                        }
                        guard self.capturing else { return }
                        self.input("button", "\(number),\(pressed)")
                    }
                }
            }
        }
        setNeedsUpdateOfPrefersPointerLocked()
        synchronize()
    }

    private func updateCursor() {
        var point = position ?? CGPoint(x: view.bounds.midX, y: view.bounds.midY)
        point.x = min(max(point.x, 0), max(view.bounds.width - 1, 0))
        point.y = min(max(point.y, 0), max(view.bounds.height - 1, 0))
        position = point
        let scale = view.window?.screen.scale ?? 2
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        cursor.layer.position = CGPoint(x: (point.x * scale).rounded() / scale + cursor.bounds.width / 2,
            y: (point.y * scale).rounded() / scale + cursor.bounds.height / 2)
        CATransaction.commit()
        CATransaction.flush() // Preserve April's explicitly flushed native cursor.
        input("absolute", "\(point.x),\(point.y)")
    }

    @objc private func scroll(_ gesture: UIPanGestureRecognizer) {
        guard capturing, gesture.state == .changed || gesture.state == .ended else { return }
        let delta = gesture.translation(in: view)
        gesture.setTranslation(.zero, in: view)
        input("wheel", "\(-delta.x),\(-delta.y)")
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool { capturing }
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "nativeLux", message.frameInfo.isMainFrame, isBundled(message.frameInfo.request.url),
            let body = message.body as? [String: Any], body["version"] as? Int == 1,
            let id = body["documentID"] as? String, id.count <= 128,
            let nextSequence = body["sequence"] as? Int, nextSequence > 0,
            let type = body["type"] as? String
        else { return }
        if type == "loaded" {
            reset()
            documentID = id
            documentArgument = String(decoding: (try? JSONEncoder().encode(id)) ?? Data("null".utf8), as: UTF8.self)
        }
        guard id == documentID, nextSequence > sequence else { return }
        sequence = nextSequence
        switch type {
        case "configure":
            requested = false
            ready = body["ready"] as? Bool == true
            clientSideMouse = body["clientSideMouse"] as? Bool == true
            let value = body["sensitivity"] as? Double ?? 1.5
            sensitivity = value.isFinite ? CGFloat(min(2.9, max(0.1, value))) : 1.5
            position = nil
        case "capture": requested = ready
        case "release": release(escape: body["escape"] as? Bool == true); return
        default: break
        }
        setNeedsUpdateOfPrefersPointerLocked()
        synchronize(force: true)
    }

    private func isBundled(_ candidate: URL?) -> Bool {
        candidate?.isFileURL == true && candidate?.standardizedFileURL.path == url.standardizedFileURL.path
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard action.targetFrame?.isMainFrame == true else { return .cancel }
        if isBundled(action.request.url) { return .allow }
        // Upstream's file-origin error recovery produces a relative "null/..." URL.
        let recovery = URL(string: "null" + url.path, relativeTo: url)?.absoluteURL
        if action.request.url?.standardizedFileURL == recovery?.standardizedFileURL {
            webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        }
        return .cancel
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { reset() }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { reset(); webView.reload() }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async {
        guard frame.isMainFrame, isBundled(frame.request.url), presentedViewController == nil else { return }
        await withCheckedContinuation { continuation in
            let alert = UIAlertController(title: "Lux", message: message, preferredStyle: .alert)
            alertCompletion = continuation
            javaScriptAlert = alert
            alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak self] _ in self?.finishAlert() })
            present(alert, animated: true)
            synchronize()
        }
    }

    private func finishAlert() {
        let completion = alertCompletion
        alertCompletion = nil
        javaScriptAlert = nil
        completion?.resume()
    }

    private func reset() {
        javaScriptAlert?.dismiss(animated: false)
        finishAlert()
        ready = false
        release()
        documentID = nil
        documentArgument = "null"
        sequence = 0
        lastState = []
        position = nil
    }

    func cleanup() {
        reset()
        NotificationCenter.default.removeObserver(self)
        selectMouse(nil)
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "nativeLux")
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
    }
}

@MainActor
private final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    weak var delegate: WKScriptMessageHandler?
    init(_ delegate: WKScriptMessageHandler) { self.delegate = delegate }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        delegate?.userContentController(controller, didReceive: message)
    }
}
