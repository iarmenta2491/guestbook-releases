/**
 * engine/stitch.js — FFmpeg compilation engine (v3 — robust HTML5 edition)
 *
 * Guarantees for every segment entering filter_complex:
 *   • Exact W×H, CFR 30fps, yuv420p (H.264-compatible pixel format)
 *   • Stereo AAC 44100 Hz — even if source has no audio track (two-pass fallback)
 *   • PTS reset via setpts / asetpts — no timestamp discontinuities
 *   • -movflags +faststart on all MP4 output — Chromium can stream immediately
 *
 * Hard-cut transitions use concat for BOTH video AND audio — never mixing
 * concat (video) with acrossfade (audio) which caused filter_complex crashes.
 */
'use strict';

const path       = require('path');
const fs         = require('fs');
const os         = require('os');
const { execFile, spawn } = require('child_process');

const TARGET_FPS       = 30;
const TARGET_AR        = 44100;
const TARGET_PIXEL_FMT = 'yuv420p';

const QUALITY_PRESETS = {
  '1080p': { width: 1920, height: 1080, crf: 18, preset: 'fast'     },
  '720p':  { width: 1280, height: 720,  crf: 22, preset: 'veryfast' },
};

/* ═══════════════════════════════════════════════════════════════════════════
   sanitizeFilePath — strip any URL protocol prefix so FFmpeg always receives
   a bare OS path.  Handles: media:/// localfile:// file:/// file://
   Also decodes percent-encoding (e.g. %20 → space).
═══════════════════════════════════════════════════════════════════════════ */
function sanitizeFilePath(raw) {
  if (!raw) return '';
  let p = String(raw);
  p = p.replace(/^media:\/\/\//i,   '')
       .replace(/^localfile:\/\//i, '')
       .replace(/^file:\/\/\//i,    '')
       .replace(/^file:\/\//i,      '');
  try { p = decodeURIComponent(p); } catch (_) {}
  return p;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Public API
═══════════════════════════════════════════════════════════════════════════ */
async function stitch({ clips, transitions, outputPath, ffmpegPath, onProgress, options = {} }) {
  if (!clips || clips.length === 0) throw new Error('No clips to stitch');

  const safeOut = String(outputPath);
  const {
    quality             = '1080p',
    transitionDurations = [],
    normalizeAudio      = false,
    bgMusicPath         = null,
    bgMusicVolume       = 0.1,
    intro               = null,
    outro               = null,
    trimData            = {},
    externalClipPaths   = {},
  } = options;

  const preset = QUALITY_PRESETS[quality] || QUALITY_PRESETS['1080p'];
  const W = preset.width, H = preset.height;

  onProgress && onProgress(2);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb_stitch_'));

  try {
    // ── 1. Normalise every source clip to identical spec ──────────────────
    const normalizedPaths = [];
    for (let i = 0; i < clips.length; i++) {
      const clip    = clips[i];
      const srcPath = sanitizeFilePath(externalClipPaths[clip.id] || clip.path || '');
      if (!srcPath || !fs.existsSync(srcPath)) {
        throw new Error(`Source clip not found: "${srcPath}" (clip id: ${clip.id})`);
      }
      const trim     = trimData[clip.id] || null;
      const normPath = path.join(tmpDir, `norm_${i}.mp4`);
      try {
        await normalizeClip(srcPath, normPath, ffmpegPath, W, H, preset, trim, normalizeAudio);
      } catch (normErr) {
        // Re-throw with clip identity so the error banner shows exactly what failed
        throw new Error(
          `Failed to normalize clip ${i + 1} of ${clips.length} ` +
          `(id: "${clip.id}", file: "${path.basename(srcPath)}"):\n${normErr.message}`
        );
      }
      if (!fs.existsSync(normPath) || fs.statSync(normPath).size === 0) {
        throw new Error(
          `Clip ${i + 1} (id: "${clip.id}", file: "${path.basename(srcPath)}") ` +
          `produced an empty output file — check that FFmpeg supports this format.`
        );
      }
      normalizedPaths.push(normPath);
      onProgress && onProgress(2 + Math.round((i + 1) / clips.length * 35));
    }
    onProgress && onProgress(40);

    // ── 2. Generate title cards at identical spec ─────────────────────────
    const introPath = intro ? await makeTitleCard(intro, W, H, tmpDir, 'intro', ffmpegPath, preset) : null;
    const outroPath = outro ? await makeTitleCard(outro, W, H, tmpDir, 'outro', ffmpegPath, preset) : null;
    onProgress && onProgress(48);

    // ── 3. Ordered segment list ───────────────────────────────────────────
    const segments = [];
    if (introPath) segments.push({ path: introPath, knownDuration: intro.duration || 3 });
    for (const p of normalizedPaths) segments.push({ path: p });
    if (outroPath)  segments.push({ path: outroPath, knownDuration: outro.duration || 3 });

    // ── 4. Stitch ─────────────────────────────────────────────────────────
    let stitchedPath;
    if (segments.length === 1) {
      stitchedPath = await copySingle(segments[0].path, tmpDir, ffmpegPath, preset);
    } else {
      stitchedPath = await stitchMultiple(segments, transitions, transitionDurations, tmpDir, ffmpegPath, preset, onProgress);
    }
    onProgress && onProgress(88);

    // ── 5. BG Music or final copy ─────────────────────────────────────────
    const safeBgMusic = bgMusicPath ? sanitizeFilePath(bgMusicPath) : null;
    if (safeBgMusic && fs.existsSync(safeBgMusic)) {
      await mixBgMusic(stitchedPath, safeBgMusic, bgMusicVolume, safeOut, ffmpegPath);
    } else {
      await runFFmpeg(ffmpegPath, [
        '-y', '-i', stitchedPath,
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
        '-movflags', '+faststart',
        safeOut,
      ]);
    }
    onProgress && onProgress(100);

  } finally {
    try {
      for (const f of fs.readdirSync(tmpDir)) {
        try { fs.unlinkSync(path.join(tmpDir, f)); } catch (_) {}
      }
      fs.rmdirSync(tmpDir);
    } catch (_) {}
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   normalizeClip — Two-pass approach for robust audio handling.
   Pass 1: Try with source audio.
   Pass 2: If pass 1 fails (e.g. no audio stream), inject silent audio.
═══════════════════════════════════════════════════════════════════════════ */
function buildNormVf(W, H) {
  // scale: fit within WxH preserving aspect ratio (letterbox/pillarbox)
  // pad: fill remaining space with black to reach exactly WxH
  // setsar=1: force square sample aspect ratio — critical for concat/xfade
  //           (phones shoot in non-1:1 SAR; mismatched SAR crashes filter_complex)
  // fps: conform to exact target frame rate
  // format: pin pixel format to yuv420p for H.264 baseline compatibility
  // setpts: reset timestamps to avoid discontinuities
  return [
    `scale=${W}:${H}:force_original_aspect_ratio=decrease`,
    `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `setsar=1`,
    `fps=${TARGET_FPS}`,
    `format=${TARGET_PIXEL_FMT}`,
    `setpts=PTS-STARTPTS`,
  ].join(',');
}

function buildNormEncodeArgs(preset) {
  return [
    '-c:v', 'libx264', '-preset', preset.preset, '-crf', String(preset.crf),
    '-profile:v', 'baseline', '-level', '3.1',   // widest HTML5/Chromium compat
    '-c:a', 'aac', '-ar', String(TARGET_AR), '-ac', '2', '-b:a', '192k',
    '-r', String(TARGET_FPS),
    '-video_track_timescale', '90000',
    '-movflags', '+faststart',
    '-avoid_negative_ts', 'make_zero',
  ];
}

/* ═══════════════════════════════════════════════════════════════════════════
   hasAudioStream — probe whether a file contains an audio stream.
   Uses ffmpeg -i (which always exits non-zero) and parses stderr for "Audio:"
═══════════════════════════════════════════════════════════════════════════ */
function hasAudioStream(filePath, ffmpegPath) {
  return new Promise((resolve) => {
    execFile(String(ffmpegPath), ['-i', String(filePath), '-f', 'null', '-'], { timeout: 15000 }, (_, __, stderr) => {
      resolve(/Audio:/.test(stderr || ''));
    });
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   normalizeClip — Probe-first approach for robust audio handling.
   If the source file has an audio stream, it is normalised and kept.
   If not, a stereo silent audio track is synthesised via lavfi aevalsrc.
   This avoids the false-positive failure of a try/catch two-pass approach.
═══════════════════════════════════════════════════════════════════════════ */
async function normalizeClip(inputPath, outputPath, ffmpegPath, W, H, preset, trim, normalizeAudio) {
  const vf = buildNormVf(W, H);

  const afParts = ['aresample=' + TARGET_AR, 'asetpts=PTS-STARTPTS'];
  if (normalizeAudio) afParts.push('loudnorm=I=-16:TP=-1.5:LRA=11');
  const af = afParts.join(',');

  const trimArgs = trim ? ['-ss', String(trim.start), '-to', String(trim.end)] : [];

  // Probe first — deterministic path avoids false-positive failures
  const sourceHasAudio = await hasAudioStream(inputPath, ffmpegPath);

  if (sourceHasAudio) {
    // Source has audio — normalise and keep it
    await runFFmpeg(ffmpegPath, [
      '-y', ...trimArgs, '-i', inputPath,
      '-vf', vf, '-af', af,
      ...buildNormEncodeArgs(preset),
      outputPath,
    ]);
  } else {
    // Source has NO audio track — synthesise stereo silence via lavfi aevalsrc
    await runFFmpeg(ffmpegPath, [
      '-y', ...trimArgs, '-i', inputPath,
      '-f', 'lavfi', '-i',
        `aevalsrc=0:channel_layout=stereo:sample_rate=${TARGET_AR}`,
      '-map', '0:v', '-map', '1:a',
      '-vf', vf,
      '-af', 'asetpts=PTS-STARTPTS',
      ...buildNormEncodeArgs(preset),
      '-shortest',
      outputPath,
    ]);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   makeTitleCard — Generates a title card MP4 at exact target spec.
═══════════════════════════════════════════════════════════════════════════ */
async function makeTitleCard({ text, color, duration, mediaPath }, W, H, tmpDir, name, ffmpegPath, preset) {
  const safeDur  = duration || 3;
  const outPath  = path.join(tmpDir, `title_${name}.mp4`);
  const vf       = buildNormVf(W, H);
  // Strip any protocol prefix (media://, file://, etc.) before passing to FFmpeg
  const cleanMedia = mediaPath ? sanitizeFilePath(mediaPath) : null;

  if (cleanMedia && fs.existsSync(cleanMedia)) {
    const ext     = path.extname(cleanMedia).toLowerCase();
    const isImage = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext);

    if (isImage) {
      // Image demuxer options MUST precede -i: -loop 1 tells the demuxer
      // to loop the single frame; -framerate sets the input frame rate.
      // -t is an OUTPUT option — it caps the encoded duration.
      await runFFmpeg(ffmpegPath, [
        '-y',
        '-loop', '1',                        // image2 demuxer: loop infinitely
        '-framerate', String(TARGET_FPS),     // image2 demuxer: input frame rate
        '-i', cleanMedia,                     // image input
        '-f', 'lavfi',
        '-i', `aevalsrc=0:channel_layout=stereo:sample_rate=${TARGET_AR}`,
        '-map', '0:v:0', '-map', '1:a',
        '-vf', vf,
        '-af', 'asetpts=PTS-STARTPTS',
        '-t', String(safeDur),               // OUTPUT option — limits encoded duration
        ...buildNormEncodeArgs(preset),
        outPath,
      ]);
    } else {
      // Video media: -stream_loop + -t before -i are INPUT options, which is correct
      // for video (caps how much of the looping stream is decoded).
      await runFFmpeg(ffmpegPath, [
        '-y',
        '-stream_loop', '-1',
        '-t', String(safeDur),
        '-i', cleanMedia,
        '-f', 'lavfi',
        '-i', `aevalsrc=0:channel_layout=stereo:sample_rate=${TARGET_AR}`,
        '-map', '0:v:0', '-map', '1:a',
        '-vf', vf,
        '-af', 'asetpts=PTS-STARTPTS',
        '-t', String(safeDur),               // OUTPUT option guard
        ...buildNormEncodeArgs(preset),
        outPath,
      ]);
    }
    return outPath;
  }

  // Text + solid colour background
  const bgColor  = (color || '#1a1a2e').replace('#', '');
  const safeText = (text || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:');
  const drawText = safeText
    ? `drawtext=text='${safeText}':fontsize=${Math.floor(H * 0.06)}:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:shadowcolor=black:shadowx=2:shadowy=2`
    : null;
  const titleVf = [
    `format=${TARGET_PIXEL_FMT}`,
    drawText,
    `setpts=PTS-STARTPTS`,
  ].filter(Boolean).join(',');

  await runFFmpeg(ffmpegPath, [
    '-y',
    '-f', 'lavfi', '-i', `color=c=0x${bgColor}:size=${W}x${H}:rate=${TARGET_FPS}:duration=${safeDur}`,
    '-f', 'lavfi', '-i', `aevalsrc=0:channel_layout=stereo:sample_rate=${TARGET_AR}:duration=${safeDur}`,
    '-vf', titleVf, '-af', 'asetpts=PTS-STARTPTS',
    ...buildNormEncodeArgs(preset),
    '-t', String(safeDur), outPath,
  ]);
  return outPath;
}

/* ═══════════════════════════════════════════════════════════════════════════
   copySingle — Re-encode single segment for faststart + HTML5 compat.
═══════════════════════════════════════════════════════════════════════════ */
function copySingle(inputPath, tmpDir, ffmpegPath, preset) {
  const outPath = path.join(tmpDir, 'single_out.mp4');
  return runFFmpeg(ffmpegPath, [
    '-y', '-i', inputPath,
    '-c:v', 'libx264', '-preset', preset.preset, '-crf', String(preset.crf),
    '-profile:v', 'baseline', '-level', '3.1',
    '-c:a', 'aac', '-ar', String(TARGET_AR), '-ac', '2', '-b:a', '192k',
    '-pix_fmt', TARGET_PIXEL_FMT, '-movflags', '+faststart',
    outPath,
  ]).then(() => outPath);
}

/* ═══════════════════════════════════════════════════════════════════════════
   stitchMultiple — Chain n segments with per-transition xfade or concat.

   xfade / acrossfade: for crossfade, fade-to-black, wipe transitions
   concat (v+a both):  for hard-cut — never mix concat+acrossfade

   Offset calculation:
     cumDur tracks where the video timeline currently ends.
     Each xfade starts at (cumDur - tDur), i.e. the overlap region.
     cumDur advances by (segDuration - tDur) after each join.
═══════════════════════════════════════════════════════════════════════════ */
async function stitchMultiple(segments, transitions, transitionDurations, tmpDir, ffmpegPath, preset, onProgress) {
  const n          = segments.length;
  const outputPath = path.join(tmpDir, 'stitched.mp4');

  // Probe durations for pre-normalised segments
  const durations = await Promise.all(segments.map(s =>
    s.knownDuration != null ? Promise.resolve(Number(s.knownDuration)) : getDuration(s.path, ffmpegPath)
  ));

  const XFADE_MAP = {
    'crossfade':     'fade',
    'fade-to-black': 'fadeblack',
    'wipe':          'wipeleft',
  };

  const getTransition = (i) => {
    if (Array.isArray(transitions) && transitions[i]) return transitions[i];
    return typeof transitions === 'string' ? transitions : 'crossfade';
  };
  const getTDur = (i) => {
    if (Array.isArray(transitionDurations) && transitionDurations[i] != null) return Number(transitionDurations[i]);
    return 1.0;
  };

  const inputArgs   = [];
  for (const s of segments) inputArgs.push('-i', s.path);

  const filterParts = [];
  let cumDur = durations[0];
  let prevV  = '[0:v]';
  let prevA  = '[0:a]';

  for (let i = 1; i < n; i++) {
    const tType  = getTransition(i - 1);
    // Clamp transition to 90% of the shorter neighbouring segment
    const tDur   = Math.min(getTDur(i - 1), durations[i - 1] * 0.9, durations[i] * 0.9);
    const xfade  = XFADE_MAP[tType] ?? null;
    const isLast = (i === n - 1);
    const vOut   = isLast ? '[vout]' : `[v${i}]`;
    const aOut   = isLast ? '[aout]' : `[a${i}]`;

    if (xfade) {
      const offset = Math.max(0, cumDur - tDur);
      filterParts.push(
        `${prevV}[${i}:v]xfade=transition=${xfade}:duration=${tDur.toFixed(4)}:offset=${offset.toFixed(4)}${vOut}`
      );
      filterParts.push(
        `${prevA}[${i}:a]acrossfade=d=${tDur.toFixed(4)}:c1=exp:c2=exp${aOut}`
      );
    } else {
      // Hard-cut: concat BOTH video and audio into the same output labels
      filterParts.push(
        `${prevV}[${i}:v]concat=n=2:v=1:a=0${vOut}`,
        `${prevA}[${i}:a]concat=n=2:v=0:a=1${aOut}`
      );
    }

    prevV   = vOut;
    prevA   = aOut;
    cumDur += durations[i] - tDur;
  }

  const args = [
    '-y', ...inputArgs,
    '-filter_complex', filterParts.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', preset.preset, '-crf', String(preset.crf),
    '-profile:v', 'baseline', '-level', '3.1',
    '-c:a', 'aac', '-ar', String(TARGET_AR), '-ac', '2', '-b:a', '192k',
    '-pix_fmt', TARGET_PIXEL_FMT,
    '-movflags', '+faststart',
    outputPath,
  ];

  await runFFmpeg(ffmpegPath, args, onProgress, 50, 85);
  return outputPath;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Background music mixing
   ─────────────────────────────────────────────────────────────────────────
   Filter graph breakdown:
     [0:a]  = compiled video's audio (guest voices) → kept at full volume
     [1:a]  = background MP3 (looped) → scaled by user's volume slider value

   IMPORTANT — normalize=0 on amix:
     FFmpeg's amix by default divides each track by the number of inputs to
     prevent clipping (÷2 for 2 tracks). This makes 100% slider sound like
     ~50%. normalize=0 disables this so the slider is a true 0–100% control.
═══════════════════════════════════════════════════════════════════════════ */
function mixBgMusic(videoPath, musicPath, musicVolume, outputPath, ffmpegPath) {
  // musicVolume arrives as 0.0–1.0 (slider 0%–100% ÷ 100 in React)
  // musicVolume arrives as 0.0–1.0; multiply by 2 so 100% slider = volume=2.0
  const vol = Math.max(0, Math.min(2, musicVolume * 2));

  // Named-label filter graph — easier to read and debug in FFmpeg logs
  const af = [
    // Guest audio: pass through at full volume
    `[0:a]volume=1.0[guest]`,
    // Background music: loop infinitely, apply doubled user volume
    `[1:a]aloop=loop=-1:size=2000000000,volume=${vol.toFixed(4)}[music]`,
    // Mix: normalize=0 disables amix's built-in ÷N attenuation so the
    // slider value maps 1:1 (100% → full music volume, not ÷2 = ~50%)
    `[guest][music]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[aout]`,
  ].join(';');

  return runFFmpeg(ffmpegPath, [
    '-y', '-i', videoPath,
    '-stream_loop', '-1', '-i', musicPath,
    '-filter_complex', af,
    '-map', '0:v', '-map', '[aout]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    '-shortest', '-movflags', '+faststart',
    String(outputPath),
  ]);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Helpers
═══════════════════════════════════════════════════════════════════════════ */
function getDuration(filePath, ffmpegPath) {
  return new Promise((resolve) => {
    execFile(String(ffmpegPath), ['-i', String(filePath), '-f', 'null', '-'], { timeout: 30000 }, (_, __, stderr) => {
      const m = (stderr || '').match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
      resolve(m ? parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]) : 30);
    });
  });
}

function runFFmpeg(ffmpegPath, args, onProgress, progressStart = 0, progressEnd = 100) {
  return new Promise((resolve, reject) => {
    const proc = spawn(String(ffmpegPath), args.map(String));
    let stderr = '';

    proc.stderr.on('data', (chunk) => {
      const txt = chunk.toString();
      stderr += txt;
      if (onProgress) {
        const match = txt.match(/time=(\d+):(\d+):([\d.]+)/);
        if (match) {
          const elapsed  = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseFloat(match[3]);
          const durMatch = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
          if (durMatch) {
            const total = parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseFloat(durMatch[3]);
            if (total > 0) {
              onProgress(Math.min(progressEnd, Math.round(progressStart + (elapsed / total) * (progressEnd - progressStart))));
            }
          }
        }
      }
    });

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exit ${code}\n${stderr.slice(-4000)}`));
    });
    proc.on('error', (err) => reject(new Error(`FFmpeg spawn failed: ${err.message}`)));
  });
}

module.exports = { stitch, getDuration };
