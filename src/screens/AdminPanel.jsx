import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { ReactSortable } from 'react-sortablejs';
import EventModal from './EventModal';
import { isMobile, hasFFmpeg, hasTranscription } from '../services/platform';
import '../styles/admin.css';

/* ─────────────────────────────────────────────────────────────────────────────
   Constants & Helpers
───────────────────────────────────────────────────────────────────────────── */
const TRANSITION_OPTIONS = [
  { value: 'crossfade',     label: 'Smooth Crossfade' },
  { value: 'hard-cut',      label: 'Hard Cut' },
  { value: 'fade-to-black', label: 'Fade to Black' },
  { value: 'wipe',          label: 'Wipe' },
];

const TAG_OPTIONS = ['all', 'wedding', 'birthday', 'family', 'friends', 'anniversary', 'graduation'];

const SENTIMENT_OPTIONS = [
  { value: 'all',      label: 'All Sentiments' },
  { value: 'positive', label: '😊 Positive' },
  { value: 'negative', label: '😔 Negative' },
  { value: 'neutral',  label: '😐 Neutral' },
];

function sentimentColor(sentiment) {
  if (!sentiment) return 'var(--text-muted)';
  const s = sentiment.toLowerCase();
  if (s === 'positive') return 'var(--green-400)';
  if (s === 'negative') return 'var(--rose-400)';
  return 'var(--text-secondary)';
}

function sentimentIcon(sentiment) {
  if (!sentiment) return '●';
  const s = sentiment.toLowerCase();
  if (s === 'positive') return '▲';
  if (s === 'negative') return '▼';
  return '●';
}

