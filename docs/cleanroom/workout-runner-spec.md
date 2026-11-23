# Workout runner: behaviour spec (clean-room)

This file describes what the step runner of a Suunto "sequence" workout guide has to do. It was
written from observed behaviour and the interface the watch offers, so that a new runner can be
written without the original. It holds no code. The runner written from it lives in
`src/workout/runner.ts`. Whoever writes that file works from this spec and from the public
SuuntoPlus reference only.

## The package it runs in

A workout guide is a zip that Tartan already writes (`src/workout/guide.ts`, everything except
the runner). It holds `manifest.jsn` (`"type":"sequence"`, `"usage":"workout"`), an empty
`icon.pxb`, the runner `main.js`, and `step0.js`, `step1.js`, … Each step file is one JSON object.
The runner reads the step files one at a time while the workout runs.

**Step objects** (all fields optional unless stated):

- `type`:
  - `1`: a screen between parts;
  - `2`: a repeat marker;
  - absent: the part you run.
- `view`: what the step shows, as an object `{ title?, text?, field? }` or an array of such
  objects. Every step except a repeat marker has one. What the runner does with a step that
  has no view is left open: Tartan never writes one.
- `target`: an array of targets for the watch (heart rate, pace, a step distance/duration with
  `onReach`, a manual lap). The runner never reads it; it hands it to the watch.
- `lap`: present (e.g. `{ "hidden": true }`) when entering this step should start a new lap.
- `endOnLap`: `true` when pressing the lap button ends this step.
- `count` (type 2): how many times to run the steps that follow it.
- `next` (type 2): how many steps after it make up the repeated part.
- `phase`: for the watch; the runner ignores it.

## Language and form

- ES5 only: `var` and `function`, no arrow functions, `let`/`const`, classes, template strings,
  `Date` or modules. Keep it small, ideally under 1.5 KB; the watch has little memory.
- The file is evaluated as the body of a function. Its last statement must be
  `return <handler>`, where the handler is `function (event, input, data)`.
- The first line is a comment with the number 20613 (`// 20613`). The firmware may read it.
  Keep it.

## The watch's functions the runner uses (interface facts)

- `evalFile(path)`: loads and evaluates a file from the guide's folder. Paths start with the
  placeholder `{file_path}`, e.g. `'{file_path}/step3.js'`. Before reassigning the variable that
  holds the current step, set it to `undefined`, so memory is freed (public reference: evalFile).
- `initStep()` with no arguments: ends whatever step the watch is running.
- `initStep(type, target)`: starts a step on the watch with the step's `type` and `target`
  (pass them through, even when undefined).
- `open(name, true, 1, params)`: opens a popup view. The runner uses the view named `'z-popup'`
  with params `{ TITLE: <string>, TEXT: <string> }`.
- `close(name)`: closes a view. The lap view is named `'ex-lap'`.
- `unload('_cm')`: unloads the guide's own view page (public reference: unload, `_cm`).
- `playIndication('Interval')`: the interval sound/vibration (public reference).
- `$.put('Activity/Trigger', 0)`: takes a lap (public reference).
- The global variable `zPopupShown`: the runner sets it to `0` at start and to `1` when it opens
  the popup.

## Events the handler gets (first argument)

| Event | Meaning | What the runner does |
|---|---|---|
| `128` | The workout (exercise) starts | Reset (see below) |
| `1` | A tick (about once a second) | Count the guards down; on the very first tick, start the first step |
| `16384` | The watch says the current step's target was reached (distance/time) | Go to the next step |
| `4` | A lap happened (the user pressed lap, or the runner's own lap came back) | See below |
| `4096` | The watch asks what the current step shows | Return the view (see below); for every other event return nothing |

## State

- **Index:** the current step number, `-1` before the first step.
- **Current step:** the loaded step object.
- **Repeat bookkeeping:**
  - repeats left (0 when not in a repeat);
  - the index where the repeated part starts;
  - the index just after it ends.
- **Own laps pending:** how many laps the runner triggered itself that haven't come back as
  event 4 yet.
- **Three guards**, each a small countdown in ticks:
  - **lap guard:** stops two laps close together;
  - **popup guard:** stops two popups close together;
  - **beep guard:** stops two beeps close together.

  A guard is "clear" at 0. Setting one means setting it to 3.

## Behaviour

**Reset (event 128):** set the lap guard (3), own laps pending to 0, `zPopupShown` to 0, and the
index to -1. Nothing else.

**Tick (event 1):** decrement each guard that is above 0. Then, if the index is -1, go to the
next step (which is step 0).

**Target reached (event 16384):** go to the next step.

**Lap (event 4):**
1. Set the lap guard (3).
2. If own laps are pending, count one off. That lap was the runner's own, so do nothing else.
3. Otherwise, if there is a current step and it has `endOnLap`, go to the next step.

**View query (event 4096):** if there is a current step, and it is not a type-1 screen without
both title and text (a type-1 step counts only when its view has a title or a text), return
its view. Return it as is if it's an array (it has a `length`), else wrap it in a one-element
array. Otherwise return nothing.

**Go to the next step:** the target index is index + 1. When that isn't a number, or is 0, use 0.
Then enter that index:

1. If there is a current step and it has `endOnLap`, close the lap view (`close('ex-lap')`).
2. End the watch's current step: `initStep()` with no arguments.
3. Set the index to the target.
   - If repeats are left (> 0) and the index equals the end of the repeated part, count one
     repeat off.
   - If that leaves 0, stay at the index (carry on after the repeat).
   - Otherwise jump back to the start of the repeated part.
4. Load the step at the index.
5. If it's a repeat marker (type 2):
   - the repeated part starts at index + 1 and ends at that start + `next`;
   - repeats left = `count`;
   - move the index on by one and load that step instead.
6. If the step has `lap`, and the lap guard is clear:
   - set the lap guard;
   - add one own lap pending;
   - take a lap: `$.put('Activity/Trigger', 0)`.
7. If the step is a screen (type 1):
   - If its view has a title or a text, and the popup guard is clear:
     - set the popup guard;
     - set `zPopupShown = 1`;
     - close the lap view;
     - open `'z-popup'` with `TITLE` = the title or `''`, and `TEXT` = the text or `''`.
   - Otherwise, if the popup guard, the lap guard and the beep guard are all clear: set the beep
     guard and `playIndication('Interval')`.
8. Start the step on the watch: `initStep(step.type, step.target)`.
9. `unload('_cm')`.

Note: in step 3 the "end of the repeated part" is the index right after the repeated steps. A
repeat of N steps written by Tartan has `next = N + 1`, because it includes a hidden-lap screen
first.

## Checks

The test harness (`test/workout-runner.test.ts`) gives both runners the same stand-ins for the
watch's functions and feeds them the same events. Every call to the watch must match, in order
and with the same arguments, for:
- the workouts Tartan writes;
- random event sequences (ticks, laps, targets reached).
