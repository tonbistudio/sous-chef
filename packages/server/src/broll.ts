import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { homeDir } from "./connect.js";
import { libraryDir, readPreferences } from "./library.js";
import { grabFrame, probeMedia } from "./media.js";
import { spawnInHermes } from "./talk.js";

/**
 * B-roll made for you, kept in the library so any project can use it.
 *
 * Two places make it, each at its default settings:
 *  - local: Imagination Studio on your own machine (or one on your network), through its own job
 *    queue, so its memory guard and one-job-at-a-time scheduling apply as they do in its own pages;
 *  - cloud: Hermes Agent's image_generate / video_generate, with whatever providers the chosen
 *    Hermes profile is set up with.
 * Anything finer (models, sizes, lengths, a first frame) is for Hermes in the chat to tune.
 *
 * Files live in library/broll/, listed in library/broll.json. The Studio's access key is kept on its
 * own in the app's home folder and never sent back to the page.
 */
export type BrollEngine = "local" | "cloud";
export type BrollKind = "image" | "video";

export interface BrollItem {
  id: string;
  engine: BrollEngine;
  kind: BrollKind;
  prompt: string;
  status: "working" | "done" | "failed";
  createdAt: string;
  /** Where it got to, 0..1, when the maker says. */
  progress?: number;
  error?: string;
  /** The finished file, in library/broll/. */
  path?: string;
  durationUs?: number;
  width?: number | null;
  height?: number | null;
  /** The Studio's job, while a local one is being made. */
  jobId?: string;
}

export interface BrollSettings {
  /** Imagination Studio's address. */
  studioUrl: string;
  hasKey: boolean;
}

export const DEFAULT_STUDIO_URL = "http://127.0.0.1:7870";
const ID = /^b[a-f0-9]{8}$/;
const POLL_MS = 4000;
const LOCAL_LIMIT_MS = 45 * 60_000;
const CLOUD_LIMIT_MS = { image: 6 * 60_000, video: 20 * 60_000 };
const MAX_DOWNLOAD = 1024 * 1024 * 1024;
const here = path.dirname(fileURLToPath(import.meta.url));
const MEDIA_SCRIPT = path.join(here, "..", "voice", "hermes_media.py");

const dir = () => path.join(libraryDir(), "broll");
const listFile = () => path.join(libraryDir(), "broll.json");
const settingsFile = () => path.join(libraryDir(), "broll-settings.json");
const keyFile = () => path.join(homeDir(), ".studio-key");

// ------------------------------------------------------------------------------------------- the list
let queue: Promise<unknown> = Promise.resolve();
/** One change to the list at a time, so two jobs finishing together never lose each other's edits. */
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}

async function load(): Promise<BrollItem[]> {
  try {
    const list = JSON.parse(await readFile(listFile(), "utf8")) as unknown;
    return Array.isArray(list) ? (list as BrollItem[]) : [];
  } catch {
    return [];
  }
}

