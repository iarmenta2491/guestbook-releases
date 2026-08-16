/**
 * electron/preload.js — Context Bridge
 */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('guestbook', {
  // ── Settings ──────────────────────────────────────────────────────────
  getSettings:  () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // ── Recordings ────────────────────────────────────────────────────────
  saveRecording: (buffer, filename) =>
    ipcRenderer.invoke('save-recording', { buffer, filename }),

  // ── Clips ─────────────────────────────────────────────────────────────
  getClips:       () => ipcRenderer.invoke('get-clips'),
  deleteClip:     (clipId) => ipcRenderer.invoke('delete-clip', clipId),
  deleteAllClips: () => ipcRenderer.invoke('delete-all-clips'),
  reorderClips:   (orderedIds) => ipcRenderer.invoke('reorder-clips', orderedIds),
  updateClip:     (clipId, updates) => ipcRenderer.invoke('update-clip', { clipId, updates }),

  // ── AI Pipeline ───────────────────────────────────────────────────────
  transcribeClip: (clipId) => ipcRenderer.invoke('transcribe-clip', { clipId }),

  // ── Compilation ───────────────────────────────────────────────────────
  stitchClips: (clipIds, transitions, outputPath, options) =>
    ipcRenderer.invoke('stitch-clips', { clipIds, transitions, outputPath, options }),
  openSaveDialog:      (defaultName) => ipcRenderer.invoke('open-save-dialog', { defaultName }),
  chooseMusicFile:     () => ipcRenderer.invoke('choose-music-file'),
  importExternalMedia: () => ipcRenderer.invoke('import-external-media'),

  // ── Sharing ───────────────────────────────────────────────────────────
  startShareServer: (clipPath) => ipcRenderer.invoke('start-share-server', { clipPath }),
  stopShareServer:  () => ipcRenderer.invoke('stop-share-server'),
  getTunnelStatus:  () => ipcRenderer.invoke('get-tunnel-status'),
  onNgrokStatus: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('ngrok-status', handler);
    return () => ipcRenderer.removeListener('ngrok-status', handler);
  },

  // ── File System ───────────────────────────────────────────────────────
  openClipsFolder: () => ipcRenderer.invoke('open-clips-folder'),
  chooseFolder:    () => ipcRenderer.invoke('choose-folder'),
  chooseMediaFile: (types) => ipcRenderer.invoke('choose-media-file', { types }),

  // ── System ────────────────────────────────────────────────────────────
  getAppInfo:      () => ipcRenderer.invoke('get-app-info'),
  getClipCount:    () => ipcRenderer.invoke('get-clip-count'),
  getFileDuration: (filePath) => ipcRenderer.invoke('get-file-duration', filePath),

  // ── Event Management (NEW) ────────────────────────────────────────────
  /** Returns { events, activeEventId, activeConfig: {settings, clips} } */
  getEvents:       ()                              => ipcRenderer.invoke('get-events'),
  /** { name, date, cloneSettings } → { ok, event, settings, clips } */
  createEvent:     (payload)                       => ipcRenderer.invoke('create-event', payload),
  /** { eventId } → { ok, event, settings, clips } */
  activateEvent:   (eventId)                       => ipcRenderer.invoke('activate-event', { eventId }),
  /** { eventId } → { ok } */
  deleteEvent:     (eventId)                       => ipcRenderer.invoke('delete-event', { eventId }),
  /** { eventId } → opens folder in Explorer */
  openEventFolder: (eventId)                       => ipcRenderer.invoke('open-event-folder', { eventId }),

  // ── IPC Event Listeners ───────────────────────────────────────────────
  onStitchProgress: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('stitch-progress', handler);
    return () => ipcRenderer.removeListener('stitch-progress', handler);
  },
  onTranscriptionDone: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('transcription-done', handler);
    return () => ipcRenderer.removeListener('transcription-done', handler);
  },
  onOpenAdmin: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('open-admin', handler);
    return () => ipcRenderer.removeListener('open-admin', handler);
  },

  // ── Storage ──────────────────────────────────────────────────────────────
  getTotalStorage: () => ipcRenderer.invoke('get-total-storage'),
  chooseSavePath:  () => ipcRenderer.invoke('choose-save-path'),

  // ── Auto-updater ──────────────────────────────────────────────────────────
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  installUpdate:   () => ipcRenderer.invoke('install-update'),
  onUpdateStatus:  (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('update-status', handler);
    return () => ipcRenderer.removeListener('update-status', handler);
  },
});
