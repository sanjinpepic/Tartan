# Tartan on iPhone

The iPhone app is the same Tartan: the engine (TypeScript) runs in the app's web view, as on
Android. **Step 1 (now):** the web app's screens in an iOS shell, with Bluetooth to the watch, GPS
recording, notifications, files and sharing (Capacitor's iOS plugins). **Then:** native SwiftUI
screens with iOS 26's Liquid Glass, one at a time, as the Android app went native (the tab bar
and Today first; see Native iPhone screens below). It needs iOS 26 (iPhone 11 or newer).

## Building it (no Mac needed)

A Mac in the cloud builds it, unsigned: `scripts/ios-build.sh` (Xcode 26+), which writes
`build/Tartan-<version>.ipa`.

GitHub Actions does it, free on this public repository: `.github/workflows/ios.yml` runs on each
push that changes the app (or by hand, Actions → iPhone app → Run workflow). The .ipa is the
run's artifact, "tartan-ipa" (a zip with the .ipa in it). From `main` it also goes on the **ios** pre-release
(regular releases stay Android's, so Obtainium and Orion Store aren't affected), with a SideStore
source: add `https://github.com/sanjinpepic/Tartan/releases/download/ios/sidestore.json` in
SideStore (Sources → +) once, and it offers each new build.

**Screenshots:** `.github/workflows/ios-screens.yml` (on each push that changes the app, or by
hand) builds for the simulator and runs `scripts/ios-screens.sh`: Today (top, and More today),
a session's and a workout's sheet, Coach, Activities and Progress, light and dark, with the sample
data only. They're committed to
[`screenshots/ios/`](../screenshots/ios/), e.g.
`https://raw.githubusercontent.com/sanjinpepic/Tartan/main/screenshots/ios/light-1-today.png`.
The app takes launch arguments for it (`ios/App/App/Shell/Launch.swift`): `-TartanDemo YES` (the
sample data as the intro's "Try it with sample data" starts it, then a half marathon nine weeks out
and a plan by Tartan's rules, once), `-TartanTab coach`, `-TartanMore YES`, `-TartanOpen session|workout`, `-TartanDark YES`; they last for
that launch only. The script waits for each screen's data: the app writes a `ready-<screen>` file in
its Documents when it has it (only with `-TartanDemo`). `scripts/ios-prepare.sh` holds the steps both builds share.

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

## Native iPhone screens

Since Nov 2026 the tab bar, Today, Coach (with a plan), Activities, Progress and the session and
workout sheets are native SwiftUI with Liquid Glass; the rest (the chat, Settings, Body, Record and
Lift, Routes, making the first plan) is still the web app's. The Swift is in `ios/App/App/Shell/`; the page's side is `web/lib/shell.ts`, the
same as Android's.

- **The plugin** (`TartanShellPlugin.swift`): the `TartanShell` Capacitor plugin, with every
  method of `ShellPlugin` in `web/lib/shell.ts`. `TartanBridgeViewController` (Capacitor's view
  controller) registers it in `capacitorDidLoad`, before the page loads, so the page finds it.
  `parts` says which parts are native (`NativeParts.built`: nav and today); the page leaves those
  out and draws the rest. Parts iOS doesn't have yet answer so the page does its own: `workout`
  says not native, `intro`, `pair` and `scan` refuse (the page's intro, pairing and scanner
  then), the rest resolve. Settings → More → Native screens turns each built part off.
- **The bridge** (`EngineBridge` in `ShellModel.swift`): a native screen's call goes to the page
  as an `api` event (kept until the page listens, sent on the bridge's own queue) and comes back
  with `reply`, or `chunk` lines then `reply` for a stream. `await engine.get("/api/today")`,
  `engine.send(path, method:, body:)`, `engine.rpc("prefs")`. Unanswered: 599 after 20 s for a
  read, 2 min for a write, 10 min for a stream, as on Android.
- **The shell** (`ShellViewController.swift`): the window's root holds three layers. The web
  view; the native screen (`ShellScreens`), over the page while one shows; and the bar with the
  page's messages, always on top, taking touches only where it draws (`PassthroughView`). The
  page says where it is after each route (`route`: the view, and `hidden` when a sheet, the
  keyboard or its intro is open). While something of the page's is open the page comes over the
  native screen, see-through (`html.native-screen`), so its sheets show over it.
- **The bar** (`TabBar.swift`): a floating Liquid Glass capsule (`glassEffect`), not SwiftUI's
  `TabView`. Only Today is native, and the other tabs are the one web view, which `TabView` would
  have to move between tabs; the page keeps its own scroller, so `tabBarMinimizeBehavior` would
  never see it scroll; and the page's address is where the app is, not the tab view's selection.
  It folds to its icons while Today scrolls down. A tab sends `go` with its address, as Android's
  bar does; the page's own bar is hidden (`html.native-nav`).
- **Today** (`TodayScreen.swift`, `TodayCards.swift`, data in `TodayData.swift`, reads and writes
  in `TodayModel.swift`): the same JSON as Android's `TodayData.kt` and `TodayMore.kt`. Pull to
  refresh is `go` with `action: "sync"`, then Today reads again when the page says `changed`.
- **Sheets** (`SessionSheet.swift`, `WorkoutSheet.swift`, `SheetData.swift`, `SheetModels.swift`):
  a planned session (steps, target, the review against the plan, a strength routine, Mark done,
  Log the sets, Ask your coach, a .fit file) and a workout (route on a MapKit map, the numbers,
  against the plan with next time's change, your notes, Swift Charts along the way, zones, shoes,
  splits, sources). `ShellModel.sheet` presents them over everything; the page's own workout
  links come here too (`workout` says native while that part is on).
- **Coach** (`CoachScreen.swift`, `CoachData.swift`): native only while there's a plan
  (`CoachModel.hasPlan`, kept so `parts` can answer); without one the page makes the first plan,
  and when one appears the shell sends `parts` so the page steps aside. This week or the whole
  plan, Change plan (ill, better, away, busy: `POST /api/plan/life`), the watch line
  (`rpc:watchWeek`), the suggestion, undo and the week's review; the ask bar opens the page's chat.
- **Activities** (`ActivitiesScreen.swift`) and **Progress** (`ProgressScreen.swift`,
  `ProgressData.swift`): the list by week with search and the sport filter (Routes is the page's),
  and the ranges and the Week, with Swift Charts.

**The next native screen:** add its name to `NativeParts.built`, return it from
`ShellModel.nativeFor`, draw it in `ShellScreens`, and give it a model that reads through
`engine` (the Android screen's `*Data.kt` is the reference for the JSON). Add a switch for it in
`tartan2Card` (`web/views/settings.ts`, the iOS list). `test/contract.test.ts` checks the Swift
side uses only what `web/lib/contract.ts` has.
