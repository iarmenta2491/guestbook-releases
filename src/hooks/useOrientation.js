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
 *   'letterbox'  — object-fit:contain, black bars, full frame visible (default)
 *   'centercrop' — object-fit:cover, fills the portrait space (crops sides)
 *   'rotate90'   — CSS rotate 90°+scale for physically-sideways cameras
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
 * Returns inline styles for the live camera <video> element in RecordScreen.
 * Includes the scaleX(-1) mirror for non-rotate90 modes so the user sees
 * themselves naturally in the preview.
 */
export function getPreviewVideoStyle(isPortrait, mismatch) {
  if (!isPortrait) {
    // Landscape: fill the screen with the camera feed
    return { objectFit: 'cover', transform: 'scaleX(-1)' };
  }
  switch (mismatch) {
    case 'centercrop':
      // Fill the portrait space — crops left/right edges of the landscape feed
      return { objectFit: 'cover', transform: 'scaleX(-1)' };

    case 'rotate90':
      // The recording pipeline uses startRotateCanvas() which replaces the
      // video element's srcObject with an already-correct portrait canvas stream.
      // No CSS rotation is needed — just fill the container normally.
      return { objectFit: 'cover', transform: 'none' };

    case 'letterbox':
    default:
      // Show full frame — black bars will appear for landscape video in portrait space
      return { objectFit: 'contain', transform: 'scaleX(-1)' };
  }
}

/**
 * getReplayVideoStyle
 * Returns inline styles for the replay <video> element in ReviewScreen.
 * No mirror applied (the recording is already the correct orientation).
 */
export function getReplayVideoStyle(isPortrait, mismatch) {
  if (!isPortrait) {
    return { objectFit: 'contain' };
  }
  switch (mismatch) {
    case 'centercrop':
      return { objectFit: 'cover' };

    case 'rotate90':
      // The saved file is physically portrait (720×1280 from the canvas pipeline).
      // Just display it normally — object-fit:contain shows the full upright frame.
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
      // Fill the media area completely so the video can fill the portrait space
      return { width: '100%', height: '100%', aspectRatio: 'unset' };

    case 'rotate90':
      // The saved file is physically 9:16 portrait — display as a tall card
      return { aspectRatio: '9 / 16', height: '100%', width: 'auto' };

    case 'letterbox':
    default:
      // 16:9 card full-width — video shows with black bars above/below
      return { aspectRatio: '16 / 9', width: '100%', height: 'auto' };
  }
}
