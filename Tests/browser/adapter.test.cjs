const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const playwright = require('playwright');

const root = path.join(__dirname, '../..');
const clientURL = pathToFileURL(path.join(root, 'Sources/native_lux/WebClient/index.html')).href;
const adapter = fs.readFileSync(path.join(root, 'Sources/native_lux/NativeAdapter.js'), 'utf8');
const engines = (process.env.LUX_TEST_BROWSERS || 'chromium').split(',');

// Only the platform and transport are mocked. Load the actual, complete upstream
// HTML/JS and use its real DOM event listeners and video-coordinate conversion.
function bootstrap(options) {
    // Desktop WebKit reports zero even with Playwright touch emulation. Match
    // the physical iPad capability so upstream enables its touchpad option.
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 });
    window.__sent = [];
    window.__nativeMessages = [];
    window.__drawnImages = [];
    window.__strokeCount = 0;
    const drawImage = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (image, ...args) {
        __drawnImages.push(image.src ?? 'other');
        return drawImage.call(this, image, ...args);
    };
    const stroke = CanvasRenderingContext2D.prototype.stroke;
    CanvasRenderingContext2D.prototype.stroke = function (...args) {
        __strokeCount += 1;
        return stroke.apply(this, args);
    };
    window.__storageMethods = [Storage.prototype.getItem, Storage.prototype.setItem, Storage.prototype.removeItem];
    if (!localStorage.getItem('native-lux-test-initialized')) {
        for (const [key, value] of Object.entries({
            address: 'host.invalid', sensitivity: '1.5', password: options.password ?? 'upstream-password',
            client_side_mouse: String(options.clientSideMouse || false),
            simulate_touchpad: String(options.simulateTouchpad || false),
            natural_touch_scrolling: String(options.naturalTouchScrolling || false),
            view_only: String(options.viewOnly || false),
        })) localStorage.setItem(key, value);
        localStorage.setItem('native-lux-test-initialized', 'true');
    }
    if (options.native !== false) {
        window.webkit = { messageHandlers: { nativeLux: { postMessage: message => __nativeMessages.push(message) } } };
    }
    window.__unhandled = [];
    window.addEventListener('unhandledrejection', event => __unhandled.push(String(event.reason)));
    window.MediaStream = class { constructor(tracks) { this.tracks = tracks; } };
    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', { configurable: true, set(value) { this.__stream = value; }, get() { return this.__stream; } });
    Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { get: () => 1920 });
    Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { get: () => 1080 });
    HTMLMediaElement.prototype.play = () => Promise.resolve();
    window.RTCPeerConnection = class extends EventTarget {
        constructor() { super(); window.__connection = this; }
        createDataChannel(channel) {
            return { readyState: 'open', send: text => __sent.push({ channel, ...JSON.parse(text) }) };
        }
        addTransceiver() {}
        async createOffer() { return { type: 'offer', sdp: '' }; }
        async setLocalDescription(value) { this.localDescription = value; }
        startVideo() {
            const event = new Event('track');
            event.track = { kind: 'video' };
            event.streams = [];
            this.dispatchEvent(event);
        }
    };
}

