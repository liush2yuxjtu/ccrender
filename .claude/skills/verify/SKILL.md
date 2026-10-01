---
name: verify
description: Verify ccrender end to end — runs npm test (unit + smoke), CLI behaviour checks (budgeted resume, proof-frame run count, argument errors) and, when a Drive token is available, a live Google Drive download/upload round trip. Use before pushing, before merging, or when asked to verify/test the renderer.
---

# /verify

Run from the repo root:

```sh
npm i            # first time only
bash tests/verify.sh
```

`tests/verify.sh` runs, in order:

1. `npm test`: `tests/unit.mjs` (streamed/resumed download, 416 handling, atempo chain) and `tests/smoke.sh` (renders `examples/demo.bundle.json`, checks MG frame counts, 30 s duration, music after speech, manifest sha256).
2. CLI behaviour: `--budget-sec 12` loops through exit 75 to exit 0, `frames` leaves `runs` unchanged, bad flags exit 2, upload without a token exits 1.
3. Live Google Drive, only when these env vars are set:
   - `CCRENDER_DRIVE_TOKEN`: OAuth access token with `drive.readonly` + `drive.file` scopes
   - `CCRENDER_TEST_DRIVE_FILE`: fileId of a small PNG in Drive (used as the logo asset via `drive://`)
   - `CCRENDER_TEST_DRIVE_FOLDER` (optional): folder for the uploaded test render
   It checks the asset is pulled with the env token, the token never lands in the bundle, state or output, and the rendered mp4 uploads.

Report each PASS/FAIL line. If anything fails, show the failing check's output and fix the cause; never weaken or skip a check to get green. Never print the token.

Needs ffmpeg and Node 18+; Remotion downloads Chromium if none is found.
