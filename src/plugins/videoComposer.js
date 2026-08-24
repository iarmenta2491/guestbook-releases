/**
 * VideoComposer Plugin Bridge
 *
 * Registers and exports the VideoComposer native Capacitor plugin.
 * iOS: AVMutableComposition
 * Android: Media3 Transformer
 * Web: No-op stub
 */

import { registerPlugin } from '@capacitor/core';

const VideoComposer = registerPlugin('VideoComposer', {
  web: () => import('./videoComposerWeb').then(m => new m.VideoComposerWeb()),
});

export { VideoComposer };
