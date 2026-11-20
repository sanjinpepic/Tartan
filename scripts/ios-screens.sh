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

# One launch per screen: the arguments, then time for the page to start and the data to come.
shot() {
  local name=$1 wait=$2; shift 2
  xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
  xcrun simctl launch "$UDID" "$BUNDLE" -TartanDemo YES "$@" >/dev/null
  sleep "$wait"
  xcrun simctl io "$UDID" screenshot --type=png "$OUT/$name.png" >/dev/null
  # Two thirds of the phone's size: enough to read, lighter in the repository.
  sips --resampleWidth 804 "$OUT/$name.png" >/dev/null
  echo "  $name"
}

# The first start writes the sample data and reloads into it.
xcrun simctl ui "$UDID" appearance light
xcrun simctl launch "$UDID" "$BUNDLE" -TartanDemo YES >/dev/null
sleep 60

for look in light dark; do
  xcrun simctl ui "$UDID" appearance "$look"
  echo "$look:"
  shot "$look-1-today" 25 -TartanTab today
  shot "$look-2-today-more" 28 -TartanTab today -TartanMore YES
  shot "$look-2b-session" 30 -TartanTab today -TartanOpen session
  shot "$look-2c-workout" 34 -TartanTab today -TartanOpen workout
  shot "$look-3-coach" 25 -TartanTab coach
  shot "$look-4-activities" 25 -TartanTab activities
  shot "$look-5-progress" 25 -TartanTab trends
done
xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
ls -la "$OUT"
