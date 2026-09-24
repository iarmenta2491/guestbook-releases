package com.myguestbook.app;

import android.content.Context;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMuxer;
import android.util.Log;

import com.arthenica.ffmpegkit.FFmpegKit;
import com.arthenica.ffmpegkit.FFmpegSession;
import com.arthenica.ffmpegkit.ReturnCode;

import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * NativeComposer — Video composition engine for the Guestbook Android app.
 *
 * Two modes:
 *  1. FAST PATH (MediaMuxer): When all transitions are hard-cuts and there
 *     are no intros/outros — uses zero-copy re-muxing.
 *  2. FFMPEG PATH (FFmpegKit): When crossfade transitions or intro/outro
 *     clips are requested — builds a complex filtergraph for the GPU.
 *
 * Output always goes to a local cache file; JS copies to SAF afterward.
 */
public class NativeComposer {
    private static final String TAG = "NativeComposer";
    private static final int AUDIO_TRANSCODE_TIMEOUT_US = 10_000;
    private final Context context;
    private volatile boolean cancelled = false;

    public interface ProgressCallback {
        void onProgress(float progress); // 0.0 to 1.0
    }

    public static class ClipInfo {
        public final String path;
        public final long trimStartMs;
        public final long trimEndMs;

        public ClipInfo(String path, long trimStartMs, long trimEndMs) {
            this.path = sanitizePath(path);
            this.trimStartMs = trimStartMs;
            this.trimEndMs = trimEndMs;
        }

        private static String sanitizePath(String raw) {
            if (raw == null) return "";
            if (raw.startsWith("file:///")) return raw.substring(7);
            else if (raw.startsWith("file://")) return raw.substring(7);
            else if (raw.startsWith("file:/")) return raw.substring(5);
            if (raw.startsWith("content://")) return raw.substring(10);
            return raw;
        }
    }

    public static class TransitionInfo {
        public final String type; // "none" or "crossfade"
        public final int durationMs;

        public TransitionInfo(String type, int durationMs) {
            this.type = type;
            this.durationMs = durationMs;
        }
    }

    public NativeComposer(Context context) {
        this.context = context;
    }

    public void cancel() {
        cancelled = true;
        FFmpegKit.cancel();
    }

    /**
     * Main entry point. Decides between MediaMuxer (fast) and FFmpeg (transitions) paths.
     *
     * @param introPath  Path to intro video (or null/empty)
     * @param outroPath  Path to outro video (or null/empty)
     */
    public void compose(
            List<ClipInfo> clips,
            List<TransitionInfo> transitions,
            File outputFile,
            int targetWidth,
            int targetHeight,
            String bgMusicPath,
            float bgMusicVolume,
            String introPath,
            String outroPath,
            ProgressCallback progressCallback
    ) throws Exception {
        cancelled = false;

        if (clips == null || clips.isEmpty()) {
            throw new IllegalArgumentException("No clips to compose");
        }

        // Clean intro/outro paths
        introPath = ClipInfo.sanitizePath(introPath);
        outroPath = ClipInfo.sanitizePath(outroPath);
        boolean hasIntro = introPath != null && !introPath.isEmpty() && new File(introPath).exists();
        boolean hasOutro = outroPath != null && !outroPath.isEmpty() && new File(outroPath).exists();

        // STRICT ROUTING: Use FFmpeg for ANY non-trivial composition.
        // Only use MediaMuxer fast path when ALL transitions are "none"
        // AND there is no intro/outro AND there is no background music.
        boolean hasNonTrivialTransition = false;
        if (transitions != null) {
            for (TransitionInfo t : transitions) {
                if (t.type != null && !"none".equalsIgnoreCase(t.type)) {
                    hasNonTrivialTransition = true;
                    break;
                }
            }
        }
        boolean hasBgMusic = bgMusicPath != null && !bgMusicPath.isEmpty()
            && new File(ClipInfo.sanitizePath(bgMusicPath)).exists();

        boolean needsFFmpeg = hasNonTrivialTransition || hasIntro || hasOutro || hasBgMusic;

        Log.d(TAG, "compose: " + clips.size() + " clips"
            + (hasIntro ? " +intro" : "") + (hasOutro ? " +outro" : "")
            + (hasNonTrivialTransition ? " +transitions" : "")
            + (hasBgMusic ? " +bgMusic" : "")
            + " → " + (needsFFmpeg ? "FFmpeg" : "MediaMuxer"));

        if (clips.size() == 1 && !needsFFmpeg) {
            copySingleClip(clips.get(0), outputFile, progressCallback);
            return;
        }

        if (needsFFmpeg) {
            composeWithFFmpeg(clips, transitions, outputFile, targetWidth, targetHeight,
                    bgMusicPath, bgMusicVolume, introPath, outroPath,
                    hasIntro, hasOutro, progressCallback);
        } else {
            concatenateClips(clips, outputFile, targetWidth, targetHeight, progressCallback);
        }
    }

