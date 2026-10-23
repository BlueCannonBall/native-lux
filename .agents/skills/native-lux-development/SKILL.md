---
name: native-lux-development
description: Build and verify native-lux on Linux, test its injected adapter against unchanged upstream Lux, and distinguish automated checks from physical-iPad capture verification.
---

# Native Lux development

## Prerequisites

- Read the repository README and `docs/device-testing.md`.
- Use compatible current host Swift and xtool installations. AUR packaging can
  work directly on Arch; neither a historical compiler pin nor Docker is a default.
- Initialize the `Sources/native_lux/WebClient` submodule. Never patch its files
  to introduce native integration.
- Read project AGENTS.md. The pre-overhaul uncommitted checkout was never tested
  by the user and contained explicitly rejected changes. Preserve it as evidence,
  not as an approved behavioral baseline. April's committed cursor path is the
  user-reported, 960-FPS-validated latency baseline.
- Do not commit or stage changes without authorization; adding a Git submodule
  stages metadata.

## Verified build and test procedure

1. Check `swift --version`, `xtool sdk status`, and `swift sdk list`.
2. Build locally with `xtool dev build`. In a noninteractive tool session, xtool
   has been observed to crash in SwiftNIO with `epoll_ctl ... Operation not permitted`.
   Running `script -q -e -c 'xtool dev build' /dev/null` bypassed that failure.
   Do not infer a Swift compiler incompatibility from that crash alone.
3. A legacy SDK can type-check UIKit with a newer compiler yet still be rejected
   by current xtool. Inspect the actual build output. A legacy bundle without a
   retained Xcode.app requires `xtool sdk install <compatible-Xcode.xip>`, not
   `xtool sdk update`. A normal, non-slim install supports subsequent rebuilds.
4. Run `npm ci` and `npm test`. Check the resource/metadata contracts, absence of
   native credential handling, and source guards for immediate input/cursor flush.
5. Run `PLAYWRIGHT_SKIP_BROWSER_GC=1 npx playwright install chromium`, then
   `npm run test:browser`. The environment variable prevents Playwright's browser
   installer from removing other tools' cached browser revisions.
6. Where available, install WebKit and run
   `LUX_TEST_BROWSERS=chromium,webkit npm run test:browser`.
7. After building, run `npm run test:bundle`. It checks the resource allowlist,
   byte-identical upstream assets, and absence of Git metadata/stale client files.
8. A release build uses `xtool dev build -c release`. Add `--ipa` for an unsigned
   archive; this additionally requires the host's `zip` executable.
9. Report automated results separately from physical-iPad results. Only the user
   or an actual attached-device test can establish UIKit lock reliability,
   high-polling-rate latency, live media performance, and signing renewal.

## Contract boundaries

- Inject `NativeAdapter.js` at document start; do not copy upstream networking or
  call Lux's internal classes from the adapter.
- Mock the platform and WebRTC transport in browser tests, but load upstream's
  complete HTML and JS with real DOM listeners and video-coordinate mapping.
- Keep Swift limited to APIs that actually require it. Browser-side state
  classification and input translation belong in the separate adapter.
- Do not add ANY web/native overlay, HUD, toolbar, status panel, capture button,
  or diagnostic UI. This is a standing user requirement. Mouse click captures;
  Escape releases. Keep the system top status bar visible
  (`prefersStatusBarHidden == false`) and request Home-indicator auto-hide (apps
  cannot permanently hide it; iPadOS may transiently reveal it during gestures).
- Showing the status bar does not reserve its space when WKWebView is the root
  view. Use a container with the web view's top pinned to the top safe-area guide,
  but its bottom pinned to the container edge (not the bottom safe-area guide).
  Keep cursor rendering, clamping, viewport-size updates, and scroll coordinates
  relative to webView.bounds, or the status-bar offset breaks pointer alignment.
  Check the actual layout on an iPad; source-contract checks are not UIKit tests.
- Keep capture intent separate from actual scene lock. Interruptions suspend;
  explicit release cancels. Test device loss, stale document/sequence messages,
  button/key release, and synchronous per-sample delivery.
- Preserve April's immediate GameController-to-WebKit submission and native cursor
  CATransaction.flush(). No display-tick scheduling, application event buffering,
  completion-handler gate, or added main-queue dispatch is approved. A state-only
  UIKit lock monitor must never schedule input delivery.
- Capture is exclusive: while requested/active, reject original web pointer/touch/
  mouse events on the stream, even ones labeled touch/Pencil. Only native mouse
  events reach upstream. Do not add controls; after Escape, finger/Pencil and
  simulated-touchpad events must work normally. Do not promise simultaneous input.
