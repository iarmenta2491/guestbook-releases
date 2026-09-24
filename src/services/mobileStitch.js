/**
 * Mobile Video Compilation Engine
 *
 * Adapter layer that mirrors the desktop stitch.js API but delegates
 * to native platform APIs via the VideoComposer Capacitor plugin.
 *
 * Pipeline:
 *  1. NativeComposer writes output to getCacheDir()/exports/ (local file)
 *  2. Result is returned to JS with the local path
 *  3. capacitorBridge.stitchClips() then copies to SAF if configured
 */

import { Capacitor } from '@capacitor/core';
import { isMobile } from './platform';

// Lazy-loaded native plugin reference
// IMPORTANT: Do NOT return a Capacitor plugin proxy from an async function.
// JS Promise resolution calls .then() on the return value to check if it's
// a thenable. Capacitor proxies intercept all property access, so .then()
// gets sent to the native bridge as a method call → crash.
let _videoComposer = null;
let _importPromise = null;

async function ensureComposer() {
  if (!_videoComposer) {
    if (!_importPromise) {
      _importPromise = import('../plugins/videoComposer').then(mod => {
        _videoComposer = mod.VideoComposer;
      });
    }
    await _importPromise;
  }
  // Do NOT return the plugin — caller accesses _videoComposer directly
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

  await ensureComposer();

  const {
    trimData = {},
    bgMusicPath = null,
    bgMusicVolume = 0.1,
    transitionDurations = [],
    intro = null,
    outro = null,
  } = options;

  onProgress?.(2);

  // Output goes to native getCacheDir()/exports/ — the plugin handles the directory
  const outputPath = outputName;

  // Map clips to native paths
  const nativeClips = clips.map(clip => {
    let clipPath = clip.path || '';
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

  // IMPORTANT: Attach the progress listener BEFORE calling compose()
  // so we don't miss early progress events.
  // Access _videoComposer directly — never store the proxy in a variable
  // that could be returned from an async context.
  let progressListener = null;
  try {
    progressListener = await _videoComposer.addListener('composeProgress', (event) => {
      // Native reports 0.0 - 1.0, we map to 5-95 range
      const pct = 5 + Math.round((event.progress || 0) * 90);
      onProgress?.(pct);
    });
  } catch (e) {
    console.warn('[mobileStitch] Could not add progress listener:', e);
  }

  try {
    // Call native composition — writes to getCacheDir()/exports/
    const result = await _videoComposer.compose({
      clips: nativeClips,
      transitions: nativeTransitions,
      outputPath,
      resolution: { width: 1280, height: 720 },
      bgMusicPath: bgMusicPath || '',
      bgMusicVolume,
      introPath: intro?.mediaPath || '',
      outroPath: outro?.mediaPath || '',
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