async function save(list: BrollItem[]): Promise<void> {
  await mkdir(libraryDir(), { recursive: true });
  const tmp = `${listFile()}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(list, null, 2), "utf8");
  await rm(listFile(), { force: true }).catch(() => undefined);
  await rename(tmp, listFile());
}

async function update(id: string, patch: Partial<BrollItem>): Promise<BrollItem | null> {
  return locked(async () => {
    const list = await load();
    const item = list.find((x) => x.id === id);
    if (!item) return null;
    Object.assign(item, patch);
    for (const k of Object.keys(patch) as (keyof BrollItem)[]) if (patch[k] === undefined) delete item[k];
    await save(list);
    return item;
  });
}

let changed: () => void = () => {};
/** Called whenever an item starts, moves on or finishes, so open pages can redraw. */
export function onBrollChange(fn: () => void): void {
  changed = fn;
}

/** What is being made right now, so it can be stopped. */
const running = new Map<string, { stop: () => void }>();
let resumed = false;

export async function listBroll(): Promise<BrollItem[]> {
  if (!resumed) {
    resumed = true;
    await resumeAfterRestart();
  }
  return load();
}

export async function getBroll(id: string): Promise<BrollItem> {
  const item = ID.test(id) ? (await load()).find((x) => x.id === id) : undefined;
  if (!item) throw new Error(`No B-roll "${id}"`);
  return item;
}

/** Starts making one piece of B-roll and returns it at once; it finishes in the background. */
export async function startBroll(engine: unknown, kind: unknown, prompt: unknown): Promise<BrollItem> {
  if (engine !== "local" && engine !== "cloud") throw new Error("engine must be local or cloud");
  if (kind !== "image" && kind !== "video") throw new Error("kind must be image or video");
  const text = String(prompt ?? "").trim().slice(0, 4000);
  if (!text) throw new Error("Describe what to make");
  if (engine === "local") studio(await readSettingsRaw()); // a bad address is said now, not later
  const item: BrollItem = { id: `b${randomBytes(4).toString("hex")}`, engine, kind, prompt: text, status: "working", createdAt: new Date().toISOString() };
  await locked(async () => save([item, ...(await load())]));
  void make(item);
  return item;
}

/** Stops one being made. */
export async function cancelBroll(id: string): Promise<void> {
  const item = await getBroll(id);
  if (item.status !== "working") return;
  running.get(id)?.stop();
  if (item.engine === "local" && item.jobId) {
    const s = studio(await readSettingsRaw());
    await s.call("POST", `/api/jobs/${encodeURIComponent(item.jobId)}/cancel`, {}).catch(() => undefined);
  }
  await update(id, { status: "failed", error: "Stopped", jobId: undefined, progress: undefined });
  changed();
}

/** Takes one out of the library and deletes its file (projects that use it will find it missing). */
export async function removeBroll(id: string): Promise<void> {
  const item = await getBroll(id);
  if (item.status === "working") await cancelBroll(id).catch(() => undefined);
  await locked(async () => save((await load()).filter((x) => x.id !== id)));
  for (const f of await readdir(dir()).catch(() => [] as string[])) if (f.startsWith(`${id}.`)) await rm(path.join(dir(), f), { force: true });
  changed();
}

/** A small picture of it: the image itself, or a frame of the video. */
export async function brollThumb(id: string): Promise<{ data: Buffer; type: string }> {
  const item = await getBroll(id);
  if (!item.path || !existsSync(item.path)) throw new Error("Not made yet");
  if (item.kind === "image") {
    const ext = path.extname(item.path).toLowerCase();
    return { data: await readFile(item.path), type: ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg" };
  }
  const cached = path.join(dir(), `${id}.thumb.jpg`);
  if (existsSync(cached)) return { data: await readFile(cached), type: "image/jpeg" };
  const at = Math.min(1_000_000, Math.max(0, (item.durationUs ?? 0) / 2));
  const jpeg = await grabFrame(item.path, Math.round(at), 480);
  await writeFile(cached, jpeg);
  return { data: jpeg, type: "image/jpeg" };
}

/** Finished B-roll, in a few lines for Hermes at the start of a chat. */
export async function brollBriefing(): Promise<string> {
  const done = (await load()).filter((x) => x.status === "done" && x.path);
  const lines = done.slice(0, 20).map((x) => `- ${x.id}: ${x.kind}${x.durationUs && x.kind === "video" ? ` ${(x.durationUs / 1e6).toFixed(1)} s` : ""}${x.width && x.height ? ` ${x.width}x${x.height}` : ""} (${x.engine === "local" ? "Imagination Studio" : "Hermes cloud"}): "${x.prompt.slice(0, 120)}" at ${x.path!.replace(/\\/g, "/")}`);
  return `B-roll: the Library's B-roll section makes pictures and clips at default settings, locally with Imagination Studio or in the cloud with Hermes's image_generate / video_generate. When the owner wants other settings (a model, size, length, quality, a first frame), make it yourself with the imagination-studio plugin's studio_picture / studio_clip tools (or image_generate / video_generate), then bring the file in with media.add and place it on a video track above main.${lines.length ? `\nIn the library now:\n${lines.join("\n")}` : ""}`;
}

// ------------------------------------------------------------------------------------------- settings
interface SavedSettings {
  studioUrl: string;
}

