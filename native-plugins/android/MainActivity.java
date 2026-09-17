package com.myguestbook.app;

import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register custom local plugins before super.onCreate
        registerPlugin(VideoComposerPlugin.class);
        registerPlugin(LocalServerPlugin.class);
        super.onCreate(savedInstanceState);

        // Enable true immersive mode — hide status bar and navigation bar
        enableImmersiveMode();

        // Keep screen on (kiosk mode at live events)
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // Re-apply immersive mode when window regains focus (e.g. after permission dialogs)
        if (hasFocus) {
            enableImmersiveMode();
        }
    }

    private void enableImmersiveMode() {
        // Edge-to-edge: let the app draw behind system bars
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        // Hide both status bar and navigation bar with swipe-to-reveal behavior
        WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (controller != null) {
            controller.hide(WindowInsetsCompat.Type.systemBars());
            controller.setSystemBarsBehavior(
                    WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            );
        }
    }
}
