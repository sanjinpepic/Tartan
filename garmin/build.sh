#!/usr/bin/env bash
# Builds Tartan's watch app: one .prg per watch in manifest.xml (for sideloading) and the .iq
# package (for the Connect IQ Store). Needs the SDK's bin on PATH and the devices downloaded
# (connect-iq-sdk-manager device download --manifest=garmin/manifest.xml).
#   garmin/build.sh <developer_key.der> <out dir>
set -euo pipefail
KEY=$1
OUT=$2
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUT"
IDS=$(grep -o 'iq:product id="[^"]*"' "$HERE/manifest.xml" | sed 's/.*id="\(.*\)"/\1/')
FAILED=()
# The memory each watch gives a background service (Garmin's device files): one with less than
# 64 KB must leave phone messages to the app (monkey.jungle), since a plan arriving in the
# background wouldn't fit there.
DEVICES=${CIQ_DEVICES:-$HOME/.Garmin/ConnectIQ/Devices}
for id in $IDS; do
  f="$DEVICES/$id/compiler.json"
  [ -f "$f" ] || continue
  bg=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(next((a.get("memoryLimit",0) for a in d.get("appTypes",[]) if a.get("type")=="background"),0))' "$f")
  echo "$id: $bg bytes for the background"
  if [ "$bg" -gt 0 ] && [ "$bg" -lt 65536 ] && ! grep -q "^$id.excludeAnnotations = phoneInBackground$" "$HERE/monkey.jungle"; then
    echo "  $id: add '$id.excludeAnnotations = phoneInBackground' to garmin/monkey.jungle"; FAILED+=("$id")
  fi
done
for id in $IDS; do
  if monkeyc -f "$HERE/monkey.jungle" -d "$id" -o "$OUT/tartan-$id.prg" -y "$KEY" -r -w > "$OUT/$id.log" 2>&1; then
    echo "built $id"
    grep -i "warn" "$OUT/$id.log" | sort -u | head -5 || true
  else
    echo "FAILED $id"; cat "$OUT/$id.log"; FAILED+=("$id")
  fi
  rm -f "$OUT/$id.log" "$OUT/tartan-$id.prg.debug.xml"
done
if [ ${#FAILED[@]} -gt 0 ]; then echo "Failed: ${FAILED[*]}"; exit 1; fi
monkeyc -f "$HERE/monkey.jungle" -e -o "$OUT/tartan.iq" -y "$KEY" -r -w
echo "built tartan.iq"
ls -la "$OUT"
