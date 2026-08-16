/**
 * scripts/download-model.js
 * Postinstall script — downloads ggml-base.en.bin into assets/models/
 * so no internet access is needed at runtime (offline-first).
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin';
const MODEL_DIR = path.join(__dirname, '..', 'assets', 'models');
const MODEL_PATH = path.join(MODEL_DIR, 'ggml-base.en.bin');

function downloadFile(url, dest, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 10) return reject(new Error('Too many redirects'));

    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    let receivedBytes = 0;
    let totalBytes = 0;
    let lastPct = -1;

    protocol.get(url, { headers: { 'User-Agent': 'my-guestbook/1.0' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
        file.close();
        fs.unlink(dest, () => {});
        return downloadFile(res.headers.location, dest, redirectCount + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => {});
        return reject(new Error(`Failed to download model: HTTP ${res.statusCode}`));
      }

      totalBytes = parseInt(res.headers['content-length'] || '0', 10);
      res.pipe(file);

      res.on('data', (chunk) => {
        receivedBytes += chunk.length;
        if (totalBytes > 0) {
          const pct = Math.floor((receivedBytes / totalBytes) * 100);
          if (pct !== lastPct && pct % 10 === 0) {
            process.stdout.write(`\r  Downloading Whisper model... ${pct}% (${Math.round(receivedBytes / 1024 / 1024)}MB / ${Math.round(totalBytes / 1024 / 1024)}MB)`);
            lastPct = pct;
          }
        }
      });

      file.on('finish', () => {
        process.stdout.write('\n');
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

async function main() {
  if (!fs.existsSync(MODEL_DIR)) {
    fs.mkdirSync(MODEL_DIR, { recursive: true });
  }

  if (fs.existsSync(MODEL_PATH)) {
    const stat = fs.statSync(MODEL_PATH);
    if (stat.size > 100 * 1024 * 1024) {
      console.log('  ✓ Whisper model already present — skipping download.');
      return;
    }
  }

  console.log('\n  📥 Downloading Whisper AI model (ggml-base.en, ~142 MB)...');
  console.log('  This happens once during project setup — zero downloads at runtime.\n');

  try {
    await downloadFile(MODEL_URL, MODEL_PATH);
    console.log('  ✓ Whisper model saved to assets/models/ggml-base.en.bin\n');
  } catch (err) {
    console.warn(`\n  ⚠ Could not download Whisper model: ${err.message}`);
    console.warn('  Transcription will be unavailable. Re-run npm install when online.\n');
  }
}

main();
