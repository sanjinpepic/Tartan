# Body signals: how a source feeds them

`src/signals.ts` keeps each day's sleep and recovery signals in one place, whichever watch or app
sent them. Readiness and the morning check, Today on both phones, the Body card and the coach
read only from there. A new source (Garmin's watch app, Suunto's 24/7 API) just writes days into it.

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
- **The coach**: `note_body_signals` keeps a number the athlete said, as `told`.

## For the Garmin feed

The phone side gets the watch's message and calls `signalsPut` with `source: "garmin"`: Body
Battery on waking as `energy`, stress as `stress` (0-100), sleep score as `sleep_score`, recovery
time as `recovery_h`, respiration as `breathing_rate`, resting heart rate as `resting_hr`, VO2 max
as `vo2max`, and the night's times and stages when the watch has them. Send the morning's values
under the morning's date.

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
