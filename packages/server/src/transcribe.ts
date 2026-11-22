import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { homeDir } from "./connect.js";
import type { Transcript } from "@sous-chef/core";
import { refined } from "./refine.js";
import type { JobHandle } from "./jobs.js";

export type { Transcript, Word } from "@sous-chef/core";

interface Config {
  python?: string;
  hfHome?: string;
}

export function readConfig(): Config {
  try {
    return JSON.parse(readFileSync(path.join(homeDir(), "config.json"), "utf8")) as Config;
  } catch {
    return {};
  }
}

/** The Python that has WhisperX installed, or null when transcription is not set up. */
export function sidecarPython(): string | null {
  const candidates = [
    process.env.SOUS_CHEF_PYTHON,
    readConfig().python,
    path.join(homeDir(), "sidecar", ".venv", "Scripts", "python.exe"),
    path.join(homeDir(), "sidecar", ".venv", "bin", "python"),
  ];
  for (const c of candidates) if (c && existsSync(c)) return c;
  return null;
}

function sidecarScript(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [process.env.SOUS_CHEF_SIDECAR, path.resolve(here, "../../../sidecar/transcribe.py"), path.resolve(here, "../sidecar/transcribe.py")];
  for (const c of candidates) if (c && existsSync(c)) return c;
  throw new Error("The transcription script is missing from this install.");
}

function run(cmd: string, args: string[], handle?: JobHandle, onLine?: (line: string, stream: "out" | "err") => void, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env });
    if (handle) handle.onCancel = () => child.kill();
    let err = "";
    let out = "";
    const feed = (stream: "out" | "err") => {
      let buf = "";
      return (d: Buffer) => {
        buf += d.toString("utf8");
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (stream === "err") err = (err + line + "\n").slice(-6000);
          else out = (out + line + "\n").slice(-6000);
          onLine?.(line, stream);
        }
      };
    };
    child.stdout.on("data", feed("out"));
    child.stderr.on("data", feed("err"));
    child.on("error", (e) => reject(new Error(`Could not run ${path.basename(cmd)}: ${e.message}`)));
    child.on("close", (code) => {
      if (handle?.cancelled) reject(new Error("cancelled"));
      else if (code === 0) resolve(err);
      else reject(new Error(err.trim().split("\n").slice(-3).join(" | ") || `${path.basename(cmd)} exited with ${code}`));
    });
  });
}

/** Finds stretches of near silence in a WAV file. */
export async function detectSilences(wav: string, handle?: JobHandle): Promise<[number, number][]> {
  const out: [number, number][] = [];
  let start: number | null = null;
  // Read as the lines arrive: the kept stderr is only a short tail, which on a long file would hold
  // just the last pauses.
  await run("ffmpeg", ["-hide_banner", "-nostats", "-i", wav, "-af", "silencedetect=noise=-38dB:d=0.25", "-f", "null", "-"], handle, (line, stream) => {
    if (stream !== "err") return;
    const s = /silence_start: (-?[\d.]+)/.exec(line);
    const e = /silence_end: ([\d.]+)/.exec(line);
    if (s) start = Math.max(0, Number(s[1]));
    if (e && start !== null) {
      out.push([Math.round(start * 1e6), Math.round(Number(e[1]) * 1e6)]);
      start = null;
    }
  });
  return out;
}

export function transcriptPath(projectDir: string, mediaId: string): string {
  return path.join(projectDir, "transcripts", `${mediaId}.words.json`);
}

export async function readTranscript(projectDir: string, mediaId: string): Promise<Transcript | null> {
  try {
    const file = transcriptPath(projectDir, mediaId);
    const raw = JSON.parse(await readFile(file, "utf8")) as Transcript;
    // Word times as the engine gave them chop words when cut on; use the ones adjusted to the audio.
    return await refined(projectDir, mediaId, raw, file);
  } catch {
    return null;
  }
}

export async function listTranscripts(projectDir: string): Promise<string[]> {
  const names = await readdir(path.join(projectDir, "transcripts")).catch(() => [] as string[]);
  return names.filter((n) => n.endsWith(".words.json")).map((n) => n.slice(0, -".words.json".length));
}

/**
 * Transcribes media files into word lists. One Python process handles the
 * whole batch, so the models are loaded once.
 */
export async function transcribeMedia(projectDir: string, items: { mediaId: string; file: string }[], handle: JobHandle): Promise<{ done: string[]; failed: Record<string, string> }> {
  const python = sidecarPython();
  if (!python) throw new Error("Transcription is not set up on this computer. See sidecar/README.md.");
  const audioDir = path.join(projectDir, "cache", "audio");
  const outDir = path.join(projectDir, "transcripts");
  await mkdir(audioDir, { recursive: true });
  await mkdir(outDir, { recursive: true });

  const jobItems: { audio: string; out: string }[] = [];
  const silences: [number, number][][] = [];
  for (const [i, item] of items.entries()) {
    handle.update((i / items.length) * 0.15, `Reading the sound of ${path.basename(item.file)}`);
    const wav = path.join(audioDir, `${item.mediaId}.wav`);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", item.file, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav], handle);
    silences.push(await detectSilences(wav, handle));
    jobItems.push({ audio: wav, out: path.join(outDir, `${item.mediaId}.raw.json`) });
  }

  const jobFile = path.join(audioDir, `job-${handle.job.id}.json`);
  await writeFile(jobFile, JSON.stringify({ items: jobItems, model: "large-v3-turbo", language: "en", hfHome: readConfig().hfHome }), "utf8");
  const done: string[] = [];
  const failed: Record<string, string> = {};
  // The server may itself have been started from another Python's environment; do not let that leak in.
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUTF8: "1" };
  delete env.PYTHONPATH;
  delete env.PYTHONHOME;
  handle.update(0.15, "Loading the speech model");
  try {
    await run(
      python,
      [sidecarScript(), jobFile],
      handle,
      (line, stream) => {
        if (stream !== "out" || !line.startsWith("{")) return;
        let e: { event?: string; index?: number; error?: string };
        try {
          e = JSON.parse(line);
        } catch {
          return;
        }
        const i = e.index ?? 0;
        const base = 0.2 + (i / items.length) * 0.8;
        const name = items[i] ? path.basename(items[i]!.file) : "";
        if (e.event === "start") handle.update(base, `Transcribing ${name}`);
        else if (e.event === "aligning") handle.update(base + 0.5 / items.length, `Timing the words of ${name}`);
        else if (e.event === "done") done.push(items[i]!.mediaId);
        else if (e.event === "failed") failed[items[i]!.mediaId] = e.error ?? "failed";
      },
      env,
    );
  } finally {
    await rm(jobFile, { force: true });
  }
  // Join each raw word list with its silences into the final transcript file.
  for (const [i, item] of items.entries()) {
    const rawFile = jobItems[i]!.out;
    if (!done.includes(item.mediaId)) continue;
    const raw = JSON.parse(await readFile(rawFile, "utf8")) as Omit<Transcript, "silences">;
    const final: Transcript = { ...raw, silences: silences[i] ?? [] };
    const target = transcriptPath(projectDir, item.mediaId);
    await writeFile(target + ".tmp", JSON.stringify(final), "utf8");
    await rm(target, { force: true });
    await rename(target + ".tmp", target);
    await rm(rawFile, { force: true });
  }
  if (!done.length && Object.keys(failed).length) throw new Error(Object.values(failed)[0]);
  return { done, failed };
}
