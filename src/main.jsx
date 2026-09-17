import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/outfit/300.css';
import '@fontsource/outfit/400.css';
import '@fontsource/outfit/500.css';
import '@fontsource/outfit/600.css';
import '@fontsource/outfit/700.css';
import '@fontsource/outfit/800.css';
import './styles/global.css';
import './styles/mobile.css';
import App from './App';

// ── Global Bridge: expose capacitorBridge as window.guestbook on mobile ───
// AdminPanel, ShareScreen, and other screens call window.guestbook.* directly
// (matching the Electron preload.js API). Without this, all those calls crash
// on Capacitor because window.guestbook is undefined.
import { isCapacitor } from './services/platform';
import capacitorBridge from './services/capacitorBridge';
if (isCapacitor() && typeof window !== 'undefined' && !window.guestbook) {
  window.guestbook = capacitorBridge;
}

const container = document.getElementById('root');
const root = createRoot(container);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
