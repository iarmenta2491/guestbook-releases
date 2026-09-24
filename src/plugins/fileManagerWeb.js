/**
 * FileManager Web Stub
 * No-op implementations for browser/desktop development.
 */

export class FileManagerWeb {
  async pickDirectory() {
    console.warn('[FileManager] pickDirectory not available on web');
    return { uri: null };
  }

  async openFileManager() {
    console.warn('[FileManager] openFileManager not available on web');
    return { ok: false };
  }

  async shareFiles() {
    console.warn('[FileManager] shareFiles not available on web');
    return { ok: false, sharedCount: 0 };
  }

  async copyToSafDirectory() {
    console.warn('[FileManager] copyToSafDirectory not available on web');
    return { ok: false };
  }
}
