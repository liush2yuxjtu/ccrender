#!/usr/bin/env bash
# Full verification: npm test + CLI behaviour checks + optional live Google Drive round trip.
# Drive part runs only when CCRENDER_DRIVE_TOKEN and CCRENDER_TEST_DRIVE_FILE (an image fileId) are set;
# CCRENDER_TEST_DRIVE_FOLDER (optional) is where the upload lands.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }

echo "== npm test"
npm test --silent || fail=1

echo "== CLI behaviour"
cd examples
rm -rf .ccrender out
n=0; code=75
while [ $code = 75 ] && [ $n -lt 10 ]; do node ../src/cli.mjs export demo.bundle.json --budget-sec 12 >/dev/null 2>&1; code=$?; n=$((n+1)); done
check "budgeted export resumes to done (exit $code after $n runs)" '[ $code = 0 ] && [ $n -gt 1 ]'
R1=$(grep -o '"runs": [0-9]*' .ccrender/rnd_demo_001/state.json)
node ../src/cli.mjs frames demo.bundle.json --at 2 >/dev/null 2>&1
R2=$(grep -o '"runs": [0-9]*' .ccrender/rnd_demo_001/state.json)
check "proof frames do not count as runs ($R1 -> $R2)" '[ "$R1" = "$R2" ]'
node ../src/cli.mjs export demo.bundle.json --budget-sec abc >/dev/null 2>&1; c=$?
check "--budget-sec abc exits 2 (got $c)" '[ $c = 2 ]'
node ../src/cli.mjs export demo.bundle.json --bogus >/dev/null 2>&1; c=$?
check "unknown flag exits 2 (got $c)" '[ $c = 2 ]'
env -u CCRENDER_DRIVE_TOKEN node ../src/cli.mjs upload out/rnd_demo_001.mp4 >/dev/null 2>&1; c=$?
check "upload without token exits 1 (got $c)" '[ $c = 1 ]'

if [ -n "${CCRENDER_DRIVE_TOKEN:-}" ] && [ -n "${CCRENDER_TEST_DRIVE_FILE:-}" ]; then
  echo "== live Google Drive"
  T=$(mktemp -d)
  python3 - "$T" "$CCRENDER_TEST_DRIVE_FILE" <<'PY'
import json, os, sys
t, fid = sys.argv[1], sys.argv[2]
b = json.load(open('demo.bundle.json'))
for a in b['assets'].values():
    a['src'] = os.path.abspath(a['src'])  # bundle moves to a temp dir
b['assets']['logo'] = {'type': 'image', 'src': 'drive://' + fid, 'ext': '.png'}
b['renderId'] = 'rnd_drive_check'
json.dump(b, open(t + '/bundle.json', 'w'))
PY
  node ../src/cli.mjs export "$T/bundle.json" >/dev/null 2>"$T/err"; c=$?
  check "export pulls drive:// asset with env token (exit $c)" '[ $c = 0 ] && [ -s "$T/.ccrender/rnd_drive_check/assets/logo.png" ]'
  check "token not written into bundle or state" '! grep -rq "$CCRENDER_DRIVE_TOKEN" "$T/bundle.json" "$T/.ccrender" "$T/out"'
  UP=$(node ../src/cli.mjs upload "$T/out/rnd_drive_check.mp4" ${CCRENDER_TEST_DRIVE_FOLDER:+--folder "$CCRENDER_TEST_DRIVE_FOLDER"} 2>&1); c=$?
  check "upload to Drive (exit $c)" '[ $c = 0 ] && echo "$UP" | grep -q "\"id\""'
  echo "$UP" | grep -E '"(id|name|size)"' || echo "$UP" | tail -3
  rm -rf "$T"
else
  echo "== live Google Drive: skipped (set CCRENDER_DRIVE_TOKEN and CCRENDER_TEST_DRIVE_FILE)"
fi

[ $fail = 0 ] && echo "ALL PASS" || echo "SOME CHECKS FAILED"
exit $fail
