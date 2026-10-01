#!/usr/bin/env bash
# Smoke test: render the demo bundle and assert the things that broke before.
set -euo pipefail
cd "$(dirname "$0")/../examples"
rm -rf .ccrender out
node ../src/cli.mjs export demo.bundle.json > /dev/null
W=.ccrender/rnd_demo_001
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }

# 1. every motion item rendered exactly its timeline length (bug: Remotion fell back to 60 frames)
check "mg_title 90 frames"  '[ "$(ls $W/mg/mg_title | wc -l)" = 90 ]'
check "mg_lower 150 frames" '[ "$(ls $W/mg/mg_lower | wc -l)" = 150 ]'
# 2. output is exactly the timeline length
D=$(ffprobe -v error -show_entries format=duration -of csv=p=0 out/rnd_demo_001.mp4)
check "duration 30s (got $D)" 'python3 -c "import sys;sys.exit(0 if abs($D-30)<0.05 else 1)"'
# 3. music keeps playing after speech ends (bug: sidechain cut the music bus)
V=$(ffmpeg -v info -ss 24.5 -to 27.5 -i out/rnd_demo_001.mp4 -vn -af volumedetect -f null - 2>&1 | sed -n 's/.*mean_volume: \(-[0-9.]*\) dB/\1/p')
check "audio after speech > -40dB (got $V)" 'python3 -c "import sys;sys.exit(0 if $V>-40 else 1)"'
# 4. manifest hash matches the file
H=$(sha256sum out/rnd_demo_001.mp4 | cut -d" " -f1)
check "manifest sha256" 'grep -q "$H" out/export-manifest.json'
exit $fail