    // ── FFmpeg Path ──────────────────────────────────────────────────────────

    private void composeWithFFmpeg(
            List<ClipInfo> clips,
            List<TransitionInfo> transitions,
            File outputFile,
            int targetWidth, int targetHeight,
            String bgMusicPath, float bgMusicVolume,
            String introPath, String outroPath,
            boolean hasIntro, boolean hasOutro,
            ProgressCallback cb
    ) throws Exception {

        // ── Step 0: Build ordered input list with durations ──────────────
        List<String> inputPaths = new ArrayList<>();
        List<Double> inputDurations = new ArrayList<>(); // effective duration in seconds

        if (hasIntro) {
            inputPaths.add(introPath);
            inputDurations.add(probeDurationSec(introPath, 0, 0));
        }
        for (ClipInfo clip : clips) {
            inputPaths.add(clip.path);
            inputDurations.add(probeDurationSec(clip.path, clip.trimStartMs, clip.trimEndMs));
        }
        if (hasOutro) {
            inputPaths.add(outroPath);
            inputDurations.add(probeDurationSec(outroPath, 0, 0));
        }

        int totalInputs = inputPaths.size();
        Log.d(TAG, "FFmpeg: " + totalInputs + " inputs, durations=" + inputDurations);

        // ── Step 1: Build -i arguments ──────────────────────────────────
        StringBuilder cmd = new StringBuilder();
        for (String path : inputPaths) {
            cmd.append("-i \"").append(path).append("\" ");
        }

        // Background music input
        int bgMusicIdx = -1;
        if (bgMusicPath != null && !bgMusicPath.isEmpty()) {
            String cleanBgMusic = ClipInfo.sanitizePath(bgMusicPath);
            if (new File(cleanBgMusic).exists()) {
                bgMusicIdx = totalInputs; // index after all video inputs
                cmd.append("-i \"").append(cleanBgMusic).append("\" ");
            }
        }

        // ── Step 2: Build filter_complex ────────────────────────────────
        StringBuilder filter = new StringBuilder();

        // Normalize all inputs: scale, pad, fps, audio format
        for (int i = 0; i < totalInputs; i++) {
            // Video: determine trim filter
            String trimFilter = "";
            ClipInfo clipForTrim = getClipForInput(i, clips, hasIntro);
            if (clipForTrim != null && (clipForTrim.trimStartMs > 0 || clipForTrim.trimEndMs > 0)) {
                double startSec = clipForTrim.trimStartMs / 1000.0;
                if (clipForTrim.trimEndMs > 0) {
                    trimFilter = String.format(Locale.US,
                        "trim=%.3f:%.3f,setpts=PTS-STARTPTS,", startSec, clipForTrim.trimEndMs / 1000.0);
                } else {
                    trimFilter = String.format(Locale.US,
                        "trim=start=%.3f,setpts=PTS-STARTPTS,", startSec);
                }
            }
            filter.append(String.format(Locale.US,
                "[%d:v]%sscale=%d:%d:force_original_aspect_ratio=decrease," +
                "pad=%d:%d:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30[v%d];",
                i, trimFilter, targetWidth, targetHeight, targetWidth, targetHeight, i));

            // Audio: determine trim filter
            String audioTrim = "";
            if (clipForTrim != null && (clipForTrim.trimStartMs > 0 || clipForTrim.trimEndMs > 0)) {
                double startSec = clipForTrim.trimStartMs / 1000.0;
                if (clipForTrim.trimEndMs > 0) {
                    audioTrim = String.format(Locale.US,
                        "atrim=%.3f:%.3f,asetpts=PTS-STARTPTS,", startSec, clipForTrim.trimEndMs / 1000.0);
                } else {
                    audioTrim = String.format(Locale.US,
                        "atrim=start=%.3f,asetpts=PTS-STARTPTS,", startSec);
                }
            }
            filter.append(String.format(Locale.US,
                "[%d:a]%saformat=sample_rates=44100:channel_layouts=stereo[a%d];",
                i, audioTrim, i));
        }

        // ── Step 3: Build transition chain ──────────────────────────────
        // Build the full transition list (intro→clip, clip→clip, clip→outro)
        // For intro/outro joints where no user transition exists, use hard-cut
        List<TransitionInfo> fullTransitions = new ArrayList<>();
        for (int i = 1; i < totalInputs; i++) {
            TransitionInfo t = null;
            // Map input-pair index to the user's transitions array
            int userTransIdx;
            if (hasIntro) {
                userTransIdx = i - 2; // first user transition is between clip[0] and clip[1]
            } else {
                userTransIdx = i - 1;
            }
            if (transitions != null && userTransIdx >= 0 && userTransIdx < transitions.size()) {
                t = transitions.get(userTransIdx);
            }
            fullTransitions.add(t != null ? t : new TransitionInfo("none", 0));
        }

        if (totalInputs >= 2) {
            // Chain xfade/concat operations pairwise
            String prevVideo = "[v0]";
            String prevAudio = "[a0]";
            // Running offset = duration of accumulated output so far
            double runningDuration = inputDurations.get(0);

            for (int i = 0; i < fullTransitions.size(); i++) {
                TransitionInfo t = fullTransitions.get(i);
                int nextInputIdx = i + 1;
                String nextVideo = "[v" + nextInputIdx + "]";
                String nextAudio = "[a" + nextInputIdx + "]";
                String outVideo = (i < fullTransitions.size() - 1) ? "[xv" + i + "]" : "[outv]";
                String outAudio = (i < fullTransitions.size() - 1) ? "[xa" + i + "]" : "[outa]";

                boolean isTransition = t.type != null && !"none".equalsIgnoreCase(t.type) && t.durationMs > 0;

                if (isTransition) {
                    double xfadeDur = t.durationMs / 1000.0;
                    // offset = point in the accumulated output where the crossfade starts
                    // = total accumulated duration MINUS the crossfade overlap
                    double offset = Math.max(0, runningDuration - xfadeDur);

                    Log.d(TAG, String.format(Locale.US,
                        "xfade[%d→%d]: type=%s dur=%.2fs offset=%.2fs (running=%.2fs)",
                        i, nextInputIdx, t.type, xfadeDur, offset, runningDuration));

                    filter.append(String.format(Locale.US,
                        "%s%sxfade=transition=fade:duration=%.3f:offset=%.3f%s;",
                        prevVideo, nextVideo, xfadeDur, offset, outVideo));
                    filter.append(String.format(Locale.US,
                        "%s%sacrossfade=d=%.3f:c1=tri:c2=tri%s;",
                        prevAudio, nextAudio, xfadeDur, outAudio));

                    // After crossfade, the total duration shrinks by the overlap
                    runningDuration = offset + inputDurations.get(nextInputIdx);
                } else {
                    // Hard-cut: concat
                    filter.append(String.format(Locale.US,
                        "%s%sconcat=n=2:v=1:a=0%s;", prevVideo, nextVideo, outVideo));
                    filter.append(String.format(Locale.US,
                        "%s%sconcat=n=2:v=0:a=1%s;", prevAudio, nextAudio, outAudio));

                    runningDuration += inputDurations.get(nextInputIdx);
                }

                prevVideo = outVideo;
                prevAudio = outAudio;
            }
        } else {
            // Single input — just pass through
            filter.append("[v0]null[outv];[a0]anull[outa];");
        }

        // ── Step 4: Mix background music ────────────────────────────────
        String finalAudio = "[outa]";
        if (bgMusicIdx >= 0) {
            filter.append(String.format(Locale.US,
                "[%d:a]aloop=loop=-1:size=2e9,volume=%.2f[bgm];", bgMusicIdx, bgMusicVolume));
            filter.append(String.format(Locale.US,
                "%s[bgm]amix=inputs=2:duration=first:dropout_transition=2[finala];", finalAudio));
            finalAudio = "[finala]";
        }

        // ── Step 5: Build final command ─────────────────────────────────
        String filterStr = filter.toString();
        if (filterStr.endsWith(";")) {
            filterStr = filterStr.substring(0, filterStr.length() - 1);
        }

        cmd.append("-filter_complex \"").append(filterStr).append("\" ");
        cmd.append("-map \"[outv]\" -map \"").append(finalAudio).append("\" ");
        cmd.append("-c:v libx264 -preset ultrafast -crf 23 ");
        cmd.append("-c:a aac -b:a 128k ");
        cmd.append("-movflags +faststart ");
        cmd.append("-y \"").append(outputFile.getAbsolutePath()).append("\"");

        String finalCmd = cmd.toString();
        Log.d(TAG, "FFmpeg command: " + finalCmd);

        if (cb != null) cb.onProgress(0.05f);

        FFmpegSession session = FFmpegKit.execute(finalCmd);

        if (ReturnCode.isSuccess(session.getReturnCode())) {
            Log.d(TAG, "FFmpeg composition successful: " + outputFile.getAbsolutePath());
            if (cb != null) cb.onProgress(1.0f);
        } else {
            String logs = session.getOutput();
            Log.e(TAG, "FFmpeg failed: " + logs);
            throw new Exception("FFmpeg composition failed: " + session.getReturnCode()
                + "\n" + (logs != null && logs.length() > 500 ? logs.substring(logs.length() - 500) : logs));
        }
    }

