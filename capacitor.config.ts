import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "dev.freesuunto.app",
  appName: "Tartan",
  webDir: "dist",
  android: {
    // Plain http origin so the app may talk to Tartan on your PC over the home network.
    allowMixedContent: true,
  },
  server: {
    androidScheme: "http",
    cleartext: true,
  },
  plugins: {
    // Edge to edge. The phone's screens are native and handle the system bars and the keyboard
    // themselves (as it slides): Capacitor's handling would pad the whole window by the keyboard's
    // height at once, jumping the native screens. The PC's web app doesn't use this.
    SystemBars: { insetsHandling: "disable", initialViewportFitValueHint: "cover", style: "DARK" },
    // Session reminders: the white T in the status bar, in the brand red.
    LocalNotifications: { smallIcon: "ic_stat_tartan", iconColor: "#A8321F" },
    BluetoothLe: {
      displayStrings: {
        scanning: "Looking for your watch…",
        cancel: "Cancel",
        availableDevices: "Watches nearby",
        noDeviceFound: "No watch found. Wake it and open Settings → Connectivity.",
      },
    },
  },
};

export default config;
