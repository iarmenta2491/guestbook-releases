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
    const slug = await getActiveSlug();
    if (!slug) throw new Error('No active event');

    const clipsPath = `${EVENTS_DIR}/${slug}/${CLIPS_SUBDIR}`;
    await ensureDir(clipsPath);

    // On mobile, MediaRecorder outputs H.264/AAC MP4 natively — no FFmpeg
    // transcode needed. Write the blob directly to the filesystem.
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

    return { clipId, path: stat.uri };
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
    await writeEventConfig(eventSlug, {
      settings: { ...DEFAULT_SETTINGS, eventName: name },
      clips: [],
    });

    const event = { id, name, slug: eventSlug, date, createdAt: new Date().toISOString() };
    store.events.push(event);
    store.activeEventId = id;
    await writeStore(store);

    return { event, config: { ...DEFAULT_SETTINGS, eventName: name } };
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
    // On mobile, "open folder" doesn't exist — offer native share sheet
    const clips = await this.getClips();
    if (clips.length > 0 && clips[0].path) {
      await Share.share({
        title: 'Guestbook Clips',
        text: `${clips.length} clips recorded`,
        url: clips[0].webPath,
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
  async stitchClips()        { return { error: 'Compilation not available on mobile yet' }; },
  async openSaveDialog()     { return null; },
  async chooseMusicFile()    { return null; },
  async chooseMediaFile()    { return null; },
  async importExternalMedia(){ return null; },
  async startShareServer()   { return { error: 'LAN sharing not available on mobile' }; },
  async stopShareServer()    { return; },
  async getFileDuration()    { return 0; },
  async chooseSavePath()     { return null; },
  async chooseFolder()       { return null; },
  async openEventFolder()    { return; },
  async quitApp()            { return; },
  async checkForUpdates()    { return; },
  async installUpdate()      { return; },

  // ── Listeners (mobile stubs) ─────────────────────────────────────────────

  onStitchProgress()      { return () => {}; },
  onTranscriptionDone()   { return () => {}; },
  onOpenAdmin()           { return () => {}; },
  onUpdateStatus()        { return () => {}; },
};

export default capacitorBridge;
