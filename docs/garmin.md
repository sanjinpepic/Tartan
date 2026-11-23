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
- **The day's numbers to the phone:** Body Battery on waking, stress, the night's lowest heart rate
  and breathing, Pulse Ox, recovery time, resting heart rate and VO2 max, every half hour from a
  background service (below).

Pictures from the simulator (CI, the screenshot build `garmin/screens.jungle`): Forerunner 265
(AMOLED) [home](../screenshots/garmin/fr265-1-home.png), [before START](../screenshots/garmin/fr265-2-ready.png),
[a step change](../screenshots/garmin/fr265-3-step.png), [a rep](../screenshots/garmin/fr265-4-run.png); the
same on a Forerunner 955 (MIP) as `fr955-*.png`. The simulator is set to miles, so they show /mi.

The message from the phone is written by the engine (`src/workout/garmin.ts`, rpc `garminPlan`)
from the same workouts every other watch gets, and read by `garmin/source/Plan.mc`.

## The day's numbers, from the watch (`garmin/source/Body.mc`)

The other way, the watch app reads the day's recovery and sleep numbers and sends them to the
phone, which puts them into the engine's body signals as `garmin` (docs/signals.md). What a watch
app may read, on the watches that have it (each read is guarded, so an older watch builds and
simply sends less):

| Field | From | API |
| --- | --- | --- |
| `energy` | Body Battery history (`SensorHistory.getBodyBatteryHistory`): its peak from bedtime to 3 h after the usual wake time, which is the value on waking (it charges in sleep and drains once up) | 3.3 |
| `stress` | stress history (`getStressHistory`): the day's average since midnight (5 readings at least); yesterday's is worked out again over the whole day by the first run after midnight | 3.3 |
| `night_hr_min` | heart-rate history: the lowest from an hour before bedtime to an hour after the usual wake time | 2.1 |
| `spo2_max` | blood-oxygen history (`getOxygenSaturationHistory`): the highest in the same window, on watches with Pulse Ox set to all day or in sleep | 3.2 |
| `breathing_rate` | `ActivityMonitor.Info.respirationRate`, read by each background run while asleep, averaged (2 readings at least) | 3.3 |
| `recovery_h` | `ActivityMonitor.Info.timeToRecovery` (whole hours): the first reading in the 4 hours after the usual wake time, kept for the day | 3.3 |
| `resting_hr` | `UserProfile.restingHeartRate`: the day's (or the athlete's own figure, if they set one in the watch) | 1.0 |
| `vo2max` | `UserProfile.vo2maxRunning` | 3.3 |

Every watch in `garmin/manifest.xml` (Forerunner 70, 165 to 970, fēnix 6 to 9, fēnix E) builds the
same code; each read is skipped where the watch's firmware lacks it, so an older watch sends less.
In practice the fēnix 6 family and the Forerunner 245 (the oldest, 32 KB for the background) send
the same fields as the rest when their firmware has API 3.3, and Pulse Ox only on models with the
sensor.

"The night" is only a window to look in: from the athlete's usual bed and wake times in Garmin's
settings (`UserProfile.sleepTime`, `wakeTime`; 22:00 and 07:00 when unset). They aren't sent as
`sleep_start` and `sleep_end`, since they're a schedule, not the night that happened. The night's
numbers and the morning ones go from an hour before the usual wake time.

What isn't sent, and why: **sleep score**, recovery time, Body Battery, stress, respiration, VO2
max and Pulse Ox as *complications* (API 4.2) need the `ComplicationSubscriber` permission, which
Connect IQ allows only watch faces (the compiler refuses it for a watch app); the histories and
`ActivityMonitor` above give the same numbers, except the sleep score, which a watch app has no
other way to read. **Sleep stages, HRV and real bed and wake times**: Connect IQ doesn't expose them.
They come from other sources (Health Connect, Apple Health). Nothing is marked estimated.

The message (`{ t: "day", v: 1, days: [{ date, energy, stress, ... }] }`, a few hundred bytes):
today's day, and yesterday's last numbers until they've gone once.

**When it goes.** A background service (`garmin/source/Service.mc`, registered when the app first
opens and then for good) runs every 30 minutes, reads the numbers and sends today's when they
changed, or when they haven't gone for 2 hours (in case the phone missed them). The app sends
both days when it opens (after asking for the plan) and when the phone asks (`{ t: "ask" }`). The
background code is about 4 KB; Garmin gives a background 32 KB on the fēnix 6 family and the
Forerunner 245, and 64 KB on the others.

**The phone asking.** Tartan asks each time it opens or comes back (at most every 10 minutes). On
the watches with 64 KB for the background, a phone message wakes the background service even with
the app closed (`Background.registerForPhoneAppMessageEvent`), which answers an ask at once and
keeps a plan that arrives there, as the app would. On the 32 KB ones (`monkey.jungle` leaves that
out), phone messages wait for the app to open, as before, since a full plan wouldn't fit in the
background.

**On the phone**, `GarminLink` (Android) and `GarminLink.swift` (iPhone) take the message, check it
(only these fields, numbers in their ranges, a date from two days ago to tomorrow, `GarminMessage`)
and call the engine's `signalsPut` with source `garmin`, only while the watch Tartan works with is
a Garmin, the same switch as the plan. A day the engine couldn't take is kept and sent at the next
sync.

**The gap.** Garmin's companion SDKs hand a message over only while Tartan is running on the phone
(in front, or still alive behind). A message that comes while Tartan is closed is lost; nothing
runs on the phone in the background to catch it. What makes up for it: the watch sends again
within 2 hours even when nothing changed, the phone asks for the day each time Tartan opens, and
yesterday's last numbers go along until they've gone once. A day the watch stopped resending
(older than yesterday) while Tartan stayed closed isn't recovered: Body Battery on waking, the
night's lowest heart rate and the rest come back only for today and yesterday.

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
