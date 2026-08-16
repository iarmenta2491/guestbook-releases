import React, { useEffect, useState, useRef } from 'react';
import { useApp } from '../context/AppContext';
import '../styles/ThankYouScreen.css';

/* ─────────────────────────────────────────────────────────────────────────── *
 *  ThankYouScreen
 *  Celebratory end-screen. Shows 🙏, confetti particles, event name,
 *  and a 5-second countdown progress bar before auto-navigating to attract.
 * ─────────────────────────────────────────────────────────────────────────── */

const COUNTDOWN_SECS = 5;

// Deterministic (seeded-ish) list of confetti particles so they don't
// re-randomise on every render — generated once at module load time.
const PARTICLES = Array.from({ length: 56 }, (_, i) => {
  const hues = [45, 170, 280, 340, 60, 200, 130]; // gold, teal, purple, rose, yellow, sky, green
  const hue = hues[i % hues.length];
  const saturation = 75 + (i % 3) * 8;            // 75-91
  const lightness  = 58 + (i % 4) * 6;            // 58-82

  return {
    id: i,
    left:  `${(i * 1.8 + (i % 7) * 3.2) % 100}%`,
    width:  6 + (i % 5) * 3,                       // 6-18 px
    height: 8 + (i % 4) * 4,                       // 8-20 px
    color: `hsl(${hue}, ${saturation}%, ${lightness}%)`,
    delay:  `${(i * 0.18) % 3.5}s`,
    duration: `${3 + (i % 6) * 0.5}s`,
    rotateStart: `${(i * 37) % 360}deg`,
    rotateEnd:   `${((i * 37) % 360) + 540}deg`,
    xDrift: `${((i % 5) - 2) * 40}px`,
    shape: i % 5 === 0 ? 'circle' : 'rect',
  };
});

export default function ThankYouScreen({ active }) {
  const { settings, navigateTo, resetSession } = useApp();

  const [countdown, setCountdown] = useState(COUNTDOWN_SECS);
  const [entered, setEntered] = useState(false);

  const timerRef    = useRef(null);
  const intervalRef = useRef(null);

  // ── On activate ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!active) {
      // Reset state when screen is hidden so next visit plays animations fresh
      setEntered(false);
      setCountdown(COUNTDOWN_SECS);
      clearTimeout(timerRef.current);
      clearInterval(intervalRef.current);
      return;
    }

    // Trigger enter animation on next frame
    const enterFrame = requestAnimationFrame(() => {
      setTimeout(() => setEntered(true), 50);
    });

    // Countdown interval
    setCountdown(COUNTDOWN_SECS);
    intervalRef.current = setInterval(() => {
      setCountdown(prev => Math.max(0, prev - 1));
    }, 1000);

    // Auto-navigate after countdown
    timerRef.current = setTimeout(() => {
      handleReturn();
    }, COUNTDOWN_SECS * 1000);

    return () => {
      cancelAnimationFrame(enterFrame);
      clearTimeout(timerRef.current);
      clearInterval(intervalRef.current);
    };
  }, [active]);

  // ── Return to start ───────────────────────────────────────────────────────
  const handleReturn = () => {
    clearTimeout(timerRef.current);
    clearInterval(intervalRef.current);
    resetSession();
    navigateTo('attract');
  };

  const eventName = settings.eventName || 'My Guestbook';

  // Progress bar fill (0→100%)
  const progressPct = ((COUNTDOWN_SECS - countdown) / COUNTDOWN_SECS) * 100;

  return (
    <div className={`screen thankyou-screen${active ? ' active' : ''}`}>
      {/* ── Confetti particles ─────────────────────────────────────────── */}
      <div className="ty-confetti" aria-hidden="true">
        {PARTICLES.map(p => (
          <div
            key={p.id}
            className="ty-particle"
            style={{
              left: p.left,
              width:  p.width,
              height: p.height,
              backgroundColor: p.color,
              borderRadius: p.shape === 'circle' ? '50%' : '2px',
              animationDelay:    p.delay,
              animationDuration: p.duration,
              '--x-drift': p.xDrift,
              '--r-start': p.rotateStart,
              '--r-end':   p.rotateEnd,
            }}
          />
        ))}
      </div>

      {/* ── Decorative glow orbs ───────────────────────────────────────── */}
      <div className="ty-orb ty-orb-gold" />
      <div className="ty-orb ty-orb-teal" />

      {/* ── Main content ───────────────────────────────────────────────── */}
      <div className={`ty-content${entered ? ' ty-content-entered' : ''}`}>
        {/* Emoji */}
        <div className="ty-emoji-wrap">
          <span className="ty-emoji" role="img" aria-label="thank you">🙏</span>
          <div className="ty-emoji-ring" />
        </div>

        {/* Headline */}
        <h1 className="ty-heading">
          <span className="ty-heading-line ty-heading-thanks">Thank You!</span>
        </h1>

        {/* Subtext */}
        <p className="ty-subtext">
          Your message has been saved for
          <br />
          <span className="ty-event-name">{eventName}</span>
        </p>

        {/* Decorative divider */}
        <div className="ty-divider">
          <div className="ty-divider-line" />
          <div className="ty-divider-gem">✦</div>
          <div className="ty-divider-line" />
        </div>

        {/* 5-second countdown progress bar */}
        <div className="ty-progress-section">
          <div className="ty-progress-bar">
            <div
              className="ty-progress-fill"
              style={{
                width: `${progressPct}%`,
                transition: countdown === COUNTDOWN_SECS
                  ? 'none'
                  : 'width 1s linear',
              }}
            />
          </div>
          <p className="ty-progress-label">
            Returning to start in <strong>{countdown}</strong>s
          </p>
        </div>

        {/* Return button */}
        <button
          className="btn btn-secondary ty-return-btn"
          onClick={handleReturn}
        >
          ↩ Return to Start
        </button>
      </div>
    </div>
  );
}
