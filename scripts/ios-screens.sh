#!/usr/bin/env bash
# Screenshots of the iPhone app in the simulator, with the sample data only (nothing of anyone's):
# builds for the simulator, boots the newest iPhone (an iPhone 17 Pro when there is one), and
# launches the app once per screen with the launch arguments the shell reads (ios/App/App/Shell/
# Launch.swift): -TartanDemo YES (the sample data, no intro), -TartanTab <tab>, -TartanMore YES.
# Light and dark. Writes screenshots/ios/<appearance>-<n>-<screen>.png. On a Mac with Xcode 26+.
set -euo pipefail
cd "$(dirname "$0")/.."
./scripts/ios-prepare.sh

UDID=$(xcrun simctl list devices available -j | python3 -c '
import json, re, sys
devs = []
for runtime, items in json.load(sys.stdin)["devices"].items():
    m = re.search(r"iOS-(\d+)-(\d+)", runtime)
    if not m: continue
    for d in items:
        if d["name"].startswith("iPhone"): devs.append(((int(m[1]), int(m[2])), d))
devs.sort(key=lambda x: x[0])
best = [d for v, d in devs if d["name"] == "iPhone 17 Pro"] or [d for v, d in devs if "Pro" in d["name"]] or [d for v, d in devs]
print(best[-1]["udid"])')
echo "Simulator: $(xcrun simctl list devices | grep "$UDID")"
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b >/dev/null

xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug -sdk iphonesimulator \
  -destination "id=$UDID" -derivedDataPath ios/App/build-sim CODE_SIGNING_ALLOWED=NO build | tail -n 5
APP=ios/App/build-sim/Build/Products/Debug-iphonesimulator/App.app
BUNDLE=app.tartan

xcrun simctl uninstall "$UDID" "$BUNDLE" 2>/dev/null || true
xcrun simctl install "$UDID" "$APP"
xcrun simctl privacy "$UDID" grant all "$BUNDLE" 2>/dev/null || true
xcrun simctl status_bar "$UDID" override --time 9:41 --dataNetwork wifi --wifiBars 3 --cellularBars 4 --batteryState charged --batteryLevel 100

OUT=screenshots/ios
rm -rf "$OUT" && mkdir -p "$OUT"

# The app marks what it has loaded (Shell/Launch.swift ready): a file in its Documents.
DOCS="$(xcrun simctl get_app_container "$UDID" "$BUNDLE" data)/Documents"
mkdir -p "$DOCS"
wait_for() {
  local what=$1 limit=$2 t=0
  until [ -f "$DOCS/ready-$what" ]; do
    sleep 1; t=$((t + 1))
    if [ "$t" -ge "$limit" ]; then echo "  (no $what after ${limit}s)"; return 0; fi
  done
}

# One launch per screen: the arguments, then until what it shows has its data, and a moment for
# the animations to settle.
shot() {
  local name=$1 ready=$2; shift 2
  xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
  rm -f "$DOCS"/ready-*
  xcrun simctl launch "$UDID" "$BUNDLE" -TartanDemo YES "$@" >/dev/null
  wait_for "$ready" 120
  sleep 4
  xcrun simctl io "$UDID" screenshot --type=png "$OUT/$name.png" >/dev/null
  # Two thirds of the phone's size: enough to read, lighter in the repository.
  sips --resampleWidth 804 "$OUT/$name.png" >/dev/null
  echo "  $name"
}

# The first start: the sample data (the page reloads into it and writes ten weeks of workouts),
# then a race and a plan by Tartan's rules.
xcrun simctl ui "$UDID" appearance light
rm -f "$DOCS"/ready-*
xcrun simctl launch "$UDID" "$BUNDLE" -TartanDemo YES >/dev/null
wait_for plan 300

for look in light dark; do
  xcrun simctl ui "$UDID" appearance "$look"
  echo "$look:"
  shot "$look-1-today" today -TartanTab today
  shot "$look-2-today-more" more -TartanTab today -TartanMore YES
  shot "$look-2b-session" session -TartanTab today -TartanOpen session
  shot "$look-2c-workout" workout -TartanTab today -TartanOpen workout
  shot "$look-3-coach" coach -TartanTab coach
  shot "$look-3b-chat" chat -TartanTab chat -TartanChatSample YES
  shot "$look-4-activities" activities -TartanTab activities
  shot "$look-5-progress" trends -TartanTab trends
  shot "$look-6-settings" settings -TartanTab settings/training
  shot "$look-7-body" you -TartanTab you
  shot "$look-8-record" record -TartanTab record
  shot "$look-9-lift" lift -TartanTab lift
done
xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
ls -la "$OUT"