function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return '--:--';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatDate(isoOrMs) {
  if (!isoOrMs) return '';
  try {
    return new Date(isoOrMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return ''; }
}

function PlaceholderThumb({ size = 64 }) {
  return (
    <div style={{
      width: '100%', aspectRatio: '16/9', background: 'var(--glass-md)',
      borderRadius: 'var(--radius-sm)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      border: '1px solid var(--glass-border)', flexShrink: 0,
    }}>
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.5">
        <path d="M15 10l4.553-2.069A1 1 0 0121 8.845v6.31a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
      </svg>
    </div>
  );
}

function Toggle({ value, onChange, label, description }) {
  return (
    <div className="toggle-row" onClick={() => onChange(!value)} role="switch" aria-checked={value} tabIndex={0}
      onKeyDown={e => {
        // Only handle Space/Enter when the toggle itself (or its own children) is the target,
        // NOT when a textarea/input inside the same section fires a bubbled keydown.
        if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
        if (e.key === ' ' || e.key === 'Enter') onChange(!value);
      }}>
      <div className="toggle-row-info">
        <div className="toggle-row-label">{label}</div>
        {description && <div className="toggle-row-desc">{description}</div>}
      </div>
      <div className={`toggle${value ? ' on' : ''}`} aria-hidden="true" />
    </div>
  );
}

function SliderRow({ label, value, min, max, step = 1, unit = 's', onChange }) {
  return (
    <div className="form-row">
      <div className="form-label">{label}</div>
      <div className="slider-row">
        <input type="range" className="admin-slider" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} />
        <span className="slider-value">{value}{unit}</span>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   Custom Prompts Editor
   Keeps a raw string in local state so the user can type freely (spaces,
   blank lines, mid-word characters) without React clobbering the cursor.
   The array is only computed and saved to parent state on onBlur.
───────────────────────────────────────────────────────────────────────────── */
function CustomPromptsEditor({ value, onChange }) {
  // Initialise rawText from the saved array once on mount / when value length changes.
  // We do NOT re-derive rawText from `value` on every render — that would stomp the cursor.
  const [rawText, setRawText] = React.useState(() => (value || []).join('\n'));

  // When the saved array changes externally (e.g. settings reload), sync raw text —
  // but only if the textarea is not currently focused to avoid stomping an active edit.
  const textareaRef = React.useRef(null);
  React.useEffect(() => {
    if (document.activeElement !== textareaRef.current) {
      setRawText((value || []).join('\n'));
    }
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Parse raw text → array of non-blank trimmed lines and save to parent. */
  const commitToParent = (text) => {
    const lines = text
      .split('\n')
      .map(l => l.trim())
      .filter(l => l !== '');
    onChange(lines);
  };

  const savedCount = (value || []).length;

  return (
    <div className="custom-prompts-area">
      <label className="form-label" style={{ marginBottom: 6 }}>
        Custom Topic Prompts{' '}
        <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(one per line)</span>
      </label>
      <textarea
        ref={textareaRef}
        className="admin-textarea"
        rows={6}
        placeholder={"Share a favourite memory with the happy couple! 💍\nWhat's your best advice for the birthday star? 🎂\nTell us something funny that only you would know! 😄"}
        value={rawText}
        onChange={e => setRawText(e.target.value)}
        onBlur={e => commitToParent(e.target.value)}
        onKeyDown={e => {
          // Stop ALL key events from bubbling to parent Toggle rows or global handlers.
          // This is what allows Space and Enter to work normally inside the textarea.
          e.stopPropagation();
        }}
        spellCheck
        autoCorrect="on"
      />
      <div className="form-hint" style={{ marginTop: 4 }}>
        {savedCount} prompt{savedCount !== 1 ? 's' : ''} saved.{' '}
        Each non-blank line becomes one rotating prompt on the Attract Screen.
      </div>
    </div>
  );
}


/* ─────────────────────────────────────────────────────────────────────────────
   Dual-Handle Range Slider (iOS-style visual trimmer)
───────────────────────────────────────────────────────────────────────────── */
function DualRangeSlider({ min, max, start, end, onStartChange, onEndChange, step = 0.1 }) {
  const startPct = max > min ? ((start - min) / (max - min)) * 100 : 0;
  const endPct   = max > min ? ((end   - min) / (max - min)) * 100 : 100;
  return (
    <div className="dual-range-container">
      <div className="dual-range-track">
        <div className="dual-range-fill" style={{ left: `${startPct}%`, width: `${endPct - startPct}%` }} />
      </div>
      <input type="range" className="dual-range-input dual-range-start"
        min={min} max={max} step={step} value={start}
        onChange={e => { const v = Number(e.target.value); if (v < end - step) onStartChange(v); }} />
      <input type="range" className="dual-range-input dual-range-end"
        min={min} max={max} step={step} value={end}
        onChange={e => { const v = Number(e.target.value); if (v > start + step) onEndChange(v); }} />
      <div className="dual-range-labels">
        <span style={{ left: `${startPct}%` }}>{formatDuration(start)}</span>
        <span style={{ left: `${endPct}%`, transform: 'translateX(-100%)' }}>{formatDuration(end)}</span>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   PIN Gate
───────────────────────────────────────────────────────────────────────────── */
const MASTER_PIN = '0204';

function PinGate({ correctPin, onSuccess, onCancel }) {
  const [digits, setDigits]   = useState([]);
  const [error, setError]     = useState('');
  const [shaking, setShaking] = useState(false);

  const handleDigit = useCallback((d) => {
    if (digits.length >= 4) return;
    const next = [...digits, d];
    setDigits(next);
    setError('');
    if (next.length === 4) {
      setTimeout(() => {
        const entered = next.join('');
        if (entered === (correctPin || '1234') || entered === MASTER_PIN) {
          // Pass true if authenticated via master PIN
          onSuccess(entered === MASTER_PIN);
        } else {
          setShaking(true);
          setError('Incorrect PIN. Please try again.');
          setTimeout(() => { setDigits([]); setShaking(false); }, 480);
        }
      }, 120);
    }
  }, [digits, correctPin, onSuccess]);

  const handleBackspace = useCallback(() => {
    setDigits(prev => prev.slice(0, -1));
    setError('');
  }, []);

  useEffect(() => {
    const handler = (e) => {
      if (e.key >= '0' && e.key <= '9') handleDigit(e.key);
      if (e.key === 'Backspace') handleBackspace();
      if (e.key === 'Escape') onCancel?.();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleDigit, handleBackspace, onCancel]);

  const numKeys = ['1','2','3','4','5','6','7','8','9'];
  return (
    <div className="pin-gate-overlay">
      <div className={`pin-gate-card${shaking ? ' shake' : ''}`}>
        <div className="pin-gate-icon">🔐</div>
        <div>
          <div className="pin-gate-title">Admin Access</div>
          <div className="pin-gate-subtitle">Enter your 4-digit PIN to continue</div>
        </div>
        <div className="pin-dots">
          {[0,1,2,3].map(i => <div key={i} className={`pin-dot${digits.length > i ? ' filled' : ''}`} />)}
        </div>
        <div className="pin-error-msg">{error}</div>
        <div className="pin-numpad">
          {numKeys.map(k => (
            <button key={k} className="pin-key" onClick={() => handleDigit(k)} tabIndex={-1}>{k}</button>
          ))}
          <button className="pin-key pin-backspace" onClick={handleBackspace} tabIndex={-1}>⌫</button>
          <button className="pin-key pin-zero" onClick={() => handleDigit('0')} tabIndex={-1}>0</button>
        </div>
        {/* Back / Cancel button */}
        <button className="pin-cancel-btn" onClick={() => { setDigits([]); setError(''); onCancel?.(); }} tabIndex={-1}>
          ← Back to Kiosk
        </button>
      </div>
    </div>
  );
}


/* ─────────────────────────────────────────────────────────────────────────────
   TAB 1: Overview & Dashboard
───────────────────────────────────────────────────────────────────────────── */
function TabDashboard({ draft, setDraft, clips, navigateTo }) {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [resolvedClips, setResolvedClips] = useState(clips);
  const [storageDisplay, setStorageDisplay] = useState('—');
  const [pinInput,    setPinInput]    = useState('');
  const [pinSaved,    setPinSaved]    = useState(false);
  const [pinError,    setPinError]    = useState('');

  useEffect(() => { setResolvedClips(clips); }, [clips]);

  // Fetch total storage size via IPC
  useEffect(() => {
    if (!window.guestbook?.getTotalStorage) return;
    window.guestbook.getTotalStorage()
      .then(res => { if (res?.formatted) setStorageDisplay(res.formatted); })
      .catch(() => {});
  }, [clips]);

  useEffect(() => {
    if (!window.guestbook?.getFileDuration) return;
    let cancelled = false;
    async function probeMissing() {
      // Probe clips with missing OR zero duration (webm recorder saves 0 by default)
      const needsProbe = clips.filter(c => (!c.duration || c.duration === 0 || c.duration === '0:00') && c.path);
      if (needsProbe.length === 0) return;
      const updated = [...clips];
      for (const clip of needsProbe) {
        try {
          const dur = await window.guestbook.getFileDuration(clip.path);
          if (cancelled) return;
          if (dur > 0) {
            const idx = updated.findIndex(c => c.id === clip.id);
            if (idx !== -1) updated[idx] = { ...updated[idx], duration: dur };
          }
        } catch (_) {}
      }
      if (!cancelled) setResolvedClips([...updated]);
    }
    probeMissing();
    return () => { cancelled = true; };
  }, [clips]);

  useEffect(() => {
    const onOnline  = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online',  onOnline);
    window.addEventListener('offline', onOffline);
    return () => { window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); };
  }, []);

  // Robust duration parser: handles number (seconds), "M:SS", "H:MM:SS", or raw float string
  function parseDurSecs(raw) {
    if (raw === null || raw === undefined || raw === '') return 0;
    if (typeof raw === 'number') return isNaN(raw) ? 0 : raw;
    const s = String(raw).trim();
    if (s === '' || s === '0' || s === '0:00') return 0;
    if (s.includes(':')) {
      const parts = s.split(':').map(p => parseInt(p, 10));
      if (parts.some(isNaN)) return 0;
      if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
      if (parts.length === 2) return parts[0] * 60 + parts[1];
    }
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  }

  const totalDuration = resolvedClips.reduce((acc, c) => acc + parseDurSecs(c.duration), 0);

  // Format total: use H:MM:SS only when >= 1 hour
  function formatTotal(secs) {
    const s = Math.floor(secs);
    if (s < 3600) {
      const m = Math.floor(s / 60), sec = s % 60;
      return `${m}:${String(sec).padStart(2, '0')}`;
    }
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  const handleDeleteAll = async () => {
    if (!window.confirm(`Delete ALL ${clips.length} clips?\n\nThis action CANNOT be undone.`)) return;
    try { if (window.guestbook?.deleteAllClips) await window.guestbook.deleteAllClips(); }
    catch (e) { console.error('deleteAllClips error:', e); }
  };
  const handleOpenFolder = async () => {
    if (window.guestbook?.openClipsFolder) try { await window.guestbook.openClipsFolder(); } catch (e) {}
  };
  const handleChooseSavePath = async () => {
    if (!window.guestbook?.chooseSavePath) return;
    try {
      const res = await window.guestbook.chooseSavePath();
      if (res?.ok && res.path) {
        // Update draft immediately so the auto-save debounce persists the new path
        setDraft(d => ({ ...d, customSavePath: res.path }));
        setStorageDisplay('—'); // will refresh on next clips change
      }
    } catch (e) { console.error('chooseSavePath error:', e); }
  };

  return (
    <div className="tab-content">
      <div className="dash-grid">
        <div className="dash-card">
          <div className="dash-card-icon">🎥</div>
          <div>
            <div className="dash-card-value">{clips.length}</div>
            <div className="dash-card-label">Total Clips Recorded</div>
          </div>
        </div>
        <div className="dash-card">
          <div className="dash-card-icon">💾</div>
          <div>
            <div className="dash-card-value">{storageDisplay}</div>
            <div className="dash-card-label">Total Storage Used</div>
          </div>
        </div>
        <div className="dash-card">
          <div className="dash-card-icon">🌐</div>
          <div>
            <div style={{marginTop: 10}}>
              <span className={`dash-badge ${isOnline ? 'online' : 'offline'}`}>
                {isOnline ? '● System Online' : '● System Offline'}
              </span>
            </div>
            <div className="dash-card-label" style={{marginTop: 12}}>
              {isOnline ? 'QR & Email sharing are active.' : 'No internet. Sharing will be disabled.'}
            </div>
          </div>
        </div>
      </div>
      <div className="settings-section" style={{ marginTop: 16 }}>
        <div className="settings-section-title">Quick Actions & Storage</div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="admin-btn" onClick={() => navigateTo('attract')}>Launch Kiosk</button>
          <button className="admin-btn" onClick={handleOpenFolder}>Open Storage Folder</button>
          <button className="admin-btn" onClick={handleChooseSavePath}>📁 Choose Save Location</button>
          <button className="admin-btn danger" disabled={clips.length === 0} onClick={handleDeleteAll}>Delete All Clips</button>
        </div>
        <div className="form-hint" style={{ marginTop: 8 }}>
          <strong>Save Path:</strong> {draft.customSavePath || draft.savePath || 'Default App Storage'}
        </div>
      </div>

      {/* ── Security: Admin PIN ──────────────────────────────────────────── */}
      <div className="settings-section" style={{ marginTop: 16 }}>
        <div className="settings-section-title">🔒 Security — Admin PIN</div>
        <div className="form-row">
          <label className="form-label">Update PIN</label>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <input
              className="admin-input"
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={4}
              placeholder="New 4-digit PIN"
              value={pinInput}
              style={{ maxWidth: 160, letterSpacing: '0.3em', fontSize: '1.2rem' }}
              onKeyDown={e => e.stopPropagation()}
              onChange={e => {
                const val = e.target.value.replace(/\D/g, '').slice(0, 4);
                setPinInput(val);
                setPinSaved(false);
                setPinError('');
              }}
            />
            <button
              className="admin-btn primary small"
              disabled={pinInput.length !== 4}
              onClick={() => {
                if (pinInput.length !== 4) { setPinError('PIN must be exactly 4 digits.'); return; }
                setDraft(d => ({ ...d, pin: pinInput }));
                setPinSaved(true);
                setPinInput('');
                setPinError('');
                setTimeout(() => setPinSaved(false), 3000);
              }}
            >
              Save PIN
            </button>
          </div>
          {pinError && <div style={{ color: 'var(--rose-400)', fontSize: '0.85rem', marginTop: 4 }}>{pinError}</div>}
          {pinSaved && <div style={{ color: 'var(--green-400)', fontSize: '0.85rem', marginTop: 4 }}>✓ PIN updated and saved.</div>}
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 12px',
          background: 'rgba(139,92,246,0.08)',
          border: '1px solid rgba(139,92,246,0.2)',
          borderRadius: 'var(--radius-sm)',
          fontSize: '0.82rem', color: 'var(--text-secondary)',
        }}>
          <span style={{ fontSize: '1rem' }}>🛡️</span>
          <span>Master PIN: <strong style={{ color: 'var(--purple-300)', letterSpacing: '0.15em' }}>0204</strong> — always grants full access regardless of operator PIN.</span>
        </div>
        <div className="form-hint">Current operator PIN: <strong>{draft.pin ? '••••' : 'Default (1234)'}</strong></div>
      </div>
    </div>
  );
}


/* ─────────────────────────────────────────────────────────────────────────────
   TAB 2: Event & Hardware Settings
───────────────────────────────────────────────────────────────────────────── */
function TabEventSettings({ draft, setDraft }) {
  const [cameras, setCameras] = useState([]);
  const [mics, setMics]       = useState([]);
  const [camOnline, setCamOnline] = useState(null); // null=unknown, true=online, false=offline
  const [micOnline, setMicOnline] = useState(null);

  useEffect(() => {
    const enumerate = async () => {
      try {
        await navigator.mediaDevices.getUserMedia({ audio: true, video: true }).catch(() => {});
        const devices = await navigator.mediaDevices.enumerateDevices();
        setCameras(devices.filter(d => d.kind === 'videoinput'));
        setMics(devices.filter(d => d.kind === 'audioinput'));
        // Test actual camera availability
        try {
          const camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
          camStream.getTracks().forEach(t => t.stop());
          setCamOnline(true);
        } catch (_) { setCamOnline(false); }
        // Test actual mic availability
        try {
          const micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          micStream.getTracks().forEach(t => t.stop());
          setMicOnline(true);
        } catch (_) { setMicOnline(false); }
      } catch (e) { setCamOnline(false); setMicOnline(false); }
    };
    enumerate();
  }, []);

  return (
    <div className="tab-content settings-2col">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        <div className="settings-section">
          <div className="settings-section-title">Guest Features</div>
          <Toggle value={draft.enableReplay} onChange={v => setDraft(d => ({ ...d, enableReplay: v }))} label="Enable Replay" />
          <Toggle value={draft.enableQR} onChange={v => setDraft(d => ({ ...d, enableQR: v }))} label="Enable QR Code Sharing" />
          <Toggle value={draft.enableEmail} onChange={v => setDraft(d => ({ ...d, enableEmail: v }))} label="Enable Email Sharing" />
        </div>

        {/* ── AI Options & Settings ──────────────────────────────────────── */}
        <div className="settings-section settings-section-ai">
          <div className="settings-section-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>🤖</span> AI Options &amp; Settings
          </div>
          {hasTranscription() && (
            <Toggle
              value={draft.enableTranscription !== false}
              onChange={v => setDraft(d => ({ ...d, enableTranscription: v }))}
              label="Offline AI Transcriptions (Whisper)"
              description="Automatically transcribe each recording using the local Whisper model after it is saved. Requires FFmpeg and the Whisper model file."
            />
          )}
          <Toggle
            value={draft.enableSentiment !== false}
            onChange={v => setDraft(d => ({ ...d, enableSentiment: v }))}
            label="AI Sentiment & Keyword Tagging"
            description="Analyse the transcript to detect positive / neutral / negative sentiment and extract keywords. Only active when Transcription is also enabled."
          />
          <Toggle
            value={draft.enableGlam === true}
            onChange={v => setDraft(d => ({ ...d, enableGlam: v }))}
            label="✨ Enable GLAM Filter"
            description="Show a 'GLAM Mode' button on the Attract Screen. When tapped, applies a real-time skin-softening beauty filter to the recording via canvas compositing."
          />
          <Toggle
            value={draft.showTopicPrompts !== false}
            onChange={v => setDraft(d => ({ ...d, showTopicPrompts: v }))}
            label="Show AI Topic Prompts on Attract Screen"
            description="Display rotating conversation starter prompts on the Attract Screen to inspire guests before they record. Turn off to enter your own custom prompts below."
          />
          {draft.showTopicPrompts === false && (
            <CustomPromptsEditor
              value={draft.customPrompts || []}
              onChange={arr => setDraft(d => ({ ...d, customPrompts: arr }))}
            />
          )}

          {/* ── Prompt Styling ─────────────────────────────────────── */}
          <div className="settings-subsection">
            <div className="settings-subsection-title">🎨 Prompt Styling</div>
            <div className="settings-subsection-hint">
              Applies to both AI and Custom prompts on the Attract Screen.
            </div>

            {/* Text Color + Rainbow */}
            <div className="form-row" style={{ alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div className="form-label" style={{ minWidth: 110 }}>Text Color</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', flex: 1 }}>
                <input
                  type="color"
                  value={(draft.promptStyling || {}).color || '#ffffff'}
                  disabled={(draft.promptStyling || {}).rainbowAnimation}
                  style={{ width: 44, height: 36, border: 'none', borderRadius: 6, cursor: 'pointer',
                    opacity: (draft.promptStyling || {}).rainbowAnimation ? 0.4 : 1 }}
                  onChange={e => setDraft(d => ({ ...d, promptStyling: { ...(d.promptStyling || {}), color: e.target.value } }))}
                />
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: '0.88rem', color: 'var(--text-secondary)' }}>
                  <div
                    className={`toggle${(draft.promptStyling || {}).rainbowAnimation ? ' on' : ''}`}
                    style={{ flexShrink: 0 }}
                    onClick={() => setDraft(d => ({ ...d, promptStyling: { ...(d.promptStyling || {}), rainbowAnimation: !(d.promptStyling || {}).rainbowAnimation } }))}
                    role="switch"
                    aria-checked={(draft.promptStyling || {}).rainbowAnimation}
                  />
                  🌈 Rainbow / Color-Changing Animation
                </label>
              </div>
            </div>

            {/* Font Size */}
            <div className="form-row">
              <div className="form-label">Font Size</div>
              <div className="slider-row">
                <input type="range" className="admin-slider"
                  min={12} max={36} step={1}
                  value={(draft.promptStyling || {}).fontSize || 18}
                  onChange={e => setDraft(d => ({ ...d, promptStyling: { ...(d.promptStyling || {}), fontSize: Number(e.target.value) } }))}
                />
                <span className="slider-value">{(draft.promptStyling || {}).fontSize || 18}px</span>
              </div>
            </div>

            {/* Box Width */}
            <div className="form-row">
              <div className="form-label">Box Width</div>
              <div className="slider-row">
                <input type="range" className="admin-slider"
                  min={40} max={100} step={5}
                  value={(draft.promptStyling || {}).boxWidth || 80}
                  onChange={e => setDraft(d => ({ ...d, promptStyling: { ...(d.promptStyling || {}), boxWidth: Number(e.target.value) } }))}
                />
                <span className="slider-value">{(draft.promptStyling || {}).boxWidth || 80}%</span>
              </div>
            </div>

            {/* Bold */}
            <Toggle
              value={(draft.promptStyling || {}).bold === true}
              onChange={v => setDraft(d => ({ ...d, promptStyling: { ...(d.promptStyling || {}), bold: v } }))}
              label="Bold Text"
              description="Make the prompt text bold."
            />

            {/* Font Family */}
            <div className="form-row" style={{ alignItems: 'center' }}>
              <div className="form-label">Font Family</div>
              <select
                className="admin-select"
                value={(draft.promptStyling || {}).fontFamily || 'default'}
                onChange={e => setDraft(d => ({ ...d, promptStyling: { ...(d.promptStyling || {}), fontFamily: e.target.value } }))}
              >
                <option value="default" style={{ fontFamily: "'Outfit', sans-serif" }}>Default Sans (Outfit)</option>
                <option value="serif"   style={{ fontFamily: "Georgia, serif" }}>Elegant Serif (Georgia)</option>
                <option value="rounded" style={{ fontFamily: "'Nunito', sans-serif" }}>Playful Rounded (Nunito)</option>
                <option value="mono"    style={{ fontFamily: "'Courier New', monospace" }}>Modern Mono (Courier)</option>
                <option value="cursive" style={{ fontFamily: "'Dancing Script', cursive" }}>Script / Cursive (Dancing Script)</option>
              </select>
            </div>
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        <div className="settings-section">
          <div className="settings-section-title">Hardware</div>
          <div className="form-row">
            <label className="form-label">Mode</label>
            <select className="admin-select" value={draft.mode} onChange={e => setDraft(d => ({ ...d, mode: e.target.value }))}>
              <option value="video+audio">Video & Audio</option>
              <option value="audio">Audio Only</option>
            </select>
          </div>
          <div className="form-row" style={{ alignItems: 'center' }}>
            <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {camOnline !== null && (
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: camOnline ? '#22c55e' : '#ef4444', display: 'inline-block', boxShadow: camOnline ? '0 0 6px #22c55e' : '0 0 6px #ef4444' }} />
              )}
              Camera
            </label>
            <select className="admin-select" value={draft.cameraId} onChange={e => setDraft(d => ({ ...d, cameraId: e.target.value }))} disabled={draft.mode === 'audio'}>
              <option value="default">Default Camera</option>
              {cameras.map(c => <option key={c.deviceId} value={c.deviceId}>{c.label}</option>)}
            </select>
          </div>
          <div className="form-row" style={{ alignItems: 'center' }}>
            <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {micOnline !== null && (
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: micOnline ? '#22c55e' : '#ef4444', display: 'inline-block', boxShadow: micOnline ? '0 0 6px #22c55e' : '0 0 6px #ef4444' }} />
              )}
              Microphone
            </label>
            <select className="admin-select" value={draft.micId} onChange={e => setDraft(d => ({ ...d, micId: e.target.value }))}>
              <option value="default">Default Microphone</option>
              {mics.map(m => <option key={m.deviceId} value={m.deviceId}>{m.label}</option>)}
            </select>
          </div>
        </div>

        {/* ── Screen Orientation ──────────────────────────────────────────── */}
        <div className="settings-section">
          <div className="settings-section-title">📐 Screen Orientation</div>

          {/* Master orientation mode */}
          <div className="form-row">
            <label className="form-label">Orientation Mode</label>
            <select
              className="admin-select"
              value={draft.orientationMode || 'auto'}
              onChange={e => setDraft(d => ({ ...d, orientationMode: e.target.value }))}
            >
              <option value="auto">Auto (Device Native)</option>
              <option value="landscape">Force Landscape (16:9)</option>
              <option value="portrait">Force Portrait (9:16)</option>
            </select>
          </div>
          <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', padding: '0 0 8px 0', lineHeight: 1.5 }}>
            {(!draft.orientationMode || draft.orientationMode === 'auto') &&
              'Reads the device/OS orientation in real time. On tablets that rotate freely, the Camera Mismatch setting below will automatically correct the video when the screen enters Portrait mode.'}
            {draft.orientationMode === 'landscape' &&
              'Locks all screens to 16:9 widescreen regardless of device rotation.'}
            {draft.orientationMode === 'portrait' &&
              'Locks all screens to 9:16 vertical. Use the Camera Mismatch setting below to handle cameras that always deliver a landscape frame.'}
          </div>

          {/* Camera Mismatch — shown for Auto and Force Portrait (not needed when locked Landscape) */}
          {(draft.orientationMode === 'auto' || draft.orientationMode === 'portrait') && (
            <>
              <div className="form-row" style={{ marginTop: 4 }}>
                <label className="form-label">Camera Mismatch</label>
                <select
                  className="admin-select"
                  value={draft.cameraMismatch || 'letterbox'}
                  onChange={e => setDraft(d => ({ ...d, cameraMismatch: e.target.value }))}
                >
                  <option value="letterbox">Letterbox (Contain) — full frame, black bars</option>
                  <option value="centercrop">Center Crop (Cover) — fills vertical space</option>
                  <option value="rotate90cw">Rotate 90° Clockwise — camera mounted sideways (CW)</option>
                  <option value="rotate90ccw">Rotate 90° Counter-Clockwise — camera mounted sideways (CCW)</option>
                </select>
              </div>
              <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', padding: '0 0 4px 0', lineHeight: 1.5 }}>
                {(!draft.cameraMismatch || draft.cameraMismatch === 'letterbox') &&
                  'Shows the full video with black bars when portrait mode detects a landscape camera. Nothing is cropped.'}
                {draft.cameraMismatch === 'centercrop' &&
                  'Zooms to fill the portrait space. Left/right edges of the landscape feed are cropped.'}
                {draft.cameraMismatch === 'rotate90cw' &&
                  'Rotates the feed 90° clockwise. Use when the physical camera top is pointing to the right.'}
                {draft.cameraMismatch === 'rotate90ccw' &&
                  'Rotates the feed 90° counter-clockwise. Use when the physical camera top is pointing to the left.'}
              </div>
            </>
          )}
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Durations</div>
          <SliderRow label="Max Recording" value={draft.maxDuration} min={10} max={300} step={5} onChange={v => setDraft(d => ({ ...d, maxDuration: v }))} />
          <SliderRow label="Sharing Phase Timeout" value={draft.sharingTimeout} min={30} max={300} step={10} onChange={v => setDraft(d => ({ ...d, sharingTimeout: v }))} />
        </div>
      </div>

      {/* ── App Updates ─────────────────────────────────────────────────── */}
      {!isMobile() && (
        <AppUpdatesCard />
      )}
    </div>
  );
}


/* ── App Updates Card ────────────────────────────────────────────────────── */
function AppUpdatesCard() {
  const [appVersion,  setAppVersion]  = useState('…');
  const [upd,         setUpd]         = useState({ state: 'idle', version: null, progress: null, error: null });
  const [checking,    setChecking]    = useState(false);

  // Hydrate from main process on mount
  useEffect(() => {
    if (!window.guestbook?.getAppInfo) return;
    window.guestbook.getAppInfo().then(info => {
      if (info?.version) setAppVersion(info.version);
      if (info?.updateStatus) setUpd(info.updateStatus);
    }).catch(() => {});
  }, []);

  // Subscribe to live push updates from main process
  useEffect(() => {
    if (!window.guestbook?.onUpdateStatus) return;
    const unsub = window.guestbook.onUpdateStatus((status) => setUpd(status));
    return () => { if (typeof unsub === 'function') unsub(); };
  }, []);

  const handleCheck = async () => {
    setChecking(true);
    try { await window.guestbook.checkForUpdates?.(); } catch (_) {}
    setChecking(false);
  };
  const handleInstall = () => window.guestbook.installUpdate?.();

  /* Status pill */
  const STATUS_MAP = {
    idle:          { label: 'Idle',                color: 'var(--text-muted)',    icon: '○' },
    checking:      { label: 'Checking…',           color: '#fbbf24',             icon: '⟳' },
    available:     { label: `Update available`,    color: '#34d399',             icon: '↓' },
    'not-available': { label: 'App is up to date', color: '#2dd4bf',             icon: '✓' },
    downloading:   { label: `Downloading…`,        color: '#60a5fa',             icon: '↓' },
    downloaded:    { label: 'Ready to install!',   color: '#a78bfa',             icon: '✦' },
    error:         { label: 'Update error',        color: 'var(--rose-400)',      icon: '!' },
  };
  const pill = STATUS_MAP[upd.state] || STATUS_MAP.idle;
  const statusLabel = upd.state === 'available'
    ? `v${upd.version} available`
    : upd.state === 'downloaded'
      ? `v${upd.version} ready`
      : upd.state === 'downloading' && upd.progress
        ? `Downloading… ${upd.progress.percent}%`
        : pill.label;

  return (
    <div className="settings-section" style={{ borderTop: '1px solid var(--glass-border)', marginTop: 0 }}>
      <div className="settings-section-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>🔄</span> App Updates
      </div>

      {/* Version row */}
      <div className="form-row" style={{ alignItems: 'center' }}>
        <label className="form-label">Current Version</label>
        <span style={{ fontWeight: 700, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums', fontSize: '1rem' }}>
          v{appVersion}
        </span>
      </div>

      {/* Status row */}
      <div className="form-row" style={{ alignItems: 'center' }}>
        <label className="form-label">Status</label>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '4px 12px', borderRadius: 'var(--radius-full)',
          background: `${pill.color}18`, border: `1px solid ${pill.color}44`,
          color: pill.color, fontWeight: 600, fontSize: '0.82rem', letterSpacing: '0.04em',
        }}>
          {pill.icon}&nbsp;{statusLabel}
        </span>
      </div>

      {/* Error detail */}
      {upd.state === 'error' && upd.error && (
        <div style={{ fontSize: '0.8rem', color: 'var(--rose-400)', padding: '4px 0 0 0', opacity: 0.8 }}>
          {upd.error}
        </div>
      )}

      {/* Download progress bar */}
      {upd.state === 'downloading' && upd.progress && (
        <div style={{ marginTop: 4 }}>
          <div style={{ width: '100%', height: 6, background: 'var(--glass-md)', borderRadius: 'var(--radius-full)', overflow: 'hidden' }}>
            <div style={{
              height: '100%', width: `${upd.progress.percent}%`,
              background: 'linear-gradient(90deg, #60a5fa, #2dd4bf)',
              borderRadius: 'var(--radius-full)', transition: 'width 0.5s linear',
            }} />
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4 }}>
            {(upd.progress.transferred / 1048576).toFixed(1)} / {(upd.progress.total / 1048576).toFixed(1)} MB
            &nbsp;·&nbsp;{(upd.progress.bytesPerSecond / 1024).toFixed(0)} KB/s
          </div>
        </div>
      )}

      {/* Check button */}
      {upd.state !== 'downloaded' && (
        <button
          className="admin-btn"
          style={{ alignSelf: 'flex-start', marginTop: 4 }}
          onClick={handleCheck}
          disabled={checking || upd.state === 'checking' || upd.state === 'downloading'}
        >
          {checking || upd.state === 'checking' ? '⟳ Checking…' : '⟳ Check for Updates'}
        </button>
      )}

      {/* Restart banner — only when update is downloaded */}
      {upd.state === 'downloaded' && (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 10,
          padding: '14px 18px',
          background: 'linear-gradient(135deg, rgba(139,92,246,0.12), rgba(45,212,191,0.08))',
          border: '1px solid rgba(139,92,246,0.35)',
          borderRadius: 'var(--radius-md)', marginTop: 4,
        }}>
          <div style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: '0.95rem' }}>
            🎉 My Guestbook v{upd.version} is ready!
          </div>
          <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
            The update has been downloaded. Restart the app to apply it.
          </div>
          <button
            className="admin-btn success"
            style={{
              alignSelf: 'flex-start',
              background: 'linear-gradient(135deg, var(--purple-500), var(--teal-400))',
              color: '#fff', fontWeight: 700, border: 'none',
              boxShadow: '0 4px 20px rgba(139,92,246,0.4)',
            }}
            onClick={handleInstall}
          >
            ⚡ Restart &amp; Apply Update
          </button>
        </div>
      )}
    </div>
  );
}


