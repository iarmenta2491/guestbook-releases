/**
 * LocalServer Web Stub
 * No-op implementation for browser/Electron (desktop uses Node HTTP server).
 */

import { WebPlugin } from '@capacitor/core';

export class LocalServerWeb extends WebPlugin {
  async start() {
    throw new Error('LocalServer is not available in the browser. Use the desktop LAN server.');
  }

  async stop() {
    // no-op
  }

  async getLocalIP() {
    return { ip: '127.0.0.1' };
  }
}
