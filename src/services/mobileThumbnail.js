/**
 * Mobile Thumbnail Generator
 * Uses HTML5 Canvas to extract a frame from a video and create a JPEG thumbnail.
 * Works in any WebView (Capacitor iOS/Android) without FFmpeg.
 */

import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Capacitor } from '@capacitor/core';
import write_blob from 'capacitor-blob-writer';

/**
 * Generate a thumbnail from a video URL.
 * @param {string} videoUrl - A WebView-playable URL (e.g. from Capacitor.convertFileSrc)
 * @param {number} [timeSeconds=0.5] - Time in seconds to capture the frame
 * @returns {Promise<Blob|null>} JPEG blob of the thumbnail, or null on failure
 */
export function captureThumbnailBlob(videoUrl, timeSeconds = 0.5) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.playsInline = true;
    video.muted = true;
    video.preload = 'metadata';

    const cleanup = () => {
      video.removeAttribute('src');
      video.load();
    };

    video.onloadeddata = () => {
      // Seek to the desired time
      video.currentTime = Math.min(timeSeconds, video.duration || 1);
    };

    video.onseeked = () => {
      try {
        const canvas = document.createElement('canvas');
        const thumbWidth = 320;
        const aspectRatio = video.videoHeight / video.videoWidth;
        canvas.width = thumbWidth;
        canvas.height = Math.round(thumbWidth * aspectRatio);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(
          (blob) => {
            cleanup();
            resolve(blob);
          },
          'image/jpeg',
          0.7
        );
      } catch (e) {
        console.warn('[Thumbnail] Canvas capture failed:', e);
        cleanup();
        resolve(null);
      }
    };

    video.onerror = () => {
      console.warn('[Thumbnail] Video load failed for:', videoUrl);
      cleanup();
      resolve(null);
    };

    // Timeout after 10 seconds
    setTimeout(() => {
      cleanup();
      resolve(null);
    }, 10000);

    video.src = videoUrl;
  });
}

/**
 * Generate and save a thumbnail to the filesystem.
 * @param {string} videoUrl - WebView-playable video URL
 * @param {string} savePath - Relative path within Directory.Data (e.g. 'events/my-event/clips/thumb_123.jpg')
 * @returns {Promise<{uri: string, webUrl: string}|null>}
 */
export async function generateAndSaveThumbnail(videoUrl, savePath) {
  const blob = await captureThumbnailBlob(videoUrl);
  if (!blob) return null;

  try {
    await write_blob({
      path: savePath,
      directory: Directory.Data,
      blob,
      recursive: true,
    });

    const stat = await Filesystem.stat({
      path: savePath,
      directory: Directory.Data,
    });

    return {
      uri: stat.uri,
      webUrl: Capacitor.convertFileSrc(stat.uri),
    };
  } catch (e) {
    console.warn('[Thumbnail] Save failed:', e);
    return null;
  }
}
