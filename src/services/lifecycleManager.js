/**
 * Android Lifecycle Manager — Handles app pause/resume, permission checks,
 * and state persistence for Capacitor Android.
 * 
 * Android aggressively kills background WebViews. This module:
 * - Saves critical state to Preferences on pause
 * - Rehydrates state on resume
 * - Re-acquires camera/mic streams after restore
 * - Checks and requests permissions before getUserMedia
 */

import { App } from '@capacitor/app';
import { Preferences } from '@capacitor/preferences';
import { Capacitor } from '@capacitor/core';

const LIFECYCLE_KEY = 'guestbook_lifecycle';

/**
 * Save volatile app state to Preferences (survives process kill).
 * Called on 'pause' and before navigating away.
 */
export async function saveLifecycleState(state) {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const payload = {
      screen: state.screen || 'attract',
      activeEventId: state.activeEventId || null,
      guestNumber: state.guestNumber || 1,
      timestamp: Date.now(),
    };
    await Preferences.set({
      key: LIFECYCLE_KEY,
      value: JSON.stringify(payload),
    });
  } catch (e) {
    console.warn('[lifecycle] Failed to save state:', e);
  }
}

/**
 * Restore lifecycle state after an Android process kill.
 * Returns null if no saved state or if it's stale (> 30 min).
 */
export async function restoreLifecycleState() {
  if (!Capacitor.isNativePlatform()) return null;
  try {
    const { value } = await Preferences.get({ key: LIFECYCLE_KEY });
    if (!value) return null;
    const state = JSON.parse(value);
    // Discard state older than 30 minutes (stale session)
    if (Date.now() - state.timestamp > 30 * 60 * 1000) return null;
    return state;
  } catch {
    return null;
  }
}

/**
 * Clear saved lifecycle state (e.g., on clean shutdown).
 */
export async function clearLifecycleState() {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await Preferences.remove({ key: LIFECYCLE_KEY });
  } catch { /* ignore */ }
}

/**
 * Register App lifecycle listeners (pause/resume).
 * Returns an unsubscribe function.
 */
export function registerLifecycleListeners({ onPause, onResume }) {
  if (!Capacitor.isNativePlatform()) return () => {};

  const handles = [];

  // App paused (user pressed Home / switched apps)
  const pauseHandle = App.addListener('pause', () => {
    console.log('[lifecycle] App paused');
    if (onPause) onPause();
  });
  handles.push(pauseHandle);

  // App resumed (user returned to the app)
  const resumeHandle = App.addListener('resume', () => {
    console.log('[lifecycle] App resumed');
    if (onResume) onResume();
  });
  handles.push(resumeHandle);

  // App state change (covers edge cases)
  const stateHandle = App.addListener('appStateChange', ({ isActive }) => {
    console.log('[lifecycle] appStateChange, isActive:', isActive);
    if (isActive && onResume) onResume();
    if (!isActive && onPause) onPause();
  });
  handles.push(stateHandle);

  return () => {
    handles.forEach(h => {
      if (h && typeof h.remove === 'function') h.remove();
    });
  };
}

/**
 * Check if camera and microphone permissions are granted.
 * Uses the Web Permissions API (supported in Android WebView).
 * Returns { camera: 'granted'|'denied'|'prompt', microphone: 'granted'|'denied'|'prompt' }
 */
export async function checkMediaPermissions() {
  const result = { camera: 'prompt', microphone: 'prompt' };
  try {
    if (navigator.permissions) {
      const [cam, mic] = await Promise.all([
        navigator.permissions.query({ name: 'camera' }).catch(() => ({ state: 'prompt' })),
        navigator.permissions.query({ name: 'microphone' }).catch(() => ({ state: 'prompt' })),
      ]);
      result.camera = cam.state;
      result.microphone = mic.state;
    }
  } catch { /* permissions API not available */ }
  return result;
}

/**
 * Request camera and microphone access with proper error handling.
 * Returns the stream on success, or null with a user-friendly error string.
 */
export async function requestMediaAccess(constraints = { video: true, audio: true }) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    return { stream, error: null };
  } catch (err) {
    const name = err.name || '';
    let error;
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      error = 'Camera/microphone permission denied. Please grant access in your device Settings → Apps → My Guestbook → Permissions.';
    } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      error = 'No camera or microphone found on this device.';
    } else if (name === 'NotReadableError' || name === 'TrackStartError') {
      error = 'Camera is in use by another app. Please close other apps and try again.';
    } else if (name === 'OverconstrainedError') {
      error = 'Camera does not support the requested settings. Trying with default settings...';
    } else {
      error = `Could not access camera/microphone: ${err.message}`;
    }
    console.warn('[lifecycle] Media access error:', name, err.message);
    return { stream: null, error };
  }
}
