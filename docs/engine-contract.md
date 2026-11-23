# The engine contract

Generated from `web/lib/contract.ts` and `web/lib/shell.ts` by `bun scripts/contract-doc.ts`; don't edit by hand.

The native screens (Android today, iOS later) draw everything; the TypeScript engine (the same code the PC runs) does the work. They talk over three channels:

- **Calls into the engine:** the screens send `api` events. A path `rpc:<name>` is one of the calls below, with its arguments as the JSON body; any other path goes to the engine's HTTP API (`src/api.ts`, the routes the PC serves). The engine answers with `reply` (and `chunk` for streamed lines).
- **Calls into the screens:** the engine calls the native plugin's methods.
- **Events from the screens:** the plugin notifies the page.

## Calls into the engine

### Settings: preferences kept by the engine

**`prefs`**

- takes `—`
- answers `{ colours: ColourChoice; weekly: boolean; demos: DemoChoice; version: string; build: string; paired: boolean; inUse: InUse; }`

**`colours`**

- takes `{ choice: 'wallpaper' | 'tartan'; }`
- answers `void`

**`weekly`**

- takes `{ on: boolean; }`
- answers `void`

**`demos`**

- takes `{ choice: string; }`
- answers `void`

**`allowReminders`** · Reminders and the calendar: Android's notification permission, the calendars it may write.

- takes `—`
- answers `boolean`

**`calendars`**

- takes `—`
- answers `{ id: string; title: string; account?: string | undefined; }[] | null`

### Strength: a session's exercises with their doses

**`routine`**

- takes `{ exercises?: PlannedExercise[] | undefined; minutes?: number | undefined; }`
- answers `{ basic: boolean; primary: ('traps' | 'delts' | 'chest' | 'biceps' | 'triceps' | 'forearms' | 'lats' | 'upper_back' | 'lower_back' | 'abs' | 'obliques' | 'hip_flexors' | 'glutes' | 'glute_med' | 'adductors' | 'quads' | 'hamstrings' | 'calves' | 'tibialis')[]; secondary: ('traps' | 'delts' | 'chest' | 'biceps' | 'triceps' | 'forearms' | 'lats' | 'upper_back' | 'lower_back' | 'abs' | 'obliques' | 'h…`

**`exercises`**

- takes `—`
- answers `{ figure: Body; items: { id: string; name: string; kind: 'strength' | 'core' | 'power' | 'mobility'; equipment: string | null; dose: string; cues: [string, string, string]; why: string; primary: ('traps' | 'delts' | 'chest' | 'biceps' | 'triceps' | 'forearms' | 'lats' | 'upper_back' | 'lower_back' | 'abs' | 'obliques' | 'hip_flexors' | 'glutes' | 'glute_med' | 'adductors' | 'quads' | 'hamstrings' …`

**`body`** · The 3D body (lib/body3d.ts) as WebP frames: an exercise's move, or muscles lit.

- takes `{ key?: string | undefined; exercise?: string | undefined; primary?: string[] | undefined; secondary?: string[] | undefined; width?: number | undefined; height?: number | undefined; loop?: number | undefined; turn?: number | undefined; }`
- answers `{ loop: string[]; turn: string[]; cycle: number; } | null`

**`restNote`**

- takes `{ at?: number | undefined; next?: string | undefined; }`
- answers `boolean`

### The watch over Bluetooth (web/watch.ts)

**`watchConnect`** · Connect the Suunto (with deviceId: the one Find my watch picked, which becomes the watch).

- takes `{ deviceId?: string | undefined; name?: string | undefined; }`
- answers `boolean`

**`watchFind`** · Find my watch: one watch and its brand (src/transport/brand.ts); `garmin` is what Garmin Connect reports.

- takes `{ garmin?: { id: string; name: string; connected?: boolean | undefined; }[] | undefined; }`
- answers `{ found: FoundWatch | null; nearby: number; }`

**`watchBrand`** · The one watch Tartan works with, its brand and name; with `set`, another (null: none).

- takes `{ set?: 'garmin' | 'suunto' | null | undefined; name?: string | undefined; }`
- answers `{ brand: WatchBrand | null; name: string; } | { brand: WatchBrand | null; name: string; }`