async function readSettingsRaw(): Promise<{ studioUrl: string; key: string }> {
  let saved: Partial<SavedSettings> = {};
  try {
    saved = JSON.parse(await readFile(settingsFile(), "utf8")) as Partial<SavedSettings>;
  } catch {
    saved = {};
  }
  const key = (await readFile(keyFile(), "utf8").catch(() => "")).trim();
  return { studioUrl: typeof saved.studioUrl === "string" && saved.studioUrl ? saved.studioUrl : DEFAULT_STUDIO_URL, key };
}

export async function readBrollSettings(): Promise<BrollSettings> {
  const s = await readSettingsRaw();
  return { studioUrl: s.studioUrl, hasKey: Boolean(s.key) };
}

/** Saves the Studio's address and, when given, its key ("" forgets the key). */
export async function writeBrollSettings(patch: { studioUrl?: unknown; key?: unknown }): Promise<BrollSettings> {
  const now = await readSettingsRaw();
  const url = typeof patch.studioUrl === "string" ? cleanStudioUrl(patch.studioUrl) : now.studioUrl;
  const key = typeof patch.key === "string" ? patch.key.trim() : now.key;
  studio({ studioUrl: url, key }); // refuses a key over plain http to an internet address
  await mkdir(libraryDir(), { recursive: true });
  await writeFile(settingsFile(), JSON.stringify({ studioUrl: url }, null, 2), "utf8");
  if (typeof patch.key === "string") {
    if (key) {
      await writeFile(keyFile(), key, { encoding: "utf8", mode: 0o600 });
      await chmod(keyFile(), 0o600).catch(() => undefined);
    } else await rm(keyFile(), { force: true });
  }
  return readBrollSettings();
}

export function cleanStudioUrl(text: string): string {
  let t = text.trim().replace(/\/+$/, "");
  if (!t) return DEFAULT_STUDIO_URL;
  if (!/^https?:\/\//i.test(t)) t = `http://${t}`;
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    throw new Error("That isn't a web address. It looks like http://127.0.0.1:7870");
  }
  if (u.username || u.password || u.search || u.hash) throw new Error("Give just the Studio's address, like http://127.0.0.1:7870");
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
}

