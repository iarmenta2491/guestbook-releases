/**
 * VideoComposer Web Stub
 * No-op implementation for when the app runs in a browser or Electron.
 */

import { WebPlugin } from '@capacitor/core';

export class VideoComposerWeb extends WebPlugin {
  async compose() {
    throw new Error('VideoComposer is not available in the browser. Use the desktop compilation engine.');
  }

  async cancel() {
    // no-op
  }
}
