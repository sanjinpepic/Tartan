<img src="brand/icon.svg" width="72" alt="Tartan app icon">

# Tartan

**A training coach that works from your own data.** Tartan brings your workouts in from Strava
and from your watch, keeps them on your own device, plans your training around your week, and
hands all of it to LLM agents over MCP. It works with Strava alone, with a watch alone, or both.

*Tartan was called FreeSuunto until October 2026. The Android app updates in place and keeps its
data; agents need the new MCP server name `tartan` (see below).*

## Install (Android)

Get the APK from [the latest release](https://github.com/sanjinpepic/Tartan/releases/latest),
or add this repository to Orion Store or
[Obtainium](https://github.com/ImranR98/Obtainium) and it updates itself from the releases.
Open it and either connect your workouts, or tap **Try it with sample data** to look around
first. Nothing else is needed: no account, and the coach's AI is optional.

With Obtainium: **Add App**, paste `https://github.com/sanjinpepic/Tartan`, **Add**, **Install**.
Every release is signed with the same key; its certificate's SHA-256 fingerprint is
`76:68:3E:E0:40:AE:1F:C9:95:50:7F:9A:77:4F:2B:FC:AC:57:6F:AB:F0:63:A5:E6:86:81:29:B3:2E:D7:03:D4`
(AppVerifier or `apksigner verify --print-certs` shows it). iPhone: see [docs/ios.md](docs/ios.md).

Five ways in, all feeding one local library:

1. **Health Connect** (Android): whatever your watch's app already shares there (Samsung Health,
   the Suunto app, Fitbit, Coros, Polar…), each workout with heart rate, distance and route.
2. **intervals.icu**, with a personal key: Garmin, Suunto, Coros, Polar, Wahoo and Zwift.
3. **From Strava**, which most watches already sync to. This gives your complete history with
   laps, splits, best efforts and full time series (HR, pace, cadence, power, altitude, GPS).
4. **Straight off a Suunto watch over Bluetooth**, with the same protocol the Suunto app uses.
   No Suunto app or account is involved. Tested on a Suunto Run 2.
5. **Files**: share or open a `.fit`, `.gpx` or `.tcx` from any app, or import them in Settings.

Every workout appears **once**: the copies from the watch, from Strava and from any other source
are merged into one activity, each number taken from the best source, with one set of time
series. On top of that library:

- **Dashboards**, each answering its own question in plain words:
  - **Today**, how you are now: readiness (Tired, Building, Balanced, Fresh or Rested), with why and what to do today. Then the last workout's effort for you and its heart-rate mix, and this week day by day against your usual.
  - **Activities**: every workout, searchable, opening into a sheet with the route, pace, heart rate, elevation, zones and splits.
  - **Progress**, how training adds up: totals, weekly distance, fitness over time, consistency, intensity mix, easy-run efficiency, how well your long runs hold (heart-rate drift for the same hill-adjusted pace) and personal bests.
- **Targets**: a weekly distance and number of workouts, a long run, and a race with a target time. Today tracks the week against them. Progress shows how often you hit them and predicts your race time from your best efforts.
- **Record runs on the phone** (Android app): GPS that keeps going with the screen off, heart rate from any Bluetooth heart-rate sensor, pause and resume, then **send to Strava** with one tap. When Strava's copy syncs back, it merges with the phone's, so the run appears once.
- **A coach**: chat with Claude about your training. It reads the merged data through the same
  tools your agents get and shows what it checked.
- **Routes from the coach**: ask for "5 km near home" or "a scenic loop in nature from here" and
  the coach routes it on OpenStreetMap, picks the greenest (or quietest, flattest) of several,
  saves it in Routes and, if you ask, sends it to your watch.
- **An MCP server**, so Claude Code, Claude Desktop, Cursor or any MCP client can query all of it.

It runs on **Android** on its own (native app: watch over Bluetooth, Strava, dashboards and the
coach, all on the phone) and on the **PC** (Bun; browser UI with Web Bluetooth, Linux CLI with
BlueZ, and the MCP server for your agents). The two share one codebase. The phone can also send
its watch backups to the PC over your home network, for the agents there.

> The coach gives training guidance, not medical advice: for pain, illness or anything that
> worries you, see a doctor.
>
> Unofficial and unaffiliated with Suunto, Amer Sports, Garmin, Strava, intervals.icu or Google.
> The Suunto watch protocol was worked out by reverse engineering, for interoperability with your
> own watch, and a firmware update can change it.

## Status

| Part | State |
|---|---|
| **MCP server** (stdio + HTTP) | Tested with real MCP clients (in-memory and Streamable HTTP) against synced data: all 16 tools. |
| **Merging** | Tested: watch + Strava + cloud copies of one workout become one activity; back-to-back runs on the same morning stay separate; ids stay stable as copies arrive. |
| **Dashboards and takeaways** | Tested against seeded data (training load, zones, efficiency, takeaways). |
| **Coach** | Tested against mocks of the Claude API and the Gemini API (streaming, tools, history, Gemini thought signatures, model lists). Needs your own Anthropic or Gemini key to run for real. |
| **Strava sync** | Tested against a mock Strava API. Covers OAuth with token refresh, incremental sync, rate-limit pausing and resuming, and new-activity pickup. **Not yet run against the real Strava API with your app credentials.** |
| **Watch over Bluetooth** | The protocol is ported from [SyncFix](https://git.sr.ht/~eppuh/SyncFix) and [zappctl](https://github.com/wylandplex/zappctl), which verified it on real Vertical 2 and 9 Peak Pro watches. Tartan is tested against a protocol simulator and a mock `bluetoothd`, and **works on a real Suunto Run 2** (owner, November 2026). The filesystem layout is detected automatically. |
| **Workouts from the watch** | Raw files are copied. Where the Run 2 keeps workouts, and in what format, still needs a real backup to map. FIT files are parsed automatically. |
| **Android app** | Runs the whole library, Strava sync, dashboards and coach on the phone. Tested in Chromium in the app's own mode (`bun scripts/phone-e2e.ts`: Strava sign-in round trip, sync, every screen, coach with a mock Claude API, demo-watch backup) and in `test/phone.test.ts`. Not yet run on a real phone with the real Strava and Claude APIs; the native Bluetooth plugin needs a real phone. |
| **Suunto cloud export** | Removed in 2.56 (it used an undocumented endpoint). Workouts it brought in earlier are still read and merged. |

## Quick start (PC)

Requires [Bun](https://bun.sh) 1.2 or newer.

```bash
bun install
bun src/cli.ts serve            # → http://127.0.0.1:5173  (open in Chrome or Edge)
```

Four screens: **Today**, **Coach** (your plan and your coach), **Activities** and **Progress**, plus **Settings** (behind
the gear on a phone), where Strava, the watch and the PC link are connected. There is no Sync
button: new data comes in by itself when the app opens, when you come back to it, and every
half hour while it's open (Strava at most every 15 minutes; in the Android app the paired watch
at most every 3 hours). Settings has **Sync now** for the impatient. On a phone the screens sit
in a bottom bar; on a wide screen in a rail on the left.

### 1. Connect Strava (recommended: the complete history)

1. Create a free API application at <https://www.strava.com/settings/api>.
   Set **Authorization Callback Domain** to `localhost`.
2. In Tartan open **Settings**, paste the Client ID and Client Secret, and click **Connect Strava**.
3. Your workouts start downloading as soon as you're back. Strava allows about 100 requests per
   15 minutes and each activity needs two, so a long history takes several rounds. Tartan
   pauses at the limit and continues on its next automatic sync.

From the terminal instead: `bun src/cli.ts strava-auth`, then `bun src/cli.ts strava-sync`
(cron-friendly).

### 2. Give it to your AI agents (MCP)

**Settings → AI agents** shows ready-to-copy commands with your real paths. For example:

```bash
# Claude Code
claude mcp add freesuunto -- bun /path/to/Tartan/src/cli.ts mcp

# any client that takes a URL, while `serve` is running
claude mcp add --transport http freesuunto http://127.0.0.1:5173/mcp
```

Claude Desktop / Cursor (`claude_desktop_config.json` / `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "freesuunto": { "command": "bun", "args": ["/path/to/Tartan/src/cli.ts", "mcp"] }
  }
}
```

Tools:

| Tool | What it returns |
|---|---|
| `get_overview` | What data exists: athlete, counts, date range, last syncs, watches |
| `get_takeaways` | The few things worth knowing right now, each with its numbers |
| `list_activities` | Workouts newest first, each one once (merged across sources); filter by date, sport, source |
| `get_activity` | One workout: laps, per-km splits, best efforts, which copy each number came from |
| `get_activity_streams` | Time series (HR, pace, cadence, power, altitude, GPS), downsampled to N points |
| `get_training_summary` | Totals per week, month or year: distance, hours, climb, average HR, sport mix |
| `get_training_load` | Fitness, fatigue and form per day, from heart rate (TRIMP) |
| `get_hr_zones` | Time in heart-rate zones for one workout or a period |
| `get_efficiency_trend` | Easy-run metres per heartbeat, week by week |
| `get_durability` | Long runs: heart-rate drift for the same hill-adjusted pace, and the minute the effort stopped holding |
| `get_weather` | The forecast at each planned session (Open-Meteo), with what the heat costs in pace and a cooler hour |
| `get_goals` | Your targets (weekly distance and workouts, long run, a race) and progress, with a predicted race time |
| `get_best_efforts` | Personal bests per distance across all synced runs |
| `get_athlete_profile` | Profile, totals and heart-rate settings |
| `get_week` | One week day by day against the week before |
| `get_training_plan` | The training plan the app shows, each session done (or marked by hand), missed or ahead |
| `save_training_plan` | Write or change that plan (earlier versions are kept) |
| `mark_plan_session` | Tick a session off by hand, or undo it |
| `set_training_availability` | Days and hours a week, long-run day, constraints |
| `get_training_times`, `set_training_times` | When you usually train (weekdays, weekends, a day of its own) and the next sessions at those times |
| `export_training_plan_csv` | The plan as CSV |
| `export_training_plan_ics` | The sessions ahead as a calendar file at your times |
| `reset_training_plan` | Clear the plan (kept as an earlier version; flagged destructive, so clients ask first) |
| `list_routes`, `get_route`, `save_route` | Your routes (points, distance, climb, GPX); save a line, e.g. a workout's track, as a route |
| `list_watch_files`, `read_watch_file` | Files copied off the watch; FIT parsed, text as text |
| `sync_strava` | Pull new activities now |
| `backup_watch` | Copy new files off the watch (Linux with BlueZ) |

It also has two prompts: `training_review`, and `training_plan`, which plans with the same rules as
the in-app coach and saves to the same plan, so an outside agent can coach you too. Ask things like *"How did my long runs develop over the
last two months?"* or *"Compare heart rate drift in my last three tempo runs."*

### 3. Back up the watch over Bluetooth

**In the Android app:** if the watch is already paired with the phone (through the Suunto app),
just tap **Connect watch**. Android keeps the pairing, not the app, so Tartan uses it as is:
no picker, no code, and the Suunto app stays paired. If the Suunto app happens to be syncing,
let it finish first. A watch that was never paired goes through the picker and Android's code
dialog once.

**From a PC browser or the Linux CLI:**

1. Turn the phone's Bluetooth off, or force-stop the Suunto app. The watch talks to one device at a time.
2. Wake the watch and open **Settings → Connectivity**.
3. **Watch → Connect watch**, pick it, and type the 6-digit code it shows the first time.
4. **Back up everything**. Next time only new files are copied.

At least the 9 Peak Pro keeps a single bond, so after pairing Tartan the Suunto app has to
pair again (and vice versa). The demo watch lets you try the whole flow without hardware.

**When something goes wrong with the watch:** Settings → More → Advanced → **Watch recorder** →
**Record the next connection**, let the watch connect once (by hand or by itself), then **Share
recording**. The file has every byte between the phone and the watch, with the activity log
between them. That lets a problem be played back and fixed without the watch:
`bun scripts/replay.ts watch.jsonl` decodes it, `--connect` runs the connection code against
it, and `ReplayLink` (`src/protocol/blackbox.ts`) turns it into a watch for a test. On the
Linux CLI, `--record watch.jsonl` does the same. The recording holds what the watch sent
(workouts, heart rate, routes), so it is shared by hand and never committed.

### 4. Set up the coach (optional)

The coach runs on **your own AI key**, with the provider you pick in **Coach** or **Settings**:

- **Anthropic (Claude)**: a key from <https://console.anthropic.com>. Claude Opus 5.5 by default, or Sonnet 5.5 / Haiku 5.5 for faster, cheaper answers. `ANTHROPIC_API_KEY` in the environment works too.
- **Google (Gemini)**: a Gemini Developer API key from <https://aistudio.google.com>. Gemini 3.8 Flash by default, or Gemini 3.5 Flash-Lite. `GEMINI_API_KEY` or `GOOGLE_API_KEY` in the environment works too.

**Load models** next to the model picker lists the models your key can use, straight from the provider. Usage is billed to your account. Gemini has a free tier that needs no card: it has daily request limits, and Google may use free-tier requests to improve its products.

**On the phone, with Model Hub** (Android app): Model Hub keeps the phone's AI models for all
your apps, so a model such as Gemma 4 E2B is downloaded once, and runs it on the Tensor TPU, GPU
or CPU. In Coach settings choose **Model Hub on this phone**, allow Tartan to use it, and pick a
model in Model Hub. It's free and offline, and it calls the coach's read-only data tools itself.
With a cloud key as well, the cloud model answers when you're online and Model Hub when you're
not (**Keep the chat on the phone** turns that off). Without a key, plans come from Tartan's rules.

**Photos and voice in the chat.** The camera button in the message box sends a photo with your
question (a shoe, a meal, a watch screen, a sore spot), resized on the phone first. Claude and
Gemini get it as an image, and Model Hub through its model's vision part when it has one. The mic lets you say the message instead of typing it. Each has its
own switch in Coach settings (**Photos in the chat**, **Speak to the coach**).

**No AI key?** The Coach tab still makes a plan, by Tartan's own rules (`src/basic-plan.ts`): the same three questions, then about 10% more a week, every fourth week easier, one long run, at most two hard sessions and never back to back, mostly easy running, and a two-week taper that ends with the race. Paces come from what your recent runs say you could race 5 km in, heart-rate ranges from your zones. It is ticked off, sent to the watch and reminded like any plan. It doesn't adjust itself; add a key and the coach can. Keys are stored only on the device you enter them on: on the PC in `data/coach/settings.json` (mode 600), in the app in its private storage. The app calls the provider directly from the phone. A conversation stays on the provider it started with.

- The coach reads your data through the read-only data tools, never sync or backup. Its writes
  are limited to your plan: the plan itself (`save_training_plan`, kept in `data/coach/plan.json`,
  with every earlier version in `data/coach/plans/`), sessions you tell it you did without the
  watch, and the time you have.
- **Coach** tab: your plan and your coach in one place. Without a plan the coach introduces
  itself with what it already sees in your data and asks three quick things (days a week, hours
  a week, long-run day), plus an optional target date in your own words ("14 March", "end of
  June"; your race day is filled in). The coach reads the date and plans up to that week (at most 26 weeks); without
  one, the plan is 8 weeks. Tap **Make my plan** and the coach works out your paces and
  heart-rate ranges from your data (shown on the tab), then builds the plan from your targets
  and recent training: at most 10% more a week, an easier week every 3-4, about 80% easy, a
  taper before a race. With a plan, the tab shows **This week** day by day or the **Whole plan**
  as one row per week (focus, volume bar, a dot per day ticked when done; tap for the days).
  **Ask your coach** at the bottom opens the conversation, which is also how the plan changes
  (extend it, move sessions, a busy week); **Ask** on a session starts a message about it. Each
  session is ticked off against your workouts (done, missed, today, rest); runs nobody planned
  show as extras. Forgot the watch? **Mark done** ticks a session off by hand (kept in
  `data/coach/plan-marks.json`, so it survives plan rewrites). **Today** leads with today's
  planned session. **Settings → Training** exports the plan as CSV or resets it.
- **Strength sessions** show a 3D body with the muscles the session works, then each exercise:
  tap one and the body moves through it (drag to turn it round), with sets and reps and three
  form cues. 32 exercises: a runner's bodyweight basics and the gym classics with their kit
  (back squat, deadlift, bench press, overhead press, rows, pull-ups, curls, hip thrusts,
  kettlebell swings…); the coach uses the loaded ones only if you have the equipment. A man or a
  woman in gym clothes shows them (Settings → Training); a worked muscle under the clothes shows
  as the fabric dyed in the accent. The bodies come from MakeHuman's CC0 assets
  (`scripts/build-body.py`), with shading and floor shadows baked in Blender (`scripts/blender/`).
- **Progress → Week**: one week day by day (distance or time, load, zones, sports, workouts)
  against the week before, stepping back with the arrows; the week's plan is linked when there is one.
- Conversations are kept in `data/coach/conversations/` and can be continued later.
- The coach **remembers** what matters across conversations (an old injury, when you can train,
  what worked): short notes in `data/coach/memory.json` it adds, edits and forgets itself, shown in
  **Settings → Coach** where you can remove any. With the app linked to the PC the notes are merged
  both ways, so the app's coach, the PC's and any MCP agent (`get_memory`, `remember`) share them.
- With Opus and Sonnet, a request the model declines is retried on a fallback model server-side
  instead of failing.

### Routes

The **Routes** tab: draw a route on a map in the app's colours (OpenStreetMap data via
OpenFreeMap). Tap to place points; the line follows footpaths, tracks and streets (the
openstreetmap.org walking router), or goes straight where you choose **Straight**. Distance, a
dot every kilometre, climb and an elevation profile (Open-Meteo heights) update as you draw.
Along paths, a tap or a dropped point near a path lands on it, so you needn't hit it exactly.
A blue dot shows where you are; tap it to start (or add a point) right there.
With nothing drawn yet, **Or a loop from here** offers 5, 10, 15 or 21 km: three loops along paths
from where you are, on the map in three colours; tap one and it's your route.
**Race pace** works out even-effort splits for a target time over the course's hills (slower up,
quicker down) and sends the course with a named point at every km ("5k 24:10") and a pacing
workout that guides each km at its pace.
Drag a point to move it, tap it to take it out, tap the start to close the loop; **Undo**,
**Back to start**, **Out and back** and **Reverse** do what they say. Routes are saved as files
in `data/routes/`, and GPX files import too.

**Send to watch** puts the route straight on the watch over Bluetooth, the way the Suunto app
does (the Suunto Run 2; it appears under Navigation → Routes, and the list marks it "On your
watch"). Before writing anything Tartan checks that the watch describes routes exactly as it
expects, and it writes nothing if not. The GPX button shares the route as a file instead, for the
Suunto app or anything else.

### Weather

Today's session card (or, on a rest day, the next session's line) gives the forecast at the
session's time where you run: the temperature, and in the heat the dew point and what it costs.
Heat is judged the way runners do, as temperature plus dew point in °F: past about 130 it says
how much slower the same effort will be ("about 3–4.5% slower; go by effort, not pace"), offers a
cooler hour that day, and past 180 it advises against hard running. The coach and agents get the
same with `get_weather`, and the long-run durability summary says when heat explains the drift.
The weather comes from [Open-Meteo](https://open-meteo.com) (free, no key). The place is where
your latest GPS workout started, rounded to about a kilometre, so no location permission is needed.

### Morning check

Today's readiness card asks two things each morning: how you slept and how your legs feel. With
your training load it says whether you're ready, should go easy or rest, and on a bad day with a
hard session planned it offers to swap it for an easy run (undoable). The swap is what the coach
sees and what goes to your watch.

### Body: heart rate, sleep and blood oxygen

Each time the phone app connects to a Suunto Run 2 it reads the watch's 10-minute log (heart
rate while worn, blood oxygen when the watch measured it, steps and active energy) and keeps what
is new. The watch only holds about a day of it, so open Tartan daily. Today's **Body** card
shows your resting heart rate (lowest still half hour) against your usual, last night's rest
(estimated from heart rate and stillness, as the watch's own sleep stages can't be read yet), the
latest blood-oxygen reading, steps and today's heart rate. A resting heart rate 7 or more bpm
above your usual counts against readiness. The coach and MCP agents get it as `get_health`. The
demo watch carries a day of it.

### Health Connect (Android)

Settings → Sources → **Health Connect** shares Tartan's data with Android's Health Connect, so
Google Fit and any app that reads it see it, and brings sleep back. Four switches: **workouts**
(each with its heart rate, distance and route; one another app already wrote there, such as the
Suunto app or Strava, is skipped), **heart rate and blood oxygen** (the watch's 10-minute log and
a daily resting heart rate), **steps and active calories** (leave off if the Suunto app already
shares steps), and **sleep and HRV from other apps** (shown on Today's Body card instead of the
estimate). It shares the last 30 days when connected, then what's new after each sync. "Stop
sharing" can also remove everything Tartan wrote. The plan's coming week goes to Health Connect
(for Samsung, Pixel and other watch apps) when you pick it in **Settings → Sources → Plan on your
watch**. The app needs Android 8 or newer.

### Workouts on the watch

On the Coach tab, **Send** (on the "On your watch" line above the weeks) sends the next seven days'
sessions, any sport, to the Suunto Run 2 as guided workouts, and each session on the watch is
marked "On your watch" in the plan. It works the way the Suunto app's
workout planner does: warm-up, the intervals as repeats, recoveries and cool-down, each with the
target to hold (heart rate, pace, speed or power, when it has one) and the time or distance
left. A steady session goes
as one step. Start one from the sport mode you're doing. Sending
again takes off workouts whose day has passed or whose session the coach changed; workouts from
the Suunto app are never touched. On the watch they're named for the day and the session, e.g.
"Wed 6 x 800 m".


After a session, **How it went** on the Coach tab lays the plan over what you recorded: each
step with its target, what you did and whether it was on target, too fast or too slow ("5 of 6
reps on target; rep 6 8 s/km slow"). The coach reads the same before it changes your plan.

**Your week on a face** (Settings → Watch, with the drink and gel reminders) draws the week on a face you pick: a dot per day, today's
session and the week's km filling the rim. The watch can't switch faces by itself, so after an
update you pick Tartan Week again on the watch.
### When something comes up

On the Coach tab, **Change plan** (beside This week and Whole plan) changes the plan in one tap,
with no chat and no AI key, by fixed rules. It goes in at once, listed with **Undo** like any
other change:

- **I'm ill:** rest today and the next two days. The button then reads **Feeling better?**
- **Better now / I was ill:** easy running for a while, picked by how long you were ill. A few
  days gives three easy days. About a week gives seven, half length for the first three. Longer
  gives two weeks, the first at half. The long run is capped, and sessions the ill days put aside
  come back first.
- **I'm away:** this week, next week or two weeks. Either no training (with two easy days after a
  week or more away), or easy runs only.
- **Busy week:** the rest of this week shorter. Easy runs drop to about 60% and the long run to
  75%, and hard sessions stay.

Races are never touched. The coach's memory gets a note ("Ill for 3 days…"), so a chat later
knows.

### The plan on other watches

The same guided workouts go to other watches too. Pick where the plan goes in **Settings →
Sources → Plan on your watch**; the Coach tab then shows one line ("On your watch: 3 of 5") with
**Send**:

- **Garmin and others, through intervals.icu.** With intervals.icu connected (Settings → Sources),
  **Send** puts the coming seven days there as planned workouts, and intervals.icu passes them on
  to the watch accounts you link there (Garmin Connect, for one). It stays up to date by itself.
- **Samsung, Pixel and others, through Health Connect.** The coming week as Health Connect planned
  workouts, for watch apps that read them (needs a recent Health Connect).
- **Any watch, as .fit workout files.** The week (a zip) or one session (its sheet → **Save as a
  .fit workout**), to open in your watch's app; on a Garmin over USB they go in `GARMIN/NewFiles`.

Apple Watch takes workouts only from an iPhone, so it isn't here.

### Watch faces

**Settings → More → Advanced → Watch face builder** lists your faces: Tartan's own **Tartan Track** (AMOLED black, everything in
tartan red, the minutes on a track with a finish line at 12) and the ones you make. **Design a
face** opens the face builder: start from one of 19 designs, each its own look (Tartan Track,
Signal Red, Plaid, Chequered Flag, Heart Zones, Podium, Racing Stripes, Trail, Lane Eight, Day
and Night, Target, Paper, Big T, Minimal, Night Run, Ice, Racing Green, Marathon, Dawn) or
**Surprise me**, then choose the background (black, a colour, a gradient, a tartan plaid or your
photo) and a pattern over it (sunburst, racing stripes, split, rings, heart-rate zones, contours,
chequered, lanes, halftone, a big T), the track (lanes, filled, one ring, dashes, a bezel with
the minutes, none) and finish line, the marks and their shape, numerals (12 and 9, XII and IX,
or one big 12), the T or your own text, the hands (classic, slim, baton, sword, arrow, skeleton,
dauphine, block, pencil), the seconds hand and caps, and the colour of every part
and of the seven seconds hands the watch lets you choose from. The preview ticks live and shows
the watch's own data where the watch will draw it: the compass, the battery, the day, and two
spots you fill on the watch (one of 12 kinds of data at lower left, heart rate to start; one of 5
at the right, steps to start). **Install on watch** draws the face on the phone and installs it
over Bluetooth the way the Suunto app does (Suunto Run 2), after checking that the watch
describes faces as Tartan expects; **Package (.zip)** saves it instead. Agents can list and
design faces too (`list_watch_faces`, `save_watch_face`).


**Check the watch** (in the face builder's list) lists the Tartan faces on your watch, each with
**Remove**, which takes it off the way Uninstall does in the Suunto app (Tartan's faces don't
show up there). Tartan only ever removes faces it made.
### Training times, reminders and your calendar

**Settings → Training → Training times**: when you usually train, say weekdays 18:00 after work
and weekends 09:00 (quick picks: before work, lunch, after work, evening), and a different time
for any day you like. Every session in your plan gets that time. In the Android app:

- **Remind me**: a notification 15 minutes to 2 hours before each session, with what's planned.
  Tap it to open Today. Reminders are set 30 days ahead and redone whenever the plan, the times
  or what's done changes; a session you've already done loses its reminder.
- **Add to my calendar**: every session ahead as an event in a calendar you pick (Google,
  Samsung, any calendar on the phone that takes events), at your time and for its length. They
  move or go when the plan changes; past ones stay as a record. Turning it off takes the future
  ones out.

The intro asks for these times too, and offers reminders there (that's when Android asks to
allow notifications; Bluetooth, location and calendar are asked the first time you use them).

Anywhere, **Calendar file (.ics)** downloads the sessions ahead for Google Calendar, Outlook or
Apple Calendar; importing it again updates them instead of adding them twice. The coach sets the
times too when you tell it ("I run after work, around 18:00").

### Workouts from any watch or app

**Settings → Sources → Workout files → Import .fit files** takes FIT files exported from Garmin
Connect (⋯ → Export Original, then unzip), Coros, Polar, Wahoo, Zwift or a bike computer. They
are kept under `watches/Imported-files/` like files copied off a watch, so a workout Strava also
has merges into one, with the file's own time series. Importing the same file again does
nothing. Imported workouts are never sent to Strava by the switch below.

### Send watch workouts to Strava (optional)

For a watch that doesn't reach Strava through the Suunto app: **Settings → Sources → Send watch
workouts to Strava**. It runs right after a watch sync saves new workouts (never on a timer) and
uploads only workouts that started after you turned it on and that Strava doesn't have, checked
against a fresh Strava sync just before. Each workout has a stable upload id, so a retry never
makes a second copy; anything that fails is tried again after the next watch sync. Leave it off
if the Suunto app already sends your workouts to Strava. Needs Strava's upload permission
(**Allow uploads** on the Strava card).

## One workout, once

Your watch syncs every run to Strava, and Tartan can also copy it straight off the watch, so
most workouts arrive two or three times. They are merged when they overlap in time by at least
half, are the same kind of sport, and their distances agree within 12%. The merged activity takes:

- **measurements** (distance, time, heart rate, climb, laps, streams) from the watch file first,
  then Strava, then the phone, then an old Suunto cloud export;
- **name and sport** from Strava first (that's where you edit them);
- **one** set of time series, never a blend, so no data point is counted twice.

Each activity keeps a list of its copies and which one every number came from (the workout
sheet shows it). Merged ids are remembered in `data/activity-links.json`, so a workout keeps its
id when a new copy arrives later.

## Heart-rate settings

Zones and training load use your max and resting heart rate. Max defaults to the highest value
seen in the last year; set both in **Settings → Heart rate**. Zones are % of max (Z1 50-60,
Z2 60-70, Z3 70-80, Z4 80-90, Z5 90+). Load is Banister TRIMP; fitness is its 42-day average,
fatigue its 7-day average, form the difference.

## Android app

The UI is packaged as a native Android app with [Capacitor](https://capacitorjs.com), and the
app runs Tartan itself: the same library, merging, Strava sync, analytics and coach code as
the PC (`src/`), on the app's private storage instead of `data/`, with the screens calling it
in-process (`web/local-api.ts`). It needs no PC.

- **Watch:** native Bluetooth, reusing the phone's existing pairing (see above).
- **Strava:** the same API application and the same callback domain (`localhost`). Connecting
  opens Strava's sign-in in a browser tab over the app: it shows the address, has a close
  button, and its menu can open it in Chrome. Settings also shows the link with a Copy
  button for any browser on the phone. Strava then returns to the app through a
  `freesuunto://localhost` link. (Not the Strava app: it opens its home screen, not the consent.)
  Strava calls go through Android's HTTP stack, since Strava's API doesn't allow browser calls.
- **Coach:** your key, stored in the app, sent only to Anthropic.
- **Recording:** Today → **Record**. Location runs through a foreground service, so recording continues with the screen off, and Android shows a notification while it does. **Connect heart rate** pairs any Bluetooth heart-rate sensor, like a chest strap or a watch that shares its heart rate. Runs are saved every 10 seconds; one left unfinished (the app closed or crashed) comes back paused on the next start.
- **Guided runs, no watch needed:** with a run on the plan today, Record talks you through it as you go: each step as it starts ("Rep 2 of 6. 800 metres at 3 50 to 4 00 a kilometre. Go."), 10 seconds or 100 metres before the next one, halfway on long steps, and now and then a word when you're off the target pace or heart rate. The screen shows the step, what's left and what's next, with **Next step** to move on early. Steps go to Strava as laps. Switch it off for a run on Record ("Guide me through…"); **Voice cues** silences the voice. Kilometre cues pause while a structured session runs, and come back after it. **Send to Strava** uploads a TCX file. That needs Strava's upload permission: if you connected before uploads existed, tap **Allow uploads** in Settings once.

**Get the APK:** debug builds are committed on the `apk` branch under `releases/`. Open the file
on GitHub in the phone's browser (not the GitHub app, which shows it as text) and tap
**Download raw file**, or build it yourself.

**Build it yourself** (Android Studio or the Android SDK plus JDK 21):

```bash
bun install
bun run android:build      # → android/app/build/outputs/apk/owner/debug/app-owner-debug.apk
bun run android:build:public   # the public build (foss flavour, app.tartan; signed when android/keystore.properties exists)
# or: bun run android:sync && bun run android:open   (then Run in Android Studio)
```

**Phone and PC as one** (optional), end to end encrypted:

1. On the PC run `bun src/cli.ts serve --lan`, open it at `http://localhost:5173` (not the network
   address: browsers warn about plain http there), **Settings → More → Phone app → Pair a phone**. It shows a QR code, the address and a
   10-character code (good for 10 minutes).
2. In Tartan on the phone choose **I use Tartan on my PC** at first start (later: **Settings → More
   → Your PC**, or the card on Today) and tap **Scan the code on your PC**, or type the address and
   code. (Scan with Tartan itself, not the camera app: the camera would open the PC's address in a
   browser, which warns about plain http.) Phone and PC on the same Wi-Fi; on Windows allow Bun
   through the firewall for private networks when it asks.
3. The two bring each other to the latest, like a sync: what one has goes to the other, the newer
   copy wins, a fresh install never overwrites a full history (caches and Strava's sign-in stay
   per device). After that the plan, lifts and check-ins keep in step on every sync, and
   everything else every few hours or on **Sync now**.

Pairing is an ECDH key exchange tied to the code; afterwards every request between phone and PC is
one AES-256-GCM sealed message (`src/link.ts`), so nothing travels in the clear on the network:
not your data, health, keys or the coach's API key. Each message is fresh and taken once (no
replays, even across a PC restart), each answer is bound to its request, and the phone pairs only
with an address on your own network, asking first when a link opened it. In LAN mode the PC's
plain API still answers only the PC itself (and only under its own names, which stops DNS
rebinding); the phone goes through the sealed link. The data folder is owner-only (0700), and the
app opts out of Android's cloud backup and device transfer: its own encrypted backup is the way
to move, and it leaves the link keys out.

## Linux CLI

```bash
bun src/cli.ts pair                 # one time: type the code shown on the watch
bun src/cli.ts info                 # what the watch reports + its top-level folders
bun src/cli.ts ls /                 # list a folder on the watch
bun src/cli.ts get /path/file       # download one file
bun src/cli.ts backup               # copy everything new (--force re-downloads)
bun src/cli.ts strava-auth          # connect Strava (opens a local callback)
bun src/cli.ts strava-sync          # pull new activities with detail + streams
bun src/cli.ts mcp                  # MCP server on stdio
bun src/cli.ts serve [--lan]        # web UI + MCP over HTTP
bun src/cli.ts forget               # remove the bond before going back to the Suunto app
```

`--needle "Run 2"` picks a watch by name, `--data <dir>` moves the data folder, and `-v` shows
protocol traffic. A cron line such as
`*/30 * * * * cd ~/Tartan && bun src/cli.ts strava-sync` keeps the library fresh for your agents.

## Where the data lives

Everything is plain files in `data/` (or `$FREESUUNTO_DATA`). The Android app keeps the same
layout under `Tartan/` in its private storage:

```
data/
  strava/index.json              every activity summary
  strava/activities/<id>.json    full detail: laps, splits, best efforts
  strava/streams/<id>.json       time series
  strava/config.json, tokens.json   your API app + OAuth tokens (mode 600)
  watches/<watch>/files/…        raw files copied off the watch
  watches/<watch>/files/daily/trends/<ms>.json   the watch's 10-minute health log, as read
  health/connect.json            sleep and HRV read from Health Connect
  cloud/…                        the old Suunto cloud export (until 2.56; still read)
  events.jsonl                   sync log (watch backups, Strava syncs, agent reads)
  activity-links.json            which copies were merged into which workout
  profile.json                   heart-rate settings
  settings/schedule.json         training times, reminders, calendar
  routes/<id>.json               routes: points, lines, heights
  faces/<id>.json                watch faces from the face builder
  coach/settings.json            API key + model (mode 600)
  coach/conversations/<id>.json  coach chats
  link/devices.json              phones paired with this PC, their link keys (mode 600)
```

## How the watch protocol works

The watch exposes GATT service `61353090-8231-49cc-b57a-886370740041` carrying Suunto's
"whiteboard" protocol:

```
on the air:  7E | escape(frame) | 7E                 (7E → 7D 5E, 7D → 7D 5D)
frame:       A5 | type | LE16 len | LE16 requestId | body | LE32 CRC-32
GET body:    resource[3] | client[3] | paramCount | (LE16 typeId | value)…
reply body:  resource[3] | client[3] | LE16 status (200 OK, 100 more, 404…) | value
```

A session replays the official app's read-only connect handshake, then lists folders (JSON)
and reads files in chunks. Tartan only ever sends HELLO, resolve and GET frames, and a test
enforces that. Full notes:
[zappctl docs/PROTOCOL.md](https://github.com/wylandplex/zappctl/blob/main/docs/PROTOCOL.md).

## Project layout

```
src/protocol/       codec, captured handshake, WatchSession, mirror
src/transport/      bluez.ts (Linux), web-bluetooth.ts (browsers), capacitor-ble.ts (Android)
src/strava/         OAuth client, incremental sync
src/merge.ts        matching copies of one workout across sources
src/library.ts      the merged library: every workout once (what MCP and the UI read)
src/analytics.ts    training load, zones, efficiency, takeaways
src/tools.ts        the data tools shared by MCP and the coach
src/mcp.ts          MCP server
src/coach.ts        the coach (Claude API, streaming, tools)
src/fit.ts          FIT decoder
src/disk.ts         storage interface (disk-node.ts on the PC, web/disk-capacitor.ts in the app)
src/api.ts          the /api routes as a plain Request → Response handler (PC server and app)
src/server.ts       web app, serves src/api.ts, /mcp, LAN mode
src/cli.ts          command line
src/sim/            protocol simulator (tests + demo mode)
web/                the UI (shared by browser and Android app): views/, lib/charts.ts (SVG charts),
                    local-api.ts (the app running Tartan in-process)
android/            Capacitor Android project
```

## Development

```bash
bun test               # protocol, BlueZ, Strava mock, merging, analytics, MCP clients, coach (mock API), FIT
bun run typecheck
bun run dev            # web UI with hot reload
```

`bun scripts/phone-e2e.ts [dir]` drives the app's own mode in Chromium end to end against mock
Strava and Claude APIs, optionally saving screenshots. To click through it yourself, serve the
production bundle (`NODE_ENV=production bun src/cli.ts serve`) and open
`http://127.0.0.1:5173/?device-storage`. The dev server's bundler can't load the Anthropic SDK,
which only the app's own mode imports.

The UI was designed with the [impeccable](https://github.com/pbakaus/impeccable) and
[taste-skill](https://github.com/Leonxlnx/taste-skill) agent skills (not part of this
repository). Product context is in [PRODUCT.md](PRODUCT.md) and the visual system in
[DESIGN.md](DESIGN.md).

## Translating

Tartan is English only for now, and ready to be translated. The phone app's words (every native
screen, the widget, notifications and the run's Live Update) are in
`android/app/src/main/res/values/strings.xml`; a translation goes in a `values-<language>/strings.xml`
beside it (`values-de`, `values-fi`, `values-pt-rBR`), F-Droid and Weblate style. Keep each
`%1$s` and `%2$d`: they are where a name or a number goes, and may move within the sentence. A
`<plurals>` entry has one form per count (`one`, `other`, and whatever more your language needs).
Leave strings marked `translatable="false"` alone.

Not yet translatable: the words that come from Tartan's engine (TypeScript in `src/` and `web/`):
the coach's prompts and replies, takeaways, plan and session names, error messages from syncing,
and the PC's web app. They are still English in the code.

## Contributing

Issues and pull requests are welcome at
[github.com/sanjinpepic/Tartan](https://github.com/sanjinpepic/Tartan). Before a pull request:
`bun run typecheck`, `bun test` and `bun run check:public`; for the Android screens also
`cd android && ./gradlew testOwnerDebugUnitTest` (screenshots land in
`android/app/build/shots/`). [HANDOVER.md](HANDOVER.md) and
[docs/architecture.md](docs/architecture.md) explain how it fits together. In the app, Settings
→ More → Send feedback opens an issue here with the app's log attached if you choose.

## Credits and license

- Watch protocol: **SyncFix** by ~eppuh (0BSD) and **zappctl** (0BSD). The captured handshake
  in `src/protocol/captured.ts` comes from SyncFix; see `vendor/SyncFix-LICENSE`.
- Barlow Condensed font: SIL Open Font License (`web/fonts/OFL.txt`).
- 2D muscle map outlines: **MuscleMap** by Melih Colpan (MIT), converted by
  `scripts/build-musclemap.py` into `web/lib/musclemap-paths.ts` (and by `scripts/musclemap-asset.ts`
  into the Android app's `res/raw/musclemap.json`); see `vendor/MuscleMap-LICENSE`.
- 3D bodies: MakeHuman's base mesh, skeleton, weights and targets (CC0).
Tartan is free software under the [GNU General Public License v3.0 or later](LICENSE): use it,
change it and share it, and anything you share that's built on it stays under the same licence.
Suunto, Garmin and Strava are trademarks of their owners, used only to describe compatibility.

Nothing taken from Suunto's own software is in this repository: Tartan sends its own clean-room
workout runner (`src/workout/runner.ts`, from `docs/cleanroom/workout-runner-spec.md`) and writes
its own watch-face layout. `bun run check:public` (also in CI) keeps it that way.