- Preserve Ctrl+[ as remote Escape without capture release; it was present in the
  early application's Escape fix but absent from the later working copy. Test
  both key-release orders and ordinary Ctrl+] separately. Do not send Ctrl+Escape
  accidentally: temporarily release/restore remote Control around the Escape.
- Touch/Pencil compatibility clicks must not reach either upstream or adapter
  click-to-lock listeners. Older WebKit clicks may lack pointerType, requiring
  the preceding pointerdown's input type as a fallback.
- Do not intercept Storage, delete passwords, add credential UI, or use native
  password/Keychain storage. Those changes were explicitly rejected. Upstream
  Lux owns password persistence; test that its original Storage methods remain
  unchanged and no credential messages cross the native boundary.
- Upstream retries any rejected options-bearing pointer-lock request with a
  no-argument legacy call. Explicit cancellation/denial must block that fallback
  from recapturing, while allowing a new genuine click or native-button request.
  Test this against the actual upstream click handler, not just direct shim calls.
- Test removal of a canvas: its detached element still owns upstream listeners,
  so deliver releases before discarding the element.
- Mixed-input handoff needs more than checking that touch and mouse events are
  both delivered. Upstream's mouse-down/up handlers ignore event coordinates and
  send only the button number. Before each captured client-side mouse down/up,
  emit a mousemove at the last native position so upstream sends mousemoveabs on
  the same ordered channel before the button. This also applies to forced release.
  Merely setting clientX/clientY on a button event does not reposition the host.
- Verified browser reproduction: move native mouse once, leave it stationary,
  use touch/Pencil or simulated touchpad elsewhere, then press/release each of the
  five mouse buttons, including touch during a held drag. Without position-before-
  button ordering the inferred host cursor stays at the other input's position.
  Position ordering alone did NOT resolve the user's on-device report. Keep it as
  a safeguard, not as a complete diagnosis or a claim of physical verification.
- A second browser reproduction generated the reported wrong button: leave a
  just-ended simulated-touchpad tap in upstream's 125 ms linger, enter capture,
  then deliver a native left click plus WebKit pointer events labeled touch. The
  old path sent left-down, right-down, right-up, left-up. This demonstrates the
  risk of double delivery, but actual iPad event labels still require confirmation.
- Before entering capture, cancel active pointers AND recent ended touches through
  synthetic pointercancel events. Clearing only native mouse buttons/keys leaves
  upstream's touch/Pencil gesture state live. Keep recent completed touch history
  bounded; do not add an input-delivery delay or alter upstream source.
- Treat GameController's button profile as the authoritative physical mouse
  source. Native left presses may request capture without relying on a WebKit
  click label; consume the activation press. Delay UIKit indirect touches during
  capture. Do not suppress the initial unlocked UI click path on an unverified
  assumption that every OS version delivers unlocked GameController callbacks.

## Interactive xtool authentication

