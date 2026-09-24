/**
 * Capacitor Bridge — Mobile Implementation of the Guestbook API
 * 
 * Mirrors the same API surface as window.guestbook (from electron/preload.js)
 * using Capacitor plugins for iOS and Android.
 * 
 * Used when isCapacitor() === true. The React frontend calls this bridge
 * identically to how it calls window.guestbook on Electron.
 */

import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Preferences } from '@capacitor/preferences';
import { Device } from '@capacitor/device';
import { App } from '@capacitor/app';
import { Share } from '@capacitor/share';
import { Capacitor } from '@capacitor/core';
import write_blob from 'capacitor-blob-writer';

// ─── Constants ───────────────────────────────────────────────────────────────

const EVENTS_DIR    = 'events';
const CLIPS_SUBDIR  = 'clips';
const CONFIG_FILE   = 'event_config.json';
const STORE_KEY     = 'guestbook_store';

// ─── Internal Helpers ────────────────────────────────────────────────────────

/** Read the app-wide store (event registry, active event, etc.) */
async function readStore() {
  try {
    const { value } = await Preferences.get({ key: STORE_KEY });
    return value ? JSON.parse(value) : { events: [], activeEventId: null };
  } catch {
    return { events: [], activeEventId: null };
  }
}

/** Write the app-wide store */
async function writeStore(store) {
  await Preferences.set({ key: STORE_KEY, value: JSON.stringify(store) });
}

/** Read an event's config JSON from filesystem */
async function readEventConfig(eventSlug) {
  try {
    const { data } = await Filesystem.readFile({
      path: `${EVENTS_DIR}/${eventSlug}/${CONFIG_FILE}`,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
    });
    return JSON.parse(data);
  } catch {
    return { settings: {}, clips: [] };
  }
}

/** Write an event's config JSON */
async function writeEventConfig(eventSlug, config) {
  await Filesystem.writeFile({
    path: `${EVENTS_DIR}/${eventSlug}/${CONFIG_FILE}`,
    directory: Directory.Data,
    data: JSON.stringify(config, null, 2),
    encoding: Encoding.UTF8,
    recursive: true,
  });
}

/** Get the active event's slug from the store */
async function getActiveSlug() {
  const store = await readStore();
  if (!store.activeEventId || !store.events.length) return null;
  const ev = store.events.find(e => e.id === store.activeEventId);
  return ev ? ev.slug : null;
}

/** Ensure a directory exists */
async function ensureDir(path) {
  try {
    await Filesystem.mkdir({
      path,
      directory: Directory.Data,
      recursive: true,
    });
  } catch {
    // already exists
  }
}

/** Convert a native file URI to a WebView-playable URL */
function toWebUrl(uri) {
  return Capacitor.convertFileSrc(uri);
}

// ─── Default Settings (must stay in sync with electron/main.js defaults) ─────

const DEFAULT_SETTINGS = {
  eventName: 'My Event',
  pin: '1234',
  maxDuration: 120,
  countdownSeconds: 5,
  idleTimeout: 30,
  prompts: ['Share a memory', 'Say something nice', 'Tell us a story'],
  orientationMode: 'auto',
  cameraMismatch: 'letterbox',
  isAudioOnly: false,
  enableTranscription: false,
  enableGlam: false,
  theme: 'midnight',
  attractTitle: 'Welcome!',
  attractSubtitle: 'Tap anywhere to start',
};

// ─── Capacitor Bridge Object ─────────────────────────────────────────────────