/* ─────────────────────────────────────────────────────────────────────────────
   Intro / Outro Config Modal (with media-upload tab)
───────────────────────────────────────────────────────────────────────────── */
function TitleCardModal({ title, config, setConfig, onApply, onClose }) {
  const [mode, setMode] = useState(config.mediaPath ? 'media' : 'text');

  const handleMediaUpload = async () => {
    if (!window.guestbook?.chooseMediaFile) return;
    const res = await window.guestbook.chooseMediaFile('any');
    if (res?.path) { setConfig(c => ({ ...c, mediaPath: res.path })); setMode('media'); }
  };

  return (
    <div className="ed-modal-overlay" onClick={onClose}>
      <div className="ed-modal-box" onClick={e => e.stopPropagation()}>
        <div className="ed-modal-header">
          <span style={{ fontWeight: 700 }}>{title}</span>
          <button className="ed-modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="title-card-tabs">
          <button className={`title-card-tab${mode === 'text' ? ' active' : ''}`} onClick={() => setMode('text')}>✏️ Text & Color</button>
          <button className={`title-card-tab${mode === 'media' ? ' active' : ''}`} onClick={() => setMode('media')}>🖼️ Upload Media</button>
        </div>

        {mode === 'text' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 16 }}>
            <div className="form-row">
              <label className="form-label">Title Text</label>
              <input className="admin-input" placeholder="e.g. Sarah & James — Wedding Day" value={config.text || ''}
                onChange={e => setConfig(c => ({ ...c, text: e.target.value }))} />
            </div>
            <div className="form-row">
              <label className="form-label">Background Color</label>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <input type="color" value={config.color || '#1a1a2e'}
                  onChange={e => setConfig(c => ({ ...c, color: e.target.value }))}
                  style={{ width: 48, height: 48, border: 'none', borderRadius: 8, cursor: 'pointer' }} />
                <div style={{ flex: 1, height: 48, borderRadius: 8, background: config.color || '#1a1a2e', border: '1px solid var(--glass-border)' }} />
              </div>
            </div>
            <SliderRow label="Slide Duration" value={config.duration || 3} min={1} max={10} step={0.5}
              onChange={v => setConfig(c => ({ ...c, duration: v }))} />
          </div>
        )}

        {mode === 'media' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 16 }}>
            <div className="title-card-upload-zone" onClick={handleMediaUpload}>
              {config.mediaPath ? (
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '2rem', marginBottom: 8 }}>✅</div>
                  <div style={{ color: 'var(--teal-400)', fontWeight: 600, wordBreak: 'break-all', fontSize: '0.85rem' }}>
                    {config.mediaPath.split(/[/\\]/).pop()}
                  </div>
                  <div className="form-hint" style={{ marginTop: 4 }}>Click to change file</div>
                </div>
              ) : (
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '2.5rem', marginBottom: 8 }}>📁</div>
                  <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>Click to upload</div>
                  <div className="form-hint">Supports .mp4, .jpg, .png</div>
                </div>
              )}
            </div>
            {config.mediaPath && (
              <button className="admin-btn small danger" onClick={() => setConfig(c => ({ ...c, mediaPath: null }))}>✕ Remove Media</button>
            )}
            <SliderRow label="Slide Duration" value={config.duration || 3} min={1} max={10} step={0.5}
              onChange={v => setConfig(c => ({ ...c, duration: v }))} />
          </div>
        )}
        <button className="admin-btn success-variant" style={{ marginTop: 20, width: '100%' }} onClick={onApply}>Apply</button>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   Visual Trim Modal (iOS-style: video player + dual-handle slider)
