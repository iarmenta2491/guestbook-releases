/**
 * pipeline/transcribe.js
 *
 * Transcribes a WebM/audio recording using the bundled whisper.cpp CLI for
 * Windows.  The pipeline is fully asynchronous and non-blocking:
 *
 *   1. FFmpeg  converts the .webm recording → temporary 16 kHz mono PCM .wav
 *      (Whisper only accepts 16 kHz WAV input)
 *   2. whisper-cli.exe  runs offline against the bundled ggml-base.en.bin model
 *      and outputs plain-text to stdout.
 *   3. Temporary .wav is deleted regardless of success or failure.
 *
 * Binary locations (relative to project root):
 *   whisper-cli : assets/whisper/Release/whisper-cli.exe
 *   model       : assets/models/ggml-base.en.bin   (147 MB, GGML format)
 *
 * Error philosophy: every failure writes a detailed message to the console so
 * the developer can diagnose issues without digging into silent rejections.
 */

'use strict';

const path      = require('path');
const fs        = require('fs');
const os        = require('os');
const { execFile } = require('child_process');

// ── Binary / model resolution ─────────────────────────────────────────────────
// In a packaged Electron app, `extraResources` are placed at process.resourcesPath.
// In dev, assets live at project_root/assets (one level up from pipeline/).
const ASSETS_DIR = (process.resourcesPath && !process.resourcesPath.includes('node_modules'))
  ? require('path').join(process.resourcesPath, 'assets')
  : require('path').join(__dirname, '..', 'assets');

const WHISPER_CLI   = path.join(ASSETS_DIR, 'whisper', 'x64', 'Release', 'whisper-cli.exe');
const DEFAULT_MODEL = path.join(ASSETS_DIR, 'models', 'ggml-base.en.bin');

/**
 * Transcribe an audio/video file using the bundled whisper-cli.exe.
 *
 * @param {string} inputPath  - Absolute path to the .webm (or any media) file
 * @param {string} ffmpegPath - Absolute path to the ffmpeg binary
 * @param {string} [modelPath] - Optional override for the GGML model path
 * @returns {Promise<string>} Transcript text (empty string on failure)
 */
async function transcribe(inputPath, ffmpegPath, modelPath) {
  const model = modelPath || DEFAULT_MODEL;

  // ── Pre-flight checks ──────────────────────────────────────────────────────
  if (!fs.existsSync(inputPath)) {
    console.error('[Transcribe] ❌ Input file not found:', inputPath);
    return '';
  }
  if (!fs.existsSync(WHISPER_CLI)) {
    console.error(
      '[Transcribe] ❌ whisper-cli.exe not found at:', WHISPER_CLI,
      '\n  → Place the whisper.cpp Windows binary at that path to enable transcription.'
    );
    return '';
  }
  if (!fs.existsSync(model)) {
    console.error(
      '[Transcribe] ❌ GGML model not found at:', model,
      '\n  → Download ggml-base.en.bin and place it in assets/models/'
    );
    return '';
  }
  if (!fs.existsSync(ffmpegPath)) {
    console.error('[Transcribe] ❌ FFmpeg not found at:', ffmpegPath);
    return '';
  }

  // ── Step 1: Convert to 16 kHz mono WAV ────────────────────────────────────
  const tmpWav = path.join(os.tmpdir(), `gb_whisper_${Date.now()}.wav`);
  console.log('[Transcribe] Converting to WAV:', path.basename(inputPath), '→', path.basename(tmpWav));

  try {
    await convertToWav(inputPath, tmpWav, ffmpegPath);
  } catch (err) {
    console.error('[Transcribe] ❌ FFmpeg WAV conversion failed:', err.message);
    return '';
  }

  // ── Step 2: Run whisper-cli ────────────────────────────────────────────────
  let text = '';
  try {
    text = await runWhisperCli(tmpWav, model);
    console.log('[Transcribe] ✅ Transcript length:', text.length, 'chars');
  } catch (err) {
    console.error('[Transcribe] ❌ whisper-cli failed:', err.message);
    text = '';
  } finally {
    // Always remove the temp WAV
    try { fs.unlinkSync(tmpWav); } catch (_) {}
  }

  return text;
}

/**
 * Run whisper-cli.exe against a 16 kHz WAV file.
 * Returns the plain-text transcript as a string.
 *
 * whisper-cli flags used:
 *   -m <model>  GGML model file
 *   -f <file>   Input WAV
 *   -l en       Language
 *   -nt         No timestamps in output  (cleaner text)
 *   -pc         Print colours disabled (prevents ANSI escapes in stdout)
 *   --no-prints Suppress progress lines (suppresses "whisper_model_load...")
 */
function runWhisperCli(wavPath, modelPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-m', modelPath,
      '-f', wavPath,
      '-l', 'en',
      '-np',            // no progress meter / prints
      '-nt',            // no timestamps in text output  (confirmed working v1.9.2)
    ];

    console.log('[Transcribe] Spawning whisper-cli:', WHISPER_CLI, args.slice(0, 4).join(' '), '...');

    execFile(
      WHISPER_CLI,
      args,
      {
        timeout:    180_000,   // 3 minutes max
        maxBuffer:  10 * 1024 * 1024,  // 10 MB stdout buffer
        // Run from the whisper binary's own directory so it can find its DLLs
        cwd: path.join(path.dirname(WHISPER_CLI)),
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          // Log full stderr for debugging
          if (stderr) console.error('[Transcribe] whisper-cli stderr:\n', stderr.slice(0, 2000));
          reject(new Error(`whisper-cli exited with code ${err.code}: ${err.message}`));
          return;
        }
        if (stderr && stderr.length > 0) {
          // whisper-cli logs progress to stderr — not an error
          console.log('[Transcribe] whisper-cli stderr (info):', stderr.slice(0, 500));
        }
        // Clean up the text output:
        // whisper-cli outputs lines like "[00:00:00.000 --> 00:00:04.000]  Hello world." when
        // -nt is not supported by older builds; strip timestamp brackets just in case.
        const cleaned = stdout
          .replace(/\[\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}\]\s*/g, '')
          .replace(/\[BLANK_AUDIO\]/gi, '')
          .split('\n')
          .map(l => l.trim())
          .filter(Boolean)
          .join(' ')
          .trim();
        resolve(cleaned);
      }
    );
  });
}

/**
 * Convert any media file to a 16 kHz mono WAV using FFmpeg.
 * whisper.cpp requires exactly: PCM s16le, mono, 16000 Hz.
 */
function convertToWav(inputPath, outputPath, ffmpegPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',                     // overwrite output without prompting
      '-i',  inputPath,
      '-ar', '16000',           // resample to 16 kHz
      '-ac', '1',               // mono
      '-c:a', 'pcm_s16le',      // uncompressed PCM signed 16-bit little-endian
      outputPath,
    ];

    execFile(ffmpegPath, args, { timeout: 60_000, windowsHide: true }, (err, _stdout, stderr) => {
      if (err) {
        console.error('[Transcribe] FFmpeg stderr:', stderr?.slice(0, 1000));
        reject(new Error('FFmpeg WAV conversion failed: ' + err.message));
      } else {
        resolve();
      }
    });
  });
}

module.exports = { transcribe };