**`garminPlan`** · The plan for Tartan's Garmin watch app (src/workout/garmin.ts); null unless the watch is a Garmin.

- takes `{ days?: number | undefined; }`
- answers `{ key: string; message: GarminMessage; } | null`

**`watchBackup`**

- takes `{ path?: string | undefined; force?: boolean | undefined; }`
- answers `number`

**`watchDisconnect`**

- takes `—`
- answers `boolean`

**`watchCancel`**

- takes `—`
- answers `boolean`

**`watchBrowse`**

- takes `{ path?: string | undefined; }`
- answers `boolean`

**`watchSaveOne`**

- takes `{ path: string; }`
- answers `boolean`

**`watchWeek`** · The coming 7 days as guided workouts; with send, send them.

- takes `{ send?: boolean | undefined; }`
- answers `{ canBluetooth: boolean; wanted: number; onWatch: number; sent?: undefined; line?: undefined; } | { sent: boolean; line: string; canBluetooth?: undefined; wanted?: undefined; onWatch?: undefined; }`

**`fuel`**

- takes `{ set?: Partial<{ drink: boolean; drinkMin: number; gel: boolean; gelMin: number; }> | undefined; }`
- answers `{ fromMin: number; gel: boolean; drink: boolean; gelMin: number; drinkMin: number; }`

### The plan on other watches (lib/plan-out.ts): intervals.icu (Garmin…), Health Connect (Samsung, Pixel…), .fit files

**`planOut`** · Where the coming week can go besides a Suunto, and how each stands; an op sends, stops or shares.

- takes `{ op?: 'hc' | 'state' | 'intervals' | 'intervalsOff' | 'hcOff' | 'files' | undefined; }`
- answers `PlanOutState`

**`sessionFile`** · One session as a .fit workout file through the share sheet.

- takes `{ date: string; kind: string; }`
- answers `{ name: string; }`

**`runner`**

- takes `{ set?: 'tartan' | 'suunto' | undefined; }`
- answers `{ public: boolean; choice: RunnerChoice; }`

### Strava

**`stravaSync`**

- takes `{ full?: boolean | undefined; }`
- answers `{ lines: string[]; result: StravaSyncResult | null; }`

**`stravaConnect`**

- takes `{ clientId?: string | undefined; clientSecret?: string | undefined; }`
- answers `{ url: string; }`

**`openUrl`**

- takes `{ url: string; }`
- answers `boolean`

### Files and Health Connect

**`importFit`**

- takes `{ name: string; data: string; }`
- answers `{ already?: boolean | undefined; error?: string | undefined; }`

**`hc`**

- takes `{ op?: 'state' | 'connect' | 'stop' | 'toggle' | 'share' | 'manage' | undefined; kind?: HcKind | undefined; remove?: boolean | undefined; }`
- answers `{ status: 'available' | 'update' | 'unavailable' | 'web'; on: boolean; kinds: { [k: string]: boolean; }; missing: { [k: string]: boolean; }; last: { at: number; written: number; covered: number; sleep: number; imported?: number | undefined; error?: string | undefined; } | null; note: string | null; }`

**`ah`** · Apple Health on iPhone, read only: its state; connect, bring in now, open the Health app, stop.

- takes `{ op?: 'state' | 'connect' | 'sync' | 'open' | 'stop' | undefined; }`
- answers `{ status: 'available' | 'unavailable' | 'web'; on: boolean; running: boolean; workouts: number; seen: number | null; last: { at: number; added: number; error?: string | undefined; } | null; note: string | null; }`

**`saveFile`**

- takes `{ path: string; name: string; type: string; }`
- answers `void`

### Body signals (src/signals.ts, docs/signals.md): each day's sleep and recovery, from any watch or app

