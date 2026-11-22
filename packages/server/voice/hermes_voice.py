"""
Sous Chef's bridge to Hermes Agent's own voice functions.

Runs inside Hermes's Python (Sous Chef starts it with the command `hermes --print-runtime-command`
reports), so speech-to-text and text-to-speech use whatever the chosen Hermes profile is set up with:
the same providers, voices and keys as Hermes uses elsewhere. Nothing here picks a provider.

Protocol: one JSON request per line on stdin, one JSON reply per line on stdout.
  {"id": 1, "op": "stt", "path": "C:/.../clip.webm"}        -> {"id": 1, "ok": true, "text": "..."}
  {"id": 2, "op": "tts", "text": "...", "out": "C:/.../a"}  -> {"id": 2, "ok": true, "path": "C:/.../a.mp3"}
Anything Hermes prints while it works goes to stderr, so stdout stays clean.
"""
import json
import os
import sys

REAL_STDOUT = sys.stdout
sys.stdout = sys.stderr  # Hermes's own logging must not land in the reply stream.


def reply(obj):
    REAL_STDOUT.write(json.dumps(obj) + "\n")
    REAL_STDOUT.flush()


def first_path(value):
    """The audio file a TTS result points at, wherever the envelope keeps it."""
    if isinstance(value, str):
        return value if os.path.isfile(value) else None
    if isinstance(value, dict):
        for key in ("file_path", "path", "audio_path", "output_path", "media_path", "file"):
            found = first_path(value.get(key))
            if found:
                return found
        for item in value.values():
            found = first_path(item)
            if found:
                return found
    if isinstance(value, list):
        for item in value:
            found = first_path(item)
            if found:
                return found
    return None


def main():
    from tools.transcription_tools import transcribe_audio
    from tools.tts_tool import text_to_speech_tool

    reply({"ready": True})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue
        rid = req.get("id")
        try:
            if req.get("op") == "stt":
                result = transcribe_audio(req["path"], source="voice_mode")
                if result.get("success") is False or result.get("error"):
                    reply({"id": rid, "ok": False, "error": str(result.get("error") or "Transcription failed")})
                else:
                    reply({"id": rid, "ok": True, "text": str(result.get("transcript") or "").strip()})
            elif req.get("op") == "tts":
                raw = text_to_speech_tool(req["text"], output_path=req.get("out"))
                try:
                    result = json.loads(raw) if isinstance(raw, str) else raw
                except ValueError:
                    result = {"text": raw}
                path = first_path(result)
                if isinstance(result, dict) and result.get("success") is False:
                    reply({"id": rid, "ok": False, "error": str(result.get("error") or "Speech failed")})
                elif not path:
                    reply({"id": rid, "ok": False, "error": "Hermes made no audio file"})
                else:
                    reply({"id": rid, "ok": True, "path": path})
            else:
                reply({"id": rid, "ok": False, "error": "unknown op"})
        except Exception as exc:  # one bad request must not end the worker
            reply({"id": rid, "ok": False, "error": f"{type(exc).__name__}: {exc}"})


if __name__ == "__main__":
    main()
