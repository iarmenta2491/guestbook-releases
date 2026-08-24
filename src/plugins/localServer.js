/**
 * LocalServer Plugin Bridge
 *
 * Registers and exports the LocalServer native Capacitor plugin.
 * iOS: GCDWebServer
 * Android: NanoHTTPD
 * Web: No-op stub
 */

import { registerPlugin } from '@capacitor/core';

const LocalServer = registerPlugin('LocalServer', {
  web: () => import('./localServerWeb').then(m => new m.LocalServerWeb()),
});

export { LocalServer };
