# Scope and baseline

- The user reports that April's committed native cursor implementation was
  meticulously validated at 960 FPS. Preserve its latency-sensitive behavior;
  do not claim latency equivalence without new physical-device measurements.
- The pre-overhaul uncommitted checkout was never compiled or tested by the user.
  Some changes directly violated their directions. It is suspect reference
  material, not an approved behavioral baseline.
- Native credential handling, Keychain integration, password deletion, and Storage
  interception are explicitly unwanted. Leave credentials to unchanged upstream Lux.
- Keep Swift as small as practical: native API bindings, WebKit hosting, and native
  cursor rendering. Put wrapper UI and browser-side behavior in the separate JS
  adapter, without recreating Lux's networking or input protocol.

# Presentation

- Never add an app overlay: no capture button, HUD, status panel, toolbar, or
  diagnostic panel over Lux. This is a standing user requirement for remote
  desktop apps. Mouse click captures; Escape releases. Do not replace overlays
  with other visible chrome.
- Keep the top system status bar visible and reserve its top safe-area space;
  never draw the video underneath it. Request automatic hiding of the bottom
  Home indicator; note that iPadOS can transiently reveal it during system gestures.

# Latency

- Forward raw input immediately from the GameController callback. Do not add a
  display-tick wait, application event queue/coalescer, asynchronous main-queue
  hop, or completion-handler serialization without explicit approval and an
  on-device comparison against April's baseline.
- Keep `CATransaction.flush()` after updating the native cursor, as in April.
- A timer used only to observe UIKit lock state must never schedule input delivery.

# Upstream and Git

- Keep `Sources/native_lux/WebClient` an unchanged, pinned upstream submodule.
- Default to leaving changes unstaged and uncommitted. Prior permission to stage
  the initial submodule metadata does not authorize staging other app changes.
- Build/test automation is not physical-iPad pointer-lock or latency verification.
