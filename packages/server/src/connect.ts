import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Where the running server announces itself so the app, the Hermes page and the MCP adapter can find it. */
export function homeDir(): string {
  if (process.env.SOUS_CHEF_HOME) return process.env.SOUS_CHEF_HOME;
  const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share");
  return path.join(base, "sous-chef");
}

/** Where the app kept its settings when it was called AI Garage Editor. */
export function legacyHomeDir(): string {
  const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share");
  return path.join(base, "ai-garage-editor");
}

/**
 * First start under the new name: brings settings, the library (templates, Hermes's notes, recent
 * projects, publishing templates) and the transcription set-up over from the old app's folder. The old
 * folder is left as it was. Connection files are not copied; they belong to a running server.
 */
export async function migrateHome(): Promise<boolean> {
  if (process.env.SOUS_CHEF_HOME) return false;
  const home = homeDir();
  const old = legacyHomeDir();
  // The app may already have made the folder (to start the server in); what counts is whether it holds settings yet.
  if (!existsSync(old) || ["preferences.json", "config.json", "library"].some((f) => existsSync(path.join(home, f)))) return false;
  const skip = new Set(["server.json", "server.log", "install.json"]);
  await cp(old, home, { recursive: true, filter: (src) => !skip.has(path.basename(src)) || path.dirname(src) !== old });
  return true;
}

export function lockFile(): string {
  return path.join(homeDir(), "server.json");
}

export interface ServerInfo {
  port: number;
  token: string;
  pid: number;
}

/** The running server, or null when there is none (a stale lock file counts as none). */
export async function findServer(): Promise<ServerInfo | null> {
  return (await probeServer())?.info ?? null;
}

async function probeServer(): Promise<{ info: ServerInfo; build: number; busy: boolean } | null> {
  try {
    const info = JSON.parse(await readFile(lockFile(), "utf8")) as ServerInfo;
    const res = await fetch(`http://127.0.0.1:${info.port}/api/health`, { signal: AbortSignal.timeout(1500) });
    const body = (await res.json()) as { name?: string; build?: number; busy?: boolean };
    return body.name === "sous-chef" ? { info, build: Number(body.build ?? 0), busy: Boolean(body.busy) } : null;
  } catch {
    return null;
  }
}

/** When the server code on disk was built. */
function entryBuild(entry: string): number {
  try {
    // The server stamps itself with http.js, the file that holds the stamp code.
    return Math.round(statSync(path.join(path.dirname(entry), "http.js")).mtimeMs);
  } catch {
    return 0;
  }
}

/**
 * What to run to start the server. Normally the server's own main.js beside this
 * file. When this code is bundled into the Hermes plugin that file is elsewhere,
 * so fall back to what the server recorded the last time it ran.
 */
function launchTarget(): { exec: string; entry: string } {
  const beside = fileURLToPath(new URL("./main.js", import.meta.url));
  if (!process.env.SOUS_CHEF_BUNDLED && existsSync(beside)) return { exec: process.execPath, entry: beside };
  try {
    const saved = JSON.parse(readFileSync(path.join(homeDir(), "install.json"), "utf8")) as { exec: string; entry: string };
    if (existsSync(saved.exec) && existsSync(saved.entry)) return saved;
  } catch {
    /* fall through */
  }
  throw new Error("Sous Chef is not set up on this computer. Open the Sous Chef app once, then try again.");
}

export interface EnsureOptions {
  /** Minutes with no connected window before a server we start shuts itself down. */
  idleExitMinutes?: number;
  timeoutMs?: number;
}

/**
 * Returns the running server, starting one if needed. The server runs as its
 * own process so it outlives whichever window started it; the Electron app,
 * the Hermes page and the MCP adapter all share it.
 */
export async function ensureServer(options: EnsureOptions = {}): Promise<ServerInfo> {
  const found = await probeServer();
  let target: { exec: string; entry: string } | null = null;
  if (found) {
    // A server left running from before an update keeps serving old code; replace it when it is idle.
    try {
      target = launchTarget();
    } catch {
      return found.info;
    }
    const onDisk = entryBuild(target.entry);
    if (found.busy || !onDisk || found.build >= onDisk - 1000) return found.info;
    await fetch(`http://127.0.0.1:${found.info.port}/api/shutdown`, { method: "POST", headers: { authorization: `Bearer ${found.info.token}` }, signal: AbortSignal.timeout(3000) }).catch(() => undefined);
    for (let i = 0; i < 40 && (await probeServer()); i++) await new Promise((r) => setTimeout(r, 100));
  }

  const { exec, entry } = target ?? launchTarget();
  mkdirSync(homeDir(), { recursive: true });
  // Two programs starting together (the app and an agent tool, say) must not each start a server:
  // two servers would both write the same project. Only the one that creates this file starts it.
  const starting = path.join(homeDir(), "server.starting");
  let mine = false;
  try {
    if (existsSync(starting) && Date.now() - statSync(starting).mtimeMs > 20_000) rmSync(starting, { force: true });
    writeFileSync(starting, String(process.pid), { flag: "wx" });
    mine = true;
  } catch {
    /* someone else is starting it; wait for theirs below */
  }
  try {
    if (mine) launch(exec, entry, options);
    const deadline = Date.now() + (options.timeoutMs ?? 15000);
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
      const info = await findServer();
      if (info) return info;
    }
  } finally {
    if (mine) rmSync(starting, { force: true });
  }
  throw new Error(`The Sous Chef server did not start. See ${path.join(homeDir(), "server.log")}`);
}

function launch(exec: string, entry: string, options: EnsureOptions): void {
  const args = [entry, "--idle-exit-minutes", String(options.idleExitMinutes ?? 10), "--log", path.join(homeDir(), "server.log")];
  // Inside Electron, process.execPath is Electron itself; this makes it behave as plain Node.
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  if (process.platform === "win32") {
    // A directly spawned child inherits open handles from the app, and Electron then cannot
    // finish exiting while the server lives. Start-Process launches it with nothing inherited.
    const quoted = args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(" ");
    const launcher = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "Start-Process -WindowStyle Hidden -FilePath $env:SOUS_EXE -ArgumentList $env:SOUS_ARGS"],
      { stdio: "ignore", windowsHide: true, env: { ...env, SOUS_EXE: exec, SOUS_ARGS: quoted } },
    );
    launcher.unref();
  } else {
    const child = spawn(exec, args, { detached: true, stdio: "ignore", env });
    child.unref();
  }
}

export function editorUrl(info: ServerInfo, projectId?: string): string {
  return `http://127.0.0.1:${info.port}/?token=${info.token}${projectId ? `&project=${projectId}` : ""}`;
}
