# Changelog — My Guestbook

## v1.3.0 — 2026-08-23

This is a major feature and stability release focused on full-screen kiosk
operation, orientation handling, canvas-based recording, cross-platform
compatibility, and editor quality-of-life improvements.

---

### New Features

#### Full-Screen Kiosk Mode
- The application now launches in true OS-level full-screen by default
  (fullscreen: true, frame: false in the Electron window config).
- The OS taskbar (Windows) and window title bar are completely hidden.
  The app fills the entire screen edge-to-edge with no chrome visible.
- Dev mode retains a normal maximised window for developer convenience.

#### Exit Application Button
- A red-tinted "Exit App" button has been added to the Admin Panel in
  two locations: the top header and the bottom footer.
- A window.confirm() guard prevents accidental taps from quitting the app.
- Uses a dedicated quit-app IPC handler (app.quit()) for a clean shutdown.

#### Three-Way Master Orientation System
- New Screen Orientation card in Admin Settings with three modes:
  - Auto (Device Native): reads OS orientation in real time via
    window.matchMedia('(orientation: landscape)') and updates live.
  - Force Landscape: locks the UI and recording to 16:9.
  - Force Portrait: locks the UI and recording to 9:16.
- A Camera Mismatch dropdown appears whenever the UI is in Portrait mode
  and offers four strategies for handling a landscape hardware camera:
  - Letterbox (Contain): black bars above/below, full frame visible.
  - Center Crop (Cover): sides cropped, centre preserved.
  - Rotate 90 Clockwise: rotates frame +90 degrees onto portrait canvas.
  - Rotate 90 Counter-Clockwise: rotates frame -90 degrees onto portrait canvas.

#### Canvas Recording Pipeline for All Mismatch Strategies
- All four mismatch strategies now route through a hidden canvas pipeline
  (startMismatchCanvas). The MediaRecorder receives the canvas stream and
  saves a physically correct portrait video (720x1280) -- no CSS tricks.
- Letterbox, Center Crop, Rotate CW, and Rotate CCW all bake geometry
  directly into the saved video file pixels.

#### Dynamic Mismatch Detection (Surface Pro / Windows Tablets)
- Camera Mismatch is decoupled from the Force Portrait setting.
- At recording start, the app probes the live camera track via
  videoTrack.getSettings() and auto-detects cameraIsLandscape.
- hasMismatch = isPortrait && cameraIsLandscape -- triggers regardless of
  whether portrait came from Auto or Force Portrait mode.

#### Editor Tab: Open Save Folder Button
- A "Open Save Folder" button has been added directly next to the
  "Import Media" button in the Editor tab Source Clips toolbar.
- Opens the OS native file explorer directly to the active save location.
- Respects the custom save path if configured; falls back to the active
  event's clips/ directory.

---

### Bug Fixes

#### Orientation and Replay
- Portrait videos replaying in landscape: Fixed the full chain -- the
  review screen correctly determines isPortrait from settings and displays
  the video card at the right aspect ratio (9/16 or 16/9).
- Video zooming / cropping on orientation change: object-fit changed from
  cover to contain across live preview and replay screens. No video frame
  is ever cropped or zoomed -- black bars fill leftover space.
- Replay card overflowing off-screen in fullscreen: Added maxHeight 100%
  and maxWidth 100% to replay card inline styles so it never pushes action
  buttons off-screen.
- Flex containment in fullscreen layout: min-height:0 and overflow:hidden
  enforced on .review-media-area so the replay card respects flex boundaries.

#### Rotate 90 Split
- The single rotate90 mismatch option was ambiguous for different camera
  mounting directions. Split into two explicit options:
  - rotate90cw: ctx.rotate(+Math.PI/2)
  - rotate90ccw: ctx.rotate(-Math.PI/2)

#### Canvas Rotation Math
- Fixed the Rotate 90 canvas draw loop. Previous implementation applied
  incorrect CSS transforms producing upside-down or sideways previews.
  Fixed sequence: ctx.translate(cw/2, ch/2) -> ctx.rotate(angle) ->
  ctx.drawImage(video, -vw/2, -vh/2, vw, vh).

#### Mirror Removal
- Removed all scaleX(-1) mirroring from the entire application.
  Camera now records and displays exactly as the hardware sees the scene.
  Affected: useOrientation.js, RecordScreen.jsx (GLAM + rotate canvas +
  inline CSS), src/styles/record.css.

#### Sharing / QR
- Removed ngrok completely -- sharing is LAN/Wi-Fi only.
- Removed the raw share URL from the QR screen -- only the QR code shown.

---

### Safari / WebKit Compatibility

- MediaRecorder MIME type: Added pickMimeType() helper that probes
  candidates in order (WebM for Chromium, MP4 fallback for Safari).
  Previously video/webm was hardcoded, causing NotSupportedError in Safari.
- Blob type fixed: finishRecording() now uses mimeTypeRef.current (set from
  recorder.mimeType after construction) so the Blob Content-Type matches
  the actual recorded container.
- Filename extension: Derived from blob.type at save time -- .webm for
  Chromium, .mp4 for Safari.
- FFmpeg source != dest collision fixed: Raw recorder output now written as
  filename_raw.ext temp file before transcoding, preventing the
  source-equals-dest failure when Safari records native MP4.
- canvas.captureStream() guard: Both canvas pipelines fall back to
  rawStream if captureStream is absent on the canvas element.
- ctx.filter guard: SUPPORTS_CANVAS_FILTER static check -- GLAM colour
  grade and badge only activate when ctx.filter is supported.
- webkit-playsinline attribute: Added to live preview and replay video
  elements to prevent iOS Safari from forcing full-screen playback.

---

### Visual and UX Changes

- Black letterbox bars: record-root, .record-video, .review-video, and
  .review-video-card all use background:#000 so any aspect ratio padding
  appears as clean black.
- iOS share page: Updated with 5-step Safari download guide.

---

### Architecture / Technical Changes

  electron/main.js:    fullscreen: !isDev; frame: false; quit-app IPC;
                       raw file _raw.ext temp; extension-agnostic mp4Filename
  electron/preload.js: quitApp() added to context bridge
  useOrientation.js:   Full rewrite: hook + getPreviewVideoStyle (contain);
                       getReplayCardStyle (maxHeight/maxWidth); getReplayVideoStyle (contain)
  RecordScreen.jsx:    pickMimeType(); SUPPORTS_CANVAS_FILTER; mimeTypeRef;
                       startMismatchCanvas (4 strategies); all mirroring removed;
                       record-root bg #000; record-video contain; webkitPlaysInline
  ReviewScreen.jsx:    webkitPlaysInline on replay video
  AdminPanel.jsx:      Orientation card; Camera Mismatch dropdown; rotate90cw/ccw;
                       Exit App button; Open Save Folder button
  AppContext.jsx:      Filename extension from blob.type
  ReviewScreen.css:    max-height 100% on card; background #000; flex containment

---

### Upgrade Notes

- Settings are forward-compatible. Existing event configs are merged with
  new defaults (orientationMode: auto, cameraMismatch: letterbox).
- No database migrations required.
- The old rotate90 mismatch value is no longer valid; configs storing
  rotate90 will fall back to letterbox automatically via settings merge.
