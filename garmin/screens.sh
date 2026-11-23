#!/usr/bin/env bash
# Pictures of the watch app in the Connect IQ simulator (headless, under Xvfb), from the
# screenshot build (screens.jungle: a sample plan, and the app driving itself through home, the
# run before START, a step change and the run). Writes <out>/<device>-1-home.png and so on.
#   garmin/screens.sh <developer_key.der> <device> <out dir>
set -euo pipefail
KEY=$1
DEV=$2
OUT=$3
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUT" /tmp/shots-$DEV
monkeyc -f "$HERE/screens.jungle" -d "$DEV" -o /tmp/screens-$DEV.prg -y "$KEY" -w
export DISPLAY=${DISPLAY:-:99}
simulator > /tmp/sim-$DEV.log 2>&1 &
SIM=$!
sleep 8
monkeydo /tmp/screens-$DEV.prg "$DEV" > /tmp/monkeydo-$DEV.log 2>&1 &
# A picture a second for 60 s; the phases are told apart afterwards by what changed.
for i in $(seq -w 1 60); do sleep 1; import -window root "/tmp/shots-$DEV/$i.png" 2>/dev/null || true; done
kill $SIM 2>/dev/null || true
pkill -f monkeydo 2>/dev/null || true
sleep 2
python3 "$HERE/pick-shots.py" "/tmp/shots-$DEV" "$OUT" "$DEV"