For Apple login error `-80046`, check current upstream releases rather than
retrying credentials or changing Swift/SDK versions. xtool 1.23.0 includes the
upstream macOS-Omnisette authentication change (PR #380) explicitly targeting that
error. Its Anisette service is a third-party trust dependency; disclose that and
get approval before switching from local header generation. Passwords are still
submitted directly to Apple. Login and installation using the official 1.23.0
AppImage have been verified on Linux. Still verify the result for the current
account/device rather than assuming that a release note establishes success.

If AUR lags behind an authentication fix, a checksum-verified official temporary
AppImage can sign/install an existing unsigned IPA with `xtool install <path>`;
this avoids invoking a new SDK builder or replacing installed packages. Where
FUSE is unavailable, `APPIMAGE_EXTRACT_AND_RUN=1` runs the official AppImage without
mounting it. Verify its version and command help before asking for another login.
Do not alternate authentication/signing versions blindly: xtool's saved-token
loader can delete a token whose Anisette provider ID differs from its own.

Verified on Linux: xtool's Console implementation uses SwiftNIO on duplicated
stdin/stdout descriptors. Prompting leaves the shared terminal descriptors in
nonblocking mode. After xtool exits, a shell `read` can immediately fail with
`Resource temporarily unavailable`, closing a helper terminal before the user can
see the real authentication error. This was reproduced with an intentionally
empty password and no Apple login request.

After an interactive xtool command, restore blocking stdio in the wrapper:

```bash
python -c 'import os; [os.set_blocking(fd, True) for fd in range(3)]'
```

Verified: a subsequent shell read works after that restoration. A terminal's
hold-open option independently preserves error output even if the script exits.
Do not confuse terminal auto-closure with a successful login or ask users to
repeatedly reenter credentials without inspecting the actual failure.

Keep passwords and 2FA input in a private interactive terminal, never command-line
arguments, chat, or terminal-session transcripts. If diagnosing failures, capture
only stderr with restrictive permissions; do not log the input stream or enable
debug dumps that might expose authentication payloads. This is xtool's Apple
signing authentication, separate from the explicitly rejected app credential code.

## Device-registration/provisioning failures

Verified sequence: login succeeded, but profile creation returned HTTP 409 with
`There are no current IOS devices on this team matching the provided device IDs`.
The team's device list was empty. Explicitly registering the connected iPad via
the same Apple Developer Services API returned HTTP 201 and an ENABLED IOS/IPAD
record. Retrying the official `xtool install` then signed, installed, and verified
the app successfully. No app uninstall or certificate revocation was needed.

Check the actual device list with the matching new CLI (`xtool ds devices list`).
Do not infer that the USB device is already registered just because xtool advanced
past its device-registration step: its AddDeviceOperation treats any 409 as
"already registered" without checking the error body. Inspect that response when
necessary. The exact cause of the initial missing registration was not proven;
do not guess that resetting certificates, changing bundle IDs, renaming devices,
or paying for membership is required.

Any diagnostic API helper must remain outside app code, use only the user's
existing signing session, restrict authenticated requests to Apple's fixed
Developer Services host, and never log tokens/headers or send them to the
Anisette service. Register only the intended connected device. Do not remove
devices, profiles, apps, or certificates as a speculative fix.

## Desktop WebKit on Arch

Verified: Playwright's Ubuntu fallback WebKit can run with matching missing ICU
and flite libraries extracted from Ubuntu packages into a scratch directory;
no system installation is necessary. Check current binary dependencies first.
Never substitute a different ICU ABI by renaming or symlinking its SONAME.

The packaged MiniBrowser wrapper overwrites `LD_LIBRARY_PATH`, so setting that
variable on the test command alone is insufficient. A separate launcher must set
the browser's own WEBKIT_EXEC_PATH, WEBKIT_INJECTED_BUNDLE_PATH,
WEBKIT_INSPECTOR_RESOURCES_PATH, and LD_LIBRARY_PATH including both the scratch
libraries and its bundled lib/sys-lib directories, then exec its MiniBrowser binary.
Pass the launcher through `LUX_TEST_WEBKIT_EXECUTABLE`. Paths/revisions are local
test setup, not app dependencies; discover them instead of hardcoding old versions.

Also verified: desktop WebKit may report zero `navigator.maxTouchPoints` despite
Playwright touch emulation. Tests must explicitly model the iPad's nonzero touch
capability when exercising upstream's simulated-touchpad setting. Synthetic pen
events need representative coalesced samples to test upstream stroke rendering.
Desktop WebKit also recomputes synthetic PointerEvent tilt from default angles;
explicit representative sensor properties test unchanged forwarding, not physical
Pencil calibration. Keep that distinction in any verification report.

## Physical latency measurement (user-reported)

The S22 Super Slow-mo MP4 is 960 Hz capture saved as a 30 fps playback file;
use frame indices, not container timestamps. Each capture frame is 1.0417 ms.
A 542-frame clip is ~0.565 s of real action. Extract frames losslessly and burn
the frame index into each image (or confirm the player does so); do not infer
onset from a normal timeline or from blurry frame differences.

The user compared native-lux's client-side cursor with the iPadOS system cursor
against the host laptop pointer at 960 captured frames. Native-lux moved at frame
214 after the host moved at 185 (29 frames, ~30.2 ms). The system cursor moved at
frame 286 after the host moved at 232 (54 frames, ~56.3 ms). This is ~26 ms (~1.6
laptop 60 Hz intervals) faster for native-lux in those separate clips. Treat these
as user measurements, not independently reproduced values. The host had a Wi-Fi
hop, so these are host-relative gaps, not input-to-photon latency for the iPad.

Frame identification is sensitive to the cursor fading across positions; verify
the local-vs-streamed cursor origin (freeze/disconnect video) and use the same
onset rule in both clips. A 1-2 frame revision does not change the large gap.
Future cursor-path changes should beat the 29-frame host-relative gap under the
same capture setup rather than be accepted speculatively.

## Known limits

- Desktop browser tests do not exercise GCMouse or UIKit pointer lock.
- Free provisioning still expires. No app rewrite removes that limit; on-device
  refresh tooling and offloading diagnosis are separate work.
- An SDK or compiler smoke test does not establish deployment or signing success.
- Exclusive-mode switching, compatibility events, and actual button identities
  still need physical-device checks; browser tests do not establish their behavior.
