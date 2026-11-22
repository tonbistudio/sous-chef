import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HERMES } from "./chat.js";
import { readPreferences } from "./library.js";

/**
 * Talking with Hermes in the chat, through Hermes Agent's own speech functions.
 *
 * A small worker runs inside Hermes's Python (the command `hermes --print-runtime-command` reports)
 * and calls Hermes's transcribe_audio and text_to_speech_tool, so the editor listens and speaks with
 * whatever the chosen Hermes profile is set up with. The worker stays up between requests so a local
 * speech model is loaded once, and quits after a while unused.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "..", "voice", "hermes_voice.py");
const IDLE_MS = 10 * 60_000;
const REQUEST_MS = 120_000;
const START = "runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)";

interface Pending {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** The Python command Hermes itself starts with, so the worker sees Hermes's modules and settings. */
async function runtimeCommand(): Promise<string[]> {
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(HERMES, ["--print-runtime-command", "chat"], { windowsHide: true, shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    child.stdout!.on("data", (d: Buffer) => (text += d.toString()));
    child.on("error", (e) => reject(/ENOENT/.test(String(e)) ? new Error("Hermes Agent was not found on this computer.") : e));
    child.on("close", (code) => (code === 0 ? resolve(text) : reject(new Error("This Hermes Agent can't lend its voice to Sous Chef; update it with `hermes update`."))));
  });
  let cmd: unknown;
  try {
    cmd = JSON.parse(out.trim().split(/\r?\n/).pop() ?? "[]");
  } catch {
    cmd = null;
  }
  if (!Array.isArray(cmd) || cmd.length < 4 || cmd[2] !== "-c" || typeof cmd[3] !== "string") throw new Error("Could not read how Hermes starts, so voice is unavailable.");
  return cmd.slice(0, 4) as string[];
}

/**
 * Starts one of Sous Chef's Python helpers inside Hermes's own Python, with the chosen profile's
 * settings ("" or "default": the user's default profile), so it can call Hermes's tools directly.
 */
export async function spawnInHermes(script: string, profile: string): Promise<ChildProcess> {
  const usable = profile === "default" ? "" : profile;
  const [python, isolate, , code] = await runtimeCommand();
  if (!code!.includes(START) || !code!.includes("import hermes_bootstrap;")) throw new Error("This Hermes Agent starts in a way Sous Chef doesn't know; update it with `hermes update`.");
  // The chosen profile's settings: point HERMES_HOME at it before Hermes reads anything.
  const pick = usable ? `import hermes_constants as _sc; os.environ['HERMES_HOME'] = os.path.join(str(_sc.get_default_hermes_root()), 'profiles', ${JSON.stringify(usable)}); ` : "";
  const run = code!
    .replace("import hermes_bootstrap;", `${pick}import hermes_bootstrap;`)
    .replace(START, `sys.argv = [${JSON.stringify(script)}]; runpy.run_path(${JSON.stringify(script)}, run_name='__main__')`);
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };
  delete env.HERMES_HOME;
  return spawn(python!, [isolate!, "-c", run], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env });
}

class VoiceWorker {
  private child: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private profile = "";
  private seq = 0;
  private pending = new Map<number, Pending>();
  private idle: NodeJS.Timeout | null = null;

  private stop(): void {
    const child = this.child;
    this.child = null;
    this.ready = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("The voice helper stopped."));
    }
    this.pending.clear();
    if (child && child.exitCode === null) child.kill();
  }

  private async start(profile: string): Promise<void> {
    const child = await spawnInHermes(SCRIPT, profile);
    this.child = child;
    this.profile = profile;
    let buffer = "";
    let stderr = "";
    this.ready = new Promise<void>((resolve, reject) => {
      child.on("error", (e) => reject(new Error(`Could not start Hermes's voice: ${e.message}`)));
      child.on("exit", (exitCode) => {
        if (this.child === child) this.stop();
        reject(new Error(stderr.trim().split(/\r?\n/).slice(-1)[0] || `Hermes's voice helper exited (${exitCode})`));
      });
      child.stderr!.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));
      child.stdout!.on("data", (d: Buffer) => {
        buffer += d.toString();
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (msg.ready) {
            resolve();
            continue;
          }
          const p = this.pending.get(Number(msg.id));
          if (!p) continue;
          this.pending.delete(Number(msg.id));
          clearTimeout(p.timer);
          if (msg.ok) p.resolve(msg);
          else p.reject(new Error(String(msg.error ?? "Voice request failed")));
        }
      });
    });
    await this.ready;
  }

  async request(op: "stt" | "tts", args: Record<string, string>): Promise<Record<string, unknown>> {
    const profile = (await readPreferences().catch(() => ({ hermesProfile: "" }))).hermesProfile || "";
    const usable = profile === "default" ? "" : profile;
    if (this.child && this.profile !== usable) this.stop();
    if (!this.child) {
      this.ready = this.start(usable).catch((e: unknown) => {
        this.stop();
        throw e;
      });
    }
    await this.ready;
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop(), IDLE_MS);
    this.idle.unref();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Hermes took too long with that."));
      }, REQUEST_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin!.write(JSON.stringify({ id, op, ...args }) + "\n");
    });
  }

  dispose(): void {
    this.stop();
  }
}

const worker = new VoiceWorker();
export const disposeTalk = (): void => worker.dispose();

function scratch(): string {
  return path.join(os.tmpdir(), "sous-chef-voice");
}

const AUDIO_EXT: Record<string, string> = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3", "audio/mp4": "m4a" };

/** The words in a recording made in the editor's chat. */
export async function transcribe(audio: Buffer, type: string): Promise<string> {
  const ext = AUDIO_EXT[type.split(";")[0]!.trim().toLowerCase()];
  if (!ext) throw new Error("That recording format can't be transcribed.");
  await mkdir(scratch(), { recursive: true });
  const file = path.join(scratch(), `say-${Date.now()}-${process.pid}.${ext}`);
  await writeFile(file, audio);
  try {
    const r = await worker.request("stt", { path: file });
    return String(r.text ?? "");
  } finally {
    await rm(file, { force: true });
  }
}

const AUDIO_TYPE: Record<string, string> = { mp3: "audio/mpeg", ogg: "audio/ogg", opus: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4", flac: "audio/flac" };

/** A reply read aloud in the profile's Hermes voice: the audio and its type. */
export async function speak(text: string): Promise<{ audio: Buffer; type: string }> {
  await mkdir(scratch(), { recursive: true });
  const base = path.join(scratch(), `reply-${Date.now()}-${process.pid}`);
  const r = await worker.request("tts", { text, out: `${base}.mp3` });
  const file = String(r.path ?? "");
  if (!file || !existsSync(file)) throw new Error("Hermes made no audio.");
  try {
    return { audio: await readFile(file), type: AUDIO_TYPE[path.extname(file).slice(1).toLowerCase()] ?? "application/octet-stream" };
  } finally {
    await rm(file, { force: true });
  }
}

/** The words worth saying aloud from a chat reply: no markdown, links, paths or code, and not too long. */
export function spokenText(reply: string, max = 700): string {
  const plain = reply
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(?:[-*•]|\d+\.)\s+/gm, "")
    .replace(/^#+\s*/gm, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[A-Za-z]:[\\/][^\s,;)]+/g, "")
    .replace(/[*_~|>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return (end > max * 0.4 ? cut.slice(0, end + 1) : cut).trim();
}
