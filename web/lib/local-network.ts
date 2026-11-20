/**
 * Android 17 asks before an app reaches the home network (TartanLocalNetworkPlugin): the PC link
 * needs it. `ask` shows Android's prompt (from a tap); without it, only whether it's allowed.
 * Not the phone app (the PC itself, a browser): always allowed.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";

const LocalNetwork = registerPlugin<{ check(): Promise<{ granted: boolean }>; request(): Promise<{ granted: boolean }> }>("TartanLocalNetwork");

export async function localNetwork(ask: boolean): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return true;
  try {
    return (await (ask ? LocalNetwork.request() : LocalNetwork.check())).granted;
  } catch {
    return true; // an older build of the app without the plugin: Android doesn't ask there either
  }
}

export const LOCAL_NETWORK_DENIED = "Tartan can't reach your PC: Android 17 needs your OK for devices on your home network. Allow Nearby devices for Tartan (Android Settings → Apps → Tartan → Permissions), then try again.";
