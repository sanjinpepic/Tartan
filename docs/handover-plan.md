# Tartan: handover plan (18 Nov 2026)

A short plan for whoever picks Tartan up next (a person or a Claude Code session), updated for
2.62. Start with `HANDOVER.md` (checks, builds, rules); the full history and every decision are
in `docs/history.md`, how it fits together in `docs/architecture.md`, product intent in
`PRODUCT.md`, design in `DESIGN.md`. This page is where things stand, what to do next and in what
order.

## Where it stands

- **Version 0.4.62** (versionCode 7), on `tartan-2` and `main` (the same after every ship).
  Versions are plain `0.4.N` from 2.60, N the build number, so update checkers see each one as
  newer. All checks pass: 393 engine tests, 99 Robolectric tests, the phone end-to-end script.
- **The owner confirms the latest build (2.61) works on his phone.** 2.62 (a note after each run,
  the race countdown, routes from your own runs, buttons that wrap) has run in tests only.
- **The owner confirms everything through 2.55 works on a real phone** (18 Nov 2026), including
  the Suunto Run 2 over Bluetooth and 2.47 to 2.55 (the plan on other watches, guided runs,
  one-tap life changes, the coach's routes, the chat fixes), which had run in tests only.
- **Public builds are out** on [`sanjinpepic/Tartan`](https://github.com/sanjinpepic/Tartan) since
  2.56, where Obtainium reads them. Nothing sent to Orion Store or F-Droid yet.

## Two builds

| | Owner build | Public build |
|---|---|---|
| Gradle flavour | `owner` | `foss` |
| App ID | `dev.freesuunto.app` | `app.tartan` |
| Signed with | the debug key in the repo | the release key (not in the repo; SHA-256 `76683ee0…`) |
| Build | `bun run android:build` | `bun run android:build:public` |

They install side by side. Data moves between them with Settings → More → Backups.

## The release key

- The owner holds it: `tartan-release.jks`, with its passwords in `KEEP-THIS-SAFE.txt`
  (sent 9 Nov 2026). It is not in the repo or the container and must never be committed: a session
  that ships asks the owner for it (locally `android/keystore.properties`, gitignored, points at it).
- If it is lost, people who installed the public build can't get updates.

## How to ship

Every batch goes to the owner **and** out publicly:

1. Bump `version` in `package.json` and raise `versionCode` by one; add
   `fastlane/metadata/android/en-US/changelogs/<versionCode>.txt` (a few plain lines for users).
2. Run the checks: `npx tsc --noEmit`, `bun test`, `bun run check:public`,
   `bun run android:sync && bun scripts/phone-e2e.ts`,
   `cd android && ./gradlew testOwnerDebugUnitTest assembleOwnerDebug`.
3. Look at the screenshots you changed in `android/app/build/shots/`.
4. `bun run android:build:public` (signed with the release key, SHA-256 `76683ee0…`), then
   `bun run android:sync` to put the owner bundle back.
5. Add an entry to `docs/history.md`, commit, push `tartan-2`, fast-forward `main`.
6. Send the owner the owner APK.
7. Release the public APK on Tartan's `release` branch, never on `main` (APKs stay out of main's
   history). That branch is one commit: `.github/workflows/release.yml`, `notes.md` and
   `apk/tartan-<version>.apk`. Make a new one-commit branch with the new APK in place of the old
   and force-push it to `release`; its workflow tags `v<version>` on main's newest commit and makes
   the GitHub release. No tag push from a session.

This repository's `.github/workflows/release.yml` (a `v*` tag) is no longer the route: the
private repository has no Actions minutes left.

## Before a wider release

1. **Decide the app ID.** `app.tartan` is set but can still change. Once friends install the
   public build it is fixed for good.
2. **A small group first:** three or four friends on different phones and watches (a Samsung,
   a Pixel, a Garmin user), on the public build, reporting through Settings → More → Send
   feedback.
3. **Read Strava's API agreement.** Its 2024 terms restrict using Strava data with AI, and the
   coach reads workouts. Health Connect and intervals.icu don't have that problem and are the
   easier ways in for new users anyway.
4. **Model Hub** is the owner's own fork; other people can't install it unless it is published
   too. Without it they use a Gemini key, or Tartan's rules.
5. **The step runner.** The public build sends Tartan's own (clean-room) step runner, never yet
   confirmed on a watch. Before friends rely on guided workouts, the owner picks Tartan's own under
   Settings → More → Advanced → Step runner, sends a session and checks steps, laps, popups and the
   end screen on the Run 2. If it holds, the captured runner can go.

## What 2.57 to 2.62 did

- **2.57:** Gemini keys starting with `AQ.` are accepted.
- **2.58:** the PC's plan view matches the phone's Coach tab (plan first, Change plan in a sheet,
  one "On your watch" line, where the plan goes in Settings → Sources); Health Connect's switches
  are one short line each and its plan switch is gone (Plan on your watch is the one place); the
  step runner left Settings → Watch for Advanced; AGP 8.13.2 (R8 reads Kotlin 2.3's metadata, no
  more warning); the native screens' words are in `strings.xml`, ready for translation.
- **2.59 to 2.61:** the bar folds while you scroll; plain version numbers; a tick on every control.
- **2.62:** a short note from the coach after each new run (Settings → Training times → After a
  run); the race countdown on Today from twelve weeks out, with the prediction from recent runs and
  how it moved; the coach's `route_from_run` (a route from a past run, reversed, longer or
  shorter); buttons that wrap instead of squeezing. To confirm on the phone: see `docs/history.md`
  (2.62).

