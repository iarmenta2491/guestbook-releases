/**
 * Self-Hosted OTA Updater — Uses GitHub Releases as the update server
 * 
 * On each app launch / resume, checks the latest GitHub release for a
 * web bundle ZIP. If a newer version is found, downloads and applies it.
 * 
 * The update flow:
 *   1. App starts → check latest release via GitHub API
 *   2. Compare release tag (e.g. "v1.4.0") with current bundle version
 *   3. If newer, download the dist.zip asset from the release
 *   4. Capacitor Updater unpacks and hot-swaps the web assets
 *   5. Next launch uses the new bundle (with rollback on crash)
 * 
 * This is fully self-hosted — no Capgo Cloud fees. GitHub Releases
 * serves as the artifact store and version registry.
 */

import { isCapacitor } from './platform';

// GitHub repo for release checks
const GITHUB_OWNER = 'iarmenta2491';
const GITHUB_REPO  = 'guestbook-releases';

/**
 * Get the latest release info from GitHub (no auth needed for public repos)
 */
async function getLatestRelease() {
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
      { headers: { 'Accept': 'application/vnd.github+json' } }
    );
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

/**
 * Find the OTA bundle asset (dist.zip) in a GitHub release
 */
function findBundleAsset(release) {
  if (!release || !release.assets) return null;
  return release.assets.find(a =>
    a.name === 'dist.zip' || a.name === 'ota-bundle.zip'
  ) || null;
}

/**
 * Compare version strings (e.g., "1.3.0" vs "1.4.0")
 * Returns true if remote is newer than local.
 */
function isNewer(remoteTag, localVersion) {
  const remote = (remoteTag || '').replace(/^v/, '').split('.').map(Number);
  const local  = (localVersion || '0.0.0').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((remote[i] || 0) > (local[i] || 0)) return true;
    if ((remote[i] || 0) < (local[i] || 0)) return false;
  }
  return false;
}

/**
 * Check for and apply OTA updates.
 * Call this on app launch and on resume from background.
 * 
 * @param {string} currentVersion - The current app version (e.g., "1.3.0")
 * @returns {{ available: boolean, version?: string, error?: string }}
 */
export async function checkAndApplyOTA(currentVersion) {
  if (!isCapacitor()) {
    return { available: false, error: 'OTA only available on mobile' };
  }

  try {
    // Dynamically import to avoid bundling on Electron
    const { CapacitorUpdater } = await import('@capgo/capacitor-updater');

    // Notify the plugin that the current bundle loaded successfully
    // (prevents rollback on a clean boot)
    await CapacitorUpdater.notifyAppReady();

    // Check GitHub for latest release
    const release = await getLatestRelease();
    if (!release) {
      return { available: false, error: 'Could not reach update server' };
    }

    const remoteVersion = (release.tag_name || '').replace(/^v/, '');
    if (!isNewer(release.tag_name, currentVersion)) {
      return { available: false, version: remoteVersion };
    }

    // Find the OTA bundle asset
    const asset = findBundleAsset(release);
    if (!asset) {
      return { available: false, error: 'No OTA bundle in latest release' };
    }

    // Download and apply the update
    const bundle = await CapacitorUpdater.download({
      url: asset.browser_download_url,
      version: remoteVersion,
    });

    // Set the new bundle — takes effect on next app launch
    await CapacitorUpdater.set(bundle);

    return { available: true, version: remoteVersion };
  } catch (err) {
    console.warn('[OTA] Update check failed:', err);
    return { available: false, error: String(err) };
  }
}

/**
 * Reset to the original app-store bundle (rollback).
 * Use this if a hot-updated bundle causes issues.
 */
export async function rollbackOTA() {
  if (!isCapacitor()) return;
  try {
    const { CapacitorUpdater } = await import('@capgo/capacitor-updater');
    await CapacitorUpdater.reset();
  } catch (err) {
    console.warn('[OTA] Rollback failed:', err);
  }
}
