package com.myguestbook.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.DocumentsContract;
import android.util.Log;

import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;

/**
 * FileManagerPlugin — Native Android file management for the Guestbook kiosk.
 *
 * Provides:
 *  - pickDirectory(): Opens SAF folder picker (ACTION_OPEN_DOCUMENT_TREE)
 *    so the user can select internal storage or a USB-C drive.
 *  - openFileManager(): Opens the native file manager at a given path/URI.
 *  - shareFiles(): Shares multiple files via the Android share sheet.
 */
@CapacitorPlugin(name = "FileManager")
public class FileManagerPlugin extends Plugin {
    private static final String TAG = "FileManager";

    /**
     * Opens the Storage Access Framework directory picker.
     * Returns the selected directory's content URI string.
     */
    @PluginMethod
    public void pickDirectory(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION |
            Intent.FLAG_GRANT_WRITE_URI_PERMISSION |
            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
        );

        // Optionally set initial URI if provided
        String initialPath = call.getString("initialPath", null);
        if (initialPath != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                Uri initialUri = Uri.parse(initialPath);
                intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, initialUri);
            } catch (Exception e) {
                Log.w(TAG, "Could not parse initial path: " + initialPath);
            }
        }

        startActivityForResult(call, intent, "handleDirectoryPicked");
    }

    @ActivityCallback
    private void handleDirectoryPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;

        if (result.getResultCode() == Activity.RESULT_OK && result.getData() != null) {
            Uri treeUri = result.getData().getData();
            if (treeUri != null) {
                // Take persistent permission so the URI survives app restarts
                try {
                    getContext().getContentResolver().takePersistableUriPermission(
                        treeUri,
                        Intent.FLAG_GRANT_READ_URI_PERMISSION |
                        Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                    );
                } catch (SecurityException e) {
                    Log.w(TAG, "Could not take persistable permission: " + e.getMessage());
                }

                JSObject ret = new JSObject();
                ret.put("uri", treeUri.toString());
                // Try to extract a human-readable path for display
                ret.put("displayPath", getDisplayPath(treeUri));
                call.resolve(ret);
                return;
            }
        }

        // User cancelled or no data
        call.resolve(new JSObject().put("uri", JSObject.NULL));
    }

    /**
     * Opens the native Android file manager at the specified path or URI.
     */
    @PluginMethod
    public void openFileManager(PluginCall call) {
        String path = call.getString("path", null);
        String uri = call.getString("uri", null);

        try {
            Intent intent = new Intent(Intent.ACTION_VIEW);

            if (uri != null) {
                // SAF content URI — open document browser at that tree
                Uri contentUri = Uri.parse(uri);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    // Use EXTRA_INITIAL_URI to hint where to open
                    intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("video/*");
                    intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, contentUri);
                } else {
                    intent.setDataAndType(contentUri, "resource/folder");
                }
            } else if (path != null) {
                // Native file path — create a content:// URI via FileProvider
                String cleanPath = path
                    .replace("file:///", "/")
                    .replace("file://", "");
                File dir = new File(cleanPath);
                if (!dir.exists()) {
                    // Try parent directory
                    dir = dir.getParentFile();
                }
                if (dir != null && dir.exists()) {
                    Uri contentUri = FileProvider.getUriForFile(
                        getContext(),
                        getContext().getPackageName() + ".fileprovider",
                        dir
                    );
                    intent.setDataAndType(contentUri, "resource/folder");
                    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                } else {
                    // Fallback: open generic file manager
                    intent = getContext().getPackageManager()
                        .getLaunchIntentForPackage("com.google.android.documentsui");
                    if (intent == null) {
                        intent = new Intent(Intent.ACTION_VIEW);
                        intent.setType("video/*");
                    }
                }
            } else {
                // No path specified — open generic files app
                intent.setType("video/*");
            }

            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve(new JSObject().put("ok", true));
        } catch (Exception e) {
            Log.e(TAG, "openFileManager error: " + e.getMessage(), e);
            // Fallback: try to open any file manager
            try {
                Intent fallback = new Intent(Intent.ACTION_VIEW);
                fallback.setType("video/*");
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(fallback);
                call.resolve(new JSObject().put("ok", true));
            } catch (Exception e2) {
                call.reject("Could not open file manager: " + e2.getMessage());
            }
        }
    }

    /**
     * Shares multiple video files via the Android share sheet.
     * Expects a JSON array of native file paths under "files".
     */
    @PluginMethod
    public void shareFiles(PluginCall call) {
        try {
            org.json.JSONArray filesArray = call.getArray("files");
            if (filesArray == null || filesArray.length() == 0) {
                call.reject("No files to share");
                return;
            }

            String title = call.getString("title", "Guestbook Clips");

            java.util.ArrayList<Uri> uris = new java.util.ArrayList<>();
            for (int i = 0; i < filesArray.length(); i++) {
                String filePath = filesArray.getString(i);
                // Strip file:// prefix
                filePath = filePath
                    .replace("file:///", "/")
                    .replace("file://", "");
                File file = new File(filePath);
                if (file.exists()) {
                    Uri contentUri = FileProvider.getUriForFile(
                        getContext(),
                        getContext().getPackageName() + ".fileprovider",
                        file
                    );
                    uris.add(contentUri);
                }
            }

            if (uris.isEmpty()) {
                call.reject("None of the specified files exist");
                return;
            }

            Intent shareIntent;
            if (uris.size() == 1) {
                shareIntent = new Intent(Intent.ACTION_SEND);
                shareIntent.setType("video/*");
                shareIntent.putExtra(Intent.EXTRA_STREAM, uris.get(0));
            } else {
                shareIntent = new Intent(Intent.ACTION_SEND_MULTIPLE);
                shareIntent.setType("video/*");
                shareIntent.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
            }

            shareIntent.putExtra(Intent.EXTRA_SUBJECT, title);
            shareIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

            Intent chooser = Intent.createChooser(shareIntent, title);
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(chooser);

            call.resolve(new JSObject().put("ok", true).put("sharedCount", uris.size()));
        } catch (Exception e) {
            Log.e(TAG, "shareFiles error: " + e.getMessage(), e);
            call.reject("Share failed: " + e.getMessage());
        }
    }

    /**
     * Extract a human-readable display path from a SAF tree URI.
     */
    private String getDisplayPath(Uri treeUri) {
        String uriStr = treeUri.toString();
        // SAF URIs look like content://com.android.externalstorage.documents/tree/primary%3ADocuments
        try {
            String decoded = Uri.decode(uriStr);
            if (decoded.contains("primary:")) {
                String sub = decoded.substring(decoded.indexOf("primary:") + 8);
                return "Internal/" + sub;
            } else if (decoded.contains(":")) {
                // External storage (USB drive)
                String sub = decoded.substring(decoded.lastIndexOf("/tree/") + 6);
                return "USB/" + sub.replace(":", "/");
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not parse display path", e);
        }
        return uriStr;
    }
}
