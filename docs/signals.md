# Body signals: how a source feeds them

`src/signals.ts` keeps each day's sleep and recovery signals in one place, whichever watch or app
sent them. Readiness and the morning check, Today on both phones, the Body card and the coach
read only from there. A new source (Suunto's 24/7 API, say) just writes days into it, as
Garmin's watch app does.

## Writing a day

One call, from any source: the engine's `signalsPut` (native shells, `web/lib/contract.ts`), or
`PUT /api/signals` (the PC, the page). Both take a list of days:

```json
{ "days": [{ "date": "2026-11-23", "source": "garmin", "energy": 64, "resting_hr": 48, "sleep_min": 431, "deep_min": 72 }], "replace": false }
```

- `date` is the morning the day belongs to (`YYYY-MM-DD`, local): the night that ended that
  morning, its HRV and lowest heart rate, the resting heart rate and the energy on waking.
- `source` is one of `garmin`, `suunto`, `health_connect`, `apple_health`, `sample`, `told`.
- Send only what the source measured. A field left out stays as that source sent it before;
  `null` clears it; `"replace": true` makes the list the source's whole day (for a feed that works
  days out afresh). Values of the wrong kind or out of range are dropped and listed in `dropped`.
- Sending the same values again changes nothing (and writes nothing), so a feed can resend.

The fields, their units and ranges are documented on `SignalValues` in `src/signals.ts`. In short:
sleep start and end (local `YYYY-MM-DDTHH:MM`), minutes asleep, deep, light, REM, awake, latency,
naps; sleep score 0-100; overnight lowest and average heart rate, HRV as RMSSD in ms (not SDNN),
highest SpO2 %, breathing rate a minute; resting heart rate; energy 0-100; stress 0-100 or a
level (`low`, `medium`, `high`); recovery hours still to go; VO2 max (running).

## How days merge

Each source keeps its own record per day. Reading merges them field by field, best first: `told`
(the athlete said it), the connected watch's brand (the watch that reported last), the other watch
brand, the phone's health store, the sample. The night (start, end, the minutes and stages) comes
whole from one source, and a tracked night always beats one estimated from heart rate and
stillness (`sleep_estimated`, the Suunto log's). Every merged value keeps its source in `from`.
The usual (`usualBefore`) is the median of the 28 days before, once three days have a value.
Kept in `health/signals.json`, about a year.

## The feeds today

- **Health Connect** (Android): the page sends sleep sessions and HRV to
  `/api/health-connect/in`, which keeps them and writes the days they touch as `health_connect`
  (`hcSignalDays`).
- **The Suunto's own log** (over Bluetooth): resting heart rate and the estimated night, written as
  `suunto` whenever the body is read (`watchLogDays`, `Health.feed`).
- **The sample** (the demo): two weeks as `sample`, with a rough night and a low-energy morning.
- **Tartan's Garmin watch app**: the day's Body Battery on waking, stress, night, recovery, resting
  heart rate and VO2 max, as `garmin` (below).
- **The coach**: `note_body_signals` keeps a number the athlete said, as `told`.

## The Garmin feed

Tartan's Garmin watch app reads the day's numbers on the watch (`garmin/source/Body.mc`, every 30
minutes from a background service, when the app opens and when the phone asks) and sends
`{ t: "day", v: 1, days: [...] }` with SignalValues' own names. The phone (`GarminLink` on Android,
`GarminLink.swift` on iPhone) checks it (`GarminMessage.signalDays`: only the fields below, numbers
in their ranges, a date from two days ago to tomorrow) and calls `signalsPut` with source
`garmin`, only while the watch is a Garmin (the brand the engine keeps; a Suunto never takes
Garmin's numbers). Without `replace`: a field the watch hasn't got yet stays as it was.

- `energy`: Body Battery on waking (its peak from bedtime to 3 hours after the usual wake time).
- `stress`: the day's average stress so far, 0-100 (yesterday's over the whole day).
- `night_hr_min`, `spo2_max`: the lowest heart rate and highest blood oxygen in the night.
- `breathing_rate`: the night's readings averaged.
- `recovery_h`: recovery time in the morning (whole hours), `resting_hr`: the day's resting heart
  rate, `vo2max`: running VO2 max.

The date is the morning's. Not from Garmin: sleep stages, HRV, sleep times (Connect IQ doesn't
give them) and the sleep score (a watch app can't read it). Those come from Health Connect or
Apple Health, and the night stays theirs. docs/garmin.md has the watch side, which watches send
what, and the gap: a message that comes while Tartan is closed on the phone is lost, so the watch
resends within 2 hours and the phone asks for the day whenever Tartan opens.
`test/fixtures/garmin-day.json` is a message and what reaches `signalsPut` (read by
`test/garmin-signals.test.ts` and Android's `GarminTest`).

## For the Suunto 24/7 feed (not built yet)

A mapping from Suunto's public API names, for when access comes: Sleep `BedtimeStart` /
`BedtimeEnd` → `sleep_start` / `sleep_end`; `Duration` → `sleep_min` (asleep minutes);
`DeepSleepDuration`, `LightSleepDuration`, `REMSleepDuration` → `deep_min`, `light_min`, `rem_min`;
`WakeAfterSleepOnsetDuration` → `awake_min`; `SleepOnsetLatencyDuration` → `latency_min`;
`SleepQualityScore` → `sleep_score`; `AvgHRV` → `hrv_ms`; `HRAvg` / `HRMin` → `night_hr_avg` /
`night_hr_min`; `MaxSpo2` → `spo2_max`; a sleep with `IsNap` adds to `nap_min` instead. Recovery
`Balance` (Resources) on waking → `energy`; `StressState` → `stress_level`. Durations in seconds
become minutes. Source `suunto`.

## Not yet

Apple Health on iPhone reads workouts only: its sleep, resting heart rate, breathing rate and VO2
max could come in as `apple_health` the way Health Connect's do (its HRV is SDNN, not RMSSD, so it
doesn't go in `hrv_ms`).
