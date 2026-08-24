const fs = require('fs');
const path = require('path');

const appCtxPath = 'c:/Users/iarme/OneDrive/Documents/My Guestbook/src/context/AppContext.jsx';
let content = fs.readFileSync(appCtxPath, 'utf8');

// 1. Add imports and getBridge
content = content.replace(
  "import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';\n\nconst AppContext = createContext(null);",
  `import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { isElectron, isCapacitor, isMobile, hasFFmpeg, hasTranscription } from '../services/platform';
import capacitorBridge from '../services/capacitorBridge';

const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);

/** Returns the platform-appropriate API bridge */
function getBridge() {
  if (isElectron()) return window.guestbook;
  if (isCapacitor()) return capacitorBridge;
  return null;
}`
);
content = content.replace(
  "export const useApp = () => useContext(AppContext);\n\n// ── Default settings",
  "// ── Default settings"
);

// 2. Replace load
content = content.replace(
  "if (!window.guestbook) return;",
  "const bridge = getBridge();\n      if (!bridge) return;"
);
content = content.replace(
  "const res = await window.guestbook.getEvents();",
  "const res = await bridge.getEvents();"
);
content = content.replace(
  "try { const s = await window.guestbook.getSettings(); if (s) setSettings({ ...DEFAULT_SETTINGS, ...s }); } catch (_) {}",
  "try { const s = await bridge.getSettings(); if (s) setSettings({ ...DEFAULT_SETTINGS, ...s }); } catch (_) {}"
);
content = content.replace(
  "try { const c = await window.guestbook.getClips();    if (c) setClips(c); }                                catch (_) {}",
  "try { const c = await bridge.getClips();    if (c) setClips(c); }                                catch (_) {}"
);

// 3. Replace admin shortcut
content = content.replace(
  "if (!window.guestbook) return;\n    const unsub = window.guestbook.onOpenAdmin(() => {",
  "const bridge = getBridge();\n    if (!bridge) return;\n    const unsub = bridge.onOpenAdmin(() => {"
);

// 4. Replace reloadFromEvent
content = content.replace(
  "if (window.guestbook) {\n      window.guestbook.getEvents().then(res => {",
  "const bridge = getBridge();\n    if (bridge) {\n      bridge.getEvents().then(res => {"
);

// 5. Replace saveRecording
content = content.replace(
  "const result = await window.guestbook.saveRecording(buf, filename);\n      if (result.ok) {",
  "const bridge = getBridge();\n      const result = await bridge?.saveRecording(buf, filename);\n      if (result?.ok) {"
);
content = content.replace(
  "setTimeout(() => window.guestbook.transcribeClip(result.clipId).catch(() => {}), 1000);",
  "setTimeout(() => bridge?.transcribeClip(result.clipId).catch(() => {}), 1000);"
);

// 6. Replace refreshClips
content = content.replace(
  "if (window.guestbook) {\n      const c = await window.guestbook.getClips();",
  "const bridge = getBridge();\n    if (bridge) {\n      const c = await bridge.getClips();"
);

// 7. Replace updateSettings
content = content.replace(
  "if (window.guestbook) await window.guestbook.saveSettings(merged);",
  "const bridge = getBridge();\n    if (bridge) await bridge.saveSettings(merged);"
);

// 8. Add values to Context
content = content.replace(
  "startRecording, saveRecording, resetSession,",
  "startRecording, saveRecording, resetSession,\n      isElectron, isCapacitor, isMobile, hasFFmpeg, hasTranscription,"
);

fs.writeFileSync(appCtxPath, content, 'utf8');

// -------- index.html --------
const indexPath = 'c:/Users/iarme/OneDrive/Documents/My Guestbook/index.html';
let indexContent = fs.readFileSync(indexPath, 'utf8');
indexContent = indexContent.replace(
  '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
  `<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="format-detection" content="telephone=no" />`
);
fs.writeFileSync(indexPath, indexContent, 'utf8');

// -------- package.json --------
const pkgPath = 'c:/Users/iarme/OneDrive/Documents/My Guestbook/package.json';
let pkgContent = fs.readFileSync(pkgPath, 'utf8');
const pjson = JSON.parse(pkgContent);
const newScripts = {
  ...pjson.scripts,
  "cap:sync": "npm run build && npx cap sync",
  "cap:ios": "npm run build && npx cap sync ios && npx cap open ios",
  "cap:android": "npm run build && npx cap sync android && npx cap open android"
};
// keep postinstall at the end if it exists
if (newScripts.postinstall) {
  const pi = newScripts.postinstall;
  delete newScripts.postinstall;
  newScripts.postinstall = pi;
}
pjson.scripts = newScripts;
fs.writeFileSync(pkgPath, JSON.stringify(pjson, null, 4), 'utf8');

console.log('Patch complete.');
