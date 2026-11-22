"""Backend for the Sous Chef page in Hermes Desktop.

The editor page cannot read files or start programs, so it asks this route
where the local edit server is. The route finds the running server, or starts
it, and returns the address and access token for the page to load.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException

router = APIRouter()

START_TIMEOUT_S = 15
IDLE_EXIT_MINUTES = 10


def _home() -> Path:
    override = os.environ.get("SOUS_CHEF_HOME")
    if override:
        return Path(override)
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / ".local" / "share")
    return Path(base) / "sous-chef"


def _running() -> dict[str, Any] | None:
    """The live server's connection details, or None. A stale lock file counts as none."""
    try:
        info = json.loads((_home() / "server.json").read_text(encoding="utf-8"))
        port = int(info["port"])
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1.5) as res:
            if json.load(res).get("name") != "sous-chef":
                return None
        return {"port": port, "token": str(info["token"])}
    except Exception:
        return None


def _launch_command() -> list[str] | None:
    """The command that starts the edit server, or None when Sous Chef is not installed."""
    # A development checkout: this package sits beside the server it starts.
    local = Path(__file__).resolve().parents[2] / "packages" / "server" / "dist" / "main.js"
    node = shutil.which("node")
    if local.is_file() and node:
        return [node, str(local)]
    # Otherwise, whatever started the server last time (the desktop app records this).
    try:
        saved = json.loads((_home() / "install.json").read_text(encoding="utf-8"))
        exec_path, entry = Path(saved["exec"]), Path(saved["entry"])
        if exec_path.is_file() and entry.is_file():
            return [str(exec_path), str(entry)]
    except Exception:
        pass
    return None


def _start() -> None:
    command = _launch_command()
    if command is None:
        raise HTTPException(503, "Sous Chef is not set up on this computer. Open the Sous Chef app once, then try again.")
    home = _home()
    home.mkdir(parents=True, exist_ok=True)
    command += ["--idle-exit-minutes", str(IDLE_EXIT_MINUTES), "--log", str(home / "server.log")]
    # ELECTRON_RUN_AS_NODE makes the desktop app's own binary behave as plain Node; plain Node ignores it.
    env = {**os.environ, "ELECTRON_RUN_AS_NODE": "1"}
    flags = 0
    if sys.platform == "win32":
        flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    subprocess.Popen(
        command,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
        creationflags=flags,
        start_new_session=sys.platform != "win32",
    )


@router.post("/connection")
def connection() -> dict[str, Any]:
    """Where the edit server is. Starts it when it is not running."""
    info = _running()
    started = False
    if info is None:
        _start()
        started = True
        deadline = time.monotonic() + START_TIMEOUT_S
        while info is None and time.monotonic() < deadline:
            time.sleep(0.2)
            info = _running()
        if info is None:
            raise HTTPException(504, f"The Sous Chef server did not start. See {_home() / 'server.log'}")
    return {"url": f"http://127.0.0.1:{info['port']}", "token": info["token"], "started": started}
