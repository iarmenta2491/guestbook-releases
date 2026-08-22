import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import QRCode from 'qrcode';
import '../styles/ShareScreen.css';

/* ─────────────────────────────────────────────────────────────────────────── *
 *  ShareScreen
 *  Shows QR / Email sharing options after a recording is saved.
 *
 *  Timer behaviour:
 *   - On activate: starts a decision countdown (decisionTimeout, default 30s).
 *   - When QR or Email is chosen: restarts countdown at sharingTimeout.
 *   - Any user interaction (button tap, key press, view switch) resets the
 *     current countdown back to its full duration.
 *   - When both QR and Email are enabled, each view shows a
 *     "Switch to …" button so the guest can move between them without
 *     returning to the idle selection screen.
 * ─────────────────────────────────────────────────────────────────────────── */

// SVG countdown ring constants
const RING_R = 44;
const RING_CIRC = 2 * Math.PI * RING_R; // ≈ 276.5

export default function ShareScreen({ active }) {
  const { session, settings, navigateTo } = useApp();

  // 'idle' | 'qr' | 'email' | 'email-sending' | 'email-sent'
  const [view, setView] = useState('idle');
  const [qrUrl, setQrUrl] = useState(null);
  const [qrError, setQrError] = useState(null);
  const [countdown, setCountdown] = useState(0);
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState('');

  const canvasRef        = useRef(null);
  const timerRef         = useRef(null);
  const countIntervalRef = useRef(null);
  // Store the "full duration" that the current countdown was started with,
  // so that bumpCountdown() can reset back to it.
  const currentDurRef    = useRef(30);
  // Store the expiry callback so bumpCountdown() can restart the whole timer.
  const currentExpireRef = useRef(null);

  // ─── Helpers ──────────────────────────────────────────────────────────────

  const clearTimers = useCallback(() => {
    clearTimeout(timerRef.current);
    clearInterval(countIntervalRef.current);
  }, []);

  /** Start (or restart) a countdown. Always wipes previous timers first. */
  const startCountdown = useCallback((seconds, onExpire) => {
    clearTimers();
    currentDurRef.current    = seconds;
    currentExpireRef.current = onExpire;
    setCountdown(seconds);
    countIntervalRef.current = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          clearInterval(countIntervalRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    timerRef.current = setTimeout(onExpire, seconds * 1000);
  }, [clearTimers]);

  /**
   * Reset the current countdown back to its full duration.
   * Called on any meaningful user interaction so the guest never gets
   * timed out while actively using the screen.
   */
  const bumpCountdown = useCallback(() => {
    if (currentExpireRef.current) {
      startCountdown(currentDurRef.current, currentExpireRef.current);
    }
  }, [startCountdown]);

  const goThankyou = useCallback(() => {
    clearTimers();
    navigateTo('thankyou');
  }, [clearTimers, navigateTo]);

  // ─── Activate / Deactivate ────────────────────────────────────────────────

  useEffect(() => {
    if (active) {
      setView('idle');
      setQrUrl(null);
      setQrError(null);
      setEmail('');
      setEmailError('');
      const secs = settings.decisionTimeout || 30;
      startCountdown(secs, goThankyou);
    } else {
      clearTimers();
    }
    return clearTimers;
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── QR generation ────────────────────────────────────────────────────────

  const handleShowQR = useCallback(async () => {
    setView('qr');
    setQrError(null);
    const secs = settings.sharingTimeout || 120;
    startCountdown(secs, goThankyou);
    try {
      const result = await window.guestbook.startShareServer(session.savedClipPath);

      // Always use the local LAN URL — no tunnel upgrade
      const baseUrl  = result.localUrl || result.url || 'http://localhost:8765';
      const fileName = session.savedClipPath
        ? session.savedClipPath.replace(/\\/g, '/').split('/').pop()
        : 'latest.mp4';

      const safeUrl = new URL('/download', baseUrl);
      safeUrl.searchParams.set('file', fileName);
      const qrTargetUrl = safeUrl.toString();

      console.log('[QR] Local share URL:', qrTargetUrl);
      setQrUrl(qrTargetUrl);
    } catch (err) {
      console.error('[QR] Share error:', err);
      setQrError('Could not start sharing server. Please try again.');
      setView('idle');
      const secs = settings.decisionTimeout || 30;
      startCountdown(secs, goThankyou);
    }
  }, [session.savedClipPath, settings, goThankyou, startCountdown]);


  // Draw QR onto canvas once qrUrl is set and canvas is mounted.
  // Uses a rAF+retry loop to handle the async gap between state update
  // and the canvas element actually appearing in the DOM.
  useEffect(() => {
    if (view !== 'qr' || !qrUrl || typeof qrUrl !== 'string' || !qrUrl.startsWith('http')) return;

    let cancelled = false;
    let attempts  = 0;

    function tryDraw() {
      if (cancelled) return;
      if (canvasRef.current) {
        QRCode.toCanvas(canvasRef.current, qrUrl, {
          width: 280, margin: 2,
          color: { dark: '#07071a', light: '#ffffff' },
        })
        .then(() => console.log('[QR] Canvas drawn successfully.'))
        .catch(err => console.error('[QR] Canvas draw error:', err));
      } else if (attempts < 20) {
        attempts++;
        requestAnimationFrame(tryDraw);
      } else {
        console.warn('[QR] Canvas ref never mounted after 20 rAF attempts.');
      }
    }
    requestAnimationFrame(tryDraw);
    return () => { cancelled = true; };
  }, [view, qrUrl]);

  // ─── Email handlers ───────────────────────────────────────────────────────

  const handleShowEmail = useCallback(() => {
    setView('email');
    setEmailError('');
    const secs = settings.sharingTimeout || 120;
    startCountdown(secs, goThankyou);        // restart timer at sharingTimeout
  }, [settings, goThankyou, startCountdown]);

  const handleSendEmail = useCallback(async () => {
    if (!email.trim() || !/\S+@\S+\.\S+/.test(email)) {
      setEmailError('Please enter a valid email address.');
      return;
    }
    bumpCountdown();
    setView('email-sending');
    setEmailError('');
    try {
      await window.guestbook.sendEmailShare(session.savedClipPath, email.trim());
      setView('email-sent');
      // Route through timerRef so clearTimers() cancels it on navigation
      timerRef.current = setTimeout(goThankyou, 3000);
    } catch (err) {
      console.error('Email send error:', err);
      setEmailError('Failed to send email. Please try again.');
      setView('email');
    }
  }, [email, session.savedClipPath, goThankyou, bumpCountdown]);

  // ─── Switch between QR and Email ─────────────────────────────────────────

  /** Switch from QR → Email (or vice-versa). Reuses running sharing timeout. */
  const handleSwitchToEmail = useCallback(() => {
    bumpCountdown();
    setView('email');
    setEmailError('');
  }, [bumpCountdown]);

  const handleSwitchToQR = useCallback(() => {
    bumpCountdown();
    handleShowQR();
  }, [bumpCountdown, handleShowQR]);

  // ─── Countdown ring progress ──────────────────────────────────────────────

  const totalSecs  = currentDurRef.current || 30;
  const fraction   = totalSecs > 0 ? (countdown / totalSecs) : 1;
  const dashOffset = RING_CIRC * (1 - fraction);

  const bothEnabled = settings.enableQR && settings.enableEmail;

  // ─── Shared countdown ring JSX ────────────────────────────────────────────

  const CountdownRing = ({ size = 64, label }) => (
    <div className="share-countdown-wrap">
      <svg className="share-ring" viewBox="0 0 100 100" width={size} height={size}>
        <circle
          className="share-ring-track"
          cx={50} cy={50} r={RING_R}
          fill="none"
          stroke="rgba(255,255,255,0.1)"
          strokeWidth={6}
        />
        <circle
          className="share-ring-fill"
          cx={50} cy={50} r={RING_R}
          fill="none"
          stroke="var(--teal-400)"
          strokeWidth={6}
          strokeLinecap="round"
          strokeDasharray={RING_CIRC}
          strokeDashoffset={dashOffset}
          transform="rotate(-90 50 50)"
          style={{ transition: 'stroke-dashoffset 1s linear' }}
        />
        <text
          x={50} y={55}
          textAnchor="middle"
          fontSize={size >= 70 ? 18 : 16}
          fill="var(--text-primary)"
          fontFamily="Outfit, sans-serif"
          fontWeight={700}
        >
          {countdown}
        </text>
      </svg>
      <p className="share-countdown-label">{label}</p>
    </div>
  );

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className={`screen share-screen${active ? ' active' : ''}`}>
      {/* ── Decorative background ─────────────────────────────────────── */}
      <div className="share-bg" />
      <div className="share-orb share-orb-1" />
      <div className="share-orb share-orb-2" />

      {/* ── Main card ────────────────────────────────────────────────── */}
      <div className="share-card glass-card-bright animate-fadeInScale">

        {/* ── Header ─────────────────────────────────────────────────── */}
        <div className="share-header">
          <div className="share-emoji">🎉</div>
          <h1 className="share-title gradient-text">Your message has been saved!</h1>
          <p className="share-subtitle">
            {view === 'idle'
              ? 'Would you like a copy of your recording?'
              : view === 'qr'
                ? 'Scan the QR code to download your recording'
                : view === 'email' || view === 'email-sending'
                  ? 'Enter your email address below'
                  : view === 'email-sent'
                    ? 'Email sent! Redirecting…'
                    : ''}
          </p>
        </div>

        {/* ═══════════════════════════════════════════════════════════════
            VIEW: idle — decision buttons
        ═══════════════════════════════════════════════════════════════ */}
        {view === 'idle' && (
          <div className="share-decision">
            {qrError && <p className="share-error animate-fadeIn">{qrError}</p>}

            <div className="share-option-row">
              {settings.enableQR && (
                <button
                  className="share-option-btn btn btn-teal"
                  onClick={() => { bumpCountdown(); handleShowQR(); }}
                >
                  <span className="share-option-icon">📱</span>
                  <span className="share-option-label">QR Code</span>
                  <span className="share-option-desc">Scan to download</span>
                </button>
              )}
              {settings.enableEmail && (
                <button
                  className="share-option-btn btn btn-primary"
                  onClick={() => { bumpCountdown(); handleShowEmail(); }}
                >
                  <span className="share-option-icon">✉️</span>
                  <span className="share-option-label">Email</span>
                  <span className="share-option-desc">Send to my inbox</span>
                </button>
              )}
            </div>

            <CountdownRing size={64} label={`Auto-skip in ${countdown}s`} />
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════
            VIEW: qr — QR code panel
        ═══════════════════════════════════════════════════════════════ */}
        {view === 'qr' && (
          <div className="share-qr-panel animate-fadeIn">
            <div className="share-qr-frame">
              {/* Show spinner while URL is being fetched/validated */}
              {(!qrUrl || typeof qrUrl !== 'string' || !qrUrl.startsWith('http')) && (
                <div className="spinner" style={{ width: 48, height: 48 }} />
              )}
              {/* Only mount canvas when we have a confirmed absolute URL */}
              {qrUrl && typeof qrUrl === 'string' && qrUrl.startsWith('http') && (
                <canvas
                  ref={canvasRef}
                  className="share-qr-canvas"
                  style={{ display: 'block' }}
                />
              )}
            </div>

            {/* Wi-Fi instruction badge — shown whenever the QR is ready */}
            {qrUrl && typeof qrUrl === 'string' && qrUrl.startsWith('http') && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '6px 16px', borderRadius: 999,
                background: 'rgba(20,184,166,0.12)',
                border: '1px solid rgba(20,184,166,0.35)',
                color: '#2dd4bf',
                fontSize: '0.78rem', fontWeight: 700, letterSpacing: '0.04em',
              }}>
                📶 Connect to the event Wi-Fi, then scan
              </span>
            )}

            <CountdownRing size={72} label={`Link expires in ${countdown}s`} />

            {/* Switch to Email option (only when both are enabled) */}
            {bothEnabled && (
              <button
                className="btn btn-ghost share-switch-btn"
                onClick={handleSwitchToEmail}
              >
                ✉️&nbsp; Send via Email Instead
              </button>
            )}
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════
            VIEW: email — email input form
        ═══════════════════════════════════════════════════════════════ */}
        {(view === 'email' || view === 'email-sending' || view === 'email-sent') && (
          <div className="share-email-panel animate-fadeIn">
            {view === 'email-sent' ? (
              <div className="share-email-success">
                <div style={{ fontSize: '3rem' }}>✅</div>
                <p className="share-email-sent-msg">Email sent to <strong>{email}</strong></p>
              </div>
            ) : (
              <>
                <div className="share-email-field">
                  <input
                    className="input share-email-input"
                    type="email"
                    placeholder="your@email.com"
                    value={email}
                    onChange={e => {
                      setEmail(e.target.value);
                      setEmailError('');
                      bumpCountdown();   // reset timer on every keystroke
                    }}
                    onKeyDown={e => {
                      bumpCountdown();   // reset on any key tap
                      if (e.key === 'Enter') handleSendEmail();
                    }}
                    disabled={view === 'email-sending'}
                    autoFocus
                  />
                  <button
                    className="btn btn-teal share-email-send-btn"
                    onClick={() => { bumpCountdown(); handleSendEmail(); }}
                    disabled={view === 'email-sending' || !email.trim()}
                  >
                    {view === 'email-sending'
                      ? <span className="spinner" style={{ width: 22, height: 22, borderWidth: 2 }} />
                      : 'Send →'}
                  </button>
                </div>
                {emailError && <p className="share-error">{emailError}</p>}

                <CountdownRing size={56} label={`Continuing in ${countdown}s`} />

                {/* Switch to QR option (only when both are enabled) */}
                {bothEnabled && (
                  <button
                    className="btn btn-ghost share-switch-btn"
                    onClick={handleSwitchToQR}
                  >
                    📱&nbsp; Show QR Code Instead
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {/* ── Footer: Done / Skip ─────────────────────────────────────── */}
        {view !== 'email-sent' && (
          <div className="share-footer">
            <button
              className="btn btn-ghost btn-md share-done-btn share-done-illuminated"
              onClick={() => { bumpCountdown(); goThankyou(); }}
            >
              {view === 'idle' ? 'No Thanks, Skip \u2192' : 'Done \u2192'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
