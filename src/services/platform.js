/**
 * Platform Detection Utilities
 * 
 * Detects whether the app is running inside Electron (desktop),
 * Capacitor (iOS/Android mobile), or a plain browser.
 * All platform-dependent behavior should branch through these helpers.
 */

import { Capacitor } from '@capacitor/core';

/** True when running inside the Electron desktop shell (preload bridge present) */
export const isElectron = () => !!(typeof window !== 'undefined' && window.guestbook);

/** True when running inside a Capacitor native mobile shell (iOS or Android) */
export const isCapacitor = () => {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
};

/** Convenience alias — true on iOS or Android */
export const isMobile = () => isCapacitor();

/** True when running in a plain browser with no native shell */
export const isWeb = () => !isElectron() && !isCapacitor();

/**
 * Returns the current platform identifier.
 * @returns {'electron' | 'ios' | 'android' | 'web'}
 */
export const platform = () => {
  if (isElectron()) return 'electron';
  if (isCapacitor()) return Capacitor.getPlatform(); // 'ios' | 'android'
  return 'web';
};

/**
 * Returns true if the platform supports Node.js backend features
 * (FFmpeg transcoding, whisper transcription, local HTTP share server, etc.)
 */
export const hasNativeBackend = () => isElectron();

/**
 * Returns true if the platform supports FFmpeg-based features.
 * Currently only Electron has FFmpeg. Phase 2 will add mobile via native plugin.
 */
export const hasFFmpeg = () => isElectron();

/**
 * Returns true if the platform supports offline speech transcription.
 * Currently only Electron has whisper.cpp. Phase 2 will add mobile via native plugin.
 */
export const hasTranscription = () => isElectron();
