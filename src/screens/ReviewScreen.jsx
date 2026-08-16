import React, { useEffect, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import '../styles/ReviewScreen.css';

/**
 * ReviewScreen — Shows the recording (or a static state indicator when replay
 * is disabled) TOGETHER with the Re-Do / Cancel / Complete buttons on the
 * same screen at all times.  There is no separate "preview" phase that hides
 * the action buttons.
 *
 * Phases: 'ready' | 'saving'
 */
export default function ReviewScreen({ active }) {
  const { session, settings, navigateTo, resetSession, saveRecording } = useApp();

  const [phase, setPhase]       = useState('ready');
  const [saveError, setSaveError] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);

  const videoRef = useRef(null);

  const isAudioOnly  = settings.mode === 'audio';
  const replayEnabled = settings.enableReplay && !!session.recordingUrl;

  /* ── Activate / Deactivate lifecycle ─────────────────────────────────── */
  useEffect(() => {
    if (!active) {
      // Stop any playback when screen goes inactive
      if (videoRef.current) {
        try { videoRef.current.pause(); videoRef.current.currentTime = 0; } catch (_) {}
      }
      setPhase('ready');
      setSaveError(null);
      setIsPlaying(false);
      return;
    }

    // Screen became active — reset to ready state
    setPhase('ready');
    setSaveError(null);
    setIsPlaying(false);

    // Auto-play replay if enabled (small delay for fade-in animation)
    if (replayEnabled) {
      const t = setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.currentTime = 0;
          videoRef.current.play()
            .then(() => setIsPlaying(true))
            .catch(() => setIsPlaying(false));
        }
      }, 500);
      return () => clearTimeout(t);
    }
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Button handlers ──────────────────────────────────────────────────── */
  const handleRedo = () => {
    resetSession();
    navigateTo('record');
  };

  const handleCancel = () => {
    resetSession();
    navigateTo('attract');
  };

  const handleComplete = async () => {
    if (phase === 'saving') return;
    setPhase('saving');
    setSaveError(null);
    try {
      const result = await saveRecording();
      if (!result) throw new Error('Save returned null');
      if (settings.enableQR || settings.enableEmail) {
        navigateTo('share');
      } else {
        navigateTo('thankyou');
      }
    } catch (err) {
      console.error('Save error:', err);
      setSaveError('Could not save recording. Please try again.');
      setPhase('ready');
    }
  };

  const handleVideoEnded = () => setIsPlaying(false);

  const handleTogglePlay = () => {
    if (!videoRef.current) return;
    if (isPlaying) {
      videoRef.current.pause();
      setIsPlaying(false);
    } else {
      videoRef.current.currentTime = 0;
      videoRef.current.play().then(() => setIsPlaying(true)).catch(() => {});
    }
  };

  /* ── Render ───────────────────────────────────────────────────────────── */
  return (
    <div className={`screen review-screen${active ? ' active' : ''}`}>
      {/* Decorative background */}
      <div className="review-bg" />

      {/* ── Main layout: media top, buttons bottom ─────────────────────── */}
      <div className="review-layout">

        {/* ── Top: Media area ─────────────────────────────────────────── */}
        <div className="review-media-area">
          {replayEnabled ? (
            /* ── REPLAY ENABLED: embedded player ──────────────────────── */
            isAudioOnly ? (
              <div className="review-audio-card glass-card-bright">
                <div className="review-audio-icon">🎙️</div>
                <p className="review-audio-label">
                  {isPlaying ? 'Playing your recording…' : 'Your recording is ready'}
                </p>
                <audio
                  ref={videoRef}
                  src={session.recordingUrl}
                  onEnded={handleVideoEnded}
                  style={{ display: 'none' }}
                />
                <div className={`review-audio-wave${isPlaying ? ' playing' : ''}`}>
                  {Array.from({ length: 24 }).map((_, i) => (
                    <div
                      key={i}
                      className="review-audio-bar"
                      style={{ animationDelay: `${i * 0.06}s` }}
                    />
                  ))}
                </div>
                <button className="review-replay-btn" onClick={handleTogglePlay}>
                  {isPlaying ? '⏸ Pause' : '▶ Replay'}
                </button>
              </div>
            ) : (
              <div className="review-video-card">
                <video
                  ref={videoRef}
                  className="review-video"
                  src={session.recordingUrl}
                  onEnded={handleVideoEnded}
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  playsInline
                />
                {/* Play/pause overlay tap target */}
                <button
                  className="review-video-overlay-btn"
                  onClick={handleTogglePlay}
                  aria-label={isPlaying ? 'Pause' : 'Play'}
                >
                  {!isPlaying && (
                    <div className="review-play-icon">▶</div>
                  )}
                </button>
                {/* Recording label badge */}
                <div className="review-vid-badge">Your Recording</div>
              </div>
            )
          ) : (
            /* ── REPLAY DISABLED: static "ready" indicator ─────────────── */
            <div className="review-static-card glass-card-bright">
              <div className="review-static-icon">
                {isAudioOnly ? '🎙️' : '🎬'}
              </div>
              <p className="review-static-title">Recording Complete!</p>
              <p className="review-static-sub">
                Tap <strong>Complete</strong> to save your message, or{' '}
                <strong>Re-Do</strong> to record again.
              </p>
            </div>
          )}
        </div>

        {/* ── Bottom: Action buttons — always visible ──────────────────── */}
        <div className="review-actions-area">
          {saveError && (
            <p className="review-error animate-fadeIn">{saveError}</p>
          )}

          {phase === 'saving' ? (
            <div className="review-saving">
              <div className="spinner" />
              <p className="review-saving-text">Processing your video&hellip;</p>
              <p style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.45)', marginTop: 8, textAlign: 'center' }}>
                Optimizing for all devices — this takes a moment
              </p>
            </div>
          ) : (
            <>
              <div className="review-btn-row">
                {/* Re-Do */}
                <button
                  className="btn btn-secondary review-action-btn"
                  onClick={handleRedo}
                >
                  <span className="review-btn-icon">↩</span>
                  Re-Do
                </button>

                {/* Cancel */}
                <button
                  className="btn btn-danger review-action-btn"
                  onClick={handleCancel}
                >
                  <span className="review-btn-icon">✕</span>
                  Cancel
                </button>

                {/* Complete */}
                <button
                  className="btn btn-success review-action-btn review-complete-btn animate-glow"
                  onClick={handleComplete}
                >
                  <span className="review-btn-icon">✓</span>
                  Complete
                </button>
              </div>

              <p className="review-hint">
                Happy with your recording? Tap <strong>Complete</strong> to save it.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