/** Whether the Studio answers, in words for the settings page. */
export async function checkStudio(): Promise<{ ok: boolean; message: string }> {
  try {
    const st = (await studio(await readSettingsRaw()).call("GET", "/api/state")) as { version?: string; platform_label?: string; image_models?: unknown[] };
    const models = Array.isArray(st.image_models) ? st.image_models.length : 0;
    return { ok: true, message: `Imagination Studio${st.version ? ` ${st.version}` : ""} answers${st.platform_label ? ` on ${st.platform_label}` : ""}${models ? `, with ${models} picture model${models === 1 ? "" : "s"}` : ""}.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

// ------------------------------------------------------------------------------------------- Imagination Studio
function privateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || /\.(local|lan|internal|ts\.net)$/.test(h)) return true;
  if (isIP(h) === 4) {
    const [a, b] = h.split(".").map(Number) as [number, number];
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(h) === 6) return h === "::1" || /^f[cd]/.test(h) || h.startsWith("fe80");
  return false;
}

interface Studio {
  url: string;
  call: (method: string, p: string, body?: unknown) => Promise<unknown>;
  download: (rel: string, target: string) => Promise<void>;
}

function studio(s: { studioUrl: string; key: string }): Studio {
  const u = new URL(s.studioUrl);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("The Studio's address must start with http:// or https://");
  if (s.key && u.protocol === "http:" && !privateHost(u.hostname)) throw new Error(`The Studio's key is only sent over https to an internet address: use https:// for ${u.hostname}`);
  const base = s.studioUrl.replace(/\/+$/, "");
  const headers = (json: boolean): Record<string, string> => ({ Accept: "application/json", "User-Agent": "sous-chef", ...(json ? { "Content-Type": "application/json" } : {}), ...(s.key ? { "X-Studio-Key": s.key } : {}) });
  const said = async (r: Response, what: string): Promise<Error> => {
    if (r.status >= 300 && r.status < 400) return new Error(`The Studio answered with a redirect (${r.status}). Give its own address; redirects aren't followed so the key stays with it.`);
    if (r.status === 401) return new Error("The Studio needs its access key. Find it in the Studio's Settings page, or in ~/ImaginationStudio/access-key on its machine.");
    let detail = "";
    try {
      const j = (await r.json()) as { error?: unknown; detail?: unknown };
      detail = String(j.error ?? j.detail ?? "").slice(0, 300);
    } catch {
      detail = "";
    }
    return new Error(`${what}: ${detail || r.statusText} (${r.status})`);
  };
  const reach = (e: unknown) => new Error(`Imagination Studio doesn't answer at ${base} (${e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e)}). Is it running, and is the address right?`);
  return {
    url: base,
    async call(method, p, body) {
      let r: Response;
      try {
        r = await fetch(base + p, { method, headers: headers(body !== undefined), body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(60_000) });
      } catch (e) {
        throw reach(e);
      }
      if (!r.ok) throw await said(r, "The Studio said");
      try {
        return await r.json();
      } catch {
        throw new Error(`The Studio at ${base} answered with something that isn't JSON`);
      }
    },
    async download(rel, target) {
      const parts = rel.replace(/^\/+/, "").split("/").filter((x) => x && x !== ".");
      if (!parts.length || parts.some((x) => x === ".." || /[\\\x00-\x1f]/.test(x)) || rel.includes("://")) throw new Error("The Studio named a file oddly");
      let r: Response;
      try {
        r = await fetch(`${base}/files/${parts.map(encodeURIComponent).join("/")}`, { headers: headers(false), redirect: "manual", signal: AbortSignal.timeout(10 * 60_000) });
      } catch (e) {
        throw reach(e);
      }
      if (!r.ok || !r.body) throw await said(r, "The Studio couldn't give the file");
      if (Number(r.headers.get("content-length") ?? 0) > MAX_DOWNLOAD) throw new Error("The file is too large");
      const data = Buffer.from(await r.arrayBuffer());
      if (data.length > MAX_DOWNLOAD) throw new Error("The file is too large");
      await writeFile(`${target}.part`, data);
      await rename(`${target}.part`, target);
    },
  };
}

interface StudioJob {
  id?: string;
  status?: string;
  progress?: number;
  outputs?: unknown[];
  error?: string;
}

/** The Studio's defaults: one picture at its own size and model; a five-second 720p clip at its quick quality. */
async function studioParams(s: Studio, kind: BrollKind, prompt: string): Promise<{ kind: string; params: Record<string, unknown> }> {
  if (kind === "image") return { kind: "scout", params: { prompt, count: 1 } };
  const params: Record<string, unknown> = { prompt, seconds: 5, preset: "p720" };
  try {
    const st = (await s.call("GET", "/api/state")) as { turbo?: boolean; presets?: Record<string, unknown> };
    if (st.presets && typeof st.presets === "object" && !("p720" in st.presets)) delete params.preset;
    if (!st.turbo) params.quality = "fh8"; // without the Turbo adapter the Studio's quick route is FastH3
  } catch {
    params.quality = "fh8";
  }
  return { kind: "video", params };
}

async function makeLocal(item: BrollItem, stopped: () => boolean): Promise<string> {
  const s = studio(await readSettingsRaw());
  let jobId = item.jobId;
  if (!jobId) {
    const { kind, params } = await studioParams(s, item.kind, item.prompt);
    const job = (await s.call("POST", "/api/jobs", { kind, title: `Sous Chef B-roll: ${item.prompt.slice(0, 60)}`, params })) as StudioJob;
    if (!job?.id) throw new Error("The Studio didn't take the job");
    jobId = String(job.id);
    await update(item.id, { jobId });
    changed();
  }
  const ends = Date.now() + LOCAL_LIMIT_MS;
  let last = -1;
  for (;;) {
    if (stopped()) throw new Error("Stopped");
    const job = (await s.call("GET", `/api/jobs/${encodeURIComponent(jobId)}`)) as StudioJob;
    if (job.status === "done") {
      const outputs = (job.outputs ?? []).filter((x): x is string => typeof x === "string");
      const want = item.kind === "image" ? /\.(png|jpe?g|webp)$/i : /\.(mp4|webm|mov|m4v)$/i;
      const rel = outputs.find((x) => want.test(x)) ?? outputs[0];
      if (!rel) throw new Error("The Studio finished but made no file");
      const target = path.join(dir(), `${item.id}${path.extname(rel).toLowerCase() || (item.kind === "image" ? ".png" : ".mp4")}`);
      await mkdir(dir(), { recursive: true });
      await s.download(rel, target);
      return target;
    }
    if (job.status === "failed" || job.status === "cancelled") throw new Error(job.error ? `The Studio said: ${job.error}` : `The Studio's job ${job.status}`);
    const p = typeof job.progress === "number" && Number.isFinite(job.progress) ? Math.max(0, Math.min(1, job.progress > 1 ? job.progress / 100 : job.progress)) : undefined;
    if (p !== undefined && Math.abs(p - last) >= 0.02) {
      last = p;
      await update(item.id, { progress: p });
      changed();
    }
    if (Date.now() > ends) throw new Error("The Studio took too long. It may still finish there; look in its Library.");
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

// ------------------------------------------------------------------------------------------- Hermes (cloud)
async function makeCloud(item: BrollItem, onStop: (stop: () => void) => void): Promise<string> {
  const profile = (await readPreferences().catch(() => ({ hermesProfile: "" }))).hermesProfile || "";
  await mkdir(dir(), { recursive: true });
  const child = await spawnInHermes(MEDIA_SCRIPT, profile);
  return new Promise<string>((resolve, reject) => {
    let out = "";
    let err = "";
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error("Hermes took too long to make it")));
    }, CLOUD_LIMIT_MS[item.kind]);
    onStop(() => {
      child.kill();
      finish(() => reject(new Error("Stopped")));
    });
    child.stdout!.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr!.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-4000)));
    child.on("error", (e) => finish(() => reject(new Error(`Could not start Hermes: ${e.message}`))));
    child.on("close", () => {
      const line = out.trim().split(/\r?\n/).pop() ?? "";
      let msg: { ok?: boolean; path?: string; error?: string } = {};
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        msg = { ok: false, error: err.trim().split(/\r?\n/).slice(-1)[0] || "Hermes stopped without an answer" };
      }
      finish(() => (msg.ok && msg.path && existsSync(msg.path) ? resolve(msg.path) : reject(new Error(msg.error || "Hermes made nothing"))));
    });
    child.stdin!.end(JSON.stringify({ kind: item.kind, prompt: item.prompt, out: path.join(dir(), item.id) }) + "\n");
  });
}