    /**
     * Probe the effective duration of a media file in seconds.
     * If trim is specified, returns the trimmed duration.
     */
    private double probeDurationSec(String path, long trimStartMs, long trimEndMs) {
        try {
            MediaExtractor ext = new MediaExtractor();
            ext.setDataSource(path);
            long durUs = 0;
            for (int t = 0; t < ext.getTrackCount(); t++) {
                MediaFormat fmt = ext.getTrackFormat(t);
                if (fmt.containsKey(MediaFormat.KEY_DURATION)) {
                    durUs = Math.max(durUs, fmt.getLong(MediaFormat.KEY_DURATION));
                }
            }
            ext.release();
            double durSec = durUs / 1_000_000.0;
            double startSec = trimStartMs / 1000.0;
            double endSec = trimEndMs > 0 ? trimEndMs / 1000.0 : durSec;
            double effectiveDur = endSec - startSec;
            return Math.max(0.1, effectiveDur); // min 100ms to avoid division by zero
        } catch (Exception e) {
            Log.w(TAG, "probeDurationSec failed for " + path + ": " + e.getMessage());
            return 5.0; // fallback 5 seconds
        }
    }

    /**
     * Map an input index (in the full intro+clips+outro list) to a ClipInfo,
     * returning null for intro/outro positions.
     */
    private ClipInfo getClipForInput(int inputIdx, List<ClipInfo> clips, boolean hasIntro) {
        int clipIdx = hasIntro ? inputIdx - 1 : inputIdx;
        if (clipIdx >= 0 && clipIdx < clips.size()) {
            return clips.get(clipIdx);
        }
        return null; // intro or outro position
    }


