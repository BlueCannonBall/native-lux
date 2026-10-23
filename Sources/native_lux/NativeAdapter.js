/* native-lux's only web compatibility layer. Never edit WebClient to integrate it. */
(() => {
    "use strict";
    const messageHandler = window.webkit?.messageHandlers?.nativeLux;
    if (!messageHandler || window.nativeLux) return;

    const documentID = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    const generatedEvents = new WeakSet();
    const pressedButtons = new Set();
    const pressedKeys = new Map();
    const activePointers = new Map();
    const endedTouches = [];
    const escapeShortcutKeys = new Set();
    const pendingLocks = [];
    let sequence = 0;
    let captureCommandSequence = 0;
    let canvas = null;
    let clientSideMouse = false;
    let locked = false;
    let requested = false;
    let phase = "idle";
    let captureCancelled = false;
    let remainderX = 0, remainderY = 0;
    let clientX = innerWidth / 2, clientY = innerHeight / 2;
    let suppressEscapeUp = false;
    let canvasGeometry = "";
    let layoutDirty = true;
    let viewportScale = 1, viewportLeft = 0, viewportTop = 0;
    let lastPointerType = "";
    let platformState = {};

    function post(type, fields = {}) {
        sequence += 1;
        if (type === "capture" || type === "release") captureCommandSequence = sequence;
        messageHandler.postMessage({ version: 1, documentID, sequence, type, ...fields });
    }

    function emit(target, event) {
        generatedEvents.add(event);
        target.dispatchEvent(event);
    }

    function buttonMask() {
        let mask = 0;
        for (const button of pressedButtons) mask |= [1, 4, 2, 8, 16][button] ?? 0;
        return mask;
    }

    function refreshCanvasLayout(force = false) {
        if (!canvas?.isConnected) return;
        const video = document.querySelector("video");
        const geometry = [canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio,
            video?.videoWidth, video?.videoHeight].join(":");
        if (force || geometry !== canvasGeometry) {
            canvasGeometry = geometry;
            // Native layout may finish before WebKit dispatches window.resize.
            // Refresh upstream's own caches before delivering new coordinates.
            window.dispatchEvent(new Event("resize"));
        }
        layoutDirty = false;
    }

    function viewportChanged() {
        const viewport = window.visualViewport;
        viewportScale = viewport?.scale || 1;
        viewportLeft = viewport?.offsetLeft || 0;
        viewportTop = viewport?.offsetTop || 0;
        layoutDirty = true;
    }
    window.addEventListener("resize", viewportChanged);
    window.visualViewport?.addEventListener("resize", viewportChanged);
    window.visualViewport?.addEventListener("scroll", viewportChanged);
    viewportChanged();

    function mouse(type, fields = {}) {
        // A removed canvas still owns upstream's listeners. Deliver releases to
        // that element before forgetting it, so its remote buttons cannot stick.
        if (!canvas) return;
        // Lux sends only a button number for down/up, ignoring their clientX/Y.
        // Touch/Pencil may have moved the remote pointer since the last mouse
        // sample. Restore the native position first, including drag/forced releases.
        if (clientSideMouse && locked && (type === "mousedown" || type === "mouseup")) mouse("mousemove");
        if (clientSideMouse && layoutDirty) refreshCanvasLayout();
        const event = new MouseEvent(type, {
            bubbles: true, cancelable: true, clientX, clientY,
            buttons: buttonMask(), ...fields,
        });
        // WebKit versions differ in accepting movementX/Y in MouseEventInit.
        for (const key of ["movementX", "movementY"]) {
            if (key in fields) Object.defineProperty(event, key, { value: fields[key] });
        }
        emit(canvas, event);
    }

    function releaseInputs() {
        // Cancel upstream gestures before switching to native mouse input. Keep
        // recent touch-ups too: Lux deliberately retains a lone tap for 125 ms,
        // and a compatibility touch could otherwise turn it into a right click.
        const pointers = [...endedTouches, ...activePointers.values()];
        endedTouches.length = 0;
        activePointers.clear();
        for (const pointer of pointers) {
            if (!canvas) break;
            emit(canvas, new PointerEvent("pointercancel", {
                bubbles: true, pointerId: pointer.pointerId, pointerType: pointer.pointerType,
                clientX: pointer.clientX, clientY: pointer.clientY, width: pointer.width, height: pointer.height,
                pressure: 0, tiltX: pointer.tiltX, tiltY: pointer.tiltY,
                altitudeAngle: pointer.altitudeAngle, azimuthAngle: pointer.azimuthAngle,
            }));
        }
        for (const button of [...pressedButtons]) {
            pressedButtons.delete(button);
            mouse("mouseup", { button });
        }
        for (const [code, key] of [...pressedKeys].reverse()) {
            emit(document, new KeyboardEvent("keyup", { bubbles: true, code, key }));
        }
        pressedKeys.clear();
        remainderX = remainderY = 0;
    }

    function remoteEscape() {
        // Control may already have reached the host before '[' arrives. Release
        // it around the Escape pulse, then restore it if it is physically held.
        // Otherwise the supposedly pure Escape would become remote Ctrl+Escape.
        const controls = [...pressedKeys].filter(([code]) => code === "ControlLeft" || code === "ControlRight");
        for (const [code, key] of controls) emit(document, new KeyboardEvent("keyup", { bubbles: true, code, key }));
        for (const type of ["keydown", "keyup"]) {
            emit(document, new KeyboardEvent(type, { bubbles: true, code: "Escape", key: "Escape" }));
        }
        for (const [code, key] of controls) emit(document, new KeyboardEvent("keydown", { bubbles: true, code, key }));
    }

    // A synchronous JavaScript alert may block further native evaluateJavaScript
    // deliveries. Release remote input before entering that modal operation.
    const browserAlert = window.alert;
    window.alert = function (message) {
        releaseInputs();
        return browserAlert.call(window, message);
    };

    function settleLocks(error) {
        for (const pending of pendingLocks.splice(0)) {
            if (error) pending.reject(new DOMException(error, "NotAllowedError"));
            else pending.resolve();
        }
    }

    function requestLock(target) {
        if (target !== canvas || !canvas?.isConnected) {
            return Promise.reject(new DOMException("No interactive Lux canvas", "InvalidStateError"));
        }
        if (captureCancelled) {
            return Promise.reject(new DOMException("Capture was cancelled; click the canvas to retry", "NotAllowedError"));
        }
        if (locked) return Promise.resolve();
        const result = new Promise((resolve, reject) => pendingLocks.push({ resolve, reject }));
        if (!requested || phase === "unavailable") {
            releaseInputs();
            requested = true;
            phase = "pending";
            post("capture");
        }
        return result;
    }

    Object.defineProperty(Element.prototype, "requestPointerLock", {
        configurable: true, writable: true,
        value(options) {
            // Upstream retries a failed options-bearing request using the legacy
            // no-argument API. Do not let that fallback undo an explicit release
            // (or create an unhandled rejection after denial/canvas replacement).
            if (options === undefined && (captureCancelled || this !== canvas || !canvas?.isConnected)) return;
            return requestLock(this);
        },
    });
    Object.defineProperty(document, "pointerLockElement", {
        configurable: true, get: () => locked ? canvas : null,
    });
    Object.defineProperty(document, "exitPointerLock", {
        configurable: true, value() { captureCancelled = true; post("release"); },
    });

    function setState(event) {
        // Native callbacks can be queued behind a newer web request. An old idle
        // acknowledgement must not reject a lock just requested by this document.
        if (event.sequence < captureCommandSequence) return;
        const nextLocked = event.phase === "locked";
        const changed = locked !== nextLocked;
        if ((!event.requested && (requested || pendingLocks.length)) || event.phase === "unavailable") captureCancelled = true;
        else if (event.requested) captureCancelled = false;
        if (changed || event.phase !== phase || !event.requested) releaseInputs();
        locked = nextLocked;
        requested = event.requested === true;
        phase = event.phase;
        if (locked) settleLocks();
        else if (!requested || phase === "unavailable") {
            const hadPending = pendingLocks.length > 0;
            settleLocks(event.reason ?? "Mouse capture released");
            if (hadPending) document.dispatchEvent(new Event("pointerlockerror"));
        }
        if (changed) {
            document.dispatchEvent(new Event("pointerlockchange"));
            // Ask upstream's existing resize listener to redraw its canvas. This
            // removes/restores its touchpad cursor without calling Lux internals.
            refreshCanvasLayout(true);
        }
        if (event.escape) {
            suppressEscapeUp = true;
            for (const type of ["keydown", "keyup"]) {
                emit(document, new KeyboardEvent(type, { bubbles: true, key: "Escape", code: "Escape" }));
            }
        }
    }

    function state(id, platform) {
        if (id !== documentID || platform.sequence < captureCommandSequence) return;
        platformState = platform;
        const phase = !platform.requested || !canvas ? "idle"
            : !platform.supported ? "unavailable" : !platform.mouse ? "waitingForMouse"
                : !platform.active ? "suspended" : platform.locked ? "locked" : "pending";
        setState({ ...platform, phase });
    }

    // Called directly for each native sample, just like April's input path.
    // No application-level batching, frame scheduling, or acknowledgement gate.
    function input(id, type, x, y) {
        if (id !== documentID) return;
        if (type === "reset") { releaseInputs(); return; }
        if (type === "layout") { viewportChanged(); refreshCanvasLayout(true); return; }
        if (!locked || !canvas?.isConnected) return;
        switch (type) {
            case "relative": {
                if (clientSideMouse || !Number.isFinite(x) || !Number.isFinite(y)) break;
                const totalX = x + remainderX, totalY = y + remainderY;
                const deltaX = Math.round(totalX), deltaY = Math.round(totalY);
                remainderX = totalX - deltaX; remainderY = totalY - deltaY;
                if (deltaX || deltaY) mouse("mousemove", { movementX: deltaX, movementY: deltaY });
                break;
            }
            case "absolute": {
                if (!clientSideMouse || !Number.isFinite(x) || !Number.isFinite(y)) break;
                clientX = x / viewportScale + viewportLeft;
                clientY = y / viewportScale + viewportTop;
                mouse("mousemove");
                break;
            }
            case "button":
                if (!Number.isInteger(x) || x < 0 || x > 4) break;
                if (y) {
                    if (pressedButtons.has(x)) break;
                    pressedButtons.add(x);
                } else if (!pressedButtons.delete(x)) break;
                mouse(y ? "mousedown" : "mouseup", { button: x });
                break;
            case "wheel":
                if (!Number.isFinite(x) || !Number.isFinite(y)) break;
                emit(document, new WheelEvent("wheel", {
                    bubbles: true, cancelable: true, deltaMode: WheelEvent.DOM_DELTA_PIXEL,
                    deltaX: x, deltaY: y,
                }));
                break;
        }
    }

    // Capture is exclusive: GameController is the only pointer source. WebKit can
    // label an indirect mouse click as touch, so pointerType is not safe here.
    // Finger/Pencil input uses upstream normally after capture is released.
    function filterMouse(event) {
        if (generatedEvents.has(event)) return;
        if (requested && phase !== "unavailable") {
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
        }
        if (event.target === canvas && event instanceof PointerEvent && event.pointerType !== "mouse") {
            if (event.type === "pointerdown" || (event.type === "pointermove" && activePointers.has(event.pointerId))) {
                activePointers.set(event.pointerId, event);
            } else if (event.type === "pointerup" || event.type === "pointercancel") {
                activePointers.delete(event.pointerId);
                if (event.type === "pointerup" && event.pointerType === "touch") {
                    endedTouches.push(event);
                    if (endedTouches.length > 10) endedTouches.shift();
                }
            }
        }
        if (event.target === canvas && event.type === "pointerdown") lastPointerType = event.pointerType;
        if (event.target === canvas && event.type === "click") {
            const pointerType = event.pointerType || lastPointerType;
            if (pointerType === "touch" || pointerType === "pen") {
                // Both upstream and the adapter attach click-to-lock listeners.
                // A touch/Pencil compatibility click must reach neither of them.
                event.preventDefault();
                event.stopImmediatePropagation();
                return;
            }
        }
        if (event.type === "click" && event.isTrusted && event.target === canvas && !locked) captureCancelled = false;
        if (event.target === canvas && event.type === "mousedown") pressedButtons.add(event.button);
        if (event.type === "mouseup") pressedButtons.delete(event.button);
    }
    for (const type of ["mousemove", "mousedown", "mouseup", "wheel", "click", "dblclick", "contextmenu",
        "pointerdown", "pointermove", "pointerup", "pointercancel", "touchstart", "touchmove", "touchend", "touchcancel"]) {
        window.addEventListener(type, filterMouse, { capture: true, passive: false });
    }
    window.addEventListener("keydown", event => {
        if (generatedEvents.has(event) || !canvas) return;
        if (event.code === "BracketLeft" && event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
            event.preventDefault(); event.stopImmediatePropagation();
            escapeShortcutKeys.add(event.code);
            remoteEscape();
            return;
        }
        escapeShortcutKeys.delete(event.code);
        if (event.code === "Escape" && requested) {
            event.preventDefault(); event.stopImmediatePropagation();
            suppressEscapeUp = true;
            captureCancelled = true;
            post("release", { escape: true });
            return;
        }
        pressedKeys.set(event.code, event.key);
    }, true);
    window.addEventListener("keyup", event => {
        if (generatedEvents.has(event)) return;
        // Remember the consumed key, not keyup.ctrlKey: Control may be released
        // before '['. Each shortcut keydown already sent a balanced Escape pulse.
        if (escapeShortcutKeys.delete(event.code)) {
            event.preventDefault(); event.stopImmediatePropagation();
            return;
        }
        if (event.code === "Escape" && suppressEscapeUp) {
            suppressEscapeUp = false;
            event.preventDefault(); event.stopImmediatePropagation();
        }
        pressedKeys.delete(event.code);
    }, true);
    window.addEventListener("blur", releaseInputs);
    document.addEventListener("visibilitychange", () => { if (document.hidden) releaseInputs(); });
    window.addEventListener("pagehide", () => { releaseInputs(); post("release"); });

    // The only drawing shim: upstream may draw a touchpad cursor on the same
    // canvas as Pencil strokes. Suppress that image, not the canvas or its ink.
    const drawImage = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (image, ...args) {
        if (locked && clientSideMouse && this.canvas === canvas && image instanceof HTMLImageElement &&
            new URL(image.src, document.baseURI).pathname.endsWith("/mouse.png")) return;
        return drawImage.call(this, image, ...args);
    };

    function inspectDocument() {
        const nextCanvas = document.querySelector("canvas");
        if (nextCanvas === canvas) return;
        releaseInputs();
        settleLocks("Lux document changed");
        canvas = nextCanvas;
        canvasGeometry = "";
        layoutDirty = true;
        lastPointerType = "";
        locked = requested = false;
        captureCancelled = false;
        phase = "idle";
        clientSideMouse = localStorage.getItem("client_side_mouse") === "true";
        const sensitivity = Number.parseFloat(localStorage.getItem("sensitivity"));
        post("configure", {
            ready: Boolean(canvas), clientSideMouse,
            sensitivity: Number.isFinite(sensitivity) ? Math.min(2.9, Math.max(0.1, sensitivity)) : 1.5,
        });
        if (canvas) canvas.addEventListener("click", () => {
            // Relative mode's upstream click handler uses requestPointerLock too;
            // duplicate requests share the same native capture operation.
            if (!locked) requestLock(canvas).catch(() => {});
        });
    }

    window.nativeLux = Object.freeze({
        state, input,
        diagnostics: () => ({ version: 1, documentID, phase, requested, locked, clientSideMouse, platform: platformState }),
    });
    const observer = new MutationObserver(inspectDocument);
    observer.observe(document, { childList: true, subtree: true });
    document.addEventListener("DOMContentLoaded", inspectDocument, { once: true });
    post("loaded");
})();
