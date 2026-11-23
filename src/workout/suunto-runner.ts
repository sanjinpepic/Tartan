/**
 * The step runner Suunto's own app puts in its workout guides. It is Suunto's code, so it isn't
 * part of this repository: here it is empty, and Tartan sends its own runner (src/workout/runner.ts,
 * written clean-room from docs/cleanroom/workout-runner-spec.md) to every watch. The owner's own
 * build swaps this file for the captured one from a private add-on (scripts/owner-overlay.sh);
 * that copy must never be committed here (CI checks: scripts/check-public.ts).
 */
export const MAIN_JS: string | undefined = undefined;
