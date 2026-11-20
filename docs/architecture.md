# Tartan: architecture

One page on how the parts fit. The short handover is `HANDOVER.md`; history is `docs/history.md`.

## The engine

All of Tartan's logic is TypeScript in `src/`, written against a small storage interface
(`src/disk.ts`): `src/disk-node.ts` on the PC (the `data/` folder), `web/disk-capacitor.ts` on the
phone (app-private storage, the `FreeSuunto/` folder). `src/api.ts` holds every `/api` route as a
plain `Request → Response` handler, so the same routes run in Bun on the PC (`src/server.ts`) and
in-process on the phone (`web/local-api.ts`).

Main modules: `src/library.ts` (every source read as one library), `src/merge.ts`,
`src/analytics.ts` (load, fitness, readiness, takeaways), `src/plan.ts` and `src/basic-plan.ts`
(plans, and Tartan's own rules), `src/life.ts` (ill, away, busy week), `src/coach.ts` and
`src/coach/` (the coach), `src/tools.ts` (the data tools the coach and MCP share), `src/mcp.ts`,
`src/protocol/` and `src/transport/` (the watch).

## The phone: engine, bridge, native screens

The Android app (`android/`) is a Capacitor shell. A hidden WebView runs the engine bundle
(`web/engine.ts`, built by `bun run build:engine`); it draws nothing. Every screen is native
Compose in `android/app/src/main/java/dev/freesuunto/app/shell/`, hosted by `TartanShellPlugin`.

The screens talk to the engine through one bridge: they call `/api` routes and named RPCs, and the
engine answers in `web/lib/shell.ts`. The calls and their arguments are typed in
`web/lib/contract.ts`; `docs/engine-contract.md` is generated from it (`bun run contract:doc`) and
`test/contract.test.ts` checks the Kotlin side uses only what the contract has.

The native screens' words are Android string resources (`android/app/src/main/res/values/strings.xml`,
read with `stringResource` / `pluralStringResource` in Compose and `str()` / `plural()` from
`shell/Txt.kt` elsewhere, set up by `TartanApp`), so they can be translated (README → Translating).
Words the engine sends (the coach, takeaways, plan and session names, sync errors) are still
English in the TypeScript.

Android features that need native code are Capacitor plugins in `android/app/src/main/java/dev/freesuunto/app/`
(Health Connect, Model Hub, speech, the widget, the theme, the local network), registered in
`MainActivity.java`. Bluetooth goes through the Capacitor BLE plugin (`src/transport/capacitor-ble.ts`).

The PC runs the full web app (`web/app.ts`, `web/views/`) over the same API, plus the MCP server.

## Sources, FIT files, one library

- **Watch:** files copied over Bluetooth are kept as they are under `watches/<watch>/files/`
  (`src/store.ts`); the workouts among them are FIT files or Suunto's logbook.
- **Health Connect, intervals.icu, shared files, phone recordings:** each workout is written as a
  FIT file in its source's own folder (`src/import.ts`, `src/fit-write.ts`), so it is read like
  a watch file.
- **Strava:** activities and streams as Strava gives them (`src/strava/`).
- **Suunto cloud:** workouts an earlier version exported under `cloud/` are still read
  (the export itself went in 2.56).

`src/library.ts` reads every source as candidates; `src/merge.ts` joins copies of one workout
(overlapping by at least half, the same sport family, distances within 12%), takes each field
from the best source with provenance, and one source's time series. Ids stay stable through
`activity-links.json`.

## The coach's routing

`src/coach.ts` is the public surface and decides who answers; `src/coach/` holds the rest
(settings, labels, prompt, conversations, plan and route tools, one turn loop per provider).

- **Providers:** Claude (`turn-claude.ts`) or Gemini (`turn-gemini.ts`) on the user's key, or
  Model Hub on the phone (`turn-local.ts`, the tool loop in `src/coach-litert.ts`). Without any,
  Tartan's rules (`src/basic-plan.ts`) write the plan and there is no chat.
- **A phone chat** (Model Hub): with a cloud key and a connection, the cloud model answers it;
  offline, Model Hub does. "Keep the chat on the phone" turns that off. `routeOf` reads whether a
  message asks for a new plan or a changed session, so the phone's model is pointed at its tools.
- **Plans and weekly reviews** go to the planner: the chat's cloud provider, else a cloud key
  you have (Gemini first), else Tartan's rules (`plannerOf`).
- A conversation moves to the coach's current provider when it's next asked something
  (`rehome`), its words carried over.

## Where tests live

- `test/*.test.ts`: the engine, with `bun test` (merge, analytics, plans, the coach against
  stand-ins for each provider, the watch protocol against a fake watch, the bridge contract).
- `android/app/src/test/.../TartanShotsTest.kt`: Robolectric renders the native screens from
  JSON fixtures (`android/app/src/test/resources/shots/`) to `android/app/build/shots/` and clicks
  through them.
- `scripts/phone-e2e.ts`: the production bundle in phone mode in Chromium, end to end (sync,
  plan, coach, routes, faces, backups).
- `bun run check:public`: nothing from Suunto's files in the public build.
