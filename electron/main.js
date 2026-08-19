/**
 * electron/main.js — Main Electron Process
 * Handles: BrowserWindow (kiosk), IPC, local HTTP server, multi-event system, file I/O
 */

'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, session, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const { execFile } = require('child_process');
const { autoUpdater } = require('electron-updater');

// Register media:// as a privileged scheme BEFORE app is ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { bypassCSP: true, secure: true, standard: true, stream: true, supportFetchAPI: true } },
]);

// ── Local store (synchronous JSON) ────────────────────────────────────────
const SimpleStore = require('./store');
let store;

// ── State ──────────────────────────────────────────────────────────────────
let mainWindow      = null;
let localServer     = null;
let localServerPort = null;
// (ngrok removed — sharing is LAN-only)
let EVENTS_ROOT;              // resolved after app.getPath('documents') is available

// ── Auto-updater state (broadcast to renderer) ────────────────────────────
// Possible states: idle | checking | available | not-available | downloading | downloaded | error
let updateStatus = { state: 'idle', version: null, progress: null, error: null };

function broadcastUpdateStatus(patch) {
  updateStatus = { ...updateStatus, ...patch };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-status', updateStatus);
  }
}

// ── Dev / Prod URL ─────────────────────────────────────────────────────────
const isDev = process.env.NODE_ENV === 'development';
const RENDERER_URL = isDev ? 'http://localhost:5173' : null;

// ── Paths ──────────────────────────────────────────────────────────────────
// In a packaged app, assets/ is placed via extraResources → process.resourcesPath/assets
// In dev, assets/ is at the project root (one level above electron/)
const IS_PACKAGED   = app.isPackaged;
const ASSET_DIR     = IS_PACKAGED
  ? path.join(process.resourcesPath, 'assets')
  : path.join(__dirname, '..', 'assets');
const MODEL_PATH    = path.join(ASSET_DIR, 'models', 'ggml-base.en.bin');
const DIST_HTML     = path.join(__dirname, '..', 'dist', 'index.html');

// ── FFmpeg ─────────────────────────────────────────────────────────────────
let ffmpegPath;
try {
  ffmpegPath = require('ffmpeg-static');
  if (ffmpegPath.includes('app.asar')) ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
} catch (e) { ffmpegPath = 'ffmpeg'; }

