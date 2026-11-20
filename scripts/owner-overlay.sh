#!/usr/bin/env bash
# The owner's own build: copies the private add-on (Suunto's step runner, the captured test
# fixtures and the owner build's signing key) from a checkout of the private repository into this
# one, and tells git to keep ignoring them, so they're never committed here.
#   scripts/owner-overlay.sh ../FreeSuunto
set -euo pipefail
from="${1:?usage: scripts/owner-overlay.sh <path to the private checkout>}"
cd "$(dirname "$0")/.."
for f in src/workout/suunto-runner.ts test/fixtures/captured-face-layout.json test/fixtures/suunto-workouts.json android/app/debug.keystore; do
  test -f "$from/$f" || { echo "missing in $from: $f"; exit 1; }
  mkdir -p "$(dirname "$f")" && cp "$from/$f" "$f"
done
# The runner replaces a tracked stub: keep git's copy (the stub) as committed.
git update-index --skip-worktree src/workout/suunto-runner.ts
echo "Owner add-on in place (git keeps the public stub of the runner)."
