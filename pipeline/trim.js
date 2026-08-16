/**
 * pipeline/trim.js
 * Detects and trims leading/trailing silence from a recording using FFmpeg silencedetect.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

/**
 * Trim silence from start and end of a media file.
 * Returns path to trimmed file (overwrites with _trimmed suffix first, then renames).
 *
 * @param {string} inputPath  - Path to source .webm
 * @param {string} ffmpegPath - FFmpeg binary path
 * @returns {Promise<string>} Path to trimmed file
 */
async function trimSilence(inputPath, ffmpegPath) {
  const { startTime, endTime, duration } = await detectSilence(inputPath, ffmpegPath);

  // If nothing to trim (within 0.2s of boundaries), return original
  if (startTime < 0.2 && (duration - endTime) < 0.2) {
    return inputPath;
  }

  const ext = path.extname(inputPath);
  const trimmedPath = inputPath.replace(ext, `_trimmed${ext}`);
  const trimDuration = endTime - startTime;

  await runFFmpeg(ffmpegPath, [
    '-y', '-i', inputPath,
    '-ss', startTime.toFixed(3),
    '-t', trimDuration.toFixed(3),
    '-c', 'copy',
    trimmedPath,
  ]);

  // Replace original
  fs.unlinkSync(inputPath);
  fs.renameSync(trimmedPath, inputPath);
  return inputPath;
}

/**
 * Detect start/end of content (non-silence) using FFmpeg silencedetect filter.
 */
async function detectSilence(inputPath, ffmpegPath) {
  const NOISE_THRESHOLD = '-40dB';
  const MIN_SILENCE_DURATION = '0.5';

  return new Promise((resolve) => {
    const args = [
      '-i', inputPath,
      '-af', `silencedetect=noise=${NOISE_THRESHOLD}:d=${MIN_SILENCE_DURATION}`,
      '-f', 'null', '-',
    ];

    let stderr = '';
    const proc = execFile(ffmpegPath, args, { timeout: 60000 }, () => {});
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('close', () => {
      // Parse duration
      const durMatch = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
      const totalDuration = durMatch
        ? parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseFloat(durMatch[3])
        : 0;

      // Parse silence intervals
      const silenceStarts = [...stderr.matchAll(/silence_start:\s*([\d.]+)/g)].map(m => parseFloat(m[1]));
      const silenceEnds = [...stderr.matchAll(/silence_end:\s*([\d.]+)/g)].map(m => parseFloat(m[1]));

      let startTime = 0;
      let endTime = totalDuration;

      // Leading silence: if audio starts with silence
      if (silenceStarts[0] !== undefined && silenceStarts[0] < 0.5) {
        startTime = silenceEnds[0] || 0;
      }
      // Trailing silence: if last silence extends to end
      const lastStart = silenceStarts[silenceStarts.length - 1];
      if (lastStart !== undefined && totalDuration > 0 && (totalDuration - lastStart) < 3) {
        endTime = lastStart;
      }

      resolve({ startTime, endTime, duration: totalDuration });
    });
  });
}

function runFFmpeg(ffmpegPath, args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { timeout: 120000 }, (err) => {
      if (err) reject(err); else resolve();
    });
  });
}

module.exports = { trimSilence };
