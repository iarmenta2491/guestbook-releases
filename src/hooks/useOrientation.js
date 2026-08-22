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
 * cameraMismatch (only meaningful when isPortrait === true):
 *   'letterbox'   — object-fit:contain, black bars, full frame visible (default)
 *   'centercrop'  — object-fit:cover, fills the portrait space (crops sides)
 *   'rotate90cw'  — canvas pipeline rotates +90° (CW) for physically-sideways cameras
 *   'rotate90ccw' — canvas pipeline rotates -90° (CCW) for physically-sideways cameras
 */
import { useState, useEffect } from 'react';

// Convenience: true for either rotation direction
const isRotate = (m) => m === 'rotate90cw' || m === 'rotate90ccw';

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
 * Returns inline styles for the live camera <video> element in RecordScreen.
 * No mirroring — the camera is displayed exactly as it sees the scene.
 * For rotate90cw/ccw the canvas pipeline replaces srcObject with an already-correct
 * portrait stream, so no CSS transform is needed here.
 */
export function getPreviewVideoStyle(isPortrait, mismatch) {
  if (!isPortrait) {
    return { objectFit: 'cover' };
  }
  switch (mismatch) {
    case 'centercrop':
      return { objectFit: 'cover' };
    case 'rotate90cw':
    case 'rotate90ccw':
      // Canvas stream is already portrait-correct — fill the container normally.
      return { objectFit: 'cover' };
    case 'letterbox':
    default:
      return { objectFit: 'contain' };
  }
}

/**
 * getReplayVideoStyle
 * Returns inline styles for the replay <video> element in ReviewScreen.
 * No mirror applied (replaying the saved recording, which is physically correct).
 */
export function getReplayVideoStyle(isPortrait, mismatch) {
  if (!isPortrait) {
    return { objectFit: 'contain' };
  }
  switch (mismatch) {
    case 'centercrop':
      return { objectFit: 'cover' };
    case 'rotate90cw':
    case 'rotate90ccw':
      // Saved file is physically portrait (720×1280 from the canvas pipeline).
      return { objectFit: 'contain' };
    case 'letterbox':
    default:
      return { objectFit: 'contain' };
  }
}

/**
 * getReplayCardStyle
 * Returns inline styles for the .review-video-card wrapper in ReviewScreen.
 */
export function getReplayCardStyle(isPortrait, mismatch) {
  if (!isPortrait) {
    // Landscape — standard 16:9 card, full width
    return { aspectRatio: '16 / 9', width: '100%', height: 'auto' };
  }
  switch (mismatch) {
    case 'centercrop':
      // Fill the media area so the video can cover the portrait space
      return { width: '100%', height: '100%', aspectRatio: 'unset' };
    case 'rotate90cw':
    case 'rotate90ccw':
      // Saved file is physically 9:16 portrait — display as a tall card
      return { aspectRatio: '9 / 16', height: '100%', width: 'auto' };
    case 'letterbox':
    default:
      // 16:9 card full-width — video shows with black bars above/below
      return { aspectRatio: '16 / 9', width: '100%', height: 'auto' };
  }
}