// ------------------------------------------------------------------------------------------- making one
async function make(item: BrollItem): Promise<void> {
  let stop = false;
  let stopCloud: () => void = () => {};
  running.set(item.id, { stop: () => ((stop = true), stopCloud()) });
  try {
    const file = item.engine === "local" ? await makeLocal(item, () => stop) : await makeCloud(item, (fn) => (stopCloud = fn));
    if (stop) return;
    const media = await probeMedia(file);
    const isImage = media.kind === "image";
    if ((item.kind === "image") !== isImage) throw new Error(`Expected ${item.kind === "image" ? "a picture" : "a video"} but got ${isImage ? "a picture" : "something else"}`);
    await update(item.id, { status: "done", path: file, durationUs: isImage ? undefined : media.durationUs, width: media.probe.width ?? null, height: media.probe.height ?? null, jobId: undefined, progress: undefined, error: undefined });
  } catch (e) {
    if (!stop) await update(item.id, { status: "failed", error: e instanceof Error ? e.message : String(e), jobId: undefined, progress: undefined });
  } finally {
    running.delete(item.id);
    changed();
  }
}

/** After a restart: local jobs carry on (the Studio kept making them); cloud ones were lost with the app. */
async function resumeAfterRestart(): Promise<void> {
  const list = await load();
  for (const item of list) {
    if (item.status !== "working" || running.has(item.id)) continue;
    if (item.engine === "local" && item.jobId) void make(item);
    else await update(item.id, { status: "failed", error: "Stopped when Sous Chef closed", progress: undefined });
  }
}
