# ccrender v0.2 — render ChatCut-style timelines in the agent's own sandbox

> Prototype / design proposal. Not affiliated with or endorsed by ChatCut Inc. Tool names of the hosted ChatCut MCP were taken from the public [ChatCut-Inc/agent-plugin](https://github.com/ChatCut-Inc/agent-plugin) skills.

Design proposal (zh-CN): [`docs/DESIGN.md`](docs/DESIGN.md) · picture explainer: [`docs/eli5.html`](docs/eli5.html) ([live artifact](https://claude.ai/artifact/7yDV2CbF65aH8VfBKNpBS1))

Goal: move export / proof-frame / transcription compute off ChatCut's cloud and into the
user's agent sandbox (Cowork, Claude Code, Codex). Raw media lives in the user's Google Drive.

## Flow
```
ChatCut MCP  get_render_bundle ──► bundle.json  (timeline snapshot + asset refs) + short-lived Drive token
sandbox      CCRENDER_DRIVE_TOKEN=… ccrender export bundle.json   (ffmpeg base + Remotion MG layers, checkpointed)
sandbox      ccrender upload out/<id>.mp4       (resumable upload to user's Drive)
ChatCut MCP  register_export(out/export-manifest.json)
```

## Quick start
```sh
npm i && npm test        # makes synthetic fixtures, renders the demo, runs 5 checks (~2 min)
```

## Commands
```sh
node src/cli.mjs export examples/demo.bundle.json [--budget-sec 480]   # exit 75 = re-run to resume
node src/cli.mjs frames examples/demo.bundle.json --at 1.5,5,12        # agent self-check frames
CCRENDER_DRIVE_TOKEN=<token> node src/cli.mjs upload out/x.mp4 --folder <id>   # untested without real OAuth
python3 src/transcribe.py media.mp4 --model base > cues.json            # pip install faster-whisper
```

## Contract
Proposed MCP tools and types: `contract/types.ts` (capability probe, `get_render_bundle`, `register_export`).

## Bundle (render-bundle/0.1), frame-native
- `timeline` {fps,width,height,durationFrames}
- `assets` {id: {type: video|audio|image, src: relative path | https:// | drive://<fileId>}}
- `tracks[]` bottom→top: `video` (items: start, duration, sourceStart, rect, opacity, fadeIn/Out, audio:false),
  `motion` (component, props, start, duration), `audio` (role: anchor|follower → ducking), `captions` (cues, style)

## Measured on Cowork (2 vCPU, 7.8 GB)
| job | time |
|---|---|
| 30 s 1080p, 2 MG items | 41 s |
| 120 s 1080p, 6 MG items | 142 s (picture 82 s, MG 31 s for 690 frames, audio+mux+preview 27 s) |
| proof frame | 0.06–0.45 s |
| whisper base / small on 24 s speech | 1.9 s / 5.2 s |

## Known gaps
- MG now renders straight to PNG frames in one shared browser (0.045 s/frame, was 0.153 with ProRes). Picture compositing is the new bottleneck.
- `bash tests/smoke.sh` checks MG frame counts, duration, audio after speech, manifest hash.
- Drive download/upload written but not exercised with a real token. Downloads stream to disk and resume with HTTP Range + If-Range, so a partial file is only extended while the remote ETag/Last-Modified still matches.
- The Drive token is read from `CCRENDER_DRIVE_TOKEN`; `storage.drive.accessToken` in the bundle still works but is deprecated.
- With `--budget-sec`, a run that already did work stops before audio+mux if less than ~0.3× film length is left, so the tail never overruns a tool-call limit.
- `mg/index.jsx` is a stand-in for ChatCut's web renderer; swap it in so export == editor preview.
- No transitions / color / speed-ramped audio yet.
