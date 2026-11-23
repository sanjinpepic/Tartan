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
