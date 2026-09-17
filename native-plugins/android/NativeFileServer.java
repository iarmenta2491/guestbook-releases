package com.myguestbook.app;

import android.util.Log;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.UnsupportedEncodingException;
import java.net.URLDecoder;
import java.util.Map;

import fi.iki.elonen.NanoHTTPD;

/**
 * NativeFileServer — A lightweight HTTP server for serving video files
 * directly from local storage over WiFi.
 *
 * Features:
 * - Serves static files from a root directory
 * - Supports HTTP 206 Partial Content (Range requests) for video streaming
 * - Serves a customizable download landing page at /download
 * - Zero JavaScript bridge overhead — streams directly from disk
 */
public class NativeFileServer extends NanoHTTPD {
    private static final String TAG = "NativeFileServer";
    private final File rootDir;
    private final String downloadPageHtml;

    public NativeFileServer(int port, File rootDir, String downloadPageHtml) {
        super("0.0.0.0", port);
        this.rootDir = rootDir;
        this.downloadPageHtml = downloadPageHtml != null ? downloadPageHtml : getDefaultDownloadPage();
    }

    @Override
    public Response serve(IHTTPSession session) {
        String uri = session.getUri();
        Map<String, String> params = session.getParms();

        // CORS headers for cross-origin requests from guest phones
        Response response;

        try {
            if ("/download".equals(uri)) {
                response = serveDownloadPage(params);
            } else if (uri.startsWith("/video")) {
                response = serveVideoFile(uri, params, session.getHeaders());
            } else if ("/".equals(uri)) {
                response = newFixedLengthResponse(Response.Status.OK, "text/plain", "My Guestbook Sharing Server");
            } else {
                response = newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "Not Found");
            }
        } catch (Exception e) {
            Log.e(TAG, "Error serving " + uri, e);
            response = newFixedLengthResponse(Response.Status.INTERNAL_ERROR, "text/plain", "Server Error");
        }

        // Add CORS headers
        response.addHeader("Access-Control-Allow-Origin", "*");
        response.addHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        response.addHeader("Access-Control-Allow-Headers", "Range");

        return response;
    }

    private Response serveDownloadPage(Map<String, String> params) {
        String filename = params.getOrDefault("file", "");
        String html = downloadPageHtml.replace("{{FILENAME}}", filename)
                                       .replace("{{VIDEO_URL}}", "/video?file=" + filename);
        return newFixedLengthResponse(Response.Status.OK, "text/html", html);
    }

    private Response serveVideoFile(
            String uri, Map<String, String> params, Map<String, String> headers
    ) throws IOException {
        // Determine which file to serve
        String filename = params.getOrDefault("file", "");
        if (filename.isEmpty()) {
            // Try path-based: /video/filename.mp4
            String pathPart = uri.replaceFirst("^/video/?", "");
            if (!pathPart.isEmpty()) {
                try {
                    filename = URLDecoder.decode(pathPart, "UTF-8");
                } catch (UnsupportedEncodingException e) {
                    filename = pathPart;
                }
            }
        }

        if (filename.isEmpty()) {
            return newFixedLengthResponse(Response.Status.BAD_REQUEST, "text/plain", "No file specified");
        }

        // Security: prevent path traversal
        filename = new File(filename).getName();
        File videoFile = new File(rootDir, filename);

        if (!videoFile.exists() || !videoFile.isFile()) {
            return newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "File not found: " + filename);
        }

        long fileLength = videoFile.length();
        String mimeType = filename.endsWith(".mp4") ? "video/mp4" : "application/octet-stream";

        // Check for Range header (HTTP 206 Partial Content)
        String rangeHeader = headers.get("range");
        if (rangeHeader != null && rangeHeader.startsWith("bytes=")) {
            return servePartialContent(videoFile, rangeHeader, fileLength, mimeType);
        }

        // Full file response
        FileInputStream fis = new FileInputStream(videoFile);
        Response resp = newFixedLengthResponse(Response.Status.OK, mimeType, fis, fileLength);
        resp.addHeader("Content-Length", String.valueOf(fileLength));
        resp.addHeader("Content-Disposition", "attachment; filename=\"" + filename + "\"");
        resp.addHeader("Accept-Ranges", "bytes");
        return resp;
    }

    /**
     * Serve a byte range for HTTP 206 Partial Content.
     * Critical for iOS Safari which REQUIRES range requests for video playback.
     */
    private Response servePartialContent(
            File file, String rangeHeader, long fileLength, String mimeType
    ) throws IOException {
        // Parse "bytes=START-END" or "bytes=START-"
        String rangeValue = rangeHeader.replace("bytes=", "").trim();
        String[] parts = rangeValue.split("-");
        long start = Long.parseLong(parts[0]);
        long end = parts.length > 1 && !parts[1].isEmpty()
                ? Long.parseLong(parts[1])
                : fileLength - 1;

        if (start >= fileLength || end >= fileLength || start > end) {
            Response resp = newFixedLengthResponse(
                Response.Status.RANGE_NOT_SATISFIABLE, "text/plain", "Range not satisfiable"
            );
            resp.addHeader("Content-Range", "bytes */" + fileLength);
            return resp;
        }

        long contentLength = end - start + 1;
        FileInputStream fis = new FileInputStream(file);
        fis.skip(start);

        Response resp = newFixedLengthResponse(
            Response.Status.PARTIAL_CONTENT, mimeType, fis, contentLength
        );
        resp.addHeader("Content-Length", String.valueOf(contentLength));
        resp.addHeader("Content-Range", "bytes " + start + "-" + end + "/" + fileLength);
        resp.addHeader("Accept-Ranges", "bytes");
        resp.addHeader("Content-Disposition", "attachment; filename=\"" + file.getName() + "\"");
        return resp;
    }

    private String getDefaultDownloadPage() {
        return "<!DOCTYPE html>\n" +
            "<html lang=\"en\">\n" +
            "<head>\n" +
            "  <meta charset=\"UTF-8\" />\n" +
            "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1, maximum-scale=1\" />\n" +
            "  <title>Your Message</title>\n" +
            "  <style>\n" +
            "    body { background:#07071a; color:#fff; font-family:-apple-system,BlinkMacSystemFont,sans-serif; display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:100vh; margin:0; padding:20px; }\n" +
            "    h1 { font-size:1.5rem; margin-bottom:12px; }\n" +
            "    p { color:rgba(255,255,255,.6); margin-bottom:24px; }\n" +
            "    video { width:100%; max-width:480px; border-radius:16px; margin-bottom:24px; }\n" +
            "    a.btn { display:inline-flex; align-items:center; gap:8px; padding:16px 32px; background:linear-gradient(135deg,#8b5cf6,#2dd4bf); color:#fff; border-radius:50px; text-decoration:none; font-weight:700; font-size:1.1rem; }\n" +
            "  </style>\n" +
            "</head>\n" +
            "<body>\n" +
            "  <h1>\uD83C\uDFAC Your Message</h1>\n" +
            "  <p>Tap below to save your video</p>\n" +
            "  <video src=\"{{VIDEO_URL}}\" controls playsinline webkit-playsinline></video>\n" +
            "  <a class=\"btn\" href=\"{{VIDEO_URL}}\" download=\"{{FILENAME}}\">\u2B07\uFE0F Save Video</a>\n" +
            "</body></html>";
    }
}
