package com.myguestbook.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.DocumentsContract;
import android.util.Log;

import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import androidx.documentfile.provider.DocumentFile;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * FileManagerPlugin — Native Android file management for the Guestbook kiosk.
 *
 * Provides:
 *  - pickDirectory(): Opens SAF folder picker (ACTION_OPEN_DOCUMENT_TREE)
 *    so the user can select internal storage or a USB-C drive.
 *  - openFileManager(): Opens the native file browser at the SAF tree URI.
 *  - shareFiles(): Shares multiple files via the Android share sheet.
 *  - copyToSafDirectory(): Copies a file from internal storage to the user's
 *    chosen SAF directory (used after recording/compilation).
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
     * Opens the native Android file manager (e.g. Samsung My Files) at the
     * specified SAF tree URI — NOT a media player.
     *
     * Strategy: Use DocumentsContract.buildDocumentUriUsingTree() to build a
     * proper document URI, then launch ACTION_VIEW with the directory MIME type.
     */
    @PluginMethod
    public void openFileManager(PluginCall call) {
        String uriStr = call.getString("uri", null);
        String path = call.getString("path", null);

        try {
            if (uriStr != null) {
                Uri treeUri = Uri.parse(uriStr);

                // Build a proper document URI from the tree URI
                String documentId = DocumentsContract.getTreeDocumentId(treeUri);
                Uri documentUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, documentId);

                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(documentUri, "vnd.android.document/directory");
                intent.addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK |
                    Intent.FLAG_GRANT_READ_URI_PERMISSION
                );

                try {
                    getContext().startActivity(intent);
                    call.resolve(new JSObject().put("ok", true));
                    return;
                } catch (Exception e) {
                    Log.w(TAG, "vnd.android.document/directory failed, trying fallback", e);
                }

                // Fallback 1: Try to browse the document tree directly
                try {
                    Intent browseIntent = new Intent(Intent.ACTION_VIEW);
                    browseIntent.setData(documentUri);
                    browseIntent.addFlags(
                        Intent.FLAG_ACTIVITY_NEW_TASK |
                        Intent.FLAG_GRANT_READ_URI_PERMISSION
                    );
                    getContext().startActivity(browseIntent);
                    call.resolve(new JSObject().put("ok", true));
                    return;
                } catch (Exception e2) {
                    Log.w(TAG, "Document URI browse failed, trying DocumentsUI", e2);
                }

                // Fallback 2: Open the system Documents UI with the tree as initial URI
                try {
                    Intent docsIntent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    docsIntent.addCategory(Intent.CATEGORY_OPENABLE);
                    docsIntent.setType("*/*");
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        docsIntent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, treeUri);
                    }
                    docsIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    getContext().startActivity(docsIntent);
                    call.resolve(new JSObject().put("ok", true));
                    return;
                } catch (Exception e3) {
                    Log.w(TAG, "DocumentsUI fallback also failed", e3);
                }
            }

            if (path != null) {
                // Native file path — try to open containing folder
                String cleanPath = path.replace("file:///", "/").replace("file://", "");
                File dir = new File(cleanPath);
                if (!dir.isDirectory()) dir = dir.getParentFile();
                if (dir != null && dir.exists()) {
                    Uri contentUri = FileProvider.getUriForFile(
                        getContext(),
                        getContext().getPackageName() + ".fileprovider",
                        dir
                    );
                    Intent intent = new Intent(Intent.ACTION_VIEW);
                    intent.setDataAndType(contentUri, "vnd.android.document/directory");
                    intent.addFlags(
                        Intent.FLAG_ACTIVITY_NEW_TASK |
                        Intent.FLAG_GRANT_READ_URI_PERMISSION
                    );
                    getContext().startActivity(intent);
                    call.resolve(new JSObject().put("ok", true));
                    return;
                }
            }

            // Last resort: launch the system file manager app
            Intent filesIntent = getContext().getPackageManager()
                .getLaunchIntentForPackage("com.sec.android.app.myfiles"); // Samsung My Files
            if (filesIntent == null) {
                filesIntent = getContext().getPackageManager()
                    .getLaunchIntentForPackage("com.google.android.documentsui");
            }
            if (filesIntent == null) {
                filesIntent = new Intent(Intent.ACTION_VIEW);
                filesIntent.setType("*/*");
            }
            filesIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(filesIntent);
            call.resolve(new JSObject().put("ok", true));
        } catch (Exception e) {
            Log.e(TAG, "openFileManager error: " + e.getMessage(), e);
            call.reject("Could not open file manager: " + e.getMessage());
        }
    }

    /**
     * Copies a file from the app's internal storage into the user-chosen SAF
     * directory. This is how recordings and exports get routed to USB drives
     * or user-selected folders.
     *
     * @param sourcePath - Absolute path to the source file (internal storage)
     * @param treeUri    - SAF tree URI string (from pickDirectory)
     * @param fileName   - Desired filename in the destination directory
     * @returns { ok: true, uri: "content://..." } on success
     */
    @PluginMethod
    public void copyToSafDirectory(PluginCall call) {
        String sourcePath = call.getString("sourcePath", null);
        String treeUriStr = call.getString("treeUri", null);
        String fileName = call.getString("fileName", null);

        if (sourcePath == null || treeUriStr == null || fileName == null) {
            call.reject("sourcePath, treeUri, and fileName are required");
            return;
        }

        new Thread(() -> {
            try {
                // Clean the source path
                sourcePath.replace("file:///", "/").replace("file://", "");
                String cleanSource = sourcePath.replace("file:///", "/").replace("file://", "");

                File sourceFile = new File(cleanSource);
                if (!sourceFile.exists()) {
                    call.reject("Source file does not exist: " + cleanSource);
                    return;
                }

                Uri treeUri = Uri.parse(treeUriStr);
                DocumentFile directory = DocumentFile.fromTreeUri(getContext(), treeUri);
                if (directory == null || !directory.canWrite()) {
                    call.reject("Cannot write to chosen directory. Permission may have expired.");
                    return;
                }

                // Check if file already exists and delete it
                DocumentFile existing = directory.findFile(fileName);
                if (existing != null && existing.exists()) {
                    existing.delete();
                }

                // Create the new file in the SAF directory
                DocumentFile newFile = directory.createFile("video/mp4", fileName);
                if (newFile == null) {
                    call.reject("Failed to create file in SAF directory");
                    return;
                }

                // Copy bytes from internal file to SAF output stream
                try (InputStream in = new FileInputStream(sourceFile);
                     OutputStream out = getContext().getContentResolver()
                         .openOutputStream(newFile.getUri())) {
                    if (out == null) {
                        call.reject("Could not open output stream for SAF file");
                        return;
                    }
                    byte[] buffer = new byte[8192];
                    int bytesRead;
                    while ((bytesRead = in.read(buffer)) != -1) {
                        out.write(buffer, 0, bytesRead);
                    }
                    out.flush();
                }

                Log.d(TAG, "Copied " + sourceFile.getName() + " to SAF: " + newFile.getUri());

                JSObject result = new JSObject();
                result.put("ok", true);
                result.put("uri", newFile.getUri().toString());
                result.put("fileName", fileName);
                call.resolve(result);
            } catch (Exception e) {
                Log.e(TAG, "copyToSafDirectory error: " + e.getMessage(), e);
                call.reject("Copy to SAF failed: " + e.getMessage());
            }
        }).start();
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