const capacitorBridge = {

  // ── Settings ─────────────────────────────────────────────────────────────

  async getSettings() {
    const slug = await getActiveSlug();
    if (!slug) return { ...DEFAULT_SETTINGS };
    const config = await readEventConfig(slug);
    return { ...DEFAULT_SETTINGS, ...config.settings };
  },

  async saveSettings(settings) {
    const slug = await getActiveSlug();
    if (!slug) return;
    const config = await readEventConfig(slug);
    config.settings = { ...config.settings, ...settings };
    await writeEventConfig(slug, config);
  },

  // ── Recording ────────────────────────────────────────────────────────────

  async saveRecording(buffer, filename) {
    let slug = await getActiveSlug();

    // Auto-create a default event if none exists yet
    if (!slug) {
      console.warn('[capacitorBridge] No active event — auto-creating default event');
      const res = await this.createEvent({
        name: 'My Event',
        date: new Date().toISOString().slice(0, 10),
      });
      slug = res?.event?.slug;
      if (!slug) throw new Error('Failed to auto-create default event');
    }

    const clipsPath = `${EVENTS_DIR}/${slug}/${CLIPS_SUBDIR}`;
    await ensureDir(clipsPath);

    // On mobile, write the blob directly to the filesystem.
    const blob = new Blob([buffer], { type: 'video/mp4' });
    const filePath = `${clipsPath}/${filename}`;

    await write_blob({
      path: filePath,
      directory: Directory.Data,
      blob,
      recursive: true,
    });

    // Get the native URI for playback
    const stat = await Filesystem.stat({
      path: filePath,
      directory: Directory.Data,
    });

    // Register clip in event config
    const config = await readEventConfig(slug);
    const clipId = Date.now().toString();
    const clip = {
      id: clipId,
      filename,
      path: stat.uri,
      webPath: toWebUrl(stat.uri),
      createdAt: new Date().toISOString(),
      duration: 0,
      tags: [],
      transcript: '',
      sentiment: 'neutral',
    };
    config.clips = config.clips || [];
    config.clips.push(clip);
    await writeEventConfig(slug, config);

    // Copy to user's chosen SAF directory (USB drive / custom folder)
    if (config.savePath && Capacitor.isNativePlatform()) {
      try {
        const { FileManager } = await import('../plugins/fileManager');
        // stat.uri is file:///data/... — strip to get absolute path
        const absPath = stat.uri.replace(/^file:\/\//, '');
        await FileManager.copyToSafDirectory({
          sourcePath: absPath,
          treeUri: config.savePath,
          fileName: filename,
        });
      } catch (err) {
        console.warn('[Bridge] SAF copy failed (clip still saved internally):', err);
      }
    }

    return { ok: true, clipId, path: stat.uri };
  },

  // ── Clips ────────────────────────────────────────────────────────────────

  async getClips() {
    const slug = await getActiveSlug();
    if (!slug) return [];
    const config = await readEventConfig(slug);
    return (config.clips || []).map(c => ({
      ...c,
      webPath: c.path ? toWebUrl(c.path) : '',
    }));
  },

  async getClipCount() {
    const clips = await this.getClips();
    return clips.length;
  },

  async deleteClip(clipId) {
    const slug = await getActiveSlug();
    if (!slug) return;
    const config = await readEventConfig(slug);
    const clip = (config.clips || []).find(c => c.id === clipId);
    if (clip) {
      try {
        await Filesystem.deleteFile({
          path: `${EVENTS_DIR}/${slug}/${CLIPS_SUBDIR}/${clip.filename}`,
          directory: Directory.Data,
        });
      } catch { /* file may already be gone */ }
      config.clips = config.clips.filter(c => c.id !== clipId);
      await writeEventConfig(slug, config);
    }
  },

  async deleteAllClips() {
    const slug = await getActiveSlug();
    if (!slug) return;
    const config = await readEventConfig(slug);
    for (const clip of (config.clips || [])) {
      try {
        await Filesystem.deleteFile({
          path: `${EVENTS_DIR}/${slug}/${CLIPS_SUBDIR}/${clip.filename}`,
          directory: Directory.Data,
        });
      } catch { /* ignore */ }
    }
    config.clips = [];
    await writeEventConfig(slug, config);
  },

  async reorderClips(orderedIds) {
    const slug = await getActiveSlug();
    if (!slug) return;
    const config = await readEventConfig(slug);
    const clipsMap = {};
    (config.clips || []).forEach(c => { clipsMap[c.id] = c; });
    config.clips = orderedIds.map(id => clipsMap[id]).filter(Boolean);
    await writeEventConfig(slug, config);
  },

  async updateClip(clipId, updates) {
    const slug = await getActiveSlug();
    if (!slug) return;
    const config = await readEventConfig(slug);
    const idx = (config.clips || []).findIndex(c => c.id === clipId);
    if (idx >= 0) {
      config.clips[idx] = { ...config.clips[idx], ...updates };
      await writeEventConfig(slug, config);
    }
  },

  // ── Events ───────────────────────────────────────────────────────────────

  async getEvents() {
    const store = await readStore();
    return {
      events: store.events || [],
      activeEventId: store.activeEventId,
      config: store.activeEventId ? await this.getSettings() : DEFAULT_SETTINGS,
    };
  },

  async createEvent({ name, slug, date }) {
    const store = await readStore();
    const id = Date.now().toString();
    const eventSlug = slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

    await ensureDir(`${EVENTS_DIR}/${eventSlug}/${CLIPS_SUBDIR}`);

    // Prompt SAF folder picker so the user can choose where to store clips
    let savePath = null;
    let savePathDisplay = null;
    if (Capacitor.isNativePlatform()) {
      try {
        const { FileManager } = await import('../plugins/fileManager');
        const result = await FileManager.pickDirectory();
        if (result?.uri) {
          savePath = result.uri;
          savePathDisplay = result.displayPath || result.uri;
        }
      } catch (err) {
        console.warn('[Bridge] SAF picker failed during createEvent:', err);
      }
    }

    await writeEventConfig(eventSlug, {
      settings: { ...DEFAULT_SETTINGS, eventName: name },
      clips: [],
      savePath,           // SAF content:// URI or null
      savePathDisplay,    // Human-readable display path
    });

    const event = { id, name, slug: eventSlug, date, createdAt: new Date().toISOString() };
    store.events.push(event);
    store.activeEventId = id;
    await writeStore(store);

    return { event, config: { ...DEFAULT_SETTINGS, eventName: name }, savePath, savePathDisplay };
  },

  async activateEvent(eventId) {
    const store = await readStore();
    store.activeEventId = eventId;
    await writeStore(store);
    return await this.getSettings();
  },

  async deleteEvent(eventId) {
    const store = await readStore();
    const ev = store.events.find(e => e.id === eventId);
    if (ev) {
      try {
        await Filesystem.rmdir({
          path: `${EVENTS_DIR}/${ev.slug}`,
          directory: Directory.Data,
          recursive: true,
        });
      } catch { /* ignore */ }
      store.events = store.events.filter(e => e.id !== eventId);
      if (store.activeEventId === eventId) {
        store.activeEventId = store.events.length > 0 ? store.events[0].id : null;
      }
      await writeStore(store);
    }
  },

  // ── App Info ──────────────────────────────────────────────────────────────

  async getAppInfo() {
    const deviceInfo = await Device.getInfo();
    const appInfo = await App.getInfo();
    return {
      version: appInfo.version || '1.3.0',
      platform: deviceInfo.platform,       // 'ios' | 'android'
      model: deviceInfo.model,
      osVersion: deviceInfo.osVersion,
      isNative: true,
      hasWhisperModel: false,              // Phase 2
      hasFFmpeg: false,                    // Phase 2
    };
  },

  // ── File System Sharing ──────────────────────────────────────────────────

  async openClipsFolder() {
    const clips = await this.getClips();
    if (clips.length === 0) return;
    try {
      // Use native FileManager plugin for multi-file sharing
      const { FileManager } = await import('../plugins/fileManager');
      const filePaths = clips.map(c => c.path).filter(Boolean);
      if (filePaths.length > 0) {
        await FileManager.shareFiles({
          files: filePaths,
          title: `${clips.length} Guestbook Clips`,
        });
        return;
      }
    } catch (err) {
      console.warn('[Bridge] FileManager.shareFiles failed, falling back:', err);
    }
    // Fallback: single-file share via @capacitor/share
    if (clips[0]?.path) {
      await Share.share({
        title: 'Guestbook Clips',
        text: `${clips.length} clips recorded`,
        url: clips[0].path,
        dialogTitle: 'Share Guestbook Clips',
      });
    }
  },

  // ── Storage ──────────────────────────────────────────────────────────────

  async getTotalStorage() {
    const clips = await this.getClips();
    // Rough estimate — can be refined with stat calls
    return { totalBytes: clips.length * 10 * 1024 * 1024, clipCount: clips.length };
  },

  // ── Desktop-only stubs (no-ops on mobile) ────────────────────────────────

  async transcribeClip()     { return { transcript: '', tags: [], sentiment: 'neutral' }; },

  /** Return the active event's full config (settings + clips). Used by stitchClips. */
  async getActiveConfig() {
    const slug = await getActiveSlug();
    if (!slug) return null;
    return await readEventConfig(slug);
  },

  async stitchClips(clipIds, transitions, outputName, options = {}) {
    try {
      const eventConfig = await this.getActiveConfig();
      const clips = (eventConfig?.clips || []).filter(c => clipIds.includes(c.id));
      if (clips.length === 0) throw new Error('No clips found for the given IDs');
      const { mobileStitch } = await import('./mobileStitch');
      const finalName = outputName || `compilation_${Date.now()}.mp4`;
      const result = await mobileStitch({
        clips,
        transitions,
        outputName: finalName,
        onProgress: options.onProgress,
        options,
      });

      // Copy compiled video to user's SAF directory if configured
      if (eventConfig?.savePath && Capacitor.isNativePlatform() && result.outputPath) {
        try {
          const { FileManager } = await import('../plugins/fileManager');
          await FileManager.copyToSafDirectory({
            sourcePath: result.outputPath,
            treeUri: eventConfig.savePath,
            fileName: finalName,
          });
        } catch (err) {
          console.warn('[Bridge] SAF copy of export failed (still in internal storage):', err);
        }
      }

      return { ok: true, ...result };
    } catch (err) {
      console.error('[Bridge] stitchClips failed:', err);
      return { ok: false, error: err.message || 'Compilation failed' };
    }
  },

  async openSaveDialog()     { return null; },
  async chooseMusicFile()    { return null; },
  async chooseMediaFile()    { return null; },
  async importExternalMedia(){ return null; },

  /** Open native folder picker (SAF) — works with USB-C drives too.
   *  Also persists the chosen URI to the active event's config so
   *  all future saves/exports route there automatically. */
  async chooseSavePath() {
    try {
      const { FileManager } = await import('../plugins/fileManager');
      const result = await FileManager.pickDirectory();
      if (result?.uri) {
        // Persist to the active event config immediately
        const slug = await getActiveSlug();
        if (slug) {
          const config = await readEventConfig(slug);
          config.savePath = result.uri;
          config.savePathDisplay = result.displayPath || result.uri;
          await writeEventConfig(slug, config);
        }
        return { ok: true, path: result.displayPath || result.uri, uri: result.uri };
      }
      return null; // user cancelled
    } catch (err) {
      console.error('[Bridge] chooseSavePath:', err);
      return null;
    }
  },

  /** Progress listener stub — mobile uses direct callback, no IPC events */
  onStitchProgress() { return () => {}; },

  /** Email sharing on mobile — opens native share sheet with the clip attached */
  async sendEmailShare(clipPath, email) {
    try {
      const { Share } = await import('@capacitor/share');
      const path = typeof clipPath === 'string' ? clipPath : clipPath?.path;
      await Share.share({
        title: 'Your Guestbook Recording',
        text: `Here's your guestbook recording!`,
        url: path,
        dialogTitle: 'Share via Email',
      });
    } catch (err) {
      console.error('[Bridge] sendEmailShare:', err);
    }
  },

  /** Delete all clips for the active event */
  async deleteAllClips() {
    const slug = await getActiveSlug();
    if (!slug) return;
    const config = await readEventConfig(slug);
    const clips = config.clips || [];
    // Delete files from disk
    for (const clip of clips) {
      try {
        const cleanPath = clip.path?.replace(/^file:\/\/\//, '/').replace(/^file:\/\//, '');
        if (cleanPath) {
          await Filesystem.deleteFile({ path: cleanPath });
        }
      } catch { /* file may already be gone */ }
    }
    // Clear clips array and save
    config.clips = [];
    const json = JSON.stringify(config, null, 2);
    await Filesystem.writeFile({
      path: `events/${slug}/config.json`,
      data: json,
      directory: Directory.Data,
      encoding: 'utf8',
    });
  },

  async startShareServer(arg = {}) {
    try {
      // Accept both a bare string path and an object { clipPath }
      const clipPath = typeof arg === 'string' ? arg : arg?.clipPath;
      if (!clipPath) throw new Error('clipPath is required');
      // Strip file:// prefix for native API
      const cleanPath = clipPath.replace(/^file:\/\/\//, '/').replace(/^file:\/\//, '');
      const { LocalServer } = await import('../plugins/localServer');
      const lastSlash = cleanPath.lastIndexOf('/');
      const dirPath = cleanPath.substring(0, lastSlash);
      const filename = cleanPath.substring(lastSlash + 1);
      const { url, ip, port } = await LocalServer.start({
        directoryPath: dirPath,
        port: 8080,
      });
      return {
        url: `http://${ip}:${port}/download?file=${encodeURIComponent(filename)}`,
        ip,
        port,
      };
    } catch (err) {
      console.error('[Bridge] startShareServer failed:', err);
      return { error: err.message || 'Failed to start share server' };
    }
  },

  async stopShareServer() {
    try {
      const { LocalServer } = await import('../plugins/localServer');
      await LocalServer.stop();
    } catch (err) {
      console.warn('[Bridge] stopShareServer:', err);
    }
  },

  async getFileDuration(filePath) {
    // Use a hidden video element to probe duration
    return new Promise((resolve) => {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.onloadedmetadata = () => {
        const dur = video.duration || 0;
        video.removeAttribute('src');
        video.load();
        resolve(dur);
      };
      video.onerror = () => resolve(0);
      video.src = Capacitor.convertFileSrc(filePath);
    });
  },

  /** Open the Android file manager at the event's clips folder */
  async openEventFolder(eventId) {
    try {
      let slug;
      if (eventId) {
        // If called from EventModal with a specific event ID
        const store = await readStore();
        const ev = store.events.find(e => e.id === eventId);
        slug = ev?.slug;
      }
      if (!slug) slug = await getActiveSlug();
      if (!slug) return;
      const config = await readEventConfig(slug);
      const { FileManager } = await import('../plugins/fileManager');
      // Use the event's SAF save path (from creation or chooseSavePath)
      if (config.savePath) {
        await FileManager.openFileManager({ uri: config.savePath });
      } else {
        // Fallback: open internal clips directory
        const clipDir = `events/${slug}/clips`;
        const stat = await Filesystem.stat({ path: clipDir, directory: Directory.Data });
        await FileManager.openFileManager({ path: stat.uri });
      }
    } catch (err) {
      console.warn('[Bridge] openEventFolder:', err);
      // Fallback: open generic file manager
      try {
        const { FileManager } = await import('../plugins/fileManager');
        await FileManager.openFileManager({});
      } catch { /* ignore */ }
    }
  },
  async chooseFolder()       { return this.chooseSavePath(); },
  async quitApp()            { return; },
  async checkForUpdates()    { return; },
  async installUpdate()      { return; },

  // ── Listeners (mobile) ────────────────────────────────────────────────────

  onStitchProgress(callback) {
    // Subscribe to native VideoComposer progress events
    let listener = null;
    import('../plugins/videoComposer').then(({ VideoComposer }) => {
      VideoComposer.addListener('composeProgress', (event) => {
        callback?.(Math.round((event.progress || 0) * 100));
      }).then(l => { listener = l; });
    }).catch(() => {});
    return () => { if (listener) listener.remove(); };
  },
  onTranscriptionDone()   { return () => {}; },
  onOpenAdmin()           { return () => {}; },
  onUpdateStatus()        { return () => {}; },
};

export default capacitorBridge;
