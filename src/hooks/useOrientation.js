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
 * When hasMismatch is true, startMismatchCanvas() replaces videoRef.srcObject
 * with an already-correct 720×1280 portrait canvas stream, so the video element
 * just needs object-fit:cover to fill the container — no extra transforms.
 *
 * When hasMismatch is false (camera delivers portrait natively), object-fit:cover
 * fills the portrait container; object-fit:contain is used for letterbox to show
 * black bars if the camera sends a slightly different aspect ratio.
 *
 * No mirroring — the camera is displayed exactly as it sees the scene.
 */
export function getPreviewVideoStyle(isPortrait, mismatch) {
  if (!isPortrait) {
    // Landscape: fill the screen
    return { objectFit: 'cover' };
  }
  // Portrait: canvas stream is already correctly-formatted — just fill the container.
  // (CSS letterbox/cover distinction is handled inside the canvas draw loop, not here.)
  return { objectFit: 'cover' };
}

/**
 * getReplayVideoStyle
 * Inline styles for the replay <video> in ReviewScreen.
 *
 * All portrait recordings go through startMismatchCanvas → physically 720×1280 file.
 * Replay always uses object-fit:contain to show the full frame without any clipping.
 */
export function getReplayVideoStyle(isPortrait) {
  // object-fit:contain works for both landscape (16:9 file) and portrait (9:16 file)
  return { objectFit: 'contain' };
}

/**
 * getReplayCardStyle
 * Inline styles for the .review-video-card wrapper in ReviewScreen.
 *
 * Landscape → standard 16:9 card.
 * Portrait  → 9:16 card regardless of which mismatch strategy was used,
 *             because the canvas pipeline always saves a 720×1280 portrait file.
 */
export function getReplayCardStyle(isPortrait) {
  if (!isPortrait) {
    return { aspectRatio: '16 / 9', width: '100%', height: 'auto' };
  }
  // Portrait: all strategies produce a 9:16 file — display as a tall card
  return { aspectRatio: '9 / 16', height: '100%', width: 'auto' };
}
