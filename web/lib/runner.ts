/**
 * Which step runner goes in the workouts sent to the watch (src/workout/guide.ts). The public
 * build has only Tartan's own (src/workout/runner.ts, written clean-room). The owner's build
 * can also send the one captured from the Suunto app (src/workout/suunto-runner.ts), the one
 * proven on the watch so far, picked in Settings → More → Advanced (Step runner). The bundler drops the captured one
 * from the public build: it is only reached through import() behind PUBLIC_BUILD.
 */
declare const PUBLIC_BUILD: boolean | undefined;

const KEY = "freesuunto.workouts.runner";
export type RunnerChoice = "suunto" | "tartan";

export const publicBuild = (): boolean => typeof PUBLIC_BUILD !== "undefined" && !!PUBLIC_BUILD;

export function runnerChoice(): RunnerChoice {
  if (publicBuild()) return "tartan";
  try {
    return localStorage.getItem(KEY) === "tartan" ? "tartan" : "suunto";
  } catch {
    return "suunto";
  }
}

export function setRunnerChoice(c: RunnerChoice): void {
  try {
    localStorage.setItem(KEY, c);
  } catch {
    // no storage: the default stays
  }
}

/** The runner for guidePackage(): undefined means Tartan's own. */
export async function workoutRunner(): Promise<string | undefined> {
  return typeof PUBLIC_BUILD !== "undefined" && PUBLIC_BUILD ? undefined : runnerChoice() === "tartan" ? undefined : (await import("../../src/workout/suunto-runner.ts")).MAIN_JS;
}
