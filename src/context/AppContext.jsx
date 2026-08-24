import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { isElectron, isCapacitor, isMobile, hasFFmpeg, hasTranscription } from '../services/platform';
import capacitorBridge from '../services/capacitorBridge';

const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);

/** Returns the platform-appropriate API bridge */
function getBridge() {
  if (isElectron()) return window.guestbook;
  if (isCapacitor()) return capacitorBridge;
  return null;
}
// ── Default settings ─────────────────────────────────────────────────────
export const DEFAULT_SETTINGS = {
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
    color:            '#ffffff',
    rainbowAnimation: false,
    fontSize:         18,
    boxWidth:         80,
    bold:             false,
    fontFamily:       'default',
  },
  tapCtaText:   'Tap anywhere to leave a message',
  customSavePath: '',
  titleStyling: {
    fontFamily:   'default',
    fontSize:     56,
    color:        '#ffffff',
    colorAnimate: false,
    textAnimate:  false,
  },
  // Orientation / camera geometry
  orientationMode: 'auto',      // 'auto' | 'landscape' | 'portrait'
  cameraMismatch:  'letterbox', // 'letterbox' | 'centercrop' | 'rotate90cw' | 'rotate90ccw'
};

// ── Provider ─────────────────────────────────────────────────────────────
export function AppProvider({ children }) {
  const [screen,        setScreen]        = useState('attract');
  const [glamMode,       setGlamMode]       = useState(false);
  const [settings,      setSettings]      = useState(DEFAULT_SETTINGS);
  const [clips,         setClips]         = useState([]);
  const [events,        setEvents]        = useState([]);        // event registry
  const [activeEventId, setActiveEventId] = useState(null);      // active event id
  const [session, setSession] = useState({
    recordingBlob: null,
    recordingUrl:  null,
    savedClipPath: null,
    savedClipId:   null,
    shareUrl:      null,
    guestNumber:   1,
  });

  // ── Load everything on mount ──────────────────────────────────────────
  useEffect(() => {
    async function load() {
      const bridge = getBridge();
      if (!bridge) return;
      try {
        // Load event registry + active event config in one call
        const res = await bridge.getEvents();
        if (res) {
          setEvents(res.events || []);
          setActiveEventId(res.activeEventId || null);
          if (res.activeConfig) {
            if (res.activeConfig.settings) setSettings({ ...DEFAULT_SETTINGS, ...res.activeConfig.settings });
            if (res.activeConfig.clips)    setClips(res.activeConfig.clips);
          }
        }
      } catch (e) {
        // Fallback: load settings + clips individually (legacy path)
        console.warn('getEvents failed, falling back to legacy load:', e);
        try { const s = await bridge.getSettings(); if (s) setSettings({ ...DEFAULT_SETTINGS, ...s }); } catch (_) {}
        try { const c = await bridge.getClips();    if (c) setClips(c); }                                catch (_) {}
      }
    }
    load();
  }, []);

  // ── Ctrl+Shift+A → admin shortcut ──────────────────────────────────
  useEffect(() => {
    const bridge = getBridge();
    if (!bridge) return;
    const unsub = bridge.onOpenAdmin(() => {
      if (screen !== 'admin') navigateTo('admin');
    });
    return unsub;
  }, [screen]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Navigation ───────────────────────────────────────────────────────
  const navigateTo = useCallback((newScreen) => { setGlamMode(false); setScreen(newScreen); }, []);
  const navigateGlam = useCallback(() => { setGlamMode(true); setScreen('record'); }, []);

  // ── Reload all React state from a newly-activated event ──────────────
  /**
   * Called by EventModal after activateEvent or createEvent succeeds.
   * Accepts the IPC response payload directly: { event, settings, clips, events? }
   */
  const reloadFromEvent = useCallback(({ event, settings: newSettings, clips: newClips, events: newEvents } = {}) => {
    if (newSettings) setSettings({ ...DEFAULT_SETTINGS, ...newSettings });
    if (newClips)    setClips(newClips);
    if (event)       setActiveEventId(event.id);
    // Re-fetch the full annotated event list (clip counts may have changed)
    const bridge = getBridge();
    if (bridge) {
      bridge.getEvents().then(res => {
        if (res) {
          setEvents(res.events || []);
          setActiveEventId(res.activeEventId || null);
        }
      }).catch(() => {});
    }
  }, []);

  // ── Session management ───────────────────────────────────────────────
  const resetSession = useCallback(() => {
    setSession(prev => {
      if (prev.recordingUrl) URL.revokeObjectURL(prev.recordingUrl);
      return { recordingBlob: null, recordingUrl: null, savedClipPath: null, savedClipId: null, shareUrl: null, guestNumber: prev.guestNumber };
    });
  }, []);

  const startRecording = useCallback((blob) => {
    const url = URL.createObjectURL(blob);
    setSession(prev => ({ ...prev, recordingBlob: blob, recordingUrl: url }));
  }, []);

  const saveRecording = useCallback(async () => {
    if (!session.recordingBlob) return null;
    try {
      const buf      = await session.recordingBlob.arrayBuffer();
      const now      = new Date();
      const dateStr  = now.toISOString().slice(0, 10);
      const timeStr  = now.toTimeString().slice(0, 8).replace(/:/g, '-');
      const eventSlug = (settings.eventName || 'GuestBook').replace(/\s+/g, '_').slice(0, 20);
      // Derive the file extension from the Blob's actual MIME type:
      //   video/webm → .webm  (Chromium / Electron)
      //   video/mp4  → .mp4   (Safari / WebKit)
      //   audio/*    → same logic but for audio
      const blobMime = session.recordingBlob.type || '';
      const ext      = blobMime.includes('mp4') ? 'mp4' : 'webm';
      const filename = `${eventSlug}_${dateStr}_${timeStr}_G${session.guestNumber}.${ext}`;

      // Note: settings no longer sent — main.js reads them from the active event config
      const bridge = getBridge();
      const result = await bridge?.saveRecording(buf, filename);
      if (result?.ok) {
        setSession(prev => ({ ...prev, savedClipPath: result.path, savedClipId: result.clipId }));
        setSession(prev => ({ ...prev, guestNumber: prev.guestNumber + 1 }));
        if (result.clipId && settings.enableTranscription !== false) {
          setTimeout(() => bridge?.transcribeClip(result.clipId).catch(() => {}), 1000);
        }
        return result;
      }
    } catch (e) { console.error('Save failed:', e); }
    return null;
  }, [session.recordingBlob, session.guestNumber, settings]);

  const refreshClips = useCallback(async () => {
    const bridge = getBridge();
    if (bridge) {
      const c = await bridge.getClips();
      setClips(c || []);
    }
  }, []);

  const updateSettings = useCallback(async (newSettings) => {
    const merged = { ...settings, ...newSettings };
    setSettings(merged);
    const bridge = getBridge();
    if (bridge) await bridge.saveSettings(merged);
  }, [settings]);

  return (
    <AppContext.Provider value={{
      screen,       navigateTo, navigateGlam,
      glamMode,
      settings,     updateSettings,
      clips,        setClips,       refreshClips,
      events,       setEvents,
      activeEventId, setActiveEventId,
      reloadFromEvent,
      session,      setSession,
      startRecording, saveRecording, resetSession,
      isElectron, isCapacitor, isMobile, hasFFmpeg, hasTranscription,
    }}>
      {children}
    </AppContext.Provider>
  );
}
