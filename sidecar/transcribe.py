"""Sous Chef transcription sidecar.

Usage: python transcribe.py <job.json>

The job file lists audio files (16 kHz mono WAV) and where to write each word
list. Progress is printed as one JSON object per line. Models are loaded once
for the whole job.

Engine: WhisperX (faster-whisper large-v3-turbo, then wav2vec2 forced
alignment), chosen in the transcription bake-off for the tightest word edges.
"""
from __future__ import annotations

import json
import os
import sys
import time


FILLER_PROMPT = "Um, so, uh, I was, like, thinking that, um, we could, uh, you know, try it. Hmm, uh, okay. Um."


def say(**event):
    print(json.dumps(event), flush=True)


def to_words(aligned):
    """Flat word list in microseconds. Words the aligner could not time (often
    numbers) are placed between their neighbours so no text goes missing."""
    raw = []
    for seg_index, seg in enumerate(aligned.get("segments", [])):
        for w in seg.get("words", []):
            text = (w.get("word") or "").strip()
            if text:
                raw.append({"text": text, "start": w.get("start"), "end": w.get("end"), "conf": w.get("score"),
                            "seg": seg_index, "seg_start": seg.get("start"), "seg_end": seg.get("end")})
    n = len(raw)
    i = 0
    while i < n:
        if raw[i]["start"] is not None and raw[i]["end"] is not None:
            i += 1
            continue
        j = i
        while j < n and (raw[j]["start"] is None or raw[j]["end"] is None):
            j += 1
        left = raw[i - 1]["end"] if i > 0 else (raw[i]["seg_start"] or 0.0)
        right = raw[j]["start"] if j < n else (raw[j - 1]["seg_end"] or left)
        right = max(right, left)
        step = (right - left) / (j - i)
        for k in range(i, j):
            raw[k]["start"] = left + step * (k - i)
            raw[k]["end"] = left + step * (k - i + 1)
            raw[k]["guessed"] = True
        i = j
    words = []
    last_end = 0
    for index, w in enumerate(raw):
        start = max(int(round(w["start"] * 1e6)), last_end if index else 0)
        end = max(int(round(w["end"] * 1e6)), start + 1000)
        last_end = end
        item = {"id": f"w{index}", "text": w["text"], "startUs": start, "endUs": end, "seg": w["seg"]}
        if w.get("conf") is not None:
            item["conf"] = round(float(w["conf"]), 3)
        if w.get("guessed"):
            item["guessed"] = True
        words.append(item)
    return words


def main():
    job = json.load(open(sys.argv[1], encoding="utf-8"))
    if job.get("hfHome"):
        os.environ.setdefault("HF_HOME", job["hfHome"])
    say(event="loading")
    import torch
    import whisperx

    device = "cuda" if torch.cuda.is_available() else "cpu"
    compute = "float16" if device == "cuda" else "int8"
    model_name = job.get("model", "large-v3-turbo")
    language = job.get("language", "en")
    # Whisper tidies speech up and drops "um" and "uh" unless the text it is primed with has them.
    # A prompt full of fillers makes it write them down, so they can be cut.
    prompt = job.get("prompt", FILLER_PROMPT)
    asr_options = {"initial_prompt": prompt} if prompt else {}
    model = whisperx.load_model(model_name, device, compute_type=compute, language=language, download_root=os.environ.get("HF_HOME"), asr_options=asr_options)
    align_model, metadata = whisperx.load_align_model(language_code=language, device=device, model_dir=os.environ.get("HF_HOME"))
    say(event="ready", device=device)
    for index, item in enumerate(job["items"]):
        say(event="start", index=index)
        try:
            t = time.perf_counter()
            raw = model.transcribe(item["audio"], batch_size=8 if device == "cuda" else 2, language=language)
            say(event="aligning", index=index)
            aligned = whisperx.align(raw["segments"], align_model, metadata, item["audio"], device, return_char_alignments=False)
            words = to_words(aligned)
            out = {"schema": 1, "engine": "whisperx", "model": model_name, "language": language, "device": device,
                   "seconds": round(time.perf_counter() - t, 2), "words": words}
            tmp = item["out"] + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(out, f, ensure_ascii=False)
            os.replace(tmp, item["out"])
            say(event="done", index=index, words=len(words), seconds=out["seconds"])
        except Exception as exc:  # one bad file must not sink the rest
            say(event="failed", index=index, error=f"{type(exc).__name__}: {exc}")
    say(event="finished")


if __name__ == "__main__":
    main()
