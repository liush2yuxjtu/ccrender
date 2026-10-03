---
name: verify
description: Verify ccrender end to end, cheapest checks first — syntax + unit tests (~2 s), then the smoke render, CLI behaviour checks (budgeted resume, proof-frame run count, argument errors) and, when a Drive token is available, a live Google Drive download/upload round trip. Use after every edit (fast mode), before pushing or merging (full), or when asked to verify/test the renderer.
---

# /verify

Tests are shifted left: the cheap checks run first and on every commit, the slow ones before anything is pushed.

```sh
npm i                    # first time only; also points git at .githooks (npm "prepare")
npm run test:fast        # = bash tests/verify.sh --fast  (syntax + unit, ~2 s)
npm run verify           # = bash tests/verify.sh         (everything below)
```

`tests/verify.sh` stages, in order. A failure in stage 1 stops the run before any render starts.

1. **Fast**: `node --check` on every `src/` and `tests/` script, `bash -n` on every shell script and git hook, then `tests/unit.mjs` (streamed download, Range + If-Range resume, changed-remote, missing-validator, 416 and oversized `.part` handling, strong-validator selection, atempo chain, non-finite speed rejection). `--fast` stops here.
2. **Smoke render**: `fixtures/make.sh` + `tests/smoke.sh` render `examples/demo.bundle.json` and check MG frame counts, 30 s duration, music after speech, manifest sha256.
3. **CLI behaviour**: `--budget-sec 12` loops through exit 75 to exit 0; `frames` leaves `runs` unchanged; `--budget-sec abc` exits 2; a budget below the audio+mux tail exits 1; an unknown flag exits 2; upload without a token exits 1.
4. **Live Google Drive**, only when these env vars are set:
   - `CCRENDER_DRIVE_TOKEN`: OAuth access token with `drive.readonly` + `drive.file` scopes
   - `CCRENDER_TEST_DRIVE_FILE`: fileId of a small PNG in Drive (used as the logo asset via `drive://`)
   - `CCRENDER_TEST_DRIVE_FOLDER` (optional): folder for the uploaded test render
   It checks the asset is pulled with the env token, the token never lands in the bundle, state or output, and the rendered mp4 uploads.

## Git hooks (`.githooks/`, enabled by `npm i`)

- `pre-commit` runs the fast stage, so every commit has passed syntax and unit tests.
- `pre-push` runs the full verification.
- If the hooks aren't active (e.g. a fresh clone without `npm i`), enable them with `git config core.hooksPath .githooks`.
- `--no-verify` skips a hook once. Don't use it to get past a failing check.

## How to use it as an agent

- After each code change, run `npm run test:fast` before going on.
- Before pushing, opening a PR or merging, run the full `npm run verify`.
- Report each PASS/FAIL line. If anything fails, show the failing check's output and fix the cause. Never weaken or skip a check to get green, and never print the token.
- New behaviour gets its test in the cheapest stage that can catch it: a unit test in `tests/unit.mjs` before a smoke or CLI check.

Needs ffmpeg and Node 18+; Remotion downloads Chromium if none is found.
