package com.myguestbook.app;

import android.content.Context;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMuxer;
import android.net.Uri;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;

/**
 * NativeComposer — Hardware-accelerated video composition for Android.
 * 
 * Strategy:
 * - If all transitions are 'none' (hard-cut): uses fast MediaMuxer re-muxing
 *   (no re-encoding, near-instant concatenation)
 * - If any transition is 'crossfade': re-encodes affected segments using
 *   MediaCodec with surface-to-surface rendering
 * 
 * For this initial implementation, we use the simpler concat-demux approach
 * which works for same-format MP4 clips (which is our case since all clips
 * are recorded by the same device's MediaRecorder).
 */
public class NativeComposer {
    private static final String TAG = "NativeComposer";
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
            return raw.replaceFirst("^file://", "")
                      .replaceFirst("^content://", "");
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
    }

    /**
     * Compose multiple clips into a single output file.
     */
    public void compose(
            List<ClipInfo> clips,
            List<TransitionInfo> transitions,
            File outputFile,
            int targetWidth,
            int targetHeight,
            String bgMusicPath,
            float bgMusicVolume,
            ProgressCallback progressCallback
    ) throws Exception {
        cancelled = false;

        if (clips == null || clips.isEmpty()) {
            throw new IllegalArgumentException("No clips to compose");
        }

        if (clips.size() == 1) {
            // Single clip — just copy/trim it
            copySingleClip(clips.get(0), outputFile, progressCallback);
            return;
        }

        // Multi-clip concatenation using MediaMuxer
        concatenateClips(clips, outputFile, targetWidth, targetHeight, progressCallback);
    }

    /**
     * Copy a single clip (with optional trim) to the output.
     */
    private void copySingleClip(ClipInfo clip, File outputFile, ProgressCallback cb) throws Exception {
        MediaExtractor extractor = new MediaExtractor();
        extractor.setDataSource(clip.path);

        MediaMuxer muxer = new MediaMuxer(
            outputFile.getAbsolutePath(),
            MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4
        );

        int trackCount = extractor.getTrackCount();
        int[] trackMap = new int[trackCount];
        int rotationDegrees = 0;

        for (int i = 0; i < trackCount; i++) {
            MediaFormat format = extractor.getTrackFormat(i);
            trackMap[i] = muxer.addTrack(format);
            extractor.selectTrack(i);
            // Extract rotation metadata from video track
            String mime = format.getString(MediaFormat.KEY_MIME);
            if (mime != null && mime.startsWith("video/")) {
                if (format.containsKey(MediaFormat.KEY_ROTATION)) {
                    rotationDegrees = format.getInteger(MediaFormat.KEY_ROTATION);
                }
            }
        }

        // Preserve rotation metadata so portrait recordings play upright
        if (rotationDegrees != 0) {
            muxer.setOrientationHint(rotationDegrees);
            Log.d(TAG, "Single clip rotation: " + rotationDegrees + "°");
        }

        muxer.start();

        // Seek to trim start if needed
        long startUs = clip.trimStartMs * 1000;
        long endUs = clip.trimEndMs > 0 ? clip.trimEndMs * 1000 : Long.MAX_VALUE;
        if (startUs > 0) {
            extractor.seekTo(startUs, MediaExtractor.SEEK_TO_CLOSEST_SYNC);
        }

        ByteBuffer buffer = ByteBuffer.allocate(1024 * 1024); // 1MB buffer
        MediaCodec.BufferInfo bufferInfo = new MediaCodec.BufferInfo();

        while (!cancelled) {
            int trackIndex = extractor.getSampleTrackIndex();
            if (trackIndex < 0) break;

            long sampleTime = extractor.getSampleTime();
            if (sampleTime > endUs) break;

            buffer.clear();
            int sampleSize = extractor.readSampleData(buffer, 0);
            if (sampleSize < 0) break;

            bufferInfo.offset = 0;
            bufferInfo.size = sampleSize;
            bufferInfo.presentationTimeUs = sampleTime - startUs;
            bufferInfo.flags = extractor.getSampleFlags();

            muxer.writeSampleData(trackMap[trackIndex], buffer, bufferInfo);
            extractor.advance();
        }

        muxer.stop();
        muxer.release();
        extractor.release();

        if (cb != null) cb.onProgress(1.0f);
    }

    /**
     * Concatenate multiple clips using MediaExtractor + MediaMuxer.
     * This is a fast re-muxing approach (no re-encoding) that works when
     * all clips have compatible formats (same codec, resolution, etc.),
     * which is the case for clips recorded by the same device.
     */
    private void concatenateClips(
            List<ClipInfo> clips,
            File outputFile,
            int targetWidth,
            int targetHeight,
            ProgressCallback cb
    ) throws Exception {

        // First pass: determine total duration for progress
        long totalDurationUs = 0;
        List<Long> clipDurations = new ArrayList<>();
        for (ClipInfo clip : clips) {
            MediaExtractor ext = new MediaExtractor();
            ext.setDataSource(clip.path);
            long dur = 0;
            for (int t = 0; t < ext.getTrackCount(); t++) {
                MediaFormat fmt = ext.getTrackFormat(t);
                if (fmt.containsKey(MediaFormat.KEY_DURATION)) {
                    dur = Math.max(dur, fmt.getLong(MediaFormat.KEY_DURATION));
                }
            }
            // Apply trim
            long startUs = clip.trimStartMs * 1000;
            long endUs = clip.trimEndMs > 0 ? clip.trimEndMs * 1000 : dur;
            long effectiveDur = endUs - startUs;
            clipDurations.add(effectiveDur);
            totalDurationUs += effectiveDur;
            ext.release();
        }

        // Second pass: extract format from first clip and create muxer
        MediaExtractor firstExt = new MediaExtractor();
        firstExt.setDataSource(clips.get(0).path);

        MediaMuxer muxer = new MediaMuxer(
            outputFile.getAbsolutePath(),
            MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4
        );

        // Find video and audio tracks
        int srcVideoTrack = -1, srcAudioTrack = -1;
        int muxVideoTrack = -1, muxAudioTrack = -1;
        int rotationDegrees = 0;

        for (int t = 0; t < firstExt.getTrackCount(); t++) {
            MediaFormat fmt = firstExt.getTrackFormat(t);
            String mime = fmt.getString(MediaFormat.KEY_MIME);
            if (mime != null && mime.startsWith("video/") && srcVideoTrack < 0) {
                srcVideoTrack = t;
                muxVideoTrack = muxer.addTrack(fmt);
                // Extract rotation metadata (0, 90, 180, or 270 degrees)
                // Portrait recordings are typically stored as landscape + 90° rotation flag
                if (fmt.containsKey(MediaFormat.KEY_ROTATION)) {
                    rotationDegrees = fmt.getInteger(MediaFormat.KEY_ROTATION);
                }
            } else if (mime != null && mime.startsWith("audio/") && srcAudioTrack < 0) {
                srcAudioTrack = t;
                muxAudioTrack = muxer.addTrack(fmt);
            }
        }
        firstExt.release();

        if (muxVideoTrack < 0) {
            throw new Exception("No video track found in first clip");
        }

        // Apply rotation metadata to output — ensures portrait recordings
        // compile upright, not sideways. Uses the first clip's rotation as the
        // reference since all clips are recorded on the same device.
        if (rotationDegrees != 0) {
            muxer.setOrientationHint(rotationDegrees);
            Log.d(TAG, "Output rotation hint set to " + rotationDegrees + "° (from first clip)");
        }

        muxer.start();

        long cumulativeTimeUs = 0;
        long writtenDurationUs = 0;
        ByteBuffer buffer = ByteBuffer.allocate(2 * 1024 * 1024); // 2MB buffer
        MediaCodec.BufferInfo bufferInfo = new MediaCodec.BufferInfo();

        for (int c = 0; c < clips.size(); c++) {
            if (cancelled) break;

            ClipInfo clip = clips.get(c);
            MediaExtractor extractor = new MediaExtractor();
            extractor.setDataSource(clip.path);

            // Find matching tracks in this clip
            int clipVideoTrack = -1, clipAudioTrack = -1;
            for (int t = 0; t < extractor.getTrackCount(); t++) {
                MediaFormat fmt = extractor.getTrackFormat(t);
                String mime = fmt.getString(MediaFormat.KEY_MIME);
                if (mime != null && mime.startsWith("video/") && clipVideoTrack < 0) {
                    clipVideoTrack = t;
                    extractor.selectTrack(t);
                } else if (mime != null && mime.startsWith("audio/") && clipAudioTrack < 0) {
                    clipAudioTrack = t;
                    extractor.selectTrack(t);
                }
            }

            long startUs = clip.trimStartMs * 1000;
            long endUs = clip.trimEndMs > 0 ? clip.trimEndMs * 1000 : Long.MAX_VALUE;
            if (startUs > 0) {
                extractor.seekTo(startUs, MediaExtractor.SEEK_TO_CLOSEST_SYNC);
            }

            long clipBaseTime = -1;

            while (!cancelled) {
                int trackIndex = extractor.getSampleTrackIndex();
                if (trackIndex < 0) break;

                long sampleTime = extractor.getSampleTime();
                if (sampleTime > endUs) break;

                // Determine output track
                int outTrack = -1;
                if (trackIndex == clipVideoTrack && muxVideoTrack >= 0) {
                    outTrack = muxVideoTrack;
                } else if (trackIndex == clipAudioTrack && muxAudioTrack >= 0) {
                    outTrack = muxAudioTrack;
                }

                if (outTrack < 0) {
                    extractor.advance();
                    continue;
                }

                // Initialize base time for this clip
                if (clipBaseTime < 0) {
                    clipBaseTime = sampleTime;
                }

                buffer.clear();
                int sampleSize = extractor.readSampleData(buffer, 0);
                if (sampleSize < 0) break;

                bufferInfo.offset = 0;
                bufferInfo.size = sampleSize;
                // Remap timestamp: subtract clip base, add cumulative offset
                bufferInfo.presentationTimeUs = (sampleTime - clipBaseTime) + cumulativeTimeUs;
                bufferInfo.flags = extractor.getSampleFlags();

                muxer.writeSampleData(outTrack, buffer, bufferInfo);
                extractor.advance();

                // Update progress
                writtenDurationUs = bufferInfo.presentationTimeUs;
                if (cb != null && totalDurationUs > 0) {
                    cb.onProgress((float) writtenDurationUs / totalDurationUs);
                }
            }

            cumulativeTimeUs += clipDurations.get(c);
            extractor.release();

            Log.d(TAG, "Clip " + (c + 1) + "/" + clips.size() + " concatenated");
        }

        muxer.stop();
        muxer.release();

        if (cb != null) cb.onProgress(1.0f);
        Log.d(TAG, "Composition complete: " + outputFile.getAbsolutePath());
    }
}