**`signalsPut`** · Add or change days from a source (Garmin's watch app, Suunto, Health Connect, Apple Health, told); null clears a field, `replace` sends the source's whole day.

- takes `{ days: SignalPut[]; replace?: boolean | undefined; }`
- answers `{ days: SignalDay[]; dropped: string[]; }`

**`signals`** · The days kept (the last `days`, default 30), merged, each value with its source, and the usual for today.

- takes `{ days?: number | undefined; }`
- answers `{ today: string; days: SignalDay[]; usual: SignalUsual; watch: 'garmin' | 'suunto' | null; }`

### The PC: pairing and syncing (lib/pairing.ts)

**`pcState`**

- takes `—`
- answers `{ url: string; name: string | null; } | null`

**`pcPair`**

- takes `{ urls: string; code: string; }`
- answers `{ url: string; name: string | null; }`

**`pcSync`**

- takes `—`
- answers `string`

**`pcUnpair`**

- takes `—`
- answers `boolean`

**`pairCheck`**

- takes `{ urls: string[]; }`
- answers `{ home: string[]; replacing: boolean; current: string | null; }`

**`pairConnect`**

- takes `{ urls: string[]; code: string; }`
- answers `{ url: string; name: string | null; }`

**`pairSync`**

- takes `—`
- answers `{ line: string; pulled: number; pushed: number; merged: number; changed: boolean; }`

**`scanPair`**

- takes `—`
- answers `boolean`

**`reopen`**

- takes `—`
- answers `boolean`

### The coach on the phone

**`modelHub`** · With "dropOld", Tartan's own model file from before 2.37 goes (Model Hub holds the models now).

- takes `{ op?: 'state' | 'open' | 'updates' | 'allow' | 'dropOld' | undefined; }`
- answers `true | { allowed: boolean; }`

### Watch faces (lib/faces.ts, lib/face-install.ts)

**`faces`**

- takes `{ size?: number | undefined; }`
- answers `{ canBluetooth: boolean; faces: { id: string; name: string; builtin: boolean; onWatch: boolean; picture: string | null; }[]; }`

**`faceInstall`**

- takes `{ id: string; builtin?: boolean | undefined; }`
- answers `string`

**`facesOnWatch`**

- takes `—`
- answers `{ total: number; mine: { id: string; name: string; }[]; }`

**`faceRemove`**

- takes `{ id: string; name: string; }`
- answers `boolean`

**`faceStart`**

- takes `{ arg: string; size?: number | undefined; }`
- answers `{ design: FaceDesign; saved: boolean; presets: { i: number; name: string; design: Preset; picture: string | null; }[]; canBluetooth: boolean; }`

**`facePreview`**

- takes `{ design: unknown; size?: number | undefined; data?: boolean | undefined; }`
- answers `string`

**`faceSurprise`**

- takes `{ id: string; }`
- answers `FaceDesign`

**`faceSave`**

- takes `{ design: unknown; saved: boolean; }`
- answers `{ id: string; error?: string | undefined; }`

**`facePackage`**

- takes `{ id: string; }`
- answers `boolean`

**`weekFace`**

- takes `{ base?: string | undefined; keep?: boolean | undefined; send?: boolean | undefined; size?: number | undefined; }`
- answers `{ picture: string; bases: { id: string; name: string; }[]; base: string; keep: boolean; said: string | null; } | null`

### Backups, the intro, diagnostics

**`backup`**

- takes `{ op?: 'weekly' | 'state' | 'setPass' | 'now' | 'change' | 'restore' | undefined; pass?: string | undefined; on?: boolean | undefined; name?: string | undefined; data?: string | undefined; }`
- answers `{ pass: boolean; weekly: boolean; last: number | null; where: string | null; failed: { at: number; text: string; } | null; min: number; said: string | null; restored: boolean; }`

**`replayIntro`**

- takes `—`
- answers `boolean`

**`introStep`**

- takes `{ step: number; }`
- answers `boolean`

**`introDone`**

- takes `{ reload?: boolean | undefined; }`
- answers `boolean`

**`demo`**

- takes `{ op?: 'state' | 'start' | 'leave' | undefined; }`
- answers `{ on: boolean; }`

**`recorder`**

- takes `{ op?: 'state' | 'share' | 'arm' | 'cancel' | undefined; }`
- answers `RecorderState`

**`log`**

- takes `—`
- answers `{ text: string; version: string; build: string; }`

**`syncSchedule`**

- takes `—`
- answers `boolean`

### Routes (lib/routing.ts, src/routes.ts, src/race-pace.ts)

**`routePath`**

- takes `{ a: LngLat; b: LngLat; }`
- answers `{ line: LngLat[]; via: 'osm' | 'brouter'; } | { line: null; reason: 'no-path' | 'unreachable'; detail: string; }`

**`routeHeights`**

- takes `{ line: LngLat[]; }`
- answers `number[] | null`

**`routeLoops`**

- takes `{ start: LngLat; km: number; }`
- answers `Loop[]`

**`routeToWatch`**

- takes `{ name: string; line: LngLat[]; waypoints: unknown[]; }`
- answers `{ id: number; points: number; }`

**`routeGpx`**

- takes `{ id: string; }`
- answers `boolean`

**`racePacing`**

- takes `{ line: LngLat[]; elevation?: number[] | null | undefined; time: string; }`
- answers `{ splits: Split[]; marks: { point: LngLat; name: string; }[]; line: LngLat[]; target: number; }`

**`courseToWatch`**

- takes `{ name: string; line: LngLat[]; marks: { point: LngLat; name: string; }[]; }`
- answers `{ id: number; points: number; }`

**`splitsToWatch`**

- takes `{ name: string; splits: unknown; }`
- answers `boolean`

**`raceWeek`**

- takes `{ race: RaceIn; }`
- answers `RaceWeek | null`

**`pacingToWatch`**

- takes `{ name: string; distance_km: number; time_s: number; }`
- answers `boolean`

### Recording a run on the phone (web/recorder.ts)

**`recStart`**

- takes `—`
- answers `boolean`

**`recPause`**

- takes `—`
- answers `boolean`

**`recResume`**

- takes `—`
- answers `boolean`

**`recFinish`**

- takes `—`
- answers `boolean`

**`recKeep`**

- takes `{ name?: string | undefined; strava?: boolean | undefined; }`
- answers `{ said: null; } | { said: string; }`

**`recDiscard`**

- takes `—`
- answers `boolean`

**`recUpload`**

- takes `{ id: string; }`
- answers `string`

**`recHeart`**

- takes `—`
- answers `boolean`

**`recCues`**

- takes `{ on?: boolean | undefined; }`
- answers `boolean`

**`recGuide`** · Guide today's planned session when a run starts (on or off, with `on`): whether, and the session.

- takes `{ on?: boolean | undefined; }`
- answers `{ on: boolean; session: { name: string; steps: number; structured: boolean; first: string; } | null; }`

**`recLap`** · A guided run: on to the next step now.

- takes `—`
- answers `boolean`

## Calls into the screens

- **`parts`** `—`
- **`configure`** `{ colours?: string | undefined; }`
- **`route`** `{ view: string; hash: string; hidden: boolean; colours: string; }` · Where the app is: the view, the address, whether something of the page's is open.
- **`reply`** `{ id: string; status: number; body: string; }`
- **`chunk`** `{ id: string; line: string; }`
- **`chat`** `{ conversation?: string | null | undefined; prefill?: string | undefined; }`
- **`workout`** `{ id: string; at?: 'moments' | undefined; }` · A workout's sheet; `at: "moments"` (the note after a run): scrolled to its map and moments, when it has some.
- **`board`** `{ lanes: { id: string; state: string; text: string; glyph: string; name: string; status: string; failed: boolean; }[]; }` · The sync board's lanes, for the chip and its sheet.
- **`watch`** `{ state: string; }` · State pushed on every change (JSON strings, parsed natively).
- **`recorder`** `{ state: string; }`
- **`intro`** `{ step: number; }`
- **`snack`** `{ id: number; text: string; error: boolean; action?: string | undefined; ms?: number | undefined; }`
- **`pair`** `{ urls: string[]; code: string; ask: boolean; }`
- **`scan`** `{ hint: string; }`
- **`feel`** `{ kind: 'detent' | 'click' | 'confirm'; }`
- **`changed`** `—`
- **`leave`** `—`

## Events from the screens

- **`go`** `{ hash: string; activity?: string | undefined; session?: string | undefined; kind?: string | undefined; action?: string | undefined; conversation?: string | undefined; prefill?: string | undefined; lane?: string | undefined; }` · Go somewhere (an address), or an action: board, laneSync, chat, sync.
- **`back`** `—`
- **`api`** `{ id: string; method: string; path: string; body?: string | undefined; stream?: boolean | undefined; }`
- **`snack`** `{ id: number; }` · A snackbar's action was tapped.
- **`screen`** `{ native: boolean; }` · A native screen is (or isn't) showing: the page goes see-through.
- **`parts`** `{ [x: string]: boolean; }`
