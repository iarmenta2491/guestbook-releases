/**
 * src/screens/EventModal.jsx
 * Full-screen Event Manager modal — Create events and browse/switch between them.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { useApp } from '../context/AppContext';

// ── Helpers ────────────────────────────────────────────────────────────────
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function formatDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }); }
  catch { return iso; }
}

function formatRelative(iso) {
  if (!iso) return '';
  const ms   = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86400000);
  if (days === 0)  return 'Today';
  if (days === 1)  return 'Yesterday';
  if (days < 7)   return `${days} days ago`;
  if (days < 30)  return `${Math.floor(days / 7)} weeks ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)}y ago`;
}

// ── Main Component ─────────────────────────────────────────────────────────
export default function EventModal({ onClose }) {
  const { events, activeEventId, reloadFromEvent } = useApp();
  const [tab, setTab] = useState('browse'); // 'browse' | 'create'

  // ── Create tab state ───────────────────────────────────────────────────
  const [createName,   setCreateName]   = useState('');
  const [createDate,   setCreateDate]   = useState(todayISO());
  const [cloneSettings, setCloneSettings] = useState(true);
  const [creating,     setCreating]     = useState(false);
  const [createError,  setCreateError]  = useState('');

  // ── Browse tab state ──────────────────────────────────────────────────
  const [localEvents,  setLocalEvents]  = useState(events || []);
  const [activating,   setActivating]   = useState(null);  // eventId being activated
  const [deleteTarget, setDeleteTarget] = useState(null);  // eventId pending confirm
  const [deleting,     setDeleting]     = useState(false);

  // Keep local copy fresh when parent events updates
  useEffect(() => { setLocalEvents(events || []); }, [events]);

  // Refresh event list (re-fetches clip counts etc.)
  const refreshList = useCallback(async () => {
    if (!window.guestbook) return;
    try {
      const res = await window.guestbook.getEvents();
      if (res) setLocalEvents(res.events || []);
    } catch (e) { console.warn('[EventModal] refresh failed', e); }
  }, []);

  useEffect(() => { refreshList(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Create event ──────────────────────────────────────────────────────
  const handleCreate = useCallback(async () => {
    const name = createName.trim();
    if (!name) { setCreateError('Please enter an event name.'); return; }
    if (!createDate) { setCreateError('Please pick a date.'); return; }
    setCreating(true);
    setCreateError('');
    try {
      const res = await window.guestbook.createEvent({ name, date: createDate, cloneSettings });
      if (!res.ok) { setCreateError(res.error || 'Failed to create event.'); return; }
      reloadFromEvent({ event: res.event, settings: res.settings, clips: res.clips });
      await refreshList();
      setTab('browse');
      setCreateName('');
      setCreateDate(todayISO());
    } catch (e) { setCreateError(e.message); }
    finally { setCreating(false); }
  }, [createName, createDate, cloneSettings, reloadFromEvent, refreshList]);

  // ── Activate event ────────────────────────────────────────────────────
  const handleActivate = useCallback(async (eventId) => {
    if (activating) return;
    setActivating(eventId);
    try {
      const res = await window.guestbook.activateEvent(eventId);
      if (!res.ok) { console.error('[EventModal] activate failed:', res.error); return; }
      reloadFromEvent({ event: res.event, settings: res.settings, clips: res.clips });
      await refreshList();
      onClose();
    } catch (e) { console.error('[EventModal] activate error', e); }
    finally { setActivating(null); }
  }, [activating, reloadFromEvent, refreshList, onClose]);

  // ── Delete event ──────────────────────────────────────────────────────
  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await window.guestbook.deleteEvent(deleteTarget);
      if (!res.ok) { console.error('[EventModal] delete failed:', res.error); return; }
      const updated = await window.guestbook.getEvents();
      if (updated) {
        setLocalEvents(updated.events || []);
        // If deleted the active event, reload from new active
        if (activeEventId === deleteTarget && updated.activeConfig) {
          reloadFromEvent({
            event:    (updated.events || []).find(e => e.id === updated.activeEventId),
            settings: updated.activeConfig.settings,
            clips:    updated.activeConfig.clips,
          });
        }
      }
    } catch (e) { console.error('[EventModal] delete error', e); }
    finally { setDeleting(false); setDeleteTarget(null); }
  }, [deleteTarget, activeEventId, reloadFromEvent]);

  // ── Open folder ───────────────────────────────────────────────────────
  const handleOpenFolder = useCallback((eventId) => {
    window.guestbook?.openEventFolder(eventId);
  }, []);

  // ── Key handler: Escape = close ───────────────────────────────────────
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="evtm-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="evtm-modal">
        {/* Header */}
        <div className="evtm-header">
          <div className="evtm-title">
            <span className="evtm-title-icon">🗂️</span>
            Event Manager
          </div>
          <button className="evtm-close" onClick={onClose} title="Close">×</button>
        </div>

        {/* Tab switcher */}
        <div className="evtm-tabs">
          <button className={`evtm-tab${tab === 'browse' ? ' active' : ''}`} onClick={() => setTab('browse')}>
            📋 Events
          </button>
          <button className={`evtm-tab${tab === 'create' ? ' active' : ''}`} onClick={() => setTab('create')}>
            ✨ New Event
          </button>
        </div>

        {/* Tab content */}
        <div className="evtm-body">

          {/* ── BROWSE TAB ───────────────────────────────────────── */}
          {tab === 'browse' && (
            <div className="evtm-browse">
              {localEvents.length === 0 ? (
                <div className="evtm-empty">
                  <span style={{ fontSize: '2.5rem' }}>🎬</span>
                  <p>No events yet. Create your first event!</p>
                  <button className="admin-btn primary" onClick={() => setTab('create')}>
                    + New Event
                  </button>
                </div>
              ) : (
                <div className="evtm-card-grid">
                  {[...localEvents].reverse().map(ev => {
                    const isActive = ev.id === activeEventId;
                    const isPending = activating === ev.id;
                    return (
                      <div key={ev.id} className={`evtm-card${isActive ? ' active' : ''}`}>
                        {isActive && <div className="evtm-active-badge">● Active</div>}
                        <div className="evtm-card-main">
                          <div className="evtm-card-name">{ev.name}</div>
                          <div className="evtm-card-meta">
                            <span className="evtm-meta-pill">📅 {formatDate(ev.date)}</span>
                            <span className="evtm-meta-pill">🎬 {ev.clipCount ?? 0} clip{(ev.clipCount ?? 0) !== 1 ? 's' : ''}</span>
                          </div>
                        </div>
                        <div className="evtm-card-actions">
                          {!isActive && (
                            <button
                              className="admin-btn primary small"
                              disabled={!!activating}
                              onClick={() => handleActivate(ev.id)}
                            >
                              {isPending ? '⏳ Activating…' : 'Activate'}
                            </button>
                          )}
                          {isActive && (
                            <span className="evtm-active-label">Currently Active</span>
                          )}
                          <button
                            className="admin-btn small"
                            onClick={() => handleOpenFolder(ev.id)}
                            title="Open folder in Explorer"
                          >
                            📁 Folder
                          </button>
                          {!isActive && (
                            <button
                              className="admin-btn danger small"
                              onClick={() => setDeleteTarget(ev.id)}
                              title="Delete event"
                            >
                              🗑 Delete
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* ── CREATE TAB ───────────────────────────────────────── */}
          {tab === 'create' && (
            <div className="evtm-create">
              <div className="evtm-create-icon">✨</div>
              <p className="evtm-create-hint">
                Each event gets its own folder for clips, assets, and exports.
              </p>

              <div className="form-row">
                <label className="form-label">Event Name</label>
                <input
                  className="admin-input"
                  type="text"
                  placeholder="e.g. Izz & Alex's Wedding, Mia's 30th Birthday…"
                  value={createName}
                  onChange={e => { setCreateName(e.target.value); setCreateError(''); }}
                  onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') handleCreate(); }}
                  autoFocus
                />
              </div>

              <div className="form-row">
                <label className="form-label">Event Date</label>
                <input
                  className="admin-input"
                  type="date"
                  value={createDate}
                  onChange={e => { setCreateDate(e.target.value); setCreateError(''); }}
                  onKeyDown={e => e.stopPropagation()}
                />
              </div>

              <div className="evtm-clone-row">
                <label className="evtm-clone-label">
                  <input
                    type="checkbox"
                    checked={cloneSettings}
                    onChange={e => setCloneSettings(e.target.checked)}
                  />
                  <span>Clone settings from active event</span>
                  <span className="form-hint" style={{ marginLeft: 8 }}>
                    (copies PIN, hardware, AI options, branding)
                  </span>
                </label>
              </div>

              {createError && (
                <div className="evtm-error">{createError}</div>
              )}

              <button
                className="admin-btn primary"
                style={{ width: '100%', marginTop: 8, padding: '14px 0', fontSize: '1rem' }}
                disabled={creating || !createName.trim()}
                onClick={handleCreate}
              >
                {creating ? '⏳ Creating…' : '🎬 Create Event'}
              </button>
            </div>
          )}
        </div>

        {/* ── DELETE CONFIRM DIALOG ──────────────────────────────── */}
        {deleteTarget && (
          <div className="evtm-confirm-overlay">
            <div className="evtm-confirm-box">
              <div className="evtm-confirm-icon">⚠️</div>
              <div className="evtm-confirm-title">Delete Event?</div>
              <div className="evtm-confirm-body">
                This will permanently delete the event folder and{' '}
                <strong>all recordings, transcripts, and exports</strong> inside it.
                This cannot be undone.
              </div>
              <div className="evtm-confirm-actions">
                <button className="admin-btn" onClick={() => setDeleteTarget(null)} disabled={deleting}>
                  Cancel
                </button>
                <button className="admin-btn danger" onClick={handleDeleteConfirm} disabled={deleting}>
                  {deleting ? 'Deleting…' : '🗑 Delete Permanently'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