async function openClient(browser, options = {}) {
    const context = await browser.newContext({ viewport: { width: 1000, height: 800 }, hasTouch: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.dismiss());
    await context.addInitScript({ content: `(${bootstrap})(${JSON.stringify(options)});\n${adapter}` });
    await page.goto(clientURL);
    await page.locator('form').waitFor();
    return { page, context, errors };
}

async function startStream(page) {
    await page.locator('form').evaluate(form => form.requestSubmit());
    await page.evaluate(() => __connection.startVideo());
    await page.waitForFunction(() => document.querySelector('video'));
    if (await page.evaluate(() => Boolean(window.nativeLux)) && await page.locator('canvas').count()) {
        await page.waitForFunction(() => __nativeMessages.some(message => message.type === 'configure' && message.ready));
    }
}

async function deliver(page, events, options = {}) {
    await page.evaluate(({ events, options }) => {
        const id = options.documentID ?? nativeLux.diagnostics().documentID;
        for (const event of events) {
            if (event.type === 'state') nativeLux.state(id, {
                requested: event.requested, locked: event.phase === 'locked', active: event.phase !== 'suspended',
                mouse: event.phase !== 'waitingForMouse', supported: event.phase !== 'unavailable',
                sequence: options.sequence ?? __nativeMessages.at(-1).sequence, escape: event.escape ?? false,
            });
            else nativeLux.input(id, event.type,
                event.type === 'button' ? event.button : event.x ?? 0,
                event.type === 'button' ? event.pressed : event.y ?? 0);
        }
    }, { events, options });
}

async function lock(page) {
    await page.evaluate(() => { void document.querySelector('canvas').requestPointerLock().catch(() => {}); });
    await deliver(page, [{ type: 'state', phase: 'locked', requested: true }]);
    await page.evaluate(() => { __sent.length = 0; });
}

for (const engine of engines) {
    test(`${engine}: native adapter against the unchanged upstream client`, { timeout: 120000 }, async t => {
        const browser = await playwright[engine].launch({ headless: true,
            ...(engine === 'webkit' && process.env.LUX_TEST_WEBKIT_EXECUTABLE
                ? { executablePath: process.env.LUX_TEST_WEBKIT_EXECUTABLE } : {}),
        });
        t.after(() => browser.close());

        await t.test('login and password storage retain upstream behavior without native credential hooks', async t => {
            const { page, context, errors } = await openClient(browser, { password: 'existing-password' });
            t.after(() => context.close());
            assert.equal(await page.locator('input[type=password]').inputValue(), 'existing-password');
            assert.equal(await page.locator('[data-native-lux-remember]').count(), 0);
            await page.locator('input[type=password]').fill('changed-password');
            await startStream(page);
            assert.equal(await page.evaluate(() => localStorage.getItem('password')), 'changed-password');
            assert.equal(await page.evaluate(() => __nativeMessages.some(message => message.type === 'credentials')), false);
            assert(await page.evaluate(() => [Storage.prototype.getItem, Storage.prototype.setItem, Storage.prototype.removeItem]
                .every((method, index) => method === __storageMethods[index])));
            assert.equal(await page.evaluate(() => localStorage.getItem('address')), 'host.invalid');
            assert.deepEqual(errors, []);
        });

        await t.test('ordinary mouse and wheel still work before lock and after a rejected request', async t => {
            const { page, context } = await openClient(browser);
            t.after(() => context.close());
            await startStream(page);
            await page.mouse.move(100, 100);
            await page.mouse.wheel(0, 10);
            await page.waitForFunction(() => __sent.some(event => event.type === 'wheel'));
            // Clicking requests exclusive capture; test ordinary wheel input
            // before that transition, not while a capture request is pending.
            await page.mouse.down(); await page.mouse.up();
            for (const type of ['mousemove', 'mousedown', 'mouseup', 'wheel']) {
                assert(await page.evaluate(type => __sent.some(event => event.type === type), type), type);
            }
            await deliver(page, [{ type: 'state', phase: 'unavailable', requested: true, reason: 'unsupported' }]);
            await page.evaluate(() => { __sent.length = 0; });
            await page.mouse.move(200, 200);
            assert(await page.evaluate(() => __sent.some(event => event.type === 'mousemove')));
            assert.equal(await page.evaluate(() => document.pointerLockElement), null);
        });

        for (const clientSideMouse of [false, true]) {
            await t.test(`capture in ${clientSideMouse ? 'absolute' : 'relative'} mode waits for confirmation and suppresses only duplicate mouse input`, async t => {
                const { page, context, errors } = await openClient(browser, { clientSideMouse });
                t.after(() => context.close());
                await startStream(page);
                await page.locator('canvas').click({ position: { x: 100, y: 100 } });
                assert.equal(await page.evaluate(() => __nativeMessages.filter(message => message.type === 'capture').length), 1);
                assert.equal(await page.evaluate(() => document.pointerLockElement), null);
                await deliver(page, [{ type: 'state', phase: 'locked', requested: true }]);
                assert(await page.evaluate(() => document.pointerLockElement === document.querySelector('canvas')));
                await page.evaluate(() => { __sent.length = 0; });
                await page.mouse.move(150, 150); await page.mouse.down(); await page.mouse.up();
                assert.deepEqual(await page.evaluate(() => __sent), []);
                await deliver(page, [clientSideMouse
                    ? { type: 'absolute', x: 500, y: 400 }
                    : { type: 'relative', x: 4, y: -3 },
                    { type: 'button', button: 2, pressed: true },
                    { type: 'button', button: 2, pressed: false },
                    { type: 'wheel', x: 0, y: 12 },
                ]);
                assert.deepEqual(await page.evaluate(() => __sent), [
                    clientSideMouse ? { channel: 'ordered-input', type: 'mousemoveabs', x: 960, y: 540 }
                        : { channel: 'unordered-input', type: 'mousemove', x: 4, y: -3 },
                    ...(clientSideMouse ? [{ channel: 'ordered-input', type: 'mousemoveabs', x: 960, y: 540 }] : []),
                    { channel: 'ordered-input', type: 'mousedown', button: 2 },
                    ...(clientSideMouse ? [{ channel: 'ordered-input', type: 'mousemoveabs', x: 960, y: 540 }] : []),
                    { channel: 'ordered-input', type: 'mouseup', button: 2 },
                    { channel: 'unordered-input', type: 'wheel', x: 0, y: 12 },
                ]);
                assert.deepEqual(errors, []);
                assert.deepEqual(await page.evaluate(() => __unhandled), []);
            });
        }

        for (const source of ['touch', 'pen', 'simulated-touchpad']) {
            await t.test(`captured mouse ignores ${source} events and keeps every button at the native position`, async t => {
                const { page, context } = await openClient(browser, {
                    clientSideMouse: true, simulateTouchpad: source === 'simulated-touchpad',
                });
                t.after(() => context.close());
                await startStream(page); await lock(page);
                const result = await page.evaluate(source => {
                    const id = nativeLux.diagnostics().documentID;
                    const canvas = document.querySelector('canvas');
                    // The native mouse moves once. Capture must ignore subsequent
                    // web pointer events even when WebKit calls them touch/Pencil.
                    nativeLux.input(id, 'absolute', 700, 400);
                    const expected = { x: __sent.at(-1).x, y: __sent.at(-1).y };
                    let cursor = { ...expected }, consumed = __sent.length;
                    const points = [], displaced = [];
                    function consume() {
                        for (const event of __sent.slice(consumed)) {
                            if (['mousemoveabs', 'touchstart', 'touchmove', 'pen'].includes(event.type)) {
                                cursor = { x: event.x, y: event.y };
                            }
                        }
                        consumed = __sent.length;
                        return { ...cursor };
                    }
                    function otherInput() {
                        const pointerType = source === 'pen' ? 'pen' : 'touch';
                        for (const [type, x, pressure] of [
                            ['pointerdown', 100, 0.5], ['pointermove', 150, 0.5], ['pointercancel', 150, 0],
                        ]) {
                            canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType,
                                pointerId: 7, clientX: x, clientY: 250, width: 2, height: 2, pressure,
                            }));
                        }
                        displaced.push(consume());
                        // iPadOS can also emit compatibility mouse events at the
                        // last touch position. Those must not become authoritative.
                        canvas.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 150, clientY: 250 }));
                    }
                    for (const button of [0, 1, 2, 3, 4]) {
                        otherInput();
                        nativeLux.input(id, 'button', button, true);
                        points.push({ button, pressed: true, ...consume() });
                        // Also switch input sources during a mouse drag: a release
                        // must not drop the dragged object at the touch position.
                        otherInput();
                        nativeLux.input(id, 'button', button, false);
                        points.push({ button, pressed: false, ...consume() });
                    }
                    nativeLux.input(id, 'button', 0, true);
                    consume();
                    otherInput();
                    nativeLux.state(id, { requested: true, locked: false, active: false, mouse: true,
                        supported: true, sequence: __nativeMessages.at(-1).sequence });
                    points.push({ button: 0, pressed: false, ...consume() });
                    return { expected, displaced, points };
                }, source);
                for (const point of result.displaced) assert.deepEqual(point, result.expected,
                    `${source} must not move the remote pointer during native mouse capture`);
                for (const { button, pressed, x, y } of result.points) {
                    assert.deepEqual({ x, y }, result.expected,
                        `button ${button} ${pressed ? 'press' : 'release'} must first restore native mouse coordinates after ${source}`);
                }
            });
        }

        for (const clientSideMouse of [false, true]) {
            await t.test(`a native left click cannot become a right click through WebKit touch compatibility events (client-side=${clientSideMouse})`, async t => {
                const { page, context } = await openClient(browser, { clientSideMouse, simulateTouchpad: true });
                t.after(() => context.close());
                await startStream(page);
                const result = await page.evaluate(() => {
                    const id = nativeLux.diagnostics().documentID;
                    const canvas = document.querySelector('canvas');
                    function touch(type, pointerId, clientX) {
                        canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: 'touch',
                            pointerId, clientX, clientY: 250, width: 2, height: 2 }));
                    }
                    // Upstream intentionally leaves a just-ended lone touch in
                    // its gesture state for 125 ms. Capture must cancel that state.
                    touch('pointerdown', 1, 100); touch('pointerup', 1, 100);
                    void canvas.requestPointerLock().catch(() => {});
                    nativeLux.state(id, { requested: true, locked: true, active: true, mouse: true,
                        supported: true, sequence: __nativeMessages.at(-1).sequence });
                    nativeLux.input(id, 'absolute', 700, 400);
                    __sent.length = 0;
                    // Model a mouse click arriving via BOTH APIs. A WebKit event
                    // labeled touch must not join the stale contact as finger #2.
                    touch('pointerdown', 2, 150);
                    nativeLux.input(id, 'button', 0, true);
                    touch('pointerup', 2, 150);
                    nativeLux.input(id, 'button', 0, false);
                    const capturedButtons = __sent.filter(event => ['mousedown', 'mouseup'].includes(event.type))
                        .map(({ type, button }) => [type, button]);
                    nativeLux.state(id, { requested: false, locked: false, active: true, mouse: true,
                        supported: true, sequence: __nativeMessages.at(-1).sequence });
                    __sent.length = 0;
                    touch('pointerdown', 3, 200); touch('pointerup', 3, 200);
                    const releasedButtons = __sent.filter(event => ['mousedown', 'mouseup'].includes(event.type))
                        .map(({ type, button }) => [type, button]);
                    return { capturedButtons, releasedButtons };
                });
                assert.deepEqual(result.capturedButtons, [['mousedown', 0], ['mouseup', 0]],
                    'one physical left click must produce only one remote left click, never a two-finger right click');
                assert.deepEqual(result.releasedButtons, [['mousedown', 0], ['mouseup', 0]],
                    'touch input must start cleanly after capture is released');
            });
        }

        await t.test('entering mouse capture cancels active touch contacts and Pencil pressure', async t => {
            const { page, context } = await openClient(browser);
            t.after(() => context.close());
            await startStream(page);
            await page.locator('canvas').evaluate(canvas => {
                canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch',
                    pointerId: 7, clientX: 100, clientY: 250, width: 2, height: 2 }));
                void canvas.requestPointerLock().catch(() => {});
            });
            assert.deepEqual(await page.evaluate(() => __sent.filter(event => event.type.startsWith('touch')).map(event => event.type)),
                ['touchstart', 'touchend']);
            await deliver(page, [{ type: 'state', phase: 'idle', requested: false }]);
            await page.locator('canvas').evaluate(canvas => {
                canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'pen',
                    pointerId: 9, clientX: 200, clientY: 250, pressure: 0.75 }));
            });
            // A new physical click requests capture after the prior release.
            await page.locator('canvas').click({ position: { x: 100, y: 100 } });
            assert.deepEqual(await page.evaluate(() => __sent.filter(event => event.type === 'pen').map(event => event.pressure)),
                [0.75, 0]);
        });

        await t.test('subpixel relative motion is retained across deliveries', async t => {
            const { page, context } = await openClient(browser);
            t.after(() => context.close());
            await startStream(page); await lock(page);
            for (let i = 0; i < 8; i++) await deliver(page, [{ type: 'relative', x: 0.25, y: -0.25 }]);
            assert.deepEqual(await page.evaluate(() => __sent.reduce((sum, event) => ({ x: sum.x + event.x, y: sum.y + event.y }), { x: 0, y: 0 })), { x: 2, y: -2 });
        });

        await t.test('each native sample reaches upstream synchronously without a frame or acknowledgement wait', async t => {
            const { page, context } = await openClient(browser);
            t.after(() => context.close());
            await startStream(page); await lock(page);
            const counts = await page.evaluate(() => {
                const id = nativeLux.diagnostics().documentID;
                const counts = [];
                for (let index = 0; index < 8; index++) {
                    nativeLux.input(id, 'relative', 1, -1);
                    counts.push(__sent.length);
                }
                nativeLux.input('old-document', 'relative', 100, 100);
                counts.push(__sent.length);
                return counts;
            });
            assert.deepEqual(counts, [1, 2, 3, 4, 5, 6, 7, 8, 8]);
        });

        await t.test('all 32 platform-state combinations classify capture without mistaking OS lock for permission to send', async t => {
            const { page, context } = await openClient(browser);
            t.after(() => context.close());
            await startStream(page);
            const results = await page.evaluate(() => {
                const id = nativeLux.diagnostics().documentID;
                return Array.from({ length: 32 }, (_, flags) => {
                    nativeLux.state(id, {
                        requested: Boolean(flags & 1), locked: Boolean(flags & 2), active: Boolean(flags & 4),
                        mouse: Boolean(flags & 8), supported: Boolean(flags & 16), sequence: __nativeMessages.at(-1).sequence,
                    });
                    __sent.length = 0;
                    nativeLux.input(id, 'relative', 1, 1);
                    return { phase: nativeLux.diagnostics().phase, sent: __sent.length };
                });
            });
            for (let flags = 0; flags < 32; flags++) {
                const expected = !(flags & 1) ? 'idle' : !(flags & 16) ? 'unavailable'
                    : !(flags & 8) ? 'waitingForMouse' : !(flags & 4) ? 'suspended' : flags & 2 ? 'locked' : 'pending';
                assert.equal(results[flags].phase, expected, `flags=${flags}`);
                assert.equal(results[flags].sent, flags === 31 ? 1 : 0, `flags=${flags}`);
            }
        });

        await t.test('steady-state absolute input does not read layout dimensions on every sample', async t => {
            const { page, context } = await openClient(browser, { clientSideMouse: true });
            t.after(() => context.close());
            await startStream(page); await lock(page);
            const result = await page.evaluate(() => {
                const id = nativeLux.diagnostics().documentID;
                nativeLux.input(id, 'absolute', 500, 400);
                __sent.length = 0;
                let layoutReads = 0;
                const canvas = document.querySelector('canvas');
                for (const key of ['clientWidth', 'clientHeight']) {
                    const getter = Object.getOwnPropertyDescriptor(Element.prototype, key).get;
                    Object.defineProperty(canvas, key, { configurable: true, get() { layoutReads++; return getter.call(this); } });
                }
                for (let index = 0; index < 8; index++) nativeLux.input(id, 'absolute', 500 + index, 400);
                return { layoutReads, movements: __sent.filter(event => event.type === 'mousemoveabs').length };
            });
            assert.deepEqual(result, { layoutReads: 0, movements: 8 });
        });

        await t.test('no status, control, or diagnostic overlay is inserted into Lux', async t => {
            const { page, context, errors } = await openClient(browser);
            t.after(() => context.close());
            await startStream(page); await lock(page);
            assert.equal(await page.locator('#native-lux-controls').count(), 0);
            assert.equal(await page.evaluate(() => document.body.textContent.includes('Capture mouse') ||
                document.body.textContent.includes('Release mouse')), false);
            assert.equal(await page.evaluate(() => [...document.body.querySelectorAll('*')].some(element =>
                element.shadowRoot?.textContent.includes('Capture mouse'))), false);
            assert.deepEqual(errors, []);
        });

        await t.test('suspension releases buttons and keys, preserves intent, and can resume without another click', async t => {
            const { page, context } = await openClient(browser);
            t.after(() => context.close());
            await startStream(page); await lock(page);
            await deliver(page, [{ type: 'button', button: 0, pressed: true }]);
            await page.keyboard.down('Shift'); await page.keyboard.down('a');
            await deliver(page, [{ type: 'state', phase: 'suspended', requested: true }]);
            const sent = await page.evaluate(() => __sent);
            assert(sent.some(event => event.type === 'mouseup' && event.button === 0));
            assert(sent.some(event => event.type === 'keyup' && event.key === 'KeyA'));
            assert(sent.some(event => event.type === 'keyup' && event.key === 'ShiftLeft'));
            assert.equal(await page.evaluate(() => nativeLux.diagnostics().requested), true);
            await deliver(page, [{ type: 'state', phase: 'locked', requested: true }, { type: 'relative', x: 8, y: 9 }]);
            assert.deepEqual(await page.evaluate(() => __sent.at(-1)), { channel: 'unordered-input', type: 'mousemove', x: 8, y: 9 });
        });

        await t.test('Escape releases capture once, forwards a balanced remote Escape, and unlock restores ordinary input', async t => {
            const { page, context } = await openClient(browser);
            t.after(() => context.close());
            await startStream(page); await lock(page);
            await page.keyboard.down('Escape');
            assert.equal(await page.evaluate(() => __nativeMessages.filter(message => message.type === 'release' && message.escape).length), 1);
            await deliver(page, [{ type: 'state', phase: 'idle', requested: false, escape: true }]);
            await page.keyboard.up('Escape');
            assert.deepEqual(await page.evaluate(() => __sent.filter(event => event.key === 'Escape').map(event => event.type)), ['keydown', 'keyup']);
            await page.mouse.move(100, 100);
            assert.equal(await page.evaluate(() => __sent.at(-1).type), 'mousemove');
        });

        for (const captured of [false, true]) {
            for (const controlReleasedFirst of [false, true]) {
                await t.test(`Ctrl+[ sends pure remote Escape without changing capture (${captured ? 'captured' : 'released'}, ${controlReleasedFirst ? 'Control' : 'bracket'} released first)`, async t => {
                    const { page, context } = await openClient(browser);
                    t.after(() => context.close());
                    await startStream(page);
                    if (captured) await lock(page);
                    const messageCount = await page.evaluate(() => __nativeMessages.length);
                    await page.keyboard.down('Control'); await page.keyboard.down('[');
                    if (controlReleasedFirst) {
                        await page.keyboard.up('Control'); await page.keyboard.up('[');
                    } else {
                        await page.keyboard.up('['); await page.keyboard.up('Control');
                    }
                    assert.deepEqual(await page.evaluate(() => __sent.filter(event => event.type.startsWith('key')).map(({ type, key }) => [type, key])), [
                        ['keydown', 'ControlLeft'], ['keyup', 'ControlLeft'],
                        ['keydown', 'Escape'], ['keyup', 'Escape'],
                        ['keydown', 'ControlLeft'], ['keyup', 'ControlLeft'],
                    ]);
                    assert.equal(await page.evaluate(() => nativeLux.diagnostics().locked), captured);
                    assert.equal(await page.evaluate(() => __nativeMessages.length), messageCount);
                });
            }
        }

        await t.test('Ctrl+] and ordinary keyboard combinations retain upstream semantics', async t => {
            const { page, context } = await openClient(browser);
            t.after(() => context.close());
            await startStream(page); await lock(page);
            await page.keyboard.press('Control+]');
            await page.keyboard.press('Control+c');
            await page.keyboard.press('ArrowLeft');
            assert.deepEqual(await page.evaluate(() => __sent.filter(event => event.type.startsWith('key')).map(({ type, key }) => [type, key])), [
                ['keydown', 'ControlLeft'], ['keydown', 'BracketRight'], ['keyup', 'BracketRight'], ['keyup', 'ControlLeft'],
                ['keydown', 'ControlLeft'], ['keydown', 'KeyC'], ['keyup', 'KeyC'], ['keyup', 'ControlLeft'],
                ['keydown', 'ArrowLeft'], ['keyup', 'ArrowLeft'],
            ]);
            assert.equal(await page.evaluate(() => nativeLux.diagnostics().locked), true);
        });

        await t.test('finger and Pencil compatibility clicks never request mouse capture', async t => {
            const { page, context, errors } = await openClient(browser);
            t.after(() => context.close());
            await startStream(page);
            await page.touchscreen.tap(100, 100);
            await page.locator('canvas').evaluate(canvas => {
                for (const type of ['pointerdown', 'pointerup']) {
                    canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: 'pen', pointerId: 9,
                        clientX: 200, clientY: 200, pressure: type === 'pointerdown' ? 0.5 : 0, tiltX: 0, tiltY: 0 }));
                }
                // Cover both modern PointerEvent click and older WebKit's mouse
                // compatibility click, which has no pointerType of its own.
                canvas.dispatchEvent(new PointerEvent('click', { bubbles: true, pointerType: 'pen' }));
                canvas.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            assert.equal(await page.evaluate(() => __nativeMessages.some(message => message.type === 'capture')), false);
            assert.equal(await page.evaluate(() => nativeLux.diagnostics().requested), false);
            assert(await page.evaluate(() => __sent.some(event => event.type === 'touchstart')));
            assert.deepEqual(await page.evaluate(() => __sent.filter(event => event.type === 'pen').map(event => event.pressure)), [0.5, 0]);
            assert.deepEqual(errors, []);
        });

        for (const captured of [false, true]) {
            await t.test(`touch/Pencil are ${captured ? 'blocked in mouse mode' : 'forwarded normally when released'}`, async t => {
                const { page, context } = await openClient(browser);
                t.after(() => context.close());
                await startStream(page); if (captured) await lock(page);
                await page.locator('canvas').evaluate(canvas => {
                    const send = (type, pointerId, clientX, extra = {}) => {
                        const event = new PointerEvent(type, {
                            bubbles: true, pointerType: 'touch', pointerId, clientX, clientY: 100, width: 2, height: 2, ...extra,
                        });
                        // Desktop WebKit recomputes synthetic tilt from its default
                        // angles. Supply representative sensor values explicitly;
                        // the contract under test is forwarding them unchanged.
                        if (extra.pointerType === 'pen') Object.defineProperties(event, {
                            tiltX: { value: extra.tiltX }, tiltY: { value: extra.tiltY },
                        });
                        canvas.dispatchEvent(event);
                    };
                    send('pointerdown', 1, 100); send('pointerdown', 2, 150);
                    send('pointermove', 1, 120); send('pointercancel', 1, 120); send('pointerup', 2, 150);
                    send('pointerdown', 9, 200, { pointerType: 'pen', pressure: 0.75, tiltX: 20, tiltY: -10 });
                    send('pointercancel', 9, 200, { pointerType: 'pen', pressure: 0, tiltX: 20, tiltY: -10 });
                });
                assert.deepEqual(await page.evaluate(() => __sent.filter(event => event.type.startsWith('touch')).map(event => [event.type, event.id])), captured ? [] : [
                    ['touchstart', 1], ['touchstart', 2], ['touchmove', 1], ['touchend', 1], ['touchend', 2],
                ]);
                assert.deepEqual(await page.evaluate(() => __sent.filter(event => event.type === 'pen').map(({ pressure, tiltX, tiltY }) => [pressure, tiltX, tiltY])), captured ? [] : [[0.75, 20, -10], [0, 20, -10]]);
            });
        }

        for (const clientSideMouse of [false, true]) {
            await t.test(`simulated touchpad taps, movement, right click, drag, and scroll work without mouse capture (client-side=${clientSideMouse})`, async t => {
                const { page, context } = await openClient(browser, { clientSideMouse, simulateTouchpad: true });
                t.after(() => context.close());
                await startStream(page);
                await page.locator('canvas').evaluate(canvas => {
                    const now = Date.now;
                    let offset = 0;
                    Date.now = () => now() + offset;
                    const send = (type, pointerId, clientX, clientY = 100) => canvas.dispatchEvent(new PointerEvent(type, {
                        bubbles: true, pointerType: 'touch', pointerId, clientX, clientY, width: 2, height: 2,
                    }));
                    try {
                        // A completed right click, followed by a real-duration
                        // three-finger drag (not a simultaneous tap).
                        send('pointerdown', 1, 100); send('pointerdown', 2, 140);
                        send('pointerup', 1, 100); send('pointerup', 2, 140);
                        offset += 300;
                        send('pointerdown', 3, 100); send('pointerdown', 4, 140); send('pointerdown', 5, 180);
                        send('pointermove', 3, 150);
                        offset += 300;
                        send('pointerup', 3, 150); send('pointerup', 4, 140); send('pointerup', 5, 180);
                        // Two-finger scrolling starts after upstream's 25 ms
                        // gesture threshold; cancel avoids interpreting it as tap.
                        send('pointerdown', 6, 100); send('pointerdown', 7, 140);
                        offset += 30;
                        send('pointermove', 6, 100, 150);
                        send('pointercancel', 6, 100, 150); send('pointercancel', 7, 140);
                        offset += 300;
                        send('pointerdown', 8, 100); send('pointerup', 8, 100);
                    } finally { Date.now = now; }
                });
                assert.deepEqual(await page.evaluate(() => __sent.filter(event => ['mousedown', 'mouseup'].includes(event.type)).map(({ type, button }) => [type, button])), [
                    ['mousedown', 2], ['mouseup', 2], ['mousedown', 0], ['mouseup', 0], ['mousedown', 0], ['mouseup', 0],
                ]);
                assert(await page.evaluate(() => __sent.some(event => event.type === (localStorage.getItem('client_side_mouse') === 'true' ? 'mousemoveabs' : 'mousemove'))));
                assert.deepEqual(await page.evaluate(() => __sent.filter(event => event.type === 'wheel').map(({ x, y }) => [x, y])), [[0, 300]]);
                assert.equal(await page.evaluate(() => __nativeMessages.some(message => message.type === 'capture')), false);
                assert.deepEqual(await page.evaluate(() => __unhandled), []);
            });
        }

        await t.test('blocking upstream alerts release remote input before opening', async t => {
            const { page, context } = await openClient(browser);
            t.after(() => context.close());
            await startStream(page); await lock(page);
            await deliver(page, [{ type: 'button', button: 0, pressed: true }]);
            await page.keyboard.down('Shift');
            await page.evaluate(() => window.alert('Connection problem'));
            const sent = await page.evaluate(() => __sent);
            assert(sent.some(event => event.type === 'mouseup' && event.button === 0));
            assert(sent.some(event => event.type === 'keyup' && event.key === 'ShiftLeft'));
        });

        await t.test('releasing mouse mode restores normal finger contacts and Pencil pressure', async t => {
            const { page, context } = await openClient(browser);
            t.after(() => context.close());
            await startStream(page); await lock(page);
            await deliver(page, [{ type: 'state', phase: 'idle', requested: false }]);
            const canvas = page.locator('canvas');
            for (const type of ['pointerdown', 'pointerup']) {
                await canvas.dispatchEvent(type, { pointerType: 'touch', pointerId: 7, clientX: 100, clientY: 100, width: 2, height: 2 });
            }
            for (const [type, pressure] of [['pointerdown', 0.5], ['pointerup', 0]]) {
                await canvas.dispatchEvent(type, { pointerType: 'pen', pointerId: 9, clientX: 200, clientY: 200, pressure, tiltX: 0, tiltY: 0 });
            }
            assert.deepEqual(await page.evaluate(() => __sent.filter(event => event.type.startsWith('touch')).map(event => [event.type, event.id])), [['touchstart', 7], ['touchend', 7]]);
            assert.deepEqual(await page.evaluate(() => __sent.filter(event => event.type === 'pen').map(event => event.pressure)), [0.5, 0]);
        });

        await t.test('stale document packets and stale lock acknowledgements cannot change current input state', async t => {
            const { page, context } = await openClient(browser);
            t.after(() => context.close());
            await startStream(page);
            await page.evaluate(() => {
                window.__lockResult = 'pending';
                void document.querySelector('canvas').requestPointerLock().then(() => { __lockResult = 'resolved'; }, () => { __lockResult = 'rejected'; });
            });
            await deliver(page, [{ type: 'state', phase: 'idle', requested: false }], { sequence: 1 });
            assert.equal(await page.evaluate(() => __lockResult), 'pending');
            await deliver(page, [{ type: 'state', phase: 'locked', requested: true }], { documentID: 'previous-page' });
            assert.equal(await page.evaluate(() => __lockResult), 'pending');
            await deliver(page, [{ type: 'state', phase: 'locked', requested: true }]);
            assert.equal(await page.evaluate(() => __lockResult), 'resolved');
        });

        for (const phase of ['idle', 'unavailable']) {
            await t.test(`upstream's legacy fallback cannot recapture after ${phase === 'idle' ? 'explicit cancellation' : 'denial'}`, async t => {
                const { page, context } = await openClient(browser);
                t.after(() => context.close());
                await startStream(page);
                await page.locator('canvas').click({ position: { x: 100, y: 100 } });
                await deliver(page, [{ type: 'state', phase, requested: phase === 'unavailable' }]);
                // Give async handleCanvasClick's fallback and rejection reporting
                // a full turn without waiting an arbitrary wall-clock interval.
                await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve())));
                assert.equal(await page.evaluate(() => __nativeMessages.filter(message => message.type === 'capture').length), 1);
                assert.deepEqual(await page.evaluate(() => __unhandled), []);
                await page.locator('canvas').click({ position: { x: 100, y: 100 } });
                assert.equal(await page.evaluate(() => __nativeMessages.filter(message => message.type === 'capture').length), 2);
                await deliver(page, [{ type: 'state', phase: 'locked', requested: true }]);
                assert(await page.evaluate(() => document.pointerLockElement === document.querySelector('canvas')));
            });
        }

        await t.test('a deliberately blank upstream password survives reload without native involvement', async t => {
            const { page, context } = await openClient(browser, { password: '' });
            t.after(() => context.close());
            await startStream(page); await lock(page);
            await page.reload();
            assert.equal(await page.locator('input[type=password]').inputValue(), '');
            assert.equal(await page.evaluate(() => localStorage.getItem('password')), '');
        });

        await t.test('removing a streaming canvas releases input and invalidates pending requests', async t => {
            const { page, context } = await openClient(browser);
            t.after(() => context.close());
            await startStream(page); await lock(page);
            await deliver(page, [{ type: 'button', button: 0, pressed: true }]);
            await page.evaluate(() => document.querySelector('canvas').remove());
            await page.waitForFunction(() => __nativeMessages.at(-1).type === 'configure' && !__nativeMessages.at(-1).ready);
            assert.equal(await page.evaluate(() => nativeLux.diagnostics().locked), false);
            assert.deepEqual(await page.evaluate(() => __sent.filter(event => event.button === 0).map(event => event.type)), ['mousedown', 'mouseup']);
        });

        await t.test('cursor image filtering stays scoped to mouse mode and Pencil drawing works again after release', async t => {
            const { page, context } = await openClient(browser, { clientSideMouse: true, simulateTouchpad: true });
            t.after(() => context.close());
            await startStream(page);
            await page.waitForFunction(() => __drawnImages.some(src => src.endsWith('/mouse.png')), null, { timeout: 5000 }).catch(async error => {
                throw new Error(`${error.message}\n${JSON.stringify(await page.evaluate(() => ({
                    touchPoints: navigator.maxTouchPoints, touchpad: localStorage.getItem('simulate_touchpad'),
                    clientSideMouse: localStorage.getItem('client_side_mouse'), images: __drawnImages,
                })))}`);
            });
            const before = await page.evaluate(() => __drawnImages.length);
            await lock(page);
            assert.equal(await page.evaluate(() => __drawnImages.length), before);
            const canvas = page.locator('canvas');
            for (const [type, x] of [['pointerdown', 100], ['pointermove', 120]]) {
                await canvas.evaluate((canvas, { type, x }) => {
                    const event = new PointerEvent(type, { bubbles: true, pointerType: 'pen', pointerId: 9,
                        clientX: x, clientY: 100, pressure: 0.5, tiltX: 0, tiltY: 0 });
                    Object.defineProperty(event, 'getCoalescedEvents', { value: () => [event] });
                    canvas.dispatchEvent(event);
                }, { type, x });
            }
            assert.equal(await page.evaluate(() => __strokeCount), 0,
                'Pencil compatibility events must not enter Lux while mouse capture is active');
            await page.evaluate(async () => {
                const image = new Image(); image.src = 'icon.png'; await image.decode();
                document.querySelector('canvas').getContext('2d').drawImage(image, 0, 0);
            });
            assert(await page.evaluate(() => __drawnImages.at(-1).endsWith('/icon.png')));
            await deliver(page, [{ type: 'state', phase: 'idle', requested: false }]);
            assert(await page.evaluate(before => __drawnImages.length > before + 1, before));
            for (const [type, x] of [['pointerdown', 100], ['pointermove', 120]]) {
                await canvas.evaluate((canvas, { type, x }) => {
                    const event = new PointerEvent(type, { bubbles: true, pointerType: 'pen', pointerId: 9,
                        clientX: x, clientY: 100, pressure: 0.5, tiltX: 0, tiltY: 0 });
                    Object.defineProperty(event, 'getCoalescedEvents', { value: () => [event] });
                    canvas.dispatchEvent(event);
                }, { type, x });
            }
            assert(await page.evaluate(() => __strokeCount > 0), 'Pencil drawing must work again after release');
        });

        await t.test('absolute coordinates follow the unchanged client after viewport resize', async t => {
            const { page, context } = await openClient(browser, { clientSideMouse: true });
            t.after(() => context.close());
            await startStream(page); await lock(page);
            await page.setViewportSize({ width: 600, height: 400 });
            await page.waitForFunction(() => document.querySelector('canvas').clientWidth === 600);
            await deliver(page, [{ type: 'layout' }, { type: 'absolute', x: 300, y: 200 }]);
            assert.deepEqual(await page.evaluate(() => __sent.at(-1)), { channel: 'ordered-input', type: 'mousemoveabs', x: 960, y: 540 });
        });

        await t.test('view-only streams expose no capture canvas or input bridge configuration', async t => {
            const { page, context, errors } = await openClient(browser, { viewOnly: true });
            t.after(() => context.close());
            await startStream(page);
            assert.equal(await page.locator('canvas').count(), 0);
            assert.equal(await page.evaluate(() => __nativeMessages.some(message => message.type === 'configure' && message.ready)), false);
            assert.deepEqual(errors, []);
        });

        await t.test('without the native bridge the adapter leaves ordinary Lux unchanged', async t => {
            const { page, context } = await openClient(browser, { native: false });
            t.after(() => context.close());
            assert.equal(await page.locator('[data-native-lux-remember]').count(), 0);
            assert.equal(await page.evaluate(() => typeof window.nativeLux), 'undefined');
            assert.equal(await page.locator('input[type=password]').inputValue(), 'upstream-password');
        });
    });
}