## What to build next, in order

1. **The public build to a few friends.** The steps are above (Before a wider release, How to
   ship). Three or four people on different phones and watches, reporting through Settings → More
   → Send feedback.
2. **Translations.** The native screens' words are in `android/app/src/main/res/values/strings.xml`
   since 2.58 (README → Translating). Next: hook up Weblate (or take `values-xx` files by pull
   request), then the engine's words (TypeScript: the coach's prompts, takeaways, session names,
   sync errors), which are still English in the code and need a plan of their own.
3. **iPhone**, the owner's next big step. The engine is TypeScript and would carry over; the
   screens are native Android (Compose) and would need SwiftUI, or Compose Multiplatform. It needs
   a Mac or macOS CI, and an Apple Developer account to install beyond a week and to publish.
   Apple Watch plans need it too (HealthKit's workout plans live on the iPhone).

Done before 2.56, still to check on real devices with friends: the plan on other watches
(intervals.icu to Garmin, Health Connect sessions on a Galaxy or Pixel Watch, .fit files in
Garmin and Coros apps), guided runs with the screen off, and whether the life changes' ramps feel
right. See `docs/history.md` (2.47 to 2.49).

Not planned: social features, nutrition, a Wear OS app, Play Store (later, and it needs a
privacy policy, the Play Console forms and a 14-day test with 12 people). Cycling as a real
sport (power zones, FTP) only if the users ride.

## Things to know

- **The coach's routing:** with a cloud key and a connection, the cloud model answers phone
  chats; offline, Gemma on Model Hub does. "Keep the chat on the phone" in Coach settings turns
  that off. Plans and weekly reviews use the planner's model (Gemini 3.8 Flash, or Opus on Claude).
  More in `docs/architecture.md`.
- **Every source becomes a FIT file** in its own folder, so merging works the same for all.
- **The Suunto protocol is reverse engineered.** A firmware update can break it; the watch
  recorder (Settings → More → Advanced) captures a connection for fixing it without the watch.
- **House rules:** never commit `data/`, keys, watch tapes or the release key; don't regenerate
  `android/app/debug.keystore`; GPL projects (Stride, Orion Store, GymMane) are for ideas only;
  no pull requests unless the owner asks; bump the version and versionCode with every build sent
  out, and release it on `sanjinpepic/Tartan`.
