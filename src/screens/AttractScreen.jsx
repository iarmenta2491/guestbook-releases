import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useApp } from '../context/AppContext';

/* ─── Particle helpers ───────────────────────────────────────────────────── */
const PARTICLE_COUNT = 28;

function randomBetween(min, max) {
  return Math.random() * (max - min) + min;
}

function generateParticles() {
  return Array.from({ length: PARTICLE_COUNT }, (_, i) => ({
    id: i,
    x: randomBetween(0, 100),
    y: randomBetween(0, 100),
    size: randomBetween(3, 9),
    duration: randomBetween(8, 22),
    delay: randomBetween(0, 12),
    opacity: randomBetween(0.15, 0.55),
    hue: Math.random() > 0.5 ? 'purple' : 'teal',
    driftX: randomBetween(-30, 30),
    driftY: randomBetween(-40, -10),
  }));
}

/* ─── Component ──────────────────────────────────────────────────────────── */
export default function AttractScreen({ active }) {
  const { navigateTo, navigateGlam, settings, clips } = useApp();

  const [promptIndex, setPromptIndex]     = useState(0);
  const [promptVisible, setPromptVisible] = useState(true);
  const [particles]                       = useState(generateParticles);
  const [bgError, setBgError]             = useState(false);
  const [titleVisible, setTitleVisible]   = useState(false);

  const promptTimerRef = useRef(null);
  const titleTimerRef  = useRef(null);

  // Determine which prompt list to rotate:
  //   showTopicPrompts ON  → use AI-generated topicPrompts
  //   showTopicPrompts OFF → use host's customPrompts (falls back to nothing if empty)
  const aiPrompts     = settings.topicPrompts   || [];
  const customPrompts = settings.customPrompts  || [];
  const showPrompts   = settings.showTopicPrompts !== false;
  const prompts       = showPrompts ? aiPrompts : customPrompts;
  const guestCount    = clips ? clips.length : 0;
  const showText      = settings.showAttractText !== false;

  // ── Prompt Styling ─────────────────────────────────────────────────────
  const ps = settings.promptStyling || {};
  const FONT_MAP = {
    default:  "'Outfit', sans-serif",
    serif:    "Georgia, 'Times New Roman', serif",
    rounded:  "'Nunito', 'Varela Round', sans-serif",
    mono:     "'Courier New', Courier, monospace",
    cursive:  "'Dancing Script', cursive",
  };
  const tickerFontFamily  = FONT_MAP[ps.fontFamily] || FONT_MAP.default;
  const tickerFontSize    = `${ps.fontSize || 18}px`;
  const tickerFontWeight  = ps.bold ? '700' : '500';
  const tickerBoxWidth    = `${ps.boxWidth || 80}%`;
  const tickerColor       = ps.color || '#ffffff';
  const tickerRainbow     = ps.rainbowAnimation === true;

  // ── Title Styling ──────────────────────────────────────────────────────────────────
  const ts = settings.titleStyling || {};
  const TITLE_FONT_MAP = {
    default:   "'Outfit', sans-serif",
    serif:     "Georgia, 'Times New Roman', serif",
    rounded:   "'Nunito', 'Varela Round', sans-serif",
    mono:      "'Courier New', Courier, monospace",
    cursive:   "'Dancing Script', cursive",
    display:   "'Playfair Display', Georgia, serif",
    condensed: "'Barlow Condensed', 'Arial Narrow', sans-serif",
  };
  const titleFontFamily   = TITLE_FONT_MAP[ts.fontFamily] || TITLE_FONT_MAP.default;
  const titleFontSize     = `${ts.fontSize || 56}px`;
  const titleColor        = ts.color || '#ffffff';
  const titleColorAnimate = ts.colorAnimate === true;
  const titleTextAnimate  = ts.textAnimate === true;
  const tapCtaText        = settings.tapCtaText || 'Tap anywhere to leave a message';

  /* Title entrance animation */
  useEffect(() => {
    if (active) {
      titleTimerRef.current = setTimeout(() => setTitleVisible(true), 200);
    } else {
      setTitleVisible(false);
    }
    return () => clearTimeout(titleTimerRef.current);
  }, [active]);

  /* Topic prompt ticker */
  useEffect(() => {
    if (!active || prompts.length === 0) return;
    setPromptVisible(true);

    const cycle = () => {
      setPromptVisible(false);
      promptTimerRef.current = setTimeout(() => {
        setPromptIndex(i => (i + 1) % prompts.length);
        setPromptVisible(true);
      }, 600);
    };

    const intervalId = setInterval(cycle, 4000);
    return () => {
      clearInterval(intervalId);
      clearTimeout(promptTimerRef.current);
    };
  }, [active, prompts.length]);

  const handleScreenClick = useCallback((e) => {
    if (e.target.closest('[data-admin-btn]')) return;
    navigateTo('record');
  }, [navigateTo]);

  const handleAdmin = useCallback((e) => {
    e.stopPropagation();
    navigateTo('admin');
  }, [navigateTo]);

  const hasBg   = settings.attractBgPath && !bgError;
  const isVideo = settings.attractBgType === 'video';
  const bgSrc   = settings.attractBgPath || '/attract_bg.png';

  // Map the user's Display setting to CSS object-fit + object-position
  const BG_FIT_MAP = {
    fill:    { objectFit: 'cover',    objectPosition: 'center' },
    fit:     { objectFit: 'contain',  objectPosition: 'center' },
    stretch: { objectFit: 'fill',     objectPosition: 'center' },
    center:  { objectFit: 'none',     objectPosition: 'center' },
  };
  const bgFitStyle = BG_FIT_MAP[settings.attractBgFit] || BG_FIT_MAP.fit;

  return (
    <>
      <style>{`
        .attract-root {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          overflow: hidden;
          cursor: pointer;
          opacity: 0;
          pointer-events: none;
          transition: opacity 600ms var(--ease-out);
          z-index: var(--z-base);
        }
        .attract-root.active {
          opacity: 1;
          pointer-events: all;
          z-index: 10;
        }
        .attract-bg {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          /* object-fit is set via inline style from settings.attractBgFit */
          z-index: 0;
        }
        .attract-bg-fallback {
          position: absolute;
          inset: 0;
          background:
            radial-gradient(ellipse at 15% 50%, rgba(139,92,246,0.22) 0%, transparent 55%),
            radial-gradient(ellipse at 85% 20%, rgba(45,212,191,0.16) 0%, transparent 55%),
            radial-gradient(ellipse at 50% 90%, rgba(139,92,246,0.12) 0%, transparent 50%),
            var(--bg-primary);
          z-index: 0;
        }
        .attract-bg-overlay {
          position: absolute;
          inset: 0;
          background: linear-gradient(
            to bottom,
            rgba(7,7,26,0.40) 0%,
            rgba(7,7,26,0.15) 40%,
            rgba(7,7,26,0.65) 100%
          );
          z-index: 1;
        }
        .attract-orb {
          position: absolute;
          border-radius: 50%;
          pointer-events: none;
          z-index: 1;
          filter: blur(80px);
          animation: attractFloat 8s ease-in-out infinite;
        }
        .attract-orb-1 {
          width: 420px; height: 420px;
          background: rgba(139,92,246,0.14);
          top: -100px; left: -80px;
          animation-delay: 0s;
        }
        .attract-orb-2 {
          width: 320px; height: 320px;
          background: rgba(45,212,191,0.11);
          bottom: -60px; right: -60px;
          animation-delay: -4s;
        }
        .attract-orb-3 {
          width: 240px; height: 240px;
          background: rgba(139,92,246,0.09);
          top: 40%; right: 15%;
          animation-delay: -2s;
        }
        @keyframes attractFloat {
          0%, 100% { transform: translateY(0px) scale(1); }
          50%       { transform: translateY(-18px) scale(1.04); }
        }
        .attract-particles {
          position: absolute;
          inset: 0;
          pointer-events: none;
          z-index: 2;
        }
        .attract-particle {
          position: absolute;
          border-radius: 50%;
          animation: attractParticle var(--adur) var(--adelay) ease-in-out infinite;
        }
        .attract-particle-purple {
          background: radial-gradient(circle, rgba(139,92,246,0.95) 0%, rgba(139,92,246,0) 70%);
          box-shadow: 0 0 6px rgba(139,92,246,0.7);
        }
        .attract-particle-teal {
          background: radial-gradient(circle, rgba(45,212,191,0.95) 0%, rgba(45,212,191,0) 70%);
          box-shadow: 0 0 6px rgba(45,212,191,0.7);
        }
        @keyframes attractParticle {
          0%   { transform: translate(0,0) scale(1);   opacity: var(--aop); }
          33%  { transform: translate(var(--adx1), var(--ady1)) scale(1.3); opacity: calc(var(--aop)*0.6); }
          66%  { transform: translate(var(--adx2), var(--ady2)) scale(0.8); opacity: calc(var(--aop)*1.2); }
          100% { transform: translate(0,0) scale(1);   opacity: var(--aop); }
        }
        .attract-content {
          position: relative;
          z-index: 3;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          height: 100%;
          width: 100%;
          padding: 60px 40px 140px;
        }
        .attract-title-wrap {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 14px;
          transform: translateY(24px);
          opacity: 0;
          transition: opacity 800ms var(--ease-out), transform 800ms var(--ease-out);
        }
        .attract-title-wrap.visible {
          opacity: 1;
          transform: translateY(0);
        }
        .attract-eyebrow {
          font-size: 0.85rem;
          font-weight: 600;
          letter-spacing: 0.24em;
          text-transform: uppercase;
          color: var(--teal-400);
          text-shadow: 0 0 16px rgba(45,212,191,0.6);
        }
        .attract-event-name {
          font-size: clamp(3.2rem, 9vw, 7.5rem);
          font-weight: 800;
          line-height: 1.0;
          text-align: center;
          background: linear-gradient(135deg, #c4b5fd 0%, #8b5cf6 35%, #2dd4bf 70%, #5eead4 100%);
          background-size: 200% 200%;
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
          animation: attractGradient 5s ease-in-out infinite alternate;
          filter: drop-shadow(0 0 28px rgba(139,92,246,0.45));
          letter-spacing: -0.02em;
        }
        @keyframes attractGradient {
          0%   { background-position: 0% 50%;   }
          100% { background-position: 100% 50%; }
        }
        .attract-subtitle {
          font-size: clamp(1rem, 2.2vw, 1.4rem);
          font-weight: 400;
          color: rgba(241,245,249,0.65);
          letter-spacing: 0.06em;
          margin-top: 4px;
        }
        .attract-spacer { flex: 1; }
        .attract-ticker-wrap {
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 60px;
          margin-bottom: 32px;
          padding: 0 24px;
          width: 100%;
          max-width: 800px;
        }
        .attract-ticker {
          font-size: clamp(1rem, 2.4vw, 1.35rem);
          font-weight: 500;
          color: var(--text-primary);
          text-align: center;
          padding: 14px 32px;
          background: var(--glass-sm);
          border: 1px solid var(--glass-border);
          border-radius: var(--radius-full);
          backdrop-filter: blur(20px);
          -webkit-backdrop-filter: blur(20px);
          transition: opacity 500ms ease, transform 500ms var(--ease-out);
          opacity: 1;
          transform: translateY(0);
          width: 100%;
        }
        .attract-ticker.hidden {
          opacity: 0;
          transform: translateY(8px);
        }
        .attract-cta-outer {
          position: relative;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          margin-bottom: 28px;
        }
        .attract-cta-ring {
          position: absolute;
          border-radius: var(--radius-full);
          border: 2px solid rgba(139,92,246,0.55);
          animation: attractRing 2.8s ease-out infinite;
          pointer-events: none;
          inset: -4px;
        }
        .attract-cta-ring:nth-child(2) {
          inset: -14px;
          border-color: rgba(139,92,246,0.32);
          animation-delay: 0.7s;
        }
        .attract-cta-ring:nth-child(3) {
          inset: -26px;
          border-color: rgba(139,92,246,0.16);
          animation-delay: 1.4s;
        }
        @keyframes attractRing {
          0%   { opacity: 0.9; transform: scale(1); }
          100% { opacity: 0;   transform: scale(1.28); }
        }
        .attract-cta {
          position: relative;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 14px;
          padding: 26px 64px;
          font-family: 'Outfit', sans-serif;
          font-size: clamp(1.1rem, 2.5vw, 1.5rem);
          font-weight: 700;
          letter-spacing: 0.04em;
          color: #fff;
          background: linear-gradient(135deg, #7c3aed, #8b5cf6, #14b8a6);
          background-size: 200% 200%;
          border: none;
          border-radius: var(--radius-full);
          cursor: pointer;
          outline: none;
          -webkit-tap-highlight-color: transparent;
          animation: attractCtaPulse 2.8s ease-in-out infinite, attractGradient 4s ease-in-out infinite alternate;
          transition: transform 150ms var(--ease-spring);
          white-space: nowrap;
          z-index: 1;
        }
        .attract-cta:active { transform: scale(0.96); }
        @keyframes attractCtaPulse {
          0%, 100% {
            box-shadow:
              0 0  30px rgba(139,92,246,0.55),
              0 8px 40px rgba(139,92,246,0.40);
          }
          50% {
            box-shadow:
              0 0  70px rgba(139,92,246,0.90),
              0 8px 60px rgba(139,92,246,0.65);
          }
        }
        .attract-hud {
          position: absolute;
          bottom: 0;
          left: 0;
          right: 0;
          z-index: 4;
          display: flex;
          align-items: flex-end;
          justify-content: space-between;
          padding: 0 28px 28px;
        }
        .attract-guest-count {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 18px;
          background: var(--glass-sm);
          border: 1px solid var(--glass-border);
          border-radius: var(--radius-full);
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          pointer-events: none;
        }
        .attract-guest-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: var(--teal-400);
          box-shadow: 0 0 10px rgba(45,212,191,0.8);
          animation: attractDotPulse 2s ease-in-out infinite;
        }
        @keyframes attractDotPulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%       { opacity: 0.4; transform: scale(0.85); }
        }
        .attract-guest-text {
          font-size: 0.85rem;
          font-weight: 600;
          color: var(--text-secondary);
          letter-spacing: 0.03em;
        }
        .attract-guest-num {
          color: var(--teal-400);
          font-weight: 700;
        }
        .attract-admin-btn {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 9px 18px;
          background: transparent;
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: var(--radius-full);
          color: rgba(255,255,255,0.22);
          font-family: 'Outfit', sans-serif;
          font-size: 0.78rem;
          font-weight: 500;
          letter-spacing: 0.06em;
          cursor: pointer;
          transition: color 200ms, border-color 200ms, background 200ms;
          outline: none;
          -webkit-tap-highlight-color: transparent;
        }
        .attract-admin-btn:hover {
          color: rgba(255,255,255,0.70);
          border-color: rgba(255,255,255,0.22);
          background: rgba(255,255,255,0.06);
        }
      `}</style>

      <div
        className={`attract-root${active ? ' active' : ''}`}
        onClick={handleScreenClick}
      >
        {/* Background */}
        {hasBg ? (
          isVideo ? (
            <video
              className="attract-bg"
              src={bgSrc}
              autoPlay
              loop
              muted
              playsInline
              onError={() => setBgError(true)}
              style={bgFitStyle}
            />
          ) : (
            <img
              className="attract-bg"
              src={bgSrc}
              alt=""
              onError={() => setBgError(true)}
              style={bgFitStyle}
            />
          )
        ) : (
          <div className="attract-bg-fallback" />
        )}
        <div className="attract-bg-overlay" />

        {/* Ambient orbs */}
        <div className="attract-orb attract-orb-1" aria-hidden="true" />
        <div className="attract-orb attract-orb-2" aria-hidden="true" />
        <div className="attract-orb attract-orb-3" aria-hidden="true" />

        {/* Particles */}
        <div className="attract-particles" aria-hidden="true">
          {particles.map(p => (
            <div
              key={p.id}
              className={`attract-particle attract-particle-${p.hue}`}
              style={{
                left: `${p.x}%`,
                top:  `${p.y}%`,
                width:  `${p.size}px`,
                height: `${p.size}px`,
                '--adur':   `${p.duration}s`,
                '--adelay': `-${p.delay}s`,
                '--aop':    p.opacity,
                '--adx1':   `${p.driftX * 0.5}px`,
                '--ady1':   `${p.driftY * 0.6}px`,
                '--adx2':   `${-p.driftX * 0.3}px`,
                '--ady2':   `${p.driftY}px`,
              }}
            />
          ))}
        </div>

        {/* Main content */}
        <div className="attract-content">
          {/* Title — hidden when showAttractText is OFF */}
          {showText && (
            <div className={`attract-title-wrap${titleVisible ? ' visible' : ''}`}>
              <span className="attract-eyebrow">✨ Welcome to ✨</span>
              {titleColorAnimate && (
                <style>{`
                  @keyframes titleColorCycle {
                    0%   { color: hsl(270,80%,80%); }
                    20%  { color: hsl(180,70%,75%); }
                    40%  { color: hsl(340,80%,80%); }
                    60%  { color: hsl(40,90%,75%); }
                    80%  { color: hsl(210,70%,80%); }
                    100% { color: hsl(270,80%,80%); }
                  }
                  .attract-event-name.color-anim { animation: titleColorCycle 6s ease-in-out infinite; }
                `}</style>
              )}
              {titleTextAnimate && (
                <style>{`
                  @keyframes titleFloat {
                    0%,100% { transform: translateY(0px) scale(1); }
                    50%     { transform: translateY(-10px) scale(1.015); }
                  }
                  .attract-event-name.text-anim { animation: titleFloat 4s ease-in-out infinite; }
                `}</style>
              )}
              <h1
                className={`attract-event-name${titleColorAnimate ? ' color-anim' : ''}${titleTextAnimate ? ' text-anim' : ''}`}
                style={{
                  fontFamily:    titleFontFamily,
                  fontSize:      titleFontSize,
                  color:         titleColorAnimate ? undefined : titleColor,
                  whiteSpace:    'pre-wrap',
                  wordBreak:     'break-word',
                }}
              >
                {settings.eventName}
              </h1>
              <p className="attract-subtitle">Leave a lasting memory</p>
            </div>
          )}

          <div className="attract-spacer" />

          {/* Topic ticker */}
          {prompts.length > 0 && (
            <div className="attract-ticker-wrap" style={{ maxWidth: tickerBoxWidth }}>
              {tickerRainbow && (
                <style>{`
                  @keyframes rainbowShift {
                    0%   { background-position: 0% 50%; }
                    50%  { background-position: 100% 50%; }
                    100% { background-position: 0% 50%; }
                  }
                  .attract-ticker-rainbow {
                    background: linear-gradient(90deg,
                      #ff6b6b, #ffd93d, #6bcb77, #4d96ff, #c77dff, #ff6b6b);
                    background-size: 300% 300%;
                    animation: rainbowShift 4s ease infinite;
                    -webkit-background-clip: text;
                    -webkit-text-fill-color: transparent;
                    background-clip: text;
                    display: inline;
                  }
                `}</style>
              )}
              <div
                className={`attract-ticker${promptVisible ? '' : ' hidden'}`}
                style={{
                  fontSize:   tickerFontSize,
                  fontFamily: tickerFontFamily,
                  fontWeight: tickerFontWeight,
                  color:      tickerRainbow ? 'transparent' : tickerColor,
                  width:      '100%',
                }}
              >
                {tickerRainbow ? (
                  <span className="attract-ticker-rainbow">{prompts[promptIndex]}</span>
                ) : (
                  prompts[promptIndex]
                )}
              </div>
            </div>
          )}

          {/* CTA row: standard button + optional GLAM button */}
          <div className="attract-cta-outer">
            <div className="attract-cta-ring" />
            <div className="attract-cta-ring" />
            <div className="attract-cta-ring" />
            <button className="attract-cta" tabIndex={-1}>
              🎙️&nbsp;&nbsp;{tapCtaText}
            </button>
          </div>
          {settings.enableGlam && (
            <button
              className="attract-glam-btn"
              data-admin-btn="false"
              onClick={e => { e.stopPropagation(); navigateGlam(); }}
              tabIndex={-1}
              aria-label="Record with GLAM beauty filter"
            >
              ✨ GLAM Mode
            </button>
          )}
        </div>

        {/* HUD */}
        <div className="attract-hud">
          <div className="attract-guest-count">
            <div className="attract-guest-dot" />
            <span className="attract-guest-text">
              <span className="attract-guest-num">{guestCount}</span>
              {' '}message{guestCount !== 1 ? 's' : ''} recorded
            </span>
          </div>

          <button
            className="attract-admin-btn"
            data-admin-btn="true"
            onClick={handleAdmin}
            tabIndex={-1}
            aria-label="Open admin panel"
          >
            ⚙&nbsp;Admin
          </button>
        </div>
      </div>
    </>
  );
}
