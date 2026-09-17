package com.myguestbook.app;

import android.content.Context;
import android.net.wifi.WifiManager;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.Collections;
import java.util.List;

@CapacitorPlugin(name = "LocalServer")
public class LocalServerPlugin extends Plugin {
    private static final String TAG = "LocalServer";
    private NativeFileServer server;

    @PluginMethod
    public void start(PluginCall call) {
        try {
            // Stop existing server if running
            stopServer();

            String directoryPath = call.getString("directoryPath", "");
            int port = call.getInt("port", 8080);
            String downloadPageHtml = call.getString("downloadPageHtml", "");

            // Sanitize directory path
            directoryPath = directoryPath.replaceFirst("^file://", "");
            File rootDir = new File(directoryPath);
            if (!rootDir.exists() || !rootDir.isDirectory()) {
                call.reject("Directory does not exist: " + directoryPath);
                return;
            }

            server = new NativeFileServer(port, rootDir, downloadPageHtml);
            server.start();

            String ip = getLocalIPAddress();

            JSObject result = new JSObject();
            result.put("url", "http://" + ip + ":" + port);
            result.put("ip", ip);
            result.put("port", port);
            call.resolve(result);

            Log.d(TAG, "Local server started at http://" + ip + ":" + port);
        } catch (Exception e) {
            Log.e(TAG, "Failed to start server", e);
            call.reject("Failed to start server: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopServer();
        call.resolve();
    }

    @PluginMethod
    public void getLocalIP(PluginCall call) {
        JSObject result = new JSObject();
        result.put("ip", getLocalIPAddress());
        call.resolve(result);
    }

    private void stopServer() {
        if (server != null) {
            server.stop();
            server = null;
            Log.d(TAG, "Local server stopped");
        }
    }

    private String getLocalIPAddress() {
        try {
            List<NetworkInterface> interfaces = Collections.list(NetworkInterface.getNetworkInterfaces());
            for (NetworkInterface intf : interfaces) {
                if (intf.isLoopback() || !intf.isUp()) continue;
                List<InetAddress> addrs = Collections.list(intf.getInetAddresses());
                for (InetAddress addr : addrs) {
                    if (!addr.isLoopbackAddress() && addr instanceof java.net.Inet4Address) {
                        return addr.getHostAddress();
                    }
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to get local IP", e);
        }
        return "127.0.0.1";
    }

    @Override
    protected void handleOnDestroy() {
        stopServer();
    }
}
