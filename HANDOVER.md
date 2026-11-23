# Handover: Tartan

For the next person or Claude Code session. Read this, then `PRODUCT.md` (intent) and `DESIGN.md` (look).

- **What to do next, and how releases go:** [`docs/handover-plan.md`](docs/handover-plan.md)
- **How it fits together:** [`docs/architecture.md`](docs/architecture.md)
- **Every build and decision so far:** [`docs/history.md`](docs/history.md) (the long handover, moved there unchanged in 2.56)

## What Tartan is

A training coach for runners, on Android and the PC. It gets workouts off the watch over Bluetooth
(Suunto's own protocol, no Suunto account), from Strava, Health Connect, intervals.icu and files,
merges every copy of a workout into one, and plans your training around your week. The coach
runs on your own AI key (Gemini or Claude), on Model Hub on the phone, or without AI on Tartan's
rules. Everything stays on your device; agents read it over MCP. The owner has a Suunto Run 2 and
uses it with a few friends; nothing is released yet.

**State (18 Nov 2026):** the owner confirms everything through 2.55 works on a real phone. 2.56
trimmed (Gemini Nano and the Suunto cloud export gone, a plan-first Coach tab); 2.57 took Google's
newer `AQ.` keys; 2.58 brought the PC's plan view in line with the phone, put where the plan goes
in one place, moved the step runner to Advanced, upgraded the Android Gradle plugin, and pulled the
native screens' words into `strings.xml` for translation; 2.59 to 2.61 polished the feel. 2.62
brought a note from the coach after each run, a race countdown on Today and routes from your own
runs. Builds now go out publicly on `sanjinpepic/Tartan` (below). See `docs/handover-plan.md` for what comes next.

The product was called FreeSuunto until 16 Oct 2026. Kept on purpose so installs keep their data:
the app id `dev.freesuunto.app`, the phone's `FreeSuunto/` folder, `freesuunto.*` storage keys,
Strava external ids `freesuunto-…`, the `x-freesuunto-token` header, `$FREESUUNTO_DATA`, and the
`freesuunto://` return link.

**Since 20 Nov 2026 the code is public** in [`sanjinpepic/Tartan`](https://github.com/sanjinpepic/Tartan)
under GPL-3.0-or-later, the one source from now on. The private `sanjinpepic/FreeSuunto` keeps the
full history before that, and the **owner's add-on**: Suunto's captured step runner
(`src/workout/suunto-runner.ts`), the two captured test fixtures and the owner build's signing key
(`android/app/debug.keystore`). They must never be in the public repository:
`scripts/owner-overlay.sh <private checkout>` copies them into a Tartan checkout for the owner's
build (and tells git to keep the public stub of the runner); `bun run check:public` (also in CI)
fails if any of them is committed. Without the add-on everything builds and the tests that need
it are skipped.

## Where things are

- **Branches:** work on `main` of `sanjinpepic/Tartan`. Pushing code doesn't release anything
  (only a new APK in `apk/` does, below). Before a push, `git fetch origin main`; if `main` has
  commits you don't, merge them (never force-push) and rerun the checks. CI (tests, typecheck,
  `check:public`) and the iPhone build run on each push, free on a public repository.
- **Engine:** TypeScript in `src/` (data, merge, analytics, plan, coach, watch protocol). It runs
  in a hidden WebView on the phone (`web/engine.ts`, bridged by `web/lib/shell.ts`, typed in
  `web/lib/contract.ts`; `docs/engine-contract.md` is generated from it) and in Bun on the PC.
- **Phone screens:** native Compose in `android/app/src/main/java/dev/freesuunto/app/shell/`.
- **PC:** the web app (`web/views/`) and API (`bun src/cli.ts serve`), the MCP server at `/mcp`.
- **Version:** `package.json` `version`, plain `0.4.N` where N is the build number (2.60 is
  `0.4.60`; before 2.60 it was `0.3.0-tartan2.N`, which update checkers such as Orion Store read
  as the same version every time). Bump it for every build you send out,
  and raise `versionCode` by one with it (the public APK uses it; the owner APK's versionCode is
  minutes since 2026).

## Checks before a ship

All must pass:

```bash
npx tsc --noEmit
bun test
bun run android:sync && bun scripts/phone-e2e.ts
cd android && ./gradlew testOwnerDebugUnitTest assembleOwnerDebug
bun run check:public
```

Robolectric renders the native screens to `android/app/build/shots/`: look at the ones you changed.
If it can't download its Android jar (Maven Central refuses this sandbox), set
`ROBOLECTRIC_REPO=https://maven-central.storage-download.googleapis.com/maven2`.

Then the public build, and back to the owner bundle:

```bash
bun run android:build:public      # signed with the release key: SHA-256 starts 76683ee0
bun run android:sync
```

## Every build goes out publicly

A standing rule (owner, 18 Nov 2026): every build sent to the owner is also released in the public
repository [`sanjinpepic/Tartan`](https://github.com/sanjinpepic/Tartan), where Obtainium reads it.

1. Build the public APK with `bun run android:build:public`. It must be signed with the release
   key (`apksigner verify --print-certs`: SHA-256 `76683ee0…`).
2. Raise `versionCode` in `package.json` by one (with the `version` bump) and add
   `fastlane/metadata/android/en-US/changelogs/<versionCode>.txt`: a few plain lines for users.
3. Replace the one file in `apk/` with
   `apk/tartan-<version>.apk`, commit, and push `main`. No tag push (sessions can't push tags):
   that repository's workflow tags `v<version>` and makes the GitHub release by itself (or run its
   `release.yml` by hand with workflow_dispatch). It's a public repository, so its Actions are free.

The release key is not in either repository or in the container. A session that ships needs the
owner to provide `tartan-release.jks` and its passwords (`KEEP-THIS-SAFE.txt`), set up through
`android/keystore.properties` (gitignored). `.github/workflows/release-from-source.yml` builds and
signs the public APK from the code instead, once the owner adds the repository secrets it names
(then `apk/` isn't needed any more).

## The two builds

| | Owner build | Public build |
|---|---|---|
| Gradle flavour | `owner` | `foss` |
| App id | `dev.freesuunto.app` | `app.tartan` |
| Signed with | `android/app/debug.keystore` (the owner's add-on; never regenerate it) | the release key |
| APK | `android/app/build/outputs/apk/owner/debug/app-owner-debug.apk` | `android/app/build/outputs/apk/foss/release/app-foss-release.apk` |

They share all code (since 2.56 neither flavour has source of its own) and install side by side.
Since 2.56 the public release is shrunk by R8 (`minifyEnabled`, `shrinkResources`; keep rules in
`android/app/proguard-rules.pro`): about 11.6 MB instead of 22.5 MB. The owner build isn't. When
adding a plugin or anything found by name (reflection, JNI, a class in a manifest or JSON), check
it survives in the foss release.

**The release key** is with the owner (`tartan-release.jks`, sent 9 Nov 2026), never in the repo.
Locally `android/keystore.properties` (gitignored) points at it. Without it the foss release builds
unsigned. Losing it means no updates for public installs.

## House rules

- Never commit `data/`, keys, `android/keystore.properties`, any `.jks`, watch recordings, or the
  owner's add-on (Suunto's runner, the captured fixtures, the debug key): the repository is public.
- GPL projects (Stride, Orion Store, GymMane) are for ideas only: nothing copied.
- Commit messages: plain and descriptive, ending with the session's attribution trailer and a
  `Claude-Session:` line.
- User-facing words: plain, short sentences, no jargon, no em dashes (colons and commas instead).
  One question per screen: don't add a card that another screen already shows.
- Send the owner one APK at the end of a batch, release the public one on `sanjinpepic/Tartan`, and
  add the batch to `docs/history.md`.
