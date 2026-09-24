package com.myguestbook.app;

import android.content.Context;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMuxer;
import android.net.Uri;
import android.util.Log;

import java.io.File;
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
 * - Handles Opus/Vorbis audio from Android WebView's MediaRecorder by
 *   transcoding to AAC on-the-fly (MP4 requires AAC audio)
 *
 * For this initial implementation, we use the simpler concat-demux approach
 * which works for same-format clips (recorded by the same device's MediaRecorder).
 */
public class NativeComposer {
    private static final String TAG = "NativeComposer";
    private static final int AUDIO_TRANSCODE_TIMEOUT_US = 10_000; // 10ms timeout for codec
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

        /**
         * Strip URI schemes that MediaExtractor.setDataSource() does not accept.
         * Capacitor returns paths like "file:///data/user/0/..." (triple slash)
         * which must be converted to plain "/data/user/0/..."
         */
        private static String sanitizePath(String raw) {
            if (raw == null) return "";
            // Handle file:///path and file://path and file:/path
            if (raw.startsWith("file:///")) {
                return raw.substring(7); // "file:///data/..." -> "/data/..."
            } else if (raw.startsWith("file://")) {
                return raw.substring(7);
            } else if (raw.startsWith("file:/")) {
                return raw.substring(5);
            }
            // Strip content:// (would need ContentResolver, not supported here)
            if (raw.startsWith("content://")) {
                return raw.substring(10);
            }
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
            copySingleClip(clips.get(0), outputFile, progressCallback);
            return;
        }

        concatenateClips(clips, outputFile, targetWidth, targetHeight, progressCallback);
    }

    /**
     * Check whether an audio MIME type is compatible with the MP4 muxer.
     * MP4 containers only accept AAC audio natively.
     */
    private boolean isAacAudio(String mime) {
        return mime != null && (
            mime.equals("audio/mp4a-latm") ||
            mime.equals("audio/aac") ||
            mime.startsWith("audio/mp4")
        );
    }

    /**
     * Check whether an audio track needs transcoding for MP4 output.
     */
    private boolean needsAudioTranscode(MediaFormat format) {
        String mime = format.getString(MediaFormat.KEY_MIME);
        return mime != null && mime.startsWith("audio/") && !isAacAudio(mime);
    }

    /**
     * Create an AAC output format matching the input audio's channel count and sample rate.
     */
    private MediaFormat createAacFormat(MediaFormat inputFormat) {
        int sampleRate = inputFormat.containsKey(MediaFormat.KEY_SAMPLE_RATE)
                ? inputFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE) : 44100;
        int channelCount = inputFormat.containsKey(MediaFormat.KEY_CHANNEL_COUNT)
                ? inputFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT) : 1;
        int bitRate = 128_000; // 128 kbps AAC

        MediaFormat aacFormat = MediaFormat.createAudioFormat(
                MediaFormat.MIMETYPE_AUDIO_AAC, sampleRate, channelCount);
        aacFormat.setInteger(MediaFormat.KEY_BIT_RATE, bitRate);
        aacFormat.setInteger(MediaFormat.KEY_AAC_PROFILE,
                MediaCodecInfo.CodecProfileLevel.AACObjectLC);
        aacFormat.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 65536);
        return aacFormat;
    }

    /**
     * Copy a single clip (with optional trim) to the output.
     * If the audio track is Opus/Vorbis, it will be transcoded to AAC.
     */
    private void copySingleClip(ClipInfo clip, File outputFile, ProgressCallback cb) throws Exception {
        Log.d(TAG, "copySingleClip: " + clip.path);
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

        int trackCount = extractor.getTrackCount();
        int[] trackMap = new int[trackCount];
        boolean[] isTranscodeTrack = new boolean[trackCount];
        int rotationDegrees = 0;
        int audioTrackForTranscode = -1;
        MediaFormat audioInputFormat = null;

        for (int i = 0; i < trackCount; i++) {
            MediaFormat format = extractor.getTrackFormat(i);
            String mime = format.getString(MediaFormat.KEY_MIME);
            Log.d(TAG, "Track " + i + " mime: " + mime);

            if (mime != null && mime.startsWith("video/")) {
                trackMap[i] = muxer.addTrack(format);
                extractor.selectTrack(i);
                if (format.containsKey(MediaFormat.KEY_ROTATION)) {
                    rotationDegrees = format.getInteger(MediaFormat.KEY_ROTATION);
                }
            } else if (mime != null && mime.startsWith("audio/")) {
                if (needsAudioTranscode(format)) {
                    // Opus/Vorbis → will be transcoded to AAC
                    Log.d(TAG, "Audio track " + i + " is " + mime + " — will transcode to AAC");
                    MediaFormat aacFormat = createAacFormat(format);
                    trackMap[i] = muxer.addTrack(aacFormat);
                    isTranscodeTrack[i] = true;
                    audioTrackForTranscode = i;
                    audioInputFormat = format;
                    extractor.selectTrack(i);
                } else {
                    // AAC → add directly
                    trackMap[i] = muxer.addTrack(format);
                    extractor.selectTrack(i);
                }
            }
        }

        if (rotationDegrees != 0) {
            muxer.setOrientationHint(rotationDegrees);
            Log.d(TAG, "Single clip rotation: " + rotationDegrees + "°");
        }

        muxer.start();

        // If we need audio transcoding, handle it separately
        if (audioTrackForTranscode >= 0 && audioInputFormat != null) {
            copyClipWithAudioTranscode(extractor, muxer, trackMap, isTranscodeTrack,
                    audioTrackForTranscode, audioInputFormat, clip, cb);
        } else {
            // Simple re-mux path (all tracks are MP4-compatible)
            copyClipDirect(extractor, muxer, trackMap, clip, cb);
        }

        muxer.stop();
        muxer.release();
        extractor.release();

        if (cb != null) cb.onProgress(1.0f);
        Log.d(TAG, "Single clip copy complete: " + outputFile.getAbsolutePath());
    }

    /**
     * Simple direct re-mux (no transcoding needed).
     */
    private void copyClipDirect(MediaExtractor extractor, MediaMuxer muxer,
                                int[] trackMap, ClipInfo clip, ProgressCallback cb) throws Exception {
        long startUs = clip.trimStartMs * 1000;
        long endUs = clip.trimEndMs > 0 ? clip.trimEndMs * 1000 : Long.MAX_VALUE;
        if (startUs > 0) {
            extractor.seekTo(startUs, MediaExtractor.SEEK_TO_CLOSEST_SYNC);
        }

        ByteBuffer buffer = ByteBuffer.allocate(1024 * 1024);
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
    }

    /**
     * Copy a clip with on-the-fly Opus/Vorbis→AAC audio transcoding.
     * Video samples are re-muxed directly (no re-encoding).
     * Audio samples are decoded to PCM and re-encoded to AAC.
     */
    private void copyClipWithAudioTranscode(
            MediaExtractor extractor, MediaMuxer muxer, int[] trackMap,
            boolean[] isTranscodeTrack, int audioTrack,
            MediaFormat audioInputFormat, ClipInfo clip, ProgressCallback cb
    ) throws Exception {
        String inputMime = audioInputFormat.getString(MediaFormat.KEY_MIME);
        MediaFormat aacOutputFormat = createAacFormat(audioInputFormat);

        // Create decoder for the input audio (Opus/Vorbis)
        MediaCodec decoder = MediaCodec.createDecoderByType(inputMime);
        decoder.configure(audioInputFormat, null, null, 0);
        decoder.start();

        // Create encoder for AAC output
        MediaCodec encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC);
        encoder.configure(aacOutputFormat, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        encoder.start();

        long startUs = clip.trimStartMs * 1000;
        long endUs = clip.trimEndMs > 0 ? clip.trimEndMs * 1000 : Long.MAX_VALUE;
        if (startUs > 0) {
            extractor.seekTo(startUs, MediaExtractor.SEEK_TO_CLOSEST_SYNC);
        }

        ByteBuffer directBuffer = ByteBuffer.allocate(1024 * 1024);
        MediaCodec.BufferInfo directInfo = new MediaCodec.BufferInfo();
        MediaCodec.BufferInfo decodeInfo = new MediaCodec.BufferInfo();
        MediaCodec.BufferInfo encodeInfo = new MediaCodec.BufferInfo();

        boolean extractorDone = false;
        boolean decoderDone = false;
        boolean encoderDone = false;
        int muxAudioTrack = trackMap[audioTrack];

        while (!cancelled && !encoderDone) {
            // 1. Feed extractor samples to decoder (audio) or muxer (video)
            if (!extractorDone) {
                int trackIndex = extractor.getSampleTrackIndex();
                if (trackIndex < 0) {
                    extractorDone = true;
                    // Signal end of stream to decoder
                    int inIdx = decoder.dequeueInputBuffer(AUDIO_TRANSCODE_TIMEOUT_US);
                    if (inIdx >= 0) {
                        decoder.queueInputBuffer(inIdx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                    }
                } else {
                    long sampleTime = extractor.getSampleTime();
                    if (sampleTime > endUs) {
                        extractorDone = true;
                        int inIdx = decoder.dequeueInputBuffer(AUDIO_TRANSCODE_TIMEOUT_US);
                        if (inIdx >= 0) {
                            decoder.queueInputBuffer(inIdx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                        }
                    } else if (isTranscodeTrack[trackIndex]) {
                        // Audio sample → feed to decoder
                        int inIdx = decoder.dequeueInputBuffer(AUDIO_TRANSCODE_TIMEOUT_US);
                        if (inIdx >= 0) {
                            ByteBuffer inBuf = decoder.getInputBuffer(inIdx);
                            inBuf.clear();
                            int size = extractor.readSampleData(inBuf, 0);
                            if (size >= 0) {
                                decoder.queueInputBuffer(inIdx, 0, size,
                                        extractor.getSampleTime() - startUs,
                                        extractor.getSampleFlags());
                                extractor.advance();
                            }
                        }
                    } else {
                        // Video sample → direct re-mux
                        directBuffer.clear();
                        int sampleSize = extractor.readSampleData(directBuffer, 0);
                        if (sampleSize >= 0) {
                            directInfo.offset = 0;
                            directInfo.size = sampleSize;
                            directInfo.presentationTimeUs = sampleTime - startUs;
                            directInfo.flags = extractor.getSampleFlags();
                            muxer.writeSampleData(trackMap[trackIndex], directBuffer, directInfo);
                        }
                        extractor.advance();
                    }
                }
            }

            // 2. Drain decoder → feed PCM to encoder
            if (!decoderDone) {
                int outIdx = decoder.dequeueOutputBuffer(decodeInfo, AUDIO_TRANSCODE_TIMEOUT_US);
                if (outIdx >= 0) {
                    ByteBuffer decodedBuf = decoder.getOutputBuffer(outIdx);
                    boolean eos = (decodeInfo.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0;

                    if (decodeInfo.size > 0) {
                        // Feed decoded PCM to encoder
                        int encInIdx = encoder.dequeueInputBuffer(AUDIO_TRANSCODE_TIMEOUT_US);
                        if (encInIdx >= 0) {
                            ByteBuffer encInBuf = encoder.getInputBuffer(encInIdx);
                            encInBuf.clear();
                            int toCopy = Math.min(decodedBuf.remaining(), encInBuf.capacity());
                            decodedBuf.limit(decodedBuf.position() + toCopy);
                            encInBuf.put(decodedBuf);
                            encoder.queueInputBuffer(encInIdx, 0, toCopy,
                                    decodeInfo.presentationTimeUs,
                                    eos ? MediaCodec.BUFFER_FLAG_END_OF_STREAM : 0);
                        }
                    }
                    decoder.releaseOutputBuffer(outIdx, false);
                    if (eos) decoderDone = true;
                }
            }

            // 3. Drain encoder → write AAC to muxer
            int encOutIdx = encoder.dequeueOutputBuffer(encodeInfo, AUDIO_TRANSCODE_TIMEOUT_US);
            if (encOutIdx >= 0) {
                ByteBuffer encodedBuf = encoder.getOutputBuffer(encOutIdx);
                if (encodeInfo.size > 0 && encodedBuf != null) {
                    muxer.writeSampleData(muxAudioTrack, encodedBuf, encodeInfo);
                }
                boolean eos = (encodeInfo.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0;
                encoder.releaseOutputBuffer(encOutIdx, false);
                if (eos) encoderDone = true;
            }
        }

        encoder.stop();
        encoder.release();
        decoder.stop();
        decoder.release();
    }

    /**
     * Concatenate multiple clips using MediaExtractor + MediaMuxer.
     * Audio tracks that are not AAC are transcoded to AAC on-the-fly.
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
            try {
                ext.setDataSource(clip.path);
            } catch (IOException e) {
                throw new Exception("Cannot open clip: " + clip.path + " — " + e.getMessage(), e);
            }
            long dur = 0;
            for (int t = 0; t < ext.getTrackCount(); t++) {
                MediaFormat fmt = ext.getTrackFormat(t);
                if (fmt.containsKey(MediaFormat.KEY_DURATION)) {
                    dur = Math.max(dur, fmt.getLong(MediaFormat.KEY_DURATION));
                }
            }
            long startUs = clip.trimStartMs * 1000;
            long endUs = clip.trimEndMs > 0 ? clip.trimEndMs * 1000 : dur;
            long effectiveDur = endUs - startUs;
            clipDurations.add(effectiveDur);
            totalDurationUs += effectiveDur;
            ext.release();
        }

        // Second pass: extract format from first clip, detect audio codec
        MediaExtractor firstExt = new MediaExtractor();
        firstExt.setDataSource(clips.get(0).path);

        MediaMuxer muxer = new MediaMuxer(
            outputFile.getAbsolutePath(),
            MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4
        );

        int srcVideoTrack = -1, srcAudioTrack = -1;
        int muxVideoTrack = -1, muxAudioTrack = -1;
        int rotationDegrees = 0;
        boolean audioNeedsTranscode = false;
        MediaFormat audioInputFormat = null;

        for (int t = 0; t < firstExt.getTrackCount(); t++) {
            MediaFormat fmt = firstExt.getTrackFormat(t);
            String mime = fmt.getString(MediaFormat.KEY_MIME);
            Log.d(TAG, "First clip track " + t + " mime: " + mime);

            if (mime != null && mime.startsWith("video/") && srcVideoTrack < 0) {
                srcVideoTrack = t;
                muxVideoTrack = muxer.addTrack(fmt);
                if (fmt.containsKey(MediaFormat.KEY_ROTATION)) {
                    rotationDegrees = fmt.getInteger(MediaFormat.KEY_ROTATION);
                }
            } else if (mime != null && mime.startsWith("audio/") && srcAudioTrack < 0) {
                srcAudioTrack = t;
                audioInputFormat = fmt;
                if (needsAudioTranscode(fmt)) {
                    // Add an AAC track to the muxer instead of the Opus/Vorbis track
                    audioNeedsTranscode = true;
                    MediaFormat aacFormat = createAacFormat(fmt);
                    muxAudioTrack = muxer.addTrack(aacFormat);
                    Log.d(TAG, "Audio is " + mime + " — will transcode each clip to AAC");
                } else {
                    muxAudioTrack = muxer.addTrack(fmt);
                }
            }
        }
        firstExt.release();

        if (muxVideoTrack < 0) {
            throw new Exception("No video track found in first clip");
        }

        if (rotationDegrees != 0) {
            muxer.setOrientationHint(rotationDegrees);
            Log.d(TAG, "Output rotation hint set to " + rotationDegrees + "° (from first clip)");
        }

        muxer.start();

        // Track the running PTS offset — use actual max PTS written, NOT
        // KEY_DURATION metadata (which is unreliable and causes out-of-order
        // frame crashes when clip 2's timestamps overlap clip 1's actual end).
        long cumulativeTimeUs = 0;

        for (int c = 0; c < clips.size(); c++) {
            if (cancelled) break;

            ClipInfo clip = clips.get(c);
            Log.d(TAG, "Processing clip " + (c + 1) + "/" + clips.size()
                + ": " + clip.path + " (offset=" + cumulativeTimeUs + "µs)");

            long maxPtsWritten;
            if (audioNeedsTranscode && muxAudioTrack >= 0) {
                maxPtsWritten = concatenateClipWithTranscode(clip, muxer, muxVideoTrack, muxAudioTrack,
                        cumulativeTimeUs, totalDurationUs, cb);
            } else {
                maxPtsWritten = concatenateClipDirect(clip, muxer, muxVideoTrack, muxAudioTrack,
                        cumulativeTimeUs, totalDurationUs, cb);
            }

            // Advance the offset by the actual max PTS observed in this clip,
            // plus a small gap (10ms) to guarantee no overlap between clips.
            cumulativeTimeUs = maxPtsWritten + 10_000;
            Log.d(TAG, "Clip " + (c + 1) + "/" + clips.size()
                + " done — next offset: " + cumulativeTimeUs + "µs");
        }

        muxer.stop();
        muxer.release();

        if (cb != null) cb.onProgress(1.0f);
        Log.d(TAG, "Composition complete: " + outputFile.getAbsolutePath());
    }

    /**
     * Concatenate a single clip by direct re-mux (no audio transcoding needed).
     * @return the maximum PTS (µs) written to the muxer during this clip.
     */
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

        ByteBuffer buffer = ByteBuffer.allocate(2 * 1024 * 1024);
        MediaCodec.BufferInfo bufferInfo = new MediaCodec.BufferInfo();
        long clipBaseTime = -1;
        long maxPtsWritten = cumulativeTimeUs; // track the actual max PTS we write

        while (!cancelled) {
            int trackIndex = extractor.getSampleTrackIndex();
            if (trackIndex < 0) break;

            long sampleTime = extractor.getSampleTime();
            if (sampleTime > endUs) break;

            int outTrack = -1;
            if (trackIndex == clipVideoTrack && muxVideoTrack >= 0) outTrack = muxVideoTrack;
            else if (trackIndex == clipAudioTrack && muxAudioTrack >= 0) outTrack = muxAudioTrack;

            if (outTrack < 0) { extractor.advance(); continue; }

            if (clipBaseTime < 0) clipBaseTime = sampleTime;

            buffer.clear();
            int sampleSize = extractor.readSampleData(buffer, 0);
            if (sampleSize < 0) break;

            bufferInfo.offset = 0;
            bufferInfo.size = sampleSize;
            bufferInfo.presentationTimeUs = (sampleTime - clipBaseTime) + cumulativeTimeUs;
            bufferInfo.flags = extractor.getSampleFlags();

            muxer.writeSampleData(outTrack, buffer, bufferInfo);

            // Track the highest PTS we actually wrote
            if (bufferInfo.presentationTimeUs > maxPtsWritten) {
                maxPtsWritten = bufferInfo.presentationTimeUs;
            }

            extractor.advance();

            if (cb != null && totalDurationUs > 0) {
                cb.onProgress((float) bufferInfo.presentationTimeUs / totalDurationUs);
            }
        }

        extractor.release();
        return maxPtsWritten;
    }

    /**
     * Concatenate a single clip with Opus/Vorbis→AAC audio transcoding.
     * Video is re-muxed directly; audio is decoded to PCM and re-encoded as AAC.
     * @return the maximum PTS (µs) written to the muxer during this clip.
     */
    private long concatenateClipWithTranscode(
            ClipInfo clip, MediaMuxer muxer,
            int muxVideoTrack, int muxAudioTrack,
            long cumulativeTimeUs, long totalDurationUs, ProgressCallback cb
    ) throws Exception {
        MediaExtractor extractor = new MediaExtractor();
        extractor.setDataSource(clip.path);

        int clipVideoTrack = -1, clipAudioTrack = -1;
        MediaFormat clipAudioFormat = null;

        for (int t = 0; t < extractor.getTrackCount(); t++) {
            MediaFormat fmt = extractor.getTrackFormat(t);
            String mime = fmt.getString(MediaFormat.KEY_MIME);
            if (mime != null && mime.startsWith("video/") && clipVideoTrack < 0) {
                clipVideoTrack = t;
                extractor.selectTrack(t);
            } else if (mime != null && mime.startsWith("audio/") && clipAudioTrack < 0) {
                clipAudioTrack = t;
                clipAudioFormat = fmt;
                extractor.selectTrack(t);
            }
        }

        long startUs = clip.trimStartMs * 1000;
        long endUs = clip.trimEndMs > 0 ? clip.trimEndMs * 1000 : Long.MAX_VALUE;
        if (startUs > 0) {
            extractor.seekTo(startUs, MediaExtractor.SEEK_TO_CLOSEST_SYNC);
        }

        // Set up audio decode/encode pipeline if we have an audio track
        String inputAudioMime = (clipAudioFormat != null)
                ? clipAudioFormat.getString(MediaFormat.KEY_MIME) : null;
        MediaCodec decoder = null;
        MediaCodec encoder = null;

        if (clipAudioTrack >= 0 && inputAudioMime != null) {
            decoder = MediaCodec.createDecoderByType(inputAudioMime);
            decoder.configure(clipAudioFormat, null, null, 0);
            decoder.start();

            MediaFormat aacFormat = createAacFormat(clipAudioFormat);
            encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC);
            encoder.configure(aacFormat, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            encoder.start();
        }

        ByteBuffer directBuffer = ByteBuffer.allocate(2 * 1024 * 1024);
        MediaCodec.BufferInfo directInfo = new MediaCodec.BufferInfo();
        MediaCodec.BufferInfo decodeInfo = new MediaCodec.BufferInfo();
        MediaCodec.BufferInfo encodeInfo = new MediaCodec.BufferInfo();

        boolean extractorDone = false;
        boolean decoderDone = (decoder == null);
        boolean encoderDone = (encoder == null);
        long clipBaseTime = -1;
        long maxPtsWritten = cumulativeTimeUs; // track actual max PTS written

        while (!cancelled && (!encoderDone || !extractorDone)) {
            // 1. Read from extractor
            if (!extractorDone) {
                int trackIndex = extractor.getSampleTrackIndex();
                if (trackIndex < 0) {
                    extractorDone = true;
                    if (decoder != null && !decoderDone) {
                        int inIdx = decoder.dequeueInputBuffer(AUDIO_TRANSCODE_TIMEOUT_US);
                        if (inIdx >= 0) {
                            decoder.queueInputBuffer(inIdx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                        }
                    } else {
                        decoderDone = true;
                        encoderDone = true;
                    }
                } else {
                    long sampleTime = extractor.getSampleTime();
                    if (clipBaseTime < 0) clipBaseTime = sampleTime;

                    if (sampleTime > endUs) {
                        extractorDone = true;
                        if (decoder != null && !decoderDone) {
                            int inIdx = decoder.dequeueInputBuffer(AUDIO_TRANSCODE_TIMEOUT_US);
                            if (inIdx >= 0) {
                                decoder.queueInputBuffer(inIdx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            }
                        }
                    } else if (trackIndex == clipAudioTrack && decoder != null) {
                        // Audio → feed to decoder
                        int inIdx = decoder.dequeueInputBuffer(AUDIO_TRANSCODE_TIMEOUT_US);
                        if (inIdx >= 0) {
                            ByteBuffer inBuf = decoder.getInputBuffer(inIdx);
                            inBuf.clear();
                            int size = extractor.readSampleData(inBuf, 0);
                            if (size >= 0) {
                                long pts = (sampleTime - clipBaseTime) + cumulativeTimeUs;
                                decoder.queueInputBuffer(inIdx, 0, size, pts, extractor.getSampleFlags());
                                extractor.advance();
                            }
                        }
                    } else if (trackIndex == clipVideoTrack) {
                        // Video → direct re-mux
                        directBuffer.clear();
                        int sampleSize = extractor.readSampleData(directBuffer, 0);
                        if (sampleSize >= 0) {
                            directInfo.offset = 0;
                            directInfo.size = sampleSize;
                            directInfo.presentationTimeUs = (sampleTime - clipBaseTime) + cumulativeTimeUs;
                            directInfo.flags = extractor.getSampleFlags();
                            muxer.writeSampleData(muxVideoTrack, directBuffer, directInfo);

                            if (directInfo.presentationTimeUs > maxPtsWritten) {
                                maxPtsWritten = directInfo.presentationTimeUs;
                            }

                            if (cb != null && totalDurationUs > 0) {
                                cb.onProgress((float) directInfo.presentationTimeUs / totalDurationUs);
                            }
                        }
                        extractor.advance();
                    } else {
                        extractor.advance();
                    }
                }
            }

            // 2. Drain decoder → feed PCM to encoder
            if (decoder != null && !decoderDone) {
                int outIdx = decoder.dequeueOutputBuffer(decodeInfo, AUDIO_TRANSCODE_TIMEOUT_US);
                if (outIdx >= 0) {
                    ByteBuffer decodedBuf = decoder.getOutputBuffer(outIdx);
                    boolean eos = (decodeInfo.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0;

                    if (decodeInfo.size > 0 && encoder != null) {
                        int encInIdx = encoder.dequeueInputBuffer(AUDIO_TRANSCODE_TIMEOUT_US);
                        if (encInIdx >= 0) {
                            ByteBuffer encInBuf = encoder.getInputBuffer(encInIdx);
                            encInBuf.clear();
                            int toCopy = Math.min(decodedBuf.remaining(), encInBuf.capacity());
                            decodedBuf.limit(decodedBuf.position() + toCopy);
                            encInBuf.put(decodedBuf);
                            encoder.queueInputBuffer(encInIdx, 0, toCopy,
                                    decodeInfo.presentationTimeUs,
                                    eos ? MediaCodec.BUFFER_FLAG_END_OF_STREAM : 0);
                        }
                    } else if (eos && encoder != null) {
                        int encInIdx = encoder.dequeueInputBuffer(AUDIO_TRANSCODE_TIMEOUT_US);
                        if (encInIdx >= 0) {
                            encoder.queueInputBuffer(encInIdx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                        }
                    }
                    decoder.releaseOutputBuffer(outIdx, false);
                    if (eos) decoderDone = true;
                }
            }

            // 3. Drain encoder → write AAC to muxer
            if (encoder != null && !encoderDone) {
                int encOutIdx = encoder.dequeueOutputBuffer(encodeInfo, AUDIO_TRANSCODE_TIMEOUT_US);
                if (encOutIdx >= 0) {
                    ByteBuffer encodedBuf = encoder.getOutputBuffer(encOutIdx);
                    if (encodeInfo.size > 0 && encodedBuf != null) {
                        muxer.writeSampleData(muxAudioTrack, encodedBuf, encodeInfo);
                        if (encodeInfo.presentationTimeUs > maxPtsWritten) {
                            maxPtsWritten = encodeInfo.presentationTimeUs;
                        }
                    }
                    boolean eos = (encodeInfo.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0;
                    encoder.releaseOutputBuffer(encOutIdx, false);
                    if (eos) encoderDone = true;
                }
            }
        }

        if (encoder != null) { encoder.stop(); encoder.release(); }
        if (decoder != null) { decoder.stop(); decoder.release(); }
        extractor.release();
        return maxPtsWritten;
    }
}