───────────────────────────────────────────────────────────────────────────── */
function VisualTrimModal({ item, initialStart, initialEnd, onApply, onClose }) {
  const clip     = item.clip;
  const duration = clip.duration || 60;
  const [trimStart, setTrimStart] = useState(initialStart);
  const [trimEnd, setTrimEnd]     = useState(initialEnd);
  const videoRef = useRef(null);
  const [activeHandle, setActiveHandle] = useState('start');

  useEffect(() => {
    if (!videoRef.current) return;
    videoRef.current.currentTime = activeHandle === 'end' ? trimEnd : trimStart;
  }, [trimStart, trimEnd, activeHandle]);

  return (
    <div className="ed-modal-overlay" onClick={onClose}>
      <div className="ed-modal-box trim-modal-wide" onClick={e => e.stopPropagation()}>
        <div className="ed-modal-header">
          <span style={{ fontWeight: 700 }}>✂️ Trim: {clip.filename || clip.id}</span>
          <button className="ed-modal-close" onClick={onClose}>✕</button>
        </div>

        <video ref={videoRef} src={clip.path}
          style={{ width: '100%', borderRadius: 8, background: '#000', maxHeight: '42vh', display: 'block' }}
          onLoadedMetadata={e => { e.target.currentTime = trimStart; }} />

        <div style={{ marginTop: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            <span>Start: <strong style={{ color: 'var(--teal-400)' }}>{formatDuration(trimStart)}</strong></span>
            <span style={{ color: 'var(--text-muted)' }}>Total: {formatDuration(duration)}</span>
            <span>End: <strong style={{ color: 'var(--rose-400)' }}>{formatDuration(trimEnd)}</strong></span>
          </div>
          <DualRangeSlider min={0} max={duration} step={0.1}
            start={trimStart} end={trimEnd}
            onStartChange={v => { setActiveHandle('start'); setTrimStart(v); }}
            onEndChange={v => { setActiveHandle('end'); setTrimEnd(v); }} />
        </div>

        <div style={{ padding: '10px 16px', borderRadius: 8, background: 'rgba(20,184,166,0.1)', border: '1px solid rgba(20,184,166,0.3)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: 'var(--text-secondary)' }}>Retained</span>
          <strong style={{ color: 'var(--teal-400)', fontSize: '1.1rem' }}>{formatDuration(trimEnd - trimStart)}</strong>
          <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            {duration > 0 ? Math.round(((trimEnd - trimStart) / duration) * 100) : 100}% of original
          </span>
        </div>

        <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
          <button className="admin-btn" style={{ flex: 1 }} onClick={() => { setTrimStart(0); setTrimEnd(duration); }}>Reset</button>
          <button className="admin-btn" style={{ flex: 1 }} onClick={() => { if (videoRef.current) { videoRef.current.currentTime = trimStart; videoRef.current.play(); } }}>▶ Play</button>
          <button className="admin-btn success-variant" style={{ flex: 1 }} onClick={() => onApply(trimStart, trimEnd)}>Apply Trim</button>
        </div>
      </div>
    </div>
  );
}


/* ─────────────────────────────────────────────────────────────────────────────
   TAB 3: Video Editor (Timeline)
───────────────────────────────────────────────────────────────────────────── */
function TabVideoEditor({ clips: savedClips, draft, refreshClips }) {
  const [timeline, setTimeline]                     = useState([]);
  const [transitions, setTransitions]               = useState([]);
  const [transitionDurations, setTransitionDurations] = useState([]);
  const tlItemCounter = useRef(0);

  // Export
  const [exporting, setExporting]           = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportStatus, setExportStatus]     = useState('');
  const [quality, setQuality]               = useState('1080p');
  const unsubProgressRef = useRef(null);

  // Preview compilation (removed — feature deleted)
  // Clip source preview modal (kept — lets user watch a clip before adding to timeline)
  const [previewClip, setPreviewClip] = useState(null);

  // External imports
  const [externalClips, setExternalClips] = useState([]);
  const allClips = [...savedClips, ...externalClips];

  // Intro / Outro
  const [showIntroEditor, setShowIntroEditor] = useState(false);
  const [showOutroEditor, setShowOutroEditor] = useState(false);
  const [introConfig, setIntroConfig] = useState({ text: '', color: '#1a1a2e', duration: 3, mediaPath: null });
  const [outroConfig, setOutroConfig] = useState({ text: '', color: '#1a1a2e', duration: 3, mediaPath: null });
  const [hasIntro, setHasIntro] = useState(false);
  const [hasOutro, setHasOutro] = useState(false);

  // Audio
  const [bgMusicPath, setBgMusicPath]     = useState(null);
  const [bgMusicVolume, setBgMusicVolume] = useState(10);
  const [normalizeAudio, setNormalizeAudio] = useState(false);

  // Trim
  const [trimTarget, setTrimTarget] = useState(null);
  const [trimMap, setTrimMap]       = useState({});

  // Gallery multi-select
  const [selectedIds, setSelectedIds] = useState(new Set());
  const toggleSelectClip = (id) => setSelectedIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const selectAll = () => setSelectedIds(new Set(allClips.map(c => c.id)));
  const clearSelection = () => setSelectedIds(new Set());
  const addSelectedToTimeline = () => {
    allClips.filter(c => selectedIds.has(c.id)).forEach(addToTimeline);
    clearSelection();
  };
  const deleteSelected = async () => {
    if (selectedIds.size === 0) return;
    if (!window.confirm(`Move ${selectedIds.size} selected clip(s) to the Recycle Bin?`)) return;
    const deletedIds = new Set();
    for (const id of selectedIds) {
      if (id.startsWith('ext-')) {
        setExternalClips(prev => prev.filter(c => c.id !== id));
        deletedIds.add(id);
      } else {
        try {
          const res = await window.guestbook.deleteClip(id);
          if (res?.ok) deletedIds.add(id);
        } catch (_) {}
      }
    }
    // Immediately remove deleted clips from local state (UI sync)
    if (deletedIds.size > 0) refreshClips?.();
    setSelectedIds(new Set());
  };

  // Duration probing — resolve accurate durations for clips with duration ≤0
  const [durationMap, setDurationMap] = useState({});
  useEffect(() => {
    const probe = async () => {
      if (!window.guestbook?.getFileDuration) return;
      const missing = allClips.filter(c => !c.duration || c.duration <= 0);
      if (missing.length === 0) return;
      const updates = {};
      for (const clip of missing) {
        if (!clip.path) continue;
        try {
          const dur = await window.guestbook.getFileDuration(clip.path);
          if (dur > 0) updates[clip.id] = dur;
        } catch (_) {}
      }
      if (Object.keys(updates).length > 0) {
        setDurationMap(prev => ({ ...prev, ...updates }));
      }
    };
    probe();
  // Re-probe whenever the clip list changes length (new imports)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allClips.length]);

  const getClipDuration = (clip) => durationMap[clip.id] ?? clip.duration ?? 0;

  const timelineClipIds = new Set(timeline.filter(i => i.type === 'clip').map(i => i.clip.id));

  const clipCount = timeline.filter(i => i.type === 'clip').length;
  const totalDuration = timeline.reduce((acc, item) => {
    if (item.type === 'clip') { const tr = trimMap[item.id]; return acc + (tr ? tr.end - tr.start : item.clip.duration || 0); }
    if (item.type === 'title') return acc + (item.duration || 3);
    return acc;
  }, 0);

  // ── Add / Remove ───────────────────────────────────────────────────────────
  const addToTimeline = (clip) => {
    tlItemCounter.current += 1;
    const newItem = { id: `tl-${clip.id}-${tlItemCounter.current}`, type: 'clip', clip };
    setTimeline(prev => {
      const next = [...prev, newItem];
      if (next.length > 1) { setTransitions(t => [...t, draft.defaultTransition || 'crossfade']); setTransitionDurations(d => [...d, 1.0]); }
      return next;
    });
  };

  const removeFromTimeline = (itemId) => {
    setTimeline(prev => {
      const idx = prev.findIndex(x => x.id === itemId);
      if (idx === -1) return prev;
      const next = prev.filter(x => x.id !== itemId);
      const at = Math.min(idx === 0 ? 0 : idx - 1, Math.max(0, transitions.length - 1));
      if (transitions.length > 0) { setTransitions(t => { const c=[...t]; c.splice(at,1); return c; }); setTransitionDurations(d => { const c=[...d]; c.splice(at,1); return c; }); }
      return next;
    });
    setTrimMap(prev => { const n = { ...prev }; delete n[itemId]; return n; });
  };

  const handleSortableSet = (newOrder) => {
    setTimeline(prev => {
      const oldIds = prev.map(x => x.id), newIds = newOrder.map(x => x.id);
      setTransitions(t => { if (!t.length) return t; const m=new Map(); for(let i=0;i<oldIds.length-1;i++) m.set(`${oldIds[i]}|${oldIds[i+1]}`,t[i]); return newIds.slice(0,-1).map((id,i)=>m.get(`${id}|${newIds[i+1]}`)||draft.defaultTransition||'crossfade'); });
      setTransitionDurations(d => { if (!d.length) return d; const m=new Map(); for(let i=0;i<oldIds.length-1;i++) m.set(`${oldIds[i]}|${oldIds[i+1]}`,d[i]); return newIds.slice(0,-1).map((id,i)=>m.get(`${id}|${newIds[i+1]}`)||1.0); });
      return newOrder;
    });
  };

  // ── Import External ────────────────────────────────────────────────────────
  const handleImportExternal = async () => {
    if (!window.guestbook?.importExternalMedia) return;
    // The main process now returns a full clip metadata object (with
    // thumbnail, duration, filePath) rather than a bare file path string.
    const clip = await window.guestbook.importExternalMedia();
    if (clip && clip.id) {
      setExternalClips(prev => [...prev, clip]);
    }
  };

  // ── Music ──────────────────────────────────────────────────────────────────
  const handleChooseMusic = async () => {
    if (!window.guestbook?.chooseMusicFile) return;
    const res = await window.guestbook.chooseMusicFile();
    if (res) setBgMusicPath(res);
  };

  // ── Build payload ──────────────────────────────────────────────────────────
  const buildPayload = () => {
    const clipItems = timeline.filter(i => i.type === 'clip');
    const clipIds   = clipItems.map(i => i.clip.id);
    const transitionValues = transitions.slice(0, Math.max(0, clipIds.length - 1));
    const trimData = clipItems.reduce((acc, item) => { if (trimMap[item.id]) acc[item.clip.id] = trimMap[item.id]; return acc; }, {});
    const externalClipPaths = externalClips.reduce((acc, c) => { acc[c.id] = c.path; return acc; }, {});
    return {
      clipIds, transitionValues,
      options: {
        quality, transitionDurations: transitionDurations.slice(0, Math.max(0, clipIds.length - 1)),
        normalizeAudio, bgMusicPath, bgMusicVolume: bgMusicVolume / 100,
        intro: hasIntro ? introConfig : null, outro: hasOutro ? outroConfig : null,
        trimData, externalClipPaths,
      },
    };
  };

  // ── Export ─────────────────────────────────────────────────────────────────
  const handleExport = async () => {
    if (exporting || timeline.length === 0) return;
    try {
      const filePath = await window.guestbook.openSaveDialog('guestbook_compilation.mp4');
      if (!filePath) return;
      setExporting(true); setExportProgress(0); setExportStatus('Compiling...');
      if (window.guestbook.onStitchProgress) {
        unsubProgressRef.current = window.guestbook.onStitchProgress((data) => {
          const pct = typeof data === 'number' ? data : data?.pct ?? 0;
          setExportProgress(Math.max(0, Math.min(100, pct)));
          if (pct >= 100) setExportStatus('Done!');
        });
      }
      const { clipIds, transitionValues, options } = buildPayload();
      const res = await window.guestbook.stitchClips(clipIds, transitionValues, filePath, options);
      if (res?.ok) setExportStatus('Saved successfully!'); else setExportStatus('Error: ' + (res?.error || 'Failed'));
    } catch (e) { setExportStatus('Error: ' + (e.message || 'Unknown error')); }
    finally { setExporting(false); if (unsubProgressRef.current) { unsubProgressRef.current(); unsubProgressRef.current = null; } }
  };


  return (
    <div className="tab-content editor-split">

      {/* Clip source preview modal */}
      {previewClip && (
        <div className="ed-modal-overlay" onClick={() => setPreviewClip(null)}>
          <div className="ed-modal-box" onClick={e => e.stopPropagation()}>
            <div className="ed-modal-header">
              <span style={{ fontWeight: 700 }}>▶ Preview: {previewClip.filename || previewClip.id}</span>
              <button className="ed-modal-close" onClick={() => setPreviewClip(null)}>✕</button>
            </div>
            <video src={previewClip.path} controls autoPlay style={{ width: '100%', borderRadius: 8, background: '#000', maxHeight: '60vh' }} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
              <button className="admin-btn primary" onClick={() => { addToTimeline(previewClip); setPreviewClip(null); }}>+ Add to Timeline</button>
            </div>
          </div>
        </div>
      )}

      {/* Intro modal */}
      {showIntroEditor && (
        <TitleCardModal title="✨ Intro Title Card" config={introConfig} setConfig={setIntroConfig}
          onApply={() => { setHasIntro(true); setShowIntroEditor(false); }} onClose={() => setShowIntroEditor(false)} />
      )}

      {/* Outro modal */}
      {showOutroEditor && (
        <TitleCardModal title="🙏 Outro Title Card" config={outroConfig} setConfig={setOutroConfig}
          onApply={() => { setHasOutro(true); setShowOutroEditor(false); }} onClose={() => setShowOutroEditor(false)} />
      )}

      {/* Visual trim modal */}
      {trimTarget && (
        <VisualTrimModal item={trimTarget}
          initialStart={trimMap[trimTarget.id]?.start || 0}
          initialEnd={trimMap[trimTarget.id]?.end || (trimTarget.clip.duration || 60)}
          onApply={(start, end) => { setTrimMap(prev => ({ ...prev, [trimTarget.id]: { start, end } })); setTrimTarget(null); }}
          onClose={() => setTrimTarget(null)} />
      )}

      {/* Export error inline banner */}
      {exportStatus.startsWith('Error') && (
        <div className="editor-error-banner" role="alert">
          <span className="editor-error-icon">⚠️</span>
          <span className="editor-error-msg">{exportStatus}</span>
          <button className="editor-error-dismiss" onClick={() => setExportStatus('')} title="Dismiss error">✕</button>
        </div>
      )}

      {/* ── Audio Enhancement Toolbar (compact, above Source Clips) ──────── */}
      <div className="ed-audio-toolbar">
        <span className="ed-audio-toolbar-label">🎵 Audio</span>

        {/* MP3 chooser */}
        <div className="ed-audio-group">
          <button className="admin-btn small" onClick={handleChooseMusic}>Choose MP3</button>
          {bgMusicPath && (
            <>
              <span className="ed-audio-filename">{bgMusicPath.split(/[/\\]/).pop()}</span>
              <button className="admin-btn small danger" onClick={() => setBgMusicPath(null)}>✕</button>
            </>
          )}
        </div>

        {/* Volume slider — only shown when a file is chosen */}
        {bgMusicPath && (
          <div className="ed-audio-group">
            <span className="ed-audio-hint">Vol: {bgMusicVolume}%</span>
            <input
              type="range" className="admin-slider ed-audio-slider"
              min={0} max={100} step={5}
              value={bgMusicVolume}
              onChange={e => setBgMusicVolume(Number(e.target.value))}
            />
          </div>
        )}

        {/* Normalization toggle */}
        <div className="ed-audio-group ed-audio-toggle-group">
          <Toggle
            value={normalizeAudio}
            onChange={setNormalizeAudio}
            label="Normalize"
            description="Balance guest volumes"
          />
        </div>
      </div>

      {/* ── Source Clips ─────────────────────────────────────────────────── */}
      <div className="ed-gallery-top">
        {/* Header row */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <h3 className="settings-section-title">Source Clips</h3>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{allClips.length} clip{allClips.length !== 1 ? 's' : ''}</span>
            <button className="admin-btn small" onClick={selectAll} disabled={allClips.length === 0}>Select All</button>
            {selectedIds.size > 0 && (
              <>
                <span style={{ fontSize: '0.85rem', color: 'var(--teal-400)', fontWeight: 600 }}>{selectedIds.size} selected</span>
                <button className="admin-btn small" onClick={addSelectedToTimeline}>+ Add Selected</button>
                <button className="admin-btn small danger" onClick={deleteSelected}>🗑 Delete Selected</button>
                <button className="admin-btn small" onClick={clearSelection} style={{ opacity: 0.7 }}>✕ Clear</button>
              </>
            )}
            <button className="admin-btn small primary" onClick={handleImportExternal}>⬆ Import Media</button>
            {isMobile() ? (
              <button
                className="admin-btn small"
                onClick={() => window.guestbook?.openClipsFolder?.()}
                title="Share Clips"
              >📤 Share Clips</button>
            ) : (
              <button
                className="admin-btn small"
                onClick={() => window.guestbook?.openClipsFolder()}
                title="Open the save folder in File Explorer"
              >📂 Open Save Folder</button>
            )}
          </div>
        </div>
        {/* Clip grid */}
        <div className="ed-clip-grid">
          {allClips.length === 0 && <div style={{ color: 'var(--text-muted)', gridColumn: '1/-1' }}>No clips yet. Record a guest message or import external media.</div>}
          {allClips.map(clip => {
            const inTl     = timelineClipIds.has(clip.id);
            const selected = selectedIds.has(clip.id);
            return (
              <div key={clip.id} className={`ed-small-card${selected ? ' ed-card-selected' : ''}`}>
                {/* Checkbox overlay */}
                <div className="ed-card-checkbox" onClick={e => { e.stopPropagation(); toggleSelectClip(clip.id); }}>
                  <div className={`ed-checkbox${selected ? ' checked' : ''}`}>{selected ? '✓' : ''}</div>
                </div>
                <div style={{ position: 'relative' }} onClick={() => setPreviewClip(clip)} className="ed-thumb-clickable">
                  {clip.thumbnail ? <img src={clip.thumbnail} className="ed-small-thumb" /> : <PlaceholderThumb size={32} />}
                  <div className="ed-play-overlay"><span className="ed-play-btn">▶</span></div>
                  {/* Duration badge bottom-left */}
                  {getClipDuration(clip) > 0 && (
                    <div className="ed-dur-badge">{formatDuration(getClipDuration(clip))}</div>
                  )}
                  {inTl && <div className="ed-in-timeline-overlay"><span>Added</span></div>}
                  {clip.isExternal && <div className="ed-external-badge">Imported</div>}
                </div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {clip.filename || formatDate(clip.createdAt)}
                </div>
                <button className="admin-btn small" onClick={() => addToTimeline(clip)}>+ Add</button>
              </div>
            );
          })}
        </div>
      </div>

      {hasFFmpeg() && (
        <>
          {/* ── Sticky Action Bar (Compile / Export / Quality) ──────────────── */}
          <div className="ed-sticky-bar">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontWeight: 700, fontSize: '0.95rem' }}>🎬 Timeline</span>
              <span style={{ fontSize: '0.82rem', color: 'var(--teal-400)', fontWeight: 600 }}>
                {clipCount} clip{clipCount !== 1 ? 's' : ''} · {formatDuration(totalDuration)} total
                {exportStatus && <span style={{ marginLeft: 10, color: exportStatus.startsWith('Error') ? 'var(--rose-400)' : 'var(--green-400)' }}>· {exportStatus}</span>}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="admin-btn small" onClick={() => setShowIntroEditor(true)}
                style={{ borderColor: hasIntro ? 'var(--teal-400)' : undefined, color: hasIntro ? 'var(--teal-400)' : undefined }}>
                {hasIntro ? '✓ Intro' : '+ Intro'}
              </button>
              <button className="admin-btn small" onClick={() => setShowOutroEditor(true)}
                style={{ borderColor: hasOutro ? 'var(--teal-400)' : undefined, color: hasOutro ? 'var(--teal-400)' : undefined }}>
                {hasOutro ? '✓ Outro' : '+ Outro'}
              </button>
              <button className="admin-btn small" onClick={() => { setTimeline([]); setTransitions([]); setTransitionDurations([]); setTrimMap({}); setHasIntro(false); setHasOutro(false); }}>Clear</button>
              <select className="admin-select" style={{ width: 120, padding: '6px 10px' }} value={quality} onChange={e => setQuality(e.target.value)}>
                <option value="1080p">1080p Full HD</option>
                <option value="720p">720p Fast</option>
              </select>
              <button className="admin-btn primary small" disabled={exporting || timeline.length === 0} onClick={handleExport}>
                {exporting ? `Compiling ${exportProgress.toFixed(0)}%…` : 'Compile & Export'}
              </button>
            </div>
          </div>

          {/* Progress bar — shown below sticky bar while exporting */}
          {exporting && (
            <div className="progress-bar-bg" style={{ borderRadius: 0, margin: '0 0 4px' }}>
              <div className="progress-bar-fill" style={{ width: `${exportProgress}%` }} />
            </div>
          )}
        </>
      )}

      {/* Bottom Timeline */}
      <div className="ed-timeline-bottom">
        <div className="timeline-track">
          <ReactSortable list={timeline} setList={handleSortableSet} handle=".tl-drag-handle" animation={200} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            {timeline.map((item, index) => {
              if (item.type === 'title') {
                return (
                  <div key={item.id} className="tl-slot">
                    <div className="tl-item tl-title-card" style={{ background: item.color || '#1a1a2e' }}>
                      <div className="tl-drag-handle">≡</div>
                      <button className="tl-remove" onClick={() => removeFromTimeline(item.id)}>×</button>
                      <div style={{ fontSize: '0.7rem', textAlign: 'center', padding: '4px 2px', color: '#fff', fontWeight: 700, wordBreak: 'break-word' }}>
                        📝 {item.text || 'Title Card'}
                      </div>
                      <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.6)', textAlign: 'center' }}>{item.duration}s</div>
                    </div>
                    {index < timeline.length - 1 && (
                      <div className="tl-transition">
                        <select value={transitions[index] || 'crossfade'} onChange={e => { const t=[...transitions]; t[index]=e.target.value; setTransitions(t); }}>
                          {TRANSITION_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                        </select>
                        <select value={transitionDurations[index] || 1.0} onChange={e => { const d=[...transitionDurations]; d[index]=Number(e.target.value); setTransitionDurations(d); }}>
                          <option value={0.5}>0.5s</option><option value={1.0}>1.0s</option><option value={1.5}>1.5s</option>
                        </select>
                      </div>
                    )}
                  </div>
                );
              }
              const hasTrim = !!trimMap[item.id];
              return (
                <div key={item.id} className="tl-slot">
                  <div className="tl-item" style={{ borderColor: hasTrim ? 'var(--teal-400)' : undefined }}>
                    <div className="tl-drag-handle">≡</div>
                    <button className="tl-remove" onClick={() => removeFromTimeline(item.id)}>×</button>
                    {item.clip.thumbnail ? <img src={item.clip.thumbnail} className="tl-thumb" /> : <PlaceholderThumb size={20} />}
                    <div className="tl-dur-badge">
                      {hasTrim
                        ? <span style={{ color: 'var(--teal-400)' }}>✂ {formatDuration(trimMap[item.id].start)}–{formatDuration(trimMap[item.id].end)}</span>
                        : formatDuration(getClipDuration(item.clip))}
                    </div>
                    <button className="tl-trim-btn" onClick={() => setTrimTarget(item)} title="Trim clip">✂</button>
                  </div>
                  {index < timeline.length - 1 && (
                    <div className="tl-transition">
                      <select value={transitions[index] || draft.defaultTransition || 'crossfade'} onChange={e => { const t=[...transitions]; t[index]=e.target.value; setTransitions(t); }}>
                        {TRANSITION_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                      </select>
                      <select value={transitionDurations[index] || 1.0} onChange={e => { const d=[...transitionDurations]; d[index]=Number(e.target.value); setTransitionDurations(d); }}>
                        <option value={0.5}>0.5s</option><option value={1.0}>1.0s</option><option value={1.5}>1.5s</option>
                      </select>
                    </div>
                  )}
                </div>
              );
            })}
          </ReactSortable>
          {timeline.length === 0 && (
            <div style={{ color: 'var(--text-muted)', margin: 'auto', textAlign: 'center' }}>
              Timeline is empty.<br />Add clips from the gallery above or set an Intro / Outro.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


/* ─────────────────────────────────────────────────────────────────────────────
   TAB 4: AI Insights
───────────────────────────────────────────────────────────────────────────── */
function TabAIInsights({ clips, refreshClips }) {
  const [filterTag, setFilterTag]             = useState('all');
  const [filterSentiment, setFilterSentiment] = useState('all');
  const [search, setSearch]                   = useState('');

  useEffect(() => {
    if (!window.guestbook?.onTranscriptionDone) return;
    const unsub = window.guestbook.onTranscriptionDone(() => refreshClips?.());
    return () => { if (typeof unsub === 'function') unsub(); };
  }, [refreshClips]);

  const handleDelete = async (id) => {
    if (!window.confirm('Permanently delete this clip and its files from disk?')) return;
    try {
      const res = await window.guestbook.deleteClip(id);
      if (res?.ok) {
        refreshClips?.();
      } else {
        alert('Delete failed: ' + (res?.error || 'Unknown error'));
      }
    } catch (err) {
      alert('Delete error: ' + err.message);
    }
  };
  const handleTranscribe = async (id) => {
    if (window.guestbook?.transcribeClip) await window.guestbook.transcribeClip(id);
  };

  const filtered = clips.filter(c => {
    const tMatch    = filterTag === 'all' || (c.tags && c.tags.includes(filterTag));
    const sMatch    = filterSentiment === 'all' || (c.sentiment && c.sentiment.toLowerCase() === filterSentiment);
    const textMatch = search === '' || (c.transcript && c.transcript.toLowerCase().includes(search.toLowerCase()));
    return tMatch && sMatch && textMatch;
  });

  return (
    <div className="tab-content" style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%', overflow: 'hidden' }}>
      {/* ── Compact search + filter header ── */}
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 6,
        padding: '10px 14px', background: 'var(--glass-sm)',
        border: '1px solid var(--glass-border)', borderRadius: 'var(--radius-md)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <input
            className="admin-input"
            style={{ flex: 1, minWidth: 160, padding: '7px 12px', fontSize: '0.88rem' }}
            placeholder="Search transcripts..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <select
            className="admin-select"
            style={{ width: 140, padding: '7px 10px', fontSize: '0.88rem' }}
            value={filterSentiment}
            onChange={e => setFilterSentiment(e.target.value)}
          >
            {SENTIMENT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div className="filter-chips" style={{ margin: 0, padding: 0, gap: 6 }}>
          {['all', 'wedding', 'birthday', 'family', 'friends', 'anniversary', 'graduation'].map(tag => (
            <button
              key={tag}
              className={`filter-chip ${filterTag === tag ? 'active' : ''}`}
              style={{ padding: '3px 10px', fontSize: '0.78rem' }}
              onClick={() => setFilterTag(tag)}
            >
              {tag === 'all' ? 'All Tags' : tag}
            </button>
          ))}
        </div>
      </div>

      {/* ── Clip gallery — takes remaining height ── */}
      <div className="insights-feed" style={{ overflowY: 'auto', flex: 1, minHeight: 0, paddingRight: 8 }}>
        {filtered.map(clip => (
          <div key={clip.id} className="insight-card">
            <div className="insight-thumb">
              {clip.thumbnail ? <img src={clip.thumbnail} alt="" /> : <PlaceholderThumb size={48} />}
            </div>
            <div className="insight-content">
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{formatDate(clip.createdAt)} • {formatDuration(clip.duration)}</span>
                <span style={{ color: sentimentColor(clip.sentiment), fontWeight: 600 }}>{sentimentIcon(clip.sentiment)} {clip.sentiment || 'Unknown'}</span>
              </div>
              <div className="insight-transcript">
                {clip.transcript ? `"${clip.transcript}"` : <span style={{ color: 'var(--text-muted)' }}>{clip.transcript === null ? 'Transcribing...' : 'No transcript'}</span>}
              </div>
              <div className="insight-actions">
                <div className="insight-tags">{clip.tags?.map(t => <span key={t} className="insight-tag">{t}</span>)}</div>
                <div style={{ flex: 1 }} />
                {!clip.transcript && clip.transcript !== '' && <button className="admin-btn small" onClick={() => handleTranscribe(clip.id)}>Transcribe</button>}
                <button className="admin-btn small danger" onClick={() => handleDelete(clip.id)}>Delete</button>
              </div>
            </div>
          </div>
        ))}
        {filtered.length === 0 && <div style={{ color: 'var(--text-muted)', textAlign: 'center', marginTop: 32 }}>No clips match your filters.</div>}
      </div>
    </div>
  );
}


/* ─────────────────────────────────────────────────────────────────────────────
   Attract Screen Live Preview  (pixel-perfect CSS transform: scale clone)
───────────────────────────────────────────────────────────────────────────── */
const TITLE_FONT_MAP_PREV = {
  default:   "'Outfit', sans-serif",
  serif:     "Georgia, serif",
  rounded:   "'Nunito', sans-serif",
  mono:      "'Courier New', monospace",
  cursive:   "'Dancing Script', cursive",
  display:   "'Playfair Display', serif",
  condensed: "'Barlow Condensed', sans-serif",
};

/* Background fit map — identical logic to AttractScreen.jsx */
const BG_FIT_MAP_PREV = {
  fill:    { objectFit: 'cover',   objectPosition: 'center' },
  fit:     { objectFit: 'contain', objectPosition: 'center' },
  stretch: { objectFit: 'fill',    objectPosition: 'center' },
  center:  { objectFit: 'none',    objectPosition: 'center' },
};

function AttractScreenPreview({ draft }) {
  const wrapRef  = useRef(null);
  const [containerW, setContainerW] = useState(400);
  const [landscape, setLandscape]   = useState(true);

  // Track container width for scale computation
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setContainerW(el.offsetWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Virtual canvas dimensions switch with orientation
  const VIRT_W = landscape ? 1280 : 720;
  const VIRT_H = landscape ? 720  : 1280;

  // Scale to fit inside the fixed container width
  const scale       = containerW / VIRT_W;
  // Physical height the outer clip div should occupy
  const physHeight  = Math.round(scale * VIRT_H);

  const ts        = draft.titleStyling || {};
  const fontFam   = TITLE_FONT_MAP_PREV[ts.fontFamily] || TITLE_FONT_MAP_PREV.default;
  const fontSize  = `${ts.fontSize || 56}px`;
  const color     = ts.color || '#ffffff';
  const colorAnim = ts.colorAnimate === true;
  const floatAnim = ts.textAnimate  === true;
  const bgFit     = BG_FIT_MAP_PREV[draft.attractBgFit] || BG_FIT_MAP_PREV.fit;

  const hasBg   = !!draft.attractBgPath;
  const isVideo = draft.attractBgType === 'video';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* ── Header row: label + orientation toggle ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
        <div style={{
          fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.12em',
          textTransform: 'uppercase', color: 'var(--text-muted)',
        }}>
          Live Preview — Attract Screen
        </div>
        {/* Orientation toggle */}
        <div style={{ display: 'flex', background: 'var(--glass-md)', borderRadius: 20, padding: 2, gap: 2, border: '1px solid var(--glass-border)' }}>
          {[
            { label: '⬛ Landscape', value: true  },
            { label: '📱 Portrait',  value: false },
          ].map(({ label, value }) => (
            <button
              key={String(value)}
              onClick={() => setLandscape(value)}
              style={{
                padding: '4px 10px', borderRadius: 18, border: 'none', cursor: 'pointer',
                fontSize: '0.72rem', fontWeight: 600, fontFamily: 'inherit',
                background: landscape === value ? 'var(--purple-500)' : 'transparent',
                color: landscape === value ? '#fff' : 'var(--text-secondary)',
                transition: 'all 0.2s',
              }}
            >{label}</button>
          ))}
        </div>
      </div>

      {/* ── Outer clip: fixed physical height, clips the scaled canvas ── */}
      <div
        ref={wrapRef}
        style={{
          width: '100%',
          height: `${physHeight}px`,
          position: 'relative',
          overflow: 'hidden',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--glass-border)',
          boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
          /* Smooth height transition when orientation toggles */
          transition: 'height 0.35s cubic-bezier(0.4,0,0.2,1)',
        }}
      >
        {/* Virtual VIRT_W × VIRT_H canvas — scaled to fit */}
        <div style={{
          width:  `${VIRT_W}px`,
          height: `${VIRT_H}px`,
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
          position: 'absolute',
          top: 0, left: 0,
          background: hasBg && !isVideo
            ? undefined
            : 'linear-gradient(135deg, #0a0a1e 0%, #1a0a2e 50%, #0a1a0e 100%)',
          overflow: 'hidden',
        }}>

          {/* Background image — uses same fit logic as real screen */}
          {hasBg && !isVideo && (
            <img
              src={`file://${draft.attractBgPath}`}
              alt=""
              style={{
                position: 'absolute', inset: 0,
                width: '100%', height: '100%',
                opacity: 0.85,
                ...bgFit,
              }}
            />
          )}

          {/* Background video — live preview (muted, looping) */}
          {hasBg && isVideo && (
            <video
              src={`file://${draft.attractBgPath}`}
              autoPlay muted loop playsInline
              style={{
                position: 'absolute', inset: 0,
                width: '100%', height: '100%',
                opacity: 0.85,
                ...bgFit,
              }}
            />
          )}

          {/* Dark overlay */}
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.38)', zIndex: 1 }} />

          {/* Particles (static dots for preview) */}
          {[...Array(8)].map((_, i) => (
            <div key={i} style={{
              position: 'absolute',
              left:    `${(i * 13 + 7) % 100}%`,
              top:     `${(i * 17 + 11) % 100}%`,
              width:   `${4 + (i % 4) * 2}px`,
              height:  `${4 + (i % 4) * 2}px`,
              borderRadius: '50%',
              background:   i % 2 ? 'rgba(139,92,246,0.35)' : 'rgba(45,212,191,0.3)',
              filter: 'blur(1px)',
              zIndex: 2,
            }} />
          ))}

          {/* Content */}
          {draft.showAttractText !== false && (
            <div style={{
              position: 'absolute', inset: 0, zIndex: 3,
              display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center',
              gap: 32, padding: landscape ? '60px 120px' : '80px 60px',
            }}>
              {/* Keyframes */}
              <style>{`
                @keyframes prevColorCycle {
                  0%   { color: hsl(270,80%,80%); }
                  20%  { color: hsl(180,70%,75%); }
                  40%  { color: hsl(340,80%,80%); }
                  60%  { color: hsl(40,90%,75%);  }
                  80%  { color: hsl(210,70%,80%); }
                  100% { color: hsl(270,80%,80%); }
                }
                @keyframes prevFloat {
                  0%,100% { transform: translateY(0px) scale(1); }
                  50%     { transform: translateY(-10px) scale(1.015); }
                }
              `}</style>

              <span style={{
                fontSize: 18, letterSpacing: '0.25em', textTransform: 'uppercase',
                color: 'rgba(255,255,255,0.55)', fontWeight: 500,
              }}>✨ Welcome to ✨</span>

              <h1 style={{
                margin: 0,
                fontFamily:  fontFam,
                fontSize:    fontSize,
                fontWeight:  700,
                lineHeight:  1.2,
                textAlign:   'center',
                whiteSpace:  'pre-wrap',
                wordBreak:   'break-word',
                textShadow:  '0 2px 24px rgba(0,0,0,0.6)',
                maxWidth:    '80%',
                color:     colorAnim ? undefined : color,
                animation: colorAnim
                  ? 'prevColorCycle 6s ease-in-out infinite'
                  : floatAnim
                    ? 'prevFloat 4s ease-in-out infinite'
                    : 'none',
              }}>
                {draft.eventName || 'My Guestbook'}
              </h1>

              <p style={{ margin: 0, fontSize: 22, color: 'rgba(255,255,255,0.55)', letterSpacing: '0.04em' }}>
                Leave a lasting memory
              </p>

              <div style={{ flex: 1 }} />

              <div style={{
                padding: '22px 60px',
                background: 'linear-gradient(135deg, #8b5cf6, #6d28d9)',
                borderRadius: 100,
                color: '#fff', fontSize: 26, fontWeight: 700, letterSpacing: '0.06em',
                boxShadow: '0 0 40px rgba(139,92,246,0.6)',
                textAlign: 'center',
              }}>
                🎙️&nbsp;&nbsp;{draft.tapCtaText || 'Tap anywhere to leave a message'}
              </div>
            </div>
          )}
        </div>

        {/* Orientation badge */}
        <div style={{
          position: 'absolute', bottom: 6, right: 8, zIndex: 10,
          fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.08em',
          textTransform: 'uppercase', color: 'rgba(255,255,255,0.45)',
          background: 'rgba(0,0,0,0.45)', padding: '2px 7px', borderRadius: 8,
        }}>
          {landscape ? '16:9' : '9:16'}
        </div>
      </div>
    </div>
  );
}


/* ─────────────────────────────────────────────────────────────────────────────
   Main AdminPanel
───────────────────────────────────────────────────────────────────────────── */
function TabBranding({ draft, setDraft }) {
  const handleChooseImage = async () => {
    if (!window.guestbook?.chooseMediaFile) return;
    try { const res = await window.guestbook.chooseMediaFile('image'); if (res?.path) setDraft(d => ({ ...d, attractBgPath: res.path, attractBgType: 'image' })); } catch (e) {}
  };
  const handleChooseVideo = async () => {
    if (!window.guestbook?.chooseMediaFile) return;
    try { const res = await window.guestbook.chooseMediaFile('video'); if (res?.path) setDraft(d => ({ ...d, attractBgPath: res.path, attractBgType: 'video' })); } catch (e) {}
  };

  return (
    <div className="tab-content">
      <div style={{ display: 'flex', gap: 28, alignItems: 'flex-start', width: '100%' }}>
        {/* LEFT: All controls */}
        <div style={{ flex: '1 1 400px', minWidth: 300, display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div className="settings-section">
            <div className="settings-section-title">Branding</div>
            <div className="form-row">
              <label className="form-label">Event Name</label>
              <textarea
                className="admin-input"
                rows={2}
                style={{ resize: 'vertical', whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}
                value={draft.eventName || ''}
                placeholder="Event Name (Shift+Enter for new line)"
                onChange={e => setDraft(d => ({ ...d, eventName: e.target.value }))}
                onKeyDown={e => {
                  e.stopPropagation();
                  // Allow Shift+Enter for line breaks; prevent Enter-only from submitting
                  if (e.key === 'Enter' && !e.shiftKey) e.preventDefault();
                }}
              />
            </div>

            {/* ── Title Typography Controls ── */}
            <div className="settings-subsection-title" style={{ marginTop: 8 }}>🔤 Title Typography</div>
            <div className="form-row">
              <label className="form-label">Font</label>
              <select
                className="admin-select"
                value={(draft.titleStyling || {}).fontFamily || 'default'}
                onChange={e => setDraft(d => ({ ...d, titleStyling: { ...(d.titleStyling || {}), fontFamily: e.target.value } }))}
              >
                {[
                  { value: 'default',   label: 'Default (Outfit)',         css: "'Outfit', sans-serif" },
                  { value: 'serif',     label: 'Classic Serif (Georgia)',   css: 'Georgia, serif' },
                  { value: 'rounded',   label: 'Playful (Nunito)',          css: "'Nunito', sans-serif" },
                  { value: 'mono',      label: 'Monospace (Courier)',       css: "'Courier New', monospace" },
                  { value: 'cursive',   label: 'Script (Dancing Script)',   css: "'Dancing Script', cursive" },
                  { value: 'display',   label: 'Display (Playfair)',        css: "'Playfair Display', serif" },
                  { value: 'condensed', label: 'Condensed (Barlow)',        css: "'Barlow Condensed', sans-serif" },
                ].map(f => (
                  <option key={f.value} value={f.value} style={{ fontFamily: f.css }}>{f.label}</option>
                ))}
              </select>
            </div>
            <div className="form-row" style={{ alignItems: 'center' }}>
              <label className="form-label">Font Size</label>
              <input
                type="range" min={24} max={120} step={2}
                value={(draft.titleStyling || {}).fontSize || 56}
                onChange={e => setDraft(d => ({ ...d, titleStyling: { ...(d.titleStyling || {}), fontSize: Number(e.target.value) } }))}
                style={{ flex: 1 }}
              />
              <span className="slider-value">{(draft.titleStyling || {}).fontSize || 56}px</span>
            </div>
            <div className="form-row" style={{ alignItems: 'center' }}>
              <label className="form-label">Title Color</label>
              <input
                type="color"
                value={(draft.titleStyling || {}).color || '#ffffff'}
                onChange={e => setDraft(d => ({ ...d, titleStyling: { ...(d.titleStyling || {}), color: e.target.value } }))}
                style={{ width: 44, height: 36, border: 'none', background: 'none', cursor: 'pointer', borderRadius: 6 }}
              />
              <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginLeft: 8 }}>{(draft.titleStyling || {}).color || '#ffffff'}</span>
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: '0.88rem', color: 'var(--text-secondary)' }}>
                <input
                  type="checkbox"
                  checked={(draft.titleStyling || {}).colorAnimate === true}
                  onChange={e => setDraft(d => ({ ...d, titleStyling: { ...(d.titleStyling || {}), colorAnimate: e.target.checked } }))}
                />
                🌈 Color Animation
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: '0.88rem', color: 'var(--text-secondary)' }}>
                <input
                  type="checkbox"
                  checked={(draft.titleStyling || {}).textAnimate === true}
                  onChange={e => setDraft(d => ({ ...d, titleStyling: { ...(d.titleStyling || {}), textAnimate: e.target.checked } }))}
                />
                🌊 Float Animation
              </label>
            </div>

            <div className="form-row">
              <label className="form-label">Background Media</label>
              <div style={{ display: 'flex', gap: 12 }}>
                <button className="admin-btn small" onClick={handleChooseImage}>Select Image</button>
                <button className="admin-btn small" onClick={handleChooseVideo}>Select Video</button>
                {draft.attractBgPath && <button className="admin-btn small danger" onClick={() => setDraft(d => ({ ...d, attractBgPath: null }))}>Clear</button>}
              </div>
              {draft.attractBgPath && <div className="form-hint" style={{ wordBreak: 'break-all', marginTop: 4 }}>{draft.attractBgPath}</div>}
            </div>

            {/* ── Background Display Mode ── */}
            <div className="form-row">
              <label className="form-label">Background Display</label>
              <select
                className="admin-select"
                value={draft.attractBgFit || 'fit'}
                onChange={e => setDraft(d => ({ ...d, attractBgFit: e.target.value }))}
              >
                <option value="fill">Fill — cover entire screen (may crop)</option>
                <option value="fit">Fit — show whole image (default, no crop)</option>
                <option value="stretch">Stretch — distort to fill all space</option>
                <option value="center">Center — original size, centered</option>
              </select>
              <div className="form-hint">
                {({ fill: 'Image/video fills the screen edge-to-edge. Sides may be cropped.',
                    fit:  'Entire image shown without cropping. Letterbox bars may appear.',
                    stretch: 'Image is stretched to fill all space. Aspect ratio not preserved.',
                    center: 'Image shown at its original pixel size, centered on screen.',
                  }[draft.attractBgFit || 'fit'])}
              </div>
            </div>

            <Toggle
              value={draft.showAttractText !== false}
              onChange={v => setDraft(d => ({ ...d, showAttractText: v }))}
              label="Display Attract Screen Text & Title"
              description="Show event title, subtitle, and topic prompts on the attract screen. Turn off for a clean background-only display."
            />
            <div className="form-row">
              <label className="form-label">CTA Button Text</label>
              <input
                className="admin-input"
                type="text"
                placeholder="Tap anywhere to leave a message"
                value={draft.tapCtaText || ''}
                onChange={e => setDraft(d => ({ ...d, tapCtaText: e.target.value }))}
                onKeyDown={e => e.stopPropagation()}
              />
            </div>
          </div>
        </div>
        {/* RIGHT: Live Preview */}
        <div style={{ flex: '1 1 380px', minWidth: 280, position: 'sticky', top: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <AttractScreenPreview draft={draft} />
        </div>
      </div>
    </div>
  );
}

const TABS = [
  { id: 'dash',     label: 'Overview', icon: '📊' },
  { id: 'event',    label: 'Settings', icon: '⚙️' },
  { id: 'branding', label: 'Branding', icon: '🎨' },
  { id: 'editor',   label: 'Editor',   icon: '🎬' },
  { id: 'insights', label: 'Insights', icon: '🧠' },
];

export default function AdminPanel({ active }) {
  const { settings, updateSettings, navigateTo, clips, refreshClips,
          events, activeEventId, reloadFromEvent } = useApp();
  const [unlocked,       setUnlocked]       = useState(false);
  const [isMaster,       setIsMaster]       = useState(false);  // true = authenticated via master PIN
  const [draft,          setDraft]           = useState(() => ({ ...settings }));
  const [activeTab,      setActiveTab]       = useState('dash');
  const [showEventModal, setShowEventModal]  = useState(false);
  // Auto-save state: 'saved' | 'saving' | 'error'
  const [saveStatus,     setSaveStatus]      = useState('saved');
  const saveTimerRef   = useRef(null);
  const isFirstRender  = useRef(true);

  // Active event metadata (for the event bar)
  const activeEvent = (events || []).find(e => e.id === activeEventId) || null;

  useEffect(() => {
    if (!active) {
      const t = setTimeout(() => {
        setUnlocked(false);
        setIsMaster(false);   // clear master status when session ends
      }, 800);
      return () => clearTimeout(t);
    } else { refreshClips?.(); }
  }, [active, refreshClips]);

  // Sync draft when settings change from outside (e.g. on mount)
  useEffect(() => { setDraft({ ...settings }); }, [settings]);

  // Debounced auto-save: fires 1.2s after any draft change
  useEffect(() => {
    if (isFirstRender.current) { isFirstRender.current = false; return; }
    setSaveStatus('saving');
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      try {
        await updateSettings(draft);
        setSaveStatus('saved');
      } catch (e) {
        setSaveStatus('error');
      }
    }, 1200);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  return (
    <div className={`screen admin-screen${active ? ' active' : ''}`}>
      {!unlocked && active && (
        <PinGate
          correctPin={draft.pin || '1234'}
          onSuccess={(masterUsed) => { setIsMaster(masterUsed); setUnlocked(true); }}
          onCancel={() => navigateTo('attract')}
        />
      )}
      <div className="admin-panel">
        <header className="admin-header">
          <div className="admin-header-left">
            <div className="admin-header-icon">🛡️</div>
            <div>
              <div className="admin-header-title">Admin Panel</div>
              <div className="admin-header-subtitle">{draft.eventName || 'My Guestbook'}</div>
            </div>
          </div>
          <div className="admin-header-actions">
            {isMaster && (
              <span style={{
                fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.1em',
                padding: '3px 10px', borderRadius: 20,
                background: 'rgba(139,92,246,0.18)', border: '1px solid rgba(139,92,246,0.35)',
                color: 'var(--purple-300)', textTransform: 'uppercase',
              }}>Master Access</span>
            )}
            <button className="admin-btn" onClick={() => navigateTo('attract')}>Exit Admin</button>
            {!isMobile() && (
              <button
                className="admin-btn"
                style={{ background: 'rgba(244,63,94,0.18)', border: '1px solid rgba(244,63,94,0.4)', color: 'var(--rose-400)' }}
                onClick={() => {
                  if (window.confirm('Are you sure you want to quit the application?')) {
                    window.guestbook?.quitApp();
                  }
                }}
              >⏻ Exit App</button>
            )}
          </div>
        </header>

        {/* ── Active Event Bar ────────────────────────────────────── */}
        <div className="event-bar">
          <div className="event-bar-left">
            <span className="event-bar-dot" />
            <div className="event-bar-info">
              <span className="event-bar-label">Active Event</span>
              <span className="event-bar-name">
                {activeEvent?.name || draft.eventName || 'My Guestbook'}
              </span>
            </div>
            {activeEvent?.date && (
              <span className="event-bar-date">
                📅 {new Date(activeEvent.date).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}
              </span>
            )}
            <span className="event-bar-clip-count">
              🎬 {(clips || []).length} clip{(clips || []).length !== 1 ? 's' : ''}
            </span>
          </div>
          <div className="event-bar-actions">
            <button
              className="admin-btn small"
              onClick={() => setShowEventModal(true)}
              title="Manage all events"
            >
              🗂️ Manage Events
            </button>
            <button
              className="admin-btn primary small"
              onClick={() => { setShowEventModal(true); }}
              title="Create a new event"
            >
              + New Event
            </button>
          </div>
        </div>

        <nav className="admin-tabs">
          {TABS.map(tab => {
            const isEditorLocked = tab.id === 'editor' && !isMaster;
            return (
              <button
                key={tab.id}
                className={`tab-btn${activeTab === tab.id ? ' active' : ''}${isEditorLocked ? ' tab-locked' : ''}`}
                onClick={() => { if (!isEditorLocked) setActiveTab(tab.id); }}
                title={isEditorLocked ? 'Master PIN required to access the Editor' : undefined}
                aria-disabled={isEditorLocked}
              >
                <span>{tab.icon}</span> {tab.label}
                {isEditorLocked && <span className="tab-lock-icon">🔒</span>}
              </button>
            );
          })}
        </nav>
        <div className="admin-content">
          {/* All tabs always mounted — CSS display toggles preserve React state */}
          <div style={{ display: activeTab === 'dash' ? undefined : 'none' }}>
            <TabDashboard draft={draft} setDraft={setDraft} clips={clips} navigateTo={navigateTo} />
          </div>
          <div style={{ display: activeTab === 'event' ? undefined : 'none' }}>
            <TabEventSettings draft={draft} setDraft={setDraft} />
          </div>
          <div style={{ display: activeTab === 'branding' ? undefined : 'none' }}>
            <TabBranding draft={draft} setDraft={setDraft} />
          </div>
          {/* Editor tab only rendered for master sessions */}
          <div style={{ display: activeTab === 'editor' && isMaster ? undefined : 'none', height: '100%' }}>
            <TabVideoEditor clips={clips} draft={draft} refreshClips={refreshClips} />
          </div>
          <div style={{ display: activeTab === 'insights' ? undefined : 'none', height: '100%' }}>
            <TabAIInsights clips={clips} refreshClips={refreshClips} />
          </div>
        </div>
        <footer className="admin-footer">
          {/* Auto-save runs silently — only surface errors */}
          <div className="autosave-indicator">
            {saveStatus === 'error' && (
              <span style={{ color: 'var(--rose-400)' }}>
                <span className="autosave-dot error" />
                Save failed — check connection
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="admin-btn" onClick={() => navigateTo('attract')}>Exit Admin</button>
            {!isMobile() && (
              <button
                className="admin-btn"
                style={{ background: 'rgba(244,63,94,0.18)', border: '1px solid rgba(244,63,94,0.4)', color: 'var(--rose-400)' }}
                onClick={() => {
                  if (window.confirm('Are you sure you want to quit the application?')) {
                    window.guestbook?.quitApp();
                  }
                }}
              >⏻ Exit App</button>
            )}
          </div>
        </footer>
      </div>

      {/* Event Manager modal — rendered outside admin-panel so it overlays fully */}
      {showEventModal && (
        <EventModal onClose={() => setShowEventModal(false)} />
      )}
    </div>
  );
}