    // ── MediaMuxer Fast Path (hard-cuts only, no intro/outro) ────────────────

    /**
     * Check whether an audio MIME type is compatible with the MP4 muxer.
     */
    private boolean needsAudioTranscode(MediaFormat format) {
        String mime = format.getString(MediaFormat.KEY_MIME);
        return mime != null && !mime.equals("audio/mp4a-latm");
    }

    /**
     * Create an AAC encoder format matching the input's channel count and sample rate.
     */
    private MediaFormat createAacFormat(MediaFormat inputFormat) {
        int sampleRate = inputFormat.containsKey(MediaFormat.KEY_SAMPLE_RATE)
                ? inputFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE) : 44100;
        int channelCount = inputFormat.containsKey(MediaFormat.KEY_CHANNEL_COUNT)
                ? inputFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT) : 1;
        int bitRate = 128_000;
        MediaFormat format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, sampleRate, channelCount);
        format.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC);
        format.setInteger(MediaFormat.KEY_BIT_RATE, bitRate);
        return format;
    }

    /**
     * Copy a single clip to output (with optional audio transcoding).
     */
    private void copySingleClip(ClipInfo clip, File outputFile, ProgressCallback cb) throws Exception {
        MediaExtractor extractor = new MediaExtractor();
        try {
            extractor.setDataSource(clip.path);
        } catch (IOException e) {
            throw new Exception("Cannot open clip: " + clip.path + " — " + e.getMessage(), e);
        }

        MediaMuxer muxer = new MediaMuxer(
            outputFile.getAbsolutePath(),
            MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4
        );

        int srcVideoTrack = -1, srcAudioTrack = -1;
        int muxVideoTrack = -1, muxAudioTrack = -1;
        boolean audioNeedsTranscode = false;

        for (int t = 0; t < extractor.getTrackCount(); t++) {
            MediaFormat fmt = extractor.getTrackFormat(t);
            String mime = fmt.getString(MediaFormat.KEY_MIME);
            if (mime != null && mime.startsWith("video/") && srcVideoTrack < 0) {
                srcVideoTrack = t;
                muxVideoTrack = muxer.addTrack(fmt);
                if (fmt.containsKey(MediaFormat.KEY_ROTATION)) {
                    muxer.setOrientationHint(fmt.getInteger(MediaFormat.KEY_ROTATION));
                }
                extractor.selectTrack(t);
            } else if (mime != null && mime.startsWith("audio/") && srcAudioTrack < 0) {
                srcAudioTrack = t;
                if (needsAudioTranscode(fmt)) {
                    audioNeedsTranscode = true;
                    muxAudioTrack = muxer.addTrack(createAacFormat(fmt));
                } else {
                    muxAudioTrack = muxer.addTrack(fmt);
                }
                extractor.selectTrack(t);
            }
        }

        if (muxVideoTrack < 0) {
            extractor.release();
            throw new Exception("No video track found in clip");
        }

        muxer.start();

        if (audioNeedsTranscode && srcAudioTrack >= 0) {
            // copyClipWithAudioTranscode releases muxer+extractor internally
            // because it delegates to FFmpeg instead
            copyClipWithAudioTranscode(extractor, muxer, srcVideoTrack, srcAudioTrack,
                    muxVideoTrack, muxAudioTrack, clip, cb);
            // Do NOT stop/release muxer or extractor — already done
        } else {
            copyClipDirect(extractor, muxer, srcVideoTrack, srcAudioTrack,
                    muxVideoTrack, muxAudioTrack, clip, cb);
            muxer.stop();
            muxer.release();
            extractor.release();
        }
        if (cb != null) cb.onProgress(1.0f);
    }

    private void copyClipDirect(MediaExtractor extractor, MediaMuxer muxer,
            int srcVideo, int srcAudio, int muxVideo, int muxAudio,
            ClipInfo clip, ProgressCallback cb) throws Exception {
        long startUs = clip.trimStartMs * 1000;
        long endUs = clip.trimEndMs > 0 ? clip.trimEndMs * 1000 : Long.MAX_VALUE;
        if (startUs > 0) extractor.seekTo(startUs, MediaExtractor.SEEK_TO_CLOSEST_SYNC);

        ByteBuffer buffer = ByteBuffer.allocate(2 * 1024 * 1024);
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();

        while (!cancelled) {
            int trackIdx = extractor.getSampleTrackIndex();
            if (trackIdx < 0) break;
            long sampleTime = extractor.getSampleTime();
            if (sampleTime > endUs) break;

            int outTrack = -1;
            if (trackIdx == srcVideo && muxVideo >= 0) outTrack = muxVideo;
            else if (trackIdx == srcAudio && muxAudio >= 0) outTrack = muxAudio;
            if (outTrack < 0) { extractor.advance(); continue; }

            buffer.clear();
            int size = extractor.readSampleData(buffer, 0);
            if (size < 0) break;

            info.offset = 0;
            info.size = size;
            info.presentationTimeUs = sampleTime;
            info.flags = extractor.getSampleFlags();
            muxer.writeSampleData(outTrack, buffer, info);
            extractor.advance();
        }
    }

    private void copyClipWithAudioTranscode(MediaExtractor extractor, MediaMuxer muxer,
            int srcVideo, int srcAudio, int muxVideo, int muxAudio,
            ClipInfo clip, ProgressCallback cb) throws Exception {
        // The MediaMuxer was already started by the caller but we can't use it
        // for Opus audio. Stop/release it, then use FFmpeg to re-encode the audio.
        try { muxer.stop(); } catch (Exception ignore) {}
        try { muxer.release(); } catch (Exception ignore) {}
        extractor.release();

        // Use FFmpeg for the transcode: copy video, encode audio to AAC
        String trimArgs = "";
        if (clip.trimStartMs > 0) {
            trimArgs += String.format(Locale.US, " -ss %.3f", clip.trimStartMs / 1000.0);
        }
        if (clip.trimEndMs > 0) {
            trimArgs += String.format(Locale.US, " -to %.3f", clip.trimEndMs / 1000.0);
        }

        // Get the output file from cache (caller already created the muxer at this path)
        File outputDir = new File(context.getCacheDir(), "exports");
        if (!outputDir.exists()) outputDir.mkdirs();
        File tempOut = new File(outputDir, "transcode_" + System.currentTimeMillis() + ".mp4");

        String cmd = String.format(Locale.US,
            "%s -i \"%s\" -c:v copy -c:a aac -b:a 128k -movflags +faststart -y \"%s\"",
            trimArgs, clip.path, tempOut.getAbsolutePath());

        Log.d(TAG, "Single clip transcode: " + cmd);
        FFmpegSession session = FFmpegKit.execute(cmd);
        if (!ReturnCode.isSuccess(session.getReturnCode())) {
            throw new Exception("Audio transcode failed: " + session.getOutput());
        }
        if (cb != null) cb.onProgress(1.0f);
    }


    // ── MediaMuxer Concatenation (hard-cuts only) ────────────────────────────

    private void concatenateClips(
            List<ClipInfo> clips,
            File outputFile,
            int targetWidth,
            int targetHeight,
            ProgressCallback cb
    ) throws Exception {

        // First pass: determine total duration for progress
        long totalDurationUs = 0;
        for (ClipInfo clip : clips) {
            MediaExtractor ext = new MediaExtractor();
            try { ext.setDataSource(clip.path); }
            catch (IOException e) { throw new Exception("Cannot open clip: " + clip.path, e); }
            long dur = 0;
            for (int t = 0; t < ext.getTrackCount(); t++) {
                MediaFormat fmt = ext.getTrackFormat(t);
                if (fmt.containsKey(MediaFormat.KEY_DURATION)) {
                    dur = Math.max(dur, fmt.getLong(MediaFormat.KEY_DURATION));
                }
            }
            long startUs = clip.trimStartMs * 1000;
            long endUs = clip.trimEndMs > 0 ? clip.trimEndMs * 1000 : dur;
            totalDurationUs += (endUs - startUs);
            ext.release();
        }

        // Set up muxer from first clip's format
        MediaExtractor firstExt = new MediaExtractor();
        firstExt.setDataSource(clips.get(0).path);

        MediaMuxer muxer = new MediaMuxer(
            outputFile.getAbsolutePath(),
            MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4
        );

        int srcVideoTrack = -1, srcAudioTrack = -1;
        int muxVideoTrack = -1, muxAudioTrack = -1;
        boolean audioNeedsTranscode = false;

        for (int t = 0; t < firstExt.getTrackCount(); t++) {
            MediaFormat fmt = firstExt.getTrackFormat(t);
            String mime = fmt.getString(MediaFormat.KEY_MIME);
            if (mime != null && mime.startsWith("video/") && srcVideoTrack < 0) {
                srcVideoTrack = t;
                muxVideoTrack = muxer.addTrack(fmt);
                if (fmt.containsKey(MediaFormat.KEY_ROTATION)) {
                    muxer.setOrientationHint(fmt.getInteger(MediaFormat.KEY_ROTATION));
                }
            } else if (mime != null && mime.startsWith("audio/") && srcAudioTrack < 0) {
                srcAudioTrack = t;
                if (needsAudioTranscode(fmt)) {
                    audioNeedsTranscode = true;
                    muxAudioTrack = muxer.addTrack(createAacFormat(fmt));
                } else {
                    muxAudioTrack = muxer.addTrack(fmt);
                }
            }
        }
        firstExt.release();

        if (muxVideoTrack < 0) throw new Exception("No video track found in first clip");
        muxer.start();

        // If audio needs transcoding, fall back to FFmpeg for the whole concat
        if (audioNeedsTranscode) {
            muxer.stop();
            muxer.release();
            Log.d(TAG, "Audio needs transcoding — falling back to FFmpeg concat");
            composeWithFFmpeg(clips, null, outputFile, targetWidth, targetHeight,
                    "", 0.0f, null, null, false, false, cb);
            return;
        }

        long cumulativeTimeUs = 0;
        for (int c = 0; c < clips.size(); c++) {
            if (cancelled) break;
            ClipInfo clip = clips.get(c);
            Log.d(TAG, "Concat clip " + (c+1) + "/" + clips.size()
                + " offset=" + cumulativeTimeUs + "µs");

            long maxPts = concatenateClipDirect(clip, muxer, muxVideoTrack, muxAudioTrack,
                    cumulativeTimeUs, totalDurationUs, cb);
            cumulativeTimeUs = maxPts + 10_000; // 10ms safety gap
        }

        muxer.stop();
        muxer.release();
        if (cb != null) cb.onProgress(1.0f);
    }

    private long concatenateClipDirect(
            ClipInfo clip, MediaMuxer muxer,
            int muxVideoTrack, int muxAudioTrack,
            long cumulativeTimeUs, long totalDurationUs, ProgressCallback cb
    ) throws Exception {
        MediaExtractor extractor = new MediaExtractor();
        extractor.setDataSource(clip.path);

        int clipVideoTrack = -1, clipAudioTrack = -1;
        for (int t = 0; t < extractor.getTrackCount(); t++) {
            MediaFormat fmt = extractor.getTrackFormat(t);
            String mime = fmt.getString(MediaFormat.KEY_MIME);
            if (mime != null && mime.startsWith("video/") && clipVideoTrack < 0) {
                clipVideoTrack = t; extractor.selectTrack(t);
            } else if (mime != null && mime.startsWith("audio/") && clipAudioTrack < 0) {
                clipAudioTrack = t; extractor.selectTrack(t);
            }
        }

        long startUs = clip.trimStartMs * 1000;
        long endUs = clip.trimEndMs > 0 ? clip.trimEndMs * 1000 : Long.MAX_VALUE;
        if (startUs > 0) extractor.seekTo(startUs, MediaExtractor.SEEK_TO_CLOSEST_SYNC);

        ByteBuffer buffer = ByteBuffer.allocate(2 * 1024 * 1024);
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        long clipBaseTime = -1;
        long maxPtsWritten = cumulativeTimeUs;

        while (!cancelled) {
            int trackIdx = extractor.getSampleTrackIndex();
            if (trackIdx < 0) break;
            long sampleTime = extractor.getSampleTime();
            if (sampleTime > endUs) break;

            int outTrack = -1;
            if (trackIdx == clipVideoTrack && muxVideoTrack >= 0) outTrack = muxVideoTrack;
            else if (trackIdx == clipAudioTrack && muxAudioTrack >= 0) outTrack = muxAudioTrack;
            if (outTrack < 0) { extractor.advance(); continue; }
            if (clipBaseTime < 0) clipBaseTime = sampleTime;

            buffer.clear();
            int size = extractor.readSampleData(buffer, 0);
            if (size < 0) break;

            info.offset = 0;
            info.size = size;
            info.presentationTimeUs = (sampleTime - clipBaseTime) + cumulativeTimeUs;
            info.flags = extractor.getSampleFlags();
            muxer.writeSampleData(outTrack, buffer, info);

            if (info.presentationTimeUs > maxPtsWritten) maxPtsWritten = info.presentationTimeUs;
            extractor.advance();

            if (cb != null && totalDurationUs > 0) {
                cb.onProgress((float) info.presentationTimeUs / totalDurationUs);
            }
        }

        extractor.release();
        return maxPtsWritten;
    }
}
