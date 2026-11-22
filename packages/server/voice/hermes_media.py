"""
Sous Chef's bridge to Hermes Agent's own picture and video generation (for B-roll).

Runs inside Hermes's Python, started the same way as hermes_voice.py, so image_generate and
video_generate use whatever the chosen Hermes profile is set up with: the same providers, models
and keys as Hermes uses elsewhere, at their default settings. Nothing here picks a provider.

One request on stdin, one reply on stdout, then it exits:
  {"kind": "image" | "video", "prompt": "...", "out": "C:/.../b1234abcd"}
  -> {"ok": true, "path": "C:/.../b1234abcd.png"}   or   {"ok": false, "error": "..."}
`out` is the file's path without its extension; the extension follows what Hermes made.
Anything Hermes prints while it works goes to stderr, so stdout stays clean.
"""
import json
import os
import shutil
import sys
import urllib.parse
import urllib.request

REAL_STDOUT = sys.stdout
sys.stdout = sys.stderr  # Hermes's own logging must not land in the reply.

MAX_BYTES = 1024 * 1024 * 1024
EXTS = {"image": (".png", ".jpg", ".jpeg", ".webp"), "video": (".mp4", ".webm", ".mov", ".m4v")}
TYPE_EXT = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov"}


def reply(obj):
    REAL_STDOUT.write(json.dumps(obj) + "\n")
    REAL_STDOUT.flush()


def find_result(value, kind):
    """The file or link a tool result points at, wherever its envelope keeps it."""
    keys = ("image", "video", "file_path", "path", "url", "output_path", "media_path")
    if isinstance(value, str):
        v = value.strip()
        if v.startswith(("http://", "https://")) or os.path.isfile(v):
            return v
        return None
    if isinstance(value, dict):
        for key in keys:
            found = find_result(value.get(key), kind)
            if found:
                return found
        for item in value.values():
            found = find_result(item, kind)
            if found:
                return found
    if isinstance(value, list):
        for item in value:
            found = find_result(item, kind)
            if found:
                return found
    return None


def ext_for(kind, name, content_type=""):
    low = name.lower()
    for e in EXTS[kind]:
        if low.endswith(e):
            return e
    return TYPE_EXT.get(content_type.split(";")[0].strip().lower(), EXTS[kind][0])


def save(found, kind, out):
    if found.startswith(("http://", "https://")):
        request = urllib.request.Request(found, headers={"User-Agent": "sous-chef"})
        with urllib.request.urlopen(request, timeout=600) as answer:
            target = out + ext_for(kind, urllib.parse.urlsplit(found).path, answer.headers.get("Content-Type", ""))
            got = 0
            with open(target + ".part", "wb") as f:
                while True:
                    chunk = answer.read(1 << 16)
                    if not chunk:
                        break
                    got += len(chunk)
                    if got > MAX_BYTES:
                        raise ValueError("the file Hermes made is too large")
                    f.write(chunk)
        os.replace(target + ".part", target)
        return target
    target = out + ext_for(kind, found)
    shutil.copyfile(found, target)
    return target


def main():
    try:
        req = json.loads(sys.stdin.readline() or "{}")
        kind = req.get("kind")
        prompt = str(req.get("prompt") or "").strip()
        out = str(req.get("out") or "")
        if kind not in EXTS or not prompt or not out:
            return reply({"ok": False, "error": "bad request"})
        if kind == "image":
            from tools.image_generation_tool import _handle_image_generate
            raw = _handle_image_generate({"prompt": prompt})
        else:
            from tools.video_generation_tool import _handle_video_generate
            raw = _handle_video_generate({"prompt": prompt})
        try:
            result = json.loads(raw) if isinstance(raw, str) else raw
        except ValueError:
            result = {"text": raw}
        if isinstance(result, dict) and (result.get("success") is False or (result.get("error") and not find_result(result, kind))):
            return reply({"ok": False, "error": str(result.get("error") or "Hermes could not make it")[:500]})
        found = find_result(result, kind)
        if not found:
            return reply({"ok": False, "error": "Hermes made nothing it could hand back"})
        reply({"ok": True, "path": save(found, kind, out)})
    except Exception as exc:  # said plainly, never a traceback on stdout
        reply({"ok": False, "error": f"{type(exc).__name__}: {exc}"[:500]})


if __name__ == "__main__":
    main()
