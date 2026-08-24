/**
 * useOrientation.js — Shared orientation logic for all screens.
 *
 * Reads the operator-configured orientationMode setting and resolves it to a
 * simple { isPortrait, mismatch } tuple consumed by RecordScreen and ReviewScreen.
 *
 * orientationMode:
 *   'auto'      — follows the device/OS orientation in real time
 *   'landscape' — always 16:9 regardless of device rotation
 *   'portrait'  — always 9:16 regardless of device rotation
 *
 * cameraMismatch (applies when isPortrait === true and camera delivers landscape):
 *   'letterbox'   — portrait canvas with black bars above/below (contain)
 *   'centercrop'  — portrait canvas cropped from landscape centre (cover)
 *   'rotate90cw'  — landscape rotated +90° onto portrait canvas
 *   'rotate90ccw' — landscape rotated -90° onto portrait canvas
 *
 * All four strategies now bake geometry into a 720×1280 canvas stream, so the
 * saved file is always a physically correct portrait video. The mismatch value
 * has no effect on replay styles — the replay always gets a portrait file.
 */
import { useState, useEffect } from 'react';

// ── Main hook ──────────────────────────────────────────────────────────────
export function useOrientation(settings) {
  const mode     = settings?.orientationMode || 'auto';
  const mismatch = settings?.cameraMismatch  || 'letterbox';

  const resolve = () => {
    if (mode === 'landscape') return false;
    if (mode === 'portrait')  return true;
    return !window.matchMedia('(orientation: landscape)').matches;
  };

  const [isPortrait, setIsPortrait] = useState(resolve);

  useEffect(() => {
    if (mode === 'landscape') { setIsPortrait(false); return; }
    if (mode === 'portrait')  { setIsPortrait(true);  return; }

    // auto — follow OS orientation live
    const mq = window.matchMedia('(orientation: landscape)');
    const handler = (e) => setIsPortrait(!e.matches);
    setIsPortrait(!mq.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [mode]);

  return { isPortrait, mismatch };
}

// ── Style helpers ──────────────────────────────────────────────────────────

/**
 * getPreviewVideoStyle
 * Inline styles for the live camera <video> in RecordScreen.
 *
 * Always uses object-fit:contain so the full video frame is always visible —
 * no zoom, no crop, no distortion. The record-root container background is #000
 * so any letterbox/pillarbox bars are clean black.
 *
 * When startMismatchCanvas() is active, the <video> element is already
 * receiving a correctly-oriented 720×1280 portrait canvas stream, so
 * contain still shows it full-frame with no wasted pixels in portrait mode.
 */
export function getPreviewVideoStyle(isPortrait, mismatch) {
  // object-fit:contain: full frame always visible, black bars fill leftover space.
  // Works correctly for every combination of orientation and mismatch strategy.
  return { objectFit: 'contain' };
}

/**
 * getReplayVideoStyle
 * Inline styles for the replay <video> in ReviewScreen.
 *
 * object-fit:contain shows the full saved video frame without any clipping,
 * regardless of whether it is a landscape (16:9) or portrait (9:16) file.
 */
export function getReplayVideoStyle(isPortrait) {
  return { objectFit: 'contain' };
}

/**
 * getReplayCardStyle
 * Inline styles for the .review-video-card wrapper in ReviewScreen.
 *
 * Landscape → 16:9 card  (width-driven, height auto)
 * Portrait  → 9:16 card  (height-driven, width auto)
 *
 * maxHeight:'100%' ensures the card never overflows the flex media area in
 * fullscreen mode — it fills the available height but stops at the screen edge,
 * keeping the Re-Do / Complete action buttons always on-screen.
 */
export function getReplayCardStyle(isPortrait) {
  if (!isPortrait) {
    // Landscape: fill width, let height follow the 16:9 ratio, cap at 100% height
    return { aspectRatio: '16 / 9', width: '100%', height: 'auto', maxHeight: '100%' };
  }
  // Portrait: fill height, let width follow the 9:16 ratio, cap at 100% width
  return { aspectRatio: '9 / 16', height: '100%', width: 'auto', maxWidth: '100%' };
}
