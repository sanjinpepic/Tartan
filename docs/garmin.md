# Tartan on a Garmin watch

Tartan works with one watch at a time, a Suunto or a Garmin, and the watch it finds decides the
way. A Suunto is read and written over Bluetooth with Suunto's own protocol (as before). A Garmin
gets the plan through Garmin Connect, to Tartan's own watch app, and its runs come back the way
any Garmin run does: through intervals.icu, Strava, Health Connect or Apple Health. Nothing new
uploads anything.

## The watch app (`garmin/`)

A Connect IQ watch app for Forerunner and fenix watches, in Monkey C:

- **Home:** today's session (its name, the main set or how long, the target), the next one under it;
  DOWN lists the coming days, and START on one runs that one instead. Without a session, START
  runs without steps. Hold UP (the menu) to ask the phone for the plan again.
- **A run:** each step (warm-up, reps, recoveries, cool-down) ends by its time or distance (timer
  time, so a pause holds it) or by BACK/LAP, with a lap, a buzz and a full-screen moment saying
  what comes next. The screen shows the step, what's left of it in large numbers, the target
  (pace or heart rate, green in it, red with "ease off" or "speed up" out of it, or "Easy"),
  current pace and heart rate, and a ring through the step. Units follow the watch's settings.
- **Buttons, as in Garmin's own workouts:** START starts, and pauses (Resume, Save, Discard);
  BACK/LAP takes a lap and moves to the next step; BACK before the start leaves. Taps and swipes do
  nothing during a run.
- **Recorded** with ActivityRecording in the session's sport (running unless it's a ride, strength
  or other), so it saves as a normal Garmin activity and syncs to Garmin Connect. If the app is
  closed under a run, what was recorded is saved.
- **Offline:** the plan the phone sends is kept on the watch (Application.Storage), so the phone
  can stay at home.

Pictures from the simulator (CI, the screenshot build `garmin/screens.jungle`): Forerunner 265
(AMOLED) [home](../screenshots/garmin/fr265-1-home.png), [before START](../screenshots/garmin/fr265-2-ready.png),
[a step change](../screenshots/garmin/fr265-3-step.png), [a rep](../screenshots/garmin/fr265-4-run.png); the
same on a Forerunner 955 (MIP) as `fr955-*.png`. The simulator is set to miles, so they show /mi.

The message from the phone is written by the engine (`src/workout/garmin.ts`, rpc `garminPlan`)
from the same workouts every other watch gets, and read by `garmin/source/Plan.mc`.

## Installing it (sideload)

The builds are on the [`garmin` release](https://github.com/sanjinpepic/Tartan/releases/tag/garmin):
one `tartan-<watch>.prg` per watch, and `tartan.iq` for the Connect IQ Store.

1. Find your watch's file: `tartan-fr265.prg` for a Forerunner 265, `tartan-fenix847mm.prg` for a
   fenix 8 47 mm, and so on (the names are Garmin's device ids, listed in `garmin/manifest.xml`).
2. Connect the watch to a computer with its USB cable. It shows up as a drive called GARMIN (on a
   Mac, newer watches need [Android File Transfer](https://www.android.com/filetransfer/) or
   OpenMTP, since they connect over MTP).
3. Copy the `.prg` into the `GARMIN/APPS` folder, then unplug the watch.
4. Tartan is in the watch's apps list (on most watches: press START on the watch face, scroll to
   Tartan). Add it to the favourites to keep it near the top.

Garmin Express doesn't install `.prg` files; copying the file is the way until Tartan is in the
Connect IQ Store. A sideloaded app stays until you delete it; a newer `.prg` copied over it
replaces it.

## The phone side

There's no switch: **Settings → Sources → Watch → Connect your watch** (or the intro's watch step)
finds the watch and works out its brand. For a Garmin:

- **Android** asks Garmin's companion SDK (`com.garmin.connectiq:ciq-companion-app-sdk:2.4.0`,
  `GarminLink.kt`) for the watches Garmin Connect knows, and looks for watches advertising nearby.
  Garmin Connect must be installed and the watch paired there; without it, Tartan says so and
  links to it.
- **iPhone** uses Garmin's iOS SDK (`connectiq-companion-app-sdk-ios` 1.8.0 by Swift Package
  Manager, not vendored; `GarminLink.swift`). iOS doesn't let an app list Garmin Connect's watches,
  so a Garmin found nearby (or "It's a Garmin" when nothing answered) opens Garmin Connect's device
  picker, which hands the watch back to Tartan through the `tartan-ciq:` link.

Once the watch is a Garmin, the phone sends today's session and the next six days' when Tartan
opens or comes back to the front, when the plan changes, and when the watch app asks (it asks each
time it opens). Only a changed plan is sent again, unless asked; Settings → Watch has "Send it
again". Settings → Watch shows the watch, the last session sent, and whether Tartan's app is on
it. Nothing of Suunto's runs for a Garmin, and nothing of Garmin's for a Suunto; connecting a
different watch replaces it.

## Building

CI only (`.github/workflows/garmin.yml`): the Connect IQ SDK 9.3.0 and the device files come with
a Garmin developer login (secrets `GARMIN_USERNAME`, `GARMIN_PASSWORD`) through
[connect-iq-sdk-manager-cli](https://github.com/lindell/connect-iq-sdk-manager-cli), then
`garmin/build.sh` builds every watch and the `.iq` and puts them on the `garmin` release. To add a
watch, add its id from Garmin's device list (the workflow prints the Forerunner and fenix ones) to
`garmin/manifest.xml`. Nothing of the SDK, the devices or the signing key is committed.

## What's left for the Connect IQ Store

- **A fixed signing key.** CI signs with the `GARMIN_DEVELOPER_KEY` secret (a base64 DER RSA key:
  `openssl genrsa -out key.pem 4096 && openssl pkcs8 -topk8 -inform PEM -outform DER -in key.pem -out key.der -nocrypt && base64 -w0 key.der`)
  when it's set; without it each run makes its own key, which is fine for sideloading but the
  Store ties an app to one key for good. Set the secret before the first upload and keep the key
  safe.
- The upload itself (`tartan.iq` in the Connect IQ developer dashboard), the store listing and
  pictures, and Garmin's review.
- After that, the phone can open the app's Store page instead of the release page
  (`ConnectIQ.openStore` on Android, `showConnectIQStoreForApp` on iPhone).
- Body Battery, stress and other daily signals from the watch aren't sent yet (they come later
  through the engine's signals layer).