// ── Default settings ───────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  pin: '1234',
  eventName: 'My Guestbook',
  attractBgPath: null,
  attractBgType: 'image',
  topicPrompts: [
    'Share a favorite memory with the guest of honor! 🎉',
    "What's your best advice for the happy couple? 💍",
    'Tell us something funny about the birthday person! 🎂',
    'What do you wish for them in the years ahead? ✨',
    'Share a story that makes everyone laugh! 😂',
    "What's one word that describes today's celebration? 🎊",
  ],
  maxDuration: 120,
  countdownSeconds: 3,
  mode: 'video+audio',
  cameraId: 'default',
  micId: 'default',
  savePath: '',
  fileNaming: '{event}_{date}_{time}_{n}',
  enableReplay: true,
  enableQR: true,
  enableEmail: false,
  decisionTimeout: 30,
  sharingTimeout: 120,
  showAttractText: true,
  showTopicPrompts: true,
  customPrompts: [],
  enableTranscription: true,
  enableSentiment: true,
  defaultTransition: 'crossfade',
  enableGlam: false,
  promptStyling: {
    color:           '#ffffff',
    rainbowAnimation: false,
    fontSize:        18,
    boxWidth:        80,
    bold:            false,
    fontFamily:      'default',
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// EVENT SYSTEM HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/** Build a filesystem-safe folder name: YYYY-MM-DD_EventName */
function makeEventSlug(name, date) {
  const safeName = (name || 'Event')
    .replace(/[<>:"/\\|?*]/g, '')    // strip path-unsafe chars
    .replace(/\s+/g, '_')
    .slice(0, 40);
  return `${date}_${safeName}`;
}

/** Create the four subdirectories every event needs */
function createEventDirs(eventDir) {
  for (const sub of ['clips', 'assets', 'exports']) {
    fs.mkdirSync(path.join(eventDir, sub), { recursive: true });
  }
}

/** Absolute path to an event's config file */
function getEventConfigPath(eventDir) {
  return path.join(eventDir, 'event_config.json');
}

/** Read {settings, clips} from an event directory. Returns defaults if missing/corrupt. */
function readEventConfig(eventDir) {
  const cfgPath = getEventConfigPath(eventDir);
  try {
    if (fs.existsSync(cfgPath)) {
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      return {
        settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
        clips:    Array.isArray(parsed.clips) ? parsed.clips : [],
      };
    }
  } catch (e) {
    console.warn('[EventConfig] Read error:', cfgPath, e.message);
  }
  return { settings: { ...DEFAULT_SETTINGS }, clips: [] };
}

/** Atomically write {settings, clips} to an event directory. */
function writeEventConfig(eventDir, data) {
  try {
    fs.mkdirSync(eventDir, { recursive: true });
    fs.writeFileSync(getEventConfigPath(eventDir), JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('[EventConfig] Write error:', eventDir, e.message);
  }
}

/** Return the registry of all event metadata objects. */
function getEventsRegistry() { return store.get('events') || []; }

/** Return the currently-active event metadata, or null. */
function getActiveEvent() {
  const id = store.get('activeEventId');
  if (!id) return null;
  return getEventsRegistry().find(e => e.id === id) || null;
}

/** Read {settings,clips} for the active event. */
function getActiveEventConfig() {
  const ev = getActiveEvent();
  return ev ? readEventConfig(ev.dir) : { settings: { ...DEFAULT_SETTINGS }, clips: [] };
}

/** Write {settings,clips} for the active event. */
function saveActiveEventConfig(data) {
  const ev = getActiveEvent();
  if (ev) writeEventConfig(ev.dir, data);
}

/** Absolute path to the active event's clips/ subdirectory. */
function getActiveClipsDir() {
  const cfg = getActiveEventConfig();
  if (cfg?.settings?.customSavePath && cfg.settings.customSavePath.trim()) {
    const dir = cfg.settings.customSavePath.trim();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  const ev = getActiveEvent();
  return ev ? path.join(ev.dir, 'clips') : path.join(EVENTS_ROOT, '_default', 'clips');
}

/** Absolute path to the active event's exports/ subdirectory. */
function getActiveExportsDir() {
  const ev = getActiveEvent();
  return ev ? path.join(ev.dir, 'exports') : path.join(EVENTS_ROOT, '_default', 'exports');
}

/**
 * One-time migration: if the store has no events yet, create a default event
 * and move existing clips + settings from the legacy store into it.
 */
function migrateToEventSystem() {
  if (getEventsRegistry().length > 0) return; // already migrated

  console.log('[Migration] First boot — creating default event from legacy data…');
  if (!fs.existsSync(EVENTS_ROOT)) fs.mkdirSync(EVENTS_ROOT, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  const legacySettings = store.get('settings') || DEFAULT_SETTINGS;
  const legacyClips    = store.get('clips')    || [];
  const eventName      = legacySettings.eventName || 'My Guestbook';

  const id       = `evt-${Date.now()}`;
  const slug     = makeEventSlug(eventName, today);
  const eventDir = path.join(EVENTS_ROOT, slug);

  createEventDirs(eventDir);

  // Best-effort: copy existing clip files into the new event clips/ folder
  const migratedClips = legacyClips.map(clip => {
    if (!clip.path) return clip;
    try {
      if (fs.existsSync(clip.path)) {
        const newPath = path.join(eventDir, 'clips', path.basename(clip.path));
        fs.copyFileSync(clip.path, newPath);
        // Also copy transcript and thumbnail sidecars
        for (const ext of ['.txt', '_thumb.jpg']) {
          const src = clip.path.replace(/\.[^.]+$/, ext);
          if (fs.existsSync(src)) fs.copyFileSync(src, newPath.replace(/\.[^.]+$/, ext));
        }
        const thumb = clip.thumbnail && fs.existsSync(clip.thumbnail)
          ? newPath.replace(/\.[^.]+$/, '_thumb.jpg')
          : clip.thumbnail;
        return { ...clip, path: newPath, thumbnail: thumb };
      }
    } catch (e) { console.warn('[Migration] clip copy failed:', e.message); }
    return clip;
  });

  writeEventConfig(eventDir, { settings: legacySettings, clips: migratedClips });

  store.set('events', [{ id, name: eventName, date: today, dir: eventDir }]);
  store.set('activeEventId', id);
  console.log('[Migration] Default event created at', eventDir);
}

// ── App ready ──────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  EVENTS_ROOT = path.join(app.getPath('documents'), 'My Guestbook', 'Events');

  // Store now tracks: activeEventId, events[], plus legacy settings/clips for compat
  store = new SimpleStore({ activeEventId: null, events: [], settings: DEFAULT_SETTINGS, clips: [] });

  // Migrate legacy single-event data on first boot
  migrateToEventSystem();

  session.defaultSession.setPermissionCheckHandler(() => true);
  session.defaultSession.setPermissionRequestHandler((_, permission, callback) => {
    callback(['media', 'mediaKeySystem', 'geolocation'].includes(permission));
  });

  protocol.handle('media', (request) => {
    let rawPath = decodeURIComponent(request.url.slice('media:///'.length));
    return net.fetch(`file:///${rawPath}`, { headers: Object.fromEntries(request.headers) });
  });

  const { globalShortcut } = require('electron');
  globalShortcut.register('Control+Shift+A', () => { if (mainWindow) mainWindow.webContents.send('open-admin'); });
  globalShortcut.register('F12',             () => { if (mainWindow) mainWindow.webContents.toggleDevTools(); });
  globalShortcut.register('Escape',          () => { if (mainWindow) mainWindow.webContents.send('open-admin'); });

  createWindow();

  // ── Auto-updater event wiring ────────────────────────────────────────────
  // Explicitly set the GitHub repo so the updater never guesses the feed URL.
  autoUpdater.setFeedURL({
    provider:       'github',
    owner:          'iarmenta2491',
    repo:           'guestbook-releases',
    releaseType:    'release',     // only stable releases, not pre-releases
  });
  autoUpdater.autoDownload         = true;   // download silently in background
  autoUpdater.autoInstallOnAppQuit = false;  // we handle install explicitly
  autoUpdater.allowPrerelease      = false;  // stable releases only
  autoUpdater.allowDowngrade       = false;  // never roll back
  console.log('[Updater] Feed: github / iarmenta2491/guestbook-releases');

  autoUpdater.on('checking-for-update', () => {
    broadcastUpdateStatus({ state: 'checking', version: null, progress: null, error: null });
  });
  autoUpdater.on('update-available', (info) => {
    broadcastUpdateStatus({ state: 'available', version: info.version, progress: null, error: null });
  });
  autoUpdater.on('update-not-available', (info) => {
    broadcastUpdateStatus({ state: 'not-available', version: info.version, progress: null, error: null });
  });
  autoUpdater.on('download-progress', (progress) => {
    broadcastUpdateStatus({
      state: 'downloading',
      progress: {
        percent:       Math.round(progress.percent),
        transferred:   progress.transferred,
        total:         progress.total,
        bytesPerSecond: progress.bytesPerSecond,
      },
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    broadcastUpdateStatus({ state: 'downloaded', version: info.version, progress: null, error: null });
  });
  autoUpdater.on('error', (err) => {
    broadcastUpdateStatus({ state: 'error', error: err?.message || String(err) });
  });

  // ── Background update check on launch (production only) ─────────────────
  if (app.isPackaged) {
    setTimeout(() => {
      autoUpdater.checkForUpdatesAndNotify().catch((err) => {
        console.warn('[Updater] Background check failed:', err?.message);
      });
    }, 5000); // 5 second delay so window loads first
  }

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') { stopLocalServer(); app.quit(); }
});

// ── Window ─────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 800,
    frame: true, backgroundColor: '#08081a', show: true, autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, webSecurity: false,
    },
  });
  mainWindow.maximize();
  mainWindow.focus();
  if (isDev) mainWindow.loadURL(RENDERER_URL);
  else        mainWindow.loadFile(DIST_HTML);
  mainWindow.once('ready-to-show', () => mainWindow.focus());
  mainWindow.webContents.on('crashed', () => {
    console.error('[Electron] Renderer crashed — reloading…');
    setTimeout(() => mainWindow && mainWindow.reload(), 2000);
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ═══════════════════════════════════════════════════════════════════════════
// IPC — EVENT MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

/** Return the full events list + active event id + active event config. */
ipcMain.handle('get-events', () => {
  const events      = getEventsRegistry();
  const activeEventId = store.get('activeEventId') || null;
  const activeEvent = events.find(e => e.id === activeEventId) || null;

  // Annotate each event with its clip count (read from its config JSON)
  const annotated = events.map(ev => {
    try {
      const cfg = readEventConfig(ev.dir);
      return { ...ev, clipCount: cfg.clips.length };
    } catch { return { ...ev, clipCount: 0 }; }
  });

  // Also return the active event's full config for immediate React reload
  let activeConfig = null;
  if (activeEvent) {
    activeConfig = readEventConfig(activeEvent.dir);
  }

  return { events: annotated, activeEventId, activeConfig };
});

/** Create a new event, optionally cloning settings from the current active event. */
ipcMain.handle('create-event', async (_, { name, date, cloneSettings }) => {
  try {
    if (!fs.existsSync(EVENTS_ROOT)) fs.mkdirSync(EVENTS_ROOT, { recursive: true });

    const id       = `evt-${Date.now()}`;
    const slug     = makeEventSlug(name, date);
    const eventDir = path.join(EVENTS_ROOT, slug);

    if (fs.existsSync(eventDir)) {
      // Append a counter to avoid collision
      const eventDirUniq = eventDir + `_${id.slice(-6)}`;
      createEventDirs(eventDirUniq);
      const baseSettings = cloneSettings ? getActiveEventConfig().settings : DEFAULT_SETTINGS;
      const newSettings  = { ...baseSettings, eventName: name };
      writeEventConfig(eventDirUniq, { settings: newSettings, clips: [] });

      const meta = { id, name, date, dir: eventDirUniq };
      const events = getEventsRegistry();
      events.push(meta);
      store.set('events', events);
      store.set('activeEventId', id);
      return { ok: true, event: { ...meta, clipCount: 0 }, settings: newSettings, clips: [] };
    }

    createEventDirs(eventDir);
    const baseSettings = cloneSettings ? getActiveEventConfig().settings : DEFAULT_SETTINGS;
    const newSettings  = { ...baseSettings, eventName: name };
    writeEventConfig(eventDir, { settings: newSettings, clips: [] });

    const meta = { id, name, date, dir: eventDir };
    const events = getEventsRegistry();
    events.push(meta);
    store.set('events', events);
    store.set('activeEventId', id);

    return { ok: true, event: { ...meta, clipCount: 0 }, settings: newSettings, clips: [] };
  } catch (err) {
    console.error('[create-event]', err);
    return { ok: false, error: err.message };
  }
});

/** Switch the active event and return its full config for React reload. */
ipcMain.handle('activate-event', (_, { eventId }) => {
  try {
    const events = getEventsRegistry();
    const ev     = events.find(e => e.id === eventId);
    if (!ev) return { ok: false, error: 'Event not found' };

    store.set('activeEventId', eventId);
    const cfg = readEventConfig(ev.dir);
    return { ok: true, event: { ...ev, clipCount: cfg.clips.length }, settings: cfg.settings, clips: cfg.clips };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/** Delete an event — removes its directory and registry entry. */
ipcMain.handle('delete-event', (_, { eventId }) => {
  try {
    const events = getEventsRegistry();
    const ev     = events.find(e => e.id === eventId);
    if (!ev) return { ok: false, error: 'Event not found' };

    // Remove directory tree
    if (fs.existsSync(ev.dir)) {
      fs.rmSync(ev.dir, { recursive: true, force: true });
    }

    const remaining = events.filter(e => e.id !== eventId);
    store.set('events', remaining);

    // If we deleted the active event, activate the most recent remaining one
    if (store.get('activeEventId') === eventId) {
      const next = remaining[remaining.length - 1] || null;
      store.set('activeEventId', next ? next.id : null);
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/** Open the event's root folder in File Explorer. */
ipcMain.handle('open-event-folder', (_, { eventId }) => {
  const events = getEventsRegistry();
  const ev     = events.find(e => e.id === eventId);
  if (!ev) return { ok: false };
  if (!fs.existsSync(ev.dir)) fs.mkdirSync(ev.dir, { recursive: true });
  shell.openPath(ev.dir);
  return { ok: true };
});

// ═══════════════════════════════════════════════════════════════════════════
// IPC — SETTINGS  (per-event)
// ═══════════════════════════════════════════════════════════════════════════

ipcMain.handle('get-settings', () => {
  const cfg = getActiveEventConfig();
  return { ...DEFAULT_SETTINGS, ...cfg.settings };
});

ipcMain.handle('save-settings', (_, settings) => {
  const cfg = getActiveEventConfig();
  cfg.settings = { ...DEFAULT_SETTINGS, ...settings };
  saveActiveEventConfig(cfg);
  return { ok: true };
});

// ═══════════════════════════════════════════════════════════════════════════
// IPC — RECORDINGS  (per-event)
// ═══════════════════════════════════════════════════════════════════════════

ipcMain.handle('save-recording', async (_, { buffer, filename }) => {
  try {
    // Read config atomically to prevent stale-path bugs
    const cfg = getActiveEventConfig();
    let clipsDir;
    if (cfg?.settings?.customSavePath && cfg.settings.customSavePath.trim()) {
      clipsDir = cfg.settings.customSavePath.trim();
    } else {
      const ev = getActiveEvent();
      clipsDir = ev ? path.join(ev.dir, 'clips') : path.join(EVENTS_ROOT, '_default', 'clips');
    }
    if (!fs.existsSync(clipsDir)) fs.mkdirSync(clipsDir, { recursive: true });

    // Step 1: Write raw WebM to disk
    const rawWebmPath = path.join(clipsDir, filename);
    fs.writeFileSync(rawWebmPath, Buffer.from(buffer));
    console.log('[Save] Raw WebM written:', path.basename(rawWebmPath));

    // Step 2: Transcode to iOS-compatible H.264 MP4 (awaited)
    const mp4Filename  = filename.replace(/\.webm$/i, '.mp4');
    const mp4Path      = path.join(clipsDir, mp4Filename);
    const transcoded   = await generateMobileMP4(rawWebmPath, mp4Path);

    let finalPath, finalFilename;
    if (transcoded) {
      // Step 3: Delete temp WebM, use the MP4
      try { fs.unlinkSync(rawWebmPath); } catch (_) {}
      finalPath     = mp4Path;
      finalFilename = mp4Filename;
      console.log('[Save] ✅ MP4 ready:', path.basename(finalPath));
    } else {
      // FFmpeg unavailable — fall back to the raw WebM
      finalPath     = rawWebmPath;
      finalFilename = filename;
      console.warn('[Save] ⚠️ FFmpeg failed — keeping WebM fallback');
    }

    const clip = {
      id:        Date.now().toString(),
      filename:  finalFilename,
      path:      finalPath,
      createdAt: new Date().toISOString(),
      duration:  0,
      transcript: null,
      tags:       [],
      sentiment: 'neutral',
      thumbnail: null,
      order:     cfg.clips.length,
    };
    cfg.clips.push(clip);
    saveActiveEventConfig(cfg);

    // Generate thumbnail in background (non-blocking)
    generateThumbnail(finalPath, clip.id).catch(() => {});

    return { ok: true, path: finalPath, clipId: clip.id };
  } catch (err) {
    console.error('[Save] Error:', err.message);
    return { ok: false, error: err.message };
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// IPC — CLIPS  (per-event)
// ═══════════════════════════════════════════════════════════════════════════

ipcMain.handle('get-clips', () => getActiveEventConfig().clips);

ipcMain.handle('delete-clip', async (_, clipId) => {
  try {
    const cfg  = getActiveEventConfig();
    const clip = cfg.clips.find(c => c.id === clipId);
    if (clip) {
      // Move primary file to Trash
      if (clip.path && fs.existsSync(clip.path)) {
        try { await shell.trashItem(clip.path); } catch (_) {}
      }
      // Move associated files to Trash (silently ignore if missing)
      const associates = [
        clip.path ? clip.path.replace(/\.[^.]+$/, '.txt')        : null,
        clip.path ? clip.path.replace(/\.[^.]+$/, '_thumb.jpg')  : null,
        clip.path ? clip.path.replace(/\.[^.]+$/, '_mobile.mp4') : null,
      ];
      for (const f of associates) {
        if (f && fs.existsSync(f)) try { await shell.trashItem(f); } catch (_) {}
      }
    }
    cfg.clips = cfg.clips.filter(c => c.id !== clipId);
    saveActiveEventConfig(cfg);
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('delete-all-clips', async () => {
  try {
    const cfg = getActiveEventConfig();
    for (const clip of cfg.clips) {
      if (clip.path && fs.existsSync(clip.path)) {
        try { await shell.trashItem(clip.path); } catch (_) {}
      }
      try {
        const txt   = clip.path.replace(/\.[^.]+$/, '.txt');
        const thumb = clip.path.replace(/\.[^.]+$/, '_thumb.jpg');
        const mp4   = clip.path.replace(/\.[^.]+$/, '_mobile.mp4');
        if (fs.existsSync(txt))   try { await shell.trashItem(txt);   } catch (_) {}
        if (fs.existsSync(thumb)) try { await shell.trashItem(thumb); } catch (_) {}
        if (fs.existsSync(mp4))   try { await shell.trashItem(mp4);   } catch (_) {}
      } catch (_) {}
    }
    const count = cfg.clips.length;
    cfg.clips = [];
    saveActiveEventConfig(cfg);
    return { ok: true, deleted: count };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('reorder-clips', (_, orderedIds) => {
  const cfg = getActiveEventConfig();
  cfg.clips = orderedIds
    .map((id, index) => { const c = cfg.clips.find(x => x.id === id); if (c) c.order = index; return c; })
    .filter(Boolean);
  saveActiveEventConfig(cfg);
  return { ok: true };
});

ipcMain.handle('update-clip', (_, { clipId, updates }) => {
  const cfg = getActiveEventConfig();
  const idx = cfg.clips.findIndex(c => c.id === clipId);
  if (idx !== -1) { cfg.clips[idx] = { ...cfg.clips[idx], ...updates }; saveActiveEventConfig(cfg); }
  return { ok: true };
});

async function generateThumbnail(videoPath, clipId) {
  const thumbPath = videoPath.replace(/\.[^.]+$/, '_thumb.jpg');
  return new Promise((resolve) => {
    execFile(ffmpegPath, ['-y', '-i', videoPath, '-ss', '0', '-vframes', '1', '-vf', 'scale=320:-1', thumbPath], (err) => {
      if (!err) {
        const cfg = getActiveEventConfig();
        const idx = cfg.clips.findIndex(c => c.id === clipId);
        if (idx !== -1) { cfg.clips[idx].thumbnail = thumbPath; saveActiveEventConfig(cfg); }
        resolve(thumbPath);
      } else { resolve(null); }
    });
  });
}

/**
 * generateMobileMP4 — transcode any source to iOS-safe H.264 MP4.
 * ultrafast preset: encodes a 30-second clip in ~1-2 seconds on modern hardware.
 */
async function generateMobileMP4(sourcePath, destPath) {
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
    console.warn('[MP4] ffmpeg not found — skipping transcode');
    return null;
  }
  console.log('[MP4] Transcoding:', path.basename(sourcePath), '→', path.basename(destPath));
  return new Promise((resolve) => {
    const args = [
      '-y', '-i', sourcePath,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',     // fastest encode — 1-3s for typical kiosk clips
      '-crf', '28',               // good mobile quality at small file size
      '-c:a', 'aac',
      '-movflags', '+faststart',  // moov atom at front — required for iOS progressive download
      '-pix_fmt', 'yuv420p',      // widest iOS/Android device compatibility
      destPath,
    ];
    execFile(ffmpegPath, args, { timeout: 300_000, windowsHide: true }, (err, _stdout, stderr) => {
      if (err) {
        console.error('[MP4] Transcode failed:', err.message);
        if (stderr) console.error('[MP4] stderr:', stderr.slice(0, 600));
        try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch (_) {}
        resolve(null);
      } else {
        const mb = (fs.statSync(destPath).size / 1048576).toFixed(1);
        console.log(`[MP4] ✅ Done: ${path.basename(destPath)} (${mb} MB)`);
        resolve(destPath);
      }
    });
  });
}


// ═══════════════════════════════════════════════════════════════════════════
// IPC — AI PIPELINE  (per-event)
// ═══════════════════════════════════════════════════════════════════════════

// Only runs when settings.enableTranscription is true.
ipcMain.handle('transcribe-clip', async (event, { clipId }) => {
  const cfg      = getActiveEventConfig();
  const settings = cfg.settings || {};
  const clip     = cfg.clips.find(c => c.id === clipId);
  if (!clip) return { ok: false, error: 'Clip not found' };

  if (!settings.enableTranscription) return { ok: false, error: 'Transcription disabled in settings' };

  try {
    const { transcribe } = require('../pipeline/transcribe');
    const text = await transcribe(clip.path, ffmpegPath, MODEL_PATH);

    const txtPath = clip.path.replace(/\.[^.]+$/, '.txt');
    fs.writeFileSync(txtPath, text, 'utf8');

    let tags = [], sentiment = 'neutral';
    if (settings.enableSentiment) {
      const { tagText } = require('../pipeline/tag');
      ({ tags, sentiment } = tagText(text));
    }

    const latestCfg = getActiveEventConfig();
    const idx = latestCfg.clips.findIndex(c => c.id === clipId);
    if (idx !== -1) {
      latestCfg.clips[idx].transcript = text;
      latestCfg.clips[idx].tags       = tags;
      latestCfg.clips[idx].sentiment  = sentiment;
      saveActiveEventConfig(latestCfg);
    }

    event.sender.send('transcription-done', { clipId, text, tags, sentiment });
    return { ok: true, text, tags, sentiment };
  } catch (err) {
    console.error('[Transcription]', err);
    event.sender.send('transcription-done', { clipId, text: '', tags: [], sentiment: 'neutral' });
    return { ok: false, error: err.message };
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// IPC — VIDEO COMPILATION  (per-event)
// ═══════════════════════════════════════════════════════════════════════════

ipcMain.handle('stitch-clips', async (event, { clipIds, transitions, outputPath, options }) => {
  try {
    const { stitch }    = require('../engine/stitch');
    const cfg           = getActiveEventConfig();
    const savedLookup   = Object.fromEntries(cfg.clips.map(c => [c.id, c]));
    const extPaths      = options?.externalClipPaths || {};

    const ordered = clipIds.map(id => {
      if (savedLookup[id]) return savedLookup[id];
      if (extPaths[id])    return { id, path: String(extPaths[id]), duration: 0 };
      throw new Error(`Clip not found: id="${id}". Re-import the file and try again.`);
    });

    await stitch({
      clips: ordered, transitions, outputPath, ffmpegPath,
      options: options || {},
      onProgress: (pct) => { try { event.sender.send('stitch-progress', { pct }); } catch (_) {} },
    });
    return { ok: true };
  } catch (err) {
    console.error('[stitch-clips]', err.stack || err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('open-save-dialog', async (_, { defaultName }) => {
  const exportsDir = getActiveExportsDir();
  if (!fs.existsSync(exportsDir)) fs.mkdirSync(exportsDir, { recursive: true });
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Guestbook Video',
    defaultPath: path.join(exportsDir, defaultName || 'guestbook.mp4'),
    filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
  });
  return result.canceled ? null : result.filePath;
});

// ═══════════════════════════════════════════════════════════════════════════
// IPC — QR / SHARING
// ═══════════════════════════════════════════════════════════════════════════

ipcMain.handle('start-share-server', async (_, { clipPath }) => {
  stopLocalServer();
  const port      = await findFreePort(8765);
  const localIP   = getLocalIP();
  const eventName = (getActiveEventConfig()?.settings?.eventName || 'My Guestbook').replace(/</g, '&lt;');
  const dlName    = path.basename(clipPath);

  localServer = http.createServer((req, res) => {
    const url = req.url.split('?')[0];

    res.setHeader('Access-Control-Allow-Origin', '*');

    // ── /video — stream the MP4 clip ─────────────────────────────────────
    if (url === '/video') {
      try {
        // Support optional ?file= param so /download can link to a specific file
        let qFile = '';
        try { qFile = new URL('http://x' + req.url).searchParams.get('file') || ''; } catch (_) {}
        const targetPath = qFile
          ? path.join(path.dirname(clipPath), path.basename(qFile)) // basename prevents traversal
          : clipPath;
        if (!fs.existsSync(targetPath)) { res.writeHead(404); res.end('Not found'); return; }
        const stat = fs.statSync(targetPath);
        res.writeHead(200, {
          'Content-Type':        'video/mp4',
          'Content-Length':      stat.size,
          'Content-Disposition': `attachment; filename="${path.basename(targetPath)}"`,
          'Accept-Ranges':       'bytes',
          'Cache-Control':       'no-cache',
        });
        fs.createReadStream(targetPath).pipe(res);
      } catch (e) { res.writeHead(500); res.end('Error'); }

    // ── /download?file= — QR-linked page, filename from query string ───────────
    } else if (url === '/download') {
      // Parse ?file= query param from the full req.url
      let qFile = '';
      try { qFile = new URL('http://x' + req.url).searchParams.get('file') || ''; } catch (_) {}
      const serveFile = qFile || dlName; // fallback to closure dlName
      // Resolve the actual file path: look in the same dir as clipPath
      const serveDir  = path.dirname(clipPath);
      const servePath = path.join(serveDir, serveFile);
      const safeName  = path.basename(servePath); // strip any path traversal
      const videoHref = `/video?file=${encodeURIComponent(safeName)}`;
      const dlPageHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <title>Your Message \u2013 ${eventName}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #07071a; color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      min-height: 100dvh; display: flex; flex-direction: column; align-items: center;
      padding: env(safe-area-inset-top, 20px) 0 env(safe-area-inset-bottom, 20px);
    }
    header {
      width: 100%; padding: 28px 24px 20px;
      background: linear-gradient(135deg, rgba(139,92,246,.18), rgba(45,212,191,.10));
      border-bottom: 1px solid rgba(139,92,246,.2); text-align: center;
    }
    header h1 { font-size: clamp(1.2rem, 5.5vw, 1.6rem); font-weight: 700; letter-spacing: -.01em; }
    header p  { font-size: .9rem; color: rgba(255,255,255,.6); margin-top: 6px; }
    .content {
      flex: 1; display: flex; flex-direction: column; align-items: center;
      justify-content: center; gap: 24px;
      padding: 40px 24px; width: 100%; max-width: 460px;
    }
    .icon { font-size: 4rem; line-height: 1; }
    .tagline { font-size: clamp(1rem,4vw,1.1rem); font-weight: 500; color: rgba(255,255,255,.6); text-align: center; line-height: 1.55; }
    .ios-guide {
      display: none; width: 100%; background: #e8f4fd;
      border: 1.5px solid #90c9f0; border-radius: 16px;
      padding: 18px 20px; color: #0d3d6b;
    }
    .ios-guide-title {
      font-size: .8rem; font-weight: 700; letter-spacing: .08em;
      text-transform: uppercase; color: #1a6dab; margin-bottom: 10px;
      display: flex; align-items: center; gap: 6px;
    }
    .ios-guide ol { padding-left: 20px; display: flex; flex-direction: column; gap: 8px; }
    .ios-guide li { font-size: .92rem; line-height: 1.45; color: #0d3d6b; }
    .ios-guide li strong { font-weight: 700; }
    .dl-btn {
      display: flex; align-items: center; justify-content: center; gap: 10px;
      width: 100%; padding: 22px 32px;
      background: linear-gradient(135deg, #8b5cf6, #6d28d9); color: #fff;
      font-size: clamp(1.1rem,4.5vw,1.35rem); font-weight: 700; letter-spacing: .02em;
      text-decoration: none; border-radius: 100px;
      box-shadow: 0 4px 40px rgba(139,92,246,.55);
      -webkit-tap-highlight-color: transparent;
      transition: transform .15s ease, box-shadow .15s ease;
    }
    .dl-btn:active { transform: scale(.96); box-shadow: 0 2px 20px rgba(139,92,246,.35); }
    footer { padding: 20px 24px; font-size: .7rem; color: rgba(255,255,255,.2); text-align: center; }
  </style>
</head>
<body>
  <header>
    <h1>&#x1F3AC; ${eventName}</h1>
    <p>Your message has been saved! &#x1F389;</p>
  </header>
  <div class="content">
    <div class="icon">&#x1F4F1;</div>
    <p class="tagline">Your video message is ready.<br>Tap below to download it.</p>
    <div class="ios-guide" id="iosGuide">
      <div class="ios-guide-title">&#x1F34E; iPhone User Guide</div>
      <ol>
        <li>Tap <strong>Download Video</strong> below.</li>
        <li>Open your blue <strong>Files</strong> app.</li>
        <li>Tap the <strong>Share &#x29C9;</strong> icon, then tap <strong>Save Video</strong> to move it to your Camera Roll.</li>
      </ol>
    </div>
    <a class="dl-btn" href="${videoHref}" download="${safeName}">
      &#x2B07;&#xFE0F;&nbsp; Download Video
    </a>
  </div>
  <footer>Scan the QR code at the kiosk to keep your message.</footer>
  <script>
    var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
             || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isIOS) document.getElementById('iosGuide').style.display = 'block';
  </script>
</body>
</html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(dlPageHtml);

    // ── / and /mobile-download — dedicated mobile HTML page ──────────────
    // Both paths serve the same template. The QR code always links to
    // /mobile-download so phones never hit the React SPA root.
    } else if (url === '/' || url === '/mobile-download') {
      const mobileHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <title>Your Message \u2013 ${eventName}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #07071a; color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      min-height: 100dvh; display: flex; flex-direction: column; align-items: center;
      padding: env(safe-area-inset-top, 20px) 0 env(safe-area-inset-bottom, 20px);
    }
    header {
      width: 100%; padding: 28px 24px 20px;
      background: linear-gradient(135deg, rgba(139,92,246,.18), rgba(45,212,191,.10));
      border-bottom: 1px solid rgba(139,92,246,.2); text-align: center;
    }
    header h1 { font-size: clamp(1.2rem, 5.5vw, 1.6rem); font-weight: 700; letter-spacing: -.01em; }
    header p  { font-size: .9rem; color: rgba(255,255,255,.6); margin-top: 6px; }
    .content {
      flex: 1; display: flex; flex-direction: column; align-items: center;
      justify-content: center; gap: 24px;
      padding: 40px 24px; width: 100%; max-width: 460px;
    }
    .icon { font-size: 4rem; line-height: 1; }
    .tagline {
      font-size: clamp(1rem, 4vw, 1.1rem); font-weight: 500;
      color: rgba(255,255,255,.6); text-align: center; line-height: 1.55;
    }
    .ios-guide {
      display: none; width: 100%; background: #e8f4fd;
      border: 1.5px solid #90c9f0; border-radius: 16px;
      padding: 18px 20px; color: #0d3d6b;
    }
    .ios-guide-title {
      font-size: .8rem; font-weight: 700; letter-spacing: .08em;
      text-transform: uppercase; color: #1a6dab; margin-bottom: 10px;
      display: flex; align-items: center; gap: 6px;
    }
    .ios-guide ol { padding-left: 20px; display: flex; flex-direction: column; gap: 8px; }
    .ios-guide li { font-size: .92rem; line-height: 1.45; color: #0d3d6b; }
    .ios-guide li strong { font-weight: 700; }
    .dl-btn {
      display: flex; align-items: center; justify-content: center; gap: 10px;
      width: 100%; padding: 22px 32px;
      background: linear-gradient(135deg, #8b5cf6, #6d28d9); color: #fff;
      font-size: clamp(1.1rem, 4.5vw, 1.35rem); font-weight: 700; letter-spacing: .02em;
      text-decoration: none; border-radius: 100px;
      box-shadow: 0 4px 40px rgba(139,92,246,.55);
      -webkit-tap-highlight-color: transparent;
      transition: transform .15s ease, box-shadow .15s ease;
    }
    .dl-btn:active { transform: scale(.96); box-shadow: 0 2px 20px rgba(139,92,246,.35); }
    footer { padding: 20px 24px; font-size: .7rem; color: rgba(255,255,255,.2); text-align: center; }
  </style>
</head>
<body>
  <header>
    <h1>&#x1F3AC; ${eventName}</h1>
    <p>Your message has been saved! &#x1F389;</p>
  </header>
  <div class="content">
    <div class="icon">&#x1F4F1;</div>
    <p class="tagline">Your video message is ready.<br>Tap below to download it.</p>
    <div class="ios-guide" id="iosGuide">
      <div class="ios-guide-title">&#x1F34E; iPhone User Guide</div>
      <ol>
        <li>Tap <strong>Download Video</strong> below.</li>
        <li>Open your blue <strong>Files</strong> app.</li>
        <li>Tap the <strong>Share &#x29C9;</strong> icon, then tap <strong>Save Video</strong> to move it to your Camera Roll.</li>
      </ol>
    </div>
    <a class="dl-btn" id="dlBtn" href="/video" download="${dlName}">
      &#x2B07;&#xFE0F;&nbsp; Download Video
    </a>
  </div>
  <footer>Scan the QR code at the kiosk to keep your message.</footer>
  <script>
    var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
             || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isIOS) document.getElementById('iosGuide').style.display = 'block';
  </script>
</body>
</html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(mobileHtml);

    // ── Anything else — strict 404 so the React SPA never leaks through ────
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  });

  // Track sockets for instant cleanup
  localServer.on('connection', (sock) => {
    _openSockets.add(sock);
    sock.once('close', () => _openSockets.delete(sock));
  });

  // Prevent unhandled 'error' events from crashing the main process
  localServer.on('error', (err) => {
    console.error('[QR] Server error:', err.message);
  });

  localServer.listen(port, '0.0.0.0', () => {
    console.log(`[QR] Share server listening on http://${localIP}:${port}`);
  });
  localServerPort = port;

  const localUrl = `http://${localIP}:${port}`;
  return { ok: true, url: localUrl, localUrl, publicUrl: null };
});

ipcMain.handle('stop-share-server', () => { stopLocalServer(); return { ok: true }; });


// Track open sockets so stopLocalServer can destroy them immediately
let _openSockets = new Set();

function stopLocalServer() {
  if (localServer) {
    // Destroy all open sockets so the port is released instantly (no TIME_WAIT)
    for (const sock of _openSockets) { try { sock.destroy(); } catch (_) {} }
    _openSockets.clear();
    try { localServer.close(); } catch (_) {}
    localServer = null;
    localServerPort = null;
    console.log('[QR] Share server stopped.');
  }
}

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  // Prefer common LAN subnets (192.168.x.x / 10.x.x.x / 172.16-31.x.x) — phones live here
  const isLAN = (addr) => /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(addr);
  let fallback = null;
  for (const iface of Object.values(ifaces)) {
    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) {
        if (isLAN(alias.address)) return alias.address;  // best match
        if (!fallback) fallback = alias.address;         // keep first non-internal as fallback
      }
    }
  }
  return fallback || '127.0.0.1';
}

// Try up to 10 consecutive ports until one is free
function findFreePort(preferred, attempt = 0) {
  if (attempt >= 10) return Promise.resolve(preferred);
  return new Promise((resolve) => {
    const srv = require('net').createServer();
    srv.listen(preferred, '0.0.0.0', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on('error', () => resolve(findFreePort(preferred + 1, attempt + 1)));
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// IPC — FOLDER / FILE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

ipcMain.handle('enumerate-devices', async () => ({ ok: true }));

ipcMain.handle('open-clips-folder', async () => {
  const dir = getActiveClipsDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
  return { ok: true };
});

ipcMain.handle('choose-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'], title: 'Choose save folder for recordings',
  });
  return { canceled: result.canceled, path: result.filePaths?.[0] || '' };
});

ipcMain.handle('choose-music-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'], title: 'Choose background music',
    filters: [{ name: 'Audio', extensions: ['mp3', 'aac', 'wav', 'flac', 'm4a'] }],
  });
  return result.canceled ? null : (result.filePaths?.[0] || null);
});

ipcMain.handle('choose-media-file', async (_, { types }) => {
  const VIDEO_EXTS = ['mp4', 'mov', 'webm', 'mkv', 'avi'];
  const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
  const ALL_EXTS   = [...VIDEO_EXTS, ...IMAGE_EXTS];
  let filters, title;
  if      (types === 'video') { filters = [{ name: 'Video Files', extensions: VIDEO_EXTS }]; title = 'Choose a video file'; }
  else if (types === 'image') { filters = [{ name: 'Image Files', extensions: IMAGE_EXTS }]; title = 'Choose an image file'; }
  else { filters = [{ name: 'All Supported Media', extensions: ALL_EXTS }, { name: 'Video Files', extensions: VIDEO_EXTS }, { name: 'Image Files', extensions: IMAGE_EXTS }]; title = 'Choose a video or image file'; }
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], title, filters });
  return { canceled: result.canceled, path: result.filePaths?.[0] || '' };
});

// ── Import external media ──────────────────────────────────────────────────
ipcMain.handle('import-external-media', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'], title: 'Import Video or Image',
    filters: [
      { name: 'All Supported Media', extensions: ['mp4', 'mov', 'webm', 'mkv', 'avi', 'jpg', 'jpeg', 'png', 'webp', 'gif'] },
      { name: 'Video Files',         extensions: ['mp4', 'mov', 'webm', 'mkv', 'avi'] },
      { name: 'Image Files',         extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] },
    ],
  });
  if (result.canceled || !result.filePaths?.[0]) return null;

  const filePath = result.filePaths[0];
  const filename = path.basename(filePath);
  const ext      = path.extname(filePath).toLowerCase();
  const isImage  = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext);
  const clipId   = `ext-${Date.now()}`;

  let duration = 0;
  if (!isImage) {
    duration = await new Promise((resolve) => {
      execFile(String(ffmpegPath), ['-i', filePath, '-f', 'null', '-'], { timeout: 15000 }, (_, __, stderr) => {
        const m = (stderr || '').match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
        resolve(m ? parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]) : 0);
      });
    });
  }

  const thumbPath = path.join(os.tmpdir(), `gb_thumb_${clipId}.jpg`);
  let thumbnail   = null;
  try {
    const seekSec   = isImage ? 0 : Math.min(1, Math.max(0, duration - 0.1));
    const thumbArgs = isImage
      ? ['-y', '-i', filePath, '-vframes', '1', '-q:v', '3', thumbPath]
      : ['-y', '-ss', String(seekSec), '-i', filePath, '-vframes', '1', '-q:v', '3', thumbPath];
    await new Promise((resolve, reject) => {
      execFile(String(ffmpegPath), thumbArgs, { timeout: 20000 }, (err) => { if (err) reject(err); else resolve(); });
    });
    if (fs.existsSync(thumbPath)) {
      thumbnail = `data:image/jpeg;base64,${fs.readFileSync(thumbPath).toString('base64')}`;
      try { fs.unlinkSync(thumbPath); } catch (_) {}
    }
  } catch (e) { console.warn('[import-external-media] thumbnail failed:', e.message); }

  return {
    id: clipId, filename, filePath, path: filePath,
    duration, thumbnail, isExternal: true,
    tags: ['imported'], sentiment: 'neutral', transcript: null,
    createdAt: new Date().toISOString(),
  };
});

// ── System info ────────────────────────────────────────────────────────────
ipcMain.handle('get-app-info', () => ({
  version:      app.getVersion(),
  modelPresent: fs.existsSync(MODEL_PATH),
  platform:     process.platform,
  userData:     app.getPath('userData'),
  eventsRoot:   EVENTS_ROOT,
  updateStatus: { ...updateStatus },   // hydrate initial UI state
}));

// ── Auto-update IPC ─────────────────────────────────────────────────────────
ipcMain.handle('check-for-updates', async () => {
  if (!app.isPackaged) {
    // In dev mode return a simulated "not-available" so the UI works
    broadcastUpdateStatus({ state: 'not-available', version: app.getVersion(), progress: null, error: null });
    return { ok: true, dev: true };
  }
  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (err) {
    broadcastUpdateStatus({ state: 'error', error: err?.message || String(err) });
    return { ok: false, error: err?.message };
  }
});

ipcMain.handle('install-update', () => {
  if (updateStatus.state !== 'downloaded') return { ok: false, reason: 'No update downloaded yet' };
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return { ok: true };
});

ipcMain.handle('get-clip-count', () => getActiveEventConfig().clips.length);

// ── Storage metrics ──────────────────────────────────────────────────────────
ipcMain.handle('get-total-storage', () => {
  try {
    const cfg = getActiveEventConfig();
    let totalBytes = 0;
    for (const clip of cfg.clips || []) {
      if (clip.path && fs.existsSync(clip.path)) {
        try { totalBytes += fs.statSync(clip.path).size; } catch (_) {}
      }
    }
    const gb = totalBytes / (1024 ** 3);
    const mb = totalBytes / (1024 ** 2);
    const formatted = gb >= 1
      ? `${gb.toFixed(2)} GB`
      : mb >= 0.1
        ? `${mb.toFixed(1)} MB`
        : `${(totalBytes / 1024).toFixed(0)} KB`;
    return { ok: true, bytes: totalBytes, formatted };
  } catch (err) { return { ok: false, bytes: 0, formatted: '0 KB', error: err.message }; }
});

ipcMain.handle('choose-save-path', async () => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'], title: 'Choose Save Location' });
  if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
  const chosenPath = result.filePaths[0];
  // Persist to active event settings
  const cfg = getActiveEventConfig();
  cfg.settings = { ...(cfg.settings || {}), customSavePath: chosenPath };
  saveActiveEventConfig(cfg);
  return { ok: true, path: chosenPath };
});

ipcMain.handle('get-file-duration', (_, filePath) => new Promise((resolve) => {
  execFile(String(ffmpegPath), ['-i', String(filePath), '-f', 'null', '-'], { timeout: 15000 }, (_, __, stderr) => {
    const m = (stderr || '').match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    resolve(m ? parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]) : 0);
  });
}));
