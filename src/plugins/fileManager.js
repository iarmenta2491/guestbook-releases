/**
 * FileManager Plugin Bridge
 *
 * Registers and exports the FileManager native Capacitor plugin.
 * Android: SAF folder picker, native file manager launcher, multi-file share
 * Web: No-op stubs
 */

import { registerPlugin } from '@capacitor/core';

const FileManager = registerPlugin('FileManager', {
  web: () => import('./fileManagerWeb').then(m => new m.FileManagerWeb()),
});

export { FileManager };
