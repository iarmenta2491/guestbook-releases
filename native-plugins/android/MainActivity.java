package com.myguestbook.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register custom local plugins before super.onCreate
        registerPlugin(VideoComposerPlugin.class);
        registerPlugin(LocalServerPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
