# Tartan on iPhone

The iPhone app is the same Tartan: the engine (TypeScript) runs in the app's web view, as on
Android. **Step 1 (now):** the web app's screens in an iOS shell, with Bluetooth to the watch, GPS
recording, notifications, files and sharing (Capacitor's iOS plugins). **Then:** native SwiftUI
screens with iOS 26's Liquid Glass, one at a time, as the Android app went native (the tab bar
and Today first). It needs iOS 26 (iPhone 11 or newer).

## Building it (no Mac needed)

A Mac in the cloud builds it, unsigned: `scripts/ios-build.sh` (Xcode 26+), which writes
`build/Tartan-<version>.ipa`.

GitHub Actions does it, free on this public repository: `.github/workflows/ios.yml` runs on each
push that changes the app (or by hand, Actions → iPhone app → Run workflow). The .ipa is the
run's artifact, "tartan-ipa" (a zip with the .ipa in it). From `main` it also goes on the **ios** pre-release
(regular releases stay Android's, so Obtainium and Orion Store aren't affected), with a SideStore
source: add `https://github.com/sanjinpepic/Tartan/releases/download/ios/sidestore.json` in
SideStore (Sources → +) once, and it offers each new build.

## Installing it (free)

SideStore (or AltStore) signs the .ipa with your own free Apple ID as it installs it. Apple lets
a free Apple ID run an app for 7 days; SideStore renews it in the background (AltStore needs its
AltServer on your PC on the same Wi-Fi). Three such apps at a time.

1. Set up SideStore once, from a computer (Windows, Mac or Linux): sidestore.io → Install.
2. Download the .ipa on the iPhone and open it with SideStore (Share → SideStore), or in
   SideStore: My Apps → +.
3. The first time: Settings → General → VPN & Device Management → trust your Apple ID; and
   Settings → Privacy & Security → Developer Mode on (iOS asks for it for sideloaded apps).

For friends, the Apple Developer Program ($99 a year) gives TestFlight instead: no 7-day limit,
an invite link, up to 10,000 testers. It's also what the App Store needs.

## What works on iPhone, step 1

Everything the web app does, plus the watch over Bluetooth, GPS runs, reminders, the calendar,
files and sharing. Not yet: Apple Health (instead of Health Connect), dictation, the home-screen
widget, Live Activities (instead of Live Updates), Model Hub (Android only; the phone's own AI on
iPhone would be Apple's Foundation Models, later).
