import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { useOrientation, getPreviewVideoStyle } from '../hooks/useOrientation';

/* ─── Helpers ────────────────────────────────────────────────────────────── */
function pad(n) { return String(n).padStart(2, '0'); }
function formatTime(seconds) { return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`; }

const VOLUME_BAR_COUNT = 16;

/**
 * pickMimeType — returns the best MediaRecorder MIME type this browser supports.
 *
 * Priority order:
 *   1. WebM + VP9 + Opus  (Chromium / Electron — best quality)
 *   2. WebM + VP8 + Opus  (Chromium fallback)
 *   3. WebM               (Chromium basic)
 *   4. MP4 + H.264 + AAC  (Safari / WebKit — required on iOS/macOS Safari)
 *   5. MP4                (Safari basic fallback)
 *   6. ''                 (let the browser choose)
 *
 * Returns a string (possibly '') — pass to `new MediaRecorder(stream, { mimeType })`.
 */
function pickMimeType(isAudioOnly) {
  if (isAudioOnly) {
    const audioCandidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', ''];
    return audioCandidates.find(t => !t || MediaRecorder.isTypeSupported(t)) ?? '';
  }
  const videoCandidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4;codecs=avc1,mp4a.40.2', // Safari / WebKit
    'video/mp4',
    '',
  ];
  return videoCandidates.find(t => !t || MediaRecorder.isTypeSupported(t)) ?? '';
}

/**
 * SUPPORTS_CANVAS_FILTER — true in Chromium, false in Safari < 18.
 * Used to skip the ctx.filter assignment gracefully on WebKit so we don't
 * show the GLAM badge for an effect that has no visible impact.
 */
const SUPPORTS_CANVAS_FILTER = (() => {
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    return ctx != null && typeof ctx.filter === 'string';
  } catch { return false; }
})();


/* ─── Component ──────────────────────────────────────────────────────────── */
export default function RecordScreen({ active, glamMode = false }) {
  const { navigateTo, settings, startRecording } = useApp();

  // ── Phase: 'idle' | 'countdown' | 'recording' | 'finishing'
  const [phase, setPhase]                   = useState('idle');
  const [countdownNum, setCountdownNum]     = useState(3);
  const [countdownAnim, setCountdownAnim]   = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [volumeBars, setVolumeBars]         = useState(Array(VOLUME_BAR_COUNT).fill(0));
  const [devices, setDevices]               = useState({ cameras: [], mics: [] });
  const [selectedCamera, setSelectedCamera] = useState('default');
  const [selectedMic, setSelectedMic]       = useState('default');
  const [mediaError, setMediaError]         = useState(null);
  const [isGlamActive, setIsGlamActive]     = useState(false);
  // Resolve orientation mode + camera mismatch from admin settings
  const { isPortrait, mismatch } = useOrientation(settings);

  const videoRef        = useRef(null);   // preview <video> (camera or canvas)
  const canvasRef       = useRef(null);   // offscreen canvas for glam filter
  const streamRef       = useRef(null);   // raw camera stream
  const canvasStreamRef = useRef(null);   // canvas.captureStream() for GLAM/mismatch
  const glamRafRef      = useRef(null);   // requestAnimationFrame handle for canvas loop
  const recorderRef     = useRef(null);
  const chunksRef       = useRef([]);
  const mimeTypeRef     = useRef('');     // actual MIME type used by this MediaRecorder instance
  const elapsedTimerRef = useRef(null);
  const maxDurTimerRef  = useRef(null);
  const analyserRef     = useRef(null);
  const animFrameRef    = useRef(null);
  const countdownRef    = useRef(null);

  const isAudioOnly      = settings.mode === 'audio';
  const maxDuration      = settings.maxDuration || 120;
  const countdownSeconds = settings.countdownSeconds ?? 3;
  const useGlam = (glamMode || isGlamActive) && settings.enableGlam && !isAudioOnly;
  const remainingSeconds = Math.max(0, maxDuration - elapsedSeconds);

  /* ── Enumerate devices ─────────────────────────────────────────────────── */
  useEffect(() => {
    if (!active) return;
    async function enumerate() {
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ video: !isAudioOnly, audio: true });
        probe.getTracks().forEach(t => t.stop());
        const list    = await navigator.mediaDevices.enumerateDevices();
        const cameras = list.filter(d => d.kind === 'videoinput');
        const mics    = list.filter(d => d.kind === 'audioinput');
        setDevices({ cameras, mics });
      } catch (err) { console.warn('Device enumeration error:', err); }
    }
    enumerate();
  }, [active, isAudioOnly]);

  /* ── Get user media — orientation-aware constraints ────────────────────── */
  const acquireStream = useCallback(async () => {
    setMediaError(null);
    try {
      let videoConstraints;
      if (isAudioOnly) {
        videoConstraints = false;
      } else if (selectedCamera !== 'default') {
        videoConstraints = { deviceId: { exact: selectedCamera } };
      } else {
        // Request dimensions matching the effective orientation.
        // Sideways cameras (rotate90cw/ccw) use landscape constraints — the
        // canvas pipeline handles the rotation, not the hardware constraints.
        const wantPortrait = isPortrait && mismatch !== 'rotate90cw' && mismatch !== 'rotate90ccw';
        videoConstraints = wantPortrait
          ? { width: { ideal: 720  }, height: { ideal: 1280 }, facingMode: 'user' }
          : { width: { ideal: 1280 }, height: { ideal: 720  }, facingMode: 'user' };
      }
      const audioConstraints = selectedMic === 'default'
        ? true
        : { deviceId: { exact: selectedMic } };
      const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: audioConstraints });
      streamRef.current = stream;
      return stream;
    } catch (err) {
      setMediaError(`Could not access camera/microphone: ${err.message}`);
      return null;
    }
  }, [isAudioOnly, isPortrait, mismatch, selectedCamera, selectedMic]);

  /* ── GLAM canvas pipeline ──────────────────────────────────────────────── */
  // Returns Promise<MediaStream>: resolves to canvas-captured stream after
  // loadedmetadata fires and rAF draw loop is queued.
  const startGlamCanvas = useCallback((rawStream) => {
    const canvas = canvasRef.current;
    if (!canvas) return Promise.resolve(rawStream);
    const video = document.createElement('video');
    video.srcObject = rawStream; video.muted = true; video.playsInline = true;
    video.setAttribute('webkit-playsinline', ''); // iOS Safari <10 compat
    return new Promise((resolve) => {
      video.onloadedmetadata = () => {
        canvas.width  = video.videoWidth  || 1280;
        canvas.height = video.videoHeight || 720;
        const ctx = canvas.getContext('2d');
        function drawFrame() {
          if (!canvas || !ctx) return;
          const w = canvas.width, h = canvas.height;
          // SUPPORTS_CANVAS_FILTER: true on Chromium, false on Safari < 18.
          // On unsupported engines draw the raw frame — recording still works,
          // but without colour grading (GLAM badge won't appear, see below).
          if (SUPPORTS_CANVAS_FILTER) {
            ctx.filter = 'contrast(1.06) brightness(1.08) saturate(1.1)';
          }
          ctx.clearRect(0, 0, w, h);
          ctx.drawImage(video, 0, 0, w, h);
          if (SUPPORTS_CANVAS_FILTER) { ctx.filter = 'none'; }
          glamRafRef.current = requestAnimationFrame(drawFrame);
        }
        glamRafRef.current = requestAnimationFrame(drawFrame);

        // captureStream() is supported in Safari 11+, Chromium, Firefox.
        // Guard defensively in case the API is missing.
        if (!canvas.captureStream) { resolve(rawStream); return; }

        const audioTracks = rawStream.getAudioTracks();
        const canvasStream = canvas.captureStream(30);
        audioTracks.forEach(t => canvasStream.addTrack(t));
        canvasStreamRef.current = canvasStream;
        if (videoRef.current) { videoRef.current.srcObject = canvasStream; }
        resolve(canvasStream);
      };
      video.play().catch(() => resolve(rawStream));
    });
  // setIsGlamActive is called by beginCountdown only when SUPPORTS_CANVAS_FILTER is true
  // (guarded there), so the GLAM badge only shows when the filter actually ran.
  }, []);

  const stopGlamCanvas = useCallback(() => {
    if (glamRafRef.current) { cancelAnimationFrame(glamRafRef.current); glamRafRef.current = null; }
    canvasStreamRef.current = null;
  }, []);

  /* ── Mismatch canvas pipeline ───────────────────────────────────────────── */
  // Unified canvas pipeline for ALL portrait-vs-landscape camera mismatches.
  // Every strategy bakes the geometry into the pixel data of a 720×1280 canvas,
  // so the MediaRecorder saves a physically correct portrait WebM — no CSS tricks.
  //
  // Strategy     Canvas draw
  // ──────────── ──────────────────────────────────────────────────────────────
  // rotate90cw   translate(centre) → rotate(+π/2) → drawImage centred
  // rotate90ccw  translate(centre) → rotate(-π/2) → drawImage centred
  // centercrop   scale = max(cw/vw, ch/vh)  — fills portrait space, crops sides
  // letterbox    fill black + scale = min(cw/vw, ch/vh) — fits full frame + bars
  const mismatchCanvasRef = useRef(null);

  const startMismatchCanvas = useCallback((rawStream, strategy) => {
    const canvas = document.createElement('canvas');
    mismatchCanvasRef.current = canvas;

    const video = document.createElement('video');
    video.srcObject = rawStream;
    video.muted = true;
    video.playsInline = true;

    return new Promise((resolve) => {
      video.onloadedmetadata = () => {
        const vw = video.videoWidth  || 1280;
        const vh = video.videoHeight || 720;

        // Portrait output canvas: always swap the landscape dimensions
        const cw = Math.min(vw, vh);  // e.g. 720
        const ch = Math.max(vw, vh);  // e.g. 1280
        canvas.width  = cw;
        canvas.height = ch;

        const ctx = canvas.getContext('2d');

        function drawFrame() {
          if (!ctx) return;

          ctx.clearRect(0, 0, cw, ch);

          if (strategy === 'rotate90cw' || strategy === 'rotate90ccw') {
            // ── Rotation ─────────────────────────────────────────────────────
            // Translate to canvas centre, rotate ±90°, draw source centred.
            const angle = strategy === 'rotate90cw' ? Math.PI / 2 : -Math.PI / 2;
            ctx.save();
            ctx.translate(cw / 2, ch / 2);
            ctx.rotate(angle);
            ctx.drawImage(video, -vw / 2, -vh / 2, vw, vh);
            ctx.restore();

          } else if (strategy === 'centercrop') {
            // ── Center Crop (Cover) ───────────────────────────────────────────
            // Scale so the video FILLS the portrait canvas; left/right overflow
            // is naturally clipped by the canvas bounds (like object-fit:cover).
            const scale = Math.max(cw / vw, ch / vh);
            const dw = vw * scale;
            const dh = vh * scale;
            const dx = (cw - dw) / 2;
            const dy = (ch - dh) / 2;
            ctx.drawImage(video, dx, dy, dw, dh);

          } else {
            // ── Letterbox (Contain) — default ─────────────────────────────────
            // Scale so the entire video frame FITS inside the portrait canvas;
            // fill remaining space above/below with solid black.
            const scale = Math.min(cw / vw, ch / vh);
            const dw = vw * scale;
            const dh = vh * scale;
            const dx = (cw - dw) / 2;
            const dy = (ch - dh) / 2;
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, cw, ch);
            ctx.drawImage(video, dx, dy, dw, dh);
          }

          glamRafRef.current = requestAnimationFrame(drawFrame);
        }

        glamRafRef.current = requestAnimationFrame(drawFrame);

        // captureStream() guard — fall back to rawStream if API is absent
        if (!canvas.captureStream) { resolve(rawStream); return; }

        const audioTracks = rawStream.getAudioTracks();
        const canvasStream = canvas.captureStream(30);
        audioTracks.forEach(t => canvasStream.addTrack(t));
        canvasStreamRef.current = canvasStream;
        if (videoRef.current) { videoRef.current.srcObject = canvasStream; }
        resolve(canvasStream);
      };
      video.play().catch(() => resolve(rawStream));
    });
  }, []);

  const stopMismatchCanvas = useCallback(() => {
    if (glamRafRef.current) { cancelAnimationFrame(glamRafRef.current); glamRafRef.current = null; }
    canvasStreamRef.current = null;
    mismatchCanvasRef.current = null;
  }, []);

  /* ── Volume analyser ───────────────────────────────────────────────────── */
  const startAnalyser = useCallback((stream) => {
    try {
      const ctx      = new AudioContext();
      const source   = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 64;
      source.connect(analyser);
      analyserRef.current = analyser;
      const data = new Uint8Array(analyser.frequencyBinCount);
      function tick() {
        analyser.getByteFrequencyData(data);
        const bars = Array.from({ length: VOLUME_BAR_COUNT }, (_, i) => {
          const idx = Math.floor((i / VOLUME_BAR_COUNT) * data.length);
          return Math.round((data[idx] / 255) * 100);
        });
        setVolumeBars(bars);
        animFrameRef.current = requestAnimationFrame(tick);
      }
      animFrameRef.current = requestAnimationFrame(tick);
    } catch (err) { console.warn('AudioContext error:', err); }
  }, []);

  const stopAnalyser = useCallback(() => {
    if (animFrameRef.current) { cancelAnimationFrame(animFrameRef.current); animFrameRef.current = null; }
    if (analyserRef.current) { try { analyserRef.current.context.close(); } catch (_) {} analyserRef.current = null; }
    setVolumeBars(Array(VOLUME_BAR_COUNT).fill(0));
  }, []);

  /* ── Stop & cleanup stream ─────────────────────────────────────────────── */
  const stopStream = useCallback(() => {
    stopGlamCanvas();
    stopMismatchCanvas();
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
    if (videoRef.current)  { videoRef.current.srcObject = null; }
    stopAnalyser();
  }, [stopAnalyser, stopGlamCanvas, stopMismatchCanvas]);

  /* ── Start countdown then record ───────────────────────────────────────── */
  const beginCountdown = useCallback(async () => {
    const rawStream = await acquireStream();
    if (!rawStream) return;

    // ── Dynamic hardware mismatch detection ─────────────────────────────────
    // Inspect the actual video track dimensions to detect a real camera-vs-UI
    // mismatch, regardless of orientationMode (Auto / Force Portrait / Force Landscape).
    let cameraIsLandscape = false;
    if (!isAudioOnly && isPortrait) {
      const videoTrack = rawStream.getVideoTracks()[0];
      if (videoTrack) {
        const { width: camW = 0, height: camH = 0 } = videoTrack.getSettings();
        cameraIsLandscape = camW > 0 && camW > camH;
      }
    }
    // hasMismatch: UI is portrait but camera hardware delivers landscape frames
    const hasMismatch = isPortrait && cameraIsLandscape;

    // ── Stream routing ───────────────────────────────────────────────────────
    let recordStream = rawStream;
    if (useGlam) {
      recordStream = await startGlamCanvas(rawStream);
      // Only show the GLAM badge if ctx.filter is supported (Chromium / Safari 18+).
      // On Safari < 18 the canvas still records correctly but without the colour grade.
      if (SUPPORTS_CANVAS_FILTER) setIsGlamActive(true);
    } else if (hasMismatch) {
      // ALL mismatch strategies now route through the canvas pipeline so the
      // MediaRecorder saves a physically correct 720×1280 portrait WebM.
      //   letterbox  → black bars baked in above/below landscape frame
      //   centercrop → landscape frame scaled to fill portrait, sides cropped
      //   rotate90cw → landscape frame rotated +90° to fill portrait
      //   rotate90ccw→ landscape frame rotated -90° to fill portrait
      recordStream = await startMismatchCanvas(rawStream, mismatch);
      // startMismatchCanvas sets videoRef.current.srcObject to the canvas stream.
    } else {
      // No mismatch: landscape UI, or portrait UI where camera already delivers
      // portrait frames — show raw stream directly.
      if (videoRef.current && !isAudioOnly) { videoRef.current.srcObject = rawStream; }
    }

    const total = countdownSeconds > 0 ? countdownSeconds : 0;
    if (total <= 0) {
      setPhase('recording');
      startCapture(rawStream, recordStream);
      return;
    }

    setCountdownNum(total);
    setPhase('countdown');
    setCountdownAnim(false);
    let remaining = total;

    function tick() {
      setCountdownNum(remaining);
      setCountdownAnim(false);
      requestAnimationFrame(() => requestAnimationFrame(() => setCountdownAnim(true)));
      if (remaining <= 1) {
        countdownRef.current = setTimeout(() => {
          setPhase('recording');
          startCapture(rawStream, recordStream);
        }, 900);
      } else {
        remaining -= 1;
        countdownRef.current = setTimeout(tick, 1000);
      }
    }
    tick();
  }, [acquireStream, countdownSeconds, useGlam, startGlamCanvas, isPortrait, mismatch, startMismatchCanvas, isAudioOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Actual MediaRecorder capture ──────────────────────────────────────── */
  function startCapture(rawStream, recordStream) {
    chunksRef.current = [];
    mimeTypeRef.current = '';
    // Use raw stream for analyser (it has the raw audio data)
    startAnalyser(rawStream);

    const streamToRecord = recordStream || rawStream;

    // pickMimeType() probes candidates in priority order:
    //   WebM+VP9 / WebM+VP8 / WebM (Chromium/Electron)
    //   MP4+H.264+AAC / MP4          (Safari / WebKit)
    const preferredMime = pickMimeType(isAudioOnly);
    const recorderOptions = preferredMime ? { mimeType: preferredMime } : {};
    const recorder = new MediaRecorder(streamToRecord, recorderOptions);
    recorderRef.current = recorder;

    // Capture the actual MIME type the recorder is using (may differ from preferred)
    mimeTypeRef.current = recorder.mimeType || preferredMime;

    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
    recorder.start(250);

    setElapsedSeconds(0);
    elapsedTimerRef.current = setInterval(() => setElapsedSeconds(s => s + 1), 1000);
    maxDurTimerRef.current  = setTimeout(() => finishRecording(), maxDuration * 1000);
  }

  /* ── Finish recording ──────────────────────────────────────────────────── */
  const finishRecording = useCallback(() => {
    setPhase('finishing');
    clearInterval(elapsedTimerRef.current);
    clearTimeout(maxDurTimerRef.current);
    stopAnalyser();
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') { stopStream(); navigateTo('review'); return; }
    recorder.onstop = () => {
      // Use the actual MIME type recorded (video/webm on Chromium, video/mp4 on Safari).
      // This ensures the Blob's Content-Type matches the container bytes.
      const blobType = mimeTypeRef.current
        || (isAudioOnly ? 'audio/webm' : 'video/webm'); // final fallback
      const blob = new Blob(chunksRef.current, { type: blobType });
      startRecording(blob);
      stopStream();
      navigateTo('review');
    };
    recorder.stop();
  }, [isAudioOnly, navigateTo, startRecording, stopAnalyser, stopStream]);

  /* ── Activate / deactivate lifecycle ───────────────────────────────────── */
  useEffect(() => {
    if (!active) {
      clearTimeout(countdownRef.current);
      clearInterval(elapsedTimerRef.current);
      clearTimeout(maxDurTimerRef.current);
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        try { recorderRef.current.stop(); } catch (_) {}
      }
      recorderRef.current = null;
      chunksRef.current   = [];
      stopStream();
      setPhase('idle');
      setElapsedSeconds(0);
      setIsGlamActive(false);
      setCountdownNum(countdownSeconds > 0 ? countdownSeconds : 3);
      setMediaError(null);
      return;
    }
    beginCountdown();
    return () => {
      clearTimeout(countdownRef.current);
      clearInterval(elapsedTimerRef.current);
      clearTimeout(maxDurTimerRef.current);
      stopStream();
    };
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Auto-stop at max duration ─────────────────────────────────────────── */
  useEffect(() => {
    if (phase === 'recording' && elapsedSeconds >= maxDuration) finishRecording();
  }, [elapsedSeconds, maxDuration, phase, finishRecording]);

  /* ─────────────────────── Render ─────────────────────────────────────── */
  return (
    <>
      <style>{`
        .record-root {
          position: absolute; inset: 0; width: 100%; height: 100%;
          background: #000; display: flex; flex-direction: column;
          align-items: center; justify-content: center;
          opacity: 0; pointer-events: none;
          transition: opacity 600ms var(--ease-out);
          z-index: var(--z-base); overflow: hidden;
        }
        .record-root.active { opacity: 1; pointer-events: all; z-index: 10; }

        /* Camera preview / canvas preview */
        .record-video {
          position: absolute; inset: 0; width: 100%; height: 100%;
          /* contain: always shows the full frame — no stretch, no crop.
             Black bars fill any leftover space when the camera aspect ratio
             doesn't match the screen (e.g. 16:9 camera on a portrait screen
             or a 9:16 canvas stream on a landscape screen). */
          object-fit: contain; background: #000; z-index: 0;
        }
        /* Glam canvas (hidden — we show canvas stream via <video>) */
        .record-glam-canvas { display: none; }
        /* Glam badge */
        .record-glam-badge {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 5px 14px;
          background: linear-gradient(135deg, #f472b6, #c026d3, #7c3aed);
          border-radius: var(--radius-full);
          font-size: 0.78rem; font-weight: 800;
          letter-spacing: 0.14em; text-transform: uppercase; color: #fff;
          box-shadow: 0 0 20px rgba(244,114,182,0.6);
          animation: glamPulse 2s ease-in-out infinite;
        }
        @keyframes glamPulse {
          0%,100% { box-shadow: 0 0 16px rgba(244,114,182,0.5); }
          50%      { box-shadow: 0 0 32px rgba(244,114,182,0.9); }
        }
        .record-video-overlay {
          position: absolute; inset: 0;
          background: linear-gradient(to bottom, rgba(7,7,26,0.30) 0%, transparent 30%,
            transparent 60%, rgba(7,7,26,0.60) 100%);
          z-index: 1; pointer-events: none;
        }
        .record-audio-bg {
          position: absolute; inset: 0;
          background: radial-gradient(ellipse at 30% 40%, rgba(139,92,246,0.20) 0%, transparent 55%),
            radial-gradient(ellipse at 70% 60%, rgba(45,212,191,0.14) 0%, transparent 55%),
            var(--bg-primary);
          z-index: 0;
        }

        /* Top HUD */
        .record-top-hud {
          position: absolute; top: 0; left: 0; right: 0; z-index: 5;
          display: flex; align-items: center; justify-content: space-between;
          padding: 24px 32px 0;
        }
        .record-rec-badge {
          display: flex; align-items: center; gap: 8px;
          padding: 8px 18px;
          background: rgba(244,63,94,0.15); border: 1px solid rgba(244,63,94,0.40);
          border-radius: var(--radius-full); backdrop-filter: blur(12px);
          font-size: 0.85rem; font-weight: 700; letter-spacing: 0.1em;
          color: var(--rose-400); text-transform: uppercase;
        }
        .record-rec-dot {
          width: 9px; height: 9px; border-radius: 50%;
          background: var(--rose-500); box-shadow: 0 0 10px rgba(244,63,94,0.9);
          animation: recDotPulse 1.2s ease-in-out infinite;
        }
        @keyframes recDotPulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%       { opacity: 0.3; transform: scale(0.75); }
        }

        /* Countdown timer display — centered, large, bottom-center */
        .record-countdown-timer {
          position: absolute;
          bottom: 160px;
          left: 50%;
          transform: translateX(-50%);
          z-index: 6;
          font-size: clamp(3.5rem, 10vw, 6rem);
          font-weight: 800;
          font-variant-numeric: tabular-nums;
          letter-spacing: 0.04em;
          color: #fff;
          text-shadow: 0 2px 24px rgba(0,0,0,0.6);
          background: rgba(7,7,26,0.45);
          border: 1px solid rgba(255,255,255,0.15);
          border-radius: var(--radius-full);
          padding: 16px 40px;
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          white-space: nowrap;
          transition: color 0.5s;
        }
        .record-countdown-timer.warn {
          color: var(--rose-400);
          animation: timerWarn 1s ease-in-out infinite;
          border-color: rgba(244,63,94,0.4);
          background: rgba(30,5,10,0.55);
        }
        @keyframes timerWarn { 0%,100% { opacity: 1; } 50% { opacity: 0.55; } }

        /* Volume meter */
        .record-volume {
          position: absolute; right: 28px; top: 50%; transform: translateY(-50%);
          z-index: 5; display: flex; flex-direction: column-reverse; align-items: center;
          gap: 3px; padding: 14px 10px;
          background: var(--glass-sm); border: 1px solid var(--glass-border);
          border-radius: var(--radius-md); backdrop-filter: blur(16px);
        }
        .record-vol-bar {
          width: 6px; border-radius: 3px; min-height: 4px;
          transition: height 80ms ease, background 80ms ease; background: var(--purple-500);
        }

        /* Audio-only mic */
        .record-mic-wrap { position: relative; z-index: 3; display: flex; flex-direction: column; align-items: center; gap: 24px; margin-bottom: 60px; }
        .record-mic-outer { position: relative; width: 180px; height: 180px; display: flex; align-items: center; justify-content: center; }
        .record-mic-ring { position: absolute; inset: 0; border-radius: 50%; border: 2px solid rgba(139,92,246,0.50); animation: micRing 2s ease-out infinite; }
        .record-mic-ring:nth-child(2) { inset: -16px; border-color: rgba(139,92,246,0.30); animation-delay: 0.5s; }
        .record-mic-ring:nth-child(3) { inset: -32px; border-color: rgba(139,92,246,0.15); animation-delay: 1s; }
        @keyframes micRing { 0% { opacity: 0.9; transform: scale(1); } 100% { opacity: 0; transform: scale(1.5); } }
        .record-mic-circle {
          width: 140px; height: 140px; border-radius: 50%;
          background: linear-gradient(135deg, var(--purple-600), var(--purple-500));
          display: flex; align-items: center; justify-content: center; font-size: 4rem;
          box-shadow: 0 0 48px rgba(139,92,246,0.6), 0 0 80px rgba(139,92,246,0.3);
          animation: micCirclePulse 1.5s ease-in-out infinite; z-index: 1;
        }
        @keyframes micCirclePulse {
          0%,100% { transform: scale(1); box-shadow: 0 0 40px rgba(139,92,246,0.55); }
          50%      { transform: scale(1.06); box-shadow: 0 0 70px rgba(139,92,246,0.85); }
        }
        .record-mic-label { font-size: 1.3rem; font-weight: 600; color: var(--text-primary); letter-spacing: 0.04em; }
        .record-mic-sublabel { font-size: 0.95rem; color: var(--text-secondary); margin-top: -14px; }

        /* Countdown overlay (pre-recording) */
        .record-countdown {
          position: absolute; inset: 0; z-index: 20;
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          background: rgba(7,7,26,0.75); backdrop-filter: blur(8px);
        }
        .record-countdown-num {
          font-size: clamp(10rem, 22vw, 18rem); font-weight: 800; line-height: 1;
          background: linear-gradient(135deg, #c4b5fd, #8b5cf6, #2dd4bf);
          -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
          filter: drop-shadow(0 0 48px rgba(139,92,246,0.6));
          opacity: 0; transform: scale(1.6);
          transition: opacity 180ms ease, transform 180ms var(--ease-out);
        }
        .record-countdown-num.anim { opacity: 1; transform: scale(1); }
        .record-countdown-label { font-size: 1.4rem; font-weight: 500; color: var(--text-secondary); letter-spacing: 0.1em; text-transform: uppercase; margin-top: 20px; }

        /* Bottom bar */
        .record-bottom {
          position: absolute; bottom: 0; left: 0; right: 0; z-index: 6;
          display: flex; flex-direction: column; align-items: center;
          gap: 16px; padding: 0 40px 40px;
        }
        .record-progress-wrap { width: 100%; max-width: 500px; }
        .record-progress-track { width: 100%; height: 4px; background: var(--glass-md); border-radius: var(--radius-full); overflow: hidden; }
        .record-progress-fill { height: 100%; background: linear-gradient(90deg, var(--purple-500), var(--teal-400)); border-radius: var(--radius-full); transition: width 1s linear; }
        .record-progress-label { display: flex; justify-content: space-between; font-size: 0.78rem; font-weight: 500; color: var(--text-muted); margin-top: 6px; }
        .record-finish-btn {
          display: inline-flex; align-items: center; justify-content: center; gap: 14px;
          padding: 22px 64px; font-family: 'Outfit', sans-serif;
          font-size: clamp(1.1rem, 2.2vw, 1.4rem); font-weight: 700; letter-spacing: 0.04em;
          color: #fff; background: linear-gradient(135deg, var(--rose-500), #c2136d);
          border: none; border-radius: var(--radius-full); cursor: pointer; outline: none;
          box-shadow: 0 4px 32px rgba(244,63,94,0.5);
          transition: transform 150ms var(--ease-spring), box-shadow 200ms; white-space: nowrap;
        }
        .record-finish-btn:hover  { transform: translateY(-3px) scale(1.02); box-shadow: 0 8px 48px rgba(244,63,94,0.7); }
        .record-finish-btn:active { transform: scale(0.96); }

        /* Finishing spinner */
        .record-finishing {
          position: absolute; inset: 0; z-index: 25; display: flex; flex-direction: column;
          align-items: center; justify-content: center; gap: 24px;
          background: rgba(7,7,26,0.85); backdrop-filter: blur(12px);
        }
        .record-finishing-spinner {
          width: 64px; height: 64px; border: 4px solid var(--glass-border);
          border-top-color: var(--purple-500); border-radius: 50%;
          animation: recordSpin 0.8s linear infinite;
        }
        @keyframes recordSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .record-finishing-label { font-size: 1.2rem; font-weight: 500; color: var(--text-secondary); letter-spacing: 0.06em; }

        /* Error */
        .record-error { position: absolute; inset: 0; z-index: 30; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 20px; padding: 40px; }
        .record-error-card { background: var(--glass-sm); border: 1px solid rgba(244,63,94,0.3); border-radius: var(--radius-lg); backdrop-filter: blur(24px); padding: 40px 48px; max-width: 520px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 16px; }
        .record-error-icon { font-size: 3rem; }
        .record-error-title { font-size: 1.5rem; font-weight: 700; color: var(--rose-400); }
        .record-error-msg { font-size: 1rem; color: var(--text-secondary); line-height: 1.5; }
        .record-error-back { display: inline-flex; align-items: center; gap: 8px; padding: 14px 36px; font-family: 'Outfit', sans-serif; font-size: 1rem; font-weight: 600; color: var(--text-primary); background: var(--glass-md); border: 1px solid var(--glass-border-bright); border-radius: var(--radius-full); cursor: pointer; outline: none; transition: background 200ms; margin-top: 8px; }
        .record-error-back:hover { background: var(--glass-lg); }
      `}</style>

      {/* Hidden canvas used for GLAM filter pipeline */}
      <canvas ref={canvasRef} className="record-glam-canvas" />

      <div className={`record-root${active ? ' active' : ''}`}>
        {/* ── Background ── */}
        {isAudioOnly ? (
          <div className="record-audio-bg" />
        ) : (
          <>
            {/* Video preview — canvas stream (or raw stream) fills the container */}
            <video
              ref={videoRef}
              className="record-video"
              autoPlay muted playsInline
              // eslint-disable-next-line react/no-unknown-property
              webkitPlaysInline={true}
              style={getPreviewVideoStyle(isPortrait, mismatch)}
            />
            <div className="record-video-overlay" />
          </>
        )}

        {/* ── Top HUD (recording only) ── */}
        {phase === 'recording' && (
          <div className="record-top-hud">
            <div className="record-rec-badge">
              <div className="record-rec-dot" />
              REC
            </div>
            {/* GLAM badge */}
            {isGlamActive && (
              <div className="record-glam-badge">✨ GLAM</div>
            )}
          </div>
        )}

        {/* ── Countdown Timer — dynamic position based on orientation ── */}
        {phase === 'recording' && (
          <div
            className={`record-countdown-timer${remainingSeconds <= 10 ? ' warn' : ''}`}
            style={!isPortrait ? { bottom: 40, right: 40, left: 'auto', transform: 'none' } : {}}
          >
            {formatTime(remainingSeconds)}
          </div>
        )}

        {/* ── Tap-to-stop invisible overlay (whole screen) ── */}
        {phase === 'recording' && (
          <div
            onClick={finishRecording}
            style={{
              position: 'absolute', inset: 0, zIndex: 4,
              cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
            }}
            aria-label="Tap to stop recording"
          />
        )}

        {/* ── "Tap to stop" hint label ── */}
        {phase === 'recording' && (
          <div style={{
            position: 'absolute', bottom: !isPortrait ? 44 : 110, left: '50%',
            transform: 'translateX(-50%)', zIndex: 7,
            fontSize: '0.85rem', fontWeight: 600, letterSpacing: '0.08em',
            color: 'rgba(255,255,255,0.55)', textTransform: 'uppercase',
            pointerEvents: 'none', whiteSpace: 'nowrap',
          }}>
            Tap anywhere to stop recording
          </div>
        )}

        {/* ── Volume meter (recording only) ── */}
        {phase === 'recording' && (
          <div className="record-volume" aria-hidden="true">
            {volumeBars.map((pct, i) => {
              const height = Math.max(4, Math.round(pct * 0.60));
              const color  = pct > 80 ? 'var(--rose-500)' : pct > 50 ? 'var(--teal-400)' : 'var(--purple-500)';
              return <div key={i} className="record-vol-bar" style={{ height: `${height}px`, background: color }} />;
            })}
          </div>
        )}

        {/* ── Audio-only mic display ── */}
        {isAudioOnly && (phase === 'recording' || phase === 'countdown') && (
          <div className="record-mic-wrap">
            <div className="record-mic-outer">
              <div className="record-mic-ring" /><div className="record-mic-ring" /><div className="record-mic-ring" />
              <div className="record-mic-circle">🎙️</div>
            </div>
            <div className="record-mic-label">Recording Audio</div>
            {phase === 'recording' && (
              <div className="record-mic-sublabel">{formatTime(remainingSeconds)} remaining</div>
            )}
          </div>
        )}

        {/* ── Bottom bar (recording only) ── */}
        {phase === 'recording' && (
          <div className="record-bottom" style={{ pointerEvents: 'none', zIndex: 8 }}>
            <div className="record-progress-wrap">
              <div className="record-progress-track">
                <div className="record-progress-fill" style={{ width: `${Math.min(100, (elapsedSeconds / maxDuration) * 100)}%` }} />
              </div>
              <div className="record-progress-label">
                <span>{formatTime(elapsedSeconds)} elapsed</span>
                <span>max {formatTime(maxDuration)}</span>
              </div>
            </div>
            <button className="record-finish-btn" style={{ pointerEvents: 'all' }} onClick={finishRecording}>
              ✓&nbsp;&nbsp;Finish Recording
            </button>
          </div>
        )}

        {/* ── Countdown overlay ── */}
        {phase === 'countdown' && (
          <div className="record-countdown">
            <div className={`record-countdown-num${countdownAnim ? ' anim' : ''}`}>{countdownNum}</div>
            <div className="record-countdown-label">Get ready…</div>
          </div>
        )}

        {/* ── Finishing spinner overlay ── */}
        {phase === 'finishing' && (
          <div className="record-finishing">
            <div className="record-finishing-spinner" />
            <div className="record-finishing-label">Saving your message…</div>
          </div>
        )}

        {/* ── Error overlay ── */}
        {mediaError && phase !== 'finishing' && (
          <div className="record-error">
            <div className="record-error-card">
              <div className="record-error-icon">⚠️</div>
              <div className="record-error-title">Camera Unavailable</div>
              <div className="record-error-msg">{mediaError}</div>
              <button className="record-error-back" onClick={() => navigateTo('attract')}>← Go Back</button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
