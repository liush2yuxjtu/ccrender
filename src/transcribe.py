#!/usr/bin/env python3
"""Local CPU transcription for the agent sandbox (replaces a paid transcription API).

usage: transcribe.py <media> [--model base] [--fps 30] [--max-chars 32] > cues.json
Prints {"model","audioSec","elapsedSec","rtf","language","words":[...],"cues":[{start,end,text} in frames]}
"""
import json, sys, time, argparse
from faster_whisper import WhisperModel

ap = argparse.ArgumentParser()
ap.add_argument("media"); ap.add_argument("--model", default="base")
ap.add_argument("--fps", type=int, default=30); ap.add_argument("--max-chars", type=int, default=32)
a = ap.parse_args()

t_load = time.time()
model = WhisperModel(a.model, device="cpu", compute_type="int8", cpu_threads=0)
t0 = time.time()
segments, info = model.transcribe(a.media, word_timestamps=True, vad_filter=True, beam_size=1)
words = [w for s in segments for w in (s.words or [])]
elapsed = time.time() - t0

# group words into caption cards of <= max-chars, break on sentence ends / pauses
cues, cur = [], []
def flush():
    if cur:
        cues.append({"start": round(cur[0].start * a.fps), "end": round(cur[-1].end * a.fps),
                     "text": "".join(w.word for w in cur).strip()})
        cur.clear()
for w in words:
    text = "".join(x.word for x in cur) + w.word
    gap = cur and (w.start - cur[-1].end) > 0.6
    if cur and (len(text.strip()) > a.max_chars or gap):
        flush()
    cur.append(w)
    if w.word.strip().endswith((".", "?", "!")):
        flush()
flush()
for i in range(len(cues) - 1):  # close tiny gaps so captions don't flicker
    if cues[i + 1]["start"] - cues[i]["end"] < 8:
        cues[i]["end"] = cues[i + 1]["start"]

print(json.dumps({"model": a.model, "audioSec": round(info.duration, 2), "loadSec": round(t0 - t_load, 2),
                  "elapsedSec": round(elapsed, 2), "rtf": round(elapsed / info.duration, 3),
                  "language": info.language,
                  "words": [{"w": w.word.strip(), "s": round(w.start, 2), "e": round(w.end, 2)} for w in words],
                  "cues": cues}, ensure_ascii=False, indent=1))
