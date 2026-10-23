# Native Lux

[![tests](https://github.com/BlueCannonBall/native-lux/actions/workflows/tests.yml/badge.svg)](https://github.com/BlueCannonBall/native-lux/actions/workflows/tests.yml)

Small iPadOS wrapper for [Lux](https://github.com/BlueCannonBall/lux): native
pointer capture and unaccelerated mouse input in both mouse modes. The web client
is an **unchanged Git submodule**. Native code does not handle credentials or
implement Lux's network protocol.

## Build locally

Requirements: compatible current Swift and [xtool](https://xtool.sh), an installed
Darwin SDK, and a connected, trusted iPad with Developer Mode enabled. IPA export
also requires `zip` (`sudo pacman -S zip` on Arch). Development works with free
provisioning; no paid Apple Developer membership is required.

```bash
git submodule update --init --recursive
xtool dev build                 # unsigned build, no Apple login required
npm run test:bundle             # check packaged resources against source
xtool dev                       # sign, install, and run on the connected iPad
xtool dev build -c release --ipa # optional unsigned release IPA
```

The Home Screen name is **Lux**, set in `Info.plist`; its icon is upstream's
`apple-touch-icon.png`, selected in `xtool.yml`. The internal product/artifact is
still `Lux Client`. The bundle identifier remains `com.optimal.lux`. Update the
existing installation with the same account rather than uninstalling it.

If current xtool rejects a **legacy** SDK, regenerate it once with
`xtool sdk install ~/Downloads/<compatible-Xcode-file>.xip`. Omit `--slim` to retain
the material needed for future automatic rebuilds. Check `xtool sdk status` first;
compiler type-checking alone does not establish xtool SDK compatibility.

Some noninteractive shells trigger xtool's SwiftNIO
`epoll_ctl ... Operation not permitted` crash. A pseudo-terminal bypasses it:

```bash
script -q -e -c 'xtool dev build' /dev/null
```

## Input

- Click the streaming canvas **with a mouse** to capture it. Finger/Pencil taps
  do not request mouse capture.
- **Escape** releases capture and sends remote Escape. **Ctrl+[** sends remote
  Escape **without** releasing capture; Ctrl+] is unchanged. Control is temporarily
  released remotely around the Escape pulse so it is not interpreted as Ctrl+Escape.
- **There are no app overlays.** No capture button, HUD, status panel, or toolbar
  is drawn over Lux. Use the mouse to capture and Escape to release.
- **Capture is exclusive.** While mouse capture is requested/active, the streaming
  canvas ignores web mouse/touch/Pencil events and accepts only GameController
  mouse input. Release capture to use finger/Pencil or simulated-touchpad input.
- Capture becomes active only after UIKit actually grants it. Interruptions,
  alerts, and device loss release held remote input without discarding capture
  intent. Explicit release cancels that intent. A small state-only timer covers
  missed UIKit notifications; it never schedules mouse delivery.
- Unlocked mouse, finger, Pencil, simulated-touchpad gestures, keyboard, login,
  and networking otherwise remain upstream behavior. Active/recent touch gestures
  are cancelled when entering mouse mode so stale fingers cannot become clicks.

A physical left press can request capture through GameController, independent of
WebKit's pointer-type labels. The initial activation press is not sent as a remote
click. UIKit delays indirect touches during capture; the adapter also blocks web
pointer events, including events labeled as touch, rather than guessing their source.

The system status bar remains visible at the top. The bottom Home indicator is
requested to auto-hide; iPadOS still briefly reveals it after some system gestures.

In **non-client-side mode**, raw GameController deltas go immediately to the
adapter as relative mouse events. In **client-side mode**, each raw callback
immediately updates a native cursor, explicitly flushes its Core Animation
transaction, then forwards absolute coordinates. Lux still performs its own
video/letterbox conversion. Remote-host acceleration is a separate setting.
Before each captured client-side button press/release, the adapter resends the
native cursor position on the same ordered channel. Touch/Pencil may have moved
the remote pointer even when the physical mouse has not moved.

### Latency

The cursor is deliberately on an immediate path: raw GameController samples update
the native layer and `CATransaction.flush()`, then forward to the web client.
There is **no application input queue, frame-based batching, asynchronous main-queue
hop, or completion-handler gate**. DOM geometry/viewport data is refreshed on
layout changes, not read on every mouse sample.

This is a latency-sensitive design, not a photon-to-photon guarantee. Validate
changes with high-speed recording or signposts on a physical iPad.

## Minimal native boundary

- `Sources/native_lux/WebClient/`: unchanged upstream, pinned to
  `f296b4387d9361ab802ba32a184f90cf46a275f1` (September touch fixes).
- `ContentView.swift`: WebKit hosting, UIKit lock state, GameController callbacks,
  native cursor, and necessary navigation/alert handling.
- `native_luxApp.swift`: the application/window lifecycle.
- `NativeAdapter.js`: pointer-lock compatibility, DOM-event translation, keyboard
  shortcut, capture-state handling, and duplicate mouse/cursor filtering.

The adapter does not call Lux classes or copy its signaling code. It narrowly
suppresses upstream's touchpad `mouse.png` while the native cursor is active,
without hiding Pencil strokes or other canvas images. No UIKit swizzling or
private WebKit APIs are used. The native message handler accepts only the bundled
main frame; document IDs reject stale input and sequences reject stale state.

The adapter leaves `Storage`, login fields, and password persistence untouched.
**Lux stores its password in localStorage, exactly as upstream does.** There is no
native Keychain/password code, password-deletion migration, or Remember checkbox.
No native password store is read or erased by this version.

`Package.swift` copies an explicit resource allowlist. Git metadata, upstream
development files, and the old patched client are not packaged. xtool manages its
generated editor integration under `.bsp/`.

## Verification

```bash
npm ci
npm test
PLAYWRIGHT_SKIP_BROWSER_GC=1 npx playwright install chromium
npm run test:browser

# Optional WebKit run where its Linux dependencies are available:
PLAYWRIGHT_SKIP_BROWSER_GC=1 npx playwright install webkit
LUX_TEST_BROWSERS=chromium,webkit npm run test:browser
```

Tests load the complete upstream HTML/JS and its real input handlers; only the
native platform and WebRTC transport are mocked. They cover capture-state
combinations, immediate per-sample delivery, cancellation/fallback races, absence
of overlays, touch/Pencil, keyboard, upstream storage, and video coordinates. `npm test` also
guards against reintroducing native credentials or input scheduling.

On unsupported distributions, Playwright's fallback WebKit may need additional
runtime libraries. `LUX_TEST_WEBKIT_EXECUTABLE` can select a prepared launcher.
This is test tooling, not a build/deployment requirement. The browser-install
environment variable prevents removal of other tools' cached browser revisions.

**Desktop tests do not verify GCMouse, UIKit capture, live media performance, or
actual iPad input/latency.** Follow [the device checklist](docs/device-testing.md).
UIKit retains control over capture permissions, including foreground/full-screen
requirements and OS/windowing restrictions.

## Updating Lux

Fetch upstream, switch the submodule to a reviewed commit, run the tests and build,
and review its asset references against the resource allowlist. Then perform the
device checks. Update the documented revision and commit the submodule pointer
when ready; do not add native hooks inside upstream files.

## Network permissions and free signing

Upstream's TCP option briefly requests camera access while gathering WebRTC TCP
candidates, then stops the tracks. Lux uses Google's public STUN service and
connects to the specified host. Its signaling/media code is unchanged.

Apple's seven-day free-provisioning expiry is **not** removed by this wrapper.
Renewal and app offloading are separate issues. [SideStore](https://docs.sidestore.io/docs/installation/prerequisites)
is one free on-device renewal option after initial setup from Linux; it requires
its local VPN, uses a free app slot, and needs verification on the actual iPadOS
version. No renewal service is configured by this repository.
