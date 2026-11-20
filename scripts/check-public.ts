/**
 * Before a public release, and in CI: nothing taken from Suunto's own files may be in this
 * repository or in the public build. Suunto's step runner is only ever in the owner's checkout
 * (scripts/owner-overlay.sh); here src/workout/suunto-runner.ts must stay the empty stub. Then the
 * public web bundle is built and searched for the captured runner and face layout when this
 * checkout has them (the owner's). Leaves dist/ as the public build.
 *   bun scripts/check-public.ts
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { MAIN_JS } from "../src/workout/suunto-runner.ts";

// The committed stub: Suunto's runner must never be committed (the owner's copy is marked
// skip-worktree by the overlay script, so git keeps the stub).
const committed = execSync("git show HEAD:src/workout/suunto-runner.ts", { encoding: "utf8" });
if (!/export const MAIN_JS: string \| undefined = undefined;/.test(committed)) {
  console.error("Not public: src/workout/suunto-runner.ts in git isn't the empty stub (Suunto's runner was committed).");
  process.exit(1);
}
for (const f of ["test/fixtures/captured-face-layout.json", "test/fixtures/suunto-workouts.json", "android/app/debug.keystore"]) {
  if (execSync(`git ls-files ${f}`, { encoding: "utf8" }).trim()) {
    console.error(`Not public: ${f} is committed (it belongs to the owner's private add-on).`);
    process.exit(1);
  }
}

const build = Bun.spawnSync(["bun", "run", "build:web:public"], { stdout: "ignore", stderr: "inherit" });
if (build.exitCode !== 0) throw new Error("the public build failed");
// Distinctive pieces of what the owner's checkout has: the captured runner's first statement and
// the captured face layout's base64 (the app writes its own layout, so neither should appear).
const markers: Record<string, string> = {};
if (MAIN_JS) markers["the captured runner"] = MAIN_JS.split("\n")[1]!.slice(0, 40);
const face = "test/fixtures/captured-face-layout.json";
if (existsSync(face)) markers["the captured face layout"] = (JSON.parse(readFileSync(face, "utf8")) as { bytes_b64: string }).bytes_b64.slice(200, 260);
const found = readdirSync("dist")
  .filter((f) => f.endsWith(".js"))
  .flatMap((f) => {
    const text = readFileSync(`dist/${f}`, "utf8");
    return Object.entries(markers).filter(([, m]) => text.includes(m)).map(([what]) => `${what} in dist/${f}`);
  });
if (found.length) {
  console.error(`Not ready for a public release:\n  ${found.join("\n  ")}`);
  process.exit(1);
}
console.log("Public: nothing from Suunto's files in the repository or the build.");
