# Physical-iPad acceptance checklist

Build/test automation cannot grant UIKit pointer lock or measure a physical mouse.
Record the iPad model, iPadOS version, mouse/trackpad model, and upstream revision.
Do not describe a build as device-verified until these checks have actually run.

## First connection

- Update the existing installation with the same account/identity; do not uninstall.
- Check upstream login/password persistence, video, audio, remote keyboard,
  reconnect, and view-only mode. There should be no native Remember/Keychain UI.
- Before capture, verify ordinary mouse movement, buttons, and scrolling still work.
- With no mouse attached, request capture and verify a useful waiting state rather
  than repeated modal errors. Attach the mouse and check recovery.

## Both mouse modes

Run this section with client-side mouse **off**, then **on**:

- Capture by mouse-clicking the video. Confirm no web button, HUD, or status panel
  is drawn over the app. Confirm the top system status bar is visible and the bottom
  Home indicator auto-hides after inactivity.
- Check left/right/middle buttons, drag, wheel, and horizontal/trackpad scrolling.
- Hold a button and a keyboard modifier, open Control Center, then return. Verify
  no remote button/modifier remains down and capture can resume without a new click.
- Test Notification Center, app switching, a native alert, and locking/unlocking iPad.
- Disconnect/reconnect the mouse during capture. Try a second connected mouse.
- Use Escape to release; verify release stays released and ordinary pointer input
  works again. Confirm Escape reaches the remote application once.
- Use Ctrl+[ to send Escape without releasing capture. Release the keys in both
  orders; verify neither Control nor Escape remains held. Test Ctrl+] normally.
- Repeat capture/release at least 30 times. There is intentionally no on-screen
  diagnostic UI; capture and release must not depend on one.
- Resize/rotate the window and change remote video resolution. In client-side mode,
  click at the native cursor position near all four video corners and letterboxes.
- Check client-side mode at minimum/default/maximum sensitivity and different DPI.
- Check finger/Pencil and simulated-touchpad input while capture is released.
  During capture, those canvas events must be ignored; release with Escape. After
  release, input must start cleanly without stale contacts.
- In client-side mode, move the mouse once, leave it stationary, touch/draw
  elsewhere, then click without moving the mouse. Repeat for every button. Also
  touch elsewhere while holding a mouse drag, then release: neither press nor
  release should jump to the last touch/Pencil position.
- With simulated touchpad enabled, tap once, immediately capture the mouse, then
  left-click repeatedly. A lingering first tap plus a compatibility touch must
  never generate a two-finger right click. Check both button identity and position.
- With a mouse connected but released, use finger/Pencil taps and confirm they do
  not request mouse capture. Then use an actual mouse left press to capture again;
  it must work even after touch input. Test touch-only use without a mouse too.

## Acceleration and performance

- Compare against the user-validated April build using the original 960 FPS
  measurement procedure. Restored immediate submission and cursor flushing are
  source-level checks, not proof of unchanged measured latency.
- Keep mouse DPI, wrapper sensitivity, and remote-host pointer settings constant.
- Move the mouse an equal measured physical distance slowly and quickly. Compare
  displacement in client-side mode; it should not depend on speed, except clamping
  at the display edge.
- In relative mode, separately account for acceleration applied by the remote OS.
- Test a high-polling-rate mouse during video playback and sustained dragging.
  Look for cursor lag, delayed clicks, or dropped releases. Native events are
  submitted immediately, without an application queue or frame-based batching.
- Test ordinary internet loss/server restart and reconnect. Confirm input belongs
  only to the new document and the capture control returns to a useful state.

## Distribution (separate from mouse correctness)

- Determine whether previous disappearance meant signing expiry or a cloud/offload
  icon. Turning off Offload Unused Apps does not fix provisioning expiry.
- If using SideStore, test an actual renewal and an app update while retaining
  upstream app settings. Verify its local VPN does not disrupt Lux's network.
- Observe renewal over at least one seven-day interval before claiming unattended
  operation. App code cannot make free provisioning permanent.
