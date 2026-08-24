import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.myguestbook.app',
  appName: 'My Guestbook',
  webDir: 'dist',
  server: {
    // Required for getUserMedia and other secure-context APIs on Android WebView
    androidScheme: 'https',
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      launchShowDuration: 2000,
      androidScaleType: 'CENTER_CROP',
    },
    StatusBar: {
      // Hide status bar for kiosk-like experience on mobile
      overlaysWebView: true,
    },
    ScreenOrientation: {},
  },
};

export default config;
