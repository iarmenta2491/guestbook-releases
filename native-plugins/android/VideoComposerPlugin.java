package com.myguestbook.app;

import android.util.Log;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.util.ArrayList;
import java.util.List;

@CapacitorPlugin(name = "VideoComposer")
public class VideoComposerPlugin extends Plugin {
    private static final String TAG = "VideoComposer";
    private NativeComposer composer;

    @Override
    public void load() {
        composer = new NativeComposer(getContext());
    }

    @PluginMethod
    public void compose(PluginCall call) {
        try {
            JSONArray clipsArray = call.getArray("clips");
            JSONArray transitionsArray = call.getArray("transitions");
            String outputPath = call.getString("outputPath", "output.mp4");
            int width = 1280, height = 720;
            JSONObject resolution = call.getObject("resolution", null);
            if (resolution != null) {
                width = resolution.optInt("width", 1280);
                height = resolution.optInt("height", 720);
            }
            String bgMusicPath = call.getString("bgMusicPath", "");
            float bgMusicVolume = call.getDouble("bgMusicVolume", 0.1).floatValue();

            // Parse clips
            List<NativeComposer.ClipInfo> clips = new ArrayList<>();
            for (int i = 0; i < clipsArray.length(); i++) {
                JSONObject clipObj = clipsArray.getJSONObject(i);
                String path = clipObj.getString("path");
                long trimStartMs = clipObj.optLong("trimStartMs", 0);
                long trimEndMs = clipObj.optLong("trimEndMs", 0);
                clips.add(new NativeComposer.ClipInfo(path, trimStartMs, trimEndMs));
            }

            // Parse transitions
            List<NativeComposer.TransitionInfo> transitions = new ArrayList<>();
            if (transitionsArray != null) {
                for (int i = 0; i < transitionsArray.length(); i++) {
                    JSONObject t = transitionsArray.getJSONObject(i);
                    String type = t.optString("type", "none");
                    int durationMs = t.optInt("durationMs", 500);
                    transitions.add(new NativeComposer.TransitionInfo(type, durationMs));
                }
            }

            // Write to app cache directory first (MediaMuxer needs a real file path).
            // After completion, JS will copy the result to the SAF directory.
            File outputDir = new File(getContext().getCacheDir(), "exports");
            if (!outputDir.exists()) outputDir.mkdirs();
            String fileName = outputPath.contains("/")
                ? outputPath.substring(outputPath.lastIndexOf('/') + 1)
                : outputPath;
            File outputFile = new File(outputDir, fileName);

            Log.d(TAG, "compose: " + clips.size() + " clips → " + outputFile.getAbsolutePath());

            // Run composition on a background thread directly (no UI thread hop)
            final int finalWidth = width;
            final int finalHeight = height;
            new Thread(() -> {
                try {
                    composer.compose(
                        clips, transitions, outputFile,
                        finalWidth, finalHeight,
                        bgMusicPath, bgMusicVolume,
                        (progress) -> {
                            // Dispatch progress back to JS on the main/bridge thread
                            JSObject event = new JSObject();
                            event.put("progress", progress);
                            notifyListeners("composeProgress", event);
                        }
                    );

                    Log.d(TAG, "compose complete: " + outputFile.getAbsolutePath()
                        + " (" + outputFile.length() + " bytes)");

                    JSObject result = new JSObject();
                    result.put("outputPath", outputFile.getAbsolutePath());
                    result.put("outputUri", "file://" + outputFile.getAbsolutePath());
                    result.put("durationMs", 0);
                    call.resolve(result);
                } catch (Exception e) {
                    Log.e(TAG, "Composition failed", e);
                    call.reject("Composition failed: " + e.getMessage(), e);
                }
            }, "NativeComposer-Worker").start();
        } catch (Exception e) {
            Log.e(TAG, "compose() error", e);
            call.reject("Invalid parameters: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        if (composer != null) {
            composer.cancel();
        }
        call.resolve();
    }
}
