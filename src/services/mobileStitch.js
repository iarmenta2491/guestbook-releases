/**
 * Mobile Video Compilation Engine
 *
 * Adapter layer that mirrors the desktop stitch.js API but delegates
 * to native platform APIs via the VideoComposer Capacitor plugin.
 *
 * iOS: AVMutableComposition + AVVideoComposition (hardware-accelerated)
 * Android: Media3 Transformer + MediaMuxer (hardware-accelerated)
 */

import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { isMobile } from './platform';

// Lazy-loaded native plugin reference
let _videoComposer = null;

async function getComposer() {
  if (!_videoComposer) {
    const { VideoComposer } = await import('../plugins/videoComposer');
    _videoComposer = VideoComposer;
  }
  return _videoComposer;
}

/**
 * Stitch multiple clips together with optional transitions.
 * Mirrors the desktop engine/stitch.js API.
 *
 * @param {Object} params
 * @param {Array} params.clips - Array of clip objects with { id, path, filename }
 * @param {Array} params.transitions - Array of transition types ('hard-cut' | 'crossfade')
 * @param {string} params.outputName - Output filename (e.g. 'compilation_2026.mp4')
 * @param {Function} [params.onProgress] - Progress callback (0-100)
 * @param {Object} [params.options] - Additional options
 * @param {Object} [params.options.trimData] - { clipId: { startMs, endMs } }
 * @param {string} [params.options.bgMusicPath] - Background music file path
 * @param {number} [params.options.bgMusicVolume] - 0.0-1.0, default 0.1
 * @param {number[]} [params.options.transitionDurations] - Per-transition duration in ms
 * @returns {Promise<{outputPath: string, outputWebUrl: string}>}
 */
export async function mobileStitch({ clips, transitions, outputName, onProgress, options = {} }) {
  if (!isMobile()) {
    throw new Error('mobileStitch is only available on Capacitor (iOS/Android)');
  }

  const composer = await getComposer();

  const {
    trimData = {},
    bgMusicPath = null,
    bgMusicVolume = 0.1,
    transitionDurations = [],
  } = options;

  onProgress?.(2);

  // Ensure output directory exists
  const outputDir = 'exports';
  try {
    await Filesystem.mkdir({ path: outputDir, directory: Directory.Data, recursive: true });
  } catch { /* exists */ }

  const outputPath = `${outputDir}/${outputName}`;

  // Map clips to native paths
  const nativeClips = clips.map(clip => {
    // Convert WebView URLs back to native file URIs if needed
    let clipPath = clip.path || '';
    // If it's a capacitor:// or https://localhost URL, we need the original native path
    if (clip.nativePath) clipPath = clip.nativePath;
    return {
      path: clipPath,
      trimStartMs: trimData[clip.id]?.startMs || 0,
      trimEndMs: trimData[clip.id]?.endMs || 0,
    };
  });

  // Map transitions
  const nativeTransitions = (transitions || []).map((t, i) => ({
    type: t === 'crossfade' ? 'crossfade' : 'none',
    durationMs: transitionDurations[i] || (t === 'crossfade' ? 500 : 0),
  }));

  onProgress?.(5);

  // Listen for progress events from native
  let progressListener = null;
  try {
    progressListener = await composer.addListener('composeProgress', (event) => {
      // Native reports 0.0 - 1.0, we map to 5-95 range
      const pct = 5 + Math.round((event.progress || 0) * 90);
      onProgress?.(pct);
    });
  } catch { /* listener not supported on web stub */ }

  try {
    // Call native composition
    const result = await composer.compose({
      clips: nativeClips,
      transitions: nativeTransitions,
      outputPath,
      resolution: { width: 1280, height: 720 },
      bgMusicPath: bgMusicPath || '',
      bgMusicVolume,
    });

    onProgress?.(100);

    return {
      outputPath: result.outputPath,
      outputWebUrl: Capacitor.convertFileSrc(result.outputUri || result.outputPath),
      duration: result.durationMs || 0,
    };
  } finally {
    if (progressListener) {
      try { progressListener.remove(); } catch { /* ignore */ }
    }
  }
}
